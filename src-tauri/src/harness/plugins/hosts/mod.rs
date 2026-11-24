//! Host adapters: putting a plugin into one host's own plugin system, and
//! taking it out again (docs/harness-plugins.md §7 on the website).
//!
//! Each host gets one [`HostAdapter`]. Everything it does runs under the
//! plugins lock the caller holds ([`HostCx::lock`]); what else it locks is
//! its own business, in the order `plugins/lock.rs` gives. The adapters
//! never decide whether a plugin may be installed natively — the caller
//! does, from [`HostAdapter::detect`] and the install info — and every
//! operation is safe to repeat: a step that already happened is not an
//! error, so an interrupted operation can be finished or undone by running
//! the same steps again. A failed [`HostAdapter::install`] may leave part of
//! the plugin behind; [`HostAdapter::uninstall`] clears whatever there is.
//!
//! Host commands run through a [`HostRunner`]: [`ProcessRunner`] in the app,
//! with the agent's environment overrides laid over Codeg's own and a time
//! limit; in tests a runner that only runs programs in the test's own
//! directory, with nothing of Codeg's environment.

pub mod claude;
pub mod codex;
#[cfg(test)]
pub(crate) mod codex_tests;
pub mod opencode;
#[cfg(test)]
mod opencode_tests;
pub(crate) mod shared;
#[cfg(test)]
pub(crate) mod tests;

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use semver::Version;
use serde::Serialize;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};

use crate::harness::mcp::model::Reason;
use crate::harness::types::PluginInfo;
use crate::models::agent::AgentType;

use super::ctx::{InstallName, PluginsCtx};
use super::lock::PluginsGuard;
use super::switches::AdapterSwitches;

/// How long one host command may take.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// How much of a command's stdout and stderr is kept, each.
const OUTPUT_CAP: usize = 256 * 1024;
/// How much of a command's error output goes into a [`Reason`]'s detail.
const DETAIL_CHARS: usize = 2000;
/// How long the output readers get once the command has exited: a process
/// it left behind may hold the pipes open.
const DRAIN_WAIT: Duration = Duration::from_secs(2);

/// The reason codes the adapters give (on top of the lock's `lock_busy`,
/// `lock_held` and `io_error`).
pub mod codes {
    // ── detect ───────────────────────────────────────────────────────────
    /// Neither the host nor a wrapper that carries it is installed.
    pub const HOST_NOT_FOUND: &str = "plugin_host_not_found";
    /// The host is there, its version could not be read. `detail` says why.
    pub const HOST_VERSION_UNKNOWN: &str = "plugin_host_version_unknown";
    /// The agent's environment names the host's home by a relative path,
    /// which each session takes from its own project. Params: `variable`,
    /// `path`.
    pub const HOST_HOME_RELATIVE: &str = "plugin_host_home_relative";
    /// The server turned this host's adapter off (or never turned it on).
    pub const ADAPTER_OFF: &str = "plugin_adapter_off";
    /// The host's version is outside what the adapter supports. Params:
    /// `version`.
    pub const HOST_VERSION_UNSUPPORTED: &str = "plugin_host_version_unsupported";

    // ── an operation that did not go through ────────────────────────────
    /// A host command exited with an error. Params: `command` (`plugin
    /// install`, …), `status` (the exit code, or `signal`); `detail`: its
    /// error output, trimmed.
    pub const COMMAND_FAILED: &str = "plugin_host_command_failed";
    /// A host command ran past its time and was stopped. Params: `command`,
    /// `seconds`.
    pub const COMMAND_TIMED_OUT: &str = "plugin_host_command_timed_out";
    /// A host command could not be started. Params: `command`; `detail`.
    pub const COMMAND_NOT_STARTED: &str = "plugin_host_command_not_started";
    /// The host's marketplace file in the plugin store cannot be read as
    /// one Codeg wrote. `detail` says why.
    pub const MARKETPLACE_UNREADABLE: &str = "plugin_marketplace_unreadable";
    /// Another installed plugin goes by this name in the host. Params:
    /// `name`, `plugin` (that plugin's install name).
    pub const NAME_TAKEN: &str = "plugin_host_name_taken";
    /// The new revision names the plugin differently in this host's
    /// manifest. Params: `from`, `to`.
    pub const NAME_CHANGED: &str = "plugin_host_name_changed";
    /// The revision's folder is not in the plugin store. Params: `revision`.
    pub const REVISION_MISSING: &str = "plugin_revision_missing";
    /// A file of the host's or the store's could not be written or removed.
    /// `detail` says why.
    pub const HOST_FILES: &str = "plugin_host_files";
    /// The website does not list this host for the plugin: its skills only.
    pub const HOST_NOT_LISTED: &str = "plugin_host_not_listed";
    /// The revision's folder has no code for the host to load (OpenCode:
    /// `index.js`, or the file `package.json`'s `main` names, inside the
    /// folder). Params: `revision`, when there is one.
    pub const ENTRY_MISSING: &str = "plugin_entry_missing";

    // ── verify ───────────────────────────────────────────────────────────
    /// The host's settings cannot be read. `detail`: the problem's code.
    pub const SETTINGS_UNREADABLE: &str = "plugin_host_settings_unreadable";
    /// The host does not list the plugin as installed. Params: `name`.
    pub const NOT_INSTALLED: &str = "plugin_host_not_installed";
    /// The host does not know Codeg's marketplace.
    pub const MARKETPLACE_NOT_ADDED: &str = "plugin_marketplace_not_added";
    /// The host's marketplace of Codeg's name is somewhere else. Params:
    /// `path` (empty when it is not a folder).
    pub const MARKETPLACE_ELSEWHERE: &str = "plugin_marketplace_elsewhere";
    /// Codeg's marketplace file has no entry for the plugin.
    pub const MARKETPLACE_ENTRY_MISSING: &str = "plugin_marketplace_entry_missing";
    /// The marketplace entry points at another revision. Params:
    /// `expected`, `found`.
    pub const MARKETPLACE_SOURCE_MISMATCH: &str = "plugin_marketplace_source_mismatch";
    /// The host's config lists the plugin at another revision, or more than
    /// once (OpenCode). Params: `expected`, `found` (what it lists, one per
    /// line).
    pub const ENTRY_MISMATCH: &str = "plugin_host_entry_mismatch";
    /// The host's own copy of the plugin is not there. Params: `version`
    /// (the folder the host keeps it under; empty when unknown).
    pub const CACHE_MISSING: &str = "plugin_host_cache_missing";

    // ── hook trust ───────────────────────────────────────────────────────
    /// The host's answer about its hooks' trust could not be read.
    /// `detail` says why.
    pub const HOOKS_UNREADABLE: &str = "plugin_hooks_unreadable";
}

/// The hosts with an adapter, by the website's id (`PluginHost.host`, the
/// key of `/config`'s `plugins.adapters`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HostId {
    Claude,
    Codex,
    OpenCode,
}

impl HostId {
    pub fn as_str(self) -> &'static str {
        match self {
            HostId::Claude => "claude",
            HostId::Codex => "codex",
            HostId::OpenCode => "opencode",
        }
    }

    /// Whether the website lists this host for the plugin (`PluginInfo.hosts`):
    /// a plugin goes into a host natively only then.
    pub fn listed_in(self, info: &PluginInfo) -> bool {
        info.hosts.iter().any(|entry| entry.host == self.as_str())
    }

    /// The host a Codeg agent runs; `None` for an agent that only ever
    /// takes a plugin's skills.
    pub fn for_agent(agent: AgentType) -> Option<Self> {
        match agent {
            AgentType::ClaudeCode => Some(HostId::Claude),
            AgentType::Codex => Some(HostId::Codex),
            AgentType::OpenCode => Some(HostId::OpenCode),
            _ => None,
        }
    }
}

impl std::fmt::Display for HostId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The environment an agent's host runs in: the overrides its launch lays
/// over Codeg's own (`build_runtime_env_from_setting`), and the home its
/// default config directory hangs off.
#[derive(Debug, Clone)]
pub struct HostEnv {
    /// As the launch has them: an empty value removes the variable.
    pub overrides: BTreeMap<String, String>,
    /// The user's home as Codeg sees it; what the host sees is
    /// [`HostEnv::child_home`].
    pub home: PathBuf,
    /// Whether a variable without an override is Codeg's own. Off in tests:
    /// nothing of the test process's environment is read.
    inherit: bool,
}

impl HostEnv {
    /// An agent launched with `overrides`, in this user's home.
    pub fn agent(overrides: BTreeMap<String, String>) -> Self {
        Self {
            overrides,
            home: dirs::home_dir().unwrap_or_default(),
            inherit: true,
        }
    }

    /// Only `overrides` and `home`: nothing of Codeg's environment.
    #[cfg(test)]
    pub(crate) fn sandboxed(home: &Path, overrides: &[(&str, &str)]) -> Self {
        Self {
            overrides: overrides
                .iter()
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
            home: home.to_path_buf(),
            inherit: false,
        }
    }

    /// `key` as the host sees it: an override (an empty one is no value),
    /// else Codeg's own. Matched the way the launch applies overrides
    /// (case-blind on Windows, the last spelling winning).
    pub fn var(&self, key: &str) -> Option<String> {
        let found = if cfg!(windows) {
            self.overrides
                .iter()
                .rev()
                .find(|(name, _)| name.eq_ignore_ascii_case(key))
        } else {
            self.overrides.get_key_value(key)
        };
        match found {
            Some((_, value)) if value.is_empty() => None,
            Some((_, value)) => Some(value.clone()),
            None if self.inherit => std::env::var(key).ok(),
            None => None,
        }
    }

    /// The home the host itself sees: a `HOME` (on Windows `USERPROFILE`)
    /// override when it is an absolute path, else [`HostEnv::home`].
    pub fn child_home(&self) -> PathBuf {
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        self.path_var(key)
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| self.home.clone())
    }

    /// [`HostEnv::var`] as a path; unset and empty are none.
    pub fn path_var(&self, key: &str) -> Option<PathBuf> {
        self.var(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    }

    /// These overrides with `defaults` under them: a default applies only
    /// where the agent's own overrides say nothing of the variable.
    pub fn with_defaults(&self, defaults: &[(&str, &str)]) -> Self {
        let mut env = self.clone();
        for (key, value) in defaults {
            let named = env
                .overrides
                .keys()
                .any(|name| name == key || (cfg!(windows) && name.eq_ignore_ascii_case(key)));
            if !named {
                env.overrides.insert(key.to_string(), value.to_string());
            }
        }
        env
    }
}

/// How the host's commands are reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliVia {
    /// Through the ACP wrapper Codeg's sessions run, which carries its own
    /// copy of the host (`claude-agent-acp --cli …`).
    Wrapper,
    /// The user's own installed CLI.
    Native,
}

/// A host's command line: `program`, then `prefix`, then the command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostCli {
    pub program: PathBuf,
    pub prefix: Vec<String>,
    pub via: CliVia,
}

impl HostCli {
    fn args(&self, args: &[&str]) -> Vec<OsString> {
        self.prefix
            .iter()
            .map(OsString::from)
            .chain(args.iter().map(OsString::from))
            .collect()
    }
}

/// What [`HostAdapter::detect`] found.
#[derive(Debug, Clone, PartialEq)]
pub struct Detect {
    /// The host's commands; `None` when there is no host to run.
    pub cli: Option<HostCli>,
    /// The version of the host that the sessions run.
    pub version: Option<Version>,
    /// A plugin may be installed natively here: a host was found, its
    /// version is known, and the server's switch allows that version.
    pub supported: bool,
    /// Why not, when not.
    pub why_not: Option<Reason>,
}

impl Detect {
    /// The verdict for `cli` at `version` under `switches`.
    pub(crate) fn judge(
        host: HostId,
        cli: Option<HostCli>,
        version: Result<Version, String>,
        switches: &AdapterSwitches,
    ) -> Self {
        let Some(cli) = cli else {
            return Self {
                cli: None,
                version: None,
                supported: false,
                why_not: Some(Reason::new(codes::HOST_NOT_FOUND)),
            };
        };
        let version = match version {
            Ok(version) => version,
            Err(why) => {
                return Self {
                    cli: Some(cli),
                    version: None,
                    supported: false,
                    why_not: Some(Reason::new(codes::HOST_VERSION_UNKNOWN).detail(why)),
                }
            }
        };
        let why_not = if !switches.enabled(host.as_str()) {
            Some(Reason::new(codes::ADAPTER_OFF))
        } else if !switches.allows(host.as_str(), &version) {
            Some(Reason::new(codes::HOST_VERSION_UNSUPPORTED).param("version", version.to_string()))
        } else {
            None
        };
        Self {
            cli: Some(cli),
            version: Some(version),
            supported: why_not.is_none(),
            why_not,
        }
    }
}

/// One plugin as an adapter needs it.
#[derive(Debug, Clone, Copy)]
pub struct HostPlugin<'a> {
    pub name: &'a InstallName,
    pub revision: u64,
    /// This host's manifest in the package (`PluginHost.manifest`); `None`
    /// or empty: where the host keeps it by default.
    pub manifest: Option<&'a str>,
    /// `PluginInfo.name`: the name when the manifest gives none.
    pub info_name: Option<&'a str>,
    /// The name the host knows it by, as [`HostAdapter::install`] returned
    /// it and the record kept it: an adapter whose own files lost track of
    /// the plugin acts on this name only, never on a guess.
    pub host_name: Option<&'a str>,
}

impl<'a> HostPlugin<'a> {
    /// `name` at `revision`, with what the install info says of `host`.
    pub fn new(
        name: &'a InstallName,
        revision: u64,
        info: Option<&'a PluginInfo>,
        host: HostId,
    ) -> Self {
        Self {
            name,
            revision,
            manifest: info.and_then(|info| {
                info.hosts
                    .iter()
                    .find(|entry| entry.host == host.as_str())
                    .map(|entry| entry.manifest.as_str())
                    .filter(|manifest| !manifest.is_empty())
            }),
            info_name: info.map(|info| info.name.as_str()),
            host_name: None,
        }
    }

    /// With the name the record kept from the install.
    pub fn with_host_name(mut self, host_name: Option<&'a str>) -> Self {
        self.host_name = host_name;
        self
    }
}

/// What an operation works with.
pub struct HostCx<'a> {
    pub ctx: &'a PluginsCtx,
    pub env: &'a HostEnv,
    /// From [`Detect::cli`]: what to run; `None` when the host is gone.
    pub cli: Option<&'a HostCli>,
    /// The caller holds the plugins lock for the whole operation.
    pub lock: &'a PluginsGuard,
}

/// What [`HostAdapter::verify`] found of one plugin in one host. Read-only.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
pub struct HostVerify {
    /// Whether the host has it switched on; `None` when the host does not
    /// list it.
    pub enabled: Option<bool>,
    /// What does not match the record; empty when everything does.
    pub problems: Vec<Reason>,
}

impl HostVerify {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

/// What a host's own trust says of one hook.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HookTrustState {
    /// The user trusted it as it is: it runs.
    Trusted,
    /// Never trusted: it does not run until the user trusts it in the host.
    Untrusted,
    /// Trusted once, changed since: it does not run until trusted again.
    Modified,
    /// The host did not say (it could not be asked, it does not list the
    /// hook, or it answered something else).
    Unknown,
}

/// One hook of a plugin, as the host keys it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookStatus {
    /// The host's key for it (Codex:
    /// `<name>@codeg-harness:<file>:<event>:<group>:<handler>`).
    pub key: String,
    /// The event it runs on, as the key has it (`session_start`).
    pub event: String,
    pub state: HookTrustState,
}

/// What the host's own trust says of a plugin's hooks. Read-only.
#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookTrust {
    /// The plugin's hooks: those the host listed, then those the package
    /// has that it did not list (`Unknown`). Empty: the plugin has none.
    pub hooks: Vec<HookStatus>,
    /// Why the host could not be asked, when it could not; every hook is
    /// then `Unknown`. Never a reason to fail an operation.
    pub problem: Option<Reason>,
}

impl HookTrust {
    /// Every hook runs (also when there are none).
    pub fn all_trusted(&self) -> bool {
        self.hooks
            .iter()
            .all(|hook| hook.state == HookTrustState::Trusted)
    }
}

/// One host's plugin system.
#[async_trait::async_trait]
pub trait HostAdapter: Send + Sync {
    fn host(&self) -> HostId;

    /// Which host the agent's sessions run, its version, and whether a
    /// plugin may be installed into it natively.
    async fn detect(&self, env: &HostEnv, switches: &AdapterSwitches) -> Detect;

    /// Put the plugin's revision folder into the host, switched on. Returns
    /// the name the host knows it by, for the record
    /// ([`HostPlugin::host_name`]).
    async fn install(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<String, Reason>;

    /// Move an installed plugin from one revision to the other.
    async fn update(
        &self,
        cx: &HostCx<'_>,
        from: &HostPlugin<'_>,
        to: &HostPlugin<'_>,
    ) -> Result<(), Reason>;

    async fn enable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason>;

    async fn disable(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason>;

    /// Take the plugin out of the host, with what the host left of it.
    async fn uninstall(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> Result<(), Reason>;

    /// How the host has the plugin, against `plugin` (the recorded
    /// revision). Changes nothing.
    async fn verify(&self, cx: &HostCx<'_>, plugin: &HostPlugin<'_>) -> HostVerify;

    /// What the host's own trust says of the plugin's hooks, for a host
    /// that asks the user before it runs a plugin's hook (Codex). Read-only:
    /// an adapter never trusts a hook for the user. `None`: the host keeps
    /// no trust of its own.
    async fn hook_trust(&self, _cx: &HostCx<'_>, _plugin: &HostPlugin<'_>) -> Option<HookTrust> {
        None
    }
}

/// Why a command did not run to its end.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RunError {
    /// It could not be started (or this runner does not run it).
    NotStarted(String),
    /// It ran past its time and was stopped, with what it started.
    TimedOut,
}

/// Tells [`HostRunner::converse`] it has read what it was waiting for.
pub type Answered = dyn Fn(&[u8]) -> bool + Send + Sync;

/// What [`HostRunner::converse`] says, and how it knows it was answered.
#[derive(Clone, Copy)]
pub struct Exchange<'a> {
    /// Written to the server's input at once (which stays open).
    pub input: &'a [u8],
    /// Whether the output so far holds the answer.
    pub answered: &'a Answered,
}

/// Runs a host command.
#[async_trait::async_trait]
pub trait HostRunner: Send + Sync {
    async fn run(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Output, RunError>;

    /// Start a host's server (`codex app-server`) the way [`Self::run`]
    /// starts a command, write the exchange's `input` to it and keep its
    /// input open, read its output until `answered` says the output so far holds what was
    /// asked, it exits, or `timeout` — then stop it with everything it
    /// started, whatever happened. Returns what it wrote (its first
    /// [`OUTPUT_CAP`] bytes); its error output is not kept.
    async fn converse(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
        exchange: Exchange<'_>,
    ) -> Result<Vec<u8>, RunError>;
}

/// The app's runner: the agent's overrides laid over Codeg's environment
/// the way a launch does it (an empty value removes the variable,
/// `CODEG_LAUNCH_*` are Codeg's own), no input, output captured.
#[derive(Debug, Clone, Copy, Default)]
pub struct ProcessRunner;

impl ProcessRunner {
    fn command(
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
    ) -> tokio::process::Command {
        let mut command = crate::process::tokio_command(program);
        command.args(args).current_dir(cwd);
        for (key, value) in &env.overrides {
            if crate::acp::connection::is_launch_only_key(key) {
                continue;
            }
            if value.is_empty() {
                command.env_remove(key);
            } else {
                command.env(key, value);
            }
        }
        command
    }
}

#[async_trait::async_trait]
impl HostRunner for ProcessRunner {
    async fn run(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Output, RunError> {
        run_captured(Self::command(program, args, env, cwd), timeout).await
    }

    async fn converse(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
        exchange: Exchange<'_>,
    ) -> Result<Vec<u8>, RunError> {
        converse_captured(Self::command(program, args, env, cwd), timeout, exchange).await
    }
}

/// Spawn `command` with no input and its output piped, and wait for it at
/// most `timeout`. On the timeout the whole process tree is stopped: a
/// wrapper's child would otherwise go on writing the host's files.
async fn run_captured(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> Result<Output, RunError> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // A group of its own, so that everything it starts can be stopped at
    // once (see `stop`).
    #[cfg(unix)]
    command.process_group(0);
    let mut running = Running::spawn(&mut command).await?;
    let stdout = tokio::spawn(read_capped(running.child().stdout.take()));
    let stderr = tokio::spawn(read_capped(running.child().stderr.take()));
    let status = match tokio::time::timeout(timeout, running.child().wait()).await {
        Ok(Ok(status)) => {
            running.reaped();
            status
        }
        outcome => {
            running.stop().await;
            stdout.abort();
            stderr.abort();
            return Err(match outcome {
                Ok(Err(error)) => RunError::NotStarted(error.to_string()),
                _ => RunError::TimedOut,
            });
        }
    };
    let collect = |handle: tokio::task::JoinHandle<Vec<u8>>| async move {
        let abort = handle.abort_handle();
        match tokio::time::timeout(DRAIN_WAIT, handle).await {
            Ok(Ok(bytes)) => bytes,
            Ok(Err(_)) => Vec::new(),
            Err(_) => {
                abort.abort();
                Vec::new()
            }
        }
    };
    Ok(Output {
        status,
        stdout: collect(stdout).await,
        stderr: collect(stderr).await,
    })
}

/// Spawn `command` with its input and output piped (its error output
/// dropped, so it never blocks on it), write `input`, and read until
/// `answered`, its end or `timeout`; then stop it and everything it
/// started (see `stop`), in every case.
async fn converse_captured(
    mut command: tokio::process::Command,
    timeout: Duration,
    Exchange { input, answered }: Exchange<'_>,
) -> Result<Vec<u8>, RunError> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    command.process_group(0);
    let mut running = Running::spawn(&mut command).await?;
    let mut stdin = running.child().stdin.take();
    let mut stdout = running.child().stdout.take();
    let exchange = async {
        if let Some(writer) = stdin.as_mut() {
            // One that does not take it has still said what it says.
            let _ = writer.write_all(input).await;
            let _ = writer.flush().await;
        }
        let mut kept = Vec::new();
        let Some(reader) = stdout.as_mut() else {
            return kept;
        };
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => return kept,
                Ok(read) => {
                    let room = OUTPUT_CAP.saturating_sub(kept.len());
                    kept.extend_from_slice(&buffer[..read.min(room)]);
                    if answered(&kept) {
                        return kept;
                    }
                }
            }
        }
    };
    let outcome = tokio::time::timeout(timeout, exchange).await;
    drop(stdin);
    drop(stdout);
    running.stop().await;
    outcome.map_err(|_| RunError::TimedOut)
}

/// A command that runs until it is reaped or stopped. Should the future
/// that runs it be dropped first (its caller gave up on it), it is stopped
/// all the same, the way a command past its time is ([`stop`]).
struct Running {
    child: Option<tokio::process::Child>,
    pid: Option<u32>,
}

impl Running {
    async fn spawn(command: &mut tokio::process::Command) -> Result<Self, RunError> {
        command.kill_on_drop(true);
        let child = crate::process::spawn_retrying_exec_busy(|| command.spawn())
            .await
            .map_err(|error| RunError::NotStarted(error.to_string()))?;
        Ok(Self {
            pid: child.id(),
            child: Some(child),
        })
    }

    fn child(&mut self) -> &mut tokio::process::Child {
        self.child.as_mut().expect("a running command")
    }

    /// It exited and was reaped: nothing is left to stop (and its id may
    /// soon be another's).
    fn reaped(mut self) {
        self.child = None;
    }

    /// [`stop`] it. The child stays here until that is done: should this
    /// be given up on halfway, `Drop` still stops it.
    async fn stop(mut self) {
        if let Some(child) = self.child.as_mut() {
            stop(child, self.pid).await;
        }
        self.child = None;
    }
}

impl Drop for Running {
    /// What [`stop`] does, here and now (no task that a runtime shutting
    /// down might never run): its tree, its group on Unix, then the child
    /// itself (`kill_on_drop`, reaped by the runtime).
    fn drop(&mut self) {
        let Some(child) = self.child.take() else {
            return;
        };
        if let Some(pid) = self.pid {
            // In `stop()`'s order: the tree while every parent is still
            // there to be followed, then the group.
            let config = kill_tree::Config {
                signal: "SIGKILL".to_string(),
                include_target: true,
            };
            let _ = kill_tree::blocking::kill_tree_with_config(pid, &config);
            #[cfg(unix)]
            if let Ok(group) = libc::pid_t::try_from(pid) {
                // SAFETY: a plain syscall on the group the command leads (it
                // was spawned with `process_group(0)` and is not reaped yet,
                // so the id is still its); no memory is involved.
                unsafe {
                    libc::killpg(group, libc::SIGKILL);
                }
            }
        }
        drop(child);
    }
}

/// Stop `child` and everything it started, for good: `SIGKILL` (which no
/// process can catch or ignore) to its process tree and, on Unix, to its
/// process group, which still holds a descendant whose parent is already
/// gone. Then reap it. Nothing it started writes a host's file after this.
async fn stop(child: &mut tokio::process::Child, pid: Option<u32>) {
    if let Some(pid) = pid {
        let config = kill_tree::Config {
            signal: "SIGKILL".to_string(),
            include_target: true,
        };
        let _ = kill_tree::tokio::kill_tree_with_config(pid, &config).await;
        #[cfg(unix)]
        if let Ok(group) = libc::pid_t::try_from(pid) {
            // SAFETY: a plain syscall on the group this child leads (it was
            // spawned with `process_group(0)`); no memory is involved.
            unsafe {
                libc::killpg(group, libc::SIGKILL);
            }
        }
    }
    let _ = child.start_kill();
    let _ = tokio::time::timeout(DRAIN_WAIT, child.wait()).await;
}

/// All of `reader`, keeping the first [`OUTPUT_CAP`] bytes.
async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>) -> Vec<u8> {
    let Some(mut reader) = reader else {
        return Vec::new();
    };
    let mut kept = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return kept,
            Ok(read) => {
                let room = OUTPUT_CAP.saturating_sub(kept.len());
                kept.extend_from_slice(&buffer[..read.min(room)]);
            }
        }
    }
}

/// The tests' runner: runs only a program inside `root` (its real path),
/// with nothing of the test process's environment — no `PATH`, no `HOME` —
/// beyond the overrides it is given.
#[cfg(all(test, unix))]
pub(crate) struct SandboxRunner {
    root: PathBuf,
}

#[cfg(all(test, unix))]
impl SandboxRunner {
    pub(crate) fn new(root: &Path) -> Self {
        Self {
            root: std::fs::canonicalize(root).expect("the sandbox exists"),
        }
    }
}

#[cfg(all(test, unix))]
impl SandboxRunner {
    fn command(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
    ) -> Result<tokio::process::Command, RunError> {
        let real = std::fs::canonicalize(program)
            .map_err(|error| RunError::NotStarted(format!("{}: {error}", program.display())))?;
        if !program.is_absolute() || !real.starts_with(&self.root) {
            return Err(RunError::NotStarted(format!(
                "{} is outside the test's directory",
                program.display()
            )));
        }
        let mut command = tokio::process::Command::new(program);
        command.args(args).current_dir(cwd).env_clear();
        for (key, value) in &env.overrides {
            if !value.is_empty() {
                command.env(key, value);
            }
        }
        Ok(command)
    }
}

#[cfg(all(test, unix))]
#[async_trait::async_trait]
impl HostRunner for SandboxRunner {
    async fn run(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
    ) -> Result<Output, RunError> {
        run_captured(self.command(program, args, env, cwd)?, timeout).await
    }

    async fn converse(
        &self,
        program: &Path,
        args: &[OsString],
        env: &HostEnv,
        cwd: &Path,
        timeout: Duration,
        exchange: Exchange<'_>,
    ) -> Result<Vec<u8>, RunError> {
        converse_captured(self.command(program, args, env, cwd)?, timeout, exchange).await
    }
}

/// A command's outcome as a [`Reason`] when it failed. `command` names it
/// for a person (`plugin install`), without paths.
pub(crate) fn failure(
    command: &str,
    timeout: Duration,
    outcome: &Result<Output, RunError>,
) -> Option<Reason> {
    match outcome {
        Ok(output) if output.status.success() => None,
        Ok(output) => {
            let status = output
                .status
                .code()
                .map(|code| code.to_string())
                .unwrap_or_else(|| "signal".to_string());
            let text = if output.stderr.iter().any(|b| !b.is_ascii_whitespace()) {
                &output.stderr
            } else {
                &output.stdout
            };
            let mut reason = Reason::new(codes::COMMAND_FAILED)
                .param("command", command)
                .param("status", status);
            let detail = trimmed(text);
            if !detail.is_empty() {
                reason = reason.detail(detail);
            }
            Some(reason)
        }
        Err(RunError::TimedOut) => Some(
            Reason::new(codes::COMMAND_TIMED_OUT)
                .param("command", command)
                .param("seconds", timeout.as_secs().to_string()),
        ),
        Err(RunError::NotStarted(why)) => Some(
            Reason::new(codes::COMMAND_NOT_STARTED)
                .param("command", command)
                .detail(why.clone()),
        ),
    }
}

/// A command's output for a person: lossy UTF-8 without terminal escapes,
/// trimmed, its last [`DETAIL_CHARS`] characters.
pub(crate) fn trimmed(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ parameters… final byte (@ to ~).
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            continue;
        }
        if c.is_control() && c != '\n' && c != '\t' {
            continue;
        }
        plain.push(c);
    }
    let plain = plain.trim();
    let count = plain.chars().count();
    if count <= DETAIL_CHARS {
        return plain.to_string();
    }
    let tail: String = plain.chars().skip(count - DETAIL_CHARS).collect();
    format!("…{}", tail.trim_start())
}

/// The version a CLI's `--version` printed: the first word of its first
/// line that is one (`2.1.326 (Claude Code)`, `v0.4.1`).
pub(crate) fn printed_version(output: &Output) -> Option<Version> {
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .find(|line| !line.trim().is_empty())?
        .split_whitespace()
        .find_map(|word| Version::parse(word.strip_prefix('v').unwrap_or(word)).ok())
}
