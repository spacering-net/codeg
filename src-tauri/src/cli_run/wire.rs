//! The `codeg-cli` contract, in one place for both ends of it.
//!
//! Two layers:
//! - the HTTP bodies the CLI and the runtime exchange under `/api/cli_*` —
//!   camelCase, like the rest of `/api`;
//! - the events and the result object the CLI prints (`--output-format
//!   json|stream-json`) — snake_case, contract v1, documented in `docs/cli.md`.
//!
//! Compatibility rules (also in `docs/cli.md`): fields and event types are only
//! ever added; an existing field never changes meaning or type; consumers
//! ignore what they do not know. Exit codes and `subtype`s are only ever added
//! too, and a retired one is never reused.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::policy::PermissionPolicy;

/// Bumped only when the HTTP contract breaks. A single new feature is a new
/// [`capability`] instead.
pub const API_VERSION: u32 = 1;

/// Every printed event and result object carries `"v": EVENT_VERSION`.
pub const EVENT_VERSION: u32 = 1;

/// What one runtime can do, by name — so the CLI can say "this codeg is too
/// old for `--effort`" instead of a blanket version mismatch.
pub mod capability {
    /// `cli_run_*`: one prompt, one turn.
    pub const RUN: &str = "run";
    /// `effort` in `cli_run_start`.
    pub const EFFORT: &str = "effort";
    /// `open: true` in `cli_run_start` (desktop runtimes only).
    pub const OPEN_SESSION: &str = "open_session";
    /// `cli_run_find`: a run looked up by the start of its id, for
    /// `codeg-cli result` and `codeg-cli cancel`.
    pub const RUN_LOOKUP: &str = "run_lookup";
    /// `worktree` in `cli_run_start`: the run in a git worktree of its own.
    pub const WORKTREE: &str = "worktree";
    /// `cli_automations`, `cli_automation_run`, `cli_automation_run_get`.
    pub const AUTOMATIONS: &str = "automations";
    /// `cli_agent_install`, `cli_agent_install_get`.
    pub const AGENT_INSTALL: &str = "agent_install";
    /// `outputSchema` in `cli_run_start`, and `structured_output` in the
    /// result.
    pub const OUTPUT_SCHEMA: &str = "output_schema";
}

/// The exit code of `codeg-cli result` for a run that has not settled within
/// its `--wait`. Not a result's: the run was not cancelled, it goes on.
pub const STILL_RUNNING_EXIT_CODE: i32 = 6;

/// The deep link a run's conversation opens at.
pub fn session_link(conversation_id: i32) -> String {
    format!("codeg://session/{conversation_id}")
}

// ── hello ────────────────────────────────────────────────────────────────────

/// `POST /api/cli_hello` — sent WITHOUT a token: the CLI proves who it talks to
/// before it hands over the token or a prompt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloRequest {
    /// Random, hex; at least 16 bytes of entropy.
    pub nonce: String,
    pub client_version: String,
    pub api_version: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeKind {
    Desktop,
    Server,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BuildKind {
    Release,
    Debug,
}

impl BuildKind {
    /// This binary's: a debug desktop shares the release one's data directory
    /// (with its own database), so a CLI must be able to tell them apart.
    pub fn current() -> Self {
        if cfg!(debug_assertions) {
            Self::Debug
        } else {
            Self::Release
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloResponse {
    /// Hex HMAC-SHA256 over the nonce (see `hello::proof`).
    pub proof: String,
    pub runtime: RuntimeKind,
    pub build: BuildKind,
    pub version: String,
    pub api_version: u32,
    pub capabilities: Vec<String>,
}

// ── run ──────────────────────────────────────────────────────────────────────

/// `POST /api/cli_run_reserve` — takes a run id; no side effect of any kind.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReserveResponse {
    pub run_id: String,
    pub expires_in_ms: u64,
}

/// One block of the prompt. Only text in v1; stdin rides as a second block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PromptBlock {
    Text { text: String },
}

/// `POST /api/cli_run_start`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRequest {
    pub run_id: String,
    /// A path on the RUNTIME's machine, absolute there.
    pub workspace: String,
    /// Agent wire slug (`claude_code`, `custom:<id>`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    /// Assistant id or name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<String>,
    pub prompt: Vec<PromptBlock>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// Other session config options, by id.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config: BTreeMap<String, String>,
    pub permissions: PermissionPolicy,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// What is left of the CLI's `--timeout`; the runtime keeps the clock, so
    /// the run is cancelled on time even when the CLI is gone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    /// `CODEG_CLI_CALLER` of the process that ran the CLI, when it had one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
    /// Have the selected desktop runtime open the conversation once it exists.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub open: bool,
    /// Run in a new git worktree of the workspace's repository, on branch
    /// `cli/<this>` — or, empty, `cli/<the start of the run's id>`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    /// The JSON Schema the run's result is handed in against
    /// (`--output-schema`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Value>,
}

/// The worktree a run was given (`--worktree`): where it is, and its branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRef {
    pub id: i32,
    pub name: String,
}

/// A successful `cli_run_start` means the prompt is QUEUED to the agent — the
/// contract `--detach` relies on.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartResponse {
    pub run_id: String,
    pub conversation_id: i32,
    pub folder_id: i32,
    pub connection_id: String,
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<AssistantRef>,
    pub link: String,
    /// Where the agent works, as the `init` event says. Older runtimes leave
    /// it out: it is then the workspace the request sent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeInfo>,
}

/// `POST /api/cli_run_events` — long poll.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsRequest {
    pub run_id: String,
    /// Return events with `seq > after`.
    #[serde(default)]
    pub after: u64,
    /// How long to wait when there is nothing new (capped at 25 s).
    #[serde(default)]
    pub wait_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventsResponse {
    pub events: Vec<RunEvent>,
    /// The cursor for the next poll.
    pub next: u64,
    /// The run has settled and `events` reaches its result.
    pub done: bool,
    /// `after` predates the oldest event still kept.
    pub gap: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    User,
    Timeout,
    Interrupt,
}

/// `POST /api/cli_run_cancel` — idempotent; also withdraws a reservation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelRequest {
    pub run_id: String,
    pub reason: CancelReason,
}

/// `POST /api/cli_run_get`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetRequest {
    pub run_id: String,
    /// Wait this long for the run to settle before answering (capped at
    /// 25 s). Older runtimes ignore it and answer at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    Reserved,
    Starting,
    Running,
    Settled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetResponse {
    pub state: RunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<RunResult>,
    /// The run's conversation, once it has one — before the result does.
    /// Older runtimes leave these out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

/// `POST /api/cli_run_find` — the runs this runtime still knows whose id
/// starts with `prefix` (at least 8 characters).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    pub prefix: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundRun {
    pub run_id: String,
    pub state: RunState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResponse {
    /// The newest first.
    pub runs: Vec<FoundRun>,
}

// ── listings ─────────────────────────────────────────────────────────────────

/// One row of `POST /api/cli_agents` — a shape of its own, not the settings
/// page's, so the CLI contract does not move with the UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEntry {
    pub slug: String,
    pub name: String,
    pub enabled: bool,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
}

/// One row of `POST /api/cli_automations`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AutomationEntry {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    /// `schedule` or `manual`.
    pub trigger: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron: Option<String>,
    pub agent: String,
    /// `launch_session`, or `enqueue_task` (it queues a work task).
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_status: Option<String>,
    /// RFC 3339.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
}

/// `POST /api/cli_automation_run` — run an automation now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRequest {
    pub automation_id: i32,
}

/// `POST /api/cli_automation_run_get` — an automation run, waited for up to
/// `waitMs` (capped at 25 s) to end.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunGetRequest {
    pub run_id: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

/// One automation run, as the runtime answers for it and `codeg-cli
/// automations run` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AutomationRunState {
    pub v: u32,
    /// `"automation_run"`.
    #[serde(rename = "type")]
    pub kind: String,
    pub automation_id: i32,
    pub run_id: i32,
    /// `running`, `succeeded`, `failed`, `cancelled` or `skipped`.
    pub status: String,
    pub conversation_id: Option<i32>,
    pub link: Option<String>,
    /// The work task an `enqueue_task` automation queued: its run is over
    /// once the task is queued — the task's own work is not part of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<i32>,
    /// The agent's last reply, for a finished session.
    pub summary: Option<String>,
    pub error: Option<String>,
}

impl AutomationRunState {
    pub fn is_over(&self) -> bool {
        self.status != "running"
    }
}

/// `POST /api/cli_agent_install` — install an agent, or join its install in
/// progress. The answer comes at once; `cli_agent_install_get` follows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallRequest {
    pub agent: String,
    /// A version other than the one this codeg pins.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// `POST /api/cli_agent_install_get`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallGetRequest {
    pub install_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

/// An agent install, as the runtime answers for it and `codeg-cli agents
/// install` prints it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentInstallState {
    pub v: u32,
    /// `"agent_install"`.
    #[serde(rename = "type")]
    pub kind: String,
    pub install_id: String,
    pub agent: String,
    /// `running`, `installed` or `failed`.
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
}

/// One row of `POST /api/cli_assistants`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssistantEntry {
    pub id: i32,
    pub name: String,
    pub agent: String,
    pub description: String,
}

// ── errors ───────────────────────────────────────────────────────────────────

/// Why a run ended — the `subtype` of the result object. Each maps to one exit
/// code ([`Self::exit_code`]); SIGINT/SIGTERM both read `error_interrupted`,
/// told apart by the CLI's own 130/143.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Subtype {
    Success,
    ErrorDuringExecution,
    ErrorUsage,
    ErrorTimeout,
    ErrorRuntimeUnavailable,
    ErrorRuntimeAccessDenied,
    ErrorRuntimeIncompatible,
    ErrorPermissionRequired,
    ErrorInterrupted,
    /// `--output-schema`: the turn ended without a result that matches. Named
    /// as Claude Code names it.
    ErrorMaxStructuredOutputRetries,
}

impl Subtype {
    pub fn is_error(self) -> bool {
        self != Self::Success
    }

    /// The exit code, for every subtype but `error_interrupted`, whose code is
    /// the signal's (130 / 143).
    pub fn exit_code(self) -> i32 {
        match self {
            Self::Success => 0,
            Self::ErrorDuringExecution => 1,
            Self::ErrorUsage => 2,
            Self::ErrorTimeout => 3,
            Self::ErrorRuntimeUnavailable
            | Self::ErrorRuntimeAccessDenied
            | Self::ErrorRuntimeIncompatible => 4,
            Self::ErrorPermissionRequired => 5,
            Self::ErrorMaxStructuredOutputRetries => 7,
            Self::ErrorInterrupted => 130,
        }
    }
}

/// What went wrong, in a form a script can act on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ErrorInfo {
    /// Stable machine-readable code (listed in `docs/cli.md`).
    pub code: String,
    pub message: String,
    /// Things to try next, written to be followed as they stand.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub next_steps: Vec<String>,
}

/// The body of every non-2xx `/api/cli_*` answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorBody {
    pub subtype: Subtype,
    pub error: ErrorInfo,
}

// ── events and the result ────────────────────────────────────────────────────

/// Model, effort and mode, as asked for or as in effect.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchSelection {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// A value in effect whose setting the agent only took, without confirming
/// where it landed (Grok's model, Kiro's model).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Unconfirmed {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub model: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub effort: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub mode: bool,
}

impl Unconfirmed {
    fn is_empty(&self) -> bool {
        !(self.model || self.effort || self.mode)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    /// What the command line and the assistant asked for.
    pub requested: LaunchSelection,
    /// What the session actually runs with.
    pub effective: LaunchSelection,
    /// Values in `effective` the agent did not confirm.
    #[serde(default, skip_serializing_if = "Unconfirmed::is_empty")]
    pub unconfirmed: Unconfirmed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionVerdict {
    Allowed,
    Denied,
    Waiting,
    Failed,
    Withdrawn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecidedBy {
    Policy,
    User,
    Withdrawn,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuestionVerdict {
    Declined,
    Waiting,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanEntry {
    pub content: String,
    pub status: String,
}

/// A permission the run refused, as Claude's `permission_denials` lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PermissionDenial {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_kind: Option<String>,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
}

/// A card still waiting for a person when the run ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingCard {
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<i32>,
    pub tool: String,
}

/// The result object: the last event of a run, and what `--output-format json`
/// prints. The shape Claude, Amp, Cursor and Qwen share (`subtype`,
/// `is_error`, `result`, `session_id`, `duration_ms`, `permission_denials`), so
/// a `jq '.result'` written for any of them reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunResult {
    pub subtype: Subtype,
    pub is_error: bool,
    /// The agent's final reply, when the turn produced one.
    pub result: Option<String>,
    /// The agent's own session id.
    pub session_id: Option<String>,
    pub stop_reason: Option<String>,
    pub duration_ms: u64,
    #[serde(default)]
    pub permission_denials: Vec<PermissionDenial>,
    #[serde(default)]
    pub launch: Launch,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending: Option<Vec<PendingCard>>,
    pub conversation_id: Option<i32>,
    pub link: Option<String>,
    /// The agent that ran, once the run got that far.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<AssistantRef>,
    /// With several targets (`-a codex -a claude_code`): which one this is,
    /// numbered from 1 in the order the command line gives them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_index: Option<usize>,
    /// The run's own worktree (`--worktree`), left for the user to review.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeInfo>,
    /// With `--output-schema`: the result the agent handed in, which matches
    /// the schema — `null` when it handed in none that does. Missing without
    /// one, so `Some(Value::Null)` and `None` are told apart.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present"
    )]
    pub structured_output: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<ErrorInfo>,
}

/// A field that is there, `null` included, as `Some`; one that is not, as
/// `None` (by `default`).
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<serde_json::Value>, D::Error> {
    serde_json::Value::deserialize(deserializer).map(Some)
}

/// What happened, one line of `stream-json` each.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventBody {
    Init {
        conversation_id: i32,
        folder_id: i32,
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        assistant: Option<AssistantRef>,
        workspace: String,
        link: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        worktree: Option<WorktreeInfo>,
    },
    Session {
        session_id: Option<String>,
        launch: Launch,
    },
    /// Reply text; consecutive deltas are merged within one poll.
    MessageDelta {
        text: String,
    },
    ToolCall {
        id: String,
        title: String,
        kind: String,
        status: String,
    },
    ToolCallUpdate {
        id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        status: Option<String>,
    },
    Plan {
        entries: Vec<PlanEntry>,
    },
    /// A permission request and what became of it. `conversation_id` is a
    /// delegated child's when the card came from one.
    Permission {
        request_id: String,
        conversation_id: Option<i32>,
        tool: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tool_kind: Option<String>,
        decision: PermissionVerdict,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        decided_by: Option<DecidedBy>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        option_name: Option<String>,
    },
    Question {
        question_id: String,
        conversation_id: Option<i32>,
        decision: QuestionVerdict,
    },
    Notice {
        severity: String,
        title: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<String>,
    },
    /// Events were lost: the cursor predates the oldest one still kept.
    Gap {},
    /// Boxed: by far the largest event, and only one per run.
    Result(Box<RunResult>),
}

/// One event as printed: the body plus the fields every event carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunEvent {
    pub v: u32,
    /// Monotonic within `run_id`.
    pub seq: u64,
    /// `None` only on a result for a run that never got an id.
    pub run_id: Option<String>,
    #[serde(flatten)]
    pub body: EventBody,
}

impl RunEvent {
    pub fn new(seq: u64, run_id: Option<String>, body: EventBody) -> Self {
        Self {
            v: EVENT_VERSION,
            seq,
            run_id,
            body,
        }
    }

    pub fn result(&self) -> Option<&RunResult> {
        match &self.body {
            EventBody::Result(result) => Some(result),
            _ => None,
        }
    }
}

/// What `codeg-cli result` prints for a run that has not settled within its
/// `--wait`, with [`STILL_RUNNING_EXIT_CODE`]. Not a result: `type` is
/// `"status"`, and the run goes on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunStatus {
    pub v: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub run_id: String,
    pub state: RunState,
    pub subtype: String,
    pub conversation_id: Option<i32>,
    pub link: Option<String>,
}

impl RunStatus {
    pub fn still_running(
        run_id: String,
        state: RunState,
        conversation_id: Option<i32>,
        link: Option<String>,
    ) -> Self {
        Self {
            v: EVENT_VERSION,
            kind: "status".into(),
            run_id,
            state,
            subtype: "still_running".into(),
            conversation_id,
            link,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_result_event_prints_as_the_shared_result_shape() {
        let event = RunEvent::new(
            9,
            Some("run-1".into()),
            EventBody::Result(Box::new(RunResult {
                subtype: Subtype::Success,
                is_error: false,
                result: Some("done".into()),
                session_id: Some("s1".into()),
                stop_reason: Some("end_turn".into()),
                duration_ms: 1200,
                permission_denials: vec![],
                launch: Launch::default(),
                pending: None,
                conversation_id: Some(4),
                link: Some(session_link(4)),
                agent: None,
                assistant: None,
                target_index: None,
                worktree: None,
                structured_output: None,
                error: None,
            })),
        );
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["type"], "result");
        assert_eq!(json["v"], 1);
        assert_eq!(json["run_id"], "run-1");
        assert_eq!(json["subtype"], "success");
        assert_eq!(json["is_error"], false);
        assert_eq!(json["result"], "done");
        assert_eq!(json["link"], "codeg://session/4");
        assert_eq!(serde_json::from_value::<RunEvent>(json).unwrap(), event);
    }

    /// `structured_output` is there for a run given `--output-schema`, `null`
    /// when no result matched — and missing for any other run. The difference
    /// survives the trip from the runtime to the CLI.
    #[test]
    fn structured_output_is_null_when_asked_for_and_missing_otherwise() {
        let mut result: RunResult = serde_json::from_value(serde_json::json!({
            "subtype": "error_max_structured_output_retries", "is_error": true,
            "result": "no", "session_id": null, "stop_reason": "end_turn", "duration_ms": 1,
            "conversation_id": null, "link": null, "structured_output": null
        }))
        .unwrap();
        assert_eq!(result.subtype, Subtype::ErrorMaxStructuredOutputRetries);
        assert_eq!(result.structured_output, Some(serde_json::Value::Null));
        let json = serde_json::to_value(&result).unwrap();
        assert!(json["structured_output"].is_null());
        assert!(json.as_object().unwrap().contains_key("structured_output"));

        result.structured_output = None;
        let json = serde_json::to_value(&result).unwrap();
        assert!(!json.as_object().unwrap().contains_key("structured_output"));
        let back: RunResult = serde_json::from_value(json).unwrap();
        assert_eq!(back.structured_output, None);

        result.structured_output = Some(serde_json::json!({"verdict": "pass"}));
        let back: RunResult =
            serde_json::from_value(serde_json::to_value(&result).unwrap()).unwrap();
        assert_eq!(back, result);
    }

    #[test]
    fn every_subtype_maps_to_its_exit_code() {
        let codes = [
            (Subtype::Success, 0),
            (Subtype::ErrorDuringExecution, 1),
            (Subtype::ErrorUsage, 2),
            (Subtype::ErrorTimeout, 3),
            (Subtype::ErrorRuntimeUnavailable, 4),
            (Subtype::ErrorRuntimeAccessDenied, 4),
            (Subtype::ErrorRuntimeIncompatible, 4),
            (Subtype::ErrorPermissionRequired, 5),
            (Subtype::ErrorMaxStructuredOutputRetries, 7),
            (Subtype::ErrorInterrupted, 130),
        ];
        for (subtype, code) in codes {
            assert_eq!(subtype.exit_code(), code, "{subtype:?}");
            assert_eq!(subtype.is_error(), code != 0);
        }
    }

    #[test]
    fn start_requests_use_the_api_casing() {
        let json = serde_json::json!({
            "runId": "r", "workspace": "/w", "prompt": [{"type": "text", "text": "hi"}],
            "permissions": "deny", "timeoutMs": 5000
        });
        let req: StartRequest = serde_json::from_value(json).unwrap();
        assert_eq!(req.run_id, "r");
        assert_eq!(req.timeout_ms, Some(5000));
        assert_eq!(req.permissions, PermissionPolicy::Deny);
        assert!(!req.open);
        assert_eq!(req.prompt, vec![PromptBlock::Text { text: "hi".into() }]);
    }
}
