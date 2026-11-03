use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Why a segment started — and, on the segment it replaced, why that one
/// ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum SegmentReason {
    /// The first segment this personal agent ever ran.
    #[sea_orm(string_value = "first")]
    First,
    /// The owner switched the brain to another agent.
    #[sea_orm(string_value = "switch")]
    Switch,
    /// A change the running process cannot pick up (its launch settings).
    #[sea_orm(string_value = "option_restart")]
    OptionRestart,
    /// The working directory moved.
    #[sea_orm(string_value = "workdir")]
    Workdir,
    /// The owner asked for a new session.
    #[sea_orm(string_value = "manual")]
    Manual,
    /// The previous session could not be resumed.
    #[sea_orm(string_value = "recovery")]
    Recovery,
    /// The context overflowed and compaction could not bring it back.
    #[sea_orm(string_value = "overflow")]
    Overflow,
}

/// One underlying agent session of the personal agent. Exactly one row is
/// open (`ended_at IS NULL`) once the agent has started.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_segment")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// 1-based position on the timeline.
    pub seq: i32,
    #[sea_orm(column_type = "Text")]
    pub agent_type: String,
    /// JSON `AssistantAgentConfig` snapshot of the brain at the start.
    #[sea_orm(column_type = "Text")]
    pub agent_options: String,
    pub conversation_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub agent_session_id: Option<String>,
    pub start_reason: SegmentReason,
    pub end_reason: Option<SegmentReason>,
    /// A switch waiting for the next delivery: the reason the next segment
    /// will start with.
    pub pending_reason: Option<SegmentReason>,
    pub started_at: DateTimeUtc,
    pub ended_at: Option<DateTimeUtc>,
    /// JSON `{used, size}`.
    #[sea_orm(column_type = "Text", nullable)]
    pub usage_at_end: Option<String>,
    pub handoff_size: Option<i32>,
    pub compactions_auto: i32,
    pub compactions_manual: i32,
    pub compactions_agent: i32,
    pub auto_compact_paused: bool,
    #[sea_orm(column_type = "Text", nullable)]
    pub persona_digest: Option<String>,
    /// JSON `SegmentState`.
    #[sea_orm(column_type = "Text")]
    pub state: String,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
