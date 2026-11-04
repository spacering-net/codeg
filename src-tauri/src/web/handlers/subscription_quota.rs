use crate::{
    app_error::AppCommandError, app_state::AppState, commands::subscription_quota as quota,
};
use axum::{extract::Extension, Json};
use serde::Deserialize;
use std::sync::Arc;
#[derive(Deserialize)]
pub struct Params {
    request: quota::QuotaRequest,
}
pub async fn accounts(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<quota::QuotaAccount>>, AppCommandError> {
    Ok(Json(quota::accounts_core(&state.db).await?))
}
pub async fn read(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<Params>,
) -> Result<Json<quota::OfficialQuotaRead>, AppCommandError> {
    Ok(Json(
        quota::read_core(&state.db, &state.data_dir, params.request).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum_test::TestServer;
    use serde_json::{json, Value};
    #[tokio::test]
    async fn quota_http_obeys_saved_binding_and_requires_authentication() {
        let data = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let sentinel = home.path().join(".credentials.json");
        std::fs::write(&sentinel, "invalid-credential-sentinel").unwrap();
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder =
            crate::db::test_helpers::seed_folder(&db, &data.path().display().to_string()).await;
        let state = Arc::new(AppState::new_for_test(db, data.path().into()));
        let server = TestServer::new(crate::web::router::build_router(
            state,
            "quota-fixture".into(),
            assets.path().into(),
            Arc::new(crate::web::shutdown::ShutdownSignal::new()),
        ))
        .unwrap();
        server
            .post("/api/subscription_quota_accounts")
            .json(&json!({}))
            .await
            .assert_status_unauthorized();
        server
            .post("/api/subscription_quota_read")
            .json(&json!({"request":{"agentType":"claude_code"}}))
            .await
            .assert_status_unauthorized();
        let created = server.post("/api/acp_create_agent_account").add_header("authorization", "Bearer quota-fixture").json(&json!({"agentType":"claude_code","name":"Work","homeDir":home.path().display().to_string()})).await;
        created.assert_status_ok();
        let account: Value = created.json();
        let id = account["id"].as_str().unwrap();
        let conversation = server
            .post("/api/create_conversation")
            .add_header("authorization", "Bearer quota-fixture")
            .json(&json!({"agentType":"claude_code","folderId":folder,"agentAccountId":id}))
            .await;
        conversation.assert_status_ok();
        let cid: i32 = conversation.json();
        let read = server
            .post("/api/subscription_quota_read")
            .add_header("authorization", "Bearer quota-fixture")
            .json(&json!({"request":{"agentType":"claude_code","conversationId":cid}}))
            .await;
        read.assert_status_ok();
        let value: Value = read.json();
        assert_eq!(value["agentAccountId"], id);
        assert_eq!(value["name"], "Work");
        assert!(value["payload"].is_null());
        assert!(value.get("homeDir").is_none());
        assert!(!value.to_string().contains("sentinel"));
        let wrong = server
            .post("/api/subscription_quota_read")
            .add_header("authorization", "Bearer quota-fixture")
            .json(&json!({"request":{"agentType":"codex","agentAccountId":id}}))
            .await;
        assert!(!wrong.status_code().is_success());
        server
            .post("/api/acp_remove_agent_account")
            .add_header("authorization", "Bearer quota-fixture")
            .json(&json!({"accountId":id}))
            .await
            .assert_status_ok();
        let removed = server
            .post("/api/subscription_quota_read")
            .add_header("authorization", "Bearer quota-fixture")
            .json(&json!({"request":{"agentType":"claude_code","conversationId":cid}}))
            .await;
        assert!(!removed.status_code().is_success());
        assert_eq!(
            std::fs::read_to_string(sentinel).unwrap(),
            "invalid-credential-sentinel"
        );
    }
}
