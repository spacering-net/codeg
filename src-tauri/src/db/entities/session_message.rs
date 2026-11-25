use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "session_message")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub message_id: String,
    pub sender_conversation_id: i32,
    pub conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub message: String,
    /// "queue" or "steer"
    pub mode: String,
    /// When the recipient's turn ends, its final text is delivered back to
    /// the sender as a reply message.
    pub reply_back: bool,
    /// queued | dispatching | in_flight | received | completed | failed | interrupted
    pub status: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
