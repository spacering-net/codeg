use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    #[sea_orm(string_value = "dispatch")]
    Dispatch,
    #[sea_orm(string_value = "reminder")]
    Reminder,
    #[sea_orm(string_value = "followup")]
    Followup,
    #[sea_orm(string_value = "question")]
    Question,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ItemStatus {
    #[sea_orm(string_value = "open")]
    Open,
    #[sea_orm(string_value = "waiting")]
    Waiting,
    #[sea_orm(string_value = "done")]
    Done,
    #[sea_orm(string_value = "dropped")]
    Dropped,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum WaitsFor {
    #[sea_orm(string_value = "owner")]
    Owner,
    #[sea_orm(string_value = "agent")]
    Agent,
    #[sea_orm(string_value = "time")]
    Time,
    #[sea_orm(string_value = "external")]
    External,
}

/// One open matter on the personal agent's ledger.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_item")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub kind: ItemKind,
    pub dispatch_id: Option<i32>,
    pub status: ItemStatus,
    pub waits_for: Option<WaitsFor>,
    #[sea_orm(column_type = "Text")]
    pub summary: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub on_done: Option<String>,
    pub origin_timeline_id: Option<i32>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
