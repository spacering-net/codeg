//! The MCP write lock: one writer at a time for the agents' MCP-bearing
//! config files, across every codeg of this user.
//!
//! Two layers, the same way Codex's files are locked
//! (`acp::codex_catalog_commit::lock`): a mutex inside this process, so one
//! handle at a time goes for the file lock, and `~/.codeg/locks/mcp.lock`
//! held with `File::try_lock` across processes (with the same `…​.d` fallback
//! on a file system without it). The lock file sits under the REAL user home,
//! like the skills store, not under `CODEG_HOME` / `CODEG_DATA_DIR`: the
//! desktop app and a codeg-server of one user each have a data directory of
//! their own and write the same `~/.claude.json`.
//!
//! Whoever changes one of those files takes it: `mcp_apply`, the retired MCP
//! commands, and the settings panels that write a whole config file (Grok,
//! Hermes, Qoder, OpenCode, and the generic one behind Claude Code's and
//! Gemini's `settings.json`). The agents themselves do not, which is what the
//! basis check and the atomic rename are for.
//!
//! **Order.** The MCP lock first, then Codex's (`codex_catalog_commit`),
//! never the other way round. Nothing that holds Codex's lock takes this one.
//!
//! The lock is not re-entrant: a function that takes it must not be called
//! with it held. The low-level writers (`fsio::write_atomic`,
//! `opencode_config::write_atomic`, `write_hermes_secret_file`) therefore
//! take nothing; their callers do.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::acp::codex_catalog_commit::lock::{acquire_file_named, LockError};
use crate::app_error::AppCommandError;

use super::model::codes;

pub(crate) const LOCK_FILE: &str = "mcp.lock";
const FALLBACK_LOCK_FILE: &str = "mcp.lock.d";
/// How long a writer waits for the lock before giving up.
pub(crate) const LOCK_WAIT: Duration = Duration::from_secs(5);
const POLL: Duration = Duration::from_millis(25);

/// Holding both layers. Dropping it releases them.
pub struct McpWriteGuard {
    _process: tokio::sync::OwnedMutexGuard<()>,
    _file: Option<std::fs::File>,
    fallback: Option<PathBuf>,
}

impl Drop for McpWriteGuard {
    fn drop(&mut self) {
        if let Some(path) = self.fallback.take() {
            let _ = std::fs::remove_file(path);
        }
        // The file lock goes with `_file`.
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpLockError {
    /// Another codeg (or another task here) held it for the whole wait.
    Busy,
    /// The fallback lock file is there and stayed there.
    Held {
        path: PathBuf,
        holder_exited: bool,
    },
    Io(String),
}

impl McpLockError {
    pub fn code(&self) -> &'static str {
        match self {
            McpLockError::Busy => codes::LOCK_BUSY,
            McpLockError::Held { .. } => codes::LOCK_HELD,
            McpLockError::Io(_) => codes::IO_ERROR,
        }
    }

    pub fn detail(&self) -> Option<String> {
        match self {
            McpLockError::Busy => None,
            McpLockError::Held { path, .. } => Some(path.display().to_string()),
            McpLockError::Io(message) => Some(message.clone()),
        }
    }
}

impl std::fmt::Display for McpLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpLockError::Busy => write!(
                f,
                "another codeg process is writing the agents' MCP configuration; try again"
            ),
            McpLockError::Held {
                path,
                holder_exited,
            } => {
                write!(f, "the MCP configuration is locked by {}", path.display())?;
                if *holder_exited {
                    write!(
                        f,
                        "; its holder has exited. Make sure no other codeg is running, then delete that file"
                    )?;
                }
                Ok(())
            }
            McpLockError::Io(message) => write!(f, "{message}"),
        }
    }
}

impl From<LockError> for McpLockError {
    fn from(error: LockError) -> Self {
        match error {
            LockError::Busy => McpLockError::Busy,
            LockError::Held {
                path,
                holder_exited,
                ..
            } => McpLockError::Held {
                path,
                holder_exited,
            },
            LockError::Io(message) => McpLockError::Io(message),
        }
    }
}

impl From<McpLockError> for AppCommandError {
    fn from(error: McpLockError) -> Self {
        let message = error.to_string();
        let base = match &error {
            McpLockError::Io(_) => AppCommandError::io_error(message),
            _ => AppCommandError::task_execution_failed(message),
        };
        super::coded_error(base, error.code(), error.detail())
    }
}

/// `~/.codeg/locks/mcp.lock`. Unit tests get a directory of their own under
/// the system temp dir instead: the writers that take this lock are exercised
/// there, and a test must leave the real home alone.
pub(crate) fn default_lock_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir()
            .join(format!("codeg-test-mcp-locks-{}", std::process::id()))
            .join(LOCK_FILE)
    }
    #[cfg(not(test))]
    {
        super::agents::real_codeg_dir()
            .join("locks")
            .join(LOCK_FILE)
    }
}

fn process_locks() -> &'static Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn process_lock(path: &Path) -> Arc<tokio::sync::Mutex<()>> {
    let mut table = process_locks().lock().unwrap_or_else(|e| e.into_inner());
    table
        .entry(path.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

fn lock_dir(path: &Path) -> PathBuf {
    path.parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn acquire_file(path: &Path, deadline: Instant) -> Result<McpFileLock, McpLockError> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| LOCK_FILE.to_string());
    let fallback = if name == LOCK_FILE {
        FALLBACK_LOCK_FILE.to_string()
    } else {
        format!("{name}.d")
    };
    Ok(acquire_file_named(
        &lock_dir(path),
        &name,
        &fallback,
        "mcp",
        deadline,
    )?)
}

type McpFileLock = (Option<std::fs::File>, Option<PathBuf>);

/// Take the lock at `path`, waiting at most `wait` in total.
pub async fn acquire_at(path: &Path, wait: Duration) -> Result<McpWriteGuard, McpLockError> {
    let deadline = Instant::now() + wait;
    let process = tokio::time::timeout(wait, process_lock(path).lock_owned())
        .await
        .map_err(|_| McpLockError::Busy)?;
    let owned = path.to_path_buf();
    let file = tokio::task::spawn_blocking(move || acquire_file(&owned, deadline))
        .await
        .map_err(|e| McpLockError::Io(format!("lock task: {e}")))??;
    Ok(McpWriteGuard {
        _process: process,
        _file: file.0,
        fallback: file.1,
    })
}

/// [`acquire_at`] for a caller that cannot await — the settings writers are
/// synchronous functions. Waits on this thread.
pub fn acquire_blocking_at(path: &Path, wait: Duration) -> Result<McpWriteGuard, McpLockError> {
    let deadline = Instant::now() + wait;
    let lock = process_lock(path);
    let process = loop {
        match lock.clone().try_lock_owned() {
            Ok(guard) => break guard,
            Err(_) => {
                if Instant::now() >= deadline {
                    return Err(McpLockError::Busy);
                }
                std::thread::sleep(POLL);
            }
        }
    };
    let file = acquire_file(path, deadline)?;
    Ok(McpWriteGuard {
        _process: process,
        _file: file.0,
        fallback: file.1,
    })
}

/// The MCP write lock of this user, for an async caller.
pub async fn acquire() -> Result<McpWriteGuard, McpLockError> {
    acquire_at(&default_lock_path(), LOCK_WAIT).await
}

/// The MCP write lock of this user, for a synchronous caller.
pub fn acquire_blocking() -> Result<McpWriteGuard, McpLockError> {
    acquire_blocking_at(&default_lock_path(), LOCK_WAIT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::codex_catalog_commit::lock::tests::{
        as_other_process, passed, spawn_other_process, wait_for_mark,
    };

    #[tokio::test]
    async fn the_lock_serializes_async_and_blocking_takers_and_releases() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("locks").join(LOCK_FILE);
        let first = acquire_at(&path, LOCK_WAIT).await.unwrap();
        assert_eq!(
            acquire_at(&path, Duration::from_millis(80)).await.err(),
            Some(McpLockError::Busy)
        );
        assert_eq!(
            acquire_blocking_at(&path, Duration::from_millis(80)).err(),
            Some(McpLockError::Busy)
        );
        drop(first);
        let second = acquire_blocking_at(&path, LOCK_WAIT).unwrap();
        assert_eq!(
            acquire_at(&path, Duration::from_millis(80)).await.err(),
            Some(McpLockError::Busy)
        );
        drop(second);
        assert!(acquire_at(&path, LOCK_WAIT).await.is_ok());
    }

    #[tokio::test]
    async fn a_second_handle_on_the_lock_file_keeps_us_out() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOCK_FILE);
        // An independent handle stands in for another process.
        let other = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .unwrap();
        other.try_lock().unwrap();
        assert_eq!(
            acquire_at(&path, Duration::from_millis(120)).await.err(),
            Some(McpLockError::Busy)
        );
        other.unlock().unwrap();
        assert!(acquire_at(&path, LOCK_WAIT).await.is_ok());
    }

    /// A real second process holding the lock keeps this one out until it
    /// lets go: the desktop app and a codeg-server share the lock file.
    #[tokio::test]
    async fn a_lock_another_process_holds_keeps_us_out_until_it_lets_go() {
        if let Some(other) = as_other_process() {
            assert_eq!(other.role, "hold");
            let guard = acquire_at(&other.home.join(LOCK_FILE), LOCK_WAIT)
                .await
                .unwrap();
            std::fs::write(other.marks.join("held"), "").unwrap();
            wait_for_mark(&other.marks, "release", None);
            drop(guard);
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (home, marks) = (dir.path().join("locks"), dir.path().join("marks"));
        std::fs::create_dir_all(&marks).unwrap();
        let mut other = spawn_other_process(
            module_path!(),
            "a_lock_another_process_holds_keeps_us_out_until_it_lets_go",
            "hold",
            &home,
            &marks,
        );
        wait_for_mark(&marks, "held", Some(&mut other));
        let path = home.join(LOCK_FILE);
        assert_eq!(
            acquire_at(&path, Duration::from_millis(300)).await.err(),
            Some(McpLockError::Busy)
        );
        std::fs::write(marks.join("release"), "").unwrap();
        passed(other);
        assert!(acquire_at(&path, LOCK_WAIT).await.is_ok());
    }

    /// What a retired command and the settings writers hand back when the
    /// lock cannot be had: an error the page can name in the user's language.
    #[test]
    fn a_lock_that_cannot_be_taken_is_an_error_with_its_code() {
        let busy = AppCommandError::from(McpLockError::Busy);
        assert_eq!(busy.i18n_key.as_deref(), Some("errors.lockBusy"));
        assert_eq!(busy.i18n_params.unwrap()["code"], "lock_busy");

        let held = AppCommandError::from(McpLockError::Held {
            path: PathBuf::from("/x/mcp.lock.d"),
            holder_exited: true,
        });
        assert_eq!(held.i18n_key.as_deref(), Some("errors.lockHeld"));
        assert!(held.message.contains("has exited"), "{}", held.message);
        let params = held.i18n_params.unwrap();
        assert_eq!(params["code"], "lock_held");
        assert_eq!(params["detail"], "/x/mcp.lock.d");

        let io = AppCommandError::from(McpLockError::Io("no such directory".to_string()));
        assert_eq!(io.i18n_key.as_deref(), Some("errors.ioError"));
        assert_eq!(io.i18n_params.unwrap()["detail"], "no such directory");
    }

    #[test]
    fn the_default_lock_of_a_test_run_is_not_in_the_real_home() {
        let path = default_lock_path();
        assert!(path.starts_with(std::env::temp_dir()), "{}", path.display());
    }
}
