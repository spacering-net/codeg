use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

/// Where a round of acceptance stands (7.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    /// The check codeg sent out is running (or waits for the task's
    /// preflight to finish first).
    #[sea_orm(string_value = "checking")]
    Checking,
    /// The check is back: the assistant that dispatched the work decides.
    #[sea_orm(string_value = "deciding")]
    Deciding,
    /// Put to the owner on the acceptance card.
    #[sea_orm(string_value = "asked")]
    Asked,
    /// Accepted: this version may be merged.
    #[sea_orm(string_value = "accepted")]
    Accepted,
    /// Sent back to be changed; the next review is the next round.
    #[sea_orm(string_value = "revised")]
    Revised,
    /// No longer about the task as it is: it left review, or its run moved
    /// on, before the conclusion was carried out. Not counted.
    #[sea_orm(string_value = "stale")]
    Stale,
    /// The worktree changed while it was being checked: the check read a
    /// version that is not there any more. Not counted.
    #[sea_orm(string_value = "void")]
    Void,
    /// The worktree changed after the round was concluded (or while the
    /// conclusion waited): what was accepted is not what is there.
    #[sea_orm(string_value = "changed")]
    Changed,
}

impl VerificationState {
    /// Still waiting on a conclusion.
    pub fn is_open(self) -> bool {
        matches!(
            self,
            VerificationState::Checking | VerificationState::Deciding | VerificationState::Asked
        )
    }

    /// Counts as one of the rounds the limit is about.
    pub fn counts(self) -> bool {
        !matches!(self, VerificationState::Stale | VerificationState::Void)
    }
}

/// What the check found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum CheckVerdict {
    #[sea_orm(string_value = "pass")]
    Pass,
    #[sea_orm(string_value = "fail")]
    Fail,
    /// It could not tell (the tests would not run, say), or said nothing.
    #[sea_orm(string_value = "unverified")]
    Unverified,
}

/// What a round was concluded with.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum AcceptDecision {
    #[sea_orm(string_value = "accept")]
    Accept,
    #[sea_orm(string_value = "revise")]
    Revise,
    #[sea_orm(string_value = "ask_owner")]
    AskOwner,
}

/// Who concluded it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumIter, DeriveActiveEnum, Serialize, Deserialize)]
#[sea_orm(rs_type = "String", db_type = "String(StringLen::None)")]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    /// The assistant that dispatched the work (`acceptance_decide`).
    #[sea_orm(string_value = "assistant")]
    Assistant,
    /// codeg, from the check's verdict: the assistant gave no conclusion.
    #[sea_orm(string_value = "fallback")]
    Fallback,
    /// The owner, on the acceptance card.
    #[sea_orm(string_value = "owner")]
    Owner,
}

/// One round of acceptance of one piece of dispatched work (7.5).
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "personal_agent_verification")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    /// The assistant that dispatched the work.
    pub bot_id: Option<i32>,
    pub dispatch_id: i32,
    /// The check codeg dispatched; `None` when nobody could check it.
    pub check_dispatch_id: Option<i32>,
    pub round: i32,
    /// The task's run generation this round is bound to.
    pub run_seq: i32,
    /// The worktree's fingerprint when the check began.
    #[sea_orm(column_type = "Text")]
    pub fingerprint: String,
    pub state: VerificationState,
    pub check_verdict: Option<CheckVerdict>,
    #[sea_orm(column_type = "Text", nullable)]
    pub check_evidence: Option<String>,
    pub decision: Option<AcceptDecision>,
    #[sea_orm(column_type = "Text", nullable)]
    pub reason: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub message: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub question: Option<String>,
    pub decided_by: Option<DecidedBy>,
    pub notice_id: Option<i32>,
    pub unchecked: bool,
    #[sea_orm(column_type = "Text", nullable)]
    pub delivered_head: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub merge_commit: Option<String>,
    pub version_guaranteed: Option<bool>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub decided_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
