//! Per-launch scratch directories for ACP agent processes.
//!
//! # Why
//!
//! Some agent binaries are self-extracting archives that unpack into the system
//! temp directory on every launch and only clean up on a GRACEFUL exit. codeg
//! ends agent processes with `kill_tree`, which on Windows terminates
//! unconditionally, so that cleanup never runs. The Antigravity ACP server is
//! the acute case: its Windows build is a PyInstaller *onefile* whose archive
//! unpacks to **1.17 GB** per launch (verified against the shipped binary: 8261
//! TOC entries, 1192.3 MB of `b` entries plus an 8.7 MB PYZ). One user
//! accumulated 113 orphaned `%TEMP%\_MEI*` directories totalling 107.70 GB in
//! seven days and ran their system drive out of space.
//!
//! The lever is entirely host-side. The PyInstaller bootloader resolves its
//! extraction root through `GetTempPathW` (confirmed: the shipped bootloader
//! imports `GetTempPathW` and not `GetTempPath2W`, and the archive carries no
//! `pyi-runtime-tmpdir` option), and `GetTempPathW` reads `TMP`, then `TEMP`,
//! then `USERPROFILE`. Pointing those at a directory codeg owns turns an
//! unbounded leak into a directory codeg can delete.
//!
//! macOS is the same bug two orders of magnitude smaller: that build is not
//! PyInstaller, but it still drops ~172 KB of read-only resource files into
//! `TMPDIR` per launch and still leaks them when killed. So the isolation is
//! applied to every agent launch on every platform rather than special-cased.
//!
//! # Invariants
//!
//! Three ordering rules make the sweeps sound without holding a lock across a
//! multi-gigabyte delete:
//!
//! 1. **Register before `mkdir`.** There is no instant at which a scratch
//!    directory exists on disk without already being in [`REGISTRY`].
//! 2. **Unregister only after the directory is gone** (or after the retry
//!    ladder gives up, at which point it is by definition no longer live).
//! 3. **Diff under the lock, delete outside it.** A sweep enumerates, diffs and
//!    claims under the mutex, then releases it before deleting.
//!
//! Together those mean a directory created after a sweep's snapshot was
//! registered *before* it appeared on disk, so it cannot have been in the diff;
//! and a creation landing between the unlock and the delete cannot collide,
//! because names carry a fresh random suffix and are created with `create_dir`
//! (which fails on an existing name).

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// Directory under the temp root that codeg owns outright. Every sweep is
/// confined to this subtree, which is what makes it safe to delete without
/// asking: `%TEMP%` itself is a namespace shared with every other application,
/// but nothing except codeg writes here.
const SCRATCH_NAMESPACE: &str = "codeg-acp";

/// Opt out of isolation entirely and let the child inherit the ambient
/// `TMP`/`TEMP`/`TMPDIR` the way it did before this module existed. Escape
/// hatch for an agent that turns out to depend on a shared temp directory.
const ISOLATION_ENV: &str = "CODEG_ACP_TMP_ISOLATION";

/// Override for the scratch root. Set it to place the (potentially very large)
/// extraction churn on a different volume.
const ROOT_ENV: &str = "CODEG_ACP_TMP_ROOT";

/// Bytes of `sockaddr_un::sun_path` — the kernel's hard cap on the path of an
/// AF_UNIX socket, and the reason this module cannot nest its scratch
/// directories under an arbitrarily long `TMPDIR`.
///
/// The cap applies to the path as GIVEN to `bind`, not to anything resolved, so
/// it cannot be dodged with a shorter symlink to the same directory. It is also
/// not a `PATH_MAX`-sized budget: 104 bytes is barely twice a macOS per-user
/// temp directory, so every byte this module prepends is a byte taken off what
/// the child has left.
///
/// Shared with [`crate::acp::delegation::listener`], which has the same budget
/// to keep for codeg's OWN broker socket. One definition rather than two
/// because [`tests::sun_path_cap_matches_the_kernel`] checks this one against
/// `libc`, and a second copy would be a number nothing verifies.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) const SUN_PATH_CAP: usize = 108;
#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
pub(crate) const SUN_PATH_CAP: usize = 104;

/// The longest name [`new_dir_name`] can mint: ten digits of `u32` pid, the
/// separator, and eight hex.
///
/// A CONSTANT, not the width of our actual pid. [`scratch_root`] has to answer
/// the same path in every process that ever sweeps this machine, and a budget
/// derived from a live pid would not: a four-digit-pid process could pick one
/// root while a six-digit-pid process picked another, and each would then be
/// sweeping a root the other was still filling.
#[cfg(unix)]
const MAX_LEAF_NAME_LEN: usize = 10 + 1 + 8;

/// Bytes kept free inside the scratch directory for a socket the CHILD creates
/// — the separator plus its file name.
///
/// Sized from what agents really do: a `<prefix>-<uuid v4>.sock` name is 36
/// bytes of UUID plus 5 of extension plus a short prefix. The agent in #754
/// used 45, so 56 holds a full name of that shape with margin.
#[cfg(unix)]
const CHILD_SOCKET_RESERVE: usize = 56;

/// The three names a child consults for its temp directory. All are set
/// together: `GetTempPathW` reads `TMP` before `TEMP`, so setting only one
/// leaves the other able to win.
pub(crate) const TEMP_ENV_KEYS: [&str; 3] = ["TMP", "TEMP", "TMPDIR"];

/// How many times removal is retried before the directory is left to the
/// sweeps. `kill_tree` signals a process tree without waiting for it, so the
/// first attempt can land while a descendant still holds an extracted file
/// open — on Windows that is a sharing violation, not a transient blip, and it
/// clears only once the descendant actually dies.
const REMOVE_ATTEMPTS: u32 = 5;

/// Delay before the first retry. Doubles each attempt, so the ladder spans
/// roughly a minute in total — comfortably longer than a process tree takes to
/// finish dying, and bounded so a directory can never pin a task forever.
const REMOVE_RETRY_BASE: Duration = Duration::from_millis(2_000);

/// How often the in-session sweep reclaims directories this process owns but
/// has lost track of. Independent of the ACP idle sweep on purpose: that task
/// is not spawned at all when `CODEG_ACP_IDLE_TIMEOUT_SECS=0`, and disabling
/// idle disconnects must not also disable disk reclamation.
pub const SWEEP_INTERVAL: Duration = Duration::from_secs(300);

/// Names of the scratch directories THIS process currently owns.
///
/// Authoritative for our own pid, which is the only thing that can distinguish
/// a live launch from an orphan left by a previous process that happened to
/// hold the same pid number. A pid probe cannot: it reports both as alive.
static REGISTRY: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashSet<String>> {
    REGISTRY.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Whether launches get an isolated temp directory. On unless explicitly
/// disabled with `CODEG_ACP_TMP_ISOLATION=0`.
pub fn isolation_enabled() -> bool {
    !matches!(
        std::env::var(ISOLATION_ENV).as_deref(),
        Ok("0") | Ok("false") | Ok("FALSE") | Ok("off")
    )
}

/// A scratch root is only usable if a child can still bind a unix socket
/// INSIDE it. Isolation costs `/codeg-acp/<pid>-<hex>` — about 25 bytes — and
/// [`SUN_PATH_CAP`] is small enough that spending them can push a child that
/// bound fine on the ambient temp directory over the cap (#754: a macOS
/// `/var/folders/…/T` is 48 bytes, leaving 55 for a socket name; nesting under
/// it leaves 30, and the agent's name was 45).
#[cfg(unix)]
fn leaves_room_for_a_child_socket(root: &Path) -> bool {
    // The deepest path we will hand a child: the root, a separator, and the
    // longest leaf `new_dir_name` can produce.
    let scratch_dir = root.as_os_str().len() + 1 + MAX_LEAF_NAME_LEN;
    // STRICTLY less than the cap: `sun_path` has to hold the terminating NUL
    // too, so the last byte of the array is never available to the path.
    scratch_dir + CHILD_SOCKET_RESERVE < SUN_PATH_CAP
}

/// Short fallback root, used when the ambient temp directory is too long to
/// nest under.
///
/// `/tmp` because it is the shortest directory POSIX guarantees exists. Scoped
/// by euid because, unlike a macOS per-user `/var/folders/…/T`, `/tmp` is
/// shared with every other user on the machine: without the uid the first
/// account to run codeg would own `codeg-acp` and every other account would be
/// unable to create inside it. [`create`] makes it `0700` so the contents stay
/// as private as they were in the per-user directory this replaces.
#[cfg(unix)]
fn short_root() -> PathBuf {
    PathBuf::from(format!(
        "/tmp/{SCRATCH_NAMESPACE}-{}",
        // Always succeeds; `geteuid` has no failure mode.
        unsafe { libc::geteuid() }
    ))
}

/// Pick the root to nest under, given the ambient temp directory.
///
/// Split out from [`scratch_root`] so the choice is a pure function of its
/// input and can be tested without touching the process environment.
#[cfg(unix)]
fn choose_root(ambient: &Path) -> PathBuf {
    let preferred = ambient.join(SCRATCH_NAMESPACE);
    if leaves_room_for_a_child_socket(&preferred) {
        return preferred;
    }
    let short = short_root();
    if leaves_room_for_a_child_socket(&short) {
        return short;
    }
    // Nothing fits. Isolation still beats the unbounded leak it exists to stop,
    // so take the preferred root anyway and name the escape hatch — an agent
    // that binds a socket in `TMPDIR` is going to need it.
    warn_no_root_fits(&preferred);
    preferred
}

#[cfg(unix)]
fn warn_no_root_fits(root: &Path) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        tracing::warn!(
            "[ACP][scratch] {} leaves a child under {CHILD_SOCKET_RESERVE} bytes for a \
             unix socket name (AF_UNIX paths cap at {} here); an agent that binds a \
             socket in its temp dir may fail to start. Set {ROOT_ENV} to a shorter \
             directory, or {ISOLATION_ENV}=0 to turn isolation off.",
            root.display(),
            SUN_PATH_CAP - 1,
        );
    });
}

/// The single directory under which every per-launch scratch dir is created.
///
/// Deliberately not one root per agent configuration. An earlier design derived
/// the root from a per-agent `env_json` `TMP` so a user could choose the volume;
/// that made the set of roots unbounded and not discoverable by a crash sweep
/// (change the setting, crash, and the old root keeps its gigabytes forever). A
/// per-agent `TMP` is therefore IGNORED while isolation is on — see
/// [`apply_to_env`].
///
/// One root at a time, but not the same one forever: `choose_root` moves it
/// when the ambient temp directory is too long to bind a unix socket under
/// (#754). That keeps the set SMALL and ENUMERABLE rather than unbounded, which
/// is what the sweeps actually need — [`sweep_roots`] visits every root codeg
/// can pick, so relocating never strands a directory.
pub fn scratch_root() -> PathBuf {
    if let Some(explicit) = std::env::var_os(ROOT_ENV).filter(|v| !v.is_empty()) {
        // An explicit root is a decision about which VOLUME absorbs the churn,
        // usually taken to stop a system disk filling up. Honour it even when
        // it is too long to be safe and say so once, rather than silently
        // relocating gigabytes back onto the disk the user moved them off.
        let root = PathBuf::from(explicit).join(SCRATCH_NAMESPACE);
        #[cfg(unix)]
        if !leaves_room_for_a_child_socket(&root) {
            warn_no_root_fits(&root);
        }
        return root;
    }
    #[cfg(unix)]
    {
        choose_root(&std::env::temp_dir())
    }
    #[cfg(not(unix))]
    {
        // Windows children use named pipes, which live in their own kernel
        // namespace and have no `sun_path` budget to blow.
        std::env::temp_dir().join(SCRATCH_NAMESPACE)
    }
}

/// Every root a scratch directory of ours could be sitting under.
///
/// More than one because [`scratch_root`]'s answer is not fixed for all time:
/// it moves when the ambient temp directory crosses the length budget, when
/// [`ROOT_ENV`] is set or cleared, and — for anyone upgrading past #754 — when
/// codeg itself changes its mind about where the short root lives. Sweeping
/// only today's answer would strand yesterday's directories exactly the way
/// this module's own docs warn about.
fn sweep_roots() -> Vec<PathBuf> {
    let mut roots = vec![scratch_root()];
    for candidate in [
        std::env::temp_dir().join(SCRATCH_NAMESPACE),
        #[cfg(unix)]
        short_root(),
    ] {
        if !roots.contains(&candidate) {
            roots.push(candidate);
        }
    }
    roots
}

/// A scratch directory owned by one agent launch.
///
/// Cleanup lives in `Drop`, and that is load-bearing rather than idiomatic
/// tidiness. The handle travels inside an `on_exit` callback and across `.await`
/// points in the sign-in path, so there are real ways for it to be destroyed
/// without anyone calling [`LaunchScratch::release`]: the callback is dropped
/// because the connection never produced a reap, or an HTTP handler's future is
/// cancelled when the client disconnects. Without `Drop` those paths leak twice
/// over — the directory stays on disk AND its name stays in [`REGISTRY`], which
/// makes [`sweep_own_orphans`] skip it for the life of the process. `release`
/// exists to say "the process is reaped, now is the right time", and is the
/// only path that does not warn.
///
/// Deliberately NOT `Clone`: `Drop` running twice for one directory could
/// unregister a name a later launch had since been given, which is the one way
/// the sweep's set arithmetic could be made to delete a directory in use.
#[derive(Debug)]
pub struct LaunchScratch {
    name: String,
    path: PathBuf,
    /// Set by [`LaunchScratch::release`] so `Drop` can tell a deliberate
    /// handback from an unwind. Does not change WHAT is done, only whether it
    /// is reported as a bug.
    released: bool,
}

impl LaunchScratch {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Give the directory back. Returns immediately: the bounded retry ladder
    /// goes onto the current runtime, so teardown never waits on a filesystem
    /// that may be holding a sharing violation.
    ///
    /// The work itself is in `Drop` — see the type docs for why that is not
    /// merely a refactor.
    pub fn release(mut self) {
        self.released = true;
    }
}

impl Drop for LaunchScratch {
    fn drop(&mut self) {
        if !self.released {
            tracing::warn!(
                "[ACP][scratch] {} was dropped without release (a cancelled \
                 request, or a connection that never reported a reap); \
                 cleaning up anyway",
                self.path.display()
            );
        }
        let name = std::mem::take(&mut self.name);
        let path = std::mem::take(&mut self.path);
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move { remove_with_retries(name, path).await });
            }
            Err(_) => {
                // No runtime to retry on — one attempt, then hand the name back
                // REGARDLESS. Keeping it would make this directory invisible to
                // every in-session sweep, which is the one outcome worse than a
                // failed delete: the sweep is now its only remaining chance.
                if let Err(e) = remove_dir_robust(&path) {
                    tracing::warn!(
                        "[ACP][scratch] could not remove {} off-runtime: {e}; \
                         left for the sweep",
                        path.display()
                    );
                }
                unregister(&name);
            }
        }
    }
}

/// The bounded removal ladder. A free function rather than a method because
/// `Drop` cannot move `self`, and because every exit unregisters — see
/// [`LaunchScratch`].
async fn remove_with_retries(name: String, path: PathBuf) {
    let mut delay = REMOVE_RETRY_BASE;
    for attempt in 1..=REMOVE_ATTEMPTS {
        match remove_dir_robust(&path) {
            Ok(()) => {
                unregister(&name);
                return;
            }
            Err(e) if attempt == REMOVE_ATTEMPTS => {
                // Give the name up even though the directory survives: the
                // launch is over, so holding it in the registry would only
                // hide it from the sweep that is now its best chance.
                tracing::warn!(
                    "[ACP][scratch] giving up on {} after {attempt} attempts: {e}; \
                     left for the sweep",
                    path.display()
                );
                unregister(&name);
                return;
            }
            Err(_) => {
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
        }
    }
}

/// Create a scratch directory for one launch, or `None` when isolation is off
/// or the directory cannot be created.
///
/// `None` is a normal outcome, not an error: the caller leaves
/// `TMP`/`TEMP`/`TMPDIR` alone and the child uses the system temp directory
/// exactly as it did before. A launch must never fail because codeg could not
/// make a scratch directory — and it WOULD fail if the variables were set to a
/// path that does not exist, because the PyInstaller bootloader only creates
/// its own `_MEIxxxxxx` leaf, not the parents above it.
pub fn create() -> Option<LaunchScratch> {
    if !isolation_enabled() {
        return None;
    }
    let root = scratch_root();
    if let Err(e) = create_root(&root) {
        tracing::warn!(
            "[ACP][scratch] cannot create {}: {e}; launching on the system temp dir",
            root.display()
        );
        return None;
    }

    for _ in 0..8 {
        let name = new_dir_name(std::process::id());
        // INVARIANT 1: registered before it can exist on disk.
        if !register(&name) {
            continue;
        }
        let path = root.join(&name);
        match create_leaf(&path) {
            Ok(()) => {
                return Some(LaunchScratch {
                    name,
                    path,
                    released: false,
                })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                unregister(&name);
                continue;
            }
            Err(e) => {
                unregister(&name);
                tracing::warn!(
                    "[ACP][scratch] cannot create {}: {e}; launching on the system temp dir",
                    path.display()
                );
                return None;
            }
        }
    }
    None
}

/// `create_dir_all` for the root, private on Unix and refused if it is not ours.
///
/// `0700` rather than the umask default because `short_root` puts the root in
/// `/tmp`, which is `1777` — the per-user directory it stands in for
/// (`/var/folders/…/T`) is itself `0700`, and a path-length fallback has no
/// business widening who can read an agent's temp files.
///
/// The mode alone is not enough, which is why [`verify_root_is_ours`] follows
/// it: `mode` applies to a `mkdir` that HAPPENS, and `recursive(true)` answers
/// `Ok(())` for a directory that already exists — leaving its mode and its
/// owner exactly as they were. In a world-writable `/tmp` that is a directory
/// another local user can win the race to create.
///
/// Shared with [`crate::acp::delegation::listener`], whose own `/tmp` fallback
/// for the broker socket is waiting in the same world-writable directory for
/// the same squatter. The guard is security-sensitive enough that a second copy
/// of it is worse than a `pub(crate)`.
pub(crate) fn create_root(root: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(root)?;
        verify_root_is_ours(root)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(root)
    }
}

/// Refuse a scratch root codeg did not create.
///
/// Guards the two ways `/tmp/codeg-acp-<euid>` can be waiting for us: a
/// directory another local account created first (they own it, so they can read
/// and replace what the agent unpacks there), and a SYMLINK aimed somewhere
/// else — `create_dir_all` is satisfied by a symlink to a directory, so without
/// this the whole scratch tree, and the sweeps that delete it, would follow.
///
/// Refusing is safe: [`create`] treats an uncreatable root as "no isolation",
/// so the child falls back to the ambient temp directory it used before this
/// module existed — which is short, so #754 does not come back with it.
///
/// Once the root exists and is ours there is no TOCTOU left to close: `/tmp` is
/// sticky, so no other account can rename or delete an entry it does not own,
/// and the root itself is `0700`.
#[cfg(unix)]
fn verify_root_is_ours(root: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    // `symlink_metadata`, not `metadata`: a symlink is the case to reject, and
    // `metadata` would resolve it and cheerfully report the target as a fine
    // directory.
    let meta = std::fs::symlink_metadata(root)?;
    if !meta.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "scratch root is a symlink or a file, not a directory",
        ));
    }
    let us = unsafe { libc::geteuid() };
    if meta.uid() != us {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("scratch root belongs to uid {}, not to us ({us})", meta.uid()),
        ));
    }
    // Ours, but reachable by others — a root left behind by a codeg that
    // predates the `0700` above, when `create_dir_all` took the umask default.
    // Tighten it rather than refuse: refusing would turn every upgrade into a
    // silent loss of isolation. Best-effort because a filesystem the user
    // pointed `CODEG_ACP_TMP_ROOT` at may not carry Unix modes at all, and
    // ownership is the check that actually bounds who can get in.
    if meta.mode() & 0o077 != 0 {
        let _ = std::fs::set_permissions(root, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// `create_dir` for one launch's directory, `0700` on Unix.
///
/// Deliberately not `create_dir_all`: a name that somehow already exists has to
/// surface as `AlreadyExists` so [`create`] mints another one instead of
/// adopting a directory it does not own.
fn create_leaf(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(path)
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir(path)
    }
}

/// Point a merged agent environment at `scratch`.
///
/// MUST be applied after every other contributor, `runtime_env` included.
/// Precedence is the whole fix: `GetTempPathW` reads `TMP` first, so a
/// per-agent `env_json` `TMP` left in place would send the extraction wherever
/// it points while codeg deleted an empty scratch directory and reported
/// success. Users who want the churn elsewhere set [`ROOT_ENV`]; users who want
/// the old behavior wholesale set [`ISOLATION_ENV`] to `0`.
pub(crate) fn apply_to_env(env: &mut std::collections::BTreeMap<String, String>, scratch: &Path) {
    let value = scratch.to_string_lossy().into_owned();
    if cfg!(windows) {
        // Windows environment names are case-INSENSITIVE, but this map is not.
        // A per-agent `env_json` spelling it `tmp` would survive alongside the
        // `TMP` inserted below, and the child would then see two spellings of
        // one variable with only one of them pointing at the scratch dir —
        // silently reopening the very leak this module closes. Drop every
        // case variant first so the canonical name is the only one left.
        //
        // Unix is the opposite: `tmp` and `TMP` really are different variables
        // there, so removing one would be destroying an unrelated setting.
        env.retain(|key, _| {
            !TEMP_ENV_KEYS
                .iter()
                .any(|canonical| key.eq_ignore_ascii_case(canonical))
        });
    }
    for key in TEMP_ENV_KEYS {
        env.insert(key.to_string(), value.clone());
    }
}

/// Reclaim scratch directories belonging to THIS process that are no longer
/// live — a launch whose removal ladder was exhausted, or one left by a
/// previous process that held the same pid number.
///
/// Exact set arithmetic, no heuristic: a live launch is in the registry by
/// construction (invariant 1), so it can never appear in the diff.
pub fn sweep_own_orphans() {
    let roots = sweep_roots();
    let our_pid = std::process::id();

    // INVARIANT 3: enumerate + diff under the lock...
    let claimed: Vec<PathBuf> = {
        let Ok(guard) = registry().lock() else {
            return;
        };
        roots
            .iter()
            .filter_map(|root| std::fs::read_dir(root).ok())
            .flatten()
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                (pid_from_dir_name(&name) == Some(our_pid) && !guard.contains(&name))
                    .then(|| entry.path())
            })
            .collect()
    };
    // ...delete outside it.
    for path in claimed {
        if remove_dir_robust(&path).is_ok() {
            tracing::info!("[ACP][scratch] reclaimed orphan {}", path.display());
        }
    }
}

/// Reclaim scratch directories left by OTHER codeg processes that have exited.
///
/// Runs at startup, where the interesting orphans are the ones a crash or a
/// force-quit left behind. Deletes only on a positively confirmed dead owner —
/// see [`probe_pid`] for why "the probe failed" must not be read as "the owner
/// is gone".
pub fn sweep_foreign_orphans() {
    let our_pid = std::process::id();
    for entry in sweep_roots()
        .iter()
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(pid) = pid_from_dir_name(&name) else {
            continue;
        };
        // Our own pid is `sweep_own_orphans`' business; it is the only caller
        // that can tell a live launch from an orphan.
        if pid == our_pid {
            continue;
        }
        if probe_pid(pid) != PidState::Dead {
            continue;
        }
        let path = entry.path();
        if remove_dir_robust(&path).is_ok() {
            tracing::info!(
                "[ACP][scratch] reclaimed orphan {} from dead pid {pid}",
                path.display()
            );
        }
    }
}

/// Long-running task: [`sweep_own_orphans`] on a fixed interval. Spawned by
/// both runtimes at startup; never returns.
pub async fn scratch_sweep_task() {
    let mut ticker = tokio::time::interval(SWEEP_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    ticker.tick().await; // the first tick is immediate; skip it
    loop {
        ticker.tick().await;
        let _ = tokio::task::spawn_blocking(sweep_own_orphans).await;
    }
}

/// What a pid probe established. The third state is the point: a probe that
/// FAILED tells us nothing, and must not be collapsed into "dead" by a caller
/// that is about to delete something.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PidState {
    Alive,
    Dead,
    Unknown,
}

/// Tri-state liveness probe.
///
/// Deliberately NOT `delegation::parent_watcher::parent_alive`, which answers a
/// bool and treats every `OpenProcess` failure as "gone". That is correct for
/// its own caller — a child watching its own parent in the same session, where
/// access-denied cannot happen — and wrong here, where one codeg instance is
/// asking about another and an indeterminate answer must NOT authorize a
/// delete.
pub fn probe_pid(pid: u32) -> PidState {
    if pid == 0 {
        return PidState::Unknown;
    }
    #[cfg(unix)]
    {
        // `kill(pid, 0)` sends no signal; the kernel just validates the target.
        if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
            return PidState::Alive;
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(e) if e == libc::ESRCH => PidState::Dead,
            // Alive, just owned by somebody else.
            Some(e) if e == libc::EPERM => PidState::Alive,
            _ => PidState::Unknown,
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{
            CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };

        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if handle.is_null() {
            // ERROR_INVALID_PARAMETER is the one failure that positively means
            // "no such pid". Access-denied and everything else mean the process
            // may well be running and we simply cannot see it.
            return if unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
                PidState::Dead
            } else {
                PidState::Unknown
            };
        }
        let mut code: u32 = 0;
        let read_ok = unsafe { GetExitCodeProcess(handle, &mut code as *mut u32) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        if read_ok == 0 {
            return PidState::Unknown;
        }
        if code == STILL_ACTIVE as u32 {
            PidState::Alive
        } else {
            PidState::Dead
        }
    }
}

/// `<owning codeg pid>-<8 hex>`.
///
/// The pid is CODEG'S, not the agent's: the directory is created before the
/// spawn, so the agent has no pid yet. It is what lets a startup sweep tell
/// "some other codeg owns this" from "its owner is gone".
fn new_dir_name(pid: u32) -> String {
    let suffix: String = uuid::Uuid::new_v4().simple().to_string().chars().take(8).collect();
    format!("{pid}-{suffix}")
}

/// Inverse of [`new_dir_name`]. `None` for anything that does not match the
/// shape, so a stray file or a directory some other tool created is skipped
/// rather than deleted.
fn pid_from_dir_name(name: &str) -> Option<u32> {
    let (pid, suffix) = name.split_once('-')?;
    if suffix.len() != 8 || !suffix.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    pid.parse().ok()
}

/// `true` when the name was newly inserted.
fn register(name: &str) -> bool {
    registry()
        .lock()
        .map(|mut g| g.insert(name.to_string()))
        .unwrap_or(false)
}

fn unregister(name: &str) {
    if let Ok(mut g) = registry().lock() {
        g.remove(name);
    }
}

/// `remove_dir_all` plus one recovery pass for read-only children.
///
/// Windows refuses to delete a file carrying `FILE_ATTRIBUTE_READONLY`, and
/// read-only extracted payloads are not hypothetical — the macOS Antigravity
/// build writes its cached CA bundles as `r-xr-xr-x`. On Unix the attribute is
/// irrelevant to deletion (write permission on the PARENT is what matters), so
/// the recovery pass is a no-op there and the first call already succeeded.
fn remove_dir_robust(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(first) => {
            if clear_readonly_recursive(path).is_err() {
                return Err(first);
            }
            std::fs::remove_dir_all(path).or_else(|second| {
                if second.kind() == std::io::ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(second)
                }
            })
        }
    }
}

fn clear_readonly_recursive(path: &Path) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(path)?;
    let mut perms = meta.permissions();
    if perms.readonly() {
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(path, perms);
    }
    // Never follow a symlink out of the tree we are clearing.
    if meta.is_dir() && !meta.file_type().is_symlink() {
        for entry in std::fs::read_dir(path)?.flatten() {
            let _ = clear_readonly_recursive(&entry.path());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Length of a real macOS per-user temp directory,
    /// `/var/folders/hl/26lfwjvs4s760g9fm1nk15xm0000gn/T`. Short enough that a
    /// child could bind a socket directly in it, long enough that it cannot
    /// also absorb `/codeg-acp/<pid>-<hex>` — which is the whole of #754.
    #[cfg(unix)]
    const MACOS_TEMP_DIR_LEN: usize = 48;

    /// A real directory exactly `len` bytes long, built under `/tmp` so the
    /// length is ours to choose rather than this machine's `TMPDIR`'s.
    #[cfg(unix)]
    fn ambient_of_len(holder: &Path, len: usize) -> PathBuf {
        let pad = len.saturating_sub(holder.as_os_str().len() + 1);
        assert!(pad >= 1, "{} is already {len} bytes", holder.display());
        let dir = holder.join("x".repeat(pad));
        std::fs::create_dir(&dir).expect("create ambient");
        assert_eq!(dir.as_os_str().len(), len);
        dir
    }

    /// #754. The regression that mattered was not arithmetic, it was a child
    /// that could no longer `bind`, so this asserts against the kernel rather
    /// than against [`leaves_room_for_a_child_socket`]'s own opinion.
    ///
    /// Before the length budget existed this bound
    /// `<ambient>/codeg-acp/<pid>-<hex>/znr-<uuid>.sock` — 119 bytes — and
    /// failed with `path must be shorter than SUN_LEN`.
    #[cfg(unix)]
    #[test]
    fn a_child_can_bind_a_unix_socket_inside_the_scratch_dir() {
        let holder = tempfile::tempdir_in("/tmp").expect("tempdir");
        let ambient = ambient_of_len(holder.path(), MACOS_TEMP_DIR_LEN);

        let root = choose_root(&ambient);
        create_root(&root).expect("create root");
        let leaf = root.join(new_dir_name(std::process::id()));
        create_leaf(&leaf).expect("create leaf");

        // The name the agent in #754 creates: `znr-<uuid v4>.sock`, 45 bytes.
        let sock = leaf.join(format!("znr-{}.sock", uuid::Uuid::new_v4()));
        assert_eq!(sock.file_name().expect("file name").len(), 45);
        let bound = std::os::unix::net::UnixListener::bind(&sock);
        let ok = bound.is_ok();
        drop(bound);
        // The leaf can sit outside `holder` once the short root is chosen.
        let _ = std::fs::remove_dir_all(&leaf);
        assert!(
            ok,
            "a child must be able to bind {} bytes at {}",
            sock.as_os_str().len(),
            sock.display()
        );
    }

    /// The fallback only fires when it has to: a temp directory short enough to
    /// nest under keeps the churn where the user's `TMPDIR` points, which is
    /// the case on a typical Linux box where `temp_dir()` is already `/tmp`.
    #[cfg(unix)]
    #[test]
    fn a_short_temp_dir_is_still_nested_under_normally() {
        let ambient = Path::new("/tmp");
        assert_eq!(choose_root(ambient), ambient.join(SCRATCH_NAMESPACE));
    }

    /// ...and an over-long one moves to the short root rather than being nested
    /// under regardless.
    #[cfg(unix)]
    #[test]
    fn an_over_long_temp_dir_falls_back_to_the_short_root() {
        let ambient = PathBuf::from(format!("/var/folders/hl/{}/T", "z".repeat(30)));
        assert_eq!(ambient.as_os_str().len(), MACOS_TEMP_DIR_LEN);
        assert!(
            !leaves_room_for_a_child_socket(&ambient.join(SCRATCH_NAMESPACE)),
            "the nested root is what #754 showed does not fit"
        );
        assert_eq!(choose_root(&ambient), short_root());
    }

    /// `short_root` lives in a `1777` `/tmp`, so the root can be waiting for us
    /// when we get there. A symlink is the dangerous shape: `create_dir_all` is
    /// satisfied by one pointing at a directory, which would put the whole
    /// scratch tree — and the sweeps that delete it — wherever it aims.
    #[cfg(unix)]
    #[test]
    fn a_symlinked_root_is_refused() {
        let holder = tempfile::tempdir().expect("tempdir");
        let elsewhere = holder.path().join("attacker-owned");
        std::fs::create_dir(&elsewhere).expect("create target");
        let root = holder.path().join("root");
        std::os::unix::fs::symlink(&elsewhere, &root).expect("symlink");

        assert!(
            create_root(&root).is_err(),
            "a symlinked root must not be adopted"
        );
    }

    /// The other half: a root we DO own, merely left group/world-reachable by a
    /// codeg that predates the `0700`. Refusing that would turn every upgrade
    /// into a silent loss of isolation, so it is tightened instead.
    #[cfg(unix)]
    #[test]
    fn a_loose_root_we_own_is_tightened_rather_than_refused() {
        use std::os::unix::fs::PermissionsExt;
        let holder = tempfile::tempdir().expect("tempdir");
        let root = holder.path().join("codeg-acp");
        std::fs::create_dir(&root).expect("create root");
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).expect("chmod");

        create_root(&root).expect("a root we own must still be usable");

        let mode = std::fs::metadata(&root).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700, "and must come back private");
    }

    /// A launch directory is what the child is actually handed, so it carries
    /// the same `0700` as the root above it.
    #[cfg(unix)]
    #[test]
    fn a_launch_directory_is_private_and_reports_collisions() {
        use std::os::unix::fs::PermissionsExt;
        let holder = tempfile::tempdir().expect("tempdir");
        let leaf = holder.path().join(new_dir_name(std::process::id()));

        create_leaf(&leaf).expect("create leaf");
        let mode = std::fs::metadata(&leaf).expect("meta").permissions().mode();
        assert_eq!(mode & 0o777, 0o700);

        // `create` mints a new name on this error rather than adopting the
        // directory, so it has to keep arriving as `AlreadyExists`.
        assert_eq!(
            create_leaf(&leaf).expect_err("second create must fail").kind(),
            std::io::ErrorKind::AlreadyExists
        );
    }

    /// The budget is only worth anything if it is measured against the number
    /// the kernel actually enforces.
    #[cfg(unix)]
    #[test]
    fn sun_path_cap_matches_the_kernel() {
        let addr = unsafe { std::mem::zeroed::<libc::sockaddr_un>() };
        assert_eq!(SUN_PATH_CAP, addr.sun_path.len());
    }

    /// Whatever root is chosen must stay reachable by the sweeps, or the fix
    /// for #754 would reopen the leak #735 closed by stranding directories
    /// under a root nothing enumerates any more.
    #[cfg(unix)]
    #[test]
    fn the_sweeps_still_cover_the_root_that_is_not_in_use() {
        let roots = sweep_roots();
        assert!(roots.contains(&scratch_root()), "the live root");
        assert!(
            roots.contains(&std::env::temp_dir().join(SCRATCH_NAMESPACE)),
            "and the ambient one, which a previous version may have filled"
        );
        assert!(roots.contains(&short_root()), "and the short fallback");
    }

    #[test]
    fn dir_name_round_trips_through_the_pid_parser() {
        let name = new_dir_name(4242);
        assert_eq!(pid_from_dir_name(&name), Some(4242));
    }

    #[test]
    fn dir_name_suffix_is_eight_hex_chars() {
        let name = new_dir_name(1);
        let (_, suffix) = name.split_once('-').expect("name must carry a suffix");
        assert_eq!(suffix.len(), 8);
        assert!(suffix.chars().all(|c| c.is_ascii_hexdigit()));
    }

    /// Anything that is not ours is skipped rather than deleted — the sweeps
    /// only ever touch names they can prove they minted.
    #[test]
    fn pid_parser_rejects_foreign_names() {
        for name in [
            "_MEI123456",          // another PyInstaller app
            "not-a-pid",           // suffix is not hex
            "123-abc",             // suffix too short
            "123-0123456789",      // suffix too long
            "123",                 // no suffix at all
            "",                    // empty
            "-deadbeef",           // no pid
        ] {
            assert_eq!(pid_from_dir_name(name), None, "{name} must not parse");
        }
    }

    #[test]
    fn registering_the_same_name_twice_fails() {
        let name = new_dir_name(std::process::id());
        assert!(register(&name));
        assert!(!register(&name));
        unregister(&name);
        assert!(register(&name));
        unregister(&name);
    }

    /// Our own live pid is always `Alive`, and the probe never answers `Dead`
    /// for it — the case that would let a sweep delete a running launch.
    #[test]
    fn probe_reports_our_own_process_alive() {
        assert_eq!(probe_pid(std::process::id()), PidState::Alive);
    }

    #[test]
    fn probe_never_claims_pid_zero_is_dead() {
        assert_eq!(probe_pid(0), PidState::Unknown);
    }

    fn is_registered(name: &str) -> bool {
        registry().lock().map(|g| g.contains(name)).unwrap_or(false)
    }

    /// The failure this guards is silent and permanent: a handle destroyed
    /// without `release` (a cancelled HTTP request, an `on_exit` callback
    /// dropped because the connection never reported a reap) used to leave its
    /// name in `REGISTRY` forever, and `sweep_own_orphans` skips every
    /// registered name — so the directory became invisible to the one thing
    /// that would have reclaimed it.
    #[test]
    fn dropping_without_release_still_hands_the_name_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = new_dir_name(std::process::id());
        let path = dir.path().join(&name);
        std::fs::create_dir(&path).expect("create");
        assert!(register(&name));

        drop(LaunchScratch {
            name: name.clone(),
            path: path.clone(),
            released: false,
        });

        assert!(!is_registered(&name), "a dropped name must not stay claimed");
        assert!(!path.exists(), "and the directory must be gone");
    }

    /// `release` is the same cleanup, just without the "somebody forgot" log.
    #[test]
    fn release_removes_the_directory_and_the_registration() {
        let dir = tempfile::tempdir().expect("tempdir");
        let name = new_dir_name(std::process::id());
        let path = dir.path().join(&name);
        std::fs::create_dir(&path).expect("create");
        assert!(register(&name));

        LaunchScratch {
            name: name.clone(),
            path: path.clone(),
            released: false,
        }
        .release();

        assert!(!is_registered(&name));
        assert!(!path.exists());
    }

    /// Windows env names are case-insensitive while this map is not, so a
    /// per-agent `tmp` would ride along beside the injected `TMP` and the child
    /// could read either. Unix is the opposite case: there the two really are
    /// different variables and dropping one would destroy a setting.
    #[test]
    fn a_case_variant_temp_key_cannot_shadow_the_scratch_dir() {
        let mut env = std::collections::BTreeMap::new();
        env.insert("tmp".to_string(), "/somewhere/else".to_string());
        env.insert("Temp".to_string(), "/somewhere/else".to_string());
        env.insert("UNRELATED".to_string(), "keep me".to_string());

        apply_to_env(&mut env, Path::new("/scratch/abc"));

        assert_eq!(env.get("UNRELATED").map(String::as_str), Some("keep me"));
        for key in TEMP_ENV_KEYS {
            assert_eq!(env.get(key).map(String::as_str), Some("/scratch/abc"));
        }
        for variant in ["tmp", "Temp"] {
            assert_eq!(
                env.contains_key(variant),
                !cfg!(windows),
                "{variant} must be dropped on Windows and kept on Unix"
            );
        }
    }

    #[test]
    fn apply_to_env_sets_all_three_names() {
        let mut env = std::collections::BTreeMap::new();
        // A per-agent value that would otherwise win: `GetTempPathW` reads
        // `TMP` first, so leaving this in place would silently defeat the
        // isolation.
        env.insert("TMP".to_string(), "/somewhere/else".to_string());
        apply_to_env(&mut env, Path::new("/scratch/abc"));
        for key in TEMP_ENV_KEYS {
            assert_eq!(env.get(key).map(String::as_str), Some("/scratch/abc"));
        }
    }

    #[test]
    fn remove_dir_robust_tolerates_a_missing_directory() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("never-existed");
        assert!(remove_dir_robust(&missing).is_ok());
    }

    #[test]
    fn remove_dir_robust_deletes_read_only_children() {
        let dir = tempfile::tempdir().expect("tempdir");
        let target = dir.path().join("payload");
        std::fs::create_dir_all(target.join("nested")).expect("create nested");
        let file = target.join("nested").join("cacert.pem");
        std::fs::write(&file, b"x").expect("write");
        let mut perms = std::fs::metadata(&file).expect("meta").permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&file, perms).expect("set readonly");

        assert!(remove_dir_robust(&target).is_ok());
        assert!(!target.exists());
    }
}
