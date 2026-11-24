use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Where a ledger entry stands (`personal_agent::ledger`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum ActionState {
    /// The intent is written; that it took effect is not confirmed yet.
    /// Neither a success nor a failure: settled by its evidence.
    #[sea_orm(string_value = "prepared")]
    Prepared,
    /// It took effect; `ref_id` names what it made.
    #[sea_orm(string_value = "committed")]
    Committed,
    /// It certainly did not take effect: the same call may run again.
    #[sea_orm(string_value = "not_executed")]
    NotExecuted,
    /// Whether it took effect cannot be told. Never redone on its own: the
    /// owner decides on a card.
    #[sea_orm(string_value = "unknown")]
    Unknown,
    /// Written by the first build of the ledger for a call that did not run;
    /// read as [`ActionState::NotExecuted`].
    #[sea_orm(string_value = "failed")]
    Failed,
}

impl ActionState {
    /// The call certainly did not take effect.
    pub fn not_executed(self) -> bool {
        matches!(self, ActionState::NotExecuted | ActionState::Failed)
    }
}

/// One acting call of the personal agent, or one codeg makes for it: what a
/// re-delivered batch, a second click, a restart finds instead of acting
/// twice — and what tells, after an interruption, whether it took effect.
///
/// A call made in a delivery is keyed by its batch and the tool with its
/// normalized arguments; one made outside any (a card the owner clicked)
/// has `batch_id` 0 and its `op_id` for a key. Either way `op_id` is what
/// travels to the receiving side, so its own record can say "this was it".
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_action")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub batch_id: i32,
    #[sea_orm(column_type = "Text")]
    pub key: String,
    /// `dispatch` | `followup`
    #[sea_orm(column_type = "Text")]
    pub kind: String,
    pub state: ActionState,
    /// What it made: a dispatch id, as text.
    #[sea_orm(column_type = "Text", nullable)]
    pub ref_id: Option<String>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    /// The operation's id; unique. `None` only on entries from before the
    /// ledger recorded one.
    #[sea_orm(column_type = "Text", nullable)]
    pub op_id: Option<String>,
    /// JSON: the call in full, so it can be made again or shown.
    #[sea_orm(column_type = "Text", nullable)]
    pub payload: Option<String>,
    /// JSON: the evidence the receiving side gave that it took effect.
    #[sea_orm(column_type = "Text", nullable)]
    pub observed: Option<String>,
    /// JSON: what it acts on, and what to put back when it did not run.
    #[sea_orm(column_type = "Text", nullable)]
    pub target: Option<String>,
    /// The card that tells the owner about it: the one it runs for, or the
    /// one raised when its outcome is unknown.
    pub notice_id: Option<i32>,
    /// When a send was about to be written to the agent: set before the
    /// request goes out, so an entry without it was certainly not sent.
    pub attempted_at: Option<DateTimeUtc>,
    /// Why it stands as it does, in words.
    #[sea_orm(column_type = "Text", nullable)]
    pub detail: Option<String>,
    /// The assistant it belongs to (`personal_agent.id`).
    pub bot_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
