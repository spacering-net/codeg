//! The skills lock: one writer at a time for Codeg's skill store and the
//! links into the agents' skill directories, across every Codeg of this user.
//!
//! It is the MCP write lock's machinery under another file
//! (`commands::mcp_engine::lock`, which builds on `codex_catalog_commit`'s):
//! a mutex in this process, then `~/.codeg/locks/skills.lock` held with
//! `File::try_lock` across processes, with the `skills.lock.d` fallback where
//! the file system has no locking. The file sits under the REAL user home,
//! like the store itself — not under `CODEG_HOME` / `CODEG_DATA_DIR` — so the
//! desktop app and a codeg-server of one user share it.
//!
//! Who takes it: the packs' extraction at startup, every link operation, the
//! Office sync, Custom create / edit / delete / import, the Skills page's
//! writes, restoring Codeg's backup over the store, and (later) Harness
//! installs. It is not re-entrant: nothing that holds it calls a function
//! that takes it. Independent of the MCP lock; nothing takes both.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::app_error::AppCommandError;
use crate::commands::mcp_engine::lock::{self as shared, McpLockError, McpWriteGuard};

use super::model::{codes, SkillsIssue};

pub(crate) const LOCK_FILE: &str = "skills.lock";
/// How long a writer waits for the lock before giving up.
pub(crate) const LOCK_WAIT: Duration = Duration::from_secs(5);
/// Restoring Codeg's backup at startup waits longer: the swap cannot be
/// retried until the next start.
pub(crate) const RESTORE_LOCK_WAIT: Duration = Duration::from_secs(30);

/// Holding both layers; dropping it lets go.
pub struct SkillsGuard {
    _inner: McpWriteGuard,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillsLockError {
    Busy,
    Held { path: PathBuf, holder_exited: bool },
    Io(String),
}

impl SkillsLockError {
    pub fn code(&self) -> &'static str {
        match self {
            SkillsLockError::Busy => codes::LOCK_BUSY,
            SkillsLockError::Held { .. } => codes::LOCK_HELD,
            SkillsLockError::Io(_) => codes::IO_ERROR,
        }
    }

    pub fn issue(&self) -> SkillsIssue {
        let issue = SkillsIssue::new(self.code());
        match self {
            SkillsLockError::Busy => issue,
            SkillsLockError::Held { path, .. } => issue.path(path),
            SkillsLockError::Io(message) => issue.detail(message.clone()),
        }
    }
}

impl std::fmt::Display for SkillsLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SkillsLockError::Busy => write!(
                f,
                "another Codeg process is changing skills right now; try again"
            ),
            SkillsLockError::Held {
                path,
                holder_exited,
            } => {
                write!(f, "Codeg's skills are locked by {}", path.display())?;
                if *holder_exited {
                    write!(
                        f,
                        "; its holder has exited. Make sure no other Codeg is running, then delete that file"
                    )?;
                }
                Ok(())
            }
            SkillsLockError::Io(message) => write!(f, "{message}"),
        }
    }
}

impl From<McpLockError> for SkillsLockError {
    fn from(error: McpLockError) -> Self {
        match error {
            McpLockError::Busy => SkillsLockError::Busy,
            McpLockError::Held {
                path,
                holder_exited,
            } => SkillsLockError::Held {
                path,
                holder_exited,
            },
            McpLockError::Io(message) => SkillsLockError::Io(message),
        }
    }
}

impl From<SkillsLockError> for AppCommandError {
    fn from(error: SkillsLockError) -> Self {
        let message = error.to_string();
        let detail = match &error {
            SkillsLockError::Busy => None,
            SkillsLockError::Held { path, .. } => Some(path.display().to_string()),
            SkillsLockError::Io(message) => Some(message.clone()),
        };
        let base = match &error {
            SkillsLockError::Io(_) => AppCommandError::io_error(message),
            _ => AppCommandError::task_execution_failed(message),
        };
        super::coded_error(base, error.code(), detail)
    }
}

/// `~/.codeg/locks/skills.lock`. Unit tests get a directory of their own
/// under the system temp dir: the writers that take this lock run there, and
/// a test leaves the real home alone.
pub(crate) fn default_lock_path() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir()
            .join(format!("codeg-test-skills-locks-{}", std::process::id()))
            .join(LOCK_FILE)
    }
    #[cfg(not(test))]
    {
        crate::commands::mcp_engine::agents::real_codeg_dir()
            .join("locks")
            .join(LOCK_FILE)
    }
}

pub async fn acquire_at(path: &Path, wait: Duration) -> Result<SkillsGuard, SkillsLockError> {
    shared::acquire_at(path, wait)
        .await
        .map(|inner| SkillsGuard { _inner: inner })
        .map_err(Into::into)
}

/// [`acquire_at`] for a caller that cannot await. Waits on this thread.
pub fn acquire_blocking_at(path: &Path, wait: Duration) -> Result<SkillsGuard, SkillsLockError> {
    shared::acquire_blocking_at(path, wait)
        .map(|inner| SkillsGuard { _inner: inner })
        .map_err(Into::into)
}
