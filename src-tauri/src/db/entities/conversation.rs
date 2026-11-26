use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ConversationStatus {
    #[sea_orm(string_value = "in_progress")]
    InProgress,
    #[sea_orm(string_value = "pending_review")]
    PendingReview,
    #[sea_orm(string_value = "completed")]
    Completed,
    #[sea_orm(string_value = "cancelled")]
    Cancelled,
}

/// What kind of row this conversation is — drives sidebar visibility and
/// grouping. `regular` renders under its folder group; `chat` renders in the
/// flat "Chat" section; `loop` belongs to the Loop Engineering workbench and is
/// excluded from the sidebar list entirely (no write path yet — reserved for
/// the loop engine); `delegate` is a delegation child nested under its
/// parent's tool-call view; `personal` is one session segment of the personal
/// agent, which has its own page and stays out of the sidebar list too; `ask`
/// is an "ask about this selection" conversation, nested under the
/// conversation it was asked from (its `parent_id`) in the sidebar and listed
/// in that conversation's Session Details; `check` is the personal agent's
/// check of a message (or a sentence of one) of a conversation — "is this
/// right?" — nested and listed the same way under the conversation the
/// message is in. Invariant: `kind ∈ {Delegate, Ask, Check}` ⟺
/// `parent_id IS NOT NULL`, and only a `Delegate` row carries the
/// delegation columns (`parent_tool_use_id`, `delegation_call_id`,
/// `assistant_*`). Written once at insert — a check's row is nested under the
/// conversation it checks as it is created (`conversation_service::
/// create_check`) — with two exceptions: a chat conversation the user moves
/// into a project becomes `regular`
/// (`conversation_service::relocate_conversations`) — it is an ordinary
/// project conversation from then on — and an ask or a check the user
/// converts into an ordinary conversation becomes `regular` / `chat` with no
/// `parent_id` (`conversation_service::detach_ask`).
#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ConversationKind {
    #[sea_orm(string_value = "regular")]
    Regular,
    #[sea_orm(string_value = "chat")]
    Chat,
    #[sea_orm(string_value = "loop")]
    Loop,
    #[sea_orm(string_value = "delegate")]
    Delegate,
    #[sea_orm(string_value = "personal")]
    Personal,
    #[sea_orm(string_value = "ask")]
    Ask,
    #[sea_orm(string_value = "check")]
    Check,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub folder_id: i32,
    pub title: Option<String>,
    /// True once a deliberate user action fixed this conversation's name:
    /// a manual rename, or the `[Fork] ` prefix a fork stamps on the row it
    /// re-points. Gates the per-turn auto-title backfill (see
    /// `get_folder_conversation_core`) so such a title is never overwritten by
    /// a parsed session-file title.
    pub title_locked: bool,
    pub agent_type: String,
    pub status: ConversationStatus,
    pub kind: ConversationKind,
    pub model: Option<String>,
    pub git_branch: Option<String>,
    pub external_id: Option<String>,
    pub parent_id: Option<i32>,
    pub parent_tool_use_id: Option<String>,
    pub delegation_call_id: Option<String>,
    pub message_count: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
    /// When the user pinned this conversation; `None` means not pinned. Drives
    /// the sidebar's "Pinned" section (sorted by this timestamp descending).
    /// Pinning never bumps `updated_at` — it is a view preference, not activity.
    pub pinned_at: Option<DateTimeUtc>,
    /// The working directory this conversation's session was recorded in, when
    /// that differs from its (current) folder's path — written when a deleted
    /// task worktree's conversations are re-parented to the project folder, or
    /// when the user moves a conversation to another project (see
    /// `conversation_service::effective_origin_after_move`). The
    /// Gemini/Cline/OpenClaw stale-external-id fallback matches on
    /// `origin_cwd ?? folder.path`, and the chat scratch-dir GC keeps a dir a
    /// live row remembers. NULL for conversations that never moved.
    pub origin_cwd: Option<String>,
    /// The assistant a delegation child ran as; `None` for every other row.
    /// Written once with the child, never updated, and deliberately not a
    /// foreign key — the child keeps its identity even if the assistant row
    /// is gone. See `m20261016_000002_conversation_assistant`.
    pub assistant_id: Option<i32>,
    /// JSON `AssistantRunSnapshot`: the assistant's name, options and
    /// instructions as they were when the delegation started. A resume replays
    /// this, never the assistant's current row.
    pub assistant_snapshot: Option<String>,
    /// The owner's assistant (`personal_agent.uid`) a delegation child or a
    /// piece of an assistant's work ran as; `None` for every other row, and
    /// for the children of the collaboration settings' assistants from
    /// before (`assistant_id`). Written once, never updated, no foreign key,
    /// like `assistant_id`. See `m20261125_000001_personal_agent`.
    #[sea_orm(column_type = "Text", nullable)]
    pub bot_uid: Option<String>,
    /// Where the conversation was started from, when not the window:
    /// [`SOURCE_CLI`] for a `codeg-cli` run. `None` otherwise. Text, so a
    /// value from a newer build never stops an older one decoding the row.
    /// See `m20261017_000002_conversation_source`.
    pub source: Option<String>,
    /// JSON `ConversationSelection`: this conversation's own selector state
    /// (applied mode, pending composer mode, config option values), written
    /// by the backend from the live session and replayed alone when the
    /// conversation reconnects. `None` for rows from before the column (a
    /// one-time fallback, then frozen). Never bumps `updated_at`. See
    /// `m20261123_000001_conversation_selector_state`.
    pub selector_state: Option<String>,
}

/// [`Model::source`] of a conversation a `codeg-cli` run started.
pub const SOURCE_CLI: &str = "cli";

/// [`Model::source`] of a conversation the personal agent dispatched to a role
/// assistant (a chat or a work conversation).
pub const SOURCE_PERSONAL_AGENT: &str = "personal_agent";

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id"
    )]
    Folder,
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
