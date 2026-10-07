use sea_orm::entity::prelude::*;

/// One canvas: a named infinite board the user opens from the canvas list.
/// Every `canvas_node` belongs to exactly one (`canvas_node.board_id`); the
/// board-level invariants — color vocabulary, text normalization, deleting a
/// board together with its nodes — live in `canvas_service`, the same single
/// write chokepoint the nodes go through.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "canvas_board")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// NULL = never named; the client shows a localized "Untitled canvas".
    #[sea_orm(column_type = "Text", nullable)]
    pub name: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub description: Option<String>,
    /// Theme-preset color name (FolderThemeColor vocabulary).
    #[sea_orm(column_type = "Text", nullable)]
    pub color: Option<String>,
    pub created_at: DateTimeUtc,
    /// Last change to the board OR anything on it: node writes touch it in the
    /// same transaction, which is what the canvas list orders by.
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
