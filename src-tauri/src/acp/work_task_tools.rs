//! Listener-facing access for the work-task reporting tools (`task_progress` /
//! `task_complete`) carried by codeg-mcp. The listener resolves the caller's
//! parent connection from its per-launch token and hands the report here; the
//! production impl (`crate::work_task::engine::EngineWorkTaskTools`) maps the
//! connection to the owning task + execution generation and records it. Kept as
//! a trait so the listener stays decoupled from the engine (and tests can stub
//! it). Mirrors [`crate::acp::session_info::SessionInfoAccess`].

use async_trait::async_trait;
use serde::Serialize;

/// Ack for a task report: whether it was attributed and recorded, plus a
/// human-readable note the agent reads when it was not (it just carries on).
#[derive(Debug, Clone, Serialize)]
pub struct TaskReportAck {
    pub recorded: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl TaskReportAck {
    pub fn recorded() -> Self {
        Self {
            recorded: true,
            note: None,
        }
    }

    pub fn rejected(note: &str) -> Self {
        Self {
            recorded: false,
            note: Some(note.to_string()),
        }
    }
}

#[async_trait]
pub trait WorkTaskToolAccess: Send + Sync {
    /// Record a progress milestone for the task driven by
    /// `parent_connection_id`.
    async fn report_progress(&self, parent_connection_id: &str, message: &str) -> TaskReportAck;

    /// Record the final verdict (+ optional summary) for the task driven by
    /// `parent_connection_id`; the verdict decides how the task settles when
    /// the turn ends. `thread_replies` are the comments drafted for the forge
    /// threads the task came from (empty for most tasks).
    async fn complete(
        &self,
        parent_connection_id: &str,
        verdict: &str,
        summary: Option<&str>,
        thread_replies: &[crate::acp::delegation::transport::ThreadReply],
    ) -> TaskReportAck;
}
