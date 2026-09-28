//! 会话级状态结构。后端权威：流式累积、in-flight tool calls、待处理 permission 等
//! 全部住在这里。Phase 2 的 snapshot 端点直接从此处读取 live 部分。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::acp::delegation::types::{BlockedKind, BlockedOn};
use crate::acp::event_stream::{
    images_slice_size, json_str_len, json_value_size, opt_json_size, opt_str_size,
    ConnectionEventStream, RecentEventsBuffer,
};
use crate::acp::feedback::{FeedbackItem, FeedbackStatus};
use crate::acp::plan_approval::PendingPlanApprovalState;
use crate::acp::question::PendingQuestionState;
use crate::acp::types::{
    AcpEvent, AsyncTaskRecord, AvailableCommandInfo, ConfigStaleKind, ConnectionStatus,
    EventEnvelope, GrokModelSpec, PromptCapabilitiesInfo, SessionConfigOptionInfo,
    SessionFailureRecord, SessionModeStateInfo, ToolCallImageInfo,
};
use crate::models::agent::AgentType;
use crate::models::message::MessageRole;

/// 当前 streaming 中的 turn 的累积内容。turn 完成后清空。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveMessage {
    pub id: String,
    pub role: MessageRole,
    pub content: Vec<LiveContentBlock>,
    pub started_at: DateTime<Utc>,
}

/// 流式 turn 的内容块。事件按到达顺序追加。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LiveContentBlock {
    Text {
        text: String,
        /// Subagent attribution (`_meta.claudeCode.parentToolUseId`,
        /// claude-agent-acp ≥0.63 with `subagent-transcript` advertised).
        /// `None` = main-thread content. `default` keeps snapshots written
        /// by older backends parseable; skip-none keeps every other agent's
        /// snapshot byte-identical.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
    },
    Thinking {
        text: String,
        /// Same contract as `Text::parent_tool_use_id`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        parent_tool_use_id: Option<String>,
    },
    ToolCallRef { tool_call_id: String },
    Plan { entries: serde_json::Value },
}

/// 工具调用的运行态。turn 完成时统一 clear。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCallState {
    pub id: String,
    pub kind: ToolKind,
    pub label: String,
    pub status: ToolCallStatus,
    pub input: Option<serde_json::Value>,
    pub output: Option<ToolCallOutput>,
    /// Latest rendered content blocks reported by the agent (markdown / text).
    /// Distinct from `output` (which is the parsed `raw_output`); kept as the
    /// most recent value (replace-on-update, not append) for snapshot fidelity.
    pub content: Option<String>,
    /// File locations affected by this tool call (e.g. paths of edits).
    /// Forwarded verbatim from the agent's ToolCall/ToolCallUpdate event.
    /// `None` if the agent didn't supply it. Partial-update preservation:
    /// an incoming `None` from a `ToolCallUpdate` (which typically carries
    /// only changed fields) must NOT clobber a previously-set value.
    pub locations: Option<serde_json::Value>,
    /// ACP extensibility metadata. Used by frontend Phase 1 parent
    /// extraction. `None` if the agent didn't supply it. Same partial-update
    /// preservation semantic as `locations`.
    ///
    /// Convention used by codeg's multi-agent delegation (the `delegate_to_agent`
    /// MCP tool) — `DelegationBroker` writes the following object under
    /// `meta["codeg.delegation"]` on the parent's active tool call:
    ///
    /// ```jsonc
    /// {
    ///   "child_connection_id": "<uuid>",
    ///   "child_conversation_id": <i32>,
    ///   "status": "pending" | "running" | "completed" | "failed"
    /// }
    /// ```
    ///
    /// The frontend reads this to render "Delegating to <agent>…" on the live
    /// tool-call, and to anchor the inline `<DelegatedSubThread>` to the
    /// correct child conversation.
    pub meta: Option<serde_json::Value>,
    /// Latest images attached to this tool call (e.g. codex-acp v0.14+
    /// image generation). Replace-on-update semantics matching `content`:
    /// a fresh `ToolCallUpdate` carrying `Some(images)` replaces the prior
    /// vec, `None` preserves it. Persisted on snapshot so a frontend
    /// reconnecting mid-turn or after refresh sees the same image that was
    /// streamed live. ⚠ base64 image data can be multi-MB per entry; the
    /// snapshot endpoint payload grows accordingly. This is the cost of
    /// surviving page refresh without re-fetching from JSONL.
    #[serde(default)]
    pub images: Vec<ToolCallImageInfo>,
    /// 流式拼接的 input chunks（serde 不输出，仅运行时用）
    #[serde(skip)]
    pub raw_input_chunks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolCallStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
}

/// 工具种类。沿用 ACP 协议层枚举。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ToolKind {
    Read,
    Edit,
    Delete,
    Move,
    Search,
    Execute,
    Think,
    Fetch,
    Other,
}

/// 工具调用输出。可能是文本、错误、结构化结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolCallOutput {
    Text { content: String },
    Error { message: String },
    Json { value: serde_json::Value },
}

/// 待处理的权限请求。重连后从 SessionState 恢复，跨 UI 关闭不丢。
/// 注意：与 chat_channel::PendingPermission 不同（后者有 sent_message_id）。
///
/// `tool_call` 是 agent 原样转发的 JSON——保留 rawInput / content / locations /
/// patch / plan 等所有结构，前端 `parsePermissionToolCall` 依赖它来渲染 diff、
/// shell 命令、plan 列表等审批必备信息。压成 `description: String` 那种摘要
/// 字符串会让"刷新后继续审批"变成"盲签"。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermissionState {
    pub request_id: String,
    pub tool_call_id: String,
    pub tool_call: serde_json::Value,
    pub options: Vec<crate::acp::types::PermissionOptionInfo>,
    pub created_at: DateTime<Utc>,
    /// Requests queued behind this card, kept live by `PermissionQueueDepth` so
    /// a client attaching mid-turn sees the same "N more waiting" hint as one
    /// that was live for the original event.
    #[serde(default)]
    pub queued: u32,
}

/// 上下文 / 模型用量。
/// Snapshot of the most recent `AcpEvent::Error`. Carried on
/// `SessionState` so post-mortem readers (e.g. the delegation-settings
/// probe) can surface the agent's own error after the connection task
/// has already cleaned up.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SessionLastError {
    pub message: String,
    pub code: Option<String>,
    /// Mirrors `AcpEvent::Error.details` so a client that attached after the
    /// error (snapshot path) sees the same diagnostic evidence as one that was
    /// live for it. Already redacted at the source.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub details: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct UsageInfo {
    pub used: u64,
    pub size: u64,
}

/// Snapshot-recoverable record of an IN-FLIGHT (running) sub-agent delegation,
/// keyed (in `SessionState.active_delegations`) by the parent's
/// `parent_tool_use_id`.
///
/// This is the live "currently delegating" SET, not a history log:
/// `DelegationStarted` inserts an entry; `DelegationCompleted` REMOVES it. So
/// its size tracks live concurrency (bounded by what the machine actually runs)
/// — there is no cap and no cumulative growth over the parent connection's
/// lifetime.
///
/// Completed delegations are recovered without this field: a live page keeps the
/// binding in `DelegationProvider` for its lifetime, and a cold load / refresh
/// rebuilds `meta["codeg.delegation"]` (status + child id) from the child's
/// persisted DB row via `commands::conversations::inject_delegation_meta`
/// (authoritative, uncapped). The snapshot only has to recover the *running*
/// binding, which the transient `DelegationStarted` event cannot supply on the
/// snapshot attach path (cold attach, lagged re-attach, refresh) — that gap is
/// exactly what this field closes.
///
/// UNLIKE `active_tool_calls`, entries are NOT cleared on `TurnComplete`: an
/// async delegation's child runs in the background long after the parent's
/// `delegate_to_agent` tool call returns and the parent turn completes. The
/// broker emits `DelegationStarted`/`DelegationCompleted` only for a REAL
/// (non-synthetic) `parent_tool_use_id`, so synthetic-fallback cards never
/// create a phantom entry here.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ActiveDelegationState {
    pub parent_tool_use_id: String,
    pub child_connection_id: String,
    pub child_conversation_id: i32,
    pub agent_type: AgentType,
    /// Bounded task text preview + broker task id, mirrored from
    /// `DelegationStarted` so a snapshot re-attach mid-delegation reseeds the
    /// frontend binding WITH its label — required on hosts whose parent tool
    /// call never carries the arguments in `raw_input` (Cursor). `default` so
    /// a snapshot serialized by an older backend still deserializes.
    #[serde(default)]
    pub task_preview: String,
    #[serde(default)]
    pub task_id: String,
}

/// The in-flight user prompt for the current turn. Captured from
/// `AcpEvent::UserMessage` into `SessionState.pending_user_message` and carried
/// on `to_snapshot()` so a client attaching mid-turn can render the user turn
/// even though the one-shot `UserMessage` event won't replay for it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PendingUserMessage {
    pub message_id: String,
    pub blocks: Vec<crate::acp::types::UserMessageBlock>,
}

/// 后端权威的会话状态。每个 AgentConnection 持有一个 Arc<RwLock<SessionState>>。
///
/// 字段范围：仅当前 turn 的 in-flight 数据 + 元信息 + 协商出的能力。
/// 已完成的 turn 不存在这里——它们由 parser 从 agent JSONL 读。
#[derive(Debug)]
pub struct SessionState {
    // 身份
    pub connection_id: String,
    pub conversation_id: Option<i32>,
    pub external_id: Option<String>,
    /// Wall-clock instant `external_id` last CHANGED value (SessionStarted
    /// for a new/loaded/forked session). The transcript watcher uses this as
    /// its re-arm epoch: records appended to the (forked) transcript between
    /// the session change and the watcher's next poll tick must still count
    /// as this session's — an epoch taken at the tick itself would classify
    /// them as copied history and drop them.
    pub external_id_changed_at: Option<std::time::SystemTime>,
    pub agent_type: AgentType,
    pub working_dir: Option<PathBuf>,
    pub owner_window_label: String,
    pub folder_id: Option<i32>,

    // 状态
    pub status: ConnectionStatus,
    pub live_message: Option<LiveMessage>,
    pub active_tool_calls: BTreeMap<String, ToolCallState>,
    pub pending_permission: Option<PendingPermissionState>,

    /// The agent's in-flight `ask_user_question` (one set of multiple-choice
    /// questions awaiting the user's answer). Set by `QuestionRequest`, cleared
    /// by a matching `QuestionResolved` (and defensively on `TurnComplete` /
    /// `UserMessage`). Carried on `to_snapshot()` so a client attaching mid-turn
    /// re-renders the interactive card the one-shot event won't replay for it.
    /// At most one is pending at a time (the agent is blocked in the tool call);
    /// the backend's `pending_questions` registry keys the answer one-shot.
    pub pending_question: Option<PendingQuestionState>,

    /// The agent's in-flight Grok `exit_plan_mode` approval (the plan awaiting the
    /// user's Approve / Request-changes / Abandon decision). Set by
    /// `PlanApprovalRequest`, cleared by a matching `PlanApprovalResolved` (and
    /// defensively on `TurnComplete`). Carried on `to_snapshot()` so a client
    /// attaching mid-turn re-renders the approval card the one-shot event won't
    /// replay for it. At most one is pending (the agent is blocked in its
    /// `exit_plan_mode` tool call); the connection parks the ext responder keyed
    /// by `approval_id`.
    pub pending_plan_approval: Option<PendingPlanApprovalState>,

    /// In-flight (running) sub-agent delegations keyed by `parent_tool_use_id`.
    /// `DelegationStarted` inserts; `DelegationCompleted` removes. UNLIKE
    /// `active_tool_calls`, NOT cleared on `TurnComplete` (an async delegation
    /// outlives the parent turn). Carried on `to_snapshot()` so a web/server
    /// attach on the snapshot path (cold attach, lagged re-attach, refresh) can
    /// recover the running parent↔child binding the transient `DelegationStarted`
    /// event can't supply there. Size tracks live concurrency — no cap, no
    /// cumulative growth; completed delegations are recovered from the child's
    /// persisted DB row, not from here. See `ActiveDelegationState`.
    pub active_delegations: BTreeMap<String, ActiveDelegationState>,

    /// Live user-feedback ("steering") notes for the current turn. Appended by
    /// `FeedbackSubmitted` (a user note while the agent works), flipped to
    /// `Delivered` by `FeedbackConsumed` (the agent read them via the
    /// `check_user_feedback` MCP tool), and cleared on the next turn's
    /// `UserMessage` (notes are turn-scoped steering, not durable history).
    /// Carried on `to_snapshot()` so a client attaching mid-turn renders the
    /// pending notes the one-shot `FeedbackSubmitted` event won't replay for it.
    /// Size is human-bounded (one entry per note the user types this turn).
    pub feedback: Vec<FeedbackItem>,

    /// Launched-but-unresolved background tasks (async sub-agents + background
    /// shell tasks), mirrored from the transcript watcher's authoritative
    /// accounting via `AcpEvent::BackgroundActivity` (`apply_event` is the only
    /// writer). Drives `has_active_background_work()` — the idle-sweep
    /// exemption that keeps the agent CLI alive through a silent background
    /// build (killing the connection kills the CLI, and the background work
    /// dies with it). Carried on `to_snapshot()` so a client attaching
    /// mid-episode recovers the pending count without replaying events.
    pub background_outstanding: u32,
    /// Instant of the most recent `BackgroundActivity` event. Bounds the sweep
    /// exemption: if the watcher stops reporting (task died, bug) the
    /// exemption lapses after `background_keepalive_max_age()` instead of
    /// pinning the connection alive forever. Backend-internal; not serialized.
    pub background_activity_at: Option<DateTime<Utc>>,

    // ACP 协商出的能力
    pub modes: Option<SessionModeStateInfo>,
    pub current_mode: Option<String>,
    pub config_options: Option<Vec<SessionConfigOptionInfo>>,
    /// Grok only: per-model reasoning-effort specs, parsed from the top-level
    /// `models` of the session-establishment response (guaranteed on
    /// `session/new`; opportunistic on resume/fork). Grok never re-sends this on
    /// `set_model`, so it is cached here to rebuild the composer's effort
    /// selector for the target model on a mid-session model switch. `None` for
    /// non-Grok agents and when the response carried no `models` (flat fallback).
    /// Backend-internal — not serialized.
    pub grok_model_specs: Option<std::collections::HashMap<String, GrokModelSpec>>,

    /// pi only: the session prelude pi-acp reports as `_meta.piAcp.startupInfo`
    /// on `session/new`, held until the matching `agent_message_chunk` arrives
    /// so that chunk can be recognized and dropped instead of rendering as the
    /// assistant's opening words (see `pi_take_startup_banner`).
    ///
    /// `Some` only between `session/new` and that first chunk: it is taken on
    /// the match, so a later chunk that happens to repeat the text is prose and
    /// renders. `None` for every other agent, for `session/load` / `session/fork`
    /// (pi-acp sets the prelude in `newSession` only), and when pi's
    /// `quietStartup` setting suppressed the prelude at the source.
    /// Backend-internal — not serialized.
    pub pi_startup_banner: Option<String>,

    /// Config-option values codeg asserted while establishing this session
    /// (`apply_preferred_session_options`) and the agent confirmed — the user's
    /// saved preferences on a connect, the parent's selectors on a fork.
    ///
    /// Kept only until the user's first prompt, to arbitrate ONE race: an agent
    /// may re-pin its own model AFTER answering our `set_config_option`, and the
    /// resulting `config_option_update` push is indistinguishable from the user
    /// picking that model themselves. Claude does exactly this on the resume
    /// that re-establishes a forked session — the push lands ~2ms after our
    /// apply and silently reverts it, and effort follows because a model switch
    /// re-scopes the effort option. Before the user has said anything, such a
    /// push can only be establishment noise, so the connection re-asserts once
    /// (see `take_asserted_config_drift`). Once a prompt is sent, every push is
    /// attributable to what the user asked for — `/model` typed in chat is one —
    /// so the map is cleared and the agent wins from then on.
    ///
    /// Backend-internal — not serialized, not carried on `to_snapshot()`.
    pub asserted_config_values: BTreeMap<String, String>,
    /// Config-option ids this launch pinned through the environment, which the
    /// agent will therefore refuse to change for as long as the process lives.
    ///
    /// Cline forced this. codeg pins the provider with `CLINE_PROVIDER` — the
    /// only way a bring-your-own provider clears cline's ACP auth gate — and
    /// cline then answers `set_config_option("provider", …)` with `Invalid
    /// params: Cannot change provider: CLINE_PROVIDER environment variable is
    /// set`. It keeps advertising the selector regardless, so without this the
    /// composer offers a dropdown whose every choice is an error, and a
    /// preference saved from one of those clicks is replayed — and fails —
    /// on every later connect.
    ///
    /// codeg is what disabled the control, so codeg is what withholds it: these
    /// ids are dropped from what the frontend is told about and skipped when
    /// saved preferences are replayed.
    ///
    /// Backend-internal — not serialized, not carried on `to_snapshot()`.
    pub env_pinned_config_option_ids: Vec<String>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub fork_supported: bool,
    pub available_commands: Vec<AvailableCommandInfo>,
    pub usage: Option<UsageInfo>,
    /// True once the agent's initial selectors handshake (modes +
    /// config_options) has finished and `SelectorsReady` has fired. Persisted
    /// on the snapshot so a frontend that reconnects after refresh can see
    /// "init complete" without waiting for an event that already fired.
    pub selectors_ready: bool,

    /// Most recent unresolved `AcpEvent::Error` payload. Cleared when a new
    /// prompt starts, matching the frontend reducer's live-event behavior. The
    /// probe path reads this after `wait_for_session_options` errors so it can
    /// fold the agent's own error message into the returned `AcpError` instead
    /// of surfacing a generic "connection not found" once the connection task
    /// has cleaned up its map entry.
    ///
    /// Exposed on `to_snapshot()` so clients that reconnect after missing the
    /// live `AcpEvent::Error` can still surface the latest agent failure.
    pub last_error: Option<SessionLastError>,

    /// Single-fire signal that fires when `SessionStarted` applies (i.e.
    /// `external_id` transitioned from None → Some). `ConnectionManager::
    /// spawn_agent` holds the per-(agent, working_dir, session_id) dedup
    /// lock until this fires (or times out), so a concurrent acp_connect
    /// for the same logical session sees the populated `external_id` and
    /// reuses instead of spawning a duplicate. `Some` immediately after
    /// `install_session_started_signal()`; `take()`'d in `apply_event::
    /// SessionStarted`; `None` thereafter (the signal is one-shot per
    /// connection). Lives only on the in-memory `SessionState`; not
    /// transmitted on the wire (`LiveSessionSnapshot` doesn't include it).
    pub(crate) session_started_tx: Option<tokio::sync::oneshot::Sender<()>>,

    // 事件锚点
    pub event_seq: u64,
    pub last_activity_at: DateTime<Utc>,

    /// Per-connection event broadcaster used by the WS attach protocol.
    /// New subscribers register receivers here while holding the SessionState
    /// read lock; `emit_with_state` broadcasts after releasing the write
    /// lock. Wrapped in `Arc` so subscriber tasks can hold a reference
    /// independent of the SessionState lock.
    pub(crate) event_stream: Arc<ConnectionEventStream>,

    /// Bounded ring buffer of recent envelopes (most-recent-last). Pushed
    /// by `emit_with_state` inside the write-lock critical section, kept in
    /// strict lockstep with `event_seq`. Read by attach handlers under the
    /// read lock to decide between sending a snapshot or a batched replay.
    /// See `event_stream` module for size limits.
    pub(crate) recent_events: RecentEventsBuffer,

    /// Per-launch token registered with the delegation broker's
    /// `TokenRegistry` when `codeg-mcp` is injected at init.
    /// Revoked when the connection tears down so a leaked binary can't
    /// keep round-tripping after the parent session ends.
    pub delegation_token: Option<String>,

    /// Whether `delegate_to_agent` was exposed to THIS agent at launch (the
    /// `delegation` feature was on when its companion was injected). The sole
    /// gate on appending the `@agent` routing frame: an agent with no such tool
    /// would just be told to route through something it cannot call. Backend-only
    /// and fixed for the connection's lifetime.
    pub delegation_enabled: bool,

    /// Whether the `check_user_feedback` MCP tool was exposed to THIS agent at
    /// launch (the `feedback` feature was on when its companion was injected).
    /// Fixed for the connection's lifetime — tool exposure can't change after
    /// launch. The authoritative gate for both the submit path and the UI: a
    /// session started before the feature was enabled has no tool, so notes
    /// would strand; one started after has it. Carried on `to_snapshot()` so the
    /// frontend gates the feedback bar on the agent's actual capability, not the
    /// (possibly later-toggled) global setting.
    pub feedback_tool_available: bool,

    /// Whether live-feedback notes for THIS session go over the native ACP
    /// `_session/steering` push channel instead of the `check_user_feedback`
    /// pull tool. Synthesized ONCE at initialize from three gates (extension
    /// advertised + registry policy + `agent_info.version` runtime proof — see
    /// `connection.rs::init_advertises_steering`) so every consumer reads one
    /// authoritative bool and the frontend never re-derives it from agent
    /// type. Downgraded to `false` for the rest of the session if a steer ever
    /// comes back `startedNewTurn` (adapter ignored the `promptRequired`
    /// opt-in), rerouting subsequent notes to the MCP pull path.
    pub native_steering_available: bool,

    /// Which generation of codex-acp's `request_user_input` bridge this
    /// connection is talking to — 1.12.0 swapped the question and the tab
    /// header between a form property's `title` and `description`, and nothing
    /// on the wire distinguishes the two. Pinned ONCE at initialize from the
    /// RUNNING adapter's `agentInfo.version`
    /// (`connection.rs::codex_user_input_shape`), because launch may resolve an
    /// older PATH install or a user's custom pinned version rather than the
    /// registry's. `None` for every non-codex agent, and for a codex adapter
    /// that reported no `agentInfo`; the elicitation parser then dates the form
    /// from its own markers. Backend-internal routing only: not part of the
    /// client snapshot.
    pub codex_user_input_shape: Option<crate::acp::question::CodexUserInputShape>,

    /// Which `session_info_update` meta key carries goal snapshots for this
    /// connection: `true` ⇒ the provider-neutral `_meta.goal` (adapter
    /// advertised the goal extension at initialize — claude-agent-acp 0.66+,
    /// codex-acp 1.2+, which dropped the legacy key in the same release),
    /// `false` ⇒ the legacy `_meta.codex.goal`. Pinned ONCE at initialize
    /// (`connection.rs::init_advertises_goal`) so a transitional adapter
    /// double-publishing a goal transition through both namespaces — even
    /// across separate updates — can never render two goal cards.
    /// Backend-internal routing only: not part of the client snapshot.
    pub neutral_goal_channel: bool,

    /// Goal-control request method for this connection. Defaults to codex's
    /// legacy bespoke `_codex/session/goal_control`; overwritten at
    /// initialize when the adapter advertises the provider-neutral goal
    /// extension's `controlMethod` (`_session/goal`, claude 0.66+/codex
    /// 1.2+). Both take the same `{sessionId, action}` params, so
    /// `send_goal_control` just uses whatever is stored here.
    /// Backend-internal: not part of the client snapshot.
    pub goal_control_method: String,

    /// The goal-control action vocabulary this connection's adapter offers —
    /// the advertised `_meta.goal.actions` when the neutral extension is
    /// present (claude: ["set","clear"] — NO pause; codex 1.2+: all four),
    /// else the legacy default ["pause","clear"] so an older codex keeps
    /// today's affordances. Carried on the snapshot: the goal card gates its
    /// Pause/Clear buttons on this list, so a claude session never offers a
    /// pause the adapter would reject.
    ///
    /// Whether the adapter's last goal snapshot left a run OPEN — i.e. the goal
    /// is `active` and driving work. Mirrored from the live goal state in
    /// `emit_conversation_update`; backend-internal, not on the client
    /// snapshot. Read by `ConnectionManager::goal_control` as the one thing
    /// that justifies following a pause/clear with an interrupt: an active goal
    /// means whatever is running is the goal's own work, whereas a PAUSED goal
    /// drives nothing, so clearing it must not abort a turn the user started
    /// themselves.
    pub goal_active: bool,

    /// `None` means NOT YET KNOWN — the initialize response hasn't been
    /// applied. That state is real and observable: `spawn_agent` returns (and
    /// the frontend learns the connection id, then fetches this snapshot) while
    /// `initialize` is still in flight. Defaulting to the legacy pair at
    /// CONSTRUCTION would hand that early reader a plausible-looking
    /// `["pause","clear"]` it latches forever — which is exactly how a claude
    /// session ended up offering a Pause its adapter answers with
    /// `Invalid params: goal action must be "set" or "clear"`. The legacy
    /// fallback is therefore decided at INITIALIZE (see `connection.rs`), not
    /// here, so "unknown" and "legacy" stay distinguishable on the wire.
    pub goal_actions: Option<Vec<String>>,

    /// AIR typed session failures projected by `id` (see
    /// [`SessionFailureRecord`] for the wire contract). Entries are RETAINED
    /// for the connection's lifetime — resolved ones included — both because
    /// the protocol keeps resolved records as history and because each entry
    /// doubles as the per-id revision watermark: dropping an entry would let
    /// a delayed lower-revision upsert resurrect it. Carried on
    /// `to_snapshot()` (whole table, watermarks included) so a client
    /// attaching mid-session applies the same monotonic merge against
    /// subsequent live events. BTreeMap for a deterministic snapshot order.
    pub session_failures: BTreeMap<String, SessionFailureRecord>,

    /// AIR async tasks projected by task id (see [`AsyncTaskRecord`]) — the
    /// merged form of the deltas on `AcpEvent::AsyncTask`.
    ///
    /// Terminal rows are RETAINED for the connection's lifetime rather than
    /// dropped on their last state update. The adapter revises a task after it
    /// settles (a late `outputFilePath`, and a `task_notification` that corrects
    /// a best-effort `stopped` into the real `completed`/`failed`), so an
    /// evicted row would be re-created by its own correction — as a fresh
    /// "running" one, since `spawned` is what carries the identity. Presentation
    /// decides what to show; this table decides what is true. BTreeMap for a
    /// deterministic snapshot order.
    pub async_tasks: BTreeMap<String, AsyncTaskRecord>,

    /// When the last async-task delta of any kind landed. Bounds the keep-alive
    /// exemption in `has_active_background_work` exactly the way
    /// `background_activity_at` bounds the watcher's half — see
    /// [`Self::has_live_async_task`].
    pub async_task_activity_at: Option<DateTime<Utc>>,

    /// Concatenated text content of the just-completed turn's assistant
    /// message. Captured at TurnComplete (just before live_message is
    /// cleared) so the lifecycle subscriber can surface it as the
    /// `delegation_call_id`-bound child outcome. Cleared on the next prompt.
    pub last_assistant_text: Option<String>,

    /// The in-flight user prompt for the current turn, captured from
    /// `AcpEvent::UserMessage` and cleared on `TurnComplete` (alongside
    /// `live_message`). Carried on `to_snapshot()` so a client attaching
    /// mid-turn renders the user turn even though no `UserMessage` event will
    /// replay for it. `None` outside an active turn.
    pub pending_user_message: Option<PendingUserMessage>,

    /// Backend wall-clock instant the in-flight turn started, captured alongside
    /// `pending_user_message` from `AcpEvent::UserMessage` and cleared on
    /// `TurnComplete`. The detail endpoint uses it to tell the in-flight prompt
    /// — persisted at/after this instant by the agent CLI, a local subprocess
    /// sharing this machine's clock — apart from a prior identical prompt
    /// persisted during an earlier turn (see `apply_in_flight_message_id`). Not
    /// serialized: backend-internal, like `turn_in_flight`. `None` outside an
    /// active turn.
    pub pending_user_message_started_at: Option<DateTime<Utc>>,

    /// True between a prompt being accepted (enqueued to the connection loop)
    /// and that turn completing. Set by the manager BEFORE the enqueue (so it
    /// is guaranteed set before the loop can dequeue) and cleared on
    /// `TurnComplete`. The manager rejects a second prompt with
    /// `AcpError::TurnInProgress` while this is set — otherwise the second
    /// `Prompt` would queue behind the active turn and be silently dropped by
    /// the loop's in-turn command handler (`_ => {}`), with the caller still
    /// seeing success. Not serialized: it is a connection-loop liveness flag,
    /// not part of the client-visible snapshot.
    pub turn_in_flight: bool,

    /// How many `TurnComplete`s this connection has applied — the turn's
    /// IDENTITY, paired with `turn_in_flight`. `turn_in_flight` alone only says
    /// "some turn is running"; a caller that admitted itself against turn N and
    /// then awaited something cannot tell, on waking, whether it is still
    /// looking at turn N or at an N+1 that started meanwhile. Comparing this
    /// counter answers that: it moves only when a turn ends, so it is stable
    /// for a turn's whole life and differs across turns.
    ///
    /// Incremented unconditionally next to the `turn_in_flight` clear below —
    /// `TurnComplete` has three emitters and a repeat can land on an already
    /// settled turn, so this is a monotonic marker, not an exact turn count.
    /// Only inequality is ever read. Not serialized: backend-internal, like
    /// `turn_in_flight`. Sole consumer today is
    /// `ConnectionManager::submit_feedback_native`, which re-checks it across
    /// attachment hydration so a steered note cannot ride into the next turn.
    pub turns_completed: u64,

    /// Whether the most recently completed turn ended via a stop reason other
    /// than `"end_turn"` (cancelled, refusal, max_tokens, max_turn_requests,
    /// empty, unknown — the same "abnormal ending" bucket `connection.rs`
    /// already treats uniformly for cascade-cancelling child delegations). Set
    /// by `AcpEvent::TurnComplete`, alongside `pending_user_message`/
    /// `turn_in_flight` clearing. The transcript watcher reads this at the
    /// Prompting→Connected falling edge: an abnormal ending means the turn's
    /// content never reached the wire (the ACP call was torn down before a
    /// held sub-agent's real completion), so `current_turn_launched_ids`
    /// must release immediately instead of waiting for the next turn — that
    /// content has nowhere else to render. Not serialized: backend-internal,
    /// like `turn_in_flight`.
    pub last_turn_ended_abnormally: bool,

    /// True when the agent's effective settings changed after this connection
    /// was spawned — the running process is still on its launch-time config and
    /// needs a restart to pick up the change. Set/cleared by
    /// `AcpEvent::SessionConfigStale` (emitted from
    /// `ConnectionManager::refresh_connection_staleness` after a settings save).
    /// Carried on `to_snapshot()` so a client attaching via the snapshot path
    /// (web reconnect, window refresh, a newly-tiled panel) sees the staleness
    /// the transient event won't replay for it.
    pub config_stale: bool,
    /// Which settings surface drifted, for the banner's wording. `Some` iff
    /// `config_stale`; reset to `None` when staleness clears.
    pub config_stale_kind: Option<ConfigStaleKind>,

    /// Last live ACP session title we actually emitted on this connection.
    /// Used to skip identical `session_info_update.title` repeats (CodeBuddy
    /// resends its fallback after every turn with no last-sent guard).
    /// Backend-internal: not on the client snapshot. Cleared on
    /// `ConversationLinked` so a title dropped while the row was still
    /// unbound can be accepted on the next send.
    pub last_native_title: Option<String>,
}

impl SessionState {
    pub fn new(
        connection_id: String,
        agent_type: AgentType,
        working_dir: Option<PathBuf>,
        owner_window_label: String,
        folder_id: Option<i32>,
    ) -> Self {
        Self {
            connection_id,
            conversation_id: None,
            external_id: None,
            external_id_changed_at: None,
            agent_type,
            working_dir,
            owner_window_label,
            folder_id,
            status: ConnectionStatus::Connecting,
            live_message: None,
            active_tool_calls: BTreeMap::new(),
            pending_permission: None,
            pending_question: None,
            pending_plan_approval: None,
            active_delegations: BTreeMap::new(),
            feedback: Vec::new(),
            background_outstanding: 0,
            background_activity_at: None,
            modes: None,
            current_mode: None,
            config_options: None,
            grok_model_specs: None,
            pi_startup_banner: None,
            asserted_config_values: BTreeMap::new(),
            env_pinned_config_option_ids: Vec::new(),
            prompt_capabilities: None,
            fork_supported: false,
            available_commands: Vec::new(),
            usage: None,
            selectors_ready: false,
            last_error: None,
            session_started_tx: None,
            event_seq: 0,
            last_activity_at: Utc::now(),
            event_stream: Arc::new(ConnectionEventStream::new()),
            recent_events: RecentEventsBuffer::new(),
            delegation_token: None,
            delegation_enabled: false,
            feedback_tool_available: false,
            native_steering_available: false,
            codex_user_input_shape: None,
            neutral_goal_channel: false,
            goal_control_method: crate::acp::codex_goal::LEGACY_GOAL_CONTROL_METHOD.to_string(),
            goal_actions: None,
            goal_active: false,
            session_failures: BTreeMap::new(),
            async_tasks: BTreeMap::new(),
            async_task_activity_at: None,
            last_assistant_text: None,
            pending_user_message: None,
            pending_user_message_started_at: None,
            turn_in_flight: false,
            turns_completed: 0,
            last_turn_ended_abnormally: false,
            config_stale: false,
            config_stale_kind: None,
            last_native_title: None,
        }
    }

    /// Clone the broadcaster handle so attach handlers and subscriber tasks
    /// can hold an independent reference. Cheap (Arc clone).
    pub fn event_stream(&self) -> Arc<ConnectionEventStream> {
        Arc::clone(&self.event_stream)
    }

    /// Return events buffered after `since_seq`, or `None` if the cursor is
    /// older than what the ring buffer holds (caller must fall back to a
    /// snapshot). See `RecentEventsBuffer::range_after`.
    pub fn recent_events_after(&self, since_seq: u64) -> Option<Vec<Arc<EventEnvelope>>> {
        self.recent_events.range_after(since_seq)
    }

    /// Push an envelope into the ring buffer. Must be called under the
    /// write lock from `emit_with_state`, immediately after `event_seq`
    /// is incremented, so the buffer's tail seq matches `event_seq`.
    ///
    /// Returns the eviction count (events dropped from the buffer's head to
    /// stay within count/byte caps, plus any wholesale clear triggered by an
    /// oversized event). Caller propagates this into the
    /// `EventBusMetrics::ring_buffer_evict_count` counter.
    #[must_use = "evicted count feeds the ring_buffer_evict_count metric"]
    pub(crate) fn push_recent_event(&mut self, envelope: Arc<EventEnvelope>) -> usize {
        self.recent_events.push(envelope)
    }

    /// Install a one-shot signal that fires when `SessionStarted` applies.
    /// Returns the receiver; caller (typically `spawn_agent_connection`)
    /// passes it back to the dedup waiter in `spawn_agent`. Calling this
    /// more than once on the same state replaces the previous sender,
    /// silently dropping it — the contract is "exactly one install per
    /// connection lifetime" and that's what `spawn_agent_connection` does.
    pub fn install_session_started_signal(&mut self) -> tokio::sync::oneshot::Receiver<()> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.session_started_tx = Some(tx);
        rx
    }

    /// 单一分发器：把一个 AcpEvent 应用到 self。注意此方法**不**自增 event_seq——
    /// seq 由 emit_with_state 在外层管理（这样 apply_event 可独立单元测试）。
    pub fn apply_event(&mut self, payload: &AcpEvent) {
        match payload {
            AcpEvent::SessionStarted { session_id } => {
                if self.external_id.as_deref() != Some(session_id.as_str()) {
                    self.external_id_changed_at = Some(std::time::SystemTime::now());
                    // The AIR task table is keyed to the session we just left.
                    // Its rows can never settle here again: the adapter
                    // publishes their terminal frames on the OLD session id, and
                    // `AgentSession`'s router stops routing that id to this
                    // connection the moment we attach to the new one. Keeping
                    // them would leave the strip showing tasks that can never
                    // finish and — because a live row exempts this connection
                    // from idle reaping — pin the agent CLI alive for good. A
                    // fork is the ordinary way here: a background task outlives
                    // the turn that started it, and "fork from here" is only
                    // accepted between turns.
                    self.async_tasks.clear();
                    self.async_task_activity_at = None;
                }
                self.external_id = Some(session_id.clone());
                self.status = ConnectionStatus::Connected;
                // Fire the dedup waiter (if any). Take()-and-send is
                // single-shot: a duplicate SessionStarted (replay, agent
                // re-init) finds None here and is a no-op, which is
                // exactly the desired idempotent behavior. send returns
                // Err only when the receiver dropped (timeout already
                // fired in spawn_agent) — also a no-op.
                if let Some(tx) = self.session_started_tx.take() {
                    let _ = tx.send(());
                }
            }
            AcpEvent::StatusChanged { status } => {
                // Diagnostic only (no behavior change): StatusChanged was
                // never logged anywhere, so there was no way to confirm from
                // the log alone whether a held-open turn (claude-agent-acp
                // v0.59.0's #870) actually stayed `Prompting` through an async
                // sub-agent's full lifecycle, or settled earlier than assumed.
                // The suppression filter reads live `Prompting` status and is
                // only correct if the hold behaves as documented.
                tracing::info!(
                    "[ACP] status_changed session={:?} {:?} -> {status:?}",
                    self.external_id,
                    self.status
                );
                if matches!(status, ConnectionStatus::Prompting) {
                    // Match the live frontend reducer: a new prompt starts a
                    // new error scope, so stale recoverable errors must not be
                    // resurrected by a later snapshot attach.
                    self.last_error = None;
                }
                self.status = status.clone();
            }
            AcpEvent::SessionModes { modes } => {
                self.current_mode = Some(modes.current_mode_id.clone());
                self.modes = Some(modes.clone());
            }
            AcpEvent::ModeChanged { mode_id } => {
                self.current_mode = Some(mode_id.clone());
                // Keep `modes.current_mode_id` consistent with the latched
                // `current_mode`. Snapshot consumers read `modes.current_mode_id`
                // directly (the frontend's `denormalizeSnapshot` does not look
                // at the separate `current_mode` field), so without this sync
                // a session that has switched modes would hydrate post-refresh
                // showing the original default — even though the live event
                // stream has long since corrected it.
                if let Some(modes) = self.modes.as_mut() {
                    modes.current_mode_id = mode_id.clone();
                }
            }
            AcpEvent::SessionConfigOptions { config_options } => {
                self.config_options = Some(config_options.clone());
            }
            AcpEvent::SessionConfigStale { stale, kind } => {
                self.config_stale = *stale;
                self.config_stale_kind = if *stale { Some(*kind) } else { None };
            }
            AcpEvent::PromptCapabilities {
                prompt_capabilities,
            } => {
                self.prompt_capabilities = Some(prompt_capabilities.clone());
            }
            AcpEvent::ForkSupported { supported } => {
                self.fork_supported = *supported;
            }
            AcpEvent::AvailableCommands { commands } => {
                self.available_commands = commands.clone();
            }
            AcpEvent::UsageUpdate { used, size } => {
                self.usage = Some(UsageInfo {
                    used: *used,
                    size: *size,
                });
            }
            AcpEvent::ContentDelta {
                text,
                parent_tool_use_id,
            } => {
                // Subagent-attributed chunks accumulate only while the turn
                // is live. Out-of-turn parented chunks (an async subagent
                // still streaming after its parent turn settled) must not
                // resurrect a stale `live_message` via `ensure_live_message`
                // — a snapshot would then hand that ghost to every client
                // (the same disease the #870 held-turn work fenced off).
                // Main-thread chunks keep today's unconditional append.
                self.settle_retry_incidents_on_progress();
                if parent_tool_use_id.is_none() || self.status == ConnectionStatus::Prompting {
                    self.append_text_delta(text, parent_tool_use_id.as_deref());
                }
            }
            AcpEvent::Thinking {
                text,
                parent_tool_use_id,
            } => {
                self.settle_retry_incidents_on_progress();
                if parent_tool_use_id.is_none() || self.status == ConnectionStatus::Prompting {
                    self.append_thinking_delta(text, parent_tool_use_id.as_deref());
                }
            }
            AcpEvent::ToolCall {
                tool_call_id,
                title,
                kind,
                status,
                content,
                raw_input,
                raw_output,
                locations,
                meta,
                images,
            } => {
                self.settle_retry_incidents_on_progress();
                self.upsert_tool_call(
                    tool_call_id,
                    Some(kind),
                    Some(title),
                    Some(status),
                    content.as_deref(),
                    raw_input.as_deref(),
                    raw_output.as_deref(),
                    locations.as_ref(),
                    meta.as_ref(),
                    images.as_deref(),
                );
                // Anchor the tool call in `live_message.content` so snapshot
                // reload preserves position relative to surrounding text /
                // thinking blocks. Idempotent by id: a second ToolCall (or a
                // ToolCallUpdate, see below) for the same id must not push a
                // duplicate ref. Mirrors text/thinking deltas in lazily
                // creating `live_message` if absent.
                self.push_tool_call_ref_if_absent(tool_call_id);
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                title,
                status,
                content,
                raw_input,
                raw_output,
                locations,
                meta,
                images,
                ..
            } => {
                self.upsert_tool_call(
                    tool_call_id,
                    None,
                    title.as_deref(),
                    status.as_deref(),
                    content.as_deref(),
                    raw_input.as_deref(),
                    raw_output.as_deref(),
                    locations.as_ref(),
                    meta.as_ref(),
                    images.as_deref(),
                );
                // Defensive: if a ToolCallUpdate arrives before its initial
                // ToolCall (unusual ordering / replay), ensure the ref block
                // still gets anchored. Idempotent so the normal-flow case is
                // a no-op here.
                self.push_tool_call_ref_if_absent(tool_call_id);
            }
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
                queued,
            } => {
                let tc_id = extract_tool_call_id(tool_call);
                self.pending_permission = Some(PendingPermissionState {
                    request_id: request_id.clone(),
                    tool_call_id: tc_id,
                    tool_call: tool_call.clone(),
                    options: options.clone(),
                    created_at: Utc::now(),
                    queued: *queued,
                });
            }
            AcpEvent::PermissionQueueDepth { depth } => {
                // Depth-only update: the visible card is unchanged, so touch
                // nothing else. A no-op when no card is up (a late depth event
                // after a drain must not resurrect one).
                if let Some(pending) = self.pending_permission.as_mut() {
                    pending.queued = *depth;
                }
            }
            AcpEvent::PermissionResolved { request_id } => {
                // Drop the snapshot's pending_permission iff the resolved
                // request matches the current one. Without the id check, a
                // late-arriving resolved event for an already-replaced
                // request could wipe the live dialog out from under the
                // user.
                if matches!(
                    &self.pending_permission,
                    Some(p) if p.request_id == *request_id,
                ) {
                    self.pending_permission = None;
                }
            }
            AcpEvent::QuestionRequest {
                question_id,
                questions,
            } => {
                self.pending_question = Some(PendingQuestionState {
                    question_id: question_id.clone(),
                    questions: questions.clone(),
                    created_at: Utc::now(),
                });
            }
            AcpEvent::QuestionResolved { question_id } => {
                // Mirror `PermissionResolved`: only clear when the resolved id
                // matches the current one, so a late event for an already-
                // replaced question can't wipe a live card from under the user.
                if matches!(
                    &self.pending_question,
                    Some(p) if p.question_id == *question_id,
                ) {
                    self.pending_question = None;
                }
            }
            AcpEvent::PlanApprovalRequest {
                approval_id,
                tool_call_id,
                plan_markdown,
            } => {
                self.pending_plan_approval = Some(PendingPlanApprovalState {
                    approval_id: approval_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    plan_markdown: plan_markdown.clone(),
                    created_at: Utc::now(),
                });
            }
            AcpEvent::PlanApprovalResolved { approval_id } => {
                // Mirror `QuestionResolved`: only clear when the resolved id
                // matches the current one, so a late event for an already-
                // replaced approval can't wipe a live card from under the user.
                if matches!(
                    &self.pending_plan_approval,
                    Some(p) if p.approval_id == *approval_id,
                ) {
                    self.pending_plan_approval = None;
                }
            }
            AcpEvent::TurnComplete { stop_reason, .. } => {
                // Diagnostic only (no behavior change): pairs with the
                // StatusChanged log above. This is the ACTUAL point the turn
                // settles (`self.status` flips to `Connected` right below,
                // bypassing StatusChanged entirely) — needed to tell whether
                // claude-agent-acp v0.59.0's #870 held the turn open through
                // an async sub-agent's full lifecycle, or settled earlier.
                // `background_outstanding` at this instant shows whether a
                // sub-agent/shell the watcher still considers live was
                // outstanding when the ORIGINAL turn settled.
                tracing::info!(
                    "[ACP] turn_complete session={:?} stop_reason={stop_reason} background_outstanding={}",
                    self.external_id,
                    self.background_outstanding
                );
                // See `last_turn_ended_abnormally`'s doc comment: any reason
                // other than a normal end-of-turn means this turn's content
                // may never have reached the wire.
                self.last_turn_ended_abnormally = stop_reason != "end_turn";
                // AIR retry warnings resolve at the CLEAN turn boundary —
                // adapters never publish resolution (see
                // `SessionFailureRecord`), and a warning that ESCALATED
                // instead was already overwritten by a higher-revision
                // severity-"error" upsert on the same id before this event
                // (a turn's terminal failure rides the prompt RESPONSE
                // `_meta` and the loop emits it first — see
                // `response_session_failure`), so this only settles genuinely
                // recovered retry incidents. Every OTHER stop reason
                // (cancelled / empty / refusal / …) ended a turn that did NOT
                // recover: settling there painted a still-dead connection as
                // a recovered warning (2026-08-15 field report), so those
                // leave the warnings active — the `UserMessage` arm's
                // settle-all still sweeps them at the next prompt.
                //
                // Incidents that recovered MID-turn were already settled by
                // `settle_retry_incidents_on_progress`; this boundary catches
                // the ones still in flight at the end, plus the
                // category-"unknown" notices that progress deliberately skips.
                if stop_reason == "end_turn" {
                    for failure in self.session_failures.values_mut() {
                        if failure.severity == "warning" {
                            failure.resolved = true;
                        }
                    }
                }
                // Snapshot the just-finished turn's FINAL assistant text — what
                // `get_delegation_status` returns as the child result. We take
                // the Text blocks that follow the LAST tool call (the agent's
                // concluding answer), skipping any trailing Thinking/Plan blocks:
                // a `PlanUpdate` is always re-appended at the end of content, so a
                // trailing-only scan would wrongly drop the answer sitting before
                // it. No tool calls → all the turn's text. A turn ending on a tool
                // call (no concluding text) → empty, which CLEARS the field so a
                // prior turn's text can't leak as this turn's result; the LLM
                // reads the full result by opening the child session instead.
                //
                // Cleared FIRST, because a turn can end with no live message at
                // all — cancelled before it produced anything, or one whose only
                // chunk was an empty text delta (dropped by
                // `append_text_delta`). Leaving the field alone there would
                // serve the PREVIOUS turn's answer as this turn's result.
                //
                // Guarded on the turn actually being open, because
                // `TurnComplete` has three emitters (stop-reason message,
                // prompt response, and the cancel path — which deliberately
                // does not wait for the agent, so its response can bring a
                // second one). A repeat must not wipe the text the first one
                // captured.
                if self.turn_in_flight || self.live_message.is_some() {
                    self.last_assistant_text = None;
                }
                if let Some(live) = self.live_message.as_ref() {
                    let after_last_tool_call = live
                        .content
                        .iter()
                        .rposition(|b| matches!(b, LiveContentBlock::ToolCallRef { .. }))
                        .map(|i| i + 1)
                        .unwrap_or(0);
                    let assembled: String = live.content[after_last_tool_call..]
                        .iter()
                        .filter_map(|b| match b {
                            // Main-thread text only: a subagent's trailing
                            // prose (parented blocks, claude-agent-acp ≥0.63
                            // subagent transcripts) is the CHILD's voice and
                            // must never read as the parent's delegation
                            // result.
                            LiveContentBlock::Text {
                                text,
                                parent_tool_use_id: None,
                            } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<Vec<&str>>()
                        .join("");
                    if !assembled.trim().is_empty() {
                        self.last_assistant_text = Some(assembled);
                    }
                }
                self.live_message = None;
                self.active_tool_calls.clear();
                // The turn's user prompt is no longer "in flight" — the
                // assistant reply is done and the transcript is the source of
                // truth. Clear it so a post-turn snapshot doesn't carry a stale
                // pending user message into a fresh attach.
                self.pending_user_message = None;
                self.pending_user_message_started_at = None;
                // Turn finished: release the concurrency gate so the next prompt
                // is accepted. (All connection-alive turn endings — normal,
                // cancel, stop-reason — emit TurnComplete; disconnect/error
                // discard the state entirely, so no stale flag can outlive them.)
                self.turn_in_flight = false;
                // Same edge, the identity half: anyone holding "the turn I was
                // admitted against" can now see that it is gone, even if a new
                // turn sets `turn_in_flight` again before they look.
                self.turns_completed = self.turns_completed.saturating_add(1);
                // NOTE: `active_delegations` is intentionally NOT cleared here.
                // A running delegation's child runs in the background long after
                // the parent's `delegate_to_agent` tool call returns and this
                // turn completes; clearing it would drop the running binding from
                // the snapshot the instant the parent turn ends (the original
                // web-only bug). It's removed per-entry by `DelegationCompleted`.
                self.pending_permission = None;
                // A blocked `ask_user_question` can't outlive its turn: if the
                // turn ends (cancel / stop) the card is moot. The backend's
                // answer one-shot is cleaned via the listener's peer-close race;
                // this just keeps the snapshot honest.
                self.pending_question = None;
                // Likewise a blocked `exit_plan_mode` approval: the parked ext
                // responder is drained by the connection's teardown/cancel path;
                // this just keeps the snapshot honest if the turn settles first.
                self.pending_plan_approval = None;
                self.status = ConnectionStatus::Connected;
            }
            AcpEvent::UserMessage { message_id, blocks } => {
                // Capture the in-flight user prompt so a client attaching
                // mid-turn renders the user turn from the snapshot (the
                // one-shot event won't replay for it). Cleared on TurnComplete.
                self.pending_user_message = Some(PendingUserMessage {
                    message_id: message_id.clone(),
                    blocks: blocks.clone(),
                });
                // Reference instant for the in-flight prompt's recency check in
                // `apply_in_flight_message_id`. Set here (not at manager enqueue)
                // so it tracks `pending_user_message` exactly. Truncated to
                // whole milliseconds: the gate compares this against parsed
                // turn timestamps that carry at most millisecond precision
                // (Cursor's journal upgrade rewrites the in-flight user turn
                // to a millisecond send stamp taken right after this event
                // applies — sub-ms residue here would push the threshold past
                // that stamp and unstamp the turn). The shed sub-ms window
                // cannot admit a prior identical prompt: no agent turn
                // round-trips in under a millisecond.
                let now = Utc::now();
                self.pending_user_message_started_at =
                    DateTime::from_timestamp_millis(now.timestamp_millis());
                // Live-feedback notes are turn-scoped steering: a new user turn
                // starts with a clean slate. The previous turn's notes (read or
                // not) are history at this point; the frontend's "agent didn't
                // read your note → resend" fallback already had its post-turn
                // window before this next prompt arrives.
                self.feedback.clear();
                // A new user turn supersedes any stale pending question.
                self.pending_question = None;
                // Likewise a stale plan approval: a new turn started without a
                // clean TurnComplete (fork/resume re-prompt, error recovery, or a
                // queued prompt sent instead of answering) must not leave a dead
                // approval in the snapshot for a mid-turn attach to render.
                self.pending_plan_approval = None;
                // Starting a prompt past an active AIR failure acknowledges it
                // — settle EVERYTHING, mirroring the frontend reducer's
                // prompt-start settle so a client hydrating mid-turn doesn't
                // resurrect an error the owner already acted on. Entries stay
                // in the table as revision watermarks; a failure that is
                // still real re-arms via a higher revision on the same id.
                for failure in self.session_failures.values_mut() {
                    failure.resolved = true;
                }
            }
            AcpEvent::ConversationLinked {
                conversation_id,
                folder_id,
                ..
            } => {
                self.conversation_id = Some(*conversation_id);
                self.folder_id = Some(*folder_id);
                // A title published before this bind was dropped (no row yet).
                // Forget the skip-cache so a later resend of the same string
                // is not suppressed.
                self.last_native_title = None;
            }
            AcpEvent::PlanUpdate { entries } => {
                // Replace any existing Plan block, then append at end.
                // Mirrors the frontend's PLAN_UPDATE reducer semantic: there
                // is at most one plan block, always at the current end of
                // content. `Vec<PlanEntryInfo>` is converted to
                // `serde_json::Value` because the wire-side `Plan` variant
                // stores it opaquely (frontend casts back to PlanEntryInfo[]).
                let live = self.ensure_live_message();
                live.content
                    .retain(|b| !matches!(b, LiveContentBlock::Plan { .. }));
                live.content.push(LiveContentBlock::Plan {
                    entries: serde_json::to_value(entries).unwrap_or(serde_json::Value::Null),
                });
            }
            AcpEvent::ConversationStatusChanged { .. } => {
                // No-op on purpose. Conversation row `status` is row-level
                // metadata persisted by the lifecycle subscriber / send_prompt
                // path, not in-flight session state — snapshot consumers read
                // status via the conversation list endpoints, not via
                // `LiveSessionSnapshot`. Listed explicitly (rather than swept
                // up by the catchall) so the no-op is intentional and grep-able.
            }
            AcpEvent::SelectorsReady => {
                // Latches once. Snapshot exposes this so a fresh frontend (e.g.
                // after browser refresh) can tell the initial handshake is
                // already done — the event fires only once per connection.
                self.selectors_ready = true;
            }
            AcpEvent::Error {
                message,
                code,
                details,
                ..
            } => {
                // Capture so post-mortem readers (probe path, debug
                // snapshots) can surface the agent's own error message
                // after the connection task has cleaned up its map
                // entry. The same payload is independently emitted
                // through the event channel for live chat-side UX.
                self.last_error = Some(SessionLastError {
                    message: message.clone(),
                    code: code.clone(),
                    details: details.clone(),
                });
            }
            AcpEvent::DelegationStarted {
                parent_tool_use_id,
                child_connection_id,
                child_conversation_id,
                agent_type,
                task_preview,
                task_id,
                ..
            } => {
                // Record the running delegation so the binding is snapshot-
                // recoverable (survives this connection's TurnComplete and any
                // re-attach on the snapshot path). The broker only emits this for
                // a REAL (non-synthetic) parent_tool_use_id, so synthetic-fallback
                // cards never create a phantom entry here — they rely on the
                // parent tool output (see DelegatedSubThread's ack fallback).
                self.active_delegations.insert(
                    parent_tool_use_id.clone(),
                    ActiveDelegationState {
                        parent_tool_use_id: parent_tool_use_id.clone(),
                        child_connection_id: child_connection_id.clone(),
                        child_conversation_id: *child_conversation_id,
                        agent_type: *agent_type,
                        task_preview: task_preview.clone(),
                        task_id: task_id.clone(),
                    },
                );
            }
            AcpEvent::DelegationCompleted {
                parent_tool_use_id, ..
            } => {
                // A running delegation finished: drop it from the live set. Its
                // terminal status/result reaches the LLM via
                // `get_delegation_status` and the UI via the live
                // `DelegationCompleted` event (DelegationProvider) or, on a cold
                // load, the child's persisted DB row (`inject_delegation_meta`).
                // Retaining it would turn this map into an unbounded history log;
                // it is deliberately only the in-flight set.
                self.active_delegations.remove(parent_tool_use_id);
            }
            AcpEvent::FeedbackSubmitted { item } => {
                // Idempotent by id (replay / double-attach safe): append only if
                // this note isn't already tracked. The authoritative append is
                // here so snapshot replay reconstructs the same list the live
                // node holds.
                if !self.feedback.iter().any(|f| f.id == item.id) {
                    let mut item = item.clone();
                    // Enforce the per-turn attachment budget HERE, under the
                    // same `&mut self` that appends, because this is the only
                    // authorized writer. Checking it at the submit site instead
                    // would be a read followed by a write with an agent
                    // round-trip in between: two steers admitted concurrently
                    // would both read the same retained total, both pass, and
                    // both retain — and a replay/attach node applying this
                    // event would not be bounded at all. One critical section
                    // makes the bound hold however the note got here.
                    //
                    // Only the RETAINED copy is trimmed. The note still
                    // delivers and the event still carried its blocks to
                    // whoever is attached right now; what the budget protects
                    // is this list, which outlives the event and is rebuilt
                    // into every snapshot.
                    if let Some(blocks) = item.blocks.as_deref() {
                        let retained: usize = self
                            .feedback
                            .iter()
                            .filter_map(|f| f.blocks.as_deref())
                            .map(crate::acp::feedback::attachment_bytes)
                            .sum();
                        let incoming = crate::acp::feedback::attachment_bytes(blocks);
                        if retained.saturating_add(incoming)
                            > crate::acp::feedback::MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN
                        {
                            tracing::warn!(
                                "[ACP][feedback] steer attachments exceed the per-turn \
                                 budget (retained={retained} incoming={incoming}); \
                                 keeping the note without them"
                            );
                            item.blocks = None;
                        }
                    }
                    self.feedback.push(item);
                }
            }
            AcpEvent::FeedbackConsumed { ids, delivered_at } => {
                // Flip the named pending notes to Delivered. Idempotent: an id
                // already Delivered (the emitting node marked it directly under
                // the write lock; this re-apply is for replay/attach nodes) is
                // skipped. Order-independent and safe to apply more than once.
                for f in self.feedback.iter_mut() {
                    if f.status == FeedbackStatus::Pending && ids.contains(&f.id) {
                        f.status = FeedbackStatus::Delivered;
                        f.delivered_at = Some(*delivered_at);
                    }
                }
            }
            AcpEvent::BackgroundActivity { outstanding, .. } => {
                // Mirror the watcher's authoritative accounting so the idle
                // sweeps can exempt this connection while background work is
                // pending. The turns/settled payloads are frontend-only; the
                // trailing `last_activity_at = now` below additionally resets
                // the backend idle timer on every batch of transcript activity.
                self.background_outstanding = *outstanding;
                self.background_activity_at = Some(Utc::now());
            }
            AcpEvent::SessionFailure { record } => {
                // Monotonic per-id merge — the SAME rule the frontend reducer
                // applies, so a replayed/out-of-order upsert (claude re-sends
                // still-active failures on session/load) is dropped
                // identically on every consumer. Equal revisions are rejected
                // too: an upsert is only ever re-delivered verbatim, never
                // legitimately revised in place. A fresh (higher-revision)
                // upsert re-arms `resolved = false` — id reuse is how codex
                // escalates a retry warning into the turn's terminal error.
                let accept = self
                    .session_failures
                    .get(&record.id)
                    .is_none_or(|existing| record.revision > existing.revision);
                if accept {
                    self.session_failures
                        .insert(record.id.clone(), record.clone());
                }
            }
            AcpEvent::SessionNotice { .. } => {
                // Deliberately keeps NOTHING. Unlike its `SessionFailure`
                // neighbour a notice is not a record: the RFD gives it no id to
                // merge on, no revision to reject and no history position, and
                // says outright that an agent must not rely on one being
                // received or seen. So there is nothing for the snapshot to
                // carry — a client that attaches mid-session has not missed
                // state, it has missed an event, and re-raising a past toast on
                // every attach would be worse than silence.
                //
                // How a notice is presented (a toast, kept in the client's own
                // alert list) is the client's business: storing one here
                // would bring it back on every snapshot.
            }
            AcpEvent::AsyncTask { delta } => {
                // The SAME merge the frontend reducer applies, so a client
                // seeded from the snapshot and one that watched every delta
                // hold identical rows. Only a `spawned` frame may create:
                // progress naming an unknown task means we failed to read its
                // announcement, and a row we can't name or type is worse than
                // no row (see `AsyncTaskDelta::spawned`).
                match self.async_tasks.get_mut(&delta.task_id) {
                    Some(existing) => delta.apply_to(existing),
                    None if delta.spawned => {
                        self.async_tasks
                            .insert(delta.task_id.clone(), delta.to_record());
                    }
                    None => {
                        tracing::debug!(
                            task_id = %delta.task_id,
                            "[ACP] ignoring async-task delta for an unannounced task"
                        );
                    }
                }
                // Stamped for EVERY delta, including one we just dropped: the
                // adapter is demonstrably still talking about background work
                // on this connection, which is the only thing the keep-alive
                // window asks.
                self.async_task_activity_at = Some(Utc::now());
            }
            AcpEvent::ClaudeSdkMessage { .. }
            | AcpEvent::ConfigOptionRejected { .. }
            | AcpEvent::SessionLoadFailed { .. }
            | AcpEvent::TurnRetrying { .. }
            | AcpEvent::NativeSessionTitle { .. }
            | AcpEvent::TranscriptRolledOver { .. }
            | AcpEvent::UserPromptSent { .. } => {
                // 这些事件不直接修改 SessionState 的可见字段。
                // UserPromptSent 是纯通知事件，仅供 chat-channel 推送消费。
                // TurnRetrying 与 Claude 的 api_retry 一样是前端瞬态提示（重试横幅），
                // 不进快照——回合边界会清除它。
                // ConfigOptionRejected 是对一次交互的提示（选择器被降级/拒绝），
                // 权威值已由紧随其后的 SessionConfigOptions 落进快照。
            }
        }
        self.last_activity_at = Utc::now();
    }

    /// Whether this connection has launched background work (async sub-agent /
    /// background shell task) that hasn't settled yet — the idle sweeps must
    /// not reap it (disconnecting drops the ACP connection, which
    /// terminates the agent CLI process, which kills the background work).
    ///
    /// Bounded by `background_keepalive_max_age()`: the exemption requires a
    /// `BackgroundActivity` event within the window, so a wedged/dead watcher
    /// can't pin a connection alive forever. (The watcher itself also expires
    /// tasks past the same age and emits `outstanding: 0`, which resets
    /// `background_outstanding` here — this check is the belt to that
    /// suspenders.)
    pub fn has_active_background_work(&self, now: DateTime<Utc>) -> bool {
        // OR, not a sum. The two sources — the transcript watcher's
        // `background_outstanding` and the AIR async-task table — observe
        // overlapping work through different channels, so adding them would
        // double-count the same background shell. An OR cannot: whichever
        // source still believes work is pending keeps the connection alive,
        // and reaping only resumes once BOTH have let go. That asymmetry is
        // deliberate — a false "still running" costs one idle connection, a
        // false "settled" kills the agent CLI and the work with it.
        if self.has_live_async_task(now) {
            return true;
        }
        if self.background_outstanding == 0 {
            return false;
        }
        match self.background_activity_at {
            Some(at) => now.signed_duration_since(at) < background_keepalive_max_age(),
            None => false,
        }
    }

    /// Whether any AIR async task is still non-terminal AND the adapter has
    /// said something about async tasks recently enough to believe it.
    ///
    /// The age bound is the same belt-and-suspenders the watcher's half of
    /// `has_active_background_work` carries, for the same reason: a row that
    /// never reaches a terminal state would otherwise exempt this connection
    /// from idle reaping FOREVER, and the exemption is the only thing standing
    /// between an idle connection and being reaped. The adapter does close every
    /// task it announced (terminal edge, superseding liveness level, and the
    /// end-of-stream / reset / stream-error `finishAll` paths), but a row can
    /// still strand when the terminal frame is published on a session id this
    /// connection has already left — a fork is the ordinary way there. That case
    /// is handled directly (`SessionStarted` clears the table on a session-id
    /// change); this window is what catches the ones nobody predicted.
    ///
    /// Refreshed by ANY async-task delta, so a task that keeps reporting keeps
    /// its exemption for as long as it runs.
    ///
    /// That clause is claude-only in practice. codex-acp publishes no
    /// `async_task_progress` channel at all (only `_spawned` and
    /// `_state_update`), so a codex background terminal stamps the clock ONCE at
    /// its announcement and then goes quiet — its exemption expires one window
    /// after it started, however long the process actually runs. Deliberately
    /// left alone: before this capability was advertised a codex background
    /// terminal had no exemption whatsoever, and inventing a refresh here would
    /// mean pinning a connection open on a liveness claim nothing re-verifies —
    /// the exact failure this age bound exists to prevent.
    pub fn has_live_async_task(&self, now: DateTime<Utc>) -> bool {
        if !self
            .async_tasks
            .values()
            .any(|t| !crate::acp::types::async_task_state_is_terminal(&t.state))
        {
            return false;
        }
        match self.async_task_activity_at {
            Some(at) => now.signed_duration_since(at) < background_keepalive_max_age(),
            None => false,
        }
    }

    /// A single-line "what the sub-agent is doing right now" hint, used by the
    /// delegation broker so `get_delegation_status` can prove a running child is
    /// genuinely making progress instead of returning a bare "Running.".
    ///
    /// Reads the still-streaming `live_message` — unlike `last_assistant_text`,
    /// which is only snapshotted at `TurnComplete` and so is empty/stale while a
    /// turn is in flight. Preference order, each reduced to one trimmed line
    /// capped at `max_chars` chars (char-based → never splits a UTF-8 codepoint;
    /// an `…` marks truncation):
    ///
    /// 1. the answer-in-progress — `Text` after the last `ToolCallRef`, mirroring
    ///    the `TurnComplete` answer extraction;
    /// 2. else the latest `Thinking` block (`thinking: …`);
    /// 3. else the most recent tool call's label (`running tool: …`).
    ///
    /// `None` when the turn hasn't produced anything renderable yet.
    pub fn latest_live_reply(&self, max_chars: usize) -> Option<String> {
        let live = self.live_message.as_ref()?;

        // (1) Answer-in-progress: the `Text` after the last tool call.
        //
        // Consecutive text deltas merge into a single block (see
        // `append_text_delta`), so this is almost always ONE block — borrow it
        // and take its last non-empty line without copying a potentially large
        // streaming answer on every poll (this runs under the `SessionState`
        // read lock on the `get_delegation_status` path). Only when the answer
        // is split across multiple `Text` blocks (a `Thinking` block interleaved
        // mid-answer) do we stitch them, which is rare.
        let after_last_tool_call = live
            .content
            .iter()
            .rposition(|b| matches!(b, LiveContentBlock::ToolCallRef { .. }))
            .map(|i| i + 1)
            .unwrap_or(0);
        // Main-thread blocks only (`parent_tool_use_id: None`): a Claude
        // subagent's parented transcript chunks describe the CHILD's work and
        // must not surface as the parent's live reply.
        let mut texts = live.content[after_last_tool_call..]
            .iter()
            .filter_map(|b| match b {
                LiveContentBlock::Text {
                    text,
                    parent_tool_use_id: None,
                } => Some(text.as_str()),
                _ => None,
            });
        match (texts.next(), texts.next()) {
            (None, _) => {}
            (Some(only), None) => {
                if let Some(line) = last_nonempty_line(only) {
                    return Some(truncate_one_line(line, max_chars));
                }
            }
            (Some(first), Some(second)) => {
                let mut joined = String::with_capacity(first.len() + second.len());
                joined.push_str(first);
                joined.push_str(second);
                for rest in texts {
                    joined.push_str(rest);
                }
                if let Some(line) = last_nonempty_line(&joined) {
                    return Some(truncate_one_line(line, max_chars));
                }
            }
        }

        // (2) Latest main-thread thinking block — the agent is reasoning, not
        // silent. Parented (subagent) thinking is excluded for the same
        // reason as (1).
        if let Some(line) = live
            .content
            .iter()
            .rev()
            .find_map(|b| match b {
                LiveContentBlock::Thinking {
                    text,
                    parent_tool_use_id: None,
                } => Some(text.as_str()),
                _ => None,
            })
            .and_then(last_nonempty_line)
        {
            return Some(format!("thinking: {}", truncate_one_line(line, max_chars)));
        }

        // (3) Most recent tool call's label — work is happening in a tool.
        if let Some(label) = live
            .content
            .iter()
            .rev()
            .find_map(|b| match b {
                LiveContentBlock::ToolCallRef { tool_call_id } => Some(tool_call_id.as_str()),
                _ => None,
            })
            .and_then(|id| self.active_tool_calls.get(id))
            .map(|tc| tc.label.trim())
            .filter(|l| !l.is_empty())
        {
            return Some(format!(
                "running tool: {}",
                truncate_one_line(label, max_chars)
            ));
        }

        None
    }

    /// The prompt this session is parked on, if any — a permission, an
    /// `ask_user_question`, or a plan approval. `None` means nothing is waiting
    /// on the user.
    ///
    /// Sibling of [`Self::latest_live_reply`] and read on the same
    /// `get_delegation_status` path: for a delegation child, "blocked on the
    /// user" and "working" are indistinguishable from the outside, and only the
    /// former means the parent's poll should stop waiting (#447). Precedence
    /// matches the frontend's: at most one of these surfaces at a time in
    /// practice, and permission is the one agents raise most.
    ///
    /// `title` is a one-line label for whatever needs deciding, capped at
    /// `max_chars`; it can be `None` when the prompt carries no usable text.
    pub fn blocking_prompt(&self, max_chars: usize) -> Option<BlockedOn> {
        if let Some(p) = self.pending_permission.as_ref() {
            // Every producer serializes the ACP `ToolCall` (or mirrors its
            // shape), so `title` is the one field reliably present. Absent /
            // blank degrades to `None` rather than inventing a label.
            let title = p
                .tool_call
                .get("title")
                .and_then(|v| v.as_str())
                .and_then(last_nonempty_line)
                .map(|l| truncate_one_line(l, max_chars));
            return Some(BlockedOn {
                kind: BlockedKind::Permission,
                request_id: p.request_id.clone(),
                title,
            });
        }
        if let Some(q) = self.pending_question.as_ref() {
            let title = q
                .questions
                .first()
                .map(|first| first.question.as_str())
                .and_then(last_nonempty_line)
                .map(|l| truncate_one_line(l, max_chars));
            return Some(BlockedOn {
                kind: BlockedKind::Question,
                request_id: q.question_id.clone(),
                title,
            });
        }
        if let Some(a) = self.pending_plan_approval.as_ref() {
            // The plan's FIRST line is its heading; the last line would be
            // whatever the plan trails off with, which reads as nonsense here.
            let title = a
                .plan_markdown
                .lines()
                .map(str::trim)
                .find(|l| !l.is_empty())
                .map(|l| truncate_one_line(l, max_chars));
            return Some(BlockedOn {
                kind: BlockedKind::PlanApproval,
                request_id: a.approval_id.clone(),
                title,
            });
        }
        None
    }

    /// Lazily initialize `self.live_message` and return a mutable reference
    /// to it. Centralizes the "create-if-absent" pattern shared by the
    /// text/thinking delta appenders, the tool-call ref pusher, and the
    /// plan-update applier.
    fn ensure_live_message(&mut self) -> &mut LiveMessage {
        if self.live_message.is_none() {
            self.live_message = Some(LiveMessage {
                id: format!("live-{}", uuid::Uuid::new_v4()),
                role: MessageRole::Assistant,
                content: Vec::new(),
                started_at: Utc::now(),
            });
        }
        self.live_message
            .as_mut()
            .expect("live_message just initialized")
    }

    /// Settle in-flight AIR retry incidents because the turn produced output
    /// again — codex's own `completeRetryIncidentOnTurnProgress`: the warning
    /// goes up when the upstream drops, and the next chunk is the proof it came
    /// back. Mirrors the frontend's `"retry_incidents"` settle scope.
    ///
    /// Category "unknown" is deliberately left alone: it is where BOTH adapters
    /// route non-incident notices (codex config/skill-budget warnings, claude
    /// `model_refusal_fallback` advisories). Nothing "recovers" those, and
    /// settling them on the next chunk would flash them away before they can be
    /// read — they keep waiting for the turn boundary.
    fn settle_retry_incidents_on_progress(&mut self) {
        for failure in self.session_failures.values_mut() {
            if !failure.resolved && failure.severity == "warning" && failure.category != "unknown" {
                failure.resolved = true;
            }
        }
    }

    fn append_text_delta(&mut self, text: &str, parent_tool_use_id: Option<&str>) {
        // An empty text delta has nothing to render, so the only thing it could
        // contribute is a block boundary — and the frontend reducer never
        // creates one (it drops an empty `CONTENT_DELTA` outright, before it
        // would even open a live message). Dropping it here too is what keeps
        // the two block lists identical; otherwise a snapshot-hydrated client
        // carries an empty `Text` block that the streaming client never had,
        // and prose either side of it looks like two separate runs.
        //
        // Empty THINKING deltas are deliberately NOT dropped: there the empty
        // block IS the signal (it renders the "Thinking…" indicator before any
        // reasoning text arrives, and newer Claude models redact the text
        // entirely while still emitting the block).
        if text.is_empty() {
            return;
        }
        let live = self.ensure_live_message();
        // Merge only into a trailing block of the same kind AND the same
        // subagent attribution — main text → subagent text → main text must
        // produce three blocks, never one. The frontend reducer applies the
        // identical predicate over the same seq-ordered stream, so a client
        // hydrated from a snapshot converges on the same block boundaries as
        // one that streamed live.
        match live.content.last_mut() {
            Some(LiveContentBlock::Text {
                text: existing,
                parent_tool_use_id: p,
            }) if p.as_deref() == parent_tool_use_id => existing.push_str(text),
            _ => live.content.push(LiveContentBlock::Text {
                text: text.to_string(),
                parent_tool_use_id: parent_tool_use_id.map(str::to_owned),
            }),
        }
    }

    fn append_thinking_delta(&mut self, text: &str, parent_tool_use_id: Option<&str>) {
        let live = self.ensure_live_message();
        match live.content.last_mut() {
            Some(LiveContentBlock::Thinking {
                text: existing,
                parent_tool_use_id: p,
            }) if p.as_deref() == parent_tool_use_id => existing.push_str(text),
            _ => live.content.push(LiveContentBlock::Thinking {
                text: text.to_string(),
                parent_tool_use_id: parent_tool_use_id.map(str::to_owned),
            }),
        }
    }

    /// Push a `ToolCallRef` block onto `live_message.content` for the given
    /// tool-call id, but only if no existing block in `content` already
    /// references that id. Called by both `ToolCall` and `ToolCallUpdate`
    /// arms so a tool's position survives any event-ordering edge case
    /// without ever duplicating.
    fn push_tool_call_ref_if_absent(&mut self, tool_call_id: &str) {
        let live = self.ensure_live_message();
        let already_present = live.content.iter().any(|b| {
            matches!(
                b,
                LiveContentBlock::ToolCallRef { tool_call_id: id } if id == tool_call_id
            )
        });
        if !already_present {
            live.content.push(LiveContentBlock::ToolCallRef {
                tool_call_id: tool_call_id.to_string(),
            });
        }
    }

    /// Insert-or-update a tool call entry. Used by both `ToolCall` (initial) and
    /// `ToolCallUpdate` events. `kind` is `Some` only on the initial event;
    /// title/status/content/raw_input/raw_output/locations/meta are merged
    /// when present. Partial-update preservation: a `None` value passed in
    /// from a `ToolCallUpdate` (which typically carries only the fields that
    /// changed) must NOT clobber a previously-set value on the entry.
    #[allow(clippy::too_many_arguments)]
    fn upsert_tool_call(
        &mut self,
        id: &str,
        kind: Option<&str>,
        title: Option<&str>,
        status: Option<&str>,
        content: Option<&str>,
        raw_input: Option<&str>,
        raw_output: Option<&str>,
        locations: Option<&serde_json::Value>,
        meta: Option<&serde_json::Value>,
        images: Option<&[ToolCallImageInfo]>,
    ) {
        let entry = self
            .active_tool_calls
            .entry(id.to_string())
            .or_insert_with(|| ToolCallState {
                id: id.to_string(),
                kind: ToolKind::Other,
                label: String::new(),
                status: ToolCallStatus::Pending,
                input: None,
                output: None,
                content: None,
                locations: None,
                meta: None,
                images: Vec::new(),
                raw_input_chunks: Vec::new(),
            });
        if let Some(k) = kind {
            entry.kind = parse_tool_kind(k);
        }
        if let Some(t) = title {
            entry.label = t.to_string();
        }
        if let Some(s) = status {
            entry.status = parse_tool_call_status(s);
        }
        if let Some(c) = content {
            entry.content = Some(c.to_string());
        }
        if let Some(chunk) = raw_input {
            entry.raw_input_chunks.push(chunk.to_string());
            // 后端目前发送的是已序列化的 JSON 文本（完整或正在累积）。
            // 对最新片段做尽力解析；解析失败则尝试拼接历史片段。
            if let Ok(value) = serde_json::from_str::<serde_json::Value>(chunk) {
                entry.input = Some(value);
            } else if let Ok(value) =
                serde_json::from_str::<serde_json::Value>(&entry.raw_input_chunks.join(""))
            {
                entry.input = Some(value);
            }
        }
        if let Some(text) = raw_output {
            entry.output = Some(parse_tool_call_output_text(text));
        }
        if let Some(loc) = locations {
            entry.locations = Some(loc.clone());
        }
        if let Some(m) = meta {
            entry.meta = Some(m.clone());
        }
        if let Some(imgs) = images {
            // Replace-on-update: the agent re-sends the full image list on
            // every ToolCallUpdate that carries content (see
            // extract_tool_call_images in connection.rs). Absent images
            // (None at the AcpEvent layer) preserve the prior vec.
            entry.images = imgs.to_vec();
        }
    }

    /// Wire copy of `active_tool_calls`, with the bulky RESULT payload of
    /// already-finished calls bounded by `MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES`.
    ///
    /// Nothing removes a completed call from `active_tool_calls`: the map is
    /// cleared in one place, `TurnComplete`. So a single long agentic turn
    /// accumulates one entry per tool call it has ever made, and the snapshot
    /// used to carry all of them whole. Issue #380 sampled a turn that had not
    /// reached `TurnComplete`: 1814 entries / 23.6 MB, then 1983 entries (1964
    /// completed, 18 failed, 1 running) / 26.7 MB. Each entry holds up to
    /// `MAX_SINGLE_EMIT_BYTES` (64 KiB) of tool output plus the agent's
    /// rendered `content` and, for image tools, base64 image data, so the
    /// payload had no bound at all — and the desktop client that parses it on
    /// every attach stopped responding.
    ///
    /// Every call still ships, in the same (id-sorted) order, with its id,
    /// kind, label, status and meta. That is the part nothing else can supply:
    /// `denormalizeSnapshot` resolves each `LiveContentBlock::ToolCallRef` in
    /// `live_message.content` through this list and DROPS a block whose id is
    /// missing, so an entry left out is a tool card missing from the middle of
    /// the in-flight turn.
    ///
    /// What the budget bounds is `input` / `output` / `content` / `locations`,
    /// and only on calls that already reached a terminal status:
    ///
    /// * Pending / InProgress calls are never trimmed, at any size. They are
    ///   the ones the attaching client has to keep rendering and revising from
    ///   live events, their partial output exists nowhere else, and their count
    ///   tracks live concurrency rather than turn length.
    /// * Terminal calls keep everything, newest first, until the budget is
    ///   spent; the older ones then ship without those fields. A finished
    ///   call's result is durable in the agent's own transcript, which is what
    ///   the conversation reloads from.
    ///
    /// `images` is NOT bounded, and deliberately: dropping the bytes does not
    /// degrade the card, it inverts it. The frontend reads an image-generation
    /// block with `image: null` and a terminal status as a FAILED generation
    /// (`generated-images-block.tsx`, and `isImageGenerationToolCall` still
    /// classifies the call from the `label` this keeps), so a trimmed success
    /// would render "image generation failed". Carrying them whole is exactly
    /// what the snapshot does today, so nothing here is a regression; what an
    /// image-heavy turn costs is the same as before this function existed. The
    /// bytes are still counted below, so they push older RESULT payload out
    /// first.
    ///
    /// The budget is spent, not enforced per entry, so the last entry admitted
    /// may carry the total past it by its own size. In-flight entries and the
    /// image data every entry keeps are counted against the budget but never
    /// trimmed by it — which is why the floor can exceed it, and why the
    /// accounting counts a trimmed entry's retained bytes rather than dropping
    /// it from the tally.
    ///
    /// ## Assumption this rests on
    ///
    /// Bounding only terminal calls assumes the agent reports one. Every agent
    /// codeg ships does (`upsert_tool_call` inserts at `Pending` and the
    /// adapter's completion update moves it), but one that never did would
    /// leave the table untrimmable at any length. Pinned by
    /// `snapshot_ships_an_all_unsettled_table_whole` so a future change has to
    /// confront the assumption rather than inherit it.
    ///
    /// ## Known degradation
    ///
    /// A trimmed entry loses `input`, which is one of the signals the client
    /// infers a tool's identity from. `label`, `kind` and `meta` survive and
    /// carry that identity for everything with an authoritative marker
    /// (delegation companions, claudeCode/qoder/grok meta, the OpenCode name),
    /// but two input-shape-only classifications fall back to a generic tool
    /// card on a mid-turn attach of an over-budget turn: codex collab capsules
    /// (`isCodexCollabInput`) and Kimi `TodoList` writes
    /// (`kimiTodoWriteEntries`). Cosmetic and self-healing — the conversation
    /// renders from the transcript on reload.
    fn snapshot_tool_calls(&self) -> Vec<ToolCallState> {
        // Arrival order comes from the live message: `push_tool_call_ref_if_absent`
        // anchors exactly one `ToolCallRef` per call, in the order the agent
        // opened them. `active_tool_calls` itself is keyed by id, which says
        // nothing about age.
        let mut arrival: BTreeMap<&str, usize> = BTreeMap::new();
        if let Some(live) = self.live_message.as_ref() {
            for (i, block) in live.content.iter().enumerate() {
                if let LiveContentBlock::ToolCallRef { tool_call_id } = block {
                    arrival.entry(tool_call_id.as_str()).or_insert(i);
                }
            }
        }

        // (arrival rank, id, trimmable bytes). An id with no anchoring ref sorts
        // newest, so the fail-safe direction is "keep everything" — today that
        // cannot happen, because both `ToolCall` and `ToolCallUpdate` anchor a
        // ref for the id they upsert.
        let mut ordered: Vec<(usize, &str, usize)> = self
            .active_tool_calls
            .iter()
            .map(|(id, tc)| {
                (
                    arrival.get(id.as_str()).copied().unwrap_or(usize::MAX),
                    id.as_str(),
                    tool_call_trimmable_bytes(tc),
                )
            })
            .collect();

        // Both halves, because the question the early return answers is
        // "would shipping this whole be over budget", and the image bytes are
        // part of what ships either way.
        let total = ordered
            .iter()
            .fold(0usize, |acc, (_, id, bytes)| {
                acc.saturating_add(*bytes)
                    .saturating_add(images_slice_size(&self.active_tool_calls[*id].images))
            });
        if total <= MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES {
            // The ordinary turn: nothing to trim, wire shape byte-identical.
            return self.active_tool_calls.values().cloned().collect();
        }

        ordered.sort_unstable();
        let mut trimmed: BTreeSet<&str> = BTreeSet::new();
        let mut spent = 0usize;
        for (_, id, bytes) in ordered.iter().rev() {
            let tc = &self.active_tool_calls[*id];
            // Counted on every entry, trimmed or not: images ship regardless
            // (see the doc comment), so leaving them out of the tally would
            // make the budget measure something the wire does not carry.
            let kept = images_slice_size(&tc.images);
            let terminal = matches!(
                tc.status,
                ToolCallStatus::Completed | ToolCallStatus::Failed
            );
            if terminal && spent >= MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES {
                trimmed.insert(*id);
                spent = spent.saturating_add(kept);
                continue;
            }
            spent = spent.saturating_add(*bytes).saturating_add(kept);
        }

        self.active_tool_calls
            .values()
            .map(|tc| {
                if !trimmed.contains(tc.id.as_str()) {
                    return tc.clone();
                }
                // Listed field by field (no `..tc.clone()`) so a field added to
                // `ToolCallState` later has to be classified here as identity
                // or as payload, instead of silently riding an unbounded value
                // back onto the wire.
                ToolCallState {
                    id: tc.id.clone(),
                    kind: tc.kind.clone(),
                    label: tc.label.clone(),
                    status: tc.status.clone(),
                    input: None,
                    output: None,
                    content: None,
                    locations: None,
                    // Kept: the delegation broker writes the parent↔child
                    // binding here (`meta["codeg.delegation"]`), which is what
                    // re-anchors an inline sub-thread on a mid-turn attach.
                    // Bounded by contract — a small status object, not output.
                    meta: tc.meta.clone(),
                    // Kept: an image-generation block whose `image` is null and
                    // whose status is terminal renders as a FAILED generation,
                    // so dropping these would report a success as a failure.
                    images: tc.images.clone(),
                    // `#[serde(skip)]` — never on the wire either way.
                    raw_input_chunks: Vec::new(),
                }
            })
            .collect()
    }

    /// 拷贝出对外可见的 wire-friendly snapshot。Phase 2 snapshot 端点直接调用此方法。
    pub fn to_snapshot(&self) -> LiveSessionSnapshot {
        LiveSessionSnapshot {
            connection_id: self.connection_id.clone(),
            conversation_id: self.conversation_id,
            folder_id: self.folder_id,
            status: self.status.clone(),
            external_id: self.external_id.clone(),
            live_message: self.live_message.clone(),
            active_tool_calls: self.snapshot_tool_calls(),
            pending_permission: self.pending_permission.clone(),
            pending_question: self.pending_question.clone(),
            pending_plan_approval: self.pending_plan_approval.clone(),
            pending_user_message: self.pending_user_message.clone(),
            active_delegations: self.active_delegations.values().cloned().collect(),
            feedback: self.feedback.clone(),
            background_outstanding: self.background_outstanding,
            feedback_tool_available: self.feedback_tool_available,
            native_steering_available: self.native_steering_available,
            modes: self.modes.clone(),
            current_mode: self.current_mode.clone(),
            config_options: self.config_options.clone(),
            prompt_capabilities: self.prompt_capabilities.clone(),
            usage: self.usage.clone(),
            fork_supported: self.fork_supported,
            available_commands: self.available_commands.clone(),
            selectors_ready: self.selectors_ready,
            config_stale: self.config_stale,
            config_stale_kind: self.config_stale_kind,
            last_error: self.last_error.clone(),
            session_failures: self.session_failures.values().cloned().collect(),
            async_tasks: self.async_tasks.values().cloned().collect(),
            goal_actions: self.goal_actions.clone(),
            event_seq: self.event_seq,
        }
    }
}

/// Max age of the background keep-alive: how long a connection with
/// launched-but-unresolved background work stays exempt from the idle sweeps
/// after the LAST `BackgroundActivity` event. Configurable via
/// `CODEG_ACP_BACKGROUND_KEEPALIVE_MAX_SECS` (seconds; invalid → default 3600;
/// `0` disables the exemption entirely). Read once per process.
pub(crate) fn background_keepalive_max_age() -> chrono::Duration {
    static SECS: std::sync::OnceLock<i64> = std::sync::OnceLock::new();
    let secs = *SECS.get_or_init(|| {
        std::env::var("CODEG_ACP_BACKGROUND_KEEPALIVE_MAX_SECS")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            // `chrono::Duration::seconds` below is an `expect` over
            // `try_seconds`, so it PANICS past `i64::MAX / 1000`. This value is
            // read on the 60-second idle sweep and on every background-watch
            // tick, so an out-of-range env value would abort the process from a
            // timer with nobody at the keyboard, and a panic there leaves no
            // trace of which setting caused it. Out of range is invalid input
            // like any other, so it takes the documented default.
            .filter(|v| *v >= 0 && chrono::Duration::try_seconds(*v).is_some())
            .unwrap_or(3600)
    });
    chrono::Duration::seconds(secs)
}

/// `to_snapshot()` 的输出——前端可消费的 wire shape。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveSessionSnapshot {
    pub connection_id: String,
    pub conversation_id: Option<i32>,
    pub folder_id: Option<i32>,
    pub status: ConnectionStatus,
    pub external_id: Option<String>,
    pub live_message: Option<LiveMessage>,
    pub active_tool_calls: Vec<ToolCallState>,
    pub pending_permission: Option<PendingPermissionState>,
    /// The agent's in-flight `ask_user_question` (see
    /// `SessionState.pending_question`). `#[serde(default)]` so older payloads
    /// deserialize; `skip_serializing_if` keeps the common no-question case off
    /// the wire so every snapshot stays byte-identical with the pre-feature shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_question: Option<PendingQuestionState>,
    /// The agent's in-flight Grok `exit_plan_mode` approval (see
    /// `SessionState.pending_plan_approval`). `#[serde(default)]` so older
    /// payloads deserialize; `skip_serializing_if` keeps the common no-approval
    /// case off the wire so every snapshot stays byte-identical with the
    /// pre-feature shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_plan_approval: Option<PendingPlanApprovalState>,
    /// The in-flight user prompt for the current turn (see
    /// `SessionState.pending_user_message`). `#[serde(default)]` so older
    /// payloads still deserialize; `skip_serializing_if` so the no-pending case
    /// keeps the wire shape byte-identical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_user_message: Option<PendingUserMessage>,
    /// Running sub-agent delegations recoverable from the snapshot (see
    /// `SessionState.active_delegations`). `#[serde(default)]` so older server
    /// payloads without this field still deserialize; `skip_serializing_if` so
    /// the common no-delegation case keeps the wire shape byte-identical and
    /// doesn't bloat every snapshot with an empty array.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub active_delegations: Vec<ActiveDelegationState>,
    /// Live user-feedback notes for the current turn (see `SessionState.feedback`).
    /// `#[serde(default)]` so older server payloads without this field still
    /// deserialize; `skip_serializing_if` keeps the common empty case off the
    /// wire so every snapshot stays byte-identical with the pre-feature shape.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub feedback: Vec<FeedbackItem>,
    /// Launched-but-unresolved background tasks (see
    /// `SessionState.background_outstanding`) — lets a client attaching
    /// mid-episode (web reconnect, new window) recover the pending count the
    /// one-shot `BackgroundActivity` events won't replay for it. `#[serde(
    /// default)]` so older payloads deserialize to `0`; skipped when `0` so the
    /// common no-background case keeps the wire shape byte-identical.
    #[serde(default, skip_serializing_if = "u32_is_zero")]
    pub background_outstanding: u32,
    /// Whether this agent has the `check_user_feedback` tool (see
    /// `SessionState.feedback_tool_available`). `#[serde(default)]` so older
    /// payloads deserialize to `false`; the frontend gates the feedback bar on
    /// it. Always serialized (a plain bool) so the frontend can rely on it.
    #[serde(default)]
    pub feedback_tool_available: bool,
    /// Whether feedback notes ride the native `_session/steering` push channel
    /// (see `SessionState.native_steering_available`). `#[serde(default)]` so
    /// older payloads deserialize to `false`; always serialized (plain bool)
    /// like `feedback_tool_available` so the frontend can rely on it.
    #[serde(default)]
    pub native_steering_available: bool,
    pub modes: Option<SessionModeStateInfo>,
    pub current_mode: Option<String>,
    pub config_options: Option<Vec<SessionConfigOptionInfo>>,
    pub prompt_capabilities: Option<PromptCapabilitiesInfo>,
    pub usage: Option<UsageInfo>,
    pub fork_supported: bool,
    pub available_commands: Vec<AvailableCommandInfo>,
    pub selectors_ready: bool,
    /// Whether the running session is on stale (launch-time) config after a
    /// later settings save (see `SessionState.config_stale`). `#[serde(default)]`
    /// so older server payloads without the field deserialize to `false`; always
    /// serialized so the frontend can rely on it from the snapshot path.
    #[serde(default)]
    pub config_stale: bool,
    /// Which settings surface drifted (see `SessionState.config_stale_kind`).
    /// `#[serde(default)]` + `skip_serializing_if` keep the common not-stale case
    /// byte-identical with the pre-feature wire shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_stale_kind: Option<ConfigStaleKind>,
    /// Most recent agent/runtime error for this live connection. Omitted when
    /// no error has occurred so older clients and common snapshots stay small.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<SessionLastError>,
    /// AIR typed session failure table (resolved entries and revision
    /// watermarks included — see `SessionState.session_failures`). A client
    /// attaching mid-session seeds its reducer from this and keeps applying
    /// the same monotonic merge to live events. Omitted while empty (the
    /// common case) to keep the wire shape byte-identical pre-feature.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub session_failures: Vec<SessionFailureRecord>,
    /// AIR async tasks, merged (see `SessionState.async_tasks`). Terminal rows
    /// included: they carry the ids the subsequent live deltas revise, so a
    /// client seeded without them would re-create a settled task as a running
    /// one on its next correction. Omitted while empty (the common case) to
    /// keep the wire shape byte-identical pre-feature.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub async_tasks: Vec<AsyncTaskRecord>,
    /// Goal-control action vocabulary the goal card gates its buttons on
    /// (see `SessionState.goal_actions`): the advertised list for neutral-goal
    /// adapters, the legacy ["pause","clear"] pair for the rest.
    ///
    /// Three-valued on purpose, and ALWAYS serialized (no `skip_serializing_if`)
    /// so the client can tell the middle case apart:
    /// * a list — the vocabulary is known, gate the buttons on it;
    /// * `null` — this connection hasn't finished `initialize`, so nothing is
    ///   known yet; the client stays fail-closed (no buttons) and re-reads;
    /// * ABSENT — a server too old to have the field at all, which the client
    ///   maps to the legacy pair.
    #[serde(default)]
    pub goal_actions: Option<Vec<String>>,
    pub event_seq: u64,
}

/// `skip_serializing_if` helper for `LiveSessionSnapshot.background_outstanding`.
fn u32_is_zero(v: &u32) -> bool {
    *v == 0
}

/// Byte budget for the bulky tool-call payload one snapshot may carry. See
/// [`SessionState::snapshot_tool_calls`] for what it does and does not bound.
///
/// 2 MiB leaves the newest ~150 finished calls of a typical read/edit/grep turn
/// intact (and, at the 64 KiB per-call ceiling `MAX_SINGLE_EMIT_BYTES` imposes,
/// at least the newest 32 in the worst case) — far more than a client attaching
/// mid-turn has on screen — while holding the #380 session's snapshot at ~2.6 MB
/// instead of 24 MB.
///
/// A ceiling on what is DROPPABLE, not a hard cap on the message: in-flight
/// calls and every call's image data are counted against it but never trimmed
/// by it, so a turn holding more of those than the budget ships more than the
/// budget. That is the same size it ships today.
const MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES: usize = 2 * 1024 * 1024;

/// The part of a `ToolCallState` a trim actually removes: the RESULT payload,
/// which grows with what the tool did. Excludes the identity fields (id / kind /
/// label / status / meta) and `images`, which every entry keeps whatever the
/// budget says — see [`SessionState::snapshot_tool_calls`] for why.
///
/// Sized with the same escape-aware, allocation-free accounting the per-event
/// cap uses (`event_stream`), so "this call's payload" means the same number of
/// bytes on both paths.
fn tool_call_trimmable_bytes(tc: &ToolCallState) -> usize {
    let output = match tc.output.as_ref() {
        Some(ToolCallOutput::Text { content }) => json_str_len(content),
        Some(ToolCallOutput::Error { message }) => json_str_len(message),
        Some(ToolCallOutput::Json { value }) => json_value_size(value),
        None => 0,
    };
    opt_json_size(&tc.input)
        .saturating_add(output)
        .saturating_add(opt_str_size(&tc.content))
        .saturating_add(opt_json_size(&tc.locations))
}

/// Last non-empty line of `s`, trimmed. `None` if every line is blank.
fn last_nonempty_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).rev().find(|l| !l.is_empty())
}

/// Cap `line` at `max_chars` characters, appending `…` when truncated. Operates
/// on `char`s so multi-byte text never splits mid-codepoint. Expects an
/// already single, trimmed line (see [`last_nonempty_line`]). Single-pass: takes
/// at most `max_chars + 1` chars total, so a huge (e.g. MB) input line never
/// triggers a second full scan to decide whether to mark truncation.
fn truncate_one_line(line: &str, max_chars: usize) -> String {
    let mut chars = line.chars();
    let mut out: String = (&mut chars).take(max_chars).collect();
    if chars.next().is_some() {
        out.push('…');
    }
    out
}

fn parse_tool_kind(s: &str) -> ToolKind {
    match s {
        "read" => ToolKind::Read,
        "edit" => ToolKind::Edit,
        "delete" => ToolKind::Delete,
        "move" => ToolKind::Move,
        "search" => ToolKind::Search,
        "execute" => ToolKind::Execute,
        "think" => ToolKind::Think,
        "fetch" => ToolKind::Fetch,
        _ => ToolKind::Other,
    }
}

fn parse_tool_call_status(s: &str) -> ToolCallStatus {
    match s {
        "in_progress" => ToolCallStatus::InProgress,
        "completed" => ToolCallStatus::Completed,
        "failed" => ToolCallStatus::Failed,
        _ => ToolCallStatus::Pending,
    }
}

/// `raw_output` 是已序列化的 JSON 文本。尽力解析为结构化 JSON；解析失败时回退为
/// 文本。如果解析后的 JSON 顶层有 `"error"` 字段，提升为 `Error` 变体。
fn parse_tool_call_output_text(text: &str) -> ToolCallOutput {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(value) => {
            if let Some(err) = value.get("error").and_then(|v| v.as_str()) {
                ToolCallOutput::Error {
                    message: err.to_string(),
                }
            } else if let Some(s) = value.as_str() {
                ToolCallOutput::Text {
                    content: s.to_string(),
                }
            } else {
                ToolCallOutput::Json { value }
            }
        }
        Err(_) => ToolCallOutput::Text {
            content: text.to_string(),
        },
    }
}

/// Permission 事件的 `tool_call` 字段是 ACP 的 ToolCall JSON。提取 id 用作
/// `PendingPermissionState.tool_call_id`——快查路径（match by id 时不必每次重
/// 解析整个 tool_call value）。完整 tool_call value 由调用方另行保留，前端
/// 依赖它做 diff / 命令 / plan 渲染。同时兼容 camelCase / snake_case。
fn extract_tool_call_id(tool_call: &serde_json::Value) -> String {
    tool_call
        .as_object()
        .and_then(|o| {
            o.get("toolCallId")
                .or_else(|| o.get("tool_call_id"))
                .and_then(|v| v.as_str())
        })
        .unwrap_or("")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{
        AcpEvent, AsyncTaskDelta, AsyncTaskUsage, ConnectionStatus, DelegationResultSummary,
        EventEnvelope, PromptCapabilitiesInfo, SessionConfigKindInfo, SessionConfigOptionInfo,
        SessionConfigSelectInfo, SessionModeInfo, SessionModeStateInfo, UserMessageBlock,
    };

    fn fresh_state() -> SessionState {
        SessionState::new(
            "conn-test".to_string(),
            AgentType::ClaudeCode,
            None,
            "win-test".to_string(),
            None,
        )
    }

    /// `ConversationLinked` must forget the live-title skip-cache.
    ///
    /// Today this clear can only ever be a no-op: `emit_conversation_update`
    /// refuses to cache a title while `conversation_id` is `None`, and both
    /// producers of `ConversationLinked` fire only from that same unbound
    /// state, so the cache is already empty every time this runs. It is kept —
    /// and pinned here — because the day something rebinds a LIVE connection to
    /// another row, a cache carried over from the old one would classify the
    /// new row's first title as a repeat and leave it Untitled for the rest of
    /// the connection, with no error anywhere to point at.
    #[test]
    fn conversation_linked_clears_the_native_title_skip_cache() {
        let mut s = fresh_state();
        s.last_native_title = Some("Fix the login flow".into());

        s.apply_event(&AcpEvent::ConversationLinked {
            conversation_id: 7,
            folder_id: 1,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        });

        assert_eq!(s.conversation_id, Some(7));
        assert!(s.last_native_title.is_none());
    }

    #[test]
    fn plan_approval_applies_clears_by_id_and_survives_snapshot() {
        let mut s = fresh_state();
        // Request → pending set + carried on the snapshot for mid-turn attach.
        s.apply_event(&AcpEvent::PlanApprovalRequest {
            approval_id: "ap-1".into(),
            tool_call_id: "call-1".into(),
            plan_markdown: "# Plan".into(),
        });
        let pending = s.pending_plan_approval.clone().expect("pending set");
        assert_eq!(pending.approval_id, "ap-1");
        assert_eq!(pending.tool_call_id, "call-1");
        assert_eq!(pending.plan_markdown, "# Plan");
        assert!(s.to_snapshot().pending_plan_approval.is_some());

        // A resolve for a DIFFERENT id must not wipe the live approval.
        s.apply_event(&AcpEvent::PlanApprovalResolved {
            approval_id: "other".into(),
        });
        assert!(s.pending_plan_approval.is_some());

        // Matching resolve clears it (and the snapshot).
        s.apply_event(&AcpEvent::PlanApprovalResolved {
            approval_id: "ap-1".into(),
        });
        assert!(s.pending_plan_approval.is_none());
        assert!(s.to_snapshot().pending_plan_approval.is_none());
    }

    #[test]
    fn session_failure_upserts_merge_monotonically_and_settle_at_turn_end() {
        fn failure(id: &str, revision: u64, severity: &str, title: &str) -> AcpEvent {
            AcpEvent::SessionFailure {
                record: SessionFailureRecord {
                    id: id.into(),
                    revision,
                    category: "limit".into(),
                    severity: severity.into(),
                    title: title.into(),
                    details: None,
                    actions: vec!["retry".into()],
                    resolved: false,
                },
            }
        }
        let mut s = fresh_state();

        // Upsert then revise in place: one entry, latest revision wins.
        s.apply_event(&failure("t1:error", 1, "warning", "retrying"));
        s.apply_event(&failure("t1:error", 2, "warning", "still retrying"));
        assert_eq!(s.session_failures.len(), 1);
        assert_eq!(s.session_failures["t1:error"].revision, 2);
        assert_eq!(s.session_failures["t1:error"].title, "still retrying");

        // Stale and equal-revision replays are rejected (claude re-publishes
        // still-active failures on session/load — must not thrash state).
        s.apply_event(&failure("t1:error", 1, "warning", "stale"));
        s.apply_event(&failure("t1:error", 2, "warning", "replay"));
        assert_eq!(s.session_failures["t1:error"].title, "still retrying");

        // Turn boundary settles warnings — errors stay active (codex keeps
        // terminal records active deliberately).
        s.apply_event(&failure("s:notice", 1, "error", "auth expired"));
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sid".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert!(s.session_failures["t1:error"].resolved);
        assert!(!s.session_failures["s:notice"].resolved);

        // Escalation via id reuse: a HIGHER-revision upsert re-arms the entry
        // (resolved resets) — how codex turns a retry warning into the turn's
        // terminal error.
        s.apply_event(&failure("t1:error", 3, "error", "gave up"));
        let escalated = &s.session_failures["t1:error"];
        assert!(!escalated.resolved);
        assert_eq!(escalated.severity, "error");

        // Starting a NEW prompt settles EVERYTHING — errors included — so a
        // client hydrating mid-turn can't resurrect a failure the owner
        // already acted past (mirrors the frontend reducer's prompt-start
        // settle). Watermarks survive: the stale rev-2 replay stays rejected,
        // and only a genuinely newer revision re-arms the record.
        s.apply_event(&AcpEvent::UserMessage {
            message_id: "m1".into(),
            blocks: vec![],
        });
        assert!(s.session_failures.values().all(|f| f.resolved));
        s.apply_event(&failure("t1:error", 2, "error", "stale replay"));
        assert!(s.session_failures["t1:error"].resolved);
        assert_eq!(s.session_failures["t1:error"].title, "gave up");
        s.apply_event(&failure("t1:error", 4, "error", "it recurred"));
        assert!(!s.session_failures["t1:error"].resolved);

        // The snapshot carries the WHOLE table — resolved entries and their
        // revision watermarks included — so an attaching client can keep
        // rejecting stale upserts.
        let snap = s.to_snapshot();
        assert_eq!(snap.session_failures.len(), 2);
        let json = serde_json::to_value(&snap).unwrap();
        let failures = json.get("session_failures").unwrap().as_array().unwrap();
        assert!(failures.iter().any(|f| {
            f.get("id").and_then(|v| v.as_str()) == Some("t1:error")
                && f.get("revision").and_then(|v| v.as_u64()) == Some(4)
        }));
    }

    fn async_task_delta(task_id: &str, spawned: bool) -> AsyncTaskDelta {
        AsyncTaskDelta {
            task_id: task_id.into(),
            spawned,
            name: None,
            task_type: None,
            description: None,
            show_in_transcript: None,
            can_stop: None,
            state: None,
            summary: None,
            last_tool_name: None,
            usage: None,
            output_file_path: None,
            tool_call_id: None,
        }
    }

    /// Only the spawn frame carries a task's identity, so it is the only one
    /// allowed to create a row: a progress delta for an id we never saw
    /// announced means codeg failed to read the announcement, and a row with a
    /// placeholder name and no type is worse than no row at all.
    #[test]
    fn async_task_rows_are_created_only_by_a_spawn_delta() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::AsyncTask {
            delta: async_task_delta("ghost", false),
        });
        assert!(s.async_tasks.is_empty());

        let spawn = AsyncTaskDelta {
            name: Some("pnpm test".into()),
            task_type: Some("shell".into()),
            description: Some("pnpm test --watch".into()),
            show_in_transcript: Some(false),
            can_stop: Some(true),
            ..async_task_delta("t1", true)
        };
        s.apply_event(&AcpEvent::AsyncTask { delta: spawn });
        let row = &s.async_tasks["t1"];
        assert_eq!(row.name, "pnpm test");
        assert_eq!(row.task_type, "shell");
        assert!(!row.show_in_transcript);
        assert!(row.can_stop);
        // A spawn frame carries no state field; the row starts live.
        assert_eq!(row.state, "running");
    }

    /// Progress/state deltas are PARTIAL: an absent field must leave the stored
    /// value alone, or the first progress tick would blank out the task's name.
    #[test]
    fn async_task_deltas_revise_only_the_fields_they_carry() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                name: Some("pnpm test".into()),
                task_type: Some("shell".into()),
                ..async_task_delta("t1", true)
            },
        });
        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                last_tool_name: Some("Bash".into()),
                usage: Some(AsyncTaskUsage {
                    total_tokens: 1200,
                    tool_uses: 3,
                    duration_ms: 4500,
                }),
                output_file_path: Some("/tmp/tasks/t1.output".into()),
                ..async_task_delta("t1", false)
            },
        });
        let row = &s.async_tasks["t1"];
        assert_eq!(row.name, "pnpm test");
        assert_eq!(row.task_type, "shell");
        assert_eq!(row.last_tool_name.as_deref(), Some("Bash"));
        assert_eq!(row.usage.as_ref().unwrap().total_tokens, 1200);
        assert_eq!(row.output_file_path.as_deref(), Some("/tmp/tasks/t1.output"));

        // The adapter revises a task AFTER it settles — correcting a
        // best-effort `stopped` into the real outcome, or attaching a late
        // output path. Retaining the row is what lets that correction land as a
        // revision instead of resurrecting the task as a fresh running one.
        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                state: Some("stopped".into()),
                ..async_task_delta("t1", false)
            },
        });
        assert_eq!(s.async_tasks["t1"].state, "stopped");
        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                state: Some("completed".into()),
                summary: Some("all green".into()),
                ..async_task_delta("t1", false)
            },
        });
        assert_eq!(s.async_tasks["t1"].state, "completed");
        assert_eq!(s.async_tasks["t1"].summary.as_deref(), Some("all green"));

        // The whole table rides the snapshot so a client attaching mid-session
        // merges subsequent deltas against the same rows.
        let snap = s.to_snapshot();
        assert_eq!(snap.async_tasks.len(), 1);
        assert_eq!(snap.async_tasks[0].task_id, "t1");
    }

    /// Reaping an idle connection kills the agent CLI, and with it any
    /// background work. A live async task must hold the connection open on its
    /// own — the transcript watcher is a separate, overlapping observer, so the
    /// two combine by OR (never a sum, which would double-count one shell).
    #[test]
    fn a_live_async_task_alone_defers_the_idle_sweep() {
        let mut s = fresh_state();
        let now = Utc::now();
        assert!(!s.has_active_background_work(now));

        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                name: Some("watch".into()),
                ..async_task_delta("t1", true)
            },
        });
        // No `BackgroundActivity` has ever arrived, so this exemption is coming
        // from the async-task table alone.
        assert_eq!(s.background_outstanding, 0);
        assert!(s.has_active_background_work(now));

        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                state: Some("completed".into()),
                ..async_task_delta("t1", false)
            },
        });
        assert!(!s.has_active_background_work(now));
    }

    /// The exemption is what stops the idle sweep, so a row that never reaches a
    /// terminal state would otherwise hold the agent CLI open forever. Bounded
    /// by the same window as the watcher's half, and refreshed by any delta —
    /// a task that keeps reporting keeps its exemption for as long as it runs.
    #[test]
    fn a_silent_async_task_stops_deferring_the_sweep_after_the_keepalive_window() {
        let mut s = fresh_state();
        let now = Utc::now();
        s.apply_event(&AcpEvent::AsyncTask {
            delta: async_task_delta("t1", true),
        });
        assert!(s.has_active_background_work(now));

        let past_window = now + background_keepalive_max_age() + chrono::Duration::seconds(1);
        assert!(
            !s.has_active_background_work(past_window),
            "a row that never settles must not exempt the connection forever"
        );

        // Any delta re-arms it, terminal state notwithstanding: the adapter is
        // demonstrably still talking about this task.
        s.apply_event(&AcpEvent::AsyncTask {
            delta: AsyncTaskDelta {
                last_tool_name: Some("Bash".into()),
                ..async_task_delta("t1", false)
            },
        });
        assert!(s.has_active_background_work(Utc::now()));
    }

    /// A fork attaches to a NEW session id on the same process. The old
    /// session's task rows can never settle here again — their terminal frames
    /// are published on the id the `AgentSession` router has stopped routing to
    /// this connection — so they must go, or the strip shows work that never
    /// finishes and the keep-alive pins the CLI open.
    #[test]
    fn a_session_id_change_drops_the_previous_session_tasks() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "s1".into(),
        });
        s.apply_event(&AcpEvent::AsyncTask {
            delta: async_task_delta("t1", true),
        });
        assert!(s.has_active_background_work(Utc::now()));

        // A duplicate announcement of the SAME id is a replay, not a fork.
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "s1".into(),
        });
        assert_eq!(s.async_tasks.len(), 1);

        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "s2".into(),
        });
        assert!(s.async_tasks.is_empty());
        assert!(!s.has_active_background_work(Utc::now()));
    }

    #[test]
    fn session_failure_warnings_survive_non_clean_turn_ends() {
        fn failure(id: &str, revision: u64, severity: &str, title: &str) -> AcpEvent {
            AcpEvent::SessionFailure {
                record: SessionFailureRecord {
                    id: id.into(),
                    revision,
                    category: "connection".into(),
                    severity: severity.into(),
                    title: title.into(),
                    details: None,
                    actions: vec!["new_session".into()],
                    resolved: false,
                },
            }
        }
        fn turn_complete(stop_reason: &str) -> AcpEvent {
            AcpEvent::TurnComplete {
                session_id: "sid".into(),
                stop_reason: stop_reason.into(),
                agent_type: "claude_code".into(),
            }
        }
        let mut s = fresh_state();
        s.apply_event(&failure("t1:error", 5, "warning", "Reconnecting, attempt 5 of 5."));

        // A cancelled/failed/empty exit is NOT recovery — the incident (e.g.
        // reconnect attempts with the network still down) must stay active
        // instead of collapsing into a "recovered" row (2026-08-15 field
        // report: the banner claimed recovery while offline).
        for reason in ["cancelled", "empty", "refusal", "unknown"] {
            s.apply_event(&turn_complete(reason));
            assert!(
                !s.session_failures["t1:error"].resolved,
                "stop_reason={reason} must not settle warnings"
            );
        }

        // The terminal escalation rides the prompt RESPONSE and the loop
        // applies it BEFORE `TurnComplete` (see `response_session_failure`):
        // the same id flips to severity "error", so even the adapters'
        // disguised clean `end_turn` carrying it cannot settle the incident.
        s.apply_event(&failure("t1:error", 6, "error", "The connection was lost."));
        s.apply_event(&turn_complete("end_turn"));
        let escalated = &s.session_failures["t1:error"];
        assert!(!escalated.resolved);
        assert_eq!(escalated.severity, "error");
        assert_eq!(escalated.revision, 6);

        // A clean end still settles a genuine warning — and only the warning.
        s.apply_event(&failure("w2", 1, "warning", "transient notice"));
        s.apply_event(&turn_complete("end_turn"));
        assert!(s.session_failures["w2"].resolved);
        assert!(!s.session_failures["t1:error"].resolved);
    }

    /// Issue #496: a long turn that reconnects N times stacked N permanent
    /// strips, because the only settle points were a clean `end_turn` and the
    /// next prompt. Turn PROGRESS settles the incident instead — codex's own
    /// `completeRetryIncidentOnTurnProgress`.
    #[test]
    fn session_failure_retry_incidents_settle_on_turn_progress() {
        fn failure(id: &str, category: &str, severity: &str) -> AcpEvent {
            AcpEvent::SessionFailure {
                record: SessionFailureRecord {
                    id: id.into(),
                    revision: 1,
                    category: category.into(),
                    severity: severity.into(),
                    title: format!("{id} title"),
                    details: None,
                    actions: vec![],
                    resolved: false,
                },
            }
        }
        fn text(text: &str) -> AcpEvent {
            AcpEvent::ContentDelta {
                text: text.into(),
                parent_tool_use_id: None,
            }
        }

        let mut s = fresh_state();
        s.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        s.apply_event(&failure("i1", "connection", "warning"));
        s.apply_event(&failure("i2", "service", "warning"));
        // Non-incident informational records: codex config/skill-budget
        // notices and claude advisories both land on category "unknown".
        // Nothing "recovers" those, so progress must leave them readable.
        s.apply_event(&failure("notice", "unknown", "warning"));
        s.apply_event(&failure("err", "connection", "error"));

        s.apply_event(&text("back online"));
        assert!(s.session_failures["i1"].resolved);
        assert!(s.session_failures["i2"].resolved);
        assert!(!s.session_failures["notice"].resolved);
        assert!(!s.session_failures["err"].resolved);

        // Thinking and a fresh tool call are turn output too.
        s.apply_event(&failure("i3", "limit", "warning"));
        s.apply_event(&AcpEvent::Thinking {
            text: "hmm".into(),
            parent_tool_use_id: None,
        });
        assert!(s.session_failures["i3"].resolved);

        s.apply_event(&failure("i4", "connection", "warning"));
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "Read".into(),
            kind: "read".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        assert!(s.session_failures["i4"].resolved);

        // The notice still waits for the clean turn boundary; the terminal
        // error survives it, exactly as before.
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sid".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert!(s.session_failures["notice"].resolved);
        assert!(!s.session_failures["err"].resolved);
    }

    #[test]
    fn turn_complete_clears_pending_plan_approval() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PlanApprovalRequest {
            approval_id: "ap-1".into(),
            tool_call_id: "c".into(),
            plan_markdown: String::new(),
        });
        assert!(s.pending_plan_approval.is_some());
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sid".into(),
            stop_reason: "end_turn".into(),
            agent_type: "grok".into(),
        });
        assert!(s.pending_plan_approval.is_none());
    }

    #[test]
    fn user_message_supersedes_stale_pending_plan_approval() {
        // A new turn starting without a clean TurnComplete (fork/resume re-prompt,
        // queued prompt sent instead of answering) must not leave a dead approval
        // in the snapshot for a mid-turn attach to render.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PlanApprovalRequest {
            approval_id: "ap-1".into(),
            tool_call_id: "c".into(),
            plan_markdown: "# plan".into(),
        });
        assert!(s.pending_plan_approval.is_some());
        s.apply_event(&AcpEvent::UserMessage {
            message_id: "m1".into(),
            blocks: vec![],
        });
        assert!(s.pending_plan_approval.is_none());
    }

    #[test]
    fn background_activity_mirrors_outstanding_and_gates_keepalive() {
        let mut s = fresh_state();
        assert!(!s.has_active_background_work(Utc::now()));

        s.apply_event(&AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding: 2,
            settled: vec![],
            watermark: 42,
        });
        assert_eq!(s.background_outstanding, 2);
        let now = Utc::now();
        assert!(s.has_active_background_work(now));

        // The exemption lapses once the last watcher heartbeat is older than
        // the max age — a dead/wedged watcher can't pin a connection forever.
        let long_after = now + background_keepalive_max_age() + chrono::Duration::seconds(1);
        assert!(!s.has_active_background_work(long_after));

        // Settled back to zero: no exemption regardless of recency.
        s.apply_event(&AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding: 0,
            settled: vec![],
            watermark: 43,
        });
        assert!(!s.has_active_background_work(Utc::now()));
    }

    #[test]
    fn snapshot_carries_background_outstanding_and_skips_zero_on_wire() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding: 3,
            settled: vec![],
            watermark: 0,
        });
        assert_eq!(s.to_snapshot().background_outstanding, 3);
        let json = serde_json::to_value(s.to_snapshot()).unwrap();
        assert_eq!(
            json.get("background_outstanding").and_then(|v| v.as_u64()),
            Some(3)
        );

        // Zero is skipped so the common no-background snapshot stays
        // byte-identical with the pre-feature wire shape.
        let zero = fresh_state();
        let json = serde_json::to_value(zero.to_snapshot()).unwrap();
        assert!(json.get("background_outstanding").is_none());
    }

    #[test]
    fn new_session_starts_with_seq_zero_and_connecting_status() {
        let s = fresh_state();
        assert_eq!(s.event_seq, 0);
        assert_eq!(s.status, ConnectionStatus::Connecting);
        assert!(s.external_id.is_none());
        assert!(s.live_message.is_none());
        assert!(s.active_tool_calls.is_empty());
        assert!(s.pending_permission.is_none());
        assert!(!s.fork_supported);
        assert!(s.available_commands.is_empty());
        assert!(!s.selectors_ready);
        assert!(s.pending_user_message.is_none());
    }

    fn text_user_message(id: &str, text: &str) -> AcpEvent {
        AcpEvent::UserMessage {
            message_id: id.to_string(),
            blocks: vec![UserMessageBlock::Text {
                text: text.to_string(),
            }],
        }
    }

    #[test]
    fn user_message_event_captures_pending_user_message() {
        // The in-flight user prompt is captured so a mid-turn attacher renders
        // the user turn from the snapshot (the one-shot event won't replay).
        let mut s = fresh_state();
        s.apply_event(&text_user_message("user-1", "hello agent"));
        let pending = s.pending_user_message.as_ref().expect("pending set");
        assert_eq!(pending.message_id, "user-1");
        assert_eq!(
            pending.blocks,
            vec![UserMessageBlock::Text {
                text: "hello agent".into()
            }]
        );
        assert!(
            s.pending_user_message_started_at.is_some(),
            "the turn-start instant is captured alongside the pending prompt"
        );
    }

    #[test]
    fn pending_user_message_started_at_has_no_sub_ms_residue() {
        // The recency gate in `apply_in_flight_message_id` compares this
        // stamp against millisecond-precision parsed-turn timestamps
        // (Cursor's journal upgrade rewrites the in-flight user turn to a
        // ms send stamp taken right after this event applies). Sub-ms
        // residue would order the threshold AFTER a stamp taken later in
        // real time and unstamp the turn.
        let mut s = fresh_state();
        s.apply_event(&text_user_message("user-1", "hello"));
        let at = s.pending_user_message_started_at.expect("stamp set");
        assert_eq!(at.timestamp_subsec_nanos() % 1_000_000, 0);
    }

    #[test]
    fn turn_complete_clears_pending_user_message() {
        let mut s = fresh_state();
        s.apply_event(&text_user_message("user-1", "hi"));
        assert!(s.pending_user_message.is_some());
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sess".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        assert!(
            s.pending_user_message.is_none(),
            "a completed turn must clear the pending user message (no stale snapshot)"
        );
        assert!(
            s.pending_user_message_started_at.is_none(),
            "the turn-start instant is cleared in lockstep with the pending prompt"
        );
    }

    #[test]
    fn to_snapshot_carries_pending_user_message() {
        let mut s = fresh_state();
        s.apply_event(&text_user_message("user-7", "snapshot me"));
        let pending = s
            .to_snapshot()
            .pending_user_message
            .expect("snapshot carries pending");
        assert_eq!(pending.message_id, "user-7");
    }

    #[test]
    fn snapshot_round_trips_pending_user_message_and_omits_when_absent() {
        let mut s = fresh_state();
        s.apply_event(&text_user_message("user-9", "round trip"));
        let snap = s.to_snapshot();
        let json = serde_json::to_string(&snap).expect("serialize");
        let back: LiveSessionSnapshot = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.pending_user_message, snap.pending_user_message);
        // No-pending snapshot keeps the field off the wire (byte-identical with
        // the pre-feature shape).
        let empty_json = serde_json::to_string(&fresh_state().to_snapshot()).expect("serialize");
        assert!(
            !empty_json.contains("pending_user_message"),
            "no-pending snapshot must omit the field"
        );
    }

    #[test]
    fn snapshot_carries_last_error_and_clears_on_next_prompt() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::Error {
            message: "ACP protocol error: forbidden".into(),
            agent_type: "claude_code".into(),
            code: Some("forbidden".into()),
            details: None,
            terminal: true,
        });

        let snap = s.to_snapshot();
        assert_eq!(
            snap.last_error,
            Some(SessionLastError {
                message: "ACP protocol error: forbidden".into(),
                code: Some("forbidden".into()),
                details: None,
            })
        );

        let json = serde_json::to_string(&snap).expect("serialize");
        let back: LiveSessionSnapshot = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back.last_error, snap.last_error);

        let empty_json = serde_json::to_string(&fresh_state().to_snapshot()).expect("serialize");
        assert!(
            !empty_json.contains("last_error"),
            "no-error snapshot must omit last_error"
        );

        s.apply_event(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        });
        assert!(
            s.to_snapshot().last_error.is_none(),
            "new prompts clear stale snapshot-recoverable errors"
        );
    }

    #[test]
    fn latest_live_reply_prefers_answer_after_last_tool_call() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "let me check".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "ls".into(),
            kind: "execute".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "Found 3 files.\nDetails here".into(),
            parent_tool_use_id: None,
        });
        // Last non-empty line of the text that follows the final tool call.
        assert_eq!(s.latest_live_reply(100).as_deref(), Some("Details here"));
    }

    #[test]
    fn latest_live_reply_falls_back_to_thinking_then_tool() {
        // Thinking only → `thinking:` prefix.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::Thinking {
            text: "pondering options".into(),
            parent_tool_use_id: None,
        });
        assert_eq!(
            s.latest_live_reply(100).as_deref(),
            Some("thinking: pondering options")
        );

        // A tool call with no trailing text / thinking → `running tool:` prefix.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-9".into(),
            title: "grep files".into(),
            kind: "search".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        assert_eq!(
            s.latest_live_reply(100).as_deref(),
            Some("running tool: grep files")
        );
    }

    #[test]
    fn latest_live_reply_truncates_to_char_budget_and_handles_empty() {
        // No live message yet → nothing to report.
        assert_eq!(fresh_state().latest_live_reply(100), None);

        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "0123456789abcdef".into(),
            parent_tool_use_id: None,
        });
        assert_eq!(s.latest_live_reply(10).as_deref(), Some("0123456789…"));
    }

    #[test]
    fn latest_live_reply_extracts_last_line_from_large_multiline_and_truncates_utf8() {
        let mut s = fresh_state();
        // A large multi-line streamed answer, a final multi-byte line, then
        // trailing blank lines (which must be skipped). The tail extraction must
        // not copy the whole answer, and truncation must land on a codepoint
        // boundary.
        let huge = "x".repeat(5000);
        let last = "résumé 完成 ▸ 配置已更新";
        s.apply_event(&AcpEvent::ContentDelta {
            text: format!("{huge}\nintermediate\n{last}\n   \n"),
            parent_tool_use_id: None,
        });
        let out = s.latest_live_reply(8).unwrap();
        // First 8 chars of `last` are r é s u m é <space> 完, then a truncation
        // marker — codepoint-safe (8 multi-byte chars + the ellipsis), proving
        // the cap counts chars, not bytes.
        assert_eq!(out, "résumé 完…");
        assert_eq!(out.chars().count(), 9);
    }

    #[test]
    fn latest_live_reply_stitches_text_split_by_interleaved_thinking() {
        // A Thinking block between two text deltas yields two separate Text
        // blocks; their concatenation forms the single answer line.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "Answer ".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::Thinking { text: "hmm".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "continues here".into(),
            parent_tool_use_id: None,
        });
        assert_eq!(
            s.latest_live_reply(100).as_deref(),
            Some("Answer continues here")
        );
    }

    #[test]
    fn selectors_ready_event_latches_state_and_snapshot() {
        let mut s = fresh_state();
        assert!(!s.selectors_ready);
        assert!(!s.to_snapshot().selectors_ready);
        s.apply_event(&AcpEvent::SelectorsReady);
        assert!(s.selectors_ready);
        assert!(s.to_snapshot().selectors_ready);
        // Idempotent — staying true on a second apply.
        s.apply_event(&AcpEvent::SelectorsReady);
        assert!(s.selectors_ready);
    }

    #[test]
    fn conversation_status_changed_event_is_a_visible_field_noop() {
        use crate::db::entities::conversation::ConversationStatus;
        // Seed a fully-populated state so we can verify nothing visible mutates
        // when ConversationStatusChanged is applied.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-1".into(),
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "hello".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "ls".into(),
            kind: "execute".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&AcpEvent::ConversationLinked {
            conversation_id: 7,
            folder_id: 3,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        });
        let before = s.to_snapshot();
        let before_status = s.status.clone();
        let before_conversation_id = s.conversation_id;
        let before_external_id = s.external_id.clone();

        s.apply_event(&AcpEvent::ConversationStatusChanged {
            conversation_id: 7,
            status: ConversationStatus::InProgress,
        });

        // Visible state fields unchanged.
        assert_eq!(s.status, before_status);
        assert_eq!(s.conversation_id, before_conversation_id);
        assert_eq!(s.external_id, before_external_id);
        assert!(
            s.live_message.is_some(),
            "live_message must be preserved across status-changed event"
        );
        assert_eq!(s.active_tool_calls.len(), 1);
        assert!(s.active_tool_calls.contains_key("tc-1"));

        // Snapshot output unchanged (modulo last_activity_at which is internal).
        let after = s.to_snapshot();
        assert_eq!(
            serde_json::to_value(&before).unwrap(),
            serde_json::to_value(&after).unwrap(),
            "snapshot must be byte-identical after no-op event"
        );
    }

    #[test]
    fn conversation_linked_event_writes_ids_into_state_and_snapshot() {
        let mut s = fresh_state();
        assert_eq!(s.conversation_id, None);
        assert_eq!(s.folder_id, None);
        s.apply_event(&AcpEvent::ConversationLinked {
            conversation_id: 42,
            folder_id: 7,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        });
        assert_eq!(s.conversation_id, Some(42));
        assert_eq!(s.folder_id, Some(7));
        let snap = s.to_snapshot();
        assert_eq!(snap.conversation_id, Some(42));
        assert_eq!(snap.folder_id, Some(7));
    }

    #[test]
    fn session_started_sets_external_id_and_connected_status() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-42".into(),
        });
        assert_eq!(s.external_id.as_deref(), Some("ext-42"));
        assert_eq!(s.status, ConnectionStatus::Connected);
    }

    #[tokio::test]
    async fn session_started_signal_fires_when_session_started_applies() {
        let mut s = fresh_state();
        let rx = s.install_session_started_signal();
        // Pre-fire: rx not ready.
        assert!(s.session_started_tx.is_some());

        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-1".into(),
        });

        // tx was take()'d.
        assert!(s.session_started_tx.is_none());
        // rx resolves with Ok(()) — bounded timeout because the test must
        // never hang if the signal logic regresses.
        let result = tokio::time::timeout(std::time::Duration::from_millis(50), rx).await;
        assert!(
            matches!(result, Ok(Ok(()))),
            "rx must fire on SessionStarted; got {result:?}"
        );
    }

    #[tokio::test]
    async fn session_started_signal_is_single_shot_safe_against_replay() {
        let mut s = fresh_state();
        let rx = s.install_session_started_signal();
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-1".into(),
        });
        // Replay (or any second SessionStarted) must not panic / double-fire.
        s.apply_event(&AcpEvent::SessionStarted {
            session_id: "ext-2".into(),
        });
        // The first send delivered; rx is consumed.
        let result = tokio::time::timeout(std::time::Duration::from_millis(50), rx).await;
        assert!(matches!(result, Ok(Ok(()))));
    }

    #[tokio::test]
    async fn session_started_rx_aborts_when_state_drops_before_session_started() {
        // Mirrors the production "agent died before SessionStarted" path:
        // SessionState owns tx, gets dropped → rx receives RecvError. The
        // dedup waiter in `spawn_agent` treats this as "abort, release
        // dedup_lock, let next caller proceed".
        let rx = {
            let mut s = fresh_state();
            s.install_session_started_signal()
            // s drops here, taking tx with it.
        };
        let result = tokio::time::timeout(std::time::Duration::from_millis(50), rx).await;
        assert!(
            matches!(result, Ok(Err(_))),
            "rx must receive Err when sender drops without sending; got {result:?}"
        );
    }

    #[test]
    fn content_delta_creates_live_message_then_appends() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "hello ".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "world".into(),
            parent_tool_use_id: None,
        });
        let live = s.live_message.as_ref().expect("live_message expected");
        assert_eq!(
            live.content.len(),
            1,
            "consecutive text deltas merge into one block"
        );
        match &live.content[0] {
            LiveContentBlock::Text { text, .. } => assert_eq!(text, "hello world"),
            _ => panic!("expected text block"),
        }
        assert!(matches!(live.role, MessageRole::Assistant));
    }

    #[test]
    fn thinking_delta_creates_separate_block_from_text() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "T".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::Thinking { text: "X".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::ContentDelta { text: "Y".into(), parent_tool_use_id: None });
        let live = s.live_message.as_ref().unwrap();
        assert_eq!(live.content.len(), 3);
        match &live.content[0] {
            LiveContentBlock::Text { text, .. } => assert_eq!(text, "T"),
            _ => panic!("expected text"),
        }
        match &live.content[1] {
            LiveContentBlock::Thinking { text, .. } => assert_eq!(text, "X"),
            _ => panic!("expected thinking"),
        }
        match &live.content[2] {
            LiveContentBlock::Text { text, .. } => assert_eq!(text, "Y"),
            _ => panic!("expected text"),
        }
    }

    /// Parent → subagent → parent interleave must produce three blocks: the
    /// merge predicate requires the SAME `parent_tool_use_id`, so subagent
    /// prose can never concatenate onto the main thread (and vice versa).
    #[test]
    fn parented_delta_interleave_never_merges_across_attribution() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::ContentDelta {
            text: "main ".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "sub".into(),
            parent_tool_use_id: Some("toolu_parent".into()),
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "more main".into(),
            parent_tool_use_id: None,
        });
        let live = s.live_message.as_ref().unwrap();
        assert_eq!(live.content.len(), 3, "attribution boundaries split blocks");
        match &live.content[1] {
            LiveContentBlock::Text {
                text,
                parent_tool_use_id,
            } => {
                assert_eq!(text, "sub");
                assert_eq!(parent_tool_use_id.as_deref(), Some("toolu_parent"));
            }
            other => panic!("expected parented text block, got {other:?}"),
        }
    }

    /// The frontend reducer drops an empty `CONTENT_DELTA` outright, so a
    /// streaming client never sees an empty `Text` block. If this side kept
    /// one, a snapshot-hydrated client would get an extra block the streaming
    /// one lacks — and prose either side of it would render as two runs
    /// instead of one (#494 on the snapshot path only).
    #[test]
    fn empty_text_delta_adds_no_block_and_never_splits_a_run() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::Thinking {
            text: "before".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: String::new(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::Thinking {
            text: " after".into(),
            parent_tool_use_id: None,
        });
        let live = s.live_message.as_ref().expect("live message");
        assert_eq!(live.content.len(), 1, "no empty Text block was inserted");
        assert!(
            matches!(&live.content[0], LiveContentBlock::Thinking { text, .. } if text == "before after"),
            "the thinking run stayed one block, got {:?}",
            live.content[0]
        );
    }

    /// …and it must not open a live message either — same as the reducer,
    /// which returns before `ensureLiveMessage`.
    #[test]
    fn empty_text_delta_does_not_open_a_live_message() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::ContentDelta {
            text: String::new(),
            parent_tool_use_id: None,
        });
        assert!(s.live_message.is_none());
    }

    #[test]
    fn parented_deltas_with_same_parent_merge() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::ContentDelta {
            text: "a".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "b".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        // A different parent's thinking starts its own block.
        s.apply_event(&AcpEvent::Thinking {
            text: "t1".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        s.apply_event(&AcpEvent::Thinking {
            text: "t2".into(),
            parent_tool_use_id: Some("toolu_q".into()),
        });
        let live = s.live_message.as_ref().unwrap();
        assert_eq!(live.content.len(), 3);
        assert!(
            matches!(&live.content[0], LiveContentBlock::Text { text, .. } if text == "ab"),
            "same-parent text deltas merge"
        );
        assert!(
            matches!(&live.content[2], LiveContentBlock::Thinking { text, parent_tool_use_id }
                if text == "t2" && parent_tool_use_id.as_deref() == Some("toolu_q")),
            "different-parent thinking splits"
        );
    }

    /// Out-of-turn parented chunks (async subagent still streaming after the
    /// parent turn settled) must not resurrect a live_message via
    /// `ensure_live_message` — the snapshot would hand that ghost to every
    /// attaching client. Main-thread chunks keep the unconditional append.
    #[test]
    fn parented_delta_outside_prompting_does_not_touch_live_message() {
        let mut s = fresh_state();
        assert_ne!(s.status, ConnectionStatus::Prompting);
        s.apply_event(&AcpEvent::ContentDelta {
            text: "late sub text".into(),
            parent_tool_use_id: Some("toolu_gone".into()),
        });
        s.apply_event(&AcpEvent::Thinking {
            text: "late sub think".into(),
            parent_tool_use_id: Some("toolu_gone".into()),
        });
        assert!(
            s.live_message.is_none(),
            "parented chunks must not create live_message outside a turn"
        );
        s.apply_event(&AcpEvent::ContentDelta {
            text: "main".into(),
            parent_tool_use_id: None,
        });
        assert!(
            s.live_message.is_some(),
            "main-thread append stays unconditional"
        );
    }

    /// Snapshot round-trip: `parent_tool_use_id` survives serialization, and a
    /// snapshot written by an older backend (no field) still deserializes.
    #[test]
    fn live_block_parent_survives_snapshot_and_old_snapshots_parse() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::ContentDelta {
            text: "sub".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        let snap = s.to_snapshot();
        let json = serde_json::to_string(&snap).unwrap();
        let back: LiveSessionSnapshot = serde_json::from_str(&json).unwrap();
        let live = back.live_message.expect("live message in snapshot");
        assert!(matches!(
            &live.content[0],
            LiveContentBlock::Text { parent_tool_use_id, .. }
                if parent_tool_use_id.as_deref() == Some("toolu_p")
        ));

        let legacy: LiveContentBlock =
            serde_json::from_str(r#"{"kind":"text","text":"old"}"#).unwrap();
        assert!(matches!(
            legacy,
            LiveContentBlock::Text {
                parent_tool_use_id: None,
                ..
            }
        ));
    }

    /// `last_assistant_text` is the delegation child's result — a subagent's
    /// trailing prose is the CHILD's voice and must not read as the answer.
    #[test]
    fn last_assistant_text_ignores_parented_blocks() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::ContentDelta {
            text: "final answer".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: " SUBAGENT NOISE".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "sess-1".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        assert_eq!(s.last_assistant_text.as_deref(), Some("final answer"));
    }

    #[test]
    fn latest_live_reply_ignores_parented_blocks() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.apply_event(&AcpEvent::Thinking {
            text: "sub thinking".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        s.apply_event(&AcpEvent::ContentDelta {
            text: "sub text".into(),
            parent_tool_use_id: Some("toolu_p".into()),
        });
        assert_eq!(
            s.latest_live_reply(200),
            None,
            "parented-only content must not surface as the parent's live reply"
        );
        s.apply_event(&AcpEvent::ContentDelta {
            text: "main progress".into(),
            parent_tool_use_id: None,
        });
        assert_eq!(s.latest_live_reply(200).as_deref(), Some("main progress"));
    }

    #[test]
    fn tool_call_inserts_pending_entry() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "ls".into(),
            kind: "execute".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").expect("tc-1 inserted");
        assert_eq!(entry.status, ToolCallStatus::Pending);
        assert_eq!(entry.kind, ToolKind::Execute);
        assert_eq!(entry.label, "ls");
        assert!(entry.input.is_none());
        assert!(entry.output.is_none());
    }

    #[test]
    fn snapshot_active_tool_calls_are_sorted_by_id() {
        let mut s = fresh_state();
        for id in ["tc-z", "tc-a", "tc-m"] {
            s.apply_event(&AcpEvent::ToolCall {
                tool_call_id: id.into(),
                title: id.into(),
                kind: "read".into(),
                status: "pending".into(),
                content: None,
                raw_input: None,
                raw_output: None,
                locations: None,
                meta: None,
                images: None,
            });
        }
        let snap = s.to_snapshot();
        let ids: Vec<&str> = snap
            .active_tool_calls
            .iter()
            .map(|tc| tc.id.as_str())
            .collect();
        assert_eq!(ids, vec!["tc-a", "tc-m", "tc-z"]);
    }

    /// Open a tool call and finish it, with `output_bytes` of tool output.
    /// `settled` false leaves it in progress (still streaming its output).
    fn run_tool_call(s: &mut SessionState, id: &str, output_bytes: usize, settled: bool) {
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: format!("Read src/{id}.rs"),
            kind: "read".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: Some(format!("{{\"file_path\":\"src/{id}.rs\"}}")),
            raw_output: None,
            locations: Some(serde_json::json!([{ "path": format!("src/{id}.rs") }])),
            meta: Some(serde_json::json!({ "codeg.delegation": { "status": "completed" } })),
            images: None,
        });
        let status = if settled { "completed" } else { "in_progress" };
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: id.into(),
            title: None,
            status: Some(status.to_string()),
            content: None,
            raw_input: None,
            raw_output: Some("o".repeat(output_bytes)),
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
    }

    /// The ordinary turn stays byte-identical: nothing is trimmed while the
    /// table fits the budget, so the wire shape is exactly what it always was.
    #[test]
    fn snapshot_carries_every_tool_call_whole_while_it_fits_the_budget() {
        let mut s = fresh_state();
        for i in 0..20 {
            run_tool_call(&mut s, &format!("tc-{i:03}"), 4 * 1024, true);
        }

        let snap = s.to_snapshot();
        assert_eq!(snap.active_tool_calls.len(), 20);
        for tc in &snap.active_tool_calls {
            let live = &s.active_tool_calls[&tc.id];
            assert_eq!(
                serde_json::to_value(tc).unwrap(),
                serde_json::to_value(live).unwrap(),
                "{} must ship exactly as held",
                tc.id
            );
        }
    }

    /// #380: `active_tool_calls` is cleared only at `TurnComplete`, so a turn
    /// that keeps working accumulates every tool call it ever made — the
    /// reporter sampled 1983 entries and a 26.7 MB snapshot on a turn that had
    /// not reached one, and the client that parses that on attach stopped
    /// responding.
    ///
    /// The snapshot now spends a byte budget over the finished calls' payload,
    /// newest first, WITHOUT dropping an entry: every `ToolCallRef` in the live
    /// message must still resolve, or the reattaching client renders the
    /// in-flight turn with tool cards missing from the middle of it.
    #[test]
    fn snapshot_bounds_finished_tool_call_payload_on_a_long_turn() {
        const CALLS: usize = 300;
        const OUTPUT_BYTES: usize = 16 * 1024;
        let mut s = fresh_state();
        for i in 0..CALLS {
            run_tool_call(&mut s, &format!("tc-{i:04}"), OUTPUT_BYTES, true);
        }
        // …and one still running, the call the attaching client has to keep
        // rendering from live events.
        run_tool_call(&mut s, "tc-running", OUTPUT_BYTES, false);

        // What the state holds, and what shipping it whole would have cost.
        assert_eq!(s.active_tool_calls.len(), CALLS + 1);
        let held: usize = s
            .active_tool_calls
            .values()
            .map(tool_call_trimmable_bytes)
            .sum();
        assert!(
            held > 2 * MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES,
            "the turn must hold well past the budget for this to test anything (held {held})"
        );

        let snap = s.to_snapshot();
        let wire = serde_json::to_string(&snap).expect("serialize snapshot");
        assert!(
            wire.len() < MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES * 3 / 2,
            "snapshot must stay near the budget, got {} bytes for {held} bytes held",
            wire.len()
        );

        // Nothing is dropped: same count, same (id-sorted) order, and every
        // `ToolCallRef` block in the live message still resolves.
        assert_eq!(snap.active_tool_calls.len(), CALLS + 1);
        let wire_ids: Vec<&str> = snap
            .active_tool_calls
            .iter()
            .map(|tc| tc.id.as_str())
            .collect();
        let held_ids: Vec<&str> = s.active_tool_calls.keys().map(String::as_str).collect();
        assert_eq!(wire_ids, held_ids);
        let by_id: std::collections::BTreeMap<&str, &ToolCallState> = snap
            .active_tool_calls
            .iter()
            .map(|tc| (tc.id.as_str(), tc))
            .collect();
        for block in &s.live_message.as_ref().expect("live message").content {
            if let LiveContentBlock::ToolCallRef { tool_call_id } = block {
                assert!(
                    by_id.contains_key(tool_call_id.as_str()),
                    "{tool_call_id} is anchored in the live message but missing from the snapshot"
                );
            }
        }

        // The running call keeps its partial output at any size — nothing else
        // has it. So does the newest finished one.
        assert!(by_id["tc-running"].output.is_some());
        assert!(by_id[format!("tc-{:04}", CALLS - 1).as_str()].output.is_some());

        // The oldest finished calls ship without the payload, but keep every
        // field that identifies the card.
        let oldest = by_id["tc-0000"];
        assert!(oldest.output.is_none(), "oldest call must shed its output");
        assert!(oldest.content.is_none());
        assert!(oldest.input.is_none());
        assert!(oldest.locations.is_none());
        assert_eq!(oldest.label, "Read src/tc-0000.rs");
        assert_eq!(oldest.kind, ToolKind::Read);
        assert_eq!(oldest.status, ToolCallStatus::Completed);
        assert!(
            oldest.meta.is_some(),
            "delegation meta re-anchors an inline sub-thread on attach"
        );

        // And the trimming is a tail, not a purge: the budget is actually spent
        // on the recent calls rather than thrown away.
        let kept = snap
            .active_tool_calls
            .iter()
            .filter(|tc| tc.output.is_some())
            .count();
        assert!(
            kept > 32 && kept < CALLS,
            "expected a bounded recent window to keep its output, got {kept}"
        );
    }

    /// The budget bounds finished work only. A single running call bigger than
    /// the whole budget still ships whole: its output exists nowhere else yet,
    /// and its count tracks live concurrency, not how long the turn has run.
    #[test]
    fn snapshot_never_trims_a_running_tool_call() {
        let mut s = fresh_state();
        for i in 0..200 {
            run_tool_call(&mut s, &format!("tc-{i:04}"), 16 * 1024, true);
        }
        run_tool_call(&mut s, "tc-huge", MAX_SNAPSHOT_TOOL_PAYLOAD_BYTES + 1024, false);

        let snap = s.to_snapshot();
        let huge = snap
            .active_tool_calls
            .iter()
            .find(|tc| tc.id == "tc-huge")
            .expect("running call present");
        assert_eq!(huge.status, ToolCallStatus::InProgress);
        assert!(huge.output.is_some(), "a running call is never trimmed");
    }

    /// A generated image survives the trim, however old the call is.
    ///
    /// `isImageGenerationToolCall` classifies the call from the `label` the
    /// trim keeps, and `generated-images-block.tsx` renders an
    /// image-generation block whose `image` is null under a terminal status as
    /// "image generation failed". So shedding the bytes would not show less,
    /// it would report a success as a failure — and an image is exactly the
    /// payload a user would then go looking for.
    #[test]
    fn snapshot_keeps_a_generated_image_on_the_oldest_trimmed_call() {
        let mut s = fresh_state();
        // The oldest call, and the one carrying the image.
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-image".into(),
            title: "Image generation".into(),
            kind: "other".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: Some("{\"prompt\":\"a cat\"}".into()),
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-image".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some("o".repeat(16 * 1024)),
            raw_output_append: None,
            locations: None,
            meta: None,
            images: Some(vec![ToolCallImageInfo {
                data: "R0lGODlhAQABAAAAACw=".repeat(64),
                mime_type: "image/png".into(),
                uri: None,
            }]),
        });
        // …then enough finished work after it to push it out of the budget.
        for i in 0..300 {
            run_tool_call(&mut s, &format!("tc-{i:04}"), 16 * 1024, true);
        }

        let snap = s.to_snapshot();
        let image_call = snap
            .active_tool_calls
            .iter()
            .find(|tc| tc.id == "tc-image")
            .expect("the image call still ships");
        assert!(
            image_call.output.is_none(),
            "it is old enough to be trimmed, which is what makes this a test"
        );
        assert_eq!(
            image_call.images.len(),
            1,
            "a trimmed success must not come back as a failed generation"
        );
        assert_eq!(image_call.label, "Image generation");
    }

    /// The bound covers terminal calls only, so a table that never reaches one
    /// ships whole however long it gets.
    ///
    /// Every agent codeg ships reports a terminal status, which is what makes
    /// the carve-out for in-flight calls safe. This pins the assumption rather
    /// than leaving it implicit: an agent that stopped reporting one would
    /// turn this test red instead of silently restoring #380.
    #[test]
    fn snapshot_ships_an_all_unsettled_table_whole() {
        let mut s = fresh_state();
        for i in 0..300 {
            run_tool_call(&mut s, &format!("tc-{i:04}"), 16 * 1024, false);
        }

        let snap = s.to_snapshot();
        assert_eq!(snap.active_tool_calls.len(), 300);
        assert!(
            snap.active_tool_calls
                .iter()
                .all(|tc| tc.output.is_some() && tc.status == ToolCallStatus::InProgress),
            "nothing unsettled is trimmed at any size"
        );
    }

    #[test]
    fn tool_call_content_field_is_preserved_on_state() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "ls".into(),
            kind: "execute".into(),
            status: "pending".into(),
            content: Some("line one\nline two".into()),
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").expect("tc-1 inserted");
        assert_eq!(entry.content.as_deref(), Some("line one\nline two"));

        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: None,
            content: Some("line three".into()),
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        // Phase 2 chooses replace-on-update semantics: update == latest known content.
        assert_eq!(entry.content.as_deref(), Some("line three"));
    }

    #[test]
    fn tool_call_update_merges_status_and_output() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "cat foo.txt".into(),
            kind: "read".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        // raw_output text "\"file contents\"" — i.e. JSON-encoded string.
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some("\"file contents\"".into()),
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        assert_eq!(entry.status, ToolCallStatus::Completed);
        assert_eq!(entry.kind, ToolKind::Read);
        assert_eq!(entry.label, "cat foo.txt");
        match &entry.output {
            Some(ToolCallOutput::Text { content }) => assert_eq!(content, "file contents"),
            other => panic!("expected text output, got {:?}", other),
        }
    }

    #[test]
    fn turn_complete_clears_live_and_tool_calls_and_pending_permission() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "hi".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "x".into(),
            kind: "read".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: serde_json::json!({"toolCallId": "tc-1", "title": "danger"}),
            options: vec![],
            queued: 0,
        });
        assert!(s.live_message.is_some());
        assert!(s.pending_permission.is_some());
        assert_eq!(s.active_tool_calls.len(), 1);
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        assert!(s.live_message.is_none());
        assert!(s.active_tool_calls.is_empty());
        assert!(s.pending_permission.is_none());
        assert_eq!(s.status, ConnectionStatus::Connected);
    }

    // --- active_delegations: running-only, snapshot-recoverable binding ---

    fn delegation_started(parent_tool_use_id: &str, child_conv: i32) -> AcpEvent {
        AcpEvent::DelegationStarted {
            parent_connection_id: "conn-test".into(),
            parent_tool_use_id: parent_tool_use_id.into(),
            child_connection_id: "child-conn-1".into(),
            child_conversation_id: child_conv,
            agent_type: AgentType::Codex,
            task_preview: "run the tests".into(),
            task_id: "task-ss-1".into(),
        }
    }

    fn delegation_completed(parent_tool_use_id: &str, child_conv: i32) -> AcpEvent {
        AcpEvent::DelegationCompleted {
            parent_connection_id: "conn-test".into(),
            parent_tool_use_id: parent_tool_use_id.into(),
            child_connection_id: "child-conn-1".into(),
            child_conversation_id: child_conv,
            agent_type: AgentType::Codex,
            result: DelegationResultSummary::Ok {
                duration_ms: 1,
                text_preview: None,
            },
        }
    }

    #[test]
    fn delegation_started_populates_active_delegations_and_snapshot() {
        let mut s = fresh_state();
        s.apply_event(&delegation_started("pt-1", 99));

        let d = s
            .active_delegations
            .get("pt-1")
            .expect("active delegation recorded");
        assert_eq!(d.child_conversation_id, 99);
        assert_eq!(d.child_connection_id, "child-conn-1");
        assert_eq!(d.agent_type, AgentType::Codex);

        // Surfaced on the snapshot, and survives the JSON round-trip the web
        // client hydrates from.
        let snap = s.to_snapshot();
        assert_eq!(snap.active_delegations.len(), 1);
        let json = serde_json::to_string(&snap).unwrap();
        let back: LiveSessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.active_delegations.len(), 1);
        assert_eq!(back.active_delegations[0].parent_tool_use_id, "pt-1");
        assert_eq!(back.active_delegations[0].child_conversation_id, 99);
    }

    #[test]
    fn active_delegations_survives_turn_complete() {
        // Core regression for the web-only bug: an async delegation's child runs
        // in the background AFTER the parent's `delegate_to_agent` tool call
        // returns and the parent turn completes. TurnComplete clears
        // live_message / active_tool_calls but MUST NOT clear active_delegations
        // — otherwise the running binding vanishes from the snapshot the instant
        // the parent turn ends, and a web/server attach (snapshot path) can't
        // recover it.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "pt-1".into(),
            title: "delegate_to_agent".into(),
            kind: "other".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&delegation_started("pt-1", 99));
        assert!(s.active_tool_calls.contains_key("pt-1"));
        assert!(s.active_delegations.contains_key("pt-1"));

        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });

        assert!(
            s.active_tool_calls.is_empty(),
            "TurnComplete still clears in-flight tool calls"
        );
        assert!(
            s.active_delegations.contains_key("pt-1"),
            "running delegation binding must survive TurnComplete"
        );
        assert_eq!(
            s.to_snapshot().active_delegations.len(),
            1,
            "binding still on the snapshot a post-turn attach would receive"
        );
    }

    #[test]
    fn delegation_completed_removes_entry() {
        // Completed delegations are NOT retained here — their terminal state is
        // recovered from the child's persisted DB row (inject_delegation_meta)
        // and the live DelegationProvider binding, not from this in-flight set.
        let mut s = fresh_state();
        s.apply_event(&delegation_started("pt-1", 99));
        assert!(s.active_delegations.contains_key("pt-1"));
        s.apply_event(&delegation_completed("pt-1", 99));
        assert!(
            !s.active_delegations.contains_key("pt-1"),
            "completed delegation removed from the in-flight set"
        );
        assert!(s.to_snapshot().active_delegations.is_empty());
    }

    #[test]
    fn delegation_completed_without_started_is_noop() {
        // A stream that only delivered the completion (started never observed on
        // this connection) must not synthesize a phantom entry: removing an
        // absent key is a no-op, and there is no running child to bind.
        let mut s = fresh_state();
        s.apply_event(&delegation_completed("pt-unknown", 7));
        assert!(s.active_delegations.is_empty());
    }

    #[test]
    fn active_delegations_unbounded_by_running_fanout() {
        // No cap: a parent fanning out far past any old soft bound keeps every
        // running binding (size tracks live concurrency, not an artificial
        // limit). Completing them drains the set back to empty.
        let mut s = fresh_state();
        let n: i32 = 200;
        for i in 0..n {
            s.apply_event(&delegation_started(&format!("pt-{i}"), 1000 + i));
        }
        assert_eq!(s.active_delegations.len(), n as usize);
        assert_eq!(s.to_snapshot().active_delegations.len(), n as usize);
        for i in 0..n {
            s.apply_event(&delegation_completed(&format!("pt-{i}"), 1000 + i));
        }
        assert!(s.active_delegations.is_empty());
    }

    #[test]
    fn delegation_binding_survives_snapshot_split_like_live() {
        // Path A (live): apply started + completed straight through.
        // Path B (reconnect): apply started, snapshot round-trip mid-flight,
        // then apply completed. Both must converge — proving a running
        // delegation recovered from the snapshot ends identically to one tracked
        // live. This is the exact web-attach path the original bug broke.
        let mut a = fresh_state();
        a.apply_event(&delegation_started("tc-1", 99));
        a.apply_event(&delegation_completed("tc-1", 99));

        let mut b = fresh_state();
        b.apply_event(&delegation_started("tc-1", 99));
        // Snapshot round-trip while the child is still running: the running
        // binding must ride along on the wire shape the web client hydrates from.
        let snap = b.to_snapshot();
        assert_eq!(snap.active_delegations.len(), 1);
        assert_eq!(snap.active_delegations[0].parent_tool_use_id, "tc-1");
        let wire = serde_json::to_string(&snap).unwrap();
        let _back: LiveSessionSnapshot = serde_json::from_str(&wire).unwrap();
        b.apply_event(&delegation_completed("tc-1", 99));

        assert_eq!(
            serde_json::to_value(a.to_snapshot().active_delegations).unwrap(),
            serde_json::to_value(b.to_snapshot().active_delegations).unwrap(),
            "snapshot-recovered delegation must match the live-tracked one"
        );
    }

    #[test]
    fn turn_complete_captures_only_trailing_text_block() {
        // last_assistant_text (the delegation result text surfaced by
        // get_delegation_status) keeps only the final text run — the answer
        // after the last tool call — not intermediate narration.
        let mut s = fresh_state();
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![
                LiveContentBlock::Text {
                    text: "let me check ".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::ToolCallRef {
                    tool_call_id: "tc".into(),
                },
                LiveContentBlock::Text {
                    text: "the answer is 42".into(),
                    parent_tool_use_id: None,
                },
            ],
            started_at: Utc::now(),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text.as_deref(), Some("the answer is 42"));
    }

    #[test]
    fn turn_complete_no_tool_calls_captures_full_text() {
        // With no tool call to split on, the trailing run is the whole answer.
        let mut s = fresh_state();
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![
                LiveContentBlock::Text {
                    text: "part 1 ".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::Text {
                    text: "part 2".into(),
                    parent_tool_use_id: None,
                },
            ],
            started_at: Utc::now(),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text.as_deref(), Some("part 1 part 2"));
    }

    #[test]
    fn turn_complete_trailing_tool_call_captures_no_text() {
        // A turn ending on a tool call has no concluding text block; the result
        // text stays unset (the LLM opens the child session for detail).
        let mut s = fresh_state();
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![
                LiveContentBlock::Text {
                    text: "running a tool".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::ToolCallRef {
                    tool_call_id: "tc".into(),
                },
            ],
            started_at: Utc::now(),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text, None);
    }

    #[test]
    fn turn_complete_keeps_final_text_before_a_trailing_plan_block() {
        // `PlanUpdate` re-appends a Plan block at the END of content, so the
        // agent's concluding answer often sits BEFORE a trailing Plan. The
        // result must still be the text after the last tool call, not empty.
        let mut s = fresh_state();
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![
                LiveContentBlock::Text {
                    text: "let me check".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::ToolCallRef {
                    tool_call_id: "tc".into(),
                },
                LiveContentBlock::Text {
                    text: "the answer is 42".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::Plan {
                    entries: serde_json::json!([]),
                },
            ],
            started_at: Utc::now(),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text.as_deref(), Some("the answer is 42"));
    }

    #[test]
    fn turn_complete_clears_stale_last_assistant_text() {
        // A turn that ends with no concluding text must CLEAR any prior value
        // rather than leak it as this turn's delegation result.
        let mut s = fresh_state();
        s.last_assistant_text = Some("stale text from an earlier turn".into());
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![
                LiveContentBlock::Text {
                    text: "working".into(),
                    parent_tool_use_id: None,
                },
                LiveContentBlock::ToolCallRef {
                    tool_call_id: "tc".into(),
                },
            ],
            started_at: Utc::now(),
        });
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text, None);
    }

    /// A turn that never opened a live message has no text of its own either.
    /// An agent whose only output was an empty text chunk reaches exactly that
    /// state (`append_text_delta` drops it), and the turn still ends on
    /// `end_turn` — so without clearing, `get_delegation_status` would hand the
    /// PREVIOUS turn's answer back as this turn's result.
    #[test]
    fn turn_complete_clears_stale_text_when_the_turn_produced_nothing() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.turn_in_flight = true;
        s.last_assistant_text = Some("stale text from an earlier turn".into());
        s.apply_event(&AcpEvent::ContentDelta {
            text: String::new(),
            parent_tool_use_id: None,
        });
        assert!(s.live_message.is_none(), "empty chunk opens no live message");
        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "codex".into(),
        });
        assert_eq!(s.last_assistant_text, None);
    }

    /// `TurnComplete` is emitted from three places, and the cancel path does
    /// not wait for the agent — so a second one can land on an already-settled
    /// turn. It must not wipe the text the first one captured.
    #[test]
    fn a_repeat_turn_complete_keeps_the_captured_text() {
        let mut s = fresh_state();
        s.status = ConnectionStatus::Prompting;
        s.turn_in_flight = true;
        s.live_message = Some(LiveMessage {
            id: "m1".into(),
            role: MessageRole::Assistant,
            content: vec![LiveContentBlock::Text {
                text: "the answer".into(),
                parent_tool_use_id: None,
            }],
            started_at: Utc::now(),
        });
        let complete = AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "cancelled".into(),
            agent_type: "codex".into(),
        };
        s.apply_event(&complete);
        assert_eq!(s.last_assistant_text.as_deref(), Some("the answer"));
        s.apply_event(&complete);
        assert_eq!(
            s.last_assistant_text.as_deref(),
            Some("the answer"),
            "the agent's late response must not erase the captured result"
        );
    }

    #[test]
    fn permission_resolved_clears_matching_request() {
        // Mirrors the pet snapshot semantics: when the user (or auto-approve)
        // responds, the snapshot's pending_permission must drop *before*
        // TurnComplete, otherwise a snapshot-recovering frontend (WS attach
        // after a refresh) would re-render a dialog the user has already
        // answered.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: serde_json::json!({"toolCallId": "tc-1"}),
            options: vec![],
            queued: 0,
        });
        assert!(s.pending_permission.is_some());

        s.apply_event(&AcpEvent::PermissionResolved {
            request_id: "p-1".into(),
        });
        assert!(
            s.pending_permission.is_none(),
            "matching PermissionResolved must clear the pending permission"
        );
    }

    #[test]
    fn permission_queue_depth_updates_the_visible_card_only() {
        // A request arriving behind the visible card publishes no
        // `PermissionRequest` of its own, so the depth-only event is what keeps
        // the card's "N more waiting" hint from going stale — including for a
        // client that attaches mid-turn and hydrates from this snapshot.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: serde_json::json!({"toolCallId": "tc-1"}),
            options: vec![],
            queued: 0,
        });
        s.apply_event(&AcpEvent::PermissionQueueDepth { depth: 2 });
        let p = s.pending_permission.as_ref().expect("card still up");
        assert_eq!(p.queued, 2);
        assert_eq!(p.request_id, "p-1", "depth must not change which card is up");
    }

    #[test]
    fn permission_queue_depth_without_a_card_is_a_noop() {
        // A depth event that lands after a drain must not resurrect a card.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PermissionQueueDepth { depth: 3 });
        assert!(s.pending_permission.is_none());
    }

    #[test]
    fn permission_resolved_stale_request_is_noop() {
        // A late `PermissionResolved` for an already-replaced request must
        // not wipe out the *new* outstanding permission — id mismatch is
        // the only thing distinguishing the two, since the snapshot only
        // tracks one pending permission at a time.
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-2".into(),
            tool_call: serde_json::json!({"toolCallId": "tc-2"}),
            options: vec![],
            queued: 0,
        });

        s.apply_event(&AcpEvent::PermissionResolved {
            request_id: "p-stale".into(),
        });
        let p = s
            .pending_permission
            .as_ref()
            .expect("stale PermissionResolved must not clear a non-matching pending permission");
        assert_eq!(p.request_id, "p-2");
    }

    #[test]
    fn permission_request_preserves_full_tool_call_value() {
        let mut s = fresh_state();
        // Realistic permission payload: title + kind + rawInput (used by the
        // frontend's permission parser to extract command / diff / plan).
        // After the refresh-survives-permission fix, all of this must round
        // trip via the snapshot — losing rawInput would force the user to
        // approve blind.
        let raw_tool_call = serde_json::json!({
            "toolCallId": "tc-9",
            "title": "Run rm -rf /",
            "kind": "execute",
            "rawInput": { "command": "rm -rf /" },
            "locations": [{ "path": "/", "line": 1 }],
        });
        s.apply_event(&AcpEvent::PermissionRequest {
            request_id: "p-1".into(),
            tool_call: raw_tool_call.clone(),
            options: vec![],
            queued: 0,
        });
        let p = s.pending_permission.as_ref().expect("permission set");
        assert_eq!(p.request_id, "p-1");
        assert_eq!(p.tool_call_id, "tc-9");
        assert_eq!(
            p.tool_call, raw_tool_call,
            "full tool_call JSON must round-trip into PendingPermissionState"
        );

        // Snapshot round-trip preserves it byte-for-byte (the load-bearing
        // property — frontend re-renders the approval dialog from this).
        let snap = s.to_snapshot();
        let snap_perm = snap.pending_permission.as_ref().unwrap();
        assert_eq!(snap_perm.tool_call, raw_tool_call);
    }

    #[test]
    fn mode_changed_updates_current_mode_and_session_modes_seeds_state() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::SessionModes {
            modes: SessionModeStateInfo {
                current_mode_id: "default".into(),
                available_modes: vec![SessionModeInfo {
                    id: "default".into(),
                    name: "Default".into(),
                    description: None,
                }],
            },
        });
        assert_eq!(s.current_mode.as_deref(), Some("default"));
        assert!(s.modes.is_some());
        s.apply_event(&AcpEvent::ModeChanged {
            mode_id: "edit".into(),
        });
        assert_eq!(s.current_mode.as_deref(), Some("edit"));
        // Snapshot consistency invariant: ModeChanged must keep
        // `modes.current_mode_id` in sync with the scalar `current_mode`.
        // The frontend's `denormalizeSnapshot` reads `modes.current_mode_id`
        // exclusively; without this sync a post-refresh hydration would
        // show the stale default even though the live event stream had
        // long since switched modes.
        assert_eq!(
            s.modes.as_ref().unwrap().current_mode_id,
            "edit",
            "ModeChanged must keep modes.current_mode_id consistent for snapshot consumers"
        );
    }

    #[test]
    fn snapshot_excludes_internal_chunk_buffers_and_carries_negotiated_caps() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::PromptCapabilities {
            prompt_capabilities: PromptCapabilitiesInfo {
                image: true,
                audio: false,
                embedded_context: true,
            },
        });
        s.apply_event(&AcpEvent::ForkSupported { supported: true });
        s.apply_event(&AcpEvent::SessionConfigOptions {
            config_options: vec![SessionConfigOptionInfo {
                id: "model".into(),
                name: "Model".into(),
                description: None,
                category: None,
                kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                    current_value: "sonnet".into(),
                    options: vec![],
                    groups: vec![],
                }),
                recommended_value: None,
            }],
        });
        s.apply_event(&AcpEvent::UsageUpdate {
            used: 1234,
            size: 200_000,
        });
        // Two raw_input fragments; the second is a complete JSON object
        // and should overwrite `entry.input` with the parsed value.
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "edit".into(),
            kind: "edit".into(),
            status: "pending".into(),
            content: None,
            raw_input: Some("{\"a\":".into()),
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        });
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: None,
            content: None,
            raw_input: Some("{\"a\":1}".into()),
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        assert_eq!(entry.input, Some(serde_json::json!({"a": 1})));
        assert_eq!(entry.raw_input_chunks.len(), 2);

        let snapshot = s.to_snapshot();
        assert_eq!(snapshot.connection_id, "conn-test");
        assert!(snapshot.fork_supported);
        assert_eq!(
            snapshot.usage,
            Some(UsageInfo {
                used: 1234,
                size: 200_000,
            })
        );
        assert!(snapshot.prompt_capabilities.is_some());
        assert_eq!(snapshot.config_options.as_ref().map(|v| v.len()), Some(1));
        assert_eq!(snapshot.active_tool_calls.len(), 1);

        // Wire shape: raw_input_chunks must NOT be serialized.
        let json = serde_json::to_value(&snapshot).unwrap();
        let tc_json = json["active_tool_calls"][0].clone();
        assert!(
            tc_json.get("raw_input_chunks").is_none(),
            "raw_input_chunks must be #[serde(skip)] (got {})",
            tc_json
        );
        assert_eq!(tc_json["input"], serde_json::json!({"a": 1}));
    }

    fn scripted_event_sequence() -> Vec<AcpEvent> {
        vec![
            AcpEvent::SessionStarted {
                session_id: "ext-1".into(),
            },
            AcpEvent::ContentDelta {
                text: "Hello ".into(),
                parent_tool_use_id: None,
            },
            AcpEvent::ContentDelta {
                text: "world".into(),
                parent_tool_use_id: None,
            },
            AcpEvent::ToolCall {
                tool_call_id: "tc-1".into(),
                title: "ls".into(),
                kind: "execute".into(),
                status: "pending".into(),
                content: None,
                raw_input: None,
                raw_output: None,
                locations: None,
                meta: None,
                images: None,
            },
            AcpEvent::ToolCallUpdate {
                tool_call_id: "tc-1".into(),
                title: None,
                status: Some("completed".into()),
                content: None,
                raw_input: None,
                raw_output: Some("\"done\"".into()),
                raw_output_append: None,
                locations: None,
                meta: None,
                images: None,
            },
            AcpEvent::Thinking {
                text: "considering".into(),
                parent_tool_use_id: None,
            },
            AcpEvent::ContentDelta {
                text: " More text".into(),
                parent_tool_use_id: None,
            },
            AcpEvent::UsageUpdate {
                used: 1234,
                size: 200_000,
            },
        ]
    }

    #[test]
    fn full_turn_lifecycle_increments_seq_monotonically() {
        let mut s = fresh_state();
        let events = scripted_event_sequence();
        let mut seq = 0u64;
        for e in &events {
            s.apply_event(e);
            seq += 1;
            s.event_seq = seq;
        }
        assert_eq!(s.event_seq, events.len() as u64);
    }

    /// Strip volatile fields that legitimately differ between Path A and Path B
    /// (e.g. `LiveMessage.id` is generated via `uuid::new_v4()` and `started_at`
    /// uses `Utc::now()`) but don't matter for snapshot/live consistency.
    fn normalize_snapshot(snap: &LiveSessionSnapshot) -> serde_json::Value {
        let mut v = serde_json::to_value(snap).unwrap();
        if let Some(lm) = v.get_mut("live_message") {
            if let Some(obj) = lm.as_object_mut() {
                obj.remove("id");
                obj.remove("started_at");
            }
        }
        v
    }

    /// 对账测试：从初始状态全程 apply 到 N 个事件 == 从 snapshot
    /// (apply 完前 K 个) + apply 剩下 N-K 个事件，最终状态等价。
    #[test]
    fn snapshot_filtered_events_yield_same_state_as_live_subscriber() {
        let events = scripted_event_sequence();
        let split = events.len() / 2;

        // Path A: live subscriber——全程 apply
        let mut a = fresh_state();
        for (i, e) in events.iter().enumerate() {
            a.apply_event(e);
            a.event_seq = (i + 1) as u64;
        }

        // Path B: snapshot 重连
        // 1) apply 前 split 个事件
        let mut b = fresh_state();
        for (i, e) in events.iter().take(split).enumerate() {
            b.apply_event(e);
            b.event_seq = (i + 1) as u64;
        }
        // 2) snapshot round-trip 通过 JSON
        let snapshot = b.to_snapshot();
        let _wire = serde_json::to_string(&snapshot).unwrap();
        // 3) 继续 apply 剩下事件
        for (i, e) in events.iter().enumerate().skip(split) {
            b.apply_event(e);
            b.event_seq = (i + 1) as u64;
        }

        let snap_a = a.to_snapshot();
        let snap_b = b.to_snapshot();

        assert_eq!(snap_a.event_seq, snap_b.event_seq);
        assert_eq!(snap_a.status, snap_b.status);
        assert_eq!(snap_a.external_id, snap_b.external_id);
        assert_eq!(snap_a.usage, snap_b.usage);

        // Full structural equivalence (with volatile fields stripped + tool
        // calls sorted by id). This is the load-bearing consistency check.
        assert_eq!(normalize_snapshot(&snap_a), normalize_snapshot(&snap_b));
    }

    // ---------- Phase 3c-3: snapshot fidelity ----------

    /// Helper: returns the kind discriminator + payload-id of each block in
    /// `live_message.content`, suitable for asserting block ordering.
    fn live_block_summary(s: &SessionState) -> Vec<(&'static str, String)> {
        s.live_message
            .as_ref()
            .map(|lm| {
                lm.content
                    .iter()
                    .map(|b| match b {
                        LiveContentBlock::Text { text, .. } => ("text", text.clone()),
                        LiveContentBlock::Thinking { text, .. } => ("thinking", text.clone()),
                        LiveContentBlock::ToolCallRef { tool_call_id } => {
                            ("tool_call_ref", tool_call_id.clone())
                        }
                        LiveContentBlock::Plan { entries } => {
                            ("plan", serde_json::to_string(entries).unwrap_or_default())
                        }
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn tool_call_event(id: &str, title: &str) -> AcpEvent {
        AcpEvent::ToolCall {
            tool_call_id: id.into(),
            title: title.into(),
            kind: "execute".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        }
    }

    #[test]
    fn tool_call_pushes_ref_block_at_current_position() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta {
            text: "before ".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&tool_call_event("tc-1", "ls"));
        s.apply_event(&AcpEvent::ContentDelta {
            text: "between".into(),
            parent_tool_use_id: None,
        });
        s.apply_event(&tool_call_event("tc-2", "pwd"));

        let summary = live_block_summary(&s);
        assert_eq!(
            summary,
            vec![
                ("text", "before ".to_string()),
                ("tool_call_ref", "tc-1".to_string()),
                ("text", "between".to_string()),
                ("tool_call_ref", "tc-2".to_string()),
            ],
            "tool-call refs must anchor at the position they arrived in the stream"
        );
    }

    #[test]
    fn tool_call_ref_push_is_idempotent() {
        let mut s = fresh_state();
        s.apply_event(&tool_call_event("tc-1", "ls"));
        // Defensive: second ToolCall with the same id (replay/unusual ordering)
        // must NOT push a duplicate ref block.
        s.apply_event(&tool_call_event("tc-1", "ls (retry)"));

        let summary = live_block_summary(&s);
        let ref_count = summary
            .iter()
            .filter(|(kind, id)| *kind == "tool_call_ref" && id == "tc-1")
            .count();
        assert_eq!(ref_count, 1, "duplicate ToolCall must not duplicate ref");
    }

    #[test]
    fn tool_call_update_does_not_duplicate_ref() {
        let mut s = fresh_state();
        s.apply_event(&tool_call_event("tc-1", "ls"));
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some("\"done\"".into()),
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });

        let summary = live_block_summary(&s);
        let ref_count = summary
            .iter()
            .filter(|(kind, id)| *kind == "tool_call_ref" && id == "tc-1")
            .count();
        assert_eq!(
            ref_count, 1,
            "ToolCall + ToolCallUpdate for same id yields exactly one ref"
        );
    }

    #[test]
    fn tool_call_state_carries_locations_and_meta() {
        let mut s = fresh_state();
        let locs = serde_json::json!([{ "path": "/tmp/foo.rs", "line": 12 }]);
        let meta = serde_json::json!({ "parent_tool_use_id": "abc", "session": "ext-1" });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "edit".into(),
            kind: "edit".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: Some(locs.clone()),
            meta: Some(meta.clone()),
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").expect("tc-1 inserted");
        assert_eq!(entry.locations.as_ref(), Some(&locs));
        assert_eq!(entry.meta.as_ref(), Some(&meta));

        // Snapshot round-trip preserves both.
        let snap = s.to_snapshot();
        let tc = snap
            .active_tool_calls
            .iter()
            .find(|t| t.id == "tc-1")
            .unwrap();
        assert_eq!(tc.locations.as_ref(), Some(&locs));
        assert_eq!(tc.meta.as_ref(), Some(&meta));
    }

    #[test]
    fn tool_call_update_preserves_locations_when_omitted() {
        let mut s = fresh_state();
        let locs = serde_json::json!([{ "path": "/tmp/foo.rs" }]);
        let meta = serde_json::json!({ "k": "v" });
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "edit".into(),
            kind: "edit".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: Some(locs.clone()),
            meta: Some(meta.clone()),
            images: None,
        });
        // Subsequent partial update without locations/meta — must not clobber.
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: Some("\"ok\"".into()),
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("tc-1").unwrap();
        assert_eq!(entry.status, ToolCallStatus::Completed);
        assert_eq!(
            entry.locations.as_ref(),
            Some(&locs),
            "ToolCallUpdate without locations must NOT clobber previously-set value"
        );
        assert_eq!(
            entry.meta.as_ref(),
            Some(&meta),
            "ToolCallUpdate without meta must NOT clobber previously-set value"
        );
    }

    #[test]
    fn tool_call_images_replace_or_preserve_on_update() {
        let mut s = fresh_state();
        let img_v1 = ToolCallImageInfo {
            data: "AAAA".into(),
            mime_type: "image/png".into(),
            uri: Some("/tmp/v1.png".into()),
        };
        let img_v2 = ToolCallImageInfo {
            data: "BBBB".into(),
            mime_type: "image/jpeg".into(),
            uri: None,
        };

        // Initial ToolCall carries one image — should be persisted.
        s.apply_event(&AcpEvent::ToolCall {
            tool_call_id: "ig-1".into(),
            title: "Image generation".into(),
            kind: "other".into(),
            status: "in_progress".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: Some(vec![img_v1.clone()]),
        });
        let entry = s.active_tool_calls.get("ig-1").unwrap();
        assert_eq!(entry.images.len(), 1);
        assert_eq!(entry.images[0].data, "AAAA");

        // Update without images field — must preserve prior images.
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "ig-1".into(),
            title: None,
            status: Some("in_progress".into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        });
        let entry = s.active_tool_calls.get("ig-1").unwrap();
        assert_eq!(
            entry.images.len(),
            1,
            "ToolCallUpdate with images=None must preserve prior images"
        );
        assert_eq!(entry.images[0].data, "AAAA");

        // Update with Some(new_vec) — must replace.
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "ig-1".into(),
            title: None,
            status: Some("completed".into()),
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: Some(vec![img_v2.clone()]),
        });
        let entry = s.active_tool_calls.get("ig-1").unwrap();
        assert_eq!(entry.images.len(), 1, "Some(vec) replaces prior images");
        assert_eq!(entry.images[0].data, "BBBB");
        assert_eq!(entry.images[0].mime_type, "image/jpeg");
        assert!(entry.images[0].uri.is_none());

        // Snapshot round-trip preserves images.
        let snap = s.to_snapshot();
        let tc = snap
            .active_tool_calls
            .iter()
            .find(|t| t.id == "ig-1")
            .unwrap();
        assert_eq!(tc.images.len(), 1);
        assert_eq!(tc.images[0].data, "BBBB");

        // Update with Some(empty) — must clear images (allows the agent to
        // explicitly drop a prior image if needed).
        s.apply_event(&AcpEvent::ToolCallUpdate {
            tool_call_id: "ig-1".into(),
            title: None,
            status: None,
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: Some(vec![]),
        });
        let entry = s.active_tool_calls.get("ig-1").unwrap();
        assert!(
            entry.images.is_empty(),
            "Some(empty vec) clears prior images"
        );
    }

    #[test]
    fn plan_update_appends_at_end_replacing_existing() {
        use crate::acp::types::PlanEntryInfo;
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "A".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::PlanUpdate {
            entries: vec![PlanEntryInfo {
                content: "step v1".into(),
                priority: "high".into(),
                status: "pending".into(),
            }],
        });
        s.apply_event(&AcpEvent::ContentDelta { text: "B".into(), parent_tool_use_id: None });
        s.apply_event(&AcpEvent::PlanUpdate {
            entries: vec![PlanEntryInfo {
                content: "step v2".into(),
                priority: "high".into(),
                status: "in_progress".into(),
            }],
        });

        let summary = live_block_summary(&s);
        // Expect: text("A"), text("B"), plan(v2). The old plan block is
        // removed and the fresh one is appended at end (after all current
        // text), matching the frontend reducer's replace-then-append.
        assert_eq!(summary.len(), 3, "summary was: {:?}", summary);
        assert_eq!(summary[0], ("text", "A".to_string()));
        assert_eq!(summary[1], ("text", "B".to_string()));
        assert_eq!(summary[2].0, "plan");
        assert!(
            summary[2].1.contains("step v2"),
            "plan block must be the v2 entries, not v1; got: {}",
            summary[2].1
        );
        assert!(
            !summary[2].1.contains("step v1"),
            "old plan block must be removed; got: {}",
            summary[2].1
        );
    }

    #[test]
    fn plan_update_creates_live_message_when_absent() {
        use crate::acp::types::PlanEntryInfo;
        let mut s = fresh_state();
        assert!(s.live_message.is_none());
        s.apply_event(&AcpEvent::PlanUpdate {
            entries: vec![PlanEntryInfo {
                content: "first step".into(),
                priority: "medium".into(),
                status: "pending".into(),
            }],
        });
        let live = s
            .live_message
            .as_ref()
            .expect("PlanUpdate must lazily create live_message");
        assert_eq!(live.content.len(), 1);
        match &live.content[0] {
            LiveContentBlock::Plan { entries } => {
                assert!(
                    entries.to_string().contains("first step"),
                    "plan must carry the entries payload; got: {}",
                    entries
                );
            }
            other => panic!("expected Plan block, got {:?}", other),
        }
    }

    #[test]
    fn turn_complete_clears_plan_and_tool_refs() {
        use crate::acp::types::PlanEntryInfo;
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::ContentDelta { text: "x".into(), parent_tool_use_id: None });
        s.apply_event(&tool_call_event("tc-1", "ls"));
        s.apply_event(&AcpEvent::PlanUpdate {
            entries: vec![PlanEntryInfo {
                content: "step".into(),
                priority: "low".into(),
                status: "pending".into(),
            }],
        });
        // Sanity precondition: live now has text, ref, plan.
        assert_eq!(live_block_summary(&s).len(), 3);
        assert_eq!(s.active_tool_calls.len(), 1);

        s.apply_event(&AcpEvent::TurnComplete {
            session_id: "ext".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        });
        // The existing `live_message = None` clear handles the new block kinds
        // automatically — they live inside live_message, not as siblings.
        assert!(s.live_message.is_none());
        assert!(s.active_tool_calls.is_empty());
    }

    /// 验证 envelope 序列化 + 反序列化 round-trip
    #[test]
    fn event_envelope_round_trips_through_json() {
        let env = EventEnvelope {
            seq: 7,
            connection_id: "conn-x".into(),
            payload: AcpEvent::ContentDelta { text: "abc".into(), parent_tool_use_id: None },
        };
        let json = serde_json::to_string(&env).unwrap();
        let back: EventEnvelope = serde_json::from_str(&json).unwrap();
        assert_eq!(back.seq, 7);
        assert_eq!(back.connection_id, "conn-x");
        match back.payload {
            AcpEvent::ContentDelta { text, .. } => assert_eq!(text, "abc"),
            _ => panic!("expected ContentDelta"),
        }
    }

    // --- live feedback: apply_event + snapshot --------------------------

    fn feedback_note(id: &str, text: &str) -> FeedbackItem {
        FeedbackItem::new_pending(id.into(), text.into(), Utc::now())
    }

    #[test]
    fn feedback_submitted_appends_idempotently() {
        let mut s = fresh_state();
        let item = feedback_note("f1", "use UserService");
        s.apply_event(&AcpEvent::FeedbackSubmitted { item: item.clone() });
        assert_eq!(s.feedback.len(), 1);
        // Replay / double-attach: a second apply with the same id is a no-op.
        s.apply_event(&AcpEvent::FeedbackSubmitted { item });
        assert_eq!(s.feedback.len(), 1, "duplicate id must not append twice");
        assert_eq!(s.feedback[0].status, FeedbackStatus::Pending);
        // A different id appends.
        s.apply_event(&AcpEvent::FeedbackSubmitted {
            item: feedback_note("f2", "skip the migration"),
        });
        assert_eq!(s.feedback.len(), 2);
    }

    #[test]
    fn feedback_consumed_marks_named_notes_delivered() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::FeedbackSubmitted {
            item: feedback_note("f1", "a"),
        });
        s.apply_event(&AcpEvent::FeedbackSubmitted {
            item: feedback_note("f2", "b"),
        });
        let at = Utc::now();
        s.apply_event(&AcpEvent::FeedbackConsumed {
            ids: vec!["f1".into()],
            delivered_at: at,
        });
        let f1 = s.feedback.iter().find(|f| f.id == "f1").unwrap();
        let f2 = s.feedback.iter().find(|f| f.id == "f2").unwrap();
        assert_eq!(f1.status, FeedbackStatus::Delivered);
        assert_eq!(f1.delivered_at, Some(at));
        assert_eq!(f2.status, FeedbackStatus::Pending, "unnamed note untouched");
        // Idempotent: re-applying the same consumption leaves f1 delivered and
        // does not flip its delivered_at to a new instant.
        s.apply_event(&AcpEvent::FeedbackConsumed {
            ids: vec!["f1".into()],
            delivered_at: Utc::now(),
        });
        let f1 = s.feedback.iter().find(|f| f.id == "f1").unwrap();
        assert_eq!(f1.delivered_at, Some(at), "delivered_at must not change");
    }

    #[test]
    fn user_message_clears_feedback_for_new_turn() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::FeedbackSubmitted {
            item: feedback_note("f1", "a"),
        });
        assert_eq!(s.feedback.len(), 1);
        // A new turn's user prompt resets the turn-scoped feedback set.
        s.apply_event(&text_user_message("user-1", "next prompt"));
        assert!(
            s.feedback.is_empty(),
            "feedback is turn-scoped; a new user_message clears it"
        );
    }

    #[test]
    fn snapshot_carries_feedback_and_omits_when_empty() {
        let mut s = fresh_state();
        s.apply_event(&AcpEvent::FeedbackSubmitted {
            item: feedback_note("f1", "snapshot me"),
        });
        let snap = s.to_snapshot();
        assert_eq!(snap.feedback.len(), 1);
        assert_eq!(snap.feedback[0].id, "f1");
        // Round-trips through the wire shape the web client hydrates from.
        let json = serde_json::to_string(&snap).unwrap();
        let back: LiveSessionSnapshot = serde_json::from_str(&json).unwrap();
        assert_eq!(back.feedback.len(), 1);
        // The empty case keeps the NOTES array off the wire (the always-present
        // `feedback_tool_available` bool is a separate field).
        let empty = serde_json::to_string(&fresh_state().to_snapshot()).unwrap();
        assert!(
            !empty.contains("\"feedback\":"),
            "no-feedback snapshot must omit the notes array"
        );
    }
}
