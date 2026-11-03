use sea_orm::entity::prelude::*;

/// One row per queued message in a conversation's "send later" queue.
///
/// The queue is keyed by `owner_id` (a conversation id). `item_uid` is a
/// client-generated UUID that is stable across edits, so reordering and updates
/// can target the same logical item without a server round-trip for ids. The
/// `draft` is stored as JSON because `PromptDraft` is a frontend-only type.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "message_queue_item")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub owner_id: String,
    pub item_uid: String,
    #[sea_orm(column_type = "Text")]
    pub draft_json: String,
    pub mode_id: Option<String>,
    pub adopt_send_time_mode: bool,
    pub sort_order: i32,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
