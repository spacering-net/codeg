//! Lifecycle handle for the codeg-mcp broker socket — the half of the
//! companion round-trip that lives inside codeg's own process.
//!
//! Both runtimes bind the socket once at boot and then forget about it: the
//! accept loop is a detached task, so a bind failure (address taken, `/tmp`
//! not writable) is logged and lost, and a socket the OS later takes away
//! (a `/tmp` reaper on a long-lived desktop session; an admin deleting the
//! file) leaves every subsequently-launched companion talking to nothing,
//! with no way back short of restarting the app.
//!
//! [`DelegationService`] closes both gaps. It owns the bound socket's task
//! handle plus the last bind error, exposes a real end-to-end liveness probe
//! ([`BrokerMessage::Ping`](super::transport::BrokerMessage::Ping)), and can
//! rebind on demand — which is what the workspace status indicator's
//! "start service" button drives.
//!
//! The handle is a process singleton (the socket path is PID-scoped, and each
//! runtime binds exactly one), so bootstrap [`install`]s it and any command
//! handler reaches it through [`current`] rather than threading it through
//! `AppState` and every test constructor.

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use super::listener::DelegationListener;
use super::transport::client_ping;

/// How long a liveness probe may take before the socket is called dead. The
/// listener answers a ping without touching the DB, the broker, or the token
/// registry, so anything slower than this is a hung peer, not a busy one.
pub const PROBE_TIMEOUT: Duration = Duration::from_millis(1_500);

#[derive(Default)]
struct ServiceState {
    /// Accept-loop task for the currently-bound socket. `None` before the
    /// first successful bind and after a failed rebind.
    task: Option<JoinHandle<()>>,
    /// Unix-millis timestamp of the bind that produced `task`.
    started_at: Option<i64>,
    /// Why the last bind attempt failed. Cleared by a successful bind, so a
    /// stale message can't outlive the problem it describes.
    last_error: Option<String>,
}

/// What [`DelegationService::snapshot`] reports about the socket's lifecycle.
/// Deliberately excludes liveness: that comes from a probe, not from
/// bookkeeping, because the two can disagree (a live task whose socket file
/// was deleted underneath it).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ServiceSnapshot {
    /// Whether an accept-loop task exists and has not returned.
    pub task_alive: bool,
    pub started_at: Option<i64>,
    pub last_error: Option<String>,
}

pub struct DelegationService {
    listener: Arc<DelegationListener>,
    socket_path: PathBuf,
    state: Mutex<ServiceState>,
}

impl DelegationService {
    pub fn new(listener: Arc<DelegationListener>, socket_path: PathBuf) -> Arc<Self> {
        Arc::new(Self {
            listener,
            socket_path,
            state: Mutex::new(ServiceState::default()),
        })
    }

    pub fn socket_path(&self) -> &Path {
        &self.socket_path
    }

    /// Bind the socket and spawn its accept loop, replacing whatever was
    /// running before. The bind happens inline so its error reaches the
    /// caller — that error is the whole reason the status indicator can say
    /// *why* the service is down instead of just that it is.
    ///
    /// Used by bootstrap, where there is nothing to replace. A user-driven
    /// restart should go through [`Self::ensure_running`], which will not
    /// rebind over a socket that is already answering.
    pub async fn start(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        self.start_locked(&mut state).await
    }

    /// Start the socket only if it isn't already answering. Idempotent, so the
    /// UI can call it on every click without a second thought.
    ///
    /// The liveness re-check happens INSIDE the state lock. Probing outside it
    /// and then taking the lock would let two callers — two workspace windows
    /// both clicking "start", or a click landing while bootstrap is still
    /// binding — each independently decide the socket is down; they would
    /// serialize, and the second would then tear down the acceptor the first
    /// had just created. Under the lock, the loser re-probes, finds the
    /// winner's socket, and does nothing.
    pub async fn ensure_running(&self) -> Result<(), String> {
        let mut state = self.state.lock().await;
        if self.is_listening().await {
            return Ok(());
        }
        self.start_locked(&mut state).await
    }

    /// Shared body of [`Self::start`] / [`Self::ensure_running`], run with the
    /// state lock held.
    ///
    /// Two ordering rules, both there so a restart can never leave the service
    /// worse off than it found it — the failure mode that matters most, since
    /// this is the *recovery* action:
    ///
    /// 1. **Windows: never replace a live accept loop.** A named pipe lives in
    ///    the kernel object namespace, so — unlike a unix socket file, which a
    ///    `/tmp` reaper can unlink out from under a running loop — its name
    ///    cannot disappear while the loop holds an instance. A live loop
    ///    therefore always implies a reachable pipe, and a probe that says
    ///    otherwise is a false negative (all instances momentarily busy, or a
    ///    stalled runtime), not a fault to repair. Rebinding on that signal
    ///    would abort a working acceptor and then very likely fail to replace
    ///    it: `first_pipe_instance` is refused while ANY instance exists, and
    ///    the connection workers this loop spawned are deliberately left
    ///    running — a parked `ask_user_question` holds its instance until a
    ///    human answers, an unbounded `get_delegation_status` until a child's
    ///    turn ends. The result would be no acceptor at all, for as long as
    ///    that connection lives. So on Windows a live loop is reported as
    ///    already-running and left alone.
    ///
    ///    What remains is narrow and fails safely: if the loop has genuinely
    ///    died while such a worker is still parked, the rebind returns
    ///    `PermissionDenied` and the caller sees it. Nothing was destroyed to
    ///    get there — the acceptor was already gone.
    ///
    /// 2. **Bind before retiring the old loop.** A failed bind then leaves the
    ///    existing acceptor untouched instead of having already killed it. On
    ///    unix the new socket takes over the path via an atomic rename (see
    ///    [`DelegationListener::bind`], which never unlinks the destination),
    ///    so the path is continuously served and the old loop is simply left
    ///    holding the inode that path no longer names; it is retired
    ///    immediately below. (On Windows rule 1 means we only ever get here
    ///    with no live loop to protect.)
    ///
    /// 3. **Nothing awaits between a successful bind and the commit.** This
    ///    function runs inside an axum handler / Tauri command whose future is
    ///    dropped if the caller goes away — a user who clicks "start" and then
    ///    closes the window. An await in that stretch would let the cancellation
    ///    land with the replacement socket bound but never installed: it would
    ///    be dropped, leaving a dead socket file owning the path while the old
    ///    loop sat on the inode that path no longer names. Silently unreachable,
    ///    and `state` would still claim the old acceptor was fine. Keeping the
    ///    stretch await-free makes bind-then-commit atomic against cancellation.
    ///
    /// In-flight companion round-trips survive a restart either way — each runs
    /// in its own task, spawned off the loop rather than inside it.
    async fn start_locked(&self, state: &mut ServiceState) -> Result<(), String> {
        #[cfg(windows)]
        if state.task.as_ref().is_some_and(|t| !t.is_finished()) {
            tracing::info!(
                "[delegation] accept loop is still running on {}; not rebinding \
                 (a named pipe cannot be unlinked, so there is nothing to repair)",
                self.socket_path.display()
            );
            return Ok(());
        }

        let bound = match DelegationListener::bind(&self.socket_path).await {
            Ok(bound) => bound,
            Err(e) => {
                let msg = e.to_string();
                tracing::error!(
                    "[delegation] failed to bind {}: {msg}",
                    self.socket_path.display()
                );
                // Leave `task` alone: the bind failed, so whatever was serving
                // before (if anything) is still the best we have.
                state.last_error = Some(msg.clone());
                return Err(msg);
            }
        };
        // Abort WITHOUT joining, so that everything from here to the commit
        // below is await-free — see rule 3 on this function. The retired loop
        // is harmless in the meantime: on unix its socket was just unlinked out
        // from under it (the replacement now owns the path), so it can only
        // accept on a nameless inode nobody can dial; on Windows rule 1 means
        // there is never a live loop here to begin with.
        if let Some(task) = state.task.take() {
            task.abort();
        }
        let listener = Arc::clone(&self.listener);
        let socket_path = self.socket_path.clone();
        state.task = Some(tokio::spawn(async move {
            if let Err(e) = listener.accept_loop(bound, socket_path).await {
                tracing::info!("[delegation] listener exited: {e}");
            }
        }));
        state.started_at = Some(chrono::Utc::now().timestamp_millis());
        state.last_error = None;
        Ok(())
    }

    /// Round-trip a ping over the real socket. This — not the task handle —
    /// is the answer to "is the service running?": an accept loop can be alive
    /// while its socket file is gone, and a socket file can exist long after
    /// the process that bound it died.
    pub async fn is_listening(&self) -> bool {
        probe_socket(&self.socket_path).await
    }

    pub async fn snapshot(&self) -> ServiceSnapshot {
        let state = self.state.lock().await;
        ServiceSnapshot {
            task_alive: state.task.as_ref().is_some_and(|t| !t.is_finished()),
            started_at: state.started_at,
            last_error: state.last_error.clone(),
        }
    }
}

/// Ping `socket_path` under [`PROBE_TIMEOUT`], answering only "did a listener
/// serve this". Every failure mode — no such socket, connection refused, a
/// peer that accepts but never answers — collapses to `false`, which is
/// exactly the granularity the caller acts on.
pub async fn probe_socket(socket_path: &Path) -> bool {
    let path = socket_path.to_string_lossy().to_string();
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, client_ping(&path)).await,
        Ok(Ok(_))
    )
}

static SERVICE: OnceLock<Arc<DelegationService>> = OnceLock::new();

/// Publish the process's delegation service so command handlers can find it.
/// First writer wins; a second call is a no-op, because a process that bound
/// two sockets would have two of everything and the status indicator could
/// only ever report one.
pub fn install(service: Arc<DelegationService>) {
    if SERVICE.set(service).is_err() {
        tracing::warn!("[delegation] service handle already installed; ignoring second install");
    }
}

/// The installed service, or `None` in a runtime that never bound a socket
/// (unit tests, `AppState::new_for_test`). Callers must degrade rather than
/// unwrap: no handle means "cannot start it from here", not "it is broken".
pub fn current() -> Option<Arc<DelegationService>> {
    SERVICE.get().cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::delegation::broker::{ConversationDepthLookup, DelegationBroker};
    use crate::acp::delegation::listener::{ParentSessionLookup, TokenRegistry};
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::DelegationError;
    use async_trait::async_trait;

    /// One stub for every access trait `DelegationListener::new` demands. The
    /// ping arm answers before any of them is consulted, which is the point of
    /// these tests — so every method is unreachable in practice.
    struct Stub;

    #[async_trait]
    impl ConversationDepthLookup for Stub {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    #[async_trait]
    impl ParentSessionLookup for Stub {
        async fn current_conversation_id(&self, _parent_connection_id: &str) -> Option<i32> {
            None
        }
    }

    #[async_trait]
    impl crate::acp::feedback::SessionFeedbackAccess for Stub {
        async fn read_pending_feedback(
            &self,
            _parent_connection_id: &str,
        ) -> Vec<crate::acp::feedback::PendingFeedback> {
            Vec::new()
        }
        async fn commit_feedback_delivered(
            &self,
            _parent_connection_id: &str,
            _ids: Vec<String>,
        ) {
        }
    }

    #[async_trait]
    impl crate::acp::question::SessionQuestionAccess for Stub {
        async fn register_question(
            &self,
            _parent_connection_id: &str,
            _questions: Vec<crate::acp::question::QuestionSpec>,
        ) -> Option<crate::acp::question::RegisteredQuestion> {
            None
        }
        async fn cancel_question(&self, _parent_connection_id: &str, _question_id: &str) {}
        async fn cancel_questions_by_parent(&self, _parent_connection_id: &str) {}
    }

    #[async_trait]
    impl crate::acp::session_info::SessionInfoAccess for Stub {
        async fn resolve(
            &self,
            session_id: i32,
            _max_messages: u32,
        ) -> crate::acp::session_info::SessionInfo {
            crate::acp::session_info::SessionInfo::not_found(session_id)
        }
    }

    #[async_trait]
    impl crate::acp::work_task_tools::WorkTaskToolAccess for Stub {
        async fn report_progress(
            &self,
            _parent_connection_id: &str,
            _message: &str,
        ) -> crate::acp::work_task_tools::TaskReportAck {
            crate::acp::work_task_tools::TaskReportAck::rejected("stub")
        }
        async fn complete(
            &self,
            _parent_connection_id: &str,
            _verdict: &str,
            _summary: Option<&str>,
        ) -> crate::acp::work_task_tools::TaskReportAck {
            crate::acp::work_task_tools::TaskReportAck::rejected("stub")
        }
    }

    #[async_trait]
    impl crate::acp::chat_authoring::ChatAuthoringAccess for Stub {
        async fn create_automation(
            &self,
            _ctx: crate::acp::chat_authoring::AuthoringContext,
            _spec: crate::acp::chat_authoring::NewAutomationSpec,
        ) -> crate::acp::chat_authoring::AuthoringOutcome {
            crate::acp::chat_authoring::AuthoringOutcome::default()
        }
        async fn create_work_task(
            &self,
            _ctx: crate::acp::chat_authoring::AuthoringContext,
            _spec: crate::acp::chat_authoring::NewWorkTaskSpec,
        ) -> crate::acp::chat_authoring::AuthoringOutcome {
            crate::acp::chat_authoring::AuthoringOutcome::default()
        }
    }

    #[async_trait]
    impl crate::acp::browser_tools::BrowserToolAccess for Stub {
        async fn list_tabs(&self) -> crate::acp::browser_tools::BrowserTabsOutcome {
            Default::default()
        }
        async fn snapshot(
            &self,
            tab_id: &str,
            _max_chars: Option<usize>,
        ) -> crate::acp::browser_tools::BrowserSnapshotOutcome {
            crate::acp::browser_tools::BrowserSnapshotOutcome::refused(
                tab_id,
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                "stub",
            )
        }

        async fn console(
            &self,
            tab_id: &str,
            _query: crate::browser::console::ConsoleQuery,
        ) -> crate::acp::browser_tools::BrowserConsoleOutcome {
            crate::acp::browser_tools::BrowserConsoleOutcome::refused(
                tab_id,
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                "stub",
            )
        }

        async fn eval(
            &self,
            tab_id: &str,
            _request: crate::browser::eval::EvalRequest,
        ) -> crate::acp::browser_tools::BrowserEvalOutcome {
            crate::acp::browser_tools::BrowserEvalOutcome::refused(
                tab_id,
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                "stub",
            )
        }

        async fn tab_op(
            &self,
            op: crate::acp::browser_tools::BrowserTabOp,
        ) -> crate::acp::browser_tools::BrowserTabOutcome {
            crate::acp::browser_tools::BrowserTabOutcome::refused(
                op.tab_id(),
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                "stub",
            )
        }

        async fn capture(
            &self,
            tab_id: &str,
            _request: crate::browser::capture::CaptureRequest,
        ) -> crate::acp::browser_tools::BrowserCaptureOutcome {
            crate::acp::browser_tools::BrowserCaptureOutcome::refused(
                tab_id,
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                "stub",
            )
        }

        async fn act(
            &self,
            tab_id: &str,
            _request: crate::browser::agent::ActionRequest,
        ) -> crate::acp::browser_tools::BrowserActOutcome {
            crate::acp::browser_tools::BrowserActOutcome::refused(
                tab_id,
                crate::acp::browser_tools::ERROR_UNAVAILABLE,
                crate::acp::browser_tools::NO_BROWSER_NOTE,
            )
        }
    }

    /// A temp directory short enough to bind a socket inside, whatever the
    /// ambient `$TMPDIR` happens to be.
    ///
    /// `tempfile::tempdir()` honours `$TMPDIR`, and these tests then add
    /// `/.tmpXXXXXX/codeg-delegation-*.sock` on top — about 38 bytes. That is
    /// fine against the ~20-byte default and fatal against codeg's own
    /// per-session `TMPDIR`, which is 72 bytes (`/var/folders/…/T/codeg-acp/
    /// <pid>-<hex>`): the composed path reaches 110 and `sun_path` caps at 104
    /// on macOS. The whole suite went red inside a codeg session and green
    /// outside it, for reasons having nothing to do with the code under test.
    ///
    /// Rooting in `/tmp` — the same move `scratch_dir`'s socket tests make —
    /// keeps the result near 40 bytes no matter what the environment says.
    fn socket_dir() -> tempfile::TempDir {
        #[cfg(unix)]
        {
            tempfile::tempdir_in("/tmp").unwrap()
        }
        #[cfg(not(unix))]
        {
            // Windows addresses these tests to the named-pipe namespace, which
            // ignores the directory entirely; there is no budget to protect.
            tempfile::tempdir().unwrap()
        }
    }

    /// A socket path exactly one byte past what `sun_path` can hold, inside
    /// `holder`. Sized from the cap rather than hard-coded, so it keeps
    /// straddling the boundary if either side of it moves.
    ///
    /// The parent directory is deliberately NOT created. `bind` is supposed to
    /// refuse before it touches the filesystem, so its absence afterwards is
    /// the observable that proves it — and a pre-created parent would destroy
    /// that: `create_dir_all` on a directory that already exists creates
    /// nothing, so the check could be moved below it and the test would still
    /// pass.
    #[cfg(unix)]
    fn over_long_socket_path(holder: &Path) -> PathBuf {
        const NAME: &str = "codeg-delegation-unreachable.sock";
        let cap = crate::acp::scratch_dir::SUN_PATH_CAP;
        // holder + '/' + pad + '/' + NAME == cap, i.e. one past the cap - 1
        // bytes a path may actually occupy.
        let pad = cap - holder.as_os_str().len() - 2 - NAME.len();
        let path = holder.join("x".repeat(pad)).join(NAME);
        assert_eq!(path.as_os_str().len(), cap);
        path
    }

    fn make_service(socket_path: PathBuf) -> Arc<DelegationService> {
        let broker = Arc::new(DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(Stub) as Arc<dyn ConversationDepthLookup>,
        ));
        let listener = DelegationListener::new(
            broker,
            Arc::new(TokenRegistry::default()),
            Arc::new(Stub),
            Arc::new(Stub),
            Arc::new(Stub),
            Arc::new(Stub),
            Arc::new(Stub),
            Arc::new(Stub),
            Arc::new(Stub),
        );
        DelegationService::new(listener, socket_path)
    }

    /// The whole point of the handle: a bind error is returned, not swallowed
    /// by a detached task.
    #[tokio::test]
    async fn start_reports_bind_failure_and_records_it() {
        let dir = socket_dir();
        // A directory is not a bindable socket address on either platform.
        let unbindable = dir.path().join("nested").join("dir");
        std::fs::create_dir_all(&unbindable).unwrap();
        let service = make_service(unbindable);

        let err = service.start().await.unwrap_err();
        assert!(!err.is_empty());
        let snap = service.snapshot().await;
        assert!(!snap.task_alive);
        assert_eq!(snap.last_error.as_deref(), Some(err.as_str()));
        assert!(snap.started_at.is_none());
    }

    #[tokio::test]
    async fn probe_answers_false_for_an_unbound_path() {
        let dir = socket_dir();
        assert!(!probe_socket(&dir.path().join("nobody-here.sock")).await);
    }

    /// Bind → probe answers → rebind → probe still answers. The rebind arm is
    /// what the status indicator's start button exercises when the socket was
    /// yanked out from under a live accept loop.
    #[cfg(unix)]
    #[tokio::test]
    async fn start_binds_probeable_socket_and_survives_a_restart() {
        let dir = socket_dir();
        let socket = dir.path().join("codeg-delegation-test.sock");
        let service = make_service(socket.clone());

        service.start().await.unwrap();
        assert!(service.is_listening().await);
        let first = service.snapshot().await;
        assert!(first.task_alive);
        assert!(first.started_at.is_some());
        assert!(first.last_error.is_none());

        // Yank the socket file: the accept loop is still alive, but nothing can
        // reach it any more — the exact state a /tmp reaper leaves behind.
        std::fs::remove_file(&socket).unwrap();
        assert!(!service.is_listening().await);
        assert!(service.snapshot().await.task_alive);

        service.ensure_running().await.unwrap();
        assert!(service.is_listening().await);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn ensure_running_is_a_noop_while_the_socket_answers() {
        let dir = socket_dir();
        let service = make_service(dir.path().join("codeg-delegation-noop.sock"));

        service.start().await.unwrap();
        let before = service.snapshot().await.started_at;
        service.ensure_running().await.unwrap();
        // Unchanged timestamp ⇒ no rebind happened.
        assert_eq!(service.snapshot().await.started_at, before);
    }

    /// Restarting is the RECOVERY action, so a restart that fails must not
    /// leave the service worse off than it found it. Two rules conspire to
    /// guarantee that, and this test pins both: `start_locked` binds before it
    /// retires, and `DelegationListener::bind` stages + renames rather than
    /// unlinking the destination — so neither the acceptor task nor the socket
    /// path clients are dialing can be destroyed by a bind that then fails.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_failed_rebind_leaves_the_working_acceptor_alone() {
        use std::os::unix::fs::PermissionsExt;

        let dir = socket_dir();
        let nest = dir.path().join("nest");
        std::fs::create_dir(&nest).unwrap();
        let socket = nest.join("codeg-delegation-keep.sock");
        let service = make_service(socket.clone());

        service.start().await.unwrap();
        assert!(service.is_listening().await);
        let before = service.snapshot().await;

        // Drop write permission on the containing directory: both the unlink
        // and the bind inside `DelegationListener::bind` now fail with EACCES,
        // while the already-bound socket keeps working.
        std::fs::set_permissions(&nest, std::fs::Permissions::from_mode(0o500)).unwrap();

        let err = service.start().await.unwrap_err();
        assert!(!err.is_empty());

        let after = service.snapshot().await;
        assert!(after.task_alive, "the acceptor must survive a failed rebind");
        assert_eq!(
            after.started_at, before.started_at,
            "a failed rebind must not look like a successful one"
        );
        assert_eq!(after.last_error.as_deref(), Some(err.as_str()));
        assert!(
            socket.exists(),
            "a failed rebind must not unlink the socket clients are dialing"
        );
        assert!(
            service.is_listening().await,
            "clients must still reach the socket after a failed rebind"
        );

        // Restore so the tempdir can clean itself up.
        std::fs::set_permissions(&nest, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    /// A successful rebind hands the path over to a genuinely new socket and
    /// cleans up after itself: the inode moves, the path stays present and
    /// answering, and no `.stg-*` entry is left behind.
    ///
    /// Note what this does NOT pin: that the path is never *momentarily*
    /// absent. That is a transient of the rename-vs-unlink choice which an
    /// after-the-fact assertion cannot see (unlink-then-bind would end in the
    /// same observable state), and racing an observer against a microsecond
    /// window would only buy a flaky test. The failure contract in
    /// `a_failed_rebind_leaves_the_working_acceptor_alone` is what actually
    /// guards the behaviour that matters.
    #[cfg(unix)]
    #[tokio::test]
    async fn rebinding_replaces_the_socket_without_ever_unlinking_the_path() {
        use std::os::unix::fs::MetadataExt;

        let dir = socket_dir();
        let socket = dir.path().join("codeg-delegation-swap.sock");
        let service = make_service(socket.clone());

        service.start().await.unwrap();
        let first_inode = std::fs::metadata(&socket).unwrap().ino();
        assert!(service.is_listening().await);

        service.start().await.unwrap();
        assert!(socket.exists(), "the path must survive the handover");
        assert!(service.is_listening().await);
        assert_ne!(
            std::fs::metadata(&socket).unwrap().ino(),
            first_inode,
            "the path should now name the replacement socket"
        );

        // No `.stg-*` litter: a staged socket is either renamed into place or
        // cleaned up.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.starts_with(".stg-"))
            .collect();
        assert!(leftovers.is_empty(), "staging left behind: {leftovers:?}");
    }

    /// Two windows clicking "start" at once — or a click landing while
    /// bootstrap is still binding — must not have the loser tear down the
    /// acceptor the winner just created. The liveness re-check lives inside the
    /// state lock precisely so the loser sees the winner's socket and stops.
    ///
    /// On unix the loser's rebind would merely churn, so this is a regression
    /// net rather than a reproduction: the destructive version of this race is
    /// Windows-only (`first_pipe_instance` refuses the replacement while a
    /// parked connection worker still holds an instance), and cannot be
    /// exercised from here.
    #[cfg(unix)]
    #[tokio::test]
    async fn concurrent_ensure_running_calls_settle_on_one_acceptor() {
        let dir = socket_dir();
        let service = make_service(dir.path().join("codeg-delegation-race.sock"));

        let results = futures::future::join_all(
            (0..4).map(|_| {
                let service = Arc::clone(&service);
                async move { service.ensure_running().await }
            }),
        )
        .await;
        assert!(
            results.iter().all(Result::is_ok),
            "every caller should report success: {results:?}"
        );

        let snap = service.snapshot().await;
        assert!(snap.task_alive);
        assert!(snap.last_error.is_none());
        assert!(service.is_listening().await);

        // And the settled service is stable: another call still changes nothing.
        let before = snap.started_at;
        service.ensure_running().await.unwrap();
        assert_eq!(service.snapshot().await.started_at, before);
    }

    /// A socket path too long to dial must be REFUSED, never published.
    ///
    /// `DelegationListener::bind` binds a short `.stg-*` sibling and renames it
    /// onto the real path, and `rename(2)` answers to `PATH_MAX`, not to
    /// `sun_path`. So an over-long path used to bind, publish and return `Ok`:
    /// the socket file appeared, `start()` succeeded, and `snapshot()` reported
    /// `task_alive` with no `last_error` — a service the status indicator
    /// called healthy while every `connect(2)` to it failed with EINVAL and no
    /// companion process could reach the broker at all.
    ///
    /// The silence is the bug this pins. A bind that simply failed was never
    /// the dangerous case.
    #[cfg(unix)]
    #[tokio::test]
    async fn start_never_reports_success_for_a_socket_nobody_can_reach() {
        let holder = socket_dir();
        let socket = over_long_socket_path(holder.path());
        let service = make_service(socket.clone());

        let err = service.start().await.unwrap_err();
        assert!(
            err.contains("AF_UNIX"),
            "the error should name the limit that was hit: {err}"
        );

        assert!(
            !socket.exists(),
            "a socket nothing can dial must not be published at {}",
            socket.display()
        );
        assert!(!service.is_listening().await);

        let snap = service.snapshot().await;
        assert!(!snap.task_alive);
        assert!(snap.started_at.is_none());
        assert_eq!(snap.last_error.as_deref(), Some(err.as_str()));

        // Refused BEFORE the first filesystem call, which is what keeps the
        // "a failed bind leaves an incumbent untouched" invariant free: there
        // is no staged entry and no directory creation to undo. The parent was
        // never created by this test (see `over_long_socket_path`), so its
        // continued absence is exactly that claim — move the length check below
        // `create_dir_all` and this fires.
        let parent = socket.parent().unwrap();
        assert!(
            !parent.exists(),
            "bind touched the filesystem: {} was created",
            parent.display()
        );
    }
}
