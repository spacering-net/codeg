//! The plugins lock: one writer at a time for the plugin store, its record
//! and its journals, across every Codeg of this user.
//!
//! The MCP write lock's machinery under another file
//! (`commands::mcp_engine::lock`): a mutex in this process, then
//! `~/.codeg/locks/plugins.lock` held with `File::try_lock` across processes
//! (with the `.d` fallback where the file system has no locking). Not
//! re-entrant: nothing that holds it calls a function that takes it.
//!
//! **Lock order.** A plugin operation takes this lock first and holds it for
//! its whole life; what it does under it takes the other locks inside it,
//! one at a time, always in this order:
//!
//! - plugins → skills (skills-only hosts: member skills through the skills
//!   engine);
//! - plugins → MCP → Codex home (Claude Code's `settings.json` is written
//!   under the MCP lock; Codex's `config.toml` under the Codex home lock,
//!   which is never held while taking the MCP lock).
//!
//! The skills lock and the MCP lock are never held together. Nothing that
//! holds the skills, MCP or Codex home lock takes this one. The startup
//! recovery takes it before the skills journals are recovered.

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::commands::mcp_engine::lock::{self as shared, McpLockError, McpWriteGuard};

use super::ctx::PluginsCtx;

/// Holding the lock; dropping it lets go.
pub struct PluginsGuard {
    _inner: McpWriteGuard,
}

/// Why the lock could not be taken.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginsLockError {
    /// Another Codeg (or another task here) held it for the whole wait.
    Busy,
    /// The fallback lock file is there and stayed there.
    Held {
        path: PathBuf,
        holder_exited: bool,
    },
    Io(String),
}

impl PluginsLockError {
    /// The same codes as the other locks' (`lock_busy`, `lock_held`,
    /// `io_error`).
    pub fn code(&self) -> &'static str {
        McpLockError::from(self.clone()).code()
    }
}

impl std::fmt::Display for PluginsLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginsLockError::Busy => write!(
                f,
                "another Codeg process is changing plugins right now; try again"
            ),
            PluginsLockError::Held {
                path,
                holder_exited,
            } => {
                write!(f, "Codeg's plugins are locked by {}", path.display())?;
                if *holder_exited {
                    write!(
                        f,
                        "; its holder has exited. Make sure no other Codeg is running, then delete that file"
                    )?;
                }
                Ok(())
            }
            PluginsLockError::Io(message) => write!(f, "{message}"),
        }
    }
}

impl From<McpLockError> for PluginsLockError {
    fn from(error: McpLockError) -> Self {
        match error {
            McpLockError::Busy => PluginsLockError::Busy,
            McpLockError::Held {
                path,
                holder_exited,
            } => PluginsLockError::Held {
                path,
                holder_exited,
            },
            McpLockError::Io(message) => PluginsLockError::Io(message),
        }
    }
}

impl From<PluginsLockError> for McpLockError {
    fn from(error: PluginsLockError) -> Self {
        match error {
            PluginsLockError::Busy => McpLockError::Busy,
            PluginsLockError::Held {
                path,
                holder_exited,
            } => McpLockError::Held {
                path,
                holder_exited,
            },
            PluginsLockError::Io(message) => McpLockError::Io(message),
        }
    }
}

pub async fn acquire_at(path: &Path, wait: Duration) -> Result<PluginsGuard, PluginsLockError> {
    shared::acquire_at(path, wait)
        .await
        .map(|inner| PluginsGuard { _inner: inner })
        .map_err(Into::into)
}

/// [`acquire_at`] for a caller that cannot await. Waits on this thread.
pub fn acquire_blocking_at(path: &Path, wait: Duration) -> Result<PluginsGuard, PluginsLockError> {
    shared::acquire_blocking_at(path, wait)
        .map(|inner| PluginsGuard { _inner: inner })
        .map_err(Into::into)
}

impl PluginsCtx {
    pub async fn lock(&self) -> Result<PluginsGuard, PluginsLockError> {
        acquire_at(&self.lock_path, self.lock_wait).await
    }

    pub fn lock_blocking(&self) -> Result<PluginsGuard, PluginsLockError> {
        acquire_blocking_at(&self.lock_path, self.lock_wait)
    }
}
