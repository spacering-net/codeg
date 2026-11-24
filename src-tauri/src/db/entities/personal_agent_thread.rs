use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ThreadState {
    #[sea_orm(string_value = "open")]
    Open,
    /// The owner stopped it.
    #[sea_orm(string_value = "stopped")]
    Stopped,
    /// It went round without progress and was stopped.
    #[sea_orm(string_value = "looped")]
    Looped,
}

/// The exchange a first message between assistants starts; its id is that
/// message's.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_thread")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: i32,
    pub state: ThreadState,
    /// JSON: the back-and-forth count of each pair of assistants on it.
    #[sea_orm(column_type = "Text")]
    pub counts: String,
    pub last_progress_at: Option<DateTimeUtc>,
    pub origin_bot_id: Option<i32>,
    pub origin_row_id: Option<i32>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
