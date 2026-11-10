use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "subsession_message")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub message_id: String,
    pub parent_conversation_id: i32,
    pub child_conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub message: String,
    pub delivery: String,
    pub status: String,
    pub owner_pid: Option<i64>,
    #[sea_orm(column_type = "Text", nullable)]
    pub result: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}
impl ActiveModelBehavior for ActiveModel {}
