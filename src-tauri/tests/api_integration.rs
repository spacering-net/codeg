//! HTTP API integration tests.
//!
//! Builds the real Axum router from `web::router::build_router`, wired to an
//! in-memory SQLite database (`fresh_in_memory_db`) and a `WebOnly` event
//! emitter (`EventEmitter::test_web_only`). Drives requests through
//! `axum-test::TestServer` so no TCP socket is involved.
//!
//! Scope of this first pass:
//! - Authentication matrix on a representative protected endpoint
//! - Public endpoint (`get_system_language_settings`) reachable without token
//! - DB-backed endpoints (`load_folder_history`, `list_open_folders`) return
//!   the expected JSON shape. `list_folders` is NOT one of them — it parses
//!   the real home directory and ignores the test DB entirely.
//!
//! Not covered: WebSocket attach (separate concern), endpoints that touch the
//! Tauri webview (those are gated behind `tauri-runtime`).

use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TEST_TOKEN: &str = "integration-test-token";

async fn build_test_server() -> (TestServer, tempfile::TempDir, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");

    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
    let shutdown = Arc::new(ShutdownSignal::new());

    let router = build_router(
        state,
        TEST_TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        shutdown,
    );

    let server = TestServer::new(router).expect("test server");
    // Keep data_dir and static_dir alive for the whole test by returning them.
    (server, data_dir, static_dir)
}

// ────────────────────────────────────────────────────────────────────────────
// Auth matrix
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn protected_endpoint_rejects_missing_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server.post("/api/list_folders").json(&json!({})).await;
    assert_eq!(resp.status_code(), 401);
}

#[tokio::test]
async fn protected_endpoint_rejects_wrong_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/list_folders")
        .add_header("authorization", "Bearer wrong-token")
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 401);
}

#[tokio::test]
async fn protected_endpoint_accepts_correct_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/list_folders")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
}

// ────────────────────────────────────────────────────────────────────────────
// Public endpoint
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn public_language_settings_reachable_without_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/get_system_language_settings")
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body: Value = resp.json();
    // Shape contract: returns a JSON object (exact fields vary by default).
    assert!(body.is_object(), "expected object body, got {body}");
}

// ────────────────────────────────────────────────────────────────────────────
// DB-backed endpoint
// ────────────────────────────────────────────────────────────────────────────

// Note: `/api/list_folders` invokes every parser against the *real* user home
// directory, so it can't be asserted to-be-empty without elaborate filesystem
// isolation. We test DB-backed endpoints (`load_folder_history`,
// `list_open_folders`) instead — those only touch the in-memory SQLite.

#[tokio::test]
async fn load_folder_history_returns_empty_array_on_fresh_db() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/load_folder_history")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body: Value = resp.json();
    assert_eq!(
        body.as_array().expect("array body").len(),
        0,
        "fresh DB should have no folder history"
    );
}

#[tokio::test]
async fn open_folder_then_list_open_folders_shows_it() {
    let (server, _data, _static) = build_test_server().await;
    let open_resp = server
        .post("/api/open_folder")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({"path": "/tmp/codeg-test-folder"}))
        .await;
    assert_eq!(
        open_resp.status_code(),
        200,
        "open_folder failed: {}",
        open_resp.text()
    );

    let list_resp = server
        .post("/api/list_open_folders")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(list_resp.status_code(), 200);
    let body: Value = list_resp.json();
    let arr = body.as_array().expect("array");
    assert_eq!(
        arr.len(),
        1,
        "list_open_folders should reflect the open_folder call, got {body}"
    );
}

#[tokio::test]
async fn acp_find_connection_for_conversation_returns_null_when_none_live() {
    // No live ACP connection is bound to any conversation on a fresh server, so
    // discovery returns JSON `null` (Option::None) with 200 — the frontend
    // reads this as "no live owner, open the persisted detail instead".
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/acp_find_connection_for_conversation")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({"conversationId": 999, "agentType": "claude_code"}))
        .await;
    assert_eq!(resp.status_code(), 200, "body: {}", resp.text());
    let body: Value = resp.json();
    assert!(
        body.is_null(),
        "expected null for an unbound conversation, got {body}"
    );
}

// ────────────────────────────────────────────────────────────────────────────
// Field naming sanity (snake_case ↔ camelCase boundary)
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn health_endpoint_returns_status_field() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/health")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body: Value = resp.json();
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn unknown_endpoint_returns_501_with_typed_error() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/this_endpoint_does_not_exist")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 501);
    let body: Value = resp.json();
    assert_eq!(body["code"], "not_implemented");
    assert!(body["message"].is_string());
}

// ────────────────────────────────────────────────────────────────────────────
// Live feedback settings + submit gate
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn feedback_settings_round_trip_defaults_off() {
    let (server, _data, _static) = build_test_server().await;
    // Default is OFF (opt-in feature).
    let resp = server
        .post("/api/get_feedback_settings")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    assert_eq!(resp.json::<Value>()["enabled"], false);

    // Enable it.
    let resp = server
        .post("/api/set_feedback_settings")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({ "settings": { "enabled": true } }))
        .await;
    assert_eq!(resp.status_code(), 200);
    assert_eq!(resp.json::<Value>()["enabled"], true);

    // Reads back enabled.
    let resp = server
        .post("/api/get_feedback_settings")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.json::<Value>()["enabled"], true);
}

// The submit gate is per-connection (the agent's actual `check_user_feedback`
// capability), unit-tested in `ConnectionManager::submit_feedback`
// (`submit_feedback_rejected_when_tool_unavailable`), not via the global setting.

// ────────────────────────────────────────────────────────────────────────────
// Response compression (allowlist predicate) + turn-window params
// ────────────────────────────────────────────────────────────────────────────

async fn build_test_server_with_state() -> (
    TestServer,
    Arc<AppState>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");

    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
    let shutdown = Arc::new(ShutdownSignal::new());

    let router = build_router(
        state.clone(),
        TEST_TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        shutdown,
    );

    let server = TestServer::new(router).expect("test server");
    (server, state, data_dir, static_dir)
}

#[tokio::test]
async fn json_api_is_gzip_compressed_when_client_accepts() {
    let (server, state, _data, _static) = build_test_server_with_state().await;
    // Seed one folder so the JSON body clears the size-above threshold. The
    // endpoint has to be a DB-backed one: `/api/list_folders` ignores this
    // row and parses the *real* home directory instead, so it answers `[]`
    // — 2 bytes, under the threshold — on a clean CI runner while returning
    // a fat body on a developer machine.
    codeg_lib::db::service::folder_service::add_folder(
        &state.db.conn,
        "/tmp/codeg-compression-test-folder-with-a-reasonably-long-path",
    )
    .await
    .expect("seed folder");

    // Control: the same body, uncompressed, is over `MIN_COMPRESS_BYTES` —
    // that is what makes the gzip assertion below meaningful rather than an
    // accident of how much the host happens to have on disk.
    let plain = server
        .post("/api/list_open_folders")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(plain.status_code(), 200);
    assert_eq!(
        plain.json::<Value>().as_array().expect("array body").len(),
        1,
        "the seeded folder must be what this endpoint answers with"
    );
    assert!(
        plain.text().len() >= 32,
        "body must clear the size-above threshold, got {} bytes",
        plain.text().len()
    );

    let resp = server
        .post("/api/list_open_folders")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .add_header("accept-encoding", "gzip")
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    assert_eq!(
        resp.headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("gzip"),
        "JSON API responses must be gzip-compressed when the client accepts it"
    );
}

#[tokio::test]
async fn static_js_is_compressed_but_binary_download_is_not() {
    let (server, _data, static_dir) = build_test_server().await;
    let big_text = "console.log('x');\n".repeat(200);
    std::fs::write(static_dir.path().join("chunk.js"), &big_text).expect("write js");
    std::fs::write(static_dir.path().join("blob.bin"), vec![0u8; 4096]).expect("write bin");

    let js = server
        .get("/chunk.js")
        .add_header("accept-encoding", "gzip")
        .await;
    assert_eq!(js.status_code(), 200);
    assert_eq!(
        js.headers()
            .get("content-encoding")
            .and_then(|v| v.to_str().ok()),
        Some("gzip"),
        "static JS must compress"
    );

    let bin = server
        .get("/blob.bin")
        .add_header("accept-encoding", "gzip")
        .await;
    assert_eq!(bin.status_code(), 200);
    assert!(
        bin.headers().get("content-encoding").is_none(),
        "binary responses must stay identity-encoded (Content-Length preserved for progress)"
    );
    assert_eq!(
        bin.headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok()),
        Some("4096"),
        "binary Content-Length must survive the compression layer"
    );
}

#[tokio::test]
async fn get_folder_conversation_accepts_turn_window_params() {
    let (server, state, _data, _static) = build_test_server_with_state().await;
    let folder_id = codeg_lib::db::service::folder_service::add_folder(
        &state.db.conn,
        "/tmp/codeg-window-param-test",
    )
    .await
    .expect("seed folder")
    .id;
    let conv_id = codeg_lib::commands::conversations::create_conversation_core(
        &state.db.conn,
        folder_id,
        codeg_lib::models::AgentType::ClaudeCode,
        None,
    )
    .await
    .expect("create conversation");

    // tailTurns → windowed response: marker fields present even for an empty
    // transcript (offset/total 0, fingerprint = seed).
    let resp = server
        .post("/api/get_folder_conversation")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({ "conversationId": conv_id, "tailTurns": 50 }))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body = resp.json::<Value>();
    assert_eq!(body["turns_offset"], 0);
    assert_eq!(body["turns_total"], 0);
    assert_eq!(body["assistant_turns_before_offset"], 0);
    assert!(body["prefix_hash"].is_string());

    // No params → legacy full response: none of the window fields serialize.
    let resp = server
        .post("/api/get_folder_conversation")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({ "conversationId": conv_id }))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body = resp.json::<Value>();
    assert!(body.get("turns_offset").is_none());
    assert!(body.get("prefix_hash").is_none());

    // Both selectors → invalid input.
    let resp = server
        .post("/api/get_folder_conversation")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({ "conversationId": conv_id, "tailTurns": 5, "fromIndex": 3 }))
        .await;
    assert!(
        resp.status_code().is_client_error(),
        "tailTurns+fromIndex must be rejected, got {}",
        resp.status_code()
    );

    // Turns page endpoint responds with the seam fields.
    let resp = server
        .post("/api/get_folder_conversation_turns")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({ "conversationId": conv_id, "beforeIndex": 10, "limit": 5 }))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body = resp.json::<Value>();
    assert_eq!(body["turns_total"], 0);
    assert!(body["prefix_hash"].is_string());
    assert!(body["prefix_hash_before_index"].is_string());
}

// ────────────────────────────────────────────────────────────────────────────
// codeg-mcp service status
// ────────────────────────────────────────────────────────────────────────────

/// The status endpoint has to answer even in a runtime that never bound a
/// broker socket — that IS the "not running" case the workspace indicator
/// exists to show, so a 500 here would blind exactly the situation it reports.
/// `AppState::new_for_test` installs no service handle, which is that runtime.
#[tokio::test]
async fn codeg_mcp_service_status_reports_a_socketless_runtime_as_stopped() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/get_codeg_mcp_service_status")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body = resp.json::<Value>();
    assert_eq!(body["state"], "stopped");
    assert_eq!(body["listening"], false);
    // No handle ⇒ nothing this process can start; the UI hides its button on
    // this flag rather than offering one that can only fail.
    assert_eq!(body["can_start"], false);
    // The switches ride along regardless of socket health, so the popover can
    // explain a healthy-but-toolless service without a second round trip.
    let groups = body["tool_groups"].as_array().expect("tool_groups array");
    let keys: Vec<&str> = groups.iter().filter_map(|g| g["key"].as_str()).collect();
    assert!(keys.contains(&"delegation"), "got {keys:?}");
    assert!(keys.contains(&"feedback"), "got {keys:?}");
}

/// Starting without a handle must fail loudly rather than report success the
/// UI would then paint as a running service.
#[tokio::test]
async fn starting_codeg_mcp_service_without_a_handle_is_rejected() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/start_codeg_mcp_service")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 422);
}

#[tokio::test]
async fn codeg_mcp_service_status_requires_a_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/get_codeg_mcp_service_status")
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 401);
}

// ────────────────────────────────────────────────────────────────────────────
// DeepSeek Harness model catalog
//
// Read-only side only: the update route writes the caller's real
// `$DSH_HOME/settings.yaml`, which a test must never do. The assertions stay
// content-agnostic for the same reason — the host may or may not have a
// harness settings document, and either is a valid answer here.
// ────────────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn deepseek_model_catalog_is_readable_and_shaped_for_the_panel() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/acp_load_deepseek_model_catalog")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 200);
    let body: Value = resp.json();
    // camelCase on the wire, and every field the panel branches on is present
    // — a missing document is reported in-band, never as an error status.
    assert!(body["path"].is_string(), "got {body}");
    assert!(body["exists"].is_boolean(), "got {body}");
    assert!(body["configured"].is_boolean(), "got {body}");
    assert!(body["models"].is_array(), "got {body}");
    assert!(body["error"].is_string() || body["error"].is_null(), "got {body}");
}

#[tokio::test]
async fn deepseek_model_catalog_requires_a_token() {
    let (server, _data, _static) = build_test_server().await;
    let resp = server
        .post("/api/acp_load_deepseek_model_catalog")
        .json(&json!({}))
        .await;
    assert_eq!(resp.status_code(), 401);
}
