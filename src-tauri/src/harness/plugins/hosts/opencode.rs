//! OpenCode: a plugin is a line in OpenCode's own config, and nothing else
//! (docs/harness-plugins.md §7 and §14 on the website).
//!
//! ```text
//! <config dir>/opencode.jsonc (or opencode.json)
//!   { "plugins": ["/Users/me/.codeg/plugins/superpowers/4"] }
//! ```
//!
//! OpenCode 2 loads a local plugin from the absolute path of its folder, in
//! place, and its background server reloads the config by itself (P0,
//! OpenCode 2.3.2): install and enable add the revision folder's path to the
//! `plugins` array, an update swaps the path in the same place, and disable
//! and uninstall take the entry out — OpenCode keeps no copy, so nothing else
//! is left. The record keeps whether it was switched off. There are no
//! commands: OpenCode's CLI starts a background server, which an adapter must
//! never leave behind, so nothing here runs it — not even for its version.
//!
//! **Which OpenCode, which version.** The one Codeg's sessions launch: the
//! newest build in Codeg's binary cache (its version is the release it was
//! downloaded as), else an `opencode` the user installed, whose version is
//! what Codeg's agent list last read from it (`--version`, kept per binary
//! and its modification time). With neither, the version is unknown and the
//! plugin takes skills only.
//!
//! **Which config.** The agent's: `OPENCODE_CONFIG_DIR`, else
//! `$XDG_CONFIG_HOME/opencode`, else `.config/opencode` in the home the agent
//! sees (its `HOME` override included), as OpenCode 2 resolves it
//! (`acp::opencode_config`). Relative ones are refused, as Codex's relative
//! `CODEX_HOME` is. OpenCode reads `opencode.json`, then `opencode.jsonc`,
//! and loads the plugins both declare: the plugin's entry is edited in the
//! file it is in, a new one goes where OpenCode's own writers add one (the
//! `.jsonc` when there is one), and the plugin has one entry in all (two
//! names linked to one file are that file). Edits go through
//! `acp::opencode_plugins`, which keeps the user's comments and formatting,
//! writes in one step and — like every config writer of Codeg's — writes a
//! linked file (a dotfiles checkout) through its link. They run under the
//! MCP lock (OpenCode's MCP servers are in the same file), taken inside the
//! plugins lock.
//!
//! **Ownership.** An entry is the plugin's only when it is the absolute path
//! of one of its revision folders in Codeg's store
//! (`<root>/<install name>/<revision>`); nothing else in the list is ever
//! touched.
//!
//! **What may go in natively** ([`OpenCodeAdapter::installable`]): the
//! website lists OpenCode for the plugin, and its folder has code OpenCode
//! loads — `index.js`, or the file `package.json`'s `main` names, inside the
//! folder. Install, enable and update check the folder again.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use semver::Version;
use serde_json::Value;

use crate::acp::opencode_config;
use crate::acp::opencode_plugins as plugins;
use crate::acp::registry::{self, AgentDistribution};
use crate::commands::mcp_engine::fsio;
use crate::commands::mcp_engine::lock::{self as mcp_lock, McpWriteGuard};
use crate::harness::mcp::model::Reason;
use crate::harness::skills::package::safe_path;
use crate::harness::types::PluginInfo;
use crate::models::agent::AgentType;

use super::super::ctx::is_valid_install_name;
use super::super::switches::AdapterSwitches;
use super::shared::{env_dir, read_json_file, revision_dir};
use super::{
    codes, CliVia, Detect, HostAdapter, HostCli, HostCx, HostEnv, HostId, HostPlugin, HostVerify,
};

/// Set, it is OpenCode's config folder.
const CONFIG_DIR_VAR: &str = "OPENCODE_CONFIG_DIR";
const XDG_VAR: &str = "XDG_CONFIG_HOME";
/// The folder entry OpenCode loads when `package.json` names none.
const INDEX: &str = "index.js";
const PACKAGE: &str = "package.json";

/// Where the OpenCode Codeg launches is, and its version.
#[derive(Debug, Clone)]
enum Locate {
    /// As a session's launch finds it.
    System,
    #[cfg(test)]
    Fixed {
        program: Option<PathBuf>,
        /// `None`: Codeg does not know it.
        version: Option<String>,
    },
}

pub struct OpenCodeAdapter {
    locate: Locate,
    mcp_lock: PathBuf,
    mcp_lock_wait: Duration,
}

impl Default for OpenCodeAdapter {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenCodeAdapter {
    pub fn new() -> Self {
        Self {
            locate: Locate::System,
            mcp_lock: mcp_lock::default_lock_path(),
            mcp_lock_wait: mcp_lock::LOCK_WAIT,
        }
    }

    /// With this OpenCode (at this version, when known) and this MCP lock:
    /// for tests.
    #[cfg(test)]
    pub(crate) fn sandboxed(
        program: Option<PathBuf>,
        version: Option<&str>,
        mcp_lock: PathBuf,
    ) -> Self {
        Self {
            locate: Locate::Fixed {
                program,
                version: version.map(str::to_string),
            },
            mcp_lock,
            mcp_lock_wait: Duration::from_millis(500),
        }
    }

    /// Whether `info`'s plugin may go into OpenCode natively from its
    /// revision folder `dir`: the website lists OpenCode for it, and the
    /// folder has code OpenCode loads. The adapter's own operations check
    /// the folder again; whether the server's switch allows the host is
    /// [`HostAdapter::detect`]'s.
    pub fn installable(info: &PluginInfo, dir: &Path) -> Result<(), Reason> {
        if !HostId::OpenCode.listed_in(info) {
            return Err(Reason::new(codes::HOST_NOT_LISTED));
        }
        entry_file(dir).map(|_| ())
    }

    /// The OpenCode binary Codeg's sessions launch, and its version as Codeg
    /// knows it. Starts nothing.
    async fn installed(&self) -> (Option<PathBuf>, Result<Version, String>) {
        match &self.locate {
            Locate::System => tokio::task::spawn_blocking(system_install)
                .await
                .unwrap_or_else(|error| (None, Err(error.to_string()))),
            #[cfg(test)]
            Locate::Fixed { program, version } => {
                let version = match version {
                    Some(label) => {
                        parse_version(label).ok_or_else(|| format!("{label:?} is no version"))
                    }
                    None => Err("Codeg has not read its version".to_string()),
                };
                (program.clone(), version)
            }
        }
    }

    /// The MCP lock: OpenCode's MCP servers are in the same file.
    async fn config_lock(&self) -> Result<McpWriteGuard, Reason> {
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

    /// The plugin's revision in the agent's config, switched on, once: the
    /// plugin's last entry (the one whose options OpenCode goes by) now
    /// names it, in its place, and the plugin's other entries go after
    /// that; with none, it is added to the file OpenCode's own writers add
    /// to. `moving`: only when the config has an entry of the plugin's (at
    /// any revision) to move.
    async fn put(
        &self,
        cx: &HostCx<'_>,
        plugin: &HostPlugin<'_>,
        moving: bool,
    ) -> Result<(), Reason> {
        let config = config_dir(cx)?;
        let target = target_of(cx, plugin)?;
        let _config = self.config_lock().await?;
        let configs = Configs::read(&config, cx, plugin)?;
        let own: Vec<(usize, &String)> = configs.own().collect();
        if moving && own.is_empty() {
            return Ok(());
        }
        // The entry kept: the last of the target's, else the last one of
        // the plugin's, which takes the target's path. Everything else of the
        // plugin's goes once the kept one is written: a retry still finds it.
        let kept = match own.iter().rev().find(|(_, spec)| **spec == target) {
            Some(&(file, _)) => {
                // There more than once: its last declaration, with its
                // options, stays.
                let path = &configs.files[file].path;
                if configs.files[file]
                    .own
                    .iter()
                    .filter(|spec| **spec == target)
                    .count()
                    > 1
                {
                    replace(path, &target, &target)?;
                }
                file
            }
            None => match own.last() {
                Some(&(file, spec)) => {
                    replace(&configs.files[file].path, spec, &target)?;
                    file
                }
                None => {
                    let path = &configs.add_to;
                    plugins::add_local_dir_at(path, &target)
                        .map_err(|error| files_error(path, error))?;
                    return Ok(());
                }
            },
        };
        for (index, file) in configs.files.iter().enumerate() {
            for spec in distinct(&file.own) {
                // In the kept entry's file, a declaration of the target is
                // the kept one (or the same path again). The replaced path
                // is gone from there already: removing it changes nothing.
                if !(index == kept && *spec == target) {
                    remove(&file.path, spec)?;
                }
            }
        }
        Ok(())
    }

    /// Every entry of the plugin's out of the agent's config.
    async fn take_out(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        let config = config_dir(cx)?;
        let _config = self.config_lock().await?;
        let configs = Configs::read(&config, cx, plugin)?;
        for file in &configs.files {
            for spec in distinct(&file.own) {
                remove(&file.path, spec)?;
            }
        }
        Ok(())
    }
}

#[async_trait::async_trait]
impl HostAdapter for OpenCodeAdapter {
    fn host(&self) -> HostId {
        HostId::OpenCode
    }

    async fn detect(&self, env: &HostEnv, switches: &AdapterSwitches) -> Detect {
        let (program, version) = self.installed().await;
        // Nothing is ever run: the binary only says which OpenCode it is.
        let cli = program.map(|program| HostCli {
            program,
            prefix: Vec::new(),
            via: CliVia::Native,
        });
        let mut detect = Detect::judge(HostId::OpenCode, cli, version, switches);
        if let (true, Err(reason)) = (detect.supported, config_dir_of(env)) {
            detect.supported = false;
            detect.why_not = Some(reason);
        }
        detect
    }

    /// Returns the plugin's install name: OpenCode knows a local plugin by
    /// its folder, not by a name of its own.
    async fn install(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<String, Reason> {
        self.put(cx, plugin, false).await?;
        Ok(plugin.name.to_string())
    }

    /// The plugin's entry, wherever it is in the list, now names `to`'s
    /// folder. With no entry (switched off), there is nothing to move and
    /// nothing is added.
    async fn update(
        &self,
        cx: &HostCx<'_>,
        _from: &HostPlugin<'_>,
        to: &HostPlugin<'_>,
    ) -> Result<(), Reason> {
        // An entry at any revision of the plugin's is the one to move: an
        // update cut short, or one the user pointed elsewhere in the store.
        self.put(cx, to, true).await
    }

    async fn enable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.put(cx, plugin, false).await
    }

    async fn disable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.take_out(cx, plugin).await
    }

    async fn uninstall(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason> {
        self.take_out(cx, plugin).await
    }

    async fn verify(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> HostVerify {
        let mut verify = HostVerify::default();
        match revision_dir(cx, plugin) {
            Ok(dir) => {
                if let Err(reason) = entry_file(&dir) {
                    verify
                        .problems
                        .push(reason.param("revision", plugin.revision.to_string()));
                }
            }
            Err(reason) => verify.problems.push(reason),
        }
        let config = match config_dir(cx) {
            Ok(config) => config,
            Err(reason) => {
                verify.problems.push(reason);
                return verify;
            }
        };
        let configs = match Configs::read(&config, cx, plugin) {
            Ok(configs) => configs,
            Err(reason) => {
                verify.problems.push(reason);
                return verify;
            }
        };
        let expected = cx
            .ctx
            .revision_dir(plugin.name, plugin.revision)
            .to_string_lossy()
            .into_owned();
        let found: Vec<&String> = configs.own().map(|(_, spec)| spec).collect();
        if found.is_empty() {
            verify
                .problems
                .push(Reason::new(codes::NOT_INSTALLED).param("name", plugin.name.as_str()));
            return verify;
        }
        verify.enabled = Some(true);
        if found != [&expected] {
            verify.problems.push(
                Reason::new(codes::ENTRY_MISMATCH)
                    .param("expected", expected)
                    .param(
                        "found",
                        found
                            .iter()
                            .map(|spec| spec.as_str())
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
            );
        }
        verify
    }
}

/// The OpenCode a session launches (`acp::connection`): the newest build in
/// Codeg's binary cache, else the user's own; with the version Codeg knows.
fn system_install() -> (Option<PathBuf>, Result<Version, String>) {
    let AgentDistribution::Binary { cmd, .. } =
        registry::get_agent_meta(AgentType::OpenCode).distribution
    else {
        return (None, Err("OpenCode is not a binary agent".to_string()));
    };
    if let Ok(Some((program, label))) =
        crate::acp::binary_cache::find_best_cached_binary_for_agent(AgentType::OpenCode, cmd)
    {
        let version = parse_version(&label).ok_or_else(|| format!("{label:?} is no version"));
        return (Some(program), version);
    }
    match crate::commands::acp::resolve_system_agent_binary_for(AgentType::OpenCode, cmd) {
        Some(program) => {
            let version =
                crate::commands::acp::known_system_probed_version(AgentType::OpenCode, &program)
                    .and_then(|label| parse_version(&label))
                    .ok_or_else(|| "Codeg has not read its version".to_string());
            (Some(program), version)
        }
        None => (None, Err("not installed".to_string())),
    }
}

/// A version as a label or a banner has it (`2.3.2`, `v2.3.2`, `opencode
/// v2.3.2`): its first word that is one.
fn parse_version(label: &str) -> Option<Version> {
    label.split_whitespace().find_map(|word| {
        let word = word.strip_prefix(['v', 'V']).unwrap_or(word);
        Version::parse(word).ok()
    })
}

/// OpenCode's config folder for the agent's environment: its
/// `OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else
/// `.config/opencode` in the home it sees (`opencode_config::
/// config_dir_for_env`, with the agent's `HOME`). Relative ones are refused.
fn config_dir_of(env: &HostEnv) -> Result<PathBuf, Reason> {
    if let Some(dir) = env_dir(env, CONFIG_DIR_VAR)? {
        return Ok(dir);
    }
    let base = env_dir(env, XDG_VAR)?.unwrap_or_else(|| env.child_home().join(".config"));
    Ok(base.join("opencode"))
}

fn config_dir(cx: &HostCx<'_>) -> Result<PathBuf, Reason> {
    config_dir_of(cx.env)
}

/// The plugin's revision folder as its entry names it, once the folder is
/// there with code OpenCode loads.
fn target_of(cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<String, Reason> {
    let dir = revision_dir(cx, plugin)?;
    entry_file(&dir).map_err(|reason| reason.param("revision", plugin.revision.to_string()))?;
    dir.to_str().map(str::to_string).ok_or_else(|| {
        Reason::new(codes::HOST_FILES).detail(format!(
            "{} is not a path OpenCode's config can hold",
            dir.display()
        ))
    })
}

/// The file OpenCode loads from the plugin's folder: `package.json`'s
/// `main`, when it names a plain file inside the folder, else `index.js`.
fn entry_file(dir: &Path) -> Result<PathBuf, Reason> {
    let inside = |path: &Path| -> bool {
        let plain = fs::symlink_metadata(path).is_ok_and(|meta| meta.is_file());
        plain
            && match (fs::canonicalize(path), fs::canonicalize(dir)) {
                (Ok(path), Ok(dir)) => path.starts_with(dir),
                _ => false,
            }
    };
    let main = read_json_file(&dir.join(PACKAGE)).and_then(|package| match package.get("main") {
        Some(Value::String(main)) => Some(main.clone()),
        _ => None,
    });
    if let Some(main) = main {
        let mut relative = main.as_str();
        while let Some(rest) = relative.strip_prefix("./") {
            relative = rest;
        }
        if safe_path(relative) {
            let path = dir.join(relative);
            if inside(&path) {
                return Ok(path);
            }
        }
    }
    let index = dir.join(INDEX);
    if inside(&index) {
        return Ok(index);
    }
    Err(Reason::new(codes::ENTRY_MISSING))
}

/// One config file and the plugin's entries in it, as written.
struct Config {
    path: PathBuf,
    own: Vec<String>,
}

/// The files OpenCode reads in the config folder, in the order it reads
/// them (`opencode.json`, then `opencode.jsonc`); it loads the plugins both
/// declare. Two names that are one file (links) are that file, once.
struct Configs {
    files: Vec<Config>,
    /// Where a new entry goes: the file OpenCode's own writers add to.
    add_to: PathBuf,
}

impl Configs {
    fn read(dir: &Path, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<Self, Reason> {
        let read = |path: PathBuf| -> Result<Config, Reason> {
            let list = plugins::list_plugins_at(&path)
                .map_err(|error| Reason::new(codes::SETTINGS_UNREADABLE).detail(error))?;
            let own = list
                .plugins
                .into_iter()
                .map(|entry| entry.spec)
                .filter(|spec| owned_revision(spec, &cx.ctx.root, plugin).is_some())
                .collect();
            Ok(Config { path, own })
        };
        let add_to = opencode_config::config_file_in(dir);
        let mut present: Vec<PathBuf> = opencode_config::CONFIG_FILE_NAMES
            .iter()
            .map(|name| dir.join(name))
            .filter(|path| fs::symlink_metadata(path).is_ok())
            .collect();
        if let [first, second] = present.as_slice() {
            if same_file(first, second) {
                present.retain(|path| *path == add_to);
            }
        }
        Ok(Self {
            files: present
                .into_iter()
                .map(read)
                .collect::<Result<Vec<_>, _>>()?,
            add_to,
        })
    }

    /// The plugin's entries, file by file in load order, with their file.
    fn own(&self) -> impl Iterator<Item = (usize, &String)> {
        self.files
            .iter()
            .enumerate()
            .flat_map(|(index, file)| file.own.iter().map(move |spec| (index, spec)))
    }
}

/// Whether two names are one file: the same file once every link is
/// followed (or, for links to nothing yet, the same destination).
fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => fsio::resolve_symlinks(a) == fsio::resolve_symlinks(b),
    }
}

/// The revision an entry names when it is one of the plugin's revision
/// folders in the store: `<root>/<install name>/<revision>`, as an absolute
/// path (the only form Codeg writes).
fn owned_revision(spec: &str, root: &Path, plugin: &HostPlugin<'_>) -> Option<u64> {
    let path = Path::new(spec);
    if !path.is_absolute() {
        return None;
    }
    let mut parts = path.strip_prefix(root).ok()?.components();
    let (Some(Component::Normal(name)), Some(Component::Normal(revision)), None) =
        (parts.next(), parts.next(), parts.next())
    else {
        return None;
    };
    let name = name.to_str()?;
    let revision = revision.to_str()?;
    if !is_valid_install_name(name)
        || !name.eq_ignore_ascii_case(plugin.name.as_str())
        || revision.is_empty()
        || !revision.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    revision.parse().ok()
}

/// `specs` without repeats, in order.
fn distinct(specs: &[String]) -> impl Iterator<Item = &String> {
    specs
        .iter()
        .enumerate()
        .filter(move |(index, spec)| !specs[..*index].contains(spec))
        .map(|(_, spec)| spec)
}

fn remove(path: &Path, spec: &str) -> Result<(), Reason> {
    plugins::remove_plugin_at(path, spec)
        .map(|_| ())
        .map_err(|error| files_error(path, error))
}

fn replace(path: &Path, old: &str, new: &str) -> Result<(), Reason> {
    plugins::replace_plugin_at(path, old, new)
        .map(|_| ())
        .map_err(|error| files_error(path, error))
}

fn files_error(path: &Path, error: String) -> Reason {
    // The edit's own message names the file.
    let detail = if error.contains(&*path.to_string_lossy()) {
        error
    } else {
        format!("{}: {error}", path.display())
    };
    Reason::new(codes::HOST_FILES).detail(detail)
}
