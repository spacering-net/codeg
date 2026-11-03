use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum BatchKind {
    /// Queued owner messages and events handed to the agent as one prompt.
    #[sea_orm(string_value = "delivery")]
    Delivery,
    /// The agent's compact command, sent on its own.
    #[sea_orm(string_value = "compaction")]
    Compaction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum BatchStatus {
    #[sea_orm(string_value = "running")]
    Running,
    #[sea_orm(string_value = "completed")]
    Completed,
    /// The turn did not end on its own: a restart, a lost connection, or a
    /// context overflow.
    #[sea_orm(string_value = "interrupted")]
    Interrupted,
    #[sea_orm(string_value = "failed")]
    Failed,
    #[sea_orm(string_value = "canceled")]
    Canceled,
}

/// One prompt the personal agent engine sent.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_batch")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub segment_id: i32,
    pub kind: BatchKind,
    pub status: BatchStatus,
    #[sea_orm(column_type = "Text", nullable)]
    pub stop_reason: Option<String>,
    /// JSON: the frames that rode along, the compaction readings.
    #[sea_orm(column_type = "Text", nullable)]
    pub detail: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error: Option<String>,
    pub started_at: DateTimeUtc,
    pub ended_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
