use super::delegation::transport::{AssistantActionResult, AssistantSessionList};
use async_trait::async_trait;

#[async_trait]
pub trait AssistantToolAccess: Send + Sync {
    async fn is_assistant_connection(&self, conn_id: &str) -> bool;
    async fn list_sessions(&self, exclude_conn_id: &str) -> AssistantSessionList;
    async fn focus_session(&self, session_id: i64) -> AssistantActionResult;
    /// `requester_conn_id` is the assistant's own connection id, used to
    /// register the confirmation card on its conversation.
    async fn send_to_session(
        &self,
        requester_conn_id: &str,
        session_id: i64,
        text: String,
    ) -> AssistantActionResult;
    async fn cancel_session(
        &self,
        requester_conn_id: &str,
        session_id: i64,
    ) -> AssistantActionResult;
    async fn answer_permission(
        &self,
        requester_conn_id: &str,
        session_id: i64,
        decision: String,
    ) -> AssistantActionResult;
    async fn start_session(
        &self,
        requester_conn_id: &str,
        folder_id: i64,
        agent_type: String,
        task: String,
    ) -> AssistantActionResult;
}
