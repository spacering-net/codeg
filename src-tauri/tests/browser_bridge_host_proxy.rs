//! A hostname-addressed port bridge behind a declared reverse proxy
//! (`CODEG_BRIDGE_PUBLIC_HOST` set), where `X-Forwarded-Host` is believed.
//!
//! Its own test binary: the bridge's configuration is one process-wide
//! thing, and `browser_bridge_host.rs` runs the same bridge with no proxy
//! declared, where that header is nobody's word for anything.

use std::sync::OnceLock;

use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use codeg_lib::web::browser_bridge::{self, BridgeConfig, BridgeGrant, HostPattern};

/// The hostname the proxy in front publishes codeg at.
const PUBLIC: &str = "codeg.test";
/// What the proxy puts in `Host` when it forwards: its own upstream address,
/// which names no bridge target.
const INTERNAL: &str = "codeg-internal";

fn configure_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        browser_bridge::configure(Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            ports: Vec::new(),
            public_host: Some(PUBLIC.to_string()),
            host_pattern: Some(HostPattern::Subdomain),
            reserved: vec![1],
        }));
    });
}

async fn spawn_upstream() -> u16 {
    async fn hello(_headers: HeaderMap) -> Response {
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "text/plain")
            .body(axum::body::Body::from("hello from upstream"))
            .unwrap()
    }
    let app = Router::new().route("/hello", get(hello));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    port
}

async fn spawn_codeg() -> u16 {
    let app = Router::new()
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

fn cookie_for(grant: &BridgeGrant) -> String {
    let cap = grant
        .entry_path
        .strip_prefix(browser_bridge::ENTER_PREFIX)
        .unwrap();
    format!("codeg-bridge-{}={cap}", grant.target_port)
}

#[tokio::test]
async fn the_proxys_forwarded_host_routes_and_a_pages_cannot_escape() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-proxy", None).await.unwrap();
    // Behind a declared proxy the public hostname is what a target is named
    // after, whether or not the request carried a name of its own.
    let target = format!("{upstream}.{PUBLIC}");
    assert_eq!(grant.bridge_host.as_deref(), Some(target.as_str()));

    let get = |host: String, forwarded: Option<String>| {
        let mut request = client()
            .get(format!("http://127.0.0.1:{codeg}/hello"))
            .header(header::HOST, host)
            .header("sec-fetch-site", "same-origin")
            .header(header::COOKIE, cookie_for(&grant));
        if let Some(forwarded) = forwarded {
            request = request.header("x-forwarded-host", forwarded);
        }
        request.send()
    };

    // The proxy replaced `Host` with its upstream address: the forwarded
    // name is the only one that says which target this is.
    let response = get(INTERNAL.to_string(), Some(target.clone())).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
    // A proxy that appends rather than replaces, its client's value first.
    let response = get(INTERNAL.to_string(), Some(format!("evil.test, {target}")))
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");
    // The proxy passing `Host` through, which is the ordinary arrangement.
    let response = get(target.clone(), None).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");

    // A page on the target's origin adding a forwarding header of its own:
    // it cannot drop the `Host` that names the target, so the request stays
    // the bridge's and never becomes codeg's pages on the target's origin.
    let response = get(target, Some(PUBLIC.to_string())).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");

    // And codeg's own public name is still codeg's, from either header.
    let response = get(PUBLIC.to_string(), None).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
    let response = get(PUBLIC.to_string(), Some(PUBLIC.to_string())).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");
}
