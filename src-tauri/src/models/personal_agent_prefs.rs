//! The owner's preferences and the team's division of work: the account's
//! settings, the same for every assistant, kept on the primary's row (the
//! `prefs` and `team` keys of its settings JSON).
//!
//! Every item defaults, and every one reads leniently: a value this build
//! does not know (written by a newer one) reads as its default, without
//! taking the other items with it. The items are only those whose feature
//! exists; a milestone that brings a feature adds its items here.
//!
//! Two kinds of item:
//! - what codeg itself does: whether a dispatch, a follow-up or a message to
//!   another assistant goes to the owner as a card first, how changes the
//!   owner asks for in chat land, how many rounds two assistants may go
//!   without progress;
//! - what the brain is asked to do: how long its replies are, whether it
//!   answers with cards, what it does when unsure. codeg writes those into
//!   the handoff card as `<codeg-prefs>` and tells the brain when they change.

use std::collections::BTreeMap;

use serde::de::{DeserializeOwned, Deserializer};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::db::entities::personal_agent_dispatch::DispatchMode;

/// A value this build cannot read is the item's default.
fn lenient<'de, D, T>(d: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned + Default,
{
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or_default())
}

/// The default number of rounds two assistants may go back and forth with
/// no progress before codeg stops their exchange (4.9).
pub const DEFAULT_LOOP_ROUNDS: u32 = 3;
/// The most rounds that can be set.
pub const MAX_LOOP_ROUNDS: u32 = 1_000;

fn default_loop_rounds() -> u32 {
    DEFAULT_LOOP_ROUNDS
}

/// How many times codeg retries one dispatch on its own after a restart
/// interrupted it (7.3), unless the owner changes it; 0 is never.
pub const DEFAULT_RETRY_ROUNDS: u32 = 2;
/// The most automatic retries that can be set.
pub const MAX_RETRY_ROUNDS: u32 = 10;

fn default_retry_rounds() -> u32 {
    DEFAULT_RETRY_ROUNDS
}

fn lenient_retry_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_RETRY_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_RETRY_ROUNDS))
}

fn lenient_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_LOOP_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_LOOP_ROUNDS))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReplyLength {
    Short,
    #[default]
    Medium,
    Long,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CardUse {
    /// Wherever a card says it better.
    #[default]
    Prefer,
    /// Only when the owner has to decide something.
    Decisions,
    Never,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WhenUnsure {
    /// Go with the most reasonable reading, and say what was assumed.
    #[default]
    Assume,
    Ask,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChatChanges {
    /// What the owner says to change is changed at once, on a card that
    /// undoes it.
    #[default]
    Apply,
    /// It goes to the owner as a card first.
    Show,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmDispatch {
    #[default]
    Never,
    /// Only work that changes code: a kanban task or a work session, which
    /// run in a project's checkout. A chat touches no project.
    Code,
    Always,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AskFirst {
    #[default]
    Auto,
    Ask,
}

/// Who answers an executor's questions or plan approvals (7.3.1).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecAnswers {
    /// The assistant that dispatched the work answers for the owner, and
    /// forwards what it cannot settle.
    #[default]
    Assistant,
    /// Always the owner.
    Owner,
}

/// Whether codeg records when the owner is in codeg, to learn their usual
/// hours (1.12).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnOff {
    #[default]
    On,
    Off,
}

/// The owner's time zone as set: the system's.
pub const SYSTEM_ZONE: &str = "system";

fn default_zone() -> String {
    SYSTEM_ZONE.to_string()
}

/// A zone this build does not know is the system's.
fn lenient_zone<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_str()
        .and_then(|s| check_zone(s).ok())
        .unwrap_or_else(default_zone))
}

/// A zone as the owner sets it: `system`, or an IANA name — kept as the
/// time zone database spells it.
pub fn check_zone(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.eq_ignore_ascii_case(SYSTEM_ZONE) {
        return Ok(default_zone());
    }
    s.parse::<chrono_tz::Tz>()
        .map(|tz| tz.name().to_string())
        .or_else(|_| {
            chrono_tz::TZ_VARIANTS
                .iter()
                .find(|tz| tz.name().eq_ignore_ascii_case(s))
                .map(|tz| tz.name().to_string())
                .ok_or(())
        })
        .map_err(|_| {
            format!("`time_zone` takes system or a time zone name such as Europe/Berlin, not `{s}`")
        })
}

/// How urgent something is for the owner, and so how it reaches them (6.2).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Urgent,
    #[default]
    Normal,
    Low,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Urgent => "urgent",
            Level::Normal => "normal",
            Level::Low => "low",
        }
    }
}

fn urgent() -> Level {
    Level::Urgent
}

fn low() -> Level {
    Level::Low
}

fn lenient_urgent<'de, D: Deserializer<'de>>(d: D) -> Result<Level, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or(Level::Urgent))
}

fn lenient_low<'de, D: Deserializer<'de>>(d: D) -> Result<Level, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(serde_json::from_value(v).unwrap_or(Level::Low))
}

/// How an urgent matter reaches the owner.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UrgentVia {
    /// A system notification, and the Dock / taskbar asks for them.
    #[default]
    SystemAttention,
    System,
    /// Only on the page, while they are in codeg.
    InPage,
}

/// How a matter of normal urgency reaches the owner.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalVia {
    /// A system notification, as their presence allows: at once while they
    /// are here and not typing; after they stop typing; or, gone, merged
    /// for when they are back.
    #[default]
    System,
    InPage,
    /// No notification: it waits in "today".
    Today,
}

/// How a matter of low urgency reaches the owner.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LowVia {
    #[default]
    Today,
    /// Merged into one notification, at most every two hours.
    Digest,
}

/// When the owner is not to be disturbed.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuietHours {
    /// Outside their usual hours; [`DEFAULT_QUIET_FROM`]–[`DEFAULT_QUIET_TO`]
    /// until codeg has learned them (or with the record off).
    #[default]
    Auto,
    /// `quiet_from`–`quiet_to`.
    Fixed,
    None,
}

/// What still reaches the owner in their quiet hours.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuietLets {
    /// Their reminders only.
    #[default]
    Reminders,
    /// Their reminders and what is urgent.
    Urgent,
}

/// What "tomorrow morning" is in a reminder.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MorningMode {
    /// When the owner's day usually starts (1.12).
    #[default]
    Hours,
    /// `morning_at`, every day.
    Fixed,
}

/// The default quiet hours, until the usual hours are learned.
pub const DEFAULT_QUIET_FROM: &str = "22:00";
pub const DEFAULT_QUIET_TO: &str = "08:00";
/// The fixed "tomorrow morning", until the owner sets another.
pub const DEFAULT_MORNING_AT: &str = "09:00";
/// Minutes after the owner stops typing that what waited for it goes out.
pub const DEFAULT_FOCUS_WAIT: u32 = 3;
/// The longest that can be set.
pub const MAX_FOCUS_WAIT: u32 = 60;

fn default_quiet_from() -> String {
    DEFAULT_QUIET_FROM.into()
}

fn default_quiet_to() -> String {
    DEFAULT_QUIET_TO.into()
}

fn default_morning_at() -> String {
    DEFAULT_MORNING_AT.into()
}

fn default_focus_wait() -> u32 {
    DEFAULT_FOCUS_WAIT
}

fn lenient_focus_wait<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_FOCUS_WAIT as u64) as u32)
        .unwrap_or(DEFAULT_FOCUS_WAIT))
}

/// A time of day as the owner sets it: `HH:MM`, 00:00 to 23:59.
pub fn check_clock(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    chrono::NaiveTime::parse_from_str(s, "%H:%M")
        .map(|t| t.format("%H:%M").to_string())
        .map_err(|_| format!("a time of day is HH:MM, such as 21:30, not `{s}`"))
}

/// A clock time as stored, `None` if it is not one.
pub fn clock_of(s: &str) -> Option<chrono::NaiveTime> {
    chrono::NaiveTime::parse_from_str(s.trim(), "%H:%M").ok()
}

fn lenient_clock<'de, D: Deserializer<'de>>(
    d: D,
    fallback: fn() -> String,
) -> Result<String, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_str()
        .and_then(|s| check_clock(s).ok())
        .unwrap_or_else(fallback))
}

fn lenient_quiet_from<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    lenient_clock(d, default_quiet_from)
}

fn lenient_quiet_to<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    lenient_clock(d, default_quiet_to)
}

fn lenient_morning_at<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    lenient_clock(d, default_morning_at)
}

/// The kinds of news codeg routes to the owner (6.2, 8.6), each with the
/// level it starts at: `level_<kind>` is the owner's setting for it.
pub const NEWS: &[(&str, Level, &str)] = &[
    ("reminder", Level::Urgent, "reminders"),
    (
        "forwarded",
        Level::Urgent,
        "questions forwarded from dispatched work",
    ),
    (
        "approval",
        Level::Urgent,
        "an assistant waiting for approval",
    ),
    (
        "waiting",
        Level::Urgent,
        "anything waiting on them 10 minutes",
    ),
    ("question", Level::Normal, "an assistant's own questions"),
    ("confirm", Level::Normal, "cards to confirm"),
    (
        "stuck",
        Level::Normal,
        "steps that may not have happened, stopped exchanges",
    ),
    (
        "done",
        Level::Normal,
        "dispatched work finished or ready for review",
    ),
    ("reply", Level::Normal, "replies to what they asked"),
    ("exchange", Level::Low, "assistants' messages to each other"),
    ("changed", Level::Low, "settings changed as they asked"),
    ("answered", Level::Low, "questions answered for them"),
];

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerHandoff {
    /// Write to the work assistant and let it see the work through.
    #[default]
    Message,
    /// Dispatch to the work assistant's executor config directly.
    Direct,
}

/// The owner's preferences.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prefs {
    #[serde(default, deserialize_with = "lenient")]
    pub reply_length: ReplyLength,
    #[serde(default, deserialize_with = "lenient")]
    pub cards: CardUse,
    #[serde(default, deserialize_with = "lenient")]
    pub when_unsure: WhenUnsure,
    #[serde(default, deserialize_with = "lenient")]
    pub chat_changes: ChatChanges,
    #[serde(default, deserialize_with = "lenient")]
    pub confirm_dispatch: ConfirmDispatch,
    /// Follow-ups and retries of the assistant's own dispatches.
    #[serde(default, deserialize_with = "lenient")]
    pub followups: AskFirst,
    /// Messages to the other assistants (`bot_message`).
    #[serde(default, deserialize_with = "lenient")]
    pub messages: AskFirst,
    #[serde(default, deserialize_with = "lenient")]
    pub worker_handoff: WorkerHandoff,
    /// Rounds without progress before an exchange between two assistants is
    /// stopped; 0 is no limit.
    #[serde(default = "default_loop_rounds", deserialize_with = "lenient_rounds")]
    pub loop_rounds: u32,
    /// A dispatch a restart interrupted: retried at once, or put to the
    /// owner on a card first (7.3).
    #[serde(default, deserialize_with = "lenient")]
    pub interrupt_retry: AskFirst,
    /// How many times one dispatch is retried on its own; 0 is never.
    #[serde(default = "default_retry_rounds", deserialize_with = "lenient_retry_rounds")]
    pub retry_rounds: u32,
    /// An executor's questions (7.3.1).
    #[serde(default, deserialize_with = "lenient")]
    pub exec_questions: ExecAnswers,
    /// An executor's plan approvals (7.3.1).
    #[serde(default, deserialize_with = "lenient")]
    pub exec_plans: ExecAnswers,
    /// The owner's time zone: `system`, or an IANA name (1.12).
    #[serde(default = "default_zone", deserialize_with = "lenient_zone")]
    pub time_zone: String,
    /// Whether codeg records when the owner is in codeg and learns their
    /// usual hours from it; off, the hours are the defaults (1.12).
    #[serde(default, deserialize_with = "lenient")]
    pub presence: OnOff,
    /// Off, codeg reaches out to the owner only with their reminders (1.13).
    #[serde(default, deserialize_with = "lenient")]
    pub proactive: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub urgent_via: UrgentVia,
    #[serde(default, deserialize_with = "lenient")]
    pub normal_via: NormalVia,
    #[serde(default, deserialize_with = "lenient")]
    pub low_via: LowVia,
    /// While the owner types, what is of normal urgency waits until they
    /// have stopped this many minutes; 0 sends it as usual.
    #[serde(
        default = "default_focus_wait",
        deserialize_with = "lenient_focus_wait"
    )]
    pub focus_wait: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub quiet_hours: QuietHours,
    #[serde(
        default = "default_quiet_from",
        deserialize_with = "lenient_quiet_from"
    )]
    pub quiet_from: String,
    #[serde(default = "default_quiet_to", deserialize_with = "lenient_quiet_to")]
    pub quiet_to: String,
    #[serde(default, deserialize_with = "lenient")]
    pub quiet_lets: QuietLets,
    #[serde(default, deserialize_with = "lenient")]
    pub morning: MorningMode,
    #[serde(
        default = "default_morning_at",
        deserialize_with = "lenient_morning_at"
    )]
    pub morning_at: String,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_reminder: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_forwarded: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_approval: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_waiting: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_question: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_confirm: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_stuck: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_done: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_reply: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_exchange: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_changed: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_answered: Level,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            reply_length: ReplyLength::default(),
            cards: CardUse::default(),
            when_unsure: WhenUnsure::default(),
            chat_changes: ChatChanges::default(),
            confirm_dispatch: ConfirmDispatch::default(),
            followups: AskFirst::default(),
            messages: AskFirst::default(),
            worker_handoff: WorkerHandoff::default(),
            loop_rounds: DEFAULT_LOOP_ROUNDS,
            interrupt_retry: AskFirst::default(),
            retry_rounds: DEFAULT_RETRY_ROUNDS,
            exec_questions: ExecAnswers::default(),
            exec_plans: ExecAnswers::default(),
            time_zone: default_zone(),
            presence: OnOff::default(),
            proactive: OnOff::default(),
            urgent_via: UrgentVia::default(),
            normal_via: NormalVia::default(),
            low_via: LowVia::default(),
            focus_wait: DEFAULT_FOCUS_WAIT,
            quiet_hours: QuietHours::default(),
            quiet_from: default_quiet_from(),
            quiet_to: default_quiet_to(),
            quiet_lets: QuietLets::default(),
            morning: MorningMode::default(),
            morning_at: default_morning_at(),
            level_reminder: Level::Urgent,
            level_forwarded: Level::Urgent,
            level_approval: Level::Urgent,
            level_waiting: Level::Urgent,
            level_question: Level::Normal,
            level_confirm: Level::Normal,
            level_stuck: Level::Normal,
            level_done: Level::Normal,
            level_reply: Level::Normal,
            level_exchange: Level::Low,
            level_changed: Level::Low,
            level_answered: Level::Low,
        }
    }
}

/// What a preference takes.
#[derive(Debug, Clone, Copy)]
pub enum PrefKind {
    /// One of these words.
    Choice(&'static [&'static str]),
    /// A whole number in range.
    Count { max: u32 },
    /// `system`, or a time zone's IANA name.
    Zone,
    /// A time of day, `HH:MM`.
    Clock,
}

/// The words a `level_<kind>` item takes.
const LEVELS: &[&str] = &["urgent", "normal", "low"];

/// One item, as codeg checks and describes it.
#[derive(Debug, Clone, Copy)]
pub struct PrefSpec {
    pub key: &'static str,
    pub kind: PrefKind,
    /// What the brain reads it as.
    pub label: &'static str,
}

/// Every preference there is.
pub const PREFS: &[PrefSpec] = &[
    PrefSpec {
        key: "reply_length",
        kind: PrefKind::Choice(&["short", "medium", "long"]),
        label: "replies",
    },
    PrefSpec {
        key: "cards",
        kind: PrefKind::Choice(&["prefer", "decisions", "never"]),
        label: "cards",
    },
    PrefSpec {
        key: "when_unsure",
        kind: PrefKind::Choice(&["assume", "ask"]),
        label: "when unsure what the owner means",
    },
    PrefSpec {
        key: "chat_changes",
        kind: PrefKind::Choice(&["apply", "show"]),
        label: "settings changes asked for in chat",
    },
    PrefSpec {
        key: "confirm_dispatch",
        kind: PrefKind::Choice(&["never", "code", "always"]),
        label: "confirm before dispatching",
    },
    PrefSpec {
        key: "followups",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "follow-ups and retries of your dispatches",
    },
    PrefSpec {
        key: "messages",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "messages to the other assistants",
    },
    PrefSpec {
        key: "worker_handoff",
        kind: PrefKind::Choice(&["message", "direct"]),
        label: "handing work to a work assistant",
    },
    PrefSpec {
        key: "loop_rounds",
        kind: PrefKind::Count {
            max: MAX_LOOP_ROUNDS,
        },
        label: "rounds without progress before an exchange between assistants stops",
    },
    PrefSpec {
        key: "interrupt_retry",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "retrying a dispatch a restart interrupted",
    },
    PrefSpec {
        key: "retry_rounds",
        kind: PrefKind::Count {
            max: MAX_RETRY_ROUNDS,
        },
        label: "automatic retries of one dispatch",
    },
    PrefSpec {
        key: "exec_questions",
        kind: PrefKind::Choice(&["assistant", "owner"]),
        label: "questions from the sessions you dispatched",
    },
    PrefSpec {
        key: "exec_plans",
        kind: PrefKind::Choice(&["assistant", "owner"]),
        label: "plan approvals from the sessions you dispatched",
    },
    PrefSpec {
        key: "time_zone",
        kind: PrefKind::Zone,
        label: "the owner's time zone",
    },
    PrefSpec {
        key: "presence",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "learning the owner's usual hours from when they are in codeg",
    },
    PrefSpec {
        key: "proactive",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg reaching out to the owner",
    },
    PrefSpec {
        key: "urgent_via",
        kind: PrefKind::Choice(&["system_attention", "system", "in_page"]),
        label: "how urgent news reaches the owner",
    },
    PrefSpec {
        key: "normal_via",
        kind: PrefKind::Choice(&["system", "in_page", "today"]),
        label: "how news of normal urgency reaches the owner",
    },
    PrefSpec {
        key: "low_via",
        kind: PrefKind::Choice(&["today", "digest"]),
        label: "how minor news reaches the owner",
    },
    PrefSpec {
        key: "focus_wait",
        kind: PrefKind::Count {
            max: MAX_FOCUS_WAIT,
        },
        label:
            "while the owner types, news of normal urgency waits until they have stopped (minutes)",
    },
    PrefSpec {
        key: "quiet_hours",
        kind: PrefKind::Choice(&["auto", "fixed", "none"]),
        label: "the owner's quiet hours",
    },
    PrefSpec {
        key: "quiet_from",
        kind: PrefKind::Clock,
        label: "fixed quiet hours from",
    },
    PrefSpec {
        key: "quiet_to",
        kind: PrefKind::Clock,
        label: "fixed quiet hours until",
    },
    PrefSpec {
        key: "quiet_lets",
        kind: PrefKind::Choice(&["reminders", "urgent"]),
        label: "what still reaches the owner in their quiet hours",
    },
    PrefSpec {
        key: "morning",
        kind: PrefKind::Choice(&["hours", "fixed"]),
        label: "\"tomorrow morning\" in a reminder",
    },
    PrefSpec {
        key: "morning_at",
        kind: PrefKind::Clock,
        label: "the fixed \"tomorrow morning\"",
    },
    PrefSpec {
        key: "level_reminder",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent reminders are",
    },
    PrefSpec {
        key: "level_forwarded",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent questions forwarded from dispatched work are",
    },
    PrefSpec {
        key: "level_approval",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent an assistant waiting for approval is",
    },
    PrefSpec {
        key: "level_waiting",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent anything waiting on the owner 10 minutes is",
    },
    PrefSpec {
        key: "level_question",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent an assistant's own questions are",
    },
    PrefSpec {
        key: "level_confirm",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent cards to confirm are",
    },
    PrefSpec {
        key: "level_stuck",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent steps that may not have happened and stopped exchanges are",
    },
    PrefSpec {
        key: "level_done",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent dispatched work finished or ready for review is",
    },
    PrefSpec {
        key: "level_reply",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent replies to what the owner asked are",
    },
    PrefSpec {
        key: "level_exchange",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent assistants' messages to each other are",
    },
    PrefSpec {
        key: "level_changed",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent settings changed as the owner asked are",
    },
    PrefSpec {
        key: "level_answered",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent questions answered for the owner are",
    },
];

/// The "automation level" (13.4): a preset over the items below — not
/// stored, read off them. Changing one of them makes it "custom".
pub const AUTOMATION_KEY: &str = "automation_level";
/// The "disturbance level" (13.4): a preset over how news reaches the owner.
pub const DISTURB_KEY: &str = "disturb_level";

/// The presets, and the levels each has, in the order they are read off.
pub const PRESETS: &[(&str, &[&str])] = &[
    (AUTOMATION_KEY, &["standard", "ask_more"]),
    (DISTURB_KEY, &["quiet", "standard", "more"]),
];

/// The items preset `key`'s `level` sets, and to what.
pub fn preset(key: &str, level: &str) -> Option<Vec<(&'static str, Value)>> {
    match key {
        AUTOMATION_KEY => automation_preset(level),
        DISTURB_KEY => disturb_preset(level),
        _ => None,
    }
}

/// The items each disturbance level sets. Urgent news and reminders reach
/// the owner at every level.
pub fn disturb_preset(level: &str) -> Option<Vec<(&'static str, Value)>> {
    match level {
        "quiet" => Some(vec![
            ("normal_via", json!("today")),
            ("low_via", json!("today")),
        ]),
        "standard" => Some(vec![
            ("normal_via", json!("system")),
            ("low_via", json!("today")),
            ("focus_wait", json!(DEFAULT_FOCUS_WAIT)),
        ]),
        "more" => Some(vec![
            ("normal_via", json!("system")),
            ("low_via", json!("digest")),
            ("focus_wait", json!(0)),
        ]),
        _ => None,
    }
}

/// The items each automation level sets, and to what.
pub fn automation_preset(level: &str) -> Option<Vec<(&'static str, Value)>> {
    match level {
        "standard" => Some(vec![
            ("confirm_dispatch", json!("never")),
            ("followups", json!("auto")),
            ("messages", json!("auto")),
            ("chat_changes", json!("apply")),
            ("interrupt_retry", json!("auto")),
            ("exec_questions", json!("assistant")),
            ("exec_plans", json!("assistant")),
        ]),
        "ask_more" => Some(vec![
            ("confirm_dispatch", json!("code")),
            ("followups", json!("ask")),
            ("messages", json!("ask")),
            ("chat_changes", json!("show")),
            ("interrupt_retry", json!("ask")),
            ("exec_questions", json!("owner")),
            ("exec_plans", json!("owner")),
        ]),
        _ => None,
    }
}

pub fn spec(key: &str) -> Option<&'static PrefSpec> {
    PREFS.iter().find(|s| s.key == key)
}

/// A value for `key`, checked and in its stored form.
pub fn check_pref(key: &str, value: &Value) -> Result<Value, String> {
    let spec = spec(key).ok_or_else(|| format!("no preference `{key}`"))?;
    match spec.kind {
        PrefKind::Choice(words) => {
            let word = value.as_str().map(str::trim).unwrap_or_default();
            if words.contains(&word) {
                Ok(json!(word))
            } else {
                Err(format!("`{key}` takes one of: {}", words.join(", ")))
            }
        }
        PrefKind::Count { max } => {
            let n = value
                .as_u64()
                .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
                .ok_or_else(|| format!("`{key}` takes a whole number, 0 to {max}"))?;
            if n > max as u64 {
                return Err(format!("`{key}` takes a whole number, 0 to {max}"));
            }
            Ok(json!(n))
        }
        PrefKind::Zone => {
            let raw = value
                .as_str()
                .ok_or("`time_zone` takes system or a time zone name such as Europe/Berlin")?;
            Ok(json!(check_zone(raw)?))
        }
        PrefKind::Clock => {
            let raw = value
                .as_str()
                .ok_or_else(|| format!("`{key}` takes a time of day, HH:MM"))?;
            check_clock(raw)
                .map(|s| json!(s))
                .map_err(|e| format!("`{key}`: {e}"))
        }
    }
}

impl Prefs {
    pub fn parse(v: Option<&Value>) -> Self {
        v.cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// The items as stored, by key.
    pub fn to_map(&self) -> Map<String, Value> {
        match serde_json::to_value(self) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        }
    }

    pub fn get(&self, key: &str) -> Value {
        self.to_map().remove(key).unwrap_or(Value::Null)
    }

    /// Whether codeg records when the owner is in codeg (1.12).
    pub fn records_presence(&self) -> bool {
        self.presence == OnOff::On
    }

    /// Whether a dispatch in `mode` goes to the owner as a card first.
    pub fn confirms(&self, mode: DispatchMode) -> bool {
        match self.confirm_dispatch {
            ConfirmDispatch::Never => false,
            ConfirmDispatch::Code => mode != DispatchMode::Chat,
            ConfirmDispatch::Always => true,
        }
    }

    /// The automation level the items add up to: `standard`, `ask_more`, or
    /// `custom` when they match neither.
    pub fn automation_level(&self) -> &'static str {
        self.preset_level(AUTOMATION_KEY)
    }

    /// The disturbance level the items add up to: `quiet`, `standard`,
    /// `more`, or `custom`.
    pub fn disturb_level(&self) -> &'static str {
        self.preset_level(DISTURB_KEY)
    }

    /// The level of preset `key` the items add up to, or `custom`.
    pub fn preset_level(&self, key: &str) -> &'static str {
        let map = self.to_map();
        let levels = PRESETS
            .iter()
            .find(|(k, _)| *k == key)
            .map(|(_, l)| *l)
            .unwrap_or_default();
        for level in levels {
            let items = preset(key, level).unwrap_or_default();
            if items
                .iter()
                .all(|(k, v)| map.get(*k).is_some_and(|have| have == v))
            {
                return level;
            }
        }
        "custom"
    }

    /// The level news of kind `kind` (one of [`NEWS`]) reaches the owner at.
    pub fn level_of(&self, kind: &str) -> Level {
        match kind {
            "reminder" => self.level_reminder,
            "forwarded" => self.level_forwarded,
            "approval" => self.level_approval,
            "waiting" => self.level_waiting,
            "question" => self.level_question,
            "confirm" => self.level_confirm,
            "stuck" => self.level_stuck,
            "done" => self.level_done,
            "reply" => self.level_reply,
            "exchange" => self.level_exchange,
            "changed" => self.level_changed,
            "answered" => self.level_answered,
            _ => Level::Normal,
        }
    }

    /// Whether codeg reaches out to the owner with more than reminders.
    pub fn proactive(&self) -> bool {
        self.proactive == OnOff::On
    }
}

/// How an item's value reads to the brain.
fn brain_value(key: &str, value: &Value) -> String {
    let word = value.as_str().unwrap_or_default();
    match (key, word) {
        ("reply_length", "short") => "short: a few sentences, the answer first".into(),
        ("reply_length", "medium") => "medium: as long as the matter needs, no longer".into(),
        ("reply_length", "long") => {
            "detailed: the reasoning, the steps and the alternatives".into()
        }
        ("cards", "prefer") => {
            "answer with cards (the ui-render skill) wherever a card says it better".into()
        }
        ("cards", "decisions") => "a card only when the owner has to decide something".into(),
        ("cards", "never") => "no cards: plain text only".into(),
        ("when_unsure", "assume") => {
            "go with the most reasonable reading and say what you assumed".into()
        }
        ("when_unsure", "ask") => "ask the owner first".into(),
        ("chat_changes", "apply") => {
            "prefs_update changes what the owner asks for at once; they can undo it".into()
        }
        ("chat_changes", "show") => "prefs_update puts it on a card for the owner first".into(),
        ("confirm_dispatch", "never") => "dispatches go out directly".into(),
        ("confirm_dispatch", "code") => {
            "a dispatch that changes code (task or session) goes to the owner as a card to \
             confirm first; a chat goes out directly"
                .into()
        }
        ("confirm_dispatch", "always") => {
            "every dispatch goes to the owner as a card to confirm first".into()
        }
        ("followups" | "messages", "auto") => "sent directly".into(),
        ("followups" | "messages", "ask") => "go to the owner as a card first".into(),
        ("worker_handoff", "message") => {
            "write to the work assistant (bot_message) and let it see the work through".into()
        }
        ("worker_handoff", "direct") => {
            "dispatch to the work assistant's executor config directly".into()
        }
        ("loop_rounds", _) => match value.as_u64() {
            Some(0) => "no limit".into(),
            Some(n) => n.to_string(),
            None => value.to_string(),
        },
        ("interrupt_retry", "auto") => {
            "codeg retries it once by itself and notes it on its card".into()
        }
        ("interrupt_retry", "ask") => "codeg asks the owner on a card first".into(),
        ("retry_rounds", _) => match value.as_u64() {
            Some(0) => "none: the owner retries".into(),
            Some(n) => format!("at most {n}, then it is the owner's"),
            None => value.to_string(),
        },
        ("exec_questions" | "exec_plans", "assistant") => {
            "you answer them for the owner (dispatch_answer), and forward what you cannot settle"
                .into()
        }
        ("exec_questions" | "exec_plans", "owner") => {
            "they go to the owner; you are told, nothing to answer".into()
        }
        ("time_zone", SYSTEM_ZONE) => "the system's — <codeg-now> gives it".into(),
        ("time_zone", zone) => format!("{zone} — <codeg-now> gives the time in it"),
        ("presence", "on") => {
            "on: codeg notes the minutes the owner is active in codeg and learns their usual hours"
                .into()
        }
        ("presence", "off") => "off: nothing is noted; their hours are the defaults".into(),
        ("proactive", "on") => {
            "on: codeg tells the owner when something is stuck on them, ready or done".into()
        }
        ("proactive", "off") => {
            "off: codeg reaches out to the owner only with their reminders; speak when spoken to"
                .into()
        }
        ("urgent_via", "system_attention") => {
            "a system notification, and the Dock / taskbar asks for them".into()
        }
        ("urgent_via" | "normal_via", "system") => "a system notification".into(),
        ("urgent_via" | "normal_via", "in_page") => {
            "only on the page, while they are in codeg".into()
        }
        ("normal_via", "today") => "no notification: it waits in their day's list".into(),
        ("low_via", "today") => "no notification".into(),
        ("low_via", "digest") => "merged into one notification, at most every two hours".into(),
        ("focus_wait", _) => match value.as_u64() {
            Some(0) => "not held: it goes out as usual".into(),
            Some(n) => format!("{n}"),
            None => value.to_string(),
        },
        ("quiet_hours", "auto") => {
            "outside their usual hours (22:00–08:00 until codeg has learned them)".into()
        }
        ("quiet_hours", "fixed") => "the fixed times below".into(),
        ("quiet_hours", "none") => "none".into(),
        ("quiet_lets", "reminders") => "their reminders only".into(),
        ("quiet_lets", "urgent") => "their reminders and what is urgent".into(),
        ("morning", "hours") => "when their day usually starts".into(),
        ("morning", "fixed") => "the fixed time below".into(),
        (_, w) if !w.is_empty() => w.to_string(),
        _ => value.to_string(),
    }
}

/// The `level_<kind>` items, as one line.
fn levels_line(map: &Map<String, Value>) -> String {
    let parts: Vec<String> = NEWS
        .iter()
        .map(|(kind, _, label)| {
            let v = map
                .get(&format!("level_{kind}"))
                .and_then(Value::as_str)
                .unwrap_or("normal");
            format!("{label} {v}")
        })
        .collect();
    format!(
        "- how urgent each kind of news is (codeg routes it; urgent goes out at once, normal \
         as their presence allows, low waits for them): {}",
        parts.join(" · ")
    )
}

/// The preferences as the brain reads them: `<codeg-prefs>`. A worker is
/// not told how the primary hands work to workers.
pub fn prefs_block(prefs: &Prefs, worker: bool) -> String {
    let map = prefs.to_map();
    let mut lines: Vec<String> = PREFS
        .iter()
        .filter(|s| !(worker && s.key == "worker_handoff"))
        .filter(|s| !s.key.starts_with("level_"))
        .map(|s| {
            let v = map.get(s.key).cloned().unwrap_or(Value::Null);
            format!("- {}: {}", s.label, brain_value(s.key, &v))
        })
        .collect();
    lines.push(levels_line(&map));
    format!(
        "<codeg-prefs>\n\
The owner's preferences, as they set them in codeg — every assistant follows the same ones. The \
ones about how you write are yours to follow; the others codeg applies itself, so a tool may \
answer that something went to the owner first.\n\
{}\n\
</codeg-prefs>",
        lines.join("\n")
    )
}

/// What changed between two sets of preferences, one line each
/// ("replies → short: …").
pub fn prefs_changes(old: &Prefs, new: &Prefs, worker: bool) -> Vec<String> {
    let (a, b) = (old.to_map(), new.to_map());
    PREFS
        .iter()
        .filter(|s| !(worker && s.key == "worker_handoff"))
        .filter_map(|s| {
            let (from, to) = (a.get(s.key)?, b.get(s.key)?);
            (from != to).then(|| format!("{} → {}", s.label, brain_value(s.key, to)))
        })
        .collect()
}

/// For the next delivery after the owner changed a preference: what
/// changed, and the whole set anew.
pub fn prefs_update_card(changes: &[String], prefs: &Prefs, worker: bool) -> String {
    format!(
        "<codeg-context kind=\"prefs-update\">\n\
The owner changed their preferences: {}. These replace what you had.\n\
{}\n\
</codeg-context>",
        changes.join("; "),
        prefs_block(prefs, worker)
    )
}

// ── the team ────────────────────────────────────────────────────────────────

/// The kinds of work the division assigns a first pick for (10.5).
pub const DIVISION: &[&str] = &[
    "code", "review", "test", "fix_ci", "docs", "release", "research", "check",
];

/// What the brain reads a kind of work as.
pub fn division_label(category: &str) -> &'static str {
    match category {
        "code" => "writing code",
        "review" => "review",
        "test" => "testing",
        "fix_ci" => "fixing CI",
        "docs" => "docs",
        "release" => "releases",
        "research" => "research",
        "check" => "checking finished work",
        _ => "other",
    }
}

fn default_true() -> bool {
    true
}

fn all_modes() -> Vec<DispatchMode> {
    vec![
        DispatchMode::Task,
        DispatchMode::Chat,
        DispatchMode::Session,
    ]
}

/// How the assistants may use an executor config (10.5, 补齐三). The
/// owner's, set on the executor config, checked at `dispatch`. Not on the
/// `assistant` table: @-delegation, codeg-cli and config sync never see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutorUsage {
    /// The assistants may dispatch to it at all. Off, it is still there to
    /// @ in a conversation.
    #[serde(default = "default_true")]
    pub dispatch: bool,
    /// The modes it takes.
    #[serde(default = "all_modes")]
    pub modes: Vec<DispatchMode>,
    /// The projects it works on; `None` is every one. A chat takes no
    /// project, so this never refuses one.
    #[serde(default)]
    pub projects: Option<Vec<i32>>,
}

impl Default for ExecutorUsage {
    fn default() -> Self {
        Self {
            dispatch: true,
            modes: all_modes(),
            projects: None,
        }
    }
}

impl ExecutorUsage {
    /// Checked as the editor submits it.
    pub fn checked(mut self) -> Result<Self, String> {
        let mut modes = Vec::new();
        for m in all_modes() {
            if self.modes.contains(&m) {
                modes.push(m);
            }
        }
        if modes.is_empty() {
            return Err(
                "an executor config the assistants dispatch to takes at least one mode".into(),
            );
        }
        self.modes = modes;
        if let Some(p) = self.projects.as_mut() {
            p.sort_unstable();
            p.dedup();
            if p.is_empty() {
                return Err("pick at least one project, or allow every project".into());
            }
        }
        Ok(self)
    }

    pub fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

/// The team's settings: the division of work and how each executor config
/// may be used. A division entry is `bot:<uid>` (a work assistant) or
/// `assistant:<uid>` (an executor config); a kind of work left out is
/// "auto".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamSettings {
    #[serde(default, deserialize_with = "lenient")]
    pub division: BTreeMap<String, String>,
    #[serde(default, deserialize_with = "lenient_usage")]
    pub usage: BTreeMap<String, ExecutorUsage>,
}

/// Each executor config's usage on its own: one this build cannot read is
/// the default, the others stay.
fn lenient_usage<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<BTreeMap<String, ExecutorUsage>, D::Error> {
    let v = Value::deserialize(d)?;
    let Value::Object(map) = v else {
        return Ok(BTreeMap::new());
    };
    Ok(map
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_value(v).ok().map(|u| (k, u)))
        .collect())
}

impl TeamSettings {
    pub fn parse(v: Option<&Value>) -> Self {
        v.cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    }

    /// How executor config `uid` may be used (the default when the owner
    /// set nothing).
    pub fn usage_of(&self, uid: &str) -> ExecutorUsage {
        self.usage.get(uid).cloned().unwrap_or_default()
    }
}

/// A division pick, checked: `auto` (as `None`), `bot:<uid>` or
/// `assistant:<uid>`.
pub fn check_division(category: &str, value: &Value) -> Result<Option<String>, String> {
    if !DIVISION.contains(&category) {
        return Err(format!(
            "no kind of work `{category}`; one of: {}",
            DIVISION.join(", ")
        ));
    }
    match value {
        Value::Null => Ok(None),
        Value::String(s) if s == "auto" => Ok(None),
        Value::String(s) => {
            let ok = s
                .split_once(':')
                .is_some_and(|(k, uid)| matches!(k, "bot" | "assistant") && !uid.trim().is_empty());
            if ok {
                Ok(Some(s.clone()))
            } else {
                Err("a division pick is auto, bot:<uid> or assistant:<uid>".into())
            }
        }
        _ => Err("a division pick is auto, bot:<uid> or assistant:<uid>".into()),
    }
}

/// The account's preferences and team, as the page reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    pub prefs: Prefs,
    pub team: TeamSettings,
    /// The automation level the preferences add up to.
    #[serde(default)]
    pub automation_level: String,
    /// The disturbance level they add up to (1.13).
    #[serde(default)]
    pub disturb_level: String,
}

impl AccountView {
    /// Read off the primary's settings JSON.
    pub fn from_settings(raw: &str) -> Self {
        let v: Value = serde_json::from_str(raw).unwrap_or(Value::Null);
        let prefs = Prefs::parse(v.get("prefs"));
        let automation_level = prefs.automation_level().to_string();
        let disturb_level = prefs.disturb_level().to_string();
        Self {
            prefs,
            team: TeamSettings::parse(v.get("team")),
            automation_level,
            disturb_level,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_read_leniently_item_by_item() {
        let p = Prefs::parse(Some(&json!({
            "reply_length": "short",
            "cards": "holograms",
            "loop_rounds": "lots",
            "confirm_dispatch": "code",
        })));
        assert_eq!(p.reply_length, ReplyLength::Short);
        assert_eq!(p.cards, CardUse::Prefer, "an unknown word is the default");
        assert_eq!(p.loop_rounds, DEFAULT_LOOP_ROUNDS);
        assert_eq!(p.confirm_dispatch, ConfirmDispatch::Code);
        assert_eq!(Prefs::parse(None), Prefs::default());
        assert_eq!(Prefs::parse(Some(&json!("junk"))), Prefs::default());
    }

    #[test]
    fn every_item_checks_and_reads_back() {
        for s in PREFS {
            let stored = Prefs::default().get(s.key);
            assert!(!stored.is_null(), "{} is on Prefs", s.key);
            assert_eq!(check_pref(s.key, &stored).unwrap(), stored);
        }
        assert!(check_pref("reply_length", &json!("tiny")).is_err());
        assert!(check_pref("loop_rounds", &json!(1_001)).is_err());
        assert_eq!(check_pref("loop_rounds", &json!("5")).unwrap(), json!(5));
        assert!(check_pref("nope", &json!(1)).is_err());
    }

    #[test]
    fn a_time_zone_is_system_or_a_known_name() {
        assert_eq!(
            check_pref("time_zone", &json!("system")).unwrap(),
            json!("system")
        );
        assert_eq!(
            check_pref("time_zone", &json!(" SYSTEM ")).unwrap(),
            json!("system")
        );
        assert_eq!(
            check_pref("time_zone", &json!("europe/berlin")).unwrap(),
            json!("Europe/Berlin"),
            "kept as the database spells it"
        );
        assert!(check_pref("time_zone", &json!("Mars/Olympus")).is_err());
        assert!(check_pref("time_zone", &json!(8)).is_err());
        let p = Prefs::parse(Some(
            &json!({ "time_zone": "Atlantis/Lost", "presence": "maybe" }),
        ));
        assert_eq!(
            p.time_zone, "system",
            "an unknown zone reads as the system's"
        );
        assert!(p.records_presence(), "an unknown word is the default: on");
        let p = Prefs::parse(Some(
            &json!({ "time_zone": "Asia/Tokyo", "presence": "off" }),
        ));
        assert_eq!(p.time_zone, "Asia/Tokyo");
        assert!(!p.records_presence());
        assert_eq!(
            p.automation_level(),
            "standard",
            "neither is part of a level"
        );
    }

    #[test]
    fn notification_items_read_leniently_and_presets_read_off() {
        let p = Prefs::parse(Some(&json!({
            "quiet_from": "25:99",
            "quiet_to": "06:30",
            "focus_wait": 600,
            "level_reminder": "loud",
            "level_exchange": "normal",
            "normal_via": "pigeon",
        })));
        assert_eq!(p.quiet_from, DEFAULT_QUIET_FROM);
        assert_eq!(p.quiet_to, "06:30");
        assert_eq!(p.focus_wait, MAX_FOCUS_WAIT);
        assert_eq!(
            p.level_reminder,
            Level::Urgent,
            "an unknown level is the kind's own"
        );
        assert_eq!(p.level_exchange, Level::Normal);
        assert_eq!(p.normal_via, NormalVia::System);
        assert_eq!(
            check_pref("morning_at", &json!(" 7:05 ")).unwrap(),
            json!("07:05")
        );
        assert!(check_pref("morning_at", &json!("7pm")).is_err());
        let d = Prefs::default();
        assert_eq!(d.disturb_level(), "standard");
        for (kind, level, _) in NEWS {
            assert_eq!(d.level_of(kind), *level, "{kind}");
            assert!(spec(&format!("level_{kind}")).is_some(), "{kind}");
        }
        let mut map = d.to_map();
        for (k, v) in disturb_preset("more").unwrap() {
            map.insert(k.into(), v);
        }
        let more: Prefs = serde_json::from_value(Value::Object(map)).unwrap();
        assert_eq!(more.disturb_level(), "more");
        assert_eq!(more.automation_level(), "standard", "the presets are apart");
    }

    #[test]
    fn the_automation_level_is_read_off_the_items() {
        let mut p = Prefs::default();
        assert_eq!(p.automation_level(), "standard");
        let mut map = p.to_map();
        for (k, v) in automation_preset("ask_more").unwrap() {
            map.insert(k.into(), v);
        }
        p = serde_json::from_value(Value::Object(map)).unwrap();
        assert_eq!(p.automation_level(), "ask_more");
        assert!(p.confirms(DispatchMode::Task) && !p.confirms(DispatchMode::Chat));
        p.followups = AskFirst::Auto;
        assert_eq!(p.automation_level(), "custom");
    }

    #[test]
    fn the_brain_reads_the_changes_and_the_whole_set() {
        let old = Prefs::default();
        let new = Prefs {
            reply_length: ReplyLength::Short,
            worker_handoff: WorkerHandoff::Direct,
            ..Prefs::default()
        };
        let lines = prefs_changes(&old, &new, false);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("replies → short"));
        assert_eq!(
            prefs_changes(&old, &new, true).len(),
            1,
            "a worker is not told the handoff"
        );
        let block = prefs_block(&new, true);
        assert!(block.contains("<codeg-prefs>") && block.contains("replies: short"));
        assert!(!block.contains("handing work"));
    }

    #[test]
    fn usage_and_division_check() {
        let u = ExecutorUsage {
            dispatch: true,
            modes: vec![
                DispatchMode::Session,
                DispatchMode::Task,
                DispatchMode::Task,
            ],
            projects: Some(vec![3, 1, 3]),
        }
        .checked()
        .unwrap();
        assert_eq!(u.modes, vec![DispatchMode::Task, DispatchMode::Session]);
        assert_eq!(u.projects, Some(vec![1, 3]));
        assert!(ExecutorUsage {
            modes: vec![],
            ..ExecutorUsage::default()
        }
        .checked()
        .is_err());
        assert_eq!(
            check_division("review", &json!("bot:abc"))
                .unwrap()
                .as_deref(),
            Some("bot:abc")
        );
        assert_eq!(check_division("review", &json!("auto")).unwrap(), None);
        assert!(check_division("review", &json!("person:abc")).is_err());
        assert!(check_division("cooking", &json!("auto")).is_err());
        let team = TeamSettings::parse(Some(&json!({
            "division": "junk",
            "usage": { "u1": { "dispatch": false }, "u3": { "modes": "junk" } },
        })));
        assert!(team.division.is_empty());
        assert!(!team.usage_of("u1").dispatch);
        assert_eq!(team.usage_of("u1").modes.len(), 3);
        assert!(team.usage_of("u2").is_default());
        assert!(
            team.usage_of("u3").is_default(),
            "one unreadable entry leaves the others"
        );
    }
}
