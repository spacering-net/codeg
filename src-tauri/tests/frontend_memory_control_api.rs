//! Real auth/router boundary with an owned in-memory DB; never parses history.
use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

#[tokio::test]
async fn frontend_memory_control_requires_auth_and_obeys_build_gate() {
    let data = tempfile::tempdir().unwrap();
    let assets = tempfile::tempdir().unwrap();
    let state = Arc::new(AppState::new_for_test(
        fresh_in_memory_db().await,
        data.path().to_path_buf(),
    ));
    let server = TestServer::new(build_router(
        state,
        "owned-test-token".to_owned(),
        assets.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    ))
    .unwrap();
    let path = "/api/debug/frontend_memory/control";
    let request =
        json!({"reportingEnabled":false,"browserCountersEnabled":false,"sampleOnce":true});
    assert_eq!(server.get(path).await.status_code(), 401);
    assert_eq!(server.post(path).json(&request).await.status_code(), 401);
    let before: Value = server
        .get(path)
        .add_header("authorization", "Bearer owned-test-token")
        .await
        .json();
    assert_eq!(before["enabled"], cfg!(feature = "memory-diagnostics"));
    let response = server
        .post(path)
        .add_header("authorization", "Bearer owned-test-token")
        .json(&request)
        .await;
    if cfg!(feature = "memory-diagnostics") {
        response.assert_status_ok();
        let control: Value = response.json();
        assert_eq!(control["reportingEnabled"], false);
        assert_eq!(control["sampleSequence"], 1);
        let after: Value = server
            .get(path)
            .add_header("authorization", "Bearer owned-test-token")
            .await
            .json();
        assert_eq!(after["control"], control);
        // Setter success is not a renderer acknowledgement.
        assert!(after["acknowledgements"].as_array().unwrap().is_empty());
    } else {
        response.assert_status_bad_request();
        assert!(before["control"].is_null());
        assert!(before["acknowledgements"].as_array().unwrap().is_empty());
    }
}
