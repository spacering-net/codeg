use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use agent_client_protocol::schema::v1::{
    CreateTerminalRequest, CreateTerminalResponse, KillTerminalRequest, KillTerminalResponse,
    ReleaseTerminalRequest, ReleaseTerminalResponse, TerminalExitStatus, TerminalOutputRequest,
    TerminalOutputResponse, WaitForTerminalExitRequest, WaitForTerminalExitResponse,
};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::{watch, Mutex, Notify, RwLock};
use tokio::task::JoinHandle;

use crate::browser::service_url::ServiceScanner;
use crate::browser::services::ServiceWatch;
use crate::terminal::shell_flavor::{classify_shell_family, ShellFamily};

type TerminalMap = HashMap<String, Arc<TerminalInstance>>;
const DEFAULT_OUTPUT_BYTE_LIMIT: u64 = 1_000_000;
/// After the child process exits, wait up to this long for the stdout/stderr
/// reader tasks to drain naturally before aborting them. Needed because a
/// grandchild process (e.g. Node spawned from a `.cmd` shim on Windows) can
/// inherit the pipe handle and keep it open long after the direct child
/// exits, turning `wait_for_exit` into a silent hang.
const READER_DRAIN_GRACE: Duration = Duration::from_millis(200);
/// How long a killed command gets to honor `SIGTERM` before the owner task
/// escalates to `SIGKILL`. `kill_tree` only sends `SIGTERM` by default, which a
/// process that traps it can ignore forever.
const KILL_ESCALATE_GRACE: Duration = Duration::from_secs(2);
/// How long `kill_command` waits to be able to *report* that the process is
/// gone. Bounding the report keeps session teardown and the cancel path
/// responsive; it does NOT abandon the process — the owner task holds the
/// `Child` and keeps reaping past this deadline.
const KILL_REPORT_BUDGET: Duration = Duration::from_secs(5);
/// Backoff cap between retries when `Child::wait` itself fails.
const WAIT_RETRY_MAX_BACKOFF: Duration = Duration::from_secs(1);
/// How long the owner task retries a failing `Child::wait` before publishing a
/// terminal state anyway. Without this, a persistently failing wait would pin
/// `TerminalCompletion::Running` forever and any agent that polls
/// `terminal/output` (rather than calling `terminal/wait_for_exit`) would hang —
/// the very bug this module was rewritten to remove. The owner task keeps
/// owning and reaping the child afterwards; only the *reporting* is unblocked.
const WAIT_ERROR_BUDGET: Duration = Duration::from_secs(30);
/// Retry cadence after `WAIT_ERROR_BUDGET` is spent and completion has already
/// been published. Purely janitorial at that point, so it can be slow.
const WAIT_ERROR_IDLE_RETRY: Duration = Duration::from_secs(5);

#[derive(Debug)]
pub enum TerminalRuntimeError {
    InvalidParams(String),
    Internal(String),
}

impl TerminalRuntimeError {
    pub fn into_rpc_error(self) -> agent_client_protocol::Error {
        match self {
            Self::InvalidParams(message) => agent_client_protocol::Error::invalid_params().data(message),
            Self::Internal(message) => agent_client_protocol::util::internal_error(message),
        }
    }
}

#[derive(Debug, Default, Clone)]
struct TerminalSnapshot {
    output: String,
    output_base_offset: u64,
    truncated: bool,
    exit_status: Option<TerminalExitStatus>,
}

/// What the owner task has published about the child process. Two states only:
/// either it is still running, or it is **known** to be gone.
///
/// There is deliberately no "failed" state. An unknown-but-maybe-finished state
/// would be indistinguishable from `Running` to `terminal/output` consumers
/// (`exit_status: None` reads as "still going"), which is exactly how an agent
/// turn hangs forever.
#[derive(Debug, Clone)]
enum TerminalCompletion {
    Running,
    /// The process is gone. Carries the real status when `Child::wait`
    /// reported one; carries an empty [`TerminalExitStatus`] (no code, no
    /// signal — ACP's "finished, details unknown") when the status is
    /// unknowable, e.g. something else reaped the child out from under us.
    Exited(TerminalExitStatus),
}

/// One ACP terminal's share of the dev-server watch.
///
/// An agent that runs `pnpm dev` through `terminal/create` has started a
/// server exactly as much as a person typing it in the terminal panel has,
/// and the address only ever appears in this output. The scanner is
/// thread-confined elsewhere; here two reader tasks (stdout and stderr) feed
/// the same one, so it takes a lock of its own — never the snapshot's, which
/// `terminal/output` polls.
struct TerminalServiceWatch {
    watch: ServiceWatch,
    terminal_id: String,
    scanner: std::sync::Mutex<ServiceScanner>,
}

struct TerminalInstance {
    session_id: String,
    output_limit: Option<usize>,
    /// `None` when the runtime was built without a watch (tests, the
    /// delegation probe, any caller with no window to tell).
    service: Option<TerminalServiceWatch>,
    snapshot: Mutex<TerminalSnapshot>,
    reader_handles: Mutex<Vec<JoinHandle<()>>>,
    /// Asks the owner task to kill the process tree.
    ///
    /// Callers signal rather than holding a pid of their own, so every kill
    /// runs while the owner still holds the **un-reaped** `Child`. That is what
    /// makes the pid safe to signal: an un-reaped child keeps its pid reserved,
    /// so it cannot have been recycled onto some unrelated process.
    kill: Notify,
    /// Terminal state, published by the owner task.
    ///
    /// Always written with `send_replace`, never `send`: a `watch` **discards**
    /// a value sent while no receiver exists (see the `Sender::new` doc in
    /// tokio's `sync/watch.rs`, which asserts `send(..).is_err()`), so a
    /// short-lived command that exits before anyone subscribes would strand
    /// every later waiter.
    completion: watch::Sender<TerminalCompletion>,
}

impl TerminalInstance {
    fn new(
        session_id: String,
        output_limit: Option<u64>,
        service: Option<TerminalServiceWatch>,
    ) -> Self {
        Self {
            session_id,
            output_limit: output_limit.and_then(|v| usize::try_from(v).ok()),
            service,
            snapshot: Mutex::new(TerminalSnapshot::default()),
            reader_handles: Mutex::new(Vec::new()),
            kill: Notify::new(),
            completion: watch::Sender::new(TerminalCompletion::Running),
        }
    }

    /// Wait briefly for stdout/stderr reader tasks to finish; abort any that
    /// remain. Must be called after the direct child has already exited —
    /// otherwise we would abort readers that are still making progress.
    async fn drain_readers(&self) {
        let handles: Vec<JoinHandle<()>> = std::mem::take(&mut *self.reader_handles.lock().await);
        for handle in handles {
            let abort = handle.abort_handle();
            if tokio::time::timeout(READER_DRAIN_GRACE, handle)
                .await
                .is_err()
            {
                abort.abort();
            }
        }
    }

    async fn append_output(&self, text: &str) {
        // Before the snapshot lock, and never holding both: the watch does no
        // I/O of its own (it hands each candidate to a thread that probes),
        // but `terminal/output` polls the snapshot and must not queue behind
        // a scan of a chunk it is not waiting for.
        if let Some(service) = &self.service {
            let mut scanner = service
                .scanner
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            service.watch.feed(&mut scanner, text, &service.terminal_id);
        }
        let mut snapshot = self.snapshot.lock().await;
        snapshot.output.push_str(text);
        if let Some(limit) = self.output_limit {
            let removed = enforce_output_limit(&mut snapshot.output, limit);
            if removed > 0 {
                snapshot.truncated = true;
                snapshot.output_base_offset = snapshot
                    .output_base_offset
                    .saturating_add(u64::try_from(removed).unwrap_or(u64::MAX));
            }
        }
    }

    /// Block until the owner task publishes a terminal state.
    ///
    /// Holds no lock for the duration, so `terminal/output`, `terminal/kill`
    /// and the session cancel path stay responsive while a never-exiting
    /// command (a dev server, `tail -f`, a watcher) is still running.
    async fn wait_for_exit(&self) -> Result<TerminalExitStatus, TerminalRuntimeError> {
        let mut completion = self.completion.subscribe();
        loop {
            let current = completion.borrow_and_update().clone();
            if let TerminalCompletion::Exited(exit_status) = current {
                return Ok(exit_status);
            }
            if completion.changed().await.is_err() {
                return Err(TerminalRuntimeError::Internal(
                    "terminal owner task ended without publishing an exit status".to_string(),
                ));
            }
        }
    }

    async fn kill_command(&self) -> Result<(), TerminalRuntimeError> {
        if matches!(
            *self.completion.borrow(),
            TerminalCompletion::Exited(_)
        ) {
            return Ok(());
        }

        // The owner task performs the kill; see `TerminalInstance::kill`.
        self.kill.notify_one();

        // Bound only how long we wait to *report*. The owner task keeps the
        // `Child` and keeps escalating and reaping regardless, so returning
        // early here never abandons the process — even once `release_terminal`
        // has already dropped this terminal from the map.
        if tokio::time::timeout(KILL_REPORT_BUDGET, self.wait_for_exit())
            .await
            .is_err()
        {
            tracing::warn!(
                "[ACP] terminal for session {} did not reap within {:?} of being killed; \
                 the owner task keeps trying",
                self.session_id,
                KILL_REPORT_BUDGET
            );
        }
        Ok(())
    }

    async fn snapshot(&self) -> TerminalSnapshot {
        self.snapshot.lock().await.clone()
    }
}

/// Signal a whole process tree, returning the pids the pass actually signalled.
///
/// `kill_tree` snapshots the tree, signals it children-first, and returns
/// immediately without waiting for anything to die. A descendant that ignores
/// the signal therefore outlives its parent and gets reparented away from
/// `pid`, at which point no snapshot rooted at `pid` can find it again. The
/// returned pids are the only remaining handle on such a survivor.
async fn signal_tree(pid: Option<u32>, signal: &str) -> Vec<u32> {
    let Some(pid) = pid else {
        return Vec::new();
    };
    let config = kill_tree::Config {
        signal: signal.to_string(),
        include_target: true,
    };
    match kill_tree::tokio::kill_tree_with_config(pid, &config).await {
        Ok(outputs) => outputs
            .into_iter()
            .filter_map(|output| match output {
                kill_tree::Output::Killed { process_id, .. } => Some(process_id),
                kill_tree::Output::MaybeAlreadyTerminated { .. } => None,
            })
            .collect(),
        Err(err) => {
            tracing::error!("[ACP] kill_tree({signal}) failed for pid {pid}: {err}");
            Vec::new()
        }
    }
}

/// `SIGKILL` any recorded descendant that outlived the graceful pass.
///
/// Best-effort by construction: survivors are identified by pid alone, so a pid
/// recycled inside the escalation window could in principle be signalled by
/// mistake. That is the same trade-off `pkill -P`-style cleanup makes, and it
/// is the price of reaching a descendant that has been reparented away. `root`
/// is skipped — it is the direct child, whose pid is already protected by the
/// un-reaped `Child` handle the owner task holds.
async fn sweep_survivors(signalled: &HashSet<u32>, root: Option<u32>) {
    for &pid in signalled {
        if Some(pid) == root {
            continue;
        }
        signal_tree(Some(pid), "SIGKILL").await;
    }
}

/// True when `Child::wait` failed because the child was already reaped by
/// something else, which means the process **is** gone but its status is lost
/// forever — and, critically, that its pid is now free for reuse and must not
/// be signalled.
///
/// Unix-only on purpose: on Windows `raw_os_error` carries Win32 codes, a
/// different namespace from the CRT errno `libc::ECHILD` belongs to. Mirrors
/// the `cfg`-guarded errno check in `crate::process::is_exec_busy`.
#[cfg(unix)]
fn is_already_reaped(err: &std::io::Error) -> bool {
    err.raw_os_error() == Some(libc::ECHILD)
}

#[cfg(not(unix))]
fn is_already_reaped(_err: &std::io::Error) -> bool {
    false
}

/// Sole owner of a spawned terminal's `Child` for the process's whole life.
///
/// Everything else in this module reads a snapshot or signals this task, which
/// is what keeps `terminal/output`, `terminal/kill` and session teardown off
/// the unbounded `Child::wait`. The task ends only once the process is **known**
/// to be gone, so it never drops a possibly-live child (tokio does not kill on
/// drop, and codeg never sets `kill_on_drop`).
async fn own_terminal_process(terminal: Arc<TerminalInstance>, mut child: tokio::process::Child) {
    let pid = child.id();
    // Cumulative across every pass, never overwritten: a later `SIGKILL` pass
    // re-snapshots the (by then smaller) tree, so only the union still holds a
    // descendant that was recorded earlier and has since been reparented.
    let mut signalled: HashSet<u32> = HashSet::new();
    let mut escalate_at: Option<tokio::time::Instant> = None;
    let mut kill_requested = false;
    let mut escalated = false;
    // State for the `Child::wait`-keeps-failing path.
    let mut backoff = Duration::from_millis(10);
    let mut wait_error_deadline: Option<tokio::time::Instant> = None;
    let mut published_without_reaping = false;

    let exit_status = loop {
        let escalate = async {
            match escalate_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            reaped = child.wait() => match reaped {
                Ok(status) => break map_exit_status(status),
                Err(err) if is_already_reaped(&err) => {
                    // Gone, but the status died with whoever reaped it. Do NOT
                    // signal `pid` from here on: it is reusable now.
                    tracing::error!(
                        "[ACP] terminal child was reaped elsewhere; exit status unavailable: {err}"
                    );
                    terminal
                        .append_output("\n[terminal exit status unavailable: child reaped elsewhere]\n")
                        .await;
                    break TerminalExitStatus::new();
                }
                Err(err) => {
                    // Not "already reaped", so nothing has collected this child
                    // and its pid is still ours. It may well still be running:
                    // kill it hard and keep trying to reap it.
                    tracing::error!("[ACP] failed waiting for terminal process to exit: {err}");
                    signalled.extend(signal_tree(pid, "SIGKILL").await);

                    let deadline = *wait_error_deadline
                        .get_or_insert_with(|| tokio::time::Instant::now() + WAIT_ERROR_BUDGET);
                    if !published_without_reaping && tokio::time::Instant::now() >= deadline {
                        // Budget spent. Unblock every reader of the completion
                        // state so no agent turn is left hanging, but keep
                        // owning the child so cleanup still has a real handle.
                        published_without_reaping = true;
                        terminal
                            .append_output(
                                "\n[terminal exit status unavailable: could not reap the process]\n",
                            )
                            .await;
                        terminal.drain_readers().await;
                        let unknown = TerminalExitStatus::new();
                        terminal.snapshot.lock().await.exit_status = Some(unknown.clone());
                        terminal
                            .completion
                            .send_replace(TerminalCompletion::Exited(unknown));
                    }

                    let pause = if published_without_reaping {
                        WAIT_ERROR_IDLE_RETRY
                    } else {
                        backoff = (backoff * 2).min(WAIT_RETRY_MAX_BACKOFF);
                        backoff
                    };
                    tokio::time::sleep(pause).await;
                }
            },
            () = escalate => {
                escalate_at = None;
                escalated = true;
                signalled.extend(signal_tree(pid, "SIGKILL").await);
            }
            () = terminal.kill.notified() => {
                let signal = if escalated { "SIGKILL" } else { "SIGTERM" };
                signalled.extend(signal_tree(pid, signal).await);
                // Only the first request arms the escalation deadline. Clearing
                // `escalate_at` when the timer fires means a plain
                // `get_or_insert` would let a later request arm a fresh one and
                // push `SIGKILL` back indefinitely.
                if !kill_requested {
                    kill_requested = true;
                    escalate_at = Some(tokio::time::Instant::now() + KILL_ESCALATE_GRACE);
                }
            }
        }
    };

    if kill_requested {
        sweep_survivors(&signalled, pid).await;
    }

    if published_without_reaping {
        // Completion was already published on the budget-exhausted path; the
        // real status arrived late and nobody is waiting for it any more.
        return;
    }

    // Drain readers BEFORE publishing. Otherwise a caller polling
    // `terminal/output` can see `exit_status = Some(...)` while a grandchild
    // process (e.g. Node spawned from a `.cmd` shim on Windows) still holds the
    // stdout/stderr pipe and is flushing tail output. If the agent treats
    // exit_status as "terminal done", the trailing bytes never reach the UI.
    // Draining first upholds the invariant: whenever an external observer sees
    // exit_status, the snapshot already contains (or has explicitly given up
    // on) all reader output.
    terminal.drain_readers().await;
    terminal.snapshot.lock().await.exit_status = Some(exit_status.clone());
    terminal
        .completion
        .send_replace(TerminalCompletion::Exited(exit_status));
}

/// Shared, hot-swappable default shell for ACP terminal requests.
///
/// The setting is owned by [`crate::acp::manager::ConnectionManager`] and
/// cloned into every connection runtime. Reading it when a terminal is created
/// means a change in General Settings also affects already-running model
/// sessions.
#[derive(Clone, Default)]
pub struct TerminalShellRuntimeConfig {
    inner: Arc<RwLock<Option<String>>>,
}

impl TerminalShellRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> Option<String> {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, default_shell: Option<String>) {
        *self.inner.write().await = default_shell;
    }
}

pub struct TerminalRuntime {
    terminals: Mutex<TerminalMap>,
    /// Base environment merged into every spawned terminal command before
    /// the agent's per-request `env` is applied. This is where the codeg
    /// git credential helper (`GIT_CONFIG_*`) lives so an agent that runs
    /// `git push` via the ACP `terminal/create` tool inherits the same
    /// auth path the agent process itself does. Per-request env from the
    /// agent overrides on key collision so an agent can still scrub or
    /// override anything explicitly.
    base_env: BTreeMap<String, String>,
    /// Fallback working directory applied to spawned terminals when the
    /// agent's `terminal/create` request omits `cwd`. The connection layer
    /// sets this to the session's resolved working directory so terminals
    /// default to the folder the conversation runs in instead of codeg's own
    /// process cwd (often "/" on desktop, the dev crate dir in development).
    /// `None` leaves the process cwd inherited (legacy behavior).
    default_cwd: Option<PathBuf>,
    /// The current General Settings default shell. Structured ACP requests
    /// still direct-exec real programs, while shell command lines and shell
    /// builtins use this selected shell as their fallback.
    default_shell: TerminalShellRuntimeConfig,
    /// Where to report a local server an agent's command starts. `None` for
    /// a runtime with nobody to report to.
    service_watch: Option<ServiceWatch>,
}

#[derive(Debug, Clone)]
pub struct TerminalOutputDelta {
    pub output: String,
    pub next_offset: u64,
    pub had_gap: bool,
    pub truncated: bool,
    pub exit_status: Option<TerminalExitStatus>,
}

impl TerminalRuntime {
    /// Construct a runtime where every spawned command starts with `base_env`
    /// applied, before the agent's per-request env overrides are layered on
    /// top. Use this to propagate process-level invariants like the git
    /// credential helper across `terminal/create` invocations.
    pub fn with_base_env(base_env: BTreeMap<String, String>) -> Self {
        Self {
            terminals: Mutex::new(HashMap::new()),
            base_env,
            default_cwd: None,
            default_shell: TerminalShellRuntimeConfig::new(),
            service_watch: None,
        }
    }

    /// Set the fallback working directory used when a `terminal/create` request
    /// does not specify its own `cwd`. Chainable after `with_base_env`.
    pub fn with_default_cwd(mut self, default_cwd: Option<PathBuf>) -> Self {
        self.default_cwd = default_cwd;
        self
    }

    /// Watch this connection's terminals for a dev server announcing its
    /// address, and tell `owner_window`'s workspace about it. Chainable.
    ///
    /// Left unset the feature is simply absent: a runtime with no window to
    /// tell (the delegation probe, every unit test) behaves exactly as before.
    pub fn with_service_watch(mut self, watch: Option<ServiceWatch>) -> Self {
        self.service_watch = watch;
        self
    }

    /// Use a shared General Settings shell value for ACP terminal fallbacks.
    /// The config is read at command creation time so existing connections pick
    /// up setting changes without being restarted.
    pub fn with_default_shell_config(
        mut self,
        default_shell: TerminalShellRuntimeConfig,
    ) -> Self {
        self.default_shell = default_shell;
        self
    }

    /// Apply stdio, working directory, and environment to a freshly built
    /// terminal command. Shared by the direct-exec and shell-fallback spawn
    /// paths in `create_terminal` so both honor the same cwd precedence and
    /// env layering.
    fn configure_command(
        &self,
        command: &mut tokio::process::Command,
        request: &CreateTerminalRequest,
    ) {
        command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());

        // Working directory. An explicit `cwd` from the agent (validated
        // absolute in `create_terminal`) is honored as-is, so a non-existent
        // directory surfaces as a loud spawn failure rather than silently
        // running somewhere else. Only when the agent omits `cwd` do we fall
        // back to the connection's session working directory — agents like
        // CodeBuddy omit it, which would otherwise inherit codeg's own process
        // cwd instead of the folder the conversation runs in. The fallback is
        // guarded on `is_dir` so a not-yet-created session dir never turns into
        // a spawn failure (mirrors the cwd guard in `build_agent`).
        if let Some(cwd) = request.cwd.as_deref() {
            command.current_dir(cwd);
        } else if let Some(default_cwd) = self.default_cwd.as_deref() {
            if default_cwd.is_dir() {
                command.current_dir(default_cwd);
            }
        }

        // Apply the runtime's base env first (e.g. `GIT_CONFIG_*` for the
        // codeg credential helper), then layer the agent's request env on top
        // so agents can still override or scrub specific keys.
        for (key, value) in &self.base_env {
            command.env(key, value);
        }
        for env_var in &request.env {
            command.env(&env_var.name, &env_var.value);
        }
    }

    pub async fn create_terminal(
        &self,
        request: CreateTerminalRequest,
    ) -> Result<CreateTerminalResponse, TerminalRuntimeError> {
        if let Some(cwd) = request.cwd.as_ref() {
            if !cwd.is_absolute() {
                return Err(TerminalRuntimeError::InvalidParams(
                    "terminal/create requires an absolute cwd when provided".to_string(),
                ));
            }
        }

        if request.command.trim().is_empty() {
            return Err(TerminalRuntimeError::InvalidParams(
                "terminal/create requires a non-empty command".to_string(),
            ));
        }

        let output_byte_limit = request
            .output_byte_limit
            .unwrap_or(DEFAULT_OUTPUT_BYTE_LIMIT);
        if output_byte_limit == 0 {
            return Err(TerminalRuntimeError::InvalidParams(
                "terminal/create outputByteLimit must be greater than 0".to_string(),
            ));
        }

        // Spawn the command. Try a direct exec first so a real program — one
        // resolved on PATH, an absolute path, or a relative/space-containing
        // path reachable through the request's cwd and env — runs exactly as
        // before, in the real spawn context. Only if the OS rejects the program
        // as unrunnable (`NotFound`, or `InvalidFilename` when the whole line is
        // longer than the OS path limit — grok crams `<shell> -lc "<script>"`
        // into `command`, so a multi-KB heredoc exceeds PATH_MAX and the direct
        // exec fails with ENAMETOOLONG, not ENOENT) do we retry through a shell.
        // Whole shell lines (empty args + embedded whitespace, the shape
        // CodeBuddy and grok send) always qualify. A bare no-argv command
        // additionally qualifies when the fallback shell resolves names the OS
        // cannot — PowerShell's `Get-ChildItem`, cmd's `dir`. A path that long
        // can never be a real executable, so rerouting it is always at least as
        // correct. Deciding off a real failed spawn — rather than a pre-spawn
        // `which` guess that runs in codeg's own cwd/env — means we never
        // reroute a command that would otherwise have run.
        //
        // A spawn the kernel refuses with `ETXTBSY` is retried in place instead
        // (see `spawn_retrying_exec_busy`): the program *is* runnable, it is
        // just momentarily held open for writing — often by the agent's own
        // brand-new script — so rerouting it through the shell would split a
        // space-containing path for no reason.
        let mut direct = crate::process::tokio_command(&request.command);
        direct.args(&request.args);
        self.configure_command(&mut direct, &request);

        // Resolve the fallback shell before the spawn attempt so the retry
        // decision can depend on which dialect it speaks. Keying off the shell
        // family rather than "did the user configure something" means picking
        // `/bin/sh` explicitly behaves exactly like leaving the setting on its
        // default, which is the only defensible reading of that choice.
        let fallback_shell = self
            .default_shell
            .snapshot()
            .await
            .unwrap_or_else(default_platform_shell);
        // A structured ACP request normally names an executable plus argv, so
        // preserve direct execution for it. Reconstructing argv as shell text
        // needs shell-specific quoting, so argful requests never fall back.
        let can_retry_through_shell = request.args.is_empty()
            && (request.command.contains(char::is_whitespace)
                || classify_shell_family(&fallback_shell).resolves_bare_builtins());
        let spawned = crate::process::spawn_retrying_exec_busy(|| direct.spawn()).await;
        let mut child = match spawned {
            Ok(child) => child,
            Err(err)
                if matches!(
                    err.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidFilename
                ) && can_retry_through_shell =>
            {
                let mut shell = shell_wrapped_command(&fallback_shell, &request.command);
                self.configure_command(&mut shell, &request);
                shell.spawn().map_err(|err| {
                    TerminalRuntimeError::Internal(format!(
                        "failed to spawn terminal command {}: {err}",
                        request.command
                    ))
                })?
            }
            Err(err) => {
                return Err(TerminalRuntimeError::Internal(format!(
                    "failed to spawn terminal command {}: {err}",
                    request.command
                )));
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let terminal_id = format!("term_{}", uuid::Uuid::new_v4().simple());
        let terminal = Arc::new(TerminalInstance::new(
            request.session_id.to_string(),
            Some(output_byte_limit),
            self.service_watch
                .as_ref()
                .map(|watch| TerminalServiceWatch {
                    watch: watch.clone(),
                    terminal_id: terminal_id.clone(),
                    scanner: std::sync::Mutex::new(ServiceScanner::new()),
                }),
        ));

        let mut handles: Vec<JoinHandle<()>> = Vec::new();
        if let Some(reader) = stdout {
            let terminal_ref = terminal.clone();
            handles.push(tokio::spawn(async move {
                read_stream(reader, terminal_ref).await;
            }));
        }

        if let Some(reader) = stderr {
            let terminal_ref = terminal.clone();
            handles.push(tokio::spawn(async move {
                read_stream(reader, terminal_ref).await;
            }));
        }

        if !handles.is_empty() {
            terminal.reader_handles.lock().await.extend(handles);
        }

        // Hand the child to its owner task only AFTER the reader handles are
        // registered: the owner drains them before publishing the exit status,
        // and a command that exits instantly would otherwise drain an empty
        // list and leave the readers running past the published completion.
        tokio::spawn(own_terminal_process(terminal.clone(), child));

        self.terminals
            .lock()
            .await
            .insert(terminal_id.clone(), terminal);

        Ok(CreateTerminalResponse::new(terminal_id))
    }

    pub async fn terminal_output(
        &self,
        request: TerminalOutputRequest,
    ) -> Result<TerminalOutputResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;

        let snapshot = terminal.snapshot().await;

        Ok(
            TerminalOutputResponse::new(snapshot.output, snapshot.truncated)
                .exit_status(snapshot.exit_status),
        )
    }

    pub async fn terminal_output_delta(
        &self,
        session_id: &str,
        terminal_id: &str,
        from_offset: Option<u64>,
    ) -> Result<TerminalOutputDelta, TerminalRuntimeError> {
        let terminal = self.find_terminal(terminal_id, session_id).await?;
        let snapshot = terminal.snapshot().await;

        let output_len = u64::try_from(snapshot.output.len()).unwrap_or(u64::MAX);
        let base_offset = snapshot.output_base_offset;
        let end_offset = base_offset.saturating_add(output_len);
        let requested_offset = from_offset.unwrap_or(base_offset);
        let had_gap = from_offset
            .map(|offset| offset < base_offset)
            .unwrap_or(false);
        let start_offset = requested_offset.clamp(base_offset, end_offset);
        let start_index = usize::try_from(start_offset.saturating_sub(base_offset)).unwrap_or(0);
        let output = snapshot.output[start_index..].to_string();

        Ok(TerminalOutputDelta {
            output,
            next_offset: end_offset,
            had_gap,
            truncated: snapshot.truncated,
            exit_status: snapshot.exit_status,
        })
    }

    pub async fn wait_for_terminal_exit(
        &self,
        request: WaitForTerminalExitRequest,
    ) -> Result<WaitForTerminalExitResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;
        let exit_status = terminal.wait_for_exit().await?;
        Ok(WaitForTerminalExitResponse::new(exit_status))
    }

    pub async fn kill_terminal(
        &self,
        request: KillTerminalRequest,
    ) -> Result<KillTerminalResponse, TerminalRuntimeError> {
        let terminal = self
            .find_terminal(
                &request.terminal_id.to_string(),
                &request.session_id.to_string(),
            )
            .await?;
        terminal.kill_command().await?;
        Ok(KillTerminalResponse::new())
    }

    pub async fn release_terminal(
        &self,
        request: ReleaseTerminalRequest,
    ) -> Result<ReleaseTerminalResponse, TerminalRuntimeError> {
        let terminal_id = request.terminal_id.to_string();
        let session_id = request.session_id.to_string();
        let terminal = {
            let mut terminals = self.terminals.lock().await;
            let Some(existing) = terminals.get(&terminal_id) else {
                return Err(TerminalRuntimeError::InvalidParams(format!(
                    "terminal {terminal_id} not found"
                )));
            };
            if existing.session_id != session_id {
                return Err(TerminalRuntimeError::InvalidParams(format!(
                    "terminal {terminal_id} does not belong to session {session_id}"
                )));
            }
            terminals.remove(&terminal_id).expect("terminal exists")
        };

        terminal.kill_command().await?;
        Ok(ReleaseTerminalResponse::new())
    }

    pub async fn release_all_for_session(&self, session_id: &str) {
        let removed = {
            let mut terminals = self.terminals.lock().await;
            let ids: Vec<String> = terminals
                .iter()
                .filter(|(_, term)| term.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();

            let mut removed = Vec::with_capacity(ids.len());
            for id in ids {
                if let Some(term) = terminals.remove(&id) {
                    removed.push(term);
                }
            }
            removed
        };

        // Kill concurrently. Sequentially, a session holding N terminals would
        // cost up to N * KILL_REPORT_BUDGET to tear down, and this runs on the
        // cancel path where the user is waiting.
        futures::future::join_all(removed.into_iter().map(|terminal| async move {
            if let Err(err) = terminal.kill_command().await {
                tracing::error!("[ACP] Failed to release terminal during cleanup: {err:?}");
            }
        }))
        .await;
    }

    async fn find_terminal(
        &self,
        terminal_id: &str,
        session_id: &str,
    ) -> Result<Arc<TerminalInstance>, TerminalRuntimeError> {
        let terminal = {
            let terminals = self.terminals.lock().await;
            terminals.get(terminal_id).cloned()
        }
        .ok_or_else(|| {
            TerminalRuntimeError::InvalidParams(format!("terminal {terminal_id} not found"))
        })?;

        if terminal.session_id != session_id {
            return Err(TerminalRuntimeError::InvalidParams(format!(
                "terminal {terminal_id} does not belong to session {session_id}"
            )));
        }

        Ok(terminal)
    }
}

async fn read_stream<R>(mut reader: R, terminal: Arc<TerminalInstance>)
where
    R: AsyncRead + Unpin,
{
    let mut buffer = [0_u8; 4096];
    let mut pending = Vec::<u8>::new();
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) => {
                if !pending.is_empty() {
                    let text = String::from_utf8_lossy(&pending).to_string();
                    terminal.append_output(&text).await;
                    pending.clear();
                }
                break;
            }
            Ok(size) => {
                pending.extend_from_slice(&buffer[..size]);
                let decoded = decode_available_utf8(&mut pending);
                if !decoded.is_empty() {
                    terminal.append_output(&decoded).await;
                }
            }
            Err(_) => break,
        }
    }
}

/// Preserve the platform shell used by ACP before configurable shells were
/// introduced. General Settings only changes this behavior after an explicit
/// shell selection.
#[cfg(not(windows))]
fn default_platform_shell() -> String {
    "/bin/sh".to_string()
}

#[cfg(windows)]
fn default_platform_shell() -> String {
    default_windows_platform_shell(std::env::var("COMSPEC").ok())
}

#[cfg(windows)]
fn default_windows_platform_shell(comspec: Option<String>) -> String {
    comspec
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

/// Wrap a command line through the configured shell, or the legacy platform
/// shell when no preference has been selected. The agent's line is always a
/// single argv element, never concatenated into a larger script.
///
/// Deliberately NOT here: a UTF-8 preamble for the Windows arms. This runtime
/// decodes captured output as UTF-8 while Windows PowerShell 5.1 and cmd write
/// redirected output in the OEM code page, so non-ASCII output can arrive
/// garbled (`decode_available_utf8` renders it lossily rather than failing).
/// The obvious fixes — `chcp 65001` for cmd, `[Console]::OutputEncoding` for
/// PowerShell — both need a console, and `crate::process::tokio_command`
/// spawns with `CREATE_NO_WINDOW`, so they would fail and add a diagnostic to
/// the agent's captured output without changing the encoding. The built-in
/// terminal can set them only because it runs its shell under a PTY. Fixing
/// this needs a redirected-stream-aware approach, not a command-line preamble.
fn shell_wrapped_command(shell: &str, line: &str) -> tokio::process::Command {
    let mut command = crate::process::tokio_command(shell);

    match classify_shell_family(shell) {
        ShellFamily::PowerShell => {
            command.args(["-NoLogo", "-NoProfile", "-Command", line]);
        }
        ShellFamily::Cmd => {
            command.args(["/D", "/S", "/C", line]);
        }
        ShellFamily::Posix => {
            command.arg("-c").arg(line);
        }
    }
    command
}

fn map_exit_status(status: std::process::ExitStatus) -> TerminalExitStatus {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status).map(|s| s.to_string());
    #[cfg(not(unix))]
    let signal: Option<String> = None;

    let exit_code = status.code().and_then(|code| u32::try_from(code).ok());
    TerminalExitStatus::new()
        .exit_code(exit_code)
        .signal(signal)
}

fn enforce_output_limit(output: &mut String, limit: usize) -> usize {
    if output.len() <= limit {
        return 0;
    }

    let mut start = output.len().saturating_sub(limit);
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }

    output.drain(..start);
    start
}

fn decode_available_utf8(pending: &mut Vec<u8>) -> String {
    let mut output = String::new();
    let mut consumed = 0usize;
    let mut remaining = pending.as_slice();

    while !remaining.is_empty() {
        match std::str::from_utf8(remaining) {
            Ok(text) => {
                output.push_str(text);
                consumed = consumed.saturating_add(remaining.len());
                break;
            }
            Err(err) => {
                let valid_up_to = err.valid_up_to();
                if valid_up_to > 0 {
                    if let Ok(text) = std::str::from_utf8(&remaining[..valid_up_to]) {
                        output.push_str(text);
                    }
                    consumed = consumed.saturating_add(valid_up_to);
                    remaining = &remaining[valid_up_to..];
                }

                match err.error_len() {
                    Some(invalid_len) => {
                        output.push_str(&String::from_utf8_lossy(&remaining[..invalid_len]));
                        consumed = consumed.saturating_add(invalid_len);
                        remaining = &remaining[invalid_len..];
                    }
                    None => break, // keep partial UTF-8 sequence for next chunk
                }
            }
        }
    }

    if consumed > 0 {
        pending.drain(..consumed);
    }
    output
}

#[cfg(test)]
mod shell_config_tests {
    use super::*;

    #[tokio::test]
    async fn default_shell_config_hot_swaps() {
        let config = TerminalShellRuntimeConfig::new();
        assert_eq!(config.snapshot().await, None);

        config.set(Some("pwsh.exe".to_string())).await;
        assert_eq!(config.snapshot().await.as_deref(), Some("pwsh.exe"));
    }

    fn wrapped_argv(shell: &str, line: &str) -> (String, Vec<String>) {
        let command = shell_wrapped_command(shell, line);
        let std_command = command.as_std();
        (
            std_command.get_program().to_string_lossy().to_string(),
            std_command
                .get_args()
                .map(|value| value.to_string_lossy().to_string())
                .collect(),
        )
    }

    #[test]
    fn powershell_fallback_uses_the_selected_executable() {
        let (program, args) = wrapped_argv("pwsh.exe", "Get-ChildItem");

        assert_eq!(program, "pwsh.exe");
        assert_eq!(
            args,
            vec![
                "-NoLogo".to_string(),
                "-NoProfile".to_string(),
                "-Command".to_string(),
                "Get-ChildItem".to_string(),
            ]
        );
    }

    /// A cmd-flavored shell gets cmd's own convention. Pinned because the
    /// classifier's Windows fallthrough now routes unrecognized `COMSPEC`
    /// values here rather than to POSIX `-c`.
    ///
    /// The line is passed verbatim as its own argv element — see
    /// `shell_wrapped_command` for why no UTF-8 preamble is prepended.
    #[test]
    fn cmd_fallback_uses_the_cmd_convention_verbatim() {
        let (program, args) = wrapped_argv("cmd.exe", "dir \"a b\"");

        assert_eq!(program, "cmd.exe");
        assert_eq!(
            args,
            vec![
                "/D".to_string(),
                "/S".to_string(),
                "/C".to_string(),
                "dir \"a b\"".to_string(),
            ]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn posix_fallback_passes_the_line_verbatim() {
        let (program, args) = wrapped_argv("/bin/sh", "echo hi && echo bye");

        assert_eq!(program, "/bin/sh");
        assert_eq!(
            args,
            vec!["-c".to_string(), "echo hi && echo bye".to_string()]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn unset_shell_keeps_the_legacy_posix_default() {
        assert_eq!(default_platform_shell(), "/bin/sh");
    }

    #[cfg(windows)]
    #[test]
    fn unset_shell_keeps_the_legacy_windows_default() {
        assert_eq!(
            default_windows_platform_shell(Some("  C:\\Windows\\System32\\cmd.exe  ".to_string())),
            "C:\\Windows\\System32\\cmd.exe"
        );
        assert_eq!(
            default_windows_platform_shell(Some("  ".to_string())),
            "cmd.exe"
        );
        assert_eq!(default_windows_platform_shell(None), "cmd.exe");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{EnvVariable, SessionId, TerminalId, WaitForTerminalExitRequest};

    /// Regression: when an ACP agent calls `terminal/create` (e.g. to run
    /// `git push`), the runtime's base env — populated by the connection
    /// layer with the codeg credential helper's `GIT_CONFIG_*` keys —
    /// must reach the spawned process. Per-request `env` from the agent
    /// still wins on key collision so the agent can scrub or override
    /// specific keys for individual commands.
    #[tokio::test]
    async fn base_env_propagates_and_request_env_overrides() {
        let mut base_env = BTreeMap::new();
        base_env.insert("CODEG_TEST_BASE_VAR".to_string(), "from_base".to_string());
        base_env.insert("CODEG_TEST_OVERRIDE".to_string(), "loses".to_string());
        let runtime = TerminalRuntime::with_base_env(base_env);

        let session_id = SessionId::new("test-session".to_string());
        let mut request = CreateTerminalRequest::new(session_id.clone(), "/bin/sh".to_string());
        request.args = vec![
            "-c".into(),
            // Print both vars on separate lines so we can match each
            // independently regardless of shell quoting.
            "printf '%s\\n' \"$CODEG_TEST_BASE_VAR\" \"$CODEG_TEST_OVERRIDE\"".into(),
        ];
        request.env = vec![EnvVariable::new("CODEG_TEST_OVERRIDE", "request_wins")];

        let response = runtime
            .create_terminal(request)
            .await
            .expect("create terminal");
        let terminal_id = response.terminal_id.clone();

        // Wait for the child to exit so the captured output is final.
        runtime
            .wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("wait for exit");

        let out = runtime
            .terminal_output(TerminalOutputRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("get output");

        assert!(
            out.output.contains("from_base"),
            "base env did not reach the spawned process; got:\n{}",
            out.output
        );
        assert!(
            out.output.contains("request_wins"),
            "per-request env did not override base on key collision; got:\n{}",
            out.output
        );
        assert!(
            !out.output.contains("loses"),
            "base value leaked through despite the request override; got:\n{}",
            out.output
        );

        // Drop terminal handle so the runtime drops its writer ends.
        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// A server an AGENT starts is a server the person is about to want to
    /// look at, and its address only ever appears in this output — there is
    /// no xterm anywhere in this path.
    ///
    /// End to end over a real child process: a real banner, a real socket,
    /// and the event the workspace listens for, carrying the window the
    /// connection belongs to.
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn a_server_an_agent_starts_is_announced_to_its_window() {
        use crate::browser::types::{ServiceSource, SERVICE_DETECTED_EVENT};
        use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

        // Something really listening, so the probe has something to find.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new()).with_service_watch(Some(
            ServiceWatch::new(
                EventEmitter::test_web_only(broadcaster),
                "main".to_string(),
                ServiceSource::Agent,
            ),
        ));

        let session_id = SessionId::new("svc-session".to_string());
        let mut request = CreateTerminalRequest::new(session_id.clone(), "/bin/sh".to_string());
        request.args = vec![
            "-c".into(),
            format!("printf 'Local:   http://127.0.0.1:{port}/\\n'"),
        ];
        runtime
            .create_terminal(request)
            .await
            .expect("create terminal");

        let detected = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let event = events.recv().await.expect("event bus");
                if event.channel == SERVICE_DETECTED_EVENT {
                    return event;
                }
            }
        })
        .await
        .expect("the service event");

        assert_eq!(
            detected.payload["origin"],
            format!("http://127.0.0.1:{port}")
        );
        assert_eq!(detected.payload["ownerWindow"], "main");
        // The list and the "+" menu tell the two apart; a person did not type
        // this one.
        assert_eq!(detected.payload["source"], "agent");

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// A runtime built without a watch is the one every test and the
    /// delegation probe get: it must behave exactly as it did before.
    #[cfg(not(target_os = "windows"))]
    #[tokio::test]
    async fn without_a_watch_nothing_is_announced() {
        use crate::browser::types::SERVICE_DETECTED_EVENT;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let port = listener.local_addr().unwrap().port();
        let broadcaster = Arc::new(crate::web::event_bridge::WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();

        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());
        let session_id = SessionId::new("quiet-session".to_string());
        let mut request = CreateTerminalRequest::new(session_id.clone(), "/bin/sh".to_string());
        request.args = vec![
            "-c".into(),
            format!("printf 'Local:   http://127.0.0.1:{port}/\\n'"),
        ];
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(output.contains(&format!("http://127.0.0.1:{port}/")));

        // Give a probe that should not exist every chance to finish first.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let announced = std::iter::from_fn(|| events.try_recv().ok())
            .any(|event| event.channel == SERVICE_DETECTED_EVENT);
        assert!(!announced, "a runtime with no watch announced a service");
    }

    /// Spawn `request`, wait for it to exit, return its captured output, and
    /// release the session's terminals.
    async fn run_and_capture(
        runtime: &TerminalRuntime,
        session_id: &SessionId,
        request: CreateTerminalRequest,
    ) -> String {
        let response = runtime
            .create_terminal(request)
            .await
            .expect("create terminal");
        let terminal_id = response.terminal_id.clone();
        runtime
            .wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("wait for exit");
        let out = runtime
            .terminal_output(TerminalOutputRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("get output");
        runtime.release_all_for_session(session_id.0.as_ref()).await;
        out.output
    }

    /// The shell handle is shared with a live connection, so changing General
    /// Settings after the agent connects affects its next shell command.
    #[tokio::test]
    async fn shell_fallback_uses_the_live_selected_shell() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let shell = dir.path().join("selected-shell");
        std::fs::write(
            &shell,
            "#!/bin/sh\nprintf '%s\\n' selected-shell\nexec /bin/sh \"$@\"\n",
        )
        .expect("write shell");
        let mut permissions = std::fs::metadata(&shell)
            .expect("shell metadata")
            .permissions();
        permissions.set_mode(0o755);
        std::fs::set_permissions(&shell, permissions).expect("make shell executable");

        let config = TerminalShellRuntimeConfig::new();
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_shell_config(config.clone());
        config
            .set(Some(shell.to_string_lossy().to_string()))
            .await;

        let session_id = SessionId::new("selected-shell".to_string());
        let request = CreateTerminalRequest::new(
            session_id.clone(),
            "printf 'command-output\\n'".to_string(),
        );
        let output = run_and_capture(&runtime, &session_id, request).await;

        assert!(
            output.contains("selected-shell"),
            "configured shell did not run; got:\n{output}"
        );
        assert!(
            output.contains("command-output"),
            "configured shell did not execute the command; got:\n{output}"
        );
    }

    /// A `terminal/create` that omits `cwd` defaults to the runtime's
    /// configured working directory rather than codeg's own process cwd.
    #[tokio::test]
    async fn falls_back_to_default_cwd_when_request_omits_cwd() {
        let dir = tempfile::tempdir().expect("temp dir");
        let canonical = dir.path().canonicalize().expect("canonicalize");
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_cwd(Some(dir.path().to_path_buf()));

        let session_id = SessionId::new("cwd-default".to_string());
        // Bare `pwd` (no whitespace) → direct exec; current_dir still applies.
        let request = CreateTerminalRequest::new(session_id.clone(), "pwd".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;

        assert!(
            output.contains(canonical.to_string_lossy().as_ref()),
            "terminal did not run in the default cwd; got:\n{output}"
        );
    }

    /// An explicit absolute `cwd` in the request takes precedence over the
    /// runtime default.
    #[tokio::test]
    async fn request_cwd_overrides_default_cwd() {
        let default_dir = tempfile::tempdir().expect("default dir");
        let request_dir = tempfile::tempdir().expect("request dir");
        let request_canonical = request_dir.path().canonicalize().expect("canonicalize");
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_cwd(Some(default_dir.path().to_path_buf()));

        let session_id = SessionId::new("cwd-override".to_string());
        let mut request = CreateTerminalRequest::new(session_id.clone(), "pwd".to_string());
        request.cwd = Some(request_dir.path().to_path_buf());
        let output = run_and_capture(&runtime, &session_id, request).await;

        assert!(
            output.contains(request_canonical.to_string_lossy().as_ref()),
            "request cwd did not take precedence over the default; got:\n{output}"
        );
    }

    /// Regression guard for the *selection* made in `create_terminal`, not
    /// just for `default_platform_shell()` in isolation: with nothing
    /// configured the fallback must be the POSIX platform shell, never the
    /// host's login shell. Agents emit `sh` syntax while `$SHELL` may be
    /// fish/csh/nu, which reject `export`, `2>&1`, and heredocs.
    ///
    /// `$0` names the shell that actually interpreted the line, so this fails
    /// if the call site ever goes back to `resolve_shell()` — on a zsh host it
    /// reports `/bin/zsh`.
    #[tokio::test]
    async fn unset_default_runs_the_platform_shell_not_the_login_shell() {
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());

        let session_id = SessionId::new("unset-default-shell".to_string());
        let request =
            CreateTerminalRequest::new(session_id.clone(), "echo \"ran-under=$0\"".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;

        assert!(
            output.contains("ran-under=/bin/sh"),
            "unset default did not run through /bin/sh; got:\n{output}"
        );
    }

    /// A whitespace-bearing command with empty args runs through the shell. A
    /// direct exec would ENOENT trying to run a program literally named with
    /// spaces — this is the shape CodeBuddy sends.
    #[tokio::test]
    async fn whitespace_command_runs_through_shell() {
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());

        let session_id = SessionId::new("shell-wrap".to_string());
        let request =
            CreateTerminalRequest::new(session_id.clone(), "echo hello world".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("hello world"),
            "shell did not run the whitespace command; got:\n{output}"
        );

        // Genuine shell operators must evaluate, not be passed as literal args.
        let session_id = SessionId::new("shell-ops".to_string());
        let request =
            CreateTerminalRequest::new(session_id.clone(), "true && echo OK".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("OK"),
            "shell operators did not evaluate; got:\n{output}"
        );
    }

    /// A whole shell line longer than the OS path limit still runs through the
    /// shell. grok crams `<shell> -lc "<script>"` into `command` with empty
    /// args; a multi-KB heredoc makes the direct exec fail with ENAMETOOLONG →
    /// `ErrorKind::InvalidFilename` (not `NotFound`), which the fallback guard
    /// must also catch. The marker exceeds Linux's PATH_MAX (4096) so the direct
    /// exec fails with ENAMETOOLONG on both macOS (1024) and Linux — a sub-limit
    /// line would return `NotFound` and silently exercise the other branch.
    #[tokio::test]
    async fn overlong_command_line_falls_back_to_shell() {
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());

        let session_id = SessionId::new("overlong-cmd".to_string());
        let marker = "x".repeat(5000);
        let request =
            CreateTerminalRequest::new(session_id.clone(), format!("echo {marker}"));
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains(&marker),
            "overlong command line did not run via the shell fallback; got {} bytes",
            output.len()
        );
    }

    /// The shell-wrapped path still honors the working directory, so a
    /// CodeBuddy-style `pnpm build` runs in the session folder.
    #[tokio::test]
    async fn shell_wrapped_command_respects_cwd() {
        let dir = tempfile::tempdir().expect("temp dir");
        let canonical = dir.path().canonicalize().expect("canonicalize");
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_cwd(Some(dir.path().to_path_buf()));

        let session_id = SessionId::new("shell-cwd".to_string());
        // Whitespace → shell-wrapped; must run in the default cwd.
        let request =
            CreateTerminalRequest::new(session_id.clone(), "pwd && echo done".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains(canonical.to_string_lossy().as_ref()) && output.contains("done"),
            "shell-wrapped command ignored the default cwd; got:\n{output}"
        );
    }

    /// When the agent supplies explicit `args`, the command is exec'd directly
    /// (no shell), so an argument containing spaces stays a single argument.
    #[tokio::test]
    async fn explicit_args_bypass_shell_wrap() {
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());

        let session_id = SessionId::new("direct-exec".to_string());
        let mut request =
            CreateTerminalRequest::new(session_id.clone(), "/bin/echo".to_string());
        request.args = vec!["hello world".into()];
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("hello world"),
            "direct exec did not pass the single arg through; got:\n{output}"
        );
    }

    /// An explicit but non-existent absolute `cwd` is honored as-is and
    /// surfaces as a spawn failure — never silently downgraded to the default
    /// fallback or the inherited process cwd.
    #[tokio::test]
    async fn explicit_missing_cwd_surfaces_as_spawn_failure() {
        let default_dir = tempfile::tempdir().expect("default dir");
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_cwd(Some(default_dir.path().to_path_buf()));

        let session_id = SessionId::new("missing-cwd".to_string());
        let mut request = CreateTerminalRequest::new(session_id, "pwd".to_string());
        request.cwd = Some(PathBuf::from("/codeg-nonexistent-cwd/does/not/exist"));

        let result = runtime.create_terminal(request).await;
        assert!(
            matches!(result, Err(TerminalRuntimeError::Internal(_))),
            "expected a spawn failure for a missing explicit cwd"
        );
    }

    /// A real executable whose path contains spaces is exec'd directly: the
    /// direct spawn succeeds, so the shell fallback never fires (shell-wrapping
    /// would split the path at the space).
    ///
    /// Note: writing an executable and exec'ing it from a multi-threaded test
    /// binary can hit a spurious `ETXTBSY` when a sibling test forks in the
    /// window where the write descriptor is still open. The spawn's
    /// `spawn_retrying_exec_busy` wrapper is what keeps this deterministic —
    /// see `spawn_rides_out_a_transient_text_file_busy`.
    #[tokio::test]
    async fn executable_path_with_spaces_is_not_shell_wrapped() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let exe = dir.path().join("my tool"); // space in the file name
        std::fs::write(&exe, "#!/bin/sh\necho ran-directly\n").expect("write script");
        let mut perms = std::fs::metadata(&exe).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&exe, perms).expect("chmod");

        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());
        let session_id = SessionId::new("space-exe".to_string());
        // Empty args + whitespace in command, but it resolves to a real
        // executable, so it must run directly rather than via the shell.
        let request =
            CreateTerminalRequest::new(session_id.clone(), exe.to_string_lossy().to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("ran-directly"),
            "space-containing executable was not exec'd directly; got:\n{output}"
        );
    }

    /// A whitespace-only command is rejected up front rather than spawning a
    /// shell no-op.
    #[tokio::test]
    async fn whitespace_only_command_is_rejected() {
        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());
        let session_id = SessionId::new("blank-command".to_string());
        let request = CreateTerminalRequest::new(session_id, "   ".to_string());

        let result = runtime.create_terminal(request).await;
        assert!(
            matches!(result, Err(TerminalRuntimeError::InvalidParams(_))),
            "expected InvalidParams for a whitespace-only command"
        );
    }

    /// A relative, space-containing executable resolves against the terminal's
    /// effective cwd and runs directly — the shell fallback fires only on a
    /// genuine NotFound. This guards the regression where a pre-spawn `which`
    /// check, run in codeg's own cwd, would shell-wrap and split the path.
    #[tokio::test]
    async fn relative_executable_with_spaces_runs_in_effective_cwd() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let exe = dir.path().join("my tool"); // space in the file name
        std::fs::write(&exe, "#!/bin/sh\necho ran-relative\n").expect("write script");
        let mut perms = std::fs::metadata(&exe).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&exe, perms).expect("chmod");

        let runtime = TerminalRuntime::with_base_env(BTreeMap::new())
            .with_default_cwd(Some(dir.path().to_path_buf()));
        let session_id = SessionId::new("rel-space-exe".to_string());
        // "./my tool": empty args + whitespace, resolvable only against the
        // terminal's cwd — must run directly, not via the shell.
        let request = CreateTerminalRequest::new(session_id.clone(), "./my tool".to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("ran-relative"),
            "relative space-containing exe was not run in the effective cwd; got:\n{output}"
        );
    }

    /// Spawn `command` and return `(runtime, session_id, terminal_id)` without
    /// waiting for it to finish. For the long-running cases below, where the
    /// point is what happens *while* the command is still alive.
    async fn start(command: &str, session: &str) -> (Arc<TerminalRuntime>, SessionId, TerminalId) {
        let runtime = Arc::new(TerminalRuntime::with_base_env(BTreeMap::new()));
        let session_id = SessionId::new(session.to_string());
        let request = CreateTerminalRequest::new(session_id.clone(), command.to_string());
        let response = runtime
            .create_terminal(request)
            .await
            .expect("create terminal");
        let terminal_id = response.terminal_id.clone();
        (runtime, session_id, terminal_id)
    }

    /// True while `pid` names a live process.
    fn pid_is_alive(pid: u32) -> bool {
        // Signal 0 performs the permission/existence check without delivering.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }

    /// Current parent pid of `pid`, or `None` if it is gone / unreadable.
    fn parent_pid_of(pid: u32) -> Option<u32> {
        let out = std::process::Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        String::from_utf8_lossy(&out.stdout).trim().parse().ok()
    }

    /// Poll until `pid` is gone, or the deadline passes.
    async fn wait_until_pid_gone(pid: u32, budget: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + budget;
        while tokio::time::Instant::now() < deadline {
            if !pid_is_alive(pid) {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        !pid_is_alive(pid)
    }

    /// Regression: a waiter that subscribes AFTER a fast command already exited
    /// must still get its exit status.
    ///
    /// This is the `watch::Sender::send` trap — `send` DISCARDS the value when
    /// no receiver exists yet, so publishing completion with it would strand
    /// every later waiter forever. Observing the exit through `terminal/output`
    /// first is what guarantees the publication already happened; only then is
    /// `wait_for_terminal_exit` called.
    #[tokio::test]
    async fn wait_for_exit_resolves_when_subscribing_after_a_fast_exit() {
        let (runtime, session_id, terminal_id) = start("true", "fast-exit").await;

        // Wait for the owner task to publish, observed via the output path.
        let mut published = false;
        for _ in 0..200 {
            let out = runtime
                .terminal_output(TerminalOutputRequest::new(
                    session_id.clone(),
                    terminal_id.clone(),
                ))
                .await
                .expect("get output");
            if out.exit_status.is_some() {
                published = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(published, "owner task never published an exit status");

        // Subscribing only now must not hang.
        let exit = tokio::time::timeout(
            Duration::from_secs(5),
            runtime.wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("wait_for_exit hung after a fast exit — completion was lost")
        .expect("wait for exit");
        assert_eq!(exit.exit_status.exit_code, Some(0));

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// The bug this module was rewritten for: an outstanding `wait_for_exit` on
    /// a command that never exits must not block `terminal/output` or
    /// `terminal/kill`. Previously `wait_for_exit` held the child mutex for the
    /// whole wait, so both of those (and the session cancel path) deadlocked.
    #[tokio::test]
    async fn output_and_kill_work_while_wait_for_exit_is_outstanding() {
        let (runtime, session_id, terminal_id) = start("sleep 30", "wait-outstanding").await;

        let waiter = tokio::spawn({
            let runtime = runtime.clone();
            let session_id = session_id.clone();
            let terminal_id = terminal_id.clone();
            async move {
                runtime
                    .wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                        session_id, terminal_id,
                    ))
                    .await
            }
        });
        // Let the waiter actually park inside wait_for_exit.
        tokio::time::sleep(Duration::from_millis(100)).await;

        tokio::time::timeout(
            Duration::from_secs(5),
            runtime.terminal_output(TerminalOutputRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("terminal_output blocked behind an outstanding wait_for_exit")
        .expect("get output");

        tokio::time::timeout(
            Duration::from_secs(10),
            runtime.kill_terminal(KillTerminalRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("kill_terminal blocked behind an outstanding wait_for_exit")
        .expect("kill terminal");

        tokio::time::timeout(Duration::from_secs(5), waiter)
            .await
            .expect("the outstanding wait never resolved after the kill")
            .expect("waiter task")
            .expect("wait for exit");

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// Every concurrent waiter is released, not just the first one.
    #[tokio::test]
    async fn multiple_waiters_all_resolve() {
        let (runtime, session_id, terminal_id) = start("sleep 30", "many-waiters").await;

        let waiters: Vec<_> = (0..3)
            .map(|_| {
                let runtime = runtime.clone();
                let session_id = session_id.clone();
                let terminal_id = terminal_id.clone();
                tokio::spawn(async move {
                    runtime
                        .wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                            session_id, terminal_id,
                        ))
                        .await
                })
            })
            .collect();
        tokio::time::sleep(Duration::from_millis(100)).await;

        runtime
            .kill_terminal(KillTerminalRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("kill terminal");

        for waiter in waiters {
            tokio::time::timeout(Duration::from_secs(5), waiter)
                .await
                .expect("a concurrent waiter was never released")
                .expect("waiter task")
                .expect("wait for exit");
        }

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// `kill_tree` only sends `SIGTERM`, which a process that traps it ignores
    /// forever. The owner task must escalate to `SIGKILL`.
    #[tokio::test]
    async fn kill_escalates_to_sigkill_for_a_sigterm_ignoring_process() {
        let (runtime, session_id, terminal_id) = start(
            "sh -c 'trap \"\" TERM; while :; do sleep 0.1; done'",
            "sigterm-immune",
        )
        .await;
        tokio::time::sleep(Duration::from_millis(200)).await;

        tokio::time::timeout(
            Duration::from_secs(15),
            runtime.kill_terminal(KillTerminalRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("kill_terminal never returned for a SIGTERM-immune process")
        .expect("kill terminal");

        let exit = tokio::time::timeout(
            Duration::from_secs(5),
            runtime.wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("the SIGTERM-immune process was never reaped")
        .expect("wait for exit");
        assert!(
            exit.exit_status.signal.is_some() || exit.exit_status.exit_code.is_some(),
            "expected a terminal status after escalation, got {:?}",
            exit.exit_status
        );

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// A descendant that outlives a SIGTERM-obedient parent must still be
    /// killed.
    ///
    /// Deliberately THREE levels deep: root traps TERM, the middle level dies
    /// on TERM, the leaf traps TERM. When the middle level dies the leaf is
    /// reparented, so no fresh snapshot rooted at the direct child can find it
    /// again — only the cumulative record of everything the SIGTERM pass
    /// signalled still reaches it. A two-level version of this test passes even
    /// with a non-cumulative record, so it would not catch the regression.
    #[tokio::test]
    async fn kill_sweeps_a_descendant_that_outlives_a_sigterm_obedient_parent() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pid_file = dir.path().join("leaf.pid");
        let leaf = dir.path().join("leaf.sh");
        let middle = dir.path().join("middle.sh");
        let root = dir.path().join("root.sh");

        // Three files rather than one nested one-liner: the quoting of nested
        // `sh -c "sh -c '...'"` is unreadable and easy to get subtly wrong.
        //
        // Note the ORDER in root.sh. `trap '' TERM` sets SIG_IGN, and SIG_IGN is
        // inherited across both fork AND exec — and a shell that starts with a
        // signal already ignored cannot restore its default (`trap - TERM` is a
        // no-op there). Installing the trap before spawning would therefore make
        // the ENTIRE subtree TERM-immune, the middle level would never die, the
        // leaf would never be reparented, and this test would pass even with a
        // non-cumulative record. Spawn first, then go immune.
        std::fs::write(
            &leaf,
            format!(
                "trap '' TERM\necho $$ > {}\nwhile :; do sleep 0.2; done\n",
                pid_file.display()
            ),
        )
        .expect("write leaf.sh");
        std::fs::write(
            &middle,
            format!("sh {} &\nwhile :; do sleep 0.2; done\n", leaf.display()),
        )
        .expect("write middle.sh");
        std::fs::write(
            &root,
            format!(
                "sh {} &\ntrap '' TERM\nwhile :; do sleep 0.2; done\n",
                middle.display()
            ),
        )
        .expect("write root.sh");

        let (runtime, session_id, terminal_id) =
            start(&format!("sh {}", root.display()), "deep-tree").await;

        // Wait for the leaf to announce itself.
        let mut leaf_pid = None;
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    if pid > 0 {
                        leaf_pid = Some(pid);
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let leaf_pid = leaf_pid.expect("leaf process never recorded its pid");
        assert!(pid_is_alive(leaf_pid), "leaf should be running");

        tokio::time::timeout(
            Duration::from_secs(20),
            runtime.kill_terminal(KillTerminalRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            )),
        )
        .await
        .expect("kill_terminal never returned")
        .expect("kill terminal");

        assert!(
            wait_until_pid_gone(leaf_pid, Duration::from_secs(10)).await,
            "reparented leaf {leaf_pid} survived the kill"
        );

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// Sanity check for the test above: the middle level must actually die on
    /// `SIGTERM` while the leaf survives and is reparented. If this stops
    /// holding, `kill_sweeps_a_descendant_that_outlives_a_sigterm_obedient_parent`
    /// silently stops testing the reparenting path it exists for.
    #[tokio::test]
    async fn deep_tree_fixture_reparents_the_leaf_on_sigterm() {
        let dir = tempfile::tempdir().expect("temp dir");
        let pid_file = dir.path().join("leaf.pid");
        let leaf = dir.path().join("leaf.sh");
        let middle = dir.path().join("middle.sh");
        let root = dir.path().join("root.sh");
        std::fs::write(
            &leaf,
            format!(
                "trap '' TERM\necho $$ > {}\nwhile :; do sleep 0.2; done\n",
                pid_file.display()
            ),
        )
        .expect("write leaf.sh");
        std::fs::write(
            &middle,
            format!("sh {} &\nwhile :; do sleep 0.2; done\n", leaf.display()),
        )
        .expect("write middle.sh");
        std::fs::write(
            &root,
            format!(
                "sh {} &\ntrap '' TERM\nwhile :; do sleep 0.2; done\n",
                middle.display()
            ),
        )
        .expect("write root.sh");

        let (runtime, session_id, terminal_id) =
            start(&format!("sh {}", root.display()), "deep-tree-fixture").await;

        let mut leaf_pid = None;
        for _ in 0..200 {
            if let Ok(text) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    if pid > 0 {
                        leaf_pid = Some(pid);
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        let leaf_pid = leaf_pid.expect("leaf process never recorded its pid");
        let middle_pid = parent_pid_of(leaf_pid).expect("leaf should have a parent");

        // The graceful pass only: no escalation, no sweep.
        signal_tree(Some(middle_pid), "SIGTERM").await;
        let middle_died = wait_until_pid_gone(middle_pid, Duration::from_secs(5)).await;
        let leaf_survived = pid_is_alive(leaf_pid);
        let leaf_parent_now = parent_pid_of(leaf_pid);

        // Clean up BEFORE asserting: a failing assertion would otherwise unwind
        // past the cleanup and leave a TERM-immune spinner running forever on
        // the machine (or the CI worker) that ran the test.
        unsafe { libc::kill(leaf_pid as libc::pid_t, libc::SIGKILL) };
        runtime.release_all_for_session(session_id.0.as_ref()).await;
        let _ = terminal_id;

        assert!(
            middle_died,
            "middle level ignored SIGTERM — the fixture no longer exercises reparenting"
        );
        assert!(
            leaf_survived,
            "leaf died on SIGTERM — the fixture no longer exercises reparenting"
        );
        // Deliberately NOT `== Some(1)`: under a child subreaper (containers,
        // some init systems) an orphan is reparented to the subreaper rather
        // than to pid 1. All this test needs is that the leaf moved off its
        // dead parent, which is what makes it unreachable from the root.
        assert!(
            leaf_parent_now.is_some() && leaf_parent_now != Some(middle_pid),
            "leaf was not reparented after its parent died (parent is still {leaf_parent_now:?})"
        );
    }

    /// Session teardown kills terminals concurrently. Sequentially, N stubborn
    /// terminals would each burn their own escalation grace and the cancel path
    /// (which awaits this) would stall for N times as long.
    ///
    /// The commands deliberately ignore SIGTERM: with TERM-responsive ones each
    /// kill returns in milliseconds, so a sequential implementation would finish
    /// just as fast and the test would prove nothing. Ignoring TERM forces every
    /// terminal to cost a full `KILL_ESCALATE_GRACE`, making the difference
    /// between 4 * grace (sequential) and ~1 * grace (concurrent) unmistakable.
    #[tokio::test]
    async fn release_all_for_session_kills_many_terminals_concurrently() {
        const TERMINALS: u32 = 4;
        let runtime = Arc::new(TerminalRuntime::with_base_env(BTreeMap::new()));
        let session_id = SessionId::new("bulk-release".to_string());
        for _ in 0..TERMINALS {
            let request = CreateTerminalRequest::new(
                session_id.clone(),
                "sh -c 'trap \"\" TERM; while :; do sleep 0.1; done'".to_string(),
            );
            runtime
                .create_terminal(request)
                .await
                .expect("create terminal");
        }
        // Let every shell install its trap before we start killing.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let started = tokio::time::Instant::now();
        tokio::time::timeout(
            Duration::from_secs(30),
            runtime.release_all_for_session(session_id.0.as_ref()),
        )
        .await
        .expect("release_all_for_session never returned");

        let elapsed = started.elapsed();
        assert!(
            elapsed < KILL_ESCALATE_GRACE * 2,
            "teardown of {TERMINALS} SIGTERM-immune terminals took {elapsed:?}; \
             concurrent kills should cost roughly one {KILL_ESCALATE_GRACE:?} grace, \
             so this suggests they ran sequentially"
        );
    }

    /// Output is readable while the command is still running — the snapshot is
    /// not gated on the process finishing.
    #[tokio::test]
    async fn output_is_readable_before_the_command_exits() {
        let (runtime, session_id, terminal_id) =
            start("sh -c 'echo early-marker; sleep 30'", "live-output").await;

        let mut saw_marker = false;
        for _ in 0..200 {
            let out = runtime
                .terminal_output(TerminalOutputRequest::new(
                    session_id.clone(),
                    terminal_id.clone(),
                ))
                .await
                .expect("get output");
            if out.output.contains("early-marker") {
                assert!(
                    out.exit_status.is_none(),
                    "command should still be running while we read its output"
                );
                saw_marker = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert!(saw_marker, "never saw output from a still-running command");

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// Once `wait_for_exit` returns, ALL output is already in the snapshot.
    /// Guards the drain-before-publish ordering in the owner task: publishing
    /// the exit status first would let a caller treat the terminal as done and
    /// miss the tail.
    #[tokio::test]
    async fn all_output_is_present_after_wait_returns() {
        let runtime = Arc::new(TerminalRuntime::with_base_env(BTreeMap::new()));
        let session_id = SessionId::new("drain-order".to_string());
        let request = CreateTerminalRequest::new(
            session_id.clone(),
            "sh -c 'i=0; while [ $i -lt 400 ]; do echo line-$i; i=$((i+1)); done'".to_string(),
        );
        let response = runtime
            .create_terminal(request)
            .await
            .expect("create terminal");
        let terminal_id = response.terminal_id.clone();

        runtime
            .wait_for_terminal_exit(WaitForTerminalExitRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("wait for exit");

        let out = runtime
            .terminal_output(TerminalOutputRequest::new(
                session_id.clone(),
                terminal_id.clone(),
            ))
            .await
            .expect("get output");
        assert!(
            out.output.contains("line-399"),
            "tail output was missing after wait_for_exit returned"
        );

        runtime.release_all_for_session(session_id.0.as_ref()).await;
    }

    /// A brand-new executable that something still holds open for writing is
    /// retried, not rejected. exec returns `ETXTBSY` while any write descriptor
    /// to the file is open anywhere, and codeg forks constantly (git, agents,
    /// other terminals), so a descriptor inherited across a `fork()` can make an
    /// agent's just-written script briefly unrunnable — including in this test
    /// binary, which is where the flake was first observed.
    ///
    /// Linux enforces `ETXTBSY` here, so this exercises the retry loop; macOS
    /// does not enforce it for script exec, where the first attempt simply
    /// succeeds and the assertion still holds.
    #[tokio::test]
    async fn spawn_rides_out_a_transient_text_file_busy() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("temp dir");
        let exe = dir.path().join("busy-tool");
        std::fs::write(&exe, "#!/bin/sh\necho ran-after-busy\n").expect("write script");
        let mut perms = std::fs::metadata(&exe).expect("metadata").permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&exe, perms).expect("chmod");

        // Hold a write descriptor open, then release it while the spawn is still
        // retrying — the shape of the real race, with the timing made explicit.
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&exe)
            .expect("hold write handle");
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            drop(writer);
        });

        let runtime = TerminalRuntime::with_base_env(BTreeMap::new());
        let session_id = SessionId::new("busy-exe".to_string());
        // No whitespace in the command, so there is no shell fallback to mask a
        // failed direct exec: if the retry does not ride out ETXTBSY,
        // `create_terminal` errors and this test panics.
        let request =
            CreateTerminalRequest::new(session_id.clone(), exe.to_string_lossy().to_string());
        let output = run_and_capture(&runtime, &session_id, request).await;
        assert!(
            output.contains("ran-after-busy"),
            "transient ETXTBSY was not retried; got:\n{output}"
        );
    }
}
