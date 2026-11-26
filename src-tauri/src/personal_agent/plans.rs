//! Plans (7.6): big work split into steps, laid out by an assistant and
//! carried out by codeg.
//!
//! **Laid out.** `plan_create` takes a title, a goal and the steps: each
//! with who carries it out (a work assistant, or an executor config with a
//! mode and a project), what it is to do, what done looks like and which
//! steps it waits for. A native card shows the whole of it and how far it
//! got. The board has no dependencies of its own; this layer schedules.
//!
//! **Started.** At once — or, with the owner's "plans: show me first" (or
//! one of its steps being what they confirm first: a dispatch they confirm,
//! a message they confirm), on their [Start], which confirms its steps.
//!
//! **Carried out, with no model.** A step whose steps are done is handed
//! out: an executor config's as a dispatch (past the executor page's usage,
//! under the same limits as any), a work assistant's as a message wanting
//! an answer — whose answer is the step's conclusion. What the steps it
//! builds on came to rides along. Code work is done once it landed (merged,
//! or a pull request merged) — after its acceptance, when the assistant
//! accepts code; a report, a chat or a session once it ended.
//!
//! **A step that fails** wakes the plan's assistant, which may retry it,
//! hand it to another or change the plan (`plan_update`). Still failed once
//! that turn ended, the plan is stuck: the owner is told urgently. What does
//! not wait on the step goes on meanwhile. A step that cannot be handed out
//! (its assistant gone, or nothing set for its work to run on) fails the
//! same way: the assistant hands it to another, does it itself, or tells
//! the owner.
//!
//! **Stopped.** The owner's [Stop] hands out nothing new; what is under way
//! runs to its end, and each can be canceled from the card. [Go on] picks it
//! up again.
//!
//! **Changed.** `plan_update` takes effect at once; the card lists what
//! changed, and a change to steps that have not started can be taken back.
//!
//! **Done.** The owner hears it, and the assistant is woken to write the
//! summary card.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::sync::Arc;

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::dispatch::{cut, DispatchAuth, DispatchRequest, MAX_PROMPT_CHARS, MAX_TITLE_CHARS};
use super::engine::{enum_str, PersonalAgentEngine};
use super::messages::{display_name, MessageAuth, ResolvedMessage, Unnamed};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent_dispatch::{
    self as dispatch_entity, DispatchMode, DispatchState,
};
use crate::db::entities::personal_agent_event::EventState;
use crate::db::entities::personal_agent_message::MessageState;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_plan::{self as plan_entity, PlanState};
use crate::db::entities::personal_agent_plan_step::{self as step_entity, StepState, TargetKind};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_plan_service::{
    self as psvc, NewPlan, NewStep, PlanWrite, StepWrite,
};
use crate::db::service::personal_agent_service::{
    self as svc, LedgerSlot, Ledgered, NewNotice, NewRow,
};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_overview::Ladder;
use crate::models::personal_agent_prefs::{AskFirst, Prefs};

/// The event kind a plan wakes its assistant with.
pub const PLAN_EVENT: &str = "plan";
/// The most steps a plan has.
pub const MAX_STEPS: usize = 30;
/// The longest goal.
pub const MAX_GOAL_CHARS: usize = 2_000;
/// The longest step requirement: room is left for what it builds on.
pub const MAX_STEP_PROMPT_CHARS: usize = 16_000;
/// The longest reason on a change.
const MAX_REASON_CHARS: usize = 1_000;
/// What one step it builds on brings along, and all of them.
const DEP_RESULT_CHARS: usize = 1_200;
const DEP_RESULTS_CHARS: usize = 3_500;
/// A failure its assistant has not taken up in this long is the owner's.
const WAIT_FOR_BRAIN_MINS: i64 = 10;
/// How long ended plans stay in `plan_read`'s list.
const ENDED_LISTED_DAYS: i64 = 7;

// ── what is kept ────────────────────────────────────────────────────────────

/// One change made to a plan, as its card lists it, with what undoes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Change {
    pub at: DateTime<Utc>,
    /// `assistant` | `owner`
    pub by: String,
    pub items: Vec<ChangeItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// What each step was before: `None` for one the change added.
    #[serde(default)]
    pub undo: Vec<Undo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title_before: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub goal_before: Option<Option<String>>,
    /// Taken back by the owner; the steps that had started by then kept it.
    #[serde(default)]
    pub undone: bool,
    #[serde(default)]
    pub kept: Vec<i32>,
}

/// One line of a change: what happened to which step.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChangeItem {
    /// `added` | `changed` | `removed` | `retry` | `title` | `goal` | `stop`
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seq: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The fields a `changed` step changed.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fields: Vec<String>,
}

/// What a step was before a change.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Undo {
    pub seq: i32,
    pub before: Option<NewStep>,
    #[serde(default)]
    pub state: Option<StepState>,
}

/// The news told of a plan.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Told {
    /// The failures the owner was told the plan is stuck on.
    #[serde(default)]
    pub stuck: Vec<String>,
    #[serde(default)]
    pub done: bool,
}

fn changes_of(p: &plan_entity::Model) -> Vec<Change> {
    serde_json::from_str(&p.changes).unwrap_or_default()
}

fn told_of(p: &plan_entity::Model) -> Told {
    p.told
        .as_deref()
        .and_then(|t| serde_json::from_str(t).ok())
        .unwrap_or_default()
}

/// A value with its object keys in order, so the same call reads the same.
fn canonical(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let sorted: BTreeMap<&String, Value> =
                m.iter().map(|(k, v)| (k, canonical(v))).collect();
            Value::Object(sorted.into_iter().map(|(k, v)| (k.clone(), v)).collect())
        }
        Value::Array(a) => Value::Array(a.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

/// The ledger key of a `plan_update`: the plan and what the call changes —
/// its reason left out, as a turn delivered again words it afresh.
fn update_key(plan_id: i32, args: &Value) -> String {
    use sha2::{Digest, Sha256};
    let mut a = canonical(args);
    if let Value::Object(m) = &mut a {
        m.remove("reason");
    }
    let digest = Sha256::digest(a.to_string().as_bytes());
    let hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    format!("plan_update|{plan_id}|{hex}")
}

fn wait_key(step: &step_entity::Model) -> String {
    format!("plan-step:{}:{}", step.id, step.failures)
}

// ── what the assistant writes ───────────────────────────────────────────────

/// A step as `plan_create` / `plan_update` read it: every field optional,
/// for an update lays its fields over the step it names.
#[derive(Debug, Clone, Default)]
pub struct StepArgs {
    pub id: Option<i32>,
    pub title: Option<String>,
    /// Who does it: `self` (the plan's own assistant does it itself), or a
    /// work assistant's id or name.
    pub to: Option<String>,
    pub mode: Option<String>,
    pub project_id: Option<Option<i32>>,
    pub deliverable: Option<String>,
    pub prompt: Option<String>,
    pub done_when: Option<Option<String>>,
    pub depends_on: Option<Vec<i32>>,
    pub remove: bool,
    pub retry: bool,
}

fn text_of(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// An input reference, written as text (`"#58"`, `"m12"`) or a number.
fn reference_of(v: &Value, key: &str) -> Option<String> {
    match v.get(key)? {
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    }
}

fn int_of(v: &Value) -> Option<i32> {
    v.as_i64()
        .or_else(|| v.as_str()?.trim().trim_start_matches('#').parse().ok())
        .and_then(|n| i32::try_from(n).ok())
}

fn int_at(v: &Value, key: &str) -> Option<i32> {
    v.get(key).and_then(int_of)
}

/// Read one step the assistant wrote.
pub fn step_args(v: &Value) -> Result<StepArgs, String> {
    if !v.is_object() {
        return Err("each step is an object".into());
    }
    let depends_on = match v.get("depends_on") {
        None | Some(Value::Null) => None,
        Some(Value::Array(a)) => {
            let mut out = Vec::new();
            for x in a {
                out.push(int_of(x).ok_or("`depends_on` lists step numbers, such as [1, 2]")?);
            }
            Some(out)
        }
        Some(x) => Some(vec![
            int_of(x).ok_or("`depends_on` lists step numbers, such as [1, 2]")?
        ]),
    };
    // What an older plan named its executor by is no part of a step any
    // more: refused, so it is not silently done by the plan's assistant.
    for k in ["bot", "assistant_id", "kind"] {
        if v.get(k).is_some() {
            return Err(format!(
                "a step has no `{k}`: `to` names who carries it out — \"self\" or an \
                 assistant's id or name, from bot_list"
            ));
        }
    }
    let to = match v.get("to") {
        None | Some(Value::Null) => None,
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Some(_) => {
            return Err(
                "`to` takes \"self\" or an assistant's id or name, from bot_list".into(),
            )
        }
    };
    let flag = |k: &str| v.get(k).and_then(|x| x.as_bool()) == Some(true);
    Ok(StepArgs {
        id: int_at(v, "id"),
        title: text_of(v, "title"),
        to,
        mode: text_of(v, "mode"),
        project_id: match v.get("project_id") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(x) => Some(Some(int_of(x).ok_or("`project_id` is a project's id")?)),
        },
        deliverable: text_of(v, "deliverable"),
        prompt: text_of(v, "prompt"),
        done_when: match v.get("done_when") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(_) => Some(text_of(v, "done_when")),
        },
        depends_on,
        remove: flag("remove"),
        retry: flag("retry"),
    })
}

/// Whether the steps' dependencies are steps of the plan, none of them its
/// own, and go round nowhere. The refusal names what is wrong.
pub fn check_order(steps: &[(i32, Vec<i32>)]) -> Result<(), String> {
    let seqs: BTreeSet<i32> = steps.iter().map(|(s, _)| *s).collect();
    for (s, deps) in steps {
        for d in deps {
            if d == s {
                return Err(format!("step {s} cannot depend on itself"));
            }
            if !seqs.contains(d) {
                return Err(format!(
                    "step {s} depends on step {d}, which the plan does not have"
                ));
            }
        }
    }
    // Kahn: whatever is left once every step with no open dependency is
    // taken away goes round.
    let mut open: BTreeMap<i32, BTreeSet<i32>> = steps
        .iter()
        .map(|(s, deps)| (*s, deps.iter().copied().collect()))
        .collect();
    loop {
        let free: Vec<i32> = open
            .iter()
            .filter(|(_, deps)| deps.is_empty())
            .map(|(s, _)| *s)
            .collect();
        if free.is_empty() {
            break;
        }
        for s in &free {
            open.remove(s);
        }
        for deps in open.values_mut() {
            for s in &free {
                deps.remove(s);
            }
        }
    }
    if open.is_empty() {
        Ok(())
    } else {
        let round: Vec<String> = open.keys().map(|s| s.to_string()).collect();
        Err(format!(
            "steps {} wait for each other in a circle; make one of them go first",
            round.join(", ")
        ))
    }
}

/// The owner's settings send this step to them first: a dispatch they
/// confirm first, or a message they confirm first.
pub fn needs_confirm(prefs: &Prefs, s: &NewStep) -> bool {
    match s.target_kind {
        TargetKind::Own => match s.mode.as_deref().and_then(mode_of) {
            Some(m) => prefs.confirms(m),
            None => false,
        },
        TargetKind::Bot => prefs.messages == AskFirst::Ask,
    }
}

fn mode_of(m: &str) -> Option<DispatchMode> {
    match m {
        "task" => Some(DispatchMode::Task),
        "chat" => Some(DispatchMode::Chat),
        "session" => Some(DispatchMode::Session),
        _ => None,
    }
}

/// The fields `a` and `b` differ in, by the names the assistant writes.
fn fields_changed(a: &NewStep, b: &NewStep) -> Vec<String> {
    let mut out = Vec::new();
    if a.title != b.title {
        out.push("title".into());
    }
    if a.target_kind != b.target_kind || a.target_id != b.target_id {
        out.push("who".into());
    }
    if a.mode != b.mode {
        out.push("mode".into());
    }
    if a.project_id != b.project_id {
        out.push("project".into());
    }
    if a.deliverable != b.deliverable {
        out.push("deliverable".into());
    }
    if a.prompt != b.prompt {
        out.push("prompt".into());
    }
    if a.done_when != b.done_when {
        out.push("done_when".into());
    }
    if a.depends_on != b.depends_on {
        out.push("depends_on".into());
    }
    out
}

// ── what the card and the tools show ────────────────────────────────────────

/// A step as the card and `plan_read` show it.
#[derive(Debug, Clone, Serialize)]
pub struct StepView {
    pub seq: i32,
    pub title: String,
    pub target_kind: TargetKind,
    pub target_id: i32,
    pub target_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<crate::models::AgentType>,
    #[serde(skip_serializing_if = "Value::is_null")]
    pub face: Value,
    pub mode: Option<String>,
    pub project_id: Option<i32>,
    pub project_name: Option<String>,
    pub deliverable: Option<String>,
    pub prompt: String,
    pub done_when: Option<String>,
    pub depends_on: Vec<i32>,
    pub state: StepState,
    pub confirmed: bool,
    /// Every step it waits for is done.
    pub ready: bool,
    /// Where its work stands on the PR ladder (8.5), while it runs.
    pub ladder: Option<Ladder>,
    pub dispatch_id: Option<i32>,
    pub message_id: Option<i32>,
    pub work_task_id: Option<i32>,
    pub conversation_id: Option<i32>,
    pub conversation_folder_id: Option<i32>,
    pub result: Option<String>,
    pub error: Option<String>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
}

/// A change as the card shows it.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeView {
    pub index: usize,
    pub at: DateTime<Utc>,
    pub by: String,
    pub items: Vec<ChangeItem>,
    pub reason: Option<String>,
    /// Something of it can still be taken back: a step it touched has not
    /// started.
    pub undoable: bool,
    pub undone: bool,
    pub kept: Vec<i32>,
}

/// A plan as the card and `plan_read` show it.
#[derive(Debug, Clone, Serialize)]
pub struct PlanView {
    pub id: i32,
    pub title: String,
    pub goal: Option<String>,
    pub state: PlanState,
    pub stuck_reason: Option<String>,
    pub steps: Vec<StepView>,
    pub changes: Vec<ChangeView>,
    pub done: usize,
    pub total: usize,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub ended_at: Option<DateTime<Utc>>,
}

impl PlanView {
    /// What the card's notice says it stands for: the owner's start, a step
    /// of theirs to confirm, stuck — or nothing of theirs.
    fn need(&self) -> &'static str {
        match self.state {
            PlanState::Draft => "draft",
            PlanState::Stuck => "stuck",
            PlanState::Running
                if self
                    .steps
                    .iter()
                    .any(|s| s.state == StepState::Pending && s.ready && !s.confirmed) =>
            {
                "confirm"
            }
            s => enum_str_static(s),
        }
    }
}

fn enum_str_static(s: PlanState) -> &'static str {
    match s {
        PlanState::Draft => "draft",
        PlanState::Running => "running",
        PlanState::Stuck => "stuck",
        PlanState::Stopped => "stopped",
        PlanState::Done => "done",
        PlanState::Canceled => "canceled",
    }
}

fn step_state_word(s: StepState) -> &'static str {
    match s {
        StepState::Pending => "not started",
        StepState::Running => "under way",
        StepState::Done => "done",
        StepState::Failed => "failed",
        StepState::Canceled => "canceled",
        StepState::Stopped => "stopped",
    }
}

fn who_of(s: &StepView) -> String {
    match s.target_kind {
        TargetKind::Bot => format!("work assistant {} (#{})", s.target_name, s.target_id),
        TargetKind::Own => format!(
            "itself · {}{}",
            s.mode.as_deref().unwrap_or("?"),
            s.project_name
                .as_deref()
                .map(|p| format!(" in {p}"))
                .unwrap_or_default(),
        ),
    }
}

/// The plan in words, as the brain reads it (and as the card's row says).
pub fn plan_text(v: &PlanView, full: bool) -> String {
    let mut out = format!(
        "Plan #{} \"{}\" — {} ({} of {} steps done).",
        v.id,
        v.title,
        match v.state {
            PlanState::Draft => "waiting for the owner's Start",
            PlanState::Running => "running",
            PlanState::Stuck => "stuck",
            PlanState::Stopped => "stopped by the owner",
            PlanState::Done => "done",
            PlanState::Canceled => "canceled",
        },
        v.done,
        v.total
    );
    if let Some(g) = &v.goal {
        out.push_str(&format!("\nGoal: {g}"));
    }
    if let Some(r) = &v.stuck_reason {
        out.push_str(&format!("\nStuck: {r}"));
    }
    for s in &v.steps {
        let deps = if s.depends_on.is_empty() {
            String::new()
        } else {
            format!(
                " · after {}",
                s.depends_on
                    .iter()
                    .map(|d| d.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        let mut line = format!(
            "\n{}. {} — {}{} · {}",
            s.seq,
            s.title,
            who_of(s),
            deps,
            step_state_word(s.state)
        );
        if s.state == StepState::Pending && !s.confirmed {
            line.push_str(" (waits for the owner to confirm it)");
        }
        if let Some(d) = s.dispatch_id {
            line.push_str(&format!(" · dispatch #{d}"));
        }
        if let Some(m) = s.message_id {
            line.push_str(&format!(" · message m{m}"));
        }
        if let Some(l) = s.ladder.filter(|_| s.state == StepState::Running) {
            line.push_str(&format!(" ({})", enum_str(&l)));
        }
        if let Some(e) = &s.error {
            if matches!(s.state, StepState::Failed | StepState::Canceled) {
                line.push_str(&format!(" — {}", cut(e, 300)));
            }
        }
        if full {
            if let Some(r) = &s.result {
                line.push_str(&format!("\n   came to: {}", cut(r, 600)));
            }
        }
        out.push_str(&line);
    }
    out
}

/// What the steps a step builds on came to, as its brief carries it.
fn builds_on(steps: &[step_entity::Model], s: &step_entity::Model) -> String {
    let deps = s.deps();
    let mut out = String::new();
    for d in steps.iter().filter(|x| deps.contains(&x.seq)) {
        let r = d.result.as_deref().map(str::trim).filter(|r| !r.is_empty());
        let line = format!(
            "- Step {} \"{}\" ({}): {}\n",
            d.seq,
            d.title,
            d.target_name,
            r.map(|r| cut(r, DEP_RESULT_CHARS))
                .unwrap_or_else(|| "done.".into())
        );
        if out.chars().count() + line.chars().count() > DEP_RESULTS_CHARS {
            out.push_str("- …\n");
            break;
        }
        out.push_str(&line);
    }
    out
}

/// The brief a step goes out with: what it is to do, its place in the
/// plan, what the steps it builds on came to.
fn step_brief(
    p: &plan_entity::Model,
    steps: &[step_entity::Model],
    s: &step_entity::Model,
) -> String {
    let mut out = s.prompt.trim().to_string();
    if s.target_kind == TargetKind::Bot {
        if let Some(w) = s.done_when.as_deref().filter(|w| !w.trim().is_empty()) {
            out.push_str(&format!("\n\nDone when:\n{}", w.trim()));
        }
    }
    out.push_str(&format!(
        "\n\n—— Part of a plan ——\nThis is step {} of {} of the plan \"{}\"{}. codeg hands out \
         the steps one by one; do only this one.",
        s.seq,
        steps.len(),
        p.title,
        p.goal
            .as_deref()
            .map(|g| format!(" ({})", cut(g, 300)))
            .unwrap_or_default()
    ));
    let on = builds_on(steps, s);
    if !on.is_empty() {
        out.push_str(&format!(
            "\nWhat the steps it builds on came to:\n{}",
            on.trim_end()
        ));
    }
    if s.target_kind == TargetKind::Bot {
        out.push_str(
            "\nWhen you are done, answer this message (bot_message with `reply_to`) with your \
             conclusion — what you found or did, and what the next steps should know: your \
             answer is what the plan goes on with.",
        );
    }
    cut(&out, MAX_PROMPT_CHARS)
}

// ── how a step stands ───────────────────────────────────────────────────────

/// What a running step's work came to.
#[derive(Debug, Clone, PartialEq)]
enum Outcome {
    Running,
    /// It lost what carries it out between being claimed and handed out (a
    /// restart): hand it out again, under the same operation.
    Unsent,
    Done(Option<String>),
    Failed(String),
    Canceled(String),
}

/// What a dispatch's state means for its step: code work is done once it
/// landed, a report or a conversation once it ended.
fn dispatch_outcome(
    d: &dispatch_entity::Model,
    task: Option<&crate::db::entities::work_task::Model>,
    pr: Option<&crate::models::personal_agent_overview::PrFacts>,
    retrying: bool,
) -> Outcome {
    let excerpt = d.result_excerpt.clone();
    match d.state {
        DispatchState::Queued | DispatchState::Running | DispatchState::WaitingInput => {
            Outcome::Running
        }
        DispatchState::Interrupted if retrying => Outcome::Running,
        DispatchState::Interrupted => Outcome::Failed(
            d.error
                .clone()
                .unwrap_or_else(|| "a restart interrupted it".into()),
        ),
        DispatchState::Failed => {
            Outcome::Failed(d.error.clone().unwrap_or_else(|| "its work failed".into()))
        }
        DispatchState::Canceled => Outcome::Canceled(
            d.error
                .clone()
                .unwrap_or_else(|| "its work was canceled".into()),
        ),
        DispatchState::HandedOver => {
            Outcome::Canceled("the owner took its conversation over".into())
        }
        DispatchState::Review => match task {
            Some(t) if d.deliverable.as_deref() == Some("report") || t.files_changed == Some(0) => {
                Outcome::Done(excerpt)
            }
            // Kept in review after its delivery to a pull request: it lands
            // through that pull request, whatever the board says.
            Some(t) if super::watch::kept_on_pr(t) => {
                match super::watch::with_pr(Ladder::PrOpen, pr) {
                    Ladder::Merged => Outcome::Done(excerpt),
                    Ladder::PrClosed => {
                        Outcome::Failed("its pull request was closed without being merged".into())
                    }
                    _ => Outcome::Running,
                }
            }
            // Code work waits for its acceptance and its merge.
            Some(_) => Outcome::Running,
            None => Outcome::Done(excerpt),
        },
        DispatchState::Completed => match (d.mode, task) {
            (DispatchMode::Task, Some(t)) => {
                match super::watch::with_pr(super::ladder::task_ladder(t), pr) {
                    Ladder::Merged | Ladder::Done => Outcome::Done(excerpt),
                    Ladder::PrClosed => {
                        Outcome::Failed("its pull request was closed without being merged".into())
                    }
                    Ladder::Canceled => Outcome::Canceled("its task was canceled".into()),
                    Ladder::Failed => Outcome::Failed("its task failed".into()),
                    // A pull request waiting for its checks or its merge.
                    _ => Outcome::Running,
                }
            }
            _ => Outcome::Done(excerpt),
        },
    }
}

// ── the engine ──────────────────────────────────────────────────────────────

impl PersonalAgentEngine {
    // ── laying one out ──────────────────────────────────────────────────────

    /// A step made concrete: its target resolved and checked, its texts in
    /// bounds. `base` is the step an update lays its fields over.
    async fn resolve_step(
        &self,
        a: &StepArgs,
        seq: i32,
        base: Option<&NewStep>,
        prefs: &Prefs,
    ) -> Result<NewStep, String> {
        let at = |e: String| format!("step {seq}: {e}");
        let title = a
            .title
            .clone()
            .or_else(|| base.map(|b| b.title.clone()))
            .map(|t| cut(&t, MAX_TITLE_CHARS))
            .filter(|t| !t.is_empty())
            .ok_or_else(|| at("`title` is required".into()))?;
        let prompt = a
            .prompt
            .clone()
            .or_else(|| base.map(|b| b.prompt.clone()))
            .filter(|p| !p.trim().is_empty())
            .ok_or_else(|| at("`prompt` (what it is to do) is required".into()))?;
        if prompt.chars().count() > MAX_STEP_PROMPT_CHARS {
            return Err(at(format!(
                "`prompt` is longer than {MAX_STEP_PROMPT_CHARS} characters"
            )));
        }
        let done_when = match &a.done_when {
            Some(w) => w.clone(),
            None => base.and_then(|b| b.done_when.clone()),
        };
        if done_when
            .as_deref()
            .is_some_and(|w| w.chars().count() > super::dispatch::MAX_DONE_WHEN_CHARS)
        {
            return Err(at(format!(
                "`done_when` is longer than {} characters",
                super::dispatch::MAX_DONE_WHEN_CHARS
            )));
        }
        let depends_on = a
            .depends_on
            .clone()
            .or_else(|| base.map(|b| b.depends_on.clone()))
            .unwrap_or_default();
        let depends_on: Vec<i32> = depends_on
            .into_iter()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        // Who: what it names now, else what it had, else the plan's own
        // assistant itself. `self` — or its own name — takes a step back.
        let me = self.bot().await;
        let named = match a.to.as_deref() {
            None => None,
            Some(t) if t.eq_ignore_ascii_case("self") => Some(None),
            Some(t) => {
                let b = self.receiver(t).await.map_err(at)?;
                Some((b.id != me).then_some(b))
            }
        };
        let base_bot = base.filter(|b| b.target_kind == TargetKind::Bot);
        let to_bot = match &named {
            Some(Some(b)) => Some(b.clone()),
            Some(None) => None,
            None => match base_bot {
                // Who it had stays — and one gone is said, never taken for
                // the plan's own assistant.
                Some(b) => Some(
                    svc::get_bot(&self.db.conn, b.target_id)
                        .await
                        .ok()
                        .flatten()
                        .ok_or_else(|| {
                            at(format!(
                                "{} is gone: say who carries it out now with `to` (\"self\" or \
                                 another assistant, from bot_list)",
                                b.target_name
                            ))
                        })?,
                ),
                None => None,
            },
        };
        let mut step = if let Some(b) = to_bot {
            if a.mode.is_some() || matches!(a.project_id, Some(Some(_))) || a.deliverable.is_some() {
                return Err(at(
                    "a step for another assistant takes no mode, project or deliverable: it \
                     decides how to do it. To do it yourself, give `to: \"self\"`"
                        .into(),
                ));
            }
            NewStep {
                seq,
                title,
                target_kind: TargetKind::Bot,
                target_id: b.id,
                target_name: display_name(&b),
                mode: None,
                project_id: None,
                deliverable: None,
                prompt,
                done_when,
                depends_on,
                confirmed: true,
            }
        } else {
            // Its own: what it had, when it stays its own.
            let keep = base.filter(|b| named.is_none() && b.target_kind == TargetKind::Own);
            {
                let mode = a
                    .mode
                    .clone()
                    .or_else(|| keep.and_then(|b| b.mode.clone()))
                    .ok_or_else(|| {
                        at("`mode` (task, chat or session) is required for a step you do yourself"
                            .into())
                    })?;
                let dmode = mode_of(&mode)
                    .ok_or_else(|| at("`mode` must be task, chat or session".into()))?;
                let project_id = match a.project_id {
                    Some(p) => p,
                    None => keep.and_then(|b| b.project_id),
                };
                let deliverable = match (&a.deliverable, dmode) {
                    (_, DispatchMode::Chat | DispatchMode::Session) => None,
                    (Some(d), _) if d == "change" || d == "report" => Some(d.clone()),
                    (Some(_), _) => {
                        return Err(at("`deliverable` must be change or report".into()))
                    }
                    (None, _) => keep
                        .and_then(|b| b.deliverable.clone())
                        .or_else(|| Some("change".into())),
                };
                // Checked as the dispatch it becomes: the project and the
                // texts. What runs it is taken when the step comes up.
                let req = DispatchRequest {
                    mode: dmode,
                    title: title.clone(),
                    prompt: prompt.clone(),
                    project_id,
                    report: deliverable.as_deref() == Some("report"),
                    on_done: None,
                    done_when: done_when.clone(),
                    replaces: None,
                };
                self.validate_dispatch(&req).await.map_err(at)?;
                let own = self.agent_row().await;
                NewStep {
                    seq,
                    title,
                    target_kind: TargetKind::Own,
                    target_id: me,
                    target_name: own.as_ref().map(display_name).unwrap_or_default(),
                    mode: Some(mode),
                    project_id,
                    deliverable,
                    prompt,
                    done_when,
                    depends_on,
                    confirmed: true,
                }
            }
        };
        step.confirmed = !needs_confirm(prefs, &step);
        Ok(step)
    }

    /// `plan_create`: lay a plan out. Started at once, or — when the owner
    /// sees plans first, or a step is one they confirm first — put on its
    /// card for their [Start].
    pub async fn plan_create_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let Some(title) = text_of(args, "title").map(|t| cut(&t, MAX_TITLE_CHARS)) else {
            return ToolOutcome::refused("`title` is required");
        };
        let goal = text_of(args, "goal");
        if goal
            .as_deref()
            .is_some_and(|g| g.chars().count() > MAX_GOAL_CHARS)
        {
            return ToolOutcome::refused(format!(
                "`goal` is longer than {MAX_GOAL_CHARS} characters"
            ));
        }
        let raw = match args.get("steps") {
            Some(Value::Array(a)) if !a.is_empty() => a.clone(),
            _ => return ToolOutcome::refused("`steps` lists the plan's steps, at least one"),
        };
        if raw.len() > MAX_STEPS {
            return ToolOutcome::refused(format!(
                "a plan has at most {MAX_STEPS} steps; split the work into plans that follow \
                 each other"
            ));
        }
        let prefs = self.prefs().await;
        let mut steps = Vec::new();
        for (i, v) in raw.iter().enumerate() {
            let seq = i as i32 + 1;
            let a = match step_args(v) {
                Ok(a) => a,
                Err(e) => return ToolOutcome::refused(format!("step {seq}: {e}")),
            };
            if a.id.is_some_and(|id| id != seq) {
                return ToolOutcome::refused(format!(
                    "step {seq}: steps are numbered by their order from 1; leave `id` out or \
                     write {seq}"
                ));
            }
            match self.resolve_step(&a, seq, None, &prefs).await {
                Ok(s) => steps.push(s),
                Err(e) => return ToolOutcome::refused(e),
            }
        }
        if let Err(e) = check_order(
            &steps
                .iter()
                .map(|s| (s.seq, s.depends_on.clone()))
                .collect::<Vec<_>>(),
        ) {
            return ToolOutcome::refused(e);
        }
        let input = match self
            .input_for(reference_of(args, "for").as_deref(), Unnamed::Refuse)
            .await
        {
            Ok(i) => i,
            Err(e) => return ToolOutcome::refused(e),
        };
        let lineage = self.lineage_of(input.as_ref()).await;
        let to_confirm: Vec<i32> = steps
            .iter()
            .filter(|s| !s.confirmed)
            .map(|s| s.seq)
            .collect();
        let show_first = prefs.plans == AskFirst::Ask || !to_confirm.is_empty();
        let bot = self.bot().await;
        let batch = self.current_batch().await;
        let key = format!("plan_create:{}", title.to_lowercase());
        let slot = match self.ledger_batch().await {
            Some((batch_id, scope)) => {
                match svc::ledger_entries(&self.db.conn, &scope, &key).await {
                    Ok(earlier) => {
                        if let Some(e) = earlier.iter().find(|e| {
                            e.state == crate::db::entities::personal_agent_action::ActionState::Committed
                        }) {
                            return self.earlier_plan(e).await;
                        }
                    }
                    Err(e) => return ToolOutcome::refused(e.to_string()),
                }
                Some(LedgerSlot::in_batch(
                    batch_id,
                    key,
                    super::ledger::fresh_op_id(),
                ))
            }
            None => None,
        };
        let new = NewPlan {
            bot_id: bot,
            title: title.clone(),
            goal,
            state: if show_first {
                PlanState::Draft
            } else {
                PlanState::Running
            },
            origin_batch_id: batch,
            for_input: lineage.for_input.clone(),
            origin_bot_id: lineage.origin_bot_id,
            origin_row_id: lineage.origin_row_id,
            thread_id: lineage.thread_id,
        };
        let made = match psvc::create(
            &self.db.conn,
            new,
            steps,
            slot.as_ref(),
            Some(json!({ "title": title })),
        )
        .await
        {
            Ok(Ledgered::New(p)) => p,
            Ok(Ledgered::Earlier(e)) => return self.earlier_plan(&e).await,
            Err(e) => return ToolOutcome::refused(e.to_string()),
        };
        let notice = match self.ensure_plan_card(made.id, batch).await {
            Ok(n) => Some(n),
            Err(e) => {
                tracing::warn!("[personal_agent] plan #{} card not raised: {e}", made.id);
                None
            }
        };
        if !show_first {
            self.advance_plan(made.id).await;
        }
        let view = match self.plan_view(made.id).await {
            Some(v) => v,
            None => return ToolOutcome::refused("the plan was made, and then could not be read"),
        };
        let started: Vec<String> = view
            .steps
            .iter()
            .filter(|s| s.state == StepState::Running)
            .map(|s| match (s.dispatch_id, s.message_id) {
                (Some(d), _) => format!("step {} → dispatch #{d}", s.seq),
                (_, Some(m)) => format!("step {} → message m{m} to {}", s.seq, s.target_name),
                _ => format!("step {}", s.seq),
            })
            .collect();
        let text = if show_first {
            format!(
                "Plan #{} \"{}\" is on card #{} for the owner, as you laid it out: it starts \
                 when they press Start ({}). You will hear when it does; do not hand its steps \
                 out yourself.\n\n{}",
                made.id,
                made.title,
                notice.map(|n| n.to_string()).unwrap_or_else(|| "?".into()),
                if to_confirm.is_empty() {
                    "they asked to see plans first".to_string()
                } else {
                    format!(
                        "they confirm steps like {} first",
                        to_confirm
                            .iter()
                            .map(|s| s.to_string())
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                },
                plan_text(&view, false)
            )
        } else {
            format!(
                "Plan #{} \"{}\" is made and started{}. codeg carries it out from here: it hands \
                 out each step once the steps it depends on are done (code work once it landed), \
                 wakes you when one fails, and tells the owner when the plan is done or stuck. \
                 Change it with plan_update; do not hand its steps out yourself.\n\n{}",
                made.id,
                made.title,
                if started.is_empty() {
                    String::new()
                } else {
                    format!(": {}", started.join(", "))
                },
                plan_text(&view, false)
            )
        };
        ToolOutcome::ok(text, json!({ "plan": view, "notice_id": notice }))
    }

    async fn earlier_plan(
        &self,
        entry: &crate::db::entities::personal_agent_action::Model,
    ) -> ToolOutcome {
        let Some(id) = entry.ref_id.as_deref().and_then(|r| r.parse::<i32>().ok()) else {
            return ToolOutcome::refused(
                "an earlier identical call is on record, but not its plan",
            );
        };
        if let Err(e) = self.ensure_plan_card(id, None).await {
            tracing::warn!("[personal_agent] plan #{id} card not raised: {e}");
        }
        match self.plan_view(id).await {
            Some(v) => ToolOutcome::ok(
                format!(
                    "Already laid out by the turn this delivery repeats: plan #{id}.\n\n{}",
                    plan_text(&v, false)
                ),
                json!({ "plan": v, "earlier": true }),
            ),
            None => {
                ToolOutcome::refused(format!("plan #{id} of an earlier identical call is gone"))
            }
        }
    }

    /// What a re-delivered turn's same `plan_update` answers.
    async fn plan_changed_before(&self, id: i32) -> ToolOutcome {
        let view = self.plan_view(id).await;
        ToolOutcome::ok(
            format!(
                "Already changed by the turn this delivery repeats: plan #{id} is as that change \
                 left it.{}",
                view.as_ref()
                    .map(|v| format!("\n\n{}", plan_text(v, false)))
                    .unwrap_or_default()
            ),
            json!({ "plan": view, "earlier": true }),
        )
    }

    /// `plan_read`: one plan in full, or this assistant's plans.
    pub async fn plan_read_call(&self, args: &Value) -> ToolOutcome {
        let bot = self.bot().await;
        if let Some(id) = int_at(args, "plan_id") {
            return match psvc::get_of(&self.db.conn, bot, id).await {
                Ok(Some(_)) => match self.plan_view(id).await {
                    Some(v) => ToolOutcome::ok(plan_text(&v, true), json!({ "plan": v })),
                    None => ToolOutcome::refused(format!("plan #{id} could not be read")),
                },
                Ok(None) => {
                    ToolOutcome::refused(format!("you have no plan #{id}; plan_read lists yours"))
                }
                Err(e) => ToolOutcome::refused(e.to_string()),
            };
        }
        let mut plans = psvc::of_bot(
            &self.db.conn,
            bot,
            &[
                PlanState::Draft,
                PlanState::Running,
                PlanState::Stuck,
                PlanState::Stopped,
            ],
        )
        .await
        .unwrap_or_default();
        plans.extend(
            psvc::ended_since(
                &self.db.conn,
                bot,
                super::clock::now() - Duration::days(ENDED_LISTED_DAYS),
            )
            .await
            .unwrap_or_default(),
        );
        if plans.is_empty() {
            return ToolOutcome::ok(
                "You have no plans. plan_create lays one out.",
                json!({ "plans": [] }),
            );
        }
        let mut views = Vec::new();
        for p in plans {
            if let Some(v) = self.plan_view(p.id).await {
                views.push(v);
            }
        }
        let text = views
            .iter()
            .map(|v| plan_text(v, false))
            .collect::<Vec<_>>()
            .join("\n\n");
        ToolOutcome::ok(text, json!({ "plans": views }))
    }

    /// `plan_update`: change a plan of this assistant's — its title, its
    /// goal, steps added, changed, retried or removed — or stop it. At once;
    /// the card lists the change, and the owner can take back what touched
    /// steps that have not started.
    pub async fn plan_update_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let bot = self.bot().await;
        let Some(id) = int_at(args, "plan_id") else {
            return ToolOutcome::refused("`plan_id` is required; plan_read lists your plans");
        };
        let p = match psvc::get_of(&self.db.conn, bot, id).await {
            Ok(Some(p)) => p,
            Ok(None) => {
                return ToolOutcome::refused(format!(
                    "you have no plan #{id}; plan_read lists yours"
                ))
            }
            Err(e) => return ToolOutcome::refused(e.to_string()),
        };
        if !p.state.is_live() {
            return ToolOutcome::refused(format!(
                "plan #{id} is {}; lay out a new one with plan_create",
                enum_str(&p.state)
            ));
        }
        let reason = text_of(args, "reason").map(|r| cut(&r, MAX_REASON_CHARS));
        if args.get("stop").and_then(|v| v.as_bool()) == Some(true) {
            return match self.stop_plan(&p, "assistant").await {
                Ok(()) => ToolOutcome::ok(
                    format!(
                        "Stopped plan #{id}: no new step is handed out; the steps under way run \
                         to their end."
                    ),
                    json!({ "plan_id": id, "state": "stopped" }),
                ),
                Err(e) => ToolOutcome::refused(e),
            };
        }
        // A re-delivered turn's same call changed it already: that change
        // stands, and nothing is changed twice.
        let key = update_key(id, args);
        let ledger = self.ledger_batch().await;
        if let Some((_, scope)) = &ledger {
            match svc::ledger_entries(&self.db.conn, scope, &key).await {
                Ok(earlier) => {
                    if earlier.iter().any(|e| {
                        e.state
                            == crate::db::entities::personal_agent_action::ActionState::Committed
                    }) {
                        return self.plan_changed_before(id).await;
                    }
                }
                Err(e) => return ToolOutcome::refused(e.to_string()),
            }
        }
        let _one = self.plan_lock.lock().await;
        // Read again under the lock: a step may have moved meanwhile.
        let Ok(Some(p)) = psvc::get(&self.db.conn, id).await else {
            return ToolOutcome::refused(format!("plan #{id} is gone"));
        };
        let steps = psvc::steps_of(&self.db.conn, id).await.unwrap_or_default();
        let prefs = self.prefs().await;
        let started = p.state != PlanState::Draft;
        let mut items: Vec<ChangeItem> = Vec::new();
        let mut undo: Vec<Undo> = Vec::new();
        let title = text_of(args, "title").map(|t| cut(&t, MAX_TITLE_CHARS));
        let goal = match args.get("goal") {
            None => None,
            Some(Value::Null) => Some(None),
            Some(_) => Some(text_of(args, "goal")),
        };
        if goal
            .as_ref()
            .and_then(|g| g.as_deref())
            .is_some_and(|g| g.chars().count() > MAX_GOAL_CHARS)
        {
            return ToolOutcome::refused(format!(
                "`goal` is longer than {MAX_GOAL_CHARS} characters"
            ));
        }
        // The plan as it would be: seq → (content, state).
        let mut after: BTreeMap<i32, (NewStep, StepState)> = steps
            .iter()
            .map(|s| (s.seq, (NewStep::of(s), s.state)))
            .collect();
        let by_seq: HashMap<i32, &step_entity::Model> = steps.iter().map(|s| (s.seq, s)).collect();
        // A number is never given twice: not even one of a step removed
        // since (a change taking that back brings it back under its own).
        let mut next_seq = steps
            .iter()
            .map(|s| s.seq)
            .chain(
                changes_of(&p)
                    .iter()
                    .flat_map(|c| c.undo.iter().map(|u| u.seq)),
            )
            .max()
            .unwrap_or(0)
            + 1;
        let raw: Vec<Value> = match args.get("steps") {
            None | Some(Value::Null) => Vec::new(),
            Some(Value::Array(a)) => a.clone(),
            Some(_) => return ToolOutcome::refused("`steps` is a list"),
        };
        let mut removed: Vec<i32> = Vec::new();
        for v in &raw {
            let a = match step_args(v) {
                Ok(a) => a,
                Err(e) => return ToolOutcome::refused(e),
            };
            match a.id {
                Some(seq) => {
                    let Some(old) = by_seq.get(&seq) else {
                        return ToolOutcome::refused(format!("plan #{id} has no step {seq}"));
                    };
                    if !old.state.changeable() {
                        return ToolOutcome::refused(format!(
                            "step {seq} is {}: it cannot change now — add a new step instead{}",
                            step_state_word(old.state),
                            if old.state == StepState::Running {
                                ", or the owner cancels it on the card"
                            } else {
                                ""
                            }
                        ));
                    }
                    if a.remove {
                        removed.push(seq);
                        after.remove(&seq);
                        undo.push(Undo {
                            seq,
                            before: Some(NewStep::of(old)),
                            state: Some(old.state),
                        });
                        items.push(ChangeItem {
                            kind: "removed".into(),
                            seq: Some(seq),
                            title: Some(old.title.clone()),
                            fields: vec![],
                        });
                        continue;
                    }
                    let base = NewStep::of(old);
                    let mut new = match self.resolve_step(&a, seq, Some(&base), &prefs).await {
                        Ok(s) => s,
                        Err(e) => return ToolOutcome::refused(e),
                    };
                    if !started {
                        new.confirmed = true;
                    }
                    let fields = fields_changed(&base, &new);
                    // A failed or canceled step changed (or retried) is
                    // handed out again.
                    let state = match old.state {
                        StepState::Failed | StepState::Canceled
                            if a.retry || !fields.is_empty() =>
                        {
                            StepState::Pending
                        }
                        s => s,
                    };
                    if fields.is_empty() && state == old.state {
                        continue;
                    }
                    undo.push(Undo {
                        seq,
                        before: Some(base),
                        state: Some(old.state),
                    });
                    items.push(ChangeItem {
                        kind: if fields.is_empty() {
                            "retry"
                        } else {
                            "changed"
                        }
                        .into(),
                        seq: Some(seq),
                        title: Some(new.title.clone()),
                        fields,
                    });
                    after.insert(seq, (new, state));
                }
                None => {
                    if a.remove || a.retry {
                        return ToolOutcome::refused(
                            "`remove` and `retry` name a step by its `id`",
                        );
                    }
                    if after.len() >= MAX_STEPS {
                        return ToolOutcome::refused(format!(
                            "a plan has at most {MAX_STEPS} steps"
                        ));
                    }
                    let seq = next_seq;
                    next_seq += 1;
                    let mut new = match self.resolve_step(&a, seq, None, &prefs).await {
                        Ok(s) => s,
                        Err(e) => return ToolOutcome::refused(e),
                    };
                    if !started {
                        new.confirmed = true;
                    }
                    undo.push(Undo {
                        seq,
                        before: None,
                        state: None,
                    });
                    items.push(ChangeItem {
                        kind: "added".into(),
                        seq: Some(seq),
                        title: Some(new.title.clone()),
                        fields: vec![],
                    });
                    after.insert(seq, (new, StepState::Pending));
                }
            }
        }
        // A removed step leaves the steps that waited for it.
        for r in &removed {
            let dependents: Vec<i32> = after
                .iter()
                .filter(|(_, (s, _))| s.depends_on.contains(r))
                .map(|(seq, _)| *seq)
                .collect();
            for seq in dependents {
                let Some((s, state)) = after.get_mut(&seq) else {
                    continue;
                };
                if !state.changeable() {
                    // A step under way keeps what it was handed out with.
                    s.depends_on.retain(|d| d != r);
                    continue;
                }
                if !undo.iter().any(|u| u.seq == seq) {
                    if let Some(old) = by_seq.get(&seq) {
                        undo.push(Undo {
                            seq,
                            before: Some(NewStep::of(old)),
                            state: Some(old.state),
                        });
                    }
                }
                s.depends_on.retain(|d| d != r);
                if let Some(item) = items.iter_mut().find(|i| i.seq == Some(seq)) {
                    if !item.fields.contains(&"depends_on".to_string()) {
                        item.fields.push("depends_on".into());
                    }
                } else {
                    items.push(ChangeItem {
                        kind: "changed".into(),
                        seq: Some(seq),
                        title: Some(s.title.clone()),
                        fields: vec!["depends_on".into()],
                    });
                }
            }
        }
        if after.is_empty() {
            return ToolOutcome::refused("a plan keeps at least one step; stop it instead");
        }
        if let Err(e) = check_order(
            &after
                .iter()
                .map(|(seq, (s, _))| (*seq, s.depends_on.clone()))
                .collect::<Vec<_>>(),
        ) {
            return ToolOutcome::refused(e);
        }
        let title_before = title
            .as_ref()
            .filter(|t| **t != p.title)
            .map(|_| p.title.clone());
        if let Some(t) = title.as_ref().filter(|t| **t != p.title) {
            items.push(ChangeItem {
                kind: "title".into(),
                seq: None,
                title: Some(t.clone()),
                fields: vec![],
            });
        }
        let goal_before = goal
            .as_ref()
            .filter(|g| **g != p.goal)
            .map(|_| p.goal.clone());
        if goal_before.is_some() {
            items.push(ChangeItem {
                kind: "goal".into(),
                seq: None,
                title: None,
                fields: vec![],
            });
        }
        if items.is_empty() {
            return ToolOutcome::ok(
                format!("Nothing to change on plan #{id}: it already reads so."),
                json!({ "plan_id": id, "changed": false }),
            );
        }
        // Written at once: the removed, the changed, the added, the change
        // on the plan and the call's ledger entry.
        let mut update = psvc::PlanUpdate::default();
        for r in &removed {
            if let Some(old) = by_seq.get(r) {
                update.removed.push((old.id, CHANGEABLE.to_vec()));
            }
        }
        for (seq, (content, state)) in &after {
            match by_seq.get(seq) {
                Some(old) => {
                    let base = NewStep::of(old);
                    if base == *content && *state == old.state {
                        continue;
                    }
                    let reopened = *state == StepState::Pending && old.state != StepState::Pending;
                    update.updated.push(psvc::StepUpdate {
                        id: old.id,
                        from: vec![old.state],
                        write: StepWrite {
                            content: Some(content.clone()),
                            state: Some(*state),
                            error: reopened.then_some(None),
                            result: reopened.then_some(None),
                            ended_at: reopened.then_some(None),
                            ..Default::default()
                        },
                    });
                }
                None => update.added.push(content.clone()),
            }
        }
        let mut changes = changes_of(&p);
        changes.push(Change {
            at: super::clock::now(),
            by: "assistant".into(),
            items: items.clone(),
            reason,
            undo,
            title_before,
            goal_before,
            undone: false,
            kept: vec![],
        });
        update.plan = PlanWrite {
            title: title.clone().filter(|t| *t != p.title),
            goal: goal.clone().filter(|g| *g != p.goal),
            changes: Some(serde_json::to_string(&changes).unwrap_or_else(|_| "[]".into())),
            ..Default::default()
        };
        let slot = ledger.as_ref().map(|(batch_id, _)| {
            LedgerSlot::in_batch(*batch_id, key, super::ledger::fresh_op_id())
        });
        match psvc::apply_update(
            &self.db.conn,
            bot,
            id,
            update,
            slot.as_ref(),
            Some(json!({ "plan_id": id })),
        )
        .await
        {
            Ok(Some(Ledgered::New(()))) => {}
            Ok(Some(Ledgered::Earlier(_))) => {
                drop(_one);
                return self.plan_changed_before(id).await;
            }
            Ok(None) => {
                return ToolOutcome::refused(format!(
                    "a step of plan #{id} moved meanwhile; nothing was changed — plan_read shows \
                     it now"
                ))
            }
            Err(e) => return ToolOutcome::refused(e.to_string()),
        }
        drop(_one);
        self.advance_plan(id).await;
        let view = self.plan_view(id).await;
        let lines: Vec<String> = items.iter().map(item_text).collect();
        ToolOutcome::ok(
            format!(
                "Changed plan #{id}: {}. The card lists it; the owner can take back what touched \
                 steps that have not started.{}",
                lines.join("; "),
                view.as_ref()
                    .map(|v| format!("\n\n{}", plan_text(v, false)))
                    .unwrap_or_default()
            ),
            json!({ "plan": view, "changed": true }),
        )
    }

    // ── its card ────────────────────────────────────────────────────────────

    /// Raise a plan's card, and note it on the plan.
    async fn raise_plan_card(
        &self,
        p: &plan_entity::Model,
        batch: Option<i32>,
    ) -> Result<i32, String> {
        let view = self.plan_view(p.id).await.ok_or("the plan is gone")?;
        let mut row = NewRow::new(TimelineKind::Notice, plan_text(&view, false));
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch;
        row.data = Some(json!({
            "notice": "plan",
            "state": enum_str(&view.state),
            "plan": view,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Plan,
                subject_key: Some(format!("plan:{}", p.id)),
                level: if p.state == PlanState::Draft {
                    NoticeLevel::Normal
                } else {
                    NoticeLevel::Low
                },
                batch_id: batch,
                payload: json!({ "plan_id": p.id, "state": view.need() }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        let _ = psvc::update(
            &self.db.conn,
            p.id,
            None,
            PlanWrite {
                notice_id: Some(Some(notice.id)),
                ..Default::default()
            },
        )
        .await;
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        Ok(notice.id)
    }

    /// Write a plan's card as the plan stands now: its row, and what its
    /// notice stands for. The row as written.
    async fn refresh_plan_card(&self, plan_id: i32) -> Option<TimelineRow> {
        let p = psvc::get(&self.db.conn, plan_id).await.ok().flatten()?;
        let notice_id = p.notice_id?;
        let notice = svc::get_notice(&self.db.conn, notice_id)
            .await
            .ok()
            .flatten()?;
        let row_id = notice.timeline_id?;
        let view = self.plan_view(plan_id).await?;
        let _ = svc::update_row_data(
            &self.db.conn,
            row_id,
            Some(plan_text(&view, false)),
            Some(json!({
                "notice": "plan",
                "state": enum_str(&view.state),
                "plan": view,
            })),
        )
        .await;
        let _ = svc::set_notice_payload(
            &self.db.conn,
            notice_id,
            &json!({ "plan_id": plan_id, "state": view.need() }),
        )
        .await;
        // Over: nothing more on it is the owner's.
        if !view.state.is_live() && notice.state == NoticeState::Open {
            let _ = svc::move_notice(
                &self.db.conn,
                notice_id,
                &[NoticeState::Open],
                NoticeState::Acted,
            )
            .await;
        }
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .ok()
            .flatten()
            .map(svc::to_row)?;
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Some(row)
    }

    /// A plan as its card shows it.
    pub(super) async fn plan_view(&self, plan_id: i32) -> Option<PlanView> {
        let p = psvc::get(&self.db.conn, plan_id).await.ok().flatten()?;
        let steps = psvc::steps_of(&self.db.conn, plan_id)
            .await
            .unwrap_or_default();
        let done: BTreeSet<i32> = steps
            .iter()
            .filter(|s| s.state == StepState::Done)
            .map(|s| s.seq)
            .collect();
        let mut views = Vec::new();
        for s in &steps {
            views.push(self.step_view(s, &done).await);
        }
        let changes = changes_of(&p);
        let change_views = changes
            .iter()
            .enumerate()
            .map(|(i, c)| ChangeView {
                index: i,
                at: c.at,
                by: c.by.clone(),
                items: c.items.clone(),
                reason: c.reason.clone(),
                undoable: !c.undone && p.state.is_live() && undoable(c, &steps),
                undone: c.undone,
                kept: c.kept.clone(),
            })
            .collect();
        Some(PlanView {
            id: p.id,
            title: p.title.clone(),
            goal: p.goal.clone(),
            state: p.state,
            stuck_reason: p.stuck_reason.clone(),
            done: done.len(),
            total: steps.len(),
            steps: views,
            changes: change_views,
            created_at: p.created_at,
            started_at: p.started_at,
            ended_at: p.ended_at,
        })
    }

    async fn step_view(&self, s: &step_entity::Model, done: &BTreeSet<i32>) -> StepView {
        let deps = s.deps();
        let (agent_type, mut face) = (None, Value::Null);
        if let Ok(Some(b)) = svc::get_bot_any(&self.db.conn, s.target_id).await {
            face = super::messages::bot_face(&b);
        }
        let project_name = match s.project_id {
            Some(id) => crate::db::service::folder_service::get_folder_by_id(&self.db.conn, id)
                .await
                .ok()
                .flatten()
                .map(|f| f.alias.clone().unwrap_or(f.name)),
            None => None,
        };
        let mut view = StepView {
            seq: s.seq,
            title: s.title.clone(),
            target_kind: s.target_kind,
            target_id: s.target_id,
            target_name: s.target_name.clone(),
            agent_type,
            face,
            mode: s.mode.clone(),
            project_id: s.project_id,
            project_name,
            deliverable: s.deliverable.clone(),
            prompt: s.prompt.clone(),
            done_when: s.done_when.clone(),
            depends_on: deps.clone(),
            state: s.state,
            confirmed: s.confirmed,
            ready: deps.iter().all(|d| done.contains(d)),
            ladder: None,
            dispatch_id: s.dispatch_id,
            message_id: s.message_id,
            work_task_id: None,
            conversation_id: None,
            conversation_folder_id: None,
            result: s.result.clone(),
            error: s.error.clone(),
            started_at: s.started_at,
            ended_at: s.ended_at,
        };
        if let Some(did) = s.dispatch_id {
            if let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, did).await {
                let task = self.task_of(&d).await;
                let pr = self.pr_facts_of(task.as_ref()).await;
                view.ladder = Some(super::watch::with_pr(
                    super::ladder::ladder_of(&d, task.as_ref()),
                    pr.as_ref(),
                ));
                view.work_task_id = d.work_task_id;
                view.conversation_id = d.conversation_id;
                // The agent the step's work ran on: what its conversation
                // opens with (an agent, never an executor config's name).
                view.agent_type = Some(super::dispatch::work_of(&d).agent_type);
                if let Some(cid) = d.conversation_id {
                    view.conversation_folder_id =
                        crate::db::service::conversation_service::get_by_id(&self.db.conn, cid)
                            .await
                            .ok()
                            .map(|c| c.folder_id);
                }
            }
        }
        view
    }

    async fn task_of(
        &self,
        d: &dispatch_entity::Model,
    ) -> Option<crate::db::entities::work_task::Model> {
        match (d.mode, d.work_task_id) {
            (DispatchMode::Task, Some(tid)) => {
                crate::db::service::work_task_service::get_model(&self.db.conn, tid)
                    .await
                    .ok()
            }
            _ => None,
        }
    }

    async fn pr_facts_of(
        &self,
        task: Option<&crate::db::entities::work_task::Model>,
    ) -> Option<crate::models::personal_agent_overview::PrFacts> {
        let t = task?;
        super::watch::facts_of_tasks(&self.db, &[t.id])
            .await
            .remove(&t.id)
    }

    // ── carrying it out ─────────────────────────────────────────────────────

    /// Look at every plan of this assistant still going: the clock's look,
    /// which also catches what a hook missed.
    pub(super) async fn plan_tick(self: &Arc<Self>) {
        let bot = self.bot().await;
        if bot == 0 {
            return;
        }
        for p in psvc::of_bot(
            &self.db.conn,
            bot,
            &[
                PlanState::Draft,
                PlanState::Running,
                PlanState::Stuck,
                PlanState::Stopped,
            ],
        )
        .await
        .unwrap_or_default()
        {
            // A restart between making it and raising its card: the card,
            // now (a plan shown first has nothing else to start it by).
            if p.notice_id.is_none() {
                if let Err(e) = self.ensure_plan_card(p.id, p.origin_batch_id).await {
                    tracing::warn!("[personal_agent] plan #{} card not raised: {e}", p.id);
                }
            }
            if p.state != PlanState::Draft {
                self.advance_plan(p.id).await;
            }
        }
        // A restart between its end and what its end owes: the summary and
        // the owner's news — however long ago it ended.
        for p in psvc::done_untold(&self.db.conn, bot)
            .await
            .unwrap_or_default()
        {
            if !told_of(&p).done {
                let steps = psvc::steps_of(&self.db.conn, p.id)
                    .await
                    .unwrap_or_default();
                self.plan_done(&p, &steps).await;
            }
        }
    }

    /// A plan's card: the one it has, else the one raised for it before a
    /// restart cut its link off (linked now), else a new one. Under the plan
    /// lock, read afresh: the clock's look and the call that laid the plan
    /// out never both raise one.
    async fn ensure_plan_card(&self, plan_id: i32, batch: Option<i32>) -> Result<i32, String> {
        let _one = self.plan_lock.lock().await;
        let p = psvc::get(&self.db.conn, plan_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the plan is gone")?;
        if let Some(n) = p.notice_id {
            return Ok(n);
        }
        let raised = svc::notice_of_subject(
            &self.db.conn,
            p.bot_id,
            NoticeKind::Plan,
            &format!("plan:{}", p.id),
        )
        .await
        .map_err(|e| e.to_string())?;
        if let Some(n) = raised {
            psvc::update(
                &self.db.conn,
                p.id,
                None,
                PlanWrite {
                    notice_id: Some(Some(n.id)),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            self.refresh_plan_card(p.id).await;
            return Ok(n.id);
        }
        self.raise_plan_card(&p, batch).await
    }

    /// Look at a plan off the caller's path: hooks call this, so a hook in
    /// the middle of a look never waits on the look.
    pub(super) fn kick_plan(&self, plan_id: i32) {
        let Some(engine) = self.arc() else {
            return;
        };
        tokio::spawn(async move {
            engine.advance_plan(plan_id).await;
        });
    }

    /// The step a dispatch carries out moved: its plan is looked at by the
    /// engine of the assistant whose plan it is.
    pub(super) async fn plan_dispatch_moved(&self, dispatch_id: i32) {
        let Ok(Some(s)) = psvc::step_of_dispatch(&self.db.conn, dispatch_id).await else {
            return;
        };
        self.kick_plan_of_step(&s).await;
    }

    /// A work assistant answered a message: the step it carries out, if
    /// any, is done.
    pub(super) async fn plan_message_answered(&self, message_id: i32) {
        let Ok(Some(s)) = psvc::step_of_message(&self.db.conn, message_id).await else {
            return;
        };
        self.kick_plan_of_step(&s).await;
    }

    /// A turn ended: the plans it was woken for are looked at again — a
    /// step it did not pick up makes its plan stuck (7.6).
    pub(super) async fn plans_after_turn(&self, batch_id: i32) {
        let mut ids = BTreeSet::new();
        for e in svc::events_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|e| e.kind == PLAN_EVENT)
        {
            if let Some(id) = e
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str::<Value>(p).ok())
                .and_then(|p| p["plan_id"].as_i64())
                .and_then(|id| i32::try_from(id).ok())
            {
                ids.insert(id);
            }
        }
        for id in ids {
            self.kick_plan(id);
        }
    }

    /// Boxed: reaching another assistant's engine goes through the host,
    /// whose engines' loops reach back here.
    fn kick_plan_of_step<'a>(
        &'a self,
        s: &'a step_entity::Model,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let Ok(Some(p)) = psvc::get(&self.db.conn, s.plan_id).await else {
                return;
            };
            if p.bot_id == self.bot().await {
                self.kick_plan(p.id);
            } else if let Some(peer) = self.peer(p.bot_id).await {
                peer.kick_plan(p.id);
            }
        })
    }

    /// One look at a plan: what its steps under way came to, the steps now
    /// free handed out, and where the plan stands. It runs on a task of its
    /// own, awaited: handing a step to a work assistant may start that
    /// assistant's engine, whose boot is a deep future, and the caller (a
    /// tool call, a card) is deep already. Boxed: that engine's loop looks
    /// at the plans too.
    pub(super) fn advance_plan(
        self: &Arc<Self>,
        plan_id: i32,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'static>> {
        let engine = self.clone();
        Box::pin(async move {
            let _ = tokio::spawn(async move { engine.advance_plan_now(plan_id).await }).await;
        })
    }

    async fn advance_plan_now(self: &Arc<Self>, plan_id: i32) {
        let _one = self.plan_lock.lock().await;
        let Ok(Some(p)) = psvc::get(&self.db.conn, plan_id).await else {
            return;
        };
        if p.bot_id != self.bot().await || !p.state.is_live() || p.state == PlanState::Draft {
            return;
        }
        let mut changed = false;
        // What the steps under way came to — and the failed or canceled ones
        // whose work was picked up again (a follow-up, codeg's retry) or
        // came to something after all.
        for s in psvc::steps_of(&self.db.conn, plan_id)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|s| {
                s.state == StepState::Running
                    || (matches!(s.state, StepState::Failed | StepState::Canceled)
                        && s.dispatch_id.is_some())
            })
        {
            let outcome = self.step_outcome(&s).await;
            changed |= if s.state == StepState::Running {
                self.settle_step(&p, &s, outcome).await
            } else {
                self.revive_step(&s, outcome).await
            };
        }
        // The steps now free, while it runs.
        let Ok(Some(p)) = psvc::get(&self.db.conn, plan_id).await else {
            return;
        };
        if matches!(p.state, PlanState::Running | PlanState::Stuck) {
            let steps = psvc::steps_of(&self.db.conn, plan_id)
                .await
                .unwrap_or_default();
            let done: BTreeSet<i32> = steps
                .iter()
                .filter(|s| s.state == StepState::Done)
                .map(|s| s.seq)
                .collect();
            for s in steps.iter().filter(|s| {
                s.state == StepState::Pending
                    && s.confirmed
                    && s.deps().iter().all(|d| done.contains(d))
            }) {
                self.start_step(&p, &steps, s).await;
                changed = true;
            }
        }
        changed |= self.settle_plan(plan_id).await;
        if changed {
            self.refresh_plan_card(plan_id).await;
        }
    }

    /// What a running step's work came to.
    async fn step_outcome(&self, s: &step_entity::Model) -> Outcome {
        match s.target_kind {
            TargetKind::Own => {
                let Some(did) = s.dispatch_id else {
                    return Outcome::Unsent;
                };
                let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, did).await else {
                    return Outcome::Failed(format!("its dispatch #{did} is gone"));
                };
                let task = self.task_of(&d).await;
                let pr = self.pr_facts_of(task.as_ref()).await;
                let retrying = d.state == DispatchState::Interrupted
                    && matches!(
                        self.retry_plan(&d).await,
                        super::retry::RetryPlan::Auto { .. }
                    );
                dispatch_outcome(&d, task.as_ref(), pr.as_ref(), retrying)
            }
            TargetKind::Bot => {
                let Some(mid) = s.message_id else {
                    return Outcome::Unsent;
                };
                let Ok(Some(m)) = msvc::get_message(&self.db.conn, mid).await else {
                    return Outcome::Failed(format!("its message m{mid} is gone"));
                };
                match m.state {
                    MessageState::Queued | MessageState::Delivered => Outcome::Running,
                    MessageState::Replied => {
                        let reply = msvc::reply_of(&self.db.conn, m.id, m.to_bot_id)
                            .await
                            .ok()
                            .flatten();
                        Outcome::Done(reply.map(|r| super::dispatch::excerpt_of(&r.body)))
                    }
                    MessageState::Closed => {
                        Outcome::Failed(format!("{} did not write back", s.target_name))
                    }
                    MessageState::Stopped => {
                        Outcome::Canceled("the owner stopped what it was part of".into())
                    }
                    MessageState::Looped => Outcome::Failed(
                        "the exchange went back and forth without progress and was stopped".into(),
                    ),
                    MessageState::Canceled => {
                        Outcome::Failed(format!("{} was deleted before it answered", s.target_name))
                    }
                }
            }
        }
    }

    /// Write what a running step came to. Whether anything moved.
    /// A failed or canceled step whose dispatch runs again, or is done after
    /// all: it is under way again (or done), and its plan goes on.
    async fn revive_step(&self, s: &step_entity::Model, outcome: Outcome) -> bool {
        let write = match outcome {
            Outcome::Running => StepWrite {
                state: Some(StepState::Running),
                error: Some(None),
                ended_at: Some(None),
                ..Default::default()
            },
            Outcome::Done(result) => StepWrite {
                state: Some(StepState::Done),
                result: Some(result),
                error: Some(None),
                ended_at: Some(Some(super::clock::now())),
                ..Default::default()
            },
            _ => return false,
        };
        psvc::update_step(&self.db.conn, s.id, Some(&[s.state]), write)
            .await
            .ok()
            .flatten()
            .is_some()
    }

    async fn settle_step(
        &self,
        p: &plan_entity::Model,
        s: &step_entity::Model,
        outcome: Outcome,
    ) -> bool {
        let now = super::clock::now();
        match outcome {
            Outcome::Running => false,
            Outcome::Unsent => {
                // Handed out again under the operation it was claimed for.
                if let Some(engine) = self.arc() {
                    let steps = psvc::steps_of(&self.db.conn, p.id)
                        .await
                        .unwrap_or_default();
                    engine.send_step(p, &steps, s).await;
                }
                true
            }
            Outcome::Done(result) => psvc::update_step(
                &self.db.conn,
                s.id,
                Some(&[StepState::Running]),
                StepWrite {
                    state: Some(StepState::Done),
                    result: Some(result),
                    error: Some(None),
                    ended_at: Some(Some(now)),
                    ..Default::default()
                },
            )
            .await
            .ok()
            .flatten()
            .is_some(),
            Outcome::Failed(error) => {
                let Some(s) = psvc::update_step(
                    &self.db.conn,
                    s.id,
                    Some(&[StepState::Running]),
                    StepWrite {
                        state: Some(StepState::Failed),
                        error: Some(Some(error.clone())),
                        bump_failures: true,
                        ended_at: Some(Some(now)),
                        ..Default::default()
                    },
                )
                .await
                .ok()
                .flatten() else {
                    return false;
                };
                if matches!(p.state, PlanState::Running | PlanState::Stuck) {
                    self.wake_for_step(p, &s, &error).await;
                }
                true
            }
            Outcome::Canceled(why) => psvc::update_step(
                &self.db.conn,
                s.id,
                Some(&[StepState::Running]),
                StepWrite {
                    state: Some(StepState::Canceled),
                    error: Some(Some(why)),
                    ended_at: Some(Some(now)),
                    ..Default::default()
                },
            )
            .await
            .ok()
            .flatten()
            .is_some(),
        }
    }

    /// Hand a step out: claimed first (pending → running, its attempt
    /// counted), then sent under that attempt's operation.
    async fn start_step(
        self: &Arc<Self>,
        p: &plan_entity::Model,
        steps: &[step_entity::Model],
        s: &step_entity::Model,
    ) {
        let Ok(Some(claimed)) = psvc::update_step(
            &self.db.conn,
            s.id,
            Some(&[StepState::Pending]),
            StepWrite {
                state: Some(StepState::Running),
                bump_attempt: true,
                dispatch_id: Some(None),
                message_id: Some(None),
                result: Some(None),
                error: Some(None),
                started_at: Some(Some(super::clock::now())),
                ended_at: Some(None),
                ..Default::default()
            },
        )
        .await
        else {
            return;
        };
        self.send_step(p, steps, &claimed).await;
    }

    /// Send a claimed step: its dispatch, or its message. One that cannot be
    /// handed out fails, and its assistant hears why.
    async fn send_step(
        self: &Arc<Self>,
        p: &plan_entity::Model,
        steps: &[step_entity::Model],
        s: &step_entity::Model,
    ) {
        let op_id = format!("plan-step:{}:{}", s.id, s.attempt);
        let brief = step_brief(p, steps, s);
        let lineage = svc::Lineage {
            origin_bot_id: p.origin_bot_id,
            origin_row_id: p.origin_row_id,
            thread_id: p.thread_id,
            for_input: p.for_input.clone(),
        };
        let sent: Result<(Option<i32>, Option<i32>), String> = match s.target_kind {
            TargetKind::Own => {
                let mode = s
                    .mode
                    .as_deref()
                    .and_then(mode_of)
                    .unwrap_or(DispatchMode::Task);
                let req = DispatchRequest {
                    mode,
                    title: s.title.clone(),
                    prompt: brief,
                    project_id: s.project_id,
                    report: s.deliverable.as_deref() == Some("report"),
                    on_done: None,
                    done_when: s.done_when.clone(),
                    replaces: None,
                };
                match self.validate_dispatch(&req).await {
                    Ok(mut v) => {
                        v.lineage = lineage;
                        self.record_dispatch(v, DispatchAuth::Op { op_id })
                            .await
                            .map(|made| (Some(made.dispatch.id), None))
                    }
                    Err(e) => Err(format!("it could not be handed out: {e}")),
                }
            }
            TargetKind::Bot => match svc::get_bot_any(&self.db.conn, s.target_id).await {
                Ok(Some(b)) if b.deleted_at.is_none() => {
                    let m = ResolvedMessage {
                        to: b.id,
                        to_name: display_name(&b),
                        body: cut(&brief, super::messages::MAX_MESSAGE_CHARS),
                        reply_to: None,
                        wants_reply: true,
                        thread: p.thread_id,
                        lineage,
                    };
                    self.send_resolved(m, MessageAuth::Op { op_id })
                        .await
                        .map(|sent| (None, Some(sent.message.id)))
                        .map_err(|e| format!("its message could not be sent: {e}"))
                }
                Ok(Some(b)) => Err(format!(
                    "it could not be handed out: {} was deleted",
                    display_name(&b)
                )),
                _ => Err("it could not be handed out: its work assistant is gone".into()),
            },
        };
        match sent {
            Ok((dispatch_id, message_id)) => {
                let _ = psvc::update_step(
                    &self.db.conn,
                    s.id,
                    Some(&[StepState::Running]),
                    StepWrite {
                        dispatch_id: dispatch_id.map(Some),
                        message_id: message_id.map(Some),
                        ..Default::default()
                    },
                )
                .await;
            }
            Err(error) => {
                if let Ok(Some(failed)) = psvc::update_step(
                    &self.db.conn,
                    s.id,
                    Some(&[StepState::Running]),
                    StepWrite {
                        state: Some(StepState::Failed),
                        error: Some(Some(error.clone())),
                        bump_failures: true,
                        ended_at: Some(Some(super::clock::now())),
                        ..Default::default()
                    },
                )
                .await
                {
                    self.wake_for_step(p, &failed, &error).await;
                }
            }
        }
    }

    /// A step failed: its assistant is woken to pick it up — retry it, hand
    /// it to another, change the plan, or tell the owner.
    async fn wake_for_step(&self, p: &plan_entity::Model, s: &step_entity::Model, error: &str) {
        let steps = psvc::steps_of(&self.db.conn, p.id)
            .await
            .unwrap_or_default();
        let waiting = steps.iter().filter(|x| x.deps().contains(&s.seq)).count();
        let retry = match s.dispatch_id {
            Some(d) => format!(
                "retry it (dispatch_followup on dispatch #{d}, or plan_update with \
                 {{\"id\": {}, \"retry\": true}})",
                s.seq
            ),
            None => format!(
                "retry it (plan_update with {{\"id\": {}, \"retry\": true}})",
                s.seq
            ),
        };
        let summary = format!(
            "Plan #{} \"{}\": step {} \"{}\" ({}) {}. The plan waits on it — {} step(s) depend on \
             it; what does not goes on. Pick it up now: {retry}, hand it to another \
             assistant or do it yourself (plan_update with a new `to`; for yourself, \
             \"self\" with a `mode` and, for a task or session, a `project_id`), or change the plan. If nothing fits, tell the owner why: once this turn ends with the step still \
             failed, codeg tells them the plan is stuck.",
            p.id,
            p.title,
            s.seq,
            s.title,
            s.target_name,
            if error.starts_with("it could not") || error.starts_with("its message") {
                error.to_string()
            } else {
                format!("failed: {error}")
            },
            waiting
        );
        let _ = svc::insert_event(
            &self.db.conn,
            p.bot_id,
            PLAN_EVENT,
            &wait_key(s),
            None,
            summary,
            Some(json!({ "plan_id": p.id, "step": s.seq, "what": "failed" })),
            true,
        )
        .await;
        self.nudge();
    }

    /// Where the plan stands now its steps moved: done, stuck, or running
    /// again. Whether it moved.
    async fn settle_plan(&self, plan_id: i32) -> bool {
        let Ok(Some(p)) = psvc::get(&self.db.conn, plan_id).await else {
            return false;
        };
        let steps = psvc::steps_of(&self.db.conn, plan_id)
            .await
            .unwrap_or_default();
        if !steps.is_empty() && steps.iter().all(|s| s.state == StepState::Done) {
            if !matches!(
                p.state,
                PlanState::Running | PlanState::Stuck | PlanState::Stopped
            ) {
                return false;
            }
            let Ok(Some(done)) = psvc::update(
                &self.db.conn,
                plan_id,
                Some(&[p.state]),
                PlanWrite {
                    state: Some(PlanState::Done),
                    stuck_reason: Some(None),
                    ended_at: Some(Some(super::clock::now())),
                    ..Default::default()
                },
            )
            .await
            else {
                return false;
            };
            self.plan_done(&done, &steps).await;
            return true;
        }
        if !matches!(p.state, PlanState::Running | PlanState::Stuck) {
            return false;
        }
        // What it is stuck on: a step canceled, or one still failed after
        // its assistant had its turn on it.
        let mut stuck: Option<(&step_entity::Model, bool)> = None;
        for s in &steps {
            match s.state {
                StepState::Canceled => {
                    stuck.get_or_insert((s, false));
                }
                // A failure goes before a cancel: it is the one told.
                StepState::Failed
                    if stuck.is_none_or(|(_, failed)| !failed)
                        && self.wait_over(p.bot_id, s).await =>
                {
                    stuck = Some((s, true));
                }
                _ => {}
            }
        }
        match (stuck, p.state) {
            (Some((s, failed)), _) => {
                let reason = format!(
                    "step {} \"{}\" {}{}",
                    s.seq,
                    s.title,
                    if failed { "failed" } else { "was canceled" },
                    s.error
                        .as_deref()
                        .map(|e| format!(": {}", cut(e, 300)))
                        .unwrap_or_default()
                );
                let moved = psvc::update(
                    &self.db.conn,
                    plan_id,
                    Some(&[PlanState::Running, PlanState::Stuck]),
                    PlanWrite {
                        state: Some(PlanState::Stuck),
                        stuck_reason: Some(Some(reason)),
                        ..Default::default()
                    },
                )
                .await
                .ok()
                .flatten();
                let Some(now) = moved else {
                    return false;
                };
                // A failure is told once, urgently; a cancel was the owner's.
                if failed {
                    let key = wait_key(s);
                    let mut told = told_of(&now);
                    if !told.stuck.contains(&key) {
                        // Told, then noted: a restart in between tells it
                        // again rather than never.
                        self.tell_plan(
                            &now,
                            "plan_stuck",
                            super::reach::What::PlanStuck {
                                text: super::reach::glimpse(&format!(
                                    "{} · {}. {}",
                                    now.title, s.seq, s.title
                                )),
                            },
                        )
                        .await;
                        told.stuck.push(key);
                        let _ = psvc::update(
                            &self.db.conn,
                            plan_id,
                            None,
                            PlanWrite {
                                told: Some(serde_json::to_string(&told).ok()),
                                ..Default::default()
                            },
                        )
                        .await;
                    }
                }
                p.state != PlanState::Stuck || p.stuck_reason != now.stuck_reason
            }
            (None, PlanState::Stuck)
                if !steps
                    .iter()
                    .any(|s| matches!(s.state, StepState::Failed | StepState::Canceled)) =>
            {
                psvc::update(
                    &self.db.conn,
                    plan_id,
                    Some(&[PlanState::Stuck]),
                    PlanWrite {
                        state: Some(PlanState::Running),
                        stuck_reason: Some(None),
                        ..Default::default()
                    },
                )
                .await
                .ok()
                .flatten()
                .is_some()
            }
            _ => false,
        }
    }

    /// Whether the assistant had its turn on a step's failure: the event
    /// that woke it went through a delivery, or waited too long for one.
    async fn wait_over(&self, bot: i32, s: &step_entity::Model) -> bool {
        let Ok(key) = svc::scoped_source_key(&self.db.conn, bot, &wait_key(s)).await else {
            return false;
        };
        let Ok(Some(e)) =
            crate::db::service::personal_agent_routine_service::event_by_key(&self.db.conn, &key)
                .await
        else {
            // Never raised (the step failed before the plan ran): nothing to
            // wait for.
            return true;
        };
        match e.state {
            EventState::Done => true,
            EventState::Pending | EventState::Delivered => {
                super::clock::now() - e.created_at > Duration::minutes(WAIT_FOR_BRAIN_MINS)
            }
        }
    }

    /// Every step is done: the owner hears it, and the assistant writes the
    /// summary.
    async fn plan_done(&self, p: &plan_entity::Model, steps: &[step_entity::Model]) {
        let mut told = told_of(p);
        if told.done {
            return;
        }
        let mut lines = String::new();
        for s in steps {
            lines.push_str(&format!(
                "\n{}. {} ({}){}",
                s.seq,
                s.title,
                s.target_name,
                s.result
                    .as_deref()
                    .map(|r| format!(" — {}", cut(r, 500)))
                    .unwrap_or_default()
            ));
        }
        let summary = format!(
            "Plan #{} \"{}\" is done: every step finished.{lines}\nWrite the owner one short \
             summary card of what the plan came to — a row per step (what came of it, a link \
             where there is one) and anything left for them. There is nothing more to hand out \
             for it.",
            p.id, p.title
        );
        let _ = svc::insert_event(
            &self.db.conn,
            p.bot_id,
            PLAN_EVENT,
            &format!("plan:{}:done", p.id),
            None,
            summary,
            Some(json!({ "plan_id": p.id, "what": "done" })),
            true,
        )
        .await;
        self.nudge();
        self.tell_plan(
            p,
            "plan",
            super::reach::What::PlanDone {
                text: super::reach::glimpse(&p.title),
            },
        )
        .await;
        // Noted last: a restart before this asks for the summary again (the
        // event is one per plan) and the clock's look finishes it.
        told.done = true;
        let _ = psvc::update(
            &self.db.conn,
            p.id,
            None,
            PlanWrite {
                told: Some(serde_json::to_string(&told).ok()),
                ..Default::default()
            },
        )
        .await;
    }

    async fn tell_plan(
        &self,
        p: &plan_entity::Model,
        kind: &'static str,
        what: super::reach::What,
    ) {
        let Some(host) = self.host_ref() else {
            return;
        };
        let row_id = match p.notice_id {
            Some(n) => svc::get_notice(&self.db.conn, n)
                .await
                .ok()
                .flatten()
                .and_then(|n| n.timeline_id),
            None => None,
        };
        host.tell(super::reach::News {
            key: format!("{kind}:{}:{}", p.id, told_of(p).stuck.len()),
            bot_id: p.bot_id,
            kind,
            what,
            link: Some(super::reach::NotifyLink::Bot {
                bot_id: p.bot_id,
                row_id,
            }),
            need: None,
        })
        .await;
    }

    // ── the owner's hand ────────────────────────────────────────────────────

    /// Stop a plan: nothing new is handed out; what is under way runs on.
    pub(super) async fn stop_plan(
        self: &Arc<Self>,
        p: &plan_entity::Model,
        by: &str,
    ) -> Result<(), String> {
        let _one = self.plan_lock.lock().await;
        let from: &[PlanState] = if p.state == PlanState::Draft {
            &[PlanState::Draft]
        } else {
            &[PlanState::Running, PlanState::Stuck]
        };
        let to = if p.state == PlanState::Draft {
            PlanState::Canceled
        } else {
            PlanState::Stopped
        };
        let moved = psvc::update(
            &self.db.conn,
            p.id,
            Some(from),
            PlanWrite {
                state: Some(to),
                stuck_reason: Some(None),
                ended_at: (to == PlanState::Canceled).then_some(Some(super::clock::now())),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        if moved.is_none() {
            return Err(format!("plan #{} is {} already", p.id, enum_str(&p.state)));
        }
        let _ = psvc::move_steps(
            &self.db.conn,
            p.id,
            &[StepState::Pending],
            StepState::Stopped,
        )
        .await;
        drop(_one);
        if by == "owner" {
            self.tell_brain_plan(
                p,
                &format!(
                    "The owner {} plan #{} \"{}\": no new step is handed out{}.",
                    if to == PlanState::Canceled {
                        "canceled"
                    } else {
                        "stopped"
                    },
                    p.id,
                    p.title,
                    if to == PlanState::Canceled {
                        String::new()
                    } else {
                        "; the steps under way run to their end".into()
                    }
                ),
                "stopped",
            )
            .await;
        }
        self.refresh_plan_card(p.id).await;
        Ok(())
    }

    /// A word to the plan's assistant that wakes nobody: it reads it with
    /// its next delivery.
    async fn tell_brain_plan(&self, p: &plan_entity::Model, text: &str, what: &str) {
        let _ = svc::insert_event(
            &self.db.conn,
            p.bot_id,
            PLAN_EVENT,
            &format!("plan:{}:{what}:{}", p.id, uuid::Uuid::new_v4().simple()),
            None,
            text.to_string(),
            Some(json!({ "plan_id": p.id, "what": what })),
            false,
        )
        .await;
    }

    /// The owner's answer on a plan's card:
    /// - `start`: a plan shown first starts (its steps confirmed), a stopped
    ///   one goes on;
    /// - `stop`: nothing new is handed out;
    /// - `cancel`: a plan shown first, stopped or stuck ends;
    /// - `confirm:<n>`: step n, which they confirm first, may go;
    /// - `cancel_step:<n>`: step n's work under way is stopped;
    /// - `undo:<i>`: change i is taken back where its steps have not
    ///   started.
    pub(super) async fn act_on_plan(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let p = psvc::of_notice(&self.db.conn, notice.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("this card's plan is gone")?;
        let (verb, arg) = match action.split_once(':') {
            Some((v, a)) => (v, a.trim().parse::<i64>().ok()),
            None => (action, None),
        };
        // Boxed: each is a deep future (a step canceled stops its dispatch).
        match verb {
            "start" => Box::pin(self.start_plan(&p)).await?,
            "stop" => Box::pin(self.stop_plan(&p, "owner")).await?,
            "cancel" => Box::pin(self.end_plan(&p)).await?,
            "confirm" => {
                let seq = arg
                    .and_then(|n| i32::try_from(n).ok())
                    .ok_or("which step?")?;
                Box::pin(self.confirm_step(&p, seq)).await?
            }
            "cancel_step" => {
                let seq = arg
                    .and_then(|n| i32::try_from(n).ok())
                    .ok_or("which step?")?;
                Box::pin(self.cancel_step(&p, seq)).await?
            }
            "undo" => {
                let i = arg
                    .and_then(|n| usize::try_from(n).ok())
                    .ok_or("which change?")?;
                Box::pin(self.undo_change(&p, i)).await?
            }
            _ => {
                return Err(
                    "`action` must be start, stop, cancel, confirm:<step>, cancel_step:<step> or \
                     undo:<change>"
                        .into(),
                )
            }
        }
        self.refresh_plan_card(p.id)
            .await
            .ok_or_else(|| "the card's row is missing".to_string())
    }

    async fn start_plan(self: &Arc<Self>, p: &plan_entity::Model) -> Result<(), String> {
        {
            let _one = self.plan_lock.lock().await;
            let from: &[PlanState] = match p.state {
                PlanState::Draft => &[PlanState::Draft],
                PlanState::Stopped => &[PlanState::Stopped],
                s => return Err(format!("plan #{} is {} already", p.id, enum_str(&s))),
            };
            let now = super::clock::now();
            let moved = psvc::update(
                &self.db.conn,
                p.id,
                Some(from),
                PlanWrite {
                    state: Some(PlanState::Running),
                    started_at: p.started_at.is_none().then_some(Some(now)),
                    ..Default::default()
                },
            )
            .await
            .map_err(|e| e.to_string())?;
            if moved.is_none() {
                return Err("this card was answered already".into());
            }
            let _ = psvc::move_steps(
                &self.db.conn,
                p.id,
                &[StepState::Stopped],
                StepState::Pending,
            )
            .await;
            // Starting a plan they were shown confirms its steps.
            if p.state == PlanState::Draft {
                for s in psvc::steps_of(&self.db.conn, p.id)
                    .await
                    .unwrap_or_default()
                {
                    if !s.confirmed {
                        let _ = psvc::update_step(
                            &self.db.conn,
                            s.id,
                            None,
                            StepWrite {
                                confirmed: Some(true),
                                ..Default::default()
                            },
                        )
                        .await;
                    }
                }
            }
        }
        self.tell_brain_plan(
            p,
            &format!(
                "The owner {} plan #{} \"{}\": codeg hands out its steps from now on.",
                if p.state == PlanState::Draft {
                    "started"
                } else {
                    "picked up again"
                },
                p.id,
                p.title
            ),
            "started",
        )
        .await;
        self.advance_plan(p.id).await;
        Ok(())
    }

    async fn end_plan(self: &Arc<Self>, p: &plan_entity::Model) -> Result<(), String> {
        if p.state == PlanState::Draft {
            return self.stop_plan(p, "owner").await;
        }
        let _one = self.plan_lock.lock().await;
        let moved = psvc::update(
            &self.db.conn,
            p.id,
            Some(&[PlanState::Stopped, PlanState::Stuck]),
            PlanWrite {
                state: Some(PlanState::Canceled),
                ended_at: Some(Some(super::clock::now())),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?;
        if moved.is_none() {
            return Err(format!(
                "plan #{} is {}: stop it first",
                p.id,
                enum_str(&p.state)
            ));
        }
        let _ = psvc::move_steps(
            &self.db.conn,
            p.id,
            &[StepState::Pending],
            StepState::Stopped,
        )
        .await;
        drop(_one);
        self.tell_brain_plan(
            p,
            &format!(
                "The owner ended plan #{} \"{}\": nothing more of it is handed out.",
                p.id, p.title
            ),
            "ended",
        )
        .await;
        Ok(())
    }

    async fn confirm_step(
        self: &Arc<Self>,
        p: &plan_entity::Model,
        seq: i32,
    ) -> Result<(), String> {
        let s = psvc::steps_of(&self.db.conn, p.id)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.seq == seq)
            .ok_or_else(|| format!("plan #{} has no step {seq}", p.id))?;
        if s.confirmed {
            return Err("this step was confirmed already".into());
        }
        psvc::update_step(
            &self.db.conn,
            s.id,
            Some(&[StepState::Pending, StepState::Stopped]),
            StepWrite {
                confirmed: Some(true),
                ..Default::default()
            },
        )
        .await
        .map_err(|e| e.to_string())?
        .ok_or("this step moved meanwhile")?;
        self.advance_plan(p.id).await;
        Ok(())
    }

    async fn cancel_step(self: &Arc<Self>, p: &plan_entity::Model, seq: i32) -> Result<(), String> {
        let s = psvc::steps_of(&self.db.conn, p.id)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|s| s.seq == seq)
            .ok_or_else(|| format!("plan #{} has no step {seq}", p.id))?;
        if s.state != StepState::Running {
            return Err(format!("step {seq} is {}", step_state_word(s.state)));
        }
        if let Some(did) = s.dispatch_id {
            if let Ok(Some(d)) = svc::get_dispatch(&self.db.conn, did).await {
                if !self.stop_dispatch(&d).await {
                    return Err(format!("dispatch #{did} is past stopping"));
                }
            }
        }
        if let Some(mid) = s.message_id {
            let moved = msvc::move_messages(
                &self.db.conn,
                &[mid],
                &[MessageState::Queued, MessageState::Delivered],
                MessageState::Stopped,
            )
            .await
            .unwrap_or_default();
            if !moved.is_empty() {
                self.refresh_lines(mid, "stopped").await;
                if let Ok(Some(m)) = msvc::get_message(&self.db.conn, mid).await {
                    self.drop_waiting(
                        &m,
                        crate::db::service::personal_agent_service::Closing::new(
                            crate::db::service::personal_agent_service::Closer::Codeg,
                            "plan_canceled",
                        ),
                    )
                    .await;
                }
            }
        }
        let _ = psvc::update_step(
            &self.db.conn,
            s.id,
            Some(&[StepState::Running]),
            StepWrite {
                state: Some(StepState::Canceled),
                error: Some(Some("the owner canceled it".into())),
                ended_at: Some(Some(super::clock::now())),
                ..Default::default()
            },
        )
        .await;
        self.advance_plan(p.id).await;
        Ok(())
    }

    /// Take a change back: each step it touched that has not started goes
    /// back to what it was (one it added goes, one it removed comes back);
    /// those that started since keep it.
    async fn undo_change(
        self: &Arc<Self>,
        p: &plan_entity::Model,
        index: usize,
    ) -> Result<(), String> {
        {
            let _one = self.plan_lock.lock().await;
            let Ok(Some(p)) = psvc::get(&self.db.conn, p.id).await else {
                return Err("the plan is gone".into());
            };
            if !p.state.is_live() {
                return Err(format!("plan #{} is over", p.id));
            }
            let mut changes = changes_of(&p);
            let c = changes.get(index).cloned().ok_or("no such change")?;
            if c.undone {
                return Err("this change was taken back already".into());
            }
            let steps = psvc::steps_of(&self.db.conn, p.id)
                .await
                .unwrap_or_default();
            let by_seq: HashMap<i32, &step_entity::Model> =
                steps.iter().map(|s| (s.seq, s)).collect();
            // The plan as it would be once taken back, to check its order.
            let mut after: BTreeMap<i32, Vec<i32>> =
                steps.iter().map(|s| (s.seq, s.deps())).collect();
            let mut kept = Vec::new();
            let mut todo: Vec<&Undo> = Vec::new();
            for u in &c.undo {
                match (by_seq.get(&u.seq), &u.before) {
                    (Some(now), _) if !UNSTARTED.contains(&now.state) => kept.push(u.seq),
                    (Some(_), None) => {
                        after.remove(&u.seq);
                        todo.push(u);
                    }
                    (_, Some(before)) => {
                        after.insert(u.seq, before.depends_on.clone());
                        todo.push(u);
                    }
                    (None, None) => {}
                }
            }
            if todo.is_empty() {
                return Err(
                    "every step this change touched has started; it cannot be taken back".into(),
                );
            }
            if after.is_empty() {
                return Err("taking it back would leave the plan with no step".into());
            }
            let order: Vec<(i32, Vec<i32>)> = after.into_iter().collect();
            if let Err(e) = check_order(&order) {
                return Err(format!("taking it back would break the plan's order: {e}"));
            }
            for u in todo {
                match (by_seq.get(&u.seq), &u.before) {
                    (Some(now), None) => {
                        let _ = psvc::delete_step(&self.db.conn, now.id, UNSTARTED).await;
                    }
                    (Some(now), Some(before)) => {
                        let _ = psvc::update_step(
                            &self.db.conn,
                            now.id,
                            Some(UNSTARTED),
                            StepWrite {
                                content: Some(before.clone()),
                                state: u.state.filter(|s| *s != StepState::Running),
                                ..Default::default()
                            },
                        )
                        .await;
                    }
                    (None, Some(before)) => {
                        if let Ok(s) = psvc::insert_step(&self.db.conn, p.id, before.clone()).await
                        {
                            if let Some(state) = u.state.filter(|s| *s != StepState::Pending) {
                                let _ = psvc::update_step(
                                    &self.db.conn,
                                    s.id,
                                    None,
                                    StepWrite {
                                        state: Some(state),
                                        ..Default::default()
                                    },
                                )
                                .await;
                            }
                        }
                    }
                    (None, None) => {}
                }
            }
            if let Some(entry) = changes.get_mut(index) {
                entry.undone = true;
                entry.kept = kept;
            }
            let _ = psvc::update(
                &self.db.conn,
                p.id,
                None,
                PlanWrite {
                    title: c.title_before.clone(),
                    goal: c.goal_before.clone(),
                    changes: Some(serde_json::to_string(&changes).unwrap_or_else(|_| "[]".into())),
                    ..Default::default()
                },
            )
            .await;
        }
        self.tell_brain_plan(
            p,
            &format!(
                "The owner took back a change to plan #{} \"{}\" ({}); plan_read shows it as it \
                 is now.",
                p.id,
                p.title,
                changes_of(p)
                    .get(index)
                    .map(|c| c.items.iter().map(item_text).collect::<Vec<_>>().join("; "))
                    .unwrap_or_default()
            ),
            "undone",
        )
        .await;
        self.advance_plan(p.id).await;
        Ok(())
    }
}

/// Steps that can be changed or taken back to what they were.
const CHANGEABLE: &[StepState] = &[
    StepState::Pending,
    StepState::Failed,
    StepState::Canceled,
    StepState::Stopped,
];
/// Steps that have not started: a change to them can be taken back.
const UNSTARTED: &[StepState] = &[StepState::Pending, StepState::Stopped];

/// Whether something of a change can still be taken back.
fn undoable(c: &Change, steps: &[step_entity::Model]) -> bool {
    c.undo
        .iter()
        .any(|u| match steps.iter().find(|s| s.seq == u.seq) {
            Some(s) => UNSTARTED.contains(&s.state),
            None => u.before.is_some(),
        })
}

fn item_text(i: &ChangeItem) -> String {
    let step = i
        .seq
        .map(|s| {
            format!(
                "step {s}{}",
                i.title
                    .as_deref()
                    .map(|t| format!(" \"{t}\""))
                    .unwrap_or_default()
            )
        })
        .unwrap_or_default();
    match i.kind.as_str() {
        "added" => format!("added {step}"),
        "removed" => format!("removed {step}"),
        "retry" => format!("{step} goes again"),
        "changed" => format!("changed {step} ({})", i.fields.join(", ")),
        "title" => format!("renamed it \"{}\"", i.title.as_deref().unwrap_or("")),
        "goal" => "changed its goal".into(),
        other => other.to_string(),
    }
}

/// An assistant's plans still going, as deleting it lists them.
pub async fn impact_plans(
    db: &crate::db::AppDatabase,
    bot: i32,
) -> Vec<crate::models::personal_agent_bots::ImpactPlan> {
    psvc::of_bot(
        &db.conn,
        bot,
        &[
            PlanState::Draft,
            PlanState::Running,
            PlanState::Stuck,
            PlanState::Stopped,
        ],
    )
    .await
    .unwrap_or_default()
    .into_iter()
    .map(|p| crate::models::personal_agent_bots::ImpactPlan {
        plan_id: p.id,
        title: p.title,
    })
    .collect()
}

/// Steps of other assistants' live plans handed to work assistant `bot`
/// and not done yet, as deleting it lists them.
pub async fn impact_steps(
    db: &crate::db::AppDatabase,
    bot: i32,
) -> Vec<crate::models::personal_agent_bots::ImpactPlanStep> {
    let mut out = Vec::new();
    for s in psvc::steps_for_target(&db.conn, TargetKind::Bot, bot)
        .await
        .unwrap_or_default()
    {
        let Ok(Some(p)) = psvc::get(&db.conn, s.plan_id).await else {
            continue;
        };
        if !p.state.is_live() || p.bot_id == bot {
            continue;
        }
        let owner = svc::get_bot_any(&db.conn, p.bot_id)
            .await
            .ok()
            .flatten()
            .map(|b| display_name(&b))
            .unwrap_or_default();
        out.push(crate::models::personal_agent_bots::ImpactPlanStep {
            plan_id: p.id,
            plan_title: p.title,
            bot_name: owner,
            seq: s.seq,
            title: s.title,
        });
    }
    out
}

/// The plans of an assistant being deleted stop where they are: nothing new
/// is handed out for it.
pub async fn retire_plans_of(db: &crate::db::AppDatabase, bot: i32) {
    for p in psvc::of_bot(
        &db.conn,
        bot,
        &[PlanState::Draft, PlanState::Running, PlanState::Stuck],
    )
    .await
    .unwrap_or_default()
    {
        let _ = psvc::update(
            &db.conn,
            p.id,
            None,
            PlanWrite {
                state: Some(if p.state == PlanState::Draft {
                    PlanState::Canceled
                } else {
                    PlanState::Stopped
                }),
                stuck_reason: Some(Some("its assistant was deleted".into())),
                ..Default::default()
            },
        )
        .await;
        let _ = psvc::move_steps(&db.conn, p.id, &[StepState::Pending], StepState::Stopped).await;
    }
}

/// The news told of a plan, for a test.
#[cfg(test)]
pub(crate) fn told_for_test(p: &plan_entity::Model) -> Told {
    told_of(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_order_with_unknown_steps_or_a_circle_is_refused() {
        assert!(check_order(&[(1, vec![]), (2, vec![1]), (3, vec![1, 2])]).is_ok());
        assert!(check_order(&[(1, vec![1])]).unwrap_err().contains("itself"));
        assert!(check_order(&[(1, vec![]), (2, vec![4])])
            .unwrap_err()
            .contains("does not have"));
        let e = check_order(&[(1, vec![]), (2, vec![3]), (3, vec![2]), (4, vec![1])]).unwrap_err();
        assert!(e.contains("2, 3"), "{e}");
    }

    #[test]
    fn a_step_reads_numbers_written_either_way() {
        let a = step_args(&json!({
            "id": "2", "title": " T ", "to": 7, "depends_on": ["#1", 3],
            "done_when": null, "remove": true
        }))
        .unwrap();
        assert_eq!(a.id, Some(2));
        assert_eq!(a.title.as_deref(), Some("T"));
        assert_eq!(a.to.as_deref(), Some("7"));
        assert_eq!(a.depends_on, Some(vec![1, 3]));
        assert_eq!(a.done_when, Some(None));
        assert!(a.remove && !a.retry);
        assert!(step_args(&json!({ "depends_on": ["x"] })).is_err());
        // What an older plan named its executor by is refused, not ignored.
        for old in [json!({ "bot": 7 }), json!({ "assistant_id": 3 }), json!({ "kind": "code" })] {
            assert!(step_args(&old).unwrap_err().contains("`to`"), "{old}");
        }
        assert!(step_args(&json!("step")).is_err());
    }

    fn dispatch(state: DispatchState, mode: DispatchMode) -> dispatch_entity::Model {
        let now = Utc::now();
        dispatch_entity::Model {
            id: 1,
            mode,
            work_snapshot: "{}".into(),
            folder_id: Some(1),
            deliverable: (mode == DispatchMode::Task).then(|| "change".into()),
            title: "t".into(),
            prompt: "p".into(),
            work_task_id: (mode == DispatchMode::Task).then_some(9),
            conversation_id: None,
            connection_id: None,
            state,
            result_excerpt: Some("did it".into()),
            error: None,
            origin_batch_id: None,
            source_batch_id: None,
            on_done: None,
            turns: 1,
            followup: None,
            created_at: now,
            updated_at: now,
            finished_at: None,
            round_op_id: None,
            bot_id: Some(1),
            origin_bot_id: None,
            origin_row_id: None,
            thread_id: None,
            for_input: None,
            done_when: None,
            pr_fix: None,
            is_check: false,
            replaces_id: None,
            replaces_run_seq: None,
            replaced_by: None,
        }
    }

    #[test]
    fn code_work_is_done_once_it_landed_and_a_conversation_once_it_ended() {
        use crate::db::entities::work_task::{self, WorkTaskStatus};
        let mut task: work_task::Model = super::super::ladder::tests::task(WorkTaskStatus::Review);
        task.files_changed = Some(3);
        // In review with changes: waits for its acceptance and merge.
        let d = dispatch(DispatchState::Review, DispatchMode::Task);
        assert_eq!(
            dispatch_outcome(&d, Some(&task), None, false),
            Outcome::Running
        );
        // Nothing changed: nothing to land.
        task.files_changed = Some(0);
        assert_eq!(
            dispatch_outcome(&d, Some(&task), None, false),
            Outcome::Done(Some("did it".into()))
        );
        // Merged.
        task.files_changed = Some(3);
        task.status = WorkTaskStatus::Done;
        task.completion_kind = Some("merged".into());
        let d = dispatch(DispatchState::Completed, DispatchMode::Task);
        assert_eq!(
            dispatch_outcome(&d, Some(&task), None, false),
            Outcome::Done(Some("did it".into()))
        );
        // Delivered as a pull request, not merged yet.
        task.completion_kind = Some("delivered_pr".into());
        assert_eq!(
            dispatch_outcome(&d, Some(&task), None, false),
            Outcome::Running
        );
        // Delivered to a pull request and kept in review: the pull request
        // says when it landed — merged is done, closed is failed, the board
        // still showing review is no matter.
        let mut kept = task.clone();
        kept.status = WorkTaskStatus::Review;
        kept.completion_kind = None;
        kept.delivery = Some(
            r#"{"provider":"github","server_host":"github.com","account_id":"a","owner_repo":"acme/app","pr_url":"https://github.com/acme/app/pull/42","pr_number":42}"#
                .into(),
        );
        let review = dispatch(DispatchState::Review, DispatchMode::Task);
        let facts = |phase: &str| crate::models::personal_agent_overview::PrFacts {
            watch_id: 1,
            phase: Some(phase.into()),
            passed: 0,
            failed: 0,
            pending: 0,
            total: 0,
            checks_known: true,
            head: None,
            merge_state: None,
            last_read_at: None,
            stale: false,
            watching: phase != "merged" && phase != "closed",
        };
        assert_eq!(
            dispatch_outcome(&review, Some(&kept), None, false),
            Outcome::Running
        );
        assert_eq!(
            dispatch_outcome(&review, Some(&kept), Some(&facts("checks_failed")), false),
            Outcome::Running
        );
        assert_eq!(
            dispatch_outcome(&review, Some(&kept), Some(&facts("merged")), false),
            Outcome::Done(Some("did it".into()))
        );
        assert!(matches!(
            dispatch_outcome(&review, Some(&kept), Some(&facts("closed")), false),
            Outcome::Failed(_)
        ));
        // In review with no pull request: a merged one elsewhere is not its.
        let mut local = kept.clone();
        local.delivery = None;
        assert_eq!(
            dispatch_outcome(&review, Some(&local), Some(&facts("merged")), false),
            Outcome::Running
        );
        // A chat ended.
        let c = dispatch(DispatchState::Completed, DispatchMode::Chat);
        assert_eq!(
            dispatch_outcome(&c, None, None, false),
            Outcome::Done(Some("did it".into()))
        );
        // Interrupted: running while codeg retries it, failed otherwise.
        let i = dispatch(DispatchState::Interrupted, DispatchMode::Chat);
        assert_eq!(dispatch_outcome(&i, None, None, true), Outcome::Running);
        assert!(matches!(
            dispatch_outcome(&i, None, None, false),
            Outcome::Failed(_)
        ));
        let h = dispatch(DispatchState::HandedOver, DispatchMode::Session);
        assert!(matches!(
            dispatch_outcome(&h, None, None, false),
            Outcome::Canceled(_)
        ));
    }

    #[test]
    fn a_change_can_be_taken_back_while_a_step_it_touched_has_not_started() {
        let now = Utc::now();
        let step = |seq: i32, state: StepState| step_entity::Model {
            id: seq,
            plan_id: 1,
            seq,
            title: "t".into(),
            target_kind: TargetKind::Bot,
            target_id: 2,
            target_name: "B".into(),
            mode: None,
            project_id: None,
            deliverable: None,
            prompt: "p".into(),
            done_when: None,
            depends_on: "[]".into(),
            state,
            confirmed: true,
            dispatch_id: None,
            message_id: None,
            attempt: 0,
            failures: 0,
            result: None,
            error: None,
            started_at: None,
            ended_at: None,
            created_at: now,
            updated_at: now,
        };
        let c = Change {
            at: now,
            by: "assistant".into(),
            items: vec![],
            reason: None,
            undo: vec![Undo {
                seq: 2,
                before: None,
                state: None,
            }],
            title_before: None,
            goal_before: None,
            undone: false,
            kept: vec![],
        };
        assert!(undoable(
            &c,
            &[step(1, StepState::Done), step(2, StepState::Pending)]
        ));
        assert!(!undoable(
            &c,
            &[step(1, StepState::Done), step(2, StepState::Running)]
        ));
        // A removed step that is gone can come back.
        let r = Change {
            undo: vec![Undo {
                seq: 3,
                before: Some(NewStep::of(&step(3, StepState::Pending))),
                state: Some(StepState::Pending),
            }],
            ..c
        };
        assert!(undoable(&r, &[step(1, StepState::Done)]));
    }
}
