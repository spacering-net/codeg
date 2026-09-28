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
/// parent's tool-call view. Invariant: `kind == Delegate` ⟺ `parent_id IS NOT
/// NULL`. Written once at insert, never updated.
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
    /// the sidebar's "Pinned" section (sorted by this timestamp descending,
    /// except for rows placed by hand — see `pin_order`). Pinning never bumps
    /// `updated_at` — it is a view preference, not activity.
    pub pinned_at: Option<DateTimeUtc>,
    /// Manual position within the "Pinned" section (0 = top), written when the
    /// user drags the section into an order of their own. `None` until then,
    /// and cleared again by every pin / unpin; such rows sort above the placed
    /// ones, most recently pinned first.
    pub pin_order: Option<i32>,
    /// The working directory this conversation actually ran in, when that
    /// differs from its (current) folder's path — written when a deleted task
    /// worktree's conversations are re-parented to the project folder. The
    /// Gemini/Cline/OpenClaw stale-external-id fallback matches on
    /// `origin_cwd ?? folder.path`. Always NULL for ordinary conversations.
    pub origin_cwd: Option<String>,
}

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
