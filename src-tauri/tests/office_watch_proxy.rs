//! Integration tests for the server-mode office watch reverse proxy
//! (`/api/office-watch-proxy/{port}`).
//!
//! Builds the real Axum router via `build_router`, exercising the proxy's auth
//! gate (per-watch `?cap=` capability + SSRF port whitelist), the cap-strip
//! invariant, the HTML path-rewriting shim, and CORS — against a real loopback
//! upstream standing in for `officecli watch`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::extract::RawQuery;
use axum::http::header;
use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;

const TEST_TOKEN: &str = "ow-proxy-test-token";
const TEST_CAP: &str = "cap-deadbeefcafef00d";

async fn build_proxy_server() -> (TestServer, tempfile::TempDir, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");
    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
    let shutdown = Arc::new(ShutdownSignal::new());
    // The proxy route is unauthenticated (it self-validates `?cap=`), so the
    // build_router token only gates the *other* protected routes.
    let router = build_router(
        state,
        TEST_TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        shutdown,
    );
    let server = TestServer::new(router).expect("test server");
    (server, data_dir, static_dir)
}

/// A real loopback HTTP server standing in for `officecli watch`. Records the
/// last query string it saw (to assert `cap` is stripped) and serves `text/html`
/// for `*/page` paths so the shim-injection path is exercised.
async fn spawn_fake_upstream() -> (u16, Arc<AtomicBool>, Arc<Mutex<String>>) {
    let leaked = Arc::new(AtomicBool::new(false));
    let last_query = Arc::new(Mutex::new(String::new()));
    let leaked_h = leaked.clone();
    let last_q_h = last_query.clone();
    let app = axum::Router::new().fallback(
        move |uri: axum::http::Uri, RawQuery(q): RawQuery| {
            let leaked = leaked_h.clone();
            let last_q = last_q_h.clone();
            async move {
                let query = q.unwrap_or_default();
                if query.split('&').any(|s| s.split('=').next() == Some("cap")) {
                    leaked.store(true, Ordering::SeqCst);
                }
                *last_q.lock().unwrap() = query;
                if uri.path().ends_with("/page") {
                    axum::response::Response::builder()
                        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
                        .body(axum::body::Body::from(
                            "<html><head><title>doc</title></head><body>hi</body></html>",
                        ))
                        .unwrap()
                } else if uri.path().ends_with("/events") {
                    axum::response::Response::builder()
                        .header(header::CONTENT_TYPE, "text/event-stream")
                        .body(axum::body::Body::from(
                            "data: refresh\n\n".repeat(16),
                        ))
                        .unwrap()
                } else {
                    axum::response::Response::builder()
                        .body(axum::body::Body::from("upstream-body"))
                        .unwrap()
                }
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (port, leaked, last_query)
}

#[tokio::test]
async fn proxy_rejects_missing_cap() {
    let (server, _data, _static) = build_proxy_server().await;
    let resp = server.get("/api/office-watch-proxy/12345").await;
    assert_eq!(resp.status_code(), 401);
}

#[tokio::test]
async fn proxy_rejects_wrong_cap() {
    let (server, _data, _static) = build_proxy_server().await;
    let (port, _leaked, _q) = spawn_fake_upstream().await;
    codeg_lib::office_watch::insert_known_port_for_test(port, TEST_CAP);
    let resp = server
        .get(&format!("/api/office-watch-proxy/{port}?cap=wrong"))
        .await;
    codeg_lib::office_watch::remove_known_port_for_test(port);
    assert_eq!(resp.status_code(), 401);
}

#[tokio::test]
async fn proxy_rejects_unknown_port() {
    let (server, _data, _static) = build_proxy_server().await;
    // A valid-looking cap but a port we never bound to a watch → fail closed.
    let resp = server
        .get(&format!("/api/office-watch-proxy/65000?cap={TEST_CAP}"))
        .await;
    assert_eq!(resp.status_code(), 401);
}

#[tokio::test]
async fn proxy_forwards_with_valid_cap_without_leaking_cap() {
    let (server, _data, _static) = build_proxy_server().await;
    let (port, leaked, last_query) = spawn_fake_upstream().await;
    codeg_lib::office_watch::insert_known_port_for_test(port, TEST_CAP);

    let resp = server
        .get(&format!(
            "/api/office-watch-proxy/{port}/preview?cap={TEST_CAP}&x=1"
        ))
        .await;

    codeg_lib::office_watch::remove_known_port_for_test(port);

    assert_eq!(resp.status_code(), 200);
    assert_eq!(resp.text(), "upstream-body");
    // CORS header present so the opaque-origin iframe can read the response.
    assert_eq!(
        resp.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
    assert!(
        !leaked.load(Ordering::SeqCst),
        "the capability must never be forwarded to officecli"
    );
    // The non-cap param passes through verbatim.
    assert_eq!(&*last_query.lock().unwrap(), "x=1");
}

#[tokio::test]
async fn sse_stream_is_never_compressed() {
    // The router's CompressionLayer uses a custom allowlist predicate, which
    // REPLACES tower-http's default (whose built-in exclusions covered SSE).
    // This pins the explicit `text/event-stream` exclusion: a compressed SSE
    // response would be buffered by the encoder and stall live previews.
    let (server, _data, _static) = build_proxy_server().await;
    let (port, _leaked, _q) = spawn_fake_upstream().await;
    codeg_lib::office_watch::insert_known_port_for_test(port, TEST_CAP);

    let resp = server
        .get(&format!("/api/office-watch-proxy/{port}/events?cap={TEST_CAP}"))
        .add_header("accept-encoding", "gzip, br")
        .await;

    codeg_lib::office_watch::remove_known_port_for_test(port);

    assert_eq!(resp.status_code(), 200);
    assert!(
        resp.headers().get("content-encoding").is_none(),
        "text/event-stream must never get a content-encoding"
    );
}

#[tokio::test]
async fn proxy_injects_path_rewriting_shim_into_html() {
    let (server, _data, _static) = build_proxy_server().await;
    let (port, _leaked, _q) = spawn_fake_upstream().await;
    codeg_lib::office_watch::insert_known_port_for_test(port, TEST_CAP);

    let resp = server
        .get(&format!("/api/office-watch-proxy/{port}/page?cap={TEST_CAP}"))
        .await;

    codeg_lib::office_watch::remove_known_port_for_test(port);

    assert_eq!(resp.status_code(), 200);
    let body = resp.text();
    // The shim is injected (so officecli's /events, /api/* reach the proxy)…
    assert!(
        body.contains(&format!("/api/office-watch-proxy/{port}")),
        "expected proxy-prefix shim in HTML, got: {body}"
    );
    assert!(body.contains("window.fetch"), "shim must patch fetch");
    assert!(body.contains("EventSource"), "shim must patch EventSource");
    // …and the original document is preserved after the injected <script>.
    assert!(body.contains("<title>doc</title>"));
}

#[tokio::test]
async fn cors_preflight_covers_the_proxy_route() {
    let (server, _data, _static) = build_proxy_server().await;
    // The router's global CorsLayer short-circuits OPTIONS preflights (no cap
    // needed — a preflight carries no credentials) and the proxy route inherits
    // it. This asserts CORS actually reaches `/api/office-watch-proxy/*`.
    let resp = server
        .method(
            axum::http::Method::OPTIONS,
            "/api/office-watch-proxy/12345/api/edit",
        )
        .add_header("origin", "null")
        .add_header("access-control-request-method", "POST")
        .await;
    assert_eq!(resp.status_code(), 200);
    assert_eq!(
        resp.headers().get("access-control-allow-origin").unwrap(),
        "*"
    );
}

/// The document page's shim starts from the version the watch reported just
/// before the page was fetched, never one read after: a later one could claim
/// an edit the page doesn't show, and the page would never catch up on it.
#[tokio::test]
async fn proxy_reads_the_document_version_before_the_page() {
    let (server, _data, _static) = build_proxy_server().await;
    let asked = Arc::new(Mutex::new(Vec::<String>::new()));
    let asked_h = asked.clone();
    let app = axum::Router::new().fallback(move |uri: axum::http::Uri| {
        let asked = asked_h.clone();
        async move {
            asked.lock().unwrap().push(uri.path().to_string());
            let (content_type, body) = if uri.path() == "/api/status" {
                ("application/json", r#"{"fmt":"docx","version":7}"#)
            } else {
                (
                    "text/html; charset=utf-8",
                    "<html><head><title>doc</title></head><body>hi</body></html>",
                )
            };
            axum::response::Response::builder()
                .header(header::CONTENT_TYPE, content_type)
                .body(axum::body::Body::from(body))
                .unwrap()
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    codeg_lib::office_watch::insert_known_port_for_test(port, TEST_CAP);

    let resp = server
        .get(&format!("/api/office-watch-proxy/{port}/?cap={TEST_CAP}"))
        .await;

    codeg_lib::office_watch::remove_known_port_for_test(port);
    assert_eq!(resp.status_code(), 200);
    assert!(
        resp.text().contains(r#"Number("7")"#),
        "the shim must start from the version read before the page"
    );
    assert_eq!(*asked.lock().unwrap(), vec!["/api/status", "/"]);
}
