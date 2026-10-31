//! One immutable round of delegated work.
//!
//! A delegation child conversation is a SESSION; a task is one ROUND of work
//! inside it. `delegate_to_agent` opens the session with the first round, and
//! every `continue_delegation` adds another row here that shares the child
//! conversation (and its ACP `external_id`) but owns its own task id, parent
//! tool-call id, status and result. The original `conversation` row keeps its
//! original `delegation_call_id` / `parent_tool_use_id` for compatibility with
//! the pre-ledger world; the ledger is authoritative for anything newer.
//!
//! Rows are append-only: terminal fields are written once and never rewritten
//! by a successor. `source_task_id` is UNIQUE (partial index) so a source can
//! have at most one successor.

use sea_orm::entity::prelude::*;

/// Wire-stable status strings. They mirror the delegation `TaskStatus`
/// vocabulary and are what the ledger, reports and history cards speak.
pub const STATUS_RUNNING: &str = "running";
pub const STATUS_COMPLETED: &str = "completed";
pub const STATUS_FAILED: &str = "failed";
pub const STATUS_CANCELED: &str = "canceled";

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "delegation_task")]
pub struct Model {
    /// Broker task id (UUID). Also the id `delegate_to_agent` returned for the
    /// first round; a continue round mints a fresh one.
    #[sea_orm(primary_key, auto_increment = false)]
    pub task_id: String,
    /// The round this one follows. `NULL` for the original delegation. Unique
    /// when set: one source, at most one successor.
    pub source_task_id: Option<String>,
    /// SHA-256 of the continue request's task text (the original string). NULL
    /// for historical rows backfilled from a conversation and for the first
    /// round, whose text was the `delegate_to_agent` task.
    pub request_hash: Option<String>,
    /// The conversation that issued the delegation.
    pub parent_conversation_id: i32,
    /// The parent-side tool call this round answers (the `delegate_to_agent`
    /// call for round one, the `continue_delegation` call after that).
    pub parent_tool_use_id: Option<String>,
    /// The child conversation hosting the round — shared by every round of one
    /// session.
    pub child_conversation_id: i32,
    pub agent_type: String,
    /// The ACP session id the round ran in, when known. Continue refuses
    /// without one (never `session/new`).
    pub external_session_id: Option<String>,
    /// Absolute working directory the round ran in.
    pub working_dir: Option<String>,
    pub assistant_id: Option<i32>,
    pub assistant_name: Option<String>,
    /// JSON `AssistantRunSnapshot` as it was when the round started.
    pub assistant_snapshot: Option<String>,
    /// Bounded preview of the round's task text.
    pub task_preview: Option<String>,
    pub status: String,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub result_preview: Option<String>,
    pub created_at: DateTimeUtc,
    pub finished_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

impl Model {
    /// Whether this row can be the source of a new continue round.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status.as_str(),
            STATUS_COMPLETED | STATUS_FAILED | STATUS_CANCELED
        )
    }
}
