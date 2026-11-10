//! The personal agent's reply, built from its connection's events as they
//! apply to the session state.
//!
//! The page shows a reply as ONE step slot: the step the agent is on now
//! replaces the one before — a run of main-thread text (multi-line, streaming),
//! or a single line for anything else (a tool call, a thought, a plan) — and
//! once the turn ends only the LAST text run stays, as the reply's body.
//!
//! Built here, under the session state's write lock, one event at a time: the
//! in-process bus the engine reads is lossy, and only here is every event seen
//! exactly once and in order. Built only for a prompt the engine tagged with a
//! token (`ConnectionCommand::Prompt::reply_token`): the token turns active when
//! that prompt itself starts (`Prompting`), and the first `TurnComplete`
//! applied after seals that turn. A prompt from anywhere else, or a turn the
//! agent starts on its own, builds nothing — and none of their events reach a
//! sealed turn. A turn stays until the engine releases it after settling.
//!
//! Quote markers (`[[quote:#ID]]`, the agent naming the timeline row it
//! answers) are collected from every text run and never shown: a run made only
//! of markers and whitespace is not a step.
//!
//! Besides the slot, a turn keeps the last [`MAX_HISTORY`] steps it went
//! through, each with what its call was given and the tail of what it gave
//! back ([`StepRaw`]): the page's status line lists them, one short line
//! each (8.4), and the roster says what an assistant is doing from the one
//! it is on.

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, Utc};
use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use crate::acp::types::{AcpEvent, PlanEntryInfo};

/// Reply turns a connection keeps at most. Each lives until the engine
/// releases it after settling the turn, so there is one at a time in practice;
/// the cap only bounds what an engine that never comes back would leave.
const MAX_REPLY_TURNS: usize = 32;
/// Longest one-line title kept for a step.
const MAX_TITLE_CHARS: usize = 200;
/// Steps of a turn kept for its list.
pub const MAX_HISTORY: usize = 100;
/// A call's input is kept (parsed) only up to this size: enough for an edit's
/// old and new text, not for a whole generated file.
const MAX_INPUT_BYTES: usize = 256 * 1024;
/// The tail of a call's output kept: where a test run's summary and an exit
/// code are.
const MAX_OUTPUT_CHARS: usize = 4000;

static QUOTE_MARKER: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?i)\[\[quote:#?(\d+)\]\]").expect("valid regex"));

/// A step as the page draws it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum ReplyStep {
    /// A run of main-thread text, quote markers removed.
    Text { n: u32, text: String },
    /// Anything else, drawn as one line.
    Step {
        n: u32,
        /// The tool call, for a step that is one.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        /// ACP's tool kind (`read`, `edit`, `execute`, `search`, `fetch`, …),
        /// or `think`, `plan`, `compact`, `question` for the steps that are no
        /// ordinary tool call.
        kind: String,
        /// As the agent reported it; the page cleans it for display.
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
        /// Waiting on the owner: a permission, a question, a plan approval.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        awaiting: bool,
    },
}

impl ReplyStep {
    /// The step's ordinal in its turn — the page keys the slot on it.
    pub fn n(&self) -> u32 {
        match self {
            ReplyStep::Text { n, .. } | ReplyStep::Step { n, .. } => *n,
        }
    }
}

/// The last text run of a turn: the reply's body once the turn ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReplyText {
    pub n: u32,
    pub text: String,
}

/// One reply turn, as the engine reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ReplySnapshot {
    pub token: String,
    /// The envelope `seq` of the `TurnComplete` that sealed it.
    pub completed_seq: Option<u64>,
    /// That `TurnComplete`'s stop reason: how the turn ended, even when the
    /// engine never reads the event itself.
    pub stop_reason: Option<String>,
    pub current: Option<ReplyStep>,
    pub last_text: Option<ReplyText>,
    /// Steps the turn went through.
    pub step_count: u32,
    /// The ids of every quote marker the turn wrote, in order.
    pub quotes: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Slot {
    Text,
    Think,
    Plan,
    Tool(String),
}

#[derive(Debug, Clone)]
struct ToolStep {
    n: u32,
    kind: String,
    title: String,
    status: Option<String>,
    started_at: DateTime<Utc>,
    /// The call's input, parsed (`None`: none, not JSON, or too big).
    input: Option<serde_json::Value>,
    /// The first file location the call reported.
    path: Option<String>,
    /// The tail of its output.
    output: Option<String>,
}

/// One step of a turn's list, as the agent reported it: what the page turns
/// into a short line (`personal_agent::activity`).
#[derive(Debug, Clone, PartialEq)]
pub struct StepRaw {
    pub n: u32,
    /// `text`, `think`, `plan`, ACP's tool kind, or `compact` / `question`.
    pub kind: String,
    pub title: String,
    pub status: Option<String>,
    /// Waiting on the owner: a permission, a question, a plan approval.
    pub awaiting: bool,
    pub started_at: DateTime<Utc>,
    pub input: Option<serde_json::Value>,
    pub path: Option<String>,
    pub output: Option<String>,
}

/// A step in a turn's list: the tool calls by id (their details live in
/// `tools` and keep updating), the rest as they were.
#[derive(Debug, Clone)]
enum Past {
    Text,
    Think,
    Plan(String),
    Tool(String),
    /// A wait not tied to a call of the main thread.
    Wait { kind: String, title: String },
}

#[derive(Debug, Clone)]
struct PastStep {
    n: u32,
    at: DateTime<Utc>,
    step: Past,
}

/// Something the turn waits on the owner for. Pinned to the slot until it is
/// resolved: nothing replaces it meanwhile.
#[derive(Debug, Clone)]
struct Awaiting {
    /// `permission:<request id>`, `question:<id>`, `plan:<approval id>`.
    key: String,
    n: u32,
    tool_id: Option<String>,
    kind: String,
    title: String,
}

#[derive(Debug, Clone)]
struct ReplyTurn {
    token: String,
    completed_seq: Option<u64>,
    stop_reason: Option<String>,
    steps: u32,
    slot: Option<Slot>,
    slot_n: u32,
    plan_title: String,
    /// The text run being written (markers in), visible or not yet.
    run: String,
    /// The run's ordinal once it has visible text.
    run_n: Option<u32>,
    /// The last visible run before the one being written.
    last_closed: Option<(u32, String)>,
    tools: HashMap<String, ToolStep>,
    /// Calls of a sub-agent: they belong to the call that launched it.
    children: HashSet<String>,
    awaiting: Vec<Awaiting>,
    /// Markers of the runs already closed.
    quotes: Vec<i64>,
    /// The last steps, oldest first.
    history: VecDeque<PastStep>,
}

impl ReplyTurn {
    fn new(token: String) -> Self {
        Self {
            token,
            completed_seq: None,
            stop_reason: None,
            steps: 0,
            slot: None,
            slot_n: 0,
            plan_title: String::new(),
            run: String::new(),
            run_n: None,
            last_closed: None,
            tools: HashMap::new(),
            children: HashSet::new(),
            awaiting: Vec::new(),
            quotes: Vec::new(),
            history: VecDeque::new(),
        }
    }

    fn remember(&mut self, n: u32, step: Past) {
        if self.history.len() >= MAX_HISTORY {
            self.history.pop_front();
        }
        self.history.push_back(PastStep {
            n,
            at: Utc::now(),
            step,
        });
    }

    /// A new step in the slot, ending the text run.
    fn open_step(&mut self, slot: Slot) -> u32 {
        self.close_run();
        self.steps += 1;
        self.slot = Some(slot.clone());
        self.slot_n = self.steps;
        let past = match slot {
            Slot::Text => Past::Text,
            Slot::Think => Past::Think,
            Slot::Plan => Past::Plan(String::new()),
            Slot::Tool(id) => Past::Tool(id),
        };
        self.remember(self.steps, past);
        self.steps
    }

    fn close_run(&mut self) {
        if self.run.is_empty() {
            self.run_n = None;
            return;
        }
        self.quotes.extend(quote_ids(&self.run));
        let raw = std::mem::take(&mut self.run);
        if let Some(n) = self.run_n.take() {
            self.last_closed = Some((n, raw));
        }
    }

    fn text(&mut self, delta: &str) {
        self.run.push_str(delta);
        if self.run_n.is_some() {
            return;
        }
        // Whitespace or a marker alone is no step yet: it waits for text the
        // owner can see, or for the next step to drop it.
        if !display_text(&self.run).is_empty() {
            self.steps += 1;
            self.run_n = Some(self.steps);
            self.slot = Some(Slot::Text);
            self.slot_n = self.steps;
            self.remember(self.steps, Past::Text);
        }
    }

    fn think(&mut self, delta: &str) {
        if self.slot == Some(Slot::Think) || delta.trim().is_empty() {
            return;
        }
        self.open_step(Slot::Think);
    }

    fn plan(&mut self, entries: &[PlanEntryInfo]) {
        if self.slot != Some(Slot::Plan) {
            self.open_step(Slot::Plan);
        }
        self.plan_title = plan_title(entries);
        let (n, title) = (self.slot_n, self.plan_title.clone());
        if let Some(p) = self.history.iter_mut().rev().find(|p| p.n == n) {
            p.step = Past::Plan(title);
        }
    }

    fn tool(
        &mut self,
        id: &str,
        kind: Option<&str>,
        title: Option<&str>,
        status: Option<&str>,
        meta: Option<&serde_json::Value>,
    ) {
        self.tool_with(id, kind, title, status, meta, &CallData::default());
    }

    #[allow(clippy::too_many_arguments)]
    fn tool_with(
        &mut self,
        id: &str,
        kind: Option<&str>,
        title: Option<&str>,
        status: Option<&str>,
        meta: Option<&serde_json::Value>,
        data: &CallData<'_>,
    ) {
        if id.is_empty() || self.children.contains(id) {
            return;
        }
        if meta.and_then(parent_tool_call_id).is_some() {
            self.children.insert(id.to_string());
            return;
        }
        let compact = meta.is_some_and(is_compaction_meta);
        let title = title.map(one_line).filter(|t| !t.is_empty());
        match self.tools.get_mut(id) {
            // The step in the slot updates in place; one already replaced (a
            // parallel call that started earlier) updates too, but is never
            // brought back.
            Some(t) => {
                if compact {
                    t.kind = "compact".into();
                } else if let Some(k) = kind.filter(|k| !k.is_empty()) {
                    t.kind = k.to_string();
                }
                if let Some(title) = title {
                    t.title = title;
                }
                if let Some(s) = status {
                    t.status = Some(s.to_string());
                }
                data.apply(t);
            }
            // Never seen: a step of its own, `ToolCallUpdate`-only calls (a
            // compaction) included.
            None => {
                let n = self.open_step(Slot::Tool(id.to_string()));
                let mut step = ToolStep {
                    n,
                    kind: if compact {
                        "compact".to_string()
                    } else {
                        kind.filter(|k| !k.is_empty()).unwrap_or("other").to_string()
                    },
                    title: title.unwrap_or_default(),
                    status: status.map(str::to_string),
                    started_at: Utc::now(),
                    input: None,
                    path: None,
                    output: None,
                };
                data.apply(&mut step);
                self.tools.insert(id.to_string(), step);
            }
        }
    }

    fn wait(&mut self, key: String, tool_id: Option<&str>, kind: &str, title: String) {
        let tool_id = tool_id.filter(|id| !id.is_empty());
        let entry = match tool_id {
            // The call the owner is asked about.
            Some(id) if self.tools.contains_key(id) => {
                let t = &self.tools[id];
                Awaiting {
                    key,
                    n: t.n,
                    tool_id: Some(id.to_string()),
                    kind: t.kind.clone(),
                    title: if t.title.is_empty() { title } else { t.title.clone() },
                }
            }
            // A main-thread call not seen yet: it opens as a step of its own.
            Some(id) if !self.children.contains(id) => {
                self.tool(id, Some(kind), Some(title.as_str()), None, None);
                let n = self.tools.get(id).map(|t| t.n).unwrap_or(self.steps);
                Awaiting {
                    key,
                    n,
                    tool_id: Some(id.to_string()),
                    kind: kind.to_string(),
                    title,
                }
            }
            // A sub-agent's call, or none named: shown for the wait only.
            _ => {
                self.steps += 1;
                self.remember(
                    self.steps,
                    Past::Wait {
                        kind: kind.to_string(),
                        title: title.clone(),
                    },
                );
                Awaiting {
                    key,
                    n: self.steps,
                    tool_id: tool_id.map(str::to_string),
                    kind: kind.to_string(),
                    title,
                }
            }
        };
        self.awaiting.retain(|a| a.key != entry.key);
        self.awaiting.push(entry);
    }

    fn resolve(&mut self, key: &str) {
        self.awaiting.retain(|a| a.key != key);
    }

    fn seal(&mut self, seq: u64, stop_reason: &str) {
        self.completed_seq = Some(seq);
        self.stop_reason = Some(stop_reason.to_string());
        // A turn's end answers everything it was still waiting on.
        self.awaiting.clear();
    }

    fn current(&self) -> Option<ReplyStep> {
        if let Some(a) = self.awaiting.last() {
            let status = a
                .tool_id
                .as_ref()
                .and_then(|id| self.tools.get(id))
                .and_then(|t| t.status.clone());
            return Some(ReplyStep::Step {
                n: a.n,
                id: a.tool_id.clone(),
                kind: a.kind.clone(),
                title: a.title.clone(),
                status,
                awaiting: true,
            });
        }
        let step = |kind: &str, title: String| ReplyStep::Step {
            n: self.slot_n,
            id: None,
            kind: kind.to_string(),
            title,
            status: None,
            awaiting: false,
        };
        match self.slot.as_ref()? {
            Slot::Text => Some(ReplyStep::Text {
                n: self.slot_n,
                text: display_text(&self.run),
            }),
            Slot::Think => Some(step("think", String::new())),
            Slot::Plan => Some(step("plan", self.plan_title.clone())),
            Slot::Tool(id) => {
                let t = self.tools.get(id)?;
                Some(ReplyStep::Step {
                    n: t.n,
                    id: Some(id.clone()),
                    kind: t.kind.clone(),
                    title: t.title.clone(),
                    status: t.status.clone(),
                    awaiting: false,
                })
            }
        }
    }

    fn last_text(&self) -> Option<ReplyText> {
        if let Some(n) = self.run_n {
            return Some(ReplyText {
                n,
                text: display_text(&self.run),
            });
        }
        self.last_closed.as_ref().map(|(n, raw)| ReplyText {
            n: *n,
            text: display_text(raw),
        })
    }

    fn snapshot(&self) -> ReplySnapshot {
        let mut quotes = self.quotes.clone();
        quotes.extend(quote_ids(&self.run));
        ReplySnapshot {
            token: self.token.clone(),
            completed_seq: self.completed_seq,
            stop_reason: self.stop_reason.clone(),
            current: self.current(),
            last_text: self.last_text(),
            step_count: self.steps,
            quotes,
        }
    }

    fn raw_of_tool(&self, id: &str, at: DateTime<Utc>) -> Option<StepRaw> {
        let t = self.tools.get(id)?;
        Some(StepRaw {
            n: t.n,
            kind: t.kind.clone(),
            title: t.title.clone(),
            status: t.status.clone(),
            awaiting: self.awaiting.iter().any(|a| a.tool_id.as_deref() == Some(id)),
            started_at: t.started_at.min(at),
            input: t.input.clone(),
            path: t.path.clone(),
            output: t.output.clone(),
        })
    }

    fn raw_of(&self, p: &PastStep) -> Option<StepRaw> {
        let plain = |kind: &str, title: String| StepRaw {
            n: p.n,
            kind: kind.to_string(),
            title,
            status: None,
            awaiting: false,
            started_at: p.at,
            input: None,
            path: None,
            output: None,
        };
        match &p.step {
            Past::Text => Some(plain("text", String::new())),
            Past::Think => Some(plain("think", String::new())),
            Past::Plan(title) => Some(plain("plan", title.clone())),
            Past::Tool(id) => self.raw_of_tool(id, p.at),
            Past::Wait { kind, title } => Some(StepRaw {
                awaiting: self.awaiting.iter().any(|a| a.n == p.n),
                ..plain(kind, title.clone())
            }),
        }
    }

    /// The steps kept, oldest first.
    fn steps_raw(&self) -> Vec<StepRaw> {
        self.history.iter().filter_map(|p| self.raw_of(p)).collect()
    }

    /// The step the turn is on now, with its call's details.
    fn current_raw(&self) -> Option<StepRaw> {
        if let Some(a) = self.awaiting.last() {
            let mut raw = a
                .tool_id
                .as_deref()
                .and_then(|id| self.raw_of_tool(id, Utc::now()))
                .unwrap_or_else(|| StepRaw {
                    n: a.n,
                    kind: a.kind.clone(),
                    title: a.title.clone(),
                    status: None,
                    awaiting: true,
                    started_at: Utc::now(),
                    input: None,
                    path: None,
                    output: None,
                });
            raw.awaiting = true;
            return Some(raw);
        }
        let n = self.slot_n;
        self.history
            .iter()
            .rev()
            .find(|p| p.n == n)
            .and_then(|p| self.raw_of(p))
    }
}

/// What a tool call event says beyond its kind, title and status.
#[derive(Default)]
struct CallData<'a> {
    raw_input: Option<&'a str>,
    raw_output: Option<&'a str>,
    output_append: bool,
    content: Option<&'a str>,
    locations: Option<&'a serde_json::Value>,
}

impl CallData<'_> {
    fn apply(&self, t: &mut ToolStep) {
        if let Some(raw) = self.raw_input.filter(|r| !r.trim().is_empty()) {
            t.input = if raw.len() <= MAX_INPUT_BYTES {
                serde_json::from_str(raw).ok()
            } else {
                None
            };
        }
        if let Some(path) = self.locations.and_then(first_location) {
            t.path = Some(path);
        }
        match (self.raw_output, self.content) {
            (Some(out), _) if self.output_append => {
                let mut joined = t.output.take().unwrap_or_default();
                joined.push_str(out);
                t.output = Some(tail(&joined, MAX_OUTPUT_CHARS));
            }
            (Some(out), _) if !out.is_empty() => t.output = Some(tail(out, MAX_OUTPUT_CHARS)),
            (_, Some(content)) if !content.is_empty() && t.output.is_none() => {
                t.output = Some(tail(content, MAX_OUTPUT_CHARS));
            }
            _ => {}
        }
    }
}

fn first_location(v: &serde_json::Value) -> Option<String> {
    v.as_array()?
        .iter()
        .find_map(|l| l.get("path").and_then(|p| p.as_str()))
        .filter(|p| !p.is_empty())
        .map(str::to_string)
}

/// The last `max` chars of `s`.
fn tail(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        s.to_string()
    } else {
        s.chars().skip(n - max).collect()
    }
}

/// The reply turns of one connection (see the module docs).
#[derive(Debug, Clone, Default)]
pub struct ReplyTurns {
    turns: Vec<ReplyTurn>,
    /// The token whose turn the events go to now.
    active: Option<String>,
}

impl ReplyTurns {
    /// The prompt carrying `token` just started: its turn begins, and every
    /// event applied from here goes to it until a `TurnComplete` seals it.
    pub fn open(&mut self, token: String) {
        self.turns.retain(|t| t.token != token);
        self.turns.push(ReplyTurn::new(token.clone()));
        self.active = Some(token);
        while self.turns.len() > MAX_REPLY_TURNS {
            let Some(i) = self
                .turns
                .iter()
                .position(|t| Some(&t.token) != self.active.as_ref())
            else {
                break;
            };
            self.turns.remove(i);
        }
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    /// Apply one event to the open turn. `seq` is the envelope seq the event
    /// is about to be sent with; `turn_open` whether the connection holds a
    /// turn at all — a repeated `TurnComplete` (the cancel path emits its own)
    /// finds none and seals nothing.
    pub fn apply(&mut self, event: &AcpEvent, seq: u64, turn_open: bool) {
        let Some(token) = self.active.clone() else {
            return;
        };
        let Some(turn) = self.turns.iter_mut().find(|t| t.token == token) else {
            self.active = None;
            return;
        };
        match event {
            AcpEvent::ContentDelta {
                text,
                parent_tool_use_id: None,
            } => turn.text(text),
            AcpEvent::Thinking {
                text,
                parent_tool_use_id: None,
            } => turn.think(text),
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                meta,
                content,
                raw_input,
                raw_output,
                locations,
                ..
            } => turn.tool_with(
                tool_call_id,
                Some(kind),
                Some(title),
                Some(status),
                meta.as_ref(),
                &CallData {
                    raw_input: raw_input.as_deref(),
                    raw_output: raw_output.as_deref(),
                    output_append: false,
                    content: content.as_deref(),
                    locations: locations.as_ref(),
                },
            ),
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                title,
                status,
                meta,
                content,
                raw_input,
                raw_output,
                raw_output_append,
                locations,
                ..
            } => turn.tool_with(
                tool_call_id,
                None,
                title.as_deref(),
                status.as_deref(),
                meta.as_ref(),
                &CallData {
                    raw_input: raw_input.as_deref(),
                    raw_output: raw_output.as_deref(),
                    output_append: raw_output_append.unwrap_or(false),
                    content: content.as_deref(),
                    locations: locations.as_ref(),
                },
            ),
            AcpEvent::PlanUpdate { entries } => turn.plan(entries),
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                ..
            } => {
                let tool_id = crate::acp::session_state::extract_tool_call_id(tool_call);
                let kind = tool_call
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .filter(|k| !k.is_empty())
                    .unwrap_or("other");
                let title = tool_call
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(one_line)
                    .unwrap_or_default();
                turn.wait(
                    format!("permission:{request_id}"),
                    Some(&tool_id),
                    kind,
                    title,
                );
            }
            AcpEvent::PermissionResolved { request_id, .. } => {
                turn.resolve(&format!("permission:{request_id}"));
            }
            AcpEvent::QuestionRequest {
                question_id,
                questions,
            } => {
                let title = questions
                    .first()
                    .map(|q| one_line(&q.question))
                    .unwrap_or_default();
                turn.wait(format!("question:{question_id}"), None, "question", title);
            }
            AcpEvent::QuestionResolved { question_id } => {
                turn.resolve(&format!("question:{question_id}"));
            }
            AcpEvent::PlanApprovalRequest {
                approval_id,
                tool_call_id,
                plan_markdown,
            } => {
                turn.wait(
                    format!("plan:{approval_id}"),
                    Some(tool_call_id),
                    "plan",
                    plan_heading(plan_markdown),
                );
            }
            AcpEvent::PlanApprovalResolved { approval_id } => {
                turn.resolve(&format!("plan:{approval_id}"));
            }
            AcpEvent::TurnComplete { stop_reason, .. } if turn_open => {
                turn.seal(seq, stop_reason);
                self.active = None;
            }
            _ => {}
        }
    }

    pub fn snapshot(&self, token: &str) -> Option<ReplySnapshot> {
        self.turns
            .iter()
            .find(|t| t.token == token)
            .map(ReplyTurn::snapshot)
    }

    /// The steps turn `token` went through (the last [`MAX_HISTORY`]),
    /// oldest first.
    pub fn steps(&self, token: &str) -> Vec<StepRaw> {
        self.turns
            .iter()
            .find(|t| t.token == token)
            .map(ReplyTurn::steps_raw)
            .unwrap_or_default()
    }

    /// The step turn `token` is on now, with its call's details.
    pub fn current_step(&self, token: &str) -> Option<StepRaw> {
        self.turns
            .iter()
            .find(|t| t.token == token)
            .and_then(ReplyTurn::current_raw)
    }

    /// The engine settled the turn: forget it.
    pub fn release(&mut self, token: &str) {
        self.turns.retain(|t| t.token != token);
        if self.active.as_deref() == Some(token) {
            self.active = None;
        }
    }
}

/// The ids of the complete quote markers in `raw`, in order.
pub fn quote_ids(raw: &str) -> Vec<i64> {
    QUOTE_MARKER
        .captures_iter(raw)
        .filter_map(|c| c.get(1)?.as_str().parse::<i64>().ok())
        .collect()
}

/// `raw` as the owner sees it: quote markers removed — the one still being
/// written at the end too — and the edges trimmed.
pub fn display_text(raw: &str) -> String {
    let stripped = QUOTE_MARKER.replace_all(raw, "");
    let mut text: &str = stripped.as_ref();
    if let Some(at) = partial_marker_start(text) {
        text = &text[..at];
    }
    text.trim().to_string()
}

/// Where a marker that is still being written starts at the end of `s`.
fn partial_marker_start(s: &str) -> Option<usize> {
    // The longest prefix of a marker worth holding back: `[[quote:#` and
    // up to a dozen digits and a `]`.
    let from = s.len().saturating_sub(24);
    s.char_indices()
        .filter(|(i, c)| *i >= from && *c == '[')
        .map(|(i, _)| i)
        .find(|&i| is_marker_prefix(&s[i..]))
}

fn is_marker_prefix(t: &str) -> bool {
    const HEAD: &str = "[[quote:";
    let lower = t.to_ascii_lowercase();
    if lower.len() <= HEAD.len() {
        return HEAD.starts_with(lower.as_str());
    }
    let Some(rest) = lower.strip_prefix(HEAD) else {
        return false;
    };
    let rest = rest.strip_prefix('#').unwrap_or(rest);
    let digits = rest.find(|c: char| !c.is_ascii_digit()).unwrap_or(rest.len());
    let after = &rest[digits..];
    after.is_empty() || (after == "]" && digits > 0)
}

/// The tool call a sub-agent's call was made under, by the keys the page
/// nests sub-agent calls with: Claude Code's `claudeCode.parentToolUseId`,
/// CodeBuddy's `codebuddy.ai/parentToolCallId`, and codeg's own stamp for
/// OpenCode (`codeg.parentToolCallId`).
fn parent_tool_call_id(meta: &serde_json::Value) -> Option<&str> {
    meta.get("claudeCode")
        .and_then(|c| c.get("parentToolUseId"))
        .and_then(|v| v.as_str())
        .or_else(|| meta.get("codebuddy.ai/parentToolCallId").and_then(|v| v.as_str()))
        .or_else(|| meta.get("codeg.parentToolCallId").and_then(|v| v.as_str()))
        .filter(|id| !id.is_empty())
}

fn is_compaction_meta(meta: &serde_json::Value) -> bool {
    meta.get("contextCompaction")
        .is_some_and(|v| !v.is_null() && v != &serde_json::Value::Bool(false))
}

fn one_line(text: &str) -> String {
    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= MAX_TITLE_CHARS {
        line
    } else {
        let mut cut: String = line.chars().take(MAX_TITLE_CHARS).collect();
        cut.push('…');
        cut
    }
}

/// What a plan step says: the entry in progress, else the next one to do, else
/// the last.
fn plan_title(entries: &[PlanEntryInfo]) -> String {
    entries
        .iter()
        .find(|e| e.status == "in_progress")
        .or_else(|| entries.iter().find(|e| e.status == "pending"))
        .or_else(|| entries.last())
        .map(|e| one_line(&e.content))
        .unwrap_or_default()
}

fn plan_heading(markdown: &str) -> String {
    markdown
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .find(|l| !l.is_empty())
        .map(one_line)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(t: &str) -> AcpEvent {
        AcpEvent::ContentDelta {
            text: t.into(),
            parent_tool_use_id: None,
        }
    }

    fn child_text(t: &str) -> AcpEvent {
        AcpEvent::ContentDelta {
            text: t.into(),
            parent_tool_use_id: Some("task-1".into()),
        }
    }

    fn think(t: &str) -> AcpEvent {
        AcpEvent::Thinking {
            text: t.into(),
            parent_tool_use_id: None,
        }
    }

    fn tool(id: &str, title: &str, status: &str) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: title.into(),
            kind: "read".into(),
            status: status.into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        }
    }

    fn child_tool(id: &str, parent: &str) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: "child read".into(),
            kind: "read".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: Some(serde_json::json!({ "claudeCode": { "parentToolUseId": parent } })),
            images: None,
        }
    }

    fn update(id: &str, title: Option<&str>, status: &str) -> AcpEvent {
        AcpEvent::ToolCallUpdate {
            tool_call_id: id.into(),
            title: title.map(str::to_string),
            status: Some(status.into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        }
    }

    fn plan(entries: &[(&str, &str)]) -> AcpEvent {
        AcpEvent::PlanUpdate {
            entries: entries
                .iter()
                .map(|(content, status)| PlanEntryInfo {
                    content: content.to_string(),
                    priority: "medium".into(),
                    status: status.to_string(),
                })
                .collect(),
        }
    }

    fn permission(request_id: &str, tool_call_id: &str, title: &str) -> AcpEvent {
        AcpEvent::PermissionRequest {
            request_id: request_id.into(),
            tool_call: serde_json::json!({
                "toolCallId": tool_call_id,
                "title": title,
                "kind": "execute",
            }),
            options: Vec::new(),
            queued: 0,
        }
    }

    fn resolved(request_id: &str) -> AcpEvent {
        AcpEvent::PermissionResolved {
            request_id: request_id.into(),
            option_id: Some("allow".into()),
            origin: None,
        }
    }

    fn done() -> AcpEvent {
        AcpEvent::TurnComplete {
            session_id: "s".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        }
    }

    /// A turn opened under `token`, with `events` applied at seqs 1, 2, ….
    fn run(events: &[AcpEvent]) -> ReplySnapshot {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        for (i, e) in events.iter().enumerate() {
            turns.apply(e, i as u64 + 1, true);
        }
        turns.snapshot("tok").expect("the turn")
    }

    fn current_text(s: &ReplySnapshot) -> Option<(u32, &str)> {
        match s.current.as_ref()? {
            ReplyStep::Text { n, text } => Some((*n, text.as_str())),
            _ => None,
        }
    }

    fn current_step(s: &ReplySnapshot) -> Option<(u32, &str, &str, bool)> {
        match s.current.as_ref()? {
            ReplyStep::Step {
                n,
                kind,
                title,
                awaiting,
                ..
            } => Some((*n, kind.as_str(), title.as_str(), *awaiting)),
            _ => None,
        }
    }

    fn last(s: &ReplySnapshot) -> Option<(u32, &str)> {
        s.last_text.as_ref().map(|t| (t.n, t.text.as_str()))
    }

    #[test]
    fn text_then_tool_then_text_keeps_only_the_last_text() {
        let s = run(&[
            text("Let me "),
            text("look."),
            tool("t1", "Read a.rs", "in_progress"),
            update("t1", None, "completed"),
            text("\n\nFound it: "),
            text("line 42."),
            done(),
        ]);
        assert_eq!(current_text(&s), Some((3, "Found it: line 42.")));
        assert_eq!(last(&s), Some((3, "Found it: line 42.")));
        assert_eq!(s.step_count, 3);
        assert_eq!(s.completed_seq, Some(7));
    }

    #[test]
    fn a_turn_ending_on_a_tool_still_has_its_last_text() {
        let s = run(&[
            text("All done — the fix is in."),
            tool("t1", "Edit MEMORY.md", "in_progress"),
            update("t1", None, "completed"),
            done(),
        ]);
        let (n, kind, title, awaiting) = current_step(&s).expect("a tool step");
        assert_eq!((n, kind, title, awaiting), (2, "read", "Edit MEMORY.md", false));
        assert_eq!(last(&s), Some((1, "All done — the fix is in.")));
    }

    #[test]
    fn a_turn_of_tools_only_has_no_text() {
        let s = run(&[
            tool("t1", "dispatch", "in_progress"),
            update("t1", None, "completed"),
            done(),
        ]);
        assert!(s.last_text.is_none());
        assert_eq!(s.step_count, 1);
        let empty = run(&[done()]);
        assert!(empty.current.is_none() && empty.last_text.is_none());
        assert_eq!(empty.step_count, 0);
    }

    #[test]
    fn parallel_calls_show_the_newest_and_never_bring_an_older_one_back() {
        let s = run(&[
            tool("a", "Read a.rs", "in_progress"),
            tool("b", "Read b.rs", "in_progress"),
            update("a", Some("Read a.rs (done)"), "completed"),
            update("b", None, "completed"),
        ]);
        let (n, _, title, _) = current_step(&s).unwrap();
        assert_eq!((n, title), (2, "Read b.rs"));
        assert!(matches!(
            s.current,
            Some(ReplyStep::Step { ref status, .. }) if status.as_deref() == Some("completed")
        ));
    }

    #[test]
    fn a_call_seen_first_as_an_update_is_a_step_of_its_own() {
        let compaction = AcpEvent::ToolCallUpdate {
            tool_call_id: "compact-1".into(),
            title: Some("Compacting".into()),
            status: Some("in_progress".into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: Some(serde_json::json!({ "contextCompaction": { "version": 1 } })),
            images: None,
        };
        let s = run(&[text("Working on it."), compaction]);
        let (n, kind, title, _) = current_step(&s).unwrap();
        assert_eq!((n, kind, title), (2, "compact", "Compacting"));
    }

    #[test]
    fn a_thought_between_texts_is_a_step_and_ends_the_run() {
        let s = run(&[text("First."), think("hmm"), think(" more"), text("Second.")]);
        assert_eq!(current_text(&s), Some((3, "Second.")));
        assert_eq!(s.step_count, 3);
        let mid = run(&[text("First."), think("hmm"), think(" more")]);
        assert_eq!(current_step(&mid).map(|s| (s.0, s.1)), Some((2, "think")));
        assert_eq!(last(&mid), Some((1, "First.")));
    }

    #[test]
    fn a_plan_updates_in_place_and_splits_text() {
        let s = run(&[
            plan(&[("Read the code", "in_progress"), ("Fix it", "pending")]),
            plan(&[("Read the code", "completed"), ("Fix it", "in_progress")]),
        ]);
        assert_eq!(current_step(&s).map(|s| (s.0, s.1, s.2)), Some((1, "plan", "Fix it")));
        assert_eq!(s.step_count, 1);
        let split = run(&[
            text("Before."),
            plan(&[("Step", "pending")]),
            text("After."),
            done(),
        ]);
        assert_eq!(last(&split), Some((3, "After.")));
    }

    #[test]
    fn whitespace_and_markers_alone_are_no_step() {
        let s = run(&[
            tool("t1", "Read", "in_progress"),
            text("\n\n"),
            text("[[quote:#12]]  "),
        ]);
        assert_eq!(current_step(&s).map(|s| s.0), Some(1), "the tool stays");
        assert!(s.last_text.is_none());
        assert_eq!(s.quotes, vec![12]);
        // Visible text after the marker opens the step, marker hidden.
        let s = run(&[text("[[quote:#12]]"), text(" Yes, that one.")]);
        assert_eq!(current_text(&s), Some((1, "Yes, that one.")));
        assert_eq!(s.quotes, vec![12]);
    }

    #[test]
    fn a_marker_split_across_deltas_is_hidden_while_it_streams() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&text("Sure [[quo"), 1, true);
        assert_eq!(
            current_text(&turns.snapshot("tok").unwrap()),
            Some((1, "Sure"))
        );
        turns.apply(&text("te:#7"), 2, true);
        assert_eq!(
            current_text(&turns.snapshot("tok").unwrap()),
            Some((1, "Sure"))
        );
        turns.apply(&text("]] — done."), 3, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(current_text(&s), Some((1, "Sure  — done.")));
        assert_eq!(s.quotes, vec![7]);
    }

    #[test]
    fn markers_of_a_replaced_run_still_count() {
        let s = run(&[
            text("[[quote:#3]] On it."),
            tool("t1", "Read", "completed"),
            text("Here it is [[QUOTE:5]]."),
            done(),
        ]);
        assert_eq!(s.quotes, vec![3, 5]);
        assert_eq!(last(&s), Some((3, "Here it is .")));
    }

    #[test]
    fn a_sub_agent_never_becomes_a_step() {
        let s = run(&[
            tool("task-1", "Task: research", "in_progress"),
            child_text("child prose"),
            child_tool("c1", "task-1"),
            update("c1", Some("child read 2"), "completed"),
            AcpEvent::Thinking {
                text: "child thought".into(),
                parent_tool_use_id: Some("task-1".into()),
            },
        ]);
        assert_eq!(current_step(&s).map(|s| (s.0, s.2)), Some((1, "Task: research")));
        assert_eq!(s.step_count, 1);
        assert!(s.last_text.is_none());
    }

    #[test]
    fn a_permission_pins_its_call_until_answered() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&tool("t1", "rm -rf build", "pending"), 1, true);
        turns.apply(&permission("r1", "t1", "rm -rf build"), 2, true);
        // A parallel call starting meanwhile does not push it out.
        turns.apply(&tool("t2", "Read", "in_progress"), 3, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(current_step(&s), Some((1, "read", "rm -rf build", true)));
        turns.apply(&resolved("r1"), 4, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(current_step(&s).map(|s| (s.0, s.3)), Some((2, false)));
    }

    /// The next request can arrive before the previous one's
    /// `PermissionResolved` (a queued request is promoted): each is cleared by
    /// its own id, never by arrival order.
    #[test]
    fn permissions_clear_by_request_id_not_by_order() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&tool("t1", "first", "pending"), 1, true);
        turns.apply(&tool("t2", "second", "pending"), 2, true);
        turns.apply(&permission("r1", "t1", "first"), 3, true);
        turns.apply(&permission("r2", "t2", "second"), 4, true);
        turns.apply(&resolved("r1"), 5, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(current_step(&s).map(|s| (s.2, s.3)), Some(("second", true)));
        turns.apply(&resolved("r2"), 6, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(current_step(&s).map(|s| s.3), Some(false));
    }

    #[test]
    fn a_permission_for_an_unseen_call_opens_its_step() {
        let s = run(&[text("Cleaning up."), permission("r1", "t9", "rm tmp")]);
        assert_eq!(current_step(&s), Some((2, "execute", "rm tmp", true)));
        assert_eq!(last(&s), Some((1, "Cleaning up.")));
    }

    #[test]
    fn nothing_after_the_turn_completes_reaches_it() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&text("Answer."), 1, true);
        turns.apply(&done(), 2, true);
        turns.apply(&text("stray"), 3, true);
        turns.apply(&tool("t1", "Read", "in_progress"), 4, true);
        // A repeated completion seals nothing again.
        turns.apply(&done(), 5, true);
        let s = turns.snapshot("tok").unwrap();
        assert_eq!(s.completed_seq, Some(2));
        assert_eq!(s.stop_reason.as_deref(), Some("end_turn"));
        assert_eq!(current_text(&s), Some((1, "Answer.")));
        assert!(!turns.is_active());
    }

    #[test]
    fn a_completion_with_no_turn_open_does_not_seal() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&done(), 1, false);
        assert!(turns.is_active());
        assert_eq!(turns.snapshot("tok").unwrap().completed_seq, None);
    }

    #[test]
    fn turns_live_until_released_and_a_new_one_takes_the_events() {
        let mut turns = ReplyTurns::default();
        turns.open("a".into());
        turns.apply(&text("A's answer."), 1, true);
        turns.apply(&done(), 2, true);
        turns.open("b".into());
        turns.apply(&text("B's answer."), 3, true);
        assert_eq!(last(&turns.snapshot("a").unwrap()), Some((1, "A's answer.")));
        assert_eq!(last(&turns.snapshot("b").unwrap()), Some((1, "B's answer.")));
        turns.release("a");
        assert!(turns.snapshot("a").is_none());
        assert!(turns.snapshot("b").is_some());
    }

    #[test]
    fn display_text_strips_markers_and_a_trailing_partial_one() {
        assert_eq!(display_text("[[quote:#1]] hi"), "hi");
        assert_eq!(display_text("hi [[quote"), "hi");
        assert_eq!(display_text("hi [[quote:#12]"), "hi");
        assert_eq!(display_text("hi ["), "hi");
        assert_eq!(display_text("a [b] c"), "a [b] c");
        assert_eq!(display_text("see [[other]]"), "see [[other]]");
        assert_eq!(quote_ids("[[quote:#1]] [[quote:22]] [[Quote:#x]]"), vec![1, 22]);
    }

    fn full_tool(id: &str, kind: &str, title: &str, input: &str) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: title.into(),
            kind: kind.into(),
            status: "in_progress".into(),
            content: None,
            raw_input: Some(input.into()),
            raw_output: None,
            locations: Some(serde_json::json!([{ "path": "/w/src/parser.rs" }])),
            meta: None,
            images: None,
        }
    }

    fn output(id: &str, out: &str, append: bool) -> AcpEvent {
        AcpEvent::ToolCallUpdate {
            tool_call_id: id.into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some(out.into()),
            raw_output_append: append.then_some(true),
            locations: None,
            meta: None,
            images: None,
        }
    }

    #[test]
    fn a_turn_lists_its_steps_with_what_each_call_was_given_and_gave_back() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&think("hmm"), 1, true);
        turns.apply(&full_tool("e1", "edit", "Edit parser.rs", r#"{"file_path":"/w/src/parser.rs","old_string":"a","new_string":"b"}"#), 2, true);
        turns.apply(&output("e1", "ok", false), 3, true);
        turns.apply(&full_tool("x1", "execute", "cargo test", r#"{"command":"cargo test"}"#), 4, true);
        turns.apply(&output("x1", "running 2 tests\n", true), 5, true);
        turns.apply(&output("x1", "test result: ok. 2 passed", true), 6, true);
        turns.apply(&text("Done."), 7, true);
        let steps = turns.steps("tok");
        let kinds: Vec<&str> = steps.iter().map(|s| s.kind.as_str()).collect();
        assert_eq!(kinds, ["think", "edit", "execute", "text"]);
        let edit = &steps[1];
        assert_eq!(edit.path.as_deref(), Some("/w/src/parser.rs"));
        assert_eq!(edit.input.as_ref().unwrap()["new_string"], "b");
        assert_eq!(edit.status.as_deref(), Some("completed"));
        assert_eq!(
            steps[2].output.as_deref(),
            Some("running 2 tests\ntest result: ok. 2 passed")
        );
        // The step it is on now carries the same details.
        assert_eq!(turns.current_step("tok").unwrap().kind, "text");
    }

    #[test]
    fn a_turn_keeps_its_last_hundred_steps() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        for i in 0..(MAX_HISTORY + 20) {
            turns.apply(&tool(&format!("t{i}"), "Read", "in_progress"), i as u64, true);
        }
        let steps = turns.steps("tok");
        assert_eq!(steps.len(), MAX_HISTORY);
        assert_eq!(steps.first().unwrap().n, 21);
        assert_eq!(steps.last().unwrap().n, (MAX_HISTORY + 20) as u32);
    }

    #[test]
    fn the_step_waiting_on_the_owner_is_the_current_one() {
        let mut turns = ReplyTurns::default();
        turns.open("tok".into());
        turns.apply(&full_tool("x1", "execute", "rm -rf build", r#"{"command":"rm -rf build"}"#), 1, true);
        turns.apply(&text("Meanwhile…"), 2, true);
        turns.apply(&permission("p1", "x1", "rm -rf build"), 3, true);
        let current = turns.current_step("tok").unwrap();
        assert!(current.awaiting);
        assert_eq!(current.kind, "execute");
        assert_eq!(current.input.unwrap()["command"], "rm -rf build");
    }
}
