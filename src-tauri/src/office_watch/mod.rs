//! Long-lived `officecli watch` preview servers.
//!
//! One `officecli watch <file> --port N` child process per office file,
//! shared across preview tabs by ref-count, reaped on tab-close /
//! folder-removal / app-exit.
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

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::net::TcpStream;
use tokio::process::Child;

use crate::app_error::AppCommandError;
use crate::commands::folders::resolve_tree_path;
use crate::commands::office_tools::{is_office_path, resolve_officecli};
use crate::process::tokio_command;

// ─── Tunables ───────────────────────────────────────────────────────────

/// Upper bound on how long we wait for a freshly-spawned watch server to
/// announce readiness (its `Watch: http://…:<port>` stdout line) before giving up.
const READY_TIMEOUT: Duration = Duration::from_secs(8);
/// Per-attempt TCP connect timeout for the post-announce reachability confirm.
const READY_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
/// Hard cap on concurrent watch processes — a backstop against a pathological
/// burst of tab-opens spawning unbounded officecli processes.
const MAX_CONCURRENT_WATCHES: usize = 32;
/// Grace after a web preview's last SSE connection drops before the sweep reaps
/// the (now-unviewed) watch. Bounds the leak when a browser tab closes / crashes
/// / loses network and its `stop_office_watch` request never arrives, while
/// tolerating brief SSE reconnects (officecli's stream auto-reconnects).
const SSE_LEASE_GRACE: Duration = Duration::from_secs(90);

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
/// already-authenticated user can obtain one. Desktop ignores `cap` (it loads
/// the loopback URL directly, no proxy).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeWatchStarted {
    pub port: u16,
    pub cap: String,
}

// ─── Process-pool state ─────────────────────────────────────────────────

struct WatchInstance {
    child: Child,
    port: u16,
    /// Per-watch capability the proxy authenticates against (see `OfficeWatchStarted`).
    cap: String,
    file_canonical: PathBuf,
    ref_count: usize,
    last_activity: Instant,
    /// Set once the server-mode proxy serves any request for this watch — i.e.
    /// this is a web/remote preview, not a desktop one (desktop hits loopback
    /// directly, never the proxy). Gates the SSE-lease reaping rule so a desktop
    /// preview — which legitimately sits idle with no proxy traffic — is never
    /// swept out from under the user.
    proxied: bool,
    /// Number of live SSE (`/events`) connections the proxy currently holds open
    /// for this watch. While ≥1 the preview is open in a browser; when it drops
    /// to 0 the (web) watch becomes eligible for grace-period reaping.
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
/// There's an inherent (microsecond) TOCTOU window before officecli binds it;
/// the readiness probe catches the rare loss as `PortTimeout`/`StartFailed`.
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
async fn await_ready(port: u16, child: &mut Child) -> Result<(), WatchError> {
    use tokio::io::{AsyncBufReadExt, BufReader};

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| WatchError::StartFailed("no stdout pipe".to_string()))?;
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + READY_TIMEOUT;

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
/// spawns when none is live.
pub async fn start_office_watch_core(
    root_path: String,
    path: String,
) -> Result<OfficeWatchStarted, WatchError> {
    let canonical_target = resolve_office_target(&root_path, &path)?;
    let key = watch_key(&canonical_target);

    // Fast path: a live process already exists → just share it. This path
    // intentionally does not need the officecli binary on disk.
    if let Some((port, cap)) = reuse_live(&key) {
        return Ok(OfficeWatchStarted { port, cap });
    }

    // Slow path: serialize same-file spawns, then double-check. The per-key
    // entry stays in `SPAWN_LOCKS` for as long as any task references it (so
    // serialization is never broken mid-spawn); the idle sweep prunes entries no
    // task holds (`Arc::strong_count == 1`), bounding the map's growth.
    let spawn_lock = spawn_lock_for(&key);
    let _guard = spawn_lock.lock().await;
    if let Some((port, cap)) = reuse_live(&key) {
        return Ok(OfficeWatchStarted { port, cap });
    }
    if lock_watches().len() >= MAX_CONCURRENT_WATCHES {
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

    if let Err(ready_err) = await_ready(port, &mut child).await {
        let _ = child.start_kill();
        let stderr = drain_stderr(&mut child).await;
        let detail = match (ready_err.to_string(), stderr.as_str()) {
            (msg, "") => msg,
            (msg, err) => format!("{msg} — {err}"),
        };
        reap(child);
        return Err(match ready_err {
            WatchError::PortTimeout(_) => WatchError::PortTimeout(detail),
            _ => WatchError::StartFailed(detail),
        });
    }

    // Register. Re-check after the async gap: another task may have won the
    // race for this same file while we were waiting — if so, adopt theirs and
    // reap ours.
    let result = {
        let mut watches = lock_watches();
        if let Some(entry) = watches.get_mut(&key) {
            if matches!(entry.child.try_wait(), Ok(None)) {
                entry.ref_count += 1;
                entry.last_activity = Instant::now();
                let winner = OfficeWatchStarted {
                    port: entry.port,
                    cap: entry.cap.clone(),
                };
                drop(watches);
                reap(child);
                Ok(winner)
            } else {
                // A dead entry squats the key — replace it below.
                watches.remove(&key);
                register_new(watches, key.clone(), child, port, cap.clone(), canonical_target)
            }
        } else if watches.len() >= MAX_CONCURRENT_WATCHES {
            // Enforce the cap atomically under the pool lock — per-file spawn
            // locks don't serialize *across different files*, so the early
            // pre-spawn check can be raced past by concurrent first-opens.
            drop(watches);
            reap(child);
            Err(WatchError::TooMany)
        } else {
            register_new(watches, key.clone(), child, port, cap.clone(), canonical_target)
        }
    };
    result
}

/// Insert a fresh watch under `key` while holding the pool lock. Factored out so
/// the register path has a single construction site for `WatchInstance`.
fn register_new(
    mut watches: MutexGuard<'static, HashMap<String, WatchInstance>>,
    key: String,
    child: Child,
    port: u16,
    cap: String,
    file_canonical: PathBuf,
) -> Result<OfficeWatchStarted, WatchError> {
    watches.insert(
        key,
        WatchInstance {
            child,
            port,
            cap: cap.clone(),
            file_canonical,
            ref_count: 1,
            last_activity: Instant::now(),
            proxied: false,
            sse_leases: 0,
        },
    );
    Ok(OfficeWatchStarted { port, cap })
}

/// Fast-path helper: if a live watch exists for `key`, bump its ref-count and
/// return its `(port, cap)`; if the entry is dead, reap + prune it so the slow
/// path respawns.
fn reuse_live(key: &str) -> Option<(u16, String)> {
    let mut watches = lock_watches();
    let entry = watches.get_mut(key)?;
    match entry.child.try_wait() {
        Ok(None) => {
            entry.ref_count += 1;
            entry.last_activity = Instant::now();
            Some((entry.port, entry.cap.clone()))
        }
        _ => {
            // Dead or errored — prune so the slow path respawns.
            if let Some(dead) = watches.remove(key) {
                reap(dead.child);
            }
            None
        }
    }
}

/// Release one reference to the watch for `path`. Kills the process when the
/// last reference goes away. Idempotent (closing an already-stopped tab is OK).
pub async fn stop_office_watch_core(root_path: String, path: String) -> Result<(), WatchError> {
    let Some(key) = loose_key(&root_path, &path) else {
        return Ok(());
    };

    let mut watches = lock_watches();
    let target_key = if watches.contains_key(&key) {
        Some(key)
    } else {
        // Fallback: a since-moved file may key differently; match by canonical.
        watches
            .iter()
            .find_map(|(k, entry)| (watch_key(&entry.file_canonical) == key).then(|| k.clone()))
    };
    let Some(target_key) = target_key else {
        return Ok(());
    };

    if let Some(entry) = watches.get_mut(&target_key) {
        if entry.ref_count > 1 {
            entry.ref_count -= 1;
            return Ok(());
        }
    }
    if let Some(entry) = watches.remove(&target_key) {
        // Removing the entry instantly closes the proxy gate (validate looks it
        // up here), so the port can't be forwarded the moment it's unservable.
        drop(watches);
        reap(entry.child);
    }
    Ok(())
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

/// Mark a watch as proxy-served (web/remote, not desktop) and bump its activity
/// clock. Called by the server-mode proxy on every request it forwards.
pub fn note_proxy_request(port: u16) {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            entry.proxied = true;
            entry.last_activity = Instant::now();
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
            entry.proxied = true;
            entry.sse_leases += 1;
            entry.last_activity = Instant::now();
            return;
        }
    }
}

/// Release an SSE connection accounted by [`acquire_sse_lease`]. Bumping the
/// activity clock here starts the grace window before the sweep reaps a watch
/// whose last preview connection just closed.
pub fn release_sse_lease(port: u16) {
    let mut watches = lock_watches();
    for entry in watches.values_mut() {
        if entry.port == port && is_live(entry) {
            entry.sse_leases = entry.sse_leases.saturating_sub(1);
            entry.last_activity = Instant::now();
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
            ref_count: 1,
            last_activity: Instant::now(),
            proxied: false,
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

/// Kill every watch process. Used on app/window/server shutdown.
pub fn stop_all_office_watches() -> usize {
    let drained: Vec<(String, WatchInstance)> = lock_watches().drain().collect();
    let n = drained.len();
    for (_, entry) in drained {
        reap(entry.child);
    }
    n
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

/// Reap watches that are no longer needed:
/// - **dead children** (a crashed watch must not linger);
/// - **desktop stragglers** — `ref_count == 0` (the tab stopped it) past the
///   idle window. A *live* desktop preview (`ref_count >= 1`, `!proxied`) is
///   never swept: it connects loopback directly so no proxy traffic bumps
///   `last_activity`, and reaping it by idle would yank it from under the user;
/// - **abandoned web previews** — a `proxied` watch whose last SSE connection
///   closed (`sse_leases == 0`) and stayed closed past [`SSE_LEASE_GRACE`]. This
///   is the backstop for a browser tab that closed / crashed / lost network
///   before its `stop_office_watch` arrived, so its `ref_count` never reached 0.
pub fn sweep_office_watches(idle_timeout: Duration) -> usize {
    let now = Instant::now();
    let mut watches = lock_watches();
    // First pass (needs `&mut` for `try_wait`): collect the keys to reap.
    let keys: Vec<String> = watches
        .iter_mut()
        .filter_map(|(k, entry)| {
            let idle = now.duration_since(entry.last_activity);
            let dead = matches!(entry.child.try_wait(), Ok(Some(_)));
            let desktop_straggler = !entry.proxied && entry.ref_count == 0 && idle > idle_timeout;
            let web_abandoned = entry.proxied && entry.sse_leases == 0 && idle > SSE_LEASE_GRACE;
            (dead || desktop_straggler || web_abandoned).then(|| k.clone())
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

    /// Seed a live watch entry (real `sleep` child bound conceptually to `port`).
    #[cfg(unix)]
    fn seed_live_watch(key: &str, port: u16, cap: &str, proxied: bool) {
        let child = tokio_command("sleep")
            .arg("600")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        lock_watches().insert(
            key.to_string(),
            WatchInstance {
                child,
                port,
                cap: cap.to_string(),
                file_canonical: PathBuf::from(format!("/seed/{key}")),
                ref_count: 1,
                last_activity: Instant::now(),
                proxied,
                sse_leases: 0,
            },
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn known_port_requires_live_child() {
        let port = allocate_free_port().expect("port");
        assert!(!is_known_watch_port(port));
        seed_live_watch("kp", port, "cap-xyz", false);
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
        seed_live_watch("vc", port, "secret-cap", false);
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
        let mut child = tokio_command("true").spawn().unwrap();
        let _ = child.wait().await;
        lock_watches().insert(
            "dead".to_string(),
            WatchInstance {
                child,
                port,
                cap: "c".to_string(),
                file_canonical: PathBuf::from("/seed/dead"),
                ref_count: 1,
                last_activity: Instant::now(),
                proxied: true,
                sse_leases: 0,
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
        let mut dead = tokio_command("true").spawn().unwrap();
        let _ = dead.wait().await;
        lock_watches().insert(
            "shadow-dead".into(),
            WatchInstance {
                child: dead,
                port,
                cap: "old".into(),
                file_canonical: PathBuf::from("/seed/old"),
                ref_count: 1,
                last_activity: Instant::now(),
                proxied: false,
                sse_leases: 0,
            },
        );
        // …and a live entry the OS handed the same port, with a new cap.
        seed_live_watch("shadow-live", port, "new", false);

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
        seed_live_watch("lease", port, "c", false);
        acquire_sse_lease(port);
        acquire_sse_lease(port);
        assert_eq!(lock_watches().get("lease").unwrap().sse_leases, 2);
        assert!(lock_watches().get("lease").unwrap().proxied);
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
        let child = tokio_command("sleep")
            .arg("600")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        lock_watches().insert(
            key.clone(),
            WatchInstance {
                child,
                port,
                cap: "seed-cap".to_string(),
                file_canonical: canonical.clone(),
                ref_count: 1,
                last_activity: Instant::now(),
                proxied: false,
                sse_leases: 0,
            },
        );

        // start → fast-path reuse, ref_count 2, same port + cap, no new process.
        let started = start_office_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert_eq!(started.port, port);
        assert_eq!(started.cap, "seed-cap");
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 2);

        // stop once → still present at ref_count 1.
        stop_office_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert_eq!(lock_watches().get(&key).unwrap().ref_count, 1);
        assert!(is_known_watch_port(port));

        // stop again → removed, port no longer valid.
        stop_office_watch_core(root.clone(), "deck.pptx".into())
            .await
            .unwrap();
        assert!(lock_watches().get(&key).is_none());
        assert!(!is_known_watch_port(port));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The sweep reaps a dead child, leaves a live desktop preview alone, and
    /// reaps an abandoned web preview (proxied, no SSE leases, past the grace).
    #[cfg(unix)]
    #[tokio::test]
    async fn sweep_reaping_rules() {
        let stale = Instant::now() - SSE_LEASE_GRACE - Duration::from_secs(5);

        // (a) dead child → reaped.
        let mut dead = tokio_command("true").spawn().unwrap();
        let _ = dead.wait().await;
        let p_dead = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-dead".into(),
            WatchInstance {
                child: dead,
                port: p_dead,
                cap: "c".into(),
                file_canonical: PathBuf::from("/seed/dead"),
                ref_count: 1,
                last_activity: Instant::now(),
                proxied: false,
                sse_leases: 0,
            },
        );

        // (b) live desktop preview (not proxied, ref_count>=1, idle) → kept.
        let p_desk = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-desk".into(),
            WatchInstance {
                child: tokio_command("sleep")
                    .arg("600")
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
                port: p_desk,
                cap: "c".into(),
                file_canonical: PathBuf::from("/seed/desk"),
                ref_count: 1,
                last_activity: stale,
                proxied: false,
                sse_leases: 0,
            },
        );

        // (c) abandoned web preview (proxied, no leases, stale) → reaped.
        let p_web = allocate_free_port().unwrap();
        lock_watches().insert(
            "sweep-web".into(),
            WatchInstance {
                child: tokio_command("sleep")
                    .arg("600")
                    .kill_on_drop(true)
                    .spawn()
                    .unwrap(),
                port: p_web,
                cap: "c".into(),
                file_canonical: PathBuf::from("/seed/web"),
                ref_count: 1, // ref leaked (browser vanished) — reaped anyway
                last_activity: stale,
                proxied: true,
                sse_leases: 0,
            },
        );

        // Don't assert on the returned count: it's racy under parallel tests. A
        // concurrent sweep (e.g. `sweep_prunes_unreferenced_spawn_locks`) can
        // reap these entries first, and this sweep can additionally reap another
        // test's seeded dead child. The post-conditions below are deterministic
        // — after this sweep returns, a dead/abandoned entry is gone no matter
        // which sweep reaped it, and a live desktop preview is never reapable.
        sweep_office_watches(Duration::from_secs(300));
        assert!(
            lock_watches().get("sweep-dead").is_none(),
            "a dead child must be reaped"
        );
        assert!(
            lock_watches().get("sweep-web").is_none(),
            "an abandoned web preview must be reaped"
        );
        assert!(
            lock_watches().get("sweep-desk").is_some(),
            "a live desktop preview must not be swept"
        );
        if let Some(e) = lock_watches().remove("sweep-desk") {
            reap(e.child);
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
