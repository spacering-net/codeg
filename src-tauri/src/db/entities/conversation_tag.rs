use sea_orm::entity::prelude::*;

/// A user-defined conversation label: a name plus one colour.
///
/// `folder_id` is the tag's SCOPE. NULL = a global tag, offered on every
/// conversation (chat-mode ones included). Otherwise the ROOT folder that owns
/// it — never a worktree child, whose conversations resolve to their root — and
/// the tag is offered only on that folder family's conversations.
///
/// Hard-deleted (no `deleted_at`): its links cascade away with it. See
/// `m20261006_000001_conversation_tag`.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "conversation_tag")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub folder_id: Option<i32>,
    #[sea_orm(column_type = "Text")]
    pub name: String,
    /// Normalized `#rrggbb`. One colour for both themes: the UI derives the
    /// light and dark chip treatments from it.
    #[sea_orm(column_type = "Text")]
    pub color: String,
    /// Position among the tags of the same scope.
    pub sort_order: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::folder::Entity",
        from = "Column::FolderId",
        to = "super::folder::Column::Id",
        on_delete = "Cascade"
    )]
    Folder,
    #[sea_orm(has_many = "super::conversation_tag_link::Entity")]
    Links,
}

impl Related<super::folder::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Folder.def()
    }
}

impl Related<super::conversation_tag_link::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Links.def()
    }
}

impl ActiveModelBehavior for ActiveModel {}
