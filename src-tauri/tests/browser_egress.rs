//! The browser tunnel end to end, without a browser: a SOCKS5 client (as a
//! webview's network stack would be) → the desktop's egress listener → one
//! WebSocket → the server's tunnel endpoint behind codeg's token → a real
//! upstream socket, and back.

#![cfg(feature = "tauri-runtime")]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::routing::get;
use axum::{middleware, Extension, Router};
use codeg_lib::browser::egress::{Egress, EgressStatus, TargetLoader, TunnelTarget};
use codeg_lib::web::browser_tunnel::frame::TUNNEL_PATH;
use codeg_lib::web::shutdown::ShutdownSignal;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const TOKEN: &str = "egress-test-token";

struct Server {
    addr: SocketAddr,
    shutdown: Arc<ShutdownSignal>,
}

/// The tunnel exactly as the router mounts it: behind `require_token`, with
/// the shutdown signal in reach. `/forbidden` stands in for a server whose
/// tunnel is switched off.
async fn spawn_server() -> Server {
    let shutdown = Arc::new(ShutdownSignal::new());
    let app = Router::new()
        .route(TUNNEL_PATH, get(codeg_lib::web::browser_tunnel::ws_handler))
        .route(
            "/forbidden",
            get(|| async { (axum::http::StatusCode::FORBIDDEN, "off") }),
        )
        // An older server that serves the web app answers an unknown path
        // with the app's page, 200, from its static fallback.
        .route(
            "/spa-fallback",
            get(|| async { axum::response::Html("<!doctype html><title>codeg</title>") }),
        )
        .layer(middleware::from_fn(|req, next| {
            codeg_lib::web::auth::require_token(req, next, TOKEN.to_string())
        }))
        .layer(Extension(shutdown.clone()));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    Server { addr, shutdown }
}

fn loader(addr: SocketAddr, path: &'static str, token: &'static str) -> TargetLoader {
    Arc::new(move || {
        Box::pin(async move {
            Ok(TunnelTarget {
                ws_url: format!("ws://{addr}{path}"),
                token: token.to_string(),
                headers: Default::default(),
            })
        })
    })
}

/// An upstream that echoes every byte back and closes once the client has
/// finished sending — so a half-close has to make it through the tunnel for
/// the client to see the end.
async fn spawn_echo() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let Ok((conn, _)) = listener.accept().await else { return };
            tokio::spawn(async move {
                let (mut rd, mut wr) = conn.into_split();
                let _ = tokio::io::copy(&mut rd, &mut wr).await;
                let _ = wr.shutdown().await;
            });
        }
    });
    port
}

/// A SOCKS5 CONNECT by name; the connection and the reply code.
async fn socks_connect(socks: SocketAddr, host: &str, port: u16) -> (TcpStream, u8) {
    let mut conn = TcpStream::connect(socks).await.unwrap();
    conn.write_all(&[5, 1, 0]).await.unwrap();
    let mut greeting = [0u8; 2];
    conn.read_exact(&mut greeting).await.unwrap();
    assert_eq!(greeting, [5, 0]);
    let mut request = vec![5, 1, 0, 3, host.len() as u8];
    request.extend_from_slice(host.as_bytes());
    request.extend_from_slice(&port.to_be_bytes());
    conn.write_all(&request).await.unwrap();
    let mut reply = [0u8; 10];
    conn.read_exact(&mut reply).await.unwrap();
    (conn, reply[1])
}

#[tokio::test]
async fn a_connection_reaches_the_upstream_by_name_and_ends_cleanly() {
    let server = spawn_server().await;
    let egress = Egress::start(loader(server.addr, TUNNEL_PATH, TOKEN)).await.unwrap();
    let echo = spawn_echo().await;

    let (mut conn, code) = socks_connect(egress.socks_addr(), "localhost", echo).await;
    assert_eq!(code, 0, "the tunnel should have opened the stream");
    assert_eq!(egress.status(), EgressStatus::Ready);
    conn.write_all(b"hello through the tunnel").await.unwrap();
    // Done sending: the upstream sees EOF only if the half-close crossed.
    conn.shutdown().await.unwrap();
    let mut back = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), conn.read_to_end(&mut back))
        .await
        .expect("the stream should end once both sides are done")
        .unwrap();
    assert_eq!(back, b"hello through the tunnel");
}

#[tokio::test]
async fn many_streams_move_megabytes_at_once_within_their_windows() {
    let server = spawn_server().await;
    let egress = Egress::start(loader(server.addr, TUNNEL_PATH, TOKEN)).await.unwrap();
    let echo = spawn_echo().await;

    let streams = (0..8u8).map(|n| {
        let socks = egress.socks_addr();
        tokio::spawn(async move {
            let (conn, code) = socks_connect(socks, "127.0.0.1", echo).await;
            assert_eq!(code, 0);
            let payload: Vec<u8> = (0..1024 * 1024).map(|i| (i as u8) ^ n).collect();
            let (mut rd, mut wr) = conn.into_split();
            let expected = payload.clone();
            let writer = tokio::spawn(async move {
                wr.write_all(&payload).await.unwrap();
                wr.shutdown().await.unwrap();
            });
            let mut back = Vec::with_capacity(expected.len());
            rd.read_to_end(&mut back).await.unwrap();
            writer.await.unwrap();
            assert_eq!(back.len(), expected.len(), "stream {n} lost bytes");
            assert!(back == expected, "stream {n} came back different");
        })
    });
    for stream in streams {
        tokio::time::timeout(Duration::from_secs(30), stream)
            .await
            .expect("a stream stalled")
            .unwrap();
    }
}

#[tokio::test]
async fn a_port_nobody_listens_on_is_refused_in_socks_terms() {
    let server = spawn_server().await;
    let egress = Egress::start(loader(server.addr, TUNNEL_PATH, TOKEN)).await.unwrap();
    let port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let (_, code) = socks_connect(egress.socks_addr(), "127.0.0.1", port).await;
    assert_eq!(code, 0x05, "connection refused");
}

// An older codeg-server has no tunnel; a server that switched it off says so;
// a wrong token is neither. The tabs tell these apart.
#[tokio::test]
async fn what_the_server_is_decides_the_status() {
    let server = spawn_server().await;

    let older = Egress::start(loader(server.addr, "/ws/not-here", TOKEN)).await.unwrap();
    assert_eq!(older.connect().await, Err(EgressStatus::Unsupported));
    let (_, code) = socks_connect(older.socks_addr(), "localhost", 80).await;
    assert_eq!(code, 0x03, "network unreachable while the tunnel is missing");

    let older_with_app = Egress::start(loader(server.addr, "/spa-fallback", TOKEN)).await.unwrap();
    assert_eq!(older_with_app.connect().await, Err(EgressStatus::Unsupported));

    let off = Egress::start(loader(server.addr, "/forbidden", TOKEN)).await.unwrap();
    assert_eq!(off.connect().await, Err(EgressStatus::Disabled));

    let wrong = Egress::start(loader(server.addr, TUNNEL_PATH, "not-the-token")).await.unwrap();
    assert!(matches!(wrong.connect().await, Err(EgressStatus::Down { .. })));
}

#[tokio::test]
async fn a_dropped_tunnel_is_opened_again_by_the_next_connection() {
    let server = spawn_server().await;
    let egress = Egress::start(loader(server.addr, TUNNEL_PATH, TOKEN)).await.unwrap();
    let echo = spawn_echo().await;
    let (_, code) = socks_connect(egress.socks_addr(), "localhost", echo).await;
    assert_eq!(code, 0);

    let mut status = egress.subscribe();
    server.shutdown.trigger();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !matches!(*status.borrow_and_update(), EgressStatus::Down { .. }) {
            status.changed().await.unwrap();
        }
    })
    .await
    .expect("the dropped tunnel should be noticed");
    server.shutdown.reset();

    let (mut conn, code) = socks_connect(egress.socks_addr(), "localhost", echo).await;
    assert_eq!(code, 0, "the next connection should open a new tunnel");
    conn.write_all(b"again").await.unwrap();
    conn.shutdown().await.unwrap();
    let mut back = Vec::new();
    conn.read_to_end(&mut back).await.unwrap();
    assert_eq!(back, b"again");
}

// The probe: a page addressed to the listener's own port. Through the proxy
// it arrives as SOCKS and is answered here; around it, as plain HTTP.
#[tokio::test]
async fn the_probe_tells_a_proxied_page_from_one_that_went_around_the_proxy() {
    // The tunnel is never needed for this.
    let egress = Egress::start(Arc::new(|| {
        Box::pin(async { Err::<TunnelTarget, _>("unused".to_string()) })
    }))
    .await
    .unwrap();
    let port = egress.socks_addr().port();

    let (mut page, code) = socks_connect(egress.socks_addr(), "remote.localhost", port).await;
    assert_eq!(code, 0);
    page.write_all(b"GET /codeg-egress-probe/n1 HTTP/1.1\r\nHost: remote.localhost\r\n\r\n")
        .await
        .unwrap();
    let mut body = Vec::new();
    page.read_to_end(&mut body).await.unwrap();
    let body = String::from_utf8(body).unwrap();
    assert!(body.starts_with("HTTP/1.1 200"), "{body}");
    assert!(body.contains("'/codeg-egress-probe/n1'"), "{body}");
    assert!(body.contains("+ '/direct'"), "the page addresses loopback literals: {body}");
    assert!(body.contains("new WebSocket("), "the page opens its WebSocket: {body}");

    let (mut ws, code) = socks_connect(egress.socks_addr(), "remote.localhost", port).await;
    assert_eq!(code, 0);
    ws.write_all(
        b"GET /codeg-egress-probe/n1/ws HTTP/1.1\r\nHost: remote.localhost\r\n\
          Upgrade: websocket\r\nConnection: Upgrade\r\n\
          Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    .await
    .unwrap();
    let mut answer = Vec::new();
    ws.read_to_end(&mut answer).await.unwrap();
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 101"));

    let visit = egress.await_probe("n1", Duration::from_secs(2)).await;
    assert!(visit.page && visit.websocket && !visit.bypassed, "{visit:?}");

    // Around the proxy: plain HTTP straight to the port.
    let mut direct = TcpStream::connect(egress.socks_addr()).await.unwrap();
    direct
        .write_all(b"GET /codeg-egress-probe/n2 HTTP/1.1\r\nHost: localhost\r\n\r\n")
        .await
        .unwrap();
    let mut answer = Vec::new();
    direct.read_to_end(&mut answer).await.unwrap();
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 403"));
    let visit = egress.await_probe("n2", Duration::from_secs(2)).await;
    assert!(visit.bypassed && !visit.page, "{visit:?}");

    // Nothing at all: the probe runs out of time.
    let visit = egress.await_probe("n3", Duration::from_millis(200)).await;
    assert_eq!(visit, Default::default());
}

// An edited connection: the open tunnel closes, and the next connection opens
// one to wherever the connection points now.
#[tokio::test]
async fn a_reset_tunnel_follows_the_connection_to_its_new_address() {
    let first = spawn_server().await;
    let second = spawn_server().await;
    let echo = spawn_echo().await;
    let target = Arc::new(std::sync::Mutex::new(first.addr));
    let reading = target.clone();
    let egress = Egress::start(Arc::new(move || {
        let addr = *reading.lock().unwrap();
        Box::pin(async move {
            Ok(TunnelTarget {
                ws_url: format!("ws://{addr}{TUNNEL_PATH}"),
                token: TOKEN.to_string(),
                headers: Default::default(),
            })
        })
    }))
    .await
    .unwrap();
    let (_, code) = socks_connect(egress.socks_addr(), "localhost", echo).await;
    assert_eq!(code, 0);

    *target.lock().unwrap() = second.addr;
    egress.reset().await;
    // The old server is gone: only a tunnel to the new one can carry this.
    first.shutdown.trigger();
    let (mut conn, code) = socks_connect(egress.socks_addr(), "localhost", echo).await;
    assert_eq!(code, 0, "the next connection should open a tunnel to the new address");
    conn.write_all(b"moved").await.unwrap();
    conn.shutdown().await.unwrap();
    let mut back = Vec::new();
    conn.read_to_end(&mut back).await.unwrap();
    assert_eq!(back, b"moved");
}

// A deleted connection: nothing listens on its port any more.
#[tokio::test]
async fn a_closed_egress_stops_listening() {
    let server = spawn_server().await;
    let egress = Egress::start(loader(server.addr, TUNNEL_PATH, TOKEN)).await.unwrap();
    let socks = egress.socks_addr();
    egress.close().await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(TcpStream::connect(socks).await.is_err(), "the listener should be gone");
}
