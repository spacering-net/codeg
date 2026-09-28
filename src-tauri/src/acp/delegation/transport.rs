//! Wire format for `codeg-mcp` companion ↔ main process round-trip over UDS
//! (Unix) or named pipe (Windows).
//!
//! The frame is dead simple: a little-endian `u32` byte length followed by
//! that many bytes of UTF-8 JSON. One request, one response — the companion
//! reopens the socket per `tools/call`. This trades a few extra connects for
//! a wire that's trivial to test and that doesn't need multiplexing
//! (a parent makes at most one delegation call at a time from the LLM's
//! perspective — the broker handles concurrency at a higher level).
//!
//! Why length-prefix instead of newline-delimited JSON? The LLM-issued
//! `task` arguments can contain newlines, and we'd rather avoid escaping
//! them into a single line. JSON-RPC over stdio uses newlines because
//! Content-Length headers add complexity; for an internal UDS we can do
//! better.
//!
//! ### Message shapes
//!
//! Inbound traffic is a tagged [`BrokerMessage`] enum, one variant per MCP
//! tool plus the MCP cancel notification:
//!   * `call` — [`BrokerRequest`] for `delegate_to_agent`; returns a
//!     [`BrokerResponse`] wrapping a `DelegationTaskReport` (a `Running` ack, or
//!     a terminal report).
//!   * `status` — [`BrokerStatusRequest`] for `get_delegation_status`. Carries a
//!     `task_ids` list (one or many) and an optional `wait_ms` long-poll —
//!     omitted is an immediate snapshot, an explicit `0` blocks until a task is
//!     terminal, a positive value is a bounded wait. Returns a `{ "tasks": [..] }`
//!     envelope with one task report per requested id (in request order); a
//!     batch wait wakes as soon as ANY requested task reaches a terminal state.
//!   * `cancel_task` — [`BrokerCancelTaskRequest`] for `cancel_delegation`;
//!     returns a task report.
//!   * `resume_task` — [`BrokerResumeTaskRequest`] for `resume_delegation`;
//!     returns a task report (a `Running` ack under the unchanged task id, or
//!     a refusal).
//!   * `cancel` — fire-and-forget [`BrokerCancelRequest`] from MCP
//!     `notifications/cancelled`, targeting an in-flight `delegate_to_agent`
//!     or `resume_delegation` call by `external_handle`; gets a `Value::Null`
//!     ack.
//!
//! All arms are authenticated by the same per-launch `token`.
//!
//! ### Version coupling
//!
//! The companion (`codeg-mcp`) and the listener (inside the codeg main
//! process) ship in the SAME release artifact — the Tauri bundle, the
//! server Docker image, and the standalone binary tree all install both
//! binaries at the same path. The MCP config pointing the agent CLI at
//! `codeg-mcp` uses an absolute path that is replaced atomically by the
//! upgrade, so an old-version companion talking to a new-version listener
//! is not a supported configuration. As a consequence this protocol does
//! NOT carry a version field and the tagged-enum cutover from the older
//! plain-`BrokerRequest` frame is deliberately non-backward-compatible —
//! a stale companion would fail to decode and surface as a JSON-RPC
//! error to the LLM, which is preferable to silent misbehavior.

use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::acp::chat_authoring::{NewAutomationSpec, NewWorkTaskSpec};
use crate::acp::question::QuestionSpec;

/// One delegation call's worth of input forwarded from the companion to the
/// main process. The main process re-validates `token` and maps
/// `parent_connection_id` to the live ACP connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerRequest {
    /// Shared secret minted by the main process when it spawned the agent CLI;
    /// the agent passes it through to the companion via `--token`. Rejects
    /// anything else.
    pub token: String,
    /// codeg-internal ACP connection UUID for the parent session.
    pub parent_connection_id: String,
    /// The MCP `tool_use_id` for the LLM-issued `delegate_to_agent` call.
    /// Used to bind the eventual child outcome back to the parent's
    /// tool_use_id in the UI / DB.
    pub parent_tool_use_id: String,
    /// Opaque companion-minted token (one per `tools/call`). The broker
    /// keys its `cancel_by_external_handle` lookup off this value so an
    /// MCP-side `notifications/cancelled` can target this specific call.
    /// Older companions / tests can omit it; missing handles disable the
    /// cancel path for that call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
    /// Raw `arguments` JSON from the MCP `tools/call` request, schema-shaped
    /// per [`super::tool_schema_json`]. The main process re-parses into
    /// [`super::types::DelegationRequest`].
    pub input: Value,
}

/// Cancel an in-flight delegation by its companion-minted
/// `external_handle`. Sent fire-and-forget — the listener acknowledges by
/// writing an empty [`BrokerResponse`] so the companion can detect a
/// broken socket, but the response body carries no information.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerCancelRequest {
    pub token: String,
    pub external_handle: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Query the status (and, optionally, block briefly for the result) of one or
/// more previously-issued delegation tasks by their broker `task_id`s. Backs the
/// `get_delegation_status` MCP tool. Authenticated by the same per-launch
/// `token`; the listener scopes each lookup to the token's parent connection
/// so one parent can't read another's tasks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerStatusRequest {
    pub token: String,
    /// One or many task ids to resolve. The companion forwards the MCP
    /// `task_ids` array into this list (trimmed, de-duplicated, order-preserving).
    /// The listener returns one report per id, in this order.
    pub task_ids: Vec<String>,
    /// How long the listener may block waiting for a task to reach a terminal
    /// state before returning the current (possibly still-running) snapshot.
    /// `None` (omitted) returns an immediate snapshot; an explicit `0` blocks
    /// with no timeout until a task finishes (long-running children); any
    /// positive value is a long-poll the listener clamps to a hard ceiling so a
    /// single bounded call can't hang unbounded. For a batch the wait resolves as
    /// soon as ANY requested task reaches a terminal state.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait_ms: Option<u64>,
}

/// Cancel a previously-issued delegation task by its broker `task_id`. Backs
/// the `cancel_delegation` MCP tool. Distinct from [`BrokerCancelRequest`],
/// which targets an in-flight `tools/call` by its companion-minted
/// `external_handle` for MCP `notifications/cancelled`; this targets a running
/// task the LLM is explicitly stopping by id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerCancelTaskRequest {
    pub token: String,
    pub task_id: String,
}

/// Resume a previously-canceled / interrupted delegation task by its broker
/// `task_id`. Backs the `resume_delegation` MCP tool. Carries NO task text —
/// the tool continues the ORIGINAL task in the child's resumed session; the
/// optional `reason` is bounded interruption context, never new instructions.
/// `external_handle` mirrors [`BrokerRequest::external_handle`]: a
/// `notifications/cancelled` during resume setup must tear the re-spawned
/// child back down.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerResumeTaskRequest {
    pub token: String,
    pub task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_handle: Option<String>,
}

/// Pull the pending live-feedback notes for the parent session. Backs the
/// `check_user_feedback` MCP tool. Authenticated by the same per-launch
/// `token`; the listener resolves the parent connection from it and scopes the
/// drain to that connection so one parent can't read another's feedback.
/// Always returns an immediate snapshot — no blocking wait.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerFeedbackRequest {
    pub token: String,
}

/// Confirm delivery of feedback notes, marking them `Delivered`. Sent by the
/// companion AFTER its `check_user_feedback` round-trip wins (i.e. it is
/// returning the result to the agent), NOT by the listener at UDS-write time —
/// so a per-request cancel that suppresses the agent-facing response (the agent
/// staying alive) leaves the notes pending for the next check (at-least-once).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerCommitFeedbackRequest {
    pub token: String,
    pub ids: Vec<String>,
}

/// Ask the user one or more multiple-choice questions and BLOCK until they
/// answer. Backs the `ask_user_question` MCP tool. Authenticated by the same
/// per-launch `token`; the listener resolves the parent connection from it,
/// registers the questions (broadcasting the card to every attached client),
/// and parks the response until the user answers (or the tool call is canceled,
/// detected via peer-close on this connection). The companion has already
/// validated the schema, so `questions` is well-formed and carries stable ids.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerAskRequest {
    pub token: String,
    pub questions: Vec<QuestionSpec>,
}

/// Resolve a session the user referenced (`codeg://session/<id>`) into its
/// metadata + stats, optionally with its recent messages. Backs the
/// `get_session_info` MCP tool. Authenticated by the same per-launch `token`; the
/// lookup is by codeg's internal conversation id (the number in the reference),
/// so — unlike the delegation arms — it is NOT scoped to the parent connection
/// (any non-deleted session the user references can be read).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerSessionRequest {
    pub token: String,
    /// codeg's internal conversation PK (the number in `codeg://session/<id>`).
    pub session_id: i32,
    /// How many of the most recent turns to include as compacted text. `None` /
    /// `0` → metadata only (no transcript parse); a positive value is clamped to
    /// [`crate::acp::session_info::MAX_SESSION_MESSAGES`] by the resolver.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_messages: Option<u32>,
}

/// Report a progress milestone for the work task driving the parent session.
/// Backs the `task_progress` MCP tool. Authenticated by the per-launch `token`;
/// the listener resolves the parent connection from it and the task engine maps
/// that to the owning task + execution generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerTaskProgressRequest {
    pub token: String,
    pub message: String,
}

/// Report the final verdict (+ optional summary) for the work task driving the
/// parent session. Backs the `task_complete` MCP tool; the verdict decides how
/// the task settles when the turn ends.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerTaskCompleteRequest {
    pub token: String,
    pub verdict: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// Create an automation (scheduled or manual) from the chat the caller is in.
/// Backs the `create_automation` MCP tool. Authenticated by the per-launch
/// `token`; the listener resolves the caller's conversation + working directory
/// from it so the target folder can default to the caller's own project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerCreateAutomationRequest {
    pub token: String,
    pub spec: NewAutomationSpec,
}

/// Queue a task on the work-task board from the chat the caller is in. Backs the
/// `create_work_task` MCP tool; same token scoping as the automation arm.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerCreateWorkTaskRequest {
    pub token: String,
    pub spec: NewWorkTaskSpec,
}

/// List the built-in browser's tabs as an agent may see them. Backs the
/// `browser_list_tabs` MCP tool. Authenticated by the per-launch `token`, and
/// — like [`BrokerSessionRequest`] and for the same single-tenant reason — not
/// scoped to the caller's parent connection: a browser tab belongs to the user,
/// not to a conversation, and the backend is not told which folder one was
/// opened in. What any given agent may *read* of a tab is the per-tab grant,
/// which is a decision the person makes tab by tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserTabsRequest {
    pub token: String,
}

/// Read one shared page. Backs the `browser_snapshot` MCP tool; the grant check
/// and the audit line both happen behind it, in `agent_snapshot_core`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserSnapshotRequest {
    pub token: String,
    pub tab_id: String,
    /// Cap on the rendered tree, in characters. `None` →
    /// [`crate::acp::browser_tools::DEFAULT_SNAPSHOT_MAX_CHARS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<usize>,
}

/// Act on one shared page. Backs the five action tools (`browser_click`,
/// `browser_hover`, `browser_type`, `browser_press_key`,
/// `browser_select_option`), which differ only in the action they carry; the
/// `control` check, the ref check and the audit line all happen behind it, in
/// `agent_act_core`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserActRequest {
    pub token: String,
    pub tab_id: String,
    pub request: crate::browser::agent::ActionRequest,
}

/// What one shared page printed to its console. Backs the
/// `browser_console_messages` MCP tool; the grant check and the audit line
/// happen behind it, in `agent_console_core`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserConsoleRequest {
    pub token: String,
    pub tab_id: String,
    #[serde(default)]
    pub query: crate::browser::console::ConsoleQuery,
}

/// A screenshot of one shared page. Backs the `browser_screenshot` MCP tool;
/// the grant check, the ref check for a crop and the audit line happen
/// behind it, in `agent_capture_core`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserCaptureRequest {
    pub token: String,
    pub tab_id: String,
    #[serde(default)]
    pub request: crate::browser::capture::CaptureRequest,
}

/// Run the caller's own code on one shared page. Backs the `browser_eval` MCP
/// tool; its own switch, the `control` check, the per-snippet confirmation and
/// the audit line all happen behind it, in `agent_eval_core`.
///
/// The only browser round trip that waits on a person, so it can be in flight
/// for as long as someone takes to read a screen of code — up to
/// `browser::confirm::EVAL_CONFIRM_TIMEOUT`, which is what stops it waiting
/// for one who never comes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserEvalRequest {
    pub token: String,
    pub tab_id: String,
    pub request: crate::browser::eval::EvalRequest,
}

/// Open a tab, point one somewhere else, or close one. Backs
/// `browser_open_tab` / `browser_navigate` / `browser_close_tab` — one
/// variant for the three the way one `BrowserAct` backs the five action
/// tools, because they share a gate, an answer shape and a renderer.
///
/// Waits for the page to settle, so this round trip is as long as a page
/// load (`browser::open_request::SETTLE_TIMEOUT`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerBrowserTabOpRequest {
    pub token: String,
    #[serde(flatten)]
    pub op: crate::acp::browser_tools::BrowserTabOp,
}

/// Tagged top-level message dispatched by the listener. Adding new variants
/// is the wire-stable way to grow the broker protocol without touching the
/// frame layer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BrokerMessage {
    Call(BrokerRequest),
    Cancel(BrokerCancelRequest),
    Status(BrokerStatusRequest),
    CancelTask(BrokerCancelTaskRequest),
    ResumeTask(BrokerResumeTaskRequest),
    Feedback(BrokerFeedbackRequest),
    CommitFeedback(BrokerCommitFeedbackRequest),
    Ask(BrokerAskRequest),
    SessionInfo(BrokerSessionRequest),
    TaskProgress(BrokerTaskProgressRequest),
    TaskComplete(BrokerTaskCompleteRequest),
    CreateAutomation(BrokerCreateAutomationRequest),
    CreateWorkTask(BrokerCreateWorkTaskRequest),
    BrowserTabs(BrokerBrowserTabsRequest),
    BrowserSnapshot(BrokerBrowserSnapshotRequest),
    BrowserAct(BrokerBrowserActRequest),
    BrowserConsole(BrokerBrowserConsoleRequest),
    BrowserCapture(BrokerBrowserCaptureRequest),
    BrowserEval(BrokerBrowserEvalRequest),
    BrowserTabOp(BrokerBrowserTabOpRequest),
    /// Liveness probe. Unlike every other variant this one is NOT sent by a
    /// companion — it comes from codeg's own service-status check
    /// (`acp::delegation::service`), which is why it carries no `token`: a
    /// `{"ok": true}` answer reveals nothing beyond "the socket is being
    /// served", which the connect itself already proved. Answering it end to
    /// end (accept → decode → dispatch → encode → write) is the point: it
    /// distinguishes a live accept loop from a stale socket file left behind
    /// by a dead one, which a bare `connect()` cannot.
    Ping,
}

/// The wrapped outcome the main process returns over the same socket.
/// `outcome` is a serialized [`super::types::DelegationTaskReport`] for `Call`
/// / `CancelTask` messages, a `{ "tasks": [report, ...] }` envelope (one report
/// per requested id, in request order) for `Status`, and `Value::Null` for
/// `Cancel` acknowledgements.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerResponse {
    pub outcome: Value,
}

/// Maximum allowed frame size, 16 MiB. Guards against a misbehaving peer
/// allocating gigabytes when reading the length prefix.
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

/// Write one length-prefixed JSON frame.
pub async fn write_frame<W, T>(stream: &mut W, value: &T) -> io::Result<()>
where
    W: AsyncWriteExt + Unpin,
    T: Serialize,
{
    let bytes = serde_json::to_vec(value)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("encode: {e}")))?;
    let len: u32 = bytes
        .len()
        .try_into()
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame > u32::MAX"))?;
    stream.write_all(&len.to_le_bytes()).await?;
    stream.write_all(&bytes).await?;
    stream.flush().await?;
    Ok(())
}

/// Read one length-prefixed JSON frame. Rejects frames larger than
/// [`MAX_FRAME_BYTES`].
pub async fn read_frame<R, T>(stream: &mut R) -> io::Result<T>
where
    R: AsyncReadExt + Unpin,
    T: for<'de> Deserialize<'de>,
{
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).await?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("frame {len} bytes exceeds cap {MAX_FRAME_BYTES}"),
        ));
    }
    let mut body = vec![0u8; len];
    stream.read_exact(&mut body).await?;
    serde_json::from_slice(&body)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("decode: {e}")))
}

/// One-shot client round-trip: connect, write one [`BrokerMessage`], read the
/// response, drop the connection. The three public helpers below differ only
/// in which message they build, so the connect/write/read is shared here.
#[cfg(unix)]
async fn message_round_trip(socket_path: &str, msg: &BrokerMessage) -> io::Result<BrokerResponse> {
    use tokio::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path).await?;
    write_frame(&mut stream, msg).await?;
    read_frame(&mut stream).await
}

/// Windows path uses named pipes; the address format is `\\.\pipe\<name>`.
#[cfg(windows)]
async fn message_round_trip(socket_path: &str, msg: &BrokerMessage) -> io::Result<BrokerResponse> {
    let mut stream = open_named_pipe_with_retry(socket_path)
        .await
        .map_err(|e| io::Error::other(format!("open pipe: {e}")))?;
    write_frame(&mut stream, msg).await?;
    read_frame(&mut stream).await
}

/// Dispatch a `delegate_to_agent` call and read back the broker's
/// [`super::types::DelegationTaskReport`] (a `Running` ack, or a terminal
/// report when the child finished during setup / setup failed).
pub async fn client_round_trip(
    socket_path: &str,
    req: &BrokerRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::Call(req.clone())).await
}

/// Dispatch a `get_delegation_status` query and read back the
/// `{ "tasks": [report, ...] }` envelope (one report per requested id, in
/// request order).
pub async fn client_status_round_trip(
    socket_path: &str,
    req: &BrokerStatusRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::Status(req.clone())).await
}

/// Dispatch a `cancel_delegation` request and read back the task report.
pub async fn client_cancel_task_round_trip(
    socket_path: &str,
    req: &BrokerCancelTaskRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::CancelTask(req.clone())).await
}

/// Dispatch a `resume_delegation` request and read back the task report (a
/// `Running` ack when the resume took, or a refusal / setup-failure report).
pub async fn client_resume_task_round_trip(
    socket_path: &str,
    req: &BrokerResumeTaskRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::ResumeTask(req.clone())).await
}

/// Dispatch a `check_user_feedback` query and read back the
/// `{ "feedback": [..], "count": N }` envelope (the pending notes drained for
/// the parent session, possibly empty).
pub async fn client_feedback_round_trip(
    socket_path: &str,
    req: &BrokerFeedbackRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::Feedback(req.clone())).await
}

/// Confirm delivery of feedback notes (fire-and-forget). Reads the empty ack so
/// the listener can flush before the socket drops; the body carries nothing.
pub async fn client_commit_feedback(
    socket_path: &str,
    req: &BrokerCommitFeedbackRequest,
) -> io::Result<()> {
    let _ = message_round_trip(socket_path, &BrokerMessage::CommitFeedback(req.clone())).await?;
    Ok(())
}

/// Dispatch an `ask_user_question` request and BLOCK reading the response until
/// the user answers (or the question is canceled). The listener holds this
/// connection open for the whole wait — there is no `wait_ms`, the block is
/// inherent (waiting on a human). If the tool call is canceled, the companion
/// drops this future, closing the socket; the listener observes the peer-close
/// and tears the pending question down. Returns a `{ answers, declined }`
/// envelope.
pub async fn client_ask_round_trip(
    socket_path: &str,
    req: &BrokerAskRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::Ask(req.clone())).await
}

/// Dispatch a `get_session_info` request and read back the serialized
/// [`crate::acp::session_info::SessionInfo`] envelope (metadata + stats, and the
/// recent messages when `max_messages > 0`).
pub async fn client_session_round_trip(
    socket_path: &str,
    req: &BrokerSessionRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::SessionInfo(req.clone())).await
}

/// Dispatch a `task_progress` report and read back the `{ recorded }` ack.
pub async fn client_task_progress_round_trip(
    socket_path: &str,
    req: &BrokerTaskProgressRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::TaskProgress(req.clone())).await
}

/// Dispatch a `task_complete` report and read back the `{ recorded }` ack.
pub async fn client_task_complete_round_trip(
    socket_path: &str,
    req: &BrokerTaskCompleteRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::TaskComplete(req.clone())).await
}

/// Dispatch a `create_automation` request and read back the serialized
/// [`crate::acp::chat_authoring::AuthoringOutcome`].
pub async fn client_create_automation_round_trip(
    socket_path: &str,
    req: &BrokerCreateAutomationRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::CreateAutomation(req.clone())).await
}

/// Dispatch a `create_work_task` request and read back the serialized
/// [`crate::acp::chat_authoring::AuthoringOutcome`].
pub async fn client_create_work_task_round_trip(
    socket_path: &str,
    req: &BrokerCreateWorkTaskRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::CreateWorkTask(req.clone())).await
}

/// Dispatch a `browser_list_tabs` request and read back the serialized
/// [`crate::acp::browser_tools::BrowserTabsOutcome`].
pub async fn client_browser_tabs_round_trip(
    socket_path: &str,
    req: &BrokerBrowserTabsRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserTabs(req.clone())).await
}

/// Dispatch a `browser_snapshot` request and read back the serialized
/// [`crate::acp::browser_tools::BrowserSnapshotOutcome`].
pub async fn client_browser_snapshot_round_trip(
    socket_path: &str,
    req: &BrokerBrowserSnapshotRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserSnapshot(req.clone())).await
}

/// Dispatch an action request and read back the serialized
/// [`crate::acp::browser_tools::BrowserActOutcome`].
pub async fn client_browser_act_round_trip(
    socket_path: &str,
    req: &BrokerBrowserActRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserAct(req.clone())).await
}

/// Dispatch a `browser_console_messages` request and read back the serialized
/// [`crate::acp::browser_tools::BrowserConsoleOutcome`].
pub async fn client_browser_console_round_trip(
    socket_path: &str,
    req: &BrokerBrowserConsoleRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserConsole(req.clone())).await
}

/// Dispatch a `browser_screenshot` request and read back the serialized
/// [`crate::acp::browser_tools::BrowserCaptureOutcome`].
pub async fn client_browser_capture_round_trip(
    socket_path: &str,
    req: &BrokerBrowserCaptureRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserCapture(req.clone())).await
}

/// Dispatch a `browser_eval` request and read back the serialized
/// [`crate::acp::browser_tools::BrowserEvalOutcome`].
pub async fn client_browser_eval_round_trip(
    socket_path: &str,
    req: &BrokerBrowserEvalRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserEval(req.clone())).await
}

/// Dispatch one of the three tab-lifecycle requests and read back the
/// serialized [`crate::acp::browser_tools::BrowserTabOutcome`].
pub async fn client_browser_tab_op_round_trip(
    socket_path: &str,
    req: &BrokerBrowserTabOpRequest,
) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::BrowserTabOp(req.clone())).await
}

/// Probe the listener: write a [`BrokerMessage::Ping`] and read the
/// `{"ok": true}` answer back. Used by the codeg-mcp service-status indicator
/// to tell "listening" from "socket file exists but nobody is accepting".
/// Callers should wrap this in their own timeout — a socket whose peer accepts
/// but never answers would otherwise park here.
pub async fn client_ping(socket_path: &str) -> io::Result<BrokerResponse> {
    message_round_trip(socket_path, &BrokerMessage::Ping).await
}

/// Total budget for `open()` retries on Windows named pipes. Has to be
/// short enough that it nests comfortably inside the companion's
/// `BROKER_CANCEL_BUDGET` (500 ms) — leaving ≥ 300 ms for the actual
/// write/read after the open lands.
#[cfg(windows)]
const PIPE_OPEN_RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(200);

#[cfg(windows)]
const PIPE_OPEN_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

/// Windows-only: `ClientOptions::open()` can fail with
/// `ERROR_PIPE_BUSY` (231) or `NotFound` during the brief window between
/// the listener accepting one connection and binding the next instance
/// (see `DelegationListener::run` on Windows). The companion has already
/// removed the inflight entry by the time it dispatches a cancel, so
/// dropping the cancel on a transient open failure would silently lose
/// it. Retry with small backoff inside a tight budget. Non-busy errors
/// (e.g. listener not running at all) propagate immediately.
#[cfg(windows)]
async fn open_named_pipe_with_retry(
    socket_path: &str,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    let attempt = async {
        loop {
            match ClientOptions::new().open(socket_path) {
                Ok(client) => return Ok::<_, io::Error>(client),
                Err(e) => {
                    let busy = e.raw_os_error() == Some(231);
                    let not_found = e.kind() == io::ErrorKind::NotFound;
                    if !(busy || not_found) {
                        return Err(e);
                    }
                    tokio::time::sleep(PIPE_OPEN_RETRY_DELAY).await;
                }
            }
        }
    };
    match tokio::time::timeout(PIPE_OPEN_RETRY_BUDGET, attempt).await {
        Ok(inner) => inner,
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "named pipe open: retry budget exhausted",
        )),
    }
}

/// Fire-and-forget cancel: open a fresh socket, write a
/// `BrokerMessage::Cancel`, read the (always-empty) ack so the listener gets
/// a chance to flush its side before we drop, then close. Errors are
/// returned but generally treated as "best effort" by callers — a cancel
/// race that loses to a completed response is fine, the companion will
/// suppress the response per MCP spec either way.
#[cfg(unix)]
pub async fn client_cancel(socket_path: &str, req: &BrokerCancelRequest) -> io::Result<()> {
    use tokio::net::UnixStream;
    let mut stream = UnixStream::connect(socket_path).await?;
    let msg = BrokerMessage::Cancel(req.clone());
    write_frame(&mut stream, &msg).await?;
    // The listener writes an empty BrokerResponse so we can detect a broken
    // pipe; we don't care what's inside.
    let _: io::Result<BrokerResponse> = read_frame(&mut stream).await;
    Ok(())
}

#[cfg(windows)]
pub async fn client_cancel(socket_path: &str, req: &BrokerCancelRequest) -> io::Result<()> {
    let mut stream = open_named_pipe_with_retry(socket_path)
        .await
        .map_err(|e| io::Error::other(format!("open pipe: {e}")))?;
    let msg = BrokerMessage::Cancel(req.clone());
    write_frame(&mut stream, &msg).await?;
    let _: io::Result<BrokerResponse> = read_frame(&mut stream).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::duplex;

    #[tokio::test]
    async fn frame_round_trip_in_memory() {
        let (mut a, mut b) = duplex(8 * 1024);
        let msg = BrokerMessage::Call(BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: "pt1".into(),
            external_handle: Some("h1".into()),
            input: json!({"agent_type": "codex", "task": "hi"}),
        });
        write_frame(&mut a, &msg).await.unwrap();
        let got: BrokerMessage = read_frame(&mut b).await.unwrap();
        match got {
            BrokerMessage::Call(req) => {
                assert_eq!(req.token, "tok");
                assert_eq!(req.input["agent_type"], "codex");
                assert_eq!(req.external_handle.as_deref(), Some("h1"));
            }
            other => panic!("expected Call variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn session_message_round_trip_in_memory() {
        let (mut a, mut b) = duplex(8 * 1024);
        let msg = BrokerMessage::SessionInfo(BrokerSessionRequest {
            token: "tok".into(),
            session_id: 42,
            max_messages: Some(20),
        });
        write_frame(&mut a, &msg).await.unwrap();
        let got: BrokerMessage = read_frame(&mut b).await.unwrap();
        match got {
            BrokerMessage::SessionInfo(req) => {
                assert_eq!(req.token, "tok");
                assert_eq!(req.session_id, 42);
                assert_eq!(req.max_messages, Some(20));
            }
            other => panic!("expected SessionInfo variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn resume_task_message_round_trip_in_memory() {
        let (mut a, mut b) = duplex(8 * 1024);
        let msg = BrokerMessage::ResumeTask(BrokerResumeTaskRequest {
            token: "tok".into(),
            task_id: "task-1".into(),
            reason: Some("app crashed".into()),
            external_handle: Some("h1".into()),
        });
        write_frame(&mut a, &msg).await.unwrap();
        let got: BrokerMessage = read_frame(&mut b).await.unwrap();
        match got {
            BrokerMessage::ResumeTask(req) => {
                assert_eq!(req.token, "tok");
                assert_eq!(req.task_id, "task-1");
                assert_eq!(req.reason.as_deref(), Some("app crashed"));
                assert_eq!(req.external_handle.as_deref(), Some("h1"));
            }
            other => panic!("expected ResumeTask variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn cancel_message_round_trip_in_memory() {
        let (mut a, mut b) = duplex(8 * 1024);
        let msg = BrokerMessage::Cancel(BrokerCancelRequest {
            token: "tok".into(),
            external_handle: "h1".into(),
            reason: Some("user requested".into()),
        });
        write_frame(&mut a, &msg).await.unwrap();
        let got: BrokerMessage = read_frame(&mut b).await.unwrap();
        match got {
            BrokerMessage::Cancel(req) => {
                assert_eq!(req.token, "tok");
                assert_eq!(req.external_handle, "h1");
                assert_eq!(req.reason.as_deref(), Some("user requested"));
            }
            other => panic!("expected Cancel variant, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn rejects_oversized_frame() {
        let (mut a, mut b) = duplex(8);
        // Write a length prefix larger than the cap, no body.
        let bad_len: u32 = (MAX_FRAME_BYTES as u32) + 1;
        a.write_all(&bad_len.to_le_bytes()).await.unwrap();
        a.flush().await.unwrap();
        let result: io::Result<BrokerMessage> = read_frame(&mut b).await;
        let err = result.expect_err("expected oversized frame to be rejected");
        assert_eq!(err.kind(), io::ErrorKind::InvalidData);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn named_pipe_round_trip() {
        use tokio::net::windows::named_pipe::ServerOptions;

        // PID + nanosecond suffix keeps the pipe name unique across parallel
        // tests and avoids collisions with a live listener on the same box.
        let pipe_name = format!(
            r"\\.\pipe\codeg-mcp-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&pipe_name)
            .unwrap();

        let server_pipe = pipe_name.clone();
        let server_task = tokio::spawn(async move {
            let mut conn = server;
            conn.connect().await.unwrap();
            let msg: BrokerMessage = read_frame(&mut conn).await.unwrap();
            match msg {
                BrokerMessage::Call(req) => assert_eq!(req.token, "tok"),
                other => panic!("expected Call, got {other:?}"),
            }
            let resp = BrokerResponse {
                outcome: json!({"kind": "ok", "text": "hello"}),
            };
            write_frame(&mut conn, &resp).await.unwrap();
            // Silence "unused" — server name is captured for clarity.
            let _ = server_pipe;
        });

        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: "pt1".into(),
            external_handle: None,
            input: json!({"agent_type": "codex", "task": "do x"}),
        };
        let resp = client_round_trip(&pipe_name, &req).await.unwrap();
        assert_eq!(resp.outcome["kind"], "ok");
        assert_eq!(resp.outcome["text"], "hello");
        server_task.await.unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn uds_round_trip() {
        use tokio::net::UnixListener;

        // `/tmp`, not `$TMPDIR`: a socket path has ~104 bytes of `sun_path` to
        // live in, and codeg exports a 72-byte per-session `TMPDIR` to the
        // agents it launches. Under `tempdir()` this lands at 99 bytes there —
        // green, but one directory level from an unexplainable red.
        let dir = tempfile::tempdir_in("/tmp").unwrap();
        let path = dir.path().join("codeg-mcp.sock");
        let listener = UnixListener::bind(&path).unwrap();
        let server_path = path.to_string_lossy().to_string();

        let server = tokio::spawn(async move {
            let (mut conn, _) = listener.accept().await.unwrap();
            let msg: BrokerMessage = read_frame(&mut conn).await.unwrap();
            match msg {
                BrokerMessage::Call(req) => assert_eq!(req.token, "tok"),
                other => panic!("expected Call, got {other:?}"),
            }
            let resp = BrokerResponse {
                outcome: json!({"kind": "ok", "text": "hello"}),
            };
            write_frame(&mut conn, &resp).await.unwrap();
        });

        let req = BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "p1".into(),
            parent_tool_use_id: "pt1".into(),
            external_handle: None,
            input: json!({"agent_type": "codex", "task": "do x"}),
        };
        let resp = client_round_trip(&server_path, &req).await.unwrap();
        assert_eq!(resp.outcome["kind"], "ok");
        assert_eq!(resp.outcome["text"], "hello");
        server.await.unwrap();
    }
}
