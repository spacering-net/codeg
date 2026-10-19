//! `/api/cli_*` on the main router: what `codeg-cli --url … --token …` talks
//! to on a remote `codeg-server`.
//!
//! The loopback listener (CLI token, `Host` check, discovery file) is tested
//! next to it, in `cli_run::listener`. Runs that reach an agent are tested
//! against a scripted connection in `cli_run::service`; nothing here spawns
//! one, and nothing reads the real home directory.

use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::cli_run::hello;
use codeg_lib::cli_run::wire::{HelloResponse, API_VERSION};
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TOKEN: &str = "cli-integration-token";

async fn server() -> (TestServer, tempfile::TempDir, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");
    let state = Arc::new(AppState::new_for_test(
        fresh_in_memory_db().await,
        data_dir.path().to_path_buf(),
    ));
    let router = build_router(
        state,
        TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    );
    (
        TestServer::new(router).expect("server"),
        data_dir,
        static_dir,
    )
}

#[tokio::test]
async fn the_cli_routes_take_the_main_token() {
    let (server, _data, _static) = server().await;
    for route in [
        "/api/cli_run_reserve",
        "/api/cli_run_events",
        "/api/cli_run_cancel",
        "/api/cli_run_get",
        "/api/cli_run_find",
        "/api/cli_automations",
        "/api/cli_automation_run",
        "/api/cli_automation_run_get",
        "/api/cli_agent_install",
        "/api/cli_agent_install_get",
        "/api/cli_agents",
        "/api/cli_assistants",
    ] {
        let missing = server.post(route).json(&json!({})).await;
        assert_eq!(missing.status_code(), 401, "{route} without a token");
        let wrong = server
            .post(route)
            .add_header("authorization", "Bearer nope")
            .json(&json!({}))
            .await;
        assert_eq!(wrong.status_code(), 401, "{route} with a wrong token");
    }
    let reserved = server
        .post("/api/cli_run_reserve")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({}))
        .await;
    assert_eq!(reserved.status_code(), 200);
    let body: Value = reserved.json();
    let run_id = body["runId"].as_str().expect("a run id").to_string();
    assert!(body["expiresInMs"].as_u64().unwrap() > 0);

    // A reserved run reads as reserved; an unknown one as gone.
    let got = server
        .post("/api/cli_run_get")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({ "runId": run_id }))
        .await;
    assert_eq!(got.json::<Value>()["state"], "reserved");
    let missing = server
        .post("/api/cli_run_events")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({ "runId": "no-such-run", "after": 0, "waitMs": 0 }))
        .await;
    assert_eq!(missing.status_code(), 404);
    let body: Value = missing.json();
    assert_eq!(body["subtype"], "error_runtime_unavailable");
    assert_eq!(body["error"]["code"], "run_not_found");
}

/// Over `--url` the challenge is keyed by the main token and binds no port: a
/// proxy in front of the server may hide it.
#[tokio::test]
async fn hello_answers_without_a_token_and_proves_the_main_token() {
    let (server, _data, _static) = server().await;
    let nonce = hello::random_hex(16);
    let resp = server
        .post("/api/cli_hello")
        .json(&json!({ "nonce": nonce, "clientVersion": "test", "apiVersion": API_VERSION }))
        .await;
    assert_eq!(resp.status_code(), 200);
    let answer: HelloResponse = resp.json();
    assert!(hello::verify(TOKEN, &nonce, None, &answer.proof));
    assert!(!hello::verify("other-token", &nonce, None, &answer.proof));
    for capability in [
        "run",
        "effort",
        "run_lookup",
        "worktree",
        "automations",
        "agent_install",
    ] {
        assert!(
            answer.capabilities.iter().any(|c| c == capability),
            "{capability} in {:?}",
            answer.capabilities
        );
    }

    let old = server
        .post("/api/cli_hello")
        .json(&json!({ "nonce": nonce, "clientVersion": "test", "apiVersion": 999 }))
        .await;
    assert_eq!(old.status_code(), 409);
    assert_eq!(old.json::<Value>()["subtype"], "error_runtime_incompatible");
}

/// `codeg-cli result 8d0c7c2e`: a run found by the start of its id, and a
/// start too short to be one refused.
#[tokio::test]
async fn a_run_is_looked_up_by_the_start_of_its_id() {
    let (server, _data, _static) = server().await;
    let find = |prefix: &'static str| {
        server
            .post("/api/cli_run_find")
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&json!({ "prefix": prefix }))
    };
    let none = find("8d0c7c2e").await;
    assert_eq!(none.status_code(), 200);
    assert_eq!(none.json::<Value>()["runs"], json!([]));
    let short = find("8d0c").await;
    assert_eq!(short.status_code(), 400);
    let body: Value = short.json();
    assert_eq!(body["subtype"], "error_usage");
    assert_eq!(body["error"]["code"], "bad_run_id");
}

/// `codeg-cli automations` and `codeg-cli agents install` over `--url`: no
/// automation to list, none to run, and an install refused before it starts.
#[tokio::test]
async fn automations_and_installs_answer_over_the_main_api() {
    let (server, _data, _static) = server().await;
    let post = |route: &'static str, body: Value| {
        server
            .post(route)
            .add_header("authorization", format!("Bearer {TOKEN}"))
            .json(&body)
    };
    let listed = post("/api/cli_automations", json!({})).await;
    assert_eq!(listed.status_code(), 200);
    assert_eq!(listed.json::<Value>(), json!([]));

    let run = post("/api/cli_automation_run", json!({ "automationId": 7 })).await;
    assert_eq!(run.status_code(), 400);
    assert_eq!(run.json::<Value>()["error"]["code"], "unknown_automation");

    let install = post("/api/cli_agent_install", json!({ "agent": "kiro" })).await;
    assert_eq!(install.status_code(), 400);
    assert_eq!(install.json::<Value>()["error"]["code"], "not_installable");
    let missing = post("/api/cli_agent_install_get", json!({ "installId": "x" })).await;
    assert_eq!(missing.status_code(), 404);
    assert_eq!(
        missing.json::<Value>()["error"]["code"],
        "install_not_found"
    );
}

#[tokio::test]
async fn a_start_with_a_relative_workspace_is_a_usage_error() {
    let (server, _data, _static) = server().await;
    let auth = format!("Bearer {TOKEN}");
    let reserved: Value = server
        .post("/api/cli_run_reserve")
        .add_header("authorization", auth.clone())
        .json(&json!({}))
        .await
        .json();
    let resp = server
        .post("/api/cli_run_start")
        .add_header("authorization", auth)
        .json(&json!({
            "runId": reserved["runId"],
            "workspace": "relative/dir",
            "agent": "claude_code",
            "prompt": [{ "type": "text", "text": "hi" }],
            "permissions": "deny"
        }))
        .await;
    assert_eq!(resp.status_code(), 400);
    let body: Value = resp.json();
    assert_eq!(body["subtype"], "error_usage");
    assert_eq!(body["error"]["code"], "workspace_not_absolute");
}

#[tokio::test]
async fn the_access_setting_is_reachable_with_the_main_token() {
    let (server, _data, _static) = server().await;
    let auth = format!("Bearer {TOKEN}");
    let status: Value = server
        .post("/api/cli_access_status")
        .add_header("authorization", auth.clone())
        .json(&json!({}))
        .await
        .json();
    assert_eq!(status["enabled"], true, "on unless switched off");
    assert_eq!(status["running"], false, "nothing started it in this test");
    let off: Value = server
        .post("/api/cli_access_set_enabled")
        .add_header("authorization", auth)
        .json(&json!({ "enabled": false }))
        .await
        .json();
    assert_eq!(off["enabled"], false);
}
