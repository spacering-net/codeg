use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// What a routine does when it runs (6.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum RoutineKind {
    /// Wakes its assistant with what it is to do.
    #[sea_orm(string_value = "brain")]
    Brain,
    /// codeg hands out the work its template says, without waking anyone.
    #[sea_orm(string_value = "dispatch")]
    Dispatch,
}

/// When a routine runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum RoutineTrigger {
    /// On a cron schedule, in a time zone.
    #[sea_orm(string_value = "schedule")]
    Schedule,
    /// On a coding event of a kind (and a filter).
    #[sea_orm(string_value = "event")]
    Event,
}

/// One assistant's routine.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_routine")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub bot_id: i32,
    #[sea_orm(column_type = "Text")]
    pub title: String,
    #[sea_orm(column_type = "Text")]
    pub what: String,
    pub kind: RoutineKind,
    pub trigger: RoutineTrigger,
    #[sea_orm(column_type = "Text", nullable)]
    pub cron: Option<String>,
    /// `owner`, or an IANA name.
    #[sea_orm(column_type = "Text", nullable)]
    pub timezone: Option<String>,
    /// The zone its next run was worked out in.
    #[sea_orm(column_type = "Text", nullable)]
    pub zone_used: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub event_kind: Option<String>,
    /// JSON ([`crate::personal_agent::routines::EventFilter`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub event_filter: Option<String>,
    /// JSON ([`crate::personal_agent::routines::DispatchTemplate`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub dispatch: Option<String>,
    /// JSON ([`crate::personal_agent::routines::Precheck`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub precheck: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub precheck_state: Option<String>,
    pub enabled: bool,
    /// `failures` | `executor` | `owner`
    #[sea_orm(column_type = "Text", nullable)]
    pub paused_reason: Option<String>,
    /// `owner` | `suggest` | `card` | `page` | `template`
    #[sea_orm(column_type = "Text")]
    pub source: String,
    pub next_run_at: Option<DateTimeUtc>,
    pub last_run_at: Option<DateTimeUtc>,
    pub runs: i32,
    pub failures: i32,
    pub signal_cursor: i32,
    pub trial_pending: bool,
    pub deleted_at: Option<DateTimeUtc>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
