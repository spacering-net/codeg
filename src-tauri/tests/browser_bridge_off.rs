//! Switching the web-mode port bridge off, in its own process: `configure(None)`
//! closes every listener in the process, which would fail any other test
//! sharing the binary.

use std::time::Duration;

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
async fn switching_the_bridge_off_closes_everything_and_refuses_new_opens() {
    configure();
    let upstream = spawn_upstream().await;
    let grant = browser_bridge::open(upstream, "tab-off", None).await.unwrap();
    browser_bridge::configure(None);
    assert_eq!(browser_bridge::listener_count(), 0);
    assert!(matches!(
        browser_bridge::open(upstream, "tab-off-2", None).await,
        Err(browser_bridge::BridgeError::Disabled)
    ));
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(client()
        .get(format!("{}/hello", base(&grant)))
        .header(header::COOKIE, cookie_for(&grant))
        .send()
        .await
        .is_err());
    // Back on — bound to `localhost` by name this time: opens work again
    // and the listener answers on the resolved address.
    browser_bridge::configure(Some(BridgeConfig {
        bind_host: "localhost".to_string(),
        ports: vec![0],
        public_host: None,
        host_pattern: None,
        reserved: vec![1],
    }));
    let again = browser_bridge::open(upstream, "tab-on", None).await.unwrap();
    assert_ne!(port_of(&again), 0);
    let response = client()
        .get(format!("http://localhost:{}/hello", port_of(&again)))
        .header(header::COOKIE, cookie_for(&again))
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    browser_bridge::close("tab-on");
}

