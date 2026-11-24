use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// How one run of a routine went (6.9).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum RunOutcome {
    /// Its assistant is on it, or the work it handed out is.
    #[sea_orm(string_value = "running")]
    Running,
    /// The precheck found nothing new: no one was woken.
    #[sea_orm(string_value = "skipped")]
    Skipped,
    /// Its assistant found nothing worth saying.
    #[sea_orm(string_value = "silent")]
    Silent,
    /// Its assistant reported, or the work it handed out finished.
    #[sea_orm(string_value = "reported")]
    Reported,
    #[sea_orm(string_value = "failed")]
    Failed,
    /// Its time went by while codeg was not running: not made up for.
    #[sea_orm(string_value = "missed")]
    Missed,
    /// The work it hands out waits for the owner's confirmation.
    #[sea_orm(string_value = "asked")]
    Asked,
    /// The owner did not confirm it.
    #[sea_orm(string_value = "declined")]
    Declined,
    /// The owner stopped it, or took the work over.
    #[sea_orm(string_value = "stopped")]
    Stopped,
}

/// One run of a routine.
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_routine_run")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub routine_id: i32,
    pub bot_id: i32,
    /// Its "run N"; 0 for one that did not run.
    pub seq: i32,
    /// `schedule` | `event` | `now` | `trial`
    #[sea_orm(column_type = "Text")]
    pub trigger: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub event_key: Option<String>,
    pub due_at: Option<DateTimeUtc>,
    pub started_at: DateTimeUtc,
    pub ended_at: Option<DateTimeUtc>,
    pub outcome: RunOutcome,
    #[sea_orm(column_type = "Text", nullable)]
    pub note: Option<String>,
    pub batch_id: Option<i32>,
    pub event_id: Option<i32>,
    pub dispatch_id: Option<i32>,
    pub notice_id: Option<i32>,
    pub created_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
