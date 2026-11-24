//! The owner's preferences: the account's settings, the same for every
//! assistant, kept on the primary's row (the `prefs` key of its settings
//! JSON).
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

/// The most projects a list of them may name.
pub const PROJECTS_MAX: usize = 2_000;

/// The projects the assistants keep an eye on (`prefs.projects`): every
/// open one, new ones too (stored `"all"`), or only these (an array of
/// project ids, possibly empty). Ids of projects closed or deleted stay in
/// the list, and count again when the project is back.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ProjectScope {
    #[default]
    All,
    Only(Vec<i32>),
}

impl ProjectScope {
    /// As stored.
    pub fn to_json(&self) -> Value {
        match self {
            ProjectScope::All => json!("all"),
            ProjectScope::Only(ids) => json!(ids),
        }
    }

    /// From what is stored; `None` for what is neither form.
    pub fn from_json(v: &Value) -> Option<Self> {
        match v {
            Value::String(s) if s.trim() == "all" => Some(ProjectScope::All),
            // However long: a list is never read as "all".
            Value::Array(list) => list
                .iter()
                .map(project_id)
                .collect::<Result<Vec<_>, _>>()
                .ok()
                .map(|mut ids| {
                    ids.sort_unstable();
                    ids.dedup();
                    ProjectScope::Only(ids)
                }),
            _ => None,
        }
    }

    /// Refused when a list would be longer than [`PROJECTS_MAX`].
    pub fn checked(self) -> Result<Self, String> {
        match &self {
            ProjectScope::Only(ids) if ids.len() > PROJECTS_MAX => Err(format!(
                "`projects` names at most {PROJECTS_MAX} projects; pick \"all\" instead"
            )),
            _ => Ok(self),
        }
    }

    /// Whether project `id` (one that may be kept an eye on) is.
    pub fn covers(&self, id: i32) -> bool {
        match self {
            ProjectScope::All => true,
            ProjectScope::Only(ids) => ids.contains(&id),
        }
    }
}

impl Serialize for ProjectScope {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(s)
    }
}

impl<'de> Deserialize<'de> for ProjectScope {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let v = Value::deserialize(d)?;
        ProjectScope::from_json(&v)
            .ok_or_else(|| serde::de::Error::custom("projects: \"all\" or a list of ids"))
    }
}

/// What a change of `prefs.projects` asks, read against the value it
/// meets when it is written — so that two windows ticking projects at once
/// both stand, and a preview shown first takes what changed since.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectsOp {
    /// Every project, new ones too.
    All,
    /// Only those picked: from "all", every project there is now; a list
    /// stays as it is.
    Only,
    /// One more picked (nothing to do under "all").
    Add(i32),
    /// One fewer picked (nothing to do under "all").
    Remove(i32),
    /// Exactly these.
    Set(Vec<i32>),
    /// Back to `to`, only while it is still `expect` (an undo). Never from
    /// a caller: codeg makes it.
    Swap {
        expect: ProjectScope,
        to: ProjectScope,
    },
}

const PROJECTS_TAKES: &str = "`projects` takes \"all\" (every project, new ones too), \"only\", \
{\"add\": id}, {\"remove\": id}, or a list of project ids from `project_list`";

/// A list of project ids: positive whole numbers (or their digits), each
/// once, in order.
fn project_ids(v: &Value) -> Result<Vec<i32>, String> {
    let list = v.as_array().ok_or(PROJECTS_TAKES)?;
    let mut ids: Vec<i32> = Vec::with_capacity(list.len());
    for x in list {
        ids.push(project_id(x)?);
    }
    ids.sort_unstable();
    ids.dedup();
    if ids.len() > PROJECTS_MAX {
        return Err(format!("`projects` names at most {PROJECTS_MAX} projects"));
    }
    Ok(ids)
}

fn project_id(x: &Value) -> Result<i32, String> {
    x.as_i64()
        .or_else(|| x.as_str().and_then(|s| s.trim().trim_start_matches('#').parse().ok()))
        .and_then(|n| i32::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("`projects`: {x} is not a project id; {PROJECTS_TAKES}"))
}

impl ProjectsOp {
    /// A change as a caller gives it.
    pub fn parse(v: &Value) -> Result<Self, String> {
        match v {
            Value::String(s) => match s.trim() {
                "all" => Ok(ProjectsOp::All),
                "only" => Ok(ProjectsOp::Only),
                _ => Err(PROJECTS_TAKES.into()),
            },
            Value::Array(_) => project_ids(v).map(ProjectsOp::Set),
            Value::Object(m) if m.len() == 1 => {
                if let Some(id) = m.get("add") {
                    project_id(id).map(ProjectsOp::Add)
                } else if let Some(id) = m.get("remove") {
                    project_id(id).map(ProjectsOp::Remove)
                } else {
                    Err(PROJECTS_TAKES.into())
                }
            }
            _ => Err(PROJECTS_TAKES.into()),
        }
    }

    /// As a card keeps it.
    pub fn to_json(&self) -> Value {
        match self {
            ProjectsOp::All => json!("all"),
            ProjectsOp::Only => json!("only"),
            ProjectsOp::Add(id) => json!({ "add": id }),
            ProjectsOp::Remove(id) => json!({ "remove": id }),
            ProjectsOp::Set(ids) => json!(ids),
            ProjectsOp::Swap { expect, to } => {
                json!({ "swap": { "expect": expect.to_json(), "to": to.to_json() } })
            }
        }
    }

    /// As a card kept it — the undo's swap too.
    pub fn from_card(v: &Value) -> Result<Self, String> {
        if let Some(swap) = v.get("swap") {
            let expect = ProjectScope::from_json(&swap["expect"]).ok_or(PROJECTS_TAKES)?;
            let to = ProjectScope::from_json(&swap["to"]).ok_or(PROJECTS_TAKES)?;
            return Ok(ProjectsOp::Swap { expect, to });
        }
        Self::parse(v)
    }

    /// What it makes of `current`; `eligible`: the projects there are now
    /// (what "only" starts from).
    pub fn apply(&self, current: &ProjectScope, eligible: &[i32]) -> ProjectScope {
        match (self, current) {
            (ProjectsOp::All, _) => ProjectScope::All,
            (ProjectsOp::Only, ProjectScope::All) => {
                let mut ids = eligible.to_vec();
                ids.sort_unstable();
                ids.dedup();
                ProjectScope::Only(ids)
            }
            (ProjectsOp::Only, list) => list.clone(),
            (ProjectsOp::Add(_) | ProjectsOp::Remove(_), ProjectScope::All) => ProjectScope::All,
            (ProjectsOp::Add(id), ProjectScope::Only(ids)) => {
                let mut ids = ids.clone();
                if !ids.contains(id) {
                    ids.push(*id);
                    ids.sort_unstable();
                }
                ProjectScope::Only(ids)
            }
            (ProjectsOp::Remove(id), ProjectScope::Only(ids)) => {
                ProjectScope::Only(ids.iter().copied().filter(|x| x != id).collect())
            }
            (ProjectsOp::Set(ids), _) => ProjectScope::Only(ids.clone()),
            (ProjectsOp::Swap { expect, to }, now) if now == expect => to.clone(),
            (ProjectsOp::Swap { .. }, now) => now.clone(),
        }
    }
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

/// How many rounds of checks one piece of work gets before its assistant's
/// sending it back again goes to the owner instead (7.5); 0 sends nothing
/// back on its own.
pub const DEFAULT_ACCEPT_ROUNDS: u32 = 3;
/// The most rounds that can be set.
pub const MAX_ACCEPT_ROUNDS: u32 = 10;

fn default_accept_rounds() -> u32 {
    DEFAULT_ACCEPT_ROUNDS
}

fn lenient_accept_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_ACCEPT_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_ACCEPT_ROUNDS))
}

/// How many rounds codeg starts by itself to fix one watched pull request
/// — its checks, a conflict — before it is the owner's (7.4); 0 is never.
pub const DEFAULT_CI_ROUNDS: u32 = 3;
/// The most that can be set.
pub const MAX_CI_ROUNDS: u32 = 10;

fn default_ci_rounds() -> u32 {
    DEFAULT_CI_ROUNDS
}

fn lenient_ci_rounds<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_CI_ROUNDS as u64) as u32)
        .unwrap_or(DEFAULT_CI_ROUNDS))
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

/// What codeg does when a watched pull request's checks fail (7.4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CiFailure {
    /// Its task fixes it: a follow-up, or a new task on the pull request.
    #[default]
    Fix,
    /// The owner is asked on its card first.
    Ask,
    /// Only the card.
    Tell,
}

/// The nightly tidy-up of an assistant's memory and the process skills it
/// learns from work that went well (7.7, 7.8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TidyMode {
    /// Made at once, each with a card that takes it back.
    #[default]
    Auto,
    /// Kept as a draft on its card: made only when the owner applies it.
    Draft,
    /// Not done.
    Off,
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

/// When the morning brief is prepared (6.4).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BriefTime {
    /// A quarter of an hour before the owner's usual start, once codeg has
    /// learned it; else when they first show up in the day.
    #[default]
    Hours,
    /// `brief_at`, every day.
    Fixed,
}

/// The day's wrap-up (6.5).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WrapMode {
    /// codeg brings it near the end of the owner's usual day, and when they
    /// ask.
    #[default]
    Auto,
    /// Only when the owner asks ("that's it for today").
    Ask,
    Off,
}

/// Where the weekly review goes (6.6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WeeklyReview {
    /// The week before, in the first morning brief of a workday each week.
    #[default]
    Brief,
    /// The week so far, in Friday's wrap-up.
    Wrap,
    Off,
}

/// The fixed time the morning brief is prepared, until the owner sets
/// another.
pub const DEFAULT_BRIEF_AT: &str = "08:30";
/// Suggestions a morning brief carries at most.
pub const DEFAULT_BRIEF_SUGGESTIONS: u32 = 3;
pub const MAX_BRIEF_SUGGESTIONS: u32 = 5;

fn default_brief_at() -> String {
    DEFAULT_BRIEF_AT.into()
}

fn lenient_brief_at<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    lenient_clock(d, default_brief_at)
}

fn default_brief_suggestions() -> u32 {
    DEFAULT_BRIEF_SUGGESTIONS
}

fn lenient_brief_suggestions<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(v.as_u64()
        .map(|n| n.min(MAX_BRIEF_SUGGESTIONS as u64) as u32)
        .unwrap_or(DEFAULT_BRIEF_SUGGESTIONS))
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

// ── codeg's proposal rules (6.7): how long before each says something ───────

/// Hours dispatched work or a board task stays failed with nobody on it.
pub const RULE_FAILED_HOURS: u32 = 2;
/// Hours a board task waits for review without a round of acceptance.
pub const RULE_REVIEW_HOURS: u32 = 24;
/// Minutes a session waits for the owner's answer or approval.
pub const RULE_SESSION_MINUTES: u32 = 10;
/// Days a pull request waits for the owner's review.
pub const RULE_PR_REVIEW_DAYS: u32 = 2;
/// Hours a project or worktree keeps changes nobody committed.
pub const RULE_UNCOMMITTED_HOURS: u32 = 24;
/// Days a matter goes without a change.
pub const RULE_IDLE_DAYS: u32 = 7;
/// The how-manyth alike request makes the "make it a routine?" offer.
pub const RULE_REPEAT_COUNT: u32 = 3;
const RULE_MAX_HOURS: u32 = 24 * 30;
const RULE_MAX_MINUTES: u32 = 24 * 60;
const RULE_MAX_DAYS: u32 = 90;
const RULE_MAX_COUNT: u32 = 20;

macro_rules! rule_count {
    ($default_fn:ident, $lenient_fn:ident, $default:expr, $max:expr) => {
        fn $default_fn() -> u32 {
            $default
        }

        fn $lenient_fn<'de, D: Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
            let v = Value::deserialize(d)?;
            Ok(v.as_u64()
                .map(|n| n.min($max as u64) as u32)
                .unwrap_or($default))
        }
    };
}

rule_count!(default_rule_failed_hours, lenient_rule_failed_hours, RULE_FAILED_HOURS, RULE_MAX_HOURS);
rule_count!(default_rule_review_hours, lenient_rule_review_hours, RULE_REVIEW_HOURS, RULE_MAX_HOURS);
rule_count!(
    default_rule_session_minutes,
    lenient_rule_session_minutes,
    RULE_SESSION_MINUTES,
    RULE_MAX_MINUTES
);
rule_count!(
    default_rule_pr_review_days,
    lenient_rule_pr_review_days,
    RULE_PR_REVIEW_DAYS,
    RULE_MAX_DAYS
);
rule_count!(
    default_rule_uncommitted_hours,
    lenient_rule_uncommitted_hours,
    RULE_UNCOMMITTED_HOURS,
    RULE_MAX_HOURS
);
rule_count!(default_rule_idle_days, lenient_rule_idle_days, RULE_IDLE_DAYS, RULE_MAX_DAYS);
rule_count!(default_rule_repeat_count, lenient_rule_repeat_count, RULE_REPEAT_COUNT, RULE_MAX_COUNT);

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
    (
        "acceptance",
        Level::Normal,
        "acceptance of dispatched work: ready to merge, merged, a call to make",
    ),
    (
        "forge",
        Level::Low,
        "what an assistant did on a forge: a comment, an issue closed, a merge",
    ),
    (
        "pr_ready",
        Level::Normal,
        "a watched pull request that can be merged",
    ),
    (
        "pr",
        Level::Low,
        "watched pull requests: checks failed or green again, a conflict, merged, closed",
    ),
    ("routine", Level::Normal, "a routine's report"),
    (
        "routine_paused",
        Level::Urgent,
        "a routine paused: it failed three times in a row, or its work has nothing set to run on",
    ),
    (
        "used_up",
        Level::Urgent,
        "work sent back as many rounds as allowed, still not right",
    ),
    (
        "proposal",
        Level::Normal,
        "codeg's proposals about what is stuck on them: work failed with nobody on it, work \
         waiting long for review, a pull request waiting for their review",
    ),
    (
        "proposal_low",
        Level::Low,
        "codeg's other proposals: changes left uncommitted, a matter gone quiet, a branch \
         behind with conflicts, a request they keep making",
    ),
    ("brief", Level::Normal, "the morning brief and the day's wrap-up"),
    (
        "memory",
        Level::Low,
        "what an assistant changed in its memory, persona, rules or process skills — its nightly tidy-up too",
    ),
    ("plan", Level::Normal, "a plan carried out to its end"),
    (
        "plan_stuck",
        Level::Urgent,
        "a plan stuck on a step that failed and stayed failed",
    ),
];

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
    /// Code work an assistant dispatched is checked and accepted on its own
    /// (7.5); off, it waits for the owner's review as before.
    #[serde(default, deserialize_with = "lenient")]
    pub auto_accept: OnOff,
    /// Before codeg compacts an assistant's context, the assistant notes
    /// the day's points so far in its log (7.7).
    #[serde(default, deserialize_with = "lenient")]
    pub flush: OnOff,
    /// Work its assistant wants changed after the check: sent back at once,
    /// or put to the owner on the acceptance card first.
    #[serde(default, deserialize_with = "lenient")]
    pub accept_revise: AskFirst,
    /// Rounds of checks one piece of work gets; 0 sends nothing back on its
    /// own.
    #[serde(
        default = "default_accept_rounds",
        deserialize_with = "lenient_accept_rounds"
    )]
    pub accept_rounds: u32,
    /// A comment an assistant posts on a forge (7.4): posted at once, or
    /// put to the owner on an approval card first.
    #[serde(default, deserialize_with = "lenient")]
    pub forge_comment: AskFirst,
    /// An issue an assistant closes on a forge.
    #[serde(default, deserialize_with = "lenient")]
    pub issue_close: AskFirst,
    /// A pull request an assistant merges: when its head is the version to
    /// merge and its checks are green; CNB always asks.
    #[serde(default, deserialize_with = "lenient")]
    pub pr_merge: AskFirst,
    /// The work a dispatch routine hands out (6.9): handed out at once, or
    /// put to the owner on a confirm card first.
    #[serde(default, deserialize_with = "lenient")]
    pub routine_dispatch: AskFirst,
    /// A plan an assistant lays out (7.6): started at once, or shown to the
    /// owner first and started on their [Start].
    #[serde(default, deserialize_with = "lenient")]
    pub plans: AskFirst,
    /// The nightly tidy-up of every assistant's memory, and the process
    /// skills learned from work that went well (7.7, 7.8): made at once with
    /// a card that undoes it, kept as drafts, or not done.
    #[serde(default, deserialize_with = "lenient")]
    pub tidy: TidyMode,
    /// A watched pull request whose checks failed (7.4): fixed by its task,
    /// the owner asked first, or only told.
    #[serde(default, deserialize_with = "lenient")]
    pub ci_failure: CiFailure,
    /// A watched pull request that conflicts with its base: its task brings
    /// it up to date at once, or the owner is asked first.
    #[serde(default, deserialize_with = "lenient")]
    pub pr_conflict: AskFirst,
    /// Review feedback from those who can write to the repository: handed
    /// to the pull request's task at once, or the owner asked first.
    #[serde(default, deserialize_with = "lenient")]
    pub review_feedback: AskFirst,
    /// Comments from those who cannot: the assistant judges whether its
    /// task should have them, or the owner is asked.
    #[serde(default, deserialize_with = "lenient")]
    pub outsider_comments: AskFirst,
    /// Rounds codeg starts by itself to fix one pull request; 0 is never.
    #[serde(default = "default_ci_rounds", deserialize_with = "lenient_ci_rounds")]
    pub ci_rounds: u32,
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
    #[serde(default, deserialize_with = "lenient")]
    pub level_acceptance: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_forge: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_pr_ready: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_pr: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_routine: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_routine_paused: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_used_up: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_proposal: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_proposal_low: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_brief: Level,
    #[serde(default = "low", deserialize_with = "lenient_low")]
    pub level_memory: Level,
    #[serde(default, deserialize_with = "lenient")]
    pub level_plan: Level,
    #[serde(default = "urgent", deserialize_with = "lenient_urgent")]
    pub level_plan_stuck: Level,
    /// The projects the assistants keep an eye on: every open one (new ones
    /// too), or only those picked.
    #[serde(default, deserialize_with = "lenient")]
    pub projects: ProjectScope,
    /// codeg's proposal rules (6.7), each on or off, with how long before
    /// it says something. A rule the owner muted from a card is off here.
    #[serde(default, deserialize_with = "lenient")]
    pub rule_failed: OnOff,
    #[serde(
        default = "default_rule_failed_hours",
        deserialize_with = "lenient_rule_failed_hours"
    )]
    pub rule_failed_hours: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_review: OnOff,
    #[serde(
        default = "default_rule_review_hours",
        deserialize_with = "lenient_rule_review_hours"
    )]
    pub rule_review_hours: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_session: OnOff,
    #[serde(
        default = "default_rule_session_minutes",
        deserialize_with = "lenient_rule_session_minutes"
    )]
    pub rule_session_minutes: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_pr_review: OnOff,
    #[serde(
        default = "default_rule_pr_review_days",
        deserialize_with = "lenient_rule_pr_review_days"
    )]
    pub rule_pr_review_days: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_uncommitted: OnOff,
    #[serde(
        default = "default_rule_uncommitted_hours",
        deserialize_with = "lenient_rule_uncommitted_hours"
    )]
    pub rule_uncommitted_hours: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_idle: OnOff,
    #[serde(
        default = "default_rule_idle_days",
        deserialize_with = "lenient_rule_idle_days"
    )]
    pub rule_idle_days: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_behind: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub rule_repeat: OnOff,
    #[serde(
        default = "default_rule_repeat_count",
        deserialize_with = "lenient_rule_repeat_count"
    )]
    pub rule_repeat_count: u32,
    /// The assistants' own suggestions (`suggest: true`).
    #[serde(default, deserialize_with = "lenient")]
    pub rule_suggest: OnOff,
    /// The morning brief (6.4): whether there is one, when it is prepared,
    /// the parts it has, and how many suggestions it may make.
    #[serde(default, deserialize_with = "lenient")]
    pub brief: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_time: BriefTime,
    #[serde(default = "default_brief_at", deserialize_with = "lenient_brief_at")]
    pub brief_at: String,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_needs: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_night: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_bots: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_schedule: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_loose: OnOff,
    #[serde(default, deserialize_with = "lenient")]
    pub brief_yesterday: OnOff,
    #[serde(
        default = "default_brief_suggestions",
        deserialize_with = "lenient_brief_suggestions"
    )]
    pub brief_suggestions: u32,
    /// The day's wrap-up (6.5), and the "tonight I can do" it offers.
    #[serde(default, deserialize_with = "lenient")]
    pub wrap: WrapMode,
    #[serde(default, deserialize_with = "lenient")]
    pub wrap_tonight: OnOff,
    /// The computer kept awake while work the owner had done tonight runs
    /// (desktop only).
    #[serde(default, deserialize_with = "lenient")]
    pub keep_awake: OnOff,
    /// The menu bar icon shows the busy assistant's face, the count of
    /// assistants with unread and the recent ones (10.10; desktop only).
    #[serde(default, deserialize_with = "lenient")]
    pub menubar: OnOff,
    /// The dock badge counts the assistants with unread (10.10; desktop
    /// only).
    #[serde(default, deserialize_with = "lenient")]
    pub dock_badge: OnOff,
    /// The time machine searches every conversation in codeg, not only the
    /// assistants' timelines and messages (8.2, 13.5 About you). Off, the
    /// conversations leave the index.
    #[serde(default, deserialize_with = "lenient")]
    pub history_sessions: OnOff,
    /// The time machine searches the board's tasks.
    #[serde(default, deserialize_with = "lenient")]
    pub history_tasks: OnOff,
    /// codeg keeps count of how the owner answers each kind of card, and
    /// lowers a kind they keep dismissing (5.2, 13.5 About you). Off, it
    /// lowers nothing and what it lowered goes back.
    #[serde(default, deserialize_with = "lenient")]
    pub reactions: OnOff,
    /// The weekly review (6.6).
    #[serde(default, deserialize_with = "lenient")]
    pub weekly_review: WeeklyReview,
    /// The weekly review asks whether to show changes first when the owner
    /// undid many of those made at their word (6.6, 3.1).
    #[serde(default, deserialize_with = "lenient")]
    pub rule_undo: OnOff,
    /// The weekly review asks whether to hide or delete a work assistant
    /// not woken for two weeks.
    #[serde(default, deserialize_with = "lenient")]
    pub rule_idle_bot: OnOff,
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
            loop_rounds: DEFAULT_LOOP_ROUNDS,
            interrupt_retry: AskFirst::default(),
            retry_rounds: DEFAULT_RETRY_ROUNDS,
            exec_questions: ExecAnswers::default(),
            exec_plans: ExecAnswers::default(),
            auto_accept: OnOff::default(),
            flush: OnOff::On,
            accept_revise: AskFirst::default(),
            accept_rounds: DEFAULT_ACCEPT_ROUNDS,
            forge_comment: AskFirst::default(),
            issue_close: AskFirst::default(),
            pr_merge: AskFirst::default(),
            routine_dispatch: AskFirst::default(),
            plans: AskFirst::default(),
            tidy: TidyMode::default(),
            ci_failure: CiFailure::default(),
            pr_conflict: AskFirst::default(),
            review_feedback: AskFirst::default(),
            outsider_comments: AskFirst::default(),
            ci_rounds: DEFAULT_CI_ROUNDS,
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
            level_acceptance: Level::Normal,
            level_forge: Level::Low,
            level_pr_ready: Level::Normal,
            level_pr: Level::Low,
            level_routine: Level::Normal,
            level_routine_paused: Level::Urgent,
            level_used_up: Level::Urgent,
            level_proposal: Level::Normal,
            level_proposal_low: Level::Low,
            level_brief: Level::Normal,
            level_memory: Level::Low,
            level_plan: Level::Normal,
            level_plan_stuck: Level::Urgent,
            projects: ProjectScope::All,
            rule_failed: OnOff::On,
            rule_failed_hours: RULE_FAILED_HOURS,
            rule_review: OnOff::On,
            rule_review_hours: RULE_REVIEW_HOURS,
            rule_session: OnOff::On,
            rule_session_minutes: RULE_SESSION_MINUTES,
            rule_pr_review: OnOff::On,
            rule_pr_review_days: RULE_PR_REVIEW_DAYS,
            rule_uncommitted: OnOff::On,
            rule_uncommitted_hours: RULE_UNCOMMITTED_HOURS,
            rule_idle: OnOff::On,
            rule_idle_days: RULE_IDLE_DAYS,
            rule_behind: OnOff::On,
            rule_repeat: OnOff::On,
            rule_repeat_count: RULE_REPEAT_COUNT,
            rule_suggest: OnOff::On,
            brief: OnOff::On,
            brief_time: BriefTime::Hours,
            brief_at: default_brief_at(),
            brief_needs: OnOff::On,
            brief_night: OnOff::On,
            brief_bots: OnOff::On,
            brief_schedule: OnOff::On,
            brief_loose: OnOff::On,
            brief_yesterday: OnOff::On,
            brief_suggestions: DEFAULT_BRIEF_SUGGESTIONS,
            wrap: WrapMode::Auto,
            wrap_tonight: OnOff::On,
            keep_awake: OnOff::On,
            menubar: OnOff::On,
            dock_badge: OnOff::On,
            history_sessions: OnOff::On,
            history_tasks: OnOff::On,
            reactions: OnOff::On,
            weekly_review: WeeklyReview::Brief,
            rule_undo: OnOff::On,
            rule_idle_bot: OnOff::On,
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
    /// The projects kept an eye on (`ProjectsOp`).
    Projects,
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
        key: "auto_accept",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "checking and accepting the code work you dispatched",
    },
    PrefSpec {
        key: "flush",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "noting the day's points in the log before the context is compacted",
    },
    PrefSpec {
        key: "accept_revise",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "sending work back after its check",
    },
    PrefSpec {
        key: "accept_rounds",
        kind: PrefKind::Count {
            max: MAX_ACCEPT_ROUNDS,
        },
        label: "rounds of checks one piece of work gets",
    },
    PrefSpec {
        key: "forge_comment",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "comments you post on a forge",
    },
    PrefSpec {
        key: "issue_close",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "issues you close on a forge",
    },
    PrefSpec {
        key: "pr_merge",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "pull requests you merge",
    },
    PrefSpec {
        key: "routine_dispatch",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "the work your dispatch routines hand out",
    },
    PrefSpec {
        key: "plans",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "the plans you lay out",
    },
    PrefSpec {
        key: "tidy",
        kind: PrefKind::Choice(&["auto", "draft", "off"]),
        label: "the nightly tidy-up of each assistant's memory, persona and rules, and the process skills learned from work that went well",
    },
    PrefSpec {
        key: "ci_failure",
        kind: PrefKind::Choice(&["fix", "ask", "tell"]),
        label: "a watched pull request whose checks failed",
    },
    PrefSpec {
        key: "pr_conflict",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "a watched pull request that conflicts with its base",
    },
    PrefSpec {
        key: "review_feedback",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "review feedback on a watched pull request from those who can write to it",
    },
    PrefSpec {
        key: "outsider_comments",
        kind: PrefKind::Choice(&["auto", "ask"]),
        label: "comments on a watched pull request from those who cannot write to it",
    },
    PrefSpec {
        key: "ci_rounds",
        kind: PrefKind::Count { max: MAX_CI_ROUNDS },
        label: "rounds codeg starts by itself to fix one pull request",
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
        key: "projects",
        kind: PrefKind::Projects,
        label: "the projects the assistants keep an eye on: \"all\" (new ones too), or a list of \
                project ids from `project_list`",
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
    PrefSpec {
        key: "level_acceptance",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent acceptance news is (ready to merge, merged, a call to make)",
    },
    PrefSpec {
        key: "level_forge",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent what an assistant did on a forge is",
    },
    PrefSpec {
        key: "level_pr_ready",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent a watched pull request that can be merged is",
    },
    PrefSpec {
        key: "level_pr",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent the rest of a watched pull request's news is",
    },
    PrefSpec {
        key: "level_routine",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent a routine's report is",
    },
    PrefSpec {
        key: "level_routine_paused",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent a paused routine is",
    },
    PrefSpec {
        key: "level_used_up",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent work sent back as many rounds as allowed is",
    },
    PrefSpec {
        key: "level_proposal",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent codeg's proposals about what is stuck on the owner are",
    },
    PrefSpec {
        key: "level_proposal_low",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent codeg's other proposals are",
    },
    PrefSpec {
        key: "level_brief",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent the morning brief and the wrap-up are",
    },
    PrefSpec {
        key: "level_memory",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent an assistant's memory changes are",
    },
    PrefSpec {
        key: "level_plan",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent a plan carried out to its end is",
    },
    PrefSpec {
        key: "level_plan_stuck",
        kind: PrefKind::Choice(LEVELS),
        label: "how urgent a stuck plan is",
    },
    PrefSpec {
        key: "rule_failed",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on work that failed with nobody on it",
    },
    PrefSpec {
        key: "rule_failed_hours",
        kind: PrefKind::Count {
            max: RULE_MAX_HOURS,
        },
        label: "hours failed work waits before that card",
    },
    PrefSpec {
        key: "rule_review",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on a board task waiting long for review",
    },
    PrefSpec {
        key: "rule_review_hours",
        kind: PrefKind::Count {
            max: RULE_MAX_HOURS,
        },
        label: "hours a task waits for review before that card",
    },
    PrefSpec {
        key: "rule_session",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on a session waiting for the owner",
    },
    PrefSpec {
        key: "rule_session_minutes",
        kind: PrefKind::Count {
            max: RULE_MAX_MINUTES,
        },
        label: "minutes a session waits before that card",
    },
    PrefSpec {
        key: "rule_pr_review",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on a pull request waiting for the owner's review",
    },
    PrefSpec {
        key: "rule_pr_review_days",
        kind: PrefKind::Count {
            max: RULE_MAX_DAYS,
        },
        label: "days a review request waits before that card",
    },
    PrefSpec {
        key: "rule_uncommitted",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on changes left uncommitted",
    },
    PrefSpec {
        key: "rule_uncommitted_hours",
        kind: PrefKind::Count {
            max: RULE_MAX_HOURS,
        },
        label: "hours changes stay uncommitted before that card",
    },
    PrefSpec {
        key: "rule_idle",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on a matter gone quiet",
    },
    PrefSpec {
        key: "rule_idle_days",
        kind: PrefKind::Count {
            max: RULE_MAX_DAYS,
        },
        label: "days without a change before that card",
    },
    PrefSpec {
        key: "rule_behind",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's card on a dispatched task's branch behind its target with conflicts",
    },
    PrefSpec {
        key: "rule_repeat",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg's offer to make a request the owner keeps making a routine",
    },
    PrefSpec {
        key: "rule_repeat_count",
        kind: PrefKind::Count {
            max: RULE_MAX_COUNT,
        },
        label: "the how-manyth alike request in 30 days makes that offer",
    },
    PrefSpec {
        key: "rule_suggest",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the assistants' own suggestions (`suggest: true`)",
    },
    PrefSpec {
        key: "rule_undo",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the weekly review asking to show changes first when the owner undoes many",
    },
    PrefSpec {
        key: "rule_idle_bot",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the weekly review asking to hide or delete a work assistant idle two weeks",
    },
    PrefSpec {
        key: "brief",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the morning brief",
    },
    PrefSpec {
        key: "brief_time",
        kind: PrefKind::Choice(&["hours", "fixed"]),
        label: "when the morning brief is prepared",
    },
    PrefSpec {
        key: "brief_at",
        kind: PrefKind::Clock,
        label: "the fixed time the morning brief is prepared",
    },
    PrefSpec {
        key: "brief_needs",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's part on what waits on the owner",
    },
    PrefSpec {
        key: "brief_night",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's part on what happened since the last one",
    },
    PrefSpec {
        key: "brief_bots",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's line for each work assistant",
    },
    PrefSpec {
        key: "brief_schedule",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's part on the day's schedule",
    },
    PrefSpec {
        key: "brief_loose",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's part on loose ends",
    },
    PrefSpec {
        key: "brief_yesterday",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the brief's part on the owner's yesterday",
    },
    PrefSpec {
        key: "brief_suggestions",
        kind: PrefKind::Count {
            max: MAX_BRIEF_SUGGESTIONS,
        },
        label: "suggestions in the morning brief, at most (0: none)",
    },
    PrefSpec {
        key: "wrap",
        kind: PrefKind::Choice(&["auto", "ask", "off"]),
        label: "the day's wrap-up",
    },
    PrefSpec {
        key: "wrap_tonight",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "\"tonight I can do\" in the wrap-up",
    },
    PrefSpec {
        key: "keep_awake",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "keeping the computer awake while work chosen for tonight runs (desktop)",
    },
    PrefSpec {
        key: "menubar",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the busy assistant's face, the unread count and the recent assistants in the menu bar (desktop)",
    },
    PrefSpec {
        key: "dock_badge",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "the dock badge counting the assistants with unread (desktop)",
    },
    PrefSpec {
        key: "history_sessions",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "history_search looking through every conversation in codeg",
    },
    PrefSpec {
        key: "history_tasks",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "history_search looking through the board's tasks",
    },
    PrefSpec {
        key: "reactions",
        kind: PrefKind::Choice(&["on", "off"]),
        label: "codeg counting how the owner answers each kind of card, to lower a kind they keep dismissing",
    },
    PrefSpec {
        key: "weekly_review",
        kind: PrefKind::Choice(&["brief", "wrap", "off"]),
        label: "the weekly review",
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
        "quiet" => Some(
            [
                ("normal_via", json!("today")),
                ("low_via", json!("today")),
                ("wrap", json!("ask")),
            ]
            .into_iter()
            .chain(rule_preset(level))
            .collect(),
        ),
        "standard" => Some(
            [
                ("normal_via", json!("system")),
                ("low_via", json!("today")),
                ("focus_wait", json!(DEFAULT_FOCUS_WAIT)),
                ("wrap", json!("auto")),
            ]
            .into_iter()
            .chain(rule_preset(level))
            .collect(),
        ),
        "more" => Some(
            [
                ("normal_via", json!("system")),
                ("low_via", json!("digest")),
                ("focus_wait", json!(0)),
                ("wrap", json!("auto")),
            ]
            .into_iter()
            .chain(rule_preset(level))
            .collect(),
        ),
        _ => None,
    }
}

/// The proposal rules at each disturbance level (13.4): "quiet" keeps only a
/// session waiting and work failed with nobody on it; "more" halves every
/// threshold. The assistants' own suggestions are not the level's.
fn rule_preset(level: &str) -> Vec<(&'static str, Value)> {
    let quiet = level == "quiet";
    let on = |keep: bool| json!(if keep { "on" } else { "off" });
    let time = |n: u32| json!(if level == "more" { n.div_ceil(2) } else { n });
    vec![
        ("rule_failed", on(true)),
        ("rule_failed_hours", time(RULE_FAILED_HOURS)),
        ("rule_review", on(!quiet)),
        ("rule_review_hours", time(RULE_REVIEW_HOURS)),
        ("rule_session", on(true)),
        ("rule_session_minutes", time(RULE_SESSION_MINUTES)),
        ("rule_pr_review", on(!quiet)),
        ("rule_pr_review_days", time(RULE_PR_REVIEW_DAYS)),
        ("rule_uncommitted", on(!quiet)),
        ("rule_uncommitted_hours", time(RULE_UNCOMMITTED_HOURS)),
        ("rule_idle", on(!quiet)),
        ("rule_idle_days", time(RULE_IDLE_DAYS)),
        ("rule_behind", on(!quiet)),
        ("rule_repeat", on(!quiet)),
    ]
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
            ("accept_revise", json!("auto")),
            ("forge_comment", json!("auto")),
            ("issue_close", json!("auto")),
            ("pr_merge", json!("auto")),
            ("routine_dispatch", json!("auto")),
            ("plans", json!("auto")),
            ("tidy", json!("auto")),
            ("ci_failure", json!("fix")),
            ("pr_conflict", json!("auto")),
            ("review_feedback", json!("auto")),
            ("outsider_comments", json!("auto")),
        ]),
        "ask_more" => Some(vec![
            ("confirm_dispatch", json!("code")),
            ("followups", json!("ask")),
            ("messages", json!("ask")),
            ("chat_changes", json!("show")),
            ("interrupt_retry", json!("ask")),
            ("exec_questions", json!("owner")),
            ("exec_plans", json!("owner")),
            ("accept_revise", json!("ask")),
            ("forge_comment", json!("ask")),
            ("issue_close", json!("ask")),
            ("pr_merge", json!("ask")),
            ("routine_dispatch", json!("ask")),
            ("plans", json!("ask")),
            ("tidy", json!("draft")),
            ("ci_failure", json!("ask")),
            ("pr_conflict", json!("ask")),
            ("review_feedback", json!("ask")),
            ("outsider_comments", json!("ask")),
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
        PrefKind::Projects => ProjectsOp::parse(value).map(|op| op.to_json()),
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
    /// Whether the time machine searches every conversation (8.2).
    pub fn searches_sessions(&self) -> bool {
        self.history_sessions == OnOff::On
    }

    /// Whether the time machine searches the board's tasks (8.2).
    pub fn searches_tasks(&self) -> bool {
        self.history_tasks == OnOff::On
    }

    pub fn records_presence(&self) -> bool {
        self.presence == OnOff::On
    }

    /// Whether codeg learns from how the owner answers cards (5.2).
    pub fn records_reactions(&self) -> bool {
        self.reactions == OnOff::On
    }

    /// Set the level of news kind `kind` (one of [`NEWS`]); `false` for a
    /// kind there is none of.
    pub fn set_level(&mut self, kind: &str, level: Level) -> bool {
        let slot = match kind {
            "reminder" => &mut self.level_reminder,
            "forwarded" => &mut self.level_forwarded,
            "approval" => &mut self.level_approval,
            "waiting" => &mut self.level_waiting,
            "question" => &mut self.level_question,
            "confirm" => &mut self.level_confirm,
            "stuck" => &mut self.level_stuck,
            "done" => &mut self.level_done,
            "reply" => &mut self.level_reply,
            "exchange" => &mut self.level_exchange,
            "changed" => &mut self.level_changed,
            "answered" => &mut self.level_answered,
            "acceptance" => &mut self.level_acceptance,
            "forge" => &mut self.level_forge,
            "pr_ready" => &mut self.level_pr_ready,
            "pr" => &mut self.level_pr,
            "routine" => &mut self.level_routine,
            "routine_paused" => &mut self.level_routine_paused,
            "used_up" => &mut self.level_used_up,
            "proposal" => &mut self.level_proposal,
            "proposal_low" => &mut self.level_proposal_low,
            "brief" => &mut self.level_brief,
            "memory" => &mut self.level_memory,
            "plan" => &mut self.level_plan,
            "plan_stuck" => &mut self.level_plan_stuck,
            _ => return false,
        };
        *slot = level;
        true
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
            "acceptance" => self.level_acceptance,
            "forge" => self.level_forge,
            "pr_ready" => self.level_pr_ready,
            "pr" => self.level_pr,
            "routine" => self.level_routine,
            "routine_paused" => self.level_routine_paused,
            "used_up" => self.level_used_up,
            "proposal" => self.level_proposal,
            "proposal_low" => self.level_proposal_low,
            "brief" => self.level_brief,
            "memory" => self.level_memory,
            "plan" => self.level_plan,
            "plan_stuck" => self.level_plan_stuck,
            _ => Level::Normal,
        }
    }

    /// Whether an assistant notes the day's points before codeg compacts
    /// its context (7.7).
    pub fn flushes(&self) -> bool {
        self.flush == OnOff::On
    }

    /// Whether code work an assistant dispatched is checked and accepted
    /// on its own (7.5).
    pub fn accepts(&self) -> bool {
        self.auto_accept == OnOff::On
    }

    /// Whether codeg reaches out to the owner with more than reminders.
    pub fn proactive(&self) -> bool {
        self.proactive == OnOff::On
    }

    /// Whether part `part` of the morning brief (`needs`, `night`, `bots`,
    /// `schedule`, `loose`, `yesterday`) is wanted.
    pub fn brief_part(&self, part: &str) -> bool {
        let on = match part {
            "needs" => self.brief_needs,
            "night" => self.brief_night,
            "bots" => self.brief_bots,
            "schedule" => self.brief_schedule,
            "loose" => self.brief_loose,
            "yesterday" => self.brief_yesterday,
            _ => return false,
        };
        on == OnOff::On
    }

    /// Whether proposal rule `rule` (6.7: `failed`, `review`, `session`,
    /// `pr_review`, `uncommitted`, `idle`, `behind`,
    /// `repeat`, `suggest`) is on.
    pub fn rule_on(&self, rule: &str) -> bool {
        let on = match rule {
            "failed" => self.rule_failed,
            "review" => self.rule_review,
            "session" => self.rule_session,
            "pr_review" => self.rule_pr_review,
            "uncommitted" => self.rule_uncommitted,
            "idle" => self.rule_idle,
            "behind" => self.rule_behind,
            "repeat" => self.rule_repeat,
            "suggest" => self.rule_suggest,
            "undo" => self.rule_undo,
            "idle_bot" => self.rule_idle_bot,
            _ => return false,
        };
        on == OnOff::On
    }

    /// How long rule `rule` waits before it says something, as a duration;
    /// `None` for a rule that says it at once.
    pub fn rule_after(&self, rule: &str) -> Option<chrono::Duration> {
        let h = |n: u32| chrono::Duration::hours(n as i64);
        Some(match rule {
            "failed" => h(self.rule_failed_hours),
            "review" => h(self.rule_review_hours),
            "session" => chrono::Duration::minutes(self.rule_session_minutes as i64),
            "pr_review" => chrono::Duration::days(self.rule_pr_review_days as i64),
            "uncommitted" => h(self.rule_uncommitted_hours),
            "idle" => chrono::Duration::days(self.rule_idle_days as i64),
            _ => return None,
        })
    }

    /// The how-manyth alike request makes the routine offer (at least the
    /// second).
    pub fn repeat_count(&self) -> usize {
        self.rule_repeat_count.max(2) as usize
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
            "the settings, assistants and routines the owner asks to change (prefs_update, \
             bot_create, bot_update, routine_create, routine_update) change at once; they can \
             undo it"
                .into()
        }
        ("chat_changes", "show") => {
            "what the owner asks to change in the settings, assistants and routines goes on a \
             card for them first"
                .into()
        }
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
        ("auto_accept", "on") => {
            "on: when code work you dispatched is ready for review, codeg checks it in a \
             separate read-only session and you accept it with acceptance_decide"
                .into()
        }
        ("auto_accept", "off") => {
            "off: code work ready for review waits for the owner's own review".into()
        }
        ("flush", "on") => {
            "on: before codeg compacts your context, it asks you to note the day's points so far \
             in your log first"
                .into()
        }
        ("flush", "off") => {
            "off: codeg compacts your context without asking for notes first".into()
        }
        ("accept_revise", "auto") => "sent back to the work session at once".into(),
        ("forge_comment" | "issue_close", "auto") => {
            "done at once; the owner sees a card with what was done and where".into()
        }
        ("forge_comment" | "issue_close", "ask") => {
            "put to the owner on an approval card; done once they approve".into()
        }
        ("pr_merge", "auto") => {
            "merged at once when its head is the version to merge and its checks are green \
             (CNB: always an approval card)"
                .into()
        }
        ("pr_merge", "ask") => {
            "put to the owner on an approval card; merged once they approve".into()
        }
        ("routine_dispatch", "auto") => {
            "a dispatch routine hands out its work at once when it runs".into()
        }
        ("routine_dispatch", "ask") => {
            "a dispatch routine's work is put to the owner on a confirm card first; it runs once \
             they confirm"
                .into()
        }
        ("plans", "auto") => {
            "a plan starts as soon as you lay it out: codeg hands out each step once the steps it \
             depends on are done"
                .into()
        }
        ("plans", "ask") => {
            "a plan is shown to the owner first; codeg starts it once they press Start".into()
        }
        ("tidy", "auto") => {
            "each night codeg has every assistant tidy its memory, persona and rules, and after \
             work that went well has its assistant write the process down as a skill: both made \
             at once, each with a card that undoes it"
                .into()
        }
        ("tidy", "draft") => {
            "the nightly tidy-up and the process skills learned from work are kept as drafts on \
             their cards; made only when the owner applies them"
                .into()
        }
        ("tidy", "off") => {
            "no nightly tidy-up and no process skills learned from work; a skill the owner asks \
             for is still written"
                .into()
        }
        ("accept_revise", "ask") => {
            "put to the owner on the acceptance card, with what you would send back".into()
        }
        ("ci_failure", "fix") => {
            "the pull request's task fixes it by itself: a follow-up while it is in review, else \
             a new task on the pull request; codeg pushes the fix once it is accepted"
                .into()
        }
        ("ci_failure", "ask") => "the owner is asked on its card whether to fix it".into(),
        ("ci_failure", "tell") => "only the card; nothing is fixed by itself".into(),
        ("pr_conflict", "auto") => {
            "its task brings the branch up to date with its base by itself (merging the base in)"
                .into()
        }
        ("pr_conflict", "ask") => "the owner is asked on its card first".into(),
        ("review_feedback", "auto") => {
            "handed to the pull request's task at once, word for word, to accept, clarify or \
             answer with reasons point by point"
                .into()
        }
        ("review_feedback", "ask") => "the owner is asked on its card first".into(),
        ("outsider_comments", "auto") => {
            "you are told who wrote what; you judge whether its task should have it \
             (pr_feedback_forward), tell the owner, or let it be"
                .into()
        }
        ("outsider_comments", "ask") => {
            "the owner is asked on a card whether the task should have them".into()
        }
        ("ci_rounds", _) => match value.as_u64() {
            Some(0) => "none: codeg fixes nothing by itself; the owner decides".into(),
            Some(n) => format!(
                "at most {n} for one pull request, then it is the owner's — urgently, with what \
                 each round changed"
            ),
            None => value.to_string(),
        },
        ("accept_rounds", _) => match value.as_u64() {
            Some(0) => "none: nothing is sent back on its own; the owner decides".into(),
            Some(n) => format!("at most {n} checks, then it is the owner's call"),
            None => value.to_string(),
        },
        ("time_zone", SYSTEM_ZONE) => "the system's — <codeg-now> gives it".into(),
        ("time_zone", zone) => format!("{zone} — <codeg-now> gives the time in it"),
        ("presence", "on") => {
            "on: codeg notes the minutes the owner is active in codeg and learns their usual hours"
                .into()
        }
        ("presence", "off") => "off: nothing is noted; their hours are the defaults".into(),
        (k, "on") if k.starts_with("rule_") => "on: codeg puts a card in front of the owner".into(),
        (k, "off") if k.starts_with("rule_") => {
            "off: no such card (the owner may have muted it from one)".into()
        }
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
        ("brief_time", "hours") => {
            "a quarter of an hour before their usual start (when they first show up, until \
             codeg has learned it)"
                .into()
        }
        ("brief_time", "fixed") => "the fixed time below".into(),
        ("brief_suggestions", _) => match value.as_u64() {
            Some(0) => "none".into(),
            Some(n) => format!("at most {n}"),
            None => value.to_string(),
        },
        ("wrap", "auto") => {
            "codeg brings it near the end of their usual day, and when they ask".into()
        }
        ("wrap", "ask") => "only when they ask (\"that's it for today\")".into(),
        ("reactions", "on") => {
            "on: codeg counts how they answer each kind of card; a kind they dismissed three \
             times in a row is lowered one level, and the weekly review says so"
                .into()
        }
        ("reactions", "off") => "off: nothing is lowered, and what codeg lowered is back".into(),
        ("weekly_review", "brief") => {
            "in the first morning brief of each week, about the week before".into()
        }
        ("weekly_review", "wrap") => "in Friday's wrap-up, about the week so far".into(),
        ("projects", "all") => {
            "every project open in codeg, new ones too (they can pick some on the settings' \
             Your projects page)"
                .into()
        }
        ("projects", _) => match value.as_array() {
            Some(ids) if ids.is_empty() => "none".into(),
            Some(ids) => format!(
                "only these, by project_list's ids: {}",
                ids.iter()
                    .map(|i| format!("#{i}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            None => value.to_string(),
        },
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

/// codeg's proposal rules (6.7), in one line: the ones on with their
/// thresholds, the ones off, and the assistants' own suggestions.
fn rules_line(prefs: &Prefs) -> String {
    let after = |rule: &str| match rule {
        "failed" => format!("{} h", prefs.rule_failed_hours),
        "review" => format!("{} h", prefs.rule_review_hours),
        "session" => format!("{} min", prefs.rule_session_minutes),
        "pr_review" => format!("{} d", prefs.rule_pr_review_days),
        "uncommitted" => format!("{} h", prefs.rule_uncommitted_hours),
        "idle" => format!("{} d", prefs.rule_idle_days),
        "repeat" => format!("the {}th alike request", prefs.repeat_count()),
        _ => String::new(),
    };
    let rules = [
        "failed",
        "review",
        "session",
        "pr_review",
        "uncommitted",
        "idle",
        "behind",
        "repeat",
        "undo",
        "idle_bot",
    ];
    let on: Vec<String> = rules
        .iter()
        .filter(|r| prefs.rule_on(r))
        .map(|r| match after(r) {
            a if a.is_empty() => r.to_string(),
            a => format!("{r} ({a})"),
        })
        .collect();
    let off: Vec<&str> = rules.iter().copied().filter(|r| !prefs.rule_on(r)).collect();
    format!(
        "- codeg's proposal cards (it raises them itself; nothing for you to do): on — {}; off \
         — {}. Your own suggestions (`suggest: true`): {}",
        if on.is_empty() { "none".into() } else { on.join(", ") },
        if off.is_empty() { "none".into() } else { off.join(", ") },
        if prefs.rule_on("suggest") {
            "the owner takes them"
        } else {
            "the owner does not take them now — do not suggest"
        }
    )
}

/// The morning brief's and the wrap-up's items (6.4, 6.5).
fn is_brief_item(key: &str) -> bool {
    key.starts_with("brief")
        || key.starts_with("wrap")
        || key == "keep_awake"
        || key == "weekly_review"
}

/// What the desktop shows of the assistants outside codeg's windows (10.10).
fn is_desktop_item(key: &str) -> bool {
    matches!(key, "menubar" | "dock_badge")
}

/// The menu bar and the dock badge, in one line.
fn desktop_line(prefs: &Prefs) -> String {
    let on = |v: OnOff| if v == OnOff::On { "on" } else { "off" };
    format!(
        "- on the desktop, outside codeg's windows (codeg draws them): the menu bar icon with the \
         busy assistant's face, the count of assistants with unread and the recent ones: {}; the \
         dock badge counting the assistants with unread: {}",
        on(prefs.menubar),
        on(prefs.dock_badge),
    )
}

/// The morning brief and the wrap-up, in one line: codeg brings them; the
/// primary writes them.
fn brief_line(prefs: &Prefs, worker: bool) -> String {
    let brief = if prefs.brief == OnOff::Off {
        "off".to_string()
    } else {
        let when = match prefs.brief_time {
            BriefTime::Hours => {
                "prepared a quarter of an hour before their usual start".to_string()
            }
            BriefTime::Fixed => format!("prepared at {}", prefs.brief_at),
        };
        let parts: Vec<&str> = [
            (prefs.brief_needs, "what waits on them"),
            (prefs.brief_night, "what happened since the last one"),
            (prefs.brief_bots, "each work assistant"),
            (prefs.brief_schedule, "the day's schedule"),
            (prefs.brief_loose, "loose ends"),
            (prefs.brief_yesterday, "their yesterday"),
        ]
        .iter()
        .filter(|(on, _)| *on == OnOff::On)
        .map(|(_, w)| *w)
        .collect();
        format!(
            "on, {when}, brought to them when they show up; parts: {}; suggestions: {}",
            if parts.is_empty() {
                "none".into()
            } else {
                parts.join(", ")
            },
            match prefs.brief_suggestions {
                0 => "none".to_string(),
                n => format!("at most {n}"),
            }
        )
    };
    let wrap = match prefs.wrap {
        WrapMode::Auto => "codeg brings it near the end of their usual day, and when they ask",
        WrapMode::Ask => "only when they ask",
        WrapMode::Off => "codeg does not bring it; when they ask, it is still done",
    };
    let writer = if worker {
        "the primary assistant writes them"
    } else {
        "you write them when codeg hands you the materials; \"that's it for today\" is wrap_up"
    };
    let weekly = match prefs.weekly_review {
        WeeklyReview::Brief => "in the first morning brief of each week, about the week before",
        WeeklyReview::Wrap => "in Friday's wrap-up, about the week so far",
        WeeklyReview::Off => "off",
    };
    format!(
        "- the morning brief ({writer}): {brief}. The wrap-up: {wrap}; \"tonight I can do\": {}; \
         the computer kept awake for tonight's work: {}; the weekly review: {weekly}",
        if prefs.wrap_tonight == OnOff::On {
            "on"
        } else {
            "off"
        },
        if prefs.keep_awake == OnOff::On {
            "on (desktop)"
        } else {
            "off"
        },
    )
}

/// The preferences as the brain reads them: `<codeg-prefs>`. A worker is
/// not told how the primary hands work to workers.
pub fn prefs_block(prefs: &Prefs, worker: bool) -> String {
    let map = prefs.to_map();
    let mut lines: Vec<String> = PREFS
        .iter()
        .filter(|s| !s.key.starts_with("level_") && !s.key.starts_with("rule_"))
        .filter(|s| !is_brief_item(s.key) && !is_desktop_item(s.key))
        .map(|s| {
            let v = map.get(s.key).cloned().unwrap_or(Value::Null);
            format!("- {}: {}", s.label, brain_value(s.key, &v))
        })
        .collect();
    lines.push(levels_line(&map));
    lines.push(rules_line(prefs));
    lines.push(brief_line(prefs, worker));
    lines.push(desktop_line(prefs));
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
pub fn prefs_changes(old: &Prefs, new: &Prefs) -> Vec<String> {
    let (a, b) = (old.to_map(), new.to_map());
    PREFS
        .iter()
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

/// The account's preferences, as the page reads them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccountView {
    pub prefs: Prefs,
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
            automation_level,
            disturb_level,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What the assistants read of the preferences names no executor
    /// config and no tool that is gone (R10), whichever way they are set.
    #[test]
    fn the_prefs_block_names_no_executor_config() {
        for chat_changes in [ChatChanges::Apply, ChatChanges::Show] {
            for auto_accept in [OnOff::On, OnOff::Off] {
                let prefs = Prefs {
                    chat_changes,
                    auto_accept,
                    ..Prefs::default()
                };
                for worker in [false, true] {
                    let block = prefs_block(&prefs, worker);
                    for gone in ["executor", "assistant_update", "division"] {
                        assert!(!block.contains(gone), "{gone:?} in {block}");
                    }
                }
            }
        }
    }

    /// The brain changes a preference by its key, as `prefs_update` names
    /// them: one it does not name, it does not know it can change.
    #[test]
    fn prefs_update_names_every_preference() {
        let tools: Value =
            serde_json::from_str(include_str!("../acp/delegation/tool_schema.json")).unwrap();
        let text = tools
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["name"] == "prefs_update")
            .and_then(|t| t["description"].as_str())
            .unwrap()
            .to_string();
        let named = |key: &str| {
            text.match_indices(key).any(|(at, _)| {
                let word =
                    |c: Option<char>| c.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
                !word(text[..at].chars().next_back())
                    && !word(text[at + key.len()..].chars().next())
            })
        };
        let missing: Vec<&str> = PREFS
            .iter()
            .map(|s| s.key)
            .chain([AUTOMATION_KEY, DISTURB_KEY])
            .filter(|k| !named(k))
            .collect();
        assert!(missing.is_empty(), "not named by prefs_update: {missing:?}");
    }

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
    fn the_projects_are_all_or_a_list_and_changes_read_against_what_is_there() {
        assert_eq!(check_pref("projects", &json!("all")).unwrap(), json!("all"));
        assert_eq!(check_pref("projects", &json!(" only ")).unwrap(), json!("only"));
        assert_eq!(
            check_pref("projects", &json!([3, "1", 3, "#2"])).unwrap(),
            json!([1, 2, 3]),
            "deduplicated, in order, digits taken"
        );
        assert_eq!(check_pref("projects", &json!([])).unwrap(), json!([]));
        assert_eq!(check_pref("projects", &json!({ "add": "4" })).unwrap(), json!({ "add": 4 }));
        assert_eq!(check_pref("projects", &json!({ "remove": 4 })).unwrap(), json!({ "remove": 4 }));
        for bad in [
            json!([-1]),
            json!([0]),
            json!(["x"]),
            json!({ "add": 1, "remove": 2 }),
            json!({ "swap": { "expect": "all", "to": [] } }),
            json!({ "id": 1 }),
            json!("some"),
            json!(3),
            json!((1..=PROJECTS_MAX as i32 + 1).collect::<Vec<_>>()),
        ] {
            let e = check_pref("projects", &bad).unwrap_err();
            assert!(e.contains("projects"), "{bad}: {e}");
        }

        let all = ProjectScope::All;
        let list = ProjectScope::Only(vec![1, 3]);
        let eligible = [5, 2, 7];
        assert_eq!(ProjectsOp::Only.apply(&all, &eligible), ProjectScope::Only(vec![2, 5, 7]));
        assert_eq!(ProjectsOp::Only.apply(&list, &eligible), list, "a list stays");
        assert_eq!(ProjectsOp::Add(9).apply(&all, &eligible), all, "watched already");
        assert_eq!(ProjectsOp::Remove(2).apply(&all, &eligible), all);
        assert_eq!(ProjectsOp::Add(2).apply(&list, &eligible), ProjectScope::Only(vec![1, 2, 3]));
        assert_eq!(ProjectsOp::Add(3).apply(&list, &eligible), list);
        assert_eq!(ProjectsOp::Remove(1).apply(&list, &eligible), ProjectScope::Only(vec![3]));
        assert_eq!(ProjectsOp::All.apply(&list, &eligible), all);
        assert_eq!(ProjectsOp::Set(vec![8]).apply(&all, &eligible), ProjectScope::Only(vec![8]));
        let undo = ProjectsOp::Swap { expect: list.clone(), to: all.clone() };
        assert_eq!(undo.apply(&list, &eligible), all);
        let moved = ProjectScope::Only(vec![1]);
        assert_eq!(undo.apply(&moved, &eligible), moved, "changed since: it stays");
        assert_eq!(ProjectsOp::from_card(&undo.to_json()).unwrap(), undo);

        // Read leniently: what is neither form is "all", the rest untouched.
        let p = Prefs::parse(Some(&json!({ "projects": { "x": 1 }, "reply_length": "short" })));
        assert_eq!(p.projects, ProjectScope::All);
        assert_eq!(p.reply_length, ReplyLength::Short);
        let long: Vec<i32> = (1..=PROJECTS_MAX as i32 + 1).collect();
        assert_eq!(
            Prefs::parse(Some(&json!({ "projects": long }))).projects,
            ProjectScope::Only(long.clone()),
            "a list stays a list"
        );
        let full = ProjectScope::Only((1..=PROJECTS_MAX as i32).collect());
        assert!(ProjectsOp::Add(9_999).apply(&full, &[]).checked().is_err());
        assert!(ProjectsOp::Only.apply(&all, &long).checked().is_err());
        assert!(ProjectsOp::Add(1).apply(&full, &[]).checked().is_ok());
        let p = Prefs::parse(Some(&json!({ "projects": [4, 2] })));
        assert_eq!(p.projects, ProjectScope::Only(vec![2, 4]));
        assert_eq!(p.get("projects"), json!([2, 4]));
        assert_eq!(Prefs::default().get("projects"), json!("all"));
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
            ..Prefs::default()
        };
        let lines = prefs_changes(&old, &new);
        assert_eq!(lines.len(), 1);
        assert!(lines[0].starts_with("replies → short"));
        let block = prefs_block(&new, true);
        assert!(block.contains("<codeg-prefs>") && block.contains("replies: short"));
    }

}
