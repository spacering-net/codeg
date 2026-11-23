//! Claude Code: the plugin store is a local marketplace of Codeg's
//! (docs/harness-plugins.md §7 and §14 on the website).
//!
//! ```text
//! <root>/.claude-plugin/marketplace.json
//!   { "name": "codeg-harness", "owner": { "name": "Codeg" },
//!     "plugins": [{ "name": "superpowers", "source": "./superpowers/4" }] }
//! ```
//!
//! It lists only the plugins installed natively for Claude Code, each
//! pointing at its revision folder; Claude Code loads a plugin from there,
//! in place, so an update rewrites `source` and nothing else (the next
//! session has it). An entry's name is the one in the plugin's own Claude
//! manifest — the name Claude Code knows it by (`<name>@codeg-harness`).
//!
//! **Which Claude.** Codeg's sessions run the claude-agent-acp wrapper, and
//! the wrapper runs the Claude Code its SDK ships (P3 step 0), so the
//! commands go through it — `claude-agent-acp --cli plugin …`, resolved the
//! way a session's launch resolves the wrapper — and its version is that
//! Claude Code's (`claudeCodeVersion` of the SDK package beside the
//! wrapper; when `CLAUDE_CODE_EXECUTABLE` names another CLI, or the package
//! cannot be found, `--cli --version`). Without the wrapper, the user's own
//! `claude`. A plugin installed by either loads in the other's sessions.
//!
//! **Commands** (every one safe to repeat): install = `plugin marketplace
//! add <root>`, then `plugin install <name>@codeg-harness --scope user`;
//! enable/disable = `plugin enable|disable`; uninstall = `plugin
//! uninstall`, then — when no plugin of Codeg's is left for Claude Code —
//! `plugin marketplace remove codeg-harness`, and the cache copy Claude Code
//! leaves behind (`<config>/plugins/cache/codeg-harness/<name>/`) is
//! deleted. `<config>` is the agent's `CLAUDE_CONFIG_DIR` (a relative one is
//! refused), else `~/.claude`. They write `<config>/settings.json`, which Codeg's MCP code
//! writes too, so they run under the MCP lock (taken inside the plugins
//! lock, never with the skills lock).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use semver::Version;
use serde_json::{Map, Value};

use crate::acp::npm_package as npm;
use crate::acp::opencode_config;
use crate::acp::registry::CLAUDE_AGENT_ACP_PACKAGE;
use crate::commands::mcp_engine::lock::{self as mcp_lock, McpWriteGuard};
use crate::commands::mcp_engine::plugin_gate;
use crate::harness::mcp::model::Reason;
use crate::models::agent::AgentType;

use super::super::switches::AdapterSwitches;
pub use super::shared::MARKETPLACE;
use super::shared::{
    cli_of, command_cwd, env_dir, manifest_name, plugin_key, relative_source, remove_path,
    revision_dir, root_arg, same_dir, source_text, system_programs, Layout, Marketplace,
};
use super::{
    codes, failure, printed_version, CliVia, Detect, HostAdapter, HostCli, HostCx, HostEnv, HostId,
    HostPlugin, HostRunner, HostVerify, ProcessRunner, COMMAND_TIMEOUT,
};

const LAYOUT: Layout = Layout::Claude;
/// Where a plugin keeps its Claude manifest when the install info names
/// none.
const DEFAULT_MANIFEST: &str = ".claude-plugin/plugin.json";
const SDK_PACKAGE: &str = "@anthropic-ai/claude-agent-sdk";
/// Set, it names the CLI the wrapper runs instead of its SDK's.
const EXECUTABLE_VAR: &str = "CLAUDE_CODE_EXECUTABLE";
const CONFIG_DIR_VAR: &str = "CLAUDE_CONFIG_DIR";
/// Under the agent's own overrides: no update check from a plugin command.
const COMMAND_DEFAULTS: &[(&str, &str)] = &[("DISABLE_AUTOUPDATER", "1")];

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

pub struct ClaudeAdapter {
    runner: Arc<dyn HostRunner>,
    locate: Locate,
    mcp_lock: PathBuf,
    mcp_lock_wait: Duration,
    timeout: Duration,
}

impl Default for ClaudeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeAdapter {
    pub fn new() -> Self {
        Self {
            runner: Arc::new(ProcessRunner),
            locate: Locate::System,
            mcp_lock: mcp_lock::default_lock_path(),
            mcp_lock_wait: mcp_lock::LOCK_WAIT,
            timeout: COMMAND_TIMEOUT,
        }
    }

    /// With `runner`, these programs and this MCP lock: for tests.
    #[cfg(all(test, unix))]
    pub(crate) fn sandboxed(
        runner: Arc<dyn HostRunner>,
        wrapper: Option<PathBuf>,
        native: Option<PathBuf>,
        mcp_lock: PathBuf,
    ) -> Self {
        Self {
            runner,
            locate: Locate::Fixed { wrapper, native },
            mcp_lock,
            mcp_lock_wait: Duration::from_millis(500),
            timeout: Duration::from_secs(20),
        }
    }

    #[cfg(all(test, unix))]
    pub(crate) fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// The wrapper Codeg's sessions run, and the user's own `claude`.
    async fn programs(&self) -> (Option<PathBuf>, Option<PathBuf>) {
        match &self.locate {
            Locate::System => system_programs(AgentType::ClaudeCode).await,
            #[cfg(all(test, unix))]
            Locate::Fixed { wrapper, native } => (wrapper.clone(), native.clone()),
        }
    }

    /// The version of the Claude Code `cli` runs.
    async fn version_of(&self, cli: &HostCli, env: &HostEnv) -> Result<Version, String> {
        if cli.via == CliVia::Wrapper && env.var(EXECUTABLE_VAR).is_none() {
            let wrapper = cli.program.clone();
            if let Ok(Some(version)) =
                tokio::task::spawn_blocking(move || bundled_version(&wrapper)).await
            {
                return Ok(version);
            }
        }
        // Any folder that is there: nothing is resolved against it.
        let cwd = if env.home.is_dir() {
            env.home.clone()
        } else {
            std::env::temp_dir()
        };
        let outcome = self
            .runner
            .run(
                &cli.program,
                &cli.args(&["--version"]),
                &env.with_defaults(COMMAND_DEFAULTS),
                &cwd,
                self.timeout,
            )
            .await;
        if let Some(reason) = failure("--version", self.timeout, &outcome) {
            return Err(reason.detail.unwrap_or(reason.code));
        }
        outcome
            .ok()
            .as_ref()
            .and_then(printed_version)
            .ok_or_else(|| "--version printed no version".to_string())
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
            .run(
                &cli.program,
                &cli.args(args),
                &cx.env.with_defaults(COMMAND_DEFAULTS),
                &cwd,
                self.timeout,
            )
            .await;
        match failure(command, self.timeout, &outcome) {
            Some(reason) => Err(reason),
            None => Ok(()),
        }
    }

    /// The MCP lock, for commands that write `settings.json`.
    async fn settings_lock(&self) -> Result<McpWriteGuard, Reason> {
        mcp_lock::acquire_at(&self.mcp_lock, self.mcp_lock_wait)
            .await
            .map_err(|error| {
                let reason = Reason::new(error.code());
                match error.detail() {
                    Some(detail) => reason.detail(detail),
                    None => reason,
                }
            })
    }

    async fn set_enabled(
        &self,
        cx: &HostCx<'_>,
        plugin: &HostPlugin<'_>,
        on: bool,
    ) -> Result<(), Reason> {
        let cli = cli_of(cx)?;
        let config = config_dir(cx)?;
        let market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        let name = market
            .own_name(plugin)
            .ok_or_else(|| Reason::new(codes::MARKETPLACE_ENTRY_MISSING))?;
        let key = plugin_key(&name);
        let _settings = self.settings_lock().await?;
        let (command, verb) = if on {
            ("plugin enable", "enable")
        } else {
            ("plugin disable", "disable")
        };
        match self
            .run(cx, cli, command, &["plugin", verb, &key, "--scope", "user"])
            .await
        {
            // Claude Code refuses to switch a plugin to the state it is in.
            Err(reason)
                if reason.code == codes::COMMAND_FAILED
                    && Settings::read(&config).enabled(&key) == Some(on) =>
            {
                Ok(())
            }
            outcome => outcome,
        }
    }
}

#[async_trait::async_trait]
impl HostAdapter for ClaudeAdapter {
    fn host(&self) -> HostId {
        HostId::Claude
    }

    async fn detect(&self, env: &HostEnv, switches: &AdapterSwitches) -> Detect {
        let (wrapper, native) = self.programs().await;
        let cli = match (wrapper, native) {
            (Some(program), _) => Some(HostCli {
                program,
                prefix: vec!["--cli".to_string()],
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
        let mut detect = Detect::judge(HostId::Claude, cli, version, switches);
        if let (true, Err(reason)) = (detect.supported, config_dir_of(env)) {
            detect.supported = false;
            detect.why_not = Some(reason);
        }
        detect
    }

    async fn install(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<String, Reason> {
        let cli = cli_of(cx)?;
        let root = root_arg(cx)?;
        config_dir(cx)?;
        revision_dir(cx, plugin)?;
        let name = manifest_name(cx, plugin, DEFAULT_MANIFEST);
        let mut market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        market.claim(plugin, &name)?;
        market.save(&cx.ctx.root)?;
        let _settings = self.settings_lock().await?;
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
            "plugin install",
            &["plugin", "install", &plugin_key(&name), "--scope", "user"],
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
        market.claim(to, &name)?;
        market.save(&cx.ctx.root)
    }

    async fn enable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.set_enabled(cx, plugin, true).await
    }

    async fn disable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.set_enabled(cx, plugin, false).await
    }

    async fn uninstall(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        let cli = cli_of(cx)?;
        let config = config_dir(cx)?;
        let mut market = Marketplace::load(LAYOUT, &cx.ctx.root)?;
        // Nothing in Claude Code is provably this plugin's (its install was
        // refused before it got an entry): nothing to take out.
        let Some(name) = market.own_name(plugin) else {
            return Ok(());
        };
        let key = plugin_key(&name);
        let _settings = self.settings_lock().await?;
        match self
            .run(
                cx,
                cli,
                "plugin uninstall",
                &["plugin", "uninstall", &key, "--scope", "user"],
            )
            .await
        {
            // Not installed (any more): nothing to take out.
            Err(reason)
                if reason.code == codes::COMMAND_FAILED && Settings::read(&config).lacks(&key) => {}
            outcome => outcome?,
        }
        market.drop_plugin(plugin.name);
        let cache = config.join("plugins").join("cache").join(MARKETPLACE);
        // The last of Codeg's plugins in Claude Code: by the marketplace
        // file, and by Claude Code's own lists (the file may have been lost).
        let last = market.is_empty() && !Settings::read(&config).has_other_plugins(&key);
        if !last {
            // The cache copy first: the entry still names it on a retry.
            remove_path(&cache.join(&name))?;
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
                    && !Settings::read(&config).knows_marketplace() => {}
            outcome => outcome?,
        }
        remove_path(&cache)?;
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
                    if entry.source.as_str() != Some(expected.as_str()) {
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
        let config = match config_dir(cx) {
            Ok(config) => config,
            Err(reason) => {
                verify.problems.push(reason);
                return verify;
            }
        };
        let settings = Settings::read(&config);
        let Some(document) = settings.settings.as_ref() else {
            verify.problems.push(
                Reason::new(codes::SETTINGS_UNREADABLE)
                    .detail(settings.problem.clone().unwrap_or_default()),
            );
            return verify;
        };
        verify.enabled = settings.enabled(&key);
        if verify.enabled.is_none() {
            verify
                .problems
                .push(Reason::new(codes::NOT_INSTALLED).param("name", name));
        }
        let source = document
            .get("extraKnownMarketplaces")
            .and_then(|known| known.get(MARKETPLACE))
            .and_then(|entry| entry.get("source"));
        match source {
            None => verify
                .problems
                .push(Reason::new(codes::MARKETPLACE_NOT_ADDED)),
            Some(source) => {
                let path = (source.get("source").and_then(Value::as_str) == Some("directory"))
                    .then(|| source.get("path").and_then(Value::as_str))
                    .flatten();
                if !path.is_some_and(|path| same_dir(Path::new(path), &cx.ctx.root)) {
                    verify.problems.push(
                        Reason::new(codes::MARKETPLACE_ELSEWHERE).param("path", path.unwrap_or("")),
                    );
                }
            }
        }
        verify
    }
}

/// The Claude config folder the agent's sessions use: its
/// `CLAUDE_CONFIG_DIR`, else `.claude` in the home they see. A relative
/// `CLAUDE_CONFIG_DIR` is refused, as Codex's relative `CODEX_HOME` is: a
/// session takes it from the project it runs in, so no one folder is the
/// config.
fn config_dir_of(env: &HostEnv) -> Result<PathBuf, Reason> {
    Ok(env_dir(env, CONFIG_DIR_VAR)?.unwrap_or_else(|| env.child_home().join(".claude")))
}

fn config_dir(cx: &HostCx<'_>) -> Result<PathBuf, Reason> {
    config_dir_of(cx.env)
}

/// The Claude Code that the wrapper's SDK ships: `claudeCodeVersion` of
/// the SDK package the wrapper requires.
fn bundled_version(wrapper: &Path) -> Option<Version> {
    let package = npm::package_dir_for_command(wrapper, CLAUDE_AGENT_ACP_PACKAGE)?;
    let sdk = npm::resolve_from(&package, SDK_PACKAGE)?;
    Version::parse(npm::field(&sdk, "claudeCodeVersion")?.trim()).ok()
}

/// What Claude Code's own files say, read without changing them.
struct Settings {
    /// `settings.json`, when Codeg can read and edit it (`plugin_gate`).
    settings: Option<Value>,
    /// Why not.
    problem: Option<String>,
    /// `plugins/installed_plugins.json`: `Ok(None)` when it is not there,
    /// `Err` when it cannot be read.
    installed: Result<Option<Value>, ()>,
    /// `plugins/known_marketplaces.json`, the same way.
    known: Result<Option<Value>, ()>,
}

impl Settings {
    fn read(config: &Path) -> Self {
        let read_json = |path: PathBuf| -> Result<Option<Value>, ()> {
            match fs::read(path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
                Err(_) => Err(()),
                Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|_| ()),
            }
        };
        let path = config.join("settings.json");
        let (settings, problem) = match fs::read(&path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                (Some(Value::Object(Map::new())), None)
            }
            Err(error) => (None, Some(format!("{}: {error}", path.display()))),
            Ok(bytes) => match String::from_utf8(bytes) {
                Err(error) => (None, Some(format!("{}: {error}", path.display()))),
                Ok(text) => match plugin_gate::inspect(&text) {
                    Some(issue) => (None, Some(issue.code)),
                    None => match opencode_config::parse(&text) {
                        Ok(value) => (Some(value), None),
                        Err(error) => (None, Some(error)),
                    },
                },
            },
        };
        let plugins = config.join("plugins");
        Self {
            settings,
            problem,
            installed: read_json(plugins.join("installed_plugins.json")),
            known: read_json(plugins.join("known_marketplaces.json")),
        }
    }

    /// `enabledPlugins[key]`, when it is a boolean.
    fn enabled(&self, key: &str) -> Option<bool> {
        self.settings
            .as_ref()?
            .get("enabledPlugins")?
            .get(key)?
            .as_bool()
    }

    /// Neither the settings nor the installed list have `key`: files that
    /// say so (or are not there), never a guess.
    fn lacks(&self, key: &str) -> bool {
        let Some(settings) = self.settings.as_ref() else {
            return false;
        };
        let in_settings = settings
            .get("enabledPlugins")
            .is_some_and(|plugins| plugins.get(key).is_some());
        let installed = match &self.installed {
            Ok(None) => false,
            Ok(Some(installed)) => installed
                .get("plugins")
                .is_some_and(|plugins| plugins.get(key).is_some()),
            Err(()) => return false,
        };
        !in_settings && !installed
    }

    /// A plugin of Codeg's marketplace other than `key` is in the settings
    /// or the installed list (or they cannot be read).
    fn has_other_plugins(&self, key: &str) -> bool {
        let suffix = format!("@{MARKETPLACE}");
        let other = |map: Option<&Value>| {
            map.and_then(Value::as_object).is_some_and(|map| {
                map.keys()
                    .any(|name| name != key && name.ends_with(&suffix))
            })
        };
        let Some(settings) = self.settings.as_ref() else {
            return true;
        };
        let installed = match &self.installed {
            Ok(None) => false,
            Ok(Some(installed)) => other(installed.get("plugins")),
            Err(()) => true,
        };
        other(settings.get("enabledPlugins")) || installed
    }

    /// The marketplace is still in the settings or the known list (or they
    /// cannot be read).
    fn knows_marketplace(&self) -> bool {
        let Some(settings) = self.settings.as_ref() else {
            return true;
        };
        let in_settings = settings
            .get("extraKnownMarketplaces")
            .is_some_and(|known| known.get(MARKETPLACE).is_some());
        let known = match &self.known {
            Ok(None) => false,
            Ok(Some(known)) => known.get(MARKETPLACE).is_some(),
            Err(()) => true,
        };
        in_settings || known
    }
}
