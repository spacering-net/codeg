//! A bridge hostname outliving the target it was handed out for.
//!
//! Its own test binary because it sweeps, and `sweep` is global: run
//! alongside the other hostname tests it would close their listeners too.

use std::sync::OnceLock;
use std::time::{Duration, Instant};

use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use codeg_lib::web::browser_bridge::{self, BridgeConfig, BridgeGrant, HostPattern};

const WORKBENCH: &str = "codeg.test";
/// Codeg's own port here; no target can ever be opened on it, so a name
/// built from it is one the bridge never handed out.
const RESERVED_PORT: u16 = 1;

fn configure_once() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        browser_bridge::configure(Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            ports: Vec::new(),
            public_host: None,
            host_pattern: Some(HostPattern::Subdomain),
            reserved: vec![RESERVED_PORT],
        }));
    });
}

async fn spawn_upstream() -> u16 {
    let app = Router::new().route(
        "/hello",
        get(|| async {
            Response::builder()
                .status(StatusCode::OK)
                .header(header::CONTENT_TYPE, "text/plain")
                .body(axum::body::Body::from("hello from upstream"))
                .unwrap()
        }),
    );
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

/// A name the bridge handed out stays the bridge's after its target idles
/// away. The origin outlives the target: a page that ran there may have
/// left a service worker behind, and codeg's own pages served under that
/// name would be served through it.
#[tokio::test]
async fn a_name_that_was_handed_out_never_becomes_codegs() {
    configure_once();
    let upstream = spawn_upstream().await;
    let codeg = spawn_codeg().await;
    let grant = browser_bridge::open(upstream, "tab-swept", Some(WORKBENCH))
        .await
        .unwrap();
    let host = format!("{}:{codeg}", grant.bridge_host.as_deref().unwrap());
    let get = |host: String, cookie: bool| {
        let mut request = client()
            .get(format!("http://127.0.0.1:{codeg}/hello"))
            .header(header::HOST, host)
            .header("sec-fetch-site", "same-origin");
        if cookie {
            request = request.header(header::COOKIE, cookie_for(&grant));
        }
        request.send()
    };

    let response = get(host.clone(), true).await.unwrap();
    assert_eq!(response.text().await.unwrap(), "hello from upstream");

    // The workbench tab closes and a minute passes with nothing asking.
    browser_bridge::close("tab-swept");
    assert_eq!(
        browser_bridge::sweep(Instant::now() + Duration::from_secs(61)),
        1
    );
    assert_eq!(browser_bridge::listener_count(), 0);

    // No target holds the name now — and it is still not codeg's.
    let response = get(host.clone(), true).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert!(response.text().await.unwrap().contains("no longer valid"));

    // A name of the same shape that was never handed out still reaches
    // codeg: under `auto` the shape alone is nobody's claim, or a workbench
    // on a numeric-leading hostname would lose its own pages.
    let response = get(format!("{RESERVED_PORT}.{WORKBENCH}:{codeg}"), false)
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "codeg's own page");

    // Nor does reconfiguring the bridge hand the name back. The browser's
    // memory of that origin is not reconfigured with it, so switching the
    // bridge off, or moving it back to a port per target, leaves the name
    // refused for as long as this process runs.
    for config in [
        None,
        Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            ports: vec![0],
            public_host: None,
            host_pattern: None,
            reserved: vec![RESERVED_PORT],
        }),
        Some(BridgeConfig {
            bind_host: "127.0.0.1".to_string(),
            ports: Vec::new(),
            public_host: None,
            host_pattern: Some(HostPattern::Subdomain),
            reserved: vec![RESERVED_PORT],
        }),
    ] {
        let off = config.is_none();
        browser_bridge::configure(config);
        let response = get(host.clone(), true).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "off: {off}");
        // And a name never handed out still reaches codeg, whichever way
        // the bridge is pointed now.
        let response = get(format!("{RESERVED_PORT}.{WORKBENCH}:{codeg}"), false)
            .await
            .unwrap();
        assert_eq!(response.text().await.unwrap(), "codeg's own page", "off: {off}");
    }
}
