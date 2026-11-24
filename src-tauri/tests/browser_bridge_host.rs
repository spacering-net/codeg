//! Integration tests for a port bridge addressed by hostname
//! (`CODEG_BRIDGE_HOST_PATTERN`): one real listener standing in for codeg's
//! own, `route_by_host` in front of it as the router installs it, and a real
//! upstream standing in for a dev server.
//!
//! Its own test binary on purpose: the bridge's configuration is one
//! process-wide thing, and `tests/browser_bridge.rs` configures it to bind a
//! port per target. The two ways of addressing it cannot share a process.

use std::sync::OnceLock;

use axum::extract::ws::{Message, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use codeg_lib::web::browser_bridge::{self, BridgeConfig, BridgeError, BridgeGrant, HostPattern};
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

/// The hostname the workbench itself is reached at in these tests; a target
/// port goes one label in front of it.
const WORKBENCH: &str = "codeg.test";
const RESERVED_PORT: u16 = 1;

fn configure_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        browser_bridge::configure(Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            // Nothing of the bridge's own is bound: it answers on the
            // listener codeg already has.
            ports: Vec::new(),
            public_host: None,
            host_pattern: Some(HostPattern::Subdomain),
            reserved: vec![RESERVED_PORT],
        }));
    });
}

/// A loopback server standing in for a dev server.
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
            .header("x-echo-host", echo("host"))
            .header("x-echo-origin", echo("origin"))
            .header(header::CONTENT_TYPE, "text/plain")
            .body(axum::body::Body::from("hello from upstream"))
            .unwrap()
    }
    async fn ws(ws: WebSocketUpgrade) -> Response {
        ws.protocols(["vite-hmr"]).on_upgrade(|mut socket| async move {
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
    let app = Router::new().route("/hello", get(hello)).route("/ws", get(ws));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    port
}

/// Codeg's own listener, with the bridge's host routing in front of it
/// exactly where `web::router::build_router` puts it: outermost, so a
/// bridged request never reaches anything below.
async fn spawn_codeg() -> u16 {
    let app = Router::new()
        .route("/api/whoami", get(|| async { "codeg's own api" }))
        .fallback(|| async { "codeg's own page" })
        .layer(axum::middleware::from_fn(browser_bridge::route_by_host));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    port
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

/// Named by hostname the cookie is the target port's, and host-only: the
/// browser never sends it to another target's name at all.
fn cookie_for(grant: &BridgeGrant) -> String {
    format!("codeg-bridge-{}={}", grant.target_port, cap_of(grant))
}

/// The authority the browser would use: the grant's hostname on the port it
/// already talks to, which is codeg's own.
fn authority(grant: &BridgeGrant, codeg_port: u16) -> String {
    format!(
        "{}:{codeg_port}",
        grant.bridge_host.as_deref().expect("a hostname-addressed bridge")
    )
}

#[tokio::test]
async fn a_target_is_named_by_hostname_and_bound_to_nothing() {
    configure_once();
    let upstream = spawn_upstream().await;
    let grant = browser_bridge::open(upstream, "tab-name", Some(WORKBENCH))
        .await
        .unwrap();

    assert_eq!(grant.target_port, upstream);
    assert_eq!(grant.bridge_port, None);
    assert_eq!(
        grant.bridge_host.as_deref(),
        Some(format!("{upstream}.{WORKBENCH}").as_str())
    );

    let status = browser_bridge::status();
    assert!(status.enabled);
    assert!(status.ports.is_empty());
    assert_eq!(status.host_pattern.as_deref(), Some("auto"));

    // `auto` has nothing to build on when the workbench was reached by
    // address rather than by name.
    let err = browser_bridge::open(upstream, "tab-by-address", None)
        .await
        .unwrap_err();
    assert!(matches!(err, BridgeError::NoHostname(_)), "{err:?}");
    // Codeg's own port is refused here as it is anywhere.
    let err = browser_bridge::open(RESERVED_PORT, "tab-reserved", Some(WORKBENCH))
        .await
        .unwrap_err();
    assert!(matches!(err, BridgeError::Reserved(RESERVED_PORT)), "{err:?}");
}

#[tokio::test]
async fn the_page_comes_through_codegs_own_listener() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-page", Some(WORKBENCH))
        .await
        .unwrap();
    let host = authority(&grant, codeg);

    // The entry sets this target's cookie and answers with a page that
    // navigates itself — not a redirect, which would arrive `same-site`.
    let response = client()
        .get(format!("http://127.0.0.1:{codeg}{}?to=%2Fhello", grant.entry_path))
        .header(header::HOST, &host)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap(),
        format!("{}; Path=/; HttpOnly; SameSite=Lax", cookie_for(&grant))
    );
    assert!(response.text().await.unwrap().contains("/hello"));

    // And then the page itself, on the same authority.
    let response = client()
        .get(format!("http://127.0.0.1:{codeg}/hello"))
        .header(header::HOST, &host)
        .header(header::COOKIE, cookie_for(&grant))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    // The upstream is addressed as it would be on the host itself, not as
    // the bridge hostname.
    assert_eq!(
        response.headers().get("x-echo-host").unwrap(),
        &format!("127.0.0.1:{upstream}")
    );
    assert_eq!(response.text().await.unwrap(), "hello from upstream");

    // The probe the workbench makes before it shows the frame.
    let response = client()
        .get(format!("http://127.0.0.1:{codeg}{}", browser_bridge::PING_PATH))
        .header(header::HOST, &host)
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn codeg_and_the_dev_servers_never_answer_for_each_other() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-apart", Some(WORKBENCH))
        .await
        .unwrap();
    let host = authority(&grant, codeg);
    let get = |path: &str, host: String, cookie: bool| {
        let mut request = client()
            .get(format!("http://127.0.0.1:{codeg}{path}"))
            .header(header::HOST, host)
            .header("sec-fetch-site", "same-origin");
        if cookie {
            request = request.header(header::COOKIE, cookie_for(&grant));
        }
        request.send()
    };

    // Codeg's own name still reaches codeg, and a target's name never does —
    // not its pages and not its API, whatever the request carries.
    let response = get("/", format!("{WORKBENCH}:{codeg}"), false).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    let response = get("/api/whoami", format!("{WORKBENCH}:{codeg}"), false).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own api");
    let response = get("/api/whoami", host.clone(), true).await.unwrap();
    assert_ne!(response.text().await.unwrap(), "codeg's own api");
    let response = get("/hello", host.clone(), true).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");

    // A name shaped like the bridge's that no target holds is nobody's
    // claim under `auto`, which describes `<port>.<anything>` — codeg
    // answers, as it must for a workbench whose own hostname starts with a
    // number. (A dedicated wildcard is refused instead; see
    // `unclaimed_is_the_bridges`.) The reserved port, because no test in
    // this process can ever hold it and the upstreams take whatever
    // consecutive ports the OS hands out.
    let response = get("/", format!("{RESERVED_PORT}.{WORKBENCH}:{codeg}"), false)
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    // A hostname that is not the bridge's passes straight through.
    let response = get("/", format!("app.{WORKBENCH}:{codeg}"), false).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    // Including the one the browser would send with no name at all.
    let response = get("/", format!("127.0.0.1:{codeg}"), false).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    // The bridge's own prefix is never forwarded upstream.
    let response = get("/__codeg_bridge/anything", host, true).await.unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

/// The bridge answers only for names it handed out. `auto` describes a
/// shape — `<port>.<anything>` — and a shape would let it claim names codeg
/// was never asked to take, a workbench on a numeric-leading hostname among
/// them.
#[tokio::test]
async fn only_a_name_codeg_handed_out_is_the_bridges() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-shape", Some(WORKBENCH))
        .await
        .unwrap();
    let get = |host: String| {
        client()
            .get(format!("http://127.0.0.1:{codeg}/hello"))
            .header(header::HOST, host)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, cookie_for(&grant))
            .send()
    };

    // The same port one label in front of a host no grant was ever rendered
    // from is not this target's — codeg answers, as it would for any other
    // name it was reached at.
    let response = get(format!("{upstream}.elsewhere.test:{codeg}")).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    // Including a workbench whose own hostname starts with a number: under
    // the shape rule its every request would have been the bridge's.
    let response = get(format!("{upstream}.codeg:{codeg}")).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    // The name that was handed out still works, and a second one is minted
    // for a workbench reached at a second hostname.
    let response = get(format!("{upstream}.{WORKBENCH}:{codeg}")).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
    let second = browser_bridge::open(upstream, "tab-other-base", Some("other.test"))
        .await
        .unwrap();
    assert_eq!(
        second.bridge_host.as_deref(),
        Some(format!("{upstream}.other.test").as_str())
    );
    let response = get(format!("{upstream}.other.test:{codeg}")).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
}

/// Nobody declared a proxy here, so a forwarding header is nobody's word
/// for anything — including a page's, which cannot drop the `Host` that
/// does decide. (The proxied half is `browser_bridge_host_proxy.rs`: the
/// configuration is one process-wide thing.)
#[tokio::test]
async fn a_forwarding_header_decides_nothing_without_a_proxy_in_front() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-forged", Some(WORKBENCH))
        .await
        .unwrap();
    let host = authority(&grant, codeg);
    let get = |host: String, forwarded: String| {
        client()
            .get(format!("http://127.0.0.1:{codeg}/hello"))
            .header(header::HOST, host)
            .header("x-forwarded-host", forwarded)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, cookie_for(&grant))
            .send()
    };

    // `Host` names this target, whatever the request claims it was
    // forwarded from.
    let response = get(host.clone(), format!("{WORKBENCH}:{codeg}")).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
    // And the other way: from codeg's own name, a forwarding header naming
    // a target reaches nothing of the bridge's.
    let response = get(format!("{WORKBENCH}:{codeg}"), host).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
}

#[tokio::test]
async fn only_this_targets_own_page_may_ask() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-initiator", Some(WORKBENCH))
        .await
        .unwrap();
    let host = authority(&grant, codeg);
    let send = |cookie: Option<String>, site: Option<&'static str>, origin: Option<String>| {
        let mut request = client()
            .get(format!("http://127.0.0.1:{codeg}/hello"))
            .header(header::HOST, &host);
        if let Some(cookie) = cookie {
            request = request.header(header::COOKIE, cookie);
        }
        if let Some(site) = site {
            request = request.header("sec-fetch-site", site);
        }
        if let Some(origin) = origin {
            request = request.header(header::ORIGIN, origin);
        }
        request.send()
    };
    let ok = cookie_for(&grant);

    // The cookie is the capability; nothing else stands in for it.
    for cookie in [
        None,
        Some(format!("codeg-bridge-{}=wrong", grant.target_port)),
        // Another target's cookie, which a browser would not even send to
        // this host-only name.
        Some(format!("codeg-bridge-{}={}", upstream + 1, cap_of(&grant))),
    ] {
        let response = send(cookie.clone(), Some("same-origin"), None).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{cookie:?}");
    }

    // With it, the browser still has to say the page asked.
    assert_eq!(
        send(Some(ok.clone()), Some("same-origin"), None).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        send(Some(ok.clone()), Some("none"), None).await.unwrap().status(),
        StatusCode::OK
    );
    // Another target's page, or the workbench: `same-site`, and refused —
    // the cookie would not reach them, but the answer does not depend on it.
    assert_eq!(
        send(Some(ok.clone()), Some("same-site"), None).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(Some(ok.clone()), Some("cross-site"), None).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
    // No Fetch Metadata (a plain-http deployment): the Origin must name the
    // authority this request was addressed to.
    assert_eq!(
        send(Some(ok.clone()), None, Some(format!("http://{host}"))).await.unwrap().status(),
        StatusCode::OK
    );
    assert_eq!(
        send(
            Some(ok.clone()),
            None,
            Some(format!("http://{}.{WORKBENCH}:{codeg}", upstream + 1))
        )
        .await
        .unwrap()
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        send(Some(ok), None, None).await.unwrap().status(),
        StatusCode::FORBIDDEN
    );
}

#[tokio::test]
async fn websockets_are_bridged_through_the_shared_listener() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-ws", Some(WORKBENCH))
        .await
        .unwrap();
    let host = authority(&grant, codeg);

    let connect = |cookie: Option<String>| {
        let mut request = format!("ws://127.0.0.1:{codeg}/ws")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert(header::HOST, host.parse().unwrap());
        request
            .headers_mut()
            .insert("sec-fetch-site", "same-origin".parse().unwrap());
        request
            .headers_mut()
            .insert(header::SEC_WEBSOCKET_PROTOCOL, "vite-hmr".parse().unwrap());
        if let Some(cookie) = cookie {
            request
                .headers_mut()
                .insert(header::COOKIE, cookie.parse().unwrap());
        }
        tokio_tungstenite::connect_async(request)
    };

    let (mut socket, response) = connect(Some(cookie_for(&grant))).await.unwrap();
    assert_eq!(
        response
            .headers()
            .get(header::SEC_WEBSOCKET_PROTOCOL)
            .and_then(|v| v.to_str().ok()),
        Some("vite-hmr")
    );
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text("ping".into()))
        .await
        .unwrap();
    let message = socket.next().await.unwrap().unwrap();
    assert_eq!(message.into_text().unwrap().as_str(), "echo:ping");

    // Without the capability the upgrade never reaches the dev server.
    assert!(connect(None).await.is_err());
}
