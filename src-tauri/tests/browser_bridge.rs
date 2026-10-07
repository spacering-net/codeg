//! Integration tests for the web-mode port bridge (`web::browser_bridge`):
//! real listeners on loopback, a real upstream standing in for a dev server,
//! and a real WebSocket through both.

use std::future::Future;
use std::sync::{LazyLock, OnceLock};

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use codeg_lib::web::browser_bridge::{self, BridgeConfig, BridgeError, BridgeGrant};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

const RESERVED_PORT: u16 = 1;

fn configure_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        browser_bridge::configure(Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            ports: vec![0],
            public_host: None,
            host_pattern: None,
            reserved: vec![RESERVED_PORT],
        }));
    });
}

/// Runs `task` on a runtime that lasts as long as the process, the way
/// codeg's own does. What a `#[tokio::test]` spawns stops when its test
/// ends, but the bridge's table of listeners is process-wide: a listener
/// bound from inside a test would stay in it afterwards, dead, under its
/// target port — and that port, its upstream's, would go back to the OS,
/// which may hand it to a later test's upstream, whose `open` is then given
/// the dead listener. Upstreams and listeners are started here instead.
async fn on_process_runtime<T: Send + 'static>(
    task: impl Future<Output = T> + Send + 'static,
) -> T {
    static RUNTIME: LazyLock<tokio::runtime::Runtime> = LazyLock::new(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap()
    });
    RUNTIME.spawn(task).await.unwrap()
}

/// `browser_bridge::open` from that runtime, as codeg's API handler calls it
/// from its own: the listener it binds is served where it was bound.
async fn open(target_port: u16, tab_id: &'static str) -> Result<BridgeGrant, BridgeError> {
    on_process_runtime(browser_bridge::open(target_port, tab_id, None)).await
}

/// A loopback server standing in for a dev server. Echoes the request
/// headers it cares about back as `x-echo-*` response headers.
async fn spawn_upstream() -> u16 {
    async fn hello(headers: HeaderMap) -> Response {
        let echo = |name: &str| {
            headers
                .get(name)
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .to_string()
        };
        Response::builder()
            .status(StatusCode::OK)
            .header("x-frame-options", "DENY")
            .header("content-security-policy", "default-src 'self'; frame-ancestors 'none'")
            .header("set-cookie", "sid=1; Path=/")
            .header("x-echo-cookie", echo("cookie"))
            .header("x-echo-origin", echo("origin"))
            .header("x-echo-referer", echo("referer"))
            .header("x-echo-host", echo("host"))
            .header("x-echo-accept-encoding", echo("accept-encoding"))
            .header(header::CONTENT_TYPE, "text/plain")
            .body(axum::body::Body::from("hello from upstream"))
            .unwrap()
    }
    async fn redirect(headers: HeaderMap) -> Response {
        let host = headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("127.0.0.1");
        Response::builder()
            .status(StatusCode::FOUND)
            .header(header::LOCATION, format!("http://{host}/after?x=1"))
            .body(axum::body::Body::empty())
            .unwrap()
    }
    async fn echo(headers: HeaderMap, body: String) -> Response {
        Response::builder()
            .status(StatusCode::OK)
            .header(
                header::CONTENT_TYPE,
                headers
                    .get(header::CONTENT_TYPE)
                    .cloned()
                    .unwrap_or_else(|| "text/plain".parse().unwrap()),
            )
            .body(axum::body::Body::from(format!("echo:{body}")))
            .unwrap()
    }
    async fn ws(ws: WebSocketUpgrade, headers: HeaderMap) -> Response {
        let origin = headers
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        ws.protocols(["vite-hmr"]).on_upgrade(move |mut socket| async move {
            let _ = socket
                .send(Message::Text(format!("origin:{origin}").into()))
                .await;
            while let Some(Ok(message)) = socket.recv().await {
                match message {
                    Message::Text(text) => {
                        if socket
                            .send(Message::Text(format!("echo:{text}").into()))
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        })
    }
    let app = Router::new()
        .route("/hello", get(hello))
        .route("/redirect", get(redirect))
        .route("/echo", post(echo))
        .route("/ws", get(ws));
    on_process_runtime(async move {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        port
    })
    .await
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .unwrap()
}

fn cap_of(grant: &BridgeGrant) -> &str {
    grant
        .entry_path
        .strip_prefix(browser_bridge::ENTER_PREFIX)
        .expect("entry path carries the capability")
}

/// The port this grant's listener answers on. Every test here configures
/// the bridge to bind one, so a grant without a port would be a bug.
fn port_of(grant: &BridgeGrant) -> u16 {
    grant.bridge_port.expect("a bridge addressed by port")
}

fn cookie_for(grant: &BridgeGrant) -> String {
    format!("codeg-bridge-{}={}", port_of(grant), cap_of(grant))
}

fn base(grant: &BridgeGrant) -> String {
    format!("http://127.0.0.1:{}", port_of(grant))
}

#[tokio::test]
async fn entry_sets_the_cookie_and_redirects_to_the_page() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = open(upstream, "tab-entry").await.unwrap();
    assert_eq!(grant.target_port, upstream);
    assert_ne!(port_of(&grant), 0);

    let response = client()
        .get(format!(
            "{}{}?to=%2Fhello%3Fq%3D1",
            base(&grant),
            grant.entry_path
        ))
        .send()
        .await
        .unwrap();
    // Not a redirect: the page navigates itself, so the document request
    // that follows is same-origin with the listener.
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(
        cookie,
        format!("{}; Path=/; HttpOnly; SameSite=Lax", cookie_for(&grant))
    );
    assert_eq!(
        response.headers().get(header::CACHE_CONTROL).unwrap(),
        "no-store"
    );
    // The navigation the page makes carries this listener's origin as its
    // referrer — what the gate checks without Fetch Metadata — and not the
    // entry URL with the capability.
    assert_eq!(
        response.headers().get(header::REFERRER_POLICY).unwrap(),
        "origin"
    );
    let page = response.text().await.unwrap();
    assert!(page.contains("location.replace(\"/hello?q=1\")"), "{page}");
    assert!(page.contains("content=\"0;url=/hello?q=1\""), "{page}");

    // Behind a TLS-terminating proxy the cookie is marked Secure.
    let response = client()
        .get(format!("{}{}", base(&grant), grant.entry_path))
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    assert!(response
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .ends_with("; Secure"));
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("location.replace(\"/\")"));

    // The redirect target must stay on this origin.
    let response = client()
        .get(format!(
            "{}{}?to=%2F%2Fevil.example%2F",
            base(&grant),
            grant.entry_path
        ))
        .send()
        .await
        .unwrap();
    assert!(response
        .text()
        .await
        .unwrap()
        .contains("location.replace(\"/\")"));

    // A capability the listener never issued sets nothing.
    let response = client()
        .get(format!(
            "{}{}nope",
            base(&grant),
            browser_bridge::ENTER_PREFIX
        ))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(response.headers().get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn requests_need_this_listeners_cookie() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = open(upstream, "tab-cookie").await.unwrap();
    let url = format!("{}/hello", base(&grant));

    // No cookie, a wrong value, another listener's name: all refused before
    // the upstream is touched.
    let response = client().get(&url).send().await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = client()
        .get(&url)
        .header(header::COOKIE, format!("codeg-bridge-{}=wrong", port_of(&grant)))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let response = client()
        .get(&url)
        .header(
            header::COOKIE,
            format!("codeg-bridge-{}={}", port_of(&grant) + 1, cap_of(&grant)),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    let forbidden = response.text().await.unwrap();
    assert!(forbidden.contains("Reopen the page from codeg"));

    // With the cookie the page comes through, without the anti-framing
    // header and with its own cookies; the request the upstream saw looked
    // like a direct one.
    let response = client()
        .get(&url)
        .header(header::COOKIE, format!("{}; codeg.locale=zh-CN; sid=abc", cookie_for(&grant)))
        .header("sec-fetch-site", "same-origin")
        // The page's own request: an Origin on this listener's port (the
        // public hostname may differ from the bind address).
        .header(
            header::ORIGIN,
            format!("http://codeg.example:{}", port_of(&grant)),
        )
        .header(header::REFERER, format!("{}/from/here?tab=2", base(&grant)))
        .header(header::ACCEPT_ENCODING, "gzip, br")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert!(headers.get("x-frame-options").is_none());
    assert_eq!(
        headers.get(header::CONTENT_SECURITY_POLICY).unwrap(),
        "default-src 'self'"
    );
    assert_eq!(headers.get(header::SET_COOKIE).unwrap(), "sid=1; Path=/");
    assert_eq!(headers.get("x-echo-cookie").unwrap(), "sid=abc");
    assert_eq!(
        headers.get("x-echo-origin").unwrap(),
        format!("http://127.0.0.1:{upstream}").as_str()
    );
    assert_eq!(
        headers.get("x-echo-referer").unwrap(),
        format!("http://127.0.0.1:{upstream}/from/here?tab=2").as_str()
    );
    assert_eq!(
        headers.get("x-echo-host").unwrap(),
        format!("127.0.0.1:{upstream}").as_str()
    );
    assert_eq!(headers.get("x-echo-accept-encoding").unwrap(), "gzip, br");
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
}

#[tokio::test]
async fn only_the_pages_own_requests_pass() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = open(upstream, "tab-initiator").await.unwrap();
    let url = format!("{}/hello", base(&grant));
    let send = |site: Option<&'static str>, origin: Option<String>| {
        let mut request = client().get(&url).header(header::COOKIE, cookie_for(&grant));
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.send()
    };
    // The page itself, and a navigation the user typed.
    assert_eq!(send(Some("same-origin"), None).await.unwrap().status(), StatusCode::OK);
    assert_eq!(send(Some("none"), None).await.unwrap().status(), StatusCode::OK);
    // Another proxied page (another port on this host) or the workbench,
    // whose browser attaches this listener's cookie all the same.
    let refused = send(Some("same-site"), None).await.unwrap();
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert!(refused.text().await.unwrap().contains("did not come from the page itself"));
    assert_eq!(
        send(Some("cross-site"), Some(base(&grant))).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    // Without Fetch Metadata (plain http) the Origin must name the
    // authority the request went to — this listener's.
    assert_eq!(
        send(None, Some(format!("http://127.0.0.1:{}", port_of(&grant)))).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        send(None, Some(format!("http://127.0.0.1:{}", port_of(&grant) + 1))).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(None, Some(format!("http://codeg.example:{}", port_of(&grant)))).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    // Else the Referer; nothing at all is refused (a page cannot forge a
    // referrer, only hide it).
    let with_referer = |referer: String| {
        client()
            .get(&url)
            .header(header::COOKIE, cookie_for(&grant))
            .header(header::REFERER, referer)
            .send()
    };
    assert_eq!(
        with_referer(format!("{}/some/page?x=1", base(&grant))).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        with_referer(format!("http://127.0.0.1:{}/", port_of(&grant) + 1)).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(send(None, None).await.unwrap().status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn redirects_and_bodies_pass_through() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = open(upstream, "tab-redirect").await.unwrap();

    let response = client()
        .get(format!("{}/redirect", base(&grant)))
        .header(header::COOKIE, cookie_for(&grant))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FOUND);
    // The upstream answered with its own absolute address; the browser must
    // stay on the bridge origin.
    assert_eq!(response.headers().get(header::LOCATION).unwrap(), "/after?x=1");

    let response = client()
        .post(format!("{}/echo", base(&grant)))
        .header(header::COOKIE, cookie_for(&grant))
        .header("sec-fetch-site", "same-origin")
        .header(header::CONTENT_TYPE, "application/json")
        .body("{\"a\":1}")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get(header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    assert_eq!(response.text().await.unwrap(), "echo:{\"a\":1}");

    // A path outside the page's space on the bridge itself.
    let response = client()
        .get(format!("{}/__codeg_bridge/other", base(&grant)))
        .header(header::COOKIE, cookie_for(&grant))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);

    // The reachability probe needs nothing.
    let response = client()
        .get(format!("{}{}", base(&grant), browser_bridge::PING_PATH))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .unwrap(),
        "*"
    );
}

#[tokio::test]
async fn websockets_are_bridged_with_their_subprotocol() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = open(upstream, "tab-ws").await.unwrap();

    let mut request = format!("ws://127.0.0.1:{}/ws", port_of(&grant))
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(header::COOKIE, cookie_for(&grant).parse().unwrap());
    request
        .headers_mut()
        .insert(header::SEC_WEBSOCKET_PROTOCOL, "vite-hmr".parse().unwrap());
    request
        .headers_mut()
        .insert(header::ORIGIN, base(&grant).parse().unwrap());
    let (mut socket, response) = tokio_tungstenite::connect_async(request).await.unwrap();
    assert_eq!(
        response.headers().get(header::SEC_WEBSOCKET_PROTOCOL).unwrap(),
        "vite-hmr"
    );
    // The upstream saw an Origin naming itself, as a page served directly
    // by it would send.
    let first = socket.next().await.unwrap().unwrap();
    assert_eq!(
        first.into_text().unwrap().as_str(),
        format!("origin:http://127.0.0.1:{upstream}")
    );
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text("ping".into()))
        .await
        .unwrap();
    let reply = socket.next().await.unwrap().unwrap();
    assert_eq!(reply.into_text().unwrap().as_str(), "echo:ping");
    socket.close(None).await.unwrap();

    // Without the cookie the upgrade is refused; so is one from another
    // proxied page (an Origin on another port, or same-site Fetch Metadata).
    let refused = |mutate: Box<dyn Fn(&mut tokio_tungstenite::tungstenite::handshake::client::Request)>| {
        let mut request = format!("ws://127.0.0.1:{}/ws", port_of(&grant))
            .into_client_request()
            .unwrap();
        mutate(&mut request);
        async move {
            let err = tokio_tungstenite::connect_async(request).await.unwrap_err();
            assert!(
                matches!(
                    err,
                    tokio_tungstenite::tungstenite::Error::Http(ref response)
                        if response.status() == StatusCode::FORBIDDEN
                ),
                "{err:?}"
            );
        }
    };
    refused(Box::new(|_| {})).await;
    let cookie = cookie_for(&grant);
    let other_port = port_of(&grant) + 1;
    refused(Box::new(move |request| {
        request.headers_mut().insert(header::COOKIE, cookie.parse().unwrap());
        request.headers_mut().insert(
            header::ORIGIN,
            format!("http://127.0.0.1:{other_port}").parse().unwrap(),
        );
    }))
    .await;
    let cookie = cookie_for(&grant);
    refused(Box::new(move |request| {
        request.headers_mut().insert(header::COOKIE, cookie.parse().unwrap());
        request.headers_mut().insert("sec-fetch-site", "same-site".parse().unwrap());
    }))
    .await;
}

#[tokio::test]
async fn tabs_share_a_listener_per_target_port() {
    configure_once();
    let upstream = spawn_upstream().await;
    let other_upstream = spawn_upstream().await;
    let first = open(upstream, "tab-a").await.unwrap();
    let second = open(upstream, "tab-b").await.unwrap();
    let other = open(other_upstream, "tab-c").await.unwrap();

    assert_eq!(port_of(&first), port_of(&second));
    assert_ne!(cap_of(&first), cap_of(&second));
    assert_ne!(port_of(&other), port_of(&first));

    // Both capabilities open the shared listener; neither opens the other.
    for grant in [&first, &second] {
        let response = client()
            .get(format!("{}/hello", base(&first)))
            .header(header::COOKIE, cookie_for(grant))
            .header("sec-fetch-site", "same-origin")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = client()
        .get(format!("{}/hello", base(&other)))
        .header(
            header::COOKIE,
            format!("codeg-bridge-{}={}", port_of(&other), cap_of(&first)),
        )
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn codegs_own_port_is_refused() {
    configure_once();
    let err = open(RESERVED_PORT, "tab-reserved").await.unwrap_err();
    assert!(matches!(err, BridgeError::Reserved(p) if p == RESERVED_PORT));
}
