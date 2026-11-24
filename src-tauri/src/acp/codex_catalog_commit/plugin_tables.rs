//! The plugin commit: config.toml with the switches and the hook trust of
//! one marketplace's plugins changed, and nothing else.
//!
//! The Harness plugin adapter (`harness::plugins::hosts::codex`) turns a
//! plugin of Codeg's marketplace off and on (`[plugins."<name>@<market>"]
//! enabled`) and, when the plugin goes, takes away the trust Codex keeps for
//! its hooks (`[hooks.state."<name>@<market>:…"]`). It comes in under the
//! same two-layer lock as the other commits, with the same two checks as the
//! MCP commit ([`super::mcp_servers`]):
//! - the file still holds exactly the bytes the change was computed from;
//! - the new text differs from the old one only in those entries — of that
//!   marketplace's plugins, never another's or the user's own.
//!
//! One file, so no journal: a rename over config.toml, through the MCP
//! engine's writer (a symlinked config.toml stays a link, the file keeps its
//! permissions).

use super::{LockedHome, CONFIG_REL};
use crate::commands::mcp_engine::fsio;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginCommitError {
    /// config.toml is not what the change was computed from.
    Changed,
    /// The change reaches outside the marketplace's plugin entries.
    Outside,
    /// config.toml, as it is or as it would be, is not TOML.
    Invalid(String),
    Io(String),
}

impl std::fmt::Display for PluginCommitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PluginCommitError::Changed => write!(
                f,
                "Codex's config.toml changed while the plugin settings were being saved"
            ),
            PluginCommitError::Outside => write!(
                f,
                "a plugin save may only change its own plugin entries of Codex's config.toml"
            ),
            PluginCommitError::Invalid(message) => {
                write!(f, "invalid codex config.toml: {message}")
            }
            PluginCommitError::Io(message) => write!(f, "{message}"),
        }
    }
}

/// Whether `key` (of `[plugins]`) is a plugin of `marketplace`.
fn is_market_plugin(key: &str, marketplace: &str) -> bool {
    key.strip_suffix(marketplace)
        .and_then(|rest| rest.strip_suffix('@'))
        .is_some_and(|name| !name.is_empty() && !name.contains('@'))
}

/// Whether `key` (of `[hooks.state]`) is a hook of a plugin of
/// `marketplace`: `<name>@<marketplace>:<file>:<event>:<group>:<handler>`.
fn is_market_hook(key: &str, marketplace: &str) -> bool {
    key.split_once(':')
        .is_some_and(|(plugin, rest)| !rest.is_empty() && is_market_plugin(plugin, marketplace))
}

/// config.toml without the marketplace's plugin entries: what a plugin
/// commit must leave as it is. Tables those entries alone made are dropped
/// with them; a file that is not there has nothing outside them.
fn outside_plugin_tables(
    bytes: Option<&[u8]>,
    marketplace: &str,
) -> Result<String, PluginCommitError> {
    let Some(bytes) = bytes else {
        return Ok(String::new());
    };
    let text = std::str::from_utf8(bytes).map_err(|e| PluginCommitError::Invalid(e.to_string()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut table: toml::Table = text
        .parse()
        .map_err(|e: toml::de::Error| PluginCommitError::Invalid(e.to_string()))?;
    let plugins_emptied = match table.get_mut("plugins") {
        Some(toml::Value::Table(plugins)) => {
            plugins.retain(|key, _| !is_market_plugin(key, marketplace));
            plugins.is_empty()
        }
        _ => false,
    };
    if plugins_emptied {
        table.remove("plugins");
    }
    let hooks_emptied = match table.get_mut("hooks") {
        Some(toml::Value::Table(hooks)) => {
            let state_emptied = match hooks.get_mut("state") {
                Some(toml::Value::Table(state)) => {
                    state.retain(|key, _| !is_market_hook(key, marketplace));
                    state.is_empty()
                }
                _ => false,
            };
            if state_emptied {
                hooks.remove("state");
            }
            hooks.is_empty()
        }
        _ => false,
    };
    if hooks_emptied {
        table.remove("hooks");
    }
    // Compared as text: equal tables print alike.
    toml::to_string(&table).map_err(|e| PluginCommitError::Invalid(e.to_string()))
}

impl LockedHome {
    /// Publish a change to `marketplace`'s plugin entries. `expected` is the
    /// file the change was computed from, read with
    /// [`Self::read_config_bytes`] under this same lock.
    pub fn commit_plugin_tables(
        &self,
        marketplace: &str,
        expected: Option<&[u8]>,
        updated: &[u8],
    ) -> Result<(), PluginCommitError> {
        let path = self.guard().home().join(CONFIG_REL);
        let current = fsio::read_bytes(&path)
            .map_err(|e| PluginCommitError::Io(format!("read {}: {e}", path.display())))?;
        if current.as_deref() != expected {
            return Err(PluginCommitError::Changed);
        }
        if outside_plugin_tables(current.as_deref(), marketplace)?
            != outside_plugin_tables(Some(updated), marketplace)?
        {
            return Err(PluginCommitError::Outside);
        }
        fsio::write_atomic(&path, updated)
            .map_err(|e| PluginCommitError::Io(format!("write {}: {e}", path.display())))
    }
}

#[cfg(test)]
mod tests {
    use super::super::lock_home;
    use super::*;

    const MARKET: &str = "codeg-harness";
    const CONFIG: &str = "# mine\nmodel = \"gpt-5.5\"\n\n[plugins.\"theirs@elsewhere\"]\nenabled = true\n\n[plugins.\"sp@codeg-harness\"]\nenabled = true\n\n[hooks.state.\"theirs@elsewhere:hooks/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:1\"\n";

    #[test]
    fn whose_entries_these_are() {
        assert!(is_market_plugin("sp@codeg-harness", MARKET));
        assert!(!is_market_plugin("sp@codeg-harness-2", MARKET));
        assert!(!is_market_plugin("@codeg-harness", MARKET));
        assert!(!is_market_plugin("a@b@codeg-harness", MARKET));
        assert!(is_market_hook(
            "sp@codeg-harness:hooks/hooks.json:session_start:0:0",
            MARKET
        ));
        assert!(!is_market_hook("sp@codeg-harness", MARKET));
        assert!(!is_market_hook("sp@other:hooks/hooks.json:x:0:0", MARKET));
    }

    #[tokio::test]
    async fn only_the_marketplace_s_entries_may_change() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();
        std::fs::write(home.join(CONFIG_REL), CONFIG).unwrap();
        let locked = lock_home(home).await.unwrap();
        let on_disk = locked.read_config_bytes().unwrap();

        for touched in [
            CONFIG.replace("gpt-5.5", "gpt-6"),
            CONFIG.replace(
                "[plugins.\"theirs@elsewhere\"]\nenabled = true",
                "[plugins.\"theirs@elsewhere\"]\nenabled = false",
            ),
            CONFIG.replace("trusted_hash = \"sha256:1\"\n", ""),
        ] {
            assert_eq!(
                locked.commit_plugin_tables(MARKET, on_disk.as_deref(), touched.as_bytes()),
                Err(PluginCommitError::Outside),
                "{touched}"
            );
        }
        assert!(matches!(
            locked.commit_plugin_tables(MARKET, on_disk.as_deref(), b"model = "),
            Err(PluginCommitError::Invalid(_))
        ));

        // Its own switch, and its hooks' trust: in, then out with the tables
        // they alone made.
        let mut updated = CONFIG.replace(
            "[plugins.\"sp@codeg-harness\"]\nenabled = true",
            "[plugins.\"sp@codeg-harness\"]\nenabled = false",
        );
        updated.push_str("\n[hooks.state.\"sp@codeg-harness:hooks/hooks.json:stop:0:0\"]\ntrusted_hash = \"sha256:2\"\n");
        locked
            .commit_plugin_tables(MARKET, on_disk.as_deref(), updated.as_bytes())
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(home.join(CONFIG_REL)).unwrap(),
            updated
        );
        // Changed under it since it was read: left alone.
        assert_eq!(
            locked.commit_plugin_tables(MARKET, on_disk.as_deref(), CONFIG.as_bytes()),
            Err(PluginCommitError::Changed)
        );
        let lone = "[plugins.\"sp@codeg-harness\"]\nenabled = true\n";
        std::fs::write(home.join(CONFIG_REL), lone).unwrap();
        locked
            .commit_plugin_tables(MARKET, Some(lone.as_bytes()), b"")
            .unwrap();
        assert_eq!(std::fs::read(home.join(CONFIG_REL)).unwrap(), b"");
    }
}
