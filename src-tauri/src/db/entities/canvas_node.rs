use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// What a canvas node is bound to. The four binding kinds mirror the product
/// requirement (a region shows a folder's conversations, a folder GROUP's
/// conversations, one conversation, or one agent's conversations); `custom` is
/// a hand-curated collection, `note` is a free-floating sticky, and `file` /
/// `terminal` bind the board to a place on disk (a document to read, a shell to
/// work in). One enum — and one table — because every kind shares geometry,
/// lifecycle and the `canvas://changed` side-channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum CanvasNodeKind {
    #[sea_orm(string_value = "folder")]
    Folder,
    /// Bound to a sidebar folder group: shows every conversation of every
    /// folder in the group (worktree children included, like `Folder`).
    #[sea_orm(string_value = "group")]
    Group,
    #[sea_orm(string_value = "agent")]
    Agent,
    #[sea_orm(string_value = "conversation")]
    Conversation,
    #[sea_orm(string_value = "custom")]
    Custom,
    #[sea_orm(string_value = "note")]
    Note,
    /// A read-only view of one file on disk, bound by absolute `path`.
    #[sea_orm(string_value = "file")]
    File,
    /// A shell running in `path` (its working directory). The PTY itself is
    /// runtime state keyed off the row id — only the placement is persisted.
    #[sea_orm(string_value = "terminal")]
    Terminal,
}

impl CanvasNodeKind {
    /// Whether this kind renders a member grid (and therefore honours the
    /// `grid_columns` / `grid_rows` shape and accepts member drops). Pinned
    /// cards, notes, files and terminals are single elements, not containers.
    pub fn is_region(self) -> bool {
        matches!(
            self,
            CanvasNodeKind::Folder
                | CanvasNodeKind::Group
                | CanvasNodeKind::Agent
                | CanvasNodeKind::Custom
        )
    }

    /// Whether this kind is bound to a filesystem `path` — required and
    /// non-empty for these, forbidden for every other kind.
    pub fn needs_path(self) -> bool {
        matches!(self, CanvasNodeKind::File | CanvasNodeKind::Terminal)
    }
}

/// One element on the conversation canvas. `folder_id` / `conversation_id` are
/// soft references (their targets soft-delete); kind-specific invariants —
/// which binding columns must be set, member validation — live in
/// `canvas_service`, the single write chokepoint.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "canvas_node")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub kind: CanvasNodeKind,
    pub folder_id: Option<i32>,
    /// kind=group only: the sidebar folder group this region mirrors.
    pub folder_group_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_type: Option<String>,
    pub conversation_id: Option<i32>,
    /// kind=custom only: JSON array of conversation ids, insertion order.
    #[sea_orm(column_type = "Text", nullable)]
    pub member_ids: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub title: Option<String>,
    /// kind=note only.
    #[sea_orm(column_type = "Text", nullable)]
    pub content: Option<String>,
    /// kind=file: the absolute path of the document shown on the card.
    /// kind=terminal: the absolute working directory its shell is spawned in.
    /// NULL for every other kind (see `CanvasNodeKind::needs_path`).
    #[sea_orm(column_type = "Text", nullable)]
    pub path: Option<String>,
    /// Theme-preset color name (FolderThemeColor vocabulary).
    #[sea_orm(column_type = "Text", nullable)]
    pub color: Option<String>,
    pub collapsed: bool,
    /// Region grid shape. 0 = auto (columns derived from `width`, rows capped by
    /// the frontend's visible-member cap); >0 pins that axis, which is what
    /// makes a resize step by whole cards. Ignored by non-region kinds.
    pub grid_columns: i32,
    pub grid_rows: i32,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
