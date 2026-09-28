//! Main-process side of the `codeg-mcp` round-trip: accept UDS / named-pipe
//! connections from companion processes, validate the per-launch token,
//! resolve the parent's current conversation, and hand off to the broker.
//!
//! The listener is intentionally tiny — most of the work (depth checking,
//! spawn lifecycle, timeout, cancellation) happens inside
//! [`DelegationBroker`]. The listener is the boundary between the wire and
//! the broker, plus the place where the per-launch token policy is enforced.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::RwLock;

use crate::acp::delegation::broker::{DelegationBroker, StatusWait};
use crate::acp::browser_tools::{
    BrowserActOutcome, BrowserCaptureOutcome, BrowserConsoleOutcome, BrowserEvalOutcome,
    BrowserSnapshotOutcome, BrowserTabOutcome, BrowserTabsOutcome, BrowserToolAccess,
    ERROR_NO_SUCH_TAB,
};
use crate::acp::delegation::transport::{
    read_frame, write_frame, BrokerAskRequest, BrokerBrowserActRequest,
    BrokerBrowserCaptureRequest, BrokerBrowserConsoleRequest, BrokerBrowserEvalRequest,
    BrokerBrowserSnapshotRequest, BrokerBrowserTabOpRequest, BrokerBrowserTabsRequest,
    BrokerCancelRequest, BrokerCancelTaskRequest,
    BrokerCommitFeedbackRequest, BrokerFeedbackRequest, BrokerMessage, BrokerRequest,
    BrokerCreateAutomationRequest, BrokerCreateWorkTaskRequest, BrokerResponse,
    BrokerResumeTaskRequest, BrokerSessionRequest, BrokerStatusRequest,
    BrokerTaskCompleteRequest, BrokerTaskProgressRequest,
};
use crate::acp::delegation::types::{
    DelegationRequest, DelegationTaskReport, ResumeDelegationRequest, TaskStatus,
};
use crate::acp::feedback::{PendingFeedback, SessionFeedbackAccess};
use crate::acp::question::{QuestionOutcome, SessionQuestionAccess};
#[cfg(unix)]
use crate::acp::scratch_dir::SUN_PATH_CAP;
use crate::acp::chat_authoring::{AuthoringContext, AuthoringOutcome, ChatAuthoringAccess};
use crate::acp::session_info::{SessionInfo, SessionInfoAccess};
use crate::acp::work_task_tools::{TaskReportAck, WorkTaskToolAccess};
use crate::models::AgentType;
use serde_json::Value;

/// Hard ceiling on a *positive* `get_delegation_status` long-poll, so a single
/// MCP tool call can't block the companion's round-trip unbounded. The child
/// keeps running past this; the LLM simply re-issues the wait. An explicit
/// `wait_ms = 0` opts out of the ceiling and blocks until the task is terminal.
const STATUS_WAIT_MAX_MS: u64 = 60_000;


/// The bound-but-not-yet-served socket handed from [`DelegationListener::bind`]
/// to [`DelegationListener::accept_loop`]. A UDS listener on unix; on Windows,
/// the first named-pipe server instance (the loop creates each subsequent one
/// itself).
#[cfg(unix)]
pub type BoundSocket = tokio::net::UnixListener;
#[cfg(windows)]
pub type BoundSocket = tokio::net::windows::named_pipe::NamedPipeServer;

/// Pluggable "what conversation is this parent currently in?" lookup. The
/// production impl wraps `ConnectionManager.get_state`; tests use an
/// in-memory map.
///
/// Kept as a trait so the listener can be unit-tested without spinning up a
/// real `ConnectionManager` or RwLock<SessionState>.
#[async_trait]
pub trait ParentSessionLookup: Send + Sync {
    async fn current_conversation_id(&self, parent_connection_id: &str) -> Option<i32>;
}

/// Per-launch token entry. Bound at MCP injection time and revoked on parent
/// connection teardown.
#[derive(Debug, Clone)]
pub struct TokenEntry {
    pub parent_connection_id: String,
    pub working_dir: PathBuf,
}

#[derive(Default)]
pub struct TokenRegistry {
    inner: RwLock<HashMap<String, TokenEntry>>,
}

impl TokenRegistry {
    pub async fn register(&self, token: String, entry: TokenEntry) {
        self.inner.write().await.insert(token, entry);
    }

    pub async fn revoke(&self, token: &str) {
        self.inner.write().await.remove(token);
    }

    pub async fn lookup(&self, token: &str) -> Option<TokenEntry> {
        self.inner.read().await.get(token).cloned()
    }

    /// Drop every token whose `parent_connection_id` matches. Used on parent
    /// connection teardown so a leaked token can't be reused.
    pub async fn revoke_by_parent(&self, parent_connection_id: &str) {
        let mut map = self.inner.write().await;
        map.retain(|_, entry| entry.parent_connection_id != parent_connection_id);
    }

    /// How many companions are currently reachable, and across how many
    /// distinct parent ACP connections. One token is minted per companion
    /// launch, so `companions` counts injected `codeg-mcp` processes; the two
    /// numbers differ when a connection was re-injected without its old token
    /// having been revoked yet. Read-only — used by the service-status
    /// indicator, never by the wire path.
    pub async fn stats(&self) -> TokenStats {
        let map = self.inner.read().await;
        let parents: std::collections::HashSet<&str> = map
            .values()
            .map(|entry| entry.parent_connection_id.as_str())
            .collect();
        TokenStats {
            companions: map.len(),
            parent_connections: parents.len(),
        }
    }
}

/// Snapshot of [`TokenRegistry`] occupancy. See [`TokenRegistry::stats`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct TokenStats {
    pub companions: usize,
    pub parent_connections: usize,
}

pub struct DelegationListener {
    pub broker: Arc<DelegationBroker>,
    pub tokens: Arc<TokenRegistry>,
    pub parent_lookup: Arc<dyn ParentSessionLookup>,
    /// Pulls pending live-feedback notes for the `check_user_feedback` tool.
    /// Shares the same `tokens` registry and parent-connection scoping as the
    /// delegation arms — one companion, one socket, two features.
    pub feedback: Arc<dyn SessionFeedbackAccess>,
    /// Registers / cancels the blocking `ask_user_question` tool's pending
    /// questions. Same `tokens` registry and parent-connection scoping.
    pub questions: Arc<dyn SessionQuestionAccess>,
    /// Resolves a referenced session for the `get_session_info` tool. Unlike the
    /// other arms this is NOT parent-scoped — it looks any non-deleted session up
    /// by its codeg conversation id (still token-gated against an invalid caller).
    pub session_info: Arc<dyn SessionInfoAccess>,
    /// Records work-task reports (`task_progress` / `task_complete`) against the
    /// task the parent connection is executing. Same token → parent-connection
    /// scoping as the delegation arms.
    pub tasks: Arc<dyn WorkTaskToolAccess>,
    /// Creates automations / board tasks on behalf of the chat that asked
    /// (`create_automation` / `create_work_task`). The impl re-checks the
    /// feature flags at call time, so flipping the setting off stops writes
    /// from sessions that were launched while it was on.
    pub authoring: Arc<dyn ChatAuthoringAccess>,
    /// Lists the built-in browser's tabs, reads a shared page and acts on one
    /// (`browser_list_tabs` / `browser_snapshot` / the action tools). Like the
    /// authoring impl it
    /// re-checks its feature flag at call time; unlike every other arm here it
    /// exists only in the desktop build, because a browser tab is a native
    /// webview — server mode gets `NoBrowserTabs`.
    pub browser: Arc<dyn BrowserToolAccess>,
}

impl DelegationListener {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        parent_lookup: Arc<dyn ParentSessionLookup>,
        feedback: Arc<dyn SessionFeedbackAccess>,
        questions: Arc<dyn SessionQuestionAccess>,
        session_info: Arc<dyn SessionInfoAccess>,
        tasks: Arc<dyn WorkTaskToolAccess>,
        authoring: Arc<dyn ChatAuthoringAccess>,
        browser: Arc<dyn BrowserToolAccess>,
    ) -> Arc<Self> {
        Arc::new(Self {
            broker,
            tokens,
            parent_lookup,
            feedback,
            questions,
            session_info,
            tasks,
            authoring,
            browser,
        })
    }

    /// Bind the socket, then serve it forever. Kept as the one-call entry
    /// point for callers that don't need to observe the bind separately;
    /// [`DelegationService`](super::service::DelegationService) uses the two
    /// halves so it can report a bind failure to the caller instead of losing
    /// it inside a detached task.
    pub async fn run(self: Arc<Self>, socket_path: PathBuf) -> std::io::Result<()> {
        let bound = Self::bind(&socket_path).await?;
        self.accept_loop(bound, socket_path).await
    }

    /// Take ownership of the socket. Split out from [`Self::accept_loop`] so
    /// the failure every caller actually cares about — the address is taken,
    /// the directory is gone, permissions are wrong — surfaces synchronously.
    ///
    /// Binds a short-lived sibling and `rename`s it onto `socket_path` rather
    /// than unlinking that path and binding it directly. `rename(2)` replaces
    /// the destination atomically, so the path never stops naming a bound
    /// socket, and **a bind that fails leaves whatever was already serving
    /// there reachable and untouched**.
    ///
    /// That invariant is the point. This function is on the recovery path — a
    /// user pressing "start service" on an indicator that may simply have
    /// mis-probed — and unlink-then-bind cannot promise it: with the unlink
    /// done and the bind then failing (fd exhaustion, ENOSPC), a perfectly
    /// healthy socket would have been destroyed to no purpose, by the very
    /// action meant to repair it.
    ///
    /// No fallback to unlink-then-bind on failure, deliberately: BOTH paths are
    /// checked against [`SUN_PATH_CAP`] below (so a length limit cannot reject
    /// one and admit the other) and every remaining failure reason — EMFILE,
    /// ENOSPC, a read-only directory — applies to both, so a fallback would
    /// only reintroduce the destructive window in exactly the conditions that
    /// triggered it.
    ///
    /// # Why the lengths are checked here, before anything else
    ///
    /// `bind(2)` enforces [`SUN_PATH_CAP`] but `rename(2)` does not — it is a
    /// plain directory operation with only `PATH_MAX` to answer to. So an
    /// over-long `socket_path` used to sail through this function: the staged
    /// name bound fine, the rename published it at a path no `connect(2)` on
    /// the system could ever name, and this returned `Ok`. The caller then
    /// reported a healthy service — `task_alive`, no `last_error`, a status
    /// indicator lit green — while every companion process was unable to reach
    /// it. A silent total failure, produced by the safety mechanism.
    ///
    /// Refusing up front converts that into a loud error, and doing it BEFORE
    /// the first filesystem call is what keeps the paragraph above true: there
    /// is no staged entry, no `create_dir_all`, and above all no chance of
    /// disturbing an incumbent socket that is still serving this path.
    ///
    /// The staged path is measured too rather than assumed shorter. It usually
    /// is — `.stg-<pid>-<8 hex>` is 8 bytes under `codeg-delegation-<pid>.sock`
    /// — but that holds only for names at least as long as the staged one, and
    /// a caller passing a SHORT name in a deep directory would otherwise clear
    /// this check and then fail the real `bind` on the staged path instead.
    #[cfg(unix)]
    pub async fn bind(socket_path: &Path) -> std::io::Result<BoundSocket> {
        let staging = Self::staging_socket_path(socket_path);
        // Pure: `staging_socket_path` only reshapes the name, so both operands
        // exist before this function has touched the filesystem at all.
        for path in [socket_path, staging.as_path()] {
            if !fits_sun_path(path) {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidInput,
                    format!(
                        "socket path is {} bytes; AF_UNIX addresses cap at {} here. \
                         A `rename` onto this path would succeed and publish a socket \
                         nothing could connect to, so it is refused instead. Point \
                         TMPDIR at a shorter directory: {}",
                        path.as_os_str().len(),
                        SUN_PATH_CAP - 1,
                        path.display(),
                    ),
                ));
            }
        }
        if let Some(parent) = socket_path.parent() {
            // Compared as WRITTEN, not resolved: `default_socket_path` builds
            // the fallback by joining onto `short_socket_dir()`, so the two
            // spellings are byte-identical. Anything that canonicalized the
            // path upstream would take the other branch — on macOS `/tmp` is a
            // symlink to `/private/tmp` — and silently lose the guard below, so
            // keep this function's input un-normalized.
            if parent == short_socket_dir() {
                // Our own fallback directory, and it lives in a `1777` /tmp: it
                // can be waiting for us as another account's directory or as a
                // symlink aimed elsewhere. `create_root` creates it `0700` and
                // refuses both, and unlike the branch below its error is
                // PROPAGATED — a squatted directory must fail the bind, not
                // quietly host our socket.
                //
                // Re-worded on the way out: `create_root` says "scratch root",
                // which is the wrong noun for a broker socket and would send
                // whoever reads it off the status indicator into the wrong
                // subsystem.
                crate::acp::scratch_dir::create_root(parent).map_err(|e| {
                    std::io::Error::new(
                        e.kind(),
                        format!(
                            "cannot use {} for the delegation socket: {e}",
                            parent.display()
                        ),
                    )
                })?;
            } else {
                let _ = tokio::fs::create_dir_all(parent).await;
            }
        }
        // Clear a leftover from a bind that died between these two steps.
        let _ = tokio::fs::remove_file(&staging).await;
        let listener = tokio::net::UnixListener::bind(&staging)?;
        if let Err(e) = tokio::fs::rename(&staging, socket_path).await {
            // Don't leave the staged entry for the next bind to trip over.
            let _ = tokio::fs::remove_file(&staging).await;
            return Err(e);
        }
        tracing::info!("[delegation] listening on UDS {}", socket_path.display());
        Ok(listener)
    }

    /// Sibling path for [`Self::bind`]'s staged socket.
    ///
    /// PID-scoped like the socket itself, then salted. The PID is what makes it
    /// safe: the staging directory is `$TMPDIR`, shared with every other codeg
    /// process, and two binds that picked the same staged name could interleave
    /// into real corruption — one process's `remove_file` clearing the other's
    /// staged entry, then its own bind recreating it under that name, so the
    /// first process's `rename` publishes the *second* process's socket at its
    /// path. No two live processes share a PID, so that can't happen across
    /// processes; the salt covers the only within-process caller that isn't
    /// already serialized by `DelegationService`'s state lock.
    ///
    /// The whole name is deliberately SHORTER than a real socket name
    /// (`codeg-delegation-<pid>.sock`): `sun_path` caps a unix socket address
    /// at 104 bytes on macOS, and a staged path longer than the real one could
    /// fail to bind where the real path would have succeeded — turning a safety
    /// measure into a startup failure. Replacing the file name rather than
    /// appending to it keeps the staged path the cheaper of the two.
    #[cfg(unix)]
    fn staging_socket_path(socket_path: &Path) -> PathBuf {
        let salt = uuid::Uuid::new_v4().simple().to_string();
        socket_path.with_file_name(format!(
            ".stg-{}-{}",
            std::process::id(),
            &salt[..8]
        ))
    }

    #[cfg(windows)]
    pub async fn bind(socket_path: &Path) -> std::io::Result<BoundSocket> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path_str = socket_path.to_string_lossy().to_string();
        let server = ServerOptions::new()
            .first_pipe_instance(true)
            .create(&path_str)?;
        tracing::info!("[delegation] listening on named pipe {path_str}");
        Ok(server)
    }

    /// Run the accept loop until the socket is unbound. Errors on accept are
    /// logged and the loop continues — a single bad connection can't bring
    /// down the listener.
    #[cfg(unix)]
    pub async fn accept_loop(
        self: Arc<Self>,
        listener: BoundSocket,
        _socket_path: PathBuf,
    ) -> std::io::Result<()> {
        loop {
            match listener.accept().await {
                Ok((mut conn, _)) => {
                    let me = Arc::clone(&self);
                    tokio::spawn(async move {
                        if let Err(e) = me.serve_one(&mut conn).await {
                            tracing::error!("[delegation] connection failed: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("[delegation] accept failed: {e}");
                    // Brief backoff so a persistent accept error doesn't pin a core.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            }
        }
    }

    /// Windows variant: follow Tokio's recommended accept pattern — wait for a
    /// connect, immediately create the *next* server instance, then hand the
    /// connected instance off to a worker. This keeps a pipe instance
    /// available at all times, so clients calling `ClientOptions::open()`
    /// between connections don't see `NotFound`.
    #[cfg(windows)]
    pub async fn accept_loop(
        self: Arc<Self>,
        bound: BoundSocket,
        socket_path: PathBuf,
    ) -> std::io::Result<()> {
        use tokio::net::windows::named_pipe::ServerOptions;
        let path_str = socket_path.to_string_lossy().to_string();
        let mut server = bound;
        loop {
            if let Err(e) = server.connect().await {
                tracing::error!("[delegation] connect failed: {e}");
                // Re-create the instance so the next iteration has a fresh
                // listener; a failed connect leaves the current one unusable.
                server = ServerOptions::new().create(&path_str)?;
                continue;
            }
            let connected = server;
            // Re-bind BEFORE serving the current client, so a client that
            // opens during this turn finds a server instance to connect to.
            server = ServerOptions::new().create(&path_str)?;
            let me = Arc::clone(&self);
            tokio::spawn(async move {
                let mut conn = connected;
                if let Err(e) = me.serve_one(&mut conn).await {
                    tracing::error!("[delegation] connection failed: {e}");
                }
            });
        }
    }

    /// Stream-generic per-connection handler. Exposed so unit tests can drive
    /// it over `tokio::io::duplex` instead of a real socket.
    pub async fn serve_one<C>(&self, conn: &mut C) -> std::io::Result<()>
    where
        C: AsyncReadExt + AsyncWriteExt + Unpin,
    {
        let msg: BrokerMessage = read_frame(conn).await?;
        let resp = match msg {
            // Untokened on purpose — see `BrokerMessage::Ping`. Answered before
            // anything else is touched so the probe measures the serve path and
            // nothing more.
            BrokerMessage::Ping => BrokerResponse {
                outcome: serde_json::json!({ "ok": true }),
            },
            BrokerMessage::Call(req) => report_response(self.process(req).await)?,
            BrokerMessage::Status(req) => {
                // A status long-poll — especially `wait_ms = 0` (block until
                // terminal) — can park for the whole lifetime of the child.
                // Race it against peer-close on this one-shot connection so a
                // companion that cancels and drops the request socket doesn't
                // leave this task parked until the task happens to finish. A
                // status query has no side effects (unlike a delegation), so
                // abandoning the wait is safe and there's nothing to cancel
                // broker-side. The companion never writes a second frame on
                // this socket, so the probe read only resolves on EOF/error.
                let status_fut = self.process_status(req);
                tokio::pin!(status_fut);
                let mut probe = [0u8; 1];
                let reports = tokio::select! {
                    biased;
                    reports = &mut status_fut => reports,
                    _ = conn.read(&mut probe) => return Ok(()),
                };
                reports_response(reports)?
            }
            BrokerMessage::CancelTask(req) => report_response(self.process_cancel_task(req).await)?,
            BrokerMessage::ResumeTask(req) => report_response(self.process_resume_task(req).await)?,
            BrokerMessage::Feedback(req) => {
                // at-least-once delivery: READ pending notes (no mutation),
                // WRITE the response, and COMMIT them delivered ONLY on a
                // successful write. A dropped/failed write skips the commit, so
                // the notes stay pending for the agent's next check.
                match self.feedback_target(&req).await {
                    None => {
                        // Invalid token: return an empty envelope (no leak of
                        // whether any feedback exists), nothing to commit.
                        write_frame(conn, &feedback_response(&[])?).await?;
                    }
                    Some(parent_conn_id) => {
                        let pending = self
                            .feedback
                            .read_pending_feedback(&parent_conn_id)
                            .await;
                        // Read-only: the response carries the note ids
                        // (`_commit_ids`); delivery is committed LATER, by the
                        // companion's `CommitFeedback` once it actually returns
                        // the result to the agent. So a cancel that suppresses
                        // the agent-facing response leaves the notes pending.
                        write_frame(conn, &feedback_response(&pending)?).await?;
                    }
                }
                return Ok(());
            }
            BrokerMessage::CommitFeedback(req) => {
                self.process_commit_feedback(req).await;
                // Empty ack so the companion can confirm the listener saw it.
                BrokerResponse {
                    outcome: Value::Null,
                }
            }
            BrokerMessage::Ask(req) => {
                // Register the question (broadcasting the card) and park until
                // the user answers — racing peer-close exactly like `Status`.
                // The companion holds this connection open for the whole wait
                // and never writes a second frame, so the probe read only
                // resolves on EOF/error; a canceled tool call drops the
                // companion's future, closing this socket, which we observe and
                // tear the pending question down. An invalid token, a gone
                // connection, or a connection that already has a pending ask
                // (one-at-a-time) yields a `declined` outcome (the LLM proceeds
                // with its own judgment) rather than hanging.
                let Some(parent_conn_id) = self.ask_target(&req).await else {
                    write_frame(conn, &ask_declined_response()?).await?;
                    return Ok(());
                };
                let Some(reg) = self
                    .questions
                    .register_question(&parent_conn_id, req.questions)
                    .await
                else {
                    write_frame(conn, &ask_declined_response()?).await?;
                    return Ok(());
                };
                let question_id = reg.question_id;
                let mut answer_rx = reg.answer_rx;
                // Close the teardown race: `ask_target` validated the token, but the
                // parent connection may have been revoked + swept
                // (`cancel_questions_by_parent`) in the window before the insert
                // above — the sweep would have missed this just-registered entry,
                // leaving it parked until peer-close. The token is revoked before
                // the sweep, so a re-check that now finds it gone means teardown is
                // underway: cancel immediately so the ask can't linger.
                if self.tokens.lookup(&req.token).await.is_none() {
                    self.questions
                        .cancel_question(&parent_conn_id, &question_id)
                        .await;
                    write_frame(conn, &ask_declined_response()?).await?;
                    return Ok(());
                }
                let mut probe = [0u8; 1];
                let outcome = tokio::select! {
                    biased;
                    ans = &mut answer_rx => ans.ok(),
                    _ = conn.read(&mut probe) => {
                        self.questions
                            .cancel_question(&parent_conn_id, &question_id)
                            .await;
                        return Ok(());
                    }
                };
                let resp = match outcome {
                    Some(o) => ask_response(&o)?,
                    // Sender dropped without sending (connection teardown drain):
                    // surface a declined outcome so the tool returns cleanly.
                    None => ask_declined_response()?,
                };
                write_frame(conn, &resp).await?;
                return Ok(());
            }
            BrokerMessage::SessionInfo(req) => {
                // Read-only resolution (DB + a bounded transcript parse). No
                // peer-close race needed: unlike Status/Ask this never blocks on
                // a long-poll or a human — the bounded parse always completes —
                // and there is nothing to tear down on cancel.
                session_response(self.process_session_info(req).await)?
            }
            BrokerMessage::TaskProgress(req) => {
                task_ack_response(self.process_task_progress(req).await)?
            }
            BrokerMessage::TaskComplete(req) => {
                task_ack_response(self.process_task_complete(req).await)?
            }
            BrokerMessage::CreateAutomation(req) => {
                // A bounded DB write. Like SessionInfo it never long-polls, so
                // there is no peer-close race to run — and unlike Ask there is
                // nothing to tear down if the caller cancels: either the row
                // landed or it didn't, and the response is simply dropped.
                authoring_response(self.process_create_automation(req).await)?
            }
            BrokerMessage::CreateWorkTask(req) => {
                authoring_response(self.process_create_work_task(req).await)?
            }
            BrokerMessage::BrowserTabs(req) => {
                // A registry read. No peer-close race for the same reason as
                // SessionInfo: it cannot block on anything.
                browser_tabs_response(self.process_browser_tabs(req).await)?
            }
            BrokerMessage::BrowserSnapshot(req) => {
                // This one CAN take a moment — it evaluates in the page's
                // isolated world and waits for the answer — but it is bounded
                // by the read's own 15 s engine timeout rather than by a human
                // or a long-poll, and abandoning it early would leave the
                // activity line unwritten while the page had already been
                // read. So no peer-close race here either: the read runs to its
                // own end, and a caller that walked away simply gets no answer.
                browser_snapshot_response(self.process_browser_snapshot(req).await)?
            }
            BrokerMessage::BrowserAct(req) => {
                // Same shape as the read: bounded by the engine's own
                // timeouts, and an action that has happened has to leave its
                // line on the strip whether or not the caller is still there.
                browser_act_response(self.process_browser_act(req).await)?
            }
            BrokerMessage::BrowserConsole(req) => {
                // A registry read, like the listing; nothing to block on.
                browser_console_response(self.process_browser_console(req).await)?
            }
            BrokerMessage::BrowserCapture(req) => {
                // Bounded by the capture's own engine timeout, as the read
                // is; the line it leaves on the strip is written on the
                // codeg side whether or not the caller waits.
                browser_capture_response(self.process_browser_capture(req).await)?
            }
            BrokerMessage::BrowserEval(req) => {
                // The one browser message that waits on a human, so it can sit
                // here for a couple of minutes. Still no peer-close race: the
                // question is in front of a person, and whipping it away
                // because the agent's socket went quiet would train them to
                // dismiss dialogs that vanish. It is bounded by the
                // confirmation's own timeout either way.
                browser_eval_response(self.process_browser_eval(req).await)?
            }
            BrokerMessage::BrowserTabOp(req) => {
                // Bounded by the settle timeout on the codeg side. No
                // peer-close race for the same reason the snapshot arm has
                // none: dropping the future mid-flight would leave a tab open
                // (or a page navigated) with nothing on the strip to say so.
                browser_tab_op_response(self.process_browser_tab_op(req).await)?
            }
            BrokerMessage::Cancel(cancel) => {
                self.process_cancel(cancel).await;
                // Empty ack — the companion only uses this to detect the
                // listener has at least seen the cancel before dropping.
                BrokerResponse {
                    outcome: Value::Null,
                }
            }
        };
        write_frame(conn, &resp).await?;
        Ok(())
    }

    /// Validate the token, resolve the caller's parent connection/conversation,
    /// and query the status of every requested task id (optionally blocking per
    /// the wire `wait_ms`: omitted → immediate snapshot, explicit `0` → block
    /// until a task is terminal, a positive value → bounded long-poll clamped to
    /// [`STATUS_WAIT_MAX_MS`]). Backs the `get_delegation_status` tool. Returns
    /// one report per requested id, in request order. An invalid token reports
    /// `Unknown` for each id — the caller can't usefully distinguish it from a
    /// genuinely unknown task, and we don't leak which.
    async fn process_status(&self, req: BrokerStatusRequest) -> Vec<DelegationTaskReport> {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return req.task_ids.iter().map(|id| unknown_report(id)).collect();
        };
        // Identity-less hosts (Cursor) announce this MCP call as a generic
        // "MCP: tool" and never upgrade it on the wire — the companion
        // round-trip landing here is the FIRST moment anything knows the call
        // is `get_delegation_status`. Restore the live card's identity before
        // running the (possibly long-poll-blocked) status query; on ordinary
        // hosts the broker's sticky gate makes this a no-op.
        let mut rename_input = serde_json::Map::new();
        rename_input.insert(
            "task_ids".into(),
            serde_json::Value::Array(
                req.task_ids
                    .iter()
                    .map(|id| serde_json::Value::String(id.clone()))
                    .collect(),
            ),
        );
        if let Some(ms) = req.wait_ms {
            rename_input.insert("wait_ms".into(), serde_json::Value::Number(ms.into()));
        }
        self.broker
            .rewrite_identityless_tool_call(
                &entry.parent_connection_id,
                crate::acp::delegation::STATUS_TOOL_REWRITE_TITLE,
                serde_json::Value::Object(rename_input),
            )
            .await;
        let parent_conversation_id = self
            .parent_lookup
            .current_conversation_id(&entry.parent_connection_id)
            .await;
        // Map the wire `wait_ms` to a wait mode: omitted → immediate poll, an
        // explicit `0` → block with no timeout (long-running children), any
        // positive value → bounded long-poll clamped to the hard ceiling.
        let wait = match req.wait_ms {
            None => StatusWait::Immediate,
            Some(0) => StatusWait::Infinite,
            Some(ms) => StatusWait::Bounded(ms.min(STATUS_WAIT_MAX_MS)),
        };
        self.broker
            .get_tasks_status(
                &entry.parent_connection_id,
                parent_conversation_id,
                &req.task_ids,
                wait,
            )
            .await
    }

    /// Validate the token, resolve the caller's parent, and cancel the task.
    /// Backs the `cancel_delegation` tool.
    async fn process_cancel_task(&self, req: BrokerCancelTaskRequest) -> DelegationTaskReport {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return unknown_report(&req.task_id);
        };
        // Same identity restoration as `process_status` — see the comment
        // there. `cancel_delegation` results are free-form text, so the
        // completion-time sniff can't cover this tool; the call-time rename
        // is its only identity source on identity-less hosts.
        let mut rename_input = serde_json::Map::new();
        rename_input.insert(
            "task_id".into(),
            serde_json::Value::String(req.task_id.clone()),
        );
        self.broker
            .rewrite_identityless_tool_call(
                &entry.parent_connection_id,
                crate::acp::delegation::CANCEL_TOOL_REWRITE_TITLE,
                serde_json::Value::Object(rename_input),
            )
            .await;
        let parent_conversation_id = self
            .parent_lookup
            .current_conversation_id(&entry.parent_connection_id)
            .await;
        self.broker
            .cancel_task_by_id(
                &entry.parent_connection_id,
                parent_conversation_id,
                &req.task_id,
            )
            .await
    }

    /// Validate the token, resolve the caller's parent, and resume the task.
    /// Backs the `resume_delegation` tool. Unlike `delegate_to_agent`, the
    /// parent conversation is REQUIRED here even though the broker could
    /// technically look the child up without it: ownership of a resumable task
    /// is proven by the child row's `parent_id` matching the caller's current
    /// conversation, so a caller with no conversation has no claim to resume
    /// anything.
    async fn process_resume_task(&self, req: BrokerResumeTaskRequest) -> DelegationTaskReport {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return unknown_report(&req.task_id);
        };
        // Same call-time identity restoration as `process_status` /
        // `process_cancel_task`: like cancel, the resume result is free-form
        // report text with no stable prefix for the completion-time sniff, so
        // this rename is the only identity source on identity-less hosts.
        let mut rename_input = serde_json::Map::new();
        rename_input.insert(
            "task_id".into(),
            serde_json::Value::String(req.task_id.clone()),
        );
        if let Some(reason) = req.reason.as_deref() {
            rename_input.insert(
                "reason".into(),
                serde_json::Value::String(reason.to_string()),
            );
        }
        self.broker
            .rewrite_identityless_tool_call(
                &entry.parent_connection_id,
                crate::acp::delegation::RESUME_TOOL_REWRITE_TITLE,
                serde_json::Value::Object(rename_input),
            )
            .await;
        let Some(parent_conversation_id) = self
            .parent_lookup
            .current_conversation_id(&entry.parent_connection_id)
            .await
        else {
            return cancel("parent has no active conversation");
        };
        self.broker
            .resume_delegation(ResumeDelegationRequest {
                parent_connection_id: entry.parent_connection_id,
                parent_conversation_id,
                task_id: req.task_id,
                reason: req.reason,
                external_handle: req.external_handle,
            })
            .await
    }

    /// Validate the token and resolve the `check_user_feedback` target: the
    /// caller's parent connection id. `None` on an invalid token — the LLM can't
    /// usefully distinguish "no notes" from "bad token", and we don't leak which.
    async fn feedback_target(&self, req: &BrokerFeedbackRequest) -> Option<String> {
        let entry = self.tokens.lookup(&req.token).await?;
        Some(entry.parent_connection_id)
    }

    /// Validate the token and resolve the `ask_user_question` target: the
    /// caller's parent connection id. `None` on an invalid token — the LLM gets
    /// a `declined` outcome (proceed with judgment), and we don't leak which.
    async fn ask_target(&self, req: &BrokerAskRequest) -> Option<String> {
        let entry = self.tokens.lookup(&req.token).await?;
        Some(entry.parent_connection_id)
    }

    /// Mark the named feedback notes delivered, after the companion confirms it
    /// returned them to the agent. Token-scoped to the parent connection. Unknown
    /// tokens are dropped (no LLM on the receiving end to react).
    async fn process_commit_feedback(&self, req: BrokerCommitFeedbackRequest) {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return;
        };
        self.feedback
            .commit_feedback_delivered(&entry.parent_connection_id, req.ids)
            .await;
    }

    /// Validate token + dispatch cancel to the broker. Unknown tokens and
    /// parent-mismatched cancels are silently dropped — there's no LLM on
    /// the receiving end of this method to react to errors.
    async fn process_cancel(&self, cancel: BrokerCancelRequest) {
        let Some(_entry) = self.tokens.lookup(&cancel.token).await else {
            return;
        };
        let reason = cancel
            .reason
            .unwrap_or_else(|| "mcp client canceled".into());
        self.broker
            .cancel_by_external_handle(&cancel.external_handle, reason)
            .await;
    }

    /// Validate the token and resolve the `get_session_info` target. An invalid
    /// token yields a `found:false` outcome (the LLM can't usefully distinguish it
    /// from a deleted session, and we don't leak which).
    ///
    /// SCOPE (deliberate, user-confirmed): the lookup is by codeg conversation id
    /// and is intentionally NOT scoped to the caller's parent connection or to the
    /// session ids actually referenced in the prompt — any non-deleted session
    /// resolves. This is sound in codeg's single-tenant trust model: there is no
    /// per-user isolation anywhere (desktop is one local user; server mode shares
    /// one `CODEG_TOKEN` + one data dir across an operator's devices), the user can
    /// already open every session in the UI, and the agent already has full
    /// filesystem access to every agent's raw session files via its own tools — so
    /// reading session metadata by id is strictly less capability than the agent
    /// already holds, not an escalation. The token gate above still prevents an
    /// unrelated process from reaching the broker at all.
    async fn process_session_info(&self, req: BrokerSessionRequest) -> SessionInfo {
        if self.tokens.lookup(&req.token).await.is_none() {
            return SessionInfo::not_found(req.session_id);
        }
        self.session_info
            .resolve(req.session_id, req.max_messages.unwrap_or(0))
            .await
    }

    /// Validate the token and list the browser tabs an agent may know about.
    ///
    /// An invalid token gets the same answer a runtime with no browser gets:
    /// an empty list. Consistent with every other arm here — a caller that
    /// cannot prove it is a companion learns nothing, not even whether the
    /// user has any tabs open.
    ///
    /// Not scoped to the caller's parent connection, for the reason spelled
    /// out on [`BrokerBrowserTabsRequest`]: tabs belong to the user, and what
    /// an agent may read of one is the per-tab grant.
    async fn process_browser_tabs(&self, req: BrokerBrowserTabsRequest) -> BrowserTabsOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserTabsOutcome::default();
        }
        self.browser.list_tabs().await
    }

    /// Validate the token and read one shared page.
    ///
    /// An invalid token is told the tab does not exist — the same answer a
    /// wrong id gets, so a caller off the street cannot use the refusal codes
    /// to probe which tabs are open or which of them are shared.
    async fn process_browser_snapshot(
        &self,
        req: BrokerBrowserSnapshotRequest,
    ) -> BrowserSnapshotOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserSnapshotOutcome::refused(
                &req.tab_id,
                ERROR_NO_SUCH_TAB,
                format!("No browser tab {} is open.", req.tab_id),
            );
        }
        self.browser.snapshot(&req.tab_id, req.max_chars).await
    }

    /// Validate the token and act on one shared page. An invalid token gets
    /// the same "no such tab" a wrong id gets, for the reason given on
    /// [`Self::process_browser_snapshot`].
    async fn process_browser_act(&self, req: BrokerBrowserActRequest) -> BrowserActOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserActOutcome::refused(
                &req.tab_id,
                ERROR_NO_SUCH_TAB,
                format!("No browser tab {} is open.", req.tab_id),
            );
        }
        self.browser.act(&req.tab_id, req.request).await
    }

    /// Validate the token and read one shared page's console; an invalid
    /// token gets "no such tab", as everywhere here.
    async fn process_browser_console(
        &self,
        req: BrokerBrowserConsoleRequest,
    ) -> BrowserConsoleOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserConsoleOutcome::refused(
                &req.tab_id,
                ERROR_NO_SUCH_TAB,
                format!("No browser tab {} is open.", req.tab_id),
            );
        }
        self.browser.console(&req.tab_id, req.query).await
    }

    /// Validate the token and capture one shared page; an invalid token gets
    /// "no such tab", as everywhere here.
    async fn process_browser_capture(
        &self,
        req: BrokerBrowserCaptureRequest,
    ) -> BrowserCaptureOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserCaptureOutcome::refused(
                &req.tab_id,
                ERROR_NO_SUCH_TAB,
                format!("No browser tab {} is open.", req.tab_id),
            );
        }
        self.browser.capture(&req.tab_id, req.request).await
    }

    /// Validate the token and run one snippet on one shared page; an invalid
    /// token gets "no such tab", as everywhere here.
    ///
    /// Checking the token BEFORE the access impl matters more here than
    /// anywhere else on this surface: the impl is what raises the dialog, and
    /// a caller with no standing must not be able to put a question in front
    /// of the user at all.
    async fn process_browser_eval(&self, req: BrokerBrowserEvalRequest) -> BrowserEvalOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            return BrowserEvalOutcome::refused(
                &req.tab_id,
                ERROR_NO_SUCH_TAB,
                format!("No browser tab {} is open.", req.tab_id),
            );
        }
        self.browser.eval(&req.tab_id, req.request).await
    }

    /// Validate the token and open / navigate / close one tab.
    ///
    /// The token is checked before the access impl, as everywhere here: an
    /// invalid one must not be able to open a tab on the user's screen, and
    /// hears the same "no such tab" every other unauthenticated round trip
    /// gets. An `Open` has no tab to name, so it hears the note instead —
    /// which reveals nothing either, being what a session with the browser
    /// switched off also hears.
    async fn process_browser_tab_op(&self, req: BrokerBrowserTabOpRequest) -> BrowserTabOutcome {
        if self.tokens.lookup(&req.token).await.is_none() {
            let tab_id = req.op.tab_id();
            return BrowserTabOutcome::refused(
                tab_id,
                ERROR_NO_SUCH_TAB,
                match tab_id {
                    Some(tab_id) => format!("No browser tab {tab_id} is open."),
                    None => crate::acp::browser_tools::NO_BROWSER_NOTE.to_string(),
                },
            );
        }
        self.browser.tab_op(req.op).await
    }

    /// Validate the token and hand the progress report to the task engine,
    /// which resolves the parent connection to its owning task + generation.
    async fn process_task_progress(&self, req: BrokerTaskProgressRequest) -> TaskReportAck {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return TaskReportAck::rejected("invalid token");
        };
        self.tasks
            .report_progress(&entry.parent_connection_id, &req.message)
            .await
    }

    /// Validate the token and hand the final verdict to the task engine.
    async fn process_task_complete(&self, req: BrokerTaskCompleteRequest) -> TaskReportAck {
        let Some(entry) = self.tokens.lookup(&req.token).await else {
            return TaskReportAck::rejected("invalid token");
        };
        self.tasks
            .complete(
                &entry.parent_connection_id,
                &req.verdict,
                req.summary.as_deref(),
            )
            .await
    }

    /// Resolve the caller's [`AuthoringContext`] from its per-launch token: the
    /// conversation it is currently in (for defaulting the target project) plus
    /// the working directory recorded at injection. `None` when the token is
    /// invalid — the caller gets a soft refusal, not a leak of whether the token
    /// merely expired.
    async fn authoring_context(&self, token: &str) -> Option<AuthoringContext> {
        let entry = self.tokens.lookup(token).await?;
        let conversation_id = self
            .parent_lookup
            .current_conversation_id(&entry.parent_connection_id)
            .await;
        Some(AuthoringContext {
            conversation_id,
            working_dir: entry.working_dir,
        })
    }

    /// Validate the token and hand the automation spec to the authoring impl,
    /// which re-checks the feature flag before writing.
    async fn process_create_automation(
        &self,
        req: BrokerCreateAutomationRequest,
    ) -> AuthoringOutcome {
        let Some(ctx) = self.authoring_context(&req.token).await else {
            return AuthoringOutcome::rejected("automation", "invalid token");
        };
        self.authoring.create_automation(ctx, req.spec).await
    }

    /// Validate the token and hand the task spec to the authoring impl.
    async fn process_create_work_task(&self, req: BrokerCreateWorkTaskRequest) -> AuthoringOutcome {
        let Some(ctx) = self.authoring_context(&req.token).await else {
            return AuthoringOutcome::rejected("work_task", "invalid token");
        };
        self.authoring.create_work_task(ctx, req.spec).await
    }

    async fn process(&self, req: BrokerRequest) -> DelegationTaskReport {
        // 1. Token + parent_connection_id consistency check. Treat both as
        //    "canceled" since the LLM can't usefully react to either —
        //    the parent has either been torn down or is impersonating.
        let entry = match self.tokens.lookup(&req.token).await {
            Some(e) => e,
            None => return cancel("invalid token"),
        };
        if entry.parent_connection_id != req.parent_connection_id {
            return cancel("token does not match parent connection");
        }

        // 2. Resolve the parent's current conversation. Without one the
        //    broker can't link the child row to the parent.
        let parent_conversation_id = match self
            .parent_lookup
            .current_conversation_id(&req.parent_connection_id)
            .await
        {
            Some(id) => id,
            None => return cancel("parent has no active conversation"),
        };

        // 3. Parse the delegate_to_agent arguments. Schema validation lives
        //    on the LLM side; we only enforce what the broker can't.
        let agent_type = match req.input.get("agent_type").and_then(|v| v.as_str()) {
            Some(raw) => match parse_agent_type(raw) {
                Some(t) => t,
                None => return invalid_agent_type(raw),
            },
            None => return invalid_agent_type(""),
        };
        let task = match req.input.get("task").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_string(),
            _ => {
                return report_failed("invalid_working_dir", "missing or empty task");
            }
        };
        // The `working_dir` the LLM explicitly passed (before defaulting),
        // used by the broker's correlation key. `None` when omitted —
        // symmetric with the ACP `raw_input`, which also omits it then.
        let requested_working_dir = req
            .input
            .get("working_dir")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let working_dir = requested_working_dir
            .clone()
            .or_else(|| Some(entry.working_dir.to_string_lossy().to_string()));

        let delegation_req = DelegationRequest {
            parent_connection_id: req.parent_connection_id,
            parent_conversation_id,
            parent_tool_use_id: req.parent_tool_use_id,
            agent_type,
            task,
            working_dir,
            requested_working_dir,
            external_handle: req.external_handle,
        };
        self.broker.start_delegation(delegation_req).await
    }
}

/// Serialize a [`DelegationTaskReport`] into a [`BrokerResponse`] for the wire.
/// Used by the `Call` / `CancelTask` arms, which each resolve to one report.
fn report_response(report: DelegationTaskReport) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&report).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a batch of [`DelegationTaskReport`]s into a `{ "tasks": [..] }`
/// envelope for the `Status` arm. The companion reads this back and renders it
/// uniformly as a `{ "tasks": [..] }` result — one entry per requested id,
/// whether the poll asked for a single id or a whole fan-out.
fn reports_response(reports: Vec<DelegationTaskReport>) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::json!({
            "tasks": serde_json::to_value(&reports).map_err(|e| {
                std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
            })?,
        }),
    })
}

/// Serialize the pending feedback notes into a
/// `{ "count": N, "feedback": [..], "_commit_ids": [..] }` envelope for the
/// `Feedback` arm. Only the lean `text` + `created_at` reach the agent; the
/// `_commit_ids` are internal — the companion echoes them back in a
/// `CommitFeedback` once it delivers the result, and `render_feedback_result`
/// strips them from the agent-facing output. `count == 0` is "no new feedback".
fn feedback_response(items: &[PendingFeedback]) -> std::io::Result<BrokerResponse> {
    let notes: Vec<Value> = items
        .iter()
        .map(|p| serde_json::json!({ "text": p.text, "created_at": p.created_at }))
        .collect();
    let ids: Vec<&str> = items.iter().map(|p| p.id.as_str()).collect();
    Ok(BrokerResponse {
        outcome: serde_json::json!({
            "count": notes.len(),
            "feedback": notes,
            "_commit_ids": ids,
        }),
    })
}

/// Serialize a resolved [`QuestionOutcome`] into a [`BrokerResponse`] for the
/// `Ask` arm — the `{ answers, declined }` envelope the companion renders.
fn ask_response(outcome: &QuestionOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a resolved [`SessionInfo`] into a [`BrokerResponse`] for the
/// `SessionInfo` arm — the companion renders it into the `get_session_info`
/// tool result.
fn session_response(info: SessionInfo) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&info).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserTabsOutcome`] into a [`BrokerResponse`] for the
/// `BrowserTabs` arm — the companion renders it into the `browser_list_tabs`
/// tool result.
fn browser_tabs_response(outcome: BrowserTabsOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserSnapshotOutcome`] into a [`BrokerResponse`] for the
/// `BrowserSnapshot` arm — the companion renders it into the `browser_snapshot`
/// tool result.
fn browser_snapshot_response(
    outcome: BrowserSnapshotOutcome,
) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserActOutcome`] into a [`BrokerResponse`] for the
/// `BrowserAct` arm — the companion renders it into the action tool's result.
fn browser_act_response(outcome: BrowserActOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserConsoleOutcome`] for the `BrowserConsole` arm.
fn browser_console_response(outcome: BrowserConsoleOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserEvalOutcome`] for the `BrowserEval` arm. No size guard
/// like the capture's: what a snippet can send back is already bounded twice,
/// in the page's renderer and again in `EvalOutcome::from_answer`.
fn browser_eval_response(outcome: BrowserEvalOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserTabOutcome`] for the `BrowserTabOp` arm. Nothing to
/// guard for size: the answer is a tab summary at most.
fn browser_tab_op_response(outcome: BrowserTabOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize a [`BrowserCaptureOutcome`] for the `BrowserCapture` arm. The
/// image rides inside as base64. The capture pipeline keeps it far under the
/// frame cap, but this is the last place before the frame is written, so it
/// is measured here too: a capture the companion would refuse to read is
/// answered with a refusal it can, rather than with a broken round trip.
fn browser_capture_response(outcome: BrowserCaptureOutcome) -> std::io::Result<BrokerResponse> {
    let encode = |outcome: &BrowserCaptureOutcome| {
        serde_json::to_vec(outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })
    };
    let mut bytes = encode(&outcome)?;
    if bytes.len() > CAPTURE_RESPONSE_MAX_BYTES {
        let refused = BrowserCaptureOutcome::refused(
            &outcome.tab_id,
            crate::acp::browser_tools::ERROR_READ_FAILED,
            format!(
                "The screenshot came out too large to deliver ({} bytes). Ask for a smaller \
                 `maxWidth`, or `format: \"jpeg\"`.",
                bytes.len()
            ),
        );
        bytes = encode(&refused)?;
    }
    Ok(BrokerResponse {
        outcome: serde_json::from_slice(&bytes).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// What a serialized capture outcome may weigh: the frame cap less room for
/// the envelope around it.
const CAPTURE_RESPONSE_MAX_BYTES: usize = super::transport::MAX_FRAME_BYTES - 64 * 1024;

/// Serialize a [`TaskReportAck`] into a [`BrokerResponse`] for the
/// `TaskProgress` / `TaskComplete` arms — the companion renders it into the
/// tool result.
fn task_ack_response(ack: TaskReportAck) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&ack).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// Serialize an [`AuthoringOutcome`] into a [`BrokerResponse`] for the
/// `CreateAutomation` / `CreateWorkTask` arms — the companion renders it into
/// the tool result.
fn authoring_response(outcome: AuthoringOutcome) -> std::io::Result<BrokerResponse> {
    Ok(BrokerResponse {
        outcome: serde_json::to_value(&outcome).map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, format!("encode: {e}"))
        })?,
    })
}

/// The `declined` outcome — used when the token is invalid, the connection is
/// gone, or the answer one-shot was dropped without a response. The LLM reads it
/// as "the user didn't answer; proceed with your own judgment".
fn ask_declined_response() -> std::io::Result<BrokerResponse> {
    ask_response(&QuestionOutcome {
        answers: Vec::new(),
        declined: true,
    })
}

/// A `Canceled` report for a setup-side rejection the LLM can't react to (bad
/// token, parent gone). Mirrors the old `cancel(..)` DelegationOutcome.
fn report_canceled(message: &str) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: None,
        status: TaskStatus::Canceled,
        child_conversation_id: None,
        agent_type: None,
        text: None,
        error_code: Some("canceled".into()),
        message: Some(message.into()),
        duration_ms: None,
        blocked_on: None,
    }
}

/// A `Failed` report carrying a wire-stable `error_code` for a bad argument.
fn report_failed(error_code: &str, message: &str) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: None,
        status: TaskStatus::Failed,
        child_conversation_id: None,
        agent_type: None,
        text: None,
        error_code: Some(error_code.into()),
        message: Some(message.into()),
        duration_ms: None,
        blocked_on: None,
    }
}

/// An `Unknown` report — used when a status/cancel request fails the token
/// check (we don't leak whether the task exists).
fn unknown_report(task_id: &str) -> DelegationTaskReport {
    DelegationTaskReport {
        task_id: Some(task_id.to_string()),
        status: TaskStatus::Unknown,
        child_conversation_id: None,
        agent_type: None,
        text: None,
        error_code: None,
        message: Some("unknown task id".into()),
        duration_ms: None,
        blocked_on: None,
    }
}

fn cancel(message: &str) -> DelegationTaskReport {
    report_canceled(message)
}

fn invalid_agent_type(raw: &str) -> DelegationTaskReport {
    if raw.is_empty() {
        report_failed("invalid_agent_type", "missing agent_type")
    } else {
        report_failed("invalid_agent_type", &format!("invalid agent_type: {raw}"))
    }
}

fn parse_agent_type(raw: &str) -> Option<AgentType> {
    serde_json::from_value(serde_json::Value::String(raw.to_string())).ok()
}

/// Whether `path` fits in `sockaddr_un::sun_path`.
///
/// STRICTLY less than the cap: the array has to hold the terminating NUL too,
/// so its last byte is never available to the path. Same rule, and the same
/// constant, as [`crate::acp::scratch_dir`] applies to the temp directory it
/// hands a child — this is codeg's own end of the identical budget.
#[cfg(unix)]
fn fits_sun_path(path: &Path) -> bool {
    path.as_os_str().len() < SUN_PATH_CAP
}

/// Short fallback directory for the broker socket, used when the ambient temp
/// directory is too long to hold one.
///
/// `/tmp` because it is the shortest directory POSIX guarantees exists, and
/// euid-scoped for the reason [`crate::acp::scratch_dir`] gives for its own
/// twin: `/tmp` is shared with every other account on the machine, so an
/// unscoped name would be owned by whichever user ran codeg first and
/// uncreatable by all the rest. [`DelegationListener::bind`] creates it `0700`,
/// keeping the socket as private as it was in the per-user `$TMPDIR` this
/// stands in for.
///
/// Deliberately NOT the scratch root. That directory is swept — entries are
/// enumerated and deleted by pid — and a long-lived socket has no business
/// sharing a namespace whose invariant is "everything here is disposable".
///
/// The cost of staying out of it: nothing reclaims this directory either, so a
/// process that dies without unlinking leaves one dead `.sock` inode behind
/// until the OS temp reaper gets to it. That is not a regression — the primary
/// `$TMPDIR/codeg-delegation-<pid>.sock` has always had exactly the same
/// property, and a stale entry is inert (pid-scoped, never consulted, replaced
/// by `rename` if the pid is ever recycled). Worth knowing before anyone adds a
/// sweep: it would need to cover BOTH locations or it would just move the leak.
#[cfg(unix)]
fn short_socket_dir() -> PathBuf {
    PathBuf::from(format!(
        "/tmp/codeg-{}",
        // Always succeeds; `geteuid` has no failure mode.
        unsafe { libc::geteuid() }
    ))
}

/// Default socket path for the running process, scoped to PID so multiple
/// codeg instances on the same machine don't collide.
///
/// Unix: a `.sock` file inside `temp_dir`, or — when that would not fit in
/// `sun_path` — inside [`short_socket_dir`]. The fallback is not hypothetical
/// housekeeping: codeg exports a ~72-byte per-session `TMPDIR` to the agents it
/// launches, so a codeg started from inside one is already within a few bytes
/// of the macOS cap, and a container or a hand-set `TMPDIR` clears it outright.
/// Without the fallback that produced a socket nobody could dial and no error
/// anywhere — see [`DelegationListener::bind`].
///
/// Windows: a named pipe address `\\.\pipe\codeg-delegation-<pid>`. Windows
/// named pipes live in their own kernel namespace and ignore `temp_dir`; the
/// argument is kept for signature parity across platforms.
#[cfg(unix)]
pub fn default_socket_path(temp_dir: &Path) -> PathBuf {
    let name = format!("codeg-delegation-{}.sock", std::process::id());
    let preferred = temp_dir.join(&name);
    if fits_sun_path(&preferred) {
        return preferred;
    }
    // No third candidate, because there is no third case to handle: this is
    // `/tmp/codeg-` + at most 10 digits of euid + `/codeg-delegation-` + at
    // most 10 digits of pid + `.sock` — 54 bytes at its absolute widest, or
    // half the smallest `sun_path` any of these platforms has.
    let short = short_socket_dir().join(&name);
    tracing::info!(
        "[delegation] {} is {} bytes, past the {}-byte AF_UNIX limit; \
         binding {} instead",
        preferred.display(),
        preferred.as_os_str().len(),
        SUN_PATH_CAP - 1,
        short.display(),
    );
    short
}

#[cfg(windows)]
pub fn default_socket_path(_temp_dir: &Path) -> PathBuf {
    PathBuf::from(format!(r"\\.\pipe\codeg-delegation-{}", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::broker::{ConversationDepthLookup, DelegationConfig};
    use crate::acp::delegation::spawner::{
        mock::MockSpawner, ConnectionSpawner, ResumedSpawn, SpawnerError,
    };
    use crate::acp::browser_tools::{NoBrowserTabs, ERROR_GRANT_REQUIRED};
    use crate::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationSuccess};
    use serde_json::json;
    use std::time::Duration;
    use tokio::io::duplex;

    struct AlwaysRootLookup;
    #[async_trait]
    impl ConversationDepthLookup for AlwaysRootLookup {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    struct StaticParentLookup(Option<i32>);
    #[async_trait]
    impl ParentSessionLookup for StaticParentLookup {
        async fn current_conversation_id(&self, _parent_connection_id: &str) -> Option<i32> {
            self.0
        }
    }

    /// In-memory feedback stub. `read_pending_feedback` returns the seeded notes
    /// WITHOUT draining (read-only, matching production), recording the conn id;
    /// `commit_feedback_delivered` records the (conn_id, ids) it was committed
    /// with so tests can assert delivery happens only after a successful write.
    /// Default is empty (the delegation tests don't exercise feedback).
    #[derive(Default)]
    struct StubFeedback {
        items: tokio::sync::Mutex<Vec<PendingFeedback>>,
        read_conn: tokio::sync::Mutex<Option<String>>,
        committed: tokio::sync::Mutex<Vec<(String, Vec<String>)>>,
    }
    #[async_trait]
    impl SessionFeedbackAccess for StubFeedback {
        async fn read_pending_feedback(
            &self,
            parent_connection_id: &str,
        ) -> Vec<PendingFeedback> {
            *self.read_conn.lock().await = Some(parent_connection_id.to_string());
            self.items.lock().await.clone()
        }
        async fn commit_feedback_delivered(&self, parent_connection_id: &str, ids: Vec<String>) {
            self.committed
                .lock()
                .await
                .push((parent_connection_id.to_string(), ids));
        }
    }

    /// In-memory question stub. `register_question` mints a sequential id,
    /// stashes the answer sender (so a test can resolve it via `answer`), and
    /// records the (parent_conn, questions); `cancel_question` removes the
    /// sender and records the canceled id. Lets the listener's `Ask` arm be
    /// driven without a real `ConnectionManager`.
    #[derive(Default)]
    struct StubQuestion {
        pending: tokio::sync::Mutex<HashMap<String, oneshot::Sender<QuestionOutcome>>>,
        registered: tokio::sync::Mutex<
            Vec<(String, Vec<crate::acp::question::QuestionSpec>)>,
        >,
        canceled: tokio::sync::Mutex<Vec<String>>,
    }
    #[async_trait]
    impl SessionQuestionAccess for StubQuestion {
        async fn register_question(
            &self,
            parent_connection_id: &str,
            questions: Vec<crate::acp::question::QuestionSpec>,
        ) -> Option<crate::acp::question::RegisteredQuestion> {
            let question_id = format!("q-{}", self.registered.lock().await.len() + 1);
            let (tx, rx) = oneshot::channel();
            self.pending.lock().await.insert(question_id.clone(), tx);
            self.registered
                .lock()
                .await
                .push((parent_connection_id.to_string(), questions));
            Some(crate::acp::question::RegisteredQuestion {
                question_id,
                answer_rx: rx,
            })
        }
        async fn cancel_question(&self, _parent_connection_id: &str, question_id: &str) {
            self.pending.lock().await.remove(question_id);
            self.canceled.lock().await.push(question_id.to_string());
        }
        async fn cancel_questions_by_parent(&self, _parent_connection_id: &str) {
            // Not exercised by the listener unit tests (the teardown sweep lives
            // in connection.rs); drop all parked senders to satisfy the trait.
            self.pending.lock().await.clear();
        }
    }
    impl StubQuestion {
        async fn answer(&self, question_id: &str, outcome: QuestionOutcome) {
            if let Some(tx) = self.pending.lock().await.remove(question_id) {
                let _ = tx.send(outcome);
            }
        }
    }

    /// In-memory session-info stub. Records every `(session_id, max_messages)` it
    /// was asked to resolve and returns a seeded outcome — `found` sessions echo
    /// their id, unknown ids return `not_found`. Default knows about no sessions.
    #[derive(Default)]
    struct StubSessionInfo {
        known: std::collections::HashSet<i32>,
        calls: tokio::sync::Mutex<Vec<(i32, u32)>>,
    }
    #[async_trait]
    impl SessionInfoAccess for StubSessionInfo {
        async fn resolve(&self, session_id: i32, max_messages: u32) -> SessionInfo {
            self.calls.lock().await.push((session_id, max_messages));
            if self.known.contains(&session_id) {
                SessionInfo {
                    found: true,
                    session_id,
                    title: Some(format!("session {session_id}")),
                    ..Default::default()
                }
            } else {
                SessionInfo::not_found(session_id)
            }
        }
    }

    /// A browser with one shared tab and one that nobody shared, recording
    /// every call so a test can prove the token gate never reached it.
    #[derive(Default)]
    struct StubBrowser {
        calls: tokio::sync::Mutex<Vec<String>>,
    }
    #[async_trait]
    impl BrowserToolAccess for StubBrowser {
        async fn list_tabs(&self) -> BrowserTabsOutcome {
            self.calls.lock().await.push("list".into());
            BrowserTabsOutcome {
                tabs: vec![crate::browser::agent::AgentTabSummary {
                    tab_id: "t1".into(),
                    origin: Some("https://example.com".into()),
                    level: crate::browser::agent::GrantLevel::Read,
                    title: Some("Example".into()),
                }],
                note: None,
            }
        }
        async fn snapshot(
            &self,
            tab_id: &str,
            max_chars: Option<usize>,
        ) -> BrowserSnapshotOutcome {
            self.calls
                .lock()
                .await
                .push(format!("snapshot {tab_id} {max_chars:?}"));
            BrowserSnapshotOutcome::grant_required(tab_id)
        }
        async fn eval(
            &self,
            tab_id: &str,
            request: crate::browser::eval::EvalRequest,
        ) -> BrowserEvalOutcome {
            self.calls
                .lock()
                .await
                .push(format!("eval {tab_id} {}", request.code));
            BrowserEvalOutcome::grant_required(tab_id)
        }
        async fn console(
            &self,
            tab_id: &str,
            query: crate::browser::console::ConsoleQuery,
        ) -> BrowserConsoleOutcome {
            self.calls.lock().await.push(format!(
                "console {tab_id} since={} min={:?} limit={:?}",
                query.since, query.min_level, query.limit
            ));
            BrowserConsoleOutcome::grant_required(tab_id)
        }
        async fn capture(
            &self,
            tab_id: &str,
            request: crate::browser::capture::CaptureRequest,
        ) -> BrowserCaptureOutcome {
            self.calls.lock().await.push(format!(
                "capture {tab_id} {:?} {:?} {:?}",
                request.clip_target(),
                request.max_width,
                request.format
            ));
            BrowserCaptureOutcome::grant_required(tab_id)
        }
        async fn act(
            &self,
            tab_id: &str,
            request: crate::browser::agent::ActionRequest,
        ) -> BrowserActOutcome {
            self.calls.lock().await.push(format!(
                "act {tab_id} {} {:?}",
                request.generation,
                serde_json::to_value(&request.action).unwrap()
            ));
            BrowserActOutcome::control_required(tab_id)
        }
        async fn tab_op(
            &self,
            op: crate::acp::browser_tools::BrowserTabOp,
        ) -> BrowserTabOutcome {
            self.calls
                .lock()
                .await
                .push(format!("tab_op {}", serde_json::to_value(&op).unwrap()));
            match op.tab_id() {
                Some(tab_id) => BrowserTabOutcome::control_required(tab_id),
                None => BrowserTabOutcome::tab(
                    crate::browser::agent::AgentTabSummary {
                        tab_id: "t9".into(),
                        origin: Some("http://localhost:3000".into()),
                        level: crate::browser::agent::GrantLevel::Control,
                        title: Some("dev".into()),
                    },
                    None,
                ),
            }
        }
    }

    /// No-engine stub: every report is rejected, mirroring a process without a
    /// running task engine.
    struct StubTaskTools;
    #[async_trait]
    impl WorkTaskToolAccess for StubTaskTools {
        async fn report_progress(&self, _parent: &str, _message: &str) -> TaskReportAck {
            TaskReportAck::rejected("no task engine in this process")
        }
        async fn complete(
            &self,
            _parent: &str,
            _verdict: &str,
            _summary: Option<&str>,
        ) -> TaskReportAck {
            TaskReportAck::rejected("no task engine in this process")
        }
    }

    use crate::acp::chat_authoring::{NewAutomationSpec, NewWorkTaskSpec};

    /// Records what the listener handed down and returns a canned outcome, so
    /// authoring tests can assert the token → context resolution without a DB.
    #[derive(Default)]
    struct StubAuthoring {
        automations: tokio::sync::Mutex<Vec<(AuthoringContext, NewAutomationSpec)>>,
        work_tasks: tokio::sync::Mutex<Vec<(AuthoringContext, NewWorkTaskSpec)>>,
    }
    #[async_trait]
    impl ChatAuthoringAccess for StubAuthoring {
        async fn create_automation(
            &self,
            ctx: AuthoringContext,
            spec: NewAutomationSpec,
        ) -> AuthoringOutcome {
            self.automations.lock().await.push((ctx, spec));
            AuthoringOutcome {
                created: true,
                kind: "automation".into(),
                id: Some(7),
                ..Default::default()
            }
        }
        async fn create_work_task(
            &self,
            ctx: AuthoringContext,
            spec: NewWorkTaskSpec,
        ) -> AuthoringOutcome {
            self.work_tasks.lock().await.push((ctx, spec));
            AuthoringOutcome {
                created: true,
                kind: "work_task".into(),
                id: Some(9),
                ..Default::default()
            }
        }
    }

    use tokio::sync::oneshot;

    async fn make_broker(mock: Arc<MockSpawner>) -> Arc<DelegationBroker> {
        let broker = Arc::new(DelegationBroker::new(
            mock as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        // Production default is `enabled: false`; listener tests that don't
        // explicitly set their own config need the switch flipped on so
        // `handle_request` parks pending entries instead of returning
        // `Canceled { reason: "delegation disabled" }` straight away.
        broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;
        broker
    }

    fn make_listener(
        broker: Arc<DelegationBroker>,
        tokens: Arc<TokenRegistry>,
        parent_conversation: Option<i32>,
    ) -> Arc<DelegationListener> {
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(parent_conversation)),
            Arc::new(StubFeedback::default()),
            Arc::new(StubQuestion::default()),
            Arc::new(StubSessionInfo::default()),
            Arc::new(StubTaskTools),
            Arc::new(StubAuthoring::default()),
            Arc::new(NoBrowserTabs),
        )
    }

    /// Build a listener whose feedback access is the given stub, so feedback
    /// tests can seed notes and assert the drain. Delegation pieces are minimal.
    fn make_feedback_listener(
        tokens: Arc<TokenRegistry>,
        feedback: Arc<StubFeedback>,
    ) -> Arc<DelegationListener> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(Some(1))),
            feedback,
            Arc::new(StubQuestion::default()),
            Arc::new(StubSessionInfo::default()),
            Arc::new(StubTaskTools),
            Arc::new(StubAuthoring::default()),
            Arc::new(NoBrowserTabs),
        )
    }

    /// Build a listener whose question access is the given stub, so ask tests
    /// can register/answer questions and assert the round-trip. Delegation and
    /// feedback pieces are minimal.
    fn make_question_listener(
        tokens: Arc<TokenRegistry>,
        questions: Arc<StubQuestion>,
    ) -> Arc<DelegationListener> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(Some(1))),
            Arc::new(StubFeedback::default()),
            questions,
            Arc::new(StubSessionInfo::default()),
            Arc::new(StubTaskTools),
            Arc::new(StubAuthoring::default()),
            Arc::new(NoBrowserTabs),
        )
    }

    /// Build a listener whose session-info access is the given stub, so
    /// `get_session_info` tests can seed known sessions and assert the round-trip.
    fn make_session_listener(
        tokens: Arc<TokenRegistry>,
        session_info: Arc<StubSessionInfo>,
    ) -> Arc<DelegationListener> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(Some(1))),
            Arc::new(StubFeedback::default()),
            Arc::new(StubQuestion::default()),
            session_info,
            Arc::new(StubTaskTools),
            Arc::new(StubAuthoring::default()),
            Arc::new(NoBrowserTabs),
        )
    }

    /// Build a listener whose authoring access is the given stub, so
    /// `create_automation` / `create_work_task` tests can assert what the
    /// listener resolved and passed down.
    fn make_authoring_listener(
        tokens: Arc<TokenRegistry>,
        authoring: Arc<StubAuthoring>,
        parent_conversation: Option<i32>,
    ) -> Arc<DelegationListener> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(parent_conversation)),
            Arc::new(StubFeedback::default()),
            Arc::new(StubQuestion::default()),
            Arc::new(StubSessionInfo::default()),
            Arc::new(StubTaskTools),
            authoring,
            Arc::new(NoBrowserTabs),
        )
    }

    /// Build a listener whose browser access is the given stub, so
    /// `browser_list_tabs` / `browser_snapshot` tests can assert what the token
    /// gate let through.
    fn make_browser_listener(
        tokens: Arc<TokenRegistry>,
        browser: Arc<dyn BrowserToolAccess>,
    ) -> Arc<DelegationListener> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        DelegationListener::new(
            broker,
            tokens,
            Arc::new(StaticParentLookup(Some(1))),
            Arc::new(StubFeedback::default()),
            Arc::new(StubQuestion::default()),
            Arc::new(StubSessionInfo::default()),
            Arc::new(StubTaskTools),
            Arc::new(StubAuthoring::default()),
            browser,
        )
    }

    async fn make_request(input: serde_json::Value) -> BrokerRequest {
        BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "parent-conn".into(),
            parent_tool_use_id: "pt-1".into(),
            external_handle: None,
            input,
        }
    }

    #[tokio::test]
    async fn invalid_token_rejected() {
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            Arc::new(TokenRegistry::default()),
            Some(1),
        );
        let report = listener
            .process(make_request(json!({"agent_type": "codex", "task": "x"})).await)
            .await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert_eq!(report.error_code.as_deref(), Some("canceled"));
        assert!(report.message.unwrap().contains("invalid token"));
    }

    #[tokio::test]
    async fn token_parent_mismatch_rejected() {
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "other-parent".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            tokens,
            Some(1),
        );
        let report = listener
            .process(make_request(json!({"agent_type": "codex", "task": "x"})).await)
            .await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert!(report.message.unwrap().contains("does not match"));
    }

    #[tokio::test]
    async fn missing_parent_conversation_rejected() {
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        // parent_conversation = None: parent has no live conversation.
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            tokens,
            None,
        );
        let report = listener
            .process(make_request(json!({"agent_type": "codex", "task": "x"})).await)
            .await;
        assert_eq!(report.status, TaskStatus::Canceled);
        assert!(report.message.unwrap().contains("no active conversation"));
    }

    #[tokio::test]
    async fn invalid_agent_type_rejected() {
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            tokens,
            Some(1),
        );
        let report = listener
            .process(make_request(json!({"agent_type": "garbage", "task": "x"})).await)
            .await;
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("invalid_agent_type"));
    }

    /// Full async round-trip through the listener: `delegate_to_agent` returns a
    /// Running ack, the lifecycle resolves the child via `complete_call`, and a
    /// follow-up `get_delegation_status` collects the Completed result.
    #[tokio::test]
    async fn happy_path_ack_then_status_collects_result() {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok("child-conn".into())).await;
        mock.queue_send(Ok(42)).await;
        let broker = make_broker(mock.clone()).await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;

        // 1. delegate_to_agent → Running ack carrying the child conversation id.
        let listener = make_listener(broker.clone(), tokens.clone(), Some(1));
        let (mut client, mut server) = duplex(16 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::Call(BrokerRequest {
            token: "tok".into(),
            parent_connection_id: "parent-conn".into(),
            parent_tool_use_id: "pt-1".into(),
            external_handle: None,
            input: json!({"agent_type": "codex", "task": "do x"}),
        });
        write_frame(&mut client, &msg).await.unwrap();
        let ack: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(ack.outcome["status"], "running");
        assert_eq!(ack.outcome["child_conversation_id"], 42);
        let task_id = ack.outcome["task_id"].as_str().unwrap().to_string();

        // 2. The lifecycle resolves the child on TurnComplete.
        broker
            .complete_call(
                &task_id,
                DelegationOutcome::Ok(DelegationSuccess {
                    text: "result-text".into(),
                    child_conversation_id: 42,
                    child_agent_type: AgentType::Codex,
                    turn_count: 1,
                    duration_ms: 5,
                    token_usage: None,
                }),
            )
            .await;

        // 3. get_delegation_status → Completed with the result text.
        let listener = make_listener(broker.clone(), tokens, Some(1));
        let (mut client, mut server) = duplex(16 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".into(),
            task_ids: vec![task_id.clone()],
            wait_ms: Some(1_000),
        });
        write_frame(&mut client, &status).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        // The Status arm returns a `{ tasks: [..] }` envelope; a single id is
        // the first (only) entry.
        assert_eq!(resp.outcome["tasks"][0]["status"], "completed");
        assert_eq!(resp.outcome["tasks"][0]["text"], "result-text");
        assert_eq!(resp.outcome["tasks"][0]["child_conversation_id"], 42);
    }

    /// Start a running task directly and return `(broker, tokens, task_id)`.
    /// Shared setup for the `wait_ms` mapping tests below.
    async fn running_task_fixture() -> (Arc<DelegationBroker>, Arc<TokenRegistry>, String) {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok("child-conn".into())).await;
        mock.queue_send(Ok(7)).await;
        let broker = make_broker(mock).await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let ack = broker
            .start_delegation(DelegationRequest {
                parent_connection_id: "parent-conn".into(),
                parent_conversation_id: 1,
                parent_tool_use_id: "pt-1".into(),
                agent_type: AgentType::Codex,
                task: "do x".into(),
                working_dir: None,
                requested_working_dir: None,
                external_handle: None,
            })
            .await;
        let task_id = ack.task_id.clone().expect("running task carries an id");
        (broker, tokens, task_id)
    }

    /// Omitted `wait_ms` (the safe default) maps to an immediate snapshot: the
    /// status of a still-running task returns `running` right away rather than
    /// blocking.
    #[tokio::test]
    async fn status_omitted_wait_returns_immediately() {
        let (broker, tokens, task_id) = running_task_fixture().await;
        let listener = make_listener(broker, tokens, Some(1));
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });

        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".into(),
            task_ids: vec![task_id],
            wait_ms: None,
        });
        write_frame(&mut client, &status).await.unwrap();
        // No completion ever happens — an immediate poll must still return.
        let resp: BrokerResponse = tokio::time::timeout(Duration::from_secs(2), async {
            read_frame::<_, BrokerResponse>(&mut client).await.unwrap()
        })
        .await
        .expect("omitted wait_ms must return immediately");
        server_task.await.unwrap().unwrap();
        assert_eq!(resp.outcome["tasks"][0]["status"], "running");
    }

    /// An explicit `wait_ms = 0` maps to an unbounded wait: the call blocks
    /// while the task is running and only resolves once it reaches a terminal
    /// state, returning the completed report through the wire.
    #[tokio::test]
    async fn status_explicit_zero_blocks_until_terminal() {
        let (broker, tokens, task_id) = running_task_fixture().await;
        let listener = make_listener(broker.clone(), tokens, Some(1));
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });

        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".into(),
            task_ids: vec![task_id.clone()],
            wait_ms: Some(0),
        });
        write_frame(&mut client, &status).await.unwrap();

        // While the task runs, the wait must NOT resolve.
        let early = tokio::time::timeout(Duration::from_millis(50), async {
            read_frame::<_, BrokerResponse>(&mut client).await
        })
        .await;
        assert!(
            early.is_err(),
            "wait_ms=0 must block while the task is still running"
        );

        // Resolving the task wakes the parked wait, which returns completed.
        broker
            .complete_call(
                &task_id,
                DelegationOutcome::Ok(DelegationSuccess {
                    text: "done".into(),
                    child_conversation_id: 7,
                    child_agent_type: AgentType::Codex,
                    turn_count: 1,
                    duration_ms: 5,
                    token_usage: None,
                }),
            )
            .await;
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap().unwrap();
        assert_eq!(resp.outcome["tasks"][0]["status"], "completed");
        assert_eq!(resp.outcome["tasks"][0]["text"], "done");
    }

    /// A `wait_ms = 0` status call that the companion cancels (dropping the
    /// request socket) must not leave `serve_one` parked until the task is
    /// terminal. The peer-close race abandons the wait while leaving the task
    /// itself untouched — there's no broker-side side effect from a status
    /// query.
    #[tokio::test]
    async fn infinite_status_wait_abandoned_when_peer_closes() {
        let (broker, tokens, task_id) = running_task_fixture().await;
        let listener = make_listener(broker.clone(), tokens, Some(1));
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });

        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".into(),
            task_ids: vec![task_id],
            wait_ms: Some(0),
        });
        write_frame(&mut client, &status).await.unwrap();

        // Let the server park inside the unbounded wait.
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !server_task.is_finished(),
            "server must be parked on the unbounded wait"
        );

        // Companion cancels: drop the request socket without completing the task.
        drop(client);

        // serve_one must observe the peer-close and return promptly instead of
        // hanging until the (never-completing) task is terminal.
        let result = tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .expect("serve_one must return after the peer closes");
        result.unwrap().unwrap();

        // The task itself was not touched by the abandoned status query.
        assert_eq!(broker.pending_count().await, 1);
    }

    /// Batch status over the listener: two tasks, one completed and one still
    /// running, return as a `{ tasks: [..] }` envelope with both reports in
    /// request order.
    #[tokio::test]
    async fn batch_status_over_listener_multi_id() {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok("child-1".into())).await;
        mock.queue_send(Ok(1)).await;
        mock.queue_spawn(Ok("child-2".into())).await;
        mock.queue_send(Ok(2)).await;
        let broker = make_broker(mock.clone()).await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let start = |tool_use: &'static str| {
            let broker = broker.clone();
            async move {
                broker
                    .start_delegation(DelegationRequest {
                        parent_connection_id: "parent-conn".into(),
                        parent_conversation_id: 1,
                        parent_tool_use_id: tool_use.into(),
                        agent_type: AgentType::Codex,
                        task: "do x".into(),
                        working_dir: None,
                        requested_working_dir: None,
                        external_handle: None,
                    })
                    .await
                    .task_id
                    .unwrap()
            }
        };
        let t1 = start("pt-1").await;
        let t2 = start("pt-2").await;
        broker
            .complete_call(
                &t1,
                DelegationOutcome::Ok(DelegationSuccess {
                    text: "first".into(),
                    child_conversation_id: 1,
                    child_agent_type: AgentType::Codex,
                    turn_count: 1,
                    duration_ms: 3,
                    token_usage: None,
                }),
            )
            .await;

        let listener = make_listener(broker.clone(), tokens, Some(1));
        let (mut client, mut server) = duplex(16 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "tok".into(),
            task_ids: vec![t1.clone(), t2.clone()],
            wait_ms: None,
        });
        write_frame(&mut client, &status).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        let tasks = resp.outcome["tasks"].as_array().expect("tasks array");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["status"], "completed");
        assert_eq!(tasks[0]["task_id"], t1.as_str());
        assert_eq!(tasks[1]["status"], "running");
        assert_eq!(tasks[1]["task_id"], t2.as_str());
    }

    /// An invalid token over a batch status reports `Unknown` for EACH requested
    /// id (preserving order) rather than collapsing to a single report — so the
    /// companion can still render one row per task.
    #[tokio::test]
    async fn batch_status_invalid_token_returns_unknown_per_id() {
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            Arc::new(TokenRegistry::default()),
            Some(1),
        );
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let status = BrokerMessage::Status(BrokerStatusRequest {
            token: "bad-token".into(),
            task_ids: vec!["a".into(), "b".into()],
            wait_ms: None,
        });
        write_frame(&mut client, &status).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        let tasks = resp.outcome["tasks"].as_array().expect("tasks array");
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["status"], "unknown");
        assert_eq!(tasks[0]["task_id"], "a");
        assert_eq!(tasks[1]["status"], "unknown");
        assert_eq!(tasks[1]["task_id"], "b");
    }

    /// `cancel_delegation` over the listener: a running task is canceled by id
    /// and reports `canceled`.
    #[tokio::test]
    async fn cancel_task_by_id_over_listener() {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok("child-conn".into())).await;
        mock.queue_send(Ok(7)).await;
        let broker = make_broker(mock.clone()).await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        // Start a task directly so we hold its id.
        let ack = broker
            .start_delegation(DelegationRequest {
                parent_connection_id: "parent-conn".into(),
                parent_conversation_id: 1,
                parent_tool_use_id: "pt-1".into(),
                agent_type: AgentType::Codex,
                task: "do x".into(),
                working_dir: None,
                requested_working_dir: None,
                external_handle: None,
            })
            .await;
        let task_id = ack.task_id.clone().unwrap();

        let listener = make_listener(broker.clone(), tokens, Some(1));
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let cancel = BrokerMessage::CancelTask(BrokerCancelTaskRequest {
            token: "tok".into(),
            task_id: task_id.clone(),
        });
        write_frame(&mut client, &cancel).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(resp.outcome["status"], "canceled");
        assert_eq!(broker.pending_count().await, 0);
    }

    #[tokio::test]
    async fn cancel_message_routed_to_broker() {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok("c-cancel".into())).await;
        mock.queue_send(Ok(99)).await;
        let broker = make_broker(mock.clone()).await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_listener(broker.clone(), tokens, Some(1));

        // Park a delegation call with a known external_handle.
        let driver = {
            let broker = broker.clone();
            tokio::spawn(async move {
                let req = DelegationRequest {
                    parent_connection_id: "parent-conn".into(),
                    parent_conversation_id: 1,
                    parent_tool_use_id: "pt-cancel".into(),
                    agent_type: AgentType::Codex,
                    task: "do x".into(),
                    working_dir: None,
                    requested_working_dir: None,
                    external_handle: Some("h-1".into()),
                };
                broker.handle_request(req).await
            })
        };
        while broker.pending_count().await == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Drive a cancel through the listener — listener should ack with
        // an empty BrokerResponse and the broker should drain the pending.
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });

        let cancel_msg = BrokerMessage::Cancel(BrokerCancelRequest {
            token: "tok".into(),
            external_handle: "h-1".into(),
            reason: Some("from test".into()),
        });
        write_frame(&mut client, &cancel_msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        assert!(resp.outcome.is_null(), "cancel ack must be null");
        server_task.await.unwrap();

        let outcome = driver.await.unwrap();
        match outcome {
            DelegationOutcome::Err { code, .. } => assert_eq!(code, "canceled"),
            other => panic!("expected canceled, got {other:?}"),
        }
    }

    /// Full `resume_delegation` round-trip over the wire: the listener
    /// validates the token, resolves the caller's conversation, and hands the
    /// broker a `ResumeDelegationRequest` — which resumes the interrupted child
    /// and acks Running under the unchanged task id.
    #[tokio::test]
    async fn resume_task_round_trip_resumes_interrupted_child() {
        use crate::acp::delegation::broker::{ChildResumeContext, ChildStatusLookup};
        use crate::acp::delegation::types::TaskStatus as Ts;

        /// Minimal resume-context stub: every call_id resolves to one canceled
        /// child owned by conversation 1.
        struct StubResumeLookup;
        #[async_trait]
        impl ChildStatusLookup for StubResumeLookup {
            async fn find_by_call_id(
                &self,
                _call_id: &str,
            ) -> Option<crate::acp::delegation::broker::ChildStatusRecord> {
                None
            }
            async fn find_resume_context_by_call_id(
                &self,
                _call_id: &str,
            ) -> Option<ChildResumeContext> {
                Some(ChildResumeContext {
                    child_conversation_id: 42,
                    status: Ts::Canceled,
                    agent_type: AgentType::Codex,
                    parent_id: Some(1),
                    parent_tool_use_id: Some("pt-orig".into()),
                    external_id: Some("ext-1".into()),
                    folder_id: 7,
                    working_dir: Some("/work".into()),
                    title: Some("do x".into()),
                })
            }
        }

        let mock = Arc::new(MockSpawner::new());
        mock.queue_resume_spawn(Ok(ResumedSpawn::fresh("child-conn-2"))).await;
        mock.queue_resume_send(Ok(())).await;
        let broker = Arc::new(
            DelegationBroker::new(
                mock.clone() as Arc<dyn ConnectionSpawner>,
                Arc::new(AlwaysRootLookup) as Arc<dyn ConversationDepthLookup>,
            )
            .with_status_lookup(Arc::new(StubResumeLookup)),
        );
        broker
            .set_config(DelegationConfig {
                enabled: true,
                ..DelegationConfig::default()
            })
            .await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_listener(broker.clone(), tokens, Some(1));

        let (mut client, mut server) = duplex(16 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::ResumeTask(BrokerResumeTaskRequest {
            token: "tok".into(),
            task_id: "task-1".into(),
            reason: Some("session crashed".into()),
            external_handle: Some("h-resume".into()),
        });
        write_frame(&mut client, &msg).await.unwrap();
        let ack: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(ack.outcome["status"], "running");
        assert_eq!(ack.outcome["task_id"], "task-1");
        assert_eq!(ack.outcome["child_conversation_id"], 42);
        // The child was re-spawned by loading its recorded session, and the
        // caller's reason reached the continuation prompt.
        let spawns = mock.resume_spawn_args.lock().await;
        assert_eq!(spawns.len(), 1);
        assert_eq!(spawns[0].external_session_id, "ext-1");
        drop(spawns);
        let sends = mock.resume_send_args.lock().await;
        assert_eq!(sends[0].child_conversation_id, 42);
        assert!(sends[0].prompt.contains("session crashed"));
    }

    /// An invalid token on the resume arm stays opaque — `unknown`, exactly
    /// like the status/cancel arms (no leak of whether the task exists).
    #[tokio::test]
    async fn resume_task_invalid_token_reports_unknown() {
        let listener = make_listener(
            make_broker(Arc::new(MockSpawner::new())).await,
            Arc::new(TokenRegistry::default()),
            Some(1),
        );
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::ResumeTask(BrokerResumeTaskRequest {
            token: "bad".into(),
            task_id: "task-1".into(),
            reason: None,
            external_handle: None,
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(resp.outcome["status"], "unknown");
    }

    #[tokio::test]
    async fn token_registry_revoke_and_revoke_by_parent() {
        let registry = TokenRegistry::default();
        registry
            .register(
                "t1".into(),
                TokenEntry {
                    parent_connection_id: "p1".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        registry
            .register(
                "t2".into(),
                TokenEntry {
                    parent_connection_id: "p1".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        registry
            .register(
                "t3".into(),
                TokenEntry {
                    parent_connection_id: "p2".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;

        registry.revoke("t1").await;
        assert!(registry.lookup("t1").await.is_none());
        assert!(registry.lookup("t2").await.is_some());

        registry.revoke_by_parent("p1").await;
        assert!(registry.lookup("t2").await.is_none());
        assert!(registry.lookup("t3").await.is_some());
    }

    // Sanity: spawn failure surfaces as spawn_failed when the listener path
    // is exercised. Exercises the full process() → broker.handle_request chain.
    #[tokio::test]
    async fn spawn_failure_surfaces_through_listener() {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Err(SpawnerError::Spawn("agent missing".into())))
            .await;
        // `make_broker` already enables delegation; this call narrows the
        // depth limit (8 instead of the helper's default) without changing
        // the enable bit.
        let broker = make_broker(mock).await;
        broker
            .set_config(DelegationConfig {
                enabled: true,
                depth_limit: 8,
                ..DelegationConfig::default()
            })
            .await;
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_listener(broker, tokens, Some(1));

        let report = listener
            .process(make_request(json!({"agent_type": "codex", "task": "x"})).await)
            .await;
        assert_eq!(report.status, TaskStatus::Failed);
        assert_eq!(report.error_code.as_deref(), Some("spawn_failed"));
    }

    // --- check_user_feedback over the listener -----------------------------

    use crate::acp::feedback::PendingFeedback;

    fn pending(id: &str, text: &str) -> PendingFeedback {
        PendingFeedback {
            id: id.into(),
            text: text.into(),
            created_at: chrono::Utc::now(),
        }
    }

    /// The manager chunks each response via `bounded_feedback_batch`. The
    /// serialized `feedback_response` of any such chunk must stay under the
    /// transport cap (`MAX_FRAME_BYTES` = 16 MiB) so the companion's `read_frame`
    /// never rejects it after the listener committed delivery — for BOTH
    /// worst-case-escaping notes AND a flood of tiny notes (whose per-note JSON
    /// overhead, not text length, is what a naive text-only bound would miss).
    #[test]
    fn bounded_feedback_response_always_fits_a_transport_frame() {
        use crate::acp::delegation::transport::MAX_FRAME_BYTES;
        use crate::acp::feedback::{bounded_feedback_batch, MAX_FEEDBACK_RESPONSE_BYTES};

        // Worst-case escaping: many MAX_FEEDBACK_CHARS-sized control-char notes.
        let worst = "\u{0001}".repeat(4096);
        let big: Vec<PendingFeedback> = (0..5_000)
            .map(|i| pending(&format!("b{i}"), &worst))
            .collect();
        // A flood of tiny notes: little text, lots of per-note JSON overhead.
        let tiny: Vec<PendingFeedback> = (0..200_000)
            .map(|i| pending(&format!("t{i}"), "x"))
            .collect();

        for (label, set) in [("worst-case", big), ("tiny-flood", tiny)] {
            let total = set.len();
            let batch = bounded_feedback_batch(set, MAX_FEEDBACK_RESPONSE_BYTES);
            assert!(batch.len() < total, "{label}: batch must be chunked");
            let encoded = serde_json::to_vec(&feedback_response(&batch).unwrap()).unwrap();
            assert!(
                encoded.len() < MAX_FRAME_BYTES,
                "{label}: bounded response must fit a transport frame: {} >= {}",
                encoded.len(),
                MAX_FRAME_BYTES
            );
        }
    }

    /// A valid `check_user_feedback` returns the parent's notes in a
    /// `{ count, feedback: [..] }` envelope (lean text, no ids) scoped to the
    /// token's parent connection, and — crucially — commits them delivered ONLY
    /// after the response is written, with the exact note ids.
    #[tokio::test]
    async fn feedback_returns_notes_then_commits_after_write() {
        let feedback = Arc::new(StubFeedback::default());
        *feedback.items.lock().await = vec![
            pending("f1", "use the existing UserService"),
            pending("f2", "skip the migration"),
        ];
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_feedback_listener(tokens, feedback.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::Feedback(BrokerFeedbackRequest {
            token: "tok".into(),
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["count"], 2);
        let notes = resp.outcome["feedback"].as_array().unwrap();
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0]["text"], "use the existing UserService");
        // The lean note shape carries no internal id...
        assert!(notes[0].get("id").is_none());
        // ...but the envelope carries `_commit_ids` for the companion to echo
        // back in a CommitFeedback after it delivers the result.
        let commit_ids = resp.outcome["_commit_ids"].as_array().unwrap();
        assert_eq!(commit_ids, &vec!["f1", "f2"]);
        // Read was scoped to the token's parent connection id.
        assert_eq!(feedback.read_conn.lock().await.as_deref(), Some("parent-conn"));
        // The Feedback arm is READ-ONLY — it does NOT commit (delivery is
        // committed later, by the companion's CommitFeedback).
        assert!(feedback.committed.lock().await.is_empty());
    }

    /// A valid `get_session_info` resolves the session by id and returns its
    /// metadata; the resolver is called with the requested id + max_messages.
    #[tokio::test]
    async fn session_info_valid_token_resolves_by_id() {
        let session_info = Arc::new(StubSessionInfo {
            known: std::collections::HashSet::from([42]),
            ..Default::default()
        });
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_session_listener(tokens, session_info.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::SessionInfo(BrokerSessionRequest {
            token: "tok".into(),
            session_id: 42,
            max_messages: Some(15),
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["found"], true);
        assert_eq!(resp.outcome["session_id"], 42);
        assert_eq!(resp.outcome["title"], "session 42");
        // The resolver saw the id + the requested message budget.
        assert_eq!(session_info.calls.lock().await.as_slice(), &[(42, 15)]);
    }

    /// Accepted-policy coverage (deliberate single-tenant scope): a single valid
    /// token resolves ANY non-deleted session id — not only ids "referenced" in the
    /// prompt. Three unrelated ids all resolve through one token.
    #[tokio::test]
    async fn session_info_resolves_any_session_id_not_just_referenced() {
        let session_info = Arc::new(StubSessionInfo {
            known: std::collections::HashSet::from([7, 42, 1000]),
            ..Default::default()
        });
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_session_listener(tokens, session_info.clone());

        for id in [7, 42, 1000] {
            let (mut client, mut server) = duplex(8 * 1024);
            let l = listener.clone();
            let server_task = tokio::spawn(async move {
                l.serve_one(&mut server).await.unwrap();
            });
            let msg = BrokerMessage::SessionInfo(BrokerSessionRequest {
                token: "tok".into(),
                session_id: id,
                max_messages: Some(0),
            });
            write_frame(&mut client, &msg).await.unwrap();
            let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
            server_task.await.unwrap();
            assert_eq!(resp.outcome["found"], true, "id {id} should resolve");
            assert_eq!(resp.outcome["session_id"], id);
        }
    }

    /// An invalid token yields a `found:false` outcome WITHOUT touching the
    /// resolver (no leak of whether the session exists).
    #[tokio::test]
    async fn session_info_invalid_token_is_not_found_without_resolving() {
        let session_info = Arc::new(StubSessionInfo {
            known: std::collections::HashSet::from([42]),
            ..Default::default()
        });
        // No token registered.
        let tokens = Arc::new(TokenRegistry::default());
        let listener = make_session_listener(tokens, session_info.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::SessionInfo(BrokerSessionRequest {
            token: "bogus".into(),
            session_id: 42,
            max_messages: None,
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["found"], false);
        assert_eq!(resp.outcome["session_id"], 42);
        // The resolver was never consulted for an unauthenticated caller.
        assert!(session_info.calls.lock().await.is_empty());
    }

    /// A valid token resolves the caller's conversation + working dir and hands
    /// both down as the [`AuthoringContext`], so the impl can default the target
    /// project to the project this chat is in.
    #[tokio::test]
    async fn create_automation_resolves_caller_context() {
        let authoring = Arc::new(StubAuthoring::default());
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/repo/app"),
                },
            )
            .await;
        let listener = make_authoring_listener(tokens, authoring.clone(), Some(42));

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::CreateAutomation(BrokerCreateAutomationRequest {
            token: "tok".into(),
            spec: NewAutomationSpec {
                name: "Nightly audit".into(),
                prompt: "audit deps".into(),
                cron: Some("0 3 * * *".into()),
                timezone: None,
                action: Default::default(),
                agent_type: None,
                folder_path: None,
                enabled: true,
            },
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["created"], true);
        assert_eq!(resp.outcome["id"], 7);
        let calls = authoring.automations.lock().await;
        let (ctx, spec) = calls.first().expect("impl was called");
        assert_eq!(ctx.conversation_id, Some(42));
        assert_eq!(ctx.working_dir, PathBuf::from("/repo/app"));
        assert_eq!(spec.name, "Nightly audit");
    }

    /// A caller with no conversation yet still reaches the impl — the working
    /// directory alone can resolve a project — so the arm must not gate on it.
    #[tokio::test]
    async fn create_work_task_passes_through_without_a_conversation() {
        let authoring = Arc::new(StubAuthoring::default());
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/repo/app"),
                },
            )
            .await;
        let listener = make_authoring_listener(tokens, authoring.clone(), None);

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::CreateWorkTask(BrokerCreateWorkTaskRequest {
            token: "tok".into(),
            spec: NewWorkTaskSpec {
                title: "Fix the flake".into(),
                prompt: "the retry test is flaky".into(),
                agent_type: None,
                folder_path: None,
            },
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["created"], true);
        assert_eq!(resp.outcome["id"], 9);
        let calls = authoring.work_tasks.lock().await;
        let (ctx, spec) = calls.first().expect("impl was called");
        assert_eq!(ctx.conversation_id, None);
        assert_eq!(spec.title, "Fix the flake");
    }

    /// An invalid token is a soft refusal that NEVER reaches the impl — nothing
    /// gets written on behalf of an unauthenticated caller.
    #[tokio::test]
    async fn create_automation_invalid_token_never_reaches_impl() {
        let authoring = Arc::new(StubAuthoring::default());
        // No token registered.
        let tokens = Arc::new(TokenRegistry::default());
        let listener = make_authoring_listener(tokens, authoring.clone(), Some(1));

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::CreateAutomation(BrokerCreateAutomationRequest {
            token: "bogus".into(),
            spec: NewAutomationSpec {
                name: "n".into(),
                prompt: "p".into(),
                cron: None,
                timezone: None,
                action: Default::default(),
                agent_type: None,
                folder_path: None,
                enabled: true,
            },
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["created"], false);
        assert_eq!(resp.outcome["kind"], "automation");
        assert!(authoring.automations.lock().await.is_empty());
    }

    /// `CommitFeedback` marks the named ids delivered, scoped (via the token) to
    /// the parent connection — the companion sends this only after it delivers.
    #[tokio::test]
    async fn commit_feedback_marks_delivered_scoped_to_parent() {
        let feedback = Arc::new(StubFeedback::default());
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_feedback_listener(tokens, feedback.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::CommitFeedback(BrokerCommitFeedbackRequest {
            token: "tok".into(),
            ids: vec!["f1".into(), "f2".into()],
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert!(resp.outcome.is_null(), "commit ack is empty");

        let committed = feedback.committed.lock().await;
        assert_eq!(committed.len(), 1);
        assert_eq!(committed[0].0, "parent-conn");
        assert_eq!(committed[0].1, vec!["f1".to_string(), "f2".to_string()]);
    }

    /// An invalid token on `CommitFeedback` is a silent no-op (no commit).
    #[tokio::test]
    async fn commit_feedback_invalid_token_is_noop() {
        let feedback = Arc::new(StubFeedback::default());
        let listener = make_feedback_listener(Arc::new(TokenRegistry::default()), feedback.clone());
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        write_frame(
            &mut client,
            &BrokerMessage::CommitFeedback(BrokerCommitFeedbackRequest {
                token: "bad".into(),
                ids: vec!["f1".into()],
            }),
        )
        .await
        .unwrap();
        let _: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert!(feedback.committed.lock().await.is_empty());
    }

    /// An invalid token returns an empty `{ count: 0 }` envelope (no leak of
    /// whether any feedback exists), never reads the store, and commits nothing.
    #[tokio::test]
    async fn feedback_invalid_token_returns_empty() {
        let feedback = Arc::new(StubFeedback::default());
        *feedback.items.lock().await = vec![pending("f1", "should never be returned")];
        let tokens = Arc::new(TokenRegistry::default());
        let listener = make_feedback_listener(tokens, feedback.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        let msg = BrokerMessage::Feedback(BrokerFeedbackRequest {
            token: "bad-token".into(),
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();

        assert_eq!(resp.outcome["count"], 0);
        assert!(resp.outcome["feedback"].as_array().unwrap().is_empty());
        // The store was never read or committed for an unknown token.
        assert!(feedback.read_conn.lock().await.is_none());
        assert!(feedback.committed.lock().await.is_empty());
    }

    // --- ask_user_question over the listener -------------------------------

    fn ask_msg(token: &str) -> BrokerMessage {
        BrokerMessage::Ask(BrokerAskRequest {
            token: token.into(),
            questions: vec![crate::acp::question::QuestionSpec {
                id: "qq-1".into(),
                question: "Which approach?".into(),
                header: "Approach".into(),
                multi_select: false,
                options: vec![
                    crate::acp::question::QuestionOption {
                        label: "Incremental".into(),
                        description: String::new(),
                    },
                    crate::acp::question::QuestionOption {
                        label: "Rewrite".into(),
                        description: String::new(),
                    },
                ],
                is_secret: false,
            }],
        })
    }

    use crate::acp::question::QuestionAnsweredItem;

    /// An `Ask` registers the question, parks, and — once the user answers —
    /// writes the `{ answers, declined }` envelope back over the same socket.
    #[tokio::test]
    async fn ask_registers_then_answer_resolves_response() {
        let questions = Arc::new(StubQuestion::default());
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_question_listener(tokens, questions.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        write_frame(&mut client, &ask_msg("tok")).await.unwrap();

        // The server must be parked until an answer arrives — no response yet.
        let early = tokio::time::timeout(Duration::from_millis(40), async {
            read_frame::<_, BrokerResponse>(&mut client).await
        })
        .await;
        assert!(early.is_err(), "ask must block until the user answers");

        // Wait for the stub to record the registration, then answer it.
        while questions.registered.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(questions.registered.lock().await[0].0, "parent-conn");
        questions
            .answer(
                "q-1",
                QuestionOutcome {
                    answers: vec![QuestionAnsweredItem {
                        question: "Which approach?".into(),
                        header: "Approach".into(),
                        multi_select: false,
                        selected: vec!["Incremental".into()],
                    }],
                    declined: false,
                },
            )
            .await;

        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(resp.outcome["declined"], false);
        assert_eq!(resp.outcome["answers"][0]["selected"][0], "Incremental");
        assert_eq!(resp.outcome["answers"][0]["header"], "Approach");
    }

    /// A canceled tool call drops the request socket; the listener observes the
    /// peer-close, cancels the pending question, and returns without writing.
    #[tokio::test]
    async fn ask_peer_close_cancels_question() {
        let questions = Arc::new(StubQuestion::default());
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "parent-conn".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        let listener = make_question_listener(tokens, questions.clone());

        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move { listener.serve_one(&mut server).await });
        write_frame(&mut client, &ask_msg("tok")).await.unwrap();

        // Let the server park inside the wait.
        while questions.registered.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // Companion cancels: drop the request socket.
        drop(client);

        let result = tokio::time::timeout(Duration::from_secs(5), server_task)
            .await
            .expect("serve_one must return after peer close");
        result.unwrap().unwrap();
        assert_eq!(questions.canceled.lock().await.as_slice(), &["q-1".to_string()]);
    }

    /// An invalid token never registers a question and returns a `declined`
    /// outcome (the LLM proceeds with its own judgment).
    #[tokio::test]
    async fn ask_invalid_token_declined() {
        let questions = Arc::new(StubQuestion::default());
        let listener = make_question_listener(Arc::new(TokenRegistry::default()), questions.clone());
        let (mut client, mut server) = duplex(8 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        write_frame(&mut client, &ask_msg("bad-token"))
            .await
            .unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        assert_eq!(resp.outcome["declined"], true);
        assert!(questions.registered.lock().await.is_empty());
    }

    // -- browser tools ------------------------------------------------------

    async fn browser_tokens() -> Arc<TokenRegistry> {
        let tokens = Arc::new(TokenRegistry::default());
        tokens
            .register(
                "tok".into(),
                TokenEntry {
                    parent_connection_id: "conn-1".into(),
                    working_dir: PathBuf::from("/tmp"),
                },
            )
            .await;
        tokens
    }

    async fn browser_round_trip(
        listener: Arc<DelegationListener>,
        msg: BrokerMessage,
    ) -> BrokerResponse {
        let (mut client, mut server) = duplex(64 * 1024);
        let server_task = tokio::spawn(async move {
            listener.serve_one(&mut server).await.unwrap();
        });
        write_frame(&mut client, &msg).await.unwrap();
        let resp: BrokerResponse = read_frame(&mut client).await.unwrap();
        server_task.await.unwrap();
        resp
    }

    #[tokio::test]
    async fn browser_tabs_and_snapshot_reach_the_browser_with_their_arguments() {
        let browser = Arc::new(StubBrowser::default());
        let listener = make_browser_listener(browser_tokens().await, browser.clone());

        let listed = browser_round_trip(
            listener.clone(),
            BrokerMessage::BrowserTabs(BrokerBrowserTabsRequest { token: "tok".into() }),
        )
        .await;
        assert_eq!(listed.outcome["tabs"][0]["tabId"], "t1");
        assert_eq!(listed.outcome["tabs"][0]["level"], "read");

        let read = browser_round_trip(
            listener,
            BrokerMessage::BrowserSnapshot(BrokerBrowserSnapshotRequest {
                token: "tok".into(),
                tab_id: "t9".into(),
                max_chars: Some(1234),
            }),
        )
        .await;
        // A refusal travels as a value, not as a transport error: the agent
        // has something to do about it.
        assert_eq!(read.outcome["error"], ERROR_GRANT_REQUIRED);
        assert_eq!(read.outcome["tabId"], "t9");
        assert!(read.outcome["note"].as_str().unwrap().contains("t9"));

        assert_eq!(
            browser.calls.lock().await.as_slice(),
            &["list".to_string(), "snapshot t9 Some(1234)".to_string()]
        );
    }

    /// An action reaches the browser with the whole request — token checked,
    /// nothing reinterpreted on the way — and its refusal comes back as a
    /// value the companion can render.
    #[tokio::test]
    async fn an_action_reaches_the_browser_with_its_request() {
        use crate::browser::agent::{ActionKind, ActionRequest};
        let browser = Arc::new(StubBrowser::default());
        let listener = make_browser_listener(browser_tokens().await, browser.clone());

        let acted = browser_round_trip(
            listener,
            BrokerMessage::BrowserAct(BrokerBrowserActRequest {
                token: "tok".into(),
                tab_id: "t1".into(),
                request: ActionRequest {
                    generation: "g.4.2".into(),
                    target: Some("e5".into()),
                    action: ActionKind::Type {
                        text: "Ada".into(),
                        submit: true,
                    },
                },
            }),
        )
        .await;
        assert_eq!(
            acted.outcome["error"],
            crate::acp::browser_tools::ERROR_CONTROL_REQUIRED
        );
        assert_eq!(acted.outcome["tabId"], "t1");
        assert_eq!(
            browser.calls.lock().await.as_slice(),
            &[r#"act t1 g.4.2 Object {"kind": String("type"), "text": String("Ada"), "submit": Bool(true)}"#
                .to_string()]
        );
    }

    /// The console and screenshot arms carry their whole request through and
    /// bring a refusal back as a value; an invalid token is turned away before
    /// the browser hears of it, like every other browser arm.
    #[tokio::test]
    async fn console_and_capture_reach_the_browser_and_refuse_a_bad_token() {
        use crate::browser::capture::{CaptureFormat, CaptureRequest};
        use crate::browser::console::{ConsoleLevel, ConsoleQuery};
        let browser = Arc::new(StubBrowser::default());
        let listener = make_browser_listener(browser_tokens().await, browser.clone());

        let console = browser_round_trip(
            listener.clone(),
            BrokerMessage::BrowserConsole(BrokerBrowserConsoleRequest {
                token: "tok".into(),
                tab_id: "t2".into(),
                query: ConsoleQuery {
                    since: 7,
                    min_level: Some(ConsoleLevel::Warn),
                    limit: Some(20),
                },
            }),
        )
        .await;
        assert_eq!(console.outcome["error"], ERROR_GRANT_REQUIRED);
        assert_eq!(console.outcome["tabId"], "t2");

        let capture = browser_round_trip(
            listener.clone(),
            BrokerMessage::BrowserCapture(BrokerBrowserCaptureRequest {
                token: "tok".into(),
                tab_id: "t2".into(),
                request: CaptureRequest {
                    generation: Some("g.1.1".into()),
                    target: Some("e4".into()),
                    max_width: Some(800),
                    format: CaptureFormat::Jpeg,
                },
            }),
        )
        .await;
        assert_eq!(capture.outcome["error"], ERROR_GRANT_REQUIRED);
        assert_eq!(
            browser.calls.lock().await.as_slice(),
            &[
                "console t2 since=7 min=Some(Warn) limit=Some(20)".to_string(),
                "capture t2 Some((\"g.1.1\", \"e4\")) Some(800) Jpeg".to_string(),
            ]
        );

        browser.calls.lock().await.clear();
        for message in [
            BrokerMessage::BrowserConsole(BrokerBrowserConsoleRequest {
                token: "not-a-token".into(),
                tab_id: "t1".into(),
                query: ConsoleQuery::default(),
            }),
            BrokerMessage::BrowserCapture(BrokerBrowserCaptureRequest {
                token: "not-a-token".into(),
                tab_id: "t1".into(),
                request: CaptureRequest::default(),
            }),
        ] {
            let out = browser_round_trip(listener.clone(), message).await;
            assert_eq!(out.outcome["error"], ERROR_NO_SUCH_TAB);
        }
        assert!(browser.calls.lock().await.is_empty());
    }

    /// A capture the companion could not read back — over the frame cap —
    /// is turned into a refusal it can, at the last step before the frame.
    #[test]
    fn a_capture_over_the_frame_cap_becomes_a_refusal() {
        use crate::browser::capture::{CaptureOutcome, CaptureRegion};
        let huge = BrowserCaptureOutcome::image(
            "t1",
            CaptureOutcome {
                mime: "image/png".into(),
                data: "A".repeat(CAPTURE_RESPONSE_MAX_BYTES + 1),
                width: 1,
                height: 1,
                url: "http://x/".into(),
                region: CaptureRegion {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                clipped: false,
            },
        );
        let response = browser_capture_response(huge).unwrap();
        assert_eq!(response.outcome["error"], crate::acp::browser_tools::ERROR_READ_FAILED);
        assert_eq!(response.outcome["tabId"], "t1");
        assert!(response.outcome.get("capture").is_none());
        assert!(serde_json::to_vec(&response.outcome).unwrap().len() < 4096);

        let small = BrowserCaptureOutcome::image(
            "t1",
            CaptureOutcome {
                mime: "image/png".into(),
                data: "AAAA".into(),
                width: 1,
                height: 1,
                url: "http://x/".into(),
                region: CaptureRegion {
                    x: 0.0,
                    y: 0.0,
                    width: 1.0,
                    height: 1.0,
                },
                clipped: false,
            },
        );
        assert_eq!(browser_capture_response(small).unwrap().outcome["capture"]["data"], "AAAA");
    }

    /// A caller who cannot prove it is a companion is told the same thing a
    /// user with no tabs open would be told, and the browser is never asked.
    /// Anything else would make the refusal codes a way to enumerate someone's
    /// open pages from outside the process.
    #[tokio::test]
    async fn an_invalid_token_learns_nothing_about_the_tabs() {
        let browser = Arc::new(StubBrowser::default());
        let listener = make_browser_listener(browser_tokens().await, browser.clone());

        let listed = browser_round_trip(
            listener.clone(),
            BrokerMessage::BrowserTabs(BrokerBrowserTabsRequest {
                token: "not-a-token".into(),
            }),
        )
        .await;
        assert_eq!(listed.outcome["tabs"].as_array().unwrap().len(), 0);
        assert!(listed.outcome.get("note").is_none());

        let read = browser_round_trip(
            listener,
            BrokerMessage::BrowserSnapshot(BrokerBrowserSnapshotRequest {
                token: "not-a-token".into(),
                tab_id: "t1".into(),
                max_chars: None,
            }),
        )
        .await;
        // `t1` really is open and really is shared — and the answer is the one
        // a nonexistent tab gets.
        assert_eq!(read.outcome["error"], ERROR_NO_SUCH_TAB);
        assert!(browser.calls.lock().await.is_empty());

        let acted = browser_round_trip(
            make_browser_listener(browser_tokens().await, browser.clone()),
            BrokerMessage::BrowserAct(BrokerBrowserActRequest {
                token: "not-a-token".into(),
                tab_id: "t1".into(),
                request: crate::browser::agent::ActionRequest {
                    generation: "g".into(),
                    target: Some("e1".into()),
                    action: crate::browser::agent::ActionKind::Hover,
                },
            }),
        )
        .await;
        assert_eq!(acted.outcome["error"], ERROR_NO_SUCH_TAB);
        assert!(browser.calls.lock().await.is_empty());
    }

    // -- socket path --------------------------------------------------------

    /// The fallback fires only when it has to. A temp directory short enough
    /// to hold a socket keeps the socket where the user's `TMPDIR` points,
    /// which is every ordinary desktop launch.
    #[cfg(unix)]
    #[test]
    fn a_short_temp_dir_is_used_directly() {
        let path = default_socket_path(Path::new("/tmp"));
        assert_eq!(path.parent(), Some(Path::new("/tmp")));
    }

    /// ...and an over-long one moves to the short directory rather than
    /// composing a path no `connect(2)` could name.
    #[cfg(unix)]
    #[test]
    fn an_over_long_temp_dir_falls_back_to_the_short_socket_dir() {
        let name = format!("codeg-delegation-{}.sock", std::process::id());
        // A macOS `/var/folders/…/T` with codeg's own per-session nesting under
        // it — the shape that actually produces this — padded so the composed
        // path lands exactly ONE byte past what `sun_path` can hold. Sized from
        // the cap rather than hard-coded, so it keeps straddling the boundary
        // if either side of it moves.
        let prefix = "/var/folders/hl/";
        let suffix = "/T/codeg-acp/12345-deadbeef";
        let pad = SUN_PATH_CAP - 1 - name.len() - prefix.len() - suffix.len();
        let ambient = PathBuf::from(format!("{prefix}{}{suffix}", "z".repeat(pad)));
        assert_eq!(ambient.as_os_str().len() + 1 + name.len(), SUN_PATH_CAP);
        assert!(!fits_sun_path(&ambient.join(&name)));

        let path = default_socket_path(&ambient);
        assert_eq!(path.parent(), Some(short_socket_dir().as_path()));
        assert_eq!(path.file_name(), Some(std::ffi::OsStr::new(&name)));
        assert!(
            fits_sun_path(&path),
            "the fallback must fit: {} is {} bytes",
            path.display(),
            path.as_os_str().len()
        );
    }

    /// The STAGED path is measured too, not assumed shorter than the real one.
    ///
    /// `.stg-<pid>-<8 hex>` is shorter than `codeg-delegation-<pid>.sock`, which
    /// is why production never noticed, but it is longer than a short name — so
    /// a short name in a deep directory fits `sun_path` while the path `bind`
    /// actually hands the kernel does not. Refusing both together is what makes
    /// the docstring's "a length limit cannot reject one and admit the other"
    /// true, and with it the case for having no unlink-then-bind fallback.
    ///
    /// Note what this must NOT lean on: the kernel refuses the over-long staged
    /// path by itself, with the same `InvalidInput` kind. Asserting only that
    /// `bind` errs would pass with the staged check deleted (verified by
    /// mutation). The discriminating observable is that NOTHING is touched —
    /// the un-created parent directory stays un-created.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_staged_path_too_long_for_sun_path_is_refused_too() {
        let holder = tempfile::tempdir_in("/tmp").unwrap();
        // Deep enough that `a.sock` still fits and `.stg-…` cannot. Left
        // UNCREATED on purpose — see above.
        let pad = SUN_PATH_CAP - 8 - holder.path().as_os_str().len() - 1;
        let dir = holder.path().join("x".repeat(pad));
        let socket = dir.join("a.sock");
        assert!(
            fits_sun_path(&socket),
            "the real path must fit, or this tests the wrong check"
        );
        assert!(!fits_sun_path(&DelegationListener::staging_socket_path(&socket)));

        let err = DelegationListener::bind(&socket).await.unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
        assert!(
            err.to_string().contains("AF_UNIX"),
            "refused by us, not by the kernel after the fact: {err}"
        );
        assert!(
            !dir.exists(),
            "bind touched the filesystem before refusing: {} was created",
            dir.display()
        );
        assert!(!socket.exists());
    }

    /// The end-to-end claim, asserted against the KERNEL rather than against
    /// [`fits_sun_path`]'s own opinion of itself: what broke was a socket that
    /// could not be DIALED, so drive the whole path — choose, bind, connect.
    ///
    /// The ambient directory handed in here does not exist. That is deliberate:
    /// the fallback must not need it to.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_chosen_socket_path_can_actually_be_bound_and_dialed() {
        let ambient = PathBuf::from(format!(
            "/var/folders/hl/{}/T/codeg-acp/12345-deadbeef",
            "z".repeat(60)
        ));
        let path = default_socket_path(&ambient);

        let bound = DelegationListener::bind(&path).await.expect("bind");
        // No `accept` needed: a connect lands in the listener's backlog.
        let dialed = tokio::net::UnixStream::connect(&path).await;
        drop(bound);
        let _ = std::fs::remove_file(&path);

        assert!(
            dialed.is_ok(),
            "nothing could dial {} ({} bytes): {:?}",
            path.display(),
            path.as_os_str().len(),
            dialed.err()
        );
    }
}
