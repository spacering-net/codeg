//! Routines (6.9): each assistant's own work on a schedule or on a coding
//! event.
//!
//! **Two kinds.** A `brain` routine wakes its assistant with what it is to
//! do (a `routine` event, the batch's trigger `routine`); one that finds
//! nothing worth saying replies `[[silent]]` alone, and codeg shows nothing
//! and records "no change". A `dispatch` routine hands out the work its
//! template says — on the agent its assistant's work runs on — without
//! waking anyone; what comes back is read as any dispatch's news.
//! "Routine dispatches: ask me first" turns that into a confirm card.
//!
//! **When.** On a 5-field cron in the owner's zone (or one of its own), or
//! on a coding event (6.9 / 2.3) of a kind and a filter — once per event; a
//! forge's new issue or pull request is read every five minutes. Work a
//! routine handed out (itself, or in the turn it woke its assistant for)
//! does not set the same routine off again. A time missed by more than half
//! the gap to the next (at most two hours) — codeg was not running, the
//! machine slept — is recorded as missed and not made up for.
//!
//! **A look first.** A scheduled or event run can look before it wakes
//! anyone, with no model: new commits on a branch, a new issue or pull
//! request, matters waiting longer than so many hours, a working tree that
//! changed. Nothing new: the run is "skipped". One that cannot be read runs
//! anyway, and says why. A run the owner asked for, and the trial run every
//! new routine gets, do not look — they only note what is there now.
//!
//! **Settling.** Three failed runs in a row, or the agent its assistant's
//! work runs on turned off: the routine is paused, with an urgent card
//! (`work_agent`).
//!
//! The rhythm is codeg's alone: a run's prompt says which run it is and that
//! codeg keeps the schedule.

use std::collections::HashSet;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use chrono::{DateTime, Datelike, Duration, Timelike, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::clock;
use super::read_check::OrFailed;
use super::dispatch::{DispatchAuth, DispatchRequest};
use super::due;
use super::engine::{enum_str, PersonalAgentEngine};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_item::{ItemStatus, WaitsFor};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_routine::{
    self as routine_entity, RoutineKind, RoutineTrigger,
};
use crate::db::entities::personal_agent_routine_run::{self as run_entity, RunOutcome};
use crate::db::entities::personal_agent_signal as signal_entity;
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::automation_service::compute_next_run;
use crate::db::service::personal_agent_routine_service::{
    self as rsvc, NewRoutine, NewRun, RoutineWrite, RunWrite,
};
use crate::db::service::personal_agent_service::{
    self as svc, LedgerSlot, Ledgered, NewNotice, NewRow,
};
use crate::db::service::personal_agent_watch_service as wsvc;
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};

/// The event kind that wakes an assistant for a routine.
pub const ROUTINE_EVENT: &str = "routine";
/// A routine's whole reply when it found nothing worth saying.
pub const SILENT: &str = "[[silent]]";
/// `timezone` that follows the owner's zone.
pub const OWNER_ZONE: &str = "owner";
/// The most a scheduled time may be late and still run.
pub const MAX_LATE_SECS: i64 = 2 * 3600;
/// Failed runs in a row that pause a routine.
pub const FAILURES_TO_PAUSE: i32 = 3;
/// How often a forge's newest issues or pull requests are read.
pub const FORGE_POLL_SECS: i64 = 300;
/// How often the agents the routines' work runs on are looked at.
const WORK_AGENT_CHECK_SECS: i64 = 60;
/// Coding events read in one look.
const SIGNAL_BATCH: u64 = 200;
pub const MAX_TITLE_CHARS: usize = 120;
pub const MAX_WHAT_CHARS: usize = 4_000;
/// What makes a request one the owner keeps making (6.7): the requests of
/// the last month, alike by this much (Jaccard over character trigrams).
pub const REPEAT_DAYS: i64 = 30;
pub const REPEAT_ALIKE: f64 = 0.5;
/// Shorter messages are not requests to repeat ("ok", "go on").
pub const REPEAT_MIN_CHARS: usize = 8;
/// The forge-polled event kind.
pub const FORGE_EVENT: &str = "forge_issue";
/// The coding events a routine can be set off by.
pub const EVENT_KINDS: &[&str] = &[
    "dispatch_ended",
    "task_status",
    "session_waiting",
    "pr_checks_failed",
    "pr_checks_passed",
    "pr_conflict",
    "pr_mergeable",
    "pr_no_conflict",
    "pr_merged",
    "pr_closed",
    "pr_review",
    FORGE_EVENT,
];

// ── what a routine is ───────────────────────────────────────────────────────

/// Which coding events set an event routine off.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct EventFilter {
    /// Only in this project.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i32>,
    /// Only these states: a dispatch's (`completed`, `failed`, …) or a
    /// board task's (`done`, `failed`, …).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub states: Vec<String>,
    /// Only this assistant's own work.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub mine: bool,
    /// `forge_issue`: only with this label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `forge_issue`: `issue` (the default) or `pr`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub what: Option<String>,
}

/// An event trigger as written: its kind and filter.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct EventSpec {
    pub kind: String,
    #[serde(flatten)]
    pub filter: EventFilter,
}

/// The work a dispatch routine hands out.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DispatchTemplate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<DispatchMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<i32>,
    /// Its title; none: the routine's.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Its prompt; none: the routine's `what`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// `change` (the default) or `report`, for a task.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deliverable: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub done_when: Option<String>,
}

/// What a run looks at before it wakes anyone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Precheck {
    /// Nothing: it always runs.
    None,
    /// New commits on a branch of a project (`HEAD` without one).
    Commits {
        project_id: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        branch: Option<String>,
    },
    /// A new issue (or pull request) on the project's forge, with a label
    /// when one is named.
    ForgeNew {
        project_id: i32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        what: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
    },
    /// Matters that have waited longer than this.
    ItemsWaiting { hours: u32 },
    /// The project's working tree changed.
    Changes { project_id: i32 },
}

/// A routine as a tool call or the editor writes it; what it leaves out
/// stays as it is (or takes its default, for a new one).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Draft {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub what: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<RoutineKind>,
    /// A 5-field cron (`min hour dom mon dow`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    /// `owner`, or an IANA zone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<EventSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<DispatchTemplate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub precheck: Option<Precheck>,
}

/// A routine checked and whole.
#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub title: String,
    pub what: String,
    pub kind: RoutineKind,
    pub trigger: RoutineTrigger,
    pub cron: Option<String>,
    pub timezone: Option<String>,
    pub event: Option<EventSpec>,
    pub dispatch: Option<DispatchTemplate>,
    pub precheck: Option<Precheck>,
}

fn cut(s: &str, max: usize) -> String {
    s.trim().chars().take(max).collect()
}

fn json_of<T: Serialize>(v: &T) -> Option<String> {
    serde_json::to_string(v).ok()
}

/// A stored routine as a draft: every field it has.
pub fn draft_of(r: &routine_entity::Model) -> Draft {
    Draft {
        title: Some(r.title.clone()),
        what: Some(r.what.clone()),
        kind: Some(r.kind),
        cron: r.cron.clone(),
        timezone: r.timezone.clone(),
        event: r.event_kind.as_ref().map(|k| EventSpec {
            kind: k.clone(),
            filter: filter_of(r),
        }),
        dispatch: template_of(r),
        precheck: precheck_of(r),
    }
}

pub fn filter_of(r: &routine_entity::Model) -> EventFilter {
    r.event_filter
        .as_deref()
        .and_then(|f| serde_json::from_str(f).ok())
        .unwrap_or_default()
}

pub fn template_of(r: &routine_entity::Model) -> Option<DispatchTemplate> {
    r.dispatch
        .as_deref()
        .and_then(|d| serde_json::from_str(d).ok())
}

pub fn precheck_of(r: &routine_entity::Model) -> Option<Precheck> {
    r.precheck
        .as_deref()
        .and_then(|p| serde_json::from_str::<Precheck>(p).ok())
        .filter(|p| *p != Precheck::None)
}

/// A draft over what a routine was (`base`; none for a new one), checked as
/// data: the fields it needs are there and in bounds, it has one trigger,
/// a dispatch routine has its work. Projects and the cron are checked
/// against codeg by the engine.
pub fn spec_of(draft: &Draft, base: Option<&Draft>) -> Result<Spec, String> {
    let empty = Draft::default();
    let base = base.unwrap_or(&empty);
    let pick = |a: &Option<String>, b: &Option<String>| {
        a.as_deref()
            .or(b.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let title = pick(&draft.title, &base.title).ok_or("`title` is required")?;
    let title = cut(&title, MAX_TITLE_CHARS);
    let kind = draft.kind.or(base.kind).unwrap_or(RoutineKind::Brain);
    // A new cron replaces an event, and the other way round.
    let (cron, event) = match (&draft.cron, &draft.event) {
        (Some(_), Some(_)) => {
            return Err(
                "a routine runs on a schedule (`cron`) or on an event (`event`), not both".into(),
            )
        }
        (Some(c), None) => (Some(c.trim().to_string()), None),
        (None, Some(e)) => (None, Some(e.clone())),
        (None, None) => (base.cron.clone(), base.event.clone()),
    };
    let cron = cron.filter(|c| !c.is_empty());
    let trigger = match (&cron, &event) {
        (Some(_), _) => RoutineTrigger::Schedule,
        (None, Some(_)) => RoutineTrigger::Event,
        (None, None) => {
            return Err(
                "a routine needs `cron` (a 5-field schedule) or `event` (a coding event)".into(),
            )
        }
    };
    if let Some(e) = &event {
        if !EVENT_KINDS.contains(&e.kind.as_str()) {
            return Err(format!(
                "`event.kind` must be one of {}",
                EVENT_KINDS.join(", ")
            ));
        }
        if e.kind == FORGE_EVENT && e.filter.project_id.is_none() {
            return Err("a forge_issue event needs `event.project_id`: whose forge to read".into());
        }
        if let Some(w) = e.filter.what.as_deref() {
            if !matches!(w, "issue" | "pr") {
                return Err("`event.what` must be issue or pr".into());
            }
        }
    }
    let timezone = pick(&draft.timezone, &base.timezone).filter(|z| z != OWNER_ZONE);
    if let Some(z) = &timezone {
        if z.parse::<Tz>().is_err() {
            return Err(format!("`timezone` {z} is not an IANA zone (or `owner`)"));
        }
    }
    // A template given is laid over the one it had, field by field: what
    // it leaves out (its own title, prompt, criteria) stays.
    let dispatch = match (&draft.dispatch, kind) {
        (_, RoutineKind::Brain) => None,
        (Some(d), RoutineKind::Dispatch) => Some(match &base.dispatch {
            Some(b) => DispatchTemplate {
                mode: d.mode.or(b.mode),
                project_id: d.project_id.or(b.project_id),
                title: d.title.clone().or_else(|| b.title.clone()),
                prompt: d.prompt.clone().or_else(|| b.prompt.clone()),
                deliverable: d.deliverable.clone().or_else(|| b.deliverable.clone()),
                done_when: d.done_when.clone().or_else(|| b.done_when.clone()),
            },
            None => d.clone(),
        }),
        (None, RoutineKind::Dispatch) => base.dispatch.clone(),
    };
    let what = pick(&draft.what, &base.what)
        .or_else(|| dispatch.as_ref().and_then(|d| d.prompt.clone()))
        .ok_or("`what` is required: what the routine is to do")?;
    if what.chars().count() > MAX_WHAT_CHARS {
        return Err(format!("`what` is longer than {MAX_WHAT_CHARS} characters"));
    }
    if kind == RoutineKind::Dispatch {
        let d = dispatch
            .as_ref()
            .ok_or("a dispatch routine needs `dispatch`: the work it hands out")?;
        let mode = d
            .mode
            .ok_or("`dispatch.mode` must be task, chat or session")?;
        if mode != DispatchMode::Chat && d.project_id.is_none() {
            return Err(format!(
                "a {} dispatch needs `dispatch.project_id`",
                enum_str(&mode)
            ));
        }
        if let Some(x) = d.deliverable.as_deref() {
            if !matches!(x, "change" | "report") {
                return Err("`dispatch.deliverable` must be change or report".into());
            }
        }
    }
    let precheck = match &draft.precheck {
        Some(Precheck::None) => None,
        Some(p) => Some(p.clone()),
        None => base.precheck.clone().filter(|p| *p != Precheck::None),
    };
    if let Some(Precheck::ItemsWaiting { hours }) = &precheck {
        if *hours == 0 {
            return Err("`precheck.hours` must be at least 1".into());
        }
    }
    Ok(Spec {
        title,
        what: what.chars().take(MAX_WHAT_CHARS).collect(),
        kind,
        trigger,
        cron,
        timezone,
        event,
        dispatch,
        precheck,
    })
}

impl Spec {
    pub fn draft(&self) -> Draft {
        Draft {
            title: Some(self.title.clone()),
            what: Some(self.what.clone()),
            kind: Some(self.kind),
            cron: self.cron.clone(),
            timezone: self.timezone.clone(),
            event: self.event.clone(),
            dispatch: self.dispatch.clone(),
            precheck: self.precheck.clone(),
        }
    }
}

// ── time ────────────────────────────────────────────────────────────────────

/// The zone a routine runs in: its own, or the owner's.
pub fn zone_of(routine_tz: Option<&str>, owner: Tz) -> Tz {
    match routine_tz
        .map(str::trim)
        .filter(|z| !z.is_empty() && *z != OWNER_ZONE)
    {
        Some(z) => z.parse::<Tz>().unwrap_or(owner),
        None => owner,
    }
}

/// The schedule's next time after `after`.
pub fn next_run(cron: &str, tz: Tz, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    compute_next_run(cron, tz.name(), after).ok().flatten()
}

/// How late a scheduled time may be and still run: half the gap to the
/// next, at most [`MAX_LATE_SECS`].
pub fn grace(cron: &str, tz: Tz, at: DateTime<Utc>) -> Duration {
    let cap = Duration::seconds(MAX_LATE_SECS);
    match next_run(cron, tz, at) {
        Some(n) => ((n - at) / 2).min(cap),
        None => cap,
    }
}

/// What a scheduled routine due at `due` does when it is looked at `now`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DueNow {
    /// Run for its time `at`; `missed` earlier times went by unrun.
    Run {
        at: DateTime<Utc>,
        missed: u32,
        next: Option<DateTime<Utc>>,
    },
    /// Every time up to now went by too long ago: `times` of them, the
    /// latest `at`.
    Missed {
        at: DateTime<Utc>,
        times: u32,
        next: Option<DateTime<Utc>>,
    },
}

pub fn due_now(cron: &str, tz: Tz, due: DateTime<Utc>, now: DateTime<Utc>) -> DueNow {
    let mut last = due;
    let mut before = 0u32;
    for _ in 0..10_000 {
        match next_run(cron, tz, last) {
            Some(n) if n <= now => {
                before += 1;
                last = n;
            }
            _ => break,
        }
    }
    let next = next_run(cron, tz, now);
    if now - last <= grace(cron, tz, last) {
        DueNow::Run {
            at: last,
            missed: before,
            next,
        }
    } else {
        DueNow::Missed {
            at: last,
            times: before + 1,
            next,
        }
    }
}

/// "Every week, at this time": the cron for a weekly routine at `at` in
/// `tz` (the editor's suggestion on a result card).
pub fn weekly_at(tz: Tz, at: DateTime<Utc>) -> String {
    let local = at.with_timezone(&tz);
    format!(
        "{} {} * * {}",
        local.minute(),
        local.hour(),
        local.weekday().num_days_from_sunday()
    )
}

// ── events ──────────────────────────────────────────────────────────────────

/// Whether a coding event sets this routine off. `owned`: the work it is
/// about is the routine's assistant's own.
pub fn signal_matches(spec: &EventSpec, owned: bool, s: &signal_entity::Model) -> bool {
    if s.kind != spec.kind {
        return false;
    }
    let f = &spec.filter;
    if let Some(p) = f.project_id {
        if s.folder_id != Some(p) {
            return false;
        }
    }
    if f.mine && !owned {
        return false;
    }
    if !f.states.is_empty() {
        let facts: Value = serde_json::from_str(&s.facts).unwrap_or(Value::Null);
        let state = match s.kind.as_str() {
            "dispatch_ended" => facts["state"].as_str(),
            "task_status" => facts["status"].as_str(),
            _ => None,
        };
        if let Some(st) = state {
            if !f.states.iter().any(|w| w.eq_ignore_ascii_case(st)) {
                return false;
            }
        }
    }
    true
}

/// A coding event in a line, for the run's prompt and record.
pub fn event_words(s: &signal_entity::Model) -> String {
    let f: Value = serde_json::from_str(&s.facts).unwrap_or(Value::Null);
    let title = f["title"].as_str().unwrap_or("");
    match s.kind.as_str() {
        "dispatch_ended" => format!(
            "dispatch #{} \"{title}\" ended: {}",
            f["dispatch_id"],
            f["state"].as_str().unwrap_or("?")
        ),
        "task_status" => format!(
            "board task #{} \"{title}\" is now {}",
            f["task_id"],
            f["status"].as_str().unwrap_or("?")
        ),
        "session_waiting" => format!(
            "a session (conversation #{}) waits for the owner: {}",
            f["conversation_id"],
            f["what"].as_str().unwrap_or("an answer")
        ),
        k if k.starts_with("pr_") => {
            let what = match k {
                "pr_checks_failed" => {
                    let failing: Vec<&str> = f["failing"]
                        .as_array()
                        .map(|a| a.iter().filter_map(Value::as_str).collect())
                        .unwrap_or_default();
                    if failing.is_empty() {
                        "its checks failed".to_string()
                    } else {
                        format!("its checks failed ({})", failing.join(", "))
                    }
                }
                "pr_checks_passed" => "its checks are green again".into(),
                "pr_conflict" => "it has a conflict".into(),
                "pr_mergeable" => "it can be merged".into(),
                "pr_no_conflict" => "it has no conflict (checks unknown)".into(),
                "pr_merged" => "it was merged".into(),
                "pr_closed" => "it was closed without merging".into(),
                "pr_review" => format!(
                    "it has a new review ({} item(s): {} approval(s), {} for its task)",
                    f["items"].as_u64().unwrap_or(0),
                    f["approvals"].as_u64().unwrap_or(0),
                    f["for_the_task"].as_u64().unwrap_or(0)
                ),
                _ => k.to_string(),
            };
            format!(
                "pull request {} {}: {what}",
                f["target"].as_str().unwrap_or(""),
                f["url"].as_str().unwrap_or("")
            )
        }
        k => format!("{k}: {}", s.facts),
    }
}

/// A forge event's key: one run per item. The project is part of it — a
/// routine moved to another project reads that one's numbers afresh.
pub fn forge_event_key(pr: bool, project: i32, number: i64) -> String {
    format!("{}:{project}:{number}", if pr { "pr" } else { "issue" })
}

/// The dispatch a coding event names (a session's is found by its
/// conversation or connection: [`PersonalAgentEngine::dispatch_of_signal`]).
fn named_dispatch(s: &signal_entity::Model) -> Option<i32> {
    let f: Value = serde_json::from_str(&s.facts).ok()?;
    f["dispatch_id"]
        .as_i64()
        .and_then(|d| i32::try_from(d).ok())
}

// ── alike requests (6.7) ────────────────────────────────────────────────────

fn grams(s: &str) -> HashSet<String> {
    let norm: Vec<char> = s
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .collect();
    if norm.len() < 3 {
        return std::iter::once(norm.iter().collect()).collect();
    }
    norm.windows(3).map(|w| w.iter().collect()).collect()
}

/// How alike two requests are: Jaccard over their character trigrams.
pub fn alike(a: &str, b: &str) -> f64 {
    let (x, y) = (grams(a), grams(b));
    let union = x.union(&y).count();
    if union == 0 {
        return 0.0;
    }
    x.intersection(&y).count() as f64 / union as f64
}

/// Whether a reply says only that there was nothing to say.
pub fn is_silent(text: &str) -> bool {
    let t: String = text.split_whitespace().collect();
    t == SILENT || t == format!("{SILENT}.")
}

// ── views ───────────────────────────────────────────────────────────────────

/// One run, as the page and the tools show it.
#[derive(Debug, Clone, Serialize)]
pub struct RunView {
    pub id: i32,
    pub routine_id: i32,
    pub seq: i32,
    pub trigger: String,
    pub due_at: Option<DateTime<Utc>>,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub outcome: RunOutcome,
    pub note: Option<String>,
    pub dispatch_id: Option<i32>,
    pub notice_id: Option<i32>,
    /// Its assistant's reply, to scroll to.
    pub row_id: Option<i32>,
}

/// One routine, as the page and the tools show it.
#[derive(Debug, Clone, Serialize)]
pub struct RoutineView {
    pub id: i32,
    pub bot_id: i32,
    pub title: String,
    pub what: String,
    pub kind: RoutineKind,
    pub trigger: RoutineTrigger,
    pub cron: Option<String>,
    /// As set: `None` follows the owner's zone.
    pub timezone: Option<String>,
    /// The zone it runs in now.
    pub zone: String,
    pub event: Option<EventSpec>,
    pub dispatch: Option<DispatchTemplate>,
    pub precheck: Option<Precheck>,
    pub enabled: bool,
    pub paused_reason: Option<String>,
    pub source: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub runs: i32,
    pub failures: i32,
    pub created_at: DateTime<Utc>,
    /// Its latest runs, newest first.
    pub last: Vec<RunView>,
}

pub async fn run_view(conn: &sea_orm::DatabaseConnection, r: run_entity::Model) -> RunView {
    let row_id = match r.batch_id {
        Some(b) => svc::reply_row_of_batch(conn, b)
            .await
            .or_failed()
            .map(|row| row.id),
        None => None,
    };
    RunView {
        id: r.id,
        routine_id: r.routine_id,
        seq: r.seq,
        trigger: r.trigger,
        due_at: r.due_at,
        started_at: r.started_at,
        ended_at: r.ended_at,
        outcome: r.outcome,
        note: r.note,
        dispatch_id: r.dispatch_id,
        notice_id: r.notice_id,
        row_id,
    }
}

pub async fn routine_view(
    conn: &sea_orm::DatabaseConnection,
    r: routine_entity::Model,
    owner: Tz,
    runs: u64,
) -> RoutineView {
    let mut last = Vec::new();
    for run in rsvc::runs_of(conn, r.id, runs).await.or_failed() {
        last.push(run_view(conn, run).await);
    }
    let zone = zone_of(r.timezone.as_deref(), owner).name().to_string();
    let draft = draft_of(&r);
    RoutineView {
        id: r.id,
        bot_id: r.bot_id,
        title: r.title,
        what: r.what,
        kind: r.kind,
        trigger: r.trigger,
        cron: r.cron,
        timezone: r.timezone,
        zone,
        event: draft.event,
        dispatch: draft.dispatch,
        precheck: draft.precheck,
        enabled: r.enabled,
        paused_reason: r.paused_reason,
        source: r.source,
        next_run_at: r.next_run_at,
        last_run_at: r.last_run_at,
        runs: r.runs,
        failures: r.failures,
        created_at: r.created_at,
        last,
    }
}

/// What a card shows of a routine.
fn summary_of(spec: &Spec, id: Option<i32>, next: Option<DateTime<Utc>>, zone: &str) -> Value {
    json!({
        "id": id,
        "title": spec.title,
        "what": spec.what,
        "kind": spec.kind,
        "trigger": spec.trigger,
        "cron": spec.cron,
        "timezone": spec.timezone,
        "zone": zone,
        "event": spec.event,
        "dispatch": spec.dispatch,
        "precheck": spec.precheck,
        "next_run_at": next,
    })
}

/// What a routine is, for a tool's answer.
fn line_of(v: &RoutineView, tz: Tz, now: DateTime<Utc>) -> String {
    let when = match (&v.cron, &v.event) {
        (Some(c), _) => format!("schedule `{c}` ({})", v.zone),
        (None, Some(e)) => format!("on {}", e.kind),
        _ => "—".into(),
    };
    let state = if v.enabled {
        match v.next_run_at {
            Some(n) if v.trigger == RoutineTrigger::Schedule => {
                format!("next {}", due::describe(n, tz, now))
            }
            _ => "on".into(),
        }
    } else {
        format!("paused ({})", v.paused_reason.as_deref().unwrap_or("owner"))
    };
    let last = v
        .last
        .first()
        .map(|r| format!("; last run: {}", enum_str(&r.outcome)))
        .unwrap_or_default();
    format!(
        "#{} \"{}\" — {} routine, {when}, {state}, {} run(s){last}",
        v.id,
        v.title,
        enum_str(&v.kind),
        v.runs
    )
}

/// How a routine is made.
#[derive(Debug, Clone)]
pub enum MakeAuth {
    /// A delivery's tool call: once per batch and title, across what it
    /// re-delivers.
    Ledgered { batch_id: i32, scope: Vec<i32> },
    /// The owner said so on card `notice_id`.
    Card { notice_id: i32 },
    /// The page, a template.
    Direct,
}

/// What a precheck found.
#[derive(Debug, Clone)]
enum Look {
    /// Something new: run.
    New { state: Value, words: String },
    /// Nothing new since the last run.
    Same { words: String },
    /// Could not be read: run, and say so.
    Unread { error: String },
}

impl PersonalAgentEngine {
    // ── the clock ───────────────────────────────────────────────────────────

    /// The clock's look at the routines, off the engine's own loop: a look
    /// first that reads a forge or a repository never holds up the owner's
    /// messages. One look at a time.
    pub(super) fn spawn_routine_tick(self: &Arc<Self>, now: DateTime<Utc>) {
        if self.routine_busy.swap(true, Ordering::SeqCst) {
            return;
        }
        struct Done(Arc<PersonalAgentEngine>);
        impl Drop for Done {
            fn drop(&mut self) {
                self.0.routine_busy.store(false, Ordering::SeqCst);
            }
        }
        let done = Done(self.clone());
        tokio::spawn(async move {
            done.0.routine_tick(now).await;
        });
    }

    /// Whether this assistant has a brain (D3): one converted on upgrade
    /// before there was a primary has none, and runs no routine.
    async fn has_a_brain(&self) -> Result<(), String> {
        match self.agent_row().await {
            Some(row) if super::engine::brain_of(&row).is_some() => Ok(()),
            Some(_) => Err(
                "this assistant has no brain yet: set the primary assistant up first".into(),
            ),
            None => Err("configure the personal agent first".into()),
        }
    }

    /// The clock's look at this assistant's routines (with its matters).
    pub(crate) async fn routine_tick(self: &Arc<Self>, now: DateTime<Utc>) {
        let bot = self.bot().await;
        if bot <= 0 || self.retired.load(Ordering::SeqCst) {
            return;
        }
        // None run for one with no brain yet (D3, §5).
        if self.has_a_brain().await.is_err() {
            return;
        }
        let owner = self.owner_tz().await;
        self.follow_owner_zone(bot, owner, now).await;
        for r in rsvc::due(&self.db.conn, bot, now).await.unwrap_or_default() {
            self.fire_scheduled(r, owner, now).await;
        }
        self.event_tick(bot, now).await;
        self.pending_trials(bot).await;
        let check = {
            let mut last = self
                .routine_check_at
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let due = last.is_none_or(|t| (now - t).num_seconds() >= WORK_AGENT_CHECK_SECS);
            if due {
                *last = Some(now);
            }
            due
        };
        if check {
            self.check_work_agents(bot).await;
        }
    }

    /// A routine in the owner's zone keeps its wall-clock time when their
    /// zone changes: its next time is worked out again in the new one.
    async fn follow_owner_zone(&self, bot: i32, owner: Tz, now: DateTime<Utc>) {
        for r in rsvc::enabled_of(&self.db.conn, bot)
            .await
            .unwrap_or_default()
        {
            let (Some(cron), RoutineTrigger::Schedule) = (r.cron.as_deref(), r.trigger) else {
                continue;
            };
            if r.timezone.as_deref().is_some_and(|z| z != OWNER_ZONE) {
                continue;
            }
            if r.zone_used.as_deref() == Some(owner.name()) {
                continue;
            }
            let next = next_run(cron, owner, now);
            let _ = rsvc::update(
                &self.db.conn,
                r.id,
                Some(r.next_run_at),
                RoutineWrite {
                    next_run_at: Some(next),
                    zone_used: Some(Some(owner.name().to_string())),
                    ..Default::default()
                },
            )
            .await;
        }
    }

    /// A scheduled routine's time came: run it, or record it missed.
    async fn fire_scheduled(
        self: &Arc<Self>,
        r: routine_entity::Model,
        owner: Tz,
        now: DateTime<Utc>,
    ) {
        let (Some(cron), Some(due_at)) = (r.cron.clone(), r.next_run_at) else {
            return;
        };
        let tz = zone_of(r.timezone.as_deref(), owner);
        let zone = Some(tz.name().to_string());
        match due_now(&cron, tz, due_at, now) {
            DueNow::Missed { at, times, next } => {
                let note = format!(
                    "{times} time(s) went by while codeg was not running or the computer slept"
                );
                let made = rsvc::claim_due(
                    &self.db.conn,
                    r.id,
                    due_at,
                    next,
                    zone,
                    NewRun {
                        routine_id: r.id,
                        bot_id: r.bot_id,
                        trigger: "schedule".into(),
                        event_key: None,
                        due_at: Some(at),
                        outcome: RunOutcome::Missed,
                        note: Some(note),
                    },
                )
                .await;
                if let Ok(Some(_)) = made {
                    self.emit(PersonalAgentChange::Routine { id: r.id });
                }
            }
            DueNow::Run { at, missed, next } => {
                let run = rsvc::claim_due(
                    &self.db.conn,
                    r.id,
                    due_at,
                    next,
                    zone,
                    NewRun {
                        routine_id: r.id,
                        bot_id: r.bot_id,
                        trigger: "schedule".into(),
                        event_key: None,
                        due_at: Some(at),
                        outcome: RunOutcome::Running,
                        note: None,
                    },
                )
                .await;
                let Ok(Some(run)) = run else {
                    return;
                };
                if missed > 0 {
                    let _ = rsvc::insert_run(
                        &self.db.conn,
                        NewRun {
                            routine_id: r.id,
                            bot_id: r.bot_id,
                            trigger: "schedule".into(),
                            event_key: None,
                            due_at: Some(due_at),
                            outcome: RunOutcome::Missed,
                            note: Some(format!(
                                "{missed} earlier time(s) went by while codeg was not running or the computer slept"
                            )),
                        },
                    )
                    .await;
                }
                let late = (now - at).num_seconds();
                let when = due::describe(at, tz, now);
                let facts = if late >= due::LATE_AFTER_SECS {
                    format!(
                        "Its time was {when}; it runs {} late (codeg was not running, or the computer slept).",
                        due::span(Duration::seconds(late))
                    )
                } else {
                    format!("Its time: {when}.")
                };
                self.start_run(r, run, true, facts).await;
            }
        }
    }

    /// The coding events and forge reads that set this assistant's event
    /// routines off: each event once.
    async fn event_tick(self: &Arc<Self>, bot: i32, now: DateTime<Utc>) {
        let routines: Vec<_> = rsvc::enabled_of(&self.db.conn, bot)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.trigger == RoutineTrigger::Event)
            .collect();
        if routines.is_empty() {
            return;
        }
        let (forge, signals): (Vec<_>, Vec<_>) = routines
            .into_iter()
            .partition(|r| r.event_kind.as_deref() == Some(FORGE_EVENT));
        for r in forge {
            if r.next_run_at.is_none_or(|t| t <= now) {
                self.poll_forge_event(r, now).await;
            }
        }
        let Some(from) = signals.iter().map(|r| r.signal_cursor).min() else {
            return;
        };
        let events = wsvc::signals_after(&self.db.conn, from, SIGNAL_BATCH)
            .await
            .unwrap_or_default();
        let Some(read_to) = events.last().map(|s| s.id) else {
            return;
        };
        for r in signals {
            let Some(kind) = r.event_kind.clone() else {
                continue;
            };
            let spec = EventSpec {
                kind,
                filter: filter_of(&r),
            };
            for s in events.iter().filter(|s| s.id > r.signal_cursor) {
                if s.kind != spec.kind {
                    continue;
                }
                let d = self.dispatch_of_signal(s).await;
                let owned =
                    s.bot_id == Some(bot) || d.as_ref().is_some_and(|d| d.bot_id == Some(bot));
                if !signal_matches(&spec, owned, s) {
                    continue;
                }
                // Work this routine handed out does not set it off again.
                if let Some(d) = &d {
                    if rsvc::made_by_routine(&self.db.conn, r.id, d.id, d.origin_batch_id)
                        .await
                        .unwrap_or(false)
                    {
                        continue;
                    }
                }
                let words = event_words(s);
                let run = rsvc::insert_run(
                    &self.db.conn,
                    NewRun {
                        routine_id: r.id,
                        bot_id: r.bot_id,
                        trigger: "event".into(),
                        event_key: Some(format!("signal:{}", s.id)),
                        due_at: Some(s.created_at),
                        outcome: RunOutcome::Running,
                        note: Some(words.clone()),
                    },
                )
                .await;
                if let Ok(Some(run)) = run {
                    let _ = rsvc::update(
                        &self.db.conn,
                        r.id,
                        None,
                        RoutineWrite {
                            last_run_at: Some(Some(now)),
                            ..Default::default()
                        },
                    )
                    .await;
                    self.start_run(r.clone(), run, true, format!("The event: {words}."))
                        .await;
                }
            }
            let cursor = read_to.max(r.signal_cursor);
            if cursor != r.signal_cursor {
                let _ = rsvc::update(
                    &self.db.conn,
                    r.id,
                    None,
                    RoutineWrite {
                        signal_cursor: Some(cursor),
                        ..Default::default()
                    },
                )
                .await;
            }
        }
    }

    /// The dispatch a coding event is about: the one it names, or — a
    /// session waiting for the owner — the one that session is.
    async fn dispatch_of_signal(&self, s: &signal_entity::Model) -> Option<dispatch_entity::Model> {
        if let Some(id) = named_dispatch(s) {
            return svc::get_dispatch(&self.db.conn, id).await.ok().flatten();
        }
        if s.kind != "session_waiting" {
            return None;
        }
        let f: Value = serde_json::from_str(&s.facts).ok()?;
        if let Some(c) = f["conversation_id"]
            .as_i64()
            .and_then(|c| i32::try_from(c).ok())
        {
            if let Ok(Some(d)) = svc::dispatch_by_conversation(&self.db.conn, c).await {
                return Some(d);
            }
        }
        let conn = f["connection_id"].as_str()?;
        svc::dispatch_by_connection(&self.db.conn, conn)
            .await
            .ok()
            .flatten()
    }

    /// A forge's newest issues (or pull requests): each new one sets the
    /// routine off once; the first read is only where it starts from.
    async fn poll_forge_event(self: &Arc<Self>, r: routine_entity::Model, now: DateTime<Utc>) {
        let next = now + Duration::seconds(FORGE_POLL_SECS);
        let f = filter_of(&r);
        let Some(project) = f.project_id else {
            return;
        };
        let pr = f.what.as_deref() == Some("pr");
        let read = self.forge_newest(project, pr, f.label.clone()).await;
        let mut write = RoutineWrite {
            next_run_at: Some(Some(next)),
            ..Default::default()
        };
        match read {
            Ok(rows) => {
                let max = rows.iter().map(|(n, _, _)| *n).max().unwrap_or(0);
                // 0: never read; -1: read, and there was none.
                let read_before = r.signal_cursor != 0;
                let seen = i64::from(r.signal_cursor).max(0);
                if read_before {
                    let mut new: Vec<_> = rows.iter().filter(|(n, _, _)| *n > seen).collect();
                    new.sort_by_key(|(n, _, _)| *n);
                    for (n, _, url) in new {
                        // The forge's own words are not handed over: its
                        // number and link (read it with your tools).
                        let words = format!(
                            "new {} #{n} {url}",
                            if pr { "pull request" } else { "issue" }
                        );
                        let run = rsvc::insert_run(
                            &self.db.conn,
                            NewRun {
                                routine_id: r.id,
                                bot_id: r.bot_id,
                                trigger: "event".into(),
                                event_key: Some(forge_event_key(pr, project, *n)),
                                due_at: Some(now),
                                outcome: RunOutcome::Running,
                                note: Some(words.clone()),
                            },
                        )
                        .await;
                        if let Ok(Some(run)) = run {
                            write.last_run_at = Some(Some(now));
                            self.start_run(r.clone(), run, true, format!("The event: {words}."))
                                .await;
                        }
                    }
                }
                if max > seen {
                    write.signal_cursor = Some(i32::try_from(max).unwrap_or(i32::MAX));
                } else if !read_before {
                    // Nothing there yet: anything from now on is new.
                    write.signal_cursor = Some(-1);
                }
            }
            Err(e) => tracing::warn!("[personal_agent] routine #{}: forge not read: {e}", r.id),
        }
        let _ = rsvc::update(&self.db.conn, r.id, None, write).await;
    }

    /// The newest open issues (or pull requests) of a project's forge:
    /// number, title, link.
    async fn forge_newest(
        &self,
        project: i32,
        pr: bool,
        label: Option<String>,
    ) -> Result<Vec<(i64, String, String)>, String> {
        let filters = crate::forge::ListFilters {
            tab: if pr {
                crate::forge::ForgeTab::Prs
            } else {
                crate::forge::ForgeTab::Issues
            },
            state: "open".into(),
            assigned_me: false,
            labels: label.into_iter().collect(),
            search: None,
            sort: crate::forge::ForgeSort::Newest,
            page: 1,
            per_page: 10,
            account_id: None,
        };
        let read = tokio::time::timeout(
            std::time::Duration::from_secs(25),
            crate::commands::forge::forge_list_issues_core(&self.db, project, filters),
        )
        .await
        .map_err(|_| "the forge did not answer in time".to_string())?
        .map_err(|e| e.to_string())?;
        Ok(read
            .rows
            .into_iter()
            .filter(|r| r.is_pr == pr)
            .map(|r| (r.number, r.title, r.html_url))
            .collect())
    }

    /// Routines made with their assistant run their trial once it is set
    /// up: its opening card answered.
    async fn pending_trials(self: &Arc<Self>, bot: i32) {
        let pending: Vec<_> = rsvc::enabled_of(&self.db.conn, bot)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|r| r.trial_pending)
            .collect();
        if pending.is_empty() {
            return;
        }
        let asking = svc::notices_in_state(&self.db.conn, bot, NoticeState::Open)
            .await
            .unwrap_or_default()
            .iter()
            .any(|n| n.kind == NoticeKind::Choice);
        if asking {
            return;
        }
        for r in pending {
            let claimed = rsvc::update(
                &self.db.conn,
                r.id,
                None,
                RoutineWrite {
                    trial_pending: Some(false),
                    ..Default::default()
                },
            )
            .await;
            if let Ok(Some(r)) = claimed {
                let _ = self.run_now(r, "trial").await;
            }
        }
    }

    /// A dispatch routine whose assistant has nothing its work runs on is
    /// paused ahead of its time, with an urgent card.
    async fn check_work_agents(self: &Arc<Self>, bot: i32) {
        for r in rsvc::enabled_of(&self.db.conn, bot)
            .await
            .unwrap_or_default()
        {
            if r.kind != RoutineKind::Dispatch {
                continue;
            }
            if let Err(e) = self.template_work(&r).await {
                self.pause_routine(&r, "work_agent", &e).await;
            }
        }
    }

    /// Whether a dispatch routine's work can go out: it has work to hand
    /// out, and its assistant has something its work runs on now — what the
    /// run takes when it goes.
    async fn template_work(&self, r: &routine_entity::Model) -> Result<(), String> {
        template_of(r).ok_or("the routine has no work to hand out")?;
        self.work_snapshot()
            .await
            .map(|_| ())
            .map_err(|e| self.for_the_owner(e))
    }

    // ── a run ───────────────────────────────────────────────────────────────

    /// Run a routine now (`now`: the owner asked; `trial`: it was just
    /// made). No look first — only what is there now is noted.
    pub async fn run_now(
        self: &Arc<Self>,
        r: routine_entity::Model,
        trigger: &str,
    ) -> Result<run_entity::Model, String> {
        self.has_a_brain().await?;
        let run = rsvc::insert_run(
            &self.db.conn,
            NewRun {
                routine_id: r.id,
                bot_id: r.bot_id,
                trigger: trigger.into(),
                event_key: None,
                due_at: None,
                outcome: RunOutcome::Running,
                note: None,
            },
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or("the run was not recorded")?;
        let _ = rsvc::update(
            &self.db.conn,
            r.id,
            None,
            RoutineWrite {
                last_run_at: Some(Some(clock::now())),
                ..Default::default()
            },
        )
        .await;
        let facts = match trigger {
            "trial" => "A trial run, right after the routine was made: do it for real — it is its first run.".to_string(),
            _ => "The owner ran it now.".to_string(),
        };
        let id = run.id;
        self.start_run(r, run, false, facts).await;
        rsvc::get_run(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "the run is gone".into())
    }

    /// A run recorded as running: look first (`look`), then wake the
    /// assistant or hand out the work.
    async fn start_run(
        self: &Arc<Self>,
        r: routine_entity::Model,
        run: run_entity::Model,
        look: bool,
        facts: String,
    ) {
        let mut facts = facts;
        if let Some(p) = precheck_of(&r) {
            let seen: Value = r
                .precheck_state
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(Value::Null);
            match self.look(&p, &seen).await {
                Look::Same { words } if look => {
                    let _ = rsvc::update_run(
                        &self.db.conn,
                        run.id,
                        Some(&[RunOutcome::Running]),
                        RunWrite {
                            outcome: Some(RunOutcome::Skipped),
                            note: Some(Some(words)),
                            ended_at: Some(Some(clock::now())),
                            ..Default::default()
                        },
                    )
                    .await;
                    self.emit(PersonalAgentChange::Routine { id: r.id });
                    return;
                }
                Look::Same { words } => facts = format!("{facts} {words}"),
                Look::New { state, words } => {
                    let _ = rsvc::update(
                        &self.db.conn,
                        r.id,
                        None,
                        RoutineWrite {
                            precheck_state: Some(Some(state.to_string())),
                            ..Default::default()
                        },
                    )
                    .await;
                    facts = format!("{facts} {words}");
                }
                Look::Unread { error } => {
                    facts = format!(
                        "{facts} (Its look first could not be read — {error} — so it runs.)"
                    );
                }
            }
        }
        let seq = rsvc::count_run(&self.db.conn, r.id).await.unwrap_or(1);
        let _ = rsvc::update_run(
            &self.db.conn,
            run.id,
            None,
            RunWrite {
                seq: Some(seq),
                ..Default::default()
            },
        )
        .await;
        match r.kind {
            RoutineKind::Brain => self.wake_for_run(&r, &run, seq, &facts).await,
            RoutineKind::Dispatch => self.dispatch_for_run(&r, &run, seq).await,
        }
        self.emit(PersonalAgentChange::Routine { id: r.id });
    }

    /// What a precheck finds now, against what it saw at the last run.
    async fn look(&self, p: &Precheck, seen: &Value) -> Look {
        match p {
            Precheck::None => Look::New {
                state: Value::Null,
                words: String::new(),
            },
            Precheck::Commits { project_id, branch } => {
                let path = match self.project_path(*project_id).await {
                    Ok(p) => p,
                    Err(error) => return Look::Unread { error },
                };
                let branch = branch.clone().unwrap_or_else(|| "HEAD".into());
                let sha =
                    match crate::work_task::git::rev_parse(&path, &format!("{branch}^{{commit}}"))
                        .await
                    {
                        Ok(s) => s.trim().to_string(),
                        Err(e) => {
                            return Look::Unread {
                                error: e.to_string(),
                            }
                        }
                    };
                match seen["sha"].as_str() {
                    Some(old) if old == sha => Look::Same {
                        words: format!("No new commits on {branch} since the last run."),
                    },
                    Some(old) => Look::New {
                        state: json!({ "sha": sha }),
                        words: format!(
                            "New commits on {branch} since the last run: {}..{}.",
                            short(old),
                            short(&sha)
                        ),
                    },
                    None => Look::New {
                        state: json!({ "sha": sha }),
                        words: format!("{branch} is at {}.", short(&sha)),
                    },
                }
            }
            Precheck::Changes { project_id } => {
                let path = match self.project_path(*project_id).await {
                    Ok(p) => p,
                    Err(error) => return Look::Unread { error },
                };
                let fp = match crate::work_task::git::worktree_fingerprint(&path).await {
                    Ok(f) => f,
                    Err(e) => {
                        return Look::Unread {
                            error: e.to_string(),
                        }
                    }
                };
                match seen["fp"].as_str() {
                    Some(old) if old == fp => Look::Same {
                        words: "The project's working tree has not changed since the last run."
                            .into(),
                    },
                    Some(_) => Look::New {
                        state: json!({ "fp": fp }),
                        words: "The project's working tree changed since the last run.".into(),
                    },
                    None => Look::New {
                        state: json!({ "fp": fp }),
                        words: String::new(),
                    },
                }
            }
            Precheck::ForgeNew {
                project_id,
                what,
                label,
            } => {
                let pr = what.as_deref() == Some("pr");
                let rows = match self.forge_newest(*project_id, pr, label.clone()).await {
                    Ok(r) => r,
                    Err(error) => return Look::Unread { error },
                };
                let max = rows.iter().map(|(n, _, _)| *n).max().unwrap_or(0);
                let noun = if pr { "pull request" } else { "issue" };
                match seen["max"].as_i64() {
                    Some(old) if max <= old => Look::Same {
                        words: format!("No new open {noun} since the last run."),
                    },
                    old => {
                        // Numbers only: the forge's own words are not
                        // handed over.
                        let new: Vec<String> = rows
                            .iter()
                            .filter(|(n, _, _)| old.is_none_or(|o| *n > o))
                            .map(|(n, _, _)| format!("#{n}"))
                            .collect();
                        Look::New {
                            state: json!({ "max": max }),
                            words: if new.is_empty() {
                                String::new()
                            } else {
                                format!("New open {noun}(s): {}.", new.join(", "))
                            },
                        }
                    }
                }
            }
            Precheck::ItemsWaiting { hours } => {
                let bot = self.bot().await;
                let before = clock::now() - Duration::hours(i64::from(*hours));
                let waiting = svc::list_items(&self.db.conn, bot, &[ItemStatus::Open], 500)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|i| {
                        matches!(i.waits_for, Some(WaitsFor::Owner | WaitsFor::Agent))
                            && i.created_at < before
                    })
                    .count();
                if waiting == 0 {
                    Look::Same {
                        words: format!("No matter has waited over {hours} h."),
                    }
                } else {
                    Look::New {
                        state: Value::Null,
                        words: format!("{waiting} matter(s) have waited over {hours} h."),
                    }
                }
            }
        }
    }

    async fn project_path(&self, id: i32) -> Result<String, String> {
        crate::db::service::folder_service::get_folder_by_id(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .map(|f| f.path)
            .ok_or_else(|| format!("project #{id} does not exist"))
    }

    /// A brain routine's run: an event that wakes its assistant.
    async fn wake_for_run(
        &self,
        r: &routine_entity::Model,
        run: &run_entity::Model,
        seq: i32,
        facts: &str,
    ) {
        let summary = format!(
            "Routine #{} \"{}\" — run {seq}. {facts}\nWhat to do: {}\ncodeg keeps this routine's \
             schedule: this is its run {seq}, and codeg runs it again when it is due — do not \
             schedule it yourself or wait for the next time. Do it now as your settings allow. \
             If you find nothing worth telling the owner, reply with exactly {SILENT} and \
             nothing else: codeg then shows nothing and records \"no change\".",
            r.id,
            r.title,
            r.what.trim()
        );
        let key = format!("routine-run:{}", run.id);
        let bot = self.bot().await;
        let inserted = svc::insert_event(
            &self.db.conn,
            bot,
            ROUTINE_EVENT,
            &key,
            None,
            summary,
            Some(json!({
                "routine_id": r.id,
                "run_id": run.id,
                "title": r.title,
                "seq": seq,
            })),
            true,
        )
        .await;
        match inserted {
            Ok(_) => {
                let event = match svc::scoped_source_key(&self.db.conn, bot, &key).await {
                    Ok(k) => rsvc::event_by_key(&self.db.conn, &k).await.ok().flatten(),
                    Err(_) => None,
                };
                let _ = rsvc::update_run(
                    &self.db.conn,
                    run.id,
                    None,
                    RunWrite {
                        event_id: Some(event.map(|e| e.id)),
                        ..Default::default()
                    },
                )
                .await;
                self.nudge();
            }
            Err(e) => {
                self.run_failed(r, run.id, &format!("its assistant could not be woken: {e}"))
                    .await;
            }
        }
    }

    /// A dispatch routine's run: the work its template says — or, when the
    /// owner asked to confirm routine dispatches first, a card holding it.
    async fn dispatch_for_run(
        self: &Arc<Self>,
        r: &routine_entity::Model,
        run: &run_entity::Model,
        seq: i32,
    ) {
        match self.template_work(r).await {
            Ok(()) => {}
            Err(e) => {
                self.pause_routine(r, "work_agent", &e).await;
                let _ = rsvc::update_run(
                    &self.db.conn,
                    run.id,
                    Some(&[RunOutcome::Running]),
                    RunWrite {
                        outcome: Some(RunOutcome::Failed),
                        note: Some(Some(e)),
                        ended_at: Some(Some(clock::now())),
                        ..Default::default()
                    },
                )
                .await;
                return;
            }
        };
        let t = template_of(r).unwrap_or_default();
        let mode = t.mode.unwrap_or(DispatchMode::Task);
        let prompt = t
            .prompt
            .clone()
            .filter(|p| !p.trim().is_empty())
            .unwrap_or_else(|| r.what.clone());
        let req = DispatchRequest {
            mode,
            title: t
                .title
                .clone()
                .filter(|x| !x.trim().is_empty())
                .unwrap_or_else(|| r.title.clone()),
            prompt: format!(
                "{prompt}\n\n(This is run {seq} of the routine \"{}\"; codeg keeps its schedule — \
                 do not schedule anything yourself.)",
                r.title
            ),
            project_id: (mode != DispatchMode::Chat)
                .then_some(t.project_id)
                .flatten(),
            report: t.deliverable.as_deref() == Some("report"),
            on_done: None,
            done_when: t.done_when.clone(),
            replaces: None,
        };
        let valid = match self.validate_dispatch(&req).await {
            Ok(v) => v,
            Err(e) => {
                self.run_failed(r, run.id, &e).await;
                return;
            }
        };
        if self.prefs().await.routine_dispatch == crate::models::personal_agent_prefs::AskFirst::Ask
        {
            let subject = format!("confirm:routine-run:{}", run.id);
            match self
                .dispatch_card(
                    &valid,
                    None,
                    Some(format!("Routine \"{}\", run {seq}", r.title)),
                    Some(subject),
                    "confirm",
                )
                .await
            {
                Ok(notice_id) => {
                    let _ = rsvc::update_run(
                        &self.db.conn,
                        run.id,
                        Some(&[RunOutcome::Running]),
                        RunWrite {
                            outcome: Some(RunOutcome::Asked),
                            notice_id: Some(Some(notice_id)),
                            ..Default::default()
                        },
                    )
                    .await;
                    // The owner hears of it as of any card to confirm.
                }
                Err(e) => self.run_failed(r, run.id, &e).await,
            }
            return;
        }
        match self
            .record_dispatch(
                valid,
                DispatchAuth::Routine {
                    run_id: run.id,
                    label: json!({ "id": r.id, "title": r.title, "seq": seq }),
                },
            )
            .await
        {
            Ok(made) => {
                let _ = rsvc::update_run(
                    &self.db.conn,
                    run.id,
                    None,
                    RunWrite {
                        dispatch_id: Some(Some(made.dispatch.id)),
                        ..Default::default()
                    },
                )
                .await;
            }
            Err(e) => self.run_failed(r, run.id, &e).await,
        }
    }

    /// A run failed: counted, and the third in a row pauses the routine.
    async fn run_failed(&self, r: &routine_entity::Model, run_id: i32, why: &str) {
        let _ = rsvc::update_run(
            &self.db.conn,
            run_id,
            Some(&[RunOutcome::Running, RunOutcome::Asked]),
            RunWrite {
                outcome: Some(RunOutcome::Failed),
                note: Some(Some(why.to_string())),
                ended_at: Some(Some(clock::now())),
                ..Default::default()
            },
        )
        .await;
        self.count_failure(r.id, why).await;
    }

    async fn count_failure(&self, routine_id: i32, why: &str) {
        let Ok(Some(r)) = rsvc::get(&self.db.conn, routine_id).await else {
            return;
        };
        let failures = r.failures + 1;
        let _ = rsvc::update(
            &self.db.conn,
            r.id,
            None,
            RoutineWrite {
                failures: Some(failures),
                ..Default::default()
            },
        )
        .await;
        if failures >= FAILURES_TO_PAUSE && r.enabled {
            self.pause_routine(
                &r,
                "failures",
                &format!("{failures} runs in a row failed; the last: {why}"),
            )
            .await;
        }
        self.emit(PersonalAgentChange::Routine { id: r.id });
    }

    async fn count_success(&self, routine_id: i32) {
        let _ = rsvc::update(
            &self.db.conn,
            routine_id,
            None,
            RoutineWrite {
                failures: Some(0),
                ..Default::default()
            },
        )
        .await;
    }

    /// Pause a routine for a reason codeg found, with an urgent card.
    async fn pause_routine(&self, r: &routine_entity::Model, reason: &str, why: &str) {
        let paused = rsvc::update(
            &self.db.conn,
            r.id,
            None,
            RoutineWrite {
                enabled: Some(false),
                paused_reason: Some(Some(reason.to_string())),
                ..Default::default()
            },
        )
        .await;
        let Ok(Some(r)) = paused else {
            return;
        };
        let owner = self.owner_tz().await;
        let view = routine_view(&self.db.conn, r.clone(), owner, 1).await;
        let data = json!({
            "notice": "routine",
            "what": "paused",
            "state": "open",
            "reason": reason,
            "why": why,
            "routine": view,
        });
        let card = self
            .raise_routine_card(
                format!("Routine paused: {}", r.title),
                json!({ "what": "paused", "routine_id": r.id, "reason": reason }),
                data,
                NoticeLevel::Urgent,
                Some(format!("paused:{}:{}", r.id, Utc::now().timestamp_millis())),
                None,
            )
            .await;
        self.emit(PersonalAgentChange::Routine { id: r.id });
        if let (Ok((_, row)), Some(host)) = (card, self.host_ref()) {
            let bot = self.bot().await;
            host.tell(super::reach::News {
                key: format!("routine_paused:{}:{}", r.id, row.id),
                bot_id: bot,
                kind: "routine_paused",
                what: super::reach::What::RoutinePaused {
                    text: super::reach::glimpse(&r.title),
                },
                link: Some(super::reach::NotifyLink::Bot {
                    bot_id: bot,
                    row_id: Some(row.id),
                }),
                need: None,
            })
            .await;
        }
    }

    // ── what runs come to ───────────────────────────────────────────────────

    /// The routine runs a delivery carries: on their way with it.
    pub(super) async fn note_routine_batch(
        &self,
        events: &[crate::db::entities::personal_agent_event::Model],
        batch_id: i32,
    ) {
        for e in events.iter().filter(|e| e.kind == ROUTINE_EVENT) {
            let Some(run_id) = run_id_of(e) else {
                continue;
            };
            let _ = rsvc::update_run(
                &self.db.conn,
                run_id,
                Some(&[RunOutcome::Running]),
                RunWrite {
                    batch_id: Some(Some(batch_id)),
                    ..Default::default()
                },
            )
            .await;
        }
    }

    /// What the routine runs a delivery's batch woke its assistant for came
    /// to, once the turn settled: silent or reported; failed when the turn
    /// broke twice; stopped when the owner stopped it. A run whose event
    /// went back to wait rides with the next delivery.
    pub(super) async fn settle_routine_batch(
        &self,
        batch_id: i32,
        interrupted: bool,
        canceled: bool,
        silent: bool,
        reply_row_id: Option<i32>,
        reply_words: Option<String>,
    ) {
        let events = rsvc::events_of_batch(&self.db.conn, batch_id, ROUTINE_EVENT)
            .await
            .unwrap_or_default();
        let mut told = false;
        for e in events {
            let Some(run_id) = run_id_of(&e) else {
                continue;
            };
            // Put back to wait: still running.
            if e.state == crate::db::entities::personal_agent_event::EventState::Pending {
                continue;
            }
            let Ok(Some(run)) = rsvc::get_run(&self.db.conn, run_id).await else {
                continue;
            };
            if run.outcome != RunOutcome::Running {
                continue;
            }
            let Ok(Some(r)) = rsvc::get(&self.db.conn, run.routine_id).await else {
                continue;
            };
            let outcome = if interrupted {
                RunOutcome::Failed
            } else if canceled {
                RunOutcome::Stopped
            } else if silent {
                RunOutcome::Silent
            } else {
                RunOutcome::Reported
            };
            // What it ran for (an event's words) stays on it; a silent run
            // with nothing on it says "no change".
            let note = match outcome {
                RunOutcome::Failed => Some(Some("its turn broke off twice".to_string())),
                RunOutcome::Silent if run.note.is_none() => Some(Some("no change".to_string())),
                _ => None,
            };
            let _ = rsvc::update_run(
                &self.db.conn,
                run.id,
                Some(&[RunOutcome::Running]),
                RunWrite {
                    outcome: Some(outcome),
                    note,
                    ended_at: Some(Some(clock::now())),
                    batch_id: Some(Some(batch_id)),
                    ..Default::default()
                },
            )
            .await;
            match outcome {
                RunOutcome::Failed => self.count_failure(r.id, "its turn broke off twice").await,
                RunOutcome::Silent | RunOutcome::Reported => self.count_success(r.id).await,
                _ => {}
            }
            self.emit(PersonalAgentChange::Routine { id: r.id });
            // The report reaches the owner (6.2: normal).
            if outcome == RunOutcome::Reported && !told {
                told = true;
                if let Some(host) = self.host_ref() {
                    let bot = self.bot().await;
                    host.tell(super::reach::News {
                        key: format!("routine:{}:{batch_id}", r.id),
                        bot_id: bot,
                        kind: "routine",
                        what: super::reach::What::RoutineReport {
                            title: super::reach::glimpse(&r.title),
                            text: reply_words.clone(),
                        },
                        link: Some(super::reach::NotifyLink::Bot {
                            bot_id: bot,
                            row_id: reply_row_id,
                        }),
                        need: None,
                    })
                    .await;
                }
            }
        }
    }

    /// Work a routine handed out ended: its run comes to what it came to.
    pub(super) async fn routine_dispatch_ended(&self, d: &dispatch_entity::Model) {
        let Ok(Some(run)) = rsvc::run_of_dispatch(&self.db.conn, d.id).await else {
            return;
        };
        let outcome = match d.state {
            DispatchState::Completed => RunOutcome::Reported,
            DispatchState::Failed | DispatchState::Interrupted => RunOutcome::Failed,
            DispatchState::Canceled | DispatchState::HandedOver => RunOutcome::Stopped,
            _ => return,
        };
        if run.outcome == outcome {
            return;
        }
        let note = (outcome == RunOutcome::Failed)
            .then(|| d.error.clone().unwrap_or_else(|| "the work failed".into()));
        let _ = rsvc::update_run(
            &self.db.conn,
            run.id,
            None,
            RunWrite {
                outcome: Some(outcome),
                note: Some(note.clone()),
                ended_at: Some(Some(clock::now())),
                ..Default::default()
            },
        )
        .await;
        match outcome {
            RunOutcome::Failed => {
                self.count_failure(run.routine_id, note.as_deref().unwrap_or("the work failed"))
                    .await
            }
            RunOutcome::Reported => self.count_success(run.routine_id).await,
            _ => {}
        }
        self.emit(PersonalAgentChange::Routine { id: run.routine_id });
    }

    /// The owner answered a routine run's confirm card: the work runs as
    /// `dispatch` — or, with none, it did not.
    pub(super) async fn routine_card_answered(&self, notice_id: i32, dispatch: Option<i32>) {
        let Ok(Some(run)) = rsvc::run_of_notice(&self.db.conn, notice_id).await else {
            return;
        };
        let write = match dispatch {
            Some(id) => RunWrite {
                outcome: Some(RunOutcome::Running),
                dispatch_id: Some(Some(id)),
                ..Default::default()
            },
            None => RunWrite {
                outcome: Some(RunOutcome::Declined),
                ended_at: Some(Some(clock::now())),
                note: Some(Some("the owner did not confirm it".into())),
                ..Default::default()
            },
        };
        let _ = rsvc::update_run(&self.db.conn, run.id, Some(&[RunOutcome::Asked]), write).await;
        self.emit(PersonalAgentChange::Routine { id: run.routine_id });
    }

    // ── making and changing ─────────────────────────────────────────────────

    /// A spec checked against codeg: its projects exist, its cron reads in
    /// its zone, a dispatch routine's work would be accepted.
    async fn check_spec(&self, spec: &Spec) -> Result<(), String> {
        let owner = self.owner_tz().await;
        if let Some(c) = &spec.cron {
            let tz = zone_of(spec.timezone.as_deref(), owner);
            compute_next_run(c, tz.name(), Utc::now()).map_err(|e| e.to_string())?;
        }
        let mut projects = Vec::new();
        if let Some(p) = spec.event.as_ref().and_then(|e| e.filter.project_id) {
            projects.push(p);
        }
        match &spec.precheck {
            Some(Precheck::Commits { project_id, .. })
            | Some(Precheck::Changes { project_id })
            | Some(Precheck::ForgeNew { project_id, .. }) => projects.push(*project_id),
            _ => {}
        }
        for p in projects {
            self.project_path(p).await?;
        }
        // The request itself only: what runs it is taken at each run.
        if let Some(t) = &spec.dispatch {
            let mode = t.mode.unwrap_or(DispatchMode::Task);
            self.validate_dispatch(&DispatchRequest {
                mode,
                title: spec.title.clone(),
                prompt: t.prompt.clone().unwrap_or_else(|| spec.what.clone()),
                project_id: (mode != DispatchMode::Chat)
                    .then_some(t.project_id)
                    .flatten(),
                report: t.deliverable.as_deref() == Some("report"),
                on_done: None,
                done_when: t.done_when.clone(),
                replaces: None,
            })
            .await?;
        }
        Ok(())
    }

    /// The columns a spec writes, its next time worked out from now.
    async fn new_of(&self, spec: &Spec, source: &str, trial_pending: bool) -> NewRoutine {
        let owner = self.owner_tz().await;
        let tz = zone_of(spec.timezone.as_deref(), owner);
        let now = clock::now();
        let next = spec.cron.as_deref().and_then(|c| next_run(c, tz, now));
        let cursor = self.signal_head(spec).await;
        NewRoutine {
            bot_id: self.bot().await,
            title: spec.title.clone(),
            what: spec.what.clone(),
            kind: spec.kind,
            trigger: spec.trigger,
            cron: spec.cron.clone(),
            timezone: spec.timezone.clone(),
            zone_used: spec.cron.as_ref().map(|_| tz.name().to_string()),
            event_kind: spec.event.as_ref().map(|e| e.kind.clone()),
            event_filter: spec.event.as_ref().and_then(|e| json_of(&e.filter)),
            dispatch: spec.dispatch.as_ref().and_then(json_of),
            precheck: spec.precheck.as_ref().and_then(json_of),
            source: source.to_string(),
            next_run_at: next,
            signal_cursor: cursor,
            trial_pending,
        }
    }

    /// Where an event routine starts reading: the events from now on.
    async fn signal_head(&self, spec: &Spec) -> i32 {
        match &spec.event {
            Some(e) if e.kind != FORGE_EVENT => rsvc::signal_head(&self.db.conn).await.unwrap_or(0),
            _ => 0,
        }
    }

    /// Make a routine, and run it once now as a test the owner can see. A
    /// repeated call (a re-delivered turn, a second click) makes nothing
    /// and hands back the first one's.
    pub async fn make_routine(
        self: &Arc<Self>,
        spec: &Spec,
        source: &str,
        auth: MakeAuth,
    ) -> Result<(routine_entity::Model, Option<run_entity::Model>, bool), String> {
        self.has_a_brain().await?;
        self.check_spec(spec).await?;
        let new = self.new_of(spec, source, false).await;
        let key = format!("routine_create:{}", spec.title.to_lowercase());
        let slot = match &auth {
            MakeAuth::Ledgered { batch_id, scope } => {
                let earlier = svc::ledger_entries(&self.db.conn, scope, &key)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(e) = earlier.iter().find(|e| {
                    e.state == crate::db::entities::personal_agent_action::ActionState::Committed
                }) {
                    return self.earlier_routine(e).await;
                }
                Some(LedgerSlot::in_batch(
                    *batch_id,
                    key,
                    super::ledger::fresh_op_id(),
                ))
            }
            MakeAuth::Card { notice_id } => Some(LedgerSlot::outside(super::ledger::card_op_id(
                *notice_id, 1,
            ))),
            MakeAuth::Direct => None,
        };
        let made = match slot {
            Some(slot) => match rsvc::create_ledgered(
                &self.db.conn,
                new,
                &slot,
                Some(json!({ "title": spec.title })),
            )
            .await
            .map_err(|e| e.to_string())?
            {
                Ledgered::New(r) => r,
                Ledgered::Earlier(e) => return self.earlier_routine(&e).await,
            },
            None => rsvc::create(&self.db.conn, new)
                .await
                .map_err(|e| e.to_string())?,
        };
        self.emit(PersonalAgentChange::Routine { id: made.id });
        let trial = self.run_now(made.clone(), "trial").await.ok();
        let made = rsvc::get(&self.db.conn, made.id)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(made);
        Ok((made, trial, false))
    }

    async fn earlier_routine(
        &self,
        entry: &crate::db::entities::personal_agent_action::Model,
    ) -> Result<(routine_entity::Model, Option<run_entity::Model>, bool), String> {
        let id = entry
            .ref_id
            .as_deref()
            .and_then(|r| r.parse::<i32>().ok())
            .ok_or("an earlier identical call is on record, but what it made is not")?;
        let r = rsvc::get(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("routine #{id} of an earlier identical call is gone"))?;
        Ok((r, None, true))
    }

    /// Change a routine to a spec (the whole of it, checked). Its next
    /// time is worked out again; an event routine reads on from now.
    async fn apply_spec(
        &self,
        r: &routine_entity::Model,
        spec: &Spec,
    ) -> Result<routine_entity::Model, String> {
        self.check_spec(spec).await?;
        let new = self.new_of(spec, &r.source, false).await;
        let event_changed = new.event_kind != r.event_kind || new.event_filter != r.event_filter;
        let write = RoutineWrite {
            title: Some(new.title),
            what: Some(new.what),
            kind: Some(new.kind),
            trigger: Some(new.trigger),
            cron: Some(new.cron),
            timezone: Some(new.timezone),
            zone_used: Some(new.zone_used),
            event_kind: Some(new.event_kind),
            event_filter: Some(new.event_filter),
            dispatch: Some(new.dispatch),
            precheck: Some(new.precheck.clone()),
            precheck_state: (new.precheck != r.precheck).then_some(None),
            next_run_at: Some(new.next_run_at),
            signal_cursor: event_changed.then_some(new.signal_cursor),
            ..Default::default()
        };
        let updated = rsvc::update(&self.db.conn, r.id, None, write)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the routine is gone")?;
        self.emit(PersonalAgentChange::Routine { id: r.id });
        Ok(updated)
    }

    /// Pause, resume or delete a routine (`by`: `owner` when the owner or
    /// their assistant did it).
    pub async fn routine_switch(
        &self,
        r: &routine_entity::Model,
        action: &str,
    ) -> Result<routine_entity::Model, String> {
        let now = clock::now();
        let write = match action {
            "pause" => RoutineWrite {
                enabled: Some(false),
                paused_reason: Some(Some("owner".into())),
                ..Default::default()
            },
            "resume" => {
                let owner = self.owner_tz().await;
                let tz = zone_of(r.timezone.as_deref(), owner);
                let next = r.cron.as_deref().and_then(|c| next_run(c, tz, now));
                // An event routine takes up the events from now on.
                let cursor = match r.event_kind.as_deref() {
                    Some(k) if k != FORGE_EVENT => Some(
                        rsvc::signal_head(&self.db.conn)
                            .await
                            .unwrap_or(r.signal_cursor),
                    ),
                    _ => None,
                };
                RoutineWrite {
                    enabled: Some(true),
                    paused_reason: Some(None),
                    failures: Some(0),
                    next_run_at: Some(next),
                    zone_used: r.cron.as_ref().map(|_| Some(tz.name().to_string())),
                    signal_cursor: cursor,
                    ..Default::default()
                }
            }
            "delete" => RoutineWrite {
                deleted_at: Some(Some(Utc::now())),
                ..Default::default()
            },
            _ => return Err("`action` must be pause, resume, delete or run_now".into()),
        };
        let updated = rsvc::update(&self.db.conn, r.id, None, write)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the routine is gone")?;
        self.emit(PersonalAgentChange::Routine { id: r.id });
        Ok(updated)
    }

    // ── cards ───────────────────────────────────────────────────────────────

    async fn raise_routine_card(
        &self,
        body: String,
        payload: Value,
        data: Value,
        level: NoticeLevel,
        subject: Option<String>,
        batch_id: Option<i32>,
    ) -> Result<(notice_entity::Model, TimelineRow), String> {
        let mut row = NewRow::new(TimelineKind::Notice, body);
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch_id;
        row.data = Some(data);
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Routine,
                subject_key: subject,
                level,
                batch_id,
                payload,
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        let row = svc::to_row(card);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok((notice, row))
    }

    /// Write a routine card's state (and what more it says) on its row.
    async fn routine_card_row(
        &self,
        notice: &notice_entity::Model,
        state: &str,
        more: Value,
    ) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), state.into());
            if let Value::Object(more) = more {
                for (k, v) in more {
                    map.insert(k, v);
                }
            }
        }
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// The owner's answer on a routine card:
    /// - made or changed: `undo` takes it back;
    /// - a proposal: `accept` makes (or changes) it, `dismiss` drops it;
    /// - an offer to make a repeated request a routine: `dismiss` (it is
    ///   made from the editor it opens);
    /// - paused: `resume`, or `dismiss`.
    pub(super) async fn act_on_routine(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        let what = payload["what"].as_str().unwrap_or("");
        let routine_id = payload["routine_id"]
            .as_i64()
            .and_then(|i| i32::try_from(i).ok());
        let bot = self.bot().await;
        match (what, action) {
            ("made" | "changed", "undo") => {
                let id = routine_id.ok_or("the card names no routine")?;
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acting,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                let undone = match what {
                    "made" => rsvc::update(
                        &self.db.conn,
                        id,
                        None,
                        RoutineWrite {
                            deleted_at: Some(Some(Utc::now())),
                            ..Default::default()
                        },
                    )
                    .await
                    .map_err(|e| e.to_string())
                    .map(|_| ()),
                    _ => self.restore_routine(id, &payload["before"]).await,
                };
                match undone {
                    Ok(()) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Undone,
                        )
                        .await;
                        self.emit(PersonalAgentChange::Routine { id });
                        self.tell_brain_routine(notice, "undone", id).await;
                        self.routine_card_row(notice, "undone", json!({ "error": null }))
                            .await
                    }
                    Err(e) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Open,
                        )
                        .await;
                        let _ = self
                            .routine_card_row(notice, "made", json!({ "error": e.clone() }))
                            .await;
                        Err(e)
                    }
                }
            }
            ("proposal", "accept") => {
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acting,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                let draft: Draft =
                    serde_json::from_value(payload["draft"].clone()).unwrap_or_default();
                let ran = match routine_id {
                    // A change to one: over what it is now.
                    Some(id) => match rsvc::get_of(&self.db.conn, bot, id).await {
                        Ok(Some(r)) => {
                            let action = payload["action"].as_str().unwrap_or("");
                            let done = if action.is_empty() {
                                match spec_of(&draft, Some(&draft_of(&r))) {
                                    Ok(spec) => self.apply_spec(&r, &spec).await,
                                    Err(e) => Err(e),
                                }
                            } else if action == "run_now" {
                                self.run_now(r.clone(), "now").await.map(|_| r.clone())
                            } else {
                                self.routine_switch(&r, action).await
                            };
                            done.map(|r| (r, None))
                        }
                        Ok(None) => Err(format!("routine #{id} is gone")),
                        Err(e) => Err(e.to_string()),
                    },
                    None => match spec_of(&draft, None) {
                        Ok(spec) => self
                            .make_routine(
                                &spec,
                                // One the owner asked for, shown to them
                                // first, is theirs.
                                if payload["why"].as_str() == Some("confirm") {
                                    "owner"
                                } else {
                                    "suggest"
                                },
                                MakeAuth::Card {
                                    notice_id: notice.id,
                                },
                            )
                            .await
                            .map(|(r, trial, _)| (r, trial)),
                        Err(e) => Err(e),
                    },
                };
                match ran {
                    Ok((r, trial)) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Acted,
                        )
                        .await;
                        self.tell_brain_routine(notice, "approved", r.id).await;
                        let owner = self.owner_tz().await;
                        let view = routine_view(&self.db.conn, r, owner, 1).await;
                        self.routine_card_row(
                            notice,
                            "made",
                            json!({
                                "routine": view,
                                "trial_run_id": trial.map(|t| t.id),
                                "error": null,
                            }),
                        )
                        .await
                    }
                    Err(e) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Open,
                        )
                        .await;
                        let _ = self
                            .routine_card_row(notice, "open", json!({ "error": e.clone() }))
                            .await;
                        Err(e)
                    }
                }
            }
            ("proposal" | "repeat" | "paused", "dismiss") => {
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Dismissed,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                if what == "proposal" {
                    self.tell_brain_routine(notice, "declined", routine_id.unwrap_or(0))
                        .await;
                }
                self.routine_card_row(notice, "dismissed", json!({})).await
            }
            ("paused", "resume") => {
                let id = routine_id.ok_or("the card names no routine")?;
                let r = rsvc::get_of(&self.db.conn, bot, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("routine #{id} is gone"))?;
                if r.kind == RoutineKind::Dispatch {
                    self.template_work(&r).await?;
                }
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acted,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                self.routine_switch(&r, "resume").await?;
                self.routine_card_row(notice, "resumed", json!({})).await
            }
            _ => Err(format!("`{action}` does not apply to this card")),
        }
    }

    /// Put back what a routine was before a change (the card's `before`).
    async fn restore_routine(&self, id: i32, before: &Value) -> Result<(), String> {
        let draft: Draft = serde_json::from_value(before["draft"].clone()).unwrap_or_default();
        let r = rsvc::get(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("routine #{id} is gone"))?;
        // The whole of what it was: a field it did not have then (a zone,
        // a look first) is not kept from now.
        let spec = spec_of(&draft, None)?;
        let updated = self.apply_spec(&r, &spec).await?;
        let enabled = before["enabled"].as_bool().unwrap_or(updated.enabled);
        let paused = before["paused_reason"].as_str().map(str::to_string);
        let deleted = before["deleted"].as_bool().unwrap_or(false);
        rsvc::update(
            &self.db.conn,
            id,
            None,
            RoutineWrite {
                enabled: Some(enabled),
                paused_reason: Some(paused),
                deleted_at: Some(deleted.then(Utc::now)),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Let the assistant know what the owner did with its routine card, with
    /// its next delivery.
    async fn tell_brain_routine(&self, notice: &notice_entity::Model, verdict: &str, id: i32) {
        let summary = match verdict {
            "approved" => format!(
                "The owner approved your routine card #{}; it is routine #{id} now.",
                notice.id
            ),
            "declined" => format!(
                "The owner declined your routine card #{}; nothing changed.",
                notice.id
            ),
            _ => format!(
                "The owner undid routine card #{} (routine #{id}).",
                notice.id
            ),
        };
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "proposal",
            &format!(
                "notice:{}:{verdict}:{}",
                notice.id,
                Utc::now().timestamp_millis()
            ),
            None,
            summary,
            Some(json!({ "notice_id": notice.id, "verdict": verdict, "routine_id": id })),
            false,
        )
        .await;
    }

    // ── a request the owner keeps making (6.7) ──────────────────────────────

    /// A dispatch this assistant just made: when it is the third alike in
    /// a month, offer the owner a routine for it. The note for the tool's
    /// answer, when one was offered.
    pub async fn offer_routine_for_dispatch(&self, d: &dispatch_entity::Model) -> Option<String> {
        // The owner turned the offer off (6.7).
        let prefs = self.prefs().await;
        if !prefs.proactive() || !prefs.rule_on("repeat") {
            return None;
        }
        // Work a routine handed out is a routine already.
        if rsvc::run_of_dispatch(&self.db.conn, d.id)
            .await
            .ok()
            .flatten()
            .is_some()
        {
            return None;
        }
        let since = clock::now() - Duration::days(REPEAT_DAYS);
        let recent = rsvc::dispatches_since(&self.db.conn, self.bot().await, since)
            .await
            .ok()?;
        // codeg's own acceptance checks are not requests.
        let ids: Vec<i32> = recent.iter().map(|x| x.id).collect();
        let checks =
            crate::db::service::personal_agent_verification_service::of_checks(&self.db.conn, &ids)
                .await
                .unwrap_or_default();
        if checks.contains_key(&d.id) {
            return None;
        }
        let earlier: Vec<_> = recent
            .into_iter()
            .filter(|x| {
                x.id != d.id
                    && !checks.contains_key(&x.id)
                    && alike(&x.title, &d.title) >= REPEAT_ALIKE
            })
            .collect();
        let mut alike_earlier = Vec::new();
        for x in earlier {
            if rsvc::run_of_dispatch(&self.db.conn, x.id)
                .await
                .ok()
                .flatten()
                .is_none()
            {
                alike_earlier.push(x);
            }
        }
        if alike_earlier.len() + 1 < prefs.repeat_count() {
            return None;
        }
        let owner = self.owner_tz().await;
        let draft = Draft {
            title: Some(d.title.clone()),
            what: Some(d.prompt.clone()),
            kind: Some(RoutineKind::Dispatch),
            cron: Some(weekly_at(owner, clock::now())),
            timezone: None,
            event: None,
            dispatch: Some(DispatchTemplate {
                mode: Some(d.mode),
                project_id: d.folder_id,
                title: None,
                prompt: None,
                deliverable: d.deliverable.clone(),
                done_when: d.done_when.clone(),
            }),
            precheck: None,
        };
        let titles: Vec<String> = alike_earlier.iter().map(|x| x.title.clone()).collect();
        let id = self
            .offer_routine(&d.title, draft, titles, "dispatch", Some(d.id))
            .await?;
        Some(format!(
            "This is request number {} like it in {REPEAT_DAYS} days, so codeg put card #{id} in front \
             of the owner offering to make it a routine; you may mention it at the end of your reply.",
            alike_earlier.len() + 1
        ))
    }

    /// An owner's message just queued: the third alike in a month gets the
    /// same offer, for this assistant to do then.
    pub(super) async fn offer_routine_for_message(&self, row_id: i32, text: &str) {
        let text = text.trim();
        if text.chars().count() < REPEAT_MIN_CHARS {
            return;
        }
        // The owner turned the offer off (6.7).
        let prefs = self.prefs().await;
        if !prefs.proactive() || !prefs.rule_on("repeat") {
            return;
        }
        let bot = self.bot().await;
        let since = clock::now() - Duration::days(REPEAT_DAYS);
        let Ok(earlier) = rsvc::owner_messages_since(&self.db.conn, bot, since, 300).await else {
            return;
        };
        let alike_earlier: Vec<String> = earlier
            .into_iter()
            .filter(|m| m.id != row_id)
            .map(|m| m.body)
            .filter(|b| {
                b.trim().chars().count() >= REPEAT_MIN_CHARS && alike(b, text) >= REPEAT_ALIKE
            })
            .collect();
        if alike_earlier.len() + 1 < prefs.repeat_count() {
            return;
        }
        let owner = self.owner_tz().await;
        let title: String = text
            .lines()
            .next()
            .unwrap_or(text)
            .chars()
            .take(60)
            .collect();
        let draft = Draft {
            title: Some(title.clone()),
            what: Some(text.chars().take(MAX_WHAT_CHARS).collect()),
            kind: Some(RoutineKind::Brain),
            cron: Some(weekly_at(owner, clock::now())),
            ..Default::default()
        };
        let alike_earlier_count = alike_earlier.len();
        if let Some(id) = self
            .offer_routine(&title, draft, alike_earlier, "message", None)
            .await
        {
            let _ = svc::insert_event(
                &self.db.conn,
                bot,
                "proposal",
                &format!("repeat:{id}"),
                None,
                format!(
                    "The owner has asked for something like #{row_id} {} times in {REPEAT_DAYS} days; \
                     codeg put card #{id} in front of them offering to make it a routine — no need to \
                     offer it again yourself.",
                    alike_earlier_count + 1
                ),
                Some(json!({ "notice_id": id })),
                false,
            )
            .await;
        }
    }

    /// The offer card itself, unless one alike was raised in the last month.
    async fn offer_routine(
        &self,
        title: &str,
        draft: Draft,
        earlier: Vec<String>,
        from: &str,
        dispatch_id: Option<i32>,
    ) -> Option<i32> {
        let bot = self.bot().await;
        let since = clock::now() - Duration::days(REPEAT_DAYS);
        let offered = rsvc::notices_of_kind_since(&self.db.conn, bot, NoticeKind::Routine, since)
            .await
            .ok()?;
        for n in offered {
            let p: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if p["what"].as_str() == Some("repeat")
                && alike(p["title"].as_str().unwrap_or(""), title) >= REPEAT_ALIKE
            {
                return None;
            }
        }
        let data = json!({
            "notice": "routine",
            "what": "repeat",
            "state": "open",
            "from": from,
            "count": earlier.len() + 1,
            "earlier": earlier.iter().take(5).collect::<Vec<_>>(),
            "draft": draft,
            "dispatch_id": dispatch_id,
        });
        let (notice, _) = self
            .raise_routine_card(
                format!("Make it a routine? {title}"),
                json!({ "what": "repeat", "why": "suggest", "title": title }),
                data,
                NoticeLevel::Low,
                Some(format!("repeat:{}", Utc::now().timestamp_millis())),
                self.current_batch().await,
            )
            .await
            .ok()?;
        Some(notice.id)
    }

    // ── the tools ───────────────────────────────────────────────────────────

    /// `routine_list`: this assistant's routines.
    pub async fn routine_list_call(&self) -> ToolOutcome {
        let bot = self.bot().await;
        let owner = self.owner_tz().await;
        let now = clock::now();
        let mut views = Vec::new();
        for r in rsvc::list_of(&self.db.conn, bot).await.unwrap_or_default() {
            views.push(routine_view(&self.db.conn, r, owner, 3).await);
        }
        if views.is_empty() {
            return ToolOutcome::ok(
                "You have no routines. routine_create makes one.",
                json!({ "routines": [] }),
            );
        }
        let lines: Vec<String> = views.iter().map(|v| line_of(v, owner, now)).collect();
        ToolOutcome::ok(lines.join("\n"), json!({ "routines": views }))
    }

    /// The owner asked to see the changes they ask for first (13.5).
    async fn shows_changes_first(&self) -> bool {
        self.prefs().await.chat_changes == crate::models::personal_agent_prefs::ChatChanges::Show
    }

    /// `routine_create`: made at once and run once as a test, with a card
    /// saying so (undo); with `suggest` — or with the owner's "show me such
    /// changes first" (`chat_changes`, 13.5) — a proposal card the owner
    /// answers.
    pub async fn routine_create_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let draft: Draft = match serde_json::from_value(strip(args)) {
            Ok(d) => d,
            Err(e) => return ToolOutcome::refused(format!("the routine does not read: {e}")),
        };
        let spec = match spec_of(&draft, None) {
            Ok(s) => s,
            Err(e) => return ToolOutcome::refused(e),
        };
        if let Err(e) = self.check_spec(&spec).await {
            return ToolOutcome::refused(e);
        }
        let reason = args["reason"].as_str().map(str::to_string);
        let owner = self.owner_tz().await;
        let zone = zone_of(spec.timezone.as_deref(), owner).name().to_string();
        let batch = self.current_batch().await;
        let suggest = args["suggest"].as_bool() == Some(true);
        // The owner does not take suggestions now (6.7).
        if suggest {
            if let Some(no) = self.suggestions_closed().await {
                return no;
            }
        }
        // The owner sees such changes first (13.5).
        let confirm = !suggest && self.shows_changes_first().await;
        if suggest || confirm {
            let data = json!({
                "notice": "routine",
                "what": "proposal",
                "state": "open",
                "confirm": confirm,
                "routine": summary_of(&spec, None, None, &zone),
                "draft": spec.draft(),
                "reason": reason,
            });
            return match self
                .raise_routine_card(
                    if confirm {
                        format!("Routine to confirm: {}", spec.title)
                    } else {
                        format!("Suggested routine: {}", spec.title)
                    },
                    json!({
                        "what": "proposal",
                        "why": if confirm { "confirm" } else { "suggest" },
                        "draft": spec.draft(),
                    }),
                    data,
                    if confirm {
                        NoticeLevel::Normal
                    } else {
                        NoticeLevel::Low
                    },
                    None,
                    batch,
                )
                .await
            {
                Ok((n, _)) => ToolOutcome::ok(
                    format!(
                        "{}: the routine \"{}\" is on card #{} for the owner; it is made (and run \
                         once) only if they say so. You will hear how they answered.",
                        if confirm {
                            "The owner sees such changes first"
                        } else {
                            "Suggested"
                        },
                        spec.title,
                        n.id
                    ),
                    json!({ "notice_id": n.id, "state": "awaiting_owner" }),
                ),
                Err(e) => ToolOutcome::refused(e),
            };
        }
        let auth = match self.ledger_batch().await {
            Some((batch_id, scope)) => MakeAuth::Ledgered { batch_id, scope },
            None => MakeAuth::Direct,
        };
        let (r, trial, earlier) = match self.make_routine(&spec, "owner", auth).await {
            Ok(m) => m,
            Err(e) => return ToolOutcome::refused(e),
        };
        let view = routine_view(&self.db.conn, r.clone(), owner, 1).await;
        if earlier {
            return ToolOutcome::ok(
                format!(
                    "Already made by the turn this delivery repeats: routine #{} \"{}\".",
                    r.id, r.title
                ),
                json!({ "routine": view, "earlier": true }),
            );
        }
        let data = json!({
            "notice": "routine",
            "what": "made",
            "state": "made",
            "routine": view,
            "reason": reason,
            "trial_run_id": trial.as_ref().map(|t| t.id),
        });
        let card = self
            .raise_routine_card(
                format!("Routine made: {}", r.title),
                json!({ "what": "made", "routine_id": r.id }),
                data,
                NoticeLevel::Low,
                Some(format!("made:{}", r.id)),
                batch,
            )
            .await
            .ok()
            .map(|(n, _)| n.id);
        let now = clock::now();
        let next = match (r.trigger, r.next_run_at) {
            (RoutineTrigger::Schedule, Some(n)) => {
                format!(" Next run: {}.", due::describe(n, owner, now))
            }
            _ => String::new(),
        };
        ToolOutcome::ok(
            format!(
                "Made routine #{} \"{}\" and started its trial run{} — the owner sees it on card \
                 #{} and can undo it there.{next} codeg keeps its schedule; do not schedule it yourself.",
                r.id,
                r.title,
                trial
                    .as_ref()
                    .map(|t| format!(" (run #{})", t.id))
                    .unwrap_or_default(),
                card.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
            ),
            json!({ "routine": view, "notice_id": card }),
        )
    }

    /// `routine_update`: change one of this assistant's routines, or pause,
    /// resume, delete or run it now. Made at once, with a card that can undo
    /// it; with `suggest`, or with the owner's "show me such changes first",
    /// a proposal card.
    pub async fn routine_update_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let Some(id) = args["routine_id"]
            .as_i64()
            .and_then(|i| i32::try_from(i).ok())
        else {
            return ToolOutcome::refused("`routine_id` is required; use routine_list");
        };
        let bot = self.bot().await;
        let r = match rsvc::get_of(&self.db.conn, bot, id).await {
            Ok(Some(r)) => r,
            _ => {
                return ToolOutcome::refused(format!("you have no routine #{id}; use routine_list"))
            }
        };
        let action = args["action"].as_str().unwrap_or("").to_string();
        let draft: Draft = match serde_json::from_value(strip(args)) {
            Ok(d) => d,
            Err(e) => return ToolOutcome::refused(format!("the change does not read: {e}")),
        };
        if !action.is_empty()
            && !matches!(action.as_str(), "pause" | "resume" | "delete" | "run_now")
        {
            return ToolOutcome::refused("`action` must be pause, resume, delete or run_now");
        }
        let base = draft_of(&r);
        let spec = if action.is_empty() {
            if draft == Draft::default() {
                return ToolOutcome::refused(
                    "nothing to change: give the fields to change, or `action`",
                );
            }
            match spec_of(&draft, Some(&base)) {
                Ok(s) => Some(s),
                Err(e) => return ToolOutcome::refused(e),
            }
        } else {
            None
        };
        if let Some(s) = &spec {
            if let Err(e) = self.check_spec(s).await {
                return ToolOutcome::refused(e);
            }
        }
        let reason = args["reason"].as_str().map(str::to_string);
        let owner = self.owner_tz().await;
        let batch = self.current_batch().await;
        let suggest = args["suggest"].as_bool() == Some(true);
        // The owner does not take suggestions now (6.7).
        if suggest {
            if let Some(no) = self.suggestions_closed().await {
                return no;
            }
        }
        // The owner sees such changes first (13.5).
        let confirm = !suggest && self.shows_changes_first().await;
        if suggest || confirm {
            let view = routine_view(&self.db.conn, r.clone(), owner, 1).await;
            // What the owner says yes to: a change of its fields shows the
            // routine as it would be (as it is now kept beside it); a pause,
            // a resume, a delete or a run shows it as it is.
            let shown = match &spec {
                Some(s) => {
                    let zone = zone_of(s.timezone.as_deref(), owner).name().to_string();
                    summary_of(s, Some(r.id), None, &zone)
                }
                None => serde_json::to_value(&view).unwrap_or(Value::Null),
            };
            let data = json!({
                "notice": "routine",
                "what": "proposal",
                "state": "open",
                "confirm": confirm,
                "routine": shown,
                "before": view,
                "action": action,
                "draft": spec.as_ref().map(Spec::draft),
                "reason": reason,
            });
            return match self
                .raise_routine_card(
                    if confirm {
                        format!("Routine change to confirm: {}", r.title)
                    } else {
                        format!("Suggested change to routine: {}", r.title)
                    },
                    json!({
                        "what": "proposal",
                        "why": if confirm { "confirm" } else { "suggest" },
                        "routine_id": r.id,
                        "action": action,
                        "draft": spec.as_ref().map(Spec::draft),
                    }),
                    data,
                    if confirm {
                        NoticeLevel::Normal
                    } else {
                        NoticeLevel::Low
                    },
                    None,
                    batch,
                )
                .await
            {
                Ok((n, _)) => ToolOutcome::ok(
                    format!(
                        "{}: the change to routine #{} is on card #{} for the owner; it is made \
                         only if they say so.",
                        if confirm {
                            "The owner sees such changes first"
                        } else {
                            "Suggested"
                        },
                        r.id,
                        n.id
                    ),
                    json!({ "notice_id": n.id, "state": "awaiting_owner" }),
                ),
                Err(e) => ToolOutcome::refused(e),
            };
        }
        if action == "run_now" {
            if !r.enabled {
                return ToolOutcome::refused(format!(
                    "routine #{} is paused; resume it first (`action: resume`)",
                    r.id
                ));
            }
            return match self.run_now(r.clone(), "now").await {
                Ok(run) => ToolOutcome::ok(
                    format!(
                        "Routine #{} \"{}\" runs now (run #{}).",
                        r.id, r.title, run.id
                    ),
                    json!({ "run_id": run.id }),
                ),
                Err(e) => ToolOutcome::refused(e),
            };
        }
        let before = json!({
            "draft": base,
            "enabled": r.enabled,
            "paused_reason": r.paused_reason,
            "deleted": false,
        });
        let changed = match &spec {
            Some(s) => self.apply_spec(&r, s).await,
            None => {
                if action == "resume" && r.kind == RoutineKind::Dispatch {
                    if let Err(e) = self.template_work(&r).await {
                        return ToolOutcome::refused(e);
                    }
                }
                self.routine_switch(&r, &action).await
            }
        };
        let after = match changed {
            Ok(a) => a,
            Err(e) => return ToolOutcome::refused(e),
        };
        let view = routine_view(&self.db.conn, after.clone(), owner, 1).await;
        let data = json!({
            "notice": "routine",
            "what": "changed",
            "state": "made",
            "routine": view,
            "action": if action.is_empty() { "edit" } else { action.as_str() },
            "before": before["draft"],
            "reason": reason,
        });
        let card = self
            .raise_routine_card(
                format!("Routine changed: {}", after.title),
                json!({ "what": "changed", "routine_id": r.id, "before": before }),
                data,
                NoticeLevel::Low,
                None,
                batch,
            )
            .await
            .ok()
            .map(|(n, _)| n.id);
        let done = match action.as_str() {
            "pause" => "paused",
            "resume" => "resumed",
            "delete" => "deleted",
            _ => "changed",
        };
        ToolOutcome::ok(
            format!(
                "Routine #{} \"{}\" {done}; card #{} shows the owner and can undo it.",
                r.id,
                after.title,
                card.map(|c| c.to_string()).unwrap_or_else(|| "?".into())
            ),
            json!({ "routine": view, "notice_id": card }),
        )
    }

    // ── the page ────────────────────────────────────────────────────────────

    /// The owner saved a routine in the editor: made and run once as a
    /// test, or changed. A card it came from (`notice_id`: an offer, a
    /// paused routine's) is settled with it.
    pub async fn routine_save(
        self: &Arc<Self>,
        id: Option<i32>,
        draft: Draft,
        notice_id: Option<i32>,
    ) -> Result<RoutineView, String> {
        let bot = self.bot().await;
        self.has_a_brain().await?;
        let owner = self.owner_tz().await;
        let card = match notice_id {
            Some(n) => {
                let notice = svc::get_notice_of(&self.db.conn, bot, n)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("no such card")?;
                Some(notice)
            }
            None => None,
        };
        let saved = match id {
            Some(id) => {
                let r = rsvc::get_of(&self.db.conn, bot, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("routine #{id} is gone"))?;
                let spec = spec_of(&draft, Some(&draft_of(&r)))?;
                let mut r = self.apply_spec(&r, &spec).await?;
                // A paused routine changed from its card ("use another"):
                // on again.
                if !r.enabled
                    && card.as_ref().is_some_and(|c| {
                        serde_json::from_str::<Value>(&c.payload)
                            .ok()
                            .is_some_and(|p| p["what"].as_str() == Some("paused"))
                    })
                {
                    r = self.routine_switch(&r, "resume").await?;
                }
                r
            }
            None => {
                let spec = spec_of(&draft, None)?;
                if let Some(c) = &card {
                    if !svc::move_notice(
                        &self.db.conn,
                        c.id,
                        &[NoticeState::Open],
                        NoticeState::Acting,
                    )
                    .await
                    .map_err(|e| e.to_string())?
                    {
                        return Err("this card was answered already".into());
                    }
                }
                let auth = match &card {
                    Some(c) => MakeAuth::Card { notice_id: c.id },
                    None => MakeAuth::Direct,
                };
                match self
                    .make_routine(&spec, if card.is_some() { "card" } else { "page" }, auth)
                    .await
                {
                    Ok((r, _, _)) => r,
                    Err(e) => {
                        if let Some(c) = &card {
                            let _ = svc::move_notice(
                                &self.db.conn,
                                c.id,
                                &[NoticeState::Acting],
                                NoticeState::Open,
                            )
                            .await;
                        }
                        return Err(e);
                    }
                }
            }
        };
        if let Some(c) = &card {
            let _ = svc::move_notice(
                &self.db.conn,
                c.id,
                &[NoticeState::Open, NoticeState::Acting],
                NoticeState::Acted,
            )
            .await;
            let view = routine_view(&self.db.conn, saved.clone(), owner, 1).await;
            let _ = self
                .routine_card_row(c, "made", json!({ "routine": view, "error": null }))
                .await;
        }
        Ok(routine_view(&self.db.conn, saved, owner, 3).await)
    }

    /// The owner's buttons on a routine: run now, pause, resume, delete.
    pub async fn routine_act(
        self: &Arc<Self>,
        id: i32,
        action: &str,
    ) -> Result<RoutineView, String> {
        let bot = self.bot().await;
        let r = rsvc::get_of(&self.db.conn, bot, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("routine #{id} is gone"))?;
        let owner = self.owner_tz().await;
        let after = match action {
            "run_now" => {
                self.run_now(r.clone(), "now").await?;
                rsvc::get(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .unwrap_or(r)
            }
            "resume" if r.kind == RoutineKind::Dispatch => {
                self.template_work(&r).await?;
                self.routine_switch(&r, action).await?
            }
            _ => self.routine_switch(&r, action).await?,
        };
        Ok(routine_view(&self.db.conn, after, owner, 3).await)
    }
}

/// The tool's arguments, without what is not part of the routine.
fn strip(args: &Value) -> Value {
    let mut v = args.clone();
    if let Some(m) = v.as_object_mut() {
        for k in ["suggest", "reason", "routine_id", "action"] {
            m.remove(k);
        }
    }
    v
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn run_id_of(e: &crate::db::entities::personal_agent_event::Model) -> Option<i32> {
    let p: Value = serde_json::from_str(e.payload.as_deref()?).ok()?;
    p["run_id"].as_i64().and_then(|i| i32::try_from(i).ok())
}

/// Every assistant's routines, for the page: one assistant's when `bot` is
/// given. Read from the record, wherever the assistants run.
pub async fn routines_of(
    db: &crate::db::AppDatabase,
    bot: Option<i32>,
) -> Result<Vec<RoutineView>, String> {
    let owner = match svc::primary_bot(&db.conn).await.or_failed() {
        Some(p) => {
            let prefs =
                crate::models::personal_agent_prefs::AccountView::from_settings(&p.settings).prefs;
            clock::zone_of(&prefs.time_zone)
        }
        None => clock::system_tz(),
    };
    let list = match bot {
        Some(b) => rsvc::list_of(&db.conn, b).await,
        None => rsvc::list_all(&db.conn).await,
    }
    .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in list {
        out.push(routine_view(&db.conn, r, owner, 3).await);
    }
    Ok(out)
}

/// A routine's runs, newest first.
pub async fn runs_of(
    db: &crate::db::AppDatabase,
    routine_id: i32,
    limit: u64,
) -> Result<Vec<RunView>, String> {
    let mut out = Vec::new();
    for r in rsvc::runs_of(&db.conn, routine_id, limit.clamp(1, 200))
        .await
        .map_err(|e| e.to_string())?
    {
        out.push(run_view(&db.conn, r).await);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn a_time_missed_by_more_than_half_its_gap_or_two_hours_is_not_made_up_for() {
        let tz = Tz::UTC;
        // Daily at 09:00: two hours late at most.
        let due = at("2026-11-12T09:00:00Z");
        assert!(matches!(
            due_now("0 9 * * *", tz, due, at("2026-11-12T09:30:00Z")),
            DueNow::Run { missed: 0, .. }
        ));
        assert!(matches!(
            due_now("0 9 * * *", tz, due, at("2026-11-12T12:00:00Z")),
            DueNow::Missed { times: 1, .. }
        ));
        // Hourly: half an hour.
        let due = at("2026-11-12T09:00:00Z");
        assert!(matches!(
            due_now("0 * * * *", tz, due, at("2026-11-12T09:20:00Z")),
            DueNow::Run { .. }
        ));
        // Three days away: the latest time is the one looked at.
        match due_now("0 9 * * *", tz, due, at("2026-11-15T09:10:00Z")) {
            DueNow::Run {
                at: when,
                missed,
                next,
            } => {
                assert_eq!(when, at("2026-11-15T09:00:00Z"));
                assert_eq!(missed, 3);
                assert_eq!(next, Some(at("2026-11-16T09:00:00Z")));
            }
            other => panic!("{other:?}"),
        }
        match due_now("0 9 * * *", tz, due, at("2026-11-15T13:00:00Z")) {
            DueNow::Missed { times, next, .. } => {
                assert_eq!(times, 4);
                assert_eq!(next, Some(at("2026-11-16T09:00:00Z")));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_routine_in_the_owners_zone_keeps_its_wall_clock_time() {
        let sh: Tz = "Asia/Shanghai".parse().unwrap();
        let after = at("2026-11-12T00:00:00Z");
        // 09:00 in Shanghai is 01:00 UTC.
        assert_eq!(
            next_run("0 9 * * *", sh, after),
            Some(at("2026-11-12T01:00:00Z"))
        );
        assert_eq!(zone_of(Some("owner"), sh), sh);
        assert_eq!(zone_of(None, sh), sh);
        assert_eq!(zone_of(Some("UTC"), sh), Tz::UTC);
        // Weekly at now: Thursday 12 Nov 2026, 15:04 there.
        let now = sh
            .with_ymd_and_hms(2026, 11, 12, 15, 4, 0)
            .unwrap()
            .with_timezone(&Utc);
        assert_eq!(weekly_at(sh, now), "4 15 * * 4");
    }

    #[test]
    fn a_draft_needs_one_trigger_and_a_dispatch_routine_its_work() {
        let d = Draft {
            title: Some("Deps".into()),
            what: Some("Check for security updates".into()),
            cron: Some("0 9 * * 1".into()),
            ..Default::default()
        };
        let s = spec_of(&d, None).unwrap();
        assert_eq!(s.kind, RoutineKind::Brain);
        assert_eq!(s.trigger, RoutineTrigger::Schedule);
        let both = Draft {
            event: Some(EventSpec {
                kind: "pr_checks_failed".into(),
                ..Default::default()
            }),
            ..d.clone()
        };
        assert!(spec_of(&both, None).is_err());
        let none = Draft {
            cron: None,
            ..d.clone()
        };
        assert!(spec_of(&none, None).is_err());
        let dispatch = Draft {
            kind: Some(RoutineKind::Dispatch),
            ..d.clone()
        };
        assert!(spec_of(&dispatch, None).is_err());
        let dispatch = Draft {
            kind: Some(RoutineKind::Dispatch),
            dispatch: Some(DispatchTemplate {
                mode: Some(DispatchMode::Chat),
                ..Default::default()
            }),
            ..d.clone()
        };
        assert!(spec_of(&dispatch, None).is_ok());
        // A change over what it was: an event replaces the schedule.
        let base = s.draft();
        let to_event = Draft {
            event: Some(EventSpec {
                kind: "task_status".into(),
                filter: EventFilter {
                    states: vec!["done".into()],
                    ..Default::default()
                },
            }),
            ..Default::default()
        };
        let changed = spec_of(&to_event, Some(&base)).unwrap();
        assert_eq!(changed.trigger, RoutineTrigger::Event);
        assert_eq!(changed.cron, None);
        assert_eq!(changed.title, "Deps");
        // `precheck: none` clears it.
        let with = Draft {
            precheck: Some(Precheck::ItemsWaiting { hours: 4 }),
            ..d.clone()
        };
        let with = spec_of(&with, None).unwrap();
        assert!(with.precheck.is_some());
        let cleared = spec_of(
            &Draft {
                precheck: Some(Precheck::None),
                ..Default::default()
            },
            Some(&with.draft()),
        )
        .unwrap();
        assert_eq!(cleared.precheck, None);
    }

    #[test]
    fn an_event_sets_off_only_the_routines_whose_kind_and_filter_it_fits() {
        let s = signal_entity::Model {
            id: 7,
            kind: "task_status".into(),
            key: "task:1:0:done".into(),
            bot_id: None,
            folder_id: Some(3),
            facts: json!({ "task_id": 1, "title": "x", "status": "done" }).to_string(),
            created_at: Utc::now(),
        };
        let spec = |f: EventFilter| EventSpec {
            kind: "task_status".into(),
            filter: f,
        };
        assert!(signal_matches(&spec(EventFilter::default()), false, &s));
        assert!(signal_matches(
            &spec(EventFilter {
                project_id: Some(3),
                states: vec!["DONE".into()],
                ..Default::default()
            }),
            false,
            &s
        ));
        assert!(!signal_matches(
            &spec(EventFilter {
                project_id: Some(4),
                ..Default::default()
            }),
            false,
            &s
        ));
        assert!(!signal_matches(
            &spec(EventFilter {
                states: vec!["failed".into()],
                ..Default::default()
            }),
            false,
            &s
        ));
        assert!(!signal_matches(
            &spec(EventFilter {
                mine: true,
                ..Default::default()
            }),
            false,
            &s
        ));
        assert!(!signal_matches(
            &EventSpec {
                kind: "dispatch_ended".into(),
                ..Default::default()
            },
            true,
            &s
        ));
    }

    #[test]
    fn a_dispatch_template_given_is_laid_over_the_one_it_had() {
        let base = Draft {
            title: Some("Deps".into()),
            what: Some("Check".into()),
            kind: Some(RoutineKind::Dispatch),
            cron: Some("0 9 * * 1".into()),
            dispatch: Some(DispatchTemplate {
                mode: Some(DispatchMode::Task),
                project_id: Some(2),
                title: Some("Weekly deps".into()),
                prompt: Some("Run cargo audit".into()),
                deliverable: Some("report".into()),
                done_when: Some("- every advisory listed".into()),
            }),
            ..Default::default()
        };
        // The editor's save: only what it shows.
        let edited = Draft {
            cron: Some("0 10 * * 1".into()),
            dispatch: Some(DispatchTemplate {
                mode: Some(DispatchMode::Task),
                project_id: Some(2),
                deliverable: Some("report".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        let s = spec_of(&edited, Some(&base)).unwrap();
        let t = s.dispatch.clone().unwrap();
        assert_eq!(t.title.as_deref(), Some("Weekly deps"));
        assert_eq!(t.prompt.as_deref(), Some("Run cargo audit"));
        assert_eq!(t.done_when.as_deref(), Some("- every advisory listed"));
        assert_eq!(s.cron.as_deref(), Some("0 10 * * 1"));
        // A whole snapshot (undo) is itself, with nothing laid under it.
        let whole = spec_of(&base, None).unwrap();
        assert_eq!(whole.draft(), base.clone());
    }

    #[test]
    fn a_forge_event_is_one_per_item_in_its_project() {
        assert_ne!(forge_event_key(false, 1, 42), forge_event_key(false, 2, 42));
        assert_ne!(forge_event_key(false, 1, 42), forge_event_key(true, 1, 42));
        assert_eq!(forge_event_key(true, 3, 7), "pr:3:7");
    }

    #[test]
    fn alike_requests_and_a_silent_reply() {
        assert!(alike("查一遍依赖有没有安全更新", "再查一遍依赖有没有安全更新") >= REPEAT_ALIKE);
        assert!(
            alike(
                "Check deps for security updates",
                "check deps for security updates!"
            ) >= REPEAT_ALIKE
        );
        assert!(alike("修一下登录页的样式", "看一下 CI 为什么红了") < REPEAT_ALIKE);
        assert!(is_silent("[[silent]]"));
        assert!(is_silent("  [[silent]]\n"));
        assert!(!is_silent("Nothing new. [[silent]]"));
    }
}
