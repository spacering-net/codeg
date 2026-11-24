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
    /// What a stop took with it: the turn, the work it dispatched, the
    /// messages it sent — and what it could not take back, each with a way
    /// to stop it where it is now.
    #[sea_orm(string_value = "stopped")]
    Stopped,
    /// An exchange between assistants went round without progress, or in a
    /// circle, and was stopped: the owner lets it go on or takes it over.
    #[sea_orm(string_value = "loop")]
    Loop,
    /// A change to the settings, from the conversation: made as the owner
    /// said (it can be undone), or put in front of them first — because
    /// they asked to see such changes first, or because the assistant only
    /// inferred it.
    #[sea_orm(string_value = "changed")]
    Changed,
    /// Choices put to the owner — a new work assistant's opening card
    /// (4.12): a question, its lettered answers and one of their own.
    #[sea_orm(string_value = "choice")]
    Choice,
    /// An executor's question or plan approval the dispatching assistant
    /// answers for the owner, or forwards to them (7.3.1).
    #[sea_orm(string_value = "ask")]
    Ask,
    /// A matter came due (6.1): the owner's reminder, with what they can
    /// do about it — or, for one the assistant was to do then, the note
    /// that it was woken to.
    #[sea_orm(string_value = "reminder")]
    Reminder,
    /// Getting to know the owner (5.4): the projects to connect, and what
    /// the assistants do on their own.
    #[sea_orm(string_value = "onboarding")]
    Onboarding,
    /// The first thing an assistant can take off the owner's hands in the
    /// projects they connected (5.4).
    #[sea_orm(string_value = "starter")]
    Starter,
    /// A round of acceptance (7.5): what the check found, what the
    /// assistant concluded and why — and, when it is the owner's call, the
    /// question and what sending it back would say.
    #[sea_orm(string_value = "acceptance")]
    Acceptance,
    /// One action an assistant takes on a forge (7.4) — a comment, closing
    /// an issue, merging a pull request — at the target it named once: what
    /// was done and where, or why not; an approval card first when the owner
    /// asked to approve such actions; the step whose outcome cannot be told,
    /// to look at or do again after checking the forge.
    #[sea_orm(string_value = "forge")]
    Forge,
    /// What a watched pull request came to (7.4): its checks failed or are
    /// green again, it conflicts, it can be merged, it was merged or closed.
    /// One per place it reached, on its head; a newer one supersedes it.
    #[sea_orm(string_value = "pr")]
    Pr,
    /// A routine (6.9): one made or changed as the owner said (undo), one
    /// the assistant suggests, an offer to make a request the owner keeps
    /// making a routine, one codeg paused.
    #[sea_orm(string_value = "routine")]
    Routine,
    /// One of codeg's proposal rules (6.7) found something worth the
    /// owner's time — work failed with nobody on it, review waiting long, a
    /// session waiting on them, a pull request waiting for their review,
    /// changes left uncommitted, a matter gone quiet, a new project, a
    /// branch behind with conflicts — with the next step on it.
    #[sea_orm(string_value = "rule")]
    Rule,
    /// The morning brief codeg wrote itself, with no brain to write it
    /// (6.4): nothing to answer, its rows open what they are about.
    #[sea_orm(string_value = "brief")]
    Brief,
    /// What a turn changed in the assistant's memory, persona or rules
    /// (7.7): the files and the diff, and the way to take it back.
    #[sea_orm(string_value = "memory")]
    Memory,
    /// A plan (7.6): its steps, who carries each out, what each waits for,
    /// how far it got — and stop, start, cancel, take back a change.
    #[sea_orm(string_value = "plan")]
    Plan,
    /// An assistant's nightly tidy-up of its memory, persona and rules
    /// (7.7): what it merged, changed and removed, as one commit — undone as
    /// a whole; or, kept as a draft, applied or let go.
    #[sea_orm(string_value = "tidy")]
    Tidy,
    /// A process skill an assistant wrote or changed (7.8): installed into
    /// its brain's skills, turned off, deleted or taken back; or, kept as a
    /// draft, installed or let go.
    #[sea_orm(string_value = "skill")]
    Skill,
    /// "Is this right?" (10.3): a message of an ordinary conversation the
    /// owner had checked — being checked, then the verdict and its
    /// evidence, with the way to check it again.
    #[sea_orm(string_value = "check")]
    Check,
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
    /// What it made was taken back by the owner.
    #[sea_orm(string_value = "undone")]
    Undone,
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
    /// The assistant it belongs to (`personal_agent.id`).
    pub bot_id: Option<i32>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
