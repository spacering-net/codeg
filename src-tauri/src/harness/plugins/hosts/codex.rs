//! Codex: the plugin store is a local marketplace of Codeg's in Codex's own
//! format (docs/harness-plugins.md §7 and §14 on the website).
//!
//! ```text
//! <root>/.agents/plugins/marketplace.json
//!   { "name": "codeg-harness",
//!     "plugins": [{ "name": "superpowers",
//!                   "source": { "source": "local", "path": "./superpowers/4" } }] }
//! ```
//!
//! It lists only the plugins installed natively for Codex. An entry's name
//! is the one in the plugin's own Codex manifest (`.codex-plugin/plugin.json`
//! unless the install info names another) — the name Codex knows it by,
//! `<name>@codeg-harness`. Unlike Claude Code, Codex loads a plugin from a
//! copy of its own, `$CODEX_HOME/plugins/cache/codeg-harness/<name>/<version>/`
//! (`<version>` from the manifest; `local` without one).
//!
//! **Which Codex.** Codeg's sessions run the codex-acp wrapper, which runs
//! the `@openai/codex` it bundles (P3 step 0), so the commands go through it
//! — `codex-acp cli plugin …`, the wrapper resolved the way a session's
//! launch resolves it — and its version is that codex package's, read from
//! disk (`codex-acp cli --version` prints the wrapper's own). When the
//! agent's `CODEX_PATH` names another codex for the wrapper to run, or the
//! package cannot be found, the version is asked: `codex-acp cli -V`.
//! Without the wrapper, the user's own `codex` (`--version`). A plugin
//! installed by either loads in the other's sessions.
//!
//! **Commands and files** (P3 step 5, measured with codex 0.166.0 and
//! 0.149.1; every one safe to repeat):
//! - install = `plugin marketplace add <root>` (exit 0 when it is already
//!   added from there; 1 when a marketplace of that name is added from
//!   elsewhere, which is checked first) + `plugin add <name>@codeg-harness`
//!   (exit 0 again and again; it copies the revision into the cache and
//!   switches the plugin on).
//! - update = repoint the entry + `plugin add` again: the same manifest
//!   version is copied over, a new one gets a folder of its own and the old
//!   folder is deleted (0.166 deletes it itself). `plugin add` switches the
//!   plugin on, so one that was off is switched off again.
//! - disable/enable = `[plugins."<name>@codeg-harness"] enabled = false|true`
//!   in `config.toml` (Codex has no command for it; a table without
//!   `enabled` is on).
//! - uninstall = `plugin remove` (exit 0 also when it is not there) + the
//!   cache folder + the trust Codex keeps for its hooks (`[hooks.state."<name>
//!   @codeg-harness:…"]`, which `remove` leaves); when no plugin of Codeg's is
//!   left for Codex, `plugin marketplace remove codeg-harness` (exit 1 when
//!   it is not there) and `plugins/cache/codeg-harness/`. The marketplace
//!   entry goes last, so a retry still knows the plugin.
//!
//! Everything that writes `config.toml` — the commands and Codeg's own edits
//! — runs under the Codex home lock (`acp::codex_catalog_commit`), taken
//! inside the plugins lock and never around the MCP lock. Codeg's edits go
//! through [`LockedHome::commit_plugin_tables`], which refuses anything
//! outside the marketplace's plugin entries. `$CODEX_HOME` is the agent's,
//! else `.codex` in the home it sees.
//!
//! **Hook trust.** Codex runs a plugin's hook only once the user trusted it
//! in Codex, and again only after a change is trusted. Codeg never trusts a
//! hook for the user; [`CodexAdapter::hook_trust`] reads the state by asking
//! the same codex's `app-server` (`hooks/list`), started with the agent's
//! environment, for a limited time, and always stopped with everything it
//! started. When it cannot be asked, every hook the package has is
//! `Unknown`.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde_json::{json, Value};
use toml_edit::{Document, Item, TableLike};

use crate::acp::codex_catalog_commit::{self, LockedHome};
use crate::acp::codex_runtime;
use crate::commands::mcp_engine::fsio;
use crate::harness::mcp::model::Reason;
use crate::harness::skills::package::safe_path;
use crate::models::agent::AgentType;
use crate::skills::fsio::{remove_if_empty, write_private_atomic};

use super::super::switches::AdapterSwitches;
pub use super::shared::MARKETPLACE;
use super::shared::{
    cli_of, command_cwd, env_dir, files_error, manifest_name, plugin_key, read_manifest,
    relative_source, remove_path, revision_dir, root_arg, same_dir, source_text, system_programs,
    Layout, Marketplace, MANIFEST_BYTES,
};
use super::{
    codes, failure, printed_version, trimmed, Answered, CliVia, Detect, Exchange, HookStatus,
    HookTrust, HookTrustState, HostAdapter, HostCli, HostCx, HostEnv, HostId, HostPlugin,
    HostRunner, HostVerify, ProcessRunner, RunError, COMMAND_TIMEOUT,
};

const LAYOUT: Layout = Layout::Codex;
/// Where a plugin keeps its Codex manifest when the install info names
/// none.
const DEFAULT_MANIFEST: &str = ".codex-plugin/plugin.json";
/// The hooks file Codex reads when the manifest names none.
const DEFAULT_HOOKS: &str = "hooks/hooks.json";
/// How Codex keys the hooks a manifest holds itself (`[<index>]` follows).
const INLINE_HOOKS: &str = "plugin.json#hooks";
/// In the store: one empty file per plugin (by its Codex name) that is to
/// stay off through an update — `plugin add` switches it on, and an update
/// cut short there must still know it was off.
const OFF_DIR: &str = ".codex-off";
/// The cache folder of a plugin whose manifest has no version.
const UNVERSIONED: &str = "local";
const HOME_VAR: &str = "CODEX_HOME";
/// Set, it names the codex the wrapper runs instead of its bundled one.
const PATH_VAR: &str = "CODEX_PATH";
const CONFIG_FILE: &str = "config.toml";
/// How long the app-server may take to say what it trusts.
pub const TRUST_TIMEOUT: Duration = Duration::from_secs(30);
/// The `hooks/list` request's id.
const HOOKS_LIST_ID: u64 = 2;

/// Where the wrapper and the native CLI are found.
#[derive(Debug, Clone)]
enum Locate {
    /// As a session's launch finds them.
    System,
    #[cfg(all(test, unix))]
    Fixed {
        wrapper: Option<PathBuf>,
        native: Option<PathBuf>,
    },
}

pub struct CodexAdapter {
    runner: Arc<dyn HostRunner>,
    locate: Locate,
    timeout: Duration,
    trust_timeout: Duration,
}

impl Default for CodexAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(ProcessRunner),
            locate: Locate::System,
            timeout: COMMAND_TIMEOUT,
            trust_timeout: TRUST_TIMEOUT,
        }
    }

    /// With `runner` and these programs: for tests.
    #[cfg(all(test, unix))]
    pub(crate) fn sandboxed(
        runner: Arc<dyn HostRunner>,
        wrapper: Option<PathBuf>,
        native: Option<PathBuf>,
    ) -> Self {
        Self {
            runner,
            locate: Locate::Fixed { wrapper, native },
            timeout: Duration::from_secs(20),
            trust_timeout: Duration::from_secs(20),
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) fn with_timeouts(mut self, command: Duration, trust: Duration) -> Self {
        self.timeout = command;
        self.trust_timeout = trust;
        self
    }

    /// The wrapper Codeg's sessions run, and the user's own `codex`.
    async fn programs(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        match &self.locate {
            Locate::System => system_programs(AgentType::Codex).await,
            #[cfg(all(test, unix))]
            Locate::Fixed { wrapper, native } => (wrapper.clone(), native.clone()),
        }
    }

    /// The version of the codex `cli` runs.
    async fn version_of(&self, cli: &HostCli, env: &HostEnv) -> Result<Version, String> {
        if cli.via == CliVia::Wrapper && env.var(PATH_VAR).is_none() {
            let wrapper = cli.program.clone();
            if let Ok(Some(version)) = tokio::task::spawn_blocking(move || {
                codex_runtime::bundled_codex_version(&wrapper)
                    .and_then(|version| Version::parse(version.trim()).ok())
            })
            .await
            {
                return Ok(version);
            }
        }
        // `--version` anywhere makes the wrapper print its own version; `-V`
        // goes through to the codex it runs.
        let flag = match cli.via {
            CliVia::Wrapper => "-V",
            CliVia::Native => "--version",
        };
        // Any folder that is there: nothing is resolved against it.
        let cwd = if env.home.is_dir() {
            env.home.clone()
        } else {
            std::env::temp_dir()
        };
        let outcome = self
            .runner
            .run(&cli.program, &cli.args(&[flag]), env, &cwd, self.timeout)
            .await;
        if let Some(reason) = failure(flag, self.timeout, &outcome) {
            return Err(reason.detail.unwrap_or(reason.code));
        }
        outcome
            .ok()
            .as_ref()
            .and_then(printed_version)
            .ok_or_else(|| format!("{flag} printed no version"))
    }

    /// One command, its failure as a reason. Run from the store's folder.
    async fn run(
        &self,
        cx: &HostCx<'_>,
        cli: &HostCli,
        command: &str,
        args: &[&str],
    ) -> Result<(), Reason> {
        let cwd = command_cwd(cx)?;
        let outcome = self
            .runner
            .run(&cli.program, &cli.args(args), cx.env, &cwd, self.timeout)
            .await;
        match failure(command, self.timeout, &outcome) {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    async fn set_enabled(
        &self,
        cx: &HostCx<'_>,
        plugin: &HostPlugin<'_>,
        on: bool,
    ) -> Result<(), Reason> {
        codex_home(cx)?;
        let market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        let name = market
            .own_name(plugin)
            .ok_or_else(|| Reason::new(codes::MARKETPLACE_ENTRY_MISSING))?;
        let key = plugin_key(&name);
        let home = lock_home(cx).await?;
        let mut config = Config::read_locked(&home)?;
        config.ours(&cx.ctx.root)?;
        match config.enabled(&key) {
            None => return Err(Reason::new(codes::NOT_INSTALLED).param("name", name)),
            Some(now) if now == on => {}
            Some(_) => {
                config.set_enabled(&key, on);
                config.commit(&home)?;
            }
        }
        // Said in so many words: what an update cut short left is moot.
        clear_off(cx, &name)
    }
}

#[async_trait::async_trait]
impl HostAdapter for CodexAdapter {
    fn host(&self) -> HostId {
        HostId::Codex
    }

    async fn detect(&self, env: &HostEnv, switches: &AdapterSwitches) -> Detect {
        let (wrapper, native) = self.programs().await;
        let cli = match (wrapper, native) {
            (Some(program), _) => Some(HostCli {
                program,
                prefix: vec!["cli".to_string()],
                via: CliVia::Wrapper,
            }),
            (None, Some(program)) => Some(HostCli {
                program,
                prefix: Vec::new(),
                via: CliVia::Native,
            }),
            (None, None) => None,
        };
        let version = match &cli {
            Some(cli) => self.version_of(cli, env).await,
            None => Err("not installed".to_string()),
        };
        let mut detect = Detect::judge(HostId::Codex, cli, version, switches);
        if let (true, Err(reason)) = (detect.supported, codex_home_of(env)) {
            detect.supported = false;
            detect.why_not = Some(reason);
        }
        detect
    }

    async fn install(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<String, Reason> {
        let cli = cli_of(cx)?;
        let root = root_arg(cx)?;
        revision_dir(cx, plugin)?;
        let name = manifest_name(cx, plugin, DEFAULT_MANIFEST);
        let mut market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        market.claim(plugin, &name)?;
        // Codex replaces `<cache>/<name>` through whatever is there.
        plain_dir_under(&cache_root(cx)?, &[&name])?;
        let home = lock_home(cx).await?;
        // A marketplace of Codeg's name from another folder is not Codeg's:
        // refused before the entry that would make this plugin its own.
        Config::read_locked(&home)?.ours(&cx.ctx.root)?;
        market.save(&cx.ctx.root)?;
        self.run(
            cx,
            cli,
            "plugin marketplace add",
            &["plugin", "marketplace", "add", root],
        )
        .await?;
        self.run(
            cx,
            cli,
            "plugin add",
            &["plugin", "add", &plugin_key(&name)],
        )
        .await?;
        Ok(name)
    }

    async fn update(
        &self,
        cx: &HostCx<'_>,
        from: &HostPlugin<'_>,
        to: &HostPlugin<'_>,
    ) -> Result<(), Reason> {
        let cli = cli_of(cx)?;
        revision_dir(cx, to)?;
        let mut market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        let current = market
            .own_name(from)
            .unwrap_or_else(|| manifest_name(cx, from, DEFAULT_MANIFEST));
        let name = manifest_name(cx, to, DEFAULT_MANIFEST);
        if name != current {
            return Err(Reason::new(codes::NAME_CHANGED)
                .param("from", current)
                .param("to", name));
        }
        let old_version = cache_version(cx, from);
        let new_version = cache_version(cx, to);
        market.claim(to, &name)?;
        let cache = cache_root(cx)?;
        plain_dir_under(&cache, &[&name])?;
        let key = plugin_key(&name);
        let home = lock_home(cx).await?;
        let config = Config::read_locked(&home)?;
        config.ours(&cx.ctx.root)?;
        market.save(&cx.ctx.root)?;
        // `plugin add` switches it on: one that is off is marked first, so
        // that a retry of an update cut short still turns it off again.
        let off = config.enabled(&key) == Some(false) || is_off(cx, &name)?;
        if off {
            mark_off(cx, &name)?;
        }
        self.run(cx, cli, "plugin add", &["plugin", "add", &key])
            .await?;
        if off {
            let mut config = Config::read_locked(&home)?;
            if config.enabled(&key) == Some(true) {
                config.set_enabled(&key, false);
                config.commit(&home)?;
            }
            clear_off(cx, &name)?;
        }
        if let (Some(old), Some(new)) = (old_version, new_version) {
            // Versions that differ in case alone are one folder where names
            // are case-blind.
            if !old.eq_ignore_ascii_case(&new) {
                // Checked again: the command has run since.
                if let Some(versions) = plain_dir_under(&cache_root(cx)?, &[&name])? {
                    remove_path(&versions.join(old))?;
                }
            }
        }
        Ok(())
    }

    async fn enable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.set_enabled(cx, plugin, true).await
    }

    async fn disable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.set_enabled(cx, plugin, false).await
    }

    async fn uninstall(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        let cli = cli_of(cx)?;
        let mut market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        // Nothing in Codex is provably this plugin's (its install was
        // refused before it got an entry): nothing to take out.
        let Some(name) = market.own_name(plugin) else {
            return Ok(());
        };
        let key = plugin_key(&name);
        let cache = cache_root(cx)?;
        let home = lock_home(cx).await?;
        // Codex has a marketplace of Codeg's name from another folder:
        // nothing of that name in Codex is this plugin's. Only the entry
        // goes.
        if Config::read_locked(&home)?.ours(&cx.ctx.root).is_err() {
            market.drop_plugin(plugin.name);
            clear_off(cx, &name)?;
            return if market.is_empty() {
                Marketplace::remove(LAYOUT, &cx.ctx.root)
            } else {
                market.save(&cx.ctx.root)
            };
        }
        match self
            .run(cx, cli, "plugin remove", &["plugin", "remove", &key])
            .await
        {
            // Not installed (any more): nothing to take out.
            Err(reason)
                if reason.code == codes::COMMAND_FAILED
                    && Config::read_locked(&home)?.enabled(&key).is_none() => {}
            outcome => outcome?,
        }
        if plain_dir_under(&cache_root(cx)?, &[])?.is_some() {
            remove_path(&cache.join(&name))?;
        }
        clear_off(cx, &name)?;
        // What `plugin remove` leaves: the hooks' trust (and the switch,
        // should an older codex leave that too).
        let mut config = Config::read_locked(&home)?;
        if config.forget(&key) {
            config.commit(&home)?;
        }
        market.drop_plugin(plugin.name);
        // The last of Codeg's plugins in Codex: by the marketplace file, and
        // by Codex's own config (the file may have been lost).
        let last = market.is_empty() && !config.has_other_plugins(&key);
        if !last {
            return market.save(&cx.ctx.root);
        }
        // The file keeps the plugin's entry until everything else is done:
        // a retry still knows what is its.
        match self
            .run(
                cx,
                cli,
                "plugin marketplace remove",
                &["plugin", "marketplace", "remove", MARKETPLACE],
            )
            .await
        {
            Err(reason)
                if reason.code == codes::COMMAND_FAILED
                    && Config::read_locked(&home)?
                        .marketplace(&cx.ctx.root)
                        .is_none() => {}
            outcome => outcome?,
        }
        // `cache` itself may be a link; never what is under it.
        cache_root(cx)?;
        remove_path(&cache)?;
        remove_if_empty(&cx.ctx.root.join(OFF_DIR));
        Marketplace::remove(LAYOUT, &cx.ctx.root)
    }

    async fn verify(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> HostVerify {
        let mut verify = HostVerify::default();
        if let Err(reason) = revision_dir(cx, plugin) {
            verify.problems.push(reason);
        }
        let name = match Marketplace::load(LAYOUT, &cx.ctx.root) {
            Ok(market) => match market.entry_of(plugin.name) {
                Some(entry) => {
                    let expected = relative_source(plugin);
                    if market.entry_path(entry).as_deref() != Some(expected.as_str()) {
                        verify.problems.push(
                            Reason::new(codes::MARKETPLACE_SOURCE_MISMATCH)
                                .param("expected", expected)
                                .param("found", source_text(&entry.source)),
                        );
                    }
                    entry.name.clone()
                }
                None => {
                    verify
                        .problems
                        .push(Reason::new(codes::MARKETPLACE_ENTRY_MISSING));
                    manifest_name(cx, plugin, DEFAULT_MANIFEST)
                }
            },
            Err(reason) => {
                verify.problems.push(reason);
                manifest_name(cx, plugin, DEFAULT_MANIFEST)
            }
        };
        let key = plugin_key(&name);
        let config = match codex_home(cx).and_then(|home| Config::read(&home)) {
            Ok(config) => config,
            Err(reason) => {
                verify.problems.push(reason);
                return verify;
            }
        };
        match config.marketplace(&cx.ctx.root) {
            None => verify
                .problems
                .push(Reason::new(codes::MARKETPLACE_NOT_ADDED)),
            Some(MarketSource::Elsewhere(path)) => verify
                .problems
                .push(Reason::new(codes::MARKETPLACE_ELSEWHERE).param("path", path)),
            Some(MarketSource::Here) => {}
        }
        verify.enabled = config.enabled(&key);
        if verify.enabled.is_none() {
            verify
                .problems
                .push(Reason::new(codes::NOT_INSTALLED).param("name", name.clone()));
        }
        let version = cache_version(cx, plugin);
        let cached = cache_root(cx)
            .and_then(|cache| plain_dir_under(&cache, &[&name]))
            .ok()
            .flatten();
        let present = match (&cached, &version) {
            (None, _) => false,
            (Some(cached), Some(version)) => {
                std::fs::symlink_metadata(cached.join(version)).is_ok_and(|meta| meta.is_dir())
            }
            // Which folder it would be is not known: any.
            (Some(cached), None) => {
                std::fs::read_dir(cached).is_ok_and(|mut dir| dir.next().is_some())
            }
        };
        if !present {
            verify.problems.push(
                Reason::new(codes::CACHE_MISSING).param("version", version.unwrap_or_default()),
            );
        }
        verify
    }

    async fn hook_trust(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Option<HookTrust> {
        Some(CodexAdapter::hook_trust(self, cx, plugin).await)
    }
}

impl CodexAdapter {
    /// What Codex's trust says of the plugin's hooks: those Codex lists for
    /// it, then those its package has that Codex did not list (`Unknown` —
    /// a plugin that is off has none listed). Read-only; never trusts.
    pub async fn hook_trust(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> HookTrust {
        let name = Marketplace::load(LAYOUT, &cx.ctx.root)
            .ok()
            .and_then(|market| market.own_name(plugin))
            .unwrap_or_else(|| manifest_name(cx, plugin, DEFAULT_MANIFEST));
        let key = plugin_key(&name);
        let package = package_hooks(cx, plugin, &key);
        let listed = match self.ask_hooks(cx, &key).await {
            Ok(listed) => listed,
            Err(problem) => {
                return HookTrust {
                    hooks: package
                        .into_iter()
                        .map(|(key, event)| HookStatus {
                            key,
                            event,
                            state: HookTrustState::Unknown,
                        })
                        .collect(),
                    problem: Some(problem),
                }
            }
        };
        let mut hooks: Vec<HookStatus> = Vec::new();
        for (key, state) in listed {
            if hooks.iter().any(|hook| hook.key == key) {
                continue;
            }
            hooks.push(HookStatus {
                event: event_of(&key),
                key,
                state,
            });
        }
        for (key, event) in package {
            if !hooks.iter().any(|hook| hook.key == key) {
                hooks.push(HookStatus {
                    key,
                    event,
                    state: HookTrustState::Unknown,
                });
            }
        }
        HookTrust {
            hooks,
            problem: None,
        }
    }

    /// The hooks of `key` Codex lists, in its order, with their state:
    /// `initialize`, then `hooks/list` for the store's folder, from the
    /// codex the sessions run.
    async fn ask_hooks(
        &self,
        cx: &HostCx<'_>,
        key: &str,
    ) -> Result<Vec<(String, HookTrustState)>, Reason> {
        let cli = cli_of(cx)?;
        codex_home(cx)?;
        let cwd = command_cwd(cx)?;
        let mut input = String::new();
        for message in [
            json!({ "id": 1, "method": "initialize", "params": {
                "clientInfo": { "name": "codeg", "title": "Codeg", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": null,
            } }),
            json!({ "method": "initialized" }),
            json!({ "id": HOOKS_LIST_ID, "method": "hooks/list", "params": {
                "cwds": [cwd.to_string_lossy()],
            } }),
        ] {
            input.push_str(&message.to_string());
            input.push('\n');
        }
        let answered: &Answered = &|output: &[u8]| answer(output, HOOKS_LIST_ID).is_some();
        let outcome = self
            .runner
            .converse(
                &cli.program,
                &cli.args(&["app-server"]),
                cx.env,
                &cwd,
                self.trust_timeout,
                Exchange {
                    input: input.as_bytes(),
                    answered,
                },
            )
            .await;
        let output = match outcome {
            Ok(output) => output,
            Err(RunError::TimedOut) => {
                return Err(Reason::new(codes::COMMAND_TIMED_OUT)
                    .param("command", "app-server")
                    .param("seconds", self.trust_timeout.as_secs().to_string()))
            }
            Err(RunError::NotStarted(why)) => {
                return Err(Reason::new(codes::COMMAND_NOT_STARTED)
                    .param("command", "app-server")
                    .detail(why))
            }
        };
        let unreadable = |why: String| Reason::new(codes::HOOKS_UNREADABLE).detail(why);
        let Some(message) = answer(&output, HOOKS_LIST_ID) else {
            return Err(unreadable(format!(
                "no answer to hooks/list: {}",
                trimmed(&output)
            )));
        };
        if let Some(error) = message.get("error") {
            return Err(unreadable(
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| error.to_string()),
            ));
        }
        let Some(data) = message
            .get("result")
            .and_then(|result| result.get("data"))
            .and_then(Value::as_array)
        else {
            return Err(unreadable("hooks/list answered without data".to_string()));
        };
        let prefix = format!("{key}:");
        let mut listed = Vec::new();
        for hook in data
            .iter()
            .filter_map(|entry| entry.get("hooks")?.as_array())
            .flatten()
        {
            let Some(hook_key) = hook.get("key").and_then(Value::as_str) else {
                continue;
            };
            let plugin_id = hook.get("pluginId").and_then(Value::as_str);
            if plugin_id != Some(key) || !hook_key.starts_with(&prefix) {
                continue;
            }
            let state = match hook.get("trustStatus").and_then(Value::as_str) {
                Some("trusted") => HookTrustState::Trusted,
                Some("untrusted") => HookTrustState::Untrusted,
                Some("modified") => HookTrustState::Modified,
                _ => HookTrustState::Unknown,
            };
            listed.push((hook_key.to_string(), state));
        }
        Ok(listed)
    }

    /// The hooks the plugin's package gives Codex, keyed as Codex keys them
    /// (`<key>:<file>:<event>:<group>:<handler>`), read from its revision
    /// folder — whatever Codex itself makes of them. Hooks > 0 is what makes
    /// a plugin need the user's trust in Codex.
    pub fn package_hooks(cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Vec<(String, String)> {
        let name = Marketplace::load(LAYOUT, &cx.ctx.root)
            .ok()
            .and_then(|market| market.own_name(plugin))
            .unwrap_or_else(|| manifest_name(cx, plugin, DEFAULT_MANIFEST));
        package_hooks(cx, plugin, &plugin_key(&name))
    }
}

/// The Codex home the agent's sessions use: its `CODEX_HOME`, else `.codex`
/// in the home they see. A relative `CODEX_HOME` is refused: a session
/// takes it from the project it runs in, so no one folder is the home.
fn codex_home_of(env: &HostEnv) -> Result<PathBuf, Reason> {
    Ok(env_dir(env, HOME_VAR)?.unwrap_or_else(|| env.child_home().join(".codex")))
}

fn codex_home(cx: &HostCx<'_>) -> Result<PathBuf, Reason> {
    codex_home_of(cx.env)
}

/// `$CODEX_HOME/plugins/cache/codeg-harness`, when every folder of it under
/// the home that is there is a plain one: a link would take what is
/// removed there out of Codeg's marketplace.
fn cache_root(cx: &HostCx<'_>) -> Result<PathBuf, Reason> {
    let home = codex_home(cx)?;
    plain_dir_under(&home, &["plugins", "cache", MARKETPLACE])?;
    Ok(home.join("plugins").join("cache").join(MARKETPLACE))
}

/// `base` joined with `names`, checked one folder at a time (`base`
/// itself when there are none): `Ok(None)` when one is not there, an error
/// when one is not a plain folder (a link).
fn plain_dir_under(base: &Path, names: &[&str]) -> Result<Option<PathBuf>, Reason> {
    let mut dir = base.to_path_buf();
    let mut steps = vec![dir.clone()];
    if !names.is_empty() {
        steps.clear();
        for name in names {
            dir = dir.join(name);
            steps.push(dir.clone());
        }
    }
    for step in &steps {
        match std::fs::symlink_metadata(step) {
            Ok(meta) if meta.is_dir() => {}
            Ok(_) => return Err(files_error(step, "not a plain folder")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(files_error(step, error)),
        }
    }
    Ok(Some(dir))
}

/// The marker's file name: the plugin's Codex name and the Codex home it is
/// off in (each home has the plugin in a state of its own).
fn off_marker(cx: &HostCx<'_>, name: &str) -> Result<String, Reason> {
    let home = codex_home(cx)?;
    let home = codex_catalog_commit::lock::normalize_home(&home);
    let id = fsio::sha256_hex(&path_bytes(&home));
    Ok(format!("{name}@{}", &id[..16]))
}

/// A path's own bytes (no lossy text: two homes never share a marker).
fn path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect()
    }
}

/// Whether the plugin is marked to stay off through an update in this
/// Codex home.
fn is_off(cx: &HostCx<'_>, name: &str) -> Result<bool, Reason> {
    let marker = cx.ctx.root.join(OFF_DIR).join(off_marker(cx, name)?);
    Ok(std::fs::symlink_metadata(marker).is_ok_and(|meta| meta.is_file()))
}

fn mark_off(cx: &HostCx<'_>, name: &str) -> Result<(), Reason> {
    let dir = cx.ctx.root.join(OFF_DIR);
    if plain_dir_under(&cx.ctx.root, &[OFF_DIR])?.is_none() {
        std::fs::create_dir_all(&dir).map_err(|error| files_error(&dir, error))?;
    }
    let path = dir.join(off_marker(cx, name)?);
    if std::fs::symlink_metadata(&path).is_ok_and(|meta| !meta.is_file()) {
        return Err(files_error(&path, "not a plain file"));
    }
    write_private_atomic(&path, b"").map_err(|error| files_error(&path, error))
}

fn clear_off(cx: &HostCx<'_>, name: &str) -> Result<(), Reason> {
    let Some(dir) = plain_dir_under(&cx.ctx.root, &[OFF_DIR])? else {
        return Ok(());
    };
    remove_path(&dir.join(off_marker(cx, name)?))?;
    remove_if_empty(&dir);
    Ok(())
}

/// The Codex home lock (with any interrupted catalog commit there finished
/// or undone), for everything that writes `config.toml`.
async fn lock_home(cx: &HostCx<'_>) -> Result<LockedHome, Reason> {
    codex_catalog_commit::lock_home(&codex_home(cx)?)
        .await
        .map_err(|error| {
            let code = match error.code {
                "io" => "io_error",
                code => code,
            };
            Reason::new(code).detail(error.message)
        })
}

/// The cache folder Codex keeps the revision's copy under: its manifest's
/// version, `local` without one; `None` when that cannot be told (no
/// manifest, or a version Codex refuses).
fn cache_version(cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Option<String> {
    let manifest = read_manifest(cx, plugin, DEFAULT_MANIFEST)?;
    match manifest.get("version") {
        None | Some(Value::Null) => Some(UNVERSIONED.to_string()),
        Some(Value::String(version)) => {
            let plain = !version.is_empty()
                && version != "."
                && version != ".."
                && version
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'+' | b'_' | b'-'));
            plain.then(|| version.clone())
        }
        Some(_) => None,
    }
}

/// See [`CodexAdapter::package_hooks`]: `(key, event)`, the event as the key
/// has it.
fn package_hooks(cx: &HostCx<'_>, plugin: &HostPlugin<'_>, key: &str) -> Vec<(String, String)> {
    let dir = cx.ctx.revision_dir(plugin.name, plugin.revision);
    let manifest = plugin
        .manifest
        .filter(|path| !path.is_empty())
        .unwrap_or(DEFAULT_MANIFEST);
    // Read from the bytes, as Codex does: a key twice is an error there,
    // and would not be once read into a JSON value.
    let Some(manifest) = safe_path(manifest)
        .then(|| read_small_file(&dir.join(manifest)))
        .flatten()
        .and_then(|bytes| schema::manifest(&bytes))
    else {
        return Vec::new();
    };
    // A path Codex takes: `./` then a path inside the plugin.
    let path_of = |path: &str| -> Option<String> {
        let path = path.strip_prefix("./")?;
        safe_path(path).then(|| path.to_string())
    };
    // A file Codex cannot read as a hooks file gives none (it says so and
    // goes on).
    let read = |path: String| -> Option<(String, schema::HooksFile)> {
        let file = schema::file(&read_small_file(&dir.join(&path))?)?;
        Some((path, file))
    };
    let inline = |index: usize, file: schema::HooksFile| (format!("{INLINE_HOOKS}[{index}]"), file);
    // As codex 0.166 resolves `hooks`; when it resolves to nothing, it
    // reads the usual file.
    let declared: Option<Vec<(String, schema::HooksFile)>> = match manifest.hooks {
        Some(schema::Declared::Path(path)) => {
            path_of(&path).map(|path| read(path).into_iter().collect())
        }
        Some(schema::Declared::Paths(paths)) => {
            let paths: Vec<String> = paths.iter().filter_map(|path| path_of(path)).collect();
            (!paths.is_empty()).then(|| paths.into_iter().filter_map(read).collect())
        }
        Some(schema::Declared::Inline(file)) => Some(vec![inline(0, *file)]),
        Some(schema::Declared::InlineList(files)) => (!files.is_empty()).then(|| {
            files
                .into_iter()
                .enumerate()
                .map(|(index, file)| inline(index, file))
                .collect()
        }),
        Some(schema::Declared::Invalid(_)) | None => None,
    };
    let sources = declared.unwrap_or_else(|| {
        path_of(&format!("./{DEFAULT_HOOKS}"))
            .and_then(read)
            .into_iter()
            .collect()
    });
    let mut hooks = Vec::new();
    for (label, file) in sources {
        for (event, groups) in file.hooks.all() {
            let event = snake_case(event);
            for (group_index, group) in groups.iter().enumerate() {
                for handler_index in 0..group.hooks.len() {
                    hooks.push((
                        format!("{key}:{label}:{event}:{group_index}:{handler_index}"),
                        event.clone(),
                    ));
                }
            }
        }
    }
    hooks
}

/// A hooks file as codex 0.166 reads one (`codex_config::HooksFile` and
/// `codex_protocol::hooks`): the same fields, the same strictness, so that
/// what Codex refuses — and then does without, or falls back from — is
/// refused here too. Only what keys a hook is used.
#[allow(dead_code)]
mod schema {
    use serde::{Deserialize, Deserializer};
    use serde_json::{Map, Value};

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    pub(super) struct HooksFile {
        #[serde(default)]
        description: Option<String>,
        #[serde(default)]
        pub(super) hooks: Events,
    }

    /// Codex reads these events and no others.
    #[derive(Deserialize, Default)]
    pub(super) struct Events {
        #[serde(rename = "PreModelRequest", default)]
        pre_model_request: Vec<Group>,
        #[serde(rename = "PostModelRequest", default)]
        post_model_request: Vec<Group>,
        #[serde(rename = "PreToolUse", default)]
        pre_tool_use: Vec<Group>,
        #[serde(rename = "PermissionRequest", default)]
        permission_request: Vec<Group>,
        #[serde(rename = "PostToolUse", default)]
        post_tool_use: Vec<Group>,
        #[serde(rename = "PreCompact", default)]
        pre_compact: Vec<Group>,
        #[serde(rename = "PostCompact", default)]
        post_compact: Vec<Group>,
        #[serde(rename = "SessionStart", default)]
        session_start: Vec<Group>,
        #[serde(rename = "SessionEnd", default)]
        session_end: Vec<Group>,
        #[serde(rename = "UserPromptSubmit", default)]
        user_prompt_submit: Vec<Group>,
        #[serde(rename = "SubagentStart", default)]
        subagent_start: Vec<Group>,
        #[serde(rename = "SubagentStop", default)]
        subagent_stop: Vec<Group>,
        #[serde(rename = "Stop", default)]
        stop: Vec<Group>,
        #[serde(rename = "Interrupt", default)]
        interrupt: Vec<Group>,
    }

    impl Events {
        /// Every event with its groups, by the name the file gives it.
        pub(super) fn all(&self) -> [(&'static str, &[Group]); 14] {
            [
                ("PreModelRequest", &self.pre_model_request),
                ("PostModelRequest", &self.post_model_request),
                ("PreToolUse", &self.pre_tool_use),
                ("PermissionRequest", &self.permission_request),
                ("PostToolUse", &self.post_tool_use),
                ("PreCompact", &self.pre_compact),
                ("PostCompact", &self.post_compact),
                ("SessionStart", &self.session_start),
                ("SessionEnd", &self.session_end),
                ("UserPromptSubmit", &self.user_prompt_submit),
                ("SubagentStart", &self.subagent_start),
                ("SubagentStop", &self.subagent_stop),
                ("Stop", &self.stop),
                ("Interrupt", &self.interrupt),
            ]
        }
    }

    #[derive(Deserialize)]
    pub(super) struct Group {
        #[serde(default)]
        matcher: Option<String>,
        #[serde(default)]
        pub(super) hooks: Vec<Handler>,
    }

    #[derive(Deserialize)]
    #[serde(tag = "type")]
    pub(super) enum Handler {
        #[serde(rename = "command")]
        Command {
            command: String,
            #[serde(default, rename = "commandWindows", alias = "command_windows")]
            command_windows: Option<String>,
            #[serde(default, rename = "timeout")]
            timeout_sec: Option<u64>,
            #[serde(default)]
            r#async: bool,
            #[serde(default, rename = "statusMessage")]
            status_message: Option<String>,
            #[serde(default, rename = "additionalContextLimit")]
            additional_context_limit: Option<usize>,
        },
        #[serde(rename = "mcp_tool")]
        McpTool {
            server: String,
            tool: String,
            #[serde(default, deserialize_with = "tool_input")]
            input: Map<String, Value>,
            #[serde(default, rename = "timeout")]
            timeout_sec: Option<u64>,
            #[serde(default, rename = "statusMessage")]
            status_message: Option<String>,
        },
        #[serde(rename = "prompt")]
        Prompt {},
        #[serde(rename = "agent")]
        Agent {},
    }

    /// Codex refuses an input TOML cannot hold.
    fn tool_input<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Map<String, Value>, D::Error> {
        let input = Map::deserialize(deserializer)?;
        fn representable(value: &Value) -> bool {
            match value {
                Value::Null => false,
                Value::Number(n) => !n.is_u64() || n.as_i64().is_some(),
                Value::Array(items) => items.iter().all(representable),
                Value::Object(items) => items.values().all(representable),
                Value::Bool(_) | Value::String(_) => true,
            }
        }
        if !input.values().all(representable) {
            return Err(serde::de::Error::custom("not representable as TOML"));
        }
        Ok(input)
    }

    /// The part of a Codex manifest that says where its hooks are
    /// (`RawPluginManifest.hooks`).
    #[derive(Deserialize)]
    pub(super) struct Manifest {
        #[serde(default)]
        pub(super) hooks: Option<Declared>,
    }

    /// `RawPluginManifestHooks`, tried in this order.
    #[derive(Deserialize)]
    #[serde(untagged)]
    pub(super) enum Declared {
        Path(String),
        Paths(Vec<String>),
        Inline(Box<HooksFile>),
        InlineList(Vec<HooksFile>),
        Invalid(Value),
    }

    pub(super) fn manifest(bytes: &[u8]) -> Option<Manifest> {
        serde_json::from_slice(bytes).ok()
    }

    pub(super) fn file(bytes: &[u8]) -> Option<HooksFile> {
        serde_json::from_slice(bytes).ok()
    }
}

/// A plain file (not a link) of at most [`MANIFEST_BYTES`], as it is.
fn read_small_file(path: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MANIFEST_BYTES {
        return None;
    }
    std::fs::read(path).ok()
}

/// `SessionStart` → `session_start`, as Codex keys an event.
fn snake_case(event: &str) -> String {
    let mut out = String::with_capacity(event.len() + 4);
    let mut previous: Option<char> = None;
    for c in event.chars() {
        if c.is_ascii_uppercase()
            && previous.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            out.push('_');
        }
        out.push(c.to_ascii_lowercase());
        previous = Some(c);
    }
    out
}

/// The event a hook's key names (`…:<event>:<group>:<handler>`).
fn event_of(key: &str) -> String {
    let mut parts = key.rsplitn(4, ':');
    let (_, _, event) = (parts.next(), parts.next(), parts.next());
    event.unwrap_or_default().to_string()
}

/// The app-server's answer to request `id`, once a whole line of it is in
/// `output`.
fn answer(output: &[u8], id: u64) -> Option<Value> {
    output
        .split(|b| *b == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .find(|message| {
            message.get("id").and_then(Value::as_u64) == Some(id)
                && (message.get("result").is_some() || message.get("error").is_some())
        })
}

/// Where Codex has Codeg's marketplace from.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MarketSource {
    /// The store's folder.
    Here,
    /// Somewhere else; the path (empty when it is not a local folder).
    Elsewhere(String),
}

/// `config.toml`, read: as it was on disk, and as a document to edit
/// without losing its comments.
struct Config {
    bytes: Option<Vec<u8>>,
    bom: bool,
    doc: Document,
}

impl Config {
    /// Read, under the lock.
    fn read_locked(home: &LockedHome) -> Result<Self, Reason> {
        let path = home.config_path();
        let bytes = home
            .read_config_bytes()
            .map_err(|error| unreadable(&path, error))?;
        Self::parse(&path, bytes)
    }

    /// Read without the lock: for a look that changes nothing.
    fn read(home: &Path) -> Result<Self, Reason> {
        let path = home.join(CONFIG_FILE);
        let bytes = fsio::read_bytes(&path).map_err(|error| unreadable(&path, error))?;
        Self::parse(&path, bytes)
    }

    fn parse(path: &Path, bytes: Option<Vec<u8>>) -> Result<Self, Reason> {
        let text = match &bytes {
            None => "",
            Some(bytes) => std::str::from_utf8(bytes).map_err(|error| unreadable(path, error))?,
        };
        let (bom, body) = match text.strip_prefix('\u{feff}') {
            Some(rest) => (true, rest),
            None => (false, text),
        };
        let doc = body
            .parse::<Document>()
            .map_err(|error| unreadable(path, error))?;
        Ok(Self { bytes, bom, doc })
    }

    fn table(item: Option<&Item>) -> Option<&dyn TableLike> {
        item.and_then(Item::as_table_like)
    }

    /// `[marketplaces.codeg-harness]`: `None` when there is none.
    ///
    /// Codex matches marketplace names regardless of case, so every
    /// spelling of the name counts; only the exact one, from the store's
    /// folder, is Codeg's.
    fn marketplace(&self, root: &Path) -> Option<MarketSource> {
        let marketplaces = Self::table(self.doc.get("marketplaces"))?;
        let mut found = None;
        for (name, item) in marketplaces.iter() {
            if !name.eq_ignore_ascii_case(MARKETPLACE) {
                continue;
            }
            let table = Self::table(Some(item));
            let local = table
                .and_then(|table| table.get("source_type"))
                .and_then(Item::as_str)
                .is_none_or(|kind| kind == "local");
            let source = table
                .and_then(|table| table.get("source"))
                .and_then(Item::as_str);
            let here = match source {
                Some(path) if name == MARKETPLACE && local && same_dir(Path::new(path), root) => {
                    MarketSource::Here
                }
                Some(path) if local => MarketSource::Elsewhere(path.to_string()),
                _ => MarketSource::Elsewhere(String::new()),
            };
            match here {
                MarketSource::Here => {
                    found.get_or_insert(MarketSource::Here);
                }
                elsewhere => return Some(elsewhere),
            }
        }
        found
    }

    /// Refused when Codex has a marketplace of Codeg's name from another
    /// folder: nothing of that name in Codex is then Codeg's.
    fn ours(&self, root: &Path) -> Result<(), Reason> {
        match self.marketplace(root) {
            Some(MarketSource::Elsewhere(path)) => {
                Err(Reason::new(codes::MARKETPLACE_ELSEWHERE).param("path", path))
            }
            _ => Ok(()),
        }
    }

    /// Whether `[plugins."<key>"]` is on: `None` when there is no such
    /// table; one without `enabled` is on.
    fn enabled(&self, key: &str) -> Option<bool> {
        let table = Self::table(Self::table(self.doc.get("plugins"))?.get(key))?;
        Some(table.get("enabled").and_then(Item::as_bool).unwrap_or(true))
    }

    /// A plugin of Codeg's marketplace other than `key` is in `[plugins]`.
    fn has_other_plugins(&self, key: &str) -> bool {
        let suffix = format!("@{MARKETPLACE}");
        Self::table(self.doc.get("plugins")).is_some_and(|plugins| {
            plugins
                .iter()
                .any(|(name, _)| name != key && name.ends_with(&suffix))
        })
    }

    /// Set `[plugins."<key>"] enabled`, keeping what is around it. The table
    /// must be there.
    fn set_enabled(&mut self, key: &str, on: bool) {
        let Some(table) = self
            .doc
            .get_mut("plugins")
            .and_then(Item::as_table_like_mut)
            .and_then(|plugins| plugins.get_mut(key))
            .and_then(Item::as_table_like_mut)
        else {
            return;
        };
        match table.get_mut("enabled").and_then(Item::as_value_mut) {
            Some(value) => {
                let decor = value.decor().clone();
                *value = toml_edit::Value::from(on);
                *value.decor_mut() = decor;
            }
            None => {
                table.insert("enabled", toml_edit::value(on));
            }
        }
    }

    /// Take out what Codex keeps of `key` itself: its `[plugins]` entry and
    /// its hooks' trust (`[hooks.state."<key>:…"]`, both hashes), with the
    /// tables they alone made. Whether anything went.
    fn forget(&mut self, key: &str) -> bool {
        let mut changed = false;
        if let Some(plugins) = self
            .doc
            .get_mut("plugins")
            .and_then(Item::as_table_like_mut)
        {
            changed |= plugins.remove(key).is_some();
            if changed && plugins.is_empty() {
                self.doc.remove("plugins");
            }
        }
        let prefix = format!("{key}:");
        let mut emptied = false;
        if let Some(hooks) = self.doc.get_mut("hooks").and_then(Item::as_table_like_mut) {
            if let Some(state) = hooks.get_mut("state").and_then(Item::as_table_like_mut) {
                let mine: Vec<String> = state
                    .iter()
                    .map(|(name, _)| name.to_string())
                    .filter(|name| name.starts_with(&prefix))
                    .collect();
                for name in &mine {
                    state.remove(name);
                }
                if !mine.is_empty() {
                    changed = true;
                    if state.is_empty() {
                        hooks.remove("state");
                        emptied = hooks.is_empty();
                    }
                }
            }
        }
        if emptied {
            self.doc.remove("hooks");
        }
        changed
    }

    /// Write the edited document, if it differs from what was read.
    fn commit(&self, home: &LockedHome) -> Result<(), Reason> {
        let mut text = self.doc.to_string();
        if self.bom {
            text.insert(0, '\u{feff}');
        }
        if Some(text.as_bytes()) == self.bytes.as_deref() {
            return Ok(());
        }
        home.commit_plugin_tables(MARKETPLACE, self.bytes.as_deref(), text.as_bytes())
            .map_err(|error| {
                Reason::new(codes::HOST_FILES)
                    .detail(format!("{}: {error}", home.config_path().display()))
            })
    }
}

fn unreadable(path: &Path, error: impl std::fmt::Display) -> Reason {
    Reason::new(codes::SETTINGS_UNREADABLE).detail(format!("{}: {error}", path.display()))
}
