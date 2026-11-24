//! Where a plugin's files, its record and its lock are, and the install
//! name that every path under the store is built from.
//!
//! ```text
//! ~/.codeg/plugins/                    the store (PluginsCtx::root)
//!   <name>/<revision>/                 one revision of one plugin, as listed
//!   .staging/<op>/                     an operation's files before they move in
//!   .ops/<op>.json                     an operation's journal
//!   .trash/                            revisions on their way out
//!   .claude-plugin/marketplace.json    (step 4) Claude Code's marketplace
//!   .agents/plugins/marketplace.json   (step 5) Codex's marketplace
//! ~/.codeg/harness/plugins.json        the record (PluginsCtx::record)
//! ~/.codeg/locks/plugins.lock          the lock (PluginsCtx::lock_path)
//! ```
//!
//! Everything sits under the **real** user home, like the skill store and
//! the MCP record: the hosts' configs are per user, shared by the desktop app
//! and any codeg-server of that user. An install name starts with a letter or
//! a digit, so it never meets the dot-folders beside it.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a writer waits for the plugins lock.
pub(crate) const LOCK_WAIT: Duration = Duration::from_secs(5);

pub(crate) const STAGING_DIR: &str = ".staging";
pub(crate) const OPS_DIR: &str = ".ops";
pub(crate) const TRASH_DIR: &str = ".trash";

/// The name a plugin is installed under: its folder in the store and the
/// name hosts know it by (`PluginInfo.name`). One plain path segment that
/// every host accepts — `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — and that is
/// safe as a folder name everywhere (no trailing dot, no Windows device
/// name). Anything else is refused, never rewritten.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct InstallName(String);

impl InstallName {
    pub fn parse(name: &str) -> Option<Self> {
        is_valid_install_name(name).then(|| Self(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for InstallName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

pub fn is_valid_install_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
        && crate::harness::skills::package::safe_path(name)
}

/// Injected failures, for the tests of what a crash at each step leaves.
#[derive(Clone, Default)]
pub(crate) struct Faults {
    #[cfg(test)]
    armed: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<&'static str>>>,
}

/// Where the plugin store, its record and its lock are. [`PluginsCtx::user`]
/// is the real one; tests build theirs over a temporary directory
/// ([`PluginsCtx::at`]).
#[derive(Clone)]
pub struct PluginsCtx {
    /// `~/.codeg/plugins`.
    pub root: PathBuf,
    /// `~/.codeg/harness/plugins.json`.
    pub record: PathBuf,
    /// `~/.codeg/locks/plugins.lock`.
    pub lock_path: PathBuf,
    pub lock_wait: Duration,
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) faults: Faults,
}

impl std::fmt::Debug for PluginsCtx {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PluginsCtx")
            .field("root", &self.root)
            .field("record", &self.record)
            .field("lock_path", &self.lock_path)
            .finish_non_exhaustive()
    }
}

impl PluginsCtx {
    /// The real store under `~/.codeg`. In a unit test, a directory of the
    /// test run's own under the system temp dir: no test touches the home.
    pub fn user() -> Self {
        #[cfg(test)]
        let codeg = std::env::temp_dir().join(format!("codeg-test-plugins-{}", std::process::id()));
        #[cfg(not(test))]
        let codeg = crate::commands::mcp_engine::agents::real_codeg_dir();
        Self::at(&codeg)
    }

    /// Everything laid out under `codeg` as it is under `~/.codeg`.
    pub fn at(codeg: &Path) -> Self {
        Self {
            root: codeg.join("plugins"),
            record: codeg.join("harness").join("plugins.json"),
            lock_path: codeg.join("locks").join("plugins.lock"),
            lock_wait: LOCK_WAIT,
            faults: Faults::default(),
        }
    }

    /// The store at `root` with its record at `record` (where a backup
    /// restore finds them); the lock beside the store, as under `~/.codeg`
    /// (`<root>/../locks/plugins.lock`).
    pub fn over(root: &Path, record: &Path) -> Self {
        let codeg = root.parent().unwrap_or(root);
        Self {
            root: root.to_path_buf(),
            record: record.to_path_buf(),
            lock_path: codeg.join("locks").join("plugins.lock"),
            lock_wait: LOCK_WAIT,
            faults: Faults::default(),
        }
    }

    /// `<root>/<name>`: every revision of one plugin.
    pub fn plugin_dir(&self, name: &InstallName) -> PathBuf {
        self.root.join(name.as_str())
    }

    /// `<root>/<name>/<revision>`.
    pub fn revision_dir(&self, name: &InstallName, revision: u64) -> PathBuf {
        self.plugin_dir(name).join(revision.to_string())
    }

    pub(crate) fn staging_root(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }

    pub(crate) fn staging_dir(&self, op: &str) -> PathBuf {
        self.staging_root().join(op)
    }

    pub(crate) fn ops_dir(&self) -> PathBuf {
        self.root.join(OPS_DIR)
    }

    pub(crate) fn journal_path(&self, op: &str) -> PathBuf {
        self.ops_dir().join(format!("{op}.json"))
    }

    pub(crate) fn trash_dir(&self) -> PathBuf {
        self.root.join(TRASH_DIR)
    }

    /// Fail at `point` when a test armed it.
    pub(crate) fn fault(&self, point: &'static str) -> std::io::Result<()> {
        #[cfg(test)]
        {
            let armed = self.faults.armed.lock().unwrap_or_else(|e| e.into_inner());
            if armed.contains(point) {
                return Err(std::io::Error::other(format!(
                    "injected failure at {point}"
                )));
            }
        }
        let _ = point;
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn arm_fault(&self, point: &'static str) {
        self.faults
            .armed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(point);
    }

    #[cfg(test)]
    pub(crate) fn disarm_faults(&self) {
        self.faults
            .armed
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clear();
    }
}
