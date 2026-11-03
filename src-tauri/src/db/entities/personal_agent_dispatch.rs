use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum DispatchMode {
    /// A kanban task in the target project's worktree.
    #[sea_orm(string_value = "task")]
    Task,
    /// A chat-mode conversation in a scratch directory.
    #[sea_orm(string_value = "chat")]
    Chat,
    /// A conversation in the target project's current checkout.
    #[sea_orm(string_value = "session")]
    Session,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum DispatchState {
    /// Waiting for a slot (conversation modes) or for the task to start.
    #[sea_orm(string_value = "queued")]
    Queued,
    #[sea_orm(string_value = "running")]
    Running,
    /// Blocked on a question or permission request in its own session.
    #[sea_orm(string_value = "waiting_input")]
    WaitingInput,
    /// A kanban task waiting for the owner's review.
    #[sea_orm(string_value = "review")]
    Review,
    #[sea_orm(string_value = "completed")]
    Completed,
    #[sea_orm(string_value = "failed")]
    Failed,
    #[sea_orm(string_value = "canceled")]
    Canceled,
    /// A restart took the conversation's process down mid-turn.
    #[sea_orm(string_value = "interrupted")]
    Interrupted,
    /// The owner wrote in the conversation; the assistant leaves it alone.
    #[sea_orm(string_value = "handed_over")]
    HandedOver,
}

/// One piece of work the personal agent handed to a role assistant.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_dispatch")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub mode: DispatchMode,
    pub executor_assistant_id: i32,
    /// JSON `DispatchExecutorSnapshot`.
    #[sea_orm(column_type = "Text")]
    pub executor_snapshot: String,
    pub folder_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub deliverable: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub prompt: String,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub connection_id: Option<String>,
    pub state: DispatchState,
    #[sea_orm(column_type = "Text", nullable)]
    pub result_excerpt: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub origin_batch_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub on_done: Option<String>,
    pub turns: i32,
    /// A follow-up waiting for a free session slot (the dispatch is `queued`
    /// again); sent and cleared when it starts.
    #[sea_orm(column_type = "Text", nullable)]
    pub followup: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub finished_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
