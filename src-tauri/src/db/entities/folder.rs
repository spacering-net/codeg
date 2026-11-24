use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Folder classification. `regular` folders are user-facing; `chat` folders
/// are hidden per-conversation scratch dirs backing folderless chat mode
/// (excluded from folder lists; their conversations route to the sidebar
/// "Chat" group). A `loop_worktree` variant is reserved for M2+ engine-created
/// worktrees — add it then. Written once at insert, never updated.
#[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum FolderKind {
    #[sea_orm(string_value = "regular")]
    Regular,
    #[sea_orm(string_value = "chat")]
    Chat,
}

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "folder")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub name: String,
    #[sea_orm(unique)]
    pub path: String,
    pub git_branch: Option<String>,
    pub default_agent_type: Option<String>,
    pub last_opened_at: DateTimeUtc,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub deleted_at: Option<DateTimeUtc>,
    pub is_open: bool,
    pub sort_order: i32,
    pub color: String,
    /// Root folder this one was created under (for worktree folders). NULL for
    /// top-level folders. Flattened: a worktree of a worktree still points at the
    /// original root, never an intermediate worktree.
    pub parent_id: Option<i32>,
    /// See [`FolderKind`]. Replaces the former `is_chat` boolean.
    pub kind: FolderKind,
    /// User-supplied display alias. NULL means "no alias" — the UI falls back to
    /// the path-derived `name`. When set, surfaces render `alias [name]`.
    pub alias: Option<String>,
    /// Sidebar folder group this folder sits in; NULL = top level. Only
    /// top-level folders carry one — a worktree child (`parent_id` set) always
    /// stays NULL and follows its repo. A dangling id (group deleted
    /// concurrently) is tolerated: the sidebar falls the folder back to top
    /// level. See `super::folder_group`.
    pub group_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::conversation::Entity")]
    Conversations,

    #[sea_orm(has_many = "super::opened_tab::Entity")]
    OpenedTabs,

    #[sea_orm(has_many = "super::folder_command::Entity")]
    FolderCommands,

    #[sea_orm(
        belongs_to = "super::folder_group::Entity",
        from = "Column::GroupId",
        to = "super::folder_group::Column::Id"
    )]
    FolderGroup,
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversations.def()
    }
}

impl Related<super::opened_tab::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::OpenedTabs.def()
    }
}

impl Related<super::folder_command::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FolderCommands.def()
    }
}

impl Related<super::folder_group::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::FolderGroup.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
