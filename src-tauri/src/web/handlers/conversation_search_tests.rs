use super::*;
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::test_helpers::{fresh_in_memory_db, seed_folder};

#[tokio::test]
async fn search_route_returns_flattened_conversations_with_matches() {
    let db = fresh_in_memory_db().await;
    let data = tempfile::tempdir().unwrap();
    agent_setting_service::ensure_defaults(
        &db.conn,
        &[agent_setting_service::AgentDefaultInput {
            agent_type: AgentType::Codex,
            registry_id: "codex".into(),
            default_sort_order: 0,
        }],
    )
    .await
    .unwrap();
    agent_setting_service::update_preferences(
        &db.conn,
        AgentType::Codex,
        true,
        Some(serde_json::json!({"CODEX_HOME":data.path()}).to_string()),
    )
    .await
    .unwrap();
    let folder_id = seed_folder(&db, "/search-http-test").await;
    let row = conversation_service::create(
        &db.conn,
        folder_id,
        AgentType::Codex,
        Some("Search route title".into()),
        None,
    )
    .await
    .unwrap();
    let state = Arc::new(AppState::new_for_test(db, data.path().to_path_buf()));
    let router = crate::web::router::build_router(
        state,
        "search-test-token".into(),
        data.path().to_path_buf(),
        Arc::new(crate::web::shutdown::ShutdownSignal::new()),
    );
    let server = axum_test::TestServer::new(router).unwrap();
    server
        .post("/api/search_conversations")
        .json(&serde_json::json!({}))
        .await
        .assert_status_unauthorized();
    let response = server
        .post("/api/search_conversations")
        .authorization_bearer("search-test-token")
        .json(&serde_json::json!({"folderIds":[folder_id],"search":"route"}))
        .await;
    response.assert_status_ok();
    let results: serde_json::Value = response.json();
    assert_eq!(results.as_array().unwrap().len(), 1);
    assert_eq!(results[0]["id"], row.id);
    assert_eq!(results[0]["title"], "Search route title");
    assert_eq!(results[0]["matches"], serde_json::json!([]));
}
