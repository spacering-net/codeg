//! Broker-facing request / outcome types.
//!
//! These cross two boundaries:
//! 1. The MCP companion serializes `DelegationRequest` → JSON-RPC params and
//!    deserializes `DelegationOutcome` → MCP `tool_result`.
//! 2. The broker emits a structured outcome the listener can persist and
//!    forward to the parent's tool_use_id.
//!
//! DB ids are `i32` to match the actual `conversation.id` / `conversation.parent_id`
//! column types — keeping them strongly typed here saves us a parse-or-die step
//! at every DB boundary.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::models::AgentType;

/// Per-agent defaults applied when codeg-mcp spawns a subagent on behalf of a
/// `delegate_to_agent` call. Mirrors the two knobs `ConnectionManager::spawn_agent`
/// already accepts:
///   * `mode_id` → forwarded as `preferred_mode_id`
///   * `config_values` → forwarded as `preferred_config_values`
///
/// All fields are optional / may be empty; an absent entry means "no override —
/// use whatever the agent advertises as the default."
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentDelegationDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub config_values: BTreeMap<String, String>,
}

impl AgentDelegationDefaults {
    pub fn is_empty(&self) -> bool {
        self.mode_id.is_none() && self.config_values.is_empty()
    }
}

/// The assistant a `delegate_to_agent` call targets, read from the database
/// once when the call arrives and frozen for the whole run: an edit made while
/// the child works changes the next delegation, never this one.
///
/// `agent_options` is the assistant's complete selection. It REPLACES the
/// per-agent `agent_defaults` for this child rather than layering over them —
/// an assistant runs exactly as it was configured.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationAssistant {
    pub id: i32,
    pub name: String,
    #[serde(default)]
    pub agent_options: AgentDelegationDefaults,
    #[serde(default)]
    pub instructions: String,
}

impl DelegationAssistant {
    pub fn identity(&self) -> AssistantRef {
        AssistantRef {
            id: self.id,
            name: self.name.clone(),
        }
    }

    /// What the child row keeps of this assistant (`conversation.assistant_snapshot`).
    pub fn run_snapshot(&self) -> crate::models::AssistantRunSnapshot {
        crate::models::AssistantRunSnapshot {
            name: self.name.clone(),
            agent_options: self.agent_options.clone(),
            instructions: self.instructions.clone(),
        }
    }
}

/// What a `delegate_to_agent` call names as its target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DelegationTarget {
    Agent(AgentType),
    /// An assistant by id. Wins over any `agent_type` the same call carries:
    /// the assistant decides which agent runs.
    Assistant(i32),
}

/// Why a call's arguments name no usable target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DelegationTargetError {
    /// `assistant_id` is present but not a positive 32-bit integer (or a
    /// string of digits). Carries the raw value, for the refusal message.
    InvalidAssistantId(String),
    /// No `assistant_id`, and `agent_type` is not an agent slug.
    InvalidAgentType(String),
    /// Neither field is present.
    Missing,
}

/// Read the target out of `delegate_to_agent` arguments. THE one parser: the
/// listener uses it to dispatch the call, the lifecycle and the broker to key
/// the call for correlation, and the companion to tell an assistant call from
/// an agent one — so the four can never disagree about which kind a call is.
///
/// A present, non-null `assistant_id` decides, valid or not: falling through to
/// `agent_type` would quietly run a call meant for an assistant on a bare
/// agent. It may be an integer or a string of digits (some hosts stringify
/// every argument).
pub fn delegation_target_from_args(
    args: &serde_json::Value,
) -> Result<DelegationTarget, DelegationTargetError> {
    match args.get("assistant_id") {
        None | Some(serde_json::Value::Null) => {}
        Some(raw) => return assistant_id_from_value(raw).map(DelegationTarget::Assistant),
    }
    match args.get("agent_type") {
        None | Some(serde_json::Value::Null) => Err(DelegationTargetError::Missing),
        Some(serde_json::Value::String(raw)) => AgentType::from_wire(raw)
            .map(DelegationTarget::Agent)
            .ok_or_else(|| DelegationTargetError::InvalidAgentType(raw.clone())),
        Some(other) => Err(DelegationTargetError::InvalidAgentType(other.to_string())),
    }
}

fn assistant_id_from_value(raw: &serde_json::Value) -> Result<i32, DelegationTargetError> {
    let parsed = match raw {
        serde_json::Value::Number(n) => n.as_i64(),
        serde_json::Value::String(s) => {
            let s = s.trim();
            if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) {
                s.parse::<i64>().ok()
            } else {
                None
            }
        }
        _ => None,
    };
    parsed
        .filter(|id| *id >= 1)
        .and_then(|id| i32::try_from(id).ok())
        .ok_or_else(|| {
            DelegationTargetError::InvalidAssistantId(match raw {
                serde_json::Value::String(s) => s.clone(),
                other => other.to_string(),
            })
        })
}

/// Who a delegation ran as, when it ran as an assistant: carried beside the
/// `agent_type` on reports, events and card meta so the UI can draw the
/// assistant even when its row is gone or unknown to the client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRef {
    pub id: i32,
    pub name: String,
}

/// Everything the broker needs to dispatch a single delegation call.
///
/// `parent_connection_id` is the codeg-internal ACP connection UUID for the
/// parent session (NOT the agent-assigned ACP session id). The broker uses it
/// to inherit the parent's EventEmitter/working_dir and to scope
/// `cancel_by_parent`.
///
/// `external_handle` is a companion-minted opaque token (per MCP `tools/call`)
/// that the broker stores alongside the pending entry so an MCP-side
/// `notifications/cancelled` can target this specific delegation without the
/// companion having to know the broker-internal `call_id`. `None` for non-MCP
/// callers and tests that don't exercise the cancel path.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationRequest {
    pub parent_connection_id: String,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: String,
    pub agent_type: AgentType,
    pub task: String,
    pub working_dir: Option<String>,
    /// The `working_dir` exactly as the LLM passed it in the
    /// `delegate_to_agent` arguments, BEFORE the listener defaults a missing
    /// value to the parent's launch directory. Used only as part of the
    /// `(agent_type, task, requested_working_dir)` correlation key so two
    /// parallel calls sharing an agent and task but targeting different
    /// explicit directories don't bind to each other's `tool_call_id`.
    /// `None` when the LLM omitted it — symmetric with the ACP `raw_input`,
    /// which also omits it then. Distinct from `working_dir` above, which is
    /// the defaulted value the child is actually spawned in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_working_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
    /// Set when the call named an assistant (`assistant_id`). `agent_type` is
    /// then the ASSISTANT's agent — the caller's own `agent_type` argument is
    /// ignored — and the child runs on the assistant's options and brief.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant: Option<DelegationAssistant>,
}

impl DelegationRequest {
    /// The target this call named — what its correlation key is built from,
    /// symmetric with the lifecycle's key over the same arguments.
    pub fn target(&self) -> DelegationTarget {
        match &self.assistant {
            Some(a) => DelegationTarget::Assistant(a.id),
            None => DelegationTarget::Agent(self.agent_type),
        }
    }
}

/// Everything the broker needs to resume one interrupted delegation task.
///
/// Deliberately carries NO task text: `resume_delegation` continues the
/// ORIGINAL task in the child's own (resumed) session and must not become a
/// side-channel for new instructions — the only free-form field is `reason`,
/// which is bounded and framed as interruption context in the continuation
/// prompt (see `broker::build_resume_prompt`).
///
/// `parent_connection_id` / `parent_conversation_id` identify the CALLER —
/// after a parent-session restart this is a different connection id than the
/// one that originally delegated, but the same conversation row, which is what
/// the ownership check scopes on (`ChildResumeContext::parent_id`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResumeDelegationRequest {
    pub parent_connection_id: String,
    pub parent_conversation_id: i32,
    /// The broker `call_id` of the task to resume — the same id
    /// `delegate_to_agent` returned and the child row persists as
    /// `delegation_call_id`. The resumed task keeps this id, so
    /// `get_delegation_status` / `cancel_delegation` keep working unchanged.
    pub task_id: String,
    /// Optional context on WHY the task is being resumed (e.g. "the app was
    /// killed mid-run"). Interruption context only — never new work.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Companion-minted cancel handle, same contract as
    /// [`DelegationRequest::external_handle`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenUsage {
    pub input: u64,
    pub output: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationSuccess {
    pub text: String,
    pub child_conversation_id: i32,
    pub child_agent_type: AgentType,
    pub turn_count: u32,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenUsage>,
}

/// Broker-internal failure modes. Serialized via the wrapping
/// [`DelegationOutcome::Err`] variant — the broker maps each into a stable
/// `code` string so the frontend / MCP consumer can pattern-match without
/// caring about the inner shape.
#[derive(Debug, Clone, thiserror::Error, Serialize, Deserialize)]
#[serde(tag = "code", content = "detail", rename_all = "snake_case")]
pub enum DelegationError {
    #[error("depth limit exceeded ({current_depth} >= {limit})")]
    DepthLimitExceeded { current_depth: u32, limit: u32 },
    #[error("invalid agent type")]
    InvalidAgentType,
    #[error("invalid working dir: {0}")]
    InvalidWorkingDir(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("subagent runtime error: {0}")]
    SubagentRuntimeError(String),
    /// Child agent ended its turn via `refusal`. Often a backend / gateway
    /// error masquerading as a refusal per the ACP spec gap.
    #[error("subagent refused to continue")]
    ChildRefusal,
    #[error("subagent reached max token budget")]
    ChildMaxTokens,
    #[error("subagent reached max turn request budget")]
    ChildMaxTurnRequests,
    /// Child reported `end_turn` without producing any output (synthesized
    /// as `empty` by the connection loop's "silent EndTurn" guard).
    #[error("subagent produced no output")]
    ChildEmpty,
    /// Child's agent refused the prompt with ACP's `authRequired` (synthesized
    /// as `auth_required` by the connection loop). Distinct from
    /// [`Self::ChildUnknown`] because it names an action the user can take —
    /// and because this message ships to the parent LLM, which would otherwise
    /// read "unrecognized stop reason" for a reason codeg recognizes perfectly
    /// well. The child's session survives it, so signing in and re-delegating
    /// works.
    #[error("subagent's agent needs you to sign in again")]
    ChildAuthRequired,
    /// Child's agent rejected the prompt outright (synthesized as `rejected` by
    /// the connection loop — every turn-scoped rejection that is not
    /// `authRequired`: an unsupported slash command, a provider-side error the
    /// adapter wrapped as -32603, …). Distinct from [`Self::ChildUnknown`] for
    /// the same reason [`Self::ChildAuthRequired`] is: the parent LLM reads this
    /// message, and "unrecognized stop reason" would be wrong. The child's
    /// session survives it, so re-delegating works.
    #[error("subagent's agent rejected the prompt")]
    ChildRejected,
    #[error("subagent ended with unrecognized stop reason: {0}")]
    ChildUnknown(String),
    #[error("canceled: {reason}")]
    Canceled { reason: String },
    #[error("parent session is gone")]
    ParentSessionGone,
}

/// The single value the broker hands back to the listener / MCP companion.
/// `child_conversation_id` on the `Err` arm is best-effort — it's `Some` once
/// the broker successfully created the child DB row, even if the run later
/// fails or times out.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DelegationOutcome {
    Ok(DelegationSuccess),
    Err {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        child_conversation_id: Option<i32>,
    },
}

/// Lifecycle status of an asynchronous delegation task. Surfaced by the
/// three delegation tools — `delegate_to_agent` (returns a `Running` ack, or
/// a terminal status when the child finished during setup / setup failed),
/// `get_delegation_status`, and `cancel_delegation`. Wire-stable snake_case
/// strings: they ship to LLM context and to the frontend, so don't rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    /// Child is running in the background; no terminal result yet.
    Running,
    /// Child ended its turn cleanly; `text` carries the result (possibly
    /// truncated — open the child session for the full output).
    Completed,
    /// Child ended in a non-cancel failure; `error_code` / `message` describe it.
    Failed,
    /// Task was canceled (by `cancel_delegation`, parent teardown, or a
    /// non-`end_turn` parent turn end).
    Canceled,
    /// Task id is not known to this parent — never existed, belonged to a
    /// different parent, or its result was evicted from the cache and no DB
    /// row backs it.
    Unknown,
}

/// What a still-`Running` delegation child is blocked on. A blocked child is
/// not making progress — it is parked until the USER decides — which is a
/// materially different thing to report than "running", and the parent LLM has
/// no other way to tell them apart (#447).
///
/// Deliberately NOT a `TaskStatus` variant: those strings are wire-stable and
/// the frontend's status list is closed, so an unrecognized value would fall
/// through to the tool-call-state fallback and paint a blocked poll as *done*.
/// Carried as an extra field on an otherwise ordinary `Running` report instead,
/// which every existing consumer ignores safely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockedKind {
    /// `session/request_permission` — allow/deny a tool call.
    Permission,
    /// `ask_user_question` — a multiple-choice question.
    Question,
    /// Plan-mode approval (Grok's `exit_plan_mode` and friends).
    PlanApproval,
    /// `render_page` with `awaitAnswer` — an answer on an interactive page.
    RenderPage,
}

/// The blocking prompt itself: what kind, and a short label for the thing that
/// needs a decision (a tool title, the first question, the plan's heading).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedOn {
    pub kind: BlockedKind,
    /// Stable id of the blocking request. The broker uses it to tell "still the
    /// same prompt I already reported" from "a second prompt", so a status
    /// long-poll surfaces each block exactly once instead of returning
    /// instantly forever (see `get_tasks_status`).
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// How far a sub-agent has got with its task, as far as its tool calls show:
/// how many it has finished, how the latest of them ended, and what it did
/// last. Taken from the child's live session — the turn in flight, or the one
/// that just ended — so it is only ever as good as what the agent reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DelegationProgress {
    /// Tool calls the child has finished in this task.
    pub steps: u32,
    /// How each of the last [`MAX_STEP_MARKS`] finished calls ended, oldest
    /// first — what the parent's card draws as one segment per step.
    pub marks: Vec<StepMark>,
    /// The title of the child's latest tool call (finished or not), one line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_step: Option<String>,
}

/// How a finished tool call ended. Wire-stable: it ships to the frontend and to
/// the parent LLM's context.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StepMark {
    Ok,
    Failed,
}

/// How many [`DelegationProgress::marks`] a report carries: the card draws at
/// most this many segments and counts the rest.
pub const MAX_STEP_MARKS: usize = 12;

/// Char budget for [`DelegationProgress::last_step`].
pub const LAST_STEP_CAP: usize = 120;

/// Unified response the broker hands the listener for every delegation tool
/// (`delegate_to_agent` / `get_delegation_status` / `cancel_delegation`). The
/// listener serializes it into `BrokerResponse.outcome`; the companion renders
/// it into the MCP `CallToolResult` (with `structuredContent` carrying this
/// whole shape so the frontend can read `status` and distinguish a running ack
/// from a terminal outcome).
///
/// Fields are all optional except `status` so one type can describe a running
/// ack (ids + `Running`), a completed result (`text` + `duration_ms`), a
/// failure (`error_code` + `message`), and a setup failure (`task_id: None`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DelegationTaskReport {
    /// Broker `call_id` (UUID) identifying the task. `None` only when setup
    /// failed before a task was registered (no id to track).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub status: TaskStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub child_conversation_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<AgentType>,
    /// Completed result text (capped; open the child session for the full
    /// output). Only set for `Completed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Wire-stable error code for `Failed` / `Canceled` (mirrors
    /// `DelegationOutcome::Err.code`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    /// Human-readable note: the failure message, or a hint like
    /// "running in background" / "result not cached; open child session N".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Set only on a `Running` report whose child is parked on a user decision.
    /// Absent means "actually working" — so its absence is as informative as its
    /// presence, and neither breaks a consumer that doesn't know the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_on: Option<BlockedOn>,
    /// The assistant the task runs as, beside its `agent_type`; absent for a
    /// plain agent delegation. The name is the one the task started with — the
    /// card prefers the assistant's current name when it knows the row.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assistant_name: Option<String>,
    /// The child's tool-call progress: live on a `Running` report, as it
    /// stood at the end on a terminal one. Absent when the child called no
    /// tool, or the session it ran in is no longer in memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<DelegationProgress>,
}

impl DelegationTaskReport {
    /// Stamp the assistant identity onto a report built without it. An
    /// `Unknown` report is left alone: it answers a task the caller does not
    /// own (or that never existed), and must not name whoever it belongs to.
    pub fn with_assistant(mut self, assistant: Option<&AssistantRef>) -> Self {
        if let Some(a) = assistant {
            if self.status != TaskStatus::Unknown {
                self.assistant_id = Some(a.id);
                self.assistant_name = Some(a.name.clone());
            }
        }
        self
    }
}

impl DelegationOutcome {
    /// Project a `DelegationError` onto the wire-stable `code` string used by
    /// the frontend and MCP companion. Keep these strings stable — they ship
    /// to LLM context.
    pub fn from_err(err: DelegationError, child_conversation_id: Option<i32>) -> Self {
        let code = match &err {
            DelegationError::DepthLimitExceeded { .. } => "depth_limit",
            DelegationError::InvalidAgentType => "invalid_agent_type",
            DelegationError::InvalidWorkingDir(_) => "invalid_working_dir",
            DelegationError::SpawnFailed(_) => "spawn_failed",
            DelegationError::SubagentRuntimeError(_) => "subagent_error",
            DelegationError::ChildRefusal => "child_refusal",
            DelegationError::ChildMaxTokens => "child_max_tokens",
            DelegationError::ChildMaxTurnRequests => "child_max_turn_requests",
            DelegationError::ChildEmpty => "child_empty",
            DelegationError::ChildAuthRequired => "child_auth_required",
            DelegationError::ChildRejected => "child_rejected",
            DelegationError::ChildUnknown(_) => "child_unknown",
            DelegationError::Canceled { .. } => "canceled",
            DelegationError::ParentSessionGone => "canceled",
        };
        DelegationOutcome::Err {
            code: code.to_string(),
            message: err.to_string(),
            child_conversation_id,
        }
    }
}

#[cfg(test)]
mod target_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_assistant_id_wins_over_any_agent_type() {
        assert_eq!(
            delegation_target_from_args(&json!({"assistant_id": 3, "agent_type": "codex"})),
            Ok(DelegationTarget::Assistant(3))
        );
        assert_eq!(
            delegation_target_from_args(&json!({"assistant_id": " 12 ", "agent_type": "nonsense"})),
            Ok(DelegationTarget::Assistant(12))
        );
    }

    #[test]
    fn a_present_but_invalid_assistant_id_never_falls_back_to_the_agent() {
        for bad in [json!(0), json!(-1), json!(1.5), json!("abc"), json!("3a"), json!(true), json!(3_000_000_000_i64)] {
            assert!(
                matches!(
                    delegation_target_from_args(&json!({"assistant_id": bad, "agent_type": "codex"})),
                    Err(DelegationTargetError::InvalidAssistantId(_))
                ),
                "{bad} must not resolve"
            );
        }
    }

    #[test]
    fn without_an_assistant_the_agent_type_decides() {
        assert_eq!(
            delegation_target_from_args(&json!({"agent_type": "codex", "assistant_id": null})),
            Ok(DelegationTarget::Agent(AgentType::Codex))
        );
        assert_eq!(
            delegation_target_from_args(&json!({"agent_type": "custom:goose"})),
            Ok(DelegationTarget::Agent(AgentType::custom("goose").unwrap()))
        );
        assert_eq!(
            delegation_target_from_args(&json!({"agent_type": "nope"})),
            Err(DelegationTargetError::InvalidAgentType("nope".into()))
        );
        assert_eq!(
            delegation_target_from_args(&json!({"task": "x"})),
            Err(DelegationTargetError::Missing)
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The `code` strings ship to the parent LLM and to the status badge's
    /// i18n switch, and `from_err`'s comment declares them stable — so pin
    /// them here rather than trusting the comment. A renamed code silently
    /// falls through to the badge's `default` ("failed") and hands the LLM a
    /// label it has never seen; a NEW variant that forgets its arm would be
    /// caught by the compiler, but a new variant sharing an existing code
    /// (the mistake `ChildAuthRequired` was one edit away from) would not.
    #[test]
    fn error_codes_are_stable_and_distinct_per_child_failure() {
        let cases = [
            (DelegationError::ChildRefusal, "child_refusal"),
            (DelegationError::ChildMaxTokens, "child_max_tokens"),
            (
                DelegationError::ChildMaxTurnRequests,
                "child_max_turn_requests",
            ),
            (DelegationError::ChildEmpty, "child_empty"),
            (DelegationError::ChildAuthRequired, "child_auth_required"),
            (DelegationError::ChildRejected, "child_rejected"),
            (
                DelegationError::ChildUnknown("whatever".into()),
                "child_unknown",
            ),
        ];
        for (err, expected) in cases {
            let display = err.to_string();
            let DelegationOutcome::Err { code, message, .. } = DelegationOutcome::from_err(err, None)
            else {
                panic!("from_err must produce an Err outcome");
            };
            assert_eq!(code, expected);
            assert_eq!(message, display);
        }

        // A sign-out is a recognized reason with an action attached, so it
        // must NOT reach the parent wearing `ChildUnknown`'s "unrecognized
        // stop reason" wording.
        let DelegationOutcome::Err { message, .. } =
            DelegationOutcome::from_err(DelegationError::ChildAuthRequired, None)
        else {
            unreachable!()
        };
        assert!(message.contains("sign in"), "message was {message:?}");
    }
}
