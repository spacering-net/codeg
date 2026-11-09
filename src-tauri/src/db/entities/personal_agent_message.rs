use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum MessageState {
    /// Written, not handed to the receiving assistant yet.
    #[sea_orm(string_value = "queued")]
    Queued,
    /// Handed to it in a delivery.
    #[sea_orm(string_value = "delivered")]
    Delivered,
    /// It wrote back.
    #[sea_orm(string_value = "replied")]
    Replied,
    /// Nothing more is owed on it.
    #[sea_orm(string_value = "closed")]
    Closed,
    /// The owner stopped what it was part of.
    #[sea_orm(string_value = "stopped")]
    Stopped,
    /// Its thread went round without progress and was stopped.
    #[sea_orm(string_value = "looped")]
    Looped,
    #[sea_orm(string_value = "canceled")]
    Canceled,
}

/// One assistant's message to another (`personal_agent.id` on both ends).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_message")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The thread it is on: the id of the message the thread started with.
    pub thread_id: Option<i32>,
    pub from_bot_id: i32,
    pub to_bot_id: i32,
    /// The message it answers.
    pub reply_to: Option<i32>,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    pub wants_reply: bool,
    pub state: MessageState,
    /// The sender's delivery it was sent from.
    pub sent_batch_id: Option<i32>,
    /// The receiver's delivery it was handed over in.
    pub delivered_batch_id: Option<i32>,
    /// Where the chain it belongs to started.
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    /// The input it was sent for: `<kind>:<id>`.
    #[sea_orm(column_type = "Text", nullable)]
    pub for_input: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
