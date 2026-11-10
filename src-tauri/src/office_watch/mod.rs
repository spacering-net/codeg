//! Long-lived `officecli watch` preview servers.
//!
//! One `officecli watch <file> --port N` child process per office file,
//! shared across preview tabs by ref-count, reaped on tab-close /
//! folder-removal / app-exit, or once the web pages holding it go quiet.
//!
//! ## Why this replaces the old `officecli view html` render path
//!
//! The previous preview rendered the file to HTML on every change by
//! spawning a fresh `officecli view` that **re-read the whole OpenXML(zip)
//! file**. While an agent edited the same file via officecli (a multi-step
//! sequence of writes), the preview and the agent became two independent
//! processes contending for one file on disk — on Windows this hit a file
//! lock and the agent's edit failed with "file is in use".
//!
//! A `watch` server is a single long-lived HTTP + SSE process that officecli
//! itself drives (it refreshes the browser when *officecli* mutates the doc),
//! so the agent's edits and the preview no longer race for the file.
//!
//! ## Concurrency model (mirrors `workspace_state::WORKSPACE_STREAMS`)
//!
//! A process-level `static` registry keyed by the file's canonical path,
//! with ref-count sharing. Not on `AppState`: the server-mode proxy handler
//! only has `Extension<Arc<AppState>>` and the desktop command only has
//! `State`, but both reach a `static` for free, and the pool holds only OS
//! resources (child handles + ports) so it needs no DB/emitter injection.
//!
//! ## Who holds a watch
//!
//! References are kept per kind of holder ([`WatchHolder`]), because the two
//! kinds go away differently. A desktop window releases what it took, and what
//! it doesn't release goes with the app, so its references are only counted.
//! A web page can vanish without a word (its tab closed, the browser quit or
//! crashed, the machine asleep or offline), so each of its starts takes a
//! hold of its own, named by an id the start hands out, and the sweep drops a
//! hold once it has gone quiet for [`WEB_HOLD_GRACE`]. A preview on screen
//! keeps its live SSE connection through the proxy open; one kept mounted out
//! of sight holds none (a browser allows only a handful of connections per
//! server, see the proxy's shim) and renews its hold instead
//! ([`renew_office_watch_core`]). Being named, a hold that lapsed comes back
//! with its page's next renewal, and a page's late release takes only its own.
//! Dropping web holds never takes a desktop window's references, so a file
//! open in both keeps its watch for the window.
//!
//! officecli has a clock of its own: it ends a watch that has had no SSE client
//! and no request for five minutes. Every renewal also asks the watch for its
//! status, so a watch a preview still renews never idles out under it.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::process::{Child, ChildStdout};

use crate::app_error::AppCommandError;
use crate::commands::folders::resolve_tree_path;
use crate::commands::office_tools::{is_office_path, resolve_officecli};
use crate::process::tokio_command;

// ─── Tunables ───────────────────────────────────────────────────────────

/// Upper bound on how long a start may take before giving up: waiting out
/// another start of the same file, then for the freshly-spawned watch server to
/// announce readiness (its `Watch: http://…:<port>` stdout line). officecli
/// renders the whole document before it binds the port and announces it, so a
/// large file or a slow or busy machine can take tens of seconds; only a start
/// that never gets there waits this long. Keep the frontend's
/// `startOfficeWatch` request deadline above this budget.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// Per-attempt TCP connect timeout for the post-announce reachability confirm.
const READY_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// Bound on the status request that keeps officecli from idling out
/// ([`keep_alive`]).
const KEEP_ALIVE_TIMEOUT: Duration = Duration::from_secs(5);
/// Hard cap on concurrent watch processes — a backstop against a pathological
/// burst of tab-opens spawning unbounded officecli processes.
const MAX_CONCURRENT_WATCHES: usize = 32;
/// How long a web page's hold on a watch outlives its last renewal (or its
/// start) before the sweep drops it, counted only while no page has an SSE
/// connection to the watch open and none has sent it a request since. Bounds
/// the leak when a browser tab closes / crashes / loses network and its
/// `stop_office_watch` request never arrives, while tolerating brief SSE
/// reconnects (officecli's stream auto-reconnects). The frontend renews well
/// inside it (`WATCH_RENEW_INTERVAL_MS` in office-preview.tsx, 30s), so a
/// background tab whose timers the browser throttles to once a minute keeps
/// its hold.
const WEB_HOLD_GRACE: Duration = Duration::from_secs(90);

/// Default idle threshold for the sweep (5 minutes). Override via
/// `CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS`; `0` disables the sweep.
pub const DEFAULT_IDLE_TIMEOUT_SECS: u64 = 300;
/// Sweep cadence — once per minute, like the ACP idle sweep.
pub const SWEEP_INTERVAL_SECS: u64 = 60;

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    #[error("officecli is not installed")]
    NotInstalled,
    #[error("not a supported office file (.docx/.xlsx/.pptx)")]
    NotOffice,
    #[error("path is outside the workspace root")]
    OutsideRoot,
    #[error("failed to start officecli watch: {0}")]
    StartFailed(String),
    #[error("officecli watch did not become ready in time: {0}")]
    PortTimeout(String),
    #[error("no free port available for the preview server")]
    NoPort,
    #[error("too many office preview servers are already running")]
    TooMany,
    #[error("io error: {0}")]
    Io(String),
}

impl WatchError {
    /// Append child diagnostics to the inner detail, preserving the error code
    /// and letting Display add the contextual prefix exactly once.
    fn with_stderr(self, stderr: &str) -> Self {
        if stderr.is_empty() {
            return self;
        }
        match self {
            Self::PortTimeout(detail) => Self::PortTimeout(format!("{detail} — {stderr}")),
            Self::StartFailed(detail) => Self::StartFailed(format!("{detail} — {stderr}")),
            other => other,
        }
    }

    /// Stable machine code the frontend switches on to render the right
    /// degraded UI (install guide vs. retry). Carried into `AppCommandError`
    /// via `i18n_params` at the command boundary.
    pub fn code(&self) -> &'static str {
        match self {
            WatchError::NotInstalled => "NOT_INSTALLED",
            WatchError::NotOffice => "NOT_OFFICE",
            WatchError::OutsideRoot => "OUTSIDE_ROOT",
            WatchError::StartFailed(_) => "START_FAILED",
            WatchError::PortTimeout(_) => "PORT_TIMEOUT",
            WatchError::NoPort => "NO_PORT",
            WatchError::TooMany => "TOO_MANY",
            WatchError::Io(_) => "IO",
        }
    }
}

impl From<std::io::Error> for WatchError {
    fn from(err: std::io::Error) -> Self {
        WatchError::Io(err.to_string())
    }
}

impl From<WatchError> for AppCommandError {
    /// Carry the stable `code()` into `i18n_params.watchCode` so the frontend
    /// can branch on it (install guide vs. retry) without substring-matching
    /// the English message.
    fn from(err: WatchError) -> Self {
        let params = BTreeMap::from([("watchCode".to_string(), err.code().to_string())]);
        let base = match &err {
            WatchError::NotInstalled => AppCommandError::dependency_missing(err.to_string()),
            WatchError::NotOffice | WatchError::OutsideRoot => {
                AppCommandError::invalid_input(err.to_string())
            }
            _ => AppCommandError::task_execution_failed(err.to_string()),
        };
        base.with_i18n("Folder.fileWorkspacePanel.officeWatchError", params)
    }
}

/// Returned by `start_office_watch_core` — the loopback port the watch HTTP
/// server is listening on, plus a per-watch capability token.
///
/// `cap` is a high-entropy secret minted when the watch first spawns and
/// returned (stable) for the life of that watch. The server-mode reverse proxy
/// authenticates every request against it instead of the global server token,
/// so (a) the master `CODEG_TOKEN` never enters the preview iframe, and (b) a
/// leaked `cap` only grants access to that one open document's watch — minting
/// it requires the Bearer-authed `start_office_watch` API, so only an
/// already-authenticated user can obtain one. Desktop loads the loopback URL
/// directly (no proxy), but every preview names its watch by `cap` when it
/// releases it or asks whether it is still live: a respawn mints a new one.
///
/// `hold` names the hold a web page's start took ("Who holds a watch" above);
/// the page names it again when it renews or releases. Absent for a desktop
/// window, whose references are only counted.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchStarted {
    pub port: u16,
    pub cap: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold: Option<String>,
}

/// Who takes a reference on a watch: a desktop window (the Tauri commands) or
/// a web page (the HTTP API). See "Who holds a watch" above.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WatchHolder {
    Desktop,
    Web,
}

// ─── Process-pool state ─────────────────────────────────────────────────

struct WatchInstance {
    child: Child,
    port: u16,
    /// Per-watch capability the proxy authenticates against (see `OfficeWatchStarted`).
    cap: String,
    file_canonical: PathBuf,
    /// References desktop windows hold. Only their releases (and app exit) take
    /// them off: a desktop preview loads loopback directly, so it never shows a
    /// sign of life here, and sweeping it by idle would yank it from the user.
    desktop_refs: usize,
    /// Web pages' holds, by the id each start handed out, with when each was
    /// last renewed (or taken). The sweep also drops a hold that has gone
    /// quiet (see [`WEB_HOLD_GRACE`]).
    web_holds: HashMap<String, Instant>,
    /// The watch's last web traffic: a proxied request, an SSE connection
    /// opening or closing. While it is recent no web hold lapses, whoever it
    /// came from.
    last_web_activity: Instant,
    /// Number of live SSE (`/events`) connections the proxy currently holds open
    /// for this watch. While ≥1 a page is showing it, which keeps every web
    /// hold however long ago it was renewed.
    sse_leases: usize,
}

/// File-canonical-path → live watch process. The single source of truth: the
/// proxy authenticates against this (port + live child + cap), so there is no
/// separate port table to drift out of sync. Short critical sections only.
static OFFICE_WATCHES: LazyLock<Mutex<HashMap<String, WatchInstance>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Per-key async lock serializing concurrent starts for the same file, so two
/// tabs opening the same file in one tick can't each spawn a process. Held
/// across the async ready wait, hence a `tokio::sync::Mutex`. Entries are pruned
/// after a spawn so the map can't grow unbounded over a long server's lifetime.
static SPAWN_LOCKS: LazyLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_watches() -> MutexGuard<'static, HashMap<String, WatchInstance>> {
    OFFICE_WATCHES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Children whose start is still waiting for them to announce readiness, each
/// under its start's id until that start takes it back ([`StartingChild`]).
/// Quitting kills these along with the running watches: the process ends
/// without dropping a pending start, so its child's `kill_on_drop` never fires,
/// and an officecli left behind finishes starting, serves nobody, and makes
/// every later watch of its file exit ("Another watch process is already
/// running") until it idles out five minutes later.
static STARTING: LazyLock<Mutex<Starting>> = LazyLock::new(|| Mutex::new(Starting::default()));

#[derive(Default)]
struct Starting {
    children: HashMap<u64, Child>,
    next_id: u64,
    /// Set for good once quitting has taken the children: a start that gets
    /// its child going after that kills it instead of parking it.
    quitting: bool,
}

fn lock_starting() -> MutexGuard<'static, Starting> {
    STARTING.lock().unwrap_or_else(|p| p.into_inner())
}

/// A start's claim on the child it parked in [`STARTING`]. Dropping the claim,
/// as an abandoned start does, reaps the child.
struct StartingChild(u64);

impl StartingChild {
    /// Park `child`, or kill it if the app is quitting (`None`).
    fn park(child: Child) -> Option<Self> {
        let mut starting = lock_starting();
        if starting.quitting {
            drop(starting);
            reap(child);
            return None;
        }
        let id = starting.next_id;
        starting.next_id += 1;
        starting.children.insert(id, child);
        Some(Self(id))
    }

    /// The child back, or `None` once quitting has killed it.
    fn take(self) -> Option<Child> {
        let mut starting = lock_starting();
        let child = starting.children.remove(&self.0);
        // Unlocked before `self` drops, which locks it again.
        drop(starting);
        child
    }
}

impl Drop for StartingChild {
    fn drop(&mut self) {
        let child = lock_starting().children.remove(&self.0);
        if let Some(child) = child {
            reap(child);
        }
    }
}

/// Reap a child without blocking the caller.
///
/// The signal goes out HERE, on the calling thread. Killing from the detached
/// task instead would make the kill depend on that task being polled, and the
/// callers who most need it are the ones whose runtime is about to go away —
/// a shutdown, or a `#[tokio::test]` returning — where a queued task is simply
/// dropped and the child lives on. (Watch children are also `kill_on_drop`,
/// which is a second net, not the first one.)
///
/// The `wait()` is what still belongs on a task: it only keeps the killed
/// child from lingering as a zombie while the app keeps running, and losing it
/// at shutdown costs nothing — the OS reaps our orphans.
fn reap(mut child: Child) {
    let _ = child.start_kill();
    if let Ok(handle) = tokio::runtime::Handle::try_current() {
        handle.spawn(async move {
            let _ = child.wait().await;
        });
    }
}

fn spawn_lock_for(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .entry(key.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

// ─── Path handling ──────────────────────────────────────────────────────

/// Canonical registry key for a file. Case-folded on Windows so the same file
/// referenced with different casing collapses to one watch.
fn watch_key(canonical: &Path) -> String {
    let s = canonical.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        s.to_lowercase()
    } else {
        s
    }
}

/// Resolve `rel_path` against `root_path`, canonicalize, confine to the root,
/// and require an office extension — the same defense-in-depth as
/// `officecli_render_html` (so a tab path can never escape the workspace).
fn resolve_office_target(root_path: &str, rel_path: &str) -> Result<PathBuf, WatchError> {
    let root = PathBuf::from(root_path);
    if !root.is_dir() {
        return Err(WatchError::Io("workspace root does not exist".to_string()));
    }
    let target = resolve_tree_path(&root, rel_path).map_err(|e| WatchError::Io(e.to_string()))?;
    let canonical_root = std::fs::canonicalize(&root)?;
    let canonical_target = std::fs::canonicalize(&target)?;
    if !canonical_target.starts_with(&canonical_root) {
        return Err(WatchError::OutsideRoot);
    }
    if !canonical_target.is_file() {
        return Err(WatchError::Io("path is not a file".to_string()));
    }
    if !is_office_path(&canonical_target) {
        return Err(WatchError::NotOffice);
    }
    Ok(canonical_target)
}

/// Best-effort key for `stop` — falls back to a loose canonicalization so a
/// since-deleted file can still be released by key.
fn loose_key(root_path: &str, rel_path: &str) -> Option<String> {
    if let Ok(canonical) = resolve_office_target(root_path, rel_path) {
        return Some(watch_key(&canonical));
    }
    let root = PathBuf::from(root_path);
    let target = resolve_tree_path(&root, rel_path).ok()?;
    let canonical = std::fs::canonicalize(&target).unwrap_or(target);
    Some(watch_key(&canonical))
}

// ─── Spawn / readiness ──────────────────────────────────────────────────

/// Ask the OS for a free loopback port by binding to `:0` then releasing it.
/// officecli binds it only after rendering the document, so another process can
/// take it in between; the readiness check catches that rare loss as
/// `PortTimeout`/`StartFailed`, since it needs our own child to announce the port.
fn allocate_free_port() -> Result<u16, WatchError> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|_| WatchError::NoPort)?;
    let port = listener.local_addr().map_err(|_| WatchError::NoPort)?.port();
    drop(listener);
    Ok(port)
}

/// Parse officecli's readiness line, e.g. `Watch: http://localhost:26411`, into
/// the port it actually bound. Returns `None` for any other stdout line.
fn parse_watch_port(line: &str) -> Option<u16> {
    let line = line.trim_start();
    if !line.starts_with("Watch:") {
        return None;
    }
    // Take the run of digits immediately after the last ':' (tolerates an
    // optional trailing path like `…:26411/`).
    let after = line.rsplit(':').next()?;
    let digits: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u16>().ok()
}

/// Wait for the freshly-spawned watch to announce readiness on stdout, then
/// confirm it's reachable. Reading *our child's own stdout* for the
/// `Watch: http://…:<port>` line positively identifies the listener as this
/// officecli — closing the gap where the bind-to-`:0`-then-release port could
/// be snatched by another process between release and officecli binding it
/// (a TCP-accept probe alone can't tell whose listener answered). On success
/// the stdout reader is handed to a background drain so a chatty watch can't
/// dead-lock on a full pipe.
async fn await_ready(port: u16, stdout: ChildStdout, timeout: Duration) -> Result<(), WatchError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + timeout;

    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(WatchError::PortTimeout(
                "officecli did not announce readiness in time".to_string(),
            ));
        }
        match tokio::time::timeout(remaining, lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                let Some(bound) = parse_watch_port(&line) else {
                    continue; // a non-readiness line (Watching:, Press Ctrl+C, …)
                };
                if bound != port {
                    return Err(WatchError::PortTimeout(format!(
                        "officecli bound port {bound}, expected {port}"
                    )));
                }
                // Confirm the announced server actually accepts a connection.
                if tokio::time::timeout(
                    READY_CONNECT_TIMEOUT,
                    TcpStream::connect(("127.0.0.1", port)),
                )
                .await
                .map(|r| r.is_ok())
                .unwrap_or(false)
                {
                    // Keep the pipe drained for the child's lifetime.
                    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });
                    return Ok(());
                }
                return Err(WatchError::PortTimeout(
                    "officecli announced ready but the port did not accept".to_string(),
                ));
            }
            Ok(Ok(None)) => {
                return Err(WatchError::StartFailed(
                    "officecli exited before announcing readiness".to_string(),
                ));
            }
            Ok(Err(e)) => return Err(WatchError::StartFailed(e.to_string())),
            Err(_) => {
                return Err(WatchError::PortTimeout(
                    "officecli did not announce readiness in time".to_string(),
                ));
            }
        }
    }
}

/// Drain a killed child's stderr (best-effort, time-boxed) for diagnostics.
async fn drain_stderr(child: &mut Child) -> String {
    use tokio::io::AsyncReadExt;
    let Some(mut err) = child.stderr.take() else {
        return String::new();
    };
    let mut buf = Vec::new();
    let _ = tokio::time::timeout(Duration::from_millis(500), err.read_to_end(&mut buf)).await;
    String::from_utf8_lossy(&buf).trim().to_string()
}

// ─── Public API: start / stop / introspection ───────────────────────────

/// Ensure a watch server is running for `path` (relative to `root_path`) and
/// return its loopback port. Shares an existing process by ref-count; only
/// spawns when none is live. The reference is `holder`'s; a web page's is a
/// hold, named in the result.
pub async fn start_office_watch_core(
    root_path: String,
    path: String,
    holder: WatchHolder,
) -> Result<OfficeWatchStarted, WatchError> {
    start_within(root_path, path, holder, READY_TIMEOUT).await
}

/// [`start_office_watch_core`], giving up once the whole start has taken
/// `budget` — waiting for another start of the same file included, so the
/// caller hears back in time whatever else is starting that file.
async fn start_within(
    root_path: String,
    path: String,
    holder: WatchHolder,
    budget: Duration,
) -> Result<OfficeWatchStarted, WatchError> {
    let deadline = Instant::now() + budget;
    let canonical_target = resolve_office_target(&root_path, &path)?;
    let key = watch_key(&canonical_target);

    // Fast path: a live process already exists → just share it. This path
    // intentionally does not need the officecli binary on disk.
    if let Some(started) = reuse_live(&key, holder) {
        return Ok(started);
    }

    // Slow path: serialize same-file spawns, then double-check. The per-key
    // entry stays in `SPAWN_LOCKS` for as long as any task references it (so
    // serialization is never broken mid-spawn); the idle sweep prunes entries no
    // task holds (`Arc::strong_count == 1`), bounding the map's growth.
    let spawn_lock = spawn_lock_for(&key);
    let Ok(_guard) = tokio::time::timeout_at(deadline.into(), spawn_lock.lock()).await else {
        return Err(WatchError::PortTimeout(
            "another start of this file did not finish in time".to_string(),
        ));
    };
    if let Some(started) = reuse_live(&key, holder) {
        return Ok(started);
    }
    // Count the watches still starting too: each is an officecli process
    // already, and one can take a while to come up.
    let running = lock_watches().len();
    let starting = lock_starting().children.len();
    if running + starting >= MAX_CONCURRENT_WATCHES {
        return Err(WatchError::TooMany);
    }

    let officecli = resolve_officecli().ok_or(WatchError::NotInstalled)?;
    let port = allocate_free_port()?;
    // Mint the per-watch capability the proxy will authenticate against.
    let cap = uuid::Uuid::new_v4().simple().to_string();
    let mut child = tokio_command(&officecli)
        .arg("watch")
        .arg(&canonical_target)
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| WatchError::StartFailed(e.to_string()))?;

    // Park the child where quitting can reach it while it comes up.
    let stdout = child.stdout.take();
    let Some(parked) = StartingChild::park(child) else {
        return Err(WatchError::StartFailed("the app is quitting".to_string()));
    };
    let ready = match stdout {
        Some(stdout) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            await_ready(port, stdout, remaining).await
        }
        None => Err(WatchError::StartFailed("no stdout pipe".to_string())),
    };
    if let Err(ready_err) = ready {
        let stderr = match parked.take() {
            Some(mut child) => {
                let _ = child.start_kill();
                let stderr = drain_stderr(&mut child).await;
                reap(child);
                stderr
            }
            // Quitting killed it already.
            None => String::new(),
        };
        return Err(ready_err.with_stderr(&stderr));
    }

    // Register. Re-check after the async gap: another task may have won the
    // race for this same file while we were waiting — if so, adopt theirs and
    // reap ours.
    let result = {
        let mut watches = lock_watches();
        // Taken back under the pool lock, so a quit draining both either finds
        // the child registered or has already killed it.
        let Some(child) = parked.take() else {
            return Err(WatchError::StartFailed(
                "stopped while officecli was starting".to_string(),
            ));
        };
        if let Some(entry) = watches.get_mut(&key) {
            if matches!(entry.child.try_wait(), Ok(None)) {
                let winner = take_ref(entry, holder);
                drop(watches);
                reap(child);
                Ok(winner)
            } else {
                // A dead entry squats the key — replace it below.
                watches.remove(&key);
                register_new(
                    watches,
                    key.clone(),
                    child,
                    port,
                    cap.clone(),
                    canonical_target,
                    holder,
                )
            }
        } else if watches.len() >= MAX_CONCURRENT_WATCHES {
            // Enforce the cap atomically under the pool lock — per-file spawn
            // locks don't serialize *across different files*, so the early
            // pre-spawn check can be raced past by concurrent first-opens.
            drop(watches);
            reap(child);
            Err(WatchError::TooMany)
        } else {
            register_new(
                watches,
                key.clone(),
                child,
                port,
                cap.clone(),
                canonical_target,
                holder,
            )
        }
    };
    result
}

/// Insert a fresh watch under `key` while holding the pool lock, with the one
/// reference `holder` took. Factored out so the register path has a single
/// construction site for `WatchInstance`.
fn register_new(
    mut watches: MutexGuard<'static, HashMap<String, WatchInstance>>,
    key: String,
    child: Child,
    port: u16,
    cap: String,
    file_canonical: PathBuf,
    holder: WatchHolder,
) -> Result<OfficeWatchStarted, WatchError> {
    let mut entry = WatchInstance {
        child,
        port,
        cap,
        file_canonical,
        desktop_refs: 0,
        web_holds: HashMap::new(),
        last_web_activity: Instant::now(),
        sse_leases: 0,
    };
    let started = take_ref(&mut entry, holder);
    watches.insert(key, entry);
    Ok(started)
}

/// Take one more reference by `holder` on `entry`: count a desktop window's,
/// mint a web page's hold. The hold is fresh, so a page that vanished while
/// its watch was still spawning, before it could load the preview, keeps the
/// watch only for the grace.
fn take_ref(entry: &mut WatchInstance, holder: WatchHolder) -> OfficeWatchStarted {
    let hold = match holder {
        WatchHolder::Desktop => {
            entry.desktop_refs += 1;
            None
        }
        WatchHolder::Web => {
            let hold = uuid::Uuid::new_v4().simple().to_string();
            entry.web_holds.insert(hold.clone(), Instant::now());
            Some(hold)
        }
    };
    OfficeWatchStarted {
        port: entry.port,
        cap: entry.cap.clone(),
        hold,
    }
}

/// Fast-path helper: if a live watch exists for `key`, take `holder`'s new
/// reference on it and return it started; if the entry is dead, reap + prune
/// it so the slow path respawns.
fn reuse_live(key: &str, holder: WatchHolder) -> Option<OfficeWatchStarted> {
    let mut watches = lock_watches();
    let entry = watches.get_mut(key)?;
    match entry.child.try_wait() {
        Ok(None) => Some(take_ref(entry, holder)),
        _ => {
            // Dead or errored — prune so the slow path respawns.
            if let Some(dead) = watches.remove(key) {
                reap(dead.child);
            }
            None
        }
    }
}

/// The pool key a [`loose_key`] refers to: that key, or — for a file that has
/// since moved and keys differently — the entry whose canonical path keys the
/// same.
fn find_watch_key(watches: &HashMap<String, WatchInstance>, key: String) -> Option<String> {
    if watches.contains_key(&key) {
        return Some(key);
    }
    watches
        .iter()
        .find_map(|(k, entry)| (watch_key(&entry.file_canonical) == key).then(|| k.clone()))
}

/// Release one reference `holder` took on the watch for `path`. Kills the
/// process when the last reference of either kind goes away. Idempotent
/// (closing an already-stopped tab is OK).
///
/// `cap` names the watch the caller acquired (what its start returned). When
/// the live watch for the file is a different one, the release is a no-op:
/// the caller's watch is already gone — stopped with its folder, its worktree
/// removed, crashed — and a reference it never took must not come off the
/// watch that replaced it, which would kill another surface's preview. `None`
/// (or empty) releases whatever watch serves the file, as before.
///
/// A web page's release names its hold too, and only that one comes off, none
/// if it already lapsed: a page's late release must not take another page's
/// hold. Without one (an older client) any one web hold comes off. A desktop
/// window's release takes one of its counted references. Neither ever takes
/// the other kind's.
pub async fn stop_office_watch_core(
    root_path: String,
    path: String,
    cap: Option<String>,
    hold: Option<String>,
    holder: WatchHolder,
) -> Result<(), WatchError> {
    let Some(key) = loose_key(&root_path, &path) else {
        return Ok(());
    };

    let mut watches = lock_watches();
    let Some(target_key) = find_watch_key(&watches, key) else {
        return Ok(());
    };
    let Some(entry) = watches.get_mut(&target_key) else {
        return Ok(());
    };
    if let Some(cap) = cap.as_deref().filter(|cap| !cap.is_empty()) {
        if !constant_time_eq(entry.cap.as_bytes(), cap.as_bytes()) {
            return Ok(());
        }
    }
    let released = match holder {
        WatchHolder::Desktop => {
            let had = entry.desktop_refs > 0;
            entry.desktop_refs = entry.desktop_refs.saturating_sub(1);
            had
        }
        WatchHolder::Web => {
            let named = hold.filter(|hold| !hold.is_empty());
            let hold = named.or_else(|| entry.web_holds.keys().next().cloned());
            hold.is_some_and(|hold| entry.web_holds.remove(&hold).is_some())
        }
    };
    if !released || entry.desktop_refs > 0 || !entry.web_holds.is_empty() {
        return Ok(());
    }
    if let Some(entry) = watches.remove(&target_key) {
        // Removing the entry instantly closes the proxy gate (validate looks it
        // up here), so the port can't be forwarded the moment it's unservable.
        drop(watches);
        reap(entry.child);
    }
    Ok(())
}

/// Renew `holder`'s hold on the watch named by `cap`, and say whether that
/// watch is still the live one serving `path`: a running child for the file
/// whose capability is `cap`. False once that watch was stopped (its last
/// release, its folder removed, the sweep), crashed, or replaced by a respawn,
/// which mints a new capability.
///
/// Every preview asks this on a timer, and when it is shown again after being
/// kept out of sight, so it can start over instead of going on showing a dead
/// page. A web page names its hold, and the renewal is what keeps it: a
/// preview kept out of sight holds no SSE connection ([`WEB_HOLD_GRACE`]). A
/// hold that lapsed meanwhile (the machine asleep, say, while the watch lived
/// on for a desktop window) is taken again. A renewal naming no hold only
/// asks: every web client that renews names the hold its start returned, and
/// one that never renews (an older page) keeps its watch by its SSE
/// connection. A desktop window's references never lapse, so for it this
/// only asks.
///
/// Either way the watch hears of it ([`keep_alive`]): officecli ends a watch
/// that goes five minutes with no SSE client and no request, and a preview
/// kept out of sight in a browser window holds no SSE client.
pub fn renew_office_watch_core(
    root_path: &str,
    path: &str,
    cap: &str,
    hold: Option<&str>,
    holder: WatchHolder,
) -> bool {
    if cap.is_empty() {
        return false;
    }
    let Some(key) = loose_key(root_path, path) else {
        return false;
    };
    let mut watches = lock_watches();
    let Some(target_key) = find_watch_key(&watches, key) else {
        return false;
    };
    let Some(entry) = watches.get_mut(&target_key) else {
        return false;
    };
    if !is_live(entry) || !constant_time_eq(entry.cap.as_bytes(), cap.as_bytes()) {
        return false;
    }
    if let (WatchHolder::Web, Some(hold)) = (holder, hold.filter(|hold| !hold.is_empty())) {
        entry.web_holds.insert(hold.to_string(), Instant::now());
    }
    let port = entry.port;
    drop(watches);
    keep_alive(port);
    true
}

/// Ask the watch on `port` for its status, without waiting for the answer.
///
/// officecli shuts a watch down by itself once no SSE client has been
/// connected and nothing has counted as activity for five minutes (its
/// `WatchServer` idle watchdog; `OFFICECLI_WATCH_IDLE_SECONDS`). A status
/// request counts, so a watch a preview still renews never idles out from
/// under it; how long it lives stays this pool's call.
fn keep_alive(port: u16) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        return;
    };
    handle.spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let _ = tokio::time::timeout(KEEP_ALIVE_TIMEOUT, async {
            let mut stream = TcpStream::connect(("127.0.0.1", port)).await?;
            stream
                .write_all(
                    b"GET /api/status HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )
                .await?;
            let mut answer = Vec::new();
            stream.read_to_end(&mut answer).await
        })
        .await;
    });
}

/// Whether `entry`'s child is still running. A `find`/`any` predicate can't call
/// `try_wait` (it needs `&mut`, the predicate gets `&`), so callers use this from
/// a `values_mut()` loop where each item is already `&mut`.
fn is_live(entry: &mut WatchInstance) -> bool {
    !matches!(entry.child.try_wait(), Ok(Some(_)))
}

// All port lookups below scan for a *live* entry, skipping any dead one that may
// still squat the same port until the sweep prunes it — so a crashed watch can't
// shadow a port the OS has since re-assigned to a new watch. At most one *live*
// watch ever holds a given port.

/// Note a web page's sign of life on a watch. Called by the server-mode proxy
/// on every request it forwards (desktop previews never come through it).
pub fn note_proxy_request(port: u16) {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            entry.last_web_activity = Instant::now();
            return;
        }
    }
}

/// Account a newly-opened SSE (`/events`) connection through the proxy. Paired
/// with [`release_sse_lease`] when the connection drops.
pub fn acquire_sse_lease(port: u16) {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            entry.sse_leases += 1;
            entry.last_web_activity = Instant::now();
            return;
        }
    }
}

/// Release an SSE connection accounted by [`acquire_sse_lease`]. Noting it as a
/// sign of life starts the grace before the sweep drops web pages' hold on a
/// watch whose last connection just closed.
pub fn release_sse_lease(port: u16) {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            entry.sse_leases = entry.sse_leases.saturating_sub(1);
            entry.last_web_activity = Instant::now();
            return;
        }
    }
}

/// The SSRF gate: true only for a port currently bound to a *live* watch.
pub fn is_known_watch_port(port: u16) -> bool {
    let mut watches = lock_watches();
    watches.values_mut().any(|e| e.port == port && is_live(e))
}

/// The server-mode proxy's auth gate: the request's `port` must belong to a watch
/// whose child is still alive **and** the request must carry that watch's exact
/// capability. Checking liveness here (not a separate port table) means a crashed
/// watch's port stops being forwardable on the very next request — closing the
/// window where the OS could re-assign the freed port to another loopback
/// service. Constant-time compare so a mismatched cap can't be probed by timing.
pub fn validate_watch_cap(port: u16, cap: &str) -> bool {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            return constant_time_eq(entry.cap.as_bytes(), cap.as_bytes());
        }
    }
    false
}

/// Length-aware constant-time byte comparison (no early return on first
/// mismatch). The caps are 122-bit random so this is belt-and-suspenders.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// Seed a live watch entry (backed by a real long-lived child bound to `port`)
/// so proxy integration tests can exercise the gate without a real officecli.
/// Unix-only at runtime (`sleep`); on Windows CI `cargo test` is `--no-run`.
#[cfg(feature = "test-utils")]
pub fn insert_known_port_for_test(port: u16, cap: &str) {
    let child = tokio_command("sleep")
        .arg("600")
        // Like the real watch child: a test that panics before it removes the
        // entry must not leave the sleeper behind.
        .kill_on_drop(true)
        .spawn()
        .expect("spawn test sleeper");
    lock_watches().insert(
        format!("__test__:{port}"),
        WatchInstance {
            child,
            port,
            cap: cap.to_string(),
            file_canonical: PathBuf::from(format!("/__test__/{port}")),
            desktop_refs: 0,
            web_holds: HashMap::from([("__test__".to_string(), Instant::now())]),
            last_web_activity: Instant::now(),
            sse_leases: 0,
        },
    );
}

#[cfg(feature = "test-utils")]
pub fn remove_known_port_for_test(port: u16) {
    if let Some(entry) = lock_watches().remove(&format!("__test__:{port}")) {
        reap(entry.child);
    }
}

/// Kill every watch process, those still starting included, and let no start
/// get one going afterwards. Used on app/server shutdown.
pub fn stop_all_office_watches() -> usize {
    let (drained, starting) = {
        let mut watches = lock_watches();
        // Both under the pool lock: a start registering its child right now
        // either has it in the pool already or finds it gone (see `start_within`).
        let starting = take_starting_children();
        (watches.drain().collect::<Vec<_>>(), starting)
    };
    let n = drained.len() + starting.len();
    for (_, entry) in drained {
        reap(entry.child);
    }
    for child in starting {
        reap(child);
    }
    n
}

/// Take every child a start is still waiting for, and refuse any child started
/// from now on; those starts then fail.
fn take_starting_children() -> Vec<Child> {
    let mut starting = lock_starting();
    starting.quitting = true;
    starting.children.drain().map(|(_, child)| child).collect()
}

/// Kill every watch whose file lives under `root_path`. Used when a folder is
/// removed from the workspace (belt-and-suspenders over per-tab unmount).
pub fn stop_office_watches_under_root(root_path: &str) -> usize {
    let root = PathBuf::from(root_path);
    let root_canonical = std::fs::canonicalize(&root).unwrap_or(root);

    let mut watches = lock_watches();
    let keys: Vec<String> = watches
        .iter()
        .filter(|(_, e)| e.file_canonical.starts_with(&root_canonical))
        .map(|(k, _)| k.clone())
        .collect();

    let mut removed = Vec::with_capacity(keys.len());
    for k in &keys {
        if let Some(entry) = watches.remove(k) {
            removed.push(entry);
        }
    }
    drop(watches);

    let n = removed.len();
    for entry in removed {
        reap(entry.child);
    }
    n
}

// ─── Idle / dead-child sweep ─────────────────────────────────────────────

/// Read the idle timeout from `CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS`. `0`
/// disables the sweep; unparseable falls back to the default.
pub fn idle_timeout_from_env() -> Option<Duration> {
    let secs = match std::env::var("CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS") {
        Ok(raw) => raw.parse::<u64>().unwrap_or(DEFAULT_IDLE_TIMEOUT_SECS),
        Err(_) => DEFAULT_IDLE_TIMEOUT_SECS,
    };
    (secs != 0).then(|| Duration::from_secs(secs))
}

/// Reap watches that are no longer needed, and drop web holds that lapsed:
/// - **dead children** (a crashed watch must not linger);
/// - **quiet web holds** — while no page has an SSE connection to the watch
///   open (`sse_leases == 0`) and none has sent it a request for
///   [`WEB_HOLD_GRACE`], a hold not renewed within the grace either is
///   dropped. This is the backstop for a browser tab that closed / crashed /
///   lost network before its `stop_office_watch` arrived, so its hold never
///   came off. The watch is reaped once no hold is left, unless a desktop
///   window holds it too. A desktop window's references never lapse: its
///   preview connects loopback directly, so no sign of life reaches here, and
///   reaping it by idle would yank it from under the user;
/// - **unheld stragglers** — no references of either kind past the idle
///   window (the last release removes the entry, so this is a backstop).
pub fn sweep_office_watches(idle_timeout: Duration) -> usize {
    let now = Instant::now();
    let mut watches = lock_watches();
    // First pass (needs `&mut` for `try_wait`): drop lapsed web holds and
    // collect the keys to reap.
    let keys: Vec<String> = watches
        .iter_mut()
        .filter_map(|(k, entry)| {
            let quiet = now.duration_since(entry.last_web_activity);
            let held = entry.web_holds.len();
            if entry.sse_leases == 0 && quiet > WEB_HOLD_GRACE {
                entry
                    .web_holds
                    .retain(|_, renewed| now.duration_since(*renewed) <= WEB_HOLD_GRACE);
            }
            let lapsed = entry.web_holds.len() < held;
            let unheld = entry.desktop_refs == 0 && entry.web_holds.is_empty();
            let dead = matches!(entry.child.try_wait(), Ok(Some(_)));
            (dead || (unheld && (lapsed || quiet > idle_timeout))).then(|| k.clone())
        })
        .collect();
    let mut children: Vec<Child> = Vec::with_capacity(keys.len());
    for k in &keys {
        if let Some(entry) = watches.remove(k) {
            children.push(entry.child);
        }
    }
    drop(watches);
    let n = children.len();
    for child in children {
        reap(child);
    }

    // Prune spawn-lock entries no in-flight start references. `strong_count == 1`
    // means only the map holds the `Arc` (every active/waiting start holds its
    // own clone), so removing it can't strand a waiter or break per-key
    // serialization — bounding the map's growth over a long server's lifetime.
    SPAWN_LOCKS
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|_, arc| Arc::strong_count(arc) > 1);

    n
}

/// Long-running sweep task, spawned once per binary (desktop + server). Never
/// exits on its own; the process dying cleans everything up (plus kill_on_drop).
pub async fn office_watch_idle_sweep_task(idle_timeout: Duration, interval: Duration) {
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    // First tick is immediate — skip it so we don't sweep before any watch settles.
    ticker.tick().await;
    loop {
        ticker.tick().await;
        let n = sweep_office_watches(idle_timeout);
        if n > 0 {
            tracing::info!("[office-watch] idle sweep reaped {n} watch process(es)");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_errors_keep_one_prefix_and_child_diagnostics() {
        for stderr in ["", "renderer failed"] {
            let timeout =
                WatchError::PortTimeout("officecli did not announce readiness in time".into())
                    .with_stderr(stderr);
            assert_eq!(timeout.code(), "PORT_TIMEOUT");
            assert_eq!(
                timeout
                    .to_string()
                    .matches("officecli watch did not become ready in time:")
                    .count(),
                1
            );
            assert_eq!(
                timeout.to_string().contains("renderer failed"),
                !stderr.is_empty()
            );

            let failed =
                WatchError::StartFailed("officecli exited before announcing readiness".into())
                    .with_stderr(stderr);
            assert_eq!(failed.code(), "START_FAILED");
            assert_eq!(
                failed
                    .to_string()
                    .matches("failed to start officecli watch:")
                    .count(),
                1
            );
            assert_eq!(
                failed.to_string().contains("renderer failed"),
                !stderr.is_empty()
            );
        }
    }

    #[cfg(unix)]
    fn readiness_child(script: &str, port: u16) -> Child {
        tokio_command("sh")
            .args(["-c", script, "watch-fixture", &port.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    #[cfg(unix)]
    fn stdout_of(child: &mut Child) -> ChildStdout {
        child.stdout.take().unwrap()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_accepts_startup_slower_than_eight_seconds() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = readiness_child(
            "sleep 9; printf 'Watch: http://localhost:%s\\n' \"$1\"; exec sleep 600",
            port,
        );
        let result = await_ready(port, stdout_of(&mut child), READY_TIMEOUT).await;
        reap(child);
        assert!(
            result.is_ok(),
            "slow watch startup should succeed: {result:?}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_still_requires_the_child_announcement() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = readiness_child("exec sleep 600", port);
        let result = await_ready(port, stdout_of(&mut child), Duration::from_millis(100)).await;
        reap(child);
        assert!(matches!(result, Err(WatchError::PortTimeout(_))));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn readiness_rejects_wrong_port_and_early_exit() {
        let port = allocate_free_port().unwrap();
        let mut wrong_port = readiness_child("printf 'Watch: http://localhost:0\\n'", port);
        let result = await_ready(port, stdout_of(&mut wrong_port), READY_TIMEOUT).await;
        reap(wrong_port);
        assert!(
            matches!(result, Err(WatchError::PortTimeout(detail)) if detail.contains("expected"))
        );

        let mut exited = readiness_child("exit 1", port);
        let result = await_ready(port, stdout_of(&mut exited), READY_TIMEOUT).await;
        reap(exited);
        assert!(matches!(result, Err(WatchError::StartFailed(_))));
    }

    /// A start queued behind another start of the same file answers within its
    /// own budget. Waiting that start out first and then spending a whole budget
    /// of its own would outlast the frontend's request deadline.
    #[tokio::test]
    async fn a_start_queued_behind_another_answers_within_its_budget() {
        let dir = std::env::temp_dir().join(format!("codeg-ow-queued-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("queued.docx");
        std::fs::write(&docx, b"x").unwrap();
        let key = watch_key(&std::fs::canonicalize(&docx).unwrap());

        // Another start of the file holds its spawn lock and never finishes.
        let spawn_lock = spawn_lock_for(&key);
        let _other_start = spawn_lock.lock().await;

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            start_within(
                dir.to_string_lossy().to_string(),
                "queued.docx".into(),
                WatchHolder::Desktop,
                Duration::from_millis(300),
            ),
        )
        .await
        .expect("the queued start must give up once its budget is spent");
        assert!(
            matches!(result, Err(WatchError::PortTimeout(_))),
            "{result:?}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A start queued behind another start of the same file shares the watch
    /// that start registered, once it lets go of the file.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_queued_start_shares_the_watch_the_other_start_registered() {
        let dir = std::env::temp_dir().join(format!("codeg-ow-shared-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("shared.docx");
        std::fs::write(&docx, b"x").unwrap();
        let key = watch_key(&std::fs::canonicalize(&docx).unwrap());

        // Another start of the file is under way when this one comes in.
        let spawn_lock = spawn_lock_for(&key);
        let other_start = spawn_lock.lock().await;
        let queued = tokio::spawn(start_within(
            dir.to_string_lossy().to_string(),
            "shared.docx".into(),
            WatchHolder::Desktop,
            Duration::from_secs(10),
        ));
        // It holds the file's spawn lock too once it is waiting for it.
        for _ in 0..200 {
            if Arc::strong_count(&spawn_lock) > 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(Arc::strong_count(&spawn_lock) > 2, "the start never queued");

        // The other start registers its watch, then lets go.
        let port = allocate_free_port().unwrap();
        seed_live_watch(&key, port, "winner-cap");
        drop(other_start);

        // At once: sharing it needs no officecli of its own.
        let started = tokio::time::timeout(Duration::from_secs(1), queued)
            .await
            .expect("the queued start should share the watch without starting officecli")
            .unwrap()
            .unwrap();
        assert_eq!((started.port, started.cap.as_str()), (port, "winner-cap"));
        assert_eq!(lock_watches().get(&key).unwrap().desktop_refs, 2);

        if let Some(entry) = lock_watches().remove(&key) {
            reap(entry.child);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Park a child as a start would, with its stdout, which closes once the
    /// child is gone. Short-lived, so one a broken claim strands still ends.
    #[cfg(unix)]
    fn park_sleeper() -> (StartingChild, ChildStdout) {
        let mut child = tokio_command("sleep")
            .arg("30")
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdout = stdout_of(&mut child);
        let Some(parked) = StartingChild::park(child) else {
            panic!("no test quits the app");
        };
        (parked, stdout)
    }

    /// A start abandoned while its child comes up (its request went away)
    /// takes the child down with it instead of leaving it parked.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_abandoned_start_kills_its_child() {
        use tokio::io::AsyncReadExt;

        let (parked, mut stdout) = park_sleeper();
        drop(parked);

        let mut rest = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), stdout.read_to_end(&mut rest))
            .await
            .expect("the child should die with its start")
            .unwrap();
    }

    /// Watches still starting count against the process cap: each is an
    /// officecli process already, and may take a while to come up.
    #[cfg(unix)]
    #[tokio::test]
    async fn watches_still_starting_count_against_the_cap() {
        let parked: Vec<_> = (0..MAX_CONCURRENT_WATCHES)
            .map(|_| park_sleeper())
            .collect();

        let dir = std::env::temp_dir().join(format!("codeg-ow-cap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("one-more.xlsx"), b"x").unwrap();
        let result = start_within(
            dir.to_string_lossy().to_string(),
            "one-more.xlsx".into(),
            WatchHolder::Desktop,
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(result, Err(WatchError::TooMany)), "{result:?}");

        drop(parked);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn error_code_mapping_is_stable() {
        assert_eq!(WatchError::NotInstalled.code(), "NOT_INSTALLED");
        assert_eq!(WatchError::NotOffice.code(), "NOT_OFFICE");
        assert_eq!(WatchError::OutsideRoot.code(), "OUTSIDE_ROOT");
        assert_eq!(WatchError::StartFailed("x".into()).code(), "START_FAILED");
        assert_eq!(WatchError::PortTimeout("x".into()).code(), "PORT_TIMEOUT");
        assert_eq!(WatchError::NoPort.code(), "NO_PORT");
        assert_eq!(WatchError::TooMany.code(), "TOO_MANY");
        assert_eq!(WatchError::Io("x".into()).code(), "IO");
    }

    #[test]
    fn watch_key_folds_and_normalizes() {
        // Slashes are normalized; case-folding only on Windows.
        let p = PathBuf::from("/Users/a/Reports/Q1.docx");
        let key = watch_key(&p);
        if cfg!(windows) {
            assert_eq!(key, "/users/a/reports/q1.docx");
        } else {
            assert_eq!(key, "/Users/a/Reports/Q1.docx");
        }
    }

    #[test]
    fn allocate_free_port_is_actually_free() {
        let port = allocate_free_port().expect("should allocate");
        assert!(port > 0);
        // We released it, so we can immediately bind it again.
        let again = std::net::TcpListener::bind(("127.0.0.1", port));
        assert!(again.is_ok(), "allocated port should be re-bindable");
    }

    #[test]
    fn parse_watch_port_reads_officecli_announce() {
        assert_eq!(parse_watch_port("Watch: http://localhost:26411"), Some(26411));
        assert_eq!(parse_watch_port("Watch: http://127.0.0.1:8080/"), Some(8080));
        assert_eq!(parse_watch_port("  Watch: http://localhost:1"), Some(1));
        // Other lines are ignored — crucially `Watching:` is not a false match.
        assert_eq!(parse_watch_port("Watching: /tmp/p.docx"), None);
        assert_eq!(parse_watch_port("Press Ctrl+C to stop."), None);
    }

    /// A long-lived stand-in for a watch child (unix: a portable never-exiting
    /// process).
    #[cfg(unix)]
    fn sleeper() -> Child {
        tokio_command("sleep")
            .arg("600")
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    }

    /// A child that has already exited: a crashed watch.
    #[cfg(unix)]
    async fn exited() -> Child {
        let mut child = tokio_command("true").spawn().unwrap();
        let _ = child.wait().await;
        child
    }

    /// A registry entry around `child`, held by one desktop window. Tests set
    /// the rest with struct-update syntax.
    #[cfg(unix)]
    fn entry(child: Child, port: u16, cap: &str, file: impl Into<PathBuf>) -> WatchInstance {
        WatchInstance {
            child,
            port,
            cap: cap.to_string(),
            file_canonical: file.into(),
            desktop_refs: 1,
            web_holds: HashMap::new(),
            last_web_activity: Instant::now(),
            sse_leases: 0,
        }
    }

    /// Web holds by id, each last renewed at its instant.
    #[cfg(unix)]
    fn holds(renewed: &[(&str, Instant)]) -> HashMap<String, Instant> {
        renewed
            .iter()
            .map(|(hold, at)| (hold.to_string(), *at))
            .collect()
    }

    /// Seed a live watch entry (real `sleep` child bound conceptually to `port`).
    #[cfg(unix)]
    fn seed_live_watch(key: &str, port: u16, cap: &str) {
        lock_watches().insert(
            key.to_string(),
            entry(sleeper(), port, cap, format!("/seed/{key}")),
        );
    }

    /// A scratch directory holding one office file, and the `(root, key)` a
    /// start for it resolves to. The caller removes the directory.
    #[cfg(unix)]
    fn scratch_office_file(tag: &str, name: &str) -> (PathBuf, String, PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("codeg-ow-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(name);
        std::fs::write(&file, b"x").unwrap();
        let canonical = std::fs::canonicalize(&file).unwrap();
        let key = watch_key(&canonical);
        let root = dir.to_string_lossy().to_string();
        (dir, root, canonical, key)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn known_port_requires_live_child() {
        let port = allocate_free_port().expect("port");
        assert!(!is_known_watch_port(port));
        seed_live_watch("kp", port, "cap-xyz");
        assert!(is_known_watch_port(port));
        if let Some(e) = lock_watches().remove("kp") {
            reap(e.child);
        }
        assert!(!is_known_watch_port(port));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn validate_watch_cap_requires_live_port_and_exact_cap() {
        let port = allocate_free_port().expect("port");
        // Unknown port → reject regardless of cap.
        assert!(!validate_watch_cap(port, "anything"));
        seed_live_watch("vc", port, "secret-cap");
        // Right port, right cap → accept.
        assert!(validate_watch_cap(port, "secret-cap"));
        // Right port, wrong cap → reject (including length mismatch).
        assert!(!validate_watch_cap(port, "secret-ca"));
        assert!(!validate_watch_cap(port, "secret-capX"));
        assert!(!validate_watch_cap(port, ""));
        if let Some(e) = lock_watches().remove("vc") {
            reap(e.child);
        }
        assert!(!validate_watch_cap(port, "secret-cap"));
    }

    /// A crashed watch's port stops validating immediately (not only after the
    /// 60s sweep) — the liveness check is on the request path.
    #[cfg(unix)]
    #[tokio::test]
    async fn validate_rejects_dead_child_without_sweep() {
        let port = allocate_free_port().expect("port");
        let dead = exited().await;
        lock_watches().insert(
            "dead".to_string(),
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("h", Instant::now())]),
                ..entry(dead, port, "c", "/seed/dead")
            },
        );
        // Cap matches but the child is dead → reject, no sweep needed.
        assert!(!validate_watch_cap(port, "c"));
        assert!(!is_known_watch_port(port));
        let _ = lock_watches().remove("dead");
    }

    /// A dead entry that still squats a port the OS re-assigned to a new live
    /// watch must not shadow it: lookups skip the dead one and find the live one.
    #[cfg(unix)]
    #[tokio::test]
    async fn dead_entry_does_not_shadow_reused_port() {
        let port = allocate_free_port().expect("port");
        // Dead entry on `port` with one cap…
        let dead = exited().await;
        lock_watches().insert("shadow-dead".into(), entry(dead, port, "old", "/seed/old"));
        // …and a live entry the OS handed the same port, with a new cap.
        seed_live_watch("shadow-live", port, "new");

        // Lookups must resolve to the LIVE entry's cap, not reject on the dead.
        assert!(is_known_watch_port(port));
        assert!(validate_watch_cap(port, "new"));
        assert!(!validate_watch_cap(port, "old"));
        // Lease/activity mutators also land on the live entry, never the dead
        // one. (`shadow-dead` may be concurrently reaped by another test's
        // sweep, so only assert on it if it's still present.)
        acquire_sse_lease(port);
        assert_eq!(lock_watches().get("shadow-live").unwrap().sse_leases, 1);
        assert!(lock_watches()
            .get("shadow-dead")
            .is_none_or(|e| e.sse_leases == 0));

        let _ = lock_watches().remove("shadow-dead");
        if let Some(e) = lock_watches().remove("shadow-live") {
            reap(e.child);
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn sse_lease_accounting() {
        let port = allocate_free_port().expect("port");
        seed_live_watch("lease", port, "c");
        acquire_sse_lease(port);
        acquire_sse_lease(port);
        assert_eq!(lock_watches().get("lease").unwrap().sse_leases, 2);
        release_sse_lease(port);
        assert_eq!(lock_watches().get("lease").unwrap().sse_leases, 1);
        // Saturating: extra releases don't underflow.
        release_sse_lease(port);
        release_sse_lease(port);
        assert_eq!(lock_watches().get("lease").unwrap().sse_leases, 0);
        if let Some(e) = lock_watches().remove("lease") {
            reap(e.child);
        }
    }

    #[test]
    fn constant_time_eq_matches_semantics() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn resolve_office_target_confines_and_filters() {
        let dir = std::env::temp_dir().join(format!(
            "codeg-ow-confine-{}-{}",
            std::process::id(),
            line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("a.docx");
        std::fs::write(&docx, b"x").unwrap();
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();

        let root = dir.to_string_lossy().to_string();
        // Office file inside root resolves.
        assert!(resolve_office_target(&root, "a.docx").is_ok());
        // Non-office extension rejected.
        assert!(matches!(
            resolve_office_target(&root, "a.txt"),
            Err(WatchError::NotOffice)
        ));
        // Escape attempt rejected (outside-root or io, never resolves to a file).
        assert!(resolve_office_target(&root, "../a.docx").is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Ref-count sharing + teardown, using a long-lived stand-in child instead
    /// of a real officecli (unix-only: a portable never-exiting child).
    #[cfg(unix)]
    #[tokio::test]
    async fn ref_count_sharing_and_teardown() {
        let dir = std::env::temp_dir().join(format!("codeg-ow-ref-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let docx = dir.join("deck.pptx");
        std::fs::write(&docx, b"x").unwrap();
        let root = dir.to_string_lossy().to_string();
        let canonical = std::fs::canonicalize(&docx).unwrap();
        let key = watch_key(&canonical);

        // Seed a live "watch" with a sleep child + a real allocated port.
        let port = allocate_free_port().unwrap();
        lock_watches().insert(
            key.clone(),
            entry(sleeper(), port, "seed-cap", canonical.clone()),
        );

        // start → fast-path reuse, two references, same port + cap, no new
        // process.
        let started =
            start_office_watch_core(root.clone(), "deck.pptx".into(), WatchHolder::Desktop)
                .await
                .unwrap();
        assert_eq!(started.port, port);
        assert_eq!(started.cap, "seed-cap");
        assert_eq!(started.hold, None);
        assert_eq!(lock_watches().get(&key).unwrap().desktop_refs, 2);

        // stop once → still present with one.
        stop_office_watch_core(
            root.clone(),
            "deck.pptx".into(),
            Some("seed-cap".into()),
            None,
            WatchHolder::Desktop,
        )
        .await
        .unwrap();
        assert_eq!(lock_watches().get(&key).unwrap().desktop_refs, 1);
        assert!(is_known_watch_port(port));

        // stop again (unnamed, as an older client sends it) → removed, port no
        // longer valid.
        stop_office_watch_core(
            root.clone(),
            "deck.pptx".into(),
            None,
            None,
            WatchHolder::Desktop,
        )
        .await
        .unwrap();
        assert!(lock_watches().get(&key).is_none());
        assert!(!is_known_watch_port(port));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A web page's hold and a desktop window's references come off apart: a
    /// page's release takes only its own hold, and never a window's reference,
    /// not even once the page's hold is gone.
    #[cfg(unix)]
    #[tokio::test]
    async fn web_and_desktop_references_come_off_apart() {
        let (dir, root, canonical, key) = scratch_office_file("holders", "plan.xlsx");
        let port = allocate_free_port().unwrap();
        lock_watches().insert(key.clone(), entry(sleeper(), port, "plan-cap", canonical));
        let held = || {
            lock_watches()
                .get(&key)
                .map(|e| (e.desktop_refs, e.web_holds.len()))
        };

        let page = start_office_watch_core(root.clone(), "plan.xlsx".into(), WatchHolder::Web)
            .await
            .unwrap();
        assert_eq!(page.cap, "plan-cap");
        let hold = page.hold.expect("a web page's start names its hold");
        assert_eq!(held(), Some((1, 1)));

        let release = |hold: Option<&str>, holder| {
            stop_office_watch_core(
                root.clone(),
                "plan.xlsx".into(),
                Some("plan-cap".into()),
                hold.map(str::to_string),
                holder,
            )
        };
        release(Some(&hold), WatchHolder::Web).await.unwrap();
        assert_eq!(held(), Some((1, 0)));
        release(Some(&hold), WatchHolder::Web).await.unwrap();
        release(None, WatchHolder::Web).await.unwrap();
        assert_eq!(held(), Some((1, 0)));
        assert!(is_known_watch_port(port));

        release(None, WatchHolder::Desktop).await.unwrap();
        assert_eq!(held(), None);
        assert!(!is_known_watch_port(port));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A page's release names its hold, so a late one, arriving after that hold
    /// lapsed, takes nothing from the page holding the watch now.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_late_release_takes_only_its_own_hold() {
        let (dir, root, canonical, key) = scratch_office_file("late", "brief.docx");
        let port = allocate_free_port().unwrap();
        lock_watches().insert(key.clone(), entry(sleeper(), port, "brief-cap", canonical));
        let release = |hold: Option<&str>, holder| {
            stop_office_watch_core(
                root.clone(),
                "brief.docx".into(),
                Some("brief-cap".into()),
                hold.map(str::to_string),
                holder,
            )
        };

        // Page A's hold has lapsed (the sweep dropped it) when page B starts
        // the file, and only then does A's release come in.
        let page_b = start_office_watch_core(root.clone(), "brief.docx".into(), WatchHolder::Web)
            .await
            .unwrap()
            .hold
            .unwrap();
        release(Some("page-a"), WatchHolder::Web).await.unwrap();
        let holds_now = || -> Vec<String> {
            lock_watches()
                .get(&key)
                .map(|e| e.web_holds.keys().cloned().collect())
                .unwrap_or_default()
        };
        assert_eq!(holds_now(), vec![page_b.clone()]);

        // The window letting go leaves the watch to page B.
        release(None, WatchHolder::Desktop).await.unwrap();
        assert_eq!(holds_now(), vec![page_b]);
        assert!(is_known_watch_port(port));

        if let Some(e) = lock_watches().remove(&key) {
            reap(e.child);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A hold that lapsed while its page was quiet (asleep, offline) comes back
    /// with the page's next renewal, so once the desktop window that kept the
    /// watch running lets go, the watch stays the page's.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_lapsed_hold_comes_back_with_its_renewal() {
        let (dir, root, canonical, key) = scratch_office_file("lapsed", "deck.pptx");
        let stale = Instant::now() - WEB_HOLD_GRACE - Duration::from_secs(5);
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                web_holds: holds(&[("page", stale)]),
                last_web_activity: stale,
                ..entry(
                    sleeper(),
                    allocate_free_port().unwrap(),
                    "deck-cap",
                    canonical,
                )
            },
        );
        let held = || {
            lock_watches()
                .get(&key)
                .map(|e| (e.desktop_refs, e.web_holds.len()))
        };
        sweep_office_watches(Duration::from_secs(300));
        assert_eq!(held(), Some((1, 0)));

        assert!(renew_office_watch_core(
            &root,
            "deck.pptx",
            "deck-cap",
            Some("page"),
            WatchHolder::Web
        ));
        stop_office_watch_core(
            root.clone(),
            "deck.pptx".into(),
            Some("deck-cap".into()),
            None,
            WatchHolder::Desktop,
        )
        .await
        .unwrap();
        assert_eq!(held(), Some((0, 1)));

        if let Some(e) = lock_watches().remove(&key) {
            reap(e.child);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A release or renewal names its watch by capability: one that names a
    /// watch since replaced (the file started again after its folder closed)
    /// leaves the live watch alone.
    #[cfg(unix)]
    #[tokio::test]
    async fn release_and_renewal_are_scoped_to_the_named_watch() {
        let (dir, root, canonical, key) = scratch_office_file("cap", "report.docx");
        let port = allocate_free_port().unwrap();
        lock_watches().insert(
            key.clone(),
            entry(sleeper(), port, "current-cap", canonical),
        );
        let renew = |path: &str, cap: &str| {
            renew_office_watch_core(&root, path, cap, None, WatchHolder::Desktop)
        };

        assert!(renew("report.docx", "current-cap"));
        assert!(!renew("report.docx", "replaced-cap"));
        assert!(!renew("report.docx", ""));
        assert!(!renew("other.docx", "current-cap"));

        // A release naming the replaced watch takes nothing from this one.
        stop_office_watch_core(
            root.clone(),
            "report.docx".into(),
            Some("replaced-cap".into()),
            None,
            WatchHolder::Desktop,
        )
        .await
        .unwrap();
        assert_eq!(lock_watches().get(&key).unwrap().desktop_refs, 1);
        assert!(is_known_watch_port(port));

        // Its own release stops it, and then it is no longer live.
        stop_office_watch_core(
            root.clone(),
            "report.docx".into(),
            Some("current-cap".into()),
            None,
            WatchHolder::Desktop,
        )
        .await
        .unwrap();
        assert!(lock_watches().get(&key).is_none());
        assert!(!renew("report.docx", "current-cap"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A web page's renewal refreshes its own hold, the sign of life a preview
    /// kept out of sight gives, and no other; a desktop window's renewal
    /// touches no hold.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_web_renewal_refreshes_its_own_hold() {
        let (dir, root, canonical, key) = scratch_office_file("renew", "notes.docx");
        // Quiet for a while, though not yet past the grace: a sweep running in
        // a parallel test must not drop them before the renewal.
        let earlier = Instant::now() - Duration::from_secs(30);
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("mine", earlier), ("theirs", earlier)]),
                ..entry(
                    sleeper(),
                    allocate_free_port().unwrap(),
                    "web-cap",
                    canonical,
                )
            },
        );
        let renewed = |hold: &str| lock_watches().get(&key).unwrap().web_holds[hold];
        let renew =
            |holder| renew_office_watch_core(&root, "notes.docx", "web-cap", Some("mine"), holder);

        assert!(renew(WatchHolder::Desktop));
        assert_eq!(renewed("mine"), earlier);
        assert!(renew(WatchHolder::Web));
        assert!(renewed("mine") > earlier);
        assert_eq!(renewed("theirs"), earlier);

        if let Some(e) = lock_watches().remove(&key) {
            reap(e.child);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A renewal asks the watch for its status, the request officecli counts
    /// as activity: a watch only hidden previews hold, with no SSE client,
    /// would otherwise shut itself down after five minutes.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_renewal_keeps_officecli_from_idling_out() {
        use tokio::io::AsyncReadExt;

        let (dir, root, canonical, key) = scratch_office_file("keepalive", "deck.pptx");
        // Stands in for the watch's HTTP server.
        let officecli = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = officecli.local_addr().unwrap().port();
        lock_watches().insert(key.clone(), entry(sleeper(), port, "deck-cap", canonical));
        let next_request = || async {
            let (mut conn, _) = officecli.accept().await.unwrap();
            let mut request = vec![0u8; 256];
            let n = conn.read(&mut request).await.unwrap();
            String::from_utf8_lossy(&request[..n]).into_owned()
        };

        assert!(renew_office_watch_core(
            &root,
            "deck.pptx",
            "deck-cap",
            None,
            WatchHolder::Web
        ));
        let request = tokio::time::timeout(Duration::from_secs(5), next_request())
            .await
            .expect("the watch is asked for its status");
        assert!(
            request.starts_with("GET /api/status HTTP/1.1\r\n"),
            "{request}"
        );

        // Nothing is asked of a watch the renewal does not name.
        assert!(!renew_office_watch_core(
            &root,
            "deck.pptx",
            "replaced-cap",
            None,
            WatchHolder::Web
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(300), next_request())
                .await
                .is_err()
        );

        if let Some(e) = lock_watches().remove(&key) {
            reap(e.child);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A watch whose process died is not live, whatever its capability.
    #[cfg(unix)]
    #[tokio::test]
    async fn renewal_requires_a_running_child() {
        let (dir, root, canonical, key) = scratch_office_file("dead", "sheet.xlsx");
        let dead = exited().await;
        lock_watches().insert(
            key.clone(),
            entry(dead, allocate_free_port().unwrap(), "dead-cap", canonical),
        );

        assert!(!renew_office_watch_core(
            &root,
            "sheet.xlsx",
            "dead-cap",
            Some("page"),
            WatchHolder::Web
        ));

        lock_watches().remove(&key);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sweep reaps a dead child and leaves a desktop preview alone however
    /// idle. It drops a web hold once it has gone quiet, reaping the watch when
    /// no hold is left unless a desktop window holds it too, and leaves holds
    /// alone while a page shows the watch, renews, or sends it a request.
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_reaping_rules() {
        let stale = Instant::now() - WEB_HOLD_GRACE - Duration::from_secs(5);
        let seed = |key: &str, instance: WatchInstance| {
            lock_watches().insert(key.into(), instance);
        };
        let port = || allocate_free_port().unwrap();

        // (a) dead child → reaped.
        seed(
            "sweep-dead",
            entry(exited().await, port(), "c", "/seed/dead"),
        );
        // (b) desktop preview, long idle → kept.
        seed(
            "sweep-desk",
            WatchInstance {
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/desk")
            },
        );
        // (c) web pages gone quiet → their holds dropped and the watch reaped
        //     (browser vanished). No request need ever have reached the proxy:
        //     a page closed while its watch was spawning gave its start as its
        //     hold's last sign of life.
        seed(
            "sweep-web",
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("a", stale), ("b", stale)]),
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/web")
            },
        );
        // (d) the same, on a watch a desktop window holds too → the page's
        //     hold dropped, the watch kept for the window.
        seed(
            "sweep-shared",
            WatchInstance {
                web_holds: holds(&[("a", stale)]),
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/shared")
            },
        );
        // (e) a page showing it (an SSE connection open), however long since
        //     any renewal → kept.
        seed(
            "sweep-showing",
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("a", stale)]),
                sse_leases: 1,
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/showing")
            },
        );
        // (f) a hold renewed lately (a preview kept out of sight) → kept.
        seed(
            "sweep-renewed",
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("a", Instant::now())]),
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/renewed")
            },
        );
        // (g) a request through the proxy lately, the hold itself not renewed
        //     (a page loading, or an older client that never renews) → kept.
        seed(
            "sweep-traffic",
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("a", stale)]),
                ..entry(sleeper(), port(), "c", "/seed/traffic")
            },
        );
        // (h) a quiet hold beside a renewed one → only the quiet one goes.
        seed(
            "sweep-mixed",
            WatchInstance {
                desktop_refs: 0,
                web_holds: holds(&[("gone", stale), ("here", Instant::now())]),
                last_web_activity: stale,
                ..entry(sleeper(), port(), "c", "/seed/mixed")
            },
        );

        // Don't assert on the returned count: it's racy under parallel tests. A
        // concurrent sweep (e.g. `sweep_prunes_unreferenced_spawn_locks`) can
        // reap these entries first, and this sweep can additionally reap another
        // test's seeded dead child. The post-conditions below are deterministic
        // — after this sweep returns, a dead/abandoned entry is gone no matter
        // which sweep reaped it, and a live desktop preview is never reapable.
        sweep_office_watches(Duration::from_secs(300));
        let refs = |key: &str| {
            lock_watches()
                .get(key)
                .map(|e| (e.desktop_refs, e.web_holds.len()))
        };
        assert_eq!(refs("sweep-dead"), None, "a dead child must be reaped");
        assert_eq!(refs("sweep-web"), None, "quiet web holds must be reaped");
        assert_eq!(
            refs("sweep-desk"),
            Some((1, 0)),
            "a desktop preview must not be swept"
        );
        assert_eq!(
            refs("sweep-shared"),
            Some((1, 0)),
            "a quiet web hold goes, the desktop window's stays"
        );
        assert_eq!(
            refs("sweep-showing"),
            Some((0, 1)),
            "a page showing the watch keeps it"
        );
        assert_eq!(
            refs("sweep-renewed"),
            Some((0, 1)),
            "a page renewing its hold keeps it"
        );
        assert_eq!(
            refs("sweep-traffic"),
            Some((0, 1)),
            "web traffic to the watch keeps its holds"
        );
        assert!(
            lock_watches()
                .get("sweep-mixed")
                .is_some_and(|e| e.web_holds.len() == 1 && e.web_holds.contains_key("here")),
            "only the quiet hold goes"
        );
        for key in [
            "sweep-desk",
            "sweep-shared",
            "sweep-showing",
            "sweep-renewed",
            "sweep-traffic",
            "sweep-mixed",
        ] {
            if let Some(e) = lock_watches().remove(key) {
                reap(e.child);
            }
        }
    }

    #[test]
    fn sweep_prunes_unreferenced_spawn_locks() {
        // An entry no task references (returned Arc dropped → only the map holds
        // it) is pruned by the sweep…
        let _ = spawn_lock_for("prune-me-unref");
        // …while one a task still holds (we keep this clone) is retained.
        let held = spawn_lock_for("keep-me-ref");

        sweep_office_watches(Duration::from_secs(300));

        {
            let map = SPAWN_LOCKS.lock().unwrap_or_else(|p| p.into_inner());
            assert!(
                !map.contains_key("prune-me-unref"),
                "an unreferenced spawn lock must be pruned"
            );
            assert!(
                map.contains_key("keep-me-ref"),
                "a spawn lock a task still holds must be kept"
            );
        }

        drop(held);
        // Now unreferenced → next sweep prunes it too.
        sweep_office_watches(Duration::from_secs(300));
        assert!(!SPAWN_LOCKS
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .contains_key("keep-me-ref"));
    }

    #[test]
    fn idle_timeout_env_parsing() {
        std::env::set_var("CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS", "0");
        assert!(idle_timeout_from_env().is_none());
        std::env::set_var("CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS", "nope");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
        std::env::set_var("CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS", "120");
        assert_eq!(idle_timeout_from_env().unwrap().as_secs(), 120);
        std::env::remove_var("CODEG_OFFICE_WATCH_IDLE_TIMEOUT_SECS");
        assert_eq!(
            idle_timeout_from_env().unwrap().as_secs(),
            DEFAULT_IDLE_TIMEOUT_SECS
        );
    }
}
