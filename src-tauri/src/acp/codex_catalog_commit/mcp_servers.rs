//! The MCP commit: config.toml with its `mcp_servers` tables changed and
//! nothing else.
//!
//! The MCP engine (`commands::mcp_engine`) decides what the tables should
//! say; this is the only door it has to Codex's file. It comes in under the
//! same two-layer lock as a model-catalog commit, so the two never interleave:
//! each reads config.toml after taking the lock and publishes before letting
//! go, and the later one starts from what the earlier one wrote. An
//! interrupted model-catalog commit is finished or undone first ([`lock_home`]
//! runs the journal's recovery), so the text an MCP commit edits is never a
//! half-published one.
//!
//! Two checks stand between the engine and the file:
//! - the file still holds exactly the bytes the change was computed from —
//!   Codex itself takes no lock, and `codex mcp add` may have run meanwhile;
//! - the new text differs from the old one only under `mcp_servers` (and the
//!   `[mcp.servers]` tables older codeg releases left behind). The keys this
//!   module manages — `model_catalog_json`, root `model`, codeg's provider —
//!   are compared as values, so an MCP commit that would touch them is
//!   refused whatever the engine meant.
//!
//! One file, so no journal: the write is a rename over config.toml, which
//! leaves either the old file or the new one. It goes through the engine's
//! own writer rather than [`super::txn`], because that one keeps what a
//! journaled commit does not need to — a symlinked config.toml stays a link,
//! and the file keeps its permissions (an MCP entry's `env` holds tokens).

use std::path::{Path, PathBuf};

use super::{lock, txn, CatalogError, LockedHome, Published, CONFIG_REL, LOCK_WAIT};
use crate::commands::mcp_engine::fsio;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum McpCommitError {
    /// config.toml is not what the change was computed from.
    Changed,
    /// The change reaches outside the MCP tables.
    OutsideMcpServers,
    /// config.toml, as it is or as it would be, is not TOML.
    Invalid(String),
    Io(String),
}

impl std::fmt::Display for McpCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            McpCommitError::Changed => {
                write!(
                    f,
                    "Codex's config.toml changed while the MCP servers were being saved"
                )
            }
            McpCommitError::OutsideMcpServers => write!(
                f,
                "an MCP save may only change the mcp_servers tables of Codex's config.toml"
            ),
            McpCommitError::Invalid(message) => write!(f, "invalid codex config.toml: {message}"),
            McpCommitError::Io(message) => write!(f, "{message}"),
        }
    }
}

/// What an MCP commit does to config.toml.
#[derive(Debug, Clone, Copy)]
pub enum McpConfigChange<'a> {
    Write(&'a [u8]),
    /// Take the file away again: undoing a commit that created it.
    Remove,
}

/// config.toml without its MCP tables: what an MCP commit must leave as it
/// is. A file that is not there has nothing outside them.
fn outside_mcp_servers(bytes: Option<&[u8]>) -> Result<String, McpCommitError> {
    let Some(bytes) = bytes else {
        return Ok(String::new());
    };
    let text = std::str::from_utf8(bytes).map_err(|e| McpCommitError::Invalid(e.to_string()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut table: toml::Table = text
        .parse()
        .map_err(|e: toml::de::Error| McpCommitError::Invalid(e.to_string()))?;
    table.remove("mcp_servers");
    let legacy_emptied = match table.get_mut("mcp") {
        Some(toml::Value::Table(mcp)) => {
            mcp.remove("servers");
            mcp.is_empty()
        }
        _ => false,
    };
    if legacy_emptied {
        table.remove("mcp");
    }
    // Compared as text: equal tables print alike, and a `nan` in a config
    // does not make it unequal to itself.
    toml::to_string(&table).map_err(|e| McpCommitError::Invalid(e.to_string()))
}

/// [`super::lock_home`] for a caller that cannot await (the retired MCP
/// commands): the same lock, the same recovery, waited for on this thread.
pub fn lock_home_blocking(home: &Path) -> Result<LockedHome, CatalogError> {
    let guard = lock::acquire_blocking(home, LOCK_WAIT)?;
    txn::recover(&guard)?;
    let published = Published::read(home)?;
    Ok(LockedHome { guard, published })
}

impl LockedHome {
    pub fn config_path(&self) -> PathBuf {
        self.guard.home().join(CONFIG_REL)
    }

    /// config.toml as it is on disk right now, under the lock; `None` when
    /// there is none.
    pub fn read_config_bytes(&self) -> std::io::Result<Option<Vec<u8>>> {
        fsio::read_bytes(&self.config_path())
    }

    /// Publish a change to the MCP tables. `expected` is the file the change
    /// was computed from, read with [`Self::read_config_bytes`] under this
    /// same lock.
    pub fn commit_mcp_servers(
        &self,
        expected: Option<&[u8]>,
        change: McpConfigChange<'_>,
    ) -> Result<(), McpCommitError> {
        let path = self.config_path();
        let current = fsio::read_bytes(&path)
            .map_err(|e| McpCommitError::Io(format!("read {}: {e}", path.display())))?;
        if current.as_deref() != expected {
            return Err(McpCommitError::Changed);
        }
        let updated = match change {
            McpConfigChange::Write(bytes) => Some(bytes),
            McpConfigChange::Remove => None,
        };
        if outside_mcp_servers(current.as_deref())? != outside_mcp_servers(updated)? {
            return Err(McpCommitError::OutsideMcpServers);
        }
        match updated {
            Some(bytes) => fsio::write_atomic(&path, bytes)
                .map_err(|e| McpCommitError::Io(format!("write {}: {e}", path.display()))),
            None => fsio::remove_file(&path)
                .map_err(|e| McpCommitError::Io(format!("remove {}: {e}", path.display()))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::lock_home;
    use super::*;

    const CONFIG: &str = "# mine\nmodel = \"gpt-5.5\"\nmodel_catalog_json = \"codeg-model-catalog.json\"\n\n[mcp_servers.a]\ncommand = \"a\"\n";

    #[tokio::test]
    async fn only_the_mcp_tables_may_change() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::write(home.join(CONFIG_REL), CONFIG).unwrap();
        let locked = lock_home(home).await.unwrap();
        let on_disk = locked.read_config_bytes().unwrap();
        assert_eq!(on_disk.as_deref(), Some(CONFIG.as_bytes()));

        // A managed key, a comment-only change elsewhere is fine but a value
        // is not: `model` here.
        let touched = CONFIG.replace("gpt-5.5", "gpt-6");
        assert_eq!(
            locked.commit_mcp_servers(
                on_disk.as_deref(),
                McpConfigChange::Write(touched.as_bytes())
            ),
            Err(McpCommitError::OutsideMcpServers)
        );
        // Removing the file would take the other keys with it.
        assert_eq!(
            locked.commit_mcp_servers(on_disk.as_deref(), McpConfigChange::Remove),
            Err(McpCommitError::OutsideMcpServers)
        );
        // Not TOML.
        assert!(matches!(
            locked.commit_mcp_servers(on_disk.as_deref(), McpConfigChange::Write(b"model = ")),
            Err(McpCommitError::Invalid(_))
        ));
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_REL)).unwrap(),
            CONFIG
        );

        // The MCP tables themselves, in either location.
        let updated = format!("{CONFIG}\n[mcp_servers.b]\nurl = \"https://b.test\"\n\n[mcp.servers.c]\ncommand = \"c\"\n");
        locked
            .commit_mcp_servers(
                on_disk.as_deref(),
                McpConfigChange::Write(updated.as_bytes()),
            )
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_REL)).unwrap(),
            updated
        );
    }

    #[tokio::test]
    async fn a_file_that_changed_since_it_was_read_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::write(home.join(CONFIG_REL), CONFIG).unwrap();
        let locked = lock_home(home).await.unwrap();
        let read = locked.read_config_bytes().unwrap();
        // Codex itself takes no lock.
        let theirs = format!("{CONFIG}\n[mcp_servers.theirs]\ncommand = \"t\"\n");
        std::fs::write(home.join(CONFIG_REL), &theirs).unwrap();
        let ours = format!("{CONFIG}\n[mcp_servers.ours]\ncommand = \"o\"\n");
        assert_eq!(
            locked.commit_mcp_servers(read.as_deref(), McpConfigChange::Write(ours.as_bytes())),
            Err(McpCommitError::Changed)
        );
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_REL)).unwrap(),
            theirs
        );
    }

    #[tokio::test]
    async fn a_config_made_of_mcp_tables_alone_can_be_created_and_taken_away() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let locked = lock_home(&home).await.unwrap();
        assert_eq!(locked.read_config_bytes().unwrap(), None);
        let created = b"[mcp_servers.a]\ncommand = \"a\"\n";
        locked
            .commit_mcp_servers(None, McpConfigChange::Write(created))
            .unwrap();
        assert_eq!(std::fs::read(home.join(CONFIG_REL)).unwrap(), created);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(home.join(CONFIG_REL))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "a file codeg creates is private");
        }
        locked
            .commit_mcp_servers(Some(created), McpConfigChange::Remove)
            .unwrap();
        assert!(!home.join(CONFIG_REL).exists());
    }

    #[test]
    fn the_blocking_lock_is_the_same_lock() {
        let dir = tempfile::tempdir().unwrap();
        let first = lock_home_blocking(dir.path()).unwrap();
        let busy = lock::acquire_blocking(dir.path(), std::time::Duration::from_millis(80));
        assert!(matches!(busy, Err(lock::LockError::Busy)));
        drop(first);
        assert!(lock_home_blocking(dir.path()).is_ok());
    }
}
