//! The lock every write of codex's files takes, in two layers.
//!
//! - **In this process**: one `tokio::sync::Mutex` per `CODEX_HOME`, kept in a
//!   process-wide table so the connection layer's pre-launch check, the
//!   commands and the scheduler all reach the same one. It also guarantees a
//!   single handle per process goes for the file lock, so `flock` never
//!   contends with itself.
//! - **Across processes**: `CODEX_HOME/codeg-codex.lock`, held with std's
//!   `File::try_lock` (the same call the task engine elects with). The desktop
//!   app, a debug build and a local codeg-server all write the same
//!   `~/.codex`, each with a database of its own.
//!
//! A file system without `try_lock` (some network mounts) gets a fallback:
//! `codeg-codex.lock.d`, created with `create_new` and removed on release.
//! Like git's `index.lock` it is never taken over — not by age (a suspended
//! holder is still a holder) and not by "its holder has exited" (two waiters
//! could both decide so, and the second to delete would remove the lock the
//! first just made). A leftover one blocks writes until the user removes it;
//! the error names the file and its holder. One directory reached through
//! both kinds (two systems sharing a mount, one with `try_lock` and one
//! without) is not supported: the two never see each other.
//!
//! Nothing is ever written without one of the two file locks.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

pub const LOCK_FILE: &str = "codeg-codex.lock";
pub const FALLBACK_LOCK_FILE: &str = "codeg-codex.lock.d";
pub const SEQ_FILE: &str = "codeg-codex.seq";
/// How long a writer waits for the lock before giving up.
pub const LOCK_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(50);

/// Holding both layers. Only [`acquire`] makes one, so a function that takes
/// `&CodexHomeGuard` can only run inside the critical section — and since a
/// second [`acquire`] on the same home in the same process waits on the
/// first, the coordinator's locked steps can never re-enter it.
pub struct CodexHomeGuard {
    home: PathBuf,
    _process: tokio::sync::OwnedMutexGuard<()>,
    _file: Option<std::fs::File>,
    fallback: Option<PathBuf>,
}

impl CodexHomeGuard {
    pub fn home(&self) -> &Path {
        &self.home
    }
}

impl Drop for CodexHomeGuard {
    fn drop(&mut self) {
        if let Some(path) = self.fallback.take() {
            let _ = std::fs::remove_file(path);
        }
        // The file lock goes with `_file`.
    }
}

/// Who holds the fallback lock, as it wrote itself down.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LockHolder {
    pub host: String,
    pub pid: u32,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LockError {
    /// Another codeg (or another task here) held it for the whole wait.
    Busy,
    /// The fallback lock is there and stayed there: its holder, when it could
    /// be read, and whether that holder is known to have exited.
    Held {
        path: PathBuf,
        holder: Option<LockHolder>,
        holder_exited: bool,
    },
    Io(String),
}

impl std::fmt::Display for LockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LockError::Busy => write!(
                f,
                "another codeg process is writing the Codex configuration; try again"
            ),
            LockError::Held {
                path,
                holder,
                holder_exited,
            } => {
                write!(f, "the Codex configuration is locked by {}", path.display())?;
                if let Some(h) = holder {
                    write!(
                        f,
                        " (held by process {} on {} since {})",
                        h.pid, h.host, h.since
                    )?;
                }
                if *holder_exited {
                    write!(
                        f,
                        "; its holder has exited. Make sure no other codeg is running, then delete that file"
                    )?;
                }
                Ok(())
            }
            LockError::Io(msg) => write!(f, "{msg}"),
        }
    }
}

fn process_locks() -> &'static Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// `CODEX_HOME` as the lock table keys it: resolved when it exists, so two
/// spellings of one directory share a lock.
pub fn normalize_home(home: &Path) -> PathBuf {
    std::fs::canonicalize(home).unwrap_or_else(|_| home.to_path_buf())
}

fn process_lock(home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let key = normalize_home(home);
    let mut table = process_locks().lock().unwrap_or_else(|e| e.into_inner());
    table
        .entry(key)
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// Take both layers, waiting at most `wait` in total.
pub async fn acquire(home: &Path, wait: Duration) -> Result<CodexHomeGuard, LockError> {
    let deadline = Instant::now() + wait;
    let process = tokio::time::timeout(wait, process_lock(home).lock_owned())
        .await
        .map_err(|_| LockError::Busy)?;
    let home_buf = home.to_path_buf();
    let file = tokio::task::spawn_blocking(move || acquire_file(&home_buf, deadline))
        .await
        .map_err(|e| LockError::Io(format!("lock task: {e}")))??;
    Ok(CodexHomeGuard {
        home: home.to_path_buf(),
        _process: process,
        _file: file.0,
        fallback: file.1,
    })
}

type FileLock = (Option<std::fs::File>, Option<PathBuf>);

fn acquire_file(home: &Path, deadline: Instant) -> Result<FileLock, LockError> {
    std::fs::create_dir_all(home)
        .map_err(|e| LockError::Io(format!("create {}: {e}", home.display())))?;
    let path = home.join(LOCK_FILE);
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)
        .map_err(|e| LockError::Io(format!("open {}: {e}", path.display())))?;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok((Some(file), None)),
            Err(std::fs::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(LockError::Busy);
                }
                std::thread::sleep(POLL);
            }
            Err(std::fs::TryLockError::Error(e)) => {
                tracing::warn!(
                    "[codex-catalog] {} cannot be locked ({e}); using {FALLBACK_LOCK_FILE}",
                    path.display()
                );
                return acquire_fallback(home, deadline).map(|p| (None, Some(p)));
            }
        }
    }
}

fn this_host() -> String {
    crate::commands::config_sync::snapshot::source_device()
}

fn acquire_fallback(home: &Path, deadline: Instant) -> Result<PathBuf, LockError> {
    use std::io::Write;
    let path = home.join(FALLBACK_LOCK_FILE);
    loop {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut f) => {
                let holder = LockHolder {
                    host: this_host(),
                    pid: std::process::id(),
                    since: chrono::Utc::now().to_rfc3339(),
                };
                let _ = f.write_all(&serde_json::to_vec(&holder).unwrap_or_default());
                let _ = f.sync_all();
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if Instant::now() >= deadline {
                    let holder = std::fs::read(&path)
                        .ok()
                        .and_then(|b| serde_json::from_slice::<LockHolder>(&b).ok());
                    let holder_exited = holder.as_ref().is_some_and(|h| {
                        h.host == this_host()
                            && crate::acp::scratch_dir::probe_pid(h.pid)
                                == crate::acp::scratch_dir::PidState::Dead
                    });
                    return Err(LockError::Held {
                        path,
                        holder,
                        holder_exited,
                    });
                }
                std::thread::sleep(POLL);
            }
            Err(e) => {
                return Err(LockError::Io(format!("create {}: {e}", path.display())));
            }
        }
    }
}

/// The next request number of this `CODEX_HOME`: read, add one, write back,
/// all under the lock. Strictly increasing and never repeated, whatever the
/// clock does — which is what orders two fetches of the same list.
pub fn next_seq(guard: &CodexHomeGuard) -> std::io::Result<u64> {
    let path = guard.home().join(SEQ_FILE);
    let current = match std::fs::read_to_string(&path) {
        Ok(text) => text.trim().parse::<u64>().unwrap_or(0),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e),
    };
    let next = current + 1;
    crate::acp::codex_endpoint_catalog::write_atomic(&path, next.to_string().as_bytes())?;
    Ok(next)
}

/// [`next_seq`] for a caller not already holding the lock.
pub async fn take_seq(home: &Path) -> Result<u64, LockError> {
    let guard = acquire(home, LOCK_WAIT).await?;
    next_seq(&guard).map_err(|e| LockError::Io(format!("request counter: {e}")))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A test's second process: this test binary again, running just that
    /// test, which finds itself in a role (see [`as_other_process`]).
    pub(crate) struct OtherProcess {
        pub(crate) role: String,
        pub(crate) home: PathBuf,
        /// Where the two processes leave each other signs, outside the home.
        pub(crate) marks: PathBuf,
    }

    const ROLE_ENV: &str = "CODEG_TEST_CODEX_LOCK_ROLE";
    const HOME_ENV: &str = "CODEG_TEST_CODEX_LOCK_HOME";
    const MARKS_ENV: &str = "CODEG_TEST_CODEX_LOCK_MARKS";
    /// How long either process waits for the other before giving up.
    const PATIENCE: Duration = Duration::from_secs(60);

    /// Start the test `name` of `module` (pass `module_path!()`) again in a
    /// process of its own, as `role` on `home`.
    pub(crate) fn spawn_other_process(
        module: &str,
        name: &str,
        role: &str,
        home: &Path,
        marks: &Path,
    ) -> std::process::Child {
        // libtest names a test by its path inside the crate.
        let module = module.split_once("::").map_or(module, |(_, rest)| rest);
        std::process::Command::new(std::env::current_exe().unwrap())
            .args([&format!("{module}::{name}"), "--exact", "--nocapture"])
            .args(["--test-threads", "1"])
            .env(ROLE_ENV, role)
            .env(HOME_ENV, home)
            .env(MARKS_ENV, marks)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap()
    }

    /// Who this process is, when a test started it as its other process.
    pub(crate) fn as_other_process() -> Option<OtherProcess> {
        Some(OtherProcess {
            role: std::env::var(ROLE_ENV).ok()?,
            home: std::env::var_os(HOME_ENV)?.into(),
            marks: std::env::var_os(MARKS_ENV)?.into(),
        })
    }

    /// Wait for the mark `name`, failing if `other` (when given) exits first.
    pub(crate) fn wait_for_mark(
        marks: &Path,
        name: &str,
        mut other: Option<&mut std::process::Child>,
    ) {
        let deadline = Instant::now() + PATIENCE;
        while !marks.join(name).exists() {
            if let Some(child) = other.as_deref_mut() {
                if let Some(status) = child.try_wait().unwrap() {
                    panic!("the other process exited ({status}) before `{name}`");
                }
            }
            assert!(Instant::now() < deadline, "no `{name}` within {PATIENCE:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The other process's part: take the lock, say so, hold it until told
    /// to let go.
    pub(crate) async fn hold_the_lock_until_released(other: &OtherProcess) {
        assert_eq!(other.role, "hold");
        let guard = acquire(&other.home, LOCK_WAIT).await.unwrap();
        std::fs::write(other.marks.join("held"), "").unwrap();
        wait_for_mark(&other.marks, "release", None);
        drop(guard);
    }

    /// Wait for the other process to finish, and require it to have passed.
    pub(crate) fn passed(other: std::process::Child) {
        let out = other.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "the other process failed ({}):\n{}\n{}",
            out.status,
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    /// Another process holding the lock — a real one, not a second handle
    /// in this one — keeps us out until it lets go.
    #[tokio::test]
    async fn a_lock_another_process_holds_keeps_us_out_until_it_lets_go() {
        if let Some(other) = as_other_process() {
            hold_the_lock_until_released(&other).await;
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (home, marks) = (dir.path().join("home"), dir.path().join("marks"));
        std::fs::create_dir_all(&marks).unwrap();
        let mut other = spawn_other_process(
            module_path!(),
            "a_lock_another_process_holds_keeps_us_out_until_it_lets_go",
            "hold",
            &home,
            &marks,
        );
        wait_for_mark(&marks, "held", Some(&mut other));
        let busy = acquire(&home, Duration::from_millis(300)).await;
        assert!(matches!(busy, Err(LockError::Busy)), "{:?}", busy.err());
        std::fs::write(marks.join("release"), "").unwrap();
        passed(other);
        assert!(acquire(&home, LOCK_WAIT).await.is_ok());
    }

    /// Request numbers stay unique across processes because taking one waits
    /// on the file lock, not only the in-process one: a number taken while
    /// another process holds the lock is the one right after the number that
    /// process takes under it. Then the two take numbers side by side, and
    /// none comes up twice.
    #[tokio::test]
    async fn two_processes_taking_numbers_never_share_one() {
        const EACH: u64 = 25;
        // `take_seq`, but waiting on the other process for `PATIENCE`, as the
        // marks do, rather than `LOCK_WAIT`. A waiter only polls the lock, so
        // while the other takes its numbers back to back it may wait out that
        // whole run, which a slow runner can stretch past `LOCK_WAIT`.
        async fn take_one(home: &Path) -> u64 {
            let guard = acquire(home, PATIENCE).await.unwrap();
            next_seq(&guard).unwrap()
        }
        let take = |home: PathBuf| async move {
            let mut taken = Vec::new();
            for _ in 0..EACH {
                taken.push(take_one(&home).await);
            }
            taken
        };
        if let Some(other) = as_other_process() {
            assert_eq!(other.role, "count");
            let guard = acquire(&other.home, LOCK_WAIT).await.unwrap();
            std::fs::write(other.marks.join("held"), "").unwrap();
            // Long enough for the parent to be waiting on the lock.
            wait_for_mark(&other.marks, "waiting", None);
            std::thread::sleep(Duration::from_millis(300));
            let under_lock = next_seq(&guard).unwrap();
            std::fs::write(other.marks.join("under-lock"), under_lock.to_string()).unwrap();
            drop(guard);
            wait_for_mark(&other.marks, "go", None);
            let taken = take(other.home.clone()).await;
            std::fs::write(
                other.marks.join("theirs.json"),
                serde_json::to_vec(&taken).unwrap(),
            )
            .unwrap();
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (home, marks) = (dir.path().join("home"), dir.path().join("marks"));
        std::fs::create_dir_all(&marks).unwrap();
        let mut other = spawn_other_process(
            module_path!(),
            "two_processes_taking_numbers_never_share_one",
            "count",
            &home,
            &marks,
        );
        wait_for_mark(&marks, "held", Some(&mut other));
        std::fs::write(marks.join("waiting"), "").unwrap();
        let after_theirs = take_one(&home).await;
        let under_lock: u64 = std::fs::read_to_string(marks.join("under-lock"))
            .unwrap()
            .parse()
            .unwrap();
        assert_eq!(
            after_theirs,
            under_lock + 1,
            "taken while the lock was theirs"
        );

        std::fs::write(marks.join("go"), "").unwrap();
        let ours = take(home.clone()).await;
        passed(other);
        let theirs: Vec<u64> =
            serde_json::from_slice(&std::fs::read(marks.join("theirs.json")).unwrap()).unwrap();
        let mut all = [vec![under_lock, after_theirs], ours, theirs].concat();
        all.sort_unstable();
        assert_eq!(all, (1..=2 * EACH + 2).collect::<Vec<_>>());
    }

    #[tokio::test]
    async fn the_lock_serializes_and_releases() {
        let dir = tempfile::tempdir().unwrap();
        let first = acquire(dir.path(), LOCK_WAIT).await.unwrap();
        // Same process, same home: the second waits on the first.
        let busy = acquire(dir.path(), Duration::from_millis(100)).await;
        assert!(matches!(busy, Err(LockError::Busy)));
        drop(first);
        let again = acquire(dir.path(), LOCK_WAIT).await;
        assert!(again.is_ok());
    }

    #[tokio::test]
    async fn another_process_holding_the_file_lock_blocks_us() {
        let dir = tempfile::tempdir().unwrap();
        // A second, independent handle stands in for another process.
        let other = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.path().join(LOCK_FILE))
            .unwrap();
        other.try_lock().unwrap();
        let busy = acquire(dir.path(), Duration::from_millis(150)).await;
        assert!(matches!(busy, Err(LockError::Busy)));
        other.unlock().unwrap();
        assert!(acquire(dir.path(), LOCK_WAIT).await.is_ok());
    }

    #[tokio::test]
    async fn sequence_numbers_strictly_increase_across_takers() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let mut handles = Vec::new();
        for _ in 0..8 {
            let home = home.clone();
            handles.push(tokio::spawn(async move { take_seq(&home).await.unwrap() }));
        }
        let mut seen = Vec::new();
        for h in handles {
            seen.push(h.await.unwrap());
        }
        seen.sort();
        assert_eq!(seen, (1..=8).collect::<Vec<u64>>());
        assert_eq!(take_seq(&home).await.unwrap(), 9);
    }

    #[test]
    fn a_leftover_fallback_lock_is_never_taken_over() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(FALLBACK_LOCK_FILE);
        let holder = LockHolder {
            host: this_host(),
            // Not a running process (pid_max is far below this on every OS).
            pid: 999_999_999,
            since: "2026-10-21T00:00:00Z".into(),
        };
        std::fs::write(&path, serde_json::to_vec(&holder).unwrap()).unwrap();
        let err =
            acquire_fallback(dir.path(), Instant::now() + Duration::from_millis(120)).unwrap_err();
        match err {
            LockError::Held {
                path: p,
                holder: Some(h),
                holder_exited,
            } => {
                assert_eq!(p, path);
                assert_eq!(h.pid, 999_999_999);
                assert!(holder_exited);
            }
            other => panic!("{other:?}"),
        }
        // Still there: nothing deleted it.
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        let mine = acquire_fallback(dir.path(), Instant::now() + LOCK_WAIT).unwrap();
        assert_eq!(mine, path);
    }

    #[test]
    fn two_waiters_on_a_removed_fallback_lock_get_it_one_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let spawn = |home: PathBuf, barrier: Arc<std::sync::Barrier>| {
            std::thread::spawn(move || {
                barrier.wait();
                acquire_fallback(&home, Instant::now() + Duration::from_millis(200))
            })
        };
        let a = spawn(home.clone(), barrier.clone());
        let b = spawn(home.clone(), barrier);
        let results = [a.join().unwrap(), b.join().unwrap()];
        // `create_new` admits exactly one; the other times out while it is held.
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    }
}
