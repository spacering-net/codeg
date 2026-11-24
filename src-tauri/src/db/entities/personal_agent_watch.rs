use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Whether a watch is read (7.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum WatchState {
    /// Read on its schedule; what changes is told.
    #[sea_orm(string_value = "watching")]
    Watching,
    /// Only named: its coordinates are kept so it is resolved once, and it
    /// is not read on its own.
    #[sea_orm(string_value = "recorded")]
    Recorded,
    /// Merged, closed, gone, idle or stopped: no longer read.
    #[sea_orm(string_value = "ended")]
    Ended,
}

/// A pull request (or an issue) an assistant keeps an eye on, its target
/// resolved once (7.4).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_watch")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The assistant that hears of it.
    pub bot_id: i32,
    #[sea_orm(column_type = "Text", unique)]
    pub item_key: String,
    #[sea_orm(column_type = "Text")]
    pub provider: String,
    #[sea_orm(column_type = "Text")]
    pub server_host: String,
    #[sea_orm(column_type = "Text")]
    pub account_id: String,
    #[sea_orm(column_type = "Text")]
    pub owner_repo: String,
    /// `pr` | `issue`
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    pub number: i64,
    pub folder_id: Option<i32>,
    pub work_task_id: Option<i32>,
    pub dispatch_id: Option<i32>,
    /// `task` (a board task delivered it) | `named` | `asked`
    #[sea_orm(column_type = "Text")]
    pub source: String,
    pub state: WatchState,
    #[sea_orm(column_type = "Text", nullable)]
    pub ended_reason: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub url: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub title: Option<String>,
    /// `open` | `closed` | `merged`, as last read.
    #[sea_orm(column_type = "Text", nullable)]
    pub pr_state: Option<String>,
    pub draft: bool,
    #[sea_orm(column_type = "Text", nullable)]
    pub head_sha: Option<String>,
    pub mergeable: Option<bool>,
    #[sea_orm(column_type = "Text", nullable)]
    pub merge_state: Option<String>,
    /// The head's checks as last read ([`crate::personal_agent::watch::CheckTally`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub checks: Option<String>,
    /// The last read whole (`ForgeChangeDetail` as JSON), for `pr_status`.
    #[sea_orm(column_type = "Text", nullable)]
    pub detail: Option<String>,
    /// Where it stands ([`crate::personal_agent::watch::Phase`]).
    #[sea_orm(column_type = "Text", nullable)]
    pub phase: Option<String>,
    /// `phase@head` last told.
    #[sea_orm(column_type = "Text", nullable)]
    pub notified: Option<String>,
    /// Its first read is a baseline: nothing is told of it.
    pub quiet_first: bool,
    pub last_read_at: Option<DateTimeUtc>,
    pub last_change_at: Option<DateTimeUtc>,
    pub next_poll_at: Option<DateTimeUtc>,
    /// Reads in a row that found no such item.
    pub not_found: i32,
    /// Reads failed in a row.
    pub failures: i32,
    /// Read later than it would be: rate-limited, or the forge failed.
    pub backoff: bool,
    #[sea_orm(column_type = "Text", nullable)]
    pub last_error: Option<String>,
    /// What codeg did on it by itself (7.4, phase 3), as JSON: the rounds
    /// it started to fix it, the review feedback read, the merge it made
    /// (`personal_agent::pr_auto::Auto`).
    #[sea_orm(column_type = "Text", nullable)]
    pub auto: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
