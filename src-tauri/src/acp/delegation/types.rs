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
