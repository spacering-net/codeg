use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum NoticeKind {
    /// Something put in front of the owner instead of done: it runs as the
    /// card shows it when they say so.
    #[sea_orm(string_value = "proposal")]
    Proposal,
    /// A step whose outcome codeg cannot tell (it was cut off between going
    /// out and being confirmed): never redone on its own — the owner looks,
    /// has it done again, or lets it be.
    #[sea_orm(string_value = "uncertain")]
    Uncertain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum NoticeLevel {
    #[sea_orm(string_value = "urgent")]
    Urgent,
    #[sea_orm(string_value = "normal")]
    Normal,
    #[sea_orm(string_value = "low")]
    Low,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum NoticeState {
    #[sea_orm(string_value = "open")]
    Open,
    /// The owner acted on it and what it runs is running: the first answer
    /// took it; it settles as the ledger entry of that run does.
    #[sea_orm(string_value = "acting")]
    Acting,
    /// What it runs took effect.
    #[sea_orm(string_value = "acted")]
    Acted,
    /// What it runs was cut off, and whether it took effect cannot be told.
    #[sea_orm(string_value = "unknown")]
    Unknown,
    #[sea_orm(string_value = "dismissed")]
    Dismissed,
    #[sea_orm(string_value = "muted")]
    Muted,
    #[sea_orm(string_value = "expired")]
    Expired,
}

/// The state of one native card. The card on the timeline is a row of kind
/// `notice` whose `ref_id` is this row's id.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_notice")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub kind: NoticeKind,
    #[sea_orm(column_type = "Text", nullable)]
    pub subject_key: Option<String>,
    pub level: NoticeLevel,
    pub state: NoticeState,
    pub timeline_id: Option<i32>,
    pub batch_id: Option<i32>,
    /// JSON, shaped per kind: what acting on it does.
    #[sea_orm(column_type = "Text")]
    pub payload: String,
    pub notified_at: Option<DateTimeUtc>,
    pub acted_at: Option<DateTimeUtc>,
    pub expires_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
