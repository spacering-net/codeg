use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum TimelineKind {
    /// The owner's message (or a supplement sent while a turn ran).
    #[sea_orm(string_value = "owner")]
    Owner,
    /// The visible text the assistant wrote in one turn.
    #[sea_orm(string_value = "reply")]
    Reply,
    /// A question the assistant asked, with the owner's answer.
    #[sea_orm(string_value = "question")]
    Question,
    /// A permission request, with the owner's choice.
    #[sea_orm(string_value = "permission")]
    Permission,
    /// A piece of work handed to a role assistant.
    #[sea_orm(string_value = "dispatch")]
    Dispatch,
    /// Progress of dispatched work.
    #[sea_orm(string_value = "result")]
    Result,
    /// Segment boundaries, option changes, reconnects, compactions.
    #[sea_orm(string_value = "marker")]
    Marker,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum OwnerStatus {
    #[sea_orm(string_value = "queued")]
    Queued,
    #[sea_orm(string_value = "delivered")]
    Delivered,
    #[sea_orm(string_value = "answered")]
    Answered,
    /// The turn carrying it never ended on its own; offered for resending.
    #[sea_orm(string_value = "interrupted")]
    Interrupted,
}

/// One row of the personal agent's timeline. `id` is the global order.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_timeline")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub segment_id: Option<i32>,
    pub batch_id: Option<i32>,
    pub kind: TimelineKind,
    /// Owner rows only.
    pub status: Option<OwnerStatus>,
    #[sea_orm(column_type = "Text")]
    pub body: String,
    /// JSON, shaped per kind.
    #[sea_orm(column_type = "Text", nullable)]
    pub data: Option<String>,
    pub dispatch_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub ref_id: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
