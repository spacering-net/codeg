use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum EventState {
    /// Waiting for the next delivery.
    #[sea_orm(string_value = "pending")]
    Pending,
    /// Riding in the batch named by `batch_id`.
    #[sea_orm(string_value = "delivered")]
    Delivered,
    #[sea_orm(string_value = "done")]
    Done,
}

/// Progress of dispatched work, queued for the assistant.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_event")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 'dispatch_status' | 'system'
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    #[sea_orm(column_type = "Text", unique)]
    pub source_key: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub coalesce_key: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub summary: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub payload: Option<String>,
    /// Whether it should start a turn on its own; progress rides along only.
    pub wake: bool,
    pub state: EventState,
    pub batch_id: Option<i32>,
    pub requeues: i32,
    /// The interrupted batch this event was put back from: what that turn
    /// dispatched is listed when it is handed over again.
    pub requeued_from: Option<i32>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
