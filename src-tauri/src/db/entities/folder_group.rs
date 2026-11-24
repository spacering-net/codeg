use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// A user-named container for workspace folders, used only to organise the
/// sidebar's "Folders" section. Groups never nest, and only `regular` folders
/// can belong to one — worktree children follow their parent repo instead.
///
/// Hard-deleted (no `deleted_at`): removing a group clears `folder.group_id` on
/// its members and drops the row. See `m20260829_000001_folder_group`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "folder_group")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    /// One of the shared theme colors, or `"inherit"` (use the app theme). Only
    /// ever tints the group's own header row — members keep their own color.
    #[sea_orm(column_type = "Text")]
    pub color: String,
    /// Position among TOP-LEVEL siblings, sharing one numeric space with the
    /// `sort_order` of ungrouped folders so the two interleave in the sidebar.
    pub sort_order: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(has_many = "super::folder::Entity")]
    Folders,
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folders.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
