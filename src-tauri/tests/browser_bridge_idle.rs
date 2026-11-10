//! The idle sweep of the web-mode port bridge, in its own process: `sweep`
//! is global, and a sweep run "two hours from now" would close the listeners
//! of every other test sharing the binary.

use std::time::{Duration, Instant};

use axum::http::header;
use axum::Router;
use codeg_lib::web::browser_bridge::{self, BridgeConfig, BridgeGrant};

fn configure() {
    browser_bridge::configure(Some(BridgeConfig {
        bind_host: "127.0.0.1".to_string(),
        ports: vec![0],
        public_host: None,
        host_pattern: None,
        reserved: vec![1],
    }));
}

async fn spawn_upstream() -> u16 {
    let app = Router::new().route("/hello", axum::routing::get(|| async { "hello" }));
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

/// The port this grant's listener answers on. These tests configure the
/// bridge to bind one, so a grant without a port would be a bug.
fn port_of(grant: &BridgeGrant) -> u16 {
    grant.bridge_port.expect("a bridge addressed by port")
}

fn cookie_for(grant: &BridgeGrant) -> String {
    let cap = grant
        .entry_path
        .strip_prefix(browser_bridge::ENTER_PREFIX)
        .unwrap();
    format!("codeg-bridge-{}={cap}", port_of(grant))
}

fn base(grant: &BridgeGrant) -> String {
    format!("http://127.0.0.1:{}", port_of(grant))
}

#[tokio::test]
async fn listeners_close_when_released_and_idle() {
    configure();
    let upstream = spawn_upstream().await;
    let grant = browser_bridge::open(upstream, "tab-idle", None).await.unwrap();
    let before = browser_bridge::listener_count();
    let now = Instant::now();

    // Held and recently used: a minute of idleness is not enough.
    assert_eq!(browser_bridge::sweep(now + Duration::from_secs(61)), 0);
    // Released: a minute is.
    browser_bridge::close("tab-idle");
    assert_eq!(browser_bridge::sweep(now + Duration::from_secs(30)), 0);
    assert_eq!(browser_bridge::sweep(now + Duration::from_secs(61)), 1);
    assert_eq!(browser_bridge::listener_count(), before - 1);

    // The port stops answering (graceful close, then cut).
    tokio::time::sleep(Duration::from_millis(200)).await;
    let result = client()
        .get(format!("{}/hello", base(&grant)))
        .header(header::COOKIE, cookie_for(&grant))
        .send()
        .await;
    assert!(result.is_err(), "closed listener still answered: {result:?}");

    // A held listener still closes after two hours without a request. The
    // clock starts again here: the request above waits on a port that was
    // just closed, which Windows refuses only after ~2 s (macOS in
    // milliseconds), and the margin the sweep below leaves is one second.
    let now = Instant::now();
    let held = browser_bridge::open(upstream, "tab-held", None).await.unwrap();
    assert_ne!(port_of(&held), 0);
    assert_eq!(browser_bridge::sweep(now + Duration::from_secs(60 * 60)), 0);
    assert_eq!(
        browser_bridge::sweep(now + Duration::from_secs(2 * 60 * 60 + 1)),
        1
    );
    browser_bridge::close("tab-held");
}
