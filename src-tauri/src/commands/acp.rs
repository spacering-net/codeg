use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
#[cfg(feature = "tauri-runtime")]
use tauri::{Manager, State};

use crate::acp::binary_cache;
use crate::acp::custom_registry;
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::opencode_plugins::{self, PluginCheckSummary};
use crate::acp::preflight::{self, PreflightResult};
use crate::acp::registry;
use crate::acp::types::{
    AcpAgentInfo, AgentDiagnosticsReport, AgentSkillContent, AgentSkillItem, AgentSkillLayout,
    AgentSkillLocation, AgentSkillScope, AgentSkillsListResult, CodexGranularApproval,
    CodexSandboxSettings, CodexSandboxStructuredConfig, CodexWorkspaceWrite, ConfigStaleKind,
    ConnectionStatus, DiagCheck, DiagLevel, DiagSection, DiagnosticsVerdict, GrokSettings,
    GrokStructuredConfig,
};
#[cfg(feature = "tauri-runtime")]
use crate::acp::types::{ConnectionInfo, ForkResultInfo, PromptInputBlock};
use crate::db::service::agent_setting_service;
use crate::db::service::model_provider_service;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

const ACP_AGENTS_UPDATED_EVENT: &str = "app://acp-agents-updated";
const NPM_PREFIX_TIMEOUT: Duration = Duration::from_millis(1500);

static NPM_GLOBAL_PREFIX_CACHE: tokio::sync::OnceCell<PathBuf> = tokio::sync::OnceCell::const_new();

#[derive(Serialize, Clone)]
#[serde(rename_all = "snake_case")]
struct AcpAgentsUpdatedEventPayload {
    reason: &'static str,
    agent_type: Option<AgentType>,
}

pub(crate) fn emit_acp_agents_updated(
    emitter: &EventEmitter,
    reason: &'static str,
    agent_type: Option<AgentType>,
) {
    crate::web::event_bridge::emit_event(
        emitter,
        ACP_AGENTS_UPDATED_EVENT,
        AcpAgentsUpdatedEventPayload { reason, agent_type },
    );
}

const AGENT_INSTALL_EVENT: &str = "app://agent-install";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AgentInstallEventKind {
    Started,
    Log,
    Completed,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct AgentInstallEvent {
    pub task_id: String,
    pub kind: AgentInstallEventKind,
    pub payload: String,
}

fn emit_agent_install_event(
    emitter: &EventEmitter,
    task_id: &str,
    kind: AgentInstallEventKind,
    payload: impl Into<String>,
) {
    crate::web::event_bridge::emit_event(
        emitter,
        AGENT_INSTALL_EVENT,
        AgentInstallEvent {
            task_id: task_id.to_string(),
            kind,
            payload: payload.into(),
        },
    );
}

fn is_version_like(value: &str) -> bool {
    value.chars().any(|c| c.is_ascii_digit()) && value.contains('.')
}

fn normalize_version_candidate(value: &str) -> Option<String> {
    let normalized = value.trim().trim_start_matches('v');
    if is_version_like(normalized) {
        Some(normalized.to_string())
    } else {
        None
    }
}

fn version_from_package_spec(package: &str) -> Option<String> {
    let (_, maybe_version) = package.rsplit_once('@')?;
    let version = maybe_version.trim();
    if version.is_empty() || version.eq_ignore_ascii_case("latest") {
        return None;
    }
    normalize_version_candidate(version)
}

fn package_name_from_spec(package: &str) -> String {
    let normalized = package.trim();
    if normalized.is_empty() {
        return String::new();
    }

    if let Some(index) = normalized.rfind('@') {
        if index > 0 {
            let version_part = normalized[index + 1..].trim();
            if !version_part.is_empty() {
                return normalized[..index].to_string();
            }
        }
    }

    normalized.to_string()
}

/// Validate and normalize a user-supplied custom version for install.
///
/// Stricter than [`normalize_version_candidate`]: tolerates a leading `v`/`V`,
/// then requires the first character to be a digit and the rest to be drawn from
/// `[0-9A-Za-z.-+]` (covers semver pre-release/build metadata and calendar
/// versions like `2026.5.20`). This rejects npm dist-tags (`latest`, `next`) and
/// anything containing whitespace, `@`, or path separators, so the result is
/// safe to interpolate into an npm package spec (`name@<v>`) and to substitute
/// into a binary download URL. Returns the version without the leading `v`.
fn sanitize_custom_version(input: &str) -> Option<String> {
    let trimmed = input.trim();
    let normalized = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let mut chars = normalized.chars();
    if !chars.next()?.is_ascii_digit() {
        return None;
    }
    // Require a dotted version (e.g. `1.2.3`) so the validator agrees with the
    // detection fallback `version_from_package_spec`, which needs a `.` — and so
    // a "custom version" is a concrete version rather than an npm range (`2`).
    if !normalized.contains('.') {
        return None;
    }
    let all_allowed = normalized
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'));
    all_allowed.then(|| normalized.to_string())
}

/// Build the `npm install -g` spec for an agent.
///
/// `version_override` of `None` or all-whitespace yields the registry-pinned
/// `package` spec unchanged (current behavior). A non-empty override is
/// validated via [`sanitize_custom_version`] and combined with the registry
/// package *name* (its pinned version is dropped) to form `name@<version>`. An
/// override that fails validation is rejected with an error.
fn build_npm_install_spec(
    package: &str,
    version_override: Option<&str>,
) -> Result<String, AcpError> {
    match version_override {
        Some(raw) if !raw.trim().is_empty() => {
            let version = sanitize_custom_version(raw).ok_or_else(|| {
                AcpError::protocol(format!("invalid custom version: {}", raw.trim()))
            })?;
            Ok(format!("{}@{version}", package_name_from_spec(package)))
        }
        _ => Ok(package.to_string()),
    }
}

/// Substitute a custom version into a registry binary download URL by replacing
/// every occurrence of the registry version string. The registry version is
/// embedded in the GitHub release URL (the path tag, and for some agents the
/// asset filename), so a plain replace yields the URL for the requested version
/// — assuming the upstream release reuses the same asset-naming convention.
fn apply_custom_version_to_url(url: &str, registry_version: &str, custom_version: &str) -> String {
    url.replace(registry_version, custom_version)
}

/// Per-agent `env_json` key that opts an npx agent into installing the
/// package's `latest` npm dist-tag instead of the reviewed registry pin.
/// Owned by the "Adapter version" control in Agent Settings, riding the same
/// per-agent env store as pi's `PI_ACP_PI_COMMAND` runtime override and the
/// host-tools knob. Consulted at install/upgrade time ONLY: a launch always
/// runs whatever is installed, and nothing polls npm in the background.
///
/// Exactly the value `latest` opts in; absence or any other value stays on the
/// pin. Unlike `CODEG_ACP_HOST_TOOLS` there is no process-env second layer to
/// make "absent" ambiguous, so the settings control may delete the key for the
/// pinned default — both readers (this one and `adapterChannelFromEnvText` in
/// acp-agent-settings.tsx) treat absent as pinned.
pub(crate) const ADAPTER_CHANNEL_ENV: &str = "CODEG_ADAPTER_CHANNEL";
const ADAPTER_CHANNEL_LATEST: &str = "latest";

/// Whether a resolved per-agent env opts into the `latest` adapter channel.
/// Takes the MERGED env (`build_runtime_env_from_setting`) rather than raw
/// `env_json`, so it reads the same layers the launch path and the settings
/// page display — a value set through the agent's local config file counts too.
fn adapter_channel_is_latest(env: &BTreeMap<String, String>) -> bool {
    env.get(ADAPTER_CHANNEL_ENV)
        .is_some_and(|value| value.trim() == ADAPTER_CHANNEL_LATEST)
}

/// The npm install spec(s) one prepare call will attempt, in order: the spec to
/// try first, plus the fallback to retry on failure (at most one).
///
/// An explicit `version_override` (the Custom install dialog) always wins and
/// never falls back — the user asked for that exact version, and quietly
/// installing a different one would relabel their choice. With no override, a
/// latest-channel agent tries the `latest` dist-tag first and keeps the pinned
/// registry spec as the fallback, so npm being unreachable (or a mirror not
/// yet carrying the tag's target) degrades to the reviewed pin instead of a
/// failed install. The default stays byte-identical to `build_npm_install_spec`.
fn npm_install_attempts(
    package: &str,
    version_override: Option<&str>,
    latest_channel: bool,
) -> Result<(String, Option<String>), AcpError> {
    let pinned = build_npm_install_spec(package, version_override)?;
    let overridden = version_override.is_some_and(|raw| !raw.trim().is_empty());
    if latest_channel && !overridden {
        let latest = format!(
            "{}@{ADAPTER_CHANNEL_LATEST}",
            package_name_from_spec(package)
        );
        return Ok((latest, Some(pinned)));
    }
    Ok((pinned, None))
}

/// Check whether an NPX agent command is spawnable.
/// Uses PATH first, then falls back to the current npm global prefix to handle
/// GUI environments that don't inherit the user's shell PATH.
pub(crate) async fn is_cmd_available(cmd: &str) -> bool {
    resolve_npx_command(cmd).await.is_some()
}

pub(crate) fn resolve_command_on_path(cmd: &str) -> Option<PathBuf> {
    which::which(cmd).ok()
}

/// Resolve a binary agent's user-installed CLI (e.g. `cursor-agent` from
/// Cursor's official install script, a brew `opencode`, or a custom agent's
/// own tool). Every binary agent may fall back to this when nothing is
/// cached — the managed cache always wins, the system CLI only fills the
/// gap, mirroring how npx agents already prefer a PATH install at launch.
/// Checks PATH first, then `~/.local/bin` — a common install-script target
/// a macOS GUI app's PATH typically lacks.
pub(crate) fn resolve_system_agent_binary(cmd: &str) -> Option<PathBuf> {
    if let Some(path) = resolve_command_on_path(cmd) {
        return Some(path);
    }
    let exe = if cfg!(windows) {
        format!("{cmd}.exe")
    } else {
        cmd.to_string()
    };
    let cand = home_dir_or_default().join(".local").join("bin").join(exe);
    cand.is_file().then_some(cand)
}

/// [`resolve_system_agent_binary`] plus the agent's own installer directories
/// (see [`registry::binary_system_dirs`]).
///
/// The agent-aware form exists because a vendor installer can target a
/// directory that is neither on PATH nor `~/.local/bin` — OpenCode's is
/// `~/.opencode/bin` — and appending it to the shell rc does not help a desktop
/// app launched from Finder or the Dock. Ordered last, so a codeg-managed copy
/// and anything genuinely on PATH still win.
pub(crate) fn resolve_system_agent_binary_for(agent_type: AgentType, cmd: &str) -> Option<PathBuf> {
    if let Some(path) = resolve_system_agent_binary(cmd) {
        return Some(path);
    }
    let exe = if cfg!(windows) {
        format!("{cmd}.exe")
    } else {
        cmd.to_string()
    };
    let home = home_dir_or_default();
    registry::binary_system_dirs(agent_type).iter().find_map(|dir| {
        let cand = home.join(dir).join(&exe);
        cand.is_file().then_some(cand)
    })
}

/// Resolve the VENDOR CLI wrapped by an ACP adapter agent (`claude`, `codex`
/// — see [`registry::acp_adapter_relation`]). codeg never launches this: it is
/// probed purely so preflight/diagnostics can say "we found your own CLI, but
/// it doesn't speak ACP" instead of a bare "not installed".
///
/// Widest resolution of the three probes, because a false negative here loses
/// the most convincing evidence: PATH + the npm global prefix (the GUI-PATH-gap
/// fallback `resolve_npx_command` already implements), then `~/.local/bin` via
/// [`resolve_system_agent_binary`], then the vendor installers' own dirs.
pub(crate) async fn resolve_vendor_cli(cmd: &str, extra_dirs: &[&str]) -> Option<PathBuf> {
    if let Some(path) = resolve_npx_command(cmd).await {
        return Some(path);
    }
    if let Some(path) = resolve_system_agent_binary(cmd) {
        return Some(path);
    }
    let exe = if cfg!(windows) {
        format!("{cmd}.exe")
    } else {
        cmd.to_string()
    };
    let home = home_dir_or_default();
    extra_dirs.iter().find_map(|dir| {
        let cand = home.join(dir).join(&exe);
        cand.is_file().then_some(cand)
    })
}

/// Resolve the `uvx` (uv tool runner) executable used to launch Python ACP
/// agents (e.g. Hermes). Checks PATH first (respecting a user's own `uv`),
/// then codeg's managed uv cache, then the common install locations the
/// official `uv` installer / cargo use (`~/.local/bin`, `~/.cargo/bin`).
pub(crate) fn resolve_uvx_command() -> Option<PathBuf> {
    if let Some(path) = resolve_command_on_path("uvx") {
        return Some(path);
    }
    if let Some(path) = crate::acp::binary_cache::find_cached_uv_tool("uvx") {
        return Some(path);
    }
    let exe = if cfg!(windows) { "uvx.exe" } else { "uvx" };
    let home = home_dir_or_default();
    for dir in [home.join(".local").join("bin"), home.join(".cargo").join("bin")] {
        let cand = dir.join(exe);
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// Whether a `Uvx` agent can actually be launched on this machine right now:
/// the `uvx` runner is resolvable (codeg auto-provisions it on install, so this
/// holds post-prepare), or the agent's own CLI is on PATH (system fallback).
/// The connect gate (`verify_agent_installed`) and the Settings status/list
/// paths all use this so they agree on readiness. Note: the prepared-version
/// marker is deliberately NOT consulted here — it records what was fetched (for
/// the installed-version badge), not whether the launcher is currently present.
fn uvx_agent_launchable(system_cmd: Option<(&'static str, &'static [&'static str])>) -> bool {
    resolve_uvx_command().is_some()
        || system_cmd
            .map(|(c, _)| resolve_command_on_path(c).is_some())
            .unwrap_or(false)
}

/// The `uvx` flags that pin the interpreter for a `Uvx` agent, inserted before
/// `--from`. Returns `["--python", <ver>]` when the distribution sets a
/// `python` pin, else an empty vec. Centralizes the pin so every uvx invocation
/// (launch, prewarm, setup/model guidance) stays consistent.
pub(crate) fn uvx_python_args(python: Option<&str>) -> Vec<String> {
    match python {
        Some(ver) => vec!["--python".to_string(), ver.to_string()],
        None => Vec::new(),
    }
}

/// The version to display for a `Uvx` agent, shared by `detect_local_version`
/// and the status/list paths so they can't disagree: codeg's prepared marker
/// first, then the package's console script on PATH, then the system-fallback
/// command a launch would actually use (a pipx / `uv tool install` CLI).
async fn uvx_displayed_version(
    agent_type: AgentType,
    cmd: &str,
    system_cmd: Option<(&'static str, &'static [&'static str])>,
) -> Option<String> {
    let mut version = binary_cache::uvx_prepared_version(agent_type);
    if version.is_none() {
        let bin = resolve_command_on_path(cmd)
            .or_else(|| system_cmd.and_then(|(c, _)| resolve_command_on_path(c)));
        if let Some(bin) = bin {
            version = system_probed_version(agent_type, &bin, None).await;
        }
    }
    version
}

/// Pre-fetch a `Uvx` agent's pinned package into uvx's cache by running
/// `uvx --from <package> <cmd> --version`, so the first real connect doesn't
/// pay the download cost. Streams progress to the install event stream.
async fn prewarm_uvx_agent(
    agent_name: &str,
    package: &str,
    cmd: &str,
    python: Option<&str>,
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    // uv must already be installed; provision it separately via the "Install
    // uv" preflight action. We deliberately do NOT auto-install it here so the
    // two steps stay separate — the Settings UI disables this agent-install
    // action until uv is ready, so a normal user never reaches this error.
    let uvx = resolve_uvx_command().ok_or_else(|| {
        AcpError::SdkNotInstalled("uv is not installed; install the uv runtime first".to_string())
    })?;
    let python_args = uvx_python_args(python);
    let python_display = if python_args.is_empty() {
        String::new()
    } else {
        format!("{} ", python_args.join(" "))
    };
    emit_agent_install_event(
        emitter,
        task_id,
        AgentInstallEventKind::Log,
        format!("$ uvx {python_display}--from {package} {cmd} --version"),
    );
    let output = crate::process::tokio_command(&uvx)
        .args(&python_args)
        .arg("--from")
        .arg(package)
        .arg(cmd)
        .arg("--version")
        .output()
        .await
        .map_err(|e| AcpError::SpawnFailed(format!("failed to run uvx: {e}")))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    for line in stderr.lines().chain(stdout.lines()) {
        if !line.trim().is_empty() {
            emit_agent_install_event(
                emitter,
                task_id,
                AgentInstallEventKind::Log,
                line.to_string(),
            );
        }
    }
    if !output.status.success() {
        return Err(AcpError::protocol(format!(
            "uvx prepare for {agent_name} failed: {}",
            stderr.lines().last().unwrap_or("unknown error")
        )));
    }
    Ok(())
}

pub(crate) async fn resolve_npx_command(cmd: &str) -> Option<PathBuf> {
    if let Some(path) = resolve_command_on_path(cmd) {
        return Some(path);
    }
    resolve_npx_command_from_current_npm_prefix(cmd).await
}

#[derive(Default)]
struct NpxCommandResolver {
    per_cmd_cache: HashMap<String, Option<PathBuf>>,
    request_npm_prefix: Option<Option<PathBuf>>,
}

impl NpxCommandResolver {
    async fn resolve_for_list(&mut self, cmd: &str) -> Option<PathBuf> {
        if let Some(cached) = self.per_cmd_cache.get(cmd) {
            return cached.clone();
        }

        let resolved = if let Some(path) = resolve_command_on_path(cmd) {
            Some(path)
        } else {
            let prefix = if let Some(prefix) = &self.request_npm_prefix {
                prefix.clone()
            } else {
                let resolved_prefix = cached_npm_global_prefix().await;
                self.request_npm_prefix = Some(resolved_prefix.clone());
                resolved_prefix
            };
            prefix.and_then(|p| resolve_npx_command_from_npm_prefix(cmd, &p))
        };

        self.per_cmd_cache.insert(cmd.to_string(), resolved.clone());
        resolved
    }
}

async fn resolve_npx_command_from_current_npm_prefix(cmd: &str) -> Option<PathBuf> {
    let prefix = cached_npm_global_prefix().await?;
    resolve_npx_command_from_npm_prefix(cmd, &prefix)
}

pub(crate) async fn cached_npm_global_prefix() -> Option<PathBuf> {
    cached_npm_global_prefix_with(&NPM_GLOBAL_PREFIX_CACHE, resolve_current_npm_global_prefix).await
}

async fn cached_npm_global_prefix_with<F, Fut>(
    cache: &tokio::sync::OnceCell<PathBuf>,
    resolve: F,
) -> Option<PathBuf>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Option<PathBuf>>,
{
    if let Some(prefix) = cache.get() {
        return Some(prefix.clone());
    }

    let resolved = resolve().await?;
    match cache.set(resolved.clone()) {
        Ok(()) => Some(resolved),
        Err(_) => cache.get().cloned(),
    }
}

async fn resolve_current_npm_global_prefix() -> Option<PathBuf> {
    let npm_path = which::which("npm").ok()?;
    let mut cmd = crate::process::tokio_command(npm_path);
    cmd.arg("prefix").arg("-g").kill_on_drop(true);
    let output = tokio::time::timeout(NPM_PREFIX_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    npm_global_prefix_from_stdout(&output.stdout)
}

fn npm_global_prefix_from_stdout(stdout: &[u8]) -> Option<PathBuf> {
    let stdout_text = String::from_utf8_lossy(stdout);
    let prefix = stdout_text.lines().next()?.trim();
    if prefix.is_empty() {
        return None;
    }
    Some(PathBuf::from(prefix))
}

fn npm_prefix_bin_dir(prefix: &Path) -> PathBuf {
    if cfg!(windows) {
        prefix.to_path_buf()
    } else {
        prefix.join("bin")
    }
}

fn resolve_npx_command_from_npm_prefix(cmd: &str, prefix: &Path) -> Option<PathBuf> {
    let bin_dir = npm_prefix_bin_dir(prefix);

    #[cfg(windows)]
    let candidates = [
        bin_dir.join(format!("{cmd}.cmd")),
        bin_dir.join(format!("{cmd}.exe")),
        bin_dir.join(cmd),
    ];

    #[cfg(not(windows))]
    let candidates = [bin_dir.join(cmd)];

    candidates
        .into_iter()
        .find(|path| is_npm_command_candidate(path))
}

#[cfg(windows)]
fn is_npm_command_candidate(path: &Path) -> bool {
    path.is_file()
}

#[cfg(not(windows))]
fn is_npm_command_candidate(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.is_file()
        && path
            .metadata()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
}

/// Verify that the agent SDK / binary is installed and usable.
///
/// This is the pre-spawn guard used by the session-page connect path:
/// the session page must NEVER trigger a download or install, so if the
/// agent isn't ready we return `AcpError::SdkNotInstalled` immediately
/// and let the frontend prompt the user to install from Agent Settings.
///
/// For NPX agents: checks the command is spawnable in this process environment.
/// For Binary agents: checks platform support and that the binary is
/// already cached locally.
pub(crate) async fn verify_agent_installed(agent_type: AgentType) -> Result<(), AcpError> {
    let meta = registry::get_agent_meta(agent_type);
    match meta.distribution {
        registry::AgentDistribution::Npx { cmd, .. } => {
            if !is_cmd_available(cmd).await {
                // INVARIANT: the substring "is not installed" is matched
                // verbatim by the frontend catch block in
                // `src/contexts/acp-connections-context.tsx` to surface a
                // localized install prompt. Do not change the wording.
                return Err(AcpError::SdkNotInstalled(format!(
                    "{} is not installed. Please install it in Agent Settings.",
                    meta.name
                )));
            }
            Ok(())
        }
        registry::AgentDistribution::Binary { cmd, platforms, .. } => {
            let platform = registry::current_platform();
            if !platforms.iter().any(|p| p.platform == platform) {
                return Err(AcpError::PlatformNotSupported(format!(
                    "{} is not available on {platform}",
                    meta.name
                )));
            }
            // Accept any cached version — the Settings page will still
            // surface "upgrade available" for stale caches via its own
            // version-badge flow. A user-installed CLI also counts, the same
            // fallback `build_agent` launches with.
            let launchable = binary_cache::find_best_cached_binary_for_agent(agent_type, cmd)?
                .is_some()
                || resolve_system_agent_binary_for(agent_type, cmd).is_some();
            if !launchable {
                // INVARIANT: see note above — "is not installed" is a
                // stable substring the frontend matches against.
                return Err(AcpError::SdkNotInstalled(format!(
                    "{} is not installed. Please install it in Agent Settings.",
                    meta.name
                )));
            }
            Ok(())
        }
        registry::AgentDistribution::Uvx { system_cmd, .. } => {
            // Launchable when uvx is resolvable (codeg auto-provisions it on
            // install, so this holds post-prepare) or the agent's own CLI is on
            // PATH. Kept consistent with the Settings status/list paths via the
            // shared helper, so connect and the UI never disagree on readiness.
            if uvx_agent_launchable(system_cmd) {
                Ok(())
            } else {
                Err(AcpError::SdkNotInstalled(format!(
                    "{} is not installed. Please install it in Agent Settings.",
                    meta.name
                )))
            }
        }
    }
}

/// Detect the actual installed version of an npm global package by running
/// `npm list -g <package_name> --json` and parsing the JSON output.
///
/// Checks both the system global prefix and the user-local prefix
/// (`~/.codeg/npm-global/`) so packages installed via the EACCES fallback are
/// found as well.
///
/// `pub(crate)` so env diagnostics can report the installed version it sees
/// (which covers both prefixes, unlike the connect-gate `resolve_npx_command`).
pub(crate) async fn detect_npm_global_version(package_name: &str) -> Option<String> {
    let npm_path = which::which("npm").ok()?;

    // Try the default global prefix first.
    if let Some(v) = npm_list_version(&npm_path, package_name, None).await {
        return Some(v);
    }

    // Fallback: check the user-local prefix.
    if let Some(prefix) = crate::process::user_npm_prefix() {
        if prefix.exists() {
            return npm_list_version(&npm_path, package_name, Some(&prefix)).await;
        }
    }

    None
}

/// Run `npm list -g <package_name> --json [--prefix=<p>]` and extract the
/// installed version string.
async fn npm_list_version(
    npm_path: &std::path::Path,
    package_name: &str,
    prefix: Option<&std::path::Path>,
) -> Option<String> {
    let mut cmd = crate::process::tokio_command(npm_path);
    cmd.arg("list")
        .arg("-g")
        .arg(package_name)
        .arg("--json")
        .arg("--depth=0");
    if let Some(p) = prefix {
        cmd.arg(format!("--prefix={}", p.display()));
    }
    // `kill_on_drop` so a caller that bounds this with `tokio::time::timeout`
    // (e.g. env diagnostics) actually terminates a hung `npm list` child rather
    // than orphaning it. No effect on the normal path, which awaits to completion.
    cmd.kill_on_drop(true);
    let output = cmd.output().await.ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let json: serde_json::Value = serde_json::from_str(&stdout).ok()?;
    let version = json
        .get("dependencies")?
        .get(package_name)?
        .get("version")?
        .as_str()?;
    normalize_version_candidate(version)
}

async fn detect_local_version(agent_type: AgentType) -> Option<String> {
    let meta = registry::get_agent_meta(agent_type);
    match meta.distribution {
        registry::AgentDistribution::Npx { cmd, package, .. } => {
            let resolved = resolve_npx_command(cmd).await?;
            // Try `npm list -g <package_name> --json` to get the real installed version.
            let pkg_name = package_name_from_spec(package);
            let mut version = detect_npm_global_version(&pkg_name).await;
            // Same system-install probe the status/list paths run (covers
            // installs npm can't see: bun/pnpm globals, brew, …), so this
            // detection agrees with them (a disagreement here clears/flips
            // the persisted version back and forth).
            if version.is_none() {
                version = system_probed_version(agent_type, &resolved, Some(package)).await;
            }
            version
        }
        registry::AgentDistribution::Binary { cmd, dir_entry, .. } => {
            let cached = binary_cache::detect_installed_version(agent_type, cmd)
                .ok()
                .flatten();
            if cached.is_some() {
                return cached;
            }
            // A user-installed CLI (no codeg cache) still reports a version
            // via `<cmd> --version` (e.g. cursor-agent → "2026.07.20-8cc9c0b").
            // Mirrors the status/list paths — missing a fallback here would
            // CLEAR the persisted system version below and the next list
            // would write it back, churning events forever.
            if dir_entry.is_some() {
                return system_dir_agent_version(cmd).await;
            }
            let bin = resolve_system_agent_binary_for(agent_type, cmd)?;
            system_probed_version(agent_type, &bin, None).await
        }
        registry::AgentDistribution::Uvx {
            cmd, system_cmd, ..
        } => uvx_displayed_version(agent_type, cmd, system_cmd).await,
    }
}

// ============================================================================
// Environment diagnostics (`acp_env_diagnostics`)
//
// Runs a set of READ-ONLY probes IN THE APP PROCESS (so they reflect the PATH
// the GUI app actually sees — which differs from the user's terminal PATH and
// is the root of most "installed but shows not-installed" reports). Never
// mutates PATH; never dumps arbitrary env (only a safe whitelist, redacted).
// Split into an impure `collect_diag_inputs` and a pure `build_report` so the
// verdict heuristic and rendering are unit-testable without shelling out.
// ============================================================================

/// Per-probe timeout for the external commands diagnostics runs.
const DIAG_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Env var keys whose *values* are safe to surface in a copyable report. Chosen
/// so none carry credentials; still run through [`redact_secret`] defensively.
const DIAG_SAFE_ENV_KEYS: &[&str] = &[
    "SHELL",
    "NVM_DIR",
    "FNM_DIR",
    "FNM_MULTISHELL_PATH",
    "VOLTA_HOME",
    "ASDF_DATA_DIR",
    "MISE_DATA_DIR",
    "N_PREFIX",
    "HOMEBREW_PREFIX",
    "npm_config_prefix",
    "LANG",
];

/// Mask a value that may contain a secret, keyed on the env var *name*. If the
/// name looks credential-bearing the value is partially masked; otherwise it is
/// returned verbatim. Multibyte-safe (masks by `char`, mirroring the approach in
/// `models::model_provider::mask_api_key`) so it never panics on a UTF-8 value.
fn redact_secret(key: &str, value: &str) -> String {
    let lower = key.to_ascii_lowercase();
    let secretish = ["key", "token", "secret", "password", "passwd", "auth", "credential"]
        .iter()
        .any(|needle| lower.contains(needle));
    if !secretish {
        return value.to_string();
    }
    let chars: Vec<char> = value.chars().collect();
    let len = chars.len();
    if len == 0 {
        return String::new();
    }
    if len <= 8 {
        return "•".repeat(len);
    }
    let first: String = chars[..2].iter().collect();
    let last: String = chars[len - 2..].iter().collect();
    format!("{first}{}{last}", "•".repeat(len.saturating_sub(4).min(16)))
}

/// npm places a package's bin as `<cmd>.cmd` on Windows, bare `<cmd>` elsewhere.
fn diag_exe_name(cmd: &str) -> String {
    if cfg!(windows) {
        format!("{cmd}.cmd")
    } else {
        cmd.to_string()
    }
}

#[derive(Default, Clone)]
struct CmdProbe {
    /// Absolute path `which` resolved to, if any (same resolution the connect
    /// gate uses).
    path: Option<String>,
    /// First `--version`/`-v` output line, if the command ran.
    version: Option<String>,
}

#[derive(Default, Clone)]
struct AgentDiag {
    name: String,
    cmd: String,
    distribution: &'static str,
    package: Option<String>,
    node_required: Option<String>,
    /// Distribution-appropriate launchability, mirroring `verify_agent_installed`:
    /// npx → `resolve_npx_command`; binary → cached/system binary; uvx →
    /// `uvx_agent_launchable`. `None` = the agent cannot launch right now. This
    /// (NOT `resolve_npx`) is what the verdict uses for non-npx agents, so a
    /// working cached-binary / uvx agent is not misreported as node-missing.
    launchable: Option<String>,
    /// `resolve_npx_command(cmd)` — the resolution the new-session page gates on
    /// (npx agents only; `None` for binary/uvx).
    resolve_npx: Option<String>,
    /// `<npm prefix -g>/bin/<cmd>` when it exists.
    system_prefix_bin: Option<String>,
    /// `~/.codeg/npm-global/bin/<cmd>` (EACCES fallback) when it exists.
    user_prefix_bin: Option<String>,
    /// Homebrew global bin (`/opt/homebrew/bin/<cmd>` etc.) when it exists (macOS).
    homebrew_bin: Option<String>,
    /// Version seen by `detect_npm_global_version` (covers BOTH prefixes).
    detected_version: Option<String>,
    /// `agent_setting.installed_version` recorded in the DB.
    db_version: Option<String>,
    /// Set only for ACP *adapter* agents (Claude Code, Codex): the vendor CLI
    /// the user probably already installed, which codeg does NOT launch. See
    /// [`registry::acp_adapter_relation`].
    adapter: Option<AdapterProbe>,
}

/// The vendor CLI behind an adapter agent, probed so the report can say "we
/// found your own `claude`, but codeg launches `claude-agent-acp`" instead of a
/// bare "not installed" the user reads as plain wrong.
#[derive(Default, Clone)]
struct AdapterProbe {
    /// e.g. "claude".
    native_cmd: String,
    /// Where the vendor CLI resolved, if anywhere.
    native_path: Option<String>,
    /// First `--version` line of the vendor CLI (bounded probe).
    native_version: Option<String>,
    /// Config dir shared by the vendor CLI and the adapter.
    shared_config_dir: String,
}

#[derive(Default, Clone)]
struct TerminalProbe {
    /// The login-shell probe actually ran and produced output.
    ran: bool,
    /// Dirs in the login-shell PATH that are ABSENT from the app PATH — the
    /// smoking gun for a GUI PATH gap.
    extra_dirs: Vec<String>,
    /// `command -v <cmd>` result in the login shell.
    cmd_resolved: Option<String>,
    /// Why the probe didn't run (Windows / no `$SHELL` / timeout).
    note: Option<String>,
}

#[derive(Default, Clone)]
struct DiagInputs {
    os: String,
    arch: String,
    app_version: String,
    app_path: Vec<String>,
    path_logs: Vec<String>,
    node: CmdProbe,
    npm: CmdProbe,
    npx: CmdProbe,
    npm_prefix_g: Option<String>,
    npm_prefix_g_ms: u128,
    npm_root_g: Option<String>,
    npm_config_prefix: Option<String>,
    cached_prefix: Option<String>,
    /// (candidate bin dir, whether it contains a `node` binary).
    node_candidates: Vec<(String, bool)>,
    selected_node_dir: Option<String>,
    safe_env: Vec<(String, String)>,
    agent: Option<AgentDiag>,
    terminal: TerminalProbe,
}

/// Run a command with a timeout and return its first non-empty stdout line.
async fn diag_run(program: &Path, args: &[&str]) -> Option<String> {
    let mut cmd = crate::process::tokio_command(program);
    cmd.args(args).kill_on_drop(true);
    let out = tokio::time::timeout(DIAG_PROBE_TIMEOUT, cmd.output())
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines().find_map(|l| {
        let t = l.trim();
        (!t.is_empty()).then(|| t.to_string())
    })
}

/// Resolve a command on the app PATH and probe its version.
async fn diag_cmd_probe(cmd: &str, version_args: &[&str]) -> CmdProbe {
    let path = resolve_command_on_path(cmd);
    let version = match &path {
        Some(p) => diag_run(p, version_args).await,
        None => None,
    };
    CmdProbe {
        path: path.map(|p| p.to_string_lossy().to_string()),
        version,
    }
}

/// Major version from `v20.11.1` / `20.11.1`.
fn parse_node_major(v: &str) -> Option<u64> {
    v.trim().trim_start_matches('v').split('.').next()?.parse().ok()
}

/// Compare the user's login-shell PATH against the app PATH. Unix-only; on
/// Windows it returns a note (npm bins there are `.cmd` in the prefix root and a
/// robust login-shell probe is out of scope for v1).
#[cfg(not(windows))]
async fn diag_terminal_probe(cmd: &str, app_path: &[String]) -> TerminalProbe {
    let mut probe = TerminalProbe::default();
    let shell = match std::env::var("SHELL") {
        Ok(s) if !s.trim().is_empty() => s,
        _ => {
            probe.note = Some("$SHELL not set".to_string());
            return probe;
        }
    };
    // `cmd` is a static registry command name — no shell metacharacters.
    let script =
        format!("printf 'CODEG_PATH=%s\\n' \"$PATH\"; command -v {cmd} 2>/dev/null || true");
    let mut c = crate::process::tokio_command(&shell);
    c.arg("-lic").arg(&script).kill_on_drop(true);
    let out = match tokio::time::timeout(DIAG_PROBE_TIMEOUT, c.output()).await {
        Ok(Ok(o)) => o,
        _ => {
            probe.note = Some("login shell probe timed out or failed".to_string());
            return probe;
        }
    };
    probe.ran = true;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut term_path: Option<String> = None;
    for line in stdout.lines() {
        if let Some(p) = line.strip_prefix("CODEG_PATH=") {
            term_path = Some(p.to_string());
        } else if line.starts_with('/') && probe.cmd_resolved.is_none() {
            probe.cmd_resolved = Some(line.trim().to_string());
        }
    }
    if let Some(tp) = term_path {
        let app_set: std::collections::HashSet<&str> = app_path.iter().map(String::as_str).collect();
        let mut seen = std::collections::HashSet::new();
        probe.extra_dirs = tp
            .split(':')
            .filter(|d| !d.is_empty() && !app_set.contains(*d))
            .filter(|d| seen.insert(d.to_string()))
            .map(String::from)
            .collect();
    }
    probe
}

#[cfg(windows)]
async fn diag_terminal_probe(_cmd: &str, _app_path: &[String]) -> TerminalProbe {
    TerminalProbe {
        note: Some("Windows: compare PATH manually in PowerShell".to_string()),
        ..Default::default()
    }
}

/// Per-agent resolution probes (the core signals for the not-installed symptom).
async fn collect_agent_diag(
    db: &AppDatabase,
    agent_type: AgentType,
    npm_prefix_g: Option<&str>,
) -> AgentDiag {
    let meta = registry::get_agent_meta(agent_type);

    let db_version = agent_setting_service::get_by_agent_type(&db.conn, agent_type)
        .await
        .ok()
        .flatten()
        .and_then(|m| m.installed_version);

    let mut diag = AgentDiag {
        name: meta.name.to_string(),
        db_version,
        ..Default::default()
    };

    // Each distribution resolves launchability differently — mirror the exact
    // gates `verify_agent_installed` uses so the report agrees with connect.
    match meta.distribution {
        registry::AgentDistribution::Npx {
            cmd,
            package,
            node_required,
            ..
        } => {
            diag.cmd = cmd.to_string();
            diag.distribution = "npx";
            diag.package = Some(package.to_string());
            diag.node_required = node_required.map(str::to_string);

            let resolve_npx = resolve_npx_command(cmd)
                .await
                .map(|p| p.to_string_lossy().to_string());
            diag.launchable = resolve_npx.clone();
            diag.resolve_npx = resolve_npx;

            diag.system_prefix_bin = npm_prefix_g.and_then(|p| {
                let cand = npm_prefix_bin_dir(Path::new(p)).join(diag_exe_name(cmd));
                cand.is_file().then(|| cand.to_string_lossy().to_string())
            });
            diag.user_prefix_bin = crate::process::user_npm_prefix().and_then(|prefix| {
                let cand = npm_prefix_bin_dir(&prefix).join(diag_exe_name(cmd));
                cand.is_file().then(|| cand.to_string_lossy().to_string())
            });
            diag.homebrew_bin = if cfg!(target_os = "macos") {
                ["/opt/homebrew/bin", "/usr/local/bin"].iter().find_map(|d| {
                    let cand = Path::new(d).join(diag_exe_name(cmd));
                    cand.is_file().then(|| cand.to_string_lossy().to_string())
                })
            } else {
                None
            };
            // `npm list` can hang on a stalled global prefix; bound it (the child
            // is killed on drop via `npm_list_version`'s `kill_on_drop`).
            diag.detected_version = tokio::time::timeout(
                DIAG_PROBE_TIMEOUT,
                detect_npm_global_version(&package_name_from_spec(package)),
            )
            .await
            .ok()
            .flatten();

            // Adapter agents only: locate the vendor CLI the user installed
            // themselves. Unlike preflight (path-only, runs on every Settings
            // open) this report is on demand, so it can afford `--version` —
            // naming the exact build is what makes "we DID see your CLI" land.
            if let Some(relation) = registry::acp_adapter_relation(agent_type) {
                let native_path = resolve_vendor_cli(relation.native_cmd, relation.extra_dirs).await;
                let native_version = match &native_path {
                    Some(p) => diag_run(p, &["--version"]).await,
                    None => None,
                };
                diag.adapter = Some(AdapterProbe {
                    native_cmd: relation.native_cmd.to_string(),
                    native_path: native_path.map(|p| p.to_string_lossy().to_string()),
                    native_version,
                    shared_config_dir: relation.shared_config_dir.to_string(),
                });
            }
        }
        registry::AgentDistribution::Binary { cmd, platforms, .. } => {
            diag.cmd = cmd.to_string();
            diag.distribution = "binary";
            // Mirror verify_agent_installed exactly: it first rejects unsupported
            // platforms, then evaluates
            // `find_best_cached_binary_for_agent(..)?.is_some() || system`. So
            // an unsupported platform — and a cache-read *error* — both FAIL
            // the gate (the latter propagated via `?`) rather than falling
            // through to the system binary. Reflect both here so diagnostics
            // never reports "ok" for a case where connect errors out.
            let supported = platforms
                .iter()
                .any(|p| p.platform == registry::current_platform());
            diag.launchable = if !supported {
                None
            } else {
                match binary_cache::find_best_cached_binary_for_agent(agent_type, cmd) {
                    Ok(Some((path, _version))) => Some(path),
                    Ok(None) => resolve_system_agent_binary_for(agent_type, cmd),
                    Err(_) => None,
                }
                .map(|p| p.to_string_lossy().to_string())
            };
        }
        registry::AgentDistribution::Uvx {
            cmd,
            package,
            system_cmd,
            ..
        } => {
            diag.cmd = cmd.to_string();
            diag.distribution = "uvx";
            diag.package = Some(package.to_string());
            diag.launchable = uvx_agent_launchable(system_cmd).then(|| {
                resolve_uvx_command()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("{cmd} (system CLI on PATH)"))
            });
        }
    }

    diag
}

/// Gather all diagnostics signals (impure: runs commands / reads env, fs, DB).
async fn collect_diag_inputs(db: &AppDatabase, agent_type: Option<AgentType>) -> DiagInputs {
    let mut inp = DiagInputs {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        ..Default::default()
    };

    if let Some(path_os) = std::env::var_os("PATH") {
        inp.app_path = std::env::split_paths(&path_os)
            .map(|p| p.to_string_lossy().to_string())
            .collect();
    }

    inp.path_logs = crate::commands::logging::get_recent_logs_core(20, None, Some("[PATH]"))
        .into_iter()
        .map(|r| r.message)
        .collect();

    inp.node = diag_cmd_probe("node", &["-v"]).await;
    inp.npm = diag_cmd_probe("npm", &["-v"]).await;
    inp.npx = diag_cmd_probe("npx", &["-v"]).await;

    if let Some(npm_path) = resolve_command_on_path("npm") {
        let start = std::time::Instant::now();
        inp.npm_prefix_g = diag_run(&npm_path, &["prefix", "-g"]).await;
        inp.npm_prefix_g_ms = start.elapsed().as_millis();
        inp.npm_root_g = diag_run(&npm_path, &["root", "-g"]).await;
        inp.npm_config_prefix = diag_run(&npm_path, &["config", "get", "prefix"]).await;
    }
    inp.cached_prefix = cached_npm_global_prefix()
        .await
        .map(|p| p.to_string_lossy().to_string());

    let home = home_dir_or_default();
    let node_bin = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in crate::process::node_bin_dir_candidates(Some(home.as_path())) {
        let has_node = dir.join(node_bin).is_file();
        let dir_str = dir.to_string_lossy().to_string();
        if has_node && inp.selected_node_dir.is_none() {
            inp.selected_node_dir = Some(dir_str.clone());
        }
        inp.node_candidates.push((dir_str, has_node));
    }

    for &key in DIAG_SAFE_ENV_KEYS {
        if let Ok(val) = std::env::var(key) {
            if !val.trim().is_empty() {
                inp.safe_env.push((key.to_string(), redact_secret(key, &val)));
            }
        }
    }

    if let Some(at) = agent_type {
        let agent = collect_agent_diag(db, at, inp.npm_prefix_g.as_deref()).await;
        inp.terminal = diag_terminal_probe(&agent.cmd, &inp.app_path).await;
        inp.agent = Some(agent);
    }

    inp
}

fn diag_check(label: &str, value: &str, status: DiagLevel, hint: Option<&str>) -> DiagCheck {
    DiagCheck {
        label: label.to_string(),
        value: value.to_string(),
        status,
        hint: hint.map(str::to_string),
    }
}

fn diag_verdict(level: DiagLevel, code: &str, summary: &str) -> DiagnosticsVerdict {
    DiagnosticsVerdict {
        level,
        code: code.to_string(),
        summary: summary.to_string(),
    }
}

/// Pure: derive the one-line "likely cause" from gathered inputs.
fn compute_verdict(inp: &DiagInputs) -> DiagnosticsVerdict {
    let agent = match &inp.agent {
        None => {
            // Base environment report — Node/npm health only.
            if inp.node.path.is_none() {
                return diag_verdict(
                    DiagLevel::Fail,
                    "node_missing",
                    "Node.js was not found on the app's PATH.",
                );
            }
            if inp.npm.path.is_none() {
                return diag_verdict(
                    DiagLevel::Fail,
                    "npm_missing",
                    "npm was not found on the app's PATH.",
                );
            }
            return diag_verdict(
                DiagLevel::Ok,
                "ok",
                "The base Node.js environment looks healthy.",
            );
        }
        Some(a) => a,
    };

    // Binary/Uvx agents do not depend on Node/npm — judge them by their own
    // launch gate so a working cached-binary / uvx agent is never misreported.
    if agent.distribution != "npx" {
        if agent.launchable.is_some() {
            return diag_verdict(
                DiagLevel::Ok,
                "ok",
                "The agent is launchable — the environment looks healthy.",
            );
        }
        if agent.db_version.is_some() {
            return diag_verdict(
                DiagLevel::Fail,
                "installed_but_unresolved",
                "The agent is recorded as installed, but the app cannot locate its runtime.",
            );
        }
        return diag_verdict(
            DiagLevel::Info,
            "not_installed",
            "This agent does not appear to be installed.",
        );
    }

    // NPX agents: Node/npm-aware heuristic.
    if inp.node.path.is_none() {
        return diag_verdict(
            DiagLevel::Fail,
            "node_missing",
            "Node.js was not found on the app's PATH.",
        );
    }
    if inp.npm.path.is_none() {
        return diag_verdict(
            DiagLevel::Fail,
            "npm_missing",
            "npm was not found on the app's PATH.",
        );
    }

    if let (Some(req), Some(ver)) = (agent.node_required.as_deref(), inp.node.version.as_deref()) {
        if let (Some(rmaj), Some(nmaj)) = (parse_node_major(req), parse_node_major(ver)) {
            if nmaj < rmaj {
                return diag_verdict(
                    DiagLevel::Fail,
                    "node_too_old",
                    "The active Node.js is older than this agent requires.",
                );
            }
        }
    }

    if agent.resolve_npx.is_none() {
        // An ACP adapter agent that was never installed is the single most
        // reported "bug": the user has the vendor CLI and reads "not installed"
        // as codeg failing to see it. Answer the question they're actually
        // asking, before the generic not-installed verdict. Node problems above
        // still win — those block the adapter install itself.
        if let Some(adapter) = &agent.adapter {
            if agent.db_version.is_none() && agent.detected_version.is_none() {
                return if adapter.native_path.is_some() {
                    diag_verdict(
                        DiagLevel::Info,
                        "adapter_missing_native_present",
                        "Your own vendor CLI is installed, but codeg launches a separate ACP adapter, which is not.",
                    )
                } else {
                    diag_verdict(
                        DiagLevel::Info,
                        "adapter_missing",
                        "codeg launches a separate ACP adapter for this agent, which is not installed.",
                    )
                };
            }
        }
        if agent.db_version.is_some() || agent.detected_version.is_some() {
            if agent.user_prefix_bin.is_some() {
                return diag_verdict(
                    DiagLevel::Fail,
                    "user_prefix_not_on_path",
                    "Installed into the EACCES fallback prefix (~/.codeg/npm-global), which is not on the app's PATH.",
                );
            }
            if agent.homebrew_bin.is_some() {
                return diag_verdict(
                    DiagLevel::Fail,
                    "homebrew_bin_not_on_path",
                    "Installed under Homebrew's bin, which is not on the app's PATH (Apple Silicon keg split).",
                );
            }
            if inp.terminal.cmd_resolved.is_some() {
                return diag_verdict(
                    DiagLevel::Fail,
                    "terminal_only_path",
                    "The command resolves in your terminal but not in the app process — a GUI PATH gap.",
                );
            }
            if inp.npm_prefix_g_ms > NPM_PREFIX_TIMEOUT.as_millis() {
                return diag_verdict(
                    DiagLevel::Warn,
                    "npm_prefix_timeout",
                    "`npm prefix -g` exceeded the 1.5s probe timeout, so fallback resolution was skipped.",
                );
            }
            return diag_verdict(
                DiagLevel::Fail,
                "installed_but_unresolved",
                "The agent is recorded as installed, but the app cannot locate its executable.",
            );
        }
        return diag_verdict(
            DiagLevel::Info,
            "not_installed",
            "This agent does not appear to be installed.",
        );
    }

    diag_verdict(
        DiagLevel::Ok,
        "ok",
        "The agent's command resolves — the environment looks healthy.",
    )
}

/// Pure: turn gathered inputs into the structured sections + a copyable text
/// blob. `generated_at` is injected so the output is deterministic in tests.
fn build_report(
    inp: &DiagInputs,
    generated_at: String,
    agent_type: Option<AgentType>,
) -> AgentDiagnosticsReport {
    let verdict = compute_verdict(inp);
    let mut sections: Vec<DiagSection> = Vec::new();

    // 1. Runtime
    let mut runtime = vec![
        diag_check("os / arch", &format!("{} / {}", inp.os, inp.arch), DiagLevel::Info, None),
        diag_check("app version", &inp.app_version, DiagLevel::Info, None),
    ];
    let fix_failed = inp.path_logs.iter().any(|l| l.contains("fix_path_env failed"));
    runtime.push(diag_check(
        "fix_path_env",
        if fix_failed { "failed at startup" } else { "no failure logged" },
        if fix_failed { DiagLevel::Warn } else { DiagLevel::Info },
        Some("app imports the login-shell PATH at startup; a failure leaves a narrow GUI PATH"),
    ));
    for (k, v) in &inp.safe_env {
        runtime.push(diag_check(k, v, DiagLevel::Info, None));
    }
    runtime.push(diag_check(
        "PATH",
        &format!("{} entries (full list in copied text)", inp.app_path.len()),
        DiagLevel::Info,
        None,
    ));
    sections.push(DiagSection { title: "Runtime".to_string(), checks: runtime });

    // 2. Node / npm / npx
    let node_status = |p: &CmdProbe| if p.path.is_some() { DiagLevel::Ok } else { DiagLevel::Fail };
    let cmd_value = |p: &CmdProbe| match (&p.path, &p.version) {
        (Some(path), Some(ver)) => format!("{ver}  ({path})"),
        (Some(path), None) => path.clone(),
        _ => "NOT FOUND".to_string(),
    };
    sections.push(DiagSection {
        title: "Node / npm".to_string(),
        checks: vec![
            diag_check("node", &cmd_value(&inp.node), node_status(&inp.node), None),
            diag_check("npm", &cmd_value(&inp.npm), node_status(&inp.npm), None),
            diag_check("npx", &cmd_value(&inp.npx), node_status(&inp.npx), None),
        ],
    });

    // 3. npm global prefix
    let prefix_slow = inp.npm_prefix_g_ms > NPM_PREFIX_TIMEOUT.as_millis();
    sections.push(DiagSection {
        title: "npm global prefix".to_string(),
        checks: vec![
            diag_check(
                "npm prefix -g",
                &format!(
                    "{}  ({} ms)",
                    inp.npm_prefix_g.as_deref().unwrap_or("N/A"),
                    inp.npm_prefix_g_ms
                ),
                if prefix_slow { DiagLevel::Warn } else { DiagLevel::Info },
                prefix_slow.then_some("exceeds the 1.5s gate used at detection time"),
            ),
            diag_check("npm root -g", inp.npm_root_g.as_deref().unwrap_or("N/A"), DiagLevel::Info, None),
            diag_check(
                "npm config get prefix",
                inp.npm_config_prefix.as_deref().unwrap_or("N/A"),
                DiagLevel::Info,
                None,
            ),
            diag_check("cached prefix", inp.cached_prefix.as_deref().unwrap_or("N/A"), DiagLevel::Info, None),
        ],
    });

    // 4. Target agent — launchability keyed to its distribution.
    if let Some(a) = &inp.agent {
        let launch_label = match a.distribution {
            "npx" => format!("{} (resolve_npx_command)", a.cmd),
            "binary" => format!("{} (cached / system binary)", a.cmd),
            _ => format!("{} (uvx launchable)", a.cmd),
        };
        let mut checks = vec![diag_check(
            &launch_label,
            a.launchable.as_deref().unwrap_or("NOT RESOLVED"),
            if a.launchable.is_some() { DiagLevel::Ok } else { DiagLevel::Fail },
            (a.distribution == "npx").then_some("this is exactly what the new-session page checks"),
        )];
        if let Some(p) = &a.package {
            checks.push(diag_check("package", p, DiagLevel::Info, None));
        }
        // npm-prefix detail only applies to npx agents.
        if a.distribution == "npx" {
            checks.push(diag_check(
                "<npm prefix -g>/bin/<cmd>",
                a.system_prefix_bin.as_deref().unwrap_or("absent"),
                if a.system_prefix_bin.is_some() { DiagLevel::Ok } else { DiagLevel::Info },
                None,
            ));
            checks.push(diag_check(
                "~/.codeg/npm-global/bin/<cmd>",
                a.user_prefix_bin.as_deref().unwrap_or("absent"),
                if a.user_prefix_bin.is_some() { DiagLevel::Warn } else { DiagLevel::Info },
                a.user_prefix_bin.as_ref().map(|_| "EACCES fallback dir — reached by the connect gate only if it's on PATH"),
            ));
            if cfg!(target_os = "macos") {
                checks.push(diag_check(
                    "homebrew bin/<cmd>",
                    a.homebrew_bin.as_deref().unwrap_or("absent"),
                    if a.homebrew_bin.is_some() { DiagLevel::Warn } else { DiagLevel::Info },
                    None,
                ));
            }
            checks.push(diag_check(
                "detect_npm_global_version",
                a.detected_version.as_deref().unwrap_or("none"),
                DiagLevel::Info,
                Some("covers both prefixes — what the Settings badge uses"),
            ));
        }
        // Adapter agents: show the vendor CLI next to the adapter it is NOT.
        // Both rows land in `plain_text` too, so a pasted report answers the
        // "but I have claude installed" question without a round trip.
        if let Some(ad) = &a.adapter {
            checks.push(diag_check(
                &format!("{} (your own CLI)", ad.native_cmd),
                &match (&ad.native_path, &ad.native_version) {
                    (Some(path), Some(ver)) => format!("{ver}  ({path})"),
                    (Some(path), None) => path.clone(),
                    _ => "not found".to_string(),
                },
                DiagLevel::Info,
                Some(
                    "codeg never launches this — it launches the ACP adapter above, \
                     a separate package that shares the same config dir",
                ),
            ));
            checks.push(diag_check(
                "shared config dir",
                &ad.shared_config_dir,
                DiagLevel::Info,
                Some("read by BOTH your CLI and the adapter — no second login"),
            ));
        }
        checks.push(diag_check(
            "DB installed_version",
            a.db_version.as_deref().unwrap_or("none"),
            DiagLevel::Info,
            None,
        ));
        if let Some(req) = &a.node_required {
            let ok = inp
                .node
                .version
                .as_deref()
                .and_then(parse_node_major)
                .zip(parse_node_major(req))
                .map(|(n, r)| n >= r)
                .unwrap_or(true);
            checks.push(diag_check(
                "node_required",
                &format!("≥ {req}"),
                if ok { DiagLevel::Ok } else { DiagLevel::Fail },
                (!ok).then_some("the active Node.js is older than required"),
            ));
        }
        sections.push(DiagSection {
            title: format!("Agent: {} ({})", a.name, a.distribution),
            checks,
        });
    }

    // 5. Node version managers (candidate bin dirs)
    if !inp.node_candidates.is_empty() {
        let checks = inp
            .node_candidates
            .iter()
            .map(|(dir, has)| {
                let selected = inp.selected_node_dir.as_deref() == Some(dir.as_str());
                diag_check(
                    "candidate",
                    dir,
                    if *has { DiagLevel::Ok } else { DiagLevel::Info },
                    selected.then_some("← selected (first with a node binary)"),
                )
            })
            .collect();
        sections.push(DiagSection {
            title: "Node version-manager candidates".to_string(),
            checks,
        });
    }

    // 6. Terminal comparison
    let term_checks = if inp.terminal.ran {
        vec![
            diag_check(
                "command -v <cmd> (login shell)",
                inp.terminal.cmd_resolved.as_deref().unwrap_or("not found"),
                DiagLevel::Info,
                None,
            ),
            diag_check(
                "PATH dirs in terminal but not app",
                &if inp.terminal.extra_dirs.is_empty() {
                    "none".to_string()
                } else {
                    format!("{} (see copied text)", inp.terminal.extra_dirs.len())
                },
                if inp.terminal.extra_dirs.is_empty() { DiagLevel::Ok } else { DiagLevel::Warn },
                (!inp.terminal.extra_dirs.is_empty())
                    .then_some("the app can't see these dirs — the likely GUI PATH gap"),
            ),
        ]
    } else {
        vec![diag_check(
            "login shell probe",
            inp.terminal.note.as_deref().unwrap_or("did not run"),
            DiagLevel::Info,
            None,
        )]
    };
    sections.push(DiagSection { title: "Terminal comparison".to_string(), checks: term_checks });

    let plain_text = render_plain_text(inp, &verdict, &sections, &generated_at, agent_type);

    AgentDiagnosticsReport {
        generated_at,
        agent_type,
        verdict,
        sections,
        plain_text,
    }
}

/// Pure: render a copyable text report (structured checks + verbose appendices
/// that are summarized in the UI).
fn render_plain_text(
    inp: &DiagInputs,
    verdict: &DiagnosticsVerdict,
    sections: &[DiagSection],
    generated_at: &str,
    agent_type: Option<AgentType>,
) -> String {
    let glyph = |s: DiagLevel| match s {
        DiagLevel::Ok => "OK  ",
        DiagLevel::Warn => "WARN",
        DiagLevel::Fail => "FAIL",
        DiagLevel::Info => "--  ",
    };
    let mut out = String::new();
    out.push_str("===== Codeg environment diagnostics =====\n");
    out.push_str(&format!("generated: {generated_at}\n"));
    if let Some(at) = agent_type {
        out.push_str(&format!("agent: {at:?}\n"));
    }
    out.push_str(&format!("verdict [{}]: {}\n", verdict.code, verdict.summary));
    for sec in sections {
        out.push_str(&format!("\n## {}\n", sec.title));
        for c in &sec.checks {
            out.push_str(&format!("  [{}] {}: {}\n", glyph(c.status), c.label, c.value));
            if let Some(h) = &c.hint {
                out.push_str(&format!("        ↳ {h}\n"));
            }
        }
    }
    // Appendices (verbose lists shown only summarized in the UI).
    out.push_str("\n## PATH (app process, in order)\n");
    for d in &inp.app_path {
        out.push_str(&format!("  {d}\n"));
    }
    if !inp.terminal.extra_dirs.is_empty() {
        out.push_str("\n## PATH dirs in terminal but NOT in app\n");
        for d in &inp.terminal.extra_dirs {
            out.push_str(&format!("  {d}\n"));
        }
    }
    if !inp.path_logs.is_empty() {
        out.push_str("\n## recent [PATH] logs\n");
        for l in &inp.path_logs {
            out.push_str(&format!("  {l}\n"));
        }
    }
    out.push_str("===== end =====\n");
    out
}

/// Gather environment-diagnostics for the given agent (or a base env report when
/// `agent_type` is `None`). Read-only; safe to call from the session page.
pub(crate) async fn acp_env_diagnostics_core(
    db: &AppDatabase,
    agent_type: Option<AgentType>,
) -> Result<AgentDiagnosticsReport, AcpError> {
    let inputs = collect_diag_inputs(db, agent_type).await;
    let generated_at = chrono::Local::now().format("%Y-%m-%d %H:%M:%S %z").to_string();
    Ok(build_report(&inputs, generated_at, agent_type))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_env_diagnostics(
    agent_type: Option<AgentType>,
    db: State<'_, AppDatabase>,
) -> Result<AgentDiagnosticsReport, AcpError> {
    acp_env_diagnostics_core(&db, agent_type).await
}

#[cfg(test)]
mod diagnostics_tests {
    use super::*;

    fn base_inputs() -> DiagInputs {
        DiagInputs {
            node: CmdProbe {
                path: Some("/usr/bin/node".to_string()),
                version: Some("v20.11.1".to_string()),
            },
            npm: CmdProbe {
                path: Some("/usr/bin/npm".to_string()),
                version: Some("10.2.4".to_string()),
            },
            ..Default::default()
        }
    }

    fn agent_installed_unresolved() -> AgentDiag {
        AgentDiag {
            name: "Codex CLI".to_string(),
            cmd: "codex-acp".to_string(),
            distribution: "npx",
            db_version: Some("1.1.2".to_string()),
            ..Default::default()
        }
    }

    #[test]
    fn redact_only_masks_secretish_keys() {
        assert_eq!(redact_secret("NVM_DIR", "/home/u/.nvm"), "/home/u/.nvm");
        assert_eq!(redact_secret("SHELL", "/bin/zsh"), "/bin/zsh");
        // secret-ish key → masked, and multibyte-safe (no panic / no split).
        let masked = redact_secret("XAI_API_KEY", "sk-测试secret-1234567890");
        assert!(masked.contains('•'));
        assert!(!masked.contains("secret"));
        assert_eq!(redact_secret("MY_TOKEN", "abcd"), "••••");
    }

    #[test]
    fn verdict_node_missing() {
        let inp = DiagInputs::default();
        assert_eq!(compute_verdict(&inp).code, "node_missing");
    }

    #[test]
    fn verdict_ok_without_agent() {
        assert_eq!(compute_verdict(&base_inputs()).code, "ok");
    }

    #[test]
    fn verdict_user_prefix_not_on_path() {
        let mut inp = base_inputs();
        let mut a = agent_installed_unresolved();
        a.user_prefix_bin = Some("/home/u/.codeg/npm-global/bin/codex-acp".to_string());
        inp.agent = Some(a);
        let v = compute_verdict(&inp);
        assert_eq!(v.code, "user_prefix_not_on_path");
        assert_eq!(v.level, DiagLevel::Fail);
    }

    #[test]
    fn verdict_homebrew_bin_not_on_path() {
        let mut inp = base_inputs();
        let mut a = agent_installed_unresolved();
        a.homebrew_bin = Some("/opt/homebrew/bin/codex-acp".to_string());
        inp.agent = Some(a);
        assert_eq!(compute_verdict(&inp).code, "homebrew_bin_not_on_path");
    }

    #[test]
    fn verdict_terminal_only_path() {
        let mut inp = base_inputs();
        let mut a = agent_installed_unresolved();
        a.detected_version = Some("1.1.2".to_string());
        inp.agent = Some(a);
        inp.terminal.cmd_resolved = Some("/Users/u/.nvm/versions/node/v20/bin/codex-acp".to_string());
        assert_eq!(compute_verdict(&inp).code, "terminal_only_path");
    }

    #[test]
    fn verdict_node_too_old() {
        let mut inp = base_inputs();
        inp.node.version = Some("v18.19.0".to_string());
        let mut a = agent_installed_unresolved();
        a.node_required = Some("20.0.0".to_string());
        a.resolve_npx = Some("/x/codex-acp".to_string()); // resolves, but node too old
        inp.agent = Some(a);
        assert_eq!(compute_verdict(&inp).code, "node_too_old");
    }

    #[test]
    fn verdict_ok_when_resolved() {
        let mut inp = base_inputs();
        let mut a = agent_installed_unresolved();
        a.resolve_npx = Some("/usr/local/bin/codex-acp".to_string());
        inp.agent = Some(a);
        assert_eq!(compute_verdict(&inp).code, "ok");
    }

    #[test]
    fn verdict_not_installed_when_nothing_recorded() {
        let mut inp = base_inputs();
        inp.agent = Some(AgentDiag {
            cmd: "codex-acp".to_string(),
            distribution: "npx",
            ..Default::default()
        });
        assert_eq!(compute_verdict(&inp).code, "not_installed");
    }

    #[test]
    fn verdict_binary_launchable_ignores_node() {
        // Binary agents (e.g. Cursor) do not need Node; a launchable cached/system
        // binary must read "ok" even with no node/npm on PATH — regression guard
        // against the npx model being applied to every distribution.
        // node & npm absent
        let inp = DiagInputs {
            agent: Some(AgentDiag {
                name: "Cursor".to_string(),
                cmd: "cursor-agent".to_string(),
                distribution: "binary",
                launchable: Some("/Users/u/.local/bin/cursor-agent".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(compute_verdict(&inp).code, "ok");
    }

    #[test]
    fn verdict_binary_recorded_but_unresolved() {
        let inp = DiagInputs {
            agent: Some(AgentDiag {
                cmd: "cursor-agent".to_string(),
                distribution: "binary",
                db_version: Some("2026.07.16".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(compute_verdict(&inp).code, "installed_but_unresolved");
    }

    #[test]
    fn verdict_uvx_launchable_ok_else_not_installed() {
        let ok = DiagInputs {
            agent: Some(AgentDiag {
                cmd: "hermes".to_string(),
                distribution: "uvx",
                launchable: Some("/Users/u/.local/bin/uvx".to_string()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(compute_verdict(&ok).code, "ok");

        let missing = DiagInputs {
            agent: Some(AgentDiag {
                cmd: "hermes".to_string(),
                distribution: "uvx",
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(compute_verdict(&missing).code, "not_installed");
    }

    fn adapter_agent_never_installed(native_path: Option<&str>) -> AgentDiag {
        AgentDiag {
            name: "Codex CLI".to_string(),
            cmd: "codex-acp".to_string(),
            distribution: "npx",
            adapter: Some(AdapterProbe {
                native_cmd: "codex".to_string(),
                native_path: native_path.map(str::to_string),
                native_version: native_path.map(|_| "codex-cli 0.145.0".to_string()),
                shared_config_dir: "~/.codex".to_string(),
            }),
            ..Default::default()
        }
    }

    // The canonical support ticket: `codex` is on the machine, the adapter is
    // not. The generic "not installed" verdict reads as codeg being wrong, so
    // this case gets its own code.
    #[test]
    fn verdict_adapter_missing_while_vendor_cli_present() {
        let mut inp = base_inputs();
        inp.agent = Some(adapter_agent_never_installed(Some("/opt/homebrew/bin/codex")));
        let v = compute_verdict(&inp);
        assert_eq!(v.code, "adapter_missing_native_present");
        assert_eq!(v.level, DiagLevel::Info);
    }

    #[test]
    fn verdict_adapter_missing_without_vendor_cli() {
        let mut inp = base_inputs();
        inp.agent = Some(adapter_agent_never_installed(None));
        assert_eq!(compute_verdict(&inp).code, "adapter_missing");
    }

    // Node problems still win: they block installing the adapter in the first
    // place, so explaining the adapter split there would bury the real fix.
    #[test]
    fn verdict_node_missing_outranks_adapter_missing() {
        let inp = DiagInputs {
            agent: Some(adapter_agent_never_installed(Some(
                "/opt/homebrew/bin/codex",
            ))),
            ..Default::default()
        };
        assert_eq!(compute_verdict(&inp).code, "node_missing");
    }

    // Once the adapter resolves the split is irrelevant — plain ok, no special
    // casing that would leave an adapter agent permanently "explaining itself".
    #[test]
    fn verdict_ok_when_adapter_resolves_even_with_vendor_cli() {
        let mut inp = base_inputs();
        let mut a = adapter_agent_never_installed(Some("/opt/homebrew/bin/codex"));
        a.resolve_npx = Some("/usr/local/bin/codex-acp".to_string());
        inp.agent = Some(a);
        assert_eq!(compute_verdict(&inp).code, "ok");
    }

    // A previously-installed adapter that stopped resolving is a PATH problem,
    // not an explainer case — the adapter branch must not swallow it.
    #[test]
    fn verdict_installed_but_unresolved_still_wins_for_adapter_agents() {
        let mut inp = base_inputs();
        let mut a = adapter_agent_never_installed(Some("/opt/homebrew/bin/codex"));
        a.db_version = Some("1.1.7".to_string());
        inp.agent = Some(a);
        assert_eq!(compute_verdict(&inp).code, "installed_but_unresolved");
    }

    // The pasted report has to answer "but I have codex installed" on its own.
    #[test]
    fn report_names_the_vendor_cli_and_shared_config_dir() {
        let mut inp = base_inputs();
        inp.agent = Some(adapter_agent_never_installed(Some("/opt/homebrew/bin/codex")));
        let r = build_report(&inp, "FIXED-TS".to_string(), Some(AgentType::Codex));
        assert!(r.plain_text.contains("codex (your own CLI)"));
        assert!(r.plain_text.contains("/opt/homebrew/bin/codex"));
        assert!(r.plain_text.contains("~/.codex"));
        assert!(r.plain_text.contains("verdict [adapter_missing_native_present]"));
    }

    // Non-adapter agents keep the old shape exactly — no stray rows.
    #[test]
    fn report_omits_adapter_rows_for_plain_agents() {
        let mut inp = base_inputs();
        inp.agent = Some(AgentDiag {
            name: "Gemini CLI".to_string(),
            cmd: "gemini".to_string(),
            distribution: "npx",
            resolve_npx: Some("/usr/local/bin/gemini".to_string()),
            ..Default::default()
        });
        let r = build_report(&inp, "FIXED-TS".to_string(), Some(AgentType::Gemini));
        assert!(!r.plain_text.contains("your own CLI"));
        assert!(!r.plain_text.contains("shared config dir"));
    }

    #[test]
    fn build_report_is_deterministic_and_includes_plain_text() {
        let inp = base_inputs();
        let r = build_report(&inp, "FIXED-TS".to_string(), None);
        assert_eq!(r.generated_at, "FIXED-TS");
        assert!(r.plain_text.contains("Codeg environment diagnostics"));
        assert!(r.plain_text.contains("verdict [ok]"));
        assert!(!r.sections.is_empty());
    }
}

/// Process-local cache for dir-tree agents' system-binary `--version` probes,
/// keyed by (path, mtime) so an upgrade re-probes but the status/list paths
/// don't spawn a subprocess on every call.
static SYSTEM_BINARY_VERSION_CACHE: std::sync::Mutex<
    Option<(PathBuf, std::time::SystemTime, String)>,
> = std::sync::Mutex::new(None);

/// Version of a dir-tree agent's user-installed CLI (PATH / ~/.local/bin),
/// via a cached `--version` probe. `None` when no system install exists or
/// the probe fails.
pub(crate) async fn system_dir_agent_version(cmd: &str) -> Option<String> {
    let bin = resolve_system_agent_binary(cmd)?;
    let mtime = std::fs::metadata(&bin).ok()?.modified().ok()?;
    if let Some((cached_bin, cached_mtime, version)) =
        SYSTEM_BINARY_VERSION_CACHE.lock().ok()?.as_ref()
    {
        if *cached_bin == bin && *cached_mtime == mtime {
            return Some(version.clone());
        }
    }
    let version = probe_binary_version(&bin).await?;
    if let Ok(mut cache) = SYSTEM_BINARY_VERSION_CACHE.lock() {
        *cache = Some((bin, mtime, version.clone()));
    }
    Some(version)
}

/// Process-local cache for system-CLI version probes, keyed by the agent
/// command's resolved path and invalidated by its mtime. Failures are cached
/// too — a CLI that does not understand `--version` must not be re-spawned on
/// every settings refresh — and unlike the single-slot dir-tree cache above,
/// this one holds an entry per agent so several agents don't evict each other.
/// One probe result: the binary's mtime when probed, and the version it
/// reported (`None` = the probe failed, cached so it isn't retried until the
/// binary changes).
type ProbeCacheEntry = (std::time::SystemTime, Option<String>);

/// Cache key for a system version probe. The binary path alone is NOT
/// enough: the declared probe command is editable, so an edit must be a cache
/// miss rather than a stale hit until the binary's mtime changes — and two
/// agents sharing a launcher path must not read each other's results when
/// their probes or npm packages differ.
#[derive(Debug, PartialEq, Eq, Hash)]
struct ProbeCacheKey {
    bin: PathBuf,
    /// The declared `version_probe` in force when the entry was written.
    probe: Option<String>,
    /// The npm package the npm-list step consults. Part of the key even when
    /// a probe is declared — a failing probe falls back to the package
    /// conventions, so the package still shapes the result.
    package: Option<String>,
}

fn probe_cache_key(
    resolved_bin: &std::path::Path,
    declared_probe: Option<&str>,
    npm_package: Option<&str>,
) -> ProbeCacheKey {
    ProbeCacheKey {
        bin: resolved_bin.to_path_buf(),
        probe: declared_probe.map(str::to_string),
        package: npm_package.map(str::to_string),
    }
}

static SYSTEM_PROBE_CACHE: std::sync::Mutex<Option<HashMap<ProbeCacheKey, ProbeCacheEntry>>> =
    std::sync::Mutex::new(None);

/// First version-looking token in probe output: starts with a digit (a leading
/// `v` is tolerated and stripped), is dotted, and is drawn from the semver /
/// calendar-version alphabet. Whitespace tokens are additionally split on `/`
/// and `@` so `name/version` banners (curl-style `omp/17.1.7`) and npm-style
/// `package@1.2.3` match; URL-shaped tokens are skipped entirely so a help
/// link's path segment never reads as a version. Scans lines top-down so a
/// banner's real version wins over trailing build metadata.
fn extract_version_token(text: &str) -> Option<String> {
    fn version_candidate(piece: &str) -> Option<String> {
        let piece = piece.trim_matches(|c: char| matches!(c, '(' | ')' | ',' | ';' | ':'));
        let candidate = piece
            .strip_prefix('v')
            .or_else(|| piece.strip_prefix('V'))
            .unwrap_or(piece);
        let starts_digit = candidate
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit());
        (starts_digit
            && candidate.contains('.')
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+')))
        .then(|| candidate.to_string())
    }
    for line in text.lines() {
        for token in line.split_whitespace() {
            if token.contains("://") {
                continue;
            }
            if let Some(version) = token.split(['/', '@']).find_map(version_candidate) {
                return Some(version);
            }
        }
    }
    None
}

/// Run a CLI with version args and extract a version token from stdout, then
/// stderr (some CLIs print their banner there). Bounded like every other
/// status-path probe.
async fn probe_cli_version_token(bin: &std::path::Path, args: &[String]) -> Option<String> {
    let mut cmd = crate::process::tokio_command(bin);
    cmd.args(args).kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    extract_version_token(&String::from_utf8_lossy(&output.stdout))
        .or_else(|| extract_version_token(&String::from_utf8_lossy(&output.stderr)))
}

/// Version of an agent's SYSTEM install (the user's own `npm -g`, bun, brew,
/// installer script, …), for the status/list paths when codeg has no managed
/// install record. Works for built-ins and custom agents alike — a declared
/// `version_probe` only exists on custom definitions, so built-ins always
/// take the convention path. Cached per (binary, probe, package) (see
/// [`SYSTEM_PROBE_CACHE`]).
pub(crate) async fn system_probed_version(
    agent_type: AgentType,
    resolved_bin: &std::path::Path,
    npm_package: Option<&str>,
) -> Option<String> {
    let declared_probe = agent_type
        .custom_id()
        .and_then(crate::acp::custom_registry::version_probe_of);
    system_probed_version_with(declared_probe, resolved_bin, npm_package).await
}

/// Probe order: the declared `version_probe` command wins when it yields a
/// version; then `npm list -g` for npx packages (exact installed version,
/// both prefixes); then the near-universal `<cmd> --version` convention. A
/// declared probe that fails (unknown flag, unparsable banner) falls through
/// to the conventions rather than reading as "not installed".
async fn system_probed_version_with(
    declared_probe: Option<&str>,
    resolved_bin: &std::path::Path,
    npm_package: Option<&str>,
) -> Option<String> {
    let mtime = std::fs::metadata(resolved_bin).ok()?.modified().ok()?;
    let key = probe_cache_key(resolved_bin, declared_probe, npm_package);
    if let Ok(cache) = SYSTEM_PROBE_CACHE.lock() {
        if let Some((cached_mtime, version)) = cache.as_ref().and_then(|map| map.get(&key)) {
            if *cached_mtime == mtime {
                return version.clone();
            }
        }
    }

    let mut version = None;
    if let Some(probe) = declared_probe {
        // The declared probe is a full command line (`agent-cli --version`);
        // its program resolves like an agent command (PATH, then npm prefix).
        let mut parts = probe.split_whitespace();
        if let Some(program) = parts.next() {
            let args: Vec<String> = parts.map(str::to_string).collect();
            if let Some(path) = resolve_npx_command(program).await {
                version = probe_cli_version_token(&path, &args).await;
            }
        }
    }
    if version.is_none() {
        if let Some(package) = npm_package {
            version = detect_npm_global_version(&package_name_from_spec(package)).await;
        }
    }
    if version.is_none() {
        version = probe_cli_version_token(resolved_bin, &["--version".to_string()]).await;
    }

    if let Ok(mut cache) = SYSTEM_PROBE_CACHE.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(key, (mtime, version.clone()));
    }
    version
}

/// Run `<binary> --version` and return the first non-empty stdout line.
/// Bounded by a timeout so a wedged binary can't stall the status endpoint.
async fn probe_binary_version(bin: &std::path::Path) -> Option<String> {
    let mut cmd = crate::process::tokio_command(bin);
    cmd.arg("--version");
    let output = tokio::time::timeout(std::time::Duration::from_secs(10), cmd.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(str::to_string)
}

/// Official npm registry URL – used to bypass local mirror configurations that
/// may not have synced niche packages like `@agentclientprotocol/*`.
const NPM_OFFICIAL_REGISTRY: &str = "https://registry.npmjs.org";

/// Force npm to install platform-specific `optionalDependencies`. Several agents
/// ship their native CLI as a per-platform optional package — e.g.
/// `@agentclientprotocol/claude-agent-acp` pulls in `@anthropic-ai/claude-agent-sdk`,
/// whose runtime binary lives in optional deps like
/// `@anthropic-ai/claude-agent-sdk-win32-x64`. npm includes optional deps by
/// default, but a machine with `omit=optional` in its `.npmrc` (or `npm_config_omit`
/// in the environment) silently skips them, so the install "succeeds" yet the agent
/// fails at launch with "native binary not found for <platform>". `--include` wins
/// over `--omit` regardless of order and a CLI flag outranks any `.npmrc`, so passing
/// it unconditionally guarantees the native binary lands no matter how npm is
/// configured. Harmless for agents without optional deps.
const NPM_INCLUDE_OPTIONAL: &str = "--include=optional";
/// npm ≥7 hides lifecycle-script output by default. hermes-agent's postinstall
/// runs a multi-minute runtime bootstrap (pinned upstream checkout + isolated
/// venv sync); without this flag the install log goes silent for the whole
/// bootstrap, which reads as a hang (codeg imposes no timeout on npm). Other
/// agents' packages have no meaningful install scripts, so this only adds
/// their (empty) script output.
const NPM_FOREGROUND_SCRIPTS: &str = "--foreground-scripts";
/// CLI override forcing lifecycle scripts ON. A user-level
/// `ignore-scripts=true` (.npmrc or npm_config_ignore_scripts) makes `npm
/// install` "succeed" while silently skipping postinstall — for hermes-agent
/// the postinstall IS the install (pinned upstream checkout + isolated venv),
/// so the result is a `hermes` shim with no runtime behind it, recorded as
/// installed. CLI config outranks .npmrc/env (verified empirically), and the
/// user's explicit Install action for THIS package is consent to run its
/// install process. Applied only to packages that need it
/// (`npm_package_requires_scripts`), so every other agent keeps honoring the
/// user's global script policy.
const NPM_RUN_SCRIPTS_OVERRIDE: &str = "--ignore-scripts=false";

/// Env var that makes Node's own `fetch` read `HTTP_PROXY`/`HTTPS_PROXY`/
/// `NO_PROXY` (Node ≥24; earlier runtimes ignore an unknown variable).
///
/// Node's `fetch` (undici) is the one hop of an install that ignores the proxy
/// environment — npm, git and uv all read it. hermes-agent's postinstall
/// downloads its pinned uv binary with `fetch`, so behind a proxy the whole
/// bootstrap dies on `Downloading uv ...` with a bare `fetch failed` while
/// every other step of it would have gone through. Set only when the
/// environment doesn't already carry the variable, so a user who set it (either
/// way) still decides.
const NODE_ENV_PROXY_VAR: &str = "NODE_USE_ENV_PROXY";

/// Whether an npm package's lifecycle scripts are load-bearing for the
/// install (skipping them yields a broken command). Only the hermes-agent
/// community bridge today: its postinstall bootstraps the entire Python
/// runtime the `hermes` bin execs into.
fn npm_package_requires_scripts(package: &str) -> bool {
    package_name_from_spec(package) == "hermes-agent"
}

/// Name the proxy when a bootstrap package's install died inside the wrapper's
/// own downloads. `NODE_ENV_PROXY_VAR` covers Node ≥24; what remains is a
/// proxied machine on an older Node, where nothing codeg can pass makes that
/// `fetch` go through — worth spelling out, because npm reports it as a bare
/// `fetch failed` that says nothing about a proxy.
fn annotate_npm_bootstrap_failure(package: &str, err: AcpError) -> AcpError {
    if !npm_package_requires_scripts(package) {
        return err;
    }
    let AcpError::Protocol(message) = &err else {
        return err;
    };
    let download_failed = message.contains("fetch failed")
        || message.contains("Failed to download")
        || message.contains("aborted due to timeout");
    if !download_failed {
        return err;
    }
    AcpError::Protocol(format!(
        "{message}\n\nThe bootstrap downloads its runtime from github.com with Node's own \
         fetch, which reads HTTP(S)_PROXY only on Node 24+. Behind a proxy on an older \
         Node, upgrade Node or run the official installer — codeg picks up a `hermes` \
         on PATH."
    ))
}

/// Name the proxy when npm refused to parse the proxy address itself.
///
/// npm resolves `HTTP(S)_PROXY` with WHATWG `new URL()`, where a scheme may not
/// start with a digit, so a bare `127.0.0.1:7890` aborts the install with a
/// context-free `ERR_INVALID_URL` before any network I/O — no mention of a
/// proxy, no mention of which variable. codeg normalizes the address it exports
/// from Settings, so what reaches here is an externally-provided value (docker
/// `-e`, a shell export) that the startup contract leaves untouched.
fn annotate_npm_proxy_url_failure(err: AcpError) -> AcpError {
    let AcpError::Protocol(message) = &err else {
        return err;
    };
    if !message.contains("ERR_INVALID_URL") && !message.contains("Invalid URL") {
        return err;
    }
    let offenders = crate::network::proxy::proxy_env_vars_missing_scheme();
    if offenders.is_empty() {
        return err;
    }
    AcpError::Protocol(format!(
        "{message}\n\nnpm could not parse the proxy address in {} — it has no scheme. \
         npm requires one (codeg's own HTTP client does not, which is why updates still \
         work). Set it to a full URL, e.g. `http://127.0.0.1:7890`.",
        offenders.join(", ")
    ))
}

/// Run an npm command with piped stdout/stderr, streaming each line as a log event.
/// Returns (success: bool, collected_stderr: String) so callers can inspect errors.
async fn run_npm_streaming(
    args: &[&str],
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(bool, String), AcpError> {
    use tokio::io::BufReader;

    let mut cmd = crate::process::tokio_command("npm");
    for arg in args {
        cmd.arg(arg);
    }
    if std::env::var_os(NODE_ENV_PROXY_VAR).is_none() {
        cmd.env(NODE_ENV_PROXY_VAR, "1");
    }
    cmd.stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| AcpError::protocol(format!("failed to spawn npm: {e}")))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let emitter_clone = emitter.clone();
    let task_id_owned = task_id.to_string();

    // `collect_lines_lossy` (not `Lines`/`next_line()`) matters here: npm can
    // emit OEM-codepage bytes (e.g. GBK on a zh-CN Windows) for localized
    // OS-level error text, which `next_line()` chokes on and silently drops —
    // truncating both the live install log and the stderr this function
    // returns for the caller's error message.
    let stdout_handle = tokio::spawn({
        let emitter = emitter_clone.clone();
        let task_id = task_id_owned.clone();
        async move {
            if let Some(out) = stdout {
                crate::process::collect_lines_lossy(BufReader::new(out), |line| {
                    emit_agent_install_event(&emitter, &task_id, AgentInstallEventKind::Log, line);
                })
                .await;
            }
        }
    });

    let stderr_handle = tokio::spawn({
        let emitter = emitter_clone;
        let task_id = task_id_owned;
        async move {
            match stderr {
                Some(err) => {
                    crate::process::collect_lines_lossy(BufReader::new(err), |line| {
                        emit_agent_install_event(
                            &emitter,
                            &task_id,
                            AgentInstallEventKind::Log,
                            line,
                        );
                    })
                    .await
                }
                None => String::new(),
            }
        }
    });

    let (_, stderr_result) = tokio::join!(stdout_handle, stderr_handle);
    let collected_stderr = stderr_result.unwrap_or_default();

    let status = child
        .wait()
        .await
        .map_err(|e| AcpError::protocol(format!("failed to wait for npm process: {e}")))?;

    Ok((status.success(), collected_stderr))
}

/// Install an npm package globally, streaming progress, with the proxy
/// diagnostic attached to every failure.
///
/// The annotation lives here rather than at the call sites so it covers each
/// entry point — the pinned npx agents and the `pi` binary prerequisite alike —
/// and cannot be forgotten by the next one.
async fn install_npm_global_package_streaming(
    package: &str,
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    install_npm_global_package_streaming_inner(package, task_id, emitter)
        .await
        .map_err(annotate_npm_proxy_url_failure)
}

async fn install_npm_global_package_streaming_inner(
    package: &str,
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let registry_arg = format!("--registry={NPM_OFFICIAL_REGISTRY}");
    let run_scripts = npm_package_requires_scripts(package);

    emit_agent_install_event(
        emitter,
        task_id,
        AgentInstallEventKind::Log,
        format!("$ npm install -g {NPM_INCLUDE_OPTIONAL} {package}"),
    );

    let mut args = vec!["install", "-g", NPM_INCLUDE_OPTIONAL, NPM_FOREGROUND_SCRIPTS];
    if run_scripts {
        args.push(NPM_RUN_SCRIPTS_OVERRIDE);
    }
    args.push(&registry_arg);
    args.push(package);
    let (success, stderr) = run_npm_streaming(&args, task_id, emitter).await?;

    if !success {
        // EACCES: permission denied — retry with a user-local --prefix so
        // we don't require root/sudo on macOS / Linux.
        if stderr.contains("EACCES") {
            emit_agent_install_event(
                emitter,
                task_id,
                AgentInstallEventKind::Log,
                "Permission denied, retrying with user prefix...",
            );
            return install_npm_to_user_prefix_streaming(package, &registry_arg, task_id, emitter)
                .await;
        }

        // EEXIST: file conflict — retry with --force to overwrite
        if stderr.contains("EEXIST") {
            emit_agent_install_event(
                emitter,
                task_id,
                AgentInstallEventKind::Log,
                "File conflict, retrying with --force...",
            );
            let mut retry_args = vec![
                "install",
                "-g",
                "--force",
                NPM_INCLUDE_OPTIONAL,
                NPM_FOREGROUND_SCRIPTS,
            ];
            if run_scripts {
                retry_args.push(NPM_RUN_SCRIPTS_OVERRIDE);
            }
            retry_args.push(&registry_arg);
            retry_args.push(package);
            let (retry_success, retry_stderr) =
                run_npm_streaming(&retry_args, task_id, emitter).await?;
            if !retry_success {
                if retry_stderr.contains("EACCES") {
                    emit_agent_install_event(
                        emitter,
                        task_id,
                        AgentInstallEventKind::Log,
                        "Permission denied on --force retry, falling back to user prefix...",
                    );
                    return install_npm_to_user_prefix_streaming(
                        package,
                        &registry_arg,
                        task_id,
                        emitter,
                    )
                    .await;
                }
                let err = retry_stderr.trim().to_string();
                let msg = if err.is_empty() {
                    "failed to install npm package globally (with --force)".to_string()
                } else {
                    format!("failed to install npm package globally (with --force): {err}")
                };
                return Err(AcpError::protocol(msg));
            }
            return Ok(());
        }

        let err = stderr.trim().to_string();
        let msg = if err.is_empty() {
            "failed to install npm package globally".to_string()
        } else {
            format!("failed to install npm package globally: {err}")
        };
        return Err(AcpError::protocol(msg));
    }

    Ok(())
}

/// Fallback: install an npm package into a user-local prefix (`~/.codeg/npm-global/`)
/// when the system global prefix is not writable (EACCES).
async fn install_npm_to_user_prefix_streaming(
    package: &str,
    registry_arg: &str,
    task_id: &str,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let prefix = crate::process::user_npm_prefix().ok_or_else(|| {
        AcpError::protocol(
            "npm install -g failed with EACCES and could not determine home directory for fallback"
                .to_string(),
        )
    })?;

    // Ensure the prefix directory exists.
    tokio::fs::create_dir_all(&prefix).await.map_err(|e| {
        AcpError::protocol(format!(
            "failed to create user npm prefix {}: {e}",
            prefix.display()
        ))
    })?;

    let prefix_arg = format!("--prefix={}", prefix.display());
    let run_scripts = npm_package_requires_scripts(package);

    emit_agent_install_event(
        emitter,
        task_id,
        AgentInstallEventKind::Log,
        format!(
            "$ npm install -g {NPM_INCLUDE_OPTIONAL} --prefix={} {package}",
            prefix.display()
        ),
    );

    let mut args = vec!["install", "-g", NPM_INCLUDE_OPTIONAL, NPM_FOREGROUND_SCRIPTS];
    if run_scripts {
        args.push(NPM_RUN_SCRIPTS_OVERRIDE);
    }
    args.push(&prefix_arg);
    args.push(registry_arg);
    args.push(package);
    let (success, stderr) = run_npm_streaming(&args, task_id, emitter).await?;

    if !success {
        // EEXIST in the user prefix: retry with --force to overwrite stale files
        // from a previous installation.
        if stderr.contains("EEXIST") {
            emit_agent_install_event(
                emitter,
                task_id,
                AgentInstallEventKind::Log,
                "File conflict in user prefix, retrying with --force...",
            );
            let mut force_args = vec![
                "install",
                "-g",
                "--force",
                NPM_INCLUDE_OPTIONAL,
                NPM_FOREGROUND_SCRIPTS,
            ];
            if run_scripts {
                force_args.push(NPM_RUN_SCRIPTS_OVERRIDE);
            }
            force_args.push(&prefix_arg);
            force_args.push(registry_arg);
            force_args.push(package);
            let (force_success, force_stderr) =
                run_npm_streaming(&force_args, task_id, emitter).await?;
            if !force_success {
                let err = force_stderr.trim().to_string();
                let msg = if err.is_empty() {
                    format!(
                        "failed to install npm package (user prefix {}, --force)",
                        prefix.display()
                    )
                } else {
                    format!(
                        "failed to install npm package (user prefix {}, --force): {err}",
                        prefix.display()
                    )
                };
                return Err(AcpError::protocol(msg));
            }
            // --force succeeded, fall through to PATH setup below.
        } else {
            let err = stderr.trim().to_string();
            let msg = if err.is_empty() {
                format!(
                    "failed to install npm package globally (user prefix {})",
                    prefix.display()
                )
            } else {
                format!(
                    "failed to install npm package globally (user prefix {}): {err}",
                    prefix.display()
                )
            };
            return Err(AcpError::protocol(msg));
        }
    }

    // Make sure the user prefix bin dir is in PATH for subsequent `which` lookups.
    crate::process::ensure_user_npm_prefix_in_path();

    Ok(())
}

async fn uninstall_npm_global_package(package: &str) -> Result<(), AcpError> {
    let package_name = package_name_from_spec(package);

    if !package_name.is_empty() {
        // Try uninstalling from the default global prefix.
        let output = crate::process::tokio_command("npm")
            .arg("uninstall")
            .arg("-g")
            .arg(&package_name)
            .output()
            .await
            .map_err(|e| AcpError::protocol(format!("failed to run npm uninstall -g: {e}")))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            // EACCES: the package may have been installed to the user-local
            // prefix via the EACCES fallback — try uninstalling from there.
            if stderr.contains("EACCES") {
                return uninstall_npm_from_user_prefix(&package_name).await;
            }
            let err = stderr.trim().to_string();
            let msg = if err.is_empty() {
                "failed to uninstall npm package globally".to_string()
            } else {
                format!("failed to uninstall npm package globally: {err}")
            };
            return Err(AcpError::protocol(msg));
        }

        // Also try removing from the user prefix (best-effort) in case the
        // package was installed in both locations.
        let _ = uninstall_npm_from_user_prefix(&package_name).await;
    }

    Ok(())
}

/// Uninstall an npm package from the user-local prefix (`~/.codeg/npm-global/`).
async fn uninstall_npm_from_user_prefix(package_name: &str) -> Result<(), AcpError> {
    let prefix = match crate::process::user_npm_prefix() {
        Some(p) if p.exists() => p,
        _ => return Ok(()),
    };

    let prefix_arg = format!("--prefix={}", prefix.display());
    let output = crate::process::tokio_command("npm")
        .arg("uninstall")
        .arg("-g")
        .arg(&prefix_arg)
        .arg(package_name)
        .output()
        .await
        .map_err(|e| {
            AcpError::protocol(format!(
                "failed to run npm uninstall -g with user prefix: {e}"
            ))
        })?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if err.is_empty() {
            format!(
                "failed to uninstall npm package from user prefix (exit code {})",
                output.status.code().unwrap_or(-1)
            )
        } else {
            format!("failed to uninstall npm package from user prefix: {err}")
        };
        return Err(AcpError::protocol(msg));
    }

    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SkillStorageKind {
    SkillDirectoryOnly,
    SkillDirectoryOrMarkdownFile,
}

#[derive(Debug, Clone)]
pub(crate) struct SkillStorageSpec {
    pub kind: SkillStorageKind,
    pub global_dirs: Vec<PathBuf>,
    pub project_rel_dirs: Vec<&'static str>,
}

fn home_dir_or_default() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

fn codex_home_dir() -> PathBuf {
    let configured = std::env::var("CODEX_HOME").ok().and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    match configured {
        Some(value) => {
            if value == "~" {
                home_dir_or_default()
            } else if let Some(remain) = value.strip_prefix("~/") {
                home_dir_or_default().join(remain)
            } else {
                PathBuf::from(value)
            }
        }
        None => home_dir_or_default().join(".codex"),
    }
}

/// Hermes config/data directory. Honors `HERMES_HOME`, defaults to `~/.hermes`.
/// Hermes self-manages credentials (`.env`), config (`config.yaml`), session
/// store (`state.db`), and skills (`skills/`) here.
pub(crate) fn hermes_home_dir() -> PathBuf {
    let configured = std::env::var("HERMES_HOME").ok().and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    match configured {
        Some(value) => {
            if value == "~" {
                home_dir_or_default()
            } else if let Some(remain) = value.strip_prefix("~/") {
                home_dir_or_default().join(remain)
            } else {
                PathBuf::from(value)
            }
        }
        None => home_dir_or_default().join(".hermes"),
    }
}

fn codex_config_toml_path() -> PathBuf {
    codex_home_dir().join("config.toml")
}

fn codex_auth_json_path() -> PathBuf {
    codex_home_dir().join("auth.json")
}

/// Header codex reads to decide whether a provider authenticates through the
/// "actor authorization" path. Mirrors `OPENAI_ACTOR_AUTHORIZATION_HEADER` in
/// codex's `model-provider-info` crate.
const CODEX_ACTOR_AUTHORIZATION_HEADER: &str = "x-openai-actor-authorization";

/// Mirrors the header half of codex's
/// `ModelProviderInfo::uses_openai_actor_authorization`. A
/// `[model_providers.x.http_headers]` sub-table and an inline
/// `http_headers = { .. }` both parse to `Value::Table`, so one lookup covers
/// every spelling.
fn codex_provider_uses_actor_authorization(
    provider_table: &toml::map::Map<String, toml::Value>,
) -> bool {
    provider_table
        .get("http_headers")
        .and_then(toml::Value::as_table)
        .is_some_and(|headers| {
            headers.iter().any(|(name, value)| {
                name.eq_ignore_ascii_case(CODEX_ACTOR_AUTHORIZATION_HEADER)
                    && value.as_str().is_some_and(|value| !value.trim().is_empty())
            })
        })
}

/// Supply codeg's `requires_openai_auth` default without clobbering the user.
///
/// Codex defaults the field to `false` and only reads credentials from
/// `auth.json` when it is `true`, so `true` is correct for a provider codeg
/// provisioned itself (key in auth.json, no `env_key`) — and wrong for one the
/// user configured. Worse, codex's `uses_openai_actor_authorization()` requires
/// `!requires_openai_auth`, so forcing `true` silently disables that auth path.
/// Write the default only when the field is absent, and never over a provider
/// that opted into actor authorization.
fn ensure_codex_provider_auth_default(provider_table: &mut toml::map::Map<String, toml::Value>) {
    if provider_table.contains_key("requires_openai_auth")
        || codex_provider_uses_actor_authorization(provider_table)
    {
        return;
    }
    provider_table.insert(
        "requires_openai_auth".to_string(),
        toml::Value::Boolean(true),
    );
}

/// OpenCode reads config from `$XDG_CONFIG_HOME/opencode` (falling back to
/// `~/.config/opencode`) and credentials from `$XDG_DATA_HOME/opencode`
/// (falling back to `~/.local/share/opencode`) on every platform. codeg must
/// write where OpenCode reads, so these reuse the same XDG resolution as
/// `opencode_plugins` (config) and `parsers::opencode` (data) — otherwise a
/// user with XDG dirs set would get credentials written where OpenCode never
/// looks, and codeg's own plugin/connect paths would diverge.
fn opencode_config_dir() -> PathBuf {
    crate::acp::opencode_plugins::xdg_config_home()
        .unwrap_or_else(|| home_dir_or_default().join(".config"))
        .join("opencode")
}

fn opencode_primary_config_path() -> PathBuf {
    opencode_config_dir().join("opencode.json")
}

fn opencode_legacy_config_path() -> PathBuf {
    opencode_config_dir().join("config.json")
}

fn resolve_opencode_config_path() -> PathBuf {
    let primary = opencode_primary_config_path();
    if primary.exists() {
        return primary;
    }

    let legacy = opencode_legacy_config_path();
    if legacy.exists() {
        return legacy;
    }

    primary
}

fn opencode_auth_json_path() -> PathBuf {
    crate::parsers::opencode::resolve_opencode_base_dir().join("auth.json")
}

fn load_opencode_auth_json_raw() -> Option<String> {
    fs::read_to_string(opencode_auth_json_path()).ok()
}

// ---------------------------------------------------------------------------
// Cline config helpers
// ---------------------------------------------------------------------------
//
// WHERE CLINE 3.x ACTUALLY KEEPS PROVIDER CREDENTIALS (reverse-engineered from
// the 3.0.62 bun binary and confirmed by driving `cline --acp` over stdio).
//
// (a) The store moved. `globalState.json` + `secrets.json` are the VSCode-era
//     files; the CLI's own store is `<data>/settings/providers.json` (path
//     overridable with `CLINE_PROVIDER_SETTINGS_PATH`) plus a sibling
//     `models.json` that registers custom model ids. The CLI migrates the
//     legacy pair into `providers.json` on startup — but that migration is
//     PER-PROVIDER AND ONE-SHOT (`if (H.providers[R]) continue;`). Once a
//     provider has an entry, later edits to `globalState.json`/`secrets.json`
//     are read by nobody. codeg used to write only the legacy pair, so the
//     Cline settings panel silently stopped taking effect after the first
//     launch — hence [`persist_cline_provider_settings_at`] writing the native
//     store directly. The legacy pair is still READ as a fallback so a user
//     whose config predates this lands on their existing values.
//
// (b) `providers.json` is zod-validated on read, and a failed parse silently
//     yields an EMPTY store (every provider gone, base URL and key with it).
//     The schema that matters here:
//       { version: 1 (literal), lastUsedProvider?: string, modes: {},
//         providers: Record<string, { settings: {...}, updatedAt: <RFC3339>,
//                                     tokenSource: "manual"|"oauth"|"migration" }> }
//     `settings.baseUrl` is `z.string().url()`. So an out-of-enum tokenSource,
//     a non-`Z` timestamp or a malformed base URL does not degrade — it wipes
//     the whole file's effect. [`persist_cline_provider_settings_at`],
//     [`cline_timestamp_now`] and [`validate_cline_base_url`] exist to keep
//     codeg on the valid side of that cliff.
//
// (c) `models.json` is what makes a CUSTOM model id selectable. Without it the
//     agent falls back to the provider's built-in default (`gpt-4o` for
//     `openai-compatible`) even though `providers.json` names the model — the
//     ACP `newSession` resolver only accepts a model id present in the
//     provider's known-model list. Cline's own migration writes this entry for
//     `openai-compatible` only, and so do we.
//
// (d) Provider ids are cline's, not VSCode's. The CLI aliases `openai` →
//     `openai-compatible` in its `auth` subcommand, but the ACP path does NOT:
//     `CLINE_PROVIDER=openai` yields an empty model list. See
//     [`normalize_cline_provider_id`].
//
// The ACP auth gate that forces the launch-env half of this lives in
// [`apply_cline_launch_env`].

fn cline_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("CLINE_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    home_dir_or_default().join(".cline").join("data")
}

/// `<data>/settings/providers.json` — the CLI's real credential store, honouring
/// the same `CLINE_PROVIDER_SETTINGS_PATH` override the CLI itself reads.
fn cline_provider_settings_path() -> PathBuf {
    if let Ok(custom) = std::env::var("CLINE_PROVIDER_SETTINGS_PATH") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    cline_data_dir().join("settings").join("providers.json")
}

/// `models.json` — resolved as a SIBLING of `providers.json`, exactly as the
/// CLI resolves it, so a `CLINE_PROVIDER_SETTINGS_PATH` override moves both.
fn cline_models_catalog_path() -> PathBuf {
    cline_provider_settings_path().with_file_name("models.json")
}

fn cline_global_state_path() -> PathBuf {
    cline_data_dir().join("globalState.json")
}

fn cline_secrets_path() -> PathBuf {
    cline_data_dir().join("secrets.json")
}

fn load_cline_secrets_json_raw() -> Option<String> {
    fs::read_to_string(cline_secrets_path()).ok()
}

/// The one provider whose model ids are user-authored rather than catalogued,
/// so a `models.json` entry is required for the chosen model to be selectable.
/// Mirrors cline's own migration, which writes that entry for this id alone.
const CLINE_CUSTOM_MODEL_PROVIDER: &str = "openai-compatible";

/// Default context window cline's migration stamps on a custom model entry when
/// the legacy config carried no `openAiModelInfo` (`pc0` in the 3.0.62 bundle).
const CLINE_CUSTOM_MODEL_CONTEXT_WINDOW: u64 = 128_000;

/// Map the ids codeg (and the VSCode extension before it) used onto the ids the
/// CLI's provider registry actually keys on.
///
/// Only `openai` is genuinely renamed — but it matters: `cline auth` silently
/// aliases it while the ACP path does not, so an un-normalized `openai` reaches
/// `session/new` as an unknown provider with zero models and the session starts
/// on an empty model id.
fn normalize_cline_provider_id(provider: &str) -> String {
    match provider.trim() {
        "" => "anthropic".to_string(),
        "openai" => CLINE_CUSTOM_MODEL_PROVIDER.to_string(),
        other => other.to_string(),
    }
}

/// Providers cline authenticates without an API key (local inference). They
/// still have to clear the ACP auth gate, which only looks at
/// `process.env.CLINE_API_KEY` being non-empty — see
/// [`apply_cline_launch_env`].
fn cline_provider_is_keyless(provider: &str) -> bool {
    matches!(provider, "ollama" | "lmstudio")
}

/// Cline's own sign-in providers — the three `authMethods` its ACP `initialize`
/// advertises, and the only three its auth gate inspects.
///
/// Their credential is an OAuth token cline obtains through a device-code flow
/// (`cline auth <id>`, or the ACP `authenticate` request, which prints a code
/// and a `authkit.cline.bot/device` URL and blocks until the browser half
/// finishes) and stores itself. codeg neither holds nor refreshes it, which has
/// two consequences it must respect: never write over these entries' secrets,
/// and never export `CLINE_PROVIDER`/`CLINE_API_KEY` for them — the env would
/// shadow the very credential `tryRestoreAuth` is meant to find, and would
/// additionally freeze the provider selector (see
/// `env_pinned_config_option_ids`).
fn cline_provider_is_agent_managed(provider: &str) -> bool {
    matches!(provider, "cline" | "cline-pass" | "openai-codex")
}

/// `providers.json` rejects a `settings.baseUrl` that is not a `z.string().url()`,
/// and a rejected file reads back EMPTY — so a typo in this field would silently
/// cost the user every provider they had configured. Fail the save instead.
fn validate_cline_base_url(base_url: &str) -> Result<(), AcpError> {
    let rest = base_url
        .split_once("://")
        .filter(|(scheme, _)| {
            !scheme.is_empty()
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        })
        .map(|(_, rest)| rest);
    match rest {
        Some(rest) if !rest.trim_start_matches('/').is_empty() => Ok(()),
        _ => Err(AcpError::protocol(format!(
            "invalid Cline base URL {base_url:?}: expected an absolute URL such as https://example.com/v1"
        ))),
    }
}

/// Cline provider → secrets.json field name for the API key.
fn cline_api_key_field_for_provider(provider: &str) -> &'static str {
    match provider {
        "anthropic" => "apiKey",
        "openrouter" => "openRouterApiKey",
        "openai-native" => "openAiNativeApiKey",
        "openai" => "openAiApiKey",
        "gemini" => "geminiApiKey",
        "deepseek" => "deepSeekApiKey",
        "mistral" => "mistralApiKey",
        "xai" => "xaiApiKey",
        _ => "openAiApiKey",
    }
}

/// Cline provider → globalState model ID key suffix.
/// Providers in ProviderKeyMap use `actMode{Suffix}` / `planMode{Suffix}`,
/// others use `actModeApiModelId` / `planModeApiModelId`.
fn cline_model_id_keys_for_provider(provider: &str) -> (&'static str, &'static str) {
    match provider {
        "openrouter" | "cline" => ("actModeOpenRouterModelId", "planModeOpenRouterModelId"),
        "openai" => ("actModeOpenAiModelId", "planModeOpenAiModelId"),
        "ollama" => ("actModeOllamaModelId", "planModeOllamaModelId"),
        "lmstudio" => ("actModeLmStudioModelId", "planModeLmStudioModelId"),
        "litellm" => ("actModeLiteLlmModelId", "planModeLiteLlmModelId"),
        "requesty" => ("actModeRequestyModelId", "planModeRequestyModelId"),
        "groq" => ("actModeGroqModelId", "planModeGroqModelId"),
        _ => ("actModeApiModelId", "planModeApiModelId"),
    }
}

/// Project cline's native `providers.json` into codeg's unified config shape
/// (`apiProvider` / `model` / `apiKey` / `apiBaseUrl`).
///
/// Picks `lastUsedProvider` when it names a present entry — that is the provider
/// the CLI itself would resume on — and otherwise the sole entry, so a store
/// written by `cline auth` reads back correctly. With several entries and no
/// usable `lastUsedProvider` there is no defensible "current" provider, so this
/// reports none rather than guessing one and overwriting it on the next save.
fn load_cline_provider_settings_at(path: &Path) -> Option<serde_json::Map<String, serde_json::Value>> {
    let root = fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())?;
    let providers = root.get("providers")?.as_object()?;

    let selected = root
        .get("lastUsedProvider")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|id| providers.contains_key(*id))
        .map(str::to_string)
        .or_else(|| match providers.len() {
            1 => providers.keys().next().cloned(),
            _ => None,
        })?;

    let settings = providers.get(&selected)?.get("settings")?.as_object()?;
    let mut merged = serde_json::Map::new();
    merged.insert(
        "apiProvider".to_string(),
        serde_json::Value::String(normalize_cline_provider_id(&selected)),
    );
    for (source, target) in [("apiKey", "apiKey"), ("model", "model"), ("baseUrl", "apiBaseUrl")] {
        if let Some(value) = settings
            .get(source)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            merged.insert(target.to_string(), serde_json::Value::String(value.to_string()));
        }
    }
    Some(merged)
}

/// The Cline panel's view of the agent's credentials, as a unified config JSON
/// with keys: apiProvider, model, apiKey, apiBaseUrl.
///
/// Reads cline's native `providers.json` first and only falls back to the legacy
/// `globalState.json` + `secrets.json` pair when that store holds nothing usable
/// — the legacy pair is what a pre-3.x install (or an older codeg) left behind,
/// and surfacing it keeps those users' settings visible until their first save
/// promotes them into the native store.
fn load_cline_local_config_json() -> Option<String> {
    if let Some(from_native) = load_cline_provider_settings_at(&cline_provider_settings_path()) {
        return serde_json::to_string_pretty(&serde_json::Value::Object(from_native)).ok();
    }
    load_legacy_cline_local_config_json()
}

fn load_legacy_cline_local_config_json() -> Option<String> {
    let mut merged = serde_json::Map::new();
    // The legacy files are keyed by the VSCode-era provider ids, so every lookup
    // below uses `provider` verbatim; only the value handed back to the panel is
    // normalized onto cline 3.x's registry ids.
    let mut legacy_provider = "anthropic".to_string();

    if let Ok(raw) = fs::read_to_string(cline_global_state_path()) {
        if let Ok(state) = serde_json::from_str::<serde_json::Value>(&raw) {
            // Cline uses actModeApiProvider / planModeApiProvider (prefer actMode)
            let provider = state
                .get("actModeApiProvider")
                .or_else(|| state.get("planModeApiProvider"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .unwrap_or("anthropic")
                .to_string();
            legacy_provider = provider.clone();

            merged.insert(
                "apiProvider".to_string(),
                serde_json::Value::String(normalize_cline_provider_id(&provider)),
            );

            // Read model from provider-specific key
            let (act_key, _plan_key) = cline_model_id_keys_for_provider(&provider);
            if let Some(model_id) = state
                .get(act_key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                merged.insert(
                    "model".to_string(),
                    serde_json::Value::String(model_id.to_string()),
                );
            }

            // Read provider-specific baseUrl key
            let base_url_key = match provider.as_str() {
                "anthropic" => "anthropicBaseUrl",
                "gemini" => "geminiBaseUrl",
                "ollama" => "ollamaBaseUrl",
                "lmstudio" => "lmStudioBaseUrl",
                "litellm" => "liteLlmBaseUrl",
                "requesty" => "requestyBaseUrl",
                _ => "openAiBaseUrl",
            };
            if let Some(base_url) = state
                .get(base_url_key)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                merged.insert(
                    "apiBaseUrl".to_string(),
                    serde_json::Value::String(base_url.to_string()),
                );
            }
        }
    }

    // Read API key from secrets.json based on provider
    if let Ok(raw) = fs::read_to_string(cline_secrets_path()) {
        if let Ok(secrets) = serde_json::from_str::<serde_json::Value>(&raw) {
            let key_field = cline_api_key_field_for_provider(&legacy_provider);
            if let Some(api_key) = secrets
                .get(key_field)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                merged.insert(
                    "apiKey".to_string(),
                    serde_json::Value::String(api_key.to_string()),
                );
            }
        }
    }

    if merged.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(merged)).ok()
}

/// Write the panel's credentials into cline's NATIVE store
/// (`settings/providers.json`, plus `settings/models.json` when the provider
/// needs a custom model registered).
///
/// The legacy `globalState.json` + `secrets.json` pair is deliberately NOT
/// written any more: cline 3.x imports it once per provider and then ignores it
/// forever, so every save after the first was a no-op. See the module note
/// above (b)/(c) for why the exact shape here is load-bearing — an invalid
/// `tokenSource`, timestamp or base URL makes cline read the file as empty.
fn persist_cline_local_config(config_patch_json: Option<&str>) -> Result<(), AcpError> {
    let Some(raw_patch) = config_patch_json else {
        return Ok(());
    };
    let runtime = serde_json::from_str::<AgentRuntimeConfig>(raw_patch)
        .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;
    let patch = serde_json::from_str::<serde_json::Value>(raw_patch)
        .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;

    let provider = normalize_cline_provider_id(
        patch
            .get("apiProvider")
            .and_then(|v| v.as_str())
            .unwrap_or("anthropic"),
    );

    persist_cline_provider_settings_at(
        &cline_provider_settings_path(),
        &cline_models_catalog_path(),
        &provider,
        trim_non_empty(runtime.api_key).as_deref(),
        trim_non_empty(runtime.model).as_deref(),
        trim_non_empty(runtime.api_base_url).as_deref(),
    )
}

/// Path-explicit half of [`persist_cline_local_config`], so the file shape can
/// be tested without a `$HOME`.
///
/// Merge-preserving on both files: other providers keep their entries, and the
/// edited provider keeps every `settings` field codeg does not own (`reasoning`,
/// `aws`, `headers`, an OAuth `auth` block, …) so a `cline auth` login survives
/// a save from the panel.
fn persist_cline_provider_settings_at(
    providers_path: &Path,
    models_path: &Path,
    provider: &str,
    api_key: Option<&str>,
    model: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), AcpError> {
    if let Some(base_url) = base_url {
        validate_cline_base_url(base_url)?;
    }

    let mut root = read_json_object(providers_path).unwrap_or_else(|| serde_json::json!({}));
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| AcpError::protocol("cline providers.json root must be an object"))?;
    // `version` is a zod literal — anything else and cline reads the file as empty.
    root_obj.insert("version".to_string(), serde_json::json!(1));
    if !root_obj.get("modes").is_some_and(serde_json::Value::is_object) {
        root_obj.insert("modes".to_string(), serde_json::json!({}));
    }
    root_obj.insert(
        "lastUsedProvider".to_string(),
        serde_json::Value::String(provider.to_string()),
    );

    let providers_item = root_obj
        .entry("providers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !providers_item.is_object() {
        *providers_item = serde_json::json!({});
    }
    let providers = providers_item
        .as_object_mut()
        .ok_or_else(|| AcpError::protocol("cline providers.json `providers` must be an object"))?;

    let existing = providers.get(provider);
    // Preserve a pre-existing `tokenSource` (an `oauth` entry written by
    // `cline auth` must not be demoted to `manual`), but drop an out-of-enum
    // value rather than round-tripping a file cline would reject.
    let token_source = existing
        .and_then(|entry| entry.get("tokenSource"))
        .and_then(|v| v.as_str())
        .filter(|v| matches!(*v, "manual" | "oauth" | "migration"))
        .unwrap_or("manual")
        .to_string();
    let mut settings = existing
        .and_then(|entry| entry.get("settings"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    settings.insert(
        "provider".to_string(),
        serde_json::Value::String(provider.to_string()),
    );
    // Credentials for a sign-in provider belong to `cline auth`, not to codeg:
    // the panel offers no key or endpoint field for them, so there is no user
    // intent to write — and clearing what is not shown would log the user out.
    // `tokenSource: "oauth"` is the same statement made by an entry codeg does
    // not otherwise recognize, and is honoured for the same reason.
    let agent_managed_credential =
        cline_provider_is_agent_managed(provider) || token_source == "oauth";
    for (key, value) in [
        ("apiKey", api_key),
        ("model", model),
        ("baseUrl", base_url),
    ] {
        let credential = key != "model";
        match value {
            Some(value) => {
                if credential && agent_managed_credential {
                    continue;
                }
                settings.insert(key.to_string(), serde_json::Value::String(value.to_string()));
            }
            None => {
                if credential && agent_managed_credential {
                    continue;
                }
                settings.remove(key);
            }
        }
    }

    providers.insert(
        provider.to_string(),
        serde_json::json!({
            "settings": serde_json::Value::Object(settings),
            "updatedAt": cline_timestamp_now(),
            "tokenSource": token_source,
        }),
    );

    write_json_pretty(providers_path, &root, "cline providers.json")?;
    persist_cline_models_catalog_at(models_path, provider, model, base_url)
}

/// Register the chosen model id in `models.json` so `session/new` can actually
/// select it.
///
/// Only `openai-compatible` needs this (its model ids are user-authored rather
/// than catalogued) — for every other provider the model comes from cline's
/// built-in catalogue and an entry here would be noise. Without it the ACP
/// session silently starts on the provider's built-in default (`gpt-4o`)
/// regardless of what `providers.json` names.
fn persist_cline_models_catalog_at(
    models_path: &Path,
    provider: &str,
    model: Option<&str>,
    base_url: Option<&str>,
) -> Result<(), AcpError> {
    if provider != CLINE_CUSTOM_MODEL_PROVIDER {
        return Ok(());
    }
    let (Some(model), Some(base_url)) = (model, base_url) else {
        // Cline's own migration skips the entry when either half is missing;
        // a half-written one would pin a stale base URL into the catalogue.
        return Ok(());
    };

    let mut root = read_json_object(models_path).unwrap_or_else(|| serde_json::json!({}));
    let root_obj = root
        .as_object_mut()
        .ok_or_else(|| AcpError::protocol("cline models.json root must be an object"))?;
    root_obj.insert("version".to_string(), serde_json::json!(1));

    let providers_item = root_obj
        .entry("providers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !providers_item.is_object() {
        *providers_item = serde_json::json!({});
    }
    let providers = providers_item
        .as_object_mut()
        .ok_or_else(|| AcpError::protocol("cline models.json `providers` must be an object"))?;

    // Keep any extra models the user registered through `cline auth`, but retire
    // a previously-written entry for the model codeg is replacing.
    let mut models = providers
        .get(provider)
        .and_then(|entry| entry.get("models"))
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    models.insert(
        model.to_string(),
        serde_json::json!({
            "id": model,
            "name": model,
            "contextWindow": CLINE_CUSTOM_MODEL_CONTEXT_WINDOW,
            "maxInputTokens": CLINE_CUSTOM_MODEL_CONTEXT_WINDOW,
            "capabilities": ["streaming", "tools", "images"],
        }),
    );

    providers.insert(
        provider.to_string(),
        serde_json::json!({
            "provider": {
                "name": "OpenAI Compatible",
                "baseUrl": base_url,
                "defaultModelId": model,
            },
            "models": serde_json::Value::Object(models),
        }),
    );

    write_json_pretty(models_path, &root, "cline models.json")
}

/// `updatedAt` must satisfy zod's `z.string().datetime()`, which accepts only a
/// UTC `…Z` instant — a local offset would fail the parse and blank the store.
fn cline_timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn read_json_object(path: &Path) -> Option<serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(serde_json::Value::is_object)
}

fn write_json_pretty(path: &Path, value: &serde_json::Value, label: &str) -> Result<(), AcpError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create {label} directory failed: {e}")))?;
    }
    let serialized = serde_json::to_string_pretty(value)
        .map_err(|e| AcpError::protocol(format!("serialize {label} failed: {e}")))?;
    fs::write(path, format!("{serialized}\n"))
        .map_err(|e| AcpError::protocol(format!("write {label} failed: {e}")))
}

fn load_codex_auth_json_raw() -> Option<String> {
    fs::read_to_string(codex_auth_json_path()).ok()
}

fn load_codex_config_toml_raw() -> Option<String> {
    fs::read_to_string(codex_config_toml_path()).ok()
}

/// Read the compact codex model-catalog *source* sidecar (written next to the
/// generated catalog) so the structured editor can round-trip the list in
/// api-key mode, where no DB provider owns it.
fn load_codex_model_catalog_source_raw() -> Option<String> {
    let home = codex_home_dir();
    // 1. codeg's own source sidecar → an exact, byte-stable round-trip.
    if let Ok(raw) = fs::read_to_string(home.join(crate::acp::codex_model_catalog::SOURCE_REL)) {
        return Some(raw);
    }
    // 2. No sidecar: adopt a pre-existing `model_catalog_json` the user (or an
    //    older codeg) wrote by hand, so the editor shows those models instead of
    //    appearing empty — and the next save reproduces them rather than dropping
    //    the reference.
    import_existing_codex_catalog_source(&home)
}

/// Resolve a `model_catalog_json` value into an absolute path the way codex does:
/// `~/…` against the home dir, absolute paths verbatim, and everything else
/// relative to `CODEX_HOME`.
fn resolve_codex_home_relative(value: &str, codex_home: &Path) -> PathBuf {
    if value == "~" {
        return home_dir_or_default();
    }
    if let Some(rest) = value.strip_prefix("~/") {
        return home_dir_or_default().join(rest);
    }
    let p = Path::new(value);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        codex_home.join(value)
    }
}

/// Read a pre-existing `model_catalog_json` catalog referenced by
/// `~/.codex/config.toml` and project it into codeg's compact source shape.
/// Returns `None` when there is no reference, the file is missing/oversized/not
/// valid JSON, or it yields no usable models.
fn import_existing_codex_catalog_source(codex_home: &Path) -> Option<String> {
    let toml_value = fs::read_to_string(codex_home.join("config.toml"))
        .ok()?
        .parse::<toml::Value>()
        .ok()?;
    let rel = toml_value
        .get("model_catalog_json")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;

    let catalog_path = resolve_codex_home_relative(rel, codex_home);
    // Guard against pathological files (the shape is a small models array).
    let meta = fs::metadata(&catalog_path).ok()?;
    if meta.len() > 8 * 1024 * 1024 {
        return None;
    }
    let catalog: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(&catalog_path).ok()?).ok()?;

    let root_model = toml_value.get("model").and_then(toml::Value::as_str);
    let snapshot = crate::acp::codex_catalog_source::cached_or_bundled_snapshot();
    let config = crate::acp::codex_model_catalog::import_catalog(&catalog, root_model, &snapshot);
    if crate::acp::codex_model_catalog::is_effectively_empty(&config, &snapshot) {
        return None;
    }
    serde_json::to_string(&config).ok()
}

/// Project codex `config.toml` text into the launch-relevant config map shared
/// by the settings read-back and the staleness fingerprint. Pure (no I/O) so it
/// is unit-testable; [`load_codex_local_config_json`] is the on-disk wrapper
/// that also folds in the api key from `auth.json`.
///
/// `apiBaseUrl` / `model` / `env` mirror back into the codex runtime env via
/// [`build_runtime_env_from_setting`] (they map to `OPENAI_*`); `modelProvider`
/// deliberately does NOT (it is not an `AgentRuntimeConfig` field). It is still
/// included so a provider switch is visible to the fingerprint even when the
/// resolved `base_url` is unchanged — two providers can share one endpoint yet
/// differ in `wire_api` / auth. Before codex-acp 1.0.1 this was caught only
/// incidentally by the injected `MODEL_PROVIDER` launch env; that injection is
/// gone now that resume reads `model_provider` from config.toml (#224), so the
/// fingerprint must carry the name itself.
fn codex_config_projection_from_toml(raw_toml: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut merged = serde_json::Map::new();
    let Ok(value) = raw_toml.parse::<toml::Value>() else {
        return merged;
    };

    if let Some(model) = value
        .get("model")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        merged.insert(
            "model".to_string(),
            serde_json::Value::String(model.to_string()),
        );
    }

    let model_provider = value
        .get("model_provider")
        .and_then(|item| item.as_str())
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string);

    if let Some(provider) = &model_provider {
        merged.insert(
            "modelProvider".to_string(),
            serde_json::Value::String(provider.clone()),
        );
    }

    let mut api_base_url: Option<String> = None;
    if let Some(provider) = &model_provider {
        api_base_url = value
            .get("model_providers")
            .and_then(|table| table.get(provider.as_str()))
            .and_then(|table| table.get("base_url"))
            .and_then(|item| item.as_str())
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(str::to_string);
    }
    if api_base_url.is_none() {
        api_base_url = value
            .get("model_providers")
            .and_then(|table| table.as_table())
            .and_then(|providers| {
                providers.values().find_map(|item| {
                    item.get("base_url")
                        .and_then(|base| base.as_str())
                        .map(str::trim)
                        .filter(|base| !base.is_empty())
                        .map(str::to_string)
                })
            });
    }
    if let Some(base_url) = api_base_url {
        merged.insert(
            "apiBaseUrl".to_string(),
            serde_json::Value::String(base_url),
        );
    }

    if let Some(env) = value.get("env").and_then(|item| item.as_table()) {
        let mut env_map = serde_json::Map::new();
        for (key, item) in env {
            let Some(raw) = item.as_str() else {
                continue;
            };
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            env_map.insert(
                key.to_string(),
                serde_json::Value::String(trimmed.to_string()),
            );
        }
        if !env_map.is_empty() {
            merged.insert("env".to_string(), serde_json::Value::Object(env_map));
        }
    }

    // `[features].default_mode_request_user_input` — the flag that lets codex
    // call `request_user_input` outside Plan mode, i.e. whether codeg's
    // question cards can appear in an ordinary turn at all
    // (openai/codex#24750). Feature flags are resolved when the thread is
    // created, so flipping this only reaches a session that starts afterwards;
    // folding it into the fingerprint is what tells the user their RUNNING
    // sessions need a restart. Same false-is-default rule as the sandbox keys
    // below: absent and `false` both stay out, so a config nobody touched keeps
    // its historical fingerprint.
    if value
        .get("features")
        .and_then(|table| table.get("default_mode_request_user_input"))
        .and_then(toml::Value::as_bool)
        .unwrap_or(false)
    {
        merged.insert(
            "defaultModeRequestUserInput".to_string(),
            serde_json::Value::Bool(true),
        );
    }

    // Sandbox / approval keys. codex reads these when a thread is created
    // (`thread/start`), never mid-session, so a panel edit must mark running
    // sessions restart-required — and the fingerprint is the only channel that
    // does that. Like `modelProvider` above, they deliberately do NOT mirror
    // into the runtime env; `AgentRuntimeConfig` simply ignores them (it has no
    // `deny_unknown_fields`). Only non-default values are folded in so an
    // untouched config keeps its historical fingerprint.
    let sandbox = parse_codex_sandbox_settings(raw_toml);
    if let Some(policy) = sandbox.approval_policy {
        merged.insert(
            "approvalPolicy".to_string(),
            serde_json::Value::String(policy),
        );
    }
    if let Some(granular) = sandbox.granular {
        if let Ok(value) = serde_json::to_value(granular) {
            merged.insert("approvalGranular".to_string(), value);
        }
    }
    if let Some(mode) = sandbox.sandbox_mode {
        merged.insert("sandboxMode".to_string(), serde_json::Value::String(mode));
    }
    let ws = sandbox.workspace_write;
    if !ws.writable_roots.is_empty()
        || ws.network_access
        || ws.exclude_tmpdir_env_var
        || ws.exclude_slash_tmp
    {
        if let Ok(value) = serde_json::to_value(&ws) {
            merged.insert("sandboxWorkspaceWrite".to_string(), value);
        }
    }

    merged
}

fn load_codex_local_config_json() -> Option<String> {
    let mut merged = match fs::read_to_string(codex_config_toml_path()) {
        Ok(raw_toml) => codex_config_projection_from_toml(&raw_toml),
        Err(_) => serde_json::Map::new(),
    };

    if let Ok(raw_auth) = fs::read_to_string(codex_auth_json_path()) {
        if let Ok(auth) = serde_json::from_str::<serde_json::Value>(&raw_auth) {
            if let Some(api_key) = auth
                .get("OPENAI_API_KEY")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
            {
                merged.insert(
                    "apiKey".to_string(),
                    serde_json::Value::String(api_key.to_string()),
                );
            }
        }
    }

    if merged.is_empty() {
        return None;
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(merged)).ok()
}

fn persist_codex_local_config(config_patch_json: Option<&str>) -> Result<(), AcpError> {
    let Some(raw_patch) = config_patch_json else {
        return Ok(());
    };
    let runtime = serde_json::from_str::<AgentRuntimeConfig>(raw_patch)
        .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;
    let AgentRuntimeConfig {
        api_base_url,
        api_key,
        model,
        env,
    } = runtime;

    let config_path = codex_config_toml_path();
    let mut toml_value = if config_path.exists() {
        match fs::read_to_string(&config_path)
            .ok()
            .and_then(|raw| raw.parse::<toml::Value>().ok())
        {
            Some(existing) if existing.is_table() => existing,
            _ => toml::Value::Table(toml::map::Map::new()),
        }
    } else {
        toml::Value::Table(toml::map::Map::new())
    };

    let table = toml_value
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("codex config root must be a TOML table"))?;

    match trim_non_empty(model) {
        Some(model) => {
            table.insert("model".to_string(), toml::Value::String(model));
        }
        None => {
            table.remove("model");
        }
    }

    let provider_name = table
        .get("model_provider")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| "codeg".to_string());
    table.insert(
        "model_provider".to_string(),
        toml::Value::String(provider_name.clone()),
    );

    let providers_item = table
        .entry("model_providers".to_string())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !providers_item.is_table() {
        *providers_item = toml::Value::Table(toml::map::Map::new());
    }
    let providers = providers_item
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("invalid model_providers table"))?;
    let provider_item = providers
        .entry(provider_name.clone())
        .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
    if !provider_item.is_table() {
        *provider_item = toml::Value::Table(toml::map::Map::new());
    }
    let provider_table = provider_item
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("invalid model provider table"))?;
    match trim_non_empty(api_base_url) {
        Some(base_url) => {
            provider_table.insert("base_url".to_string(), toml::Value::String(base_url));
        }
        None => {
            provider_table.remove("base_url");
        }
    }
    if provider_name == "codeg" {
        provider_table.insert("name".to_string(), toml::Value::String("codeg".to_string()));
        provider_table.insert(
            "wire_api".to_string(),
            toml::Value::String("responses".to_string()),
        );
        ensure_codex_provider_auth_default(provider_table);
    }

    if env.is_empty() {
        table.remove("env");
    } else {
        let mut env_table = toml::map::Map::new();
        for (key, value) in env {
            let trimmed = value.trim();
            if trimmed.is_empty() {
                continue;
            }
            env_table.insert(key, toml::Value::String(trimmed.to_string()));
        }
        if env_table.is_empty() {
            table.remove("env");
        } else {
            table.insert("env".to_string(), toml::Value::Table(env_table));
        }
    }

    let serialized_toml = toml::to_string_pretty(&toml_value)
        .map_err(|e| AcpError::protocol(format!("serialize codex toml failed: {e}")))?;
    if let Some(parent) = config_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AcpError::protocol(format!("create codex config directory failed: {e}"))
        })?;
    }
    fs::write(&config_path, format!("{serialized_toml}\n"))
        .map_err(|e| AcpError::protocol(format!("write codex config failed: {e}")))?;

    let auth_path = codex_auth_json_path();
    let mut auth_value = if auth_path.exists() {
        match fs::read_to_string(&auth_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            Some(existing) if existing.is_object() => existing,
            _ => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };
    let auth_obj = auth_value
        .as_object_mut()
        .ok_or_else(|| AcpError::protocol("codex auth root must be object"))?;
    match trim_non_empty(api_key) {
        Some(api_key) => {
            auth_obj.insert(
                "OPENAI_API_KEY".to_string(),
                serde_json::Value::String(api_key),
            );
        }
        None => {
            auth_obj.remove("OPENAI_API_KEY");
        }
    }
    let serialized_auth = serde_json::to_string_pretty(&auth_value)
        .map_err(|e| AcpError::protocol(format!("serialize codex auth failed: {e}")))?;
    if let Some(parent) = auth_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create codex auth directory failed: {e}")))?;
    }
    fs::write(&auth_path, format!("{serialized_auth}\n"))
        .map_err(|e| AcpError::protocol(format!("write codex auth failed: {e}")))?;

    Ok(())
}

fn persist_codex_native_config_files(
    codex_auth_json: Option<&str>,
    codex_config_toml: Option<&str>,
) -> Result<(), AcpError> {
    if let Some(raw_toml) = codex_config_toml {
        toml::from_str::<toml::Table>(raw_toml)
            .map_err(|e| AcpError::protocol(format!("invalid codex config.toml: {e}")))?;
        let path = codex_config_toml_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AcpError::protocol(format!("create codex directory failed: {e}")))?;
        }
        fs::write(&path, raw_toml)
            .map_err(|e| AcpError::protocol(format!("write codex config.toml failed: {e}")))?;
    }

    if let Some(raw_auth) = codex_auth_json {
        let parsed = serde_json::from_str::<serde_json::Value>(raw_auth)
            .map_err(|e| AcpError::protocol(format!("invalid codex auth.json: {e}")))?;
        if !parsed.is_object() {
            return Err(AcpError::protocol(
                "invalid codex auth.json: root must be a JSON object",
            ));
        }
        let path = codex_auth_json_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AcpError::protocol(format!("create codex directory failed: {e}")))?;
        }
        fs::write(&path, raw_auth)
            .map_err(|e| AcpError::protocol(format!("write codex auth.json failed: {e}")))?;
    }

    Ok(())
}

/// Read `~/.codex/config.toml` as the base of a structured sandbox merge.
/// A missing file is an empty base; a real read error fails loudly so a save can
/// never silently drop the user's existing config.
fn read_codex_config_or_empty() -> Result<String, AcpError> {
    let path = codex_config_toml_path();
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(AcpError::protocol(format!(
            "read codex config.toml failed: {e}"
        ))),
    }
}

/// The plain-string `approval_policy` values codex 0.145 accepts.
/// `AskForApproval` also has a `Granular(GranularApprovalConfig)` variant, which
/// is a TOML *table* rather than a string and is handled separately.
const CODEX_APPROVAL_POLICIES: &[&str] = &["untrusted", "on-request", "never"];

/// `SandboxMode` — the complete upstream vocabulary.
const CODEX_SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

/// Parse the sandbox / approval keys backing the Codex panel's structured
/// controls from a raw `~/.codex/config.toml`. Read-only; uses the `toml` crate
/// so inline tables (`approval_policy = { granular = { … } }`), dotted keys and
/// arrays all read correctly. A malformed file yields defaults — the panel then
/// shows "unset" and the raw editor below it is where the user fixes the syntax.
fn parse_codex_sandbox_settings(raw_toml: &str) -> CodexSandboxSettings {
    let Ok(table) = raw_toml.parse::<toml::Table>() else {
        return CodexSandboxSettings::default();
    };

    // `approval_policy` is an externally tagged enum: a bare string for the unit
    // variants, or a single-key table for `granular`. `on-failure` is a serde
    // alias of `on-request` upstream, so it is folded here rather than shown as
    // a fourth option the panel would have to round-trip.
    let approval_item = table.get("approval_policy");
    let approval_policy = approval_item
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .map(|value| match value {
            "on-failure" => "on-request",
            other => other,
        })
        .filter(|value| CODEX_APPROVAL_POLICIES.contains(value))
        .map(str::to_string);
    let granular = approval_item
        .and_then(toml::Value::as_table)
        .and_then(|policy| policy.get("granular"))
        .and_then(toml::Value::as_table)
        .map(|granular| {
            let flag = |key: &str| {
                granular
                    .get(key)
                    .and_then(toml::Value::as_bool)
                    .unwrap_or(false)
            };
            CodexGranularApproval {
                sandbox_approval: flag("sandbox_approval"),
                rules: flag("rules"),
                skill_approval: flag("skill_approval"),
                request_permissions: flag("request_permissions"),
                mcp_elicitations: flag("mcp_elicitations"),
            }
        });

    let sandbox_mode = table
        .get("sandbox_mode")
        .and_then(toml::Value::as_str)
        .map(str::trim)
        .filter(|value| CODEX_SANDBOX_MODES.contains(value))
        .map(str::to_string);

    let ws = table
        .get("sandbox_workspace_write")
        .and_then(toml::Value::as_table);
    let ws_flag = |key: &str| {
        ws.and_then(|t| t.get(key))
            .and_then(toml::Value::as_bool)
            .unwrap_or(false)
    };
    let writable_roots = ws
        .and_then(|t| t.get("writable_roots"))
        .and_then(toml::Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(toml::Value::as_str)
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    CodexSandboxSettings {
        approval_policy,
        granular,
        sandbox_mode,
        workspace_write: CodexWorkspaceWrite {
            writable_roots,
            network_access: ws_flag("network_access"),
            exclude_tmpdir_env_var: ws_flag("exclude_tmpdir_env_var"),
            exclude_slash_tmp: ws_flag("exclude_slash_tmp"),
        },
        shadowed_by_default_permissions: table.contains_key("default_permissions"),
        has_permissions_table: table
            .get("permissions")
            .and_then(toml::Value::as_table)
            .is_some_and(|profiles| !profiles.is_empty()),
    }
}

/// A `writable_roots` entry codex will accept as-is. Upstream types the field as
/// `AbsolutePathBuf`, but a relative entry does NOT error — it is resolved
/// against `CODEX_HOME`, so `"rel/dir"` silently becomes `~/.codex/rel/dir`.
/// Rejecting it here is the only way the user learns their path was not what
/// they meant. Both POSIX (`/x`) and Windows (`C:\x`, `\\server\share`) shapes
/// are accepted regardless of the host, since the config file is portable.
fn is_absolute_config_path(value: &str) -> bool {
    let value = value.trim();
    if value.starts_with('/') || value.starts_with("\\\\") {
        return true;
    }
    let mut chars = value.chars();
    match (chars.next(), chars.next(), chars.next()) {
        (Some(drive), Some(':'), Some('\\' | '/')) => drive.is_ascii_alphabetic(),
        _ => false,
    }
}

/// Whether a `model_catalog_json` value points at the file codeg generates.
/// Anything else is the user's OWN catalog — hand-written, or authored in the
/// advanced config.toml editor — and codeg must never delete it. Resolved the
/// way codex resolves the key, so an absolute path to codeg's own file counts
/// as codeg-owned too. Unresolvable/foreign values answer `false`, which is the
/// safe direction (leave the key alone).
fn is_codeg_owned_catalog_ref(value: &str, codex_home: &Path) -> bool {
    let value = value.trim();
    if value.is_empty() {
        return false;
    }
    resolve_codex_home_relative(value, codex_home)
        == codex_home.join(crate::acp::codex_model_catalog::CATALOG_REL)
}

/// Remove the root `model_catalog_json` key from codex's config.toml, keeping
/// comments and every other key byte-identical. Returns `None` (no write) when
/// the key is absent **or** points at a catalog codeg does not own, so this is
/// safe to call on every save.
///
/// Pairs with [`crate::acp::codex_model_catalog::write_catalog_files`] returning
/// `None`: codeg's generated files and the reference to them must appear and
/// vanish together — codex refuses to start on a dangling `model_catalog_json`.
fn remove_codex_catalog_key(
    base_toml: &str,
    codex_home: &Path,
) -> Result<Option<String>, AcpError> {
    let mut doc = base_toml
        .parse::<toml_edit::Document>()
        .map_err(|e| AcpError::protocol(format!("invalid codex config.toml: {e}")))?;
    let owned = doc
        .get("model_catalog_json")
        .and_then(|v| v.as_str())
        .map(|v| is_codeg_owned_catalog_ref(v, codex_home))
        .unwrap_or(false);
    if !owned {
        return Ok(None);
    }
    doc.as_table_mut().remove("model_catalog_json");
    Ok(Some(doc.to_string()))
}

/// Drop codeg's own `model_catalog_json` reference from the config.toml on disk,
/// if it carries one. Reads fresh so it also cleans up a key written by an
/// earlier codeg version or by another window since the panel opened.
fn drop_codex_catalog_reference() -> Result<(), AcpError> {
    let base = read_codex_config_or_empty()?;
    if let Some(next) = remove_codex_catalog_key(&base, &codex_home_dir())? {
        persist_codex_native_config_files(None, Some(&next))?;
    }
    Ok(())
}

/// Apply the Codex panel's sandbox / approval PATCH to the raw config.toml text,
/// format-preservingly (comments and unmanaged keys are kept). Values are
/// validated against the upstream vocabularies first, so a UI bug can never
/// write a config codex refuses to load.
///
/// Only the fields the patch actually carries are touched — see
/// [`CodexSandboxStructuredConfig`] for why that matters. Within a carried
/// field the removal rules match codex's own defaults: an unset approval/sandbox
/// drops its key; a `false` flag or empty `writable_roots` drops that key; and a
/// `[sandbox_workspace_write]` left with no keys at all drops the section.
fn apply_codex_sandbox_config(
    base_toml: &str,
    settings: &CodexSandboxStructuredConfig,
) -> Result<String, AcpError> {
    let mut doc = base_toml
        .parse::<toml_edit::Document>()
        .map_err(|e| AcpError::protocol(format!("invalid codex config.toml: {e}")))?;

    // `approval_policy` is one externally tagged key, so the preset and the
    // granular table travel together: either both absent (leave the key alone)
    // or both present with at most one carrying a value.
    let approval = settings
        .approval_policy
        .as_ref()
        .map(|policy| policy.as_deref());
    let granular = settings.granular;
    if approval.is_some() || granular.is_some() {
        let preset = approval.flatten();
        let granular = granular.flatten();
        if preset.is_some() && granular.is_some() {
            return Err(AcpError::protocol(
                "approval_policy cannot be both a preset and a granular table",
            ));
        }
        match (preset, granular) {
            (Some(policy), _) => {
                let policy = policy.trim();
                if !CODEX_APPROVAL_POLICIES.contains(&policy) {
                    return Err(AcpError::protocol(format!(
                        "unsupported codex approval_policy: {policy}"
                    )));
                }
                // Assigning a value over an existing `[approval_policy.granular]`
                // table replaces the whole item, which is what switching away
                // from granular must do — an emptied table would fail to
                // deserialize.
                doc["approval_policy"] = toml_edit::value(policy);
            }
            (None, Some(granular)) => {
                // All five keys are always written: `sandbox_approval`, `rules`
                // and `mcp_elicitations` have no upstream default, so a partial
                // table makes codex refuse to load the config.
                let mut table = toml_edit::Table::new();
                table.insert(
                    "sandbox_approval",
                    toml_edit::value(granular.sandbox_approval),
                );
                table.insert("rules", toml_edit::value(granular.rules));
                table.insert("skill_approval", toml_edit::value(granular.skill_approval));
                table.insert(
                    "request_permissions",
                    toml_edit::value(granular.request_permissions),
                );
                table.insert(
                    "mcp_elicitations",
                    toml_edit::value(granular.mcp_elicitations),
                );
                let mut parent = toml_edit::Table::new();
                parent.insert("granular", toml_edit::Item::Table(table));
                doc["approval_policy"] = toml_edit::Item::Table(parent);
            }
            (None, None) => {
                doc.remove("approval_policy");
            }
        }
    }

    if let Some(mode) = settings.sandbox_mode.as_ref() {
        match mode.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
            Some(mode) => {
                if !CODEX_SANDBOX_MODES.contains(&mode) {
                    return Err(AcpError::protocol(format!(
                        "unsupported codex sandbox_mode: {mode}"
                    )));
                }
                doc["sandbox_mode"] = toml_edit::value(mode);
            }
            None => {
                doc.remove("sandbox_mode");
            }
        }
    }

    let roots = match settings.writable_roots.as_ref() {
        Some(roots) => {
            let roots: Vec<String> = roots
                .iter()
                .map(|root| root.trim().to_string())
                .filter(|root| !root.is_empty())
                .collect();
            if let Some(bad) = roots.iter().find(|root| !is_absolute_config_path(root)) {
                return Err(AcpError::protocol(format!(
                    "writable_roots entries must be absolute paths (codex resolves relative entries against CODEX_HOME): {bad}"
                )));
            }
            Some(roots)
        }
        None => None,
    };
    let ws_flags = [
        ("network_access", settings.network_access),
        ("exclude_tmpdir_env_var", settings.exclude_tmpdir_env_var),
        ("exclude_slash_tmp", settings.exclude_slash_tmp),
    ];
    if roots.is_some() || ws_flags.iter().any(|(_, flag)| flag.is_some()) {
        let item = &mut doc["sandbox_workspace_write"];
        if item.is_none() {
            *item = toml_edit::Item::Table(toml_edit::Table::new());
        } else if item.as_table_like_mut().is_none() {
            return Err(AcpError::protocol(
                "cannot set [sandbox_workspace_write]: it exists but is not a table",
            ));
        }
        if let Some(table) = item.as_table_like_mut() {
            if let Some(roots) = roots {
                if roots.is_empty() {
                    table.remove("writable_roots");
                } else {
                    let mut array = toml_edit::Array::new();
                    for root in &roots {
                        array.push(root.as_str());
                    }
                    table.insert("writable_roots", toml_edit::value(array));
                }
            }
            for (key, flag) in ws_flags {
                match flag {
                    Some(true) => {
                        table.insert(key, toml_edit::value(true));
                    }
                    // `false` is codex's own default for every flag here, so
                    // removing the key and writing `= false` are equivalent —
                    // removing keeps the file minimal.
                    Some(false) => {
                        table.remove(key);
                    }
                    None => {}
                }
            }
        }
        // Prune a section the patch just emptied — including one that was
        // already empty in the base — so no bare `[sandbox_workspace_write]`
        // header is left behind.
        if doc
            .get("sandbox_workspace_write")
            .and_then(|item| item.as_table_like())
            .is_some_and(|table| table.is_empty())
        {
            doc.remove("sandbox_workspace_write");
        }
    }

    Ok(doc.to_string())
}

/// Read the raw `~/.grok/config.toml` for the Grok settings panel's config-file
/// editor. `GROK_HOME` is honored via `resolve_grok_home_dir`. Returns `None`
/// when the file is absent (Grok writes it lazily on first `grok login`/run).
fn load_grok_config_toml_raw() -> Option<String> {
    fs::read_to_string(crate::parsers::grok::resolve_grok_home_dir().join("config.toml")).ok()
}

/// Read `~/.grok/config.toml` for use as the base of a structured merge. A
/// missing file yields an empty base (the merge then creates it), but any OTHER
/// read error is propagated rather than collapsed to `""` — collapsing would let
/// a transient failure clobber the user's real config with a 2-key file.
fn read_grok_config_or_empty() -> Result<String, AcpError> {
    let path = crate::parsers::grok::resolve_grok_home_dir().join("config.toml");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(AcpError::protocol(format!(
            "read grok config.toml failed: {e}"
        ))),
    }
}

/// Persist the Grok settings panel's edited `~/.grok/config.toml` back to disk.
/// Validates it parses as TOML first so a malformed edit never truncates the
/// user's real config. Unlike Codex there is no companion auth.json — Grok auth
/// lives in `~/.grok/auth.json` written by `grok login`, untouched here.
fn persist_grok_native_config_files(grok_config_toml: Option<&str>) -> Result<(), AcpError> {
    if let Some(raw_toml) = grok_config_toml {
        toml::from_str::<toml::Table>(raw_toml)
            .map_err(|e| AcpError::protocol(format!("invalid grok config.toml: {e}")))?;
        let path = crate::parsers::grok::resolve_grok_home_dir().join("config.toml");
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AcpError::protocol(format!("create grok directory failed: {e}")))?;
        }
        fs::write(&path, raw_toml)
            .map_err(|e| AcpError::protocol(format!("write grok config.toml failed: {e}")))?;
    }

    Ok(())
}

/// Parse the scalar keys that back the Grok settings panel's structured controls
/// from a raw `~/.grok/config.toml`. Read-only; uses the `toml` crate. Absent
/// keys (or a malformed file) yield `None` fields — the panel then shows the
/// "unset / default" option. Keys mirror docs.x.ai/build/settings/reference.
fn parse_grok_settings(raw_toml: &str) -> GrokSettings {
    let table = raw_toml.parse::<toml::Table>().ok();
    let get = |section: &str, key: &str| -> Option<String> {
        // `as_table` here also matches TOML inline tables, so
        // `models = { default_reasoning_effort = "high" }` reads correctly too.
        table
            .as_ref()?
            .get(section)?
            .as_table()?
            .get(key)?
            .as_str()
            .map(str::to_string)
    };

    // Read a scalar / integer from a `[model.<id>]` block for a given id.
    let model_str = |id: &str, key: &str| -> Option<String> {
        table
            .as_ref()?
            .get("model")?
            .as_table()?
            .get(id)?
            .as_table()?
            .get(key)?
            .as_str()
            .map(str::to_string)
    };
    let model_int = |id: &str, key: &str| -> Option<i64> {
        table
            .as_ref()?
            .get("model")?
            .as_table()?
            .get(id)?
            .as_table()?
            .get(key)?
            .as_integer()
    };

    // The codeg-managed custom model = `[models].default`, but only when a
    // matching `[model.<default>]` table exists — a hand-set stock default that
    // has no `[model.*]` block is left untracked (the panel shows it empty).
    let custom_model_id = get("models", "default").filter(|id| {
        table
            .as_ref()
            .and_then(|t| t.get("model"))
            .and_then(|m| m.as_table())
            .and_then(|m| m.get(id.as_str()))
            .and_then(|entry| entry.as_table())
            .is_some()
    });

    let (custom_base_url, custom_api_key, custom_api_backend, custom_context_window) =
        match custom_model_id.as_deref() {
            Some(id) => (
                model_str(id, "base_url"),
                model_str(id, "api_key"),
                model_str(id, "api_backend"),
                model_int(id, "context_window"),
            ),
            None => (None, None, None, None),
        };

    let auto_compact_threshold_percent = table
        .as_ref()
        .and_then(|t| t.get("session"))
        .and_then(|s| s.as_table())
        .and_then(|s| s.get("auto_compact_threshold_percent"))
        .and_then(|v| v.as_integer());

    GrokSettings {
        default_reasoning_effort: get("models", "default_reasoning_effort"),
        permission_mode: get("ui", "permission_mode")
            .map(|v| migrate_grok_permission_mode(&v).to_string()),
        custom_model_id,
        custom_base_url,
        custom_api_key,
        custom_api_backend,
        custom_context_window,
        auto_compact_threshold_percent,
    }
}

/// grok's real `--permission-mode` enum (docs.x.ai / verified against the
/// 0.2.99 binary). codeg historically wrote a codeg-invented
/// `permission_mode = "always-approve"` / `"ask"` into `~/.grok/config.toml`,
/// neither of which grok accepts — `grok --permission-mode always-approve`
/// errors out. `migrate_grok_permission_mode` maps those legacy markers onto the
/// real modes so the settings dropdown, the launch flag, and grok's own TUI all
/// agree.
const GROK_PERMISSION_MODES: &[&str] = &[
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "bypassPermissions",
    "plan",
];

/// Legacy → real `permission_mode` value mapping (see [`GROK_PERMISSION_MODES`]).
/// Unknown values pass through untouched (a user hand-editing config.toml to a
/// real grok mode is preserved).
fn migrate_grok_permission_mode(value: &str) -> &str {
    match value {
        "always-approve" => "bypassPermissions",
        "ask" => "default",
        other => other,
    }
}

/// Pure helper: the `--permission-mode` value this Grok `config.toml` should hand
/// the ACP launch, or `None` to pass no flag. `default` (grok's own default —
/// ACP permission requests flow to codeg's UI) and unset/unrecognized values map
/// to `None`, preserving the historical "ask" behaviour where codeg prompts.
fn grok_config_permission_mode(config_toml: &str) -> Option<String> {
    parse_grok_settings(config_toml)
        .permission_mode
        .filter(|m| m != "default" && GROK_PERMISSION_MODES.contains(&m.as_str()))
}

/// The `--permission-mode <value>` Grok's ACP launch should carry, read from the
/// global `~/.grok/config.toml` `[ui].permission_mode` (legacy-migrated by
/// `parse_grok_settings`). Best-effort: a missing/unreadable/`default` config
/// yields `None`, so the default preserves codeg's ability to prompt for approvals.
pub(crate) fn grok_launch_permission_mode() -> Option<String> {
    load_grok_config_toml_raw().and_then(|raw| grok_config_permission_mode(&raw))
}

/// Map a `~/.codex/config.toml` sandbox/approval pair onto the `INITIAL_AGENT_MODE`
/// preset id codex-acp accepts (`read-only` / `agent` / `agent-full-access`).
///
/// ## Why this mapping has to exist at all
///
/// codex-acp re-sends its OWN `approvalPolicy` + `sandboxPolicy` on every
/// `runTurn`, taken from an `AgentMode` seeded once per session from
/// `INITIAL_AGENT_MODE` (default `agent` = `on-request` + `workspace-write`).
/// So `approval_policy` / `sandbox_mode` in `config.toml` are **dead** for any
/// codeg session — chat and work task alike — even though codeg's Codex panel
/// reads, writes and fingerprints them (#442). This env var is the only
/// launch-time channel that makes the user's own config mean anything, exactly
/// like [`grok_launch_permission_mode`] above.
///
/// ## What the three presets mean (codex-acp ≥1.7.0)
///
/// | preset | sandbox | approvals reviewer |
/// |---|---|---|
/// | `read-only` ("Ask for approval") | workspace-write | `user` |
/// | `agent` ("Approve for me", DEFAULT) | workspace-write | `auto_review` |
/// | `agent-full-access` ("Full access") | danger-full-access | policy `never` |
///
/// 1.7.0 redefined these. `read-only` used to carry a genuinely read-only
/// sandbox; it now carries `workspaceWrite` like `agent`, and the two are
/// separated by a new `approvalsReviewer` axis instead — `user` routes every
/// escalation to the person, `auto_review` puts codex's Guardian model in front
/// of it and only forwards what that judges unsafe (verified in the `@openai/
/// codex` 0.148 binary: an `ApprovalsReviewer` enum plus a `guardian_*`
/// telemetry surface carrying `risk_level` / `user_authorization`; codex's own
/// `AskForApproval` vocabulary lists `on_request` and `on_request_auto_review`
/// as DISTINCT policies).
///
/// ## Why it keys off the sandbox
///
/// The sandbox is the only axis where guessing wrong ENLARGES access, so it
/// alone selects the preset; `approval_policy` is demoted to a gate that can
/// only PREVENT choosing full-access. Invariants:
///
/// 1. never widen the sandbox — the result is identical or tighter;
/// 2. never select `never` (no approvals at all) unless the config already says
///    exactly that.
///
/// ## Why the reviewer axis is NOT used to select
///
/// It is tempting to answer 1.7.0's redefinition by injecting `read-only` (the
/// only user-reviewed preset) whenever the config asks to be consulted. That is
/// wrong for two independent reasons:
///
/// - **It breaks older adapters.** `supports_custom_version()` is true for npx
///   agents, so a user may pin codex-acp ≤1.6.2, where `read-only` is still a
///   genuinely READ-ONLY sandbox. Injecting it for a `workspace-write` config
///   would leave that agent unable to write any file — a silent, hard break.
///   No preset injection is version-stable across the 1.6/1.7 boundary
///   (`read-only` changed sandbox, `agent` changed reviewer), and
///   `INITIAL_AGENT_MODE` is decided BEFORE launch, so the adapter's real
///   version is not knowable here without an `npm list -g` spawn on the connect
///   path.
/// - **It could not help the majority anyway.** This mapping only fires when
///   the user wrote a `sandbox_mode`. Everyone else gets no injection and so
///   lands on the adapter's default `agent` — i.e. `auto_review` — regardless.
///   Overriding the vendor's consent default for the minority who happened to
///   write a sandbox key, while breaking their older pins, is not a coherent
///   trade.
///
/// So the reviewer change is treated as what it is: an upstream default that
/// every ACP client now inherits. codeg DISCLOSES it in the Codex panel, and the
/// composer's approval-preset selector ("Ask for approval") remains the
/// first-class, per-session control for a user who wants to adjudicate directly.
///
/// ## What is deliberately NOT preserved
///
/// `untrusted` is not in codex-acp's vocabulary and cannot be preserved, so it
/// lands on `on-request`. That is a RELAXATION, not a tightening: `untrusted`
/// asks for everything outside its safe-list, whereas `on-request` lets the
/// model decide when to escalate, so a sandbox-permitted write stops asking.
/// The loss is inherent to the three presets and is NOT introduced here —
/// injecting nothing (the previous behavior) yields `agent`, i.e. the same
/// `on-request` PLUS a widened sandbox. Mapping is therefore strictly better on
/// the sandbox axis and neutral on the approval axis; the panel discloses the
/// approval loss to the user rather than pretending it away.
///
/// **The read-only sandbox, on codex-acp ≥1.7.0.** No preset carries one any
/// more, and the adapter re-sends the selected preset's `sandboxPolicy` on every
/// `runTurn`, so neither `config.toml` nor the `CODEX_CONFIG` session-config
/// channel can put it back. `read-only` is still the right target for a
/// read-only config — it is the tightest preset on both adapter generations —
/// but on ≥1.7.0 the session really is workspace-writable, which the panel says
/// out loud rather than papering over.
fn codex_initial_agent_mode(settings: &CodexSandboxSettings) -> Option<&'static str> {
    // `default_permissions` makes codex resolve everything through that named
    // profile and IGNORE the root sandbox/approval keys entirely (the panel
    // already warns about this). Those keys are therefore not the effective
    // policy, and mapping them would be reading a source codex itself discards:
    //
    //     approval_policy = "never"
    //     sandbox_mode = "danger-full-access"
    //     default_permissions = ":read-only"
    //
    // codex runs that read-only, but the root keys alone say "full access, no
    // approvals" — and because codex-acp re-sends the preset's policy on every
    // turn, injecting `agent-full-access` here would actually GRANT it. Decline
    // instead. codeg cannot resolve the profile, so it must not guess: this
    // leaves codex-acp's own default preset, i.e. exactly the behavior that
    // existed before this mapping (the residual gap between that default and a
    // stricter profile is pre-existing and not something codeg can close without
    // implementing codex's whole `[permissions]` resolution).
    if settings.shadowed_by_default_permissions {
        return None;
    }
    // `parse_codex_sandbox_settings` has already folded `on-failure` into
    // `on-request` and dropped anything outside `CODEX_APPROVAL_POLICIES`.
    let never = settings.approval_policy.as_deref() == Some("never");
    match settings.sandbox_mode.as_deref() {
        // The tightest preset on BOTH adapter generations: a real read-only
        // sandbox on ≤1.6.2, and workspace-write with user-adjudicated
        // approvals on ≥1.7.0 (see the note above on what 1.7.0 removed).
        Some("read-only") => Some("read-only"),
        Some("workspace-write") => Some("agent"),
        // Full access is the one preset that removes approvals entirely, so it
        // requires the config to say BOTH halves. A danger-full-access sandbox
        // paired with any approval-requiring policy tightens to `agent` instead
        // — narrower sandbox, and approvals still happen.
        Some("danger-full-access") if never => Some("agent-full-access"),
        Some("danger-full-access") => Some("agent"),
        // No sandbox expressed → nothing to preserve, so stay out of the way and
        // let codex-acp's own default stand. (codex-acp always sends an explicit
        // sandboxPolicy anyway, so config.toml's sandbox DEFAULT never applies.)
        _ => None,
    }
}

/// The `INITIAL_AGENT_MODE` value codex-acp's launch should carry, derived from
/// the global `~/.codex/config.toml`. Best-effort: a missing/unreadable/
/// unmappable config yields `None`, leaving codex-acp's default preset in place.
pub(crate) fn codex_launch_initial_agent_mode() -> Option<String> {
    let raw = load_codex_config_toml_raw()?;
    let settings = parse_codex_sandbox_settings(&raw);
    codex_initial_agent_mode(&settings).map(str::to_string)
}

/// Merge the Grok panel's structured control values into the raw config.toml
/// text, format-preservingly (comments/layout of unmanaged keys are kept). Each
/// `Some(value)` sets its documented key; each `None` removes it. Returns the
/// new TOML text (still validated on the way to disk by
/// `persist_grok_native_config_files`).
fn apply_grok_structured_config(
    base_toml: &str,
    settings: &GrokStructuredConfig,
) -> Result<String, AcpError> {
    let mut doc = base_toml
        .parse::<toml_edit::Document>()
        .map_err(|e| AcpError::protocol(format!("invalid grok config.toml: {e}")))?;
    set_or_remove_grok_key(
        &mut doc,
        "ui",
        "permission_mode",
        settings.permission_mode.as_deref(),
    )?;
    set_or_remove_grok_key(
        &mut doc,
        "models",
        "default_reasoning_effort",
        settings.default_reasoning_effort.as_deref(),
    )?;
    apply_grok_custom_model(&mut doc, settings)?;
    // `[session].auto_compact_threshold_percent` — clamp to the documented 0–100
    // range so an out-of-band value can never write an invalid config.
    set_or_remove_grok_number(
        &mut doc,
        "session",
        "auto_compact_threshold_percent",
        settings
            .auto_compact_threshold_percent
            .map(|n| n.clamp(0, 100)),
    )?;
    Ok(doc.to_string())
}

/// Write / rename / remove the codeg-managed custom Grok model. The managed block
/// is anchored as "the `[model.<id>]` whose id equals `[models].default`":
///  - a non-empty `custom_model_id` writes (or renames the previous managed block
///    to) `[model.<id>]` and points `[models].default` at it;
///  - an empty / absent id removes the previously-managed block and, when it still
///    points there, `[models].default`.
///
/// Within an active block `model = "<id>"` is always set and each empty sub-field
/// OMITS its key (empty `base_url` ⇒ Grok's official endpoint). Unmanaged keys the
/// user hand-added to the block are preserved; a rename starts a fresh block.
fn apply_grok_custom_model(
    doc: &mut toml_edit::Document,
    settings: &GrokStructuredConfig,
) -> Result<(), AcpError> {
    // Previously-managed id = current `[models].default`, but only when a matching
    // `[model.<default>]` table exists (so a hand-set stock default is never
    // mistaken for a codeg block and removed).
    let prev_id = doc
        .get("models")
        .and_then(|m| m.as_table_like())
        .and_then(|m| m.get("default"))
        .and_then(|d| d.as_str())
        .filter(|id| grok_model_block_exists(doc, id))
        .map(str::to_string);

    let target_id = settings
        .custom_model_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    match target_id {
        Some(id) => {
            // A rename removes the stale block before writing the new one.
            if let Some(prev) = prev_id.as_deref() {
                if prev != id {
                    remove_grok_model_block(doc, prev);
                }
            }
            {
                let tbl = grok_model_table_mut(doc, id)?;
                // `model` is the id sent to the API; always kept in sync with <id>.
                grok_tbl_set_str(tbl, "model", Some(id));
                grok_tbl_set_str(tbl, "base_url", trimmed_opt(settings.custom_base_url.as_deref()));
                grok_tbl_set_str(tbl, "api_key", trimmed_opt(settings.custom_api_key.as_deref()));
                grok_tbl_set_str(
                    tbl,
                    "api_backend",
                    trimmed_opt(settings.custom_api_backend.as_deref()),
                );
                grok_tbl_set_int(
                    tbl,
                    "context_window",
                    settings.custom_context_window.filter(|n| *n > 0),
                );
            }
            // Make the managed model the default for new sessions.
            set_or_remove_grok_key(doc, "models", "default", Some(id))?;
        }
        None => {
            if let Some(prev) = prev_id.as_deref() {
                remove_grok_model_block(doc, prev);
                // Clear the default only when it still points at the removed block.
                let default_still_points_here = doc
                    .get("models")
                    .and_then(|m| m.as_table_like())
                    .and_then(|m| m.get("default"))
                    .and_then(|d| d.as_str())
                    == Some(prev);
                if default_still_points_here {
                    set_or_remove_grok_key(doc, "models", "default", None)?;
                }
            }
        }
    }
    Ok(())
}

/// True when `[model.<id>]` exists as a table (standard or inline).
fn grok_model_block_exists(doc: &toml_edit::Document, id: &str) -> bool {
    doc.get("model")
        .and_then(|m| m.as_table_like())
        .and_then(|m| m.get(id))
        .map(|entry| entry.as_table_like().is_some())
        .unwrap_or(false)
}

/// Mutable handle to `[model.<id>]`, creating the implicit `[model]` parent and
/// the `<id>` sub-table as needed. Errors (rather than clobbering) if either
/// exists but is not a table.
fn grok_model_table_mut<'a>(
    doc: &'a mut toml_edit::Document,
    id: &str,
) -> Result<&'a mut dyn toml_edit::TableLike, AcpError> {
    let model = &mut doc["model"];
    if model.is_none() {
        // Implicit so a `[model]` header is never emitted for the sub-tables.
        let mut parent = toml_edit::Table::new();
        parent.set_implicit(true);
        *model = toml_edit::Item::Table(parent);
    }
    let parent = model.as_table_like_mut().ok_or_else(|| {
        AcpError::protocol("cannot write [model.<id>]: [model] exists but is not a table")
    })?;
    if parent.get(id).is_none() {
        parent.insert(id, toml_edit::Item::Table(toml_edit::Table::new()));
    }
    parent
        .get_mut(id)
        .and_then(|entry| entry.as_table_like_mut())
        .ok_or_else(|| {
            AcpError::protocol(format!(
                "cannot write [model.{id}]: it exists but is not a table"
            ))
        })
}

/// Remove `[model.<id>]`; drop the now-empty `[model]` parent so no stray header
/// lingers.
fn remove_grok_model_block(doc: &mut toml_edit::Document, id: &str) {
    let Some(parent) = doc.get_mut("model").and_then(|m| m.as_table_like_mut()) else {
        return;
    };
    parent.remove(id);
    if parent.iter().next().is_none() {
        doc.remove("model");
    }
}

/// Set (`Some`) / remove (`None`) a scalar string key in a table.
fn grok_tbl_set_str(tbl: &mut dyn toml_edit::TableLike, key: &str, value: Option<&str>) {
    match value {
        Some(v) => {
            tbl.insert(key, toml_edit::value(v));
        }
        None => {
            tbl.remove(key);
        }
    }
}

/// Set (`Some`) / remove (`None`) an integer key in a table.
fn grok_tbl_set_int(tbl: &mut dyn toml_edit::TableLike, key: &str, value: Option<i64>) {
    match value {
        Some(v) => {
            tbl.insert(key, toml_edit::value(v));
        }
        None => {
            tbl.remove(key);
        }
    }
}

/// `Some(trimmed)` only when non-empty after trimming, else `None` (so an empty
/// field omits its key rather than writing `""`).
fn trimmed_opt(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|s| !s.is_empty())
}

/// Set (`Some`) or remove (`None`) a scalar `[section].key` in a `toml_edit`
/// document. Uses the table-LIKE accessor so a standard `[section]` table AND an
/// inline `section = { … }` table are both edited in place (preserving their
/// other keys) rather than clobbered. A missing section is auto-created as a
/// table; a section that exists but is a scalar/array (incompatible) is an error
/// rather than a silent overwrite that would drop the user's value. The section
/// table itself is never removed — an empty `[ui]`/`[models]` is harmless.
fn set_or_remove_grok_key(
    doc: &mut toml_edit::Document,
    section: &str,
    key: &str,
    value: Option<&str>,
) -> Result<(), AcpError> {
    match value {
        Some(v) => {
            let item = &mut doc[section];
            if item.is_none() {
                *item = toml_edit::Item::Table(toml_edit::Table::new());
            } else if item.as_table_like_mut().is_none() {
                return Err(AcpError::protocol(format!(
                    "cannot set [{section}].{key}: [{section}] exists but is not a table"
                )));
            }
            if let Some(table) = item.as_table_like_mut() {
                table.insert(key, toml_edit::value(v));
            }
        }
        None => {
            if let Some(table) = doc.get_mut(section).and_then(|item| item.as_table_like_mut())
            {
                table.remove(key);
            }
        }
    }
    Ok(())
}

/// Integer twin of [`set_or_remove_grok_key`], for numeric `[section].key`s such
/// as `[session].auto_compact_threshold_percent`. Same table-like handling: a
/// missing section is auto-created; an incompatible non-table section errors
/// rather than being clobbered.
fn set_or_remove_grok_number(
    doc: &mut toml_edit::Document,
    section: &str,
    key: &str,
    value: Option<i64>,
) -> Result<(), AcpError> {
    match value {
        Some(v) => {
            let item = &mut doc[section];
            if item.is_none() {
                *item = toml_edit::Item::Table(toml_edit::Table::new());
            } else if item.as_table_like_mut().is_none() {
                return Err(AcpError::protocol(format!(
                    "cannot set [{section}].{key}: [{section}] exists but is not a table"
                )));
            }
            if let Some(table) = item.as_table_like_mut() {
                table.insert(key, toml_edit::value(v));
            }
        }
        None => {
            if let Some(table) = doc.get_mut(section).and_then(|item| item.as_table_like_mut())
            {
                table.remove(key);
            }
        }
    }
    Ok(())
}

fn persist_opencode_auth_json(raw_auth: &str) -> Result<(), AcpError> {
    let parsed = serde_json::from_str::<serde_json::Value>(raw_auth)
        .map_err(|e| AcpError::protocol(format!("invalid opencode auth.json: {e}")))?;
    if !parsed.is_object() {
        return Err(AcpError::protocol(
            "invalid opencode auth.json: root must be a JSON object",
        ));
    }
    let path = opencode_auth_json_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create opencode directory failed: {e}")))?;
    }
    fs::write(&path, format!("{raw_auth}\n"))
        .map_err(|e| AcpError::protocol(format!("write opencode auth.json failed: {e}")))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Kimi Code config helpers
//
// IMPORTANT — how `kimi acp` actually authenticates (reverse-engineered &
// empirically verified against @moonshot-ai/kimi-code 0.19.1; still the exact
// behaviour on 0.39.0, where the managed block + seeded token below were driven
// through a real `session/new` + `session/prompt` again):
//
// `kimi acp` gates EVERY `session/new` on an OAuth-style token: it calls
// `harnessIsAuthed`, which is true iff `~/.kimi-code/credentials/kimi-code.json`
// holds a token whose `access_token` is non-empty. It NEVER validates that token
// for the gate (no network, no signature check). API keys — whether injected via
// the `KIMI_MODEL_*` env family OR written into `config.toml` `[providers].api_key`
// — do NOT create this token, so on their own they yield `Authentication
// required`. The only advertised ACP auth method is a terminal device-code login
// (`kimi acp --login`), which requires a Kimi *subscription* account.
//
// To support plain API-key users, codeg therefore manages BOTH halves:
//   1. `config.toml` — a codeg-managed `[providers."codeg"]` + `[models."codeg-managed"]`
//      + `default_model` block that ROUTES INFERENCE to the user's API key
//      (any of the six native interface types: kimi / openai / openai_responses /
//      anthropic / google-genai / vertexai).
//   2. `credentials/kimi-code.json` — a synthetic gate token codeg seeds so the
//      ACP session opens. It is purely local: because `default_model` points at
//      the API-key provider, the managed/OAuth endpoint is never called and this
//      token is never transmitted. It carries a `_codeg_synthetic` marker so we
//      only ever remove OUR token, never a real login the user performed.
//
// The codeg-managed block is keyed by the fixed names `codeg` / `codeg-managed`
// so it is recognizable and removable without disturbing any provider/model the
// user added by hand. The raw config.toml editor is the comment/format escape
// hatch. A stale `KIMI_MODEL_*` env override would silently win over config.toml,
// so every save also clears it.
// ---------------------------------------------------------------------------

const KIMI_MANAGED_PROVIDER: &str = "codeg";
const KIMI_MANAGED_MODEL_ALIAS: &str = "codeg-managed";
const KIMI_MODEL_API_KEY_ENV: &str = "KIMI_MODEL_API_KEY";
const KIMI_MODEL_BASE_URL_ENV: &str = "KIMI_MODEL_BASE_URL";
const KIMI_MODEL_NAME_ENV: &str = "KIMI_MODEL_NAME";
/// Sentinel `access_token` value (and `_codeg_synthetic` marker) identifying the
/// gate token codeg seeds, so we never clobber a real OAuth login.
const KIMI_SYNTHETIC_TOKEN_ACCESS: &str = "codeg-local-gate";
/// Fallback context window for the managed model. Kimi's config schema **requires**
/// `[models.<alias>].max_context_size` to be a positive integer — omitting it makes
/// kimi discard the whole model block ("Ignored invalid config … models.codeg-managed"),
/// which leaves `default_model` dangling and every prompt ends with no reply. So we
/// always write one, defaulting to the kimi-k2 256K window when the user leaves it blank.
///
/// This deliberately does NOT track `parsers::infer_context_window_max_tokens`, which
/// puts `kimi-k3` on a 1M lane. The two answer different questions: that one reads a
/// past session's model id to draw a gauge, while this one is the budget codeg DECLARES
/// for a bring-your-own provider whose model is unknown — the managed block routes to
/// any of the six interface types, so the model behind it may be GPT or Claude, not a
/// Kimi model at all. Kimi spends the declared number rather than checking it (a live
/// run with this default emits `llm.request.maxTokens = 262144` and
/// `usage_update {size: 262144}`), so it is the compaction budget, not a fact about the
/// model. Users on a bigger window raise it in the config panel.
const KIMI_DEFAULT_MAX_CONTEXT_SIZE: i64 = 262_144;
/// The six native provider `type` values Kimi accepts in `[providers.<name>]`.
const KIMI_INTERFACE_TYPES: &[&str] = &[
    "kimi",
    "openai",
    "openai_responses",
    "anthropic",
    "google-genai",
    "vertexai",
];

fn kimi_code_config_toml_path() -> PathBuf {
    crate::parsers::kimi_code::resolve_kimi_code_home_dir().join("config.toml")
}

/// The synthetic-gate-token file `kimi acp` checks to decide a session is
/// authenticated (`<KIMI_CODE_HOME>/credentials/kimi-code.json`).
fn kimi_code_credentials_token_path() -> PathBuf {
    crate::parsers::kimi_code::resolve_kimi_code_home_dir()
        .join("credentials")
        .join("kimi-code.json")
}

/// The `[providers.<name>].env` variable Kimi reads each interface type's API key
/// from when the user picks "env sub-table" auth. `None` for vertexai, whose
/// credentials come from GCP Application Default Credentials (no inline key).
fn kimi_provider_key_env_var(interface_type: &str) -> Option<&'static str> {
    match interface_type {
        "kimi" => Some("KIMI_API_KEY"),
        "openai" | "openai_responses" => Some("OPENAI_API_KEY"),
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "google-genai" => Some("GOOGLE_API_KEY"),
        _ => None,
    }
}

/// The resolved codeg-managed provider/model block to write into config.toml.
struct KimiManagedSpec {
    interface_type: String,
    base_url: Option<String>,
    /// Direct `api_key` field (when the user picks "direct key" auth).
    api_key: Option<String>,
    /// `[providers.codeg.env]` sub-table entries — the env-sub-table API key, or
    /// Vertex's `GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION`.
    env: BTreeMap<String, String>,
    model: String,
    max_context_size: Option<i64>,
    /// `[models.<alias>].capabilities`. Empty ⇒ omit the key entirely, which is
    /// what "reasoning off" means — see `KIMI_BASE_CAPABILITIES`.
    capabilities: Vec<String>,
    /// `[models.<alias>].support_efforts` — the reasoning levels the composer's
    /// Thinking picker offers. Empty ⇒ omit (kimi degrades to an Off/On toggle).
    support_efforts: Vec<String>,
    /// `[models.<alias>].default_effort`. Only written when it is one of
    /// `support_efforts`; kimi otherwise falls back to the middle entry anyway.
    default_effort: Option<String>,
}

/// Input modalities always declared alongside a thinking capability.
///
/// kimi reads capabilities permissively — `if (capabilities === undefined) return true`
/// — so an ABSENT key allows everything, but a PRESENT array allows only what it
/// lists. Declaring `thinking` therefore has to re-declare the modalities that
/// were implicitly allowed before, or enabling reasoning would silently revoke
/// image/video input. `tool_use` mirrors kimi's own `capabilitiesForModel`,
/// which defaults it on (`model.supportsToolUse ?? true`). Users who need a
/// narrower set can hand-edit config.toml.
const KIMI_BASE_CAPABILITIES: &[&str] = &["image_in", "video_in", "tool_use"];
/// Capability that makes kimi advertise the Thinking picker over ACP at all
/// (`supportsThinking` = capabilities ∋ thinking | always_thinking).
const KIMI_CAPABILITY_THINKING: &str = "thinking";
/// Same, but kimi drops the `Off` row: the model cannot stop reasoning.
const KIMI_CAPABILITY_ALWAYS_THINKING: &str = "always_thinking";

/// Upsert (`Some`) or remove (`None`) the codeg-managed `[providers.codeg]` +
/// `[models.codeg-managed]` block in a parsed config.toml document, preserving
/// every other section the user authored. Removal also resets `default_model`
/// only when it points at our managed alias.
fn apply_kimi_managed_block(
    toml_value: &mut toml::Value,
    spec: Option<&KimiManagedSpec>,
) -> Result<(), AcpError> {
    let table = toml_value
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("kimi config root must be a TOML table"))?;
    match spec {
        Some(spec) => {
            let providers = table
                .entry("providers".to_string())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if !providers.is_table() {
                *providers = toml::Value::Table(toml::map::Map::new());
            }
            let providers = providers.as_table_mut().expect("providers set to table");
            let mut provider_table = toml::map::Map::new();
            provider_table.insert(
                "type".to_string(),
                toml::Value::String(spec.interface_type.clone()),
            );
            if let Some(url) = spec.base_url.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                provider_table.insert("base_url".to_string(), toml::Value::String(url.to_string()));
            }
            if let Some(key) = spec.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                provider_table.insert("api_key".to_string(), toml::Value::String(key.to_string()));
            }
            if !spec.env.is_empty() {
                let mut env_table = toml::map::Map::new();
                for (k, v) in &spec.env {
                    let trimmed = v.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    env_table.insert(k.clone(), toml::Value::String(trimmed.to_string()));
                }
                if !env_table.is_empty() {
                    provider_table.insert("env".to_string(), toml::Value::Table(env_table));
                }
            }
            providers.insert(
                KIMI_MANAGED_PROVIDER.to_string(),
                toml::Value::Table(provider_table),
            );

            let models = table
                .entry("models".to_string())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if !models.is_table() {
                *models = toml::Value::Table(toml::map::Map::new());
            }
            let models = models.as_table_mut().expect("models set to table");
            let mut model_table = toml::map::Map::new();
            model_table.insert(
                "provider".to_string(),
                toml::Value::String(KIMI_MANAGED_PROVIDER.to_string()),
            );
            model_table.insert("model".to_string(), toml::Value::String(spec.model.clone()));
            // Always emit a positive `max_context_size`: kimi's schema requires it and
            // silently drops the entire model block otherwise (→ empty turns). Fall back
            // to the default window when the user did not specify one.
            let ctx = spec
                .max_context_size
                .filter(|c| *c > 0)
                .unwrap_or(KIMI_DEFAULT_MAX_CONTEXT_SIZE);
            model_table.insert("max_context_size".to_string(), toml::Value::Integer(ctx));
            // Reasoning metadata. Each key is omitted when empty so the block
            // stays byte-identical to the pre-reasoning shape when the feature
            // is off — kimi treats an absent `capabilities` as "allow all" and
            // an absent `support_efforts` as "no effort levels".
            if !spec.capabilities.is_empty() {
                model_table.insert(
                    "capabilities".to_string(),
                    toml::Value::Array(
                        spec.capabilities
                            .iter()
                            .map(|c| toml::Value::String(c.clone()))
                            .collect(),
                    ),
                );
            }
            if !spec.support_efforts.is_empty() {
                model_table.insert(
                    "support_efforts".to_string(),
                    toml::Value::Array(
                        spec.support_efforts
                            .iter()
                            .map(|e| toml::Value::String(e.clone()))
                            .collect(),
                    ),
                );
            }
            if let Some(effort) = &spec.default_effort {
                model_table.insert(
                    "default_effort".to_string(),
                    toml::Value::String(effort.clone()),
                );
            }
            models.insert(
                KIMI_MANAGED_MODEL_ALIAS.to_string(),
                toml::Value::Table(model_table),
            );

            table.insert(
                "default_model".to_string(),
                toml::Value::String(KIMI_MANAGED_MODEL_ALIAS.to_string()),
            );
        }
        None => {
            let providers_empty = if let Some(providers) =
                table.get_mut("providers").and_then(toml::Value::as_table_mut)
            {
                providers.remove(KIMI_MANAGED_PROVIDER);
                providers.is_empty()
            } else {
                false
            };
            if providers_empty {
                table.remove("providers");
            }
            let models_empty = if let Some(models) =
                table.get_mut("models").and_then(toml::Value::as_table_mut)
            {
                models.remove(KIMI_MANAGED_MODEL_ALIAS);
                models.is_empty()
            } else {
                false
            };
            if models_empty {
                table.remove("models");
            }
            if table.get("default_model").and_then(toml::Value::as_str) == Some(KIMI_MANAGED_MODEL_ALIAS)
            {
                table.remove("default_model");
            }
        }
    }
    Ok(())
}

/// Read-modify-write `config.toml`, upserting (`Some`) or clearing (`None`) the
/// codeg-managed block. A clear on a non-existent file is a no-op (never creates
/// an empty file). Reuses the existing `toml` crate: data in other sections is
/// preserved; comments/formatting are not (the raw editor covers that).
fn mutate_kimi_config_toml(spec: Option<&KimiManagedSpec>) -> Result<(), AcpError> {
    let path = kimi_code_config_toml_path();
    if spec.is_none() && !path.exists() {
        return Ok(());
    }
    let mut toml_value = if path.exists() {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|raw| raw.parse::<toml::Value>().ok())
        {
            Some(existing) if existing.is_table() => existing,
            _ => toml::Value::Table(toml::map::Map::new()),
        }
    } else {
        toml::Value::Table(toml::map::Map::new())
    };
    apply_kimi_managed_block(&mut toml_value, spec)?;
    let serialized = toml::to_string_pretty(&toml_value)
        .map_err(|e| AcpError::protocol(format!("serialize kimi config.toml failed: {e}")))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create kimi config directory failed: {e}")))?;
    }
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|e| AcpError::protocol(format!("write kimi config.toml failed: {e}")))?;
    Ok(())
}

/// Read and parse a token file, if present and valid JSON.
fn read_kimi_token_at(path: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn read_kimi_token() -> Option<serde_json::Value> {
    read_kimi_token_at(&kimi_code_credentials_token_path())
}

/// Whether a token document is codeg's synthetic gate token (vs a real OAuth
/// login the user performed via `kimi login`). Matches either the sentinel
/// `access_token` or the explicit `_codeg_synthetic` marker.
fn kimi_token_is_synthetic(token: &serde_json::Value) -> bool {
    token
        .get("_codeg_synthetic")
        .and_then(serde_json::Value::as_bool)
        == Some(true)
        || token.get("access_token").and_then(serde_json::Value::as_str)
            == Some(KIMI_SYNTHETIC_TOKEN_ACCESS)
}

/// Whether a token document carries a non-empty `access_token` — i.e. would pass
/// `kimi acp`'s session gate.
fn kimi_token_has_access(token: &serde_json::Value) -> bool {
    token
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Whether any usable credential (real or synthetic) is present.
fn kimi_credential_present() -> bool {
    read_kimi_token().map(|t| kimi_token_has_access(&t)).unwrap_or(false)
}

/// Whether the present credential is codeg's synthetic gate token.
fn kimi_credential_is_synthetic() -> bool {
    read_kimi_token()
        .map(|t| kimi_token_is_synthetic(&t))
        .unwrap_or(false)
}

/// Seed codeg's synthetic gate token at `path` so `kimi acp` treats the session
/// as authenticated. No-op (preserves) when a REAL OAuth login token is already
/// present — that already satisfies the gate and must never be clobbered.
fn seed_kimi_synthetic_credential_at(path: &Path) -> Result<(), AcpError> {
    if let Some(existing) = read_kimi_token_at(path) {
        if kimi_token_has_access(&existing) && !kimi_token_is_synthetic(&existing) {
            return Ok(());
        }
    }
    let token = serde_json::json!({
        "access_token": KIMI_SYNTHETIC_TOKEN_ACCESS,
        "refresh_token": "",
        "expires_at": 9_999_999_999i64,
        "expires_in": 9_999_999i64,
        "scope": "",
        "token_type": "Bearer",
        "_codeg_synthetic": true,
    });
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AcpError::protocol(format!("create kimi credentials directory failed: {e}"))
        })?;
    }
    let body = serde_json::to_string_pretty(&token)
        .map_err(|e| AcpError::protocol(format!("serialize kimi credential failed: {e}")))?;
    fs::write(path, format!("{body}\n"))
        .map_err(|e| AcpError::protocol(format!("write kimi credential failed: {e}")))?;
    Ok(())
}

fn seed_kimi_synthetic_credential() -> Result<(), AcpError> {
    seed_kimi_synthetic_credential_at(&kimi_code_credentials_token_path())
}

/// Remove the gate token at `path` ONLY when it is codeg's synthetic one —
/// leaving any real OAuth login the user performed untouched.
fn remove_kimi_synthetic_credential_if_ours_at(path: &Path) -> Result<(), AcpError> {
    match read_kimi_token_at(path) {
        Some(token) if kimi_token_is_synthetic(&token) => fs::remove_file(path)
            .map_err(|e| AcpError::protocol(format!("remove kimi credential failed: {e}"))),
        _ => Ok(()),
    }
}

fn remove_kimi_synthetic_credential_if_ours() -> Result<(), AcpError> {
    remove_kimi_synthetic_credential_if_ours_at(&kimi_code_credentials_token_path())
}

/// Project the codeg-managed config.toml block into a flat JSON object for the
/// settings panel, plus the raw file text for the advanced editor. Uses keys
/// (`baseUrl` / `key` / `modelId`, never `apiBaseUrl` / `apiKey` / `model` /
/// `env`) that do NOT match `AgentRuntimeConfig`, so `build_runtime_env_from_setting`
/// never mirrors these file values back into the `KIMI_MODEL_*` runtime env.
fn project_kimi_managed_config(value: &toml::Value) -> serde_json::Map<String, serde_json::Value> {
    let mut merged = serde_json::Map::new();

    if let Some(provider) = value
        .get("providers")
        .and_then(|t| t.get(KIMI_MANAGED_PROVIDER))
        .and_then(toml::Value::as_table)
    {
        let interface_type = provider
            .get("type")
            .and_then(toml::Value::as_str)
            .map(str::to_string);
        if let Some(itype) = &interface_type {
            merged.insert(
                "interfaceType".to_string(),
                serde_json::Value::String(itype.clone()),
            );
        }
        if let Some(url) = provider
            .get("base_url")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            merged.insert(
                "baseUrl".to_string(),
                serde_json::Value::String(url.to_string()),
            );
        }
        if let Some(key) = provider
            .get("api_key")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            merged.insert("key".to_string(), serde_json::Value::String(key.to_string()));
            merged.insert(
                "authType".to_string(),
                serde_json::Value::String("api_key".to_string()),
            );
        }
        if let Some(env) = provider.get("env").and_then(toml::Value::as_table) {
            if let Some(project) = env.get("GOOGLE_CLOUD_PROJECT").and_then(toml::Value::as_str) {
                merged.insert(
                    "vertexProject".to_string(),
                    serde_json::Value::String(project.to_string()),
                );
            }
            if let Some(location) = env.get("GOOGLE_CLOUD_LOCATION").and_then(toml::Value::as_str) {
                merged.insert(
                    "vertexLocation".to_string(),
                    serde_json::Value::String(location.to_string()),
                );
            }
            if let Some(var) = interface_type.as_deref().and_then(kimi_provider_key_env_var) {
                if let Some(key) = env
                    .get(var)
                    .and_then(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    merged.insert("key".to_string(), serde_json::Value::String(key.to_string()));
                    merged.insert(
                        "authType".to_string(),
                        serde_json::Value::String("env".to_string()),
                    );
                }
            }
        }
    }
    if let Some(model) = value
        .get("models")
        .and_then(|t| t.get(KIMI_MANAGED_MODEL_ALIAS))
        .and_then(toml::Value::as_table)
    {
        if let Some(model_id) = model
            .get("model")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            merged.insert(
                "modelId".to_string(),
                serde_json::Value::String(model_id.to_string()),
            );
        }
        if let Some(ctx) = model.get("max_context_size").and_then(toml::Value::as_integer) {
            merged.insert(
                "maxContextSize".to_string(),
                serde_json::Value::Number(ctx.into()),
            );
        }
        // Reasoning metadata. `capabilities` round-trips so the panel can tell
        // whether reasoning is on (and whether it is the always-on flavour)
        // without re-deriving it from the effort list.
        let string_array = |key: &str| -> Option<Vec<serde_json::Value>> {
            Some(
                model
                    .get(key)?
                    .as_array()?
                    .iter()
                    .filter_map(toml::Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| serde_json::Value::String(s.to_string()))
                    .collect(),
            )
        };
        if let Some(caps) = string_array("capabilities") {
            merged.insert("capabilities".to_string(), serde_json::Value::Array(caps));
        }
        if let Some(efforts) = string_array("support_efforts") {
            merged.insert(
                "supportEfforts".to_string(),
                serde_json::Value::Array(efforts),
            );
        }
        if let Some(effort) = model
            .get("default_effort")
            .and_then(toml::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            merged.insert(
                "defaultEffort".to_string(),
                serde_json::Value::String(effort.to_string()),
            );
        }
    }

    let has_managed = merged.contains_key("interfaceType");
    merged.insert("hasManagedBlock".to_string(), serde_json::Value::Bool(has_managed));
    merged
}

fn load_kimi_code_config_json() -> Option<String> {
    let raw = fs::read_to_string(kimi_code_config_toml_path()).ok();
    let mut merged = match raw.as_deref().and_then(|text| text.parse::<toml::Value>().ok()) {
        Some(value) => project_kimi_managed_config(&value),
        None => {
            let mut m = serde_json::Map::new();
            m.insert("hasManagedBlock".to_string(), serde_json::Value::Bool(false));
            m
        }
    };
    // Surface the gate-credential state so the panel can show whether `kimi acp`
    // is currently authenticated and whether that came from codeg's synthetic
    // token or a real OAuth login.
    merged.insert(
        "credentialPresent".to_string(),
        serde_json::Value::Bool(kimi_credential_present()),
    );
    merged.insert(
        "credentialSynthetic".to_string(),
        serde_json::Value::Bool(kimi_credential_is_synthetic()),
    );
    if let Some(text) = raw {
        merged.insert("rawConfigToml".to_string(), serde_json::Value::String(text));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(merged)).ok()
}

/// Structured Kimi Code config update from the settings UI. `mode` is one of:
/// `apikey` — write the codeg-managed `config.toml` provider/model block AND seed
/// the synthetic gate token, so the API key actually authenticates `kimi acp`;
/// `login` — clear the managed block + remove our synthetic token so a real OAuth
/// login governs; `raw` — write a verbatim config.toml then seed the gate token.
/// Every mode also clears any stale `KIMI_MODEL_*` env override (it would
/// silently win over config.toml).
#[derive(Debug, Clone)]
pub(crate) struct KimiCodeConfigUpdate {
    pub mode: String,
    pub interface_type: Option<String>,
    pub auth_type: Option<String>,
    pub base_url: Option<String>,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub max_context_size: Option<i64>,
    pub vertex_project: Option<String>,
    pub vertex_location: Option<String>,
    pub raw_config_toml: Option<String>,
    /// Declare a thinking capability so `kimi acp` advertises its Thinking
    /// picker at all. `None`/`false` writes no `capabilities` key, leaving
    /// kimi's permissive default (and no picker) exactly as before.
    pub reasoning_enabled: Option<bool>,
    /// Use `always_thinking` instead of `thinking`, dropping the `Off` row.
    pub always_thinking: Option<bool>,
    /// The reasoning levels offered in the composer. Passed through to the
    /// provider verbatim — kimi does no client-side mapping for non-Kimi
    /// providers, so an unsupported level fails at request time, not here.
    pub support_efforts: Option<Vec<String>>,
    pub default_effort: Option<String>,
}

/// Validate + resolve a `native`-mode update into the managed block to write.
fn build_kimi_managed_spec(update: &KimiCodeConfigUpdate) -> Result<KimiManagedSpec, AcpError> {
    let interface_type = update.interface_type.as_deref().map(str::trim).unwrap_or("");
    if !KIMI_INTERFACE_TYPES.contains(&interface_type) {
        return Err(AcpError::protocol(format!(
            "unknown kimi interface type: '{interface_type}'"
        )));
    }
    let model = update
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AcpError::protocol("kimi native config requires a model id"))?
        .to_string();
    let base_url = update
        .base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(url) = &base_url {
        if url.contains(['\n', '\r']) {
            return Err(AcpError::protocol("kimi base url must not contain newlines"));
        }
    }

    let mut env: BTreeMap<String, String> = BTreeMap::new();
    let mut api_key: Option<String> = None;

    if interface_type == "vertexai" {
        // Vertex AI: no API key (GCP Application Default Credentials). Persist the
        // project/location into the provider env sub-table.
        if let Some(project) = update
            .vertex_project
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            env.insert("GOOGLE_CLOUD_PROJECT".to_string(), project.to_string());
        }
        if let Some(location) = update
            .vertex_location
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            env.insert("GOOGLE_CLOUD_LOCATION".to_string(), location.to_string());
        }
    } else if let Some(key) = update
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if key.contains(['\n', '\r']) {
            return Err(AcpError::protocol("kimi api key must not contain newlines"));
        }
        // "env" auth writes the key into the provider env sub-table under the
        // interface's canonical key var; otherwise it goes in the inline `api_key`.
        if update.auth_type.as_deref() == Some("env") {
            match kimi_provider_key_env_var(interface_type) {
                Some(var) => {
                    env.insert(var.to_string(), key.to_string());
                }
                None => api_key = Some(key.to_string()),
            }
        } else {
            api_key = Some(key.to_string());
        }
    }

    // ---- Reasoning metadata ----
    // `kimi acp` suppresses its Thinking picker unless the model declares a
    // thinking capability, and sources the picker's rows from `support_efforts`
    // ("the single source of truth for efforts"). Both only apply when the user
    // turned reasoning on; otherwise every key is left out and the block keeps
    // its previous shape.
    let reasoning_enabled = update.reasoning_enabled.unwrap_or(false);
    let mut capabilities: Vec<String> = Vec::new();
    let mut support_efforts: Vec<String> = Vec::new();
    let mut default_effort: Option<String> = None;

    if reasoning_enabled {
        capabilities.push(
            if update.always_thinking.unwrap_or(false) {
                KIMI_CAPABILITY_ALWAYS_THINKING
            } else {
                KIMI_CAPABILITY_THINKING
            }
            .to_string(),
        );
        capabilities.extend(KIMI_BASE_CAPABILITIES.iter().map(|c| c.to_string()));

        for raw in update.support_efforts.iter().flatten() {
            let effort = raw.trim();
            if effort.is_empty() {
                continue;
            }
            if effort.contains(['\n', '\r']) {
                return Err(AcpError::protocol(
                    "kimi thinking effort must not contain newlines",
                ));
            }
            if !support_efforts.iter().any(|e| e == effort) {
                support_efforts.push(effort.to_string());
            }
        }

        // kimi clamps an out-of-range default back to the middle entry, so an
        // unlisted value is dropped rather than rejected — writing it would
        // only misrepresent what the composer will actually show.
        default_effort = update
            .default_effort
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter(|s| support_efforts.iter().any(|e| e == s))
            .map(str::to_string);
    }

    Ok(KimiManagedSpec {
        interface_type: interface_type.to_string(),
        base_url,
        api_key,
        env,
        model,
        max_context_size: update.max_context_size.filter(|c| *c > 0),
        capabilities,
        support_efforts,
        default_effort,
    })
}

/// Clear any `KIMI_MODEL_*` env override from the DB `env_json`, preserving every
/// other env key and the agent's enabled/provider state. `kimi acp` reads that
/// env family BEFORE config.toml, so a stale entry would silently override the
/// codeg-managed provider; every save clears it to keep config.toml authoritative.
/// Ensures the settings row exists first. No-op fast path when nothing to clear.
async fn clear_kimi_model_env(db: &AppDatabase) -> Result<(), AcpError> {
    let default = agent_setting_service::AgentDefaultInput {
        agent_type: AgentType::KimiCode,
        registry_id: registry::registry_id_for(AgentType::KimiCode).to_string(),
        default_sort_order: i32::MAX / 2,
    };
    agent_setting_service::ensure_defaults(&db.conn, &[default])
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::KimiCode)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let enabled = setting.as_ref().map(|m| m.enabled).unwrap_or(true);
    let model_provider_id = setting.as_ref().and_then(|m| m.model_provider_id);
    let mut env: BTreeMap<String, String> = setting
        .and_then(|m| m.env_json)
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    let had = env.remove(KIMI_MODEL_BASE_URL_ENV).is_some()
        | env.remove(KIMI_MODEL_API_KEY_ENV).is_some()
        | env.remove(KIMI_MODEL_NAME_ENV).is_some();
    if !had {
        return Ok(());
    }
    let env_json = serde_json::to_string(&env)
        .map_err(|e| AcpError::protocol(format!("serialize kimi env failed: {e}")))?;
    agent_setting_service::update(
        &db.conn,
        AgentType::KimiCode,
        agent_setting_service::AgentSettingsUpdate {
            enabled,
            env_json: Some(env_json),
            model_provider_id,
        },
    )
    .await
    .map_err(|e| AcpError::protocol(e.to_string()))?;
    Ok(())
}

/// Apply a structured Kimi config update across both stores (DB `env_json` +
/// `~/.kimi-code/config.toml`), keeping exactly one authoritative. Validates the
/// whole request before any write, then writes config.toml first so an env-write
/// failure can never leave the file pointing at credentials that were rolled back.
pub(crate) async fn acp_update_kimi_code_config_core(
    update: KimiCodeConfigUpdate,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    enum FileAction {
        Managed(Option<KimiManagedSpec>),
        Raw(String),
    }
    // What to do with the synthetic gate token after the config write. `kimi acp`
    // won't open a session without it, so API-key/raw seed it; OAuth-login removes
    // only OUR token (never a real login).
    enum CredentialAction {
        Seed,
        RemoveIfOurs,
    }

    // ---- Plan + validate (no writes yet) ----
    let (file_action, credential_action) = match update.mode.trim() {
        "apikey" => (
            FileAction::Managed(Some(build_kimi_managed_spec(&update)?)),
            CredentialAction::Seed,
        ),
        "login" => (FileAction::Managed(None), CredentialAction::RemoveIfOurs),
        "raw" => {
            let raw = update.raw_config_toml.as_deref().unwrap_or("");
            toml::from_str::<toml::Table>(raw)
                .map_err(|e| AcpError::protocol(format!("invalid kimi config.toml: {e}")))?;
            (FileAction::Raw(raw.to_string()), CredentialAction::Seed)
        }
        other => {
            return Err(AcpError::protocol(format!("unknown kimi config mode: '{other}'")));
        }
    };

    // ---- Apply: config.toml, then the gate token, then clear the env override ----
    match file_action {
        FileAction::Managed(spec) => mutate_kimi_config_toml(spec.as_ref())?,
        FileAction::Raw(raw) => {
            let path = kimi_code_config_toml_path();
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    AcpError::protocol(format!("create kimi config directory failed: {e}"))
                })?;
            }
            fs::write(&path, raw)
                .map_err(|e| AcpError::protocol(format!("write kimi config.toml failed: {e}")))?;
        }
    }
    match credential_action {
        CredentialAction::Seed => seed_kimi_synthetic_credential()?,
        CredentialAction::RemoveIfOurs => remove_kimi_synthetic_credential_if_ours()?,
    }
    clear_kimi_model_env(db).await?;
    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::KimiCode));
    Ok(())
}

/// `acp_update_kimi_code_config_core` followed by a session staleness refresh.
/// Shared by the Tauri command and the web handler; returns the count of running
/// Kimi sessions left on stale (launch-time) config.
pub(crate) async fn acp_update_kimi_code_config_and_refresh(
    update: KimiCodeConfigUpdate,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<usize, AcpError> {
    acp_update_kimi_code_config_core(update, db, emitter).await?;
    Ok(refresh_config_staleness(
        manager,
        db,
        data_dir,
        &[AgentType::KimiCode],
        ConfigStaleKind::AgentConfig,
    )
    .await)
}

/// Validate an API key + endpoint by listing the account's models. GETs
/// `<base_url>/models` with the key as a Bearer token and returns the model ids
/// (OpenAI-compatible `{ "data": [{ "id": ... }] }`). Surfaces the provider's
/// own error message on failure. Lets the settings panel populate a model picker
/// and doubles as a one-click connection test — directly preventing the
/// "Not found the model ..." trap of typing a model the account can't access.
pub(crate) async fn acp_fetch_kimi_models_core(
    base_url: &str,
    api_key: &str,
) -> Result<Vec<String>, AcpError> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err(AcpError::protocol("base URL is required to list models"));
    }
    let key = api_key.trim();
    if key.is_empty() {
        return Err(AcpError::protocol("API key is required to list models"));
    }
    let url = format!("{base}/models");
    let resp = reqwest::Client::new()
        .get(&url)
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| AcpError::protocol(format!("list models request failed: {e}")))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| AcpError::protocol(format!("list models returned invalid JSON: {e}")))?;
    if !status.is_success() {
        let msg = body
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("request rejected");
        return Err(AcpError::protocol(format!("{status}: {msg}")));
    }
    let mut ids: Vec<String> = body
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("id")
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    Ok(ids)
}

// ---------------------------------------------------------------------------
// Pi config helpers
//
// pi (the self-extensible coding agent, reached over ACP via `pi-acp`) reads its
// model selection from `~/.pi/agent/settings.json` (`defaultProvider`,
// `defaultModel`, `defaultThinkingLevel` — plain strings) and its API keys from
// `~/.pi/agent/auth.json` (`{ "<provider>": { "type": "api_key", "key": ... } }`).
// codeg manages both NATIVE files directly (merge-writes that preserve every
// other key), mirroring how it manages Codex's `auth.json`/`config.toml`. The
// agent dir honors `PI_CODING_AGENT_DIR` so a custom pi install can be targeted.
// ---------------------------------------------------------------------------

/// Resolve pi's coding-agent dir: `PI_CODING_AGENT_DIR` if set (trimmed,
/// non-empty), else `~/.pi/agent` (mirrors `codex_home_dir`/`resolve_kimi_*`).
pub(crate) fn pi_agent_dir() -> PathBuf {
    match std::env::var("PI_CODING_AGENT_DIR")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(value) => PathBuf::from(value),
        None => home_dir_or_default().join(".pi").join("agent"),
    }
}

fn pi_settings_json_path() -> PathBuf {
    pi_agent_dir().join("settings.json")
}

fn pi_auth_json_path() -> PathBuf {
    pi_agent_dir().join("auth.json")
}

fn pi_models_json_path() -> PathBuf {
    pi_agent_dir().join("models.json")
}

/// Like [`pi_agent_dir`], but resolves `PI_CODING_AGENT_DIR` from a per-agent
/// `runtime_env` map first (the BYO-pi override path) before falling back to the
/// process env / `~/.pi/agent`. Launch-time trust seeding only has the per-agent
/// env (the override never lands in codeg's own process env), so it must consult
/// `runtime_env` to target the same agent dir pi-acp will spawn pi against.
fn pi_agent_dir_for_env(runtime_env: &BTreeMap<String, String>) -> PathBuf {
    match runtime_env
        .get("PI_CODING_AGENT_DIR")
        .map(|raw| raw.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        Some(value) => PathBuf::from(value),
        None => pi_agent_dir(),
    }
}

// NOTE: the per-agent `env_json` key `PI_ACP_TRUST_WORKSPACE` used to gate
// launch-time workspace-trust seeding here. codeg no longer seeds trust at all —
// project trust is an explicit per-workspace decision now — so nothing on the
// Rust side reads that key. The frontend still lists it as a reserved pi env key
// so a `"0"` persisted by an older build stays out of the raw env editor instead
// of resurfacing there as a user-defined variable.

/// The `<cwd>/.pi/` entries whose mere presence makes a project "trust-requiring"
/// for pi. Mirrors pi's own `TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES`
/// (`core/trust-manager.js`, verified against pi 0.80.2).
///
/// This list is a mirror of another project's constant, so it can drift if pi
/// adds a resource kind. It fails safe in both directions: under-detecting only
/// means codeg stays quiet about resources pi would ignore anyway (pi's own
/// non-interactive default is "don't load"), and over-detecting only costs one
/// extra prompt. Neither direction can load a resource without the user's word.
const PI_TRUST_REQUIRING_CONFIG_RESOURCES: [&str; 7] = [
    "settings.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

/// One repo-shipped pi resource that only loads once the workspace is trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProjectResource {
    /// Absolute path pi would load.
    pub path: String,
    /// Stable, display-friendly kind (e.g. `.pi/extensions`, `.agents/skills`).
    pub kind: String,
    /// Whether loading this resource means executing repo-controlled code at pi
    /// startup, as opposed to feeding it repo-controlled text. `.pi/extensions`
    /// are JS/TS modules whose top level runs immediately, and `.pi/settings.json`
    /// can make pi install project packages — the approval UI must say so plainly
    /// rather than describing all of these as "config".
    pub executes_code: bool,
}

/// pi keys `trust.json` by the directory's realpath. Mirror `realpathSync` with
/// `fs::canonicalize`, dropping Windows' verbatim (`\\?\`) prefix — Node never
/// emits that form, so leaving it on would produce keys pi can't match.
/// Falls back to the path as given when it can't be resolved (e.g. missing dir),
/// which keeps this usable for display.
fn pi_canonical_path(path: &Path) -> PathBuf {
    crate::paths::simplify_verbatim_path(&fs::canonicalize(path).unwrap_or_else(|_| path.into()))
}

/// List the repo-shipped pi resources in `cwd` that pi will only load once the
/// workspace is trusted. Empty ⇒ pi trusts the project trivially (its
/// `resolveProjectTrusted` returns `true` when nothing requires trust), so there
/// is nothing to ask the user about.
///
/// Mirrors pi's `hasTrustRequiringProjectResources`, but collects every match
/// instead of returning on the first one so the approval UI can name the files.
/// The emptiness of the result is equivalent to pi's boolean.
pub(crate) fn pi_project_trust_resources(cwd: &Path) -> Vec<PiProjectResource> {
    pi_project_trust_resources_with_home(cwd, &home_dir_or_default())
}

/// `pi_project_trust_resources` with the user's home passed in rather than
/// resolved, so the `~/.agents/skills` exclusion can be exercised against a
/// fixture: `dirs::home_dir()` reads the `FOLDERID_Profile` known folder on
/// Windows and ignores `HOME`/`USERPROFILE`, so pinning the env there cannot
/// redirect it.
fn pi_project_trust_resources_with_home(cwd: &Path, home: &Path) -> Vec<PiProjectResource> {
    let mut found = Vec::new();
    let start = pi_canonical_path(cwd);

    let config_dir = start.join(".pi");
    for entry in PI_TRUST_REQUIRING_CONFIG_RESOURCES {
        let path = config_dir.join(entry);
        if path.exists() {
            found.push(PiProjectResource {
                path: path.to_string_lossy().to_string(),
                kind: format!(".pi/{entry}"),
                // Extensions are modules pi imports (top-level code runs); project
                // settings can pull in and install project packages.
                executes_code: matches!(entry, "extensions" | "settings.json"),
            });
        }
    }

    // pi also honors `.agents/skills` from `cwd` upward, EXCEPT the user's own
    // `~/.agents/skills` (that is a user-scope store, not a repo's).
    let user_agents_skills = pi_canonical_path(home).join(".agents").join("skills");
    let mut current = start.as_path();
    loop {
        let candidate = current.join(".agents").join("skills");
        if candidate != user_agents_skills && candidate.exists() {
            found.push(PiProjectResource {
                path: candidate.to_string_lossy().to_string(),
                kind: ".agents/skills".to_string(),
                executes_code: false,
            });
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }

    found
}

/// Resolve the decision that actually applies to `cwd`, mirroring pi's
/// `findNearestTrustEntry`: walk `cwd` upward and take the first entry whose
/// value is a real boolean. A `null` entry does NOT stop the walk (pi only
/// accepts `true`/`false`), which is how "clear this folder's decision and defer
/// to an ancestor" works.
///
/// Returns the deciding path alongside the verdict so the UI can distinguish
/// "this folder" from "inherited from a parent folder" — the inherited case is
/// how a single seeded parent silently covered every repo beneath it.
fn pi_nearest_trust_decision(trust_file: &Path, cwd: &Path) -> Option<(String, bool)> {
    let map = read_json_object_or_empty(trust_file);
    if map.is_empty() {
        return None;
    }
    let mut current = pi_canonical_path(cwd);
    loop {
        let key = current.to_string_lossy().to_string();
        if let Some(serde_json::Value::Bool(decision)) = map.get(&key) {
            return Some((key, *decision));
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return None,
        }
    }
}

/// Effective project-trust state for one workspace, as shown in the approval UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiProjectTrustState {
    /// Canonical directory the decision is (or would be) keyed by.
    pub workspace: String,
    /// Repo-shipped resources gated by the decision. Empty ⇒ nothing to approve.
    pub resources: Vec<PiProjectResource>,
    /// The verdict in force, or `None` when no ancestor has decided yet — in which
    /// case pi's non-interactive default applies and the resources stay unloaded.
    pub decision: Option<bool>,
    /// Which directory carries the deciding entry (may be an ancestor).
    pub decided_at: Option<String>,
    /// Absolute path of pi's `trust.json`, so the UI can point at the real file.
    pub trust_file: String,
    /// Whether the user has been shown, in this codeg, that this folder is
    /// trusted. A grant with `acknowledged == false` is one nobody here has
    /// confirmed — most likely written by the build that auto-trusted every
    /// opened folder — and blocks the launch until it is answered.
    pub acknowledged: bool,
}

/// codeg's own record of which trusted workspaces the user has confirmed.
///
/// Deliberately NOT stored in pi's `trust.json`: that file is pi's, has no field
/// for this, and its entries carry no provenance — which is the whole problem.
/// A flat `{ "<canonical dir>": true }` map in codeg's own home.
fn pi_trust_ack_path() -> PathBuf {
    crate::paths::codeg_home_dir().join("pi-project-trust-ack.json")
}

fn pi_trust_is_acknowledged_at(ack_file: &Path, workspace: &str) -> bool {
    matches!(
        read_json_object_or_empty(ack_file).get(workspace),
        Some(serde_json::Value::Bool(true))
    )
}

/// Record (or clear) the user's confirmation that `cwd` is trusted. Clearing
/// matters: after a revoke, a later grant must be disclosed again rather than
/// ride on a stale "already seen".
fn pi_set_trust_acknowledged_at(
    ack_file: &Path,
    cwd: &Path,
    acknowledged: bool,
) -> Result<(), AcpError> {
    let key = pi_canonical_path(cwd).to_string_lossy().to_string();
    let mut obj = read_json_object_or_empty(ack_file);
    if acknowledged {
        obj.insert(key, serde_json::Value::Bool(true));
    } else if obj.remove(&key).is_none() {
        return Ok(());
    }
    write_json_object_pretty(ack_file, &obj)
}

/// One raw entry of pi's `trust.json`, for the settings-page review list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiTrustEntry {
    pub path: String,
    pub trusted: bool,
}

/// Resolve the pi agent dir the launch path will use: the per-agent `env_json`
/// (BYO `PI_CODING_AGENT_DIR`) first, then the process env / `~/.pi/agent`.
///
/// The override only ever lands in the per-agent env, never codeg's own process
/// env, so reading `std::env` here would silently target the wrong agent dir for
/// BYO-pi users — the same trap the old launch-time seeding documented.
async fn pi_agent_dir_from_db(db: &AppDatabase) -> PathBuf {
    let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::Pi)
        .await
        .ok()
        .flatten();
    let local_config_json = load_agent_local_config_json(AgentType::Pi);
    let runtime_env = build_runtime_env_from_setting(
        AgentType::Pi,
        setting.as_ref(),
        local_config_json.as_deref(),
    );
    pi_agent_dir_for_env(&runtime_env)
}

/// Project-trust state for `cwd` against explicit files. Split from the DB-backed
/// command so it is directly unit-testable against a tempdir.
fn pi_project_trust_state_at(
    trust_file: &Path,
    ack_file: &Path,
    cwd: &Path,
) -> PiProjectTrustState {
    let decided = pi_nearest_trust_decision(trust_file, cwd);
    let workspace = pi_canonical_path(cwd).to_string_lossy().to_string();
    PiProjectTrustState {
        acknowledged: pi_trust_is_acknowledged_at(ack_file, &workspace),
        resources: pi_project_trust_resources(cwd),
        decision: decided.as_ref().map(|(_, verdict)| *verdict),
        decided_at: decided.map(|(path, _)| path),
        trust_file: trust_file.to_string_lossy().to_string(),
        workspace,
    }
}

/// Refuse to launch pi into a folder whose trust grant nobody here has confirmed.
///
/// This has to run BEFORE the process starts, because pi resolves trust once at
/// startup and executes `.pi/extensions` immediately: a warning shown after the
/// connection is up has already been overtaken by the code it was warning about.
/// Disclosing the grant post-hoc would have left every install that the old
/// auto-seeding touched exposed on exactly the path that mattered — a repo cloned
/// into a folder some earlier session trusted, opened for the first time.
///
/// Only an in-force `true` over real repo resources is blocked. An undecided or
/// declined project is already safe (pi skips the resources), and an
/// acknowledged one is the user's own answer.
///
/// Returns the message to fail the launch with, or `None` to proceed.
pub(crate) fn pi_project_trust_launch_block(
    cwd: &Path,
    runtime_env: &BTreeMap<String, String>,
) -> Option<String> {
    let trust_file = pi_agent_dir_for_env(runtime_env).join("trust.json");
    let state = pi_project_trust_state_at(&trust_file, &pi_trust_ack_path(), cwd);
    if state.resources.is_empty() || state.decision != Some(true) || state.acknowledged {
        return None;
    }
    let inherited = state
        .decided_at
        .as_deref()
        .is_some_and(|at| at != state.workspace);
    let via = if inherited {
        format!(
            " The grant comes from a parent folder ({}), so it covers this repository too.",
            state.decided_at.as_deref().unwrap_or_default()
        )
    } else {
        String::new()
    };
    Some(format!(
        "pi is allowed to load this project's own files from {}, which lets the repository run its .pi/extensions at startup.{via} \
         An earlier version of codeg granted this automatically when a folder was opened, so you may never have been asked. \
         Review it in the project-trust notice above, or under Settings → Agents → Pi, then connect again.",
        state.workspace
    ))
}

/// Write Antigravity's `auth.type` (and `gcp` block) from the STORED agent row,
/// and report what happened.
///
/// The settings panel calls this straight after saving. The launch path runs the
/// same sync, but only at launch and only into the log — which made the panel's
/// "saved" mean less than it looked: the env row is not what authenticates
/// Antigravity, `<GEMINI_HOME>/antigravity-acp/settings.json` is, and when that
/// file cannot be rewritten (it is Hjson with comments, it is unreadable, its
/// `auth` is not an object) the two part ways silently. Switching methods is
/// where that bites: the launch scrubs the credentials for the NEW method while
/// the server still reads the OLD `auth.type`, so `session/new` fails with no
/// credential for the method it believes it is using — hours after the save
/// that caused it.
///
/// Reads the row rather than taking the env from the caller so it reports on
/// what was actually persisted, not on what the request claimed.
pub(crate) async fn acp_sync_antigravity_settings_core(
    db: &AppDatabase,
) -> Result<crate::acp::connection::AntigravitySyncReport, AcpError> {
    let runtime_env = antigravity_runtime_env(db).await?;
    Ok(crate::acp::connection::sync_antigravity_settings_for_env(
        &runtime_env,
    ))
}

/// The environment a real Antigravity launch would compose from the STORED row.
///
/// The read error is PROPAGATED, unlike the `.ok().flatten()` the pi trust path
/// uses. Treating a failed read as "no row" would not merely lose the method —
/// it would hand the caller an empty environment, which on a machine with no
/// settings.json yet writes `oauth-personal` and reports success for a choice
/// the user did not make, and which points the browser-free sign-in at the
/// default `~/.gemini` rather than the relocated `GEMINI_HOME` a session uses.
async fn antigravity_runtime_env(db: &AppDatabase) -> Result<BTreeMap<String, String>, AcpError> {
    let setting = agent_setting_service::get_by_agent_type(&db.conn, AgentType::Antigravity)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let local_config_json = load_agent_local_config_json(AgentType::Antigravity);
    Ok(build_runtime_env_from_setting(
        AgentType::Antigravity,
        setting.as_ref(),
        local_config_json.as_deref(),
    ))
}

/// Start a browser-free Antigravity sign-in and hand back the link to open.
///
/// For headless deployments (codeg on a Linux server, no desktop), where the
/// agent's own loopback browser flow cannot complete: it opens a browser that
/// does not exist and then blocks for five minutes inside `session/new`. See
/// [`crate::acp::antigravity_login`].
pub(crate) async fn acp_antigravity_login_start_core(
    db: &AppDatabase,
    method_id: String,
) -> Result<crate::acp::antigravity_login::AntigravityLoginStart, AcpError> {
    let runtime_env = antigravity_runtime_env(db).await?;
    crate::acp::antigravity_login::start(&runtime_env, method_id.trim()).await
}

/// Deliver the redirect the user's browser could not reach, completing the
/// sign-in started by [`acp_antigravity_login_start_core`].
pub(crate) async fn acp_antigravity_login_finish_core(
    handle: String,
    redirect: String,
) -> Result<crate::acp::antigravity_login::AntigravityLoginOutcome, AcpError> {
    crate::acp::antigravity_login::finish(handle.trim(), &redirect).await
}

/// Abandon a pending browser-free sign-in and stop its agent process.
pub(crate) async fn acp_antigravity_login_cancel_core(handle: String) -> Result<(), AcpError> {
    crate::acp::antigravity_login::cancel(handle.trim()).await
}

/// Sign Antigravity out, so the next sign-in can reach a different account.
///
/// The counterpart to [`acp_antigravity_login_start_core`], and the thing that
/// makes it usable twice: with a credential in hand the agent refreshes it
/// silently, so `authenticate` returns without a link and the first Google
/// account a user picks is the last one they get.
///
/// Three steps around the `logout`, each closing a way for the sign-out to look
/// like it worked when it did not.
///
/// 1. **Refuse unless codeg knows the agent will clear something.** `logout`
///    clears ONE flavor — the one `settings.json` names — and for a
///    `gemini-api-key` or `agent-platform` connection that set is empty, since
///    those read their key per request rather than storing anything. It answers
///    `{}` regardless. Verified against 1.1.1: with `auth.type=gemini-api-key`
///    and a `GEMINI_API_KEY` present, `logout` returns `{}`, deletes no token
///    file, and still strips `auth.type` — so without this check codeg would
///    report a sign-out that left the account exactly where it was.
///
///    The FILE is consulted rather than the stored row because it is the only
///    thing the server infers from. And a file codeg cannot parse is refused
///    rather than assumed harmless: the server reads Hjson and codeg does not,
///    so "codeg sees no method" and "there is no method" are different facts,
///    and only the second is safe to act on.
/// 2. **Quiesce this agent first, and keep it quiesced.** Antigravity processes
///    cache the OAuth credentials in memory behind a per-PROCESS lock and write
///    them back on every silent refresh, so one left running restores the
///    account being signed out of — or overwrites the account signed in next —
///    as soon as its token expires. The lockout is taken BEFORE the connections
///    are enumerated and held across the `logout`, so a session cannot be
///    spawned into the window and inherit the credential being erased.
/// 3. **Write the saved method back afterwards.** `logout` removes `auth.type`
///    on its way out, and a session whose `auth.type` is missing fails outright
///    with `Authentication required`. The report is returned for the same
///    reason a save's is: when that file refuses to be rewritten the user has
///    to fix it by hand, and this is the moment they are looking.
pub(crate) async fn acp_antigravity_sign_out_core(
    db: &AppDatabase,
    connection_manager: &crate::acp::manager::ConnectionManager,
) -> Result<crate::acp::connection::AntigravitySyncReport, AcpError> {
    use crate::acp::connection::AntigravityAuthType;

    let runtime_env = antigravity_runtime_env(db).await?;
    match crate::acp::connection::antigravity_effective_auth_type(&runtime_env) {
        AntigravityAuthType::Declared(active)
            if !matches!(active.as_str(), "oauth-personal" | "oauth-business") =>
        {
            return Err(AcpError::protocol(format!(
                "Antigravity's settings.json says it authenticates with {active}, not with a \
                 Google account, so there is no signed-in account to leave. Choose a Google \
                 sign-in method above and save first, then sign out."
            )));
        }
        AntigravityAuthType::Unreadable => {
            return Err(AcpError::protocol(
                "codeg cannot read the authentication method out of Antigravity's settings.json, \
                 so it cannot tell which account would be signed out — or whether anything would \
                 be. Make that file strict JSON (the server also accepts comments and trailing \
                 commas; codeg does not), or move it aside, then try again.",
            ));
        }
        // Declared OAuth clears that flavor; `Absent` leaves the server nothing
        // to infer from, so it clears BOTH — which is what "get me out of this
        // account" asks for either way.
        _ => {}
    }

    // Before the enumeration, and held across the `logout`: a connection
    // spawned into that window would authenticate with the credential about to
    // be erased and then write it back at its next refresh.
    //
    // The gate is global rather than per-agent, so this delays starting ANY
    // agent while it is held — the same cost the external-restore gate accepts,
    // and bounded the same way. Worth it here: the window is a few seconds in
    // practice (the ceiling is a cold PAR unpack), it is a rare and explicit
    // user action, and a blocked spawn merely waits where an admitted one would
    // silently restore the account being left behind.
    let _lockout = connection_manager.lock_out_new_connections().await;
    let disconnected = connection_manager
        .disconnect_by_agent_type(AgentType::Antigravity)
        .await;
    if disconnected > 0 {
        tracing::info!("[ACP][Antigravity] sign-out ended {disconnected} live connection(s)");
    }

    let signed_out = crate::acp::antigravity_login::sign_out(&runtime_env).await;
    drop(_lockout);
    signed_out?;

    Ok(crate::acp::connection::sync_antigravity_settings_for_env(
        &runtime_env,
    ))
}

pub(crate) async fn acp_pi_project_trust_state_core(
    db: &AppDatabase,
    workspace: String,
) -> Result<PiProjectTrustState, AcpError> {
    let trust_file = pi_agent_dir_from_db(db).await.join("trust.json");
    // Not trimmed, for the same reason as the write path: a directory name may
    // legitimately start or end with a space, and the state must describe the
    // exact folder the caller named.
    Ok(pi_project_trust_state_at(
        &trust_file,
        &pi_trust_ack_path(),
        Path::new(&workspace),
    ))
}

/// Record that the user has seen and kept an existing trust grant, so the launch
/// gate stops blocking this folder. Writes only codeg's own record — pi's
/// `trust.json` is untouched, because the grant itself is not changing.
pub(crate) async fn acp_pi_acknowledge_project_trust_core(workspace: String) -> Result<(), AcpError> {
    tokio::task::spawn_blocking(move || {
        pi_set_trust_acknowledged_at(&pi_trust_ack_path(), Path::new(&workspace), true)
    })
    .await
    .map_err(|e| AcpError::protocol(format!("trust acknowledgement task failed: {e}")))?
}

/// Record an explicit project-trust decision for `workspace` in pi's `trust.json`.
///
/// This is the ONLY place codeg writes into pi's trust store, and it runs solely
/// from a user action in the approval UI. codeg used to write `true` here on every
/// pi launch, which auto-approved repo-shipped `.pi/extensions` (arbitrary code at
/// pi startup) and — because entries are inherited by every subdirectory and are
/// read by the user's standalone `pi` CLI too — silently widened far past the
/// session that triggered it.
///
/// `trusted`: `Some(true)`/`Some(false)` write that verdict for the exact
/// canonical dir; `None` removes codeg's entry so the folder falls back to any
/// ancestor decision, then to pi's own default (the revoke path).
///
/// Scoped to the one directory, and never clobbers a `trust.json` codeg can't
/// parse — that file holds decisions the user made inside pi.
pub(crate) async fn acp_pi_set_project_trust_core(
    db: &AppDatabase,
    workspace: String,
    trusted: Option<bool>,
) -> Result<(), AcpError> {
    let path = pi_agent_dir_from_db(db).await.join("trust.json");
    // The write takes pi's file lock and can sleep on contention, so keep it off
    // the async worker. NOTE: `workspace` is NOT trimmed — leading/trailing
    // spaces are legal in a directory name, and silently trimming them would key
    // the decision to a different folder than the one being approved.
    tokio::task::spawn_blocking(move || {
        let cwd = Path::new(&workspace);
        pi_write_trust_decision_at(&path, cwd, trusted)?;
        // Any verdict here IS the user answering, so a granted folder is
        // acknowledged by construction and must not re-block the launch. A
        // declined or revoked one drops the record, so a future grant gets
        // disclosed again instead of riding on a stale "already seen".
        pi_set_trust_acknowledged_at(&pi_trust_ack_path(), cwd, trusted == Some(true))
    })
    .await
    .map_err(|e| AcpError::protocol(format!("trust write task failed: {e}")))?
}

/// Serializes codeg's own trust writes. Two surfaces can issue them at once —
/// the approval banner and the settings list's revoke buttons — and the write is
/// a read-modify-write, so without this one call could drop the entry another
/// just added. The cross-process lock below does not cover this: both callers
/// live in one process.
static PI_TRUST_WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// How long a lock may sit untouched before it counts as abandoned by a crashed
/// process. Mirrors `proper-lockfile`'s default `stale` window so codeg and pi
/// agree on when a leftover lock stops holding everyone up.
const PI_TRUST_LOCK_STALE: Duration = Duration::from_secs(10);

/// pi guards `trust.json` with a `proper-lockfile` lock — a DIRECTORY at
/// `<trust.json>.lock`, created with `mkdir` (atomic) — and takes it for its own
/// reads *and* writes (`withTrustFileLock`, `core/trust-manager.js`). Held only
/// for the read-modify-write below, and released on drop.
struct PiTrustLock {
    path: PathBuf,
}

impl Drop for PiTrustLock {
    fn drop(&mut self) {
        let _ = fs::remove_dir(&self.path);
    }
}

/// True when a lock directory is old enough that whoever made it is presumed
/// gone. Unreadable metadata counts as stale: a lock we can't reason about must
/// not wedge project-trust decisions forever.
fn pi_trust_lock_is_stale(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|meta| meta.modified())
        .map(|modified| modified.elapsed().unwrap_or_default() > PI_TRUST_LOCK_STALE)
        .unwrap_or(true)
}

/// Take pi's cross-process trust lock, retrying on contention the way pi does
/// (10 attempts, 20ms apart) before giving up. Honoring pi's own protocol is
/// what keeps a decision written here from interleaving with one the user makes
/// inside pi, and keeps pi from ever reading a half-written file.
fn acquire_pi_trust_lock(trust_file: &Path) -> Result<PiTrustLock, AcpError> {
    let mut name = trust_file.as_os_str().to_os_string();
    name.push(".lock");
    let path = PathBuf::from(name);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create pi agent directory failed: {e}")))?;
    }

    for attempt in 1..=10 {
        match fs::create_dir(&path) {
            Ok(()) => return Ok(PiTrustLock { path }),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if pi_trust_lock_is_stale(&path) {
                    // Same tie-break proper-lockfile uses, so a lock orphaned by a
                    // crash doesn't block every future decision.
                    let _ = fs::remove_dir(&path);
                    continue;
                }
                if attempt < 10 {
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            Err(e) => {
                return Err(AcpError::protocol(format!(
                    "lock {} failed: {e}",
                    path.display()
                )));
            }
        }
    }
    Err(AcpError::protocol(format!(
        "pi's trust store at {} is locked by another process; try again in a moment",
        trust_file.display()
    )))
}

/// Write one decision into `path`. Split from the command so it is directly
/// unit-testable against a tempdir.
///
/// Blocking (it can sleep waiting for pi's lock), so async callers hand it to
/// `spawn_blocking` rather than stalling a runtime worker.
fn pi_write_trust_decision_at(
    path: &Path,
    cwd: &Path,
    trusted: Option<bool>,
) -> Result<(), AcpError> {
    let key = pi_canonical_path(cwd).to_string_lossy().to_string();
    // Poisoning only means some earlier writer panicked; the map it guards lives
    // on disk, not in the mutex, so the lock is still usable.
    let _serialized = PI_TRUST_WRITE_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let _lock = acquire_pi_trust_lock(path)?;

    // Strict read: a missing file is fine (we create one), but a file that exists
    // and doesn't parse as a JSON object must NOT be rewritten from scratch.
    // Surface that rather than silently doing nothing, so the user can go fix it.
    let mut obj = match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
            Ok(serde_json::Value::Object(map)) => map,
            _ => {
                return Err(AcpError::protocol(format!(
                    "pi's trust file at {} is not a JSON object; fix or remove it before changing project trust",
                    path.display()
                )));
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Map::new(),
        Err(e) => {
            return Err(AcpError::protocol(format!(
                "read {} failed: {e}",
                path.display()
            )));
        }
    };

    match trusted {
        Some(verdict) => {
            obj.insert(key, serde_json::Value::Bool(verdict));
        }
        None => {
            if obj.remove(&key).is_none() {
                // Nothing of ours to clear (the decision came from an ancestor);
                // don't create a file just to record an absence.
                return Ok(());
            }
        }
    }
    write_json_object_pretty(path, &obj)
}

/// Every decision recorded in pi's `trust.json`, for the settings-page review
/// list. Entries codeg auto-seeded before this became a user decision are
/// indistinguishable from ones the user made inside pi (codeg never recorded
/// provenance), so they are listed for review rather than pruned automatically —
/// pruning would silently revoke the user's own approvals.
pub(crate) async fn acp_pi_list_trust_entries_core(
    db: &AppDatabase,
) -> Result<Vec<PiTrustEntry>, AcpError> {
    let path = pi_agent_dir_from_db(db).await.join("trust.json");
    Ok(pi_trust_entries_at(&path))
}

/// Read decisions out of `path`. Split from the command so it is directly
/// unit-testable against a tempdir.
fn pi_trust_entries_at(path: &Path) -> Vec<PiTrustEntry> {
    let mut entries = read_json_object_or_empty(path)
        .into_iter()
        .filter_map(|(path, value)| match value {
            // `null` means "no decision" in pi; nothing to review or revoke.
            serde_json::Value::Bool(trusted) => Some(PiTrustEntry { path, trusted }),
            _ => None,
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    entries
}

/// Structured Pi config update from the settings UI. Writes pi's native files:
/// `settings.json` always (provider/model/thinking level), and `auth.json` only
/// when an API key is supplied (merge-preserving other providers).
#[derive(Debug, Clone)]
pub(crate) struct PiConfigUpdate {
    pub provider: String,
    pub model: String,
    pub thinking_level: Option<String>,
    pub api_key: Option<String>,
    /// When set (non-empty), `provider` is a custom / self-hosted provider: its
    /// definition is merge-written to `models.json` (`baseUrl` + `api`, with the
    /// chosen `model` folded into the provider's `models` array). `None` leaves
    /// `models.json` untouched (built-in provider).
    pub custom_base_url: Option<String>,
    /// Wire protocol for the custom provider (defaults to `openai-completions`).
    /// Ignored when `custom_base_url` is `None`.
    pub custom_api: Option<String>,
    /// Reasoning declaration for `model` inside the custom provider. `None` leaves
    /// whatever the model entry already declares untouched (built-in provider path,
    /// or a client that predates the control). Ignored when `custom_base_url` is
    /// `None` — a built-in model carries pi's own, more accurate declaration.
    pub model_reasoning: Option<PiModelReasoningSpec>,
}

/// A model's reasoning capability as pi records it in `models.json`.
///
/// pi reads `reasoning: modelDef.reasoning ?? false`, and an undeclared model gets
/// `["off"]` as its entire thinking-level vocabulary — so every level the composer
/// sends is clamped straight back to `off`. `thinking_level_map` is pi's
/// `thinkingLevelMap`: `None` removes a level from the picker, `Some(value)` both
/// keeps it and sets the effort string pi sends to the provider.
///
/// The panel owns the derivation (`src/lib/pi-thinking.ts`) so the availability rules
/// live in exactly one place; this side only validates the level names and writes.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiModelReasoningSpec {
    pub reasoning: bool,
    #[serde(default)]
    pub thinking_level_map: BTreeMap<String, Option<String>>,
}

/// pi's fixed thinking-level vocabulary (`EXTENDED_THINKING_LEVELS` in pi-ai). A name
/// outside this list is rejected by pi-acp with `invalidParams`, so it must never reach
/// `models.json`.
const PI_THINKING_LEVELS: [&str; 6] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/// Read a JSON file into an owned object map, returning an empty map when the
/// file is absent, unreadable, or does not parse to a JSON object. Pi's native
/// files are small and codeg-owned; corruption shouldn't abort a save (we
/// re-author the managed keys and preserve whatever else parses).
fn read_json_object_or_empty(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| match value {
            serde_json::Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

/// Pretty-print a JSON object (with a trailing newline) to `path`, creating the
/// parent directory if needed.
fn write_json_object_pretty(
    path: &Path,
    obj: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), AcpError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create pi config directory failed: {e}")))?;
    }
    let mut text = serde_json::to_string_pretty(&serde_json::Value::Object(obj.clone()))
        .map_err(|e| AcpError::protocol(format!("serialize pi config failed: {e}")))?;
    text.push('\n');
    fs::write(path, text)
        .map_err(|e| AcpError::protocol(format!("write pi config failed: {e}")))?;
    Ok(())
}

/// Upsert `model_id` into a custom provider's `models` array, applying `reasoning`
/// when the panel sent one.
///
/// Merge-preserving by design: a model the user hand-tuned in `models.json` keeps its
/// `cost` / `contextWindow` / `headers` / `compat` / renamed `name`, because those are
/// fields codeg's form has no opinion about. Only the reasoning keys are re-authored.
///
/// The upsert also fixes the older skip-if-present behaviour, under which re-saving an
/// already-listed model wrote nothing at all — the reason a reasoning declaration could
/// never reach an existing entry.
fn apply_pi_custom_model(
    entry: &mut serde_json::Map<String, serde_json::Value>,
    model_id: &str,
    reasoning: Option<&PiModelReasoningSpec>,
) {
    let mut models = match entry.remove("models") {
        Some(serde_json::Value::Array(arr)) => arr,
        _ => Vec::new(),
    };

    let existing = models.iter_mut().find_map(|item| {
        let obj = item.as_object_mut()?;
        (obj.get("id").and_then(serde_json::Value::as_str) == Some(model_id)).then_some(obj)
    });
    let model_obj = match existing {
        Some(obj) => obj,
        None => {
            let mut fresh = serde_json::Map::new();
            fresh.insert("id".to_string(), model_id.into());
            fresh.insert("name".to_string(), model_id.into());
            models.push(serde_json::Value::Object(fresh));
            models
                .last_mut()
                .and_then(serde_json::Value::as_object_mut)
                .expect("just pushed an object")
        }
    };

    if let Some(spec) = reasoning {
        model_obj.insert("reasoning".to_string(), spec.reasoning.into());
        // An empty map means "pi's defaults" — drop the key rather than write `{}`,
        // which reads as a declaration but constrains nothing.
        let map: serde_json::Map<String, serde_json::Value> = spec
            .thinking_level_map
            .iter()
            // A name pi does not know would make pi-acp reject the level with
            // `invalidParams`; drop it rather than let it reach disk.
            .filter(|(level, _)| PI_THINKING_LEVELS.contains(&level.as_str()))
            .map(|(level, value)| {
                let value = match value {
                    Some(wire) => serde_json::Value::String(wire.clone()),
                    None => serde_json::Value::Null,
                };
                (level.clone(), value)
            })
            .collect();
        if map.is_empty() {
            model_obj.remove("thinkingLevelMap");
        } else {
            model_obj.insert(
                "thinkingLevelMap".to_string(),
                serde_json::Value::Object(map),
            );
        }
    }

    entry.insert("models".to_string(), serde_json::Value::Array(models));
}

/// Apply a structured Pi config update to pi's native files. Validates the whole
/// request before any write: provider/model must be non-empty after trim and the
/// API key must not contain newlines (it lands verbatim in a JSON string). Writes
/// `settings.json` first (merge-preserving), then `auth.json` only when an API
/// key is supplied. Ensures the settings row exists, then emits the agents-updated
/// event so the settings panel refreshes.
pub(crate) async fn acp_update_pi_config_core(
    update: PiConfigUpdate,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    // ---- Validate (no writes yet) ----
    let provider = update.provider.trim();
    if provider.is_empty() {
        return Err(AcpError::protocol("pi provider is required"));
    }
    let model = update.model.trim();
    if model.is_empty() {
        return Err(AcpError::protocol("pi model is required"));
    }
    let thinking_level = update
        .thinking_level
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let api_key = update
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(key) = api_key {
        if key.contains('\n') || key.contains('\r') {
            return Err(AcpError::protocol(
                "pi API key must not contain line breaks",
            ));
        }
    }

    // Ensure the settings row exists (mirrors the kimi flow) so the agent shows
    // up as configured/enabled in the DB-backed settings list.
    let default = agent_setting_service::AgentDefaultInput {
        agent_type: AgentType::Pi,
        registry_id: registry::registry_id_for(AgentType::Pi).to_string(),
        default_sort_order: i32::MAX / 2,
    };
    agent_setting_service::ensure_defaults(&db.conn, &[default])
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    // ---- settings.json: merge-write provider/model/thinking level ----
    let settings_path = pi_settings_json_path();
    let mut settings = read_json_object_or_empty(&settings_path);
    settings.insert(
        "defaultProvider".to_string(),
        serde_json::Value::String(provider.to_string()),
    );
    settings.insert(
        "defaultModel".to_string(),
        serde_json::Value::String(model.to_string()),
    );
    if let Some(level) = thinking_level {
        settings.insert(
            "defaultThinkingLevel".to_string(),
            serde_json::Value::String(level.to_string()),
        );
    }
    write_json_object_pretty(&settings_path, &settings)?;

    // ---- auth.json: merge-write the provider credential (only when given) ----
    if let Some(key) = api_key {
        let auth_path = pi_auth_json_path();
        let mut auth = read_json_object_or_empty(&auth_path);
        let mut entry = serde_json::Map::new();
        entry.insert(
            "type".to_string(),
            serde_json::Value::String("api_key".to_string()),
        );
        entry.insert(
            "key".to_string(),
            serde_json::Value::String(key.to_string()),
        );
        auth.insert(provider.to_string(), serde_json::Value::Object(entry));
        write_json_object_pretty(&auth_path, &auth)?;
    }

    // ---- models.json: define the custom provider (only when a base URL is
    // given). Built-in providers leave this file untouched. Merge-preserving:
    // `baseUrl`/`api` are overwritten from the form, but any other fields the
    // user hand-tuned (headers/compat/modelOverrides) and previously-defined
    // models are kept; the chosen model is upserted into the `models` array
    // along with its reasoning declaration. ----
    let custom_base_url = update
        .custom_base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if let Some(base_url) = custom_base_url {
        let custom_api = update
            .custom_api
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("openai-completions");
        let models_path = pi_models_json_path();
        let mut models_doc = read_json_object_or_empty(&models_path);
        let mut providers = match models_doc.remove("providers") {
            Some(serde_json::Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        let mut entry = match providers.remove(provider) {
            Some(serde_json::Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        entry.insert(
            "baseUrl".to_string(),
            serde_json::Value::String(base_url.to_string()),
        );
        entry.insert(
            "api".to_string(),
            serde_json::Value::String(custom_api.to_string()),
        );
        apply_pi_custom_model(&mut entry, model, update.model_reasoning.as_ref());
        providers.insert(provider.to_string(), serde_json::Value::Object(entry));
        models_doc.insert(
            "providers".to_string(),
            serde_json::Value::Object(providers),
        );
        write_json_object_pretty(&models_path, &models_doc)?;
    }

    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::Pi));
    Ok(())
}

/// Projection of pi's current native config for the settings panel: the three
/// `settings.json` model keys plus the provider names present in `auth.json`
/// (sorted). Missing files surface as all-`None` / empty.
/// A custom / self-hosted provider defined in `models.json`, projected for the
/// settings panel so it can rehydrate the custom-provider form (and detect that
/// the current `defaultProvider` is a custom one).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCustomProvider {
    pub id: String,
    pub base_url: String,
    pub api: String,
    /// Models this provider defines, sorted by id. The panel reads the entry
    /// matching `default_model` to rehydrate its reasoning controls — reading the
    /// file (rather than defaulting the form to "off") is what stops a save from
    /// wiping a declaration the user hand-wrote.
    pub models: Vec<PiCustomModel>,
}

/// One model inside a custom provider, carrying only the reasoning keys the panel
/// edits. Absent keys stay absent (`None` / empty) so "never declared" is
/// distinguishable from "declared false".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCustomModel {
    pub id: String,
    pub reasoning: Option<bool>,
    /// pi's `thinkingLevelMap`: a level mapped to `None` is removed from the picker,
    /// `Some(wire)` keeps it and sets the effort string sent to the provider.
    pub thinking_level_map: BTreeMap<String, Option<String>>,
}

/// Project a custom provider's `models` array. Entries without a string `id` are
/// skipped (pi ignores them too), and a `thinkingLevelMap` value that is neither a
/// string nor `null` is dropped rather than guessed at.
fn pi_custom_models_from_entry(entry: &serde_json::Value) -> Vec<PiCustomModel> {
    let mut models: Vec<PiCustomModel> = entry
        .get("models")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("id").and_then(serde_json::Value::as_str)?;
                    let thinking_level_map = item
                        .get("thinkingLevelMap")
                        .and_then(serde_json::Value::as_object)
                        .map(|map| {
                            map.iter()
                                .filter_map(|(level, value)| match value {
                                    serde_json::Value::Null => Some((level.clone(), None)),
                                    serde_json::Value::String(wire) => {
                                        Some((level.clone(), Some(wire.clone())))
                                    }
                                    _ => None,
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    Some(PiCustomModel {
                        id: id.to_string(),
                        reasoning: item.get("reasoning").and_then(serde_json::Value::as_bool),
                        thinking_level_map,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiConfigProjection {
    pub default_provider: Option<String>,
    pub default_model: Option<String>,
    pub default_thinking_level: Option<String>,
    pub auth_providers: Vec<String>,
    pub custom_providers: Vec<PiCustomProvider>,
}

/// Read pi's native files into a `PiConfigProjection`. Never errors: absent or
/// malformed files yield `None` / an empty provider list (the panel treats that
/// as "not configured yet").
pub(crate) fn load_pi_config_core() -> PiConfigProjection {
    let settings = read_json_object_or_empty(&pi_settings_json_path());
    let string_key = |key: &str| {
        settings
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::to_string)
    };
    let mut auth_providers: Vec<String> = read_json_object_or_empty(&pi_auth_json_path())
        .keys()
        .cloned()
        .collect();
    auth_providers.sort();
    let mut custom_providers: Vec<PiCustomProvider> =
        read_json_object_or_empty(&pi_models_json_path())
            .get("providers")
            .and_then(serde_json::Value::as_object)
            .map(|providers| {
                providers
                    .iter()
                    .map(|(id, entry)| PiCustomProvider {
                        id: id.clone(),
                        base_url: entry
                            .get("baseUrl")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        api: entry
                            .get("api")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("openai-completions")
                            .to_string(),
                        models: pi_custom_models_from_entry(entry),
                    })
                    .collect()
            })
            .unwrap_or_default();
    custom_providers.sort_by(|a, b| a.id.cmp(&b.id));
    PiConfigProjection {
        default_provider: string_key("defaultProvider"),
        default_model: string_key("defaultModel"),
        default_thinking_level: string_key("defaultThinkingLevel"),
        auth_providers,
        custom_providers,
    }
}

/// Result of validating a user-supplied custom pi binary (BYO-pi). `found=false`
/// with `resolved_path=None` is a normal result (not an error) — the panel shows
/// "not found" rather than surfacing an exception.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCommandValidation {
    pub found: bool,
    pub resolved_path: Option<String>,
    pub version: Option<String>,
}

/// Best-effort check that `resolved` looks executable on unix (any execute bit
/// set). On non-unix we already know it exists; treat that as good enough.
#[cfg(unix)]
fn pi_path_is_executable(resolved: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    fs::metadata(resolved)
        .map(|meta| meta.is_file() && (meta.permissions().mode() & 0o111 != 0))
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn pi_path_is_executable(resolved: &Path) -> bool {
    resolved.is_file()
}

/// Resolve a user-supplied pi command. A value containing a path separator (or an
/// absolute path) is treated as a path and checked on disk; a bare name is looked
/// up on `PATH` via the `which` crate. On success, best-effort `--version` is run
/// (failures tolerated → `version=None`). Never errors on a not-found / probe
/// failure: returns `found=false` (or `version=None`) instead.
/// Resolve a pi command to an executable path: a value containing a path
/// separator (or an absolute path) is checked on disk; a bare name is looked up
/// on `PATH` via the `which` crate. Returns `None` when it can't be resolved to
/// an executable. Shared by the BYO-pi validate command and the launch preflight
/// ([`crate::acp::connection`]) so both agree on what "pi is resolvable" means —
/// and both see the same `PATH` the spawned pi-acp process inherits.
pub(crate) fn resolve_pi_command_path(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }

    let looks_like_path = trimmed.contains(std::path::MAIN_SEPARATOR)
        || trimmed.contains('/')
        || Path::new(trimmed).is_absolute();

    if looks_like_path {
        let candidate = Path::new(trimmed);
        if pi_path_is_executable(candidate) {
            // Canonicalize to an absolute path; fall back to the raw path if the
            // FS rejects canonicalization (e.g. permissions) but it is executable.
            Some(fs::canonicalize(candidate).unwrap_or_else(|_| candidate.to_path_buf()))
        } else {
            None
        }
    } else {
        which::which(trimmed).ok()
    }
}

pub(crate) fn acp_validate_pi_command_core(command: String) -> PiCommandValidation {
    let Some(resolved_path) = resolve_pi_command_path(&command) else {
        return PiCommandValidation {
            found: false,
            resolved_path: None,
            version: None,
        };
    };

    let version = probe_pi_version(&resolved_path);
    PiCommandValidation {
        found: true,
        resolved_path: Some(resolved_path.to_string_lossy().into_owned()),
        version,
    }
}

/// Best-effort `<resolved> --version`, returning the trimmed first stdout line.
/// Any failure (spawn error, non-zero exit, empty output) → `None`; never panics
/// and never blocks indefinitely (`Command::output` waits for the short-lived
/// `--version` child to exit on its own).
fn probe_pi_version(resolved: &Path) -> Option<String> {
    let output = std::process::Command::new(resolved)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Hermes config helpers
//
// Hermes self-manages credentials in `~/.hermes/.env` (secrets) and general
// settings in `~/.hermes/config.yaml` (the `model:` section), reading them with
// its own runtime resolver. codeg manages those two files directly — mirroring
// how it manages Codex's `auth.json` + `config.toml` — rather than injecting
// process env. The provider choice drives the linkage: it selects which `.env`
// var holds the API key and which `model.provider` / `model.base_url` go into
// config.yaml.
// ---------------------------------------------------------------------------

fn hermes_env_path() -> PathBuf {
    hermes_home_dir().join(".env")
}

pub(crate) fn hermes_config_yaml_path() -> PathBuf {
    hermes_home_dir().join("config.yaml")
}

/// A managed Hermes provider: the config.yaml `model.provider` value (its `id`)
/// and the `.env` variable that carries its API key. `key_env_var` is the
/// variable Hermes' own setup writes first (mirrors `auth.py` PROVIDER_REGISTRY
/// priority order); it is empty for OAuth providers (credentials set via the
/// terminal `--setup` flow) and AWS Bedrock (resolved from the AWS SDK chain).
/// `needs_base_url` marks providers whose endpoint is user-supplied (the
/// OpenAI-compatible `openai-api` path). The frontend mirror owns the auth-kind
/// UI flag.
struct HermesProvider {
    id: &'static str,
    key_env_var: &'static str,
    needs_base_url: bool,
    /// The `.env` variable Hermes reads for a user-supplied endpoint URL. When
    /// set (only `openai-api` today), codeg mirrors the structured base URL into
    /// both this var and config.yaml `model.base_url`, because Hermes' own
    /// resolution paths disagree on which one wins — keeping them in sync makes
    /// the saved endpoint authoritative under either path.
    base_url_env_var: &'static str,
}

/// Curated subset of Hermes providers codeg edits via structured fields, keyed
/// by the canonical `model.provider` id and `.env` key var from Hermes'
/// `hermes_cli/auth.py` PROVIDER_REGISTRY (the single source of truth its own
/// setup uses). The long tail and any exotic credential layout go through the
/// raw config.yaml escape hatch and the terminal `--setup` flow.
const HERMES_PROVIDERS: &[HermesProvider] = &[
    // API-key providers — `key_env_var` is the first env var Hermes' own
    // setup writes (auth.py PROVIDER_REGISTRY priority order).
    HermesProvider {
        id: "openrouter",
        key_env_var: "OPENROUTER_API_KEY",
        needs_base_url: false,
        base_url_env_var: "OPENROUTER_BASE_URL",
    },
    HermesProvider {
        id: "openai-api",
        key_env_var: "OPENAI_API_KEY",
        needs_base_url: true,
        base_url_env_var: "OPENAI_BASE_URL",
    },
    // User-supplied OpenAI-compatible endpoint. Unlike every other provider,
    // `custom` carries BOTH its key and endpoint INLINE in config.yaml
    // (`model.api_key` / `model.base_url`) and reads no `.env` var — verified
    // against a working 0.16.0 config and `hermes_cli/auth.py`, where `custom`
    // is a canonical provider. Empty key/base-url env vars keep the `.env`
    // writer and the panel projection away; `plan_hermes_write` /
    // `project_hermes_key_and_base` special-case the inline key via
    // `hermes_inlines_api_key`.
    HermesProvider {
        id: "custom",
        key_env_var: "",
        needs_base_url: true,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "anthropic",
        key_env_var: "ANTHROPIC_API_KEY",
        needs_base_url: false,
        base_url_env_var: "ANTHROPIC_BASE_URL",
    },
    HermesProvider {
        id: "gemini",
        key_env_var: "GOOGLE_API_KEY",
        needs_base_url: false,
        base_url_env_var: "GEMINI_BASE_URL",
    },
    HermesProvider {
        id: "deepseek",
        key_env_var: "DEEPSEEK_API_KEY",
        needs_base_url: false,
        base_url_env_var: "DEEPSEEK_BASE_URL",
    },
    HermesProvider {
        id: "xai",
        key_env_var: "XAI_API_KEY",
        needs_base_url: false,
        base_url_env_var: "XAI_BASE_URL",
    },
    HermesProvider {
        id: "zai",
        key_env_var: "GLM_API_KEY",
        needs_base_url: false,
        base_url_env_var: "GLM_BASE_URL",
    },
    HermesProvider {
        id: "minimax",
        key_env_var: "MINIMAX_API_KEY",
        needs_base_url: false,
        base_url_env_var: "MINIMAX_BASE_URL",
    },
    HermesProvider {
        id: "minimax-cn",
        key_env_var: "MINIMAX_CN_API_KEY",
        needs_base_url: false,
        base_url_env_var: "MINIMAX_CN_BASE_URL",
    },
    HermesProvider {
        id: "kimi-coding",
        key_env_var: "KIMI_API_KEY",
        needs_base_url: false,
        base_url_env_var: "KIMI_BASE_URL",
    },
    HermesProvider {
        id: "kimi-coding-cn",
        key_env_var: "KIMI_CN_API_KEY",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "nvidia",
        key_env_var: "NVIDIA_API_KEY",
        needs_base_url: false,
        base_url_env_var: "NVIDIA_BASE_URL",
    },
    HermesProvider {
        id: "alibaba",
        key_env_var: "DASHSCOPE_API_KEY",
        needs_base_url: false,
        base_url_env_var: "DASHSCOPE_BASE_URL",
    },
    HermesProvider {
        id: "alibaba-coding-plan",
        key_env_var: "ALIBABA_CODING_PLAN_API_KEY",
        needs_base_url: false,
        base_url_env_var: "ALIBABA_CODING_PLAN_BASE_URL",
    },
    HermesProvider {
        id: "copilot",
        key_env_var: "COPILOT_GITHUB_TOKEN",
        needs_base_url: false,
        base_url_env_var: "COPILOT_API_BASE_URL",
    },
    HermesProvider {
        id: "lmstudio",
        key_env_var: "LM_API_KEY",
        needs_base_url: true,
        base_url_env_var: "LM_BASE_URL",
    },
    HermesProvider {
        id: "azure-foundry",
        key_env_var: "AZURE_FOUNDRY_API_KEY",
        needs_base_url: true,
        base_url_env_var: "AZURE_FOUNDRY_BASE_URL",
    },
    HermesProvider {
        id: "stepfun",
        key_env_var: "STEPFUN_API_KEY",
        needs_base_url: false,
        base_url_env_var: "STEPFUN_BASE_URL",
    },
    HermesProvider {
        id: "arcee",
        key_env_var: "ARCEEAI_API_KEY",
        needs_base_url: false,
        base_url_env_var: "ARCEE_BASE_URL",
    },
    HermesProvider {
        id: "gmi",
        key_env_var: "GMI_API_KEY",
        needs_base_url: false,
        base_url_env_var: "GMI_BASE_URL",
    },
    HermesProvider {
        id: "huggingface",
        key_env_var: "HF_TOKEN",
        needs_base_url: false,
        base_url_env_var: "HF_BASE_URL",
    },
    HermesProvider {
        id: "kilocode",
        key_env_var: "KILOCODE_API_KEY",
        needs_base_url: false,
        base_url_env_var: "KILOCODE_BASE_URL",
    },
    HermesProvider {
        id: "opencode-zen",
        key_env_var: "OPENCODE_ZEN_API_KEY",
        needs_base_url: false,
        base_url_env_var: "OPENCODE_ZEN_BASE_URL",
    },
    HermesProvider {
        id: "opencode-go",
        key_env_var: "OPENCODE_GO_API_KEY",
        needs_base_url: false,
        base_url_env_var: "OPENCODE_GO_BASE_URL",
    },
    HermesProvider {
        id: "xiaomi",
        key_env_var: "XIAOMI_API_KEY",
        needs_base_url: false,
        base_url_env_var: "XIAOMI_BASE_URL",
    },
    HermesProvider {
        id: "tencent-tokenhub",
        key_env_var: "TOKENHUB_API_KEY",
        needs_base_url: false,
        base_url_env_var: "TOKENHUB_BASE_URL",
    },
    HermesProvider {
        id: "ollama-cloud",
        key_env_var: "OLLAMA_API_KEY",
        needs_base_url: false,
        base_url_env_var: "OLLAMA_BASE_URL",
    },
    HermesProvider {
        id: "novita",
        key_env_var: "NOVITA_API_KEY",
        needs_base_url: false,
        base_url_env_var: "NOVITA_BASE_URL",
    },
    // New in Hermes 0.20.0 (auth.py registry gained `ai-gateway` + `vertex`).
    HermesProvider {
        id: "ai-gateway",
        key_env_var: "AI_GATEWAY_API_KEY",
        needs_base_url: false,
        base_url_env_var: "AI_GATEWAY_BASE_URL",
    },
    // OAuth / external-process providers — credentials set via the terminal
    // `--setup` flow; no `.env` key var.
    HermesProvider {
        id: "nous",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "openai-codex",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "minimax-oauth",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "xai-oauth",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "qwen-oauth",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "google-gemini-cli",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    HermesProvider {
        id: "copilot-acp",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    // AWS Bedrock — credentials from the AWS SDK chain.
    HermesProvider {
        id: "bedrock",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
    // Google Vertex AI (Hermes 0.20.0, `auth_type="vertex"`) — OAuth2 via
    // service-account JSON / application-default credentials, not an API key;
    // its endpoint is computed per request from project + region, so no
    // base-URL field either. Configured through the terminal `--setup` flow.
    HermesProvider {
        id: "vertex",
        key_env_var: "",
        needs_base_url: false,
        base_url_env_var: "",
    },
];

fn hermes_provider(id: &str) -> Option<&'static HermesProvider> {
    HERMES_PROVIDERS.iter().find(|p| p.id == id)
}

/// Whether a provider stores its API key INLINE in config.yaml `model.api_key`
/// rather than in `~/.hermes/.env`. Only `custom` (the user-supplied
/// OpenAI-compatible endpoint) works this way — verified in Hermes 0.16.0 and
/// unchanged through 0.20.0, where `custom` stays deliberately outside
/// PROVIDER_REGISTRY ("handled outside the registry", auth.py) and the new v12
/// named `providers:` mapping is a separate `custom:<name>` namespace that
/// codeg's raw config editor governs. `custom` has no `.env` key var, so the
/// key rides in the `model:` section next to `base_url`. Drives both the
/// structured write (`plan_hermes_write`) and the panel projection
/// (`project_hermes_key_and_base`).
fn hermes_inlines_api_key(provider: &str) -> bool {
    provider == "custom"
}

/// Parse simple `KEY=value` lines from a dotenv file. Ignores blank lines and
/// `#` comments, tolerates a leading `export `, and strips one layer of
/// surrounding single/double quotes from the value. Last occurrence wins.
fn parse_env_file(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let body = trimmed.strip_prefix("export ").unwrap_or(trimmed);
        let Some((key, value)) = body.split_once('=') else {
            continue;
        };
        let key = key.trim();
        if key.is_empty() {
            continue;
        }
        let value = value.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        map.insert(key.to_string(), value.to_string());
    }
    map
}

/// Update `KEY=value` entries in a dotenv file while preserving comments, blank
/// lines, ordering, and unrelated keys. The first occurrence of an updated key
/// is replaced in place; any later duplicates of that key are dropped (so a
/// last-occurrence-wins reader can't surface a stale shadowing line). Missing
/// keys are appended — including with an empty value (`KEY=`): Hermes loads
/// `~/.hermes/.env` with override semantics, so an explicit empty line both
/// clears a stored credential AND masks an inherited process-env value of the
/// same name (e.g. a stale `OPENAI_API_KEY` exported in the shell).
fn patch_env_text(existing: &str, updates: &[(&str, &str)]) -> String {
    let mut applied = vec![false; updates.len()];
    let mut out_lines: Vec<String> = Vec::new();

    for line in existing.lines() {
        let trimmed = line.trim_start();
        let line_key = if trimmed.starts_with('#') {
            None
        } else {
            let body = trimmed.strip_prefix("export ").unwrap_or(trimmed);
            body.split_once('=').map(|(k, _)| k.trim())
        };
        if let Some(line_key) = line_key {
            if let Some(i) = updates.iter().position(|(key, _)| line_key == *key) {
                if applied[i] {
                    // Drop later duplicates of a key we already rewrote.
                    continue;
                }
                out_lines.push(format!("{}={}", updates[i].0, updates[i].1));
                applied[i] = true;
                continue;
            }
        }
        out_lines.push(line.to_string());
    }

    for (i, (key, value)) in updates.iter().enumerate() {
        // Append a missing key, including an empty `KEY=` — an explicit empty
        // line is what masks an inherited process-env value under Hermes' dotenv
        // override loading, not just a no-op cleanup.
        if !applied[i] {
            out_lines.push(format!("{key}={value}"));
        }
    }

    let mut result = out_lines.join("\n");
    if !result.is_empty() {
        result.push('\n');
    }
    result
}

fn yaml_str(value: &serde_yaml::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// Read `model.provider` from an existing config.yaml document, if present. Used
/// to tell an out-of-band base URL for the *current* provider (keep) apart from a
/// stale one left by a provider the user just switched away from (clear).
fn existing_hermes_model_provider(existing: Option<&str>) -> Option<String> {
    let raw = existing?;
    let value: serde_yaml::Value = serde_yaml::from_str(raw).ok()?;
    value.get("model").and_then(|m| yaml_str(m, "provider"))
}

/// How `merge_hermes_model_config` should treat the `model.base_url` field.
enum BaseUrlWrite<'a> {
    /// Write this endpoint, or remove the field when the value is empty/blank.
    /// Used for providers whose base URL is user-editable in the panel.
    Set(&'a str),
    /// Leave any existing `model.base_url` untouched. Used for providers whose
    /// endpoint is not exposed in the structured fields, so a base URL set
    /// out-of-band (a proxy/Azure endpoint, etc.) survives a structured save.
    Preserve,
}

/// How `merge_hermes_model_config` should treat the inline `model.api_key`
/// (and the companion `model.api_mode`), which only the `custom` provider uses.
enum InlineApiKeyWrite<'a> {
    /// Inline-key provider (`custom`): write `key` (or remove the field when
    /// blank — a keyless local server). `scrub_mode` clears a stale
    /// `model.api_mode`: `true` when switching TO custom from a different
    /// provider (the prior mode must not bleed in), `false` on a custom→custom
    /// re-save so a user's raw-editor `api_mode` (e.g. `anthropic_messages` for
    /// an Anthropic-compatible proxy) survives a structured save.
    Set { key: &'a str, scrub_mode: bool },
    /// Non-inline provider (keyed/OAuth/AWS): scrub any stale inline
    /// `model.api_key` / `model.api_mode` left over from a previous `custom`
    /// endpoint so it can't bleed into the newly selected provider — mirroring
    /// Hermes' own `auth.py` cleanup on a provider switch.
    Clear,
}

/// Set `model.{provider,default,base_url}` in a Hermes config.yaml document,
/// preserving every other top-level key. `default` is only written when a
/// non-empty model is given; `base_url` follows the `BaseUrlWrite` action and
/// the inline `model.api_key` follows the `InlineApiKeyWrite` action.
fn merge_hermes_model_config(
    existing: Option<&str>,
    provider: &str,
    model: &str,
    base_url: BaseUrlWrite<'_>,
    inline_api_key: InlineApiKeyWrite<'_>,
) -> Result<String, AcpError> {
    use serde_yaml::{Mapping, Value};
    let mut root: Value = match existing {
        Some(raw) if !raw.trim().is_empty() => serde_yaml::from_str(raw)
            .map_err(|e| AcpError::protocol(format!("invalid hermes config.yaml: {e}")))?,
        _ => Value::Mapping(Mapping::new()),
    };
    if !root.is_mapping() {
        root = Value::Mapping(Mapping::new());
    }
    let root_map = root.as_mapping_mut().expect("root is a mapping");

    let model_key = Value::String("model".to_string());
    if !root_map
        .get(&model_key)
        .map(Value::is_mapping)
        .unwrap_or(false)
    {
        root_map.insert(model_key.clone(), Value::Mapping(Mapping::new()));
    }
    let model_map = root_map
        .get_mut(&model_key)
        .and_then(Value::as_mapping_mut)
        .expect("model is a mapping");

    model_map.insert(
        Value::String("provider".to_string()),
        Value::String(provider.to_string()),
    );
    if !model.is_empty() {
        model_map.insert(
            Value::String("default".to_string()),
            Value::String(model.to_string()),
        );
    }
    match base_url {
        BaseUrlWrite::Set(url) if !url.trim().is_empty() => {
            model_map.insert(
                Value::String("base_url".to_string()),
                Value::String(url.trim().to_string()),
            );
        }
        BaseUrlWrite::Set(_) => {
            model_map.remove(Value::String("base_url".to_string()));
        }
        // Preserve: leave whatever `model.base_url` is already there.
        BaseUrlWrite::Preserve => {}
    }
    match inline_api_key {
        InlineApiKeyWrite::Set { key, scrub_mode } => {
            if key.trim().is_empty() {
                // Blank key on an inline provider → keyless local server.
                model_map.remove(Value::String("api_key".to_string()));
            } else {
                model_map.insert(
                    Value::String("api_key".to_string()),
                    Value::String(key.trim().to_string()),
                );
            }
            // Switching TO custom scrubs a stale mode; a custom→custom re-save
            // leaves a user's raw-editor `api_mode` untouched.
            if scrub_mode {
                model_map.remove(Value::String("api_mode".to_string()));
            }
        }
        // Non-inline provider: scrub a stale inline key/mode from a prior `custom`.
        InlineApiKeyWrite::Clear => {
            model_map.remove(Value::String("api_key".to_string()));
            model_map.remove(Value::String("api_mode".to_string()));
        }
    }

    serde_yaml::to_string(&root)
        .map_err(|e| AcpError::protocol(format!("serialize hermes config.yaml failed: {e}")))
}

/// Quote a single argv token for the current platform's shell, only when it
/// contains characters that would otherwise be reparsed (so simple tokens stay
/// readable). POSIX uses single quotes; Windows wraps in double quotes.
fn shell_quote_arg(arg: &str) -> String {
    shell_quote_arg_for(arg, cfg!(windows))
}

/// Platform-parameterized core of [`shell_quote_arg`], so both the POSIX and
/// Windows quoting rules are unit-testable on any host.
///
/// The backslash forces quoting on POSIX (it is the shell escape char) but NOT
/// on Windows, where it is just the path separator. Force-quoting a plain
/// Windows path like `C:\…\uvx.exe` makes the rendered command *begin* with a
/// double-quoted string: `cmd.exe` runs that fine, but PowerShell parses a
/// leading quoted string as a string *expression* (invoking it would need the
/// `&` call operator) and dies with "Unexpected token" on the next argument —
/// uvx never runs. Leaving a space-free path unquoted keeps it a bare command
/// token that runs in both `cmd` and PowerShell. (A path that contains spaces
/// still must be quoted; such a copied command stays PowerShell-incompatible and
/// needs a leading `&` when pasted there.)
fn shell_quote_arg_for(arg: &str, windows: bool) -> String {
    // Metacharacters that force quoting. Backslash is POSIX-only: on Windows it
    // is the path separator and quoting on its account is what breaks PowerShell.
    let special: &str = if windows {
        "[](){}'\"$&;|<>*?`!#~"
    } else {
        "[](){}'\"$&;|<>*?`\\!#~"
    };
    let needs_quoting =
        arg.is_empty() || arg.chars().any(|c| c.is_whitespace() || special.contains(c));
    if !needs_quoting {
        return arg.to_string();
    }
    if windows {
        format!("\"{}\"", arg.replace('"', "\\\""))
    } else {
        format!("'{}'", arg.replace('\'', "'\\''"))
    }
}

fn shell_join(argv: &[String]) -> String {
    argv.iter()
        .map(|a| shell_quote_arg(a))
        .collect::<Vec<_>>()
        .join(" ")
}

/// The argv for Hermes's `--setup` and `model` flows: a `hermes` CLI on PATH
/// by bare name (official installer or an npm global bin on PATH — the short
/// form reads best in guidance), else the npm-prefix-resolved absolute path
/// (an npm install whose bin dir is NOT on the terminal's PATH must be
/// addressed absolutely or the displayed command fails), else a documented
/// `npx -y --package <pin> hermes …` form that bootstraps on demand.
/// `--package` is required in that form: the package's default bin is
/// `hermes-agent` (a different console script), not `hermes`. Returned as
/// argv vectors so callers can shell-quote per platform for display or
/// execute them.
async fn hermes_setup_argvs() -> (Vec<String>, Vec<String>) {
    let meta = registry::get_agent_meta(AgentType::Hermes);
    let package = match meta.distribution {
        registry::AgentDistribution::Npx { package, cmd, .. } => {
            if resolve_command_on_path(cmd).is_some() {
                return (
                    vec![cmd.to_string(), "acp".to_string(), "--setup".to_string()],
                    vec![cmd.to_string(), "model".to_string()],
                );
            }
            if let Some(resolved) = resolve_npx_command(cmd).await {
                let bin = resolved.display().to_string();
                return (
                    vec![bin.clone(), "acp".to_string(), "--setup".to_string()],
                    vec![bin, "model".to_string()],
                );
            }
            package
        }
        // Unreachable: Hermes is always an Npx distribution. Fall through to
        // the npx guidance with the same pinned spec so a future match-arm
        // change can't resurrect a stale recipe.
        _ => "hermes-agent@0.21.4",
    };
    let build = |tail: &[&str]| -> Vec<String> {
        let mut argv = vec![
            "npx".to_string(),
            "-y".to_string(),
            // The wrapper's postinstall bootstrap IS the install; without this
            // a user-level ignore-scripts=true yields a shim that exits
            // "runtime is not ready" (npx accepts npm config flags).
            NPM_RUN_SCRIPTS_OVERRIDE.to_string(),
            "--package".to_string(),
            package.to_string(),
            "hermes".to_string(),
        ];
        argv.extend(tail.iter().map(|s| s.to_string()));
        argv
    };
    (build(&["acp", "--setup"]), build(&["model"]))
}

/// Build the displayed/runnable `(setup, model)` shell commands for the Hermes
/// setup guidance, shell-quoted for the current platform.
async fn hermes_setup_commands() -> (String, String) {
    let (setup, model) = hermes_setup_argvs().await;
    (shell_join(&setup), shell_join(&model))
}

/// Read `~/.hermes/.env` + `config.yaml` and project them into the normalized
/// JSON the settings UI binds to: `{provider, model, baseUrl, apiKey,
/// hermesHome, setupCommand, modelCommand}`. Only the active provider's single
/// key var is surfaced — never the rest of `.env`.
/// Project the active provider's API key and endpoint URL for the settings UI.
/// For inline-key providers (`custom`) the key comes from config.yaml's
/// `model.api_key`; for every other keyed provider it is read from the
/// provider's `.env` key var. The base URL prefers config.yaml's
/// `model.base_url` and falls back to the provider's base-URL env var — so an
/// endpoint that lives only in `.env` (e.g. a bare `OPENAI_BASE_URL` with no
/// YAML `base_url`) still shows in the panel and isn't cleared on the next save.
/// Empty stored values are treated as absent. Unknown providers map to nothing
/// here (their key var is undiscoverable; the raw editor governs).
fn project_hermes_key_and_base(
    provider: &str,
    env_map: &BTreeMap<String, String>,
    yaml_base_url: Option<&str>,
    yaml_api_key: Option<&str>,
) -> (Option<String>, Option<String>) {
    let meta = hermes_provider(provider);
    let api_key = if hermes_inlines_api_key(provider) {
        yaml_api_key
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    } else {
        meta.filter(|p| !p.key_env_var.is_empty())
            .and_then(|p| env_map.get(p.key_env_var))
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
    };
    let base_url = yaml_base_url.map(str::to_string).or_else(|| {
        meta.filter(|p| !p.base_url_env_var.is_empty())
            .and_then(|p| env_map.get(p.base_url_env_var))
            .filter(|v| !v.is_empty())
            .map(|v| v.to_string())
    });
    (api_key, base_url)
}

async fn load_hermes_local_config_json() -> Option<String> {
    let env_map = fs::read_to_string(hermes_env_path())
        .ok()
        .map(|raw| parse_env_file(&raw))
        .unwrap_or_default();

    let mut provider: Option<String> = None;
    let mut model: Option<String> = None;
    let mut yaml_base_url: Option<String> = None;
    let mut yaml_api_key: Option<String> = None;
    if let Ok(raw_yaml) = fs::read_to_string(hermes_config_yaml_path()) {
        if let Ok(value) = serde_yaml::from_str::<serde_yaml::Value>(&raw_yaml) {
            if let Some(model_section) = value.get("model") {
                provider = yaml_str(model_section, "provider");
                model = yaml_str(model_section, "default");
                yaml_base_url = yaml_str(model_section, "base_url");
                yaml_api_key = yaml_str(model_section, "api_key");
            }
        }
    }

    let (api_key, base_url) = match provider.as_deref() {
        Some(p) => project_hermes_key_and_base(
            p,
            &env_map,
            yaml_base_url.as_deref(),
            yaml_api_key.as_deref(),
        ),
        None => (None, yaml_base_url),
    };

    let (setup_command, model_command) = hermes_setup_commands().await;

    let mut merged = serde_json::Map::new();
    if let Some(value) = provider {
        merged.insert("provider".to_string(), serde_json::Value::String(value));
    }
    if let Some(value) = model {
        merged.insert("model".to_string(), serde_json::Value::String(value));
    }
    if let Some(value) = base_url {
        merged.insert("baseUrl".to_string(), serde_json::Value::String(value));
    }
    if let Some(value) = api_key {
        merged.insert("apiKey".to_string(), serde_json::Value::String(value));
    }
    merged.insert(
        "hermesHome".to_string(),
        serde_json::Value::String(hermes_home_dir().display().to_string()),
    );
    merged.insert(
        "setupCommand".to_string(),
        serde_json::Value::String(setup_command),
    );
    merged.insert(
        "modelCommand".to_string(),
        serde_json::Value::String(model_command),
    );

    serde_json::to_string_pretty(&serde_json::Value::Object(merged)).ok()
}

/// Structured Hermes config update from the settings UI.
#[derive(Debug, Clone)]
pub(crate) struct HermesConfigUpdate {
    pub provider: String,
    pub api_key: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    /// When present, the raw config.yaml is validated and written verbatim
    /// (advanced mode), bypassing the structured `model:` merge.
    pub raw_config_yaml: Option<String>,
}

/// Whether to skip tightening Hermes file/dir permissions, mirroring the opt-outs
/// Hermes itself honors: containerized / managed deployments (Docker/Podman/LXC/
/// Kubernetes volume mounts with mapped UIDs, etc.) where forcing `0700`/`0600`
/// breaks the multi-process access model. Mirrors Hermes 0.16.0 `_is_container`:
/// the `HERMES_CONTAINER` / `HERMES_SKIP_CHMOD` env opt-outs, the Docker
/// (`/.dockerenv`) and Podman (`/run/.containerenv`) markers, and a
/// docker/lxc/kubepods marker in `/proc/1/cgroup`.
#[cfg(unix)]
fn hermes_skip_chmod() -> bool {
    // Match Hermes' Python truthiness (`os.environ.get(...)` — an empty value is
    // falsy): only a NON-EMPTY opt-out enables skip, so a blank `HERMES_SKIP_CHMOD=`
    // does not (and codeg still performs the 0644→0600 repair Hermes would).
    let truthy = |key: &str| std::env::var(key).map(|v| !v.is_empty()).unwrap_or(false);
    if truthy("HERMES_CONTAINER")
        || truthy("HERMES_SKIP_CHMOD")
        || Path::new("/.dockerenv").exists()
        || Path::new("/run/.containerenv").exists()
    {
        return true;
    }
    fs::read_to_string("/proc/1/cgroup")
        .map(|cgroup| {
            cgroup.contains("docker") || cgroup.contains("lxc") || cgroup.contains("kubepods")
        })
        .unwrap_or(false)
}

/// Parse a `HERMES_HOME_MODE` value (octal, e.g. `0701` for web-server traversal
/// layouts), falling back to owner-only `0700`. Accepts an optional `0o` prefix.
#[cfg(unix)]
fn parse_hermes_home_mode(raw: Option<&str>) -> u32 {
    raw.map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.strip_prefix("0o").unwrap_or(s))
        .and_then(|s| u32::from_str_radix(s, 8).ok())
        .filter(|m| *m != 0)
        .unwrap_or(0o700)
}

/// Create the Hermes home directory if needed. On Unix, tighten it to
/// `HERMES_HOME_MODE` (or `0700`) **only when codeg just created it** and Hermes
/// itself would chmod (not a container/managed deployment). An existing
/// `HERMES_HOME` is left untouched — it may be a NixOS-managed `0750`, a
/// UID-mapped Docker volume, or otherwise deliberately group-accessible, and
/// revoking that would break other Hermes users/processes.
pub(crate) fn ensure_hermes_home_secure(home: &Path) -> Result<(), AcpError> {
    #[cfg(unix)]
    let preexisting = home.exists();
    fs::create_dir_all(home)
        .map_err(|e| AcpError::protocol(format!("create hermes directory failed: {e}")))?;
    #[cfg(unix)]
    if !preexisting && !hermes_skip_chmod() {
        use std::os::unix::fs::PermissionsExt;
        let mode = parse_hermes_home_mode(std::env::var("HERMES_HOME_MODE").ok().as_deref());
        // Best-effort: a chmod hiccup must not block saving the config.
        let _ = fs::set_permissions(home, fs::Permissions::from_mode(mode));
    }
    Ok(())
}

/// Write a Hermes secret file (`.env` / `config.yaml`).
///
/// A brand-new secret — a path whose resolved target does not exist yet, whether
/// `path` itself is absent or a symlink to a missing target — is created
/// owner-only (`0600` on Unix) so it is never world-readable under the process
/// umask, the one real exposure for a first-time codeg-driven setup. An EXISTING
/// target is written through in place, which preserves everything that identifies
/// it: its inode, mode, owner/group, POSIX ACL and xattrs, and any symlink (a
/// dotfile-manager or secret-manager `~/.hermes/.env` keeps pointing at its real
/// target). This deliberately favors preserving a managed/linked layout over an
/// atomic temp+rename replace — a rename would drop the symlink and the inode's
/// owner/ACL/xattrs, and on Windows would swap the file's security descriptor for
/// the parent directory's. It matches Hermes' own model (config.py `_secure_dir`
/// is a Windows no-op; file chmod is Unix-only) and the prior baseline. A crash
/// during the brief write window is recoverable by re-saving. `label` names the
/// file for error messages.
pub(crate) fn write_hermes_secret_file(
    path: &Path,
    contents: &str,
    label: &str,
) -> Result<(), AcpError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        // `metadata` FOLLOWS symlinks, so this is true when the resolved target
        // does not exist yet — a genuinely fresh path OR a symlink whose target
        // is missing (e.g. `~/.hermes/.env -> /vault/hermes.env`). Creating with
        // `O_CREAT` likewise follows the symlink, so the new secret lands at the
        // real target with owner-only `0600` instead of the umask default
        // (`0644`). An existing resolved target is written through in place below.
        if fs::metadata(path).is_err() {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .mode(0o600)
                .open(path)
                .map_err(|e| AcpError::protocol(format!("create hermes {label} failed: {e}")))?;
            return file
                .write_all(contents.as_bytes())
                .map_err(|e| AcpError::protocol(format!("write hermes {label} failed: {e}")));
        }
    }
    // Existing target (or non-Unix): write through in place, preserving the
    // target's identity (inode, owner/group, ACL, xattrs, and any symlink).
    fs::write(path, contents)
        .map_err(|e| AcpError::protocol(format!("write hermes {label} failed: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // Repair an accidentally WORLD-accessible secret (e.g. a `0644` left by an
        // older codeg build or by the pre-fix dangling-symlink path) back to
        // owner-only `0600`: a world-readable API key is a leak, and tightening it
        // to `0640` would still expose it to a broad group like `staff`. A file
        // with no "other" bits — including a deliberately group-shared managed
        // `0640` — is left untouched, and the container/managed chmod opt-out is
        // honored. Best-effort: never fail the save on a chmod hiccup.
        if !hermes_skip_chmod() {
            if let Ok(meta) = fs::metadata(path) {
                if meta.permissions().mode() & 0o007 != 0 {
                    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
                }
            }
        }
    }
    Ok(())
}

/// Write a Hermes config update to `~/.hermes/.env` (the active provider's API
/// key) and `~/.hermes/config.yaml` (the `model:` section, or a verbatim raw
/// document in advanced mode).
pub(crate) fn acp_update_hermes_config_core(
    update: HermesConfigUpdate,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let HermesConfigUpdate {
        provider,
        api_key,
        model,
        base_url,
        raw_config_yaml,
    } = update;

    let home = hermes_home_dir();
    ensure_hermes_home_secure(&home)?;

    // Build + validate everything BEFORE any write, so an invalid document or a
    // crafted key never half-applies (the secret in particular).
    let config_path = hermes_config_yaml_path();
    let existing = if raw_config_yaml.is_none() {
        fs::read_to_string(&config_path).ok()
    } else {
        None
    };
    let model_trimmed = model.as_deref().map(str::trim).unwrap_or_default();
    let (config_yaml, env_updates) = plan_hermes_write(
        &provider,
        api_key.as_deref(),
        model_trimmed,
        base_url.as_deref(),
        raw_config_yaml.as_deref(),
        existing.as_deref(),
    )?;

    // Write config.yaml first, then `.env` — a config-write failure must never
    // leave the stored credential changed. Both are owner-only (they can carry
    // secrets: the `.env` key, and a raw config.yaml in advanced mode).
    write_hermes_secret_file(&config_path, &config_yaml, "config.yaml")?;
    if !env_updates.is_empty() {
        let env_path = hermes_env_path();
        let existing_env = fs::read_to_string(&env_path).unwrap_or_default();
        let updates: Vec<(&str, &str)> =
            env_updates.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let patched = patch_env_text(&existing_env, &updates);
        write_hermes_secret_file(&env_path, &patched, ".env")?;
    }

    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::Hermes));
    Ok(())
}

/// The result of planning a Hermes save: the `config.yaml` content to write and
/// the ordered list of `.env` `(var name, value)` updates to apply (empty when
/// nothing in `.env` changes).
type HermesWritePlan = (String, Vec<(&'static str, String)>);

/// Pure decision logic for a Hermes config save: compute the config.yaml content
/// to write and the `.env` `(key_var, value)` updates. Validation happens here
/// (no I/O) so a bad request fails before anything is written.
///
/// Raw mode is enforced server-side to never touch `.env` (the API contract is
/// not left to the caller's payload). OAuth/AWS providers carry no key var, so
/// they never produce a key update. Keyed providers update their API key (a
/// blank key leaves the stored secret untouched); providers with a base-URL env
/// var also mirror the structured endpoint URL there. Embedded newlines in the
/// key or base URL are rejected.
fn plan_hermes_write(
    provider: &str,
    api_key: Option<&str>,
    model: &str,
    base_url: Option<&str>,
    raw_config_yaml: Option<&str>,
    existing_config: Option<&str>,
) -> Result<HermesWritePlan, AcpError> {
    // The provider the existing config.yaml was on (None for a first save / raw
    // mode). Drives base-URL preservation and stale-`.env`-credential cleanup.
    let previous_provider = existing_hermes_model_provider(existing_config);

    let config_yaml = if let Some(raw) = raw_config_yaml {
        serde_yaml::from_str::<serde_yaml::Value>(raw)
            .map_err(|e| AcpError::protocol(format!("invalid hermes config.yaml: {e}")))?;
        raw.to_string()
    } else {
        // Structured mode only handles providers in the curated table. The
        // `custom` provider IS handled (its key/endpoint live inline in
        // config.yaml — see `hermes_inlines_api_key`), but unknown ids (the
        // legacy `openai` pseudo-provider, user-defined `custom:` slugs, or
        // anything outside the table) have no credential layout codeg can map —
        // reject them and steer the user to the raw config.yaml editor, which
        // stays the escape hatch.
        let meta = hermes_provider(provider).ok_or_else(|| {
            AcpError::protocol(format!(
                "unknown hermes provider '{provider}'; edit ~/.hermes/config.yaml directly"
            ))
        })?;
        // Decide what happens to `model.base_url`:
        // - User-editable endpoint (openai-api/lmstudio/azure-foundry) → write the
        //   field's value, or clear it when blank.
        // - Endpoint not exposed in the panel, and the provider is UNCHANGED →
        //   preserve an out-of-band base URL (proxy/Azure) the user set elsewhere.
        // - Endpoint not exposed, but the provider just CHANGED → clear the stale
        //   base URL left over from the previous provider (it must not carry over).
        let base = if meta.needs_base_url {
            BaseUrlWrite::Set(base_url.unwrap_or(""))
        } else if previous_provider.as_deref() == Some(provider) {
            BaseUrlWrite::Preserve
        } else {
            BaseUrlWrite::Set("")
        };
        // Inline key — `custom` only. The key rides in `model.api_key`; every
        // other provider gets `Clear` so a stale inline key from a previous
        // `custom` endpoint never bleeds into the new provider. A blank inline
        // key drops the field (keyless local server).
        let inline_api_key = if hermes_inlines_api_key(provider) {
            let key = api_key.map(str::trim).unwrap_or_default();
            if key.contains(['\n', '\r']) {
                return Err(AcpError::protocol(
                    "hermes api key must not contain newlines",
                ));
            }
            // Scrub a stale `api_mode` only when switching TO custom from a
            // different provider; a custom→custom re-save preserves it.
            let scrub_mode = previous_provider.as_deref() != Some(provider);
            InlineApiKeyWrite::Set { key, scrub_mode }
        } else {
            InlineApiKeyWrite::Clear
        };
        merge_hermes_model_config(existing_config, provider, model, base, inline_api_key)?
    };

    // Raw mode edits config.yaml only; never `.env`.
    let mut env_updates: Vec<(&'static str, String)> = Vec::new();
    if raw_config_yaml.is_none() {
        let meta = hermes_provider(provider);
        // API key — keyed providers only. A blank key leaves the stored secret
        // untouched (so switching providers can't wipe it).
        if let Some(meta) = meta.filter(|p| !p.key_env_var.is_empty()) {
            if let Some(key) = api_key.map(str::trim).filter(|k| !k.is_empty()) {
                if key.contains(['\n', '\r']) {
                    return Err(AcpError::protocol(
                        "hermes api key must not contain newlines",
                    ));
                }
                env_updates.push((meta.key_env_var, key.to_string()));
            }
        }
        // Endpoint URL — mirror the structured base URL into the provider's
        // base-URL env var so `.env` and config.yaml `model.base_url` agree
        // under either of Hermes' resolution paths. An empty value clears a
        // stale override.
        if let Some(meta) = meta.filter(|p| p.needs_base_url && !p.base_url_env_var.is_empty()) {
            let base = base_url.map(str::trim).unwrap_or_default();
            if base.contains(['\n', '\r']) {
                return Err(AcpError::protocol(
                    "hermes base url must not contain newlines",
                ));
            }
            env_updates.push((meta.base_url_env_var, base.to_string()));
        }
        // Neutralize only vars that can actually BLEED INTO the selected
        // provider's runtime path — never blanket-wipe the previous provider's
        // own credential (a valid ANTHROPIC_API_KEY must survive an anthropic→zai
        // switch; zai won't read it). The one documented cross-provider fallback
        // in hermes 0.16.0: openrouter (being OpenAI-API compatible) falls back to
        // OPENAI_API_KEY and treats OPENAI_BASE_URL as an endpoint override. So
        // when saving openrouter, write an explicit empty `OPENAI_API_KEY=` /
        // `OPENAI_BASE_URL=` — appended even if absent from `.env`, since under
        // Hermes' dotenv override loading only that masks a stale value inherited
        // from the process environment.
        if provider == "openrouter" {
            for var in ["OPENAI_API_KEY", "OPENAI_BASE_URL"] {
                if !env_updates.iter().any(|(k, _)| *k == var) {
                    env_updates.push((var, String::new()));
                }
            }
        }
    }

    Ok((config_yaml, env_updates))
}

/// Compare two base URLs for equality, ignoring a trailing slash — every Hermes
/// endpoint rstrips `/`, so `https://x/v1` and `https://x/v1/` are the same host
/// and must not churn a managed/symlinked `.env` on every launch. Used for the
/// reconcile decision ONLY; the value written to `.env` stays verbatim.
fn base_url_eq(a: &str, b: &str) -> bool {
    a.trim_end_matches('/') == b.trim_end_matches('/')
}

/// Decide how to reconcile the active provider's base-URL `.env` variable with
/// `config.yaml`'s `model.base_url`, so Hermes' auxiliary credential path —
/// `auth.py::resolve_api_key_provider_credentials`, which reads the endpoint
/// ONLY from the provider's `<X>_BASE_URL` env var — resolves the SAME endpoint
/// as the main loop, which reads `config.yaml model.base_url`. Hermes' own
/// `hermes model`/`hermes setup` writes `model.base_url` but never the `.env`
/// var, so auxiliary tasks (title generation, compression, …) silently fall
/// back to the provider's registry-default host and 401 against the wrong
/// endpoint. The settings panel already mirrors both on save; this covers
/// configs authored outside codeg.
///
/// Scope is the single ACTIVE provider's own base-URL var, never another
/// provider's. Returns `Some((env_var, value))` to write — `value` is the
/// verbatim `model.base_url`, or `""` to clear a stale override that would
/// otherwise bleed into the auxiliary path — or `None` for a no-op. Unknown /
/// legacy providers and ones with no base-URL var (OAuth, Bedrock,
/// kimi-coding-cn) map to `None`.
fn plan_hermes_base_url_reconcile(
    provider: &str,
    yaml_base_url: Option<&str>,
    current_env_value: Option<&str>,
) -> Option<(&'static str, String)> {
    let meta = hermes_provider(provider).filter(|p| !p.base_url_env_var.is_empty())?;
    let desired = yaml_base_url.map(str::trim).unwrap_or_default();
    // A base URL carrying an embedded newline would let `patch_env_text` emit an
    // extra `.env` line — injecting ANOTHER provider's var and breaking the
    // single-active-var invariant. config.yaml is the user's own file, but skip
    // rather than corrupt `.env` (the panel's `plan_hermes_write` rejects
    // newlines the same way). A blank-after-trim value still falls through to the
    // empty/clear path below.
    if desired.contains(['\n', '\r']) {
        return None;
    }
    let current = current_env_value.unwrap_or_default();
    if desired.is_empty() {
        // No endpoint in config.yaml. Clear a stale, non-empty override so it
        // can't shadow the registry default in the auxiliary path; leave an
        // absent/empty var alone (don't append a redundant `KEY=`).
        if current.is_empty() {
            return None;
        }
        return Some((meta.base_url_env_var, String::new()));
    }
    if base_url_eq(desired, current) {
        return None;
    }
    Some((meta.base_url_env_var, desired.to_string()))
}

/// Reconcile `~/.hermes/.env`'s base-URL variable with `config.yaml`'s
/// `model.base_url` for the active provider, right before launching Hermes, so
/// auxiliary tasks and the main loop hit the same endpoint (see
/// `plan_hermes_base_url_reconcile`). Best-effort: a failure here must never
/// block a launch, so the result is logged and swallowed.
///
/// Note: for `openai-api` this sets `OPENAI_BASE_URL`, which makes Hermes log a
/// one-time "OPENAI_BASE_URL is set but provider is not custom" warning. That is
/// a false positive — `OPENAI_BASE_URL` IS the correct base-URL var for
/// `openai-api` — so do not "fix" it by dropping the var.
/// Resolve the Hermes home a launch with `runtime_env` will actually use, so
/// reconcile patches the same `.env` the launched process reads.
///
/// When the agent's `env_json` sets `HERMES_HOME` it lands in `runtime_env`,
/// which `merge_agent_env` gives highest precedence — so it *replaces* the
/// parent's value in the child. We must resolve that override exactly as the
/// launched Hermes' own `get_hermes_home` does: trim it; a non-empty value is
/// used VERBATIM (`Path(val)` — Hermes does NOT expand `~`); a blank value falls
/// back to the default `~/.hermes` (it does NOT re-inherit the parent). With no
/// override the child inherits the parent env, so defer to `hermes_home_dir()`
/// (codeg's existing resolution, shared with the settings panel).
fn hermes_home_for_launch(runtime_env: &BTreeMap<String, String>) -> PathBuf {
    match runtime_env.get("HERMES_HOME") {
        Some(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                home_dir_or_default().join(".hermes")
            } else {
                PathBuf::from(trimmed)
            }
        }
        None => hermes_home_dir(),
    }
}

pub(crate) fn reconcile_hermes_runtime_env(runtime_env: &BTreeMap<String, String>) {
    if let Err(err) = reconcile_hermes_runtime_env_in(&hermes_home_for_launch(runtime_env)) {
        tracing::warn!("[ACP][Hermes] base_url reconcile skipped: {err}");
    }
}

/// Inner reconcile keyed on an explicit home dir (so tests drive a tempdir
/// without mutating `HERMES_HOME`). No-ops when `config.yaml` is absent — it
/// must never create `~/.hermes`; a config written later goes through the panel
/// (which already mirrors the base URL) or a subsequent launch.
fn reconcile_hermes_runtime_env_in(home: &Path) -> Result<(), AcpError> {
    let config_path = home.join("config.yaml");
    let Ok(raw_yaml) = fs::read_to_string(&config_path) else {
        return Ok(());
    };
    let value: serde_yaml::Value = serde_yaml::from_str(&raw_yaml)
        .map_err(|e| AcpError::protocol(format!("parse hermes config.yaml: {e}")))?;
    let Some(model_section) = value.get("model") else {
        return Ok(());
    };
    let Some(provider) = yaml_str(model_section, "provider") else {
        return Ok(());
    };
    let yaml_base_url = yaml_str(model_section, "base_url");

    let env_path = home.join(".env");
    // Only a MISSING `.env` is an empty baseline. An existing-but-unreadable file
    // (non-UTF-8, permission-denied, …) must abort the reconcile — patching from
    // an empty baseline would rewrite `.env` with just the base-URL line and drop
    // the user's API keys and comments. A dangling symlink reads as NotFound and
    // is correctly created fresh (0600) by `write_hermes_secret_file`.
    let existing_env = match fs::read_to_string(&env_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(AcpError::protocol(format!("read hermes .env: {e}"))),
    };
    let env_map = parse_env_file(&existing_env);
    let current = hermes_provider(&provider)
        .filter(|p| !p.base_url_env_var.is_empty())
        .and_then(|p| env_map.get(p.base_url_env_var))
        .map(String::as_str);

    let Some((var, val)) =
        plan_hermes_base_url_reconcile(&provider, yaml_base_url.as_deref(), current)
    else {
        return Ok(());
    };

    let patched = patch_env_text(&existing_env, &[(var, val.as_str())]);
    write_hermes_secret_file(&env_path, &patched, ".env")
}

fn agent_local_config_path(agent_type: AgentType) -> Option<PathBuf> {
    match agent_type {
        AgentType::ClaudeCode => Some(home_dir_or_default().join(".claude").join("settings.json")),
        AgentType::Gemini => Some(home_dir_or_default().join(".gemini").join("settings.json")),
        // Antigravity's ACP server keeps its own `settings.json` under
        // `<GEMINI_HOME>/antigravity-acp/` — a DIFFERENT file from Gemini
        // CLI's above, even though both trees default to `~/.gemini`. Exposing
        // the path lights up "open config file"; the write side is owned by
        // `acp::connection::sync_antigravity_settings_file` at launch, which
        // merges only `auth.type` and the `gcp` block and leaves every other
        // key the user put there alone.
        AgentType::Antigravity => Some(
            crate::parsers::antigravity::resolve_antigravity_acp_dir().join("settings.json"),
        ),
        AgentType::OpenCode => Some(resolve_opencode_config_path()),
        // The CLI's live credential store, NOT the legacy `globalState.json`
        // it migrates from once and then ignores — so "open config file" shows
        // the file that is actually in effect. Both the load and the persist
        // sides are special-cased below (the store is two files, and the shape
        // is schema-validated), so this path only feeds that link and the
        // staleness fingerprint.
        AgentType::Cline => Some(cline_provider_settings_path()),
        // Kimi Code's native config is `~/.kimi-code/config.toml`. Exposing the
        // path lights up "open config file" + staleness tracking; the actual
        // load/persist are special-cased below (TOML, not the generic JSON path).
        AgentType::KimiCode => Some(kimi_code_config_toml_path()),
        // Qoder's native config is `<QODER_CONFIG_DIR>/settings.json` (default
        // `~/.qoder`), plain JSON — so the generic loader above reads it as-is
        // and the Qoder panel's advanced editor round-trips it through
        // `config_json`. The WRITE side is special-cased in
        // `acp_update_agent_config_core` (written verbatim) and never reaches
        // this module's generic merge-persist, which could not delete a key.
        //
        // Note this file has other writers: codeg's own MCP settings page owns
        // its top-level `mcpServers` (see `commands::mcp::qoder_settings_path`,
        // which resolves the same path through the same helper).
        AgentType::Qoder => Some(qoder_settings_json_path()),
        _ => None,
    }
}

/// `<QODER_CONFIG_DIR>/settings.json` (default `~/.qoder/settings.json`).
/// Delegates to the parser's resolver, which already honours both
/// `QODER_CONFIG_DIR` (absolute path) and `QODER_CONFIG_DIR_NAME` (dir rename).
fn qoder_settings_json_path() -> PathBuf {
    crate::parsers::qoder::resolve_qoder_config_dir().join("settings.json")
}

pub(crate) fn load_agent_local_config_json(agent_type: AgentType) -> Option<String> {
    if agent_type == AgentType::Codex {
        return load_codex_local_config_json();
    }
    if agent_type == AgentType::Cline {
        return load_cline_local_config_json();
    }
    if agent_type == AgentType::KimiCode {
        return load_kimi_code_config_json();
    }

    let path = agent_local_config_path(agent_type)?;
    if !path.exists() {
        return None;
    }

    let raw = fs::read_to_string(path).ok()?;
    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    if !parsed.is_object() {
        return None;
    }
    serde_json::to_string_pretty(&parsed).ok()
}

/// What a patch subtree means where the base has nothing to merge it into: a
/// copy with its nested removal sentinels (`null` object values) dropped, or
/// `None` when it carried nothing but removals.
///
/// Copying such a subtree verbatim is what turned the "remove this key"
/// sentinel into a literal `null` on disk — and a `null` under
/// `~/.claude/settings.json`'s `env` is not "unset": the Claude Code CLI
/// stringifies it into `process.env`, so `ANTHROPIC_DEFAULT_OPUS_MODEL` becomes
/// the model name `"null"` and every row of the composer's model picker reads
/// `null`. The trigger is a first provider bind against a settings file that has
/// no `env` object yet, which is exactly the "no model configured" case: every
/// `ANTHROPIC_*_MODEL` key in the cascade patch is a removal.
///
/// Arrays are copied as-is: `merge_json_values` never treats their elements as
/// keys, so a `null` inside one is data, not a sentinel.
fn patch_addition(patch: &serde_json::Value) -> Option<serde_json::Value> {
    let Some(patch_obj) = patch.as_object() else {
        return Some(patch.clone());
    };
    let mut kept = serde_json::Map::new();
    for (key, value) in patch_obj {
        if value.is_null() {
            continue;
        }
        if let Some(value) = patch_addition(value) {
            kept.insert(key.clone(), value);
        }
    }
    // An object the patch author wrote as empty is a value in its own right; one
    // left empty by dropping removals asks for nothing and creates nothing.
    if kept.is_empty() && !patch_obj.is_empty() {
        return None;
    }
    Some(serde_json::Value::Object(kept))
}

fn merge_json_values(base: &mut serde_json::Value, patch: &serde_json::Value) {
    if let (Some(base_obj), Some(patch_obj)) = (base.as_object_mut(), patch.as_object()) {
        for (key, patch_value) in patch_obj {
            if patch_value.is_null() {
                // null in patch means "remove this key"
                base_obj.remove(key);
                continue;
            }
            match base_obj.get_mut(key) {
                Some(base_value) => merge_json_values(base_value, patch_value),
                // Nothing here to remove, so the subtree's own removal sentinels
                // must not be materialized alongside its real values.
                None => {
                    if let Some(value) = patch_addition(patch_value) {
                        base_obj.insert(key.clone(), value);
                    }
                }
            }
        }
        return;
    }

    // Type mismatch (or a non-object base): the patch replaces the base
    // wholesale, minus its removal sentinels — there is nothing here for them to
    // remove either. An all-removals object collapses to `{}` rather than
    // leaving the mistyped value in place.
    *base = patch_addition(patch).unwrap_or_else(|| serde_json::Value::Object(Default::default()));
}

fn persist_agent_local_config_json(
    agent_type: AgentType,
    config_patch_json: Option<&str>,
) -> Result<(), AcpError> {
    if agent_type == AgentType::Codex {
        return persist_codex_local_config(config_patch_json);
    }
    if agent_type == AgentType::Cline {
        return persist_cline_local_config(config_patch_json);
    }
    if agent_type == AgentType::KimiCode {
        // Kimi's config.toml is written exclusively through the dedicated
        // `acp_update_kimi_code_config` command (structured/raw modes). The
        // generic JSON-merge persist must never touch it (it would write JSON
        // into a TOML file).
        return Ok(());
    }

    let Some(path) = agent_local_config_path(agent_type) else {
        return Ok(());
    };
    let Some(raw_patch) = config_patch_json else {
        return Ok(());
    };

    let patch = serde_json::from_str::<serde_json::Value>(raw_patch)
        .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;
    if !patch.is_object() {
        return Err(AcpError::protocol(
            "invalid config_json: root must be a JSON object",
        ));
    }

    if agent_type == AgentType::OpenCode {
        let serialized = serde_json::to_string_pretty(&patch)
            .map_err(|e| AcpError::protocol(format!("serialize config_json failed: {e}")))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AcpError::protocol(format!("create config directory failed: {e}")))?;
        }
        fs::write(&path, format!("{serialized}\n"))
            .map_err(|e| AcpError::protocol(format!("write local config failed: {e}")))?;
        return Ok(());
    }

    let mut base = if path.exists() {
        match fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        {
            Some(existing) if existing.is_object() => existing,
            _ => serde_json::json!({}),
        }
    } else {
        serde_json::json!({})
    };

    merge_json_values(&mut base, &patch);
    let serialized = serde_json::to_string_pretty(&base)
        .map_err(|e| AcpError::protocol(format!("serialize config_json failed: {e}")))?;

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create config directory failed: {e}")))?;
    }
    fs::write(&path, format!("{serialized}\n"))
        .map_err(|e| AcpError::protocol(format!("write local config failed: {e}")))?;

    Ok(())
}

pub(crate) fn skill_storage_spec(agent_type: AgentType) -> Option<SkillStorageSpec> {
    match agent_type {
        AgentType::ClaudeCode => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![home_dir_or_default().join(".claude").join("skills")],
            project_rel_dirs: vec![".claude/skills"],
        }),
        AgentType::Codex => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOrMarkdownFile,
            global_dirs: vec![
                codex_home_dir().join("skills"),
                // `.system` is where Codex CLI stores its own bundled
                // skills (imagegen, skill-creator, etc.). The directory
                // name is a Codex convention, not a stable contract —
                // if Codex renames it we'll silently stop listing them.
                // `is_read_only_skill_path` mirrors this path to prevent
                // edit/delete from clobbering CLI assets.
                codex_home_dir().join("skills").join(".system"),
                home_dir_or_default().join(".agents").join("skills"),
            ],
            project_rel_dirs: vec![".codex/skills", ".agents/skills"],
        }),
        AgentType::OpenCode => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            // OpenCode is a "universal" agent for the `skills` CLI (its
            // skillsDir is `.agents/skills`): a global `skills add` writes the
            // real skill into the shared `~/.agents/skills` store and does NOT
            // create a `~/.config/opencode/skills` symlink. OpenCode reads both
            // locations, so probe both — otherwise CLI-installed skills are
            // invisible here and in Settings → Skills.
            global_dirs: vec![
                home_dir_or_default()
                    .join(".config")
                    .join("opencode")
                    .join("skills"),
                home_dir_or_default().join(".agents").join("skills"),
            ],
            project_rel_dirs: vec![".agents/skills", ".opencode/skills"],
        }),
        AgentType::Gemini => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                home_dir_or_default().join(".gemini").join("skills"),
                home_dir_or_default().join(".agents").join("skills"),
            ],
            project_rel_dirs: vec![".gemini/skills", ".agents/skills"],
        }),
        AgentType::OpenClaw => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![home_dir_or_default().join(".openclaw").join("skills")],
            project_rel_dirs: vec!["skills"],
        }),
        AgentType::Cline => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                home_dir_or_default().join(".agents").join("skills"),
                home_dir_or_default().join(".cline").join("skills"),
            ],
            project_rel_dirs: vec![
                ".agents/skills",
                ".cline/skills",
                ".clinerules/skills",
                ".claude/skills",
            ],
        }),
        AgentType::Hermes => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![hermes_home_dir().join("skills")],
            project_rel_dirs: vec![],
        }),
        // CodeBuddy is a Claude Code derivative: same `skills` directory
        // layout, under `~/.codebuddy` instead of `~/.claude`.
        AgentType::CodeBuddy => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![home_dir_or_default().join(".codebuddy").join("skills")],
            project_rel_dirs: vec![".codebuddy/skills"],
        }),
        // Kimi Code scans four roots, not two (`features/skill/catalog/
        // skillRoots.ts`): a user pair of `<KIMI_CODE_HOME>/skills` +
        // `<osHome>/.agents/skills`, and a project pair of `.kimi-code/skills`
        // + `.agents/skills`. Note the two bases differ — the brand dir hangs
        // off the DATA home (so `KIMI_CODE_HOME` moves it) while the shared
        // store hangs off the OS home (so it does not), which is why only the
        // first goes through `resolve_kimi_code_home_dir`. The kimi-native dir
        // stays first so codeg links into Kimi's own store by default and
        // toggling Kimi does not move a skill out from under pi/cline/codex,
        // which share `~/.agents/skills` too.
        //
        // Verified live rather than read off the source: with `KIMI_CODE_HOME`
        // pointed at an empty temp dir, `kimi acp` still advertised this
        // machine's `~/.agents/skills` entries as `skill:<name>` in
        // `available_commands_update`.
        AgentType::KimiCode => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                crate::parsers::kimi_code::resolve_kimi_code_home_dir().join("skills"),
                home_dir_or_default().join(".agents").join("skills"),
            ],
            project_rel_dirs: vec![".kimi-code/skills", ".agents/skills"],
        }),
        // pi auto-loads skills from `~/.pi/agent/skills` and the shared
        // `~/.agents/skills` store (both global), plus project-local
        // `.pi/skills` / `.agents/skills` once the workspace is trusted (codeg
        // seeds that trust on connect). `~/.pi/agent/skills` additionally
        // accepts standalone `.md` files, so this mirrors Codex's spec shape.
        // The pi-native dir comes first so toggling pi links into its own dir
        // without cross-agent side effects on the shared store.
        AgentType::Pi => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOrMarkdownFile,
            global_dirs: vec![
                pi_agent_dir().join("skills"),
                home_dir_or_default().join(".agents").join("skills"),
            ],
            project_rel_dirs: vec![".pi/skills", ".agents/skills"],
        }),
        // Grok reads skills from `<GROK_HOME>/skills/` (default
        // `~/.grok/skills/`, one `SKILL.md`-bearing directory per skill) and
        // project-local `<root>/.grok/skills/`.
        AgentType::Grok => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![crate::parsers::grok::resolve_grok_home_dir().join("skills")],
            project_rel_dirs: vec![".grok/skills"],
        }),
        // Cursor discovers skills in `~/.cursor/skills` + the shared
        // `~/.agents/skills` store (user scope) and `.cursor/skills` /
        // `.agents/skills` in the workspace (verified against the CLI's own
        // discovery table). `~/.cursor/skills-cursor` holds Cursor's bundled
        // builtin skills — listed for visibility but write-protected via
        // `is_read_only_skill_path`.
        AgentType::Cursor => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                home_dir_or_default().join(".cursor").join("skills"),
                home_dir_or_default().join(".agents").join("skills"),
                home_dir_or_default().join(".cursor").join("skills-cursor"),
            ],
            project_rel_dirs: vec![".cursor/skills", ".agents/skills"],
        }),
        // deepseek-acp mounts the upstream skills chain
        // (`dsh-skill-filesystem`), which discovers BOTH directory bundles
        // (`<id>/SKILL.md`) and flat `<id>.md` files — hence Codex's spec
        // shape. Its roots, highest rank first: `<project>/.dsh/skills`,
        // `<project>/.agents/skills`, `$DSH_HOME/skills` (default `~/.dsh`),
        // `$DSH_AGENTS_HOME/skills` (default `~/.agents`). The DeepSeek-native
        // directory comes first so linking targets it without cross-agent side
        // effects on the shared `.agents` store — the same ordering rationale
        // as pi and Cursor.
        AgentType::DeepSeek => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOrMarkdownFile,
            global_dirs: vec![
                crate::parsers::deepseek::resolve_dsh_home_dir().join("skills"),
                crate::parsers::deepseek::resolve_dsh_agents_home_dir().join("skills"),
            ],
            project_rel_dirs: vec![".dsh/skills", ".agents/skills"],
        }),
        // Qoder discovers directory bundles only — `<id>/SKILL.md`, never flat
        // `<id>.md` files — hence Claude's spec shape rather than Codex's.
        //
        // Roots read verbatim off `SkillCommandHandler.enumerate` in the
        // qodercli 1.1.23 bundle, which resolves them through
        // `{projectDir: <workDir>/<projectConfigDirName>, userDir: <globalDir>}`
        // (both config dir names default to `.qoder`):
        //
        //   home       `<globalDir>/skills`            ← relocated by QODER_CONFIG_DIR
        //   home       `~/.agents/skills`              ← only if loadFromAgentsDirectory
        //   workspace  `<cwd>/.qoder/skills`
        //   workspace  `<cwd>/.agents/skills`          ← only if loadFromAgentsDirectory
        //
        // Qoder's OWN dirs lead in both scopes because they are the ones it
        // always scans: the `.agents` pair is gated behind
        // `loadSkillsFromAgentsDirectory`, which defaults to FALSE. Writing
        // installs to `.agents` alone (and to a bare `<cwd>/skills`, which
        // nothing scans) is why this used to install skills the agent never
        // loaded — while leaving whatever the user already had in
        // `~/.qoder/skills` invisible to codeg. Both `.agents` roots stay in
        // the list so a user who did turn the setting on still sees them.
        AgentType::Qoder => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                crate::parsers::qoder::resolve_qoder_config_dir().join("skills"),
                // `getGlobalAgentsDir()` joins `.agents` onto Qoder's CLI HOME,
                // not the OS home — the shared store moves with
                // `QODER_CLI_HOME` even though it lives outside the config dir.
                crate::parsers::qoder::resolve_qoder_home()
                    .join(".agents")
                    .join("skills"),
            ],
            project_rel_dirs: vec![
                crate::parsers::qoder::qoder_project_skills_rel_dir(),
                ".agents/skills",
            ],
        }),
        // Antigravity's roots are `server.py::resolve_skills_paths`, verbatim
        // and in its order:
        //
        //   home       `<GEMINI_HOME>/config/skills`        ← cross-surface global
        //   workspace  `<cwd>/.gemini/skills`
        //   home       `<GEMINI_HOME>/antigravity-cli/skills` ← the CLI's, read too
        //   workspace  `<cwd>/.agents/skills`
        //
        // Both home roots follow the resolved `GEMINI_HOME` on purpose: the
        // server's own comment records that a `$HOME`-anchored entry here used
        // to hand the real `~/.gemini` to the agent even when the home had
        // been relocated. `config/skills` leads because it is the directory
        // Antigravity itself calls the global one; `antigravity-cli/skills`
        // belongs to the CLI and is only READ, so installs must not land
        // there ahead of it.
        //
        // `SkillDirectoryOnly`: the discovery docstring says "SKILL.md files
        // or skill subfolders", which does not distinguish a bundle's
        // `<id>/SKILL.md` from a flat `<id>.md`, and the actual scan happens
        // inside the Go harness. The directory bundle is the shape every agent
        // supports, so codeg installs that rather than guessing at the wider
        // one and writing skills the agent may never load.
        AgentType::Antigravity => Some(SkillStorageSpec {
            kind: SkillStorageKind::SkillDirectoryOnly,
            global_dirs: vec![
                crate::parsers::antigravity::resolve_antigravity_shared_config_dir()
                    .join("skills"),
                crate::parsers::antigravity::resolve_antigravity_cli_dir().join("skills"),
            ],
            project_rel_dirs: vec![".gemini/skills", ".agents/skills"],
        }),
        // codeg cannot detect where an arbitrary ACP agent loads skills from,
        // so custom agents are gated on the user's own declaration: that the
        // agent reads the shared `.agents/skills` store (the cross-agent
        // convention OpenCode, Gemini, Cline, Codex, pi, and Cursor already
        // follow), that it reads a dedicated directory of its own, or both.
        // The dedicated directory is listed first so linking targets it
        // without cross-agent side effects on the shared store — the same
        // ordering rationale as pi and Cursor. Undeclared (or deleted) agents
        // return `None`, which is also the gate that keeps them out of the
        // experts / office / science matrices (`supported_agents` derives from
        // this function). The dedicated path was normalized to absolute at
        // save time; a non-absolute value (a hand-edited database) is ignored
        // rather than resolved against an arbitrary working directory.
        AgentType::Custom(id) => {
            let decl = crate::acp::custom_registry::skills_decl(id);
            let mut global_dirs = Vec::new();
            if let Some(dir) = decl
                .dir
                .map(std::path::Path::new)
                .filter(|p| p.is_absolute())
            {
                global_dirs.push(dir.to_path_buf());
            }
            if decl.shared_store {
                global_dirs.push(home_dir_or_default().join(".agents").join("skills"));
            }
            if global_dirs.is_empty() {
                None
            } else {
                Some(SkillStorageSpec {
                    kind: SkillStorageKind::SkillDirectoryOnly,
                    global_dirs,
                    // Only the shared convention has a project-local layout;
                    // a dedicated directory is global by definition.
                    project_rel_dirs: if decl.shared_store {
                        vec![".agents/skills"]
                    } else {
                        vec![]
                    },
                })
            }
        }
    }
}

fn scope_rank(scope: AgentSkillScope) -> u8 {
    match scope {
        AgentSkillScope::Global => 0,
        AgentSkillScope::Project => 1,
    }
}

pub(crate) fn validate_skill_id(raw: &str) -> Result<String, AcpError> {
    let id = raw.trim();
    if id.is_empty() {
        return Err(AcpError::protocol("skill id cannot be empty"));
    }
    if id.starts_with('.') {
        return Err(AcpError::protocol("skill id cannot start with a dot (.)"));
    }
    if id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(AcpError::protocol(
            "skill id cannot contain path separators",
        ));
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(AcpError::protocol(
            "skill id can only include letters, numbers, '-', '_' and '.'",
        ));
    }
    Ok(id.to_string())
}

pub(crate) fn scoped_skill_dirs(
    agent_type: AgentType,
    scope: AgentSkillScope,
    workspace_path: Option<&str>,
) -> Result<Vec<PathBuf>, AcpError> {
    let spec = skill_storage_spec(agent_type).ok_or_else(|| {
        AcpError::protocol(format!(
            "{agent_type} skills are not supported in Settings yet"
        ))
    })?;

    match scope {
        AgentSkillScope::Global => Ok(spec.global_dirs),
        AgentSkillScope::Project => {
            let workspace = workspace_path
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| {
                    AcpError::protocol("workspace_path is required for project scoped skills")
                })?;
            let base = project_skill_base(agent_type, workspace);
            Ok(spec
                .project_rel_dirs
                .iter()
                .map(|relative| base.join(relative))
                .collect())
        }
    }
}

/// The directory an agent's PROJECT-relative skill dirs hang off.
///
/// Normally the workspace itself. DeepSeek and Kimi Code are the exceptions:
/// both walk up from the session cwd to the nearest ancestor containing `.git`
/// before joining their project-relative skill dirs, falling back to the cwd
/// when they reach the filesystem root — DeepSeek in `dsh-skill-filesystem`'s
/// `findProjectRoot`, Kimi in `features/skill/catalog/skillRoots.ts`'s
/// `projectRoots` → `findUpwardRoot(workDir, ".git", exists)`. Opening a
/// subdirectory of a repo as the workspace would otherwise make codeg create
/// and list `<subdir>/.dsh/skills` / `<subdir>/.kimi-code/skills` — a directory
/// the agent never scans, so the skill would simply never load, with nothing on
/// screen saying so.
///
/// Kimi's half was confirmed live: `kimi acp` launched with `cwd` at
/// `<repo>/sub` advertised the skills under `<repo>/.kimi-code/skills` and
/// `<repo>/.agents/skills` and ignored the ones under `<repo>/sub/...`.
///
/// `.git` is matched as a plain path, file or directory: in a linked worktree
/// (which codeg creates routinely) it is a FILE, and both upstreams' existence
/// probes (`pathExists` / `stat`) accept that too.
fn project_skill_base(agent_type: AgentType, workspace: &str) -> PathBuf {
    let workspace = PathBuf::from(workspace);
    if !matches!(agent_type, AgentType::DeepSeek | AgentType::KimiCode) {
        return workspace;
    }
    let mut current = workspace.as_path();
    loop {
        if current.join(".git").exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => return workspace.clone(),
        }
    }
}

pub(crate) fn preferred_scope_skill_dir(
    agent_type: AgentType,
    scope: AgentSkillScope,
    workspace_path: Option<&str>,
) -> Result<PathBuf, AcpError> {
    let dirs = scoped_skill_dirs(agent_type, scope, workspace_path)?;
    dirs.into_iter()
        .next()
        .ok_or_else(|| AcpError::protocol("no skill directory resolved for this agent"))
}

fn is_markdown_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn skill_name_from_id(id: &str) -> String {
    id.to_string()
}

/// Best-effort extraction of a one-line skill description from a markdown
/// file's YAML frontmatter. Prefers `short-description` (commonly nested under
/// a `metadata:` block) and falls back to a top-level `description`. Only the
/// first 4 KiB is read; frontmatter always fits, and skill bodies can be large.
pub(crate) fn read_skill_description(content_path: &Path) -> Option<String> {
    use std::io::Read;
    let mut file = fs::File::open(content_path).ok()?;
    let mut buf = [0u8; 4096];
    let n = file.read(&mut buf).ok()?;
    let head = std::str::from_utf8(&buf[..n]).ok()?;

    let mut lines = head.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut short: Option<String> = None;
    let mut long: Option<String> = None;
    for line in lines {
        let trimmed_end = line.trim_end();
        if trimmed_end == "---" || trimmed_end == "..." {
            break;
        }
        let is_top_level = !line.starts_with(|c: char| c.is_whitespace());
        let stripped = line.trim();

        // `short-description` is allowed at any indent so it resolves when
        // nested under `metadata:` (Codex's `.system` skills follow this).
        if short.is_none() {
            if let Some(rest) = stripped.strip_prefix("short-description:") {
                if let Some(val) = parse_frontmatter_scalar(rest) {
                    short = Some(val);
                    break;
                }
            }
        }
        // `description` is only honored at the top level to avoid colliding
        // with unrelated nested `description:` keys.
        if is_top_level && long.is_none() {
            if let Some(rest) = line.strip_prefix("description:") {
                if let Some(val) = parse_frontmatter_scalar(rest) {
                    long = Some(val);
                }
            }
        }
    }
    short.or(long)
}

/// Read a single-line YAML scalar (with optional matching quotes). Returns
/// `None` for empty values or block-scalar markers (`|` / `>`) we can't span.
fn parse_frontmatter_scalar(rest: &str) -> Option<String> {
    let val = rest.trim();
    if val.starts_with('|') || val.starts_with('>') {
        return None;
    }
    let unquoted = val
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .or_else(|| val.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
        .unwrap_or(val)
        .trim();
    if unquoted.is_empty() {
        None
    } else {
        Some(unquoted.to_string())
    }
}

fn build_skill_item(
    id: String,
    scope: AgentSkillScope,
    layout: AgentSkillLayout,
    path: PathBuf,
) -> AgentSkillItem {
    let description = read_skill_description(&skill_content_path(layout, &path));
    AgentSkillItem {
        name: skill_name_from_id(&id),
        id,
        scope,
        layout,
        path: path.to_string_lossy().to_string(),
        description,
        read_only: false,
    }
}

/// Codex ships a handful of built-in skills under `~/.codex/skills/.system/`
/// (imagegen, skill-creator, etc.). We scan that directory so users see
/// these in the `$` autocomplete and the Skills settings list — but any
/// write to those files would clobber the CLI's own assets.
fn is_read_only_skill_path(agent_type: AgentType, skill_path: &Path) -> bool {
    let ro_root = match agent_type {
        AgentType::Codex => codex_home_dir().join("skills").join(".system"),
        // Cursor's bundled builtin skills; the CLI restores them on update,
        // so editing/deleting through codeg would silently be undone.
        AgentType::Cursor => home_dir_or_default().join(".cursor").join("skills-cursor"),
        // `dsh-skill-filesystem` sets `skipSystem` on the `$DSH_HOME/skills`
        // root, so anything under `.system/` there belongs to the DeepSeek
        // Harness product CLI, not to the user — never write through it.
        AgentType::DeepSeek => crate::parsers::deepseek::resolve_dsh_home_dir()
            .join("skills")
            .join(".system"),
        _ => return false,
    };
    skill_path.starts_with(&ro_root)
}

fn skill_content_path(layout: AgentSkillLayout, skill_path: &Path) -> PathBuf {
    match layout {
        AgentSkillLayout::SkillDirectory => skill_path.join("SKILL.md"),
        AgentSkillLayout::MarkdownFile => skill_path.to_path_buf(),
    }
}

/// Symlink-safe removal: if `path` is a symlink (to a file or directory),
/// only the link itself is removed. Otherwise directories are removed
/// recursively and files are unlinked. This prevents `remove_dir_all` from
/// accidentally wiping the contents of a symlink target — which is critical
/// for the Experts feature where agent skill dirs may contain symlinks into
/// the central `~/.codeg/skills/` store.
pub(crate) fn remove_skill_entry(path: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(path)?;
    let file_type = meta.file_type();

    #[cfg(windows)]
    let is_reparse_point = {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    };

    if file_type.is_symlink() {
        #[cfg(windows)]
        {
            // Directory symlinks on Windows require remove_dir.
            return match fs::remove_file(path) {
                Ok(()) => Ok(()),
                Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                    fs::remove_dir(path)
                }
                Err(err) => Err(err),
            };
        }

        #[cfg(not(windows))]
        {
            return fs::remove_file(path);
        }
    }

    if file_type.is_dir() {
        #[cfg(windows)]
        {
            // Junctions are directory reparse points; remove only the link.
            if is_reparse_point {
                return fs::remove_dir(path);
            }
        }
        return fs::remove_dir_all(path);
    }

    fs::remove_file(path)
}

pub(crate) fn list_skills_from_dir(
    scope: AgentSkillScope,
    dir: &Path,
    kind: SkillStorageKind,
) -> Result<Vec<AgentSkillItem>, AcpError> {
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(dir)
        .map_err(|e| AcpError::protocol(format!("failed to read skills directory: {e}")))?;

    let mut by_id: BTreeMap<String, AgentSkillItem> = BTreeMap::new();
    for entry in entries {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => continue,
        };
        let path = entry.path();
        let file_name = entry.file_name();
        let id = file_name.to_string_lossy().to_string();

        if path.is_dir()
            && matches!(
                kind,
                SkillStorageKind::SkillDirectoryOnly
                    | SkillStorageKind::SkillDirectoryOrMarkdownFile
            )
        {
            let skill_doc = path.join("SKILL.md");
            if !skill_doc.is_file() {
                continue;
            }
            by_id.insert(
                id.clone(),
                build_skill_item(id, scope, AgentSkillLayout::SkillDirectory, path),
            );
            continue;
        }

        if path.is_file()
            && matches!(kind, SkillStorageKind::SkillDirectoryOrMarkdownFile)
            && is_markdown_file(&path)
        {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| id.clone());
            if by_id.contains_key(&stem) {
                continue;
            }
            by_id.insert(
                stem.clone(),
                build_skill_item(stem, scope, AgentSkillLayout::MarkdownFile, path),
            );
        }
    }

    Ok(by_id.into_values().collect())
}

fn locate_existing_skill(
    dir: &Path,
    kind: SkillStorageKind,
    skill_id: &str,
    scope: AgentSkillScope,
) -> Option<AgentSkillItem> {
    if matches!(
        kind,
        SkillStorageKind::SkillDirectoryOnly | SkillStorageKind::SkillDirectoryOrMarkdownFile
    ) {
        let skill_dir = dir.join(skill_id);
        if skill_dir.is_dir() && skill_dir.join("SKILL.md").is_file() {
            return Some(build_skill_item(
                skill_id.to_string(),
                scope,
                AgentSkillLayout::SkillDirectory,
                skill_dir,
            ));
        }
    }

    if matches!(kind, SkillStorageKind::SkillDirectoryOrMarkdownFile) {
        let file_path = dir.join(format!("{skill_id}.md"));
        if file_path.is_file() {
            return Some(build_skill_item(
                skill_id.to_string(),
                scope,
                AgentSkillLayout::MarkdownFile,
                file_path,
            ));
        }
    }

    None
}

pub(crate) fn locate_existing_skill_across_dirs(
    dirs: &[PathBuf],
    kind: SkillStorageKind,
    skill_id: &str,
    scope: AgentSkillScope,
) -> Option<AgentSkillItem> {
    for dir in dirs {
        if let Some(found) = locate_existing_skill(dir, kind, skill_id, scope) {
            return Some(found);
        }
    }
    None
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentRuntimeConfig {
    #[serde(default, alias = "api_base_url")]
    api_base_url: Option<String>,
    #[serde(default, alias = "api_key")]
    api_key: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default, deserialize_with = "deserialize_env_strings")]
    env: BTreeMap<String, String>,
}

/// Read an agent config's `env` map, skipping entries whose value is not a
/// string instead of failing the whole parse.
///
/// Both readers of this struct discard the ENTIRE local config on a parse error
/// (`build_runtime_env_from_setting` and the agent-info env projection), so one
/// odd value would silently cost the launch env its base URL and key too. The
/// value seen in the wild is `null` — written by an older
/// [`merge_json_values`], see [`patch_addition`] — but a hand-edited number or
/// bool deserves the same containment.
fn deserialize_env_strings<'de, D>(deserializer: D) -> Result<BTreeMap<String, String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = BTreeMap::<String, serde_json::Value>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|(key, value)| match value {
            serde_json::Value::String(value) => Some((key, value)),
            _ => None,
        })
        .collect())
}

fn trim_non_empty(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

// ---------------------------------------------------------------------------
// Cursor settings panel (cli-config.json + auth / models probes)
// ---------------------------------------------------------------------------

fn cursor_cli_config_path() -> PathBuf {
    crate::parsers::cursor::resolve_cursor_config_dir().join("cli-config.json")
}

fn load_cursor_cli_config_raw() -> Option<String> {
    fs::read_to_string(cursor_cli_config_path()).ok()
}

/// Project the structured controls out of a raw cli-config.json text.
/// Malformed JSON yields defaults (the panel shows the raw text separately).
pub(crate) fn parse_cursor_settings(raw: &str) -> crate::acp::types::CursorSettings {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) else {
        return crate::acp::types::CursorSettings::default();
    };
    let string_list = |val: Option<&serde_json::Value>| -> Vec<String> {
        val.and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|i| i.as_str())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    crate::acp::types::CursorSettings {
        sandbox_mode: v
            .pointer("/sandbox/mode")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        permissions_allow: string_list(v.pointer("/permissions/allow")),
        permissions_deny: string_list(v.pointer("/permissions/deny")),
    }
}

/// Merge the Cursor panel's structured controls into the raw cli-config.json
/// text. Only the managed keys are touched; every other key (editor prefs,
/// hints, network, …) is preserved verbatim. `None` fields leave their key
/// as-is; `Some` fields replace it (lists wholesale).
fn apply_cursor_structured_config(
    base: &str,
    patch: &crate::acp::types::CursorStructuredConfig,
) -> Result<String, AcpError> {
    let mut root: serde_json::Value = if base.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(base)
            .map_err(|e| AcpError::protocol(format!("invalid cursor cli-config.json: {e}")))?
    };
    if !root.is_object() {
        return Err(AcpError::protocol(
            "invalid cursor cli-config.json: root must be a JSON object",
        ));
    }
    let obj = root.as_object_mut().expect("checked object");

    // Drop the legacy `approvalMode` key an earlier panel version wrote: the
    // CLI never reads it from cli-config.json (approval mode lives in each
    // chat's store.db metadata, seeded by the `--force`/`--auto-review`
    // launch flags), so leaving it around only misleads whoever inspects the
    // file.
    obj.remove("approvalMode");
    if let Some(mode) = &patch.sandbox_mode {
        let sandbox = obj
            .entry("sandbox")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(sandbox_obj) = sandbox.as_object_mut() {
            if mode.trim().is_empty() {
                sandbox_obj.remove("mode");
            } else {
                sandbox_obj.insert("mode".into(), serde_json::Value::String(mode.clone()));
            }
        }
    }
    let mut set_rules = |key: &str, rules: &Option<Vec<String>>| {
        if let Some(rules) = rules {
            let permissions = obj
                .entry("permissions")
                .or_insert_with(|| serde_json::json!({}));
            if let Some(perm_obj) = permissions.as_object_mut() {
                let cleaned: Vec<serde_json::Value> = rules
                    .iter()
                    .map(|r| r.trim())
                    .filter(|r| !r.is_empty())
                    .map(|r| serde_json::Value::String(r.to_string()))
                    .collect();
                perm_obj.insert(key.to_string(), serde_json::Value::Array(cleaned));
            }
        }
    };
    set_rules("allow", &patch.permissions_allow);
    set_rules("deny", &patch.permissions_deny);

    serde_json::to_string_pretty(&root)
        .map_err(|e| AcpError::protocol(format!("serialize cursor cli-config failed: {e}")))
}

/// Validate + write cli-config.json (whole-document; the merge already
/// preserved unmanaged keys).
fn persist_cursor_cli_config(text: &str) -> Result<(), AcpError> {
    let parsed = serde_json::from_str::<serde_json::Value>(text)
        .map_err(|e| AcpError::protocol(format!("invalid cursor cli-config.json: {e}")))?;
    if !parsed.is_object() {
        return Err(AcpError::protocol(
            "invalid cursor cli-config.json: root must be a JSON object",
        ));
    }
    let path = cursor_cli_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create cursor config dir failed: {e}")))?;
    }
    fs::write(&path, format!("{text}\n"))
        .map_err(|e| AcpError::protocol(format!("write cursor cli-config failed: {e}")))
}

// ---------------------------------------------------------------------------
// Qoder settings.json helpers
// ---------------------------------------------------------------------------

/// Validate + write settings.json, whole-document.
///
/// The text is whatever the panel's advanced editor holds, which is the file as
/// codeg last read it plus the user's edits — writing it verbatim is what lets
/// a key be DELETED, which the generic merge-persist path cannot do.
///
/// Note this file has other writers (the Qoder CLI itself, and codeg's MCP
/// settings page, which owns the top-level `mcpServers`). A verbatim write
/// therefore reverts anything they wrote since the editor last loaded — the
/// same last-writer-wins contract every raw editor in this module has.
fn persist_qoder_settings(text: &str) -> Result<(), AcpError> {
    let parsed = serde_json::from_str::<serde_json::Value>(text)
        .map_err(|e| AcpError::protocol(format!("invalid qoder settings.json: {e}")))?;
    if !parsed.is_object() {
        return Err(AcpError::protocol(
            "invalid qoder settings.json: root must be a JSON object",
        ));
    }
    let path = qoder_settings_json_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AcpError::protocol(format!("create qoder config dir failed: {e}")))?;
    }
    fs::write(&path, format!("{text}\n"))
        .map_err(|e| AcpError::protocol(format!("write qoder settings failed: {e}")))
}

/// The `qoder` binary codeg would launch: managed cache first, then the user's
/// own install (PATH / ~/.local/bin) — the same order as `build_agent`.
fn resolve_qoder_binary() -> Option<PathBuf> {
    if let Ok(Some((path, _))) =
        binary_cache::find_best_cached_binary_for_agent(AgentType::Qoder, "qoder")
    {
        return Some(path);
    }
    resolve_system_agent_binary("qoder")
}

/// The Qoder agent's effective probe env: the saved env with the settings
/// form's live personal access token applied on top, so `status` reports on the
/// credential that is on screen rather than a stale saved one.
///
/// `PAT` is always materialized (empty when unset) so `run_qoder_probe` makes
/// an explicit set-or-remove decision — an inherited token from the user's dev
/// shell must not make the card claim an account that a launch would not use.
async fn qoder_probe_env(db: &AppDatabase, personal_access_token: Option<&str>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> =
        agent_setting_service::get_by_agent_type(&db.conn, AgentType::Qoder)
            .await
            .ok()
            .flatten()
            .and_then(|m| m.env_json)
            .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
            .unwrap_or_default();
    if let Some(token) = personal_access_token {
        env.insert(
            "QODER_PERSONAL_ACCESS_TOKEN".to_string(),
            token.trim().to_string(),
        );
    }
    env.entry("QODER_PERSONAL_ACCESS_TOKEN".to_string())
        .or_default();
    env
}

/// Run a `qoder` subcommand with a timeout, capturing stdout.
async fn run_qoder_probe(
    args: &[&str],
    timeout_secs: u64,
    extra_env: &BTreeMap<String, String>,
) -> Result<String, String> {
    let bin = resolve_qoder_binary().ok_or_else(|| "qoder is not installed".to_string())?;
    let mut cmd = crate::process::tokio_command(&bin);
    cmd.args(args);
    for (key, value) in extra_env {
        if value.trim().is_empty() {
            // This process's env is inherited by the child; an empty value means
            // "ensure absent" so a stale inherited token can't leak in.
            cmd.env_remove(key);
        } else {
            cmd.env(key, value);
        }
    }
    let output = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| format!("qoder {} timed out", args.join(" ")))?
        .map_err(|e| format!("failed to run qoder: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("qoder {} failed: {}", args.join(" "), stderr.trim()));
    }
    Ok(stdout)
}

/// Probe `qoder status -o json` for the Qoder settings panel's auth card.
///
/// The CLI prints one flat object — `{logged_in, version, allow_byok, username,
/// email, avatar_url, user_type}` — so unlike the Cursor probe there is no
/// nested `userInfo` to unwrap. A parse failure is reported as `error` with
/// `logged_in: false`; the panel renders that as "could not check", not as
/// "signed out", so a CLI output change never reads as a lost session.
pub(crate) async fn acp_qoder_auth_status_core(
    db: &AppDatabase,
    personal_access_token: Option<String>,
) -> crate::acp::types::QoderAuthStatus {
    let binary_path = resolve_qoder_binary().map(|p| p.to_string_lossy().to_string());
    if binary_path.is_none() {
        return crate::acp::types::QoderAuthStatus {
            installed: false,
            logged_in: false,
            username: None,
            email: None,
            user_type: None,
            version: None,
            allow_byok: None,
            error: None,
            binary_path: None,
        };
    }
    let extra_env = qoder_probe_env(db, personal_access_token.as_deref()).await;
    let failed = |error: Option<String>| crate::acp::types::QoderAuthStatus {
        installed: true,
        logged_in: false,
        username: None,
        email: None,
        user_type: None,
        version: None,
        allow_byok: None,
        error,
        binary_path: binary_path.clone(),
    };
    match run_qoder_probe(&["status", "-o", "json"], 30, &extra_env).await {
        Ok(stdout) => {
            // Scan to the first `{` so a leading log/update-notice line can't
            // break parsing.
            let json_start = stdout.find('{').unwrap_or(0);
            match serde_json::from_str::<serde_json::Value>(stdout[json_start..].trim()) {
                Ok(v) => {
                    let get_str = |key: &str| {
                        v.get(key)
                            .and_then(serde_json::Value::as_str)
                            .filter(|s| !s.is_empty())
                            .map(str::to_string)
                    };
                    crate::acp::types::QoderAuthStatus {
                        installed: true,
                        logged_in: v
                            .get("logged_in")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        username: get_str("username"),
                        email: get_str("email"),
                        user_type: get_str("user_type"),
                        version: get_str("version"),
                        // The CLI emits 0/1 here rather than a JSON boolean.
                        allow_byok: v
                            .get("allow_byok")
                            .and_then(|b| {
                                b.as_bool().or_else(|| b.as_i64().map(|n| n != 0))
                            }),
                        error: None,
                        binary_path: binary_path.clone(),
                    }
                }
                Err(e) => crate::acp::types::QoderAuthStatus {
                    error: Some(format!(
                        "unexpected status output: {e}: {}",
                        truncate_probe_output(&stdout)
                    )),
                    ..failed(None)
                },
            }
        }
        Err(err) => failed(Some(err)),
    }
}

/// The cursor-agent binary codeg would launch: managed cache first, then the
/// user's own install (PATH / ~/.local/bin) — the same order as `build_agent`.
fn resolve_cursor_binary() -> Option<PathBuf> {
    if let Ok(Some((path, _))) =
        binary_cache::find_best_cached_binary_for_agent(AgentType::Cursor, "cursor-agent")
    {
        return Some(path);
    }
    resolve_system_agent_binary("cursor-agent")
}

/// The Cursor agent's effective probe env: the saved env (env_json) with the
/// settings form's live API key applied on top, so `status` / `models` test
/// exactly the credential on screen rather than a stale saved value.
///
/// `api_key` is the form value — `Some(key)` in API-key mode, `Some("")` in
/// subscription mode to force (and verify) the browser-login credential.
/// `CURSOR_API_KEY` is always materialized (empty when unset) so
/// `run_cursor_probe` makes an explicit set-or-remove decision and a stale
/// inherited key can never leak in and produce a bogus "invalid API key".
/// `CURSOR_API_BASE_URL` is always cleared — the CLI has no custom-endpoint
/// support, so a base URL is never a valid probe input.
async fn cursor_probe_env(db: &AppDatabase, api_key: Option<&str>) -> BTreeMap<String, String> {
    let mut env: BTreeMap<String, String> =
        agent_setting_service::get_by_agent_type(&db.conn, AgentType::Cursor)
            .await
            .ok()
            .flatten()
            .and_then(|m| m.env_json)
            .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(&raw).ok())
            .unwrap_or_default();
    if let Some(key) = api_key {
        env.insert("CURSOR_API_KEY".to_string(), key.trim().to_string());
    }
    // Materialize the key so an unset one becomes an explicit empty ⇒ removed.
    env.entry("CURSOR_API_KEY".to_string()).or_default();
    // Scrub any stale base URL (legacy env_json row or inherited dev-shell
    // export): empty ⇒ removed by run_cursor_probe.
    env.insert("CURSOR_API_BASE_URL".to_string(), String::new());
    env
}

/// Run a cursor-agent subcommand with a timeout, capturing stdout.
async fn run_cursor_probe(
    args: &[&str],
    timeout_secs: u64,
    extra_env: &BTreeMap<String, String>,
) -> Result<String, String> {
    let bin = resolve_cursor_binary().ok_or_else(|| "cursor-agent is not installed".to_string())?;
    let mut cmd = crate::process::tokio_command(&bin);
    cmd.args(args);
    for (key, value) in extra_env {
        if value.trim().is_empty() {
            // This process's env is inherited by the child; an empty value means
            // "ensure absent" so a stale inherited CURSOR_API_KEY can't leak in.
            cmd.env_remove(key);
        } else {
            cmd.env(key, value);
        }
    }
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        cmd.output(),
    )
    .await
    .map_err(|_| format!("cursor-agent {} timed out", args.join(" ")))?
    .map_err(|e| format!("failed to run cursor-agent: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "cursor-agent {} failed: {}",
            args.join(" "),
            stderr.trim()
        ));
    }
    Ok(stdout)
}

/// The exact phrase `cursor-agent status` prints when it HAS a stored login but
/// could not use it: `gatherStatusInfo` calls `getMe` with the access token and
/// falls into this branch when that call throws, while still reporting
/// `isAuthenticated: true` (it decides that from token presence alone, never
/// from the token's `exp`).
///
/// Matched as a literal because it is one: the CLI emits these strings in
/// English regardless of locale, and they are what carries the difference
/// between "signed in" and "signed in with a credential that no longer works".
const CURSOR_STATUS_UNVERIFIED_MARKER: &str = "unable to fetch user details";

/// Whether the login `cursor-agent status` reports actually worked against
/// Cursor's backend — see [`crate::acp::types::CursorAuthStatus::credential_verified`]
/// for why the two are not the same question.
///
/// Deliberately conservative: only the CLI's own "I could not reach the
/// backend with this token" branch counts as unverified. Every other shape —
/// user details present, details missing for some other reason, a field we do
/// not recognize — is left as verified, so an unfamiliar status output cannot
/// invent a login problem the user does not have.
fn cursor_credential_verified(status: &serde_json::Value) -> Option<bool> {
    let authenticated = status
        .get("isAuthenticated")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    if !authenticated {
        // Nothing to verify: the panel already renders this as "not signed in".
        return None;
    }
    let message = status
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    Some(!message.contains(CURSOR_STATUS_UNVERIFIED_MARKER))
}

pub(crate) async fn acp_cursor_auth_status_core(
    db: &AppDatabase,
    api_key: Option<String>,
) -> crate::acp::types::CursorAuthStatus {
    let binary_path = resolve_cursor_binary().map(|p| p.to_string_lossy().to_string());
    if binary_path.is_none() {
        return crate::acp::types::CursorAuthStatus {
            installed: false,
            is_authenticated: false,
            raw_status: None,
            email: None,
            membership: None,
            error: None,
            binary_path: None,
            credential_verified: None,
        };
    }
    let extra_env = cursor_probe_env(db, api_key.as_deref()).await;
    match run_cursor_probe(&["status", "--format", "json"], 20, &extra_env).await {
        Ok(stdout) => {
            // The CLI prints one JSON object; scan to the first `{` so a
            // leading log line can't break parsing.
            let json_start = stdout.find('{').unwrap_or(0);
            match serde_json::from_str::<serde_json::Value>(stdout[json_start..].trim()) {
                Ok(v) => {
                    let get_str = |keys: &[&str]| {
                        keys.iter().find_map(|k| {
                            v.get(*k)
                                .and_then(serde_json::Value::as_str)
                                .filter(|s| !s.is_empty())
                                .map(str::to_string)
                        })
                    };
                    // Email is nested under `userInfo` in current CLI output;
                    // fall back to a top-level field for forward-compatibility.
                    let email = v
                        .get("userInfo")
                        .and_then(|u| u.get("email"))
                        .and_then(serde_json::Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                        .or_else(|| get_str(&["email", "userEmail", "user_email"]));
                    crate::acp::types::CursorAuthStatus {
                        installed: true,
                        is_authenticated: v
                            .get("isAuthenticated")
                            .and_then(serde_json::Value::as_bool)
                            .unwrap_or(false),
                        raw_status: get_str(&["status", "message"]),
                        email,
                        membership: get_str(&["membershipType", "membership", "plan"]),
                        error: None,
                        binary_path: binary_path.clone(),
                        credential_verified: cursor_credential_verified(&v),
                    }
                }
                Err(e) => crate::acp::types::CursorAuthStatus {
                    installed: true,
                    is_authenticated: false,
                    raw_status: Some(truncate_probe_output(&stdout)),
                    email: None,
                    membership: None,
                    error: Some(format!("unexpected status output: {e}")),
                    binary_path: binary_path.clone(),
                    credential_verified: None,
                },
            }
        }
        Err(err) => crate::acp::types::CursorAuthStatus {
            installed: true,
            is_authenticated: false,
            raw_status: None,
            email: None,
            membership: None,
            error: Some(err),
            binary_path,
            credential_verified: None,
        },
    }
}

pub(crate) async fn acp_cursor_list_models_core(
    db: &AppDatabase,
    api_key: Option<String>,
) -> crate::acp::types::CursorModelsResult {
    let extra_env = cursor_probe_env(db, api_key.as_deref()).await;
    match run_cursor_probe(&["models"], 30, &extra_env).await {
        Ok(stdout) => {
            let (models, default_model) = parse_cursor_models(&stdout);
            crate::acp::types::CursorModelsResult {
                models,
                default_model,
                error: None,
            }
        }
        Err(err) => crate::acp::types::CursorModelsResult {
            models: Vec::new(),
            default_model: None,
            error: Some(err),
        },
    }
}

/// Parse `cursor-agent models` output. Each model line is
/// `<id> - <label> [(default)]` (e.g. `claude-opus-4-8-high - Opus 4.8 1M`,
/// `auto - Auto (default)`); a leading `Available models` header and blank
/// lines are skipped. Returns the entries in CLI order plus the default id.
fn parse_cursor_models(stdout: &str) -> (Vec<crate::acp::types::CursorModelInfo>, Option<String>) {
    let mut models: Vec<crate::acp::types::CursorModelInfo> = Vec::new();
    let mut default_model = None;
    for line in stdout.lines() {
        let cleaned = strip_ansi(line);
        let trimmed = cleaned.trim();
        if trimmed.is_empty() {
            continue;
        }
        // Split id from label on the first " - ". A line with no " - " is only
        // a model if it's a bare single-token id — otherwise it's prose (the
        // "Available models" header has a space, so it's skipped below).
        let (id_raw, label_raw) = trimmed.split_once(" - ").unwrap_or((trimmed, ""));
        let id = id_raw
            .trim()
            .trim_start_matches(['-', '*', '\u{2022}'])
            .trim();
        if id.is_empty() || id.contains(char::is_whitespace) {
            continue;
        }
        let is_default = label_raw.contains("(default)") || label_raw.contains("(current)");
        let label = label_raw
            .replace("(default)", "")
            .replace("(current)", "")
            .trim()
            .to_string();
        if is_default {
            default_model = Some(id.to_string());
        }
        if !models.iter().any(|m| m.id == id) {
            models.push(crate::acp::types::CursorModelInfo {
                id: id.to_string(),
                label,
                is_default,
            });
        }
    }
    (models, default_model)
}

/// Strip ANSI SGR escape sequences from CLI output.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for esc in chars.by_ref() {
                    if esc.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn truncate_probe_output(s: &str) -> String {
    let t = s.trim();
    if t.len() > 400 {
        format!("{}…", &t[..t.char_indices().take_while(|(i, _)| *i < 400).last().map(|(i, c)| i + c.len_utf8()).unwrap_or(400)])
    } else {
        t.to_string()
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_cursor_auth_status(
    db: State<'_, AppDatabase>,
    api_key: Option<String>,
) -> Result<crate::acp::types::CursorAuthStatus, AcpError> {
    Ok(acp_cursor_auth_status_core(&db, api_key).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_qoder_auth_status(
    db: State<'_, AppDatabase>,
    personal_access_token: Option<String>,
) -> Result<crate::acp::types::QoderAuthStatus, AcpError> {
    Ok(acp_qoder_auth_status_core(&db, personal_access_token).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_cursor_list_models(
    db: State<'_, AppDatabase>,
    api_key: Option<String>,
) -> Result<crate::acp::types::CursorModelsResult, AcpError> {
    Ok(acp_cursor_list_models_core(&db, api_key).await)
}

/// Primary env var keys for each agent type: (api_base_url, api_key, model).
/// Shared by runtime env resolution, model-provider cascade, and config patching.
fn agent_env_keys(agent_type: AgentType) -> (&'static str, &'static str, &'static str) {
    match agent_type {
        AgentType::ClaudeCode => (
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_MODEL",
        ),
        AgentType::Gemini => ("GOOGLE_GEMINI_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL"),
        // Kimi Code does NOT read shell KIMI_API_KEY/OPENAI_API_KEY; the only
        // non-interactive credential path is the `KIMI_MODEL_*` family, which
        // also takes priority over `~/.kimi-code/config.toml`.
        AgentType::KimiCode => ("KIMI_MODEL_BASE_URL", "KIMI_MODEL_API_KEY", "KIMI_MODEL_NAME"),
        // Grok's non-interactive credential is `XAI_API_KEY`. Model + endpoint
        // also have working env overrides (verified against the 0.2.94 binary):
        // `GROK_DEFAULT_MODEL` selects the default model and `GROK_XAI_API_BASE_URL`
        // overrides the API base URL (both win over ~/.grok/config.toml). Note:
        // `XAI_MODEL` is NOT read by Grok — the earlier placeholder was inert.
        AgentType::Grok => ("GROK_XAI_API_BASE_URL", "XAI_API_KEY", "GROK_DEFAULT_MODEL"),
        // Cursor's non-interactive credential is `CURSOR_API_KEY` (an
        // alternative to `cursor-agent login`); `CURSOR_API_BASE_URL` is the
        // endpoint override (both verified against the 2026.07.16 CLI bundle).
        // The CLI reads NO model env var — `CURSOR_MODEL` is an inert
        // placeholder so the generic cascade never lands on OPENAI_* keys;
        // model selection flows through the Cursor panel / ACP instead.
        AgentType::Cursor => ("CURSOR_API_BASE_URL", "CURSOR_API_KEY", "CURSOR_MODEL"),
        // The real endpoint knob is `DEEPSEEK_BASE_URL`, read by the
        // `llm-deepseek` adapter through the launch-environment snapshot —
        // which, when the host installs none (deepseek-acp does not), falls
        // back to `process.env`, so codeg's launch env reaches it. It resolves
        // per request (`config.baseURL ?? env ?? https://api.deepseek.com`),
        // NOT at load. `DEEPSEEK_ACP_PROVIDER` is a different thing entirely —
        // the provider ROUTE id (`deepseek-official`), a registry key rather
        // than a URL — so it must not ride the base-url slot, or binding a
        // model provider would write an endpoint into the route selector and
        // break every request. All three keep the generic cascade off the
        // OPENAI_* keys.
        AgentType::DeepSeek => (
            "DEEPSEEK_BASE_URL",
            "DEEPSEEK_API_KEY",
            "DEEPSEEK_ACP_MODEL",
        ),
        // Qoder's non-interactive credential is `QODER_PERSONAL_ACCESS_TOKEN`
        // — "设置后自动使用 PAT 认证" in the 1.1.23 package's own README, and the
        // only way to authenticate a headless/server/Docker install, where the
        // `qoder login` browser flow cannot run. (An interactive login still
        // outranks it; the credential itself lives in the machine key store.)
        // `QODER_MODEL` is real too — the README lists it as the env twin of
        // `-m/--model`. There is NO endpoint override, so the base-url slot
        // stays an inert `QODER_BASE_URL` placeholder for the same reason
        // `CURSOR_MODEL` above is one: it keeps the generic cascade off the
        // OPENAI_* keys. `QODER_API_KEY` was never a thing Qoder reads.
        AgentType::Qoder => (
            "QODER_BASE_URL",
            "QODER_PERSONAL_ACCESS_TOKEN",
            "QODER_MODEL",
        ),
        // Antigravity's credential depends on the auth method the settings
        // panel picked, and the panel writes the right one directly; the slot
        // named here is the Gemini Developer API key, which is what
        // `auth.type = "gemini-api-key"` reads (the server says so in its own
        // `auth_required` message). `AGY_ACP_DEFAULT_MODEL` is real — it is
        // the env the server's `get_default_model_id` consults before falling
        // back to `gemini-3.7-flash-high`. There is NO endpoint override, so
        // the base-url slot stays an inert `AGY_BASE_URL` placeholder for the
        // same reason `CURSOR_MODEL`/`QODER_BASE_URL` above are: it keeps the
        // generic cascade off the `OPENAI_*` keys.
        AgentType::Antigravity => (
            "AGY_BASE_URL",
            "GEMINI_API_KEY",
            "AGY_ACP_DEFAULT_MODEL",
        ),
        // `CLINE_API_KEY` is not just a convenience: it is one of only two ways
        // past cline's ACP auth gate (`isSessionReady`), and the only one a BYO
        // provider can take — see [`apply_cline_launch_env`]. `CLINE_MODEL`
        // is the CLI's own model env twin. There is NO endpoint override:
        // `CLINE_API_BASE_URL` is cline's ACCOUNT service URL, not the LLM's, so
        // routing a base URL there would break the account API while still
        // sending inference to the wrong host. The base-url slot is therefore an
        // inert `CLINE_BASE_URL` placeholder (verified unread by the 3.0.62
        // binary), for the same reason `CURSOR_MODEL`/`QODER_BASE_URL` are: it
        // keeps the generic cascade off the `OPENAI_*` keys. The LLM endpoint
        // travels in `providers.json` instead (`persist_cline_local_config`).
        AgentType::Cline => ("CLINE_BASE_URL", "CLINE_API_KEY", "CLINE_MODEL"),
        _ => ("OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL"),
    }
}

/// Launch-env keys that let a BYO provider past cline's ACP auth gate.
///
/// THE BUG THIS FIXES. cline 3.x refuses `session/new` with
/// `Authentication required: Call authenticate before starting a session`
/// unless one of two things holds:
///
///   1. `process.env.CLINE_API_KEY` is non-empty, or
///   2. `tryRestoreAuth()` finds credentials for one of exactly THREE auth
///      methods — `cline`, `cline-pass`, `openai-codex` (the `authMethods` the
///      agent advertises at `initialize`).
///
/// Every BYO provider — anthropic, openai-native, openai-compatible, deepseek,
/// … — fails (2) no matter how completely it is configured, because
/// `tryRestoreAuth` never looks at it. So configuring a provider and nothing
/// else produced a session that could never start, whichever provider was
/// picked. Route (1) is the only door, and it needs company: with
/// `CLINE_API_KEY` alone the gate opens but `newSession` resolves the provider
/// as `process.env.CLINE_PROVIDER ?? authResult?.providerId ?? "cline"` — and
/// `authResult` is still unset precisely because the key short-circuited the
/// gate — so the turn would run against Cline's own billing instead of the
/// user's endpoint. Hence provider + key together; `CLINE_MODEL` then picks the
/// session's default model out of that provider's catalogue.
///
/// Does nothing when codeg has no usable credential for the agent, which leaves
/// `tryRestoreAuth` free to find a `cline auth` login — a user signed in to
/// Cline's own service must not be forced onto a half-filled BYO panel.
///
/// `CLINE_API_KEY` / `CLINE_MODEL` normally arrive from the generic trio in
/// [`build_runtime_env_from_setting`] (see [`agent_env_keys`]); this only fills
/// what is still missing, so an explicit `env_json` row keeps winning.
fn apply_cline_launch_env(config_json: Option<&str>, merged: &mut BTreeMap<String, String>) {
    let Some(config) = config_json.and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
    else {
        return;
    };
    let provider = normalize_cline_provider_id(
        config
            .get("apiProvider")
            .and_then(|v| v.as_str())
            .unwrap_or_default(),
    );

    // A sign-in provider must be left to `tryRestoreAuth`, and either half of
    // the pair in the way breaks it:
    //
    //   * a non-empty `CLINE_API_KEY` SHORT-CIRCUITS the gate without
    //     populating `authResult`, so `newSession` resolves
    //     `CLINE_PROVIDER ?? authResult?.providerId ?? "cline"` and a ClinePass
    //     or ChatGPT account silently runs as plain Cline billing;
    //   * a stale `CLINE_PROVIDER` — an `env_json` row, or one exported in the
    //     shell codeg was launched from — overrides the account entirely and
    //     freezes a selector these three are entitled to use.
    //
    // Both are cleared by writing an EMPTY value, which the spawn layer turns
    // into `env_remove` (see the codeg convention in `acp::agent_process`) — so
    // this strips an inherited value rather than merely declining to add one.
    // Removal, not `""`, is what the agent needs: `??` does not fall through on
    // an empty string, so an actually-empty `CLINE_PROVIDER` would become the
    // provider id. Mirrors Cursor/Grok subscription mode.
    //
    // Re-applied after every later env overlay (see `build_session_runtime_env`),
    // because a model-provider binding writes the same two keys.
    if cline_provider_is_agent_managed(&provider) {
        merged.insert("CLINE_API_KEY".to_string(), String::new());
        merged.insert("CLINE_PROVIDER".to_string(), String::new());
        return;
    }

    if !merged.contains_key("CLINE_API_KEY") {
        // Local providers authenticate with no key at all, but the gate only
        // tests `CLINE_API_KEY` for emptiness — it never validates it, and
        // `buildConfig` hands it to a local endpoint that ignores it. A
        // placeholder is what makes ollama/LM Studio reachable over ACP.
        if !cline_provider_is_keyless(&provider) {
            return;
        }
        merged.insert("CLINE_API_KEY".to_string(), "local".to_string());
    }

    merged
        .entry("CLINE_PROVIDER".to_string())
        .or_insert(provider);
}

/// Serialize a BTreeMap into env_json for database storage.
/// Returns `None` when the map is empty.
fn serialize_env_map(env: &BTreeMap<String, String>) -> Result<Option<String>, AcpError> {
    if env.is_empty() {
        Ok(None)
    } else {
        serde_json::to_string(env)
            .map(Some)
            .map_err(|e| AcpError::protocol(e.to_string()))
    }
}

pub(crate) fn build_runtime_env_from_setting(
    agent_type: AgentType,
    setting: Option<&crate::db::entities::agent_setting::Model>,
    local_config_json: Option<&str>,
) -> BTreeMap<String, String> {
    let mut merged = setting
        .and_then(|model| model.env_json.as_deref())
        .and_then(|raw| serde_json::from_str::<BTreeMap<String, String>>(raw).ok())
        .unwrap_or_default();

    let Some(raw_config_json) = local_config_json else {
        return merged;
    };
    let Ok(config) = serde_json::from_str::<AgentRuntimeConfig>(raw_config_json) else {
        return merged;
    };

    for (key, value) in config.env {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        merged.insert(key, trimmed.to_string());
    }

    let (api_base_url_key, api_key_key, model_key) = agent_env_keys(agent_type);
    if let Some(value) = trim_non_empty(config.api_base_url) {
        merged.insert(api_base_url_key.to_string(), value);
    }
    if let Some(value) = trim_non_empty(config.api_key) {
        merged.insert(api_key_key.to_string(), value);
    }
    if agent_type != AgentType::ClaudeCode {
        if let Some(value) = trim_non_empty(config.model) {
            merged.insert(model_key.to_string(), value);
        }
    }

    // Cline needs one key the generic trio has no slot for — the provider id —
    // and without it the launch env cannot clear the agent's auth gate.
    if agent_type == AgentType::Cline {
        apply_cline_launch_env(Some(raw_config_json), &mut merged);
    }

    merged
}

/// Resolve model provider credentials into runtime env vars if `model_provider_id` is set.
pub(crate) async fn apply_model_provider_env(
    agent_type: AgentType,
    setting: Option<&crate::db::entities::agent_setting::Model>,
    runtime_env: &mut BTreeMap<String, String>,
    conn: &sea_orm::DatabaseConnection,
) {
    let provider_id = match setting.and_then(|s| s.model_provider_id) {
        Some(id) => id,
        None => return,
    };
    let provider = match model_provider_service::get_by_id(conn, provider_id).await {
        Ok(Some(p)) => p,
        _ => return,
    };
    let (url_key, key_key, _) = agent_env_keys(agent_type);
    if !provider.api_url.trim().is_empty() {
        runtime_env.insert(url_key.to_string(), provider.api_url.clone());
    }
    if !provider.api_key.trim().is_empty() {
        runtime_env.insert(key_key.to_string(), provider.api_key.clone());
    }
}

/// Claude Code provider-model JSON keys → ANTHROPIC_*_MODEL env var names.
const CLAUDE_MODEL_KEY_MAP: &[(&str, &str)] = &[
    ("main", "ANTHROPIC_MODEL"),
    ("reasoning", "ANTHROPIC_REASONING_MODEL"),
    ("haiku", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("sonnet", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("opus", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    // The custom model option trio appends one entry to the in-session /model
    // picker (a model the provider's gateway serves). Carried by the provider's
    // model JSON like the five model fields, so binding/cascade pushes it too.
    ("customOption", "ANTHROPIC_CUSTOM_MODEL_OPTION"),
    ("customOptionName", "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
    (
        "customOptionDescription",
        "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
    ),
];

/// Parse the model field stored on a model_provider into the env-var actions to
/// apply on the dependent agent's `env_json` / local config file.
///
/// The provider's model field is authoritative: every env key relevant to the
/// agent type is returned, with `Some(value)` meaning "set" and `None` meaning
/// "clear". This lets the caller overwrite even when the provider's value is
/// empty.
///
/// - Claude: returns one entry per `CLAUDE_MODEL_KEY_MAP` row — the five
///   ANTHROPIC_*_MODEL fields plus the ANTHROPIC_CUSTOM_MODEL_OPTION trio. Each
///   entry is `None` when the provider's JSON omits that key or has an empty
///   value.
/// - Gemini: returns `GEMINI_MODEL`.
/// - DeepSeek: returns `DEEPSEEK_ACP_MODEL`.
/// - Codex: returns `OPENAI_MODEL` so the provider can override env_json (the
///   root `model` in `config.toml` is handled separately by
///   `provider_codex_model_action`).
/// - Others: returns `OPENAI_MODEL`.
pub(crate) fn parse_provider_model(
    agent_type: AgentType,
    raw: Option<&str>,
) -> BTreeMap<String, Option<String>> {
    let mut out: BTreeMap<String, Option<String>> = BTreeMap::new();
    let trimmed_raw = raw.map(str::trim).filter(|s| !s.is_empty());
    match agent_type {
        AgentType::ClaudeCode => {
            let parsed = trimmed_raw
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
                .and_then(|v| v.as_object().cloned());
            for (key, env_name) in CLAUDE_MODEL_KEY_MAP {
                let value = parsed
                    .as_ref()
                    .and_then(|obj| obj.get(*key))
                    .and_then(|x| x.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string);
                out.insert((*env_name).to_string(), value);
            }
        }
        AgentType::Gemini => {
            out.insert("GEMINI_MODEL".to_string(), trimmed_raw.map(str::to_string));
        }
        // Kimi reads its model name from KIMI_MODEL_NAME (the `KIMI_MODEL_*`
        // family), not OPENAI_MODEL — see `agent_env_keys`.
        AgentType::KimiCode => {
            out.insert(
                "KIMI_MODEL_NAME".to_string(),
                trimmed_raw.map(str::to_string),
            );
        }
        // deepseek-acp's launcher reads DEEPSEEK_ACP_MODEL (`readEnv`) and
        // nothing else; leaving this on the OPENAI_MODEL fallback would apply
        // a bound provider's URL and key while silently dropping its model.
        AgentType::DeepSeek => {
            out.insert(
                "DEEPSEEK_ACP_MODEL".to_string(),
                trimmed_raw.map(str::to_string),
            );
        }
        AgentType::Codex => {
            // The provider stores a structured model config (JSON) or a legacy
            // plain slug; OPENAI_MODEL is the default slug either way.
            let slug = crate::acp::codex_model_catalog::default_slug_for_env(
                &crate::acp::codex_model_catalog::parse_model_config(trimmed_raw),
            );
            out.insert("OPENAI_MODEL".to_string(), slug);
        }
        _ => {
            out.insert("OPENAI_MODEL".to_string(), trimmed_raw.map(str::to_string));
        }
    }
    out
}

/// Action to apply to the Codex `config.toml` root `model` key.
pub(crate) enum CodexModelAction {
    /// Not a Codex agent — leave the toml untouched.
    NoOp,
    /// Set the `model` key to this value.
    Set(String),
    /// Remove the `model` key.
    Clear,
}

pub(crate) fn provider_codex_model_action(
    agent_type: AgentType,
    raw: Option<&str>,
) -> CodexModelAction {
    if agent_type != AgentType::Codex {
        return CodexModelAction::NoOp;
    }
    // Structured config (JSON) or legacy plain slug → root `model` = default slug.
    match crate::acp::codex_model_catalog::default_slug_for_env(
        &crate::acp::codex_model_catalog::parse_model_config(raw),
    ) {
        Some(slug) => CodexModelAction::Set(slug),
        None => CodexModelAction::Clear,
    }
}

/// Update on-disk config files for a single agent when model provider credentials change.
/// Uses `agent_env_keys` to determine the correct env var names per agent type.
///
/// For `model_env`: entries with `Some(value)` are written; entries with `None`
/// are explicitly cleared (overwritten with empty string in the env-patch, so
/// `persist_agent_local_config_json` removes them).
fn cascade_update_agent_config(
    agent_type: AgentType,
    api_url: &str,
    api_key: &str,
    model_env: &BTreeMap<String, Option<String>>,
    codex_model: &CodexModelAction,
    codex_model_raw: Option<&str>,
) -> Result<(), AcpError> {
    let (url_key, key_key, _) = agent_env_keys(agent_type);
    match agent_type {
        AgentType::ClaudeCode | AgentType::Gemini => {
            // Write into config.env (not root-level). For model entries, use
            // JSON-null for "clear" — `merge_json_values` interprets null as
            // "remove this key".
            let mut env = serde_json::Map::new();
            env.insert(
                url_key.to_string(),
                serde_json::Value::String(api_url.to_string()),
            );
            env.insert(
                key_key.to_string(),
                serde_json::Value::String(api_key.to_string()),
            );
            for (k, v) in model_env {
                let value = match v {
                    Some(s) => serde_json::Value::String(s.clone()),
                    None => serde_json::Value::Null,
                };
                env.insert(k.clone(), value);
            }
            let patch = serde_json::json!({ "env": env });
            let patch_str =
                serde_json::to_string(&patch).map_err(|e| AcpError::protocol(e.to_string()))?;
            persist_agent_local_config_json(agent_type, Some(&patch_str))?;
        }
        AgentType::OpenClaw => {
            // agent_local_config_path returns None for OpenClaw — no-op
        }
        AgentType::Hermes => {
            // Hermes self-manages credentials in ~/.hermes/.env via
            // `hermes model` / `hermes setup`; codeg writes no provider creds.
        }
        AgentType::Cursor => {
            // Cursor authenticates via `cursor-agent login` or CURSOR_API_KEY
            // against Cursor's own backend; there is no third-party
            // model-provider endpoint to cascade into.
        }
        AgentType::Codex => {
            let auth_path = codex_auth_json_path();
            let mut auth_obj = if auth_path.exists() {
                fs::read_to_string(&auth_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .filter(|v| v.is_object())
                    .unwrap_or_else(|| serde_json::json!({}))
            } else {
                serde_json::json!({})
            };
            if !api_key.trim().is_empty() {
                auth_obj[key_key] = serde_json::Value::String(api_key.to_string());
            }
            let auth_str = serde_json::to_string_pretty(&auth_obj)
                .map_err(|e| AcpError::protocol(e.to_string()))?;

            let config_path = codex_config_toml_path();
            let mut toml_value = if config_path.exists() {
                fs::read_to_string(&config_path)
                    .ok()
                    .and_then(|raw| raw.parse::<toml::Value>().ok())
                    .filter(|v| v.is_table())
                    .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()))
            } else {
                toml::Value::Table(toml::map::Map::new())
            };
            let table = toml_value
                .as_table_mut()
                .ok_or_else(|| AcpError::protocol("codex config root must be a TOML table"))?;
            table.remove("api_base_url");

            let provider_name = table
                .get("model_provider")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| "codeg".to_string());
            table.insert(
                "model_provider".to_string(),
                toml::Value::String(provider_name.clone()),
            );

            let providers_item = table
                .entry("model_providers".to_string())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if !providers_item.is_table() {
                *providers_item = toml::Value::Table(toml::map::Map::new());
            }
            let providers = providers_item
                .as_table_mut()
                .ok_or_else(|| AcpError::protocol("invalid model_providers table"))?;
            let provider_item = providers
                .entry(provider_name.clone())
                .or_insert_with(|| toml::Value::Table(toml::map::Map::new()));
            if !provider_item.is_table() {
                *provider_item = toml::Value::Table(toml::map::Map::new());
            }
            let provider_table = provider_item
                .as_table_mut()
                .ok_or_else(|| AcpError::protocol("invalid model provider table"))?;
            if api_url.trim().is_empty() {
                provider_table.remove("base_url");
            } else {
                provider_table.insert(
                    "base_url".to_string(),
                    toml::Value::String(api_url.to_string()),
                );
            }
            if provider_name == "codeg" {
                provider_table.insert("name".to_string(), toml::Value::String("codeg".to_string()));
                provider_table.insert(
                    "wire_api".to_string(),
                    toml::Value::String("responses".to_string()),
                );
                ensure_codex_provider_auth_default(provider_table);
            }
            match codex_model {
                CodexModelAction::Set(model) => {
                    table.insert("model".to_string(), toml::Value::String(model.to_string()));
                }
                CodexModelAction::Clear => {
                    table.remove("model");
                }
                CodexModelAction::NoOp => {}
            }
            // Regenerate the model_catalog_json file from the provider's full
            // structured model config and reference it (relative to CODEX_HOME).
            // REPLACE semantics require rewriting the whole catalog every time.
            let snapshot = crate::acp::codex_catalog_source::cached_or_bundled_snapshot();
            match crate::acp::codex_model_catalog::write_catalog_files(
                codex_model_raw.unwrap_or_default(),
                &codex_home_dir(),
                &snapshot,
            ) {
                Ok(Some(inj)) => {
                    table.insert(
                        "model_catalog_json".to_string(),
                        toml::Value::String(inj.catalog_rel.to_string()),
                    );
                }
                Ok(None) => {
                    table.remove("model_catalog_json");
                }
                Err(e) => {
                    tracing::warn!("[ModelProvider] write codex catalog failed: {e}");
                }
            }
            let toml_str = toml::to_string_pretty(&toml_value)
                .map_err(|e| AcpError::protocol(e.to_string()))?;

            persist_codex_native_config_files(Some(&auth_str), Some(&toml_str))?;
        }
        AgentType::OpenCode => {
            let auth_path = opencode_auth_json_path();
            let mut auth_obj = if auth_path.exists() {
                fs::read_to_string(&auth_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                    .filter(|v| v.is_object())
                    .unwrap_or_else(|| serde_json::json!({}))
            } else {
                serde_json::json!({})
            };
            if !api_key.trim().is_empty() {
                auth_obj["api_key"] = serde_json::Value::String(api_key.to_string());
            }
            let auth_str = serde_json::to_string_pretty(&auth_obj)
                .map_err(|e| AcpError::protocol(e.to_string()))?;
            persist_opencode_auth_json(&auth_str)?;

            let patch = serde_json::json!({ "apiBaseUrl": api_url });
            let patch_str =
                serde_json::to_string(&patch).map_err(|e| AcpError::protocol(e.to_string()))?;
            persist_agent_local_config_json(agent_type, Some(&patch_str))?;
        }
        AgentType::Cline => {}
        AgentType::CodeBuddy => {
            // CodeBuddy authenticates via env vars (CODEBUDDY_API_KEY /
            // CODEBUDDY_INTERNET_ENVIRONMENT) managed by its dedicated settings
            // panel through `acpUpdateAgentEnv`; it does not participate in the
            // model-provider credential cascade.
        }
        AgentType::KimiCode => {
            // Kimi Code authenticates via the `KIMI_MODEL_*` env family
            // (KIMI_MODEL_API_KEY / KIMI_MODEL_BASE_URL / KIMI_MODEL_NAME)
            // managed by its dedicated settings panel through `acpUpdateAgentEnv`;
            // it does not participate in the model-provider credential cascade.
        }
        AgentType::Pi => {
            // Pi authenticates via its own `~/.pi/agent/auth.json` + model
            // selection in `~/.pi/agent/settings.json`, managed by the dedicated
            // Pi settings panel (`acp_update_pi_config`); it does not participate
            // in the model-provider credential cascade.
        }
        AgentType::Grok => {
            // Grok authenticates via `XAI_API_KEY` (or an interactive
            // `grok login` session stored in ~/.grok/auth.json), injected as a
            // runtime env var through the generic agent settings panel
            // (`acpUpdateAgentEnv`); it does not write provider creds into
            // ~/.grok/config.toml and does not participate in the cascade.
        }
        AgentType::DeepSeek => {
            // deepseek-acp authenticates via `DEEPSEEK_API_KEY` (or
            // `~/.dsh/.credentials.yaml`, which codeg never writes), injected
            // as a runtime env var through the generic agent settings panel;
            // it has no codeg-managed config file and does not participate in
            // the model-provider credential cascade.
        }
        AgentType::Qoder => {
            // Qoder talks only to Qoder's own service — no endpoint override
            // and no BYO-provider key — so it stays off the model-provider
            // credential cascade even though its env slots are real. The PAT
            // (`QODER_PERSONAL_ACCESS_TOKEN`) is set directly in the agent's
            // env, and while codeg DOES manage a Qoder config file
            // (`settings.json`, via the Qoder settings panel), that file holds
            // no credentials for the cascade to reconcile.
        }
        AgentType::Antigravity => {
            // Antigravity only ever talks to Google's own endpoints (CCPA for
            // the consumer path, BAIC for Gemini Enterprise, the Gemini
            // Developer API for a raw key), none of which accepts a custom
            // base URL — so it stays off the model-provider credential
            // cascade. Its credentials come from the auth method the settings
            // panel recorded, which the launch path projects into the process
            // env and into `antigravity-acp/settings.json` (see
            // `sync_antigravity_settings_file`); that file carries the chosen
            // METHOD, never a credential, so there is nothing here to
            // reconcile either.
        }
        AgentType::Custom(_) => {
            // Custom agents are deliberately configuration-free: codeg writes
            // no config file for them and they are excluded from the
            // model-provider surface, so there is nothing to cascade. Whatever
            // credentials they need go through the generic launch-env panel.
        }
    }
    Ok(())
}

/// Cascade model provider changes (credentials + model) to all dependent agent settings
/// and config files.
pub(crate) async fn cascade_update_model_provider(
    db: &AppDatabase,
    provider_id: i32,
    new_api_url: &str,
    new_api_key: &str,
    new_model: Option<&str>,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let dependents = agent_setting_service::find_by_model_provider_id(&db.conn, provider_id)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    for setting in &dependents {
        let agent_type: AgentType = match serde_json::from_str(&setting.agent_type) {
            Ok(at) => at,
            Err(_) => continue,
        };

        // 1. Update env_json in database (uses agent_env_keys for consistent key names)
        let (url_key, key_key, _) = agent_env_keys(agent_type);
        let mut env_map: BTreeMap<String, String> = setting
            .env_json
            .as_deref()
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or_default();

        if !new_api_url.trim().is_empty() {
            env_map.insert(url_key.to_string(), new_api_url.to_string());
        }
        if !new_api_key.trim().is_empty() {
            env_map.insert(key_key.to_string(), new_api_key.to_string());
        }

        let model_env = parse_provider_model(agent_type, new_model);
        for (k, v) in &model_env {
            match v {
                Some(value) => {
                    env_map.insert(k.clone(), value.clone());
                }
                None => {
                    env_map.remove(k);
                }
            }
        }

        let patch = agent_setting_service::AgentSettingsUpdate {
            enabled: setting.enabled,
            env_json: serialize_env_map(&env_map)?,
            model_provider_id: setting.model_provider_id,
        };
        agent_setting_service::update(&db.conn, agent_type, patch)
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?;

        // 2. Update on-disk config files
        let codex_action = provider_codex_model_action(agent_type, new_model);
        if let Err(e) = cascade_update_agent_config(
            agent_type,
            new_api_url,
            new_api_key,
            &model_env,
            &codex_action,
            new_model,
        ) {
            tracing::warn!(
                "[ModelProvider] cascade_update_agent_config({agent_type}) failed: {e}, skipping config update"
            );
        }

        emit_acp_agents_updated(emitter, "env_updated", Some(agent_type));
    }
    Ok(())
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_preflight(
    agent_type: AgentType,
    force_refresh: Option<bool>,
) -> Result<PreflightResult, AcpError> {
    if force_refresh.unwrap_or(false) {
        preflight::clear_npm_env_cache();
    }
    Ok(preflight::run_preflight(agent_type).await)
}

/// Resolve the full runtime env every ACP spawn should receive — settings
/// override, model provider credentials, git credential helper, OpenClaw
/// reset flag. Returns `AcpError::protocol("...disabled in settings")` when
/// the user has disabled the agent.
///
/// This is the **single source of truth** for "what env does an agent
/// process see". Three call sites depend on it:
///
///   1. `acp_connect` — the user-initiated session entry point.
///   2. `ConnectionManagerSpawner::spawn` — used by the delegation broker
///      to spawn subagents. Before this helper existed, delegation passed
///      `BTreeMap::new()`, silently bypassing settings/credentials and
///      letting disabled agents still be invoked through delegation.
///   3. `probe_agent_options` — the live settings-page probe. Must match
///      delegation's env exactly so what the user sees in the panel is
///      what `delegate_to_agent` will actually receive.
///
/// Diverging any of these from the others reintroduces the
/// "[UI shows options] != [delegation gets options]" inconsistency that
/// the multi-agent settings panel was designed to prevent.
pub(crate) async fn build_session_runtime_env(
    db: &AppDatabase,
    agent_type: AgentType,
    session_id: Option<&str>,
    data_dir: &Path,
) -> Result<BTreeMap<String, String>, AcpError> {
    let setting = agent_setting_service::get_by_agent_type(&db.conn, agent_type)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let disabled = setting
        .as_ref()
        .map(|model| !model.enabled)
        .unwrap_or(false);
    if disabled {
        return Err(AcpError::protocol(format!(
            "{agent_type} is disabled in settings"
        )));
    }

    let local_config_json = load_agent_local_config_json(agent_type);
    let mut runtime_env =
        build_runtime_env_from_setting(agent_type, setting.as_ref(), local_config_json.as_deref());
    apply_model_provider_env(agent_type, setting.as_ref(), &mut runtime_env, &db.conn).await;
    // `apply_model_provider_env` writes this agent's generic credential trio —
    // for cline that is `CLINE_BASE_URL`/`CLINE_API_KEY`/`CLINE_MODEL` — so a
    // model-provider binding left over from a BYO setup would put a key back
    // after the sign-in scrub already cleared it, silently rerouting a ClinePass
    // or ChatGPT session onto Cline's own billing. Run cline's policy last; it
    // is idempotent, so the BYO path is unchanged.
    if agent_type == AgentType::Cline {
        apply_cline_launch_env(local_config_json.as_deref(), &mut runtime_env);
    }

    // codex resume no longer needs a `MODEL_PROVIDER` pin: codex-acp 1.0.1
    // (#224) resolves the resumed provider from `~/.codex/config.toml` via
    // `config/read`, matching new sessions (which pass `null` so codex reads the
    // config's own `model_provider`). The 1.0.0 workaround that injected
    // `MODEL_PROVIDER` to stop resumed sessions falling back to "openai" is now
    // redundant and was removed.

    if let Some(cred_env) = crate::commands::terminal::prepare_credential_env(data_dir) {
        for (key, value) in cred_env {
            runtime_env.insert(key, value);
        }
    }

    if agent_type == AgentType::OpenClaw && session_id.is_none() {
        runtime_env.insert("OPENCLAW_RESET_SESSION".into(), "1".into());
    }

    Ok(runtime_env)
}

/// Per-launch env keys that vary by session/run but don't represent user
/// config, so they're excluded from the config fingerprint. Without this, a
/// session-id-derived value would flip the fingerprint the moment a real
/// session id is assigned and make every session look "stale". Currently only
/// OpenClaw's reset flag (set iff `session_id` is None at spawn).
fn is_volatile_fingerprint_key(key: &str) -> bool {
    key == "OPENCLAW_RESET_SESSION"
}

/// Fingerprint the effective config a spawned agent process is locked to: the
/// resolved `runtime_env` (minus per-launch volatile keys) plus the raw content
/// of the agent's native config file(s). Both surfaces only take effect at
/// process start, so a change to either is exactly what "this running session is
/// stale" means. The digest is process-local — never persisted, never sent on
/// the wire (only the resulting `stale` bool reaches the frontend) — so a
/// non-cryptographic hash would do; SHA-256 keeps it deterministic and matches
/// the rest of the codebase.
pub(crate) fn fingerprint_config(
    agent_type: AgentType,
    runtime_env: &BTreeMap<String, String>,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    // BTreeMap iterates in sorted key order → deterministic across calls.
    for (k, v) in runtime_env {
        if is_volatile_fingerprint_key(k) {
            continue;
        }
        hasher.update(k.as_bytes());
        hasher.update([0u8]);
        hasher.update(v.as_bytes());
        hasher.update([0u8]);
    }
    hasher.update(b"\x01native\x01");
    if let Some(native) = load_agent_local_config_json(agent_type) {
        hasher.update(native.as_bytes());
    }
    // Grok's native config (~/.grok/config.toml) is not exposed via
    // `agent_local_config_path` — it's edited through the Grok settings panel
    // (model default, reasoning effort, mcp servers, …). Fold it into the
    // fingerprint explicitly so those edits mark running Grok sessions
    // restart-required; otherwise `refresh_config_staleness` would never see the
    // change.
    if agent_type == AgentType::Grok {
        hasher.update(b"\x01grok_toml\x01");
        if let Some(toml) = load_grok_config_toml_raw() {
            hasher.update(toml.as_bytes());
        }
    }
    // Same for Cursor's ~/.cursor/cli-config.json: permission rules and
    // sandbox settings are read at process start, so panel edits must mark
    // running Cursor sessions restart-required. (The Run Everything
    // permission mode is a launch flag sourced from env_json, which the
    // env loop above already hashed.)
    if agent_type == AgentType::Cursor {
        hasher.update(b"\x01cursor_cli_config\x01");
        if let Some(json) = load_cursor_cli_config_raw() {
            hasher.update(json.as_bytes());
        }
    }
    format!("{:x}", hasher.finalize())
}

/// Recompute the canonical config fingerprint for `agent_type` from current
/// settings (DB + native config files), independent of any running session.
/// Passes `session_id = None` so the result is session-independent (the only
/// session-derived key is excluded anyway), making it directly comparable to
/// the fingerprint `fingerprint_config` produced at spawn time. Propagates the
/// agent's "disabled in settings" error verbatim.
pub(crate) async fn compute_session_config_fingerprint(
    db: &AppDatabase,
    agent_type: AgentType,
    data_dir: &Path,
) -> Result<String, AcpError> {
    let runtime_env = build_session_runtime_env(db, agent_type, None, data_dir).await?;
    Ok(fingerprint_config(agent_type, &runtime_env))
}

/// After a settings save, recompute the effective config fingerprint for each of
/// `agent_types` and tell every running connection of those agents whether it
/// has drifted onto stale (launch-time) config. Best-effort: an agent whose
/// fingerprint can't be recomputed (e.g. it was just disabled) is skipped, not
/// fatal. Returns the number of running connections currently on stale config
/// across the affected agents — for the settings-side "N sessions need restart"
/// toast.
pub(crate) async fn refresh_config_staleness(
    manager: &ConnectionManager,
    db: &AppDatabase,
    data_dir: &Path,
    agent_types: &[AgentType],
    kind: ConfigStaleKind,
) -> usize {
    let mut fresh: HashMap<AgentType, String> = HashMap::new();
    for &agent_type in agent_types {
        if fresh.contains_key(&agent_type) {
            continue;
        }
        if let Ok(fp) = compute_session_config_fingerprint(db, agent_type, data_dir).await {
            fresh.insert(agent_type, fp);
        }
    }
    if fresh.is_empty() {
        return 0;
    }
    manager.refresh_connection_staleness(&fresh, kind).await
}

/// `acp_update_agent_env_core` followed by a staleness refresh. Shared by the
/// Tauri command and the web handler so both report how many running sessions
/// the save left on stale config. Returns that count.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_update_agent_env_and_refresh(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    model_provider_id: Option<i32>,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<usize, AcpError> {
    acp_update_agent_env_core(agent_type, enabled, env, model_provider_id, db, emitter).await?;
    Ok(refresh_config_staleness(manager, db, data_dir, &[agent_type], ConfigStaleKind::AgentConfig).await)
}

/// `acp_update_agent_preferences_core` followed by a staleness refresh. Shared
/// by the Tauri command and the web handler; returns the count of running
/// sessions left on stale config.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_update_agent_preferences_and_refresh(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<usize, AcpError> {
    acp_update_agent_preferences_core(
        agent_type,
        enabled,
        env,
        config_json,
        opencode_auth_json,
        codex_auth_json,
        codex_config_toml,
        db,
        emitter,
    )
    .await?;
    Ok(refresh_config_staleness(manager, db, data_dir, &[agent_type], ConfigStaleKind::AgentConfig).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_connect(
    agent_type: AgentType,
    working_dir: Option<String>,
    session_id: Option<String>,
    preferred_mode_id: Option<String>,
    preferred_config_values: Option<BTreeMap<String, String>>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, AcpError> {
    // Resolve through the effective data dir so a custom `CODEG_DATA_DIR`
    // reaches the credential helper script the agent's git subprocess
    // will execute. `acp_connect` may be called before the app data dir
    // exists on disk (first launch); fall back to a sentinel that the
    // credential helper treats as "no credentials configured".
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let runtime_env =
        build_session_runtime_env(&db, agent_type, session_id.as_deref(), &app_data_dir).await?;

    // Guard: the session page must never trigger a download or install.
    // If the agent isn't ready, return SdkNotInstalled here so the frontend
    // can prompt the user to install it from Agent Settings.
    verify_agent_installed(agent_type).await?;

    let emitter = EventEmitter::Tauri(app_handle);
    manager
        .spawn_agent(
            agent_type,
            working_dir,
            session_id,
            runtime_env,
            window.label().to_string(),
            emitter,
            preferred_mode_id,
            preferred_config_values.unwrap_or_default(),
        )
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_prompt(
    connection_id: String,
    blocks: Vec<PromptInputBlock>,
    folder_id: Option<i32>,
    conversation_id: Option<i32>,
    client_message_id: Option<String>,
    db: State<'_, crate::db::AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .send_prompt_linked_with_message_id(
            &db,
            &connection_id,
            blocks,
            folder_id,
            conversation_id,
            None,
            client_message_id,
        )
        .await
        .map(|_| ())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_set_mode(
    connection_id: String,
    mode_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager.set_mode(&connection_id, mode_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_set_config_option(
    connection_id: String,
    config_id: String,
    value_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .set_config_option(&connection_id, config_id, value_id)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_goal_control(
    connection_id: String,
    action: crate::acp::connection::GoalControlAction,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .goal_control(&db.conn, &connection_id, action)
        .await
}

/// Spawn a transient ACP connection for `agent_type` with a silent emitter,
/// read whatever `SessionConfigOptions` / `SessionModes` the agent advertises,
/// and tear it down. The returned snapshot drives the delegation-settings UI
/// so the user picks from the exact option set the agent will accept when
/// codeg-mcp later spawns a subagent.
///
/// Does NOT touch the chat-side `selectorsCache`, `localStorage` preferences,
/// or any active connection state — see `ConnectionManager::probe_agent_options`
/// for the isolation guarantees.
pub async fn acp_describe_agent_options_core(
    manager: &ConnectionManager,
    db: &AppDatabase,
    data_dir: &Path,
    agent_type: AgentType,
    working_dir: Option<String>,
) -> Result<crate::acp::types::AgentOptionsSnapshot, AcpError> {
    verify_agent_installed(agent_type).await?;
    // Build the same runtime env delegation/acp_connect would build so
    // probe sees exactly what `delegate_to_agent` will see at runtime.
    // Without this, the settings UI could show options that the agent
    // never advertises in production (settings override an API URL,
    // model_provider injects a different model list, etc.).
    let runtime_env = build_session_runtime_env(db, agent_type, None, data_dir).await?;
    manager
        .probe_agent_options(agent_type, working_dir, runtime_env)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_describe_agent_options(
    agent_type: AgentType,
    working_dir: Option<String>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app_handle: tauri::AppHandle,
) -> Result<crate::acp::types::AgentOptionsSnapshot, AcpError> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| PathBuf::from("."));
    acp_describe_agent_options_core(&manager, &db, &app_data_dir, agent_type, working_dir).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_cancel(
    connection_id: String,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager.cancel(&db.conn, &connection_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_fork(
    connection_id: String,
    conversation_id: Option<i32>,
    folder_id: Option<i32>,
    // "Fork from here": the rendered turn to fork at. `None` = fork at the
    // tail, the composer's fork-send behaviour.
    fork_from_turn_id: Option<String>,
    db: State<'_, AppDatabase>,
    manager: State<'_, ConnectionManager>,
) -> Result<ForkResultInfo, AcpError> {
    manager
        .fork_session(
            &db,
            &connection_id,
            conversation_id,
            folder_id,
            fork_from_turn_id,
        )
        .await
}

/// Stop one AIR async task. `Ok(false)` = the adapter declined (unknown,
/// already terminal, or a stop already in flight) — a real answer, not a
/// failure.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_stop_async_task(
    connection_id: String,
    task_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<bool, AcpError> {
    manager.stop_async_task(&connection_id, &task_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_respond_permission(
    connection_id: String,
    request_id: String,
    option_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .respond_permission(&connection_id, &request_id, &option_id)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_answer_question(
    connection_id: String,
    question_id: String,
    answer: crate::acp::question::QuestionAnswer,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .answer_question(&connection_id, &question_id, answer)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_answer_plan_approval(
    connection_id: String,
    approval_id: String,
    answer: crate::acp::plan_approval::PlanApprovalAnswer,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager
        .answer_plan_approval(&connection_id, &approval_id, answer)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_disconnect(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<(), AcpError> {
    manager.disconnect(&connection_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_touch_connection(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<bool, AcpError> {
    Ok(manager.touch(&connection_id).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_list_connections(
    manager: State<'_, ConnectionManager>,
) -> Result<Vec<ConnectionInfo>, AcpError> {
    Ok(manager.list_connections().await)
}

pub(crate) async fn acp_get_session_snapshot_core(
    manager: &ConnectionManager,
    connection_id: &str,
) -> Result<Option<crate::acp::LiveSessionSnapshot>, AcpError> {
    let Some(state) = manager.get_state(connection_id).await else {
        return Ok(None);
    };
    let snap = state.read().await.to_snapshot();
    Ok(Some(snap))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_get_session_snapshot(
    connection_id: String,
    manager: State<'_, ConnectionManager>,
) -> Result<Option<crate::acp::LiveSessionSnapshot>, AcpError> {
    acp_get_session_snapshot_core(&manager, &connection_id).await
}

pub(crate) async fn acp_get_session_snapshot_by_conversation_core(
    manager: &ConnectionManager,
    conversation_id: i32,
) -> Result<Option<crate::acp::LiveSessionSnapshot>, AcpError> {
    let Some(conn_id) = manager
        .find_connection_by_conversation_id(conversation_id)
        .await
    else {
        return Ok(None);
    };
    acp_get_session_snapshot_core(manager, &conn_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_get_session_snapshot_by_conversation(
    conversation_id: i32,
    manager: State<'_, ConnectionManager>,
) -> Result<Option<crate::acp::LiveSessionSnapshot>, AcpError> {
    acp_get_session_snapshot_by_conversation_core(&manager, conversation_id).await
}

/// Discover the live connection (if any) another client is currently running
/// for this conversation, returning its id plus the current `event_seq`
/// (informational). The frontend calls this when opening a conversation: if
/// `Some`, it attaches to that connection as a viewer (cross-client live
/// streaming) instead of spawning a fresh agent; if `None`, no client is live
/// and it spawns/owns one.
///
/// Matches by `conversation_id` first, then falls back to `session_id`
/// (`external_id`). The fallback is load-bearing: a connection binds its
/// `conversation_id` only on the first prompt, so a historical conversation
/// opened by a second client BEFORE any prompt is sent would miss the
/// by-conversation lookup — and then `acp_connect` would reuse the live owner's
/// connection by `external_id` and the frontend would mis-tag it as a locally
/// owned connection, tearing it down (killing the real owner's agent) on tab
/// close. Discovering it here lets the second client attach as a viewer.
pub(crate) async fn acp_find_connection_for_conversation_core(
    manager: &ConnectionManager,
    conversation_id: i32,
    session_id: Option<&str>,
    agent_type: AgentType,
) -> Result<Option<crate::acp::ConversationConnectionInfo>, AcpError> {
    let connection_id = match manager
        .find_connection_by_conversation_id(conversation_id)
        .await
    {
        Some(id) => id,
        // The `session_id` (external_id) fallback is matched WITH `agent_type`:
        // `external_id` is unique only per agent, so matching it alone could
        // attach a viewer to a different agent's connection sharing a session id.
        None => match session_id {
            Some(sid) if !sid.is_empty() => {
                match manager
                    .find_connection_by_external_id(sid, agent_type)
                    .await
                {
                    Some(id) => id,
                    None => return Ok(None),
                }
            }
            _ => return Ok(None),
        },
    };
    // The connection may be GC'd between the lookup and the state read; treat a
    // missing state as "no live connection" rather than erroring.
    let Some(state) = manager.get_state(&connection_id).await else {
        return Ok(None);
    };
    let s = state.read().await;
    // Discovery means "a LIVE connection a viewer can attach to". Teardown
    // writes a terminal status onto the state BEFORE the cleanup hook removes
    // the map entry (see `acp/connection.rs`), and `find_connection_by_
    // conversation_id` only matches `conversation_id` — so without this guard
    // discovery can briefly hand back a connection that is going away, and the
    // viewer would attach to a dead stream. Treat terminal statuses as "no live
    // connection" (matching `find_connection_for_reuse`'s contract) so the
    // client reads the persisted detail instead.
    if matches!(
        s.status,
        ConnectionStatus::Disconnected | ConnectionStatus::Error
    ) {
        return Ok(None);
    }
    Ok(Some(crate::acp::ConversationConnectionInfo {
        connection_id,
        event_seq: s.event_seq,
    }))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_find_connection_for_conversation(
    conversation_id: i32,
    session_id: Option<String>,
    agent_type: AgentType,
    manager: State<'_, ConnectionManager>,
) -> Result<Option<crate::acp::ConversationConnectionInfo>, AcpError> {
    acp_find_connection_for_conversation_core(
        &manager,
        conversation_id,
        session_id.as_deref(),
        agent_type,
    )
    .await
}

pub(crate) async fn acp_get_agent_status_core(
    agent_type: AgentType,
    db: &AppDatabase,
) -> Result<crate::acp::types::AcpAgentStatus, AcpError> {
    let platform = registry::current_platform();
    let meta = registry::get_agent_meta(agent_type);
    let setting = agent_setting_service::get_by_agent_type(&db.conn, agent_type)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    let (available, installed_version) = match &meta.distribution {
        registry::AgentDistribution::Npx { cmd, package, .. } => {
            let resolved = resolve_npx_command(cmd).await;
            let mut version = resolved
                .as_ref()
                .and_then(|_| setting.as_ref().and_then(|m| m.installed_version.clone()));
            // An agent the user installed themselves (npm -g, bun, brew, …)
            // resolves but has no managed install record — probe the system
            // install so it reads as installed rather than demanding a
            // second, managed copy. Launch already prefers the PATH
            // resolution, so this only makes the UI agree with what runs.
            if version.is_none() {
                if let Some(bin) = &resolved {
                    version = system_probed_version(agent_type, bin, Some(package)).await;
                }
            }
            (true, version)
        }
        registry::AgentDistribution::Binary {
            platforms,
            cmd,
            dir_entry,
            ..
        } => {
            let mut detected = binary_cache::detect_installed_version(agent_type, cmd)
                .ok()
                .flatten();
            // A system install is launchable via the connect path's PATH
            // fallback, and the frontend gates connect on a non-null
            // installed_version — report the probed system version so such an
            // install isn't blocked as "not installed". Dir-tree agents
            // (Cursor) keep their dedicated probe; everyone else (custom or
            // built-in) goes through the per-agent probe cache.
            if detected.is_none() {
                if dir_entry.is_some() {
                    detected = system_dir_agent_version(cmd).await;
                } else if let Some(bin) = resolve_system_agent_binary_for(agent_type, cmd) {
                    detected = system_probed_version(agent_type, &bin, None).await;
                }
            }
            (platforms.iter().any(|p| p.platform == platform), detected)
        }
        registry::AgentDistribution::Uvx {
            cmd, system_cmd, ..
        } => {
            // Same story as npx: a CLI installed by the user (pipx, uv tool
            // install, …) is a real install (shared helper, launch-order
            // parity with `detect_local_version`).
            let version = uvx_displayed_version(agent_type, cmd, *system_cmd).await;
            (uvx_agent_launchable(*system_cmd), version)
        }
    };

    Ok(crate::acp::types::AcpAgentStatus {
        agent_type,
        available,
        enabled: setting.map(|m| m.enabled).unwrap_or(true),
        installed_version,
        is_acp_adapter: registry::acp_adapter_relation(agent_type).is_some(),
    })
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_get_agent_status(
    agent_type: AgentType,
    db: tauri::State<'_, AppDatabase>,
) -> Result<crate::acp::types::AcpAgentStatus, AcpError> {
    acp_get_agent_status_core(agent_type, &db).await
}

pub(crate) async fn acp_list_agents_core(db: &AppDatabase) -> Result<Vec<AcpAgentInfo>, AcpError> {
    let platform = registry::current_platform();
    let agent_types = registry::all_acp_agents();

    let defaults = agent_types
        .iter()
        .enumerate()
        .map(
            |(idx, agent_type)| agent_setting_service::AgentDefaultInput {
                agent_type: *agent_type,
                registry_id: registry::registry_id_for(*agent_type).to_string(),
                default_sort_order: idx as i32,
            },
        )
        .collect::<Vec<_>>();

    agent_setting_service::ensure_defaults(&db.conn, &defaults)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;
    let settings_map = agent_setting_service::list_map_by_agent_type(&db.conn)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    let mut agents = Vec::new();
    let mut npx_resolver = NpxCommandResolver::default();
    for (idx, agent_type) in agent_types.into_iter().enumerate() {
        let setting = settings_map.get(&agent_type);
        let meta = registry::get_agent_meta(agent_type);
        let (available, dist_type, local_installed_version) = match &meta.distribution {
            registry::AgentDistribution::Npx { cmd, package, .. } => {
                // Keep the list path bounded: each list request probes npm
                // global prefix at most once, then reuses the result across
                // all NPX agents in the loop.
                let resolved = npx_resolver.resolve_for_list(cmd).await;
                let mut version = resolved
                    .as_ref()
                    .and_then(|_| setting.and_then(|m| m.installed_version.clone()));
                // Mirror the status path: an agent's own system install
                // counts as installed (per-agent cached probe).
                if version.is_none() {
                    if let Some(bin) = &resolved {
                        version = system_probed_version(agent_type, bin, Some(package)).await;
                    }
                }
                (true, "npx", version)
            }
            registry::AgentDistribution::Binary {
                platforms,
                cmd,
                dir_entry,
                ..
            } => {
                let mut detected = binary_cache::detect_installed_version(agent_type, cmd)
                    .ok()
                    .flatten();
                // Mirror the status path: a system install counts as installed
                // (cached probes — no per-list subprocess after the first
                // call). Without this, the list would also persist
                // `installed_version = None` over the detected value.
                if detected.is_none() {
                    if dir_entry.is_some() {
                        detected = system_dir_agent_version(cmd).await;
                    } else if let Some(bin) = resolve_system_agent_binary_for(agent_type, cmd) {
                        detected = system_probed_version(agent_type, &bin, None).await;
                    }
                }
                (
                    platforms.iter().any(|p| p.platform == platform),
                    "binary",
                    detected,
                )
            }
            registry::AgentDistribution::Uvx {
                cmd, system_cmd, ..
            } => {
                // Mirror the status path (shared helper, launch-order parity).
                let version = uvx_displayed_version(agent_type, cmd, *system_cmd).await;
                (uvx_agent_launchable(*system_cmd), "uvx", version)
            }
        };

        let mut env = setting
            .and_then(|m| m.env_json.as_deref())
            .and_then(|s| serde_json::from_str::<BTreeMap<String, String>>(s).ok())
            .unwrap_or_default();
        let local_config_json = load_agent_local_config_json(agent_type);
        if let Some(raw_local_config) = local_config_json.as_deref() {
            if let Ok(local_cfg) = serde_json::from_str::<AgentRuntimeConfig>(raw_local_config) {
                for (key, value) in local_cfg.env {
                    let trimmed = value.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    env.insert(key, trimmed.to_string());
                }
                let (api_base_url_key, api_key_key, model_key) = agent_env_keys(agent_type);
                if let Some(value) = trim_non_empty(local_cfg.api_base_url) {
                    env.insert(api_base_url_key.to_string(), value);
                }
                if let Some(value) = trim_non_empty(local_cfg.api_key) {
                    env.insert(api_key_key.to_string(), value);
                }
                if agent_type != AgentType::ClaudeCode {
                    if let Some(value) = trim_non_empty(local_cfg.model) {
                        env.insert(model_key.to_string(), value);
                    }
                }
            }
        }
        let sort_order = setting.map(|m| m.sort_order).unwrap_or(idx as i32);
        // Persist detected version to DB for binary agents (npx written during install/upgrade)
        if dist_type == "binary" {
            let _ = agent_setting_service::set_installed_version(
                &db.conn,
                agent_type,
                local_installed_version.clone(),
            )
            .await;
        }
        let codex_auth_json = if agent_type == AgentType::Codex {
            load_codex_auth_json_raw()
        } else {
            None
        };
        let opencode_auth_json = if agent_type == AgentType::OpenCode {
            load_opencode_auth_json_raw()
        } else {
            None
        };
        let codex_config_toml = if agent_type == AgentType::Codex {
            load_codex_config_toml_raw()
        } else {
            None
        };
        let codex_model_catalog = if agent_type == AgentType::Codex {
            load_codex_model_catalog_source_raw()
        } else {
            None
        };
        // Parsed sandbox / approval keys backing the Codex panel's structured
        // controls. Derived from the same raw text as the advanced editor so the
        // two stay in sync; an absent config file still yields defaults (all
        // "unset") so the controls render.
        let codex_sandbox_settings = if agent_type == AgentType::Codex {
            Some(parse_codex_sandbox_settings(
                codex_config_toml.as_deref().unwrap_or(""),
            ))
        } else {
            None
        };
        let cline_secrets_json = if agent_type == AgentType::Cline {
            load_cline_secrets_json_raw()
        } else {
            None
        };
        // Hermes is self-managed: project its own ~/.hermes/.env + config.yaml
        // into config_json (read-only) and attach the raw config.yaml for the
        // advanced editor. The env-merge block above is skipped because
        // `load_agent_local_config_json` returns None for Hermes (no codeg
        // local config path), so no Hermes credential leaks into process env.
        let (config_json, hermes_config_yaml) = if agent_type == AgentType::Hermes {
            (
                load_hermes_local_config_json().await,
                fs::read_to_string(hermes_config_yaml_path()).ok(),
            )
        } else {
            (local_config_json, None)
        };
        let grok_config_toml = if agent_type == AgentType::Grok {
            load_grok_config_toml_raw()
        } else {
            None
        };
        // Parsed scalar settings backing the Grok panel's structured controls
        // (mode / reasoning effort). Derived from the same raw text so the
        // dropdowns and the advanced editor stay in sync.
        let grok_settings = grok_config_toml.as_deref().map(parse_grok_settings);
        let cursor_cli_config_json = if agent_type == AgentType::Cursor {
            load_cursor_cli_config_raw()
        } else {
            None
        };
        // Parsed scalar settings backing the Cursor panel's structured controls
        // (approval mode / sandbox / permission rules); an absent config file
        // still yields defaults so the panel renders its editors.
        let cursor_settings = if agent_type == AgentType::Cursor {
            Some(parse_cursor_settings(
                cursor_cli_config_json.as_deref().unwrap_or(""),
            ))
        } else {
            None
        };
        agents.push(AcpAgentInfo {
            agent_type,
            registry_id: registry::registry_id_for(agent_type).to_string(),
            registry_version: meta.registry_version().map(ToString::to_string),
            supports_custom_version: meta.supports_custom_version(),
            name: meta.name.to_string(),
            description: meta.description.to_string(),
            available,
            distribution_type: dist_type.to_string(),
            is_acp_adapter: registry::acp_adapter_relation(agent_type).is_some(),
            custom_source: agent_type
                .custom_id()
                .and_then(crate::acp::custom_registry::source_of)
                .map(|s| s.as_str().to_string()),
            enabled: setting.map(|m| m.enabled).unwrap_or(true),
            sort_order,
            installed_version: local_installed_version,
            host_tools_agent_mode: !crate::acp::host_tools_policy::HostToolsPolicy::from_env(&env)
                .hosts_channels(),
            env,
            config_json,
            config_file_path: agent_local_config_path(agent_type)
                .map(|path| path.display().to_string()),
            opencode_auth_json,
            codex_auth_json,
            codex_config_toml,
            codex_sandbox_settings,
            codex_model_catalog,
            cline_secrets_json,
            hermes_config_yaml,
            grok_config_toml,
            grok_settings,
            cursor_cli_config_json,
            cursor_settings,
            model_provider_id: setting.and_then(|m| m.model_provider_id),
            icon_url: agent_type
                .custom_id()
                .and_then(custom_registry::icon_for)
                .map(ToString::to_string),
            // Derived server-side so the skills surfaces need no frontend
            // knowledge of which agents keep a skill store: all builtins do
            // today, customs only when the user declared the shared
            // `.agents/skills` store.
            skills_capable: skill_storage_spec(agent_type).is_some(),
        });
    }

    agents.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(agents)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_list_agents(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<AcpAgentInfo>, AcpError> {
    acp_list_agents_core(&db).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_clear_binary_cache(agent_type: AgentType) -> Result<(), AcpError> {
    let meta = registry::get_agent_meta(agent_type);
    if matches!(
        meta.distribution,
        registry::AgentDistribution::Binary { .. }
    ) {
        binary_cache::clear_agent_cache(agent_type)?;
    }
    Ok(())
}

/// Scan the system temp directory for artifacts leaked by agent launches from
/// BEFORE per-launch temp isolation shipped. Read-only.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_scan_leaked_temp(
) -> Result<crate::acp::temp_reclaim::LeakedTempScan, AcpError> {
    tokio::task::spawn_blocking(crate::acp::temp_reclaim::scan)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))
}

/// Delete the given leaked artifacts. Every path is re-validated immediately
/// before deletion — see `temp_reclaim::reclaim`, which does not trust this
/// list.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_reclaim_leaked_temp(
    paths: Vec<String>,
) -> Result<crate::acp::temp_reclaim::LeakedTempReclaim, AcpError> {
    tokio::task::spawn_blocking(move || crate::acp::temp_reclaim::reclaim(paths))
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_update_agent_preferences_core(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let default = agent_setting_service::AgentDefaultInput {
        agent_type,
        registry_id: registry::registry_id_for(agent_type).to_string(),
        default_sort_order: i32::MAX / 2,
    };

    agent_setting_service::ensure_defaults(&db.conn, &[default])
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    let env_json = serialize_env_map(&env)?;
    let config_json = config_json.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    if let Some(raw) = config_json.as_deref() {
        let parsed = serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;
        if !parsed.is_object() {
            return Err(AcpError::protocol(
                "invalid config_json: root must be a JSON object",
            ));
        }
    }

    let patch = agent_setting_service::AgentSettingsUpdate {
        enabled,
        env_json,
        model_provider_id: None,
    };
    agent_setting_service::update(&db.conn, agent_type, patch)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    if agent_type == AgentType::Codex {
        if codex_auth_json.is_some() || codex_config_toml.is_some() {
            persist_codex_native_config_files(
                codex_auth_json.as_deref(),
                codex_config_toml.as_deref(),
            )?;
        }
        emit_acp_agents_updated(emitter, "preferences_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::OpenCode {
        persist_opencode_native_config(
            opencode_auth_json.as_deref(),
            config_json.as_deref(),
        )?;
        emit_acp_agents_updated(emitter, "preferences_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::Cline {
        if let Some(raw) = config_json.as_deref() {
            persist_cline_local_config(Some(raw))?;
        }
        emit_acp_agents_updated(emitter, "preferences_updated", Some(agent_type));
        return Ok(());
    }

    let mut local_patch_value = config_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    if !env.is_empty() {
        let env_json_value =
            serde_json::to_value(&env).map_err(|e| AcpError::protocol(e.to_string()))?;
        if let Some(obj) = local_patch_value.as_object_mut() {
            obj.insert("env".to_string(), env_json_value);
        }
    }
    let local_patch_json = serde_json::to_string(&local_patch_value)
        .map_err(|e| AcpError::protocol(format!("serialize local patch failed: {e}")))?;
    persist_agent_local_config_json(agent_type, Some(local_patch_json.as_str()))?;
    emit_acp_agents_updated(emitter, "preferences_updated", Some(agent_type));
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_update_agent_preferences(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<usize, AcpError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let emitter = EventEmitter::Tauri(app);
    acp_update_agent_preferences_and_refresh(
        agent_type,
        enabled,
        env,
        config_json,
        opencode_auth_json,
        codex_auth_json,
        codex_config_toml,
        &db,
        &manager,
        &app_data_dir,
        &emitter,
    )
    .await
}

pub(crate) async fn acp_update_agent_env_core(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    model_provider_id: Option<i32>,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let default = agent_setting_service::AgentDefaultInput {
        agent_type,
        registry_id: registry::registry_id_for(agent_type).to_string(),
        default_sort_order: i32::MAX / 2,
    };

    agent_setting_service::ensure_defaults(&db.conn, &[default])
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    // If a provider is selected, the provider's model field is authoritative:
    // each relevant env key is set when the provider has a value and cleared
    // (removed) when empty. Codex's root `model` in config.toml is handled the
    // same way.
    let mut merged_env = env;
    let mut codex_action = CodexModelAction::NoOp;
    // When a Codex provider is bound, capture its structured model list so we can
    // regenerate the `model_catalog_json` catalog + root `model` after the DB
    // write. `Some(_)` means "codex provider bound"; the inner option is the
    // provider's stored model value.
    let mut codex_bound_model: Option<Option<String>> = None;
    // When a Claude provider is bound, capture the inputs to also rewrite the
    // on-disk config.env below. Claude's model fields live in config.env, which
    // the runtime overlays OVER db env_json (see `build_runtime_env_from_setting`),
    // so clearing a key from db env alone is not enough — a stale value left in
    // `~/.claude/settings.json` (e.g. ANTHROPIC_CUSTOM_MODEL_OPTION) would win at
    // launch. Binding must therefore be authoritative on disk too, matching the
    // provider-edit cascade.
    let mut claude_local_cascade: Option<(String, String, BTreeMap<String, Option<String>>)> = None;
    if let Some(pid) = model_provider_id {
        let provider = crate::db::service::model_provider_service::get_by_id(&db.conn, pid)
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?
            .ok_or_else(|| AcpError::protocol(format!("model provider not found: {pid}")))?;

        // Reject cross-type binding: provider.model is formatted for its declared
        // agent_type (Claude = JSON, Codex/Gemini/others = plain string). Binding
        // a mismatched provider would parse the model under the wrong format and
        // silently write invalid env / config.toml entries.
        let provider_agent_type: AgentType =
            serde_json::from_value(serde_json::Value::String(provider.agent_type.clone()))
                .map_err(|_| {
                    AcpError::protocol(format!(
                        "model provider {pid} has invalid agent_type: {}",
                        provider.agent_type
                    ))
                })?;
        if provider_agent_type != agent_type {
            return Err(AcpError::protocol(format!(
                "model provider {pid} is for {provider_agent_type}, cannot be bound to {agent_type}"
            )));
        }

        let model_env = parse_provider_model(agent_type, provider.model.as_deref());
        for (k, v) in &model_env {
            match v {
                Some(value) => {
                    merged_env.insert(k.clone(), value.clone());
                }
                None => {
                    merged_env.remove(k);
                }
            }
        }
        codex_action = provider_codex_model_action(agent_type, provider.model.as_deref());
        // Codex's on-disk config (catalog + root model) is regenerated from the
        // provider's structured model list by `apply_codex_catalog_and_model`
        // below; Gemini's analogous config.env gap is pre-existing and out of
        // scope here. Only Claude needs the local-config cascade on bind.
        if agent_type == AgentType::Codex {
            codex_bound_model = Some(provider.model.clone());
        }
        if agent_type == AgentType::ClaudeCode {
            claude_local_cascade = Some((provider.api_url.clone(), provider.api_key.clone(), model_env));
        }
    }

    let patch = agent_setting_service::AgentSettingsUpdate {
        enabled,
        env_json: serialize_env_map(&merged_env)?,
        model_provider_id,
    };
    agent_setting_service::update(&db.conn, agent_type, patch)
        .await
        .map_err(|e| AcpError::protocol(e.to_string()))?;

    // Authoritatively rewrite the local config.env so a stale model key (e.g. the
    // custom model option) cannot survive a bind/rebind via any save path. `None`
    // entries become JSON-null and are removed by `merge_json_values`.
    if let Some((api_url, api_key, model_env)) = claude_local_cascade {
        if let Err(e) = cascade_update_agent_config(
            agent_type,
            &api_url,
            &api_key,
            &model_env,
            &CodexModelAction::NoOp,
            None,
        ) {
            eprintln!("[acp_update_agent_env] cascade_update_agent_config({agent_type}) failed: {e}");
        }
    }

    if let Some(model_raw) = codex_bound_model {
        // Codex provider bound: regenerate the catalog + config.toml keys from
        // the provider's full model list (REPLACE semantics require the whole
        // list every time).
        if let Err(e) = apply_codex_catalog_and_model(model_raw.as_deref()) {
            tracing::error!("[acp_update_agent_env] apply_codex_catalog_and_model failed: {e}");
        }
    } else if let Err(e) = apply_codex_root_model_action(&codex_action) {
        tracing::error!("[acp_update_agent_env] apply_codex_root_model_action failed: {e}");
    }

    emit_acp_agents_updated(emitter, "env_updated", Some(agent_type));
    Ok(())
}

/// Apply a `CodexModelAction` to the `model` field at the root of
/// `~/.codex/config.toml`, preserving everything else.
fn apply_codex_root_model_action(action: &CodexModelAction) -> Result<(), AcpError> {
    if matches!(action, CodexModelAction::NoOp) {
        return Ok(());
    }
    let config_path = codex_config_toml_path();
    let mut toml_value = if config_path.exists() {
        fs::read_to_string(&config_path)
            .ok()
            .and_then(|raw| raw.parse::<toml::Value>().ok())
            .filter(|v| v.is_table())
            .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()))
    } else {
        toml::Value::Table(toml::map::Map::new())
    };
    let table = toml_value
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("codex config root must be a TOML table"))?;
    match action {
        CodexModelAction::Set(model) => {
            table.insert("model".to_string(), toml::Value::String(model.clone()));
        }
        CodexModelAction::Clear => {
            table.remove("model");
        }
        CodexModelAction::NoOp => unreachable!(),
    }
    let toml_str =
        toml::to_string_pretty(&toml_value).map_err(|e| AcpError::protocol(e.to_string()))?;
    persist_codex_native_config_files(None, Some(&toml_str))?;
    Ok(())
}

/// Codex: generate the `model_catalog_json` catalog file from a structured
/// model list and point `~/.codex/config.toml` at it (relative to `CODEX_HOME`),
/// plus set the root `model` to the default slug. An empty/blank list removes
/// both keys and the generated files (codex falls back to its default catalog).
///
/// This reflows config.toml through the `toml` crate — the same behavior the
/// provider bind / cascade paths already have. The comment-preserving agent
/// panel path instead patches the config.toml text on the frontend and only
/// asks the backend to (re)write the catalog *files* (see
/// `acp_update_agent_config_core`).
fn apply_codex_catalog_and_model(raw: Option<&str>) -> Result<(), AcpError> {
    let snapshot = crate::acp::codex_catalog_source::cached_or_bundled_snapshot();
    let injection = crate::acp::codex_model_catalog::write_catalog_files(
        raw.unwrap_or_default(),
        &codex_home_dir(),
        &snapshot,
    )
    .map_err(|e| AcpError::protocol(e.to_string()))?;

    let config_path = codex_config_toml_path();
    let mut toml_value = if config_path.exists() {
        fs::read_to_string(&config_path)
            .ok()
            .and_then(|raw| raw.parse::<toml::Value>().ok())
            .filter(|v| v.is_table())
            .unwrap_or_else(|| toml::Value::Table(toml::map::Map::new()))
    } else {
        toml::Value::Table(toml::map::Map::new())
    };
    let table = toml_value
        .as_table_mut()
        .ok_or_else(|| AcpError::protocol("codex config root must be a TOML table"))?;
    match &injection {
        Some(inj) => {
            table.insert(
                "model_catalog_json".to_string(),
                toml::Value::String(inj.catalog_rel.to_string()),
            );
            match &inj.default_model {
                Some(model) => {
                    table.insert("model".to_string(), toml::Value::String(model.clone()));
                }
                None => {
                    table.remove("model");
                }
            }
        }
        None => {
            table.remove("model_catalog_json");
            table.remove("model");
        }
    }
    let toml_str =
        toml::to_string_pretty(&toml_value).map_err(|e| AcpError::protocol(e.to_string()))?;
    persist_codex_native_config_files(None, Some(&toml_str))?;
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_update_agent_env(
    agent_type: AgentType,
    enabled: bool,
    env: BTreeMap<String, String>,
    model_provider_id: Option<i32>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<usize, AcpError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let emitter = EventEmitter::Tauri(app);
    acp_update_agent_env_and_refresh(
        agent_type,
        enabled,
        env,
        model_provider_id,
        &db,
        &manager,
        &app_data_dir,
        &emitter,
    )
    .await
}

/// Decide what to write to OpenCode's `auth.json`. `None` (caller passed no
/// auth payload) leaves the file untouched. An explicitly empty payload becomes
/// `{}` so clearing the last credential truncates the file instead of being
/// skipped — otherwise a stale key would survive on disk and the disconnected
/// provider would reappear after reload.
fn opencode_auth_payload_to_write(raw: Option<&str>) -> Option<String> {
    let trimmed = raw?.trim();
    Some(if trimmed.is_empty() {
        "{}".to_string()
    } else {
        trimmed.to_string()
    })
}

/// Persist OpenCode's native files (`auth.json` + `opencode.json`) for a
/// config/preferences save. Shared by both the config and preferences commands
/// so the empty-auth handling can't drift between the two exposed paths. An
/// explicitly empty auth payload truncates `auth.json` to `{}`; `None` leaves
/// each file untouched.
fn persist_opencode_native_config(
    opencode_auth_json: Option<&str>,
    config_json: Option<&str>,
) -> Result<(), AcpError> {
    if let Some(auth) = opencode_auth_payload_to_write(opencode_auth_json) {
        persist_opencode_auth_json(&auth)?;
    }
    if let Some(raw) = config_json {
        persist_agent_local_config_json(AgentType::OpenCode, Some(raw))?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_update_agent_config_core(
    agent_type: AgentType,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    codex_model_catalog: Option<String>,
    codex_sandbox: Option<CodexSandboxStructuredConfig>,
    grok_config_toml: Option<String>,
    grok_structured: Option<GrokStructuredConfig>,
    cursor_cli_config_json: Option<String>,
    cursor_structured: Option<crate::acp::types::CursorStructuredConfig>,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    let config_json = config_json.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    if let Some(raw) = config_json.as_deref() {
        let parsed = serde_json::from_str::<serde_json::Value>(raw)
            .map_err(|e| AcpError::protocol(format!("invalid config_json: {e}")))?;
        if !parsed.is_object() {
            return Err(AcpError::protocol(
                "invalid config_json: root must be a JSON object",
            ));
        }
    }

    if agent_type == AgentType::Codex {
        // Mirrors the Grok/Cursor flow. The advanced raw editor sends the whole
        // file (`codex_config_toml = Some(text)`), so that text is the verbatim
        // base; the sandbox/approval controls send only a patch, merged onto the
        // CURRENT on-disk config (read fresh, failing loudly on a real read
        // error) so a stale in-memory snapshot can't drop keys written by codex
        // itself or another window since the panel opened.
        if codex_auth_json.is_some() || codex_config_toml.is_some() || codex_sandbox.is_some() {
            let merged_toml = match &codex_sandbox {
                Some(sandbox) => {
                    let base = match codex_config_toml {
                        Some(text) => text,
                        None => read_codex_config_or_empty()?,
                    };
                    Some(apply_codex_sandbox_config(&base, sandbox)?)
                }
                None => codex_config_toml,
            };
            persist_codex_native_config_files(codex_auth_json.as_deref(), merged_toml.as_deref())?;
        }
        // The frontend has already patched config.toml's `model_catalog_json` +
        // root `model` into `codex_config_toml` (comment-preserving text patch);
        // the backend only (re)writes the generated catalog *files* here.
        if let Some(raw) = codex_model_catalog.as_deref() {
            let snapshot = crate::acp::codex_catalog_source::cached_or_bundled_snapshot();
            match crate::acp::codex_model_catalog::write_catalog_files(
                raw,
                &codex_home_dir(),
                &snapshot,
            ) {
                // Catalog files gone (nothing deviates from codex's own list any
                // more) — the reference must go with them, or codex fails to
                // start on a `model_catalog_json` pointing at a missing file.
                // The frontend only patches that key when the user *edits* the
                // model editor, so a save that merely lets a stale removal
                // dissolve would otherwise leave the two out of sync.
                Ok(None) => drop_codex_catalog_reference()?,
                Ok(Some(_)) => {}
                Err(e) => {
                    tracing::error!("[acp_update_agent_config] write codex catalog failed: {e}")
                }
            }
        }
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::Grok {
        // Two independent save paths share this command:
        //  - Advanced raw editor  → `grok_config_toml = Some(text)`: the user
        //    authored the whole file, so it is the verbatim base.
        //  - Structured controls  → `grok_config_toml = None`: merge the mode /
        //    reasoning-effort selections onto the CURRENT on-disk config (read
        //    fresh, failing loudly on a real read error) so a stale in-memory
        //    snapshot can't silently drop config written by another window / the
        //    MCP settings path since the panel opened.
        if grok_config_toml.is_some() || grok_structured.is_some() {
            let base = match grok_config_toml {
                Some(text) => text,
                None => read_grok_config_or_empty()?,
            };
            let merged = match &grok_structured {
                Some(settings) => apply_grok_structured_config(&base, settings)?,
                None => base,
            };
            persist_grok_native_config_files(Some(&merged))?;
        }
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::Cursor {
        // Mirrors the Grok flow: the advanced raw editor sends the whole file
        // (`cursor_cli_config_json = Some(text)`); the structured controls send
        // only a patch, merged onto the CURRENT on-disk config (read fresh) so
        // a stale in-memory snapshot can't drop keys written by the CLI's own
        // `/config` UI since the panel opened.
        if cursor_cli_config_json.is_some() || cursor_structured.is_some() {
            let base = match cursor_cli_config_json {
                Some(text) => text,
                None => load_cursor_cli_config_raw().unwrap_or_default(),
            };
            let merged = match &cursor_structured {
                Some(patch) => apply_cursor_structured_config(&base, patch)?,
                None => base,
            };
            if !merged.trim().is_empty() {
                persist_cursor_cli_config(&merged)?;
            }
        }
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::Qoder {
        // The Qoder panel edits `<QODER_CONFIG_DIR>/settings.json` as a whole
        // document, and that file IS Qoder's `agent_local_config_path` — so it
        // arrives through the generic `config_json` channel but must NOT fall
        // through to the merge-persist at the end of this function, which cannot
        // delete a key. Hence the early return: the user authored the whole
        // document, so it is written verbatim.
        if let Some(text) = config_json.as_deref() {
            persist_qoder_settings(text)?;
        }
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::OpenCode {
        persist_opencode_native_config(
            opencode_auth_json.as_deref(),
            config_json.as_deref(),
        )?;
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    if agent_type == AgentType::Cline {
        if let Some(raw) = config_json.as_deref() {
            persist_cline_local_config(Some(raw))?;
        }
        emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
        return Ok(());
    }

    // Claude Code, Gemini, OpenClaw — write config JSON to local file without merging env
    let local_patch_value = config_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}));
    let local_patch_json = serde_json::to_string(&local_patch_value)
        .map_err(|e| AcpError::protocol(format!("serialize local patch failed: {e}")))?;
    persist_agent_local_config_json(agent_type, Some(local_patch_json.as_str()))?;
    emit_acp_agents_updated(emitter, "config_updated", Some(agent_type));
    Ok(())
}

/// `acp_update_agent_config_core` (native config file write) followed by a
/// staleness refresh. Shared by the Tauri command and the web handler; returns
/// the count of running sessions left on stale config.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn acp_update_agent_config_and_refresh(
    agent_type: AgentType,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    codex_model_catalog: Option<String>,
    codex_sandbox: Option<CodexSandboxStructuredConfig>,
    grok_config_toml: Option<String>,
    grok_structured: Option<GrokStructuredConfig>,
    cursor_cli_config_json: Option<String>,
    cursor_structured: Option<crate::acp::types::CursorStructuredConfig>,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<usize, AcpError> {
    acp_update_agent_config_core(
        agent_type,
        config_json,
        opencode_auth_json,
        codex_auth_json,
        codex_config_toml,
        codex_model_catalog,
        codex_sandbox,
        grok_config_toml,
        grok_structured,
        cursor_cli_config_json,
        cursor_structured,
        emitter,
    )
    .await?;
    Ok(refresh_config_staleness(manager, db, data_dir, &[agent_type], ConfigStaleKind::AgentConfig).await)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_update_agent_config(
    agent_type: AgentType,
    config_json: Option<String>,
    opencode_auth_json: Option<String>,
    codex_auth_json: Option<String>,
    codex_config_toml: Option<String>,
    codex_model_catalog: Option<String>,
    codex_sandbox: Option<CodexSandboxStructuredConfig>,
    grok_config_toml: Option<String>,
    grok_structured: Option<GrokStructuredConfig>,
    cursor_cli_config_json: Option<String>,
    cursor_structured: Option<crate::acp::types::CursorStructuredConfig>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<usize, AcpError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let emitter = EventEmitter::Tauri(app);
    acp_update_agent_config_and_refresh(
        agent_type,
        config_json,
        opencode_auth_json,
        codex_auth_json,
        codex_config_toml,
        codex_model_catalog,
        codex_sandbox,
        grok_config_toml,
        grok_structured,
        cursor_cli_config_json,
        cursor_structured,
        &db,
        &manager,
        &app_data_dir,
        &emitter,
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_update_hermes_config(
    provider: String,
    api_key: Option<String>,
    model: Option<String>,
    base_url: Option<String>,
    raw_config_yaml: Option<String>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_update_hermes_config_core(
        HermesConfigUpdate {
            provider,
            api_key,
            model,
            base_url,
            raw_config_yaml,
        },
        &emitter,
    )
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_update_kimi_code_config(
    mode: String,
    interface_type: Option<String>,
    auth_type: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
    model: Option<String>,
    max_context_size: Option<i64>,
    vertex_project: Option<String>,
    vertex_location: Option<String>,
    raw_config_toml: Option<String>,
    reasoning_enabled: Option<bool>,
    always_thinking: Option<bool>,
    support_efforts: Option<Vec<String>>,
    default_effort: Option<String>,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<usize, AcpError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let emitter = EventEmitter::Tauri(app);
    acp_update_kimi_code_config_and_refresh(
        KimiCodeConfigUpdate {
            mode,
            interface_type,
            auth_type,
            base_url,
            api_key,
            model,
            max_context_size,
            vertex_project,
            vertex_location,
            raw_config_toml,
            reasoning_enabled,
            always_thinking,
            support_efforts,
            default_effort,
        },
        &db,
        &manager,
        &app_data_dir,
        &emitter,
    )
    .await
}

/// List the models an API key + endpoint can access (validates the key and
/// populates the Kimi settings model picker). Desktop command; the web handler
/// calls `acp_fetch_kimi_models_core` directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_fetch_kimi_models(
    base_url: String,
    api_key: String,
) -> Result<Vec<String>, AcpError> {
    acp_fetch_kimi_models_core(&base_url, &api_key).await
}

/// Apply a structured Pi config update, writing pi's native `settings.json`
/// (provider/model/thinking level) and `auth.json` (when an API key is given).
/// Desktop command; the web handler calls `acp_update_pi_config_core` directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
#[allow(clippy::too_many_arguments)]
pub async fn acp_update_pi_config(
    provider: String,
    model: String,
    thinking_level: Option<String>,
    api_key: Option<String>,
    custom_base_url: Option<String>,
    custom_api: Option<String>,
    model_reasoning: Option<PiModelReasoningSpec>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_update_pi_config_core(
        PiConfigUpdate {
            provider,
            model,
            thinking_level,
            api_key,
            custom_base_url,
            custom_api,
            model_reasoning,
        },
        &db,
        &emitter,
    )
    .await
}

/// Read pi's current native config (model selection + configured auth providers)
/// for the settings panel. Desktop command; the web handler calls
/// `load_pi_config_core` directly. Reads the filesystem only — no DB/state needed.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_load_pi_config() -> Result<PiConfigProjection, AcpError> {
    Ok(load_pi_config_core())
}

/// Validate a user-supplied custom pi binary (BYO-pi): resolve it (path or
/// `PATH`) and best-effort read its `--version`. A not-found binary returns
/// `found=false` (not an error). Desktop command; the web handler calls
/// `acp_validate_pi_command_core` directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_validate_pi_command(command: String) -> Result<PiCommandValidation, AcpError> {
    Ok(acp_validate_pi_command_core(command))
}

/// Report which repo-shipped pi resources a workspace ships and whether any
/// trust decision already covers it. Read-only. Desktop command; the web handler
/// calls `acp_pi_project_trust_state_core` directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_pi_project_trust_state(
    db: tauri::State<'_, AppDatabase>,
    workspace: String,
) -> Result<PiProjectTrustState, AcpError> {
    acp_pi_project_trust_state_core(&db, workspace).await
}

/// Project the saved Antigravity auth choice into the server's settings file,
/// and say whether it landed. Called by the settings panel after a save.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_sync_antigravity_settings(
    db: tauri::State<'_, AppDatabase>,
) -> Result<crate::acp::connection::AntigravitySyncReport, AcpError> {
    acp_sync_antigravity_settings_core(&db).await
}

/// Start a browser-free Antigravity sign-in for a machine with no desktop.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_antigravity_login_start(
    db: tauri::State<'_, AppDatabase>,
    method_id: String,
) -> Result<crate::acp::antigravity_login::AntigravityLoginStart, AcpError> {
    acp_antigravity_login_start_core(&db, method_id).await
}

/// Complete a browser-free Antigravity sign-in from the address the user's
/// browser was redirected to.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_antigravity_login_finish(
    handle: String,
    redirect: String,
) -> Result<crate::acp::antigravity_login::AntigravityLoginOutcome, AcpError> {
    acp_antigravity_login_finish_core(handle, redirect).await
}

/// Abandon a pending browser-free Antigravity sign-in.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_antigravity_login_cancel(handle: String) -> Result<(), AcpError> {
    acp_antigravity_login_cancel_core(handle).await
}

/// Clear the Antigravity credential so another account can be signed in.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_antigravity_sign_out(
    db: tauri::State<'_, AppDatabase>,
    manager: tauri::State<'_, crate::acp::manager::ConnectionManager>,
) -> Result<crate::acp::connection::AntigravitySyncReport, AcpError> {
    acp_antigravity_sign_out_core(&db, &manager).await
}

/// Record (or clear, with `trusted: null`) an explicit project-trust decision in
/// pi's `trust.json`. Only ever called from a user action in the approval UI.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_pi_set_project_trust(
    db: tauri::State<'_, AppDatabase>,
    workspace: String,
    trusted: Option<bool>,
) -> Result<(), AcpError> {
    acp_pi_set_project_trust_core(&db, workspace, trusted).await
}

/// Record that the user reviewed an existing grant and chose to keep it, which
/// clears the launch gate for that folder. Does not change pi's trust store.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_pi_acknowledge_project_trust(workspace: String) -> Result<(), AcpError> {
    acp_pi_acknowledge_project_trust_core(workspace).await
}

/// List every decision in pi's `trust.json` so the settings page can review and
/// revoke them — including any auto-seeded by codeg before trust became a user
/// decision.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_pi_list_trust_entries(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<PiTrustEntry>, AcpError> {
    acp_pi_list_trust_entries_core(&db).await
}

/// Launch Hermes's interactive setup in the OS terminal. `kind` selects the
/// flow (`"setup"` → `hermes acp --setup`, `"model"` → `hermes model`); the
/// exact command is constructed by the backend from the registry recipe (the
/// renderer cannot supply arbitrary shell text). Ensures `~/.hermes` exists so
/// the `cd` into it can't fail on a fresh install. Desktop-only: these flows
/// need a real interactive TTY and a browser for OAuth.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_open_hermes_setup_terminal(kind: String) -> Result<(), AcpError> {
    let (setup, model) = hermes_setup_commands().await;
    let command = match kind.as_str() {
        "setup" => setup,
        "model" => model,
        other => {
            return Err(AcpError::protocol(format!(
                "unknown hermes setup kind: {other}"
            )));
        }
    };
    let home = hermes_home_dir();
    ensure_hermes_home_secure(&home)?;
    let home_str = home.to_string_lossy();
    open_external_terminal_impl(&command, Some(home_str.as_ref()))
}

#[cfg(feature = "tauri-runtime")]
fn open_external_terminal_impl(command: &str, cwd: Option<&str>) -> Result<(), AcpError> {
    use std::process::Command;
    // Reject control characters: a newline breaks out of the macOS AppleScript
    // string literal (and would corrupt the cmd/shell line elsewhere), turning a
    // single command into multiple statements.
    if command.contains(['\n', '\r']) || cwd.is_some_and(|c| c.contains(['\n', '\r'])) {
        return Err(AcpError::protocol(
            "terminal command and cwd must not contain newlines",
        ));
    }
    let dir = cwd
        .map(|c| c.to_string())
        .unwrap_or_else(|| home_dir_or_default().display().to_string());

    #[cfg(target_os = "macos")]
    {
        // Hand `cd <dir> && <command>` to Terminal.app via AppleScript. Quote the
        // dir for the shell, then escape the whole string for the AppleScript
        // literal (backslashes first, then double-quotes).
        let shell_cmd = format!("cd {} && {}", shell_single_quote(&dir), command);
        let escaped = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
        let osa = format!(
            "tell application \"Terminal\"\nactivate\ndo script \"{escaped}\"\nend tell"
        );
        Command::new("osascript")
            .arg("-e")
            .arg(osa)
            .spawn()
            .map_err(|e| AcpError::protocol(format!("open Terminal failed: {e}")))?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        // `start "" cmd /K <command>` opens a new console that stays open. The
        // empty "" is the window title `start` would otherwise eat.
        Command::new("cmd")
            .args(["/C", "start", "", "cmd", "/K", command])
            .current_dir(&dir)
            .spawn()
            .map_err(|e| AcpError::protocol(format!("open terminal failed: {e}")))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // Probe common Linux terminal emulators in order; keep the window open
        // after the command by re-exec'ing the user's shell.
        let keep_open = format!("{command}; exec \"${{SHELL:-bash}}\"");
        let candidates: [(&str, [&str; 3]); 4] = [
            ("x-terminal-emulator", ["-e", "sh", "-c"]),
            ("gnome-terminal", ["--", "sh", "-c"]),
            ("konsole", ["-e", "sh", "-c"]),
            ("xterm", ["-e", "sh", "-c"]),
        ];
        for (term, args) in candidates {
            if resolve_command_on_path(term).is_some() {
                return Command::new(term)
                    .args(args)
                    .arg(&keep_open)
                    .current_dir(&dir)
                    .spawn()
                    .map(|_| ())
                    .map_err(|e| AcpError::protocol(format!("open {term} failed: {e}")));
            }
        }
        return Err(AcpError::protocol(
            "no supported terminal emulator found (tried x-terminal-emulator, gnome-terminal, konsole, xterm)",
        ));
    }

    #[allow(unreachable_code)]
    Err(AcpError::protocol("unsupported platform for terminal launch"))
}

/// Quote a string for a single-quoted POSIX shell argument.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Ensure `~/.hermes` exists and reveal it in the system file manager.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_reveal_hermes_home(app: tauri::AppHandle) -> Result<(), AcpError> {
    use tauri_plugin_opener::OpenerExt;
    let home = hermes_home_dir();
    ensure_hermes_home_secure(&home)?;
    app.opener()
        .open_path(home.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AcpError::protocol(format!("open hermes folder failed: {e}")))?;
    Ok(())
}

pub(crate) async fn acp_download_agent_binary_core(
    agent_type: AgentType,
    version_override: Option<String>,
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");

    let meta = registry::get_agent_meta(agent_type);
    let result = match meta.distribution {
        registry::AgentDistribution::Binary {
            version,
            cmd,
            platforms,
            ..
        } => {
            // A custom version substitutes into the pinned download URL and the
            // cache key; `None`/empty keeps the registry-pinned version.
            let custom = match version_override.as_deref() {
                Some(raw) if !raw.trim().is_empty() => {
                    let sanitized = sanitize_custom_version(raw).ok_or_else(|| {
                        AcpError::protocol(format!("invalid custom version: {}", raw.trim()))
                    })?;
                    // Asking for the version that is already pinned is a normal
                    // install, not a custom one. Keeping it as `Some` would make
                    // the substitution below a no-op and trip the "not
                    // templatable" refusal on the one request that is trivially
                    // satisfiable — and would drop the registry's digest for a
                    // URL that has not changed.
                    (sanitized != version).then_some(sanitized)
                }
                _ => None,
            };

            let platform = registry::current_platform();
            let fallback = platforms
                .iter()
                .find(|p| p.platform == platform)
                .ok_or_else(|| {
                    AcpError::PlatformNotSupported(format!(
                        "{} is not available on {platform}",
                        meta.name
                    ))
                })?;

            let effective_version = custom.as_deref().unwrap_or(version);
            let archive_url = match &custom {
                Some(c) => {
                    let substituted = apply_custom_version_to_url(fallback.url, version, c);
                    // The substitution is the whole mechanism: when the pinned
                    // version is not a substring of the URL, asking for another
                    // one downloads the SAME archive and caches it under the
                    // requested number, so `installed_version` reports a build
                    // that was never fetched. Refuse instead of lying — the UI
                    // hides the control for these agents
                    // (`supports_custom_version`), and this is the backstop for
                    // a direct API call.
                    if substituted == fallback.url {
                        return Err(AcpError::protocol(format!(
                            "{} publishes no version-templated download URL, so it cannot install \
                             a custom version ({c}); its pinned build is {version}",
                            meta.name
                        )));
                    }
                    substituted
                }
                None => fallback.url.to_string(),
            };

            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Log,
                format!(
                    "Downloading {} v{effective_version} for {platform}",
                    meta.name
                ),
            );

            let emitter_clone = emitter.clone();
            let task_id_clone = task_id.clone();
            let _ = binary_cache::ensure_binary_for_agent_with_progress(
                agent_type,
                effective_version,
                &archive_url,
                cmd,
                // A custom version rewrites the URL, so the registry's digest
                // no longer describes what we are about to fetch — only verify
                // against the pinned release.
                custom.is_none().then_some(fallback.sha256).flatten(),
                move |msg| {
                    emit_agent_install_event(
                        &emitter_clone,
                        &task_id_clone,
                        AgentInstallEventKind::Log,
                        msg,
                    );
                },
            )
            .await?;
            emit_acp_agents_updated(emitter, "binary_downloaded", Some(agent_type));
            Ok(())
        }
        registry::AgentDistribution::Npx { .. } => Err(AcpError::protocol(
            "download is only supported for binary agents",
        )),
        registry::AgentDistribution::Uvx { .. } => Err(AcpError::protocol(
            "download is only supported for binary agents",
        )),
    };

    match &result {
        Ok(()) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Completed,
                format!("{} installed successfully", meta.name),
            );
        }
        Err(e) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Failed,
                e.to_string(),
            );
        }
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_download_agent_binary(
    agent_type: AgentType,
    version: Option<String>,
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_download_agent_binary_core(agent_type, version, task_id, &emitter).await
}

/// Provision ONLY the uv toolchain (uvx) into codeg's cache — independent of
/// installing any `Uvx` agent's package. Streams progress over the shared
/// agent-install event stream so the Settings page shows a live log. Backs the
/// uv preflight check's "Install uv" fix. After this succeeds,
/// `resolve_uvx_command()` resolves the cached uvx, so a subsequent preflight /
/// agent-status reports uv as available.
pub(crate) async fn acp_install_uv_tool_core(
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");

    let emitter_clone = emitter.clone();
    let task_id_clone = task_id.clone();
    let result = crate::acp::binary_cache::ensure_uv_tool(move |msg| {
        emit_agent_install_event(
            &emitter_clone,
            &task_id_clone,
            AgentInstallEventKind::Log,
            msg.to_string(),
        );
    })
    .await
    .map(|_| ());

    match &result {
        Ok(()) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Completed,
                "uv runtime installed successfully".to_string(),
            );
            // uv is shared across all uvx agents, so its arrival flips their
            // availability — notify every client to refetch the agent list.
            emit_acp_agents_updated(emitter, "uv_installed", None);
        }
        Err(e) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Failed,
                e.to_string(),
            );
        }
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_install_uv_tool(
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_install_uv_tool_core(task_id, &emitter).await
}

pub(crate) async fn acp_detect_agent_local_version_core(
    agent_type: AgentType,
    conn: &sea_orm::DatabaseConnection,
    emitter: &EventEmitter,
) -> Result<Option<String>, AcpError> {
    // Snapshot the stored version before probing so we can tell whether this
    // detection actually moves it. The settings page re-runs this for every
    // agent on each open; emitting unconditionally would fan a reload storm out
    // to every `useAcpAgents()` consumer, so we only notify on a real change.
    let previous = agent_setting_service::get_by_agent_type(conn, agent_type)
        .await
        .ok()
        .flatten()
        .and_then(|m| m.installed_version);

    let detected = detect_local_version(agent_type).await;
    if let Some(version) = detected.clone() {
        let _ =
            agent_setting_service::set_installed_version(conn, agent_type, Some(version.clone()))
                .await;
        // Heal the composer's install status. The input box reads
        // `installed_version` straight from this row and shows "not installed"
        // while it's null (`acp_list_agents_core` never probes npm for it). When
        // a live probe discovers a version the DB never recorded — an agent
        // installed outside codeg, or by a build predating version tracking —
        // wake `useAcpAgents()` so the composer stops claiming it's missing.
        if previous.as_deref() != Some(version.as_str()) {
            emit_acp_agents_updated(emitter, "local_version_detected", Some(agent_type));
        }
        return Ok(Some(version));
    }

    // Binary agents detect their version purely from the on-disk cache, so a
    // `None` here means the binary is genuinely absent (cleared cache, or a
    // failed custom/upgrade install). Return `None` authoritatively rather than
    // falling back to the DB, which would resurrect a removed version as a
    // phantom that can no longer be launched. The returned value does NOT depend
    // on the mirror write below, so a swallowed write cannot reintroduce the
    // phantom. (NPX detection runs `npm list`, which can fail transiently, so
    // for npx we keep the DB value as a best-effort fallback.)
    if matches!(
        registry::get_agent_meta(agent_type).distribution,
        registry::AgentDistribution::Binary { .. }
    ) {
        let _ = agent_setting_service::set_installed_version(conn, agent_type, None).await;
        // Mirror the heal in the clearing direction: a binary that vanished from
        // disk must flip the composer back to "not installed".
        if previous.is_some() {
            emit_acp_agents_updated(emitter, "local_version_cleared", Some(agent_type));
        }
        return Ok(None);
    }

    Ok(previous)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_detect_agent_local_version(
    agent_type: AgentType,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<Option<String>, AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_detect_agent_local_version_core(agent_type, &db.conn, &emitter).await
}

pub(crate) async fn acp_prepare_npx_agent_core(
    agent_type: AgentType,
    registry_version: Option<String>,
    version_override: Option<String>,
    clean_first: bool,
    task_id: String,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<String, AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");

    let meta = registry::get_agent_meta(agent_type);
    let result = match meta.distribution {
        registry::AgentDistribution::Npx { package, cmd, .. } => {
            let default = agent_setting_service::AgentDefaultInput {
                agent_type,
                registry_id: registry::registry_id_for(agent_type).to_string(),
                default_sort_order: i32::MAX / 2,
            };
            agent_setting_service::ensure_defaults(&db.conn, &[default])
                .await
                .map_err(|e| AcpError::protocol(e.to_string()))?;

            let setting = agent_setting_service::get_by_agent_type(&db.conn, agent_type)
                .await
                .ok()
                .flatten();
            let existing = setting.as_ref().and_then(|m| m.installed_version.clone());
            // The latest-channel opt-in reads the same merged env layers the
            // launch and the settings page resolve, so the control can never
            // show one channel while the install applies another.
            let latest_channel = adapter_channel_is_latest(&build_runtime_env_from_setting(
                agent_type,
                setting.as_ref(),
                load_agent_local_config_json(agent_type).as_deref(),
            ));
            // `version_override` of None/empty keeps the channel's spec (the
            // registry pin, or `<name>@latest` for a latest-channel agent); a
            // custom version installs `<name>@<version>` instead, on either
            // channel.
            let (first_spec, fallback_spec) =
                npm_install_attempts(package, version_override.as_deref(), latest_channel)?;

            // Best-effort uninstall before reinstall. Forces npm to re-resolve
            // the dependency graph from scratch, which is required for
            // platform-specific optionalDependencies (e.g. native CLI binaries
            // shipped as `<pkg>-darwin-x64`) to be picked up after an upgrade.
            // Failures here are logged and swallowed so we still attempt the
            // install — for example when nothing is currently installed.
            if clean_first {
                let package_name = package_name_from_spec(package);
                emit_agent_install_event(
                    emitter,
                    &task_id,
                    AgentInstallEventKind::Log,
                    format!("$ npm uninstall -g {package_name} (clean reinstall)"),
                );
                if let Err(e) = uninstall_npm_global_package(package).await {
                    emit_agent_install_event(
                        emitter,
                        &task_id,
                        AgentInstallEventKind::Log,
                        format!("(warning) uninstall step failed, continuing: {e}"),
                    );
                }
            }

            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Log,
                format!("Installing {} ({first_spec})", meta.name),
            );
            let install_spec = match install_npm_global_package_streaming(
                &first_spec,
                &task_id,
                emitter,
            )
            .await
            {
                Ok(()) => first_spec,
                Err(err) => {
                    // FAIL SAFE TO THE PIN. A latest-channel install can die on
                    // things the pin does not (npm unreachable, a mirror not yet
                    // carrying the tag's target, a yanked release), and the user
                    // asked for "newest when possible", not "nothing unless
                    // newest". Retry the reviewed pinned spec, saying so in the
                    // same install log — and let the recorded installed version
                    // report what actually landed.
                    let Some(pinned_spec) = fallback_spec else {
                        return Err(annotate_npm_bootstrap_failure(&first_spec, err));
                    };
                    let err = annotate_npm_bootstrap_failure(&first_spec, err);
                    tracing::warn!(
                        "[acp] latest install {first_spec} failed ({err}); \
                         falling back to pinned {pinned_spec}"
                    );
                    emit_agent_install_event(
                        emitter,
                        &task_id,
                        AgentInstallEventKind::Log,
                        format!("ERROR: installing {first_spec} failed: {err}"),
                    );
                    emit_agent_install_event(
                        emitter,
                        &task_id,
                        AgentInstallEventKind::Log,
                        format!(
                            "Falling back to the pinned version ({pinned_spec})..."
                        ),
                    );
                    emit_agent_install_event(
                        emitter,
                        &task_id,
                        AgentInstallEventKind::Log,
                        format!("Installing {} ({pinned_spec})", meta.name),
                    );
                    install_npm_global_package_streaming(&pinned_spec, &task_id, emitter)
                        .await
                        .map_err(|e| annotate_npm_bootstrap_failure(&pinned_spec, e))?;
                    pinned_spec
                }
            };

            // For a bootstrap-wrapper package (hermes-agent), npm metadata
            // existing does NOT mean the agent can run: a skipped or broken
            // postinstall leaves a shim that exits "runtime is not ready".
            // Verify the binary a launch would resolve actually answers
            // `--version` BEFORE recording success — the same resolution
            // order connect uses, so an official-installer CLI on PATH
            // legitimately satisfies the check. Without this, a broken
            // install is recorded as installed and only fails at connect
            // time with an opaque error.
            if npm_package_requires_scripts(&install_spec) {
                emit_agent_install_event(
                    emitter,
                    &task_id,
                    AgentInstallEventKind::Log,
                    format!("Verifying the {} runtime...", meta.name),
                );
                let runtime_ok = match resolve_npx_command(cmd).await {
                    Some(bin) => system_probed_version(agent_type, &bin, None)
                        .await
                        .is_some(),
                    None => false,
                };
                if !runtime_ok {
                    return Err(AcpError::protocol(format!(
                        "{} installed, but its runtime did not bootstrap (`{cmd} --version` \
                         does not answer). If your npm config sets ignore-scripts, allow \
                         scripts for this package and reinstall; otherwise retry, or use \
                         the official installer and codeg will pick up the PATH `{cmd}`.",
                        meta.name
                    )));
                }
            }

            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Log,
                "Detecting installed version...",
            );
            let resolved = detect_local_version(agent_type)
                .await
                .or_else(|| version_from_package_spec(&install_spec))
                .or_else(|| {
                    registry_version
                        .as_deref()
                        .and_then(normalize_version_candidate)
                })
                .or(existing)
                .ok_or_else(|| {
                    AcpError::protocol(
                        "npm global install succeeded but failed to determine local version",
                    )
                })?;

            agent_setting_service::set_installed_version(
                &db.conn,
                agent_type,
                Some(resolved.clone()),
            )
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?;
            emit_acp_agents_updated(emitter, "npx_prepared", Some(agent_type));
            Ok(resolved)
        }
        registry::AgentDistribution::Binary { .. } => Err(AcpError::protocol(
            "prepare is only supported for npx agents",
        )),
        registry::AgentDistribution::Uvx {
            package,
            cmd,
            version,
            python,
            ..
        } => {
            let default = agent_setting_service::AgentDefaultInput {
                agent_type,
                registry_id: registry::registry_id_for(agent_type).to_string(),
                default_sort_order: i32::MAX / 2,
            };
            agent_setting_service::ensure_defaults(&db.conn, &[default])
                .await
                .map_err(|e| AcpError::protocol(e.to_string()))?;

            // Pre-fetch the pinned package into uvx's cache so the first
            // connect doesn't pay the download cost. The version is pinned in
            // the package spec, so `version_override` does not apply here.
            prewarm_uvx_agent(meta.name, package, cmd, python, &task_id, emitter).await?;

            let resolved = version.to_string();
            binary_cache::mark_uvx_agent_prepared(agent_type, &resolved)?;
            agent_setting_service::set_installed_version(
                &db.conn,
                agent_type,
                Some(resolved.clone()),
            )
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?;
            emit_acp_agents_updated(emitter, "uvx_prepared", Some(agent_type));
            Ok(resolved)
        }
    };

    match &result {
        Ok(version) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Completed,
                format!("{} v{version} installed successfully", meta.name),
            );
        }
        Err(e) => {
            // When clean_first was true the uninstall step may already have
            // succeeded by the time install failed, leaving the DB pointing at
            // a version that no longer exists on disk. Resync the DB to the
            // actual filesystem state so the UI doesn't mislead the user into
            // thinking they can connect.
            if clean_first {
                let detected = detect_local_version(agent_type).await;
                if let Err(sync_err) =
                    agent_setting_service::set_installed_version(&db.conn, agent_type, detected)
                        .await
                {
                    tracing::error!(
                        "[acp] failed to resync installed_version after clean upgrade failure: {sync_err}"
                    );
                }
                emit_acp_agents_updated(emitter, "npx_prepare_failed", Some(agent_type));
            }
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Failed,
                e.to_string(),
            );
        }
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_prepare_npx_agent(
    agent_type: AgentType,
    registry_version: Option<String>,
    version: Option<String>,
    clean_first: Option<bool>,
    task_id: String,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<String, AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_prepare_npx_agent_core(
        agent_type,
        registry_version,
        version,
        clean_first.unwrap_or(false),
        task_id,
        &db,
        &emitter,
    )
    .await
}

pub(crate) async fn acp_uninstall_agent_core(
    agent_type: AgentType,
    task_id: String,
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");

    let meta = registry::get_agent_meta(agent_type);
    emit_agent_install_event(
        emitter,
        &task_id,
        AgentInstallEventKind::Log,
        format!("Uninstalling {}...", meta.name),
    );

    let result: Result<(), AcpError> = async {
        match meta.distribution {
            registry::AgentDistribution::Binary { .. } => {
                binary_cache::clear_agent_cache(agent_type)?;
            }
            registry::AgentDistribution::Npx { package, .. } => {
                uninstall_npm_global_package(package).await?;
            }
            registry::AgentDistribution::Uvx { .. } => {
                binary_cache::clear_uvx_agent_prepared(agent_type)?;
            }
        }

        agent_setting_service::set_installed_version(&db.conn, agent_type, None)
            .await
            .map_err(|e| AcpError::protocol(e.to_string()))?;
        emit_acp_agents_updated(emitter, "agent_uninstalled", Some(agent_type));
        Ok(())
    }
    .await;

    match &result {
        Ok(()) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Completed,
                format!("{} uninstalled successfully", meta.name),
            );
        }
        Err(e) => {
            emit_agent_install_event(
                emitter,
                &task_id,
                AgentInstallEventKind::Failed,
                e.to_string(),
            );
        }
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_uninstall_agent(
    agent_type: AgentType,
    task_id: String,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_uninstall_agent_core(agent_type, task_id, &db, &emitter).await
}

/// The npm package that ships the `pi` binary pi-acp spawns as `pi --mode rpc`.
/// Installed unpinned ("latest"): pi releases frequently and pi-acp resolves
/// `pi` from PATH, so the binary's version floats independently of the pinned
/// `pi-acp` adapter (which `acp_prepare_npx_agent` installs separately).
const PI_CODING_AGENT_PACKAGE: &str = "@earendil-works/pi-coding-agent";

/// Install the `pi` binary globally via npm, streaming progress on the shared
/// `app://agent-install` topic. This is the prerequisite the missing-pi launch
/// preflight (see [`crate::acp::connection`]) guards against. Reuses the same
/// EACCES user-prefix and EEXIST `--force` fallbacks as every other npm agent
/// install.
pub(crate) async fn acp_install_pi_binary_core(
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");

    let result =
        install_npm_global_package_streaming(PI_CODING_AGENT_PACKAGE, &task_id, emitter).await;

    match &result {
        Ok(()) => emit_agent_install_event(
            emitter,
            &task_id,
            AgentInstallEventKind::Completed,
            "pi installed successfully",
        ),
        Err(e) => emit_agent_install_event(
            emitter,
            &task_id,
            AgentInstallEventKind::Failed,
            e.to_string(),
        ),
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_install_pi_binary(
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_install_pi_binary_core(task_id, &emitter).await
}

/// Uninstall the global `pi` binary. Mirrors `acp_uninstall_agent_core`'s event
/// envelope; the npm subprocess output isn't streamed (the shared helper
/// collects it via `.output()`), but the Started/Log/Completed/Failed events
/// drive the same install-log block in the panel.
pub(crate) async fn acp_uninstall_pi_binary_core(
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    emit_agent_install_event(emitter, &task_id, AgentInstallEventKind::Started, "");
    emit_agent_install_event(
        emitter,
        &task_id,
        AgentInstallEventKind::Log,
        format!("$ npm uninstall -g {PI_CODING_AGENT_PACKAGE}"),
    );

    let result = uninstall_npm_global_package(PI_CODING_AGENT_PACKAGE).await;

    match &result {
        Ok(()) => emit_agent_install_event(
            emitter,
            &task_id,
            AgentInstallEventKind::Completed,
            "pi uninstalled successfully",
        ),
        Err(e) => emit_agent_install_event(
            emitter,
            &task_id,
            AgentInstallEventKind::Failed,
            e.to_string(),
        ),
    }
    result
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_uninstall_pi_binary(
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_uninstall_pi_binary_core(task_id, &emitter).await
}

pub(crate) async fn acp_reorder_agents_core(
    agent_types: &[AgentType],
    db: &AppDatabase,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    if agent_types.is_empty() {
        return Ok(());
    }
    agent_setting_service::reorder(&db.conn, agent_types)
        .await
        .map_err(|e| {
            let message = e.to_string();
            if message.contains("database or disk is full") || message.contains("(code: 13)") {
                AcpError::protocol("无法保存排序：数据库可写空间不足。请释放磁盘空间后重试。")
            } else {
                AcpError::protocol(message)
            }
        })?;
    emit_acp_agents_updated(emitter, "agent_reordered", None);
    Ok(())
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_reorder_agents(
    agent_types: Vec<AgentType>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    acp_reorder_agents_core(&agent_types, &db, &emitter).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_list_agent_skills(
    agent_type: AgentType,
    workspace_path: Option<String>,
) -> Result<AgentSkillsListResult, AcpError> {
    let Some(spec) = skill_storage_spec(agent_type) else {
        return Ok(AgentSkillsListResult {
            supported: false,
            message: Some(format!("{agent_type} 暂不支持在设置页管理 Skills")),
            locations: Vec::new(),
            skills: Vec::new(),
        });
    };

    let mut locations = Vec::new();
    let mut skills_by_key: BTreeMap<String, AgentSkillItem> = BTreeMap::new();

    for dir in &spec.global_dirs {
        locations.push(AgentSkillLocation {
            scope: AgentSkillScope::Global,
            path: dir.to_string_lossy().to_string(),
            exists: dir.exists(),
        });
        let listed = list_skills_from_dir(AgentSkillScope::Global, dir, spec.kind)?;
        for skill in listed {
            let key = format!("global:{}", skill.id);
            skills_by_key.entry(key).or_insert(skill);
        }
    }

    if let Some(workspace) = workspace_path.as_deref().map(str::trim) {
        if !workspace.is_empty() {
            // Same base the WRITE path resolves through `scoped_skill_dirs` —
            // for DeepSeek and Kimi Code that is the repo root, not the
            // workspace. Joining onto the workspace here instead would make a
            // skill saved from a nested workspace vanish from the list that is
            // meant to show it.
            let base = project_skill_base(agent_type, workspace);
            for relative in &spec.project_rel_dirs {
                let project_dir = base.join(relative);
                locations.push(AgentSkillLocation {
                    scope: AgentSkillScope::Project,
                    path: project_dir.to_string_lossy().to_string(),
                    exists: project_dir.exists(),
                });
                let listed =
                    list_skills_from_dir(AgentSkillScope::Project, &project_dir, spec.kind)?;
                for skill in listed {
                    let key = format!("project:{}", skill.id);
                    skills_by_key.entry(key).or_insert(skill);
                }
            }
        }
    }

    let mut skills = skills_by_key.into_values().collect::<Vec<_>>();
    for skill in &mut skills {
        if is_read_only_skill_path(agent_type, Path::new(&skill.path)) {
            skill.read_only = true;
        }
    }
    skills.sort_by(|a, b| {
        scope_rank(a.scope)
            .cmp(&scope_rank(b.scope))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(AgentSkillsListResult {
        supported: true,
        message: None,
        locations,
        skills,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_read_agent_skill(
    agent_type: AgentType,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<AgentSkillContent, AcpError> {
    let Some(spec) = skill_storage_spec(agent_type) else {
        return Err(AcpError::protocol(format!(
            "{agent_type} skills are not supported in Settings yet"
        )));
    };
    let id = validate_skill_id(&skill_id)?;
    let dirs = scoped_skill_dirs(agent_type, scope, workspace_path.as_deref())?;

    let mut skill = locate_existing_skill_across_dirs(&dirs, spec.kind, &id, scope)
        .ok_or_else(|| AcpError::protocol(format!("skill not found: {id}")))?;
    if is_read_only_skill_path(agent_type, Path::new(&skill.path)) {
        skill.read_only = true;
    }
    let content_path = skill_content_path(skill.layout, Path::new(&skill.path));
    let content = fs::read_to_string(&content_path)
        .map_err(|e| AcpError::protocol(format!("failed to read skill content: {e}")))?;
    Ok(AgentSkillContent { skill, content })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_save_agent_skill(
    agent_type: AgentType,
    scope: AgentSkillScope,
    skill_id: String,
    content: String,
    workspace_path: Option<String>,
    layout: Option<AgentSkillLayout>,
) -> Result<AgentSkillItem, AcpError> {
    let Some(spec) = skill_storage_spec(agent_type) else {
        return Err(AcpError::protocol(format!(
            "{agent_type} skills are not supported in Settings yet"
        )));
    };
    let id = validate_skill_id(&skill_id)?;
    let dirs = scoped_skill_dirs(agent_type, scope, workspace_path.as_deref())?;
    let preferred_dir = preferred_scope_skill_dir(agent_type, scope, workspace_path.as_deref())?;

    fs::create_dir_all(&preferred_dir)
        .map_err(|e| AcpError::protocol(format!("failed to create skills directory: {e}")))?;

    let existing = locate_existing_skill_across_dirs(&dirs, spec.kind, &id, scope);
    if let Some(ref item) = existing {
        if is_read_only_skill_path(agent_type, Path::new(&item.path)) {
            return Err(AcpError::protocol(format!(
                "skill '{id}' is a built-in system skill and cannot be modified"
            )));
        }
    }
    let mut skill = if let Some(item) = existing {
        item
    } else {
        let new_layout = match spec.kind {
            SkillStorageKind::SkillDirectoryOnly => AgentSkillLayout::SkillDirectory,
            SkillStorageKind::SkillDirectoryOrMarkdownFile => {
                layout.unwrap_or(AgentSkillLayout::MarkdownFile)
            }
        };
        let skill_path = match new_layout {
            AgentSkillLayout::SkillDirectory => preferred_dir.join(&id),
            AgentSkillLayout::MarkdownFile => preferred_dir.join(format!("{id}.md")),
        };
        build_skill_item(id.clone(), scope, new_layout, skill_path)
    };

    let skill_path = PathBuf::from(&skill.path);
    let content_path = skill_content_path(skill.layout, &skill_path);

    if skill.layout == AgentSkillLayout::SkillDirectory {
        fs::create_dir_all(&skill_path).map_err(|e| {
            AcpError::protocol(format!(
                "failed to create skill directory '{}': {e}",
                skill.path
            ))
        })?;
    } else if let Some(parent) = content_path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            AcpError::protocol(format!("failed to create skill parent directory: {e}"))
        })?;
    }

    fs::write(&content_path, content)
        .map_err(|e| AcpError::protocol(format!("failed to write skill content: {e}")))?;

    skill.description = read_skill_description(&content_path);

    Ok(skill)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_delete_agent_skill(
    agent_type: AgentType,
    scope: AgentSkillScope,
    skill_id: String,
    workspace_path: Option<String>,
) -> Result<(), AcpError> {
    let Some(spec) = skill_storage_spec(agent_type) else {
        return Err(AcpError::protocol(format!(
            "{agent_type} skills are not supported in Settings yet"
        )));
    };
    let id = validate_skill_id(&skill_id)?;
    let dirs = scoped_skill_dirs(agent_type, scope, workspace_path.as_deref())?;

    let skill = locate_existing_skill_across_dirs(&dirs, spec.kind, &id, scope)
        .ok_or_else(|| AcpError::protocol(format!("skill not found: {id}")))?;
    if is_read_only_skill_path(agent_type, Path::new(&skill.path)) {
        return Err(AcpError::protocol(format!(
            "skill '{id}' is a built-in system skill and cannot be deleted"
        )));
    }
    let skill_path = PathBuf::from(&skill.path);
    remove_skill_entry(&skill_path)
        .map_err(|e| AcpError::protocol(format!("failed to delete skill entry: {e}")))?;
    Ok(())
}

pub(crate) async fn opencode_list_plugins_core() -> Result<PluginCheckSummary, AcpError> {
    opencode_plugins::check_opencode_plugins(None).map_err(AcpError::Protocol)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_list_plugins() -> Result<PluginCheckSummary, AcpError> {
    opencode_list_plugins_core().await
}

pub(crate) async fn opencode_provider_catalog_core(
    data_dir: &Path,
    force_refresh: bool,
) -> Vec<crate::acp::opencode_catalog::CatalogProvider> {
    crate::acp::opencode_catalog::provider_catalog(data_dir, force_refresh).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_provider_catalog(
    force_refresh: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<crate::acp::opencode_catalog::CatalogProvider>, AcpError> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| PathBuf::from("."));
    Ok(opencode_provider_catalog_core(&data_dir, force_refresh.unwrap_or(false)).await)
}

/// The official codex model catalog (full `ModelInfo` entries), sourced at
/// runtime from the codex codeg actually launches (cache + bundled fallback),
/// used by the settings editor for the official list, "quick-add official", and
/// as the clone template for custom entries' heavy required fields.
pub(crate) async fn codex_bundled_catalog_core(force_refresh: bool) -> Vec<serde_json::Value> {
    crate::acp::codex_catalog_source::runtime_catalog(force_refresh).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn codex_bundled_catalog(
    force_refresh: Option<bool>,
) -> Result<Vec<serde_json::Value>, AcpError> {
    Ok(codex_bundled_catalog_core(force_refresh.unwrap_or(false)).await)
}

pub(crate) async fn opencode_install_plugins_core(
    names: Option<Vec<String>>,
    task_id: String,
    emitter: &EventEmitter,
) -> Result<(), AcpError> {
    opencode_plugins::install_missing_plugins(names, task_id, emitter)
        .await
        .map_err(AcpError::Protocol)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_install_plugins(
    names: Option<Vec<String>>,
    task_id: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::Tauri(app);
    opencode_install_plugins_core(names, task_id, &emitter).await
}

pub(crate) async fn opencode_uninstall_plugin_core(
    name: String,
) -> Result<PluginCheckSummary, AcpError> {
    opencode_plugins::uninstall_plugin(name)
        .await
        .map_err(AcpError::Protocol)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_uninstall_plugin(name: String) -> Result<PluginCheckSummary, AcpError> {
    opencode_uninstall_plugin_core(name).await
}

// ─── Codex Device Code OAuth ───

const CODEX_OAUTH_ISSUER: &str = "https://auth.openai.com";
const CODEX_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDeviceCodeResponse {
    pub user_code: String,
    pub verification_url: String,
    pub device_auth_id: String,
    pub interval: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDeviceCodePollResult {
    pub status: String,
    pub message: Option<String>,
    pub id_token: Option<String>,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub account_id: Option<String>,
}

#[derive(Deserialize)]
struct DeviceCodeUserCodeResp {
    device_auth_id: String,
    #[serde(alias = "usercode")]
    user_code: String,
    #[serde(
        default = "default_interval",
        deserialize_with = "deserialize_interval"
    )]
    interval: u64,
}

fn default_interval() -> u64 {
    5
}

fn extract_jwt_account_id(jwt: &str) -> Option<String> {
    let payload = jwt.split('.').nth(1)?;
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    value
        .get("https://api.openai.com/auth")
        .and_then(|auth| auth.get("chatgpt_account_id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn deserialize_interval<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de;
    let value = serde_json::Value::deserialize(deserializer)?;
    match &value {
        serde_json::Value::Number(n) => n
            .as_u64()
            .ok_or_else(|| de::Error::custom(format!("invalid interval number: {n}"))),
        serde_json::Value::String(s) => s.trim().parse::<u64>().map_err(de::Error::custom),
        _ => Err(de::Error::custom(format!(
            "unexpected interval type: {value}"
        ))),
    }
}

#[derive(Deserialize)]
struct DeviceCodeTokenResp {
    authorization_code: String,
    #[allow(dead_code)]
    code_challenge: String,
    code_verifier: String,
}

#[derive(Deserialize)]
struct OAuthTokenResp {
    id_token: String,
    access_token: String,
    refresh_token: String,
}

pub(crate) async fn codex_request_device_code_core() -> Result<CodexDeviceCodeResponse, AcpError> {
    let client = reqwest::Client::new();
    let url = format!("{CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode");
    let body = serde_json::json!({ "client_id": CODEX_OAUTH_CLIENT_ID });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| AcpError::protocol(format!("device code request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AcpError::protocol(format!(
            "device code request returned {status}: {text}"
        )));
    }

    let raw_body = resp
        .text()
        .await
        .map_err(|e| AcpError::protocol(format!("read device code response failed: {e}")))?;
    let uc: DeviceCodeUserCodeResp = serde_json::from_str(&raw_body).map_err(|e| {
        AcpError::protocol(format!(
            "parse device code response failed: {e} | body: {raw_body}"
        ))
    })?;

    Ok(CodexDeviceCodeResponse {
        user_code: uc.user_code,
        verification_url: format!("{CODEX_OAUTH_ISSUER}/codex/device"),
        device_auth_id: uc.device_auth_id,
        interval: uc.interval,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn codex_request_device_code() -> Result<CodexDeviceCodeResponse, AcpError> {
    codex_request_device_code_core().await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn codex_poll_device_code(
    device_auth_id: String,
    user_code: String,
) -> Result<CodexDeviceCodePollResult, AcpError> {
    codex_poll_device_code_core(device_auth_id, user_code).await
}

pub(crate) async fn codex_poll_device_code_core(
    device_auth_id: String,
    user_code: String,
) -> Result<CodexDeviceCodePollResult, AcpError> {
    let client = reqwest::Client::new();
    let poll_url = format!("{CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token");
    let poll_body = serde_json::json!({
        "device_auth_id": device_auth_id,
        "user_code": user_code,
    });

    let resp = client
        .post(&poll_url)
        .json(&poll_body)
        .send()
        .await
        .map_err(|e| AcpError::protocol(format!("device code poll failed: {e}")))?;

    if !resp.status().is_success() {
        return Ok(CodexDeviceCodePollResult {
            status: "pending".into(),
            message: None,
            id_token: None,
            access_token: None,
            refresh_token: None,
            account_id: None,
        });
    }

    let code_resp: DeviceCodeTokenResp = resp
        .json()
        .await
        .map_err(|e| AcpError::protocol(format!("parse poll response failed: {e}")))?;

    let redirect_uri = format!("{CODEX_OAUTH_ISSUER}/deviceauth/callback");
    let token_url = format!("{CODEX_OAUTH_ISSUER}/oauth/token");

    let token_resp = client
        .post(&token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(format!(
            "grant_type=authorization_code&code={}&redirect_uri={}&client_id={}&code_verifier={}",
            urlencoding::encode(&code_resp.authorization_code),
            urlencoding::encode(&redirect_uri),
            urlencoding::encode(CODEX_OAUTH_CLIENT_ID),
            urlencoding::encode(&code_resp.code_verifier),
        ))
        .send()
        .await
        .map_err(|e| AcpError::protocol(format!("token exchange failed: {e}")))?;

    if !token_resp.status().is_success() {
        let status = token_resp.status();
        let text = token_resp.text().await.unwrap_or_default();
        return Ok(CodexDeviceCodePollResult {
            status: "error".into(),
            message: Some(format!("token exchange returned {status}: {text}")),
            id_token: None,
            access_token: None,
            refresh_token: None,
            account_id: None,
        });
    }

    let tokens: OAuthTokenResp = token_resp
        .json()
        .await
        .map_err(|e| AcpError::protocol(format!("parse token response failed: {e}")))?;

    let account_id = extract_jwt_account_id(&tokens.id_token).unwrap_or_default();

    Ok(CodexDeviceCodePollResult {
        status: "success".into(),
        message: None,
        id_token: Some(tokens.id_token),
        access_token: Some(tokens.access_token),
        refresh_token: Some(tokens.refresh_token),
        account_id: Some(account_id),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_version_token_finds_the_version_in_common_banners() {
        assert_eq!(extract_version_token("0.21.0").as_deref(), Some("0.21.0"));
        assert_eq!(
            extract_version_token("qwen version 0.21.0\n").as_deref(),
            Some("0.21.0")
        );
        assert_eq!(
            extract_version_token("goose v1.44.0 (release)").as_deref(),
            Some("1.44.0")
        );
        assert_eq!(
            extract_version_token("Foo CLI\nversion: 2.3.4-beta.1").as_deref(),
            Some("2.3.4-beta.1")
        );
        // A leading `v` is stripped; the word "version" is not mistaken for one.
        assert_eq!(
            extract_version_token("version v10.2.30").as_deref(),
            Some("10.2.30")
        );
        // curl-style `name/version` banners (omp prints exactly this).
        assert_eq!(
            extract_version_token("omp/17.1.7").as_deref(),
            Some("17.1.7")
        );
        // npm-style `package@version`, scoped packages included.
        assert_eq!(
            extract_version_token("@oh-my-pi/pi-coding-agent@17.1.7").as_deref(),
            Some("17.1.7")
        );
    }

    #[test]
    fn extract_version_token_rejects_non_versions() {
        assert!(extract_version_token("").is_none());
        assert!(extract_version_token("usage: foo [args]").is_none());
        // Dotted but not digit-led, and digit-led but not dotted.
        assert!(extract_version_token("node.js required").is_none());
        assert!(extract_version_token("exit 1").is_none());
        // A URL's path segment must not read as a version, and slash-split
        // pieces without a dot don't qualify either.
        assert!(extract_version_token("docs: https://example.com/2.0/setup").is_none());
        assert!(extract_version_token("built 2026/07").is_none());
    }

    #[test]
    fn probe_cache_key_misses_when_the_declared_probe_or_package_changes() {
        let bin = std::path::Path::new("/usr/local/bin/agent");
        // Editing the declared probe MUST be a cache miss — this was the bug:
        // a path+mtime key kept serving the old probe's result.
        let auto = probe_cache_key(bin, None, None);
        let probe_a = probe_cache_key(bin, Some("agent --version"), None);
        let probe_b = probe_cache_key(bin, Some("agent -V"), None);
        assert_ne!(auto, probe_a);
        assert_ne!(probe_a, probe_b);
        // Removing the probe again returns to the auto key.
        assert_eq!(probe_cache_key(bin, None, None), auto);
        // Two agents sharing a launcher but naming different npm packages must
        // not read each other's auto-path result…
        let pkg_a = probe_cache_key(bin, None, Some("@scope/a"));
        let pkg_b = probe_cache_key(bin, None, Some("@scope/b"));
        assert_ne!(pkg_a, pkg_b);
        // …and the package stays in the key even with a declared probe: a
        // failing probe falls back to the package conventions, so the package
        // still shapes the cached result.
        assert_ne!(
            probe_cache_key(bin, Some("agent --version"), Some("@scope/a")),
            probe_cache_key(bin, Some("agent --version"), Some("@scope/b")),
        );
    }

    #[cfg(unix)]
    fn fake_version_script(dir: &std::path::Path, name: &str, banner: &str) -> PathBuf {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let bin = dir.join(name);
        {
            let mut f = std::fs::File::create(&bin).expect("create script");
            f.write_all(format!("#!/bin/sh\necho \"{banner}\"\n").as_bytes())
                .expect("write script");
        }
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        bin
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn system_probed_version_reads_a_system_cli_via_the_version_convention() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bin = fake_version_script(dir.path(), "fake-agent", "fake-agent version 1.2.3");

        // Unregistered custom id → no declared probe → the auto `--version`
        // path, exactly what a hand-added agent without a probe gets. The
        // same path serves built-ins, which can never declare a probe.
        let version =
            system_probed_version(AgentType::Custom("probe-e2e-test"), &bin, None).await;
        assert_eq!(version.as_deref(), Some("1.2.3"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_declared_probe_falls_back_to_the_version_convention() {
        let dir = tempfile::tempdir().expect("tempdir");
        // `name/version` banner — the shape that motivated the token split.
        let bin = fake_version_script(dir.path(), "fallback-agent", "fallback-agent/3.2.1");

        // The declared probe's program doesn't exist, so the probe yields
        // nothing; the convention path must still read the real install.
        let version = system_probed_version_with(
            Some("codeg-missing-probe-cmd-e2e --version"),
            &bin,
            None,
        )
        .await;
        assert_eq!(version.as_deref(), Some("3.2.1"));
    }

    #[test]
    fn parse_grok_settings_reads_documented_keys() {
        let toml = "[ui]\npermission_mode = \"acceptEdits\"\n\n\
                    [models]\ndefault_reasoning_effort = \"high\"\n";
        let s = parse_grok_settings(toml);
        assert_eq!(s.permission_mode.as_deref(), Some("acceptEdits"));
        assert_eq!(s.default_reasoning_effort.as_deref(), Some("high"));
    }

    #[test]
    fn parse_grok_settings_migrates_legacy_permission_values() {
        // codeg's old codeg-invented markers map onto grok's real enum so the
        // dropdown, launch flag, and grok's TUI agree.
        let approve = parse_grok_settings("[ui]\npermission_mode = \"always-approve\"\n");
        assert_eq!(approve.permission_mode.as_deref(), Some("bypassPermissions"));
        let ask = parse_grok_settings("[ui]\npermission_mode = \"ask\"\n");
        assert_eq!(ask.permission_mode.as_deref(), Some("default"));
        // A real grok mode is preserved untouched.
        let real = parse_grok_settings("[ui]\npermission_mode = \"auto\"\n");
        assert_eq!(real.permission_mode.as_deref(), Some("auto"));
    }

    #[test]
    fn parse_grok_settings_absent_or_malformed_is_none() {
        let s = parse_grok_settings("[cli]\nauto_update = true\n");
        assert!(s.permission_mode.is_none());
        assert!(s.default_reasoning_effort.is_none());
        // Malformed TOML → all None, never panics.
        let bad = parse_grok_settings("this is not = = = toml");
        assert!(bad.default_reasoning_effort.is_none());
    }

    #[test]
    fn apply_grok_structured_config_sets_and_creates_tables() {
        // Starting from an empty file, both keys land in their tables.
        let merged = apply_grok_structured_config(
            "",
            &GrokStructuredConfig {
                default_reasoning_effort: Some("high".into()),
                permission_mode: Some("acceptEdits".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let back = parse_grok_settings(&merged);
        assert_eq!(back.default_reasoning_effort.as_deref(), Some("high"));
        assert_eq!(back.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn apply_grok_structured_config_preserves_other_sections_and_comments() {
        let base = "# my grok config\n[cli]\nauto_update = true  # keep me\n\n\
                    [mcp_servers.context7]\ncommand = \"npx\"\n\n[models]\ndefault = \"grok-4.5\"\n";
        let merged = apply_grok_structured_config(
            base,
            &GrokStructuredConfig {
                default_reasoning_effort: Some("low".into()),
                permission_mode: Some("bypassPermissions".into()),
                ..Default::default()
            },
        )
        .unwrap();
        // Comments + unmanaged sections/keys survive (toml_edit is format-
        // preserving); the unmanaged `[models].default` is NOT touched.
        assert!(merged.contains("# my grok config"));
        assert!(merged.contains("# keep me"));
        assert!(merged.contains("[mcp_servers.context7]"));
        assert!(merged.contains("default = \"grok-4.5\""));
        let back = parse_grok_settings(&merged);
        assert_eq!(back.default_reasoning_effort.as_deref(), Some("low"));
        assert_eq!(back.permission_mode.as_deref(), Some("bypassPermissions"));
    }

    #[test]
    fn apply_grok_structured_config_preserves_inline_table_siblings() {
        // A `[models]` written as an inline table must keep its other keys when a
        // managed key is set (regression: `is_table()` misses inline tables and
        // would clobber the whole value).
        let base = "models = { default = \"grok-4.5\", session_summary = \"grok-4.5\" }\n";
        let merged = apply_grok_structured_config(
            base,
            &GrokStructuredConfig {
                default_reasoning_effort: Some("high".into()),
                permission_mode: None,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(merged.contains("session_summary"), "inline sibling preserved");
        assert!(merged.contains("grok-4.5"), "inline default preserved");
        assert_eq!(
            parse_grok_settings(&merged).default_reasoning_effort.as_deref(),
            Some("high")
        );
    }

    #[test]
    fn apply_grok_structured_config_removes_on_none() {
        let base = "[ui]\npermission_mode = \"ask\"\n\n\
                    [models]\ndefault_reasoning_effort = \"high\"\n";
        let merged =
            apply_grok_structured_config(base, &GrokStructuredConfig::default()).unwrap();
        let back = parse_grok_settings(&merged);
        assert!(back.permission_mode.is_none(), "unset removes the key");
        assert!(back.default_reasoning_effort.is_none());
    }

    #[test]
    fn apply_grok_structured_config_rejects_malformed_or_incompatible_base() {
        assert!(
            apply_grok_structured_config("== not toml ==", &GrokStructuredConfig::default())
                .is_err(),
            "a malformed base must error, never silently overwrite the user's config"
        );
        // A section that exists as a scalar must error rather than be replaced.
        let incompatible = apply_grok_structured_config(
            "ui = 1\n",
            &GrokStructuredConfig {
                default_reasoning_effort: None,
                permission_mode: Some("ask".into()),
                ..Default::default()
            },
        );
        assert!(
            incompatible.is_err(),
            "an incompatible non-table section must error, not clobber"
        );
    }

    // ---- Codex sandbox / approval structured controls -------------------
    // Every expectation below was verified against a real codex-cli 0.145.0 by
    // writing the shape into an isolated `CODEX_HOME` and reading the resulting
    // `thread/start` sandbox back.

    #[test]
    fn parse_codex_sandbox_settings_reads_plain_keys() {
        let s = parse_codex_sandbox_settings(
            "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n",
        );
        assert_eq!(s.approval_policy.as_deref(), Some("never"));
        assert_eq!(s.sandbox_mode.as_deref(), Some("danger-full-access"));
        assert!(s.granular.is_none());
        assert!(!s.shadowed_by_default_permissions);
    }

    #[test]
    fn parse_codex_sandbox_settings_normalizes_legacy_on_failure() {
        // `on-failure` is a serde ALIAS of `on-request` upstream, not a distinct
        // policy, so the panel must show it as `on-request` rather than as an
        // unknown value it would then clobber.
        let s = parse_codex_sandbox_settings("approval_policy = \"on-failure\"\n");
        assert_eq!(s.approval_policy.as_deref(), Some("on-request"));
    }

    /// Map a config.toml body the way the launch path does.
    fn initial_mode_for(toml: &str) -> Option<&'static str> {
        codex_initial_agent_mode(&parse_codex_sandbox_settings(toml))
    }

    #[test]
    fn codex_initial_agent_mode_never_widens_the_sandbox() {
        // The invariant that matters: codex-acp's default preset is `agent`
        // (workspace-write), so an explicitly read-only config used to be
        // silently upgraded to writable. Every approval policy — including the
        // ones that cannot be represented — must still land on `read-only`.
        for policy in [
            "",
            "approval_policy = \"untrusted\"\n",
            "approval_policy = \"on-request\"\n",
            "approval_policy = \"on-failure\"\n",
            "approval_policy = \"never\"\n",
        ] {
            let toml = format!("{policy}sandbox_mode = \"read-only\"\n");
            assert_eq!(
                initial_mode_for(&toml),
                Some("read-only"),
                "read-only sandbox must survive {policy:?}"
            );
        }
        for policy in ["", "approval_policy = \"untrusted\"\n"] {
            let toml = format!("{policy}sandbox_mode = \"workspace-write\"\n");
            assert_eq!(initial_mode_for(&toml), Some("agent"));
        }
    }

    #[test]
    fn codex_initial_agent_mode_keeps_a_writable_config_writable_on_every_adapter() {
        // Regression guard for a fix that looks right and is not. codex-acp
        // 1.7.0 turned `read-only` into a workspace-write preset whose
        // approvals are user-adjudicated, which invites mapping EVERY
        // approval-wanting config onto it. But `supports_custom_version()` is
        // true for npx agents, and on a user-pinned ≤1.6.2 that preset is still
        // a genuinely READ-ONLY sandbox — the agent would silently be unable to
        // write a single file. `INITIAL_AGENT_MODE` is chosen before launch, so
        // the running adapter's version is not knowable here; the mapping must
        // therefore stay keyed on the sandbox, which is the axis whose meaning
        // did not move. See the "Why the reviewer axis is NOT used" note above.
        for policy in [
            "",
            "approval_policy = \"on-request\"\n",
            "approval_policy = \"on-failure\"\n",
            "approval_policy = \"untrusted\"\n",
        ] {
            let toml = format!("{policy}sandbox_mode = \"workspace-write\"\n");
            assert_eq!(
                initial_mode_for(&toml),
                Some("agent"),
                "a writable config must never be handed the read-only preset ({policy:?})"
            );
        }
    }

    #[test]
    fn codex_initial_agent_mode_only_grants_full_access_on_an_exact_match() {
        // `agent-full-access` is the one preset with approvalPolicy `never`, so
        // it must never be inferred — both halves have to already say so.
        assert_eq!(
            initial_mode_for(
                "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n"
            ),
            Some("agent-full-access")
        );
        // Sandbox says full access but approvals are still wanted: tighten the
        // sandbox to workspace-write rather than dropping approvals.
        for policy in [
            "",
            "approval_policy = \"on-request\"\n",
            "approval_policy = \"untrusted\"\n",
        ] {
            let toml = format!("{policy}sandbox_mode = \"danger-full-access\"\n");
            assert_eq!(
                initial_mode_for(&toml),
                Some("agent"),
                "must not remove approvals for {policy:?}"
            );
        }
        // `never` alone must NOT reach for full access — that would widen the
        // sandbox from whatever codex-acp would otherwise use.
        assert_eq!(initial_mode_for("approval_policy = \"never\"\n"), None);
    }

    #[test]
    fn codex_initial_agent_mode_declines_when_default_permissions_shadows_the_root_keys() {
        // codex resolves through the named profile and ignores the root keys, so
        // mapping them would hand the session a policy the config never asked
        // for. The nastiest case: a read-only profile with stale permissive root
        // keys would be GRANTED full access + no approvals, because codex-acp
        // re-sends the preset's policy every turn.
        assert_eq!(
            initial_mode_for(
                "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n\
                 default_permissions = \":read-only\"\n"
            ),
            None,
            "must not widen a shadowed config"
        );
        // Declining is unconditional — even when the root keys look harmless,
        // they are not what codex is using.
        for body in [
            "sandbox_mode = \"read-only\"\ndefault_permissions = \":read-only\"\n",
            "sandbox_mode = \"workspace-write\"\ndefault_permissions = \":full-access\"\n",
        ] {
            assert_eq!(initial_mode_for(body), None, "shadowed: {body:?}");
        }
    }

    #[test]
    fn codex_initial_agent_mode_stays_out_of_the_way_without_a_sandbox() {
        // Nothing expressed → nothing to preserve; leave codex-acp's own default
        // alone rather than pinning a preset the user never chose.
        assert_eq!(initial_mode_for(""), None);
        assert_eq!(initial_mode_for("model = \"gpt-5\"\n"), None);
        assert_eq!(initial_mode_for("approval_policy = \"untrusted\"\n"), None);
        // Unknown/malformed sandbox values are dropped by the parser, so they
        // behave like "unset" rather than mapping to something arbitrary.
        assert_eq!(initial_mode_for("sandbox_mode = \"wide-open\"\n"), None);
        assert_eq!(initial_mode_for("this is not toml\n"), None);
    }

    #[test]
    fn parse_codex_sandbox_settings_reads_granular_in_both_toml_forms() {
        let inline = parse_codex_sandbox_settings(
            "approval_policy = { granular = { sandbox_approval = true, rules = false, \
             skill_approval = true, request_permissions = false, mcp_elicitations = true } }\n",
        );
        let section = parse_codex_sandbox_settings(
            "[approval_policy.granular]\nsandbox_approval = true\nrules = false\n\
             skill_approval = true\nrequest_permissions = false\nmcp_elicitations = true\n",
        );
        for s in [inline, section] {
            assert!(s.approval_policy.is_none(), "granular is not a string form");
            let g = s.granular.expect("granular table");
            assert!(g.sandbox_approval && g.skill_approval && g.mcp_elicitations);
            assert!(!g.rules && !g.request_permissions);
        }
    }

    #[test]
    fn parse_codex_sandbox_settings_reads_workspace_write_group() {
        let s = parse_codex_sandbox_settings(
            "sandbox_mode = \"workspace-write\"\n\n[sandbox_workspace_write]\n\
             writable_roots = [\"/srv/one\", \"/srv/two\"]\nnetwork_access = true\n\
             exclude_slash_tmp = true\n",
        );
        assert_eq!(s.workspace_write.writable_roots, ["/srv/one", "/srv/two"]);
        assert!(s.workspace_write.network_access);
        assert!(s.workspace_write.exclude_slash_tmp);
        assert!(!s.workspace_write.exclude_tmpdir_env_var);
    }

    #[test]
    fn parse_codex_sandbox_settings_flags_profile_shadowing() {
        // `default_permissions` makes codex resolve permissions through the
        // profile pipeline and ignore `sandbox_mode` entirely — verified live:
        // `:read-only` + `danger-full-access` yields a read-only sandbox.
        let s = parse_codex_sandbox_settings(
            "sandbox_mode = \"danger-full-access\"\ndefault_permissions = \":read-only\"\n\n\
             [permissions.tight]\nfile_system = \"restricted\"\n",
        );
        assert!(s.shadowed_by_default_permissions);
        assert!(s.has_permissions_table);
    }

    #[test]
    fn parse_codex_sandbox_settings_ignores_unknown_values_and_bad_toml() {
        let unknown = parse_codex_sandbox_settings(
            "approval_policy = \"yolo\"\nsandbox_mode = \"wide-open\"\n",
        );
        assert!(unknown.approval_policy.is_none());
        assert!(unknown.sandbox_mode.is_none());
        let broken = parse_codex_sandbox_settings("== not toml ==");
        assert!(broken.sandbox_mode.is_none());
    }

    /// Set a field: `Some(Some(v))`. Clear it: `Some(None)`. Leave it exactly as
    /// the base has it: `None` (the struct default).
    fn set<T>(value: T) -> Option<Option<T>> {
        Some(Some(value))
    }

    #[test]
    fn apply_codex_sandbox_config_writes_and_preserves_unmanaged_keys() {
        let base = "# keep me\nmodel = \"gpt-5\"\n\n[features]\nskills = true\n";
        let merged = apply_codex_sandbox_config(
            base,
            &CodexSandboxStructuredConfig {
                approval_policy: set("never".into()),
                sandbox_mode: set("workspace-write".into()),
                writable_roots: Some(vec!["/srv/extra".into()]),
                network_access: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(merged.contains("# keep me"), "comments survive");
        assert!(merged.contains("model = \"gpt-5\""));
        assert!(merged.contains("skills = true"));
        let back = parse_codex_sandbox_settings(&merged);
        assert_eq!(back.approval_policy.as_deref(), Some("never"));
        assert_eq!(back.sandbox_mode.as_deref(), Some("workspace-write"));
        assert_eq!(back.workspace_write.writable_roots, ["/srv/extra"]);
        assert!(back.workspace_write.network_access);
    }

    #[test]
    fn apply_codex_sandbox_config_writes_all_five_granular_keys() {
        // `sandbox_approval`, `rules` and `mcp_elicitations` have no upstream
        // default: a partial table makes codex refuse to load config.toml
        // ("missing field `sandbox_approval`"), so all five are always written.
        let merged = apply_codex_sandbox_config(
            "",
            &CodexSandboxStructuredConfig {
                granular: set(CodexGranularApproval {
                    sandbox_approval: true,
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .unwrap();
        for key in [
            "sandbox_approval",
            "rules",
            "skill_approval",
            "request_permissions",
            "mcp_elicitations",
        ] {
            assert!(merged.contains(key), "granular table must carry {key}");
        }
        assert!(parse_codex_sandbox_settings(&merged).granular.is_some());
    }

    #[test]
    fn apply_codex_sandbox_config_switches_granular_back_to_a_preset() {
        // The string form must REPLACE the table; an emptied `[approval_policy]`
        // would fail to deserialize as the externally tagged enum.
        let base = "[approval_policy.granular]\nsandbox_approval = true\nrules = true\n\
                    skill_approval = false\nrequest_permissions = false\nmcp_elicitations = true\n";
        let merged = apply_codex_sandbox_config(
            base,
            &CodexSandboxStructuredConfig {
                approval_policy: set("on-request".into()),
                granular: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        let back = parse_codex_sandbox_settings(&merged);
        assert_eq!(back.approval_policy.as_deref(), Some("on-request"));
        assert!(back.granular.is_none(), "the granular table is gone");
        assert!(!merged.contains("sandbox_approval"));
    }

    #[test]
    fn apply_codex_sandbox_config_keeps_root_keys_out_of_existing_tables() {
        // TOML positioning guard: a root scalar or the `[approval_policy]`
        // granular table must not be emitted AFTER an existing section, which
        // would silently reparent unrelated root keys into that section.
        let base = "model = \"gpt-5\"\nmodel_provider = \"codeg\"\n\n\
                    [features]\nskills = true\n\n\
                    [mcp_servers.ctx]\ncommand = \"npx\"\n";
        let merged = apply_codex_sandbox_config(
            base,
            &CodexSandboxStructuredConfig {
                granular: set(CodexGranularApproval {
                    sandbox_approval: true,
                    rules: true,
                    ..Default::default()
                }),
                sandbox_mode: set("workspace-write".into()),
                network_access: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let table = merged
            .parse::<toml::Table>()
            .expect("merged config must stay valid TOML");
        assert_eq!(
            table.get("model").and_then(toml::Value::as_str),
            Some("gpt-5"),
            "root keys must stay at the root"
        );
        assert_eq!(
            table.get("model_provider").and_then(toml::Value::as_str),
            Some("codeg")
        );
        assert_eq!(
            table
                .get("features")
                .and_then(toml::Value::as_table)
                .and_then(|t| t.get("skills"))
                .and_then(toml::Value::as_bool),
            Some(true),
            "unmanaged sections keep their own keys"
        );
        assert!(table.get("mcp_servers").is_some());
        let back = parse_codex_sandbox_settings(&merged);
        assert!(back.granular.is_some());
        assert_eq!(back.sandbox_mode.as_deref(), Some("workspace-write"));
        assert!(back.workspace_write.network_access);
    }

    fn config_with_catalog_ref(value: &str) -> String {
        format!(
            "\
# my codex config
model = \"gw/x\"           # the model
model_catalog_json = \"{value}\"
model_provider = \"codeg\"

[model_providers.codeg]
base_url = \"https://example.test/v1\"
"
        )
    }

    #[test]
    fn remove_codex_catalog_key_is_format_preserving_and_no_op_when_absent() {
        let home = Path::new("/tmp/codeg-test-codex-home");
        let base = config_with_catalog_ref("codeg-model-catalog.json");
        let next = remove_codex_catalog_key(&base, home)
            .unwrap()
            .expect("codeg-owned key was present");
        assert!(!next.contains("model_catalog_json"));
        // Comments and every unmanaged key survive verbatim.
        assert!(next.contains("# my codex config"));
        assert!(next.contains("model = \"gw/x\"           # the model"));
        assert!(next.contains("[model_providers.codeg]"));
        assert!(next.contains("base_url = \"https://example.test/v1\""));
        // No key → no rewrite at all (callers skip the disk write).
        assert!(remove_codex_catalog_key(&next, home).unwrap().is_none());
        assert!(remove_codex_catalog_key("", home).unwrap().is_none());
    }

    /// The cleanup must only ever reclaim codeg's OWN generated file. A catalog
    /// the user wrote by hand (or typed into the advanced config.toml editor)
    /// reaches this path on every panel save — deleting its reference would
    /// silently orphan the user's models.
    #[test]
    fn remove_codex_catalog_key_preserves_user_owned_references() {
        let home = Path::new("/tmp/codeg-test-codex-home");
        for foreign in [
            "manual.json",
            "/abs/path/to/manual.json",
            "~/my-catalog.json",
            "nested/codeg-model-catalog.json",
            "  ",
        ] {
            let base = config_with_catalog_ref(foreign);
            assert!(
                remove_codex_catalog_key(&base, home).unwrap().is_none(),
                "must not touch a user-owned reference: {foreign}"
            );
        }
        // An absolute path naming codeg's own file IS codeg-owned.
        let abs = home
            .join(crate::acp::codex_model_catalog::CATALOG_REL)
            .to_string_lossy()
            .into_owned();
        assert!(is_codeg_owned_catalog_ref(&abs, home));
        assert!(is_codeg_owned_catalog_ref(
            crate::acp::codex_model_catalog::CATALOG_REL,
            home
        ));
        assert!(!is_codeg_owned_catalog_ref("manual.json", home));
    }

    #[test]
    fn apply_codex_sandbox_config_removes_keys_and_empty_section() {
        let base = "approval_policy = \"never\"\nsandbox_mode = \"danger-full-access\"\n\n\
                    [sandbox_workspace_write]\nnetwork_access = true\n\n\
                    [features]\nskills = true\n";
        let merged = apply_codex_sandbox_config(
            base,
            &CodexSandboxStructuredConfig {
                approval_policy: Some(None),
                granular: Some(None),
                sandbox_mode: Some(None),
                writable_roots: Some(vec![]),
                network_access: Some(false),
                exclude_tmpdir_env_var: Some(false),
                exclude_slash_tmp: Some(false),
            },
        )
        .unwrap();
        let back = parse_codex_sandbox_settings(&merged);
        assert!(back.approval_policy.is_none());
        assert!(back.sandbox_mode.is_none());
        assert!(
            !merged.contains("sandbox_workspace_write"),
            "empty section removed"
        );
        assert!(merged.contains("skills = true"), "other sections untouched");
    }

    #[test]
    fn apply_codex_sandbox_config_leaves_absent_fields_untouched() {
        // The core of the patch contract. The settings panel sends the raw
        // config.toml text alongside this patch and the patch wins, so a field
        // the user did not move must not be written from the panel's (possibly
        // stale) view — otherwise a hand-edit in the raw editor gets reverted.
        let base = "approval_policy = \"never\"\nsandbox_mode = \"read-only\"\n\n\
                    [sandbox_workspace_write]\nwritable_roots = [\"/srv/keep\"]\n\
                    network_access = true\nexclude_slash_tmp = true\n";
        let merged = apply_codex_sandbox_config(
            base,
            // Only the sandbox mode moved.
            &CodexSandboxStructuredConfig {
                sandbox_mode: set("workspace-write".into()),
                ..Default::default()
            },
        )
        .unwrap();
        let back = parse_codex_sandbox_settings(&merged);
        assert_eq!(back.sandbox_mode.as_deref(), Some("workspace-write"));
        assert_eq!(
            back.approval_policy.as_deref(),
            Some("never"),
            "an untouched approval must survive the patch"
        );
        assert_eq!(back.workspace_write.writable_roots, ["/srv/keep"]);
        assert!(back.workspace_write.network_access);
        assert!(back.workspace_write.exclude_slash_tmp);
    }

    #[test]
    fn apply_codex_sandbox_config_empty_patch_is_a_no_op() {
        let base = "model = \"gpt-5\"\nsandbox_mode = \"read-only\"\n\n\
                    [approval_policy.granular]\nsandbox_approval = true\nrules = true\n\
                    skill_approval = false\nrequest_permissions = false\n\
                    mcp_elicitations = true\n\n\
                    [sandbox_workspace_write]\nnetwork_access = true\n";
        // An all-absent patch must not touch a single key.
        let merged =
            apply_codex_sandbox_config(base, &CodexSandboxStructuredConfig::default()).unwrap();
        assert_eq!(merged.trim(), base.trim());
    }

    #[test]
    fn apply_codex_sandbox_config_partial_workspace_write_patch() {
        // Toggling one flag must not disturb its siblings or the roots list.
        let base = "[sandbox_workspace_write]\nwritable_roots = [\"/srv/keep\"]\n\
                    network_access = true\n";
        let merged = apply_codex_sandbox_config(
            base,
            &CodexSandboxStructuredConfig {
                exclude_slash_tmp: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let back = parse_codex_sandbox_settings(&merged);
        assert_eq!(back.workspace_write.writable_roots, ["/srv/keep"]);
        assert!(back.workspace_write.network_access);
        assert!(back.workspace_write.exclude_slash_tmp);

        // Clearing the last remaining key drops the now-bare section header.
        let emptied = apply_codex_sandbox_config(
            "[sandbox_workspace_write]\nnetwork_access = true\n",
            &CodexSandboxStructuredConfig {
                network_access: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!emptied.contains("sandbox_workspace_write"));
    }

    #[test]
    fn apply_codex_sandbox_config_rejects_bad_input() {
        // Relative writable_roots are NOT rejected by codex — they resolve
        // against CODEX_HOME ("rel/dir" → ~/.codex/rel/dir), silently granting
        // write access somewhere the user never meant. So codeg rejects them.
        assert!(apply_codex_sandbox_config(
            "",
            &CodexSandboxStructuredConfig {
                writable_roots: Some(vec!["rel/dir".into()]),
                ..Default::default()
            }
        )
        .is_err());
        assert!(apply_codex_sandbox_config(
            "",
            &CodexSandboxStructuredConfig {
                sandbox_mode: set("wide-open".into()),
                ..Default::default()
            }
        )
        .is_err());
        assert!(
            apply_codex_sandbox_config(
                "",
                &CodexSandboxStructuredConfig {
                    approval_policy: set("never".into()),
                    granular: set(CodexGranularApproval::default()),
                    ..Default::default()
                }
            )
            .is_err(),
            "a string and a granular table cannot coexist"
        );
        assert!(
            apply_codex_sandbox_config("== not toml ==", &CodexSandboxStructuredConfig::default())
                .is_err(),
            "a malformed base must error, never silently overwrite the user's config"
        );
    }

    #[test]
    fn apply_codex_sandbox_config_accepts_windows_absolute_roots() {
        let merged = apply_codex_sandbox_config(
            "",
            &CodexSandboxStructuredConfig {
                writable_roots: Some(vec!["C:\\work\\repo".into(), "\\\\srv\\share".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            parse_codex_sandbox_settings(&merged)
                .workspace_write
                .writable_roots
                .len(),
            2
        );
    }

    #[test]
    fn codex_projection_folds_sandbox_keys_for_the_fingerprint() {
        // These keys only take effect at `thread/start`, so a running session
        // must be marked restart-required when they change; the projection is
        // what `fingerprint_config` hashes.
        let plain = codex_config_projection_from_toml("model = \"gpt-5\"\n");
        assert!(!plain.contains_key("sandboxMode"));
        assert!(!plain.contains_key("sandboxWorkspaceWrite"));
        let with_sandbox = codex_config_projection_from_toml(
            "model = \"gpt-5\"\napproval_policy = \"never\"\n\
             sandbox_mode = \"workspace-write\"\n\n\
             [sandbox_workspace_write]\nnetwork_access = true\n",
        );
        assert_eq!(
            with_sandbox.get("approvalPolicy").and_then(|v| v.as_str()),
            Some("never")
        );
        assert_eq!(
            with_sandbox.get("sandboxMode").and_then(|v| v.as_str()),
            Some("workspace-write")
        );
        assert!(with_sandbox.contains_key("sandboxWorkspaceWrite"));
        assert_ne!(plain, with_sandbox, "the fingerprint input must change");
    }

    #[test]
    fn codex_projection_folds_default_mode_request_user_input() {
        // Feature flags resolve at thread creation, so turning questions on in
        // Default mode must mark running sessions restart-required.
        let base = "model = \"gpt-5\"\n";
        let plain = codex_config_projection_from_toml(base);
        assert!(!plain.contains_key("defaultModeRequestUserInput"));

        let on = codex_config_projection_from_toml(
            "model = \"gpt-5\"\n\n[features]\ndefault_mode_request_user_input = true\n",
        );
        assert_eq!(
            on.get("defaultModeRequestUserInput")
                .and_then(serde_json::Value::as_bool),
            Some(true)
        );
        assert_ne!(plain, on, "the fingerprint input must change");

        // Explicit `false` IS codex's default, so it must hash identically to
        // an untouched config — otherwise flipping the switch on and back off
        // would leave every running session falsely marked restart-required.
        let off = codex_config_projection_from_toml(
            "model = \"gpt-5\"\n\n[features]\ndefault_mode_request_user_input = false\n",
        );
        assert_eq!(plain, off);

        // Other `[features]` keys are not projected, and must not be mistaken
        // for this one.
        let other = codex_config_projection_from_toml(
            "model = \"gpt-5\"\n\n[features]\nskills = true\n",
        );
        assert_eq!(plain, other);
    }

    #[test]
    fn parse_grok_settings_reads_custom_model_and_session() {
        let toml = "[model.foo]\nmodel = \"foo\"\nbase_url = \"https://api/v1\"\n\
                    api_key = \"sk-1\"\napi_backend = \"responses\"\ncontext_window = 262144\n\n\
                    [models]\ndefault = \"foo\"\n\n\
                    [session]\nauto_compact_threshold_percent = 90\n";
        let s = parse_grok_settings(toml);
        assert_eq!(s.custom_model_id.as_deref(), Some("foo"));
        assert_eq!(s.custom_base_url.as_deref(), Some("https://api/v1"));
        assert_eq!(s.custom_api_key.as_deref(), Some("sk-1"));
        assert_eq!(s.custom_api_backend.as_deref(), Some("responses"));
        assert_eq!(s.custom_context_window, Some(262144));
        assert_eq!(s.auto_compact_threshold_percent, Some(90));
    }

    #[test]
    fn parse_grok_settings_untracks_default_without_model_block() {
        // `[models].default` naming a stock model (no `[model.*]` block) is not a
        // codeg-managed custom model — the panel must show the custom fields empty.
        let toml = "[model.foo]\nbase_url = \"x\"\n\n[models]\ndefault = \"grok-4.5\"\n";
        let s = parse_grok_settings(toml);
        assert!(s.custom_model_id.is_none());
        assert!(s.custom_base_url.is_none());
    }

    #[test]
    fn apply_grok_custom_model_round_trips_through_parse() {
        let merged = apply_grok_structured_config(
            "",
            &GrokStructuredConfig {
                custom_model_id: Some("my-grok".into()),
                custom_base_url: Some("https://gw/v1".into()),
                custom_api_key: Some("sk-x".into()),
                custom_api_backend: Some("responses".into()),
                custom_context_window: Some(131072),
                auto_compact_threshold_percent: Some(80),
                ..Default::default()
            },
        )
        .unwrap();
        // The model becomes the default, and the block carries `model = <id>`.
        assert!(merged.contains("[model.my-grok]") || merged.contains("[model.\"my-grok\"]"));
        assert!(merged.contains("model = \"my-grok\""));
        let back = parse_grok_settings(&merged);
        assert_eq!(back.custom_model_id.as_deref(), Some("my-grok"));
        assert_eq!(back.custom_base_url.as_deref(), Some("https://gw/v1"));
        assert_eq!(back.custom_api_key.as_deref(), Some("sk-x"));
        assert_eq!(back.custom_api_backend.as_deref(), Some("responses"));
        assert_eq!(back.custom_context_window, Some(131072));
        assert_eq!(back.auto_compact_threshold_percent, Some(80));
    }

    #[test]
    fn apply_grok_custom_model_empty_base_url_omits_key() {
        // "Leave empty ⇒ official endpoint": no `base_url` key is written.
        let merged = apply_grok_structured_config(
            "",
            &GrokStructuredConfig {
                custom_model_id: Some("foo".into()),
                custom_base_url: Some("   ".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!merged.contains("base_url"), "empty base_url must omit the key");
        let back = parse_grok_settings(&merged);
        assert_eq!(back.custom_model_id.as_deref(), Some("foo"));
        assert!(back.custom_base_url.is_none());
    }

    #[test]
    fn apply_grok_custom_model_non_positive_context_window_omitted() {
        let merged = apply_grok_structured_config(
            "",
            &GrokStructuredConfig {
                custom_model_id: Some("foo".into()),
                custom_context_window: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!merged.contains("context_window"));
        assert!(parse_grok_settings(&merged).custom_context_window.is_none());
    }

    #[test]
    fn apply_grok_custom_model_rename_moves_block() {
        let base = "[model.old]\nmodel = \"old\"\nbase_url = \"https://old/v1\"\n\n\
                    [models]\ndefault = \"old\"\n";
        let merged = apply_grok_structured_config(
            base,
            &GrokStructuredConfig {
                custom_model_id: Some("new".into()),
                custom_base_url: Some("https://new/v1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(!merged.contains("old"), "the stale block + default must be gone");
        let back = parse_grok_settings(&merged);
        assert_eq!(back.custom_model_id.as_deref(), Some("new"));
        assert_eq!(back.custom_base_url.as_deref(), Some("https://new/v1"));
    }

    #[test]
    fn apply_grok_custom_model_update_preserves_unmanaged_block_keys() {
        // Editing a managed block keeps keys codeg doesn't own (e.g. temperature).
        let base = "[model.foo]\nmodel = \"foo\"\ntemperature = 0.7\nbase_url = \"https://old/v1\"\n\n\
                    [models]\ndefault = \"foo\"\n";
        let merged = apply_grok_structured_config(
            base,
            &GrokStructuredConfig {
                custom_model_id: Some("foo".into()),
                custom_base_url: Some("https://new/v1".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(merged.contains("temperature"), "unmanaged key preserved");
        let back = parse_grok_settings(&merged);
        assert_eq!(back.custom_base_url.as_deref(), Some("https://new/v1"));
    }

    #[test]
    fn apply_grok_custom_model_clear_removes_managed_block_and_default() {
        let base = "[model.foo]\nmodel = \"foo\"\nbase_url = \"https://x/v1\"\n\n\
                    [models]\ndefault = \"foo\"\n";
        let merged =
            apply_grok_structured_config(base, &GrokStructuredConfig::default()).unwrap();
        assert!(!merged.contains("[model."), "managed block removed");
        let back = parse_grok_settings(&merged);
        assert!(back.custom_model_id.is_none());
    }

    #[test]
    fn apply_grok_custom_model_clear_leaves_handset_stock_default() {
        // Clearing the (empty) custom form must NOT delete a hand-set stock
        // `[models].default` that was never codeg-managed.
        let base = "[models]\ndefault = \"grok-4.5\"\n";
        let merged =
            apply_grok_structured_config(base, &GrokStructuredConfig::default()).unwrap();
        assert!(merged.contains("default = \"grok-4.5\""));
    }

    #[test]
    fn apply_grok_session_compaction_clamps_and_removes() {
        // Out-of-range value clamps into 0–100.
        let over = apply_grok_structured_config(
            "",
            &GrokStructuredConfig {
                auto_compact_threshold_percent: Some(150),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            parse_grok_settings(&over).auto_compact_threshold_percent,
            Some(100)
        );
        // `None` removes an existing key.
        let base = "[session]\nauto_compact_threshold_percent = 70\n";
        let cleared =
            apply_grok_structured_config(base, &GrokStructuredConfig::default()).unwrap();
        assert!(parse_grok_settings(&cleared)
            .auto_compact_threshold_percent
            .is_none());
    }

    #[test]
    fn grok_config_permission_mode_maps_to_launch_flag() {
        // Legacy always-approve → real bypassPermissions, passed as the flag.
        assert_eq!(
            grok_config_permission_mode("[ui]\npermission_mode = \"always-approve\"\n").as_deref(),
            Some("bypassPermissions")
        );
        // A real granular mode passes through.
        assert_eq!(
            grok_config_permission_mode("[ui]\npermission_mode = \"acceptEdits\"\n").as_deref(),
            Some("acceptEdits")
        );
        // `default` (grok's own default) and legacy `ask` keep the flag off so
        // ACP permission requests reach codeg's UI.
        assert!(grok_config_permission_mode("[ui]\npermission_mode = \"default\"\n").is_none());
        assert!(grok_config_permission_mode("[ui]\npermission_mode = \"ask\"\n").is_none());
        // Unset / malformed / unknown ⇒ no flag (preserve the ability to prompt).
        assert!(grok_config_permission_mode("").is_none());
        assert!(grok_config_permission_mode("== not toml ==").is_none());
        assert!(grok_config_permission_mode("[ui]\npermission_mode = \"bogus\"\n").is_none());
    }

    fn touch(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, "x").unwrap();
    }

    fn canonical_key(dir: &Path) -> String {
        pi_canonical_path(dir).to_string_lossy().to_string()
    }

    /// A `runtime_env` whose `PI_CODING_AGENT_DIR` points at `agent_dir`, so the
    /// launch gate reads a tempdir's `trust.json` instead of `~/.pi/agent`.
    fn pi_env_for(agent_dir: &Path) -> BTreeMap<String, String> {
        BTreeMap::from([(
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.to_string_lossy().to_string(),
        )])
    }

    fn resource_kinds(cwd: &Path) -> Vec<String> {
        pi_project_trust_resources(cwd)
            .into_iter()
            .map(|r| r.kind)
            .collect()
    }

    /// Every `.pi/*` entry pi gates behind project trust must be reported, so the
    /// approval UI can name what it is about to let the repo load.
    #[test]
    fn pi_trust_resources_detects_every_gated_pi_entry() {
        for entry in PI_TRUST_REQUIRING_CONFIG_RESOURCES {
            let tmp = tempfile::tempdir().expect("tempdir");
            let ws = tmp.path().join("ws");
            let target = ws.join(".pi").join(entry);
            // Directory-shaped entries and file-shaped ones both count.
            if entry.contains('.') {
                touch(&target);
            } else {
                fs::create_dir_all(&target).unwrap();
            }

            assert_eq!(
                resource_kinds(&ws),
                vec![format!(".pi/{entry}")],
                "`.pi/{entry}` must be reported as a trust-gated resource",
            );
        }
    }

    /// `.pi/extensions` are modules whose top level runs at pi startup, and
    /// `.pi/settings.json` can make pi install project packages. The approval UI
    /// leans on this flag to say "this executes code" instead of calling it all
    /// "config" — the exact confusion that produced the auto-trust bug.
    #[test]
    fn pi_trust_resources_flag_the_code_executing_kinds() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        touch(&ws.join(".pi").join("settings.json"));
        fs::create_dir_all(ws.join(".pi").join("prompts")).unwrap();

        let by_kind = pi_project_trust_resources(&ws)
            .into_iter()
            .map(|r| (r.kind, r.executes_code))
            .collect::<BTreeMap<_, _>>();

        assert_eq!(by_kind.get(".pi/extensions"), Some(&true));
        assert_eq!(by_kind.get(".pi/settings.json"), Some(&true));
        assert_eq!(by_kind.get(".pi/prompts"), Some(&false));
    }

    /// A bare `.pi/` directory is not a project resource for pi, so codeg must not
    /// prompt about it (`hasTrustRequiringProjectResources` ignores it too).
    #[test]
    fn pi_trust_resources_ignores_a_bare_pi_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(ws.join(".pi")).unwrap();

        assert!(pi_project_trust_resources(&ws).is_empty());
    }

    /// pi walks ancestors for `.agents/skills`, so a parent directory's store is
    /// gated for this workspace too.
    #[test]
    fn pi_trust_resources_walks_ancestors_for_agents_skills() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let parent = tmp.path().join("parent");
        let ws = parent.join("repo");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(parent.join(".agents").join("skills")).unwrap();

        assert_eq!(resource_kinds(&ws), vec![".agents/skills".to_string()]);
    }

    /// `~/.agents/skills` is the USER's own store, not a repo's — pi excludes it
    /// from the trust decision and so must codeg, or every workspace under $HOME
    /// would raise a bogus prompt.
    #[test]
    fn pi_trust_resources_excludes_the_user_agents_skills_store() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join("home");
        let ws = home.join("repo");
        fs::create_dir_all(&ws).unwrap();
        fs::create_dir_all(home.join(".agents").join("skills")).unwrap();

        // The home is injected rather than pinned through the env: on Windows
        // `dirs::home_dir()` resolves the `FOLDERID_Profile` known folder and
        // ignores `HOME`/`USERPROFILE`, so an env-pinned home would leave the real
        // profile as the exclusion and report the fixture's store.
        //
        // Scope the assertion to the fixture as well — the ancestor walk climbs out
        // of the tempdir into the machine's own directories, and on Windows the
        // tempdir sits under that very profile dir.
        let root = pi_canonical_path(tmp.path());
        let from_fixture = pi_project_trust_resources_with_home(&ws, &home)
            .into_iter()
            .map(|resource| resource.path)
            .filter(|path| Path::new(path).starts_with(&root))
            .collect::<Vec<_>>();

        assert!(
            from_fixture.is_empty(),
            "the user's own ~/.agents/skills must not count as a repo resource, got {from_fixture:?}",
        );
    }

    /// The decision for the exact folder wins.
    #[test]
    fn pi_nearest_trust_decision_reads_the_exact_folder() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&ws), serde_json::Value::Bool(false));
        write_json_object_pretty(&trust, &map).unwrap();

        assert_eq!(
            pi_nearest_trust_decision(&trust, &ws),
            Some((canonical_key(&ws), false)),
        );
    }

    /// Inheritance is the amplifier that made the old auto-seed so wide: one
    /// entry on a parent covers every repo beneath it, including repos cloned
    /// later. The UI has to be able to show that, so resolution must report the
    /// ancestor that actually decided.
    #[test]
    fn pi_nearest_trust_decision_inherits_from_an_ancestor() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let parent = tmp.path().join("projects");
        let ws = parent.join("cloned-later");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&parent), serde_json::Value::Bool(true));
        write_json_object_pretty(&trust, &map).unwrap();

        assert_eq!(
            pi_nearest_trust_decision(&trust, &ws),
            Some((canonical_key(&parent), true)),
            "the deciding ancestor must be reported, not the workspace itself",
        );
    }

    /// pi only honors real booleans; a `null` entry means "no decision here", so
    /// the walk continues to the ancestor rather than stopping.
    #[test]
    fn pi_nearest_trust_decision_skips_null_entries() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let parent = tmp.path().join("projects");
        let ws = parent.join("repo");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&ws), serde_json::Value::Null);
        map.insert(canonical_key(&parent), serde_json::Value::Bool(true));
        write_json_object_pretty(&trust, &map).unwrap();

        assert_eq!(
            pi_nearest_trust_decision(&trust, &ws),
            Some((canonical_key(&parent), true)),
        );
    }

    /// No file, or no matching entry, means nobody has decided — pi's own
    /// non-interactive default then applies and the resources stay unloaded.
    #[test]
    fn pi_nearest_trust_decision_is_none_without_a_match() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();

        assert_eq!(
            pi_nearest_trust_decision(&tmp.path().join("missing.json"), &ws),
            None,
        );
    }

    /// The launch path no longer writes trust, so the ONLY way a workspace becomes
    /// trusted is this explicit call. Both verdicts must be recordable — declining
    /// is a real answer, not just "don't write anything".
    #[test]
    fn pi_set_project_trust_records_either_verdict() {
        for verdict in [true, false] {
            let tmp = tempfile::tempdir().expect("tempdir");
            let ws = tmp.path().join("ws");
            fs::create_dir_all(&ws).unwrap();
            let trust = tmp.path().join("agent").join("trust.json");

            pi_write_trust_decision_at(&trust, &ws, Some(verdict)).unwrap();

            assert_eq!(
                read_json_object_or_empty(&trust).get(&canonical_key(&ws)),
                Some(&serde_json::Value::Bool(verdict)),
            );
        }
    }

    /// Revoking removes codeg's entry so the folder falls back to any ancestor
    /// decision and then to pi's default. Other users' decisions must survive.
    #[test]
    fn pi_set_project_trust_revoke_removes_only_our_entry() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&ws), serde_json::Value::Bool(true));
        map.insert("/some/other".to_string(), serde_json::Value::Bool(true));
        map.insert("/denied".to_string(), serde_json::Value::Bool(false));
        write_json_object_pretty(&trust, &map).unwrap();

        pi_write_trust_decision_at(&trust, &ws, None).unwrap();

        let after = read_json_object_or_empty(&trust);
        assert_eq!(after.get(&canonical_key(&ws)), None);
        assert_eq!(after.get("/some/other"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(after.get("/denied"), Some(&serde_json::Value::Bool(false)));
    }

    /// Revoking a folder we never wrote (the decision is inherited) must not
    /// create a trust file just to record an absence.
    #[test]
    fn pi_set_project_trust_revoke_is_a_noop_when_nothing_is_ours() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("agent").join("trust.json");

        pi_write_trust_decision_at(&trust, &ws, None).unwrap();

        assert!(!trust.exists());
    }

    /// Drive the launch gate with an isolated pi agent dir AND an isolated codeg
    /// home (the acknowledgement store lives there, via `CODEG_HOME`).
    fn launch_block_for(agent_dir: &Path, codeg_home: &Path, cwd: &Path) -> Option<String> {
        temp_env::with_var(
            "CODEG_HOME",
            Some(codeg_home.to_string_lossy().to_string()),
            || pi_project_trust_launch_block(cwd, &pi_env_for(agent_dir)),
        )
    }

    /// Build a workspace shipping `.pi/extensions`, with `trust.json` saying what
    /// `decision` says about the exact folder.
    fn gated_workspace(tmp: &Path, decision: Option<bool>) -> (PathBuf, PathBuf, PathBuf) {
        let ws = tmp.join("ws");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        let agent_dir = tmp.join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        if let Some(verdict) = decision {
            let mut map = serde_json::Map::new();
            map.insert(canonical_key(&ws), serde_json::Value::Bool(verdict));
            write_json_object_pretty(&agent_dir.join("trust.json"), &map).unwrap();
        }
        (ws, agent_dir, tmp.join("codeg-home"))
    }

    /// THE regression this whole change exists for on an upgraded install: pi
    /// executes `.pi/extensions` at startup, so a grant nobody here confirmed —
    /// written by the build that auto-trusted every opened folder — must stop the
    /// launch. A notice shown after connecting would arrive after the code ran.
    #[test]
    fn pi_launch_is_blocked_by_an_unacknowledged_grant() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (ws, agent_dir, home) = gated_workspace(tmp.path(), Some(true));

        let blocked = launch_block_for(&agent_dir, &home, &ws);

        assert!(blocked.is_some(), "an unconfirmed grant must not launch pi");
        assert!(blocked.unwrap().contains(".pi/extensions"));
    }

    /// The same grant inherited from a parent — the shape that covers a repo
    /// cloned into a previously-opened folder long after it was seeded, which is
    /// the case a per-folder check alone would miss entirely.
    #[test]
    fn pi_launch_is_blocked_by_an_unacknowledged_ancestor_grant() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let parent = tmp.path().join("projects");
        let ws = parent.join("cloned-later");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        let agent_dir = tmp.path().join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&parent), serde_json::Value::Bool(true));
        write_json_object_pretty(&agent_dir.join("trust.json"), &map).unwrap();

        let blocked = launch_block_for(&agent_dir, &tmp.path().join("codeg-home"), &ws);

        assert!(blocked.is_some());
        assert!(
            blocked.unwrap().contains("parent folder"),
            "the message must name the inherited grant, not imply this folder was approved",
        );
    }

    /// Once the user answers for the folder, it launches. Acknowledging records
    /// only codeg's confirmation — pi's own grant is untouched.
    #[test]
    fn pi_launch_proceeds_after_the_grant_is_acknowledged() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let (ws, agent_dir, home) = gated_workspace(tmp.path(), Some(true));
        let trust_before = fs::read_to_string(agent_dir.join("trust.json")).unwrap();

        pi_set_trust_acknowledged_at(&home.join("pi-project-trust-ack.json"), &ws, true).unwrap();

        assert_eq!(launch_block_for(&agent_dir, &home, &ws), None);
        assert_eq!(
            fs::read_to_string(agent_dir.join("trust.json")).unwrap(),
            trust_before,
            "acknowledging must not change pi's own trust store",
        );
    }

    /// Nothing to confirm: with no decision, or a declined one, pi already skips
    /// the resources, so blocking would be pure friction.
    #[test]
    fn pi_launch_proceeds_when_no_grant_is_in_force() {
        let tmp = tempfile::tempdir().expect("tempdir");
        for decision in [None, Some(false)] {
            let sub = tmp.path().join(format!("case{decision:?}"));
            fs::create_dir_all(&sub).unwrap();
            let (ws, agent_dir, home) = gated_workspace(&sub, decision);
            assert_eq!(
                launch_block_for(&agent_dir, &home, &ws),
                None,
                "decision {decision:?} must not block the launch",
            );
        }
    }

    /// A repo that ships nothing trust-gated is never blocked, however the folder
    /// came to be trusted — there is nothing for the grant to load.
    #[test]
    fn pi_launch_proceeds_when_the_repo_ships_no_resources() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("plain");
        fs::create_dir_all(&ws).unwrap();
        let agent_dir = tmp.path().join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        let mut map = serde_json::Map::new();
        map.insert(canonical_key(&ws), serde_json::Value::Bool(true));
        write_json_object_pretty(&agent_dir.join("trust.json"), &map).unwrap();

        assert_eq!(
            launch_block_for(&agent_dir, &tmp.path().join("codeg-home"), &ws),
            None,
        );
    }

    /// Revoking must drop the confirmation too, or re-granting later would ride
    /// on a stale "already seen" and skip the disclosure.
    #[test]
    fn pi_trust_acknowledgement_round_trips_and_clears() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let ack = tmp.path().join("ack.json");

        assert!(!pi_trust_is_acknowledged_at(&ack, &canonical_key(&ws)));
        pi_set_trust_acknowledged_at(&ack, &ws, true).unwrap();
        assert!(pi_trust_is_acknowledged_at(&ack, &canonical_key(&ws)));
        pi_set_trust_acknowledged_at(&ack, &ws, false).unwrap();
        assert!(!pi_trust_is_acknowledged_at(&ack, &canonical_key(&ws)));
    }

    /// The write is a read-modify-write, and two codeg surfaces (the approval
    /// banner and the settings list's revoke buttons) can fire at once. Without
    /// serialization each writer would persist the map it read, so the last one
    /// to land silently drops every entry added since it read — losing a grant
    /// the user just made, or resurrecting one they just revoked.
    #[test]
    fn pi_trust_concurrent_writes_do_not_lose_entries() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trust = tmp.path().join("agent").join("trust.json");

        let workspaces: Vec<PathBuf> = (0..8)
            .map(|i| {
                let ws = tmp.path().join(format!("ws{i}"));
                fs::create_dir_all(&ws).unwrap();
                ws
            })
            .collect();

        std::thread::scope(|scope| {
            for ws in &workspaces {
                let trust = trust.clone();
                scope.spawn(move || {
                    pi_write_trust_decision_at(&trust, ws, Some(true)).expect("write");
                });
            }
        });

        // Every writer's entry survived, and the file is still parseable JSON —
        // interleaved truncating writes would corrupt it.
        let map = read_json_object_or_empty(&trust);
        assert_eq!(map.len(), workspaces.len(), "an entry was lost: {map:?}");
        for ws in &workspaces {
            assert_eq!(
                map.get(&canonical_key(ws)),
                Some(&serde_json::Value::Bool(true)),
            );
        }
    }

    /// The lock must not outlive the operation, or the next decision — from codeg
    /// or from pi, which takes the same lock — would stall until it goes stale.
    #[test]
    fn pi_trust_write_releases_the_lock() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("agent").join("trust.json");

        pi_write_trust_decision_at(&trust, &ws, Some(true)).unwrap();

        assert!(
            !tmp.path().join("agent").join("trust.json.lock").exists(),
            "the lock directory must be released when the write finishes",
        );
    }

    /// pi holds this same lock while it reads or writes its store. When it is
    /// held, codeg must back off and report it rather than write anyway — writing
    /// through the lock is exactly the interleaving the lock exists to prevent.
    #[test]
    fn pi_trust_write_defers_to_a_lock_held_by_pi() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let agent_dir = tmp.path().join("agent");
        fs::create_dir_all(&agent_dir).unwrap();
        let trust = agent_dir.join("trust.json");
        fs::write(&trust, "{}\n").unwrap();
        // Fresh (non-stale) lock, exactly as `proper-lockfile` leaves it.
        fs::create_dir(agent_dir.join("trust.json.lock")).unwrap();

        let err = pi_write_trust_decision_at(&trust, &ws, Some(true)).unwrap_err();

        assert!(err.to_string().contains("locked by another process"));
        assert_eq!(
            fs::read_to_string(&trust).unwrap(),
            "{}\n",
            "a contended write must leave the store untouched",
        );
    }

    /// A lock orphaned by a crash must not wedge project trust forever — pi
    /// breaks the same tie by age, so codeg has to agree on when to steal it.
    #[test]
    fn pi_trust_lock_missing_or_unreadable_counts_as_stale() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(pi_trust_lock_is_stale(&tmp.path().join("nonexistent.lock")));
        // A lock created just now is live, so it is honored rather than stolen.
        let fresh = tmp.path().join("fresh.lock");
        fs::create_dir(&fresh).unwrap();
        assert!(!pi_trust_lock_is_stale(&fresh));
    }

    /// `trust.json` holds decisions the user made inside pi. If codeg can't parse
    /// it, it must refuse loudly rather than rewrite the file from scratch.
    #[test]
    fn pi_set_project_trust_never_clobbers_an_unparseable_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(&ws).unwrap();
        let trust = tmp.path().join("trust.json");
        fs::write(&trust, "not json at all").unwrap();

        let err = pi_write_trust_decision_at(&trust, &ws, Some(true)).unwrap_err();

        assert!(err.to_string().contains("not a JSON object"));
        assert_eq!(fs::read_to_string(&trust).unwrap(), "not json at all");
    }

    /// The settings list surfaces decisions for review/revoke — including ones an
    /// older codeg auto-seeded. `null` entries carry no decision, so they are not
    /// listed.
    #[test]
    fn pi_trust_entries_lists_decisions_sorted_and_skips_nulls() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let trust = tmp.path().join("trust.json");
        let mut map = serde_json::Map::new();
        map.insert("/b/repo".to_string(), serde_json::Value::Bool(true));
        map.insert("/a/repo".to_string(), serde_json::Value::Bool(false));
        map.insert("/c/repo".to_string(), serde_json::Value::Null);
        write_json_object_pretty(&trust, &map).unwrap();

        let entries = pi_trust_entries_at(&trust);

        assert_eq!(
            entries
                .iter()
                .map(|e| (e.path.as_str(), e.trusted))
                .collect::<Vec<_>>(),
            vec![("/a/repo", false), ("/b/repo", true)],
        );
    }

    /// End-to-end shape of what the banner reads: a repo that ships an extension,
    /// with nobody having decided yet, is exactly the case that must prompt.
    #[test]
    fn pi_project_trust_state_reports_undecided_repo_resources() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(ws.join(".pi").join("extensions")).unwrap();
        let trust = tmp.path().join("trust.json");

        let state = pi_project_trust_state_at(&trust, &tmp.path().join("ack.json"), &ws);

        assert_eq!(state.decision, None, "nobody has decided yet");
        assert_eq!(state.decided_at, None);
        assert!(!state.acknowledged);
        assert_eq!(
            state.resources.iter().map(|r| &r.kind).collect::<Vec<_>>(),
            vec![".pi/extensions"],
        );
        assert!(state.resources[0].executes_code);
        assert_eq!(state.workspace, canonical_key(&ws));
    }

    // --- pi models.json: the per-model reasoning declaration -----------------
    //
    // A custom model written without `reasoning` gets `reasoning: false` from pi,
    // which collapses its thinking vocabulary to `["off"]` — every level the
    // composer sends is clamped straight back and the picker looks broken. These
    // pin the shape pi actually reads.

    fn pi_reasoning_spec(
        reasoning: bool,
        map: &[(&str, Option<&str>)],
    ) -> PiModelReasoningSpec {
        PiModelReasoningSpec {
            reasoning,
            thinking_level_map: map
                .iter()
                .map(|(level, wire)| (level.to_string(), wire.map(str::to_string)))
                .collect(),
        }
    }

    fn pi_models_of(entry: &serde_json::Map<String, serde_json::Value>) -> Vec<serde_json::Value> {
        entry
            .get("models")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default()
    }

    #[test]
    fn pi_custom_model_adds_a_missing_model_with_its_declaration() {
        let mut entry = serde_json::Map::new();

        apply_pi_custom_model(
            &mut entry,
            "gpt-5.6-sol",
            Some(&pi_reasoning_spec(
                true,
                &[("off", Some("none")), ("minimal", None), ("xhigh", Some("xhigh"))],
            )),
        );

        let models = pi_models_of(&entry);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "gpt-5.6-sol");
        assert_eq!(models[0]["name"], "gpt-5.6-sol");
        assert_eq!(models[0]["reasoning"], true);
        assert_eq!(models[0]["thinkingLevelMap"]["off"], "none");
        assert!(models[0]["thinkingLevelMap"]["minimal"].is_null());
        assert_eq!(models[0]["thinkingLevelMap"]["xhigh"], "xhigh");
    }

    /// The older writer skipped an already-listed model entirely, so a declaration
    /// could never reach one. Upserting must still leave every field the form has
    /// no opinion about — including a renamed `name` — exactly as the user left it.
    #[test]
    fn pi_custom_model_upserts_without_clobbering_hand_tuned_fields() {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "models".to_string(),
            serde_json::json!([
                { "id": "other", "name": "Other" },
                {
                    "id": "gpt-5.6-sol",
                    "name": "My renamed model",
                    "contextWindow": 400000,
                    "cost": { "input": 5, "output": 30, "cacheRead": 0.5, "cacheWrite": 0 },
                    "compat": { "some": "knob" },
                },
            ]),
        );

        apply_pi_custom_model(
            &mut entry,
            "gpt-5.6-sol",
            Some(&pi_reasoning_spec(true, &[("off", Some("none"))])),
        );

        let models = pi_models_of(&entry);
        assert_eq!(models.len(), 2, "no duplicate entry for the same id");
        let target = models
            .iter()
            .find(|m| m["id"] == "gpt-5.6-sol")
            .expect("model kept");
        assert_eq!(target["name"], "My renamed model");
        assert_eq!(target["contextWindow"], 400000);
        assert_eq!(target["cost"]["input"], 5);
        assert_eq!(target["compat"]["some"], "knob");
        assert_eq!(target["reasoning"], true);
        assert_eq!(models[0]["id"], "other", "untouched sibling stays put");
    }

    /// Turning the switch off only flips the flag: the level selection stays on
    /// disk so re-enabling restores it instead of making the user re-pick.
    #[test]
    fn pi_custom_model_disabling_reasoning_keeps_the_level_map() {
        let mut entry = serde_json::Map::new();
        apply_pi_custom_model(
            &mut entry,
            "m",
            Some(&pi_reasoning_spec(true, &[("minimal", None)])),
        );

        apply_pi_custom_model(
            &mut entry,
            "m",
            Some(&pi_reasoning_spec(false, &[("minimal", None)])),
        );

        let models = pi_models_of(&entry);
        assert_eq!(models[0]["reasoning"], false);
        assert!(models[0]["thinkingLevelMap"]["minimal"].is_null());
    }

    /// `{}` would read as a declaration that constrains nothing; drop the key so
    /// pi falls back to its own defaults.
    #[test]
    fn pi_custom_model_drops_an_empty_level_map() {
        let mut entry = serde_json::Map::new();
        apply_pi_custom_model(
            &mut entry,
            "m",
            Some(&pi_reasoning_spec(true, &[("low", Some("LOW"))])),
        );

        apply_pi_custom_model(&mut entry, "m", Some(&pi_reasoning_spec(true, &[])));

        let models = pi_models_of(&entry);
        assert!(models[0].get("thinkingLevelMap").is_none());
    }

    /// pi-acp rejects a level name outside pi's fixed six with `invalidParams`, so
    /// one must never reach disk.
    #[test]
    fn pi_custom_model_filters_levels_pi_does_not_know() {
        let mut entry = serde_json::Map::new();

        apply_pi_custom_model(
            &mut entry,
            "m",
            Some(&pi_reasoning_spec(
                true,
                &[("ultra", Some("ultra")), ("high", Some("high"))],
            )),
        );

        let models = pi_models_of(&entry);
        let map = models[0]["thinkingLevelMap"].as_object().unwrap();
        assert!(!map.contains_key("ultra"));
        assert_eq!(map["high"], "high");
    }

    /// Built-in providers (and any client that predates the control) send no spec.
    /// That must not erase a declaration already on disk.
    #[test]
    fn pi_custom_model_without_a_spec_leaves_the_declaration_alone() {
        let mut entry = serde_json::Map::new();
        entry.insert(
            "models".to_string(),
            serde_json::json!([
                { "id": "m", "name": "m", "reasoning": true,
                  "thinkingLevelMap": { "off": "none" } },
            ]),
        );

        apply_pi_custom_model(&mut entry, "m", None);

        let models = pi_models_of(&entry);
        assert_eq!(models[0]["reasoning"], true);
        assert_eq!(models[0]["thinkingLevelMap"]["off"], "none");
    }

    /// What the writer emits has to survive the read the panel rehydrates from,
    /// or reopening the settings would show the wrong chips.
    #[test]
    fn pi_custom_models_projection_reads_back_what_was_written() {
        let mut entry = serde_json::Map::new();
        apply_pi_custom_model(
            &mut entry,
            "gpt-5.6-sol",
            Some(&pi_reasoning_spec(
                true,
                &[("off", Some("none")), ("minimal", None), ("low", Some("LOW"))],
            )),
        );

        let models = pi_custom_models_from_entry(&serde_json::Value::Object(entry));

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-5.6-sol");
        assert_eq!(models[0].reasoning, Some(true));
        assert_eq!(models[0].thinking_level_map["off"], Some("none".to_string()));
        assert_eq!(models[0].thinking_level_map["minimal"], None);
        assert_eq!(models[0].thinking_level_map["low"], Some("LOW".to_string()));
    }

    /// A model with no `reasoning` key must project as `None`, not `Some(false)` —
    /// the panel distinguishes "never declared" from "declared off".
    #[test]
    fn pi_custom_models_projection_keeps_an_undeclared_model_undeclared() {
        let entry = serde_json::json!({
            "models": [
                { "id": "b", "name": "b" },
                { "id": "a", "name": "a", "thinkingLevelMap": { "low": 7 } },
                { "name": "no id at all" },
            ]
        });

        let models = pi_custom_models_from_entry(&entry);

        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b"],
            "sorted by id, entries without one skipped"
        );
        assert_eq!(models[0].reasoning, None);
        assert!(
            models[0].thinking_level_map.is_empty(),
            "a non-string, non-null wire value is dropped rather than guessed at"
        );
    }

    /// End to end through the files pi actually reads: the panel's rehydrate path
    /// must find the declaration under the provider it was saved to.
    #[test]
    fn load_pi_config_projects_custom_provider_models() {
        let tmp = tempfile::tempdir().expect("tempdir");
        temp_env::with_var("PI_CODING_AGENT_DIR", Some(tmp.path()), || {
            fs::write(
                tmp.path().join("settings.json"),
                r#"{"defaultProvider":"gs","defaultModel":"gpt-5.6-sol","defaultThinkingLevel":"high"}"#,
            )
            .unwrap();
            fs::write(
                tmp.path().join("models.json"),
                r#"{"providers":{"gs":{"api":"openai-responses","baseUrl":"https://example.test/v1",
                   "models":[{"id":"gpt-5.6-sol","name":"gpt-5.6-sol","reasoning":true,
                   "thinkingLevelMap":{"off":"none","minimal":null,"xhigh":"xhigh"}}]}}}"#,
            )
            .unwrap();

            let cfg = load_pi_config_core();

            assert_eq!(cfg.default_provider.as_deref(), Some("gs"));
            assert_eq!(cfg.default_thinking_level.as_deref(), Some("high"));
            let provider = &cfg.custom_providers[0];
            assert_eq!(provider.id, "gs");
            assert_eq!(provider.api, "openai-responses");
            assert_eq!(provider.models[0].id, "gpt-5.6-sol");
            assert_eq!(provider.models[0].reasoning, Some(true));
            assert_eq!(
                provider.models[0].thinking_level_map["xhigh"],
                Some("xhigh".to_string())
            );
        });
    }

    #[test]
    fn opencode_auth_empty_payload_truncates_to_empty_object() {
        // Clearing the last credential sends "" — it must persist `{}` (clearing
        // the file), not be skipped (which would strand a stale key on disk).
        assert_eq!(
            opencode_auth_payload_to_write(Some("")),
            Some("{}".to_string())
        );
        assert_eq!(
            opencode_auth_payload_to_write(Some("   \n")),
            Some("{}".to_string())
        );
    }

    #[test]
    fn opencode_auth_payload_preserves_non_empty_and_skips_none() {
        let json = r#"{"openai":{"type":"api","key":"k"}}"#;
        assert_eq!(
            opencode_auth_payload_to_write(Some(json)),
            Some(json.to_string())
        );
        // No payload supplied → leave auth.json untouched.
        assert_eq!(opencode_auth_payload_to_write(None), None);
    }

    // Call-site guard: both acp_update_agent_config_core and
    // acp_update_agent_preferences_core route OpenCode persistence through
    // persist_opencode_native_config, so testing it covers both exposed paths.
    #[test]
    fn persist_opencode_native_config_empty_auth_clears_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // Pin HOME and clear XDG_DATA_HOME so the auth path resolves under the
        // temp dir regardless of the developer's environment.
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("XDG_DATA_HOME", None::<&std::path::Path>),
            ],
            || {
                let auth_path = opencode_auth_json_path();
                fs::create_dir_all(auth_path.parent().unwrap()).expect("mkdir");
                fs::write(&auth_path, r#"{"openai":{"type":"api","key":"k"}}"#).expect("seed");

                // Disconnecting the last provider sends an empty auth payload: it
                // must truncate auth.json to {}, not strand the stale credential.
                persist_opencode_native_config(Some(""), None).expect("persist");

                assert_eq!(fs::read_to_string(&auth_path).unwrap().trim(), "{}");
            },
        );
    }

    #[test]
    fn persist_opencode_native_config_none_auth_leaves_file() {
        let tmp = tempfile::tempdir().expect("tempdir");
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("XDG_DATA_HOME", None::<&std::path::Path>),
            ],
            || {
                let auth_path = opencode_auth_json_path();
                fs::create_dir_all(auth_path.parent().unwrap()).expect("mkdir");
                let original = "{\"openai\":{\"type\":\"api\",\"key\":\"k\"}}\n";
                fs::write(&auth_path, original).expect("seed");

                // No auth payload supplied → file untouched.
                persist_opencode_native_config(None, None).expect("persist");

                assert_eq!(fs::read_to_string(&auth_path).unwrap(), original);
            },
        );
    }

    #[test]
    fn opencode_config_path_falls_back_when_xdg_config_home_empty() {
        // An empty XDG_CONFIG_HOME must fall back to <home>/.config, not resolve
        // to a relative "opencode/opencode.json". `dirs::home_dir()` ignores the
        // HOME env var on Windows, so derive the expected base from the same
        // resolution production uses instead of pinning HOME.
        temp_env::with_var("XDG_CONFIG_HOME", Some(""), || {
            assert_eq!(
                opencode_primary_config_path(),
                home_dir_or_default()
                    .join(".config")
                    .join("opencode")
                    .join("opencode.json")
            );
        });
    }

    #[test]
    fn opencode_paths_follow_xdg_when_set() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let cfg = tmp.path().join("xdg-config");
        let data = tmp.path().join("xdg-data");
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("XDG_CONFIG_HOME", Some(cfg.as_path())),
                ("XDG_DATA_HOME", Some(data.as_path())),
            ],
            || {
                assert_eq!(
                    opencode_primary_config_path(),
                    cfg.join("opencode").join("opencode.json")
                );
                assert_eq!(
                    opencode_auth_json_path(),
                    data.join("opencode").join("auth.json")
                );
            },
        );
    }

    #[test]
    fn codex_config_projection_tracks_model_provider_for_fingerprint() {
        // Two configs sharing one base_url but naming different providers must
        // produce different projections, so `fingerprint_config` (which hashes
        // this projection) flags a provider switch even though the resolved
        // endpoint is unchanged. codex-acp 1.0.1 reads `model_provider` from
        // config.toml directly, so it is no longer pinned into the launch env
        // where the fingerprint previously caught it incidentally.
        let codeg = r#"
model = "gpt-5-codex"
model_provider = "codeg"

[model_providers.codeg]
base_url = "https://gateway.example/v1"
wire_api = "responses"

[model_providers.other]
base_url = "https://gateway.example/v1"
wire_api = "chat"
"#;
        let other = codeg.replace(
            "model_provider = \"codeg\"",
            "model_provider = \"other\"",
        );

        let p_codeg = codex_config_projection_from_toml(codeg);
        let p_other = codex_config_projection_from_toml(&other);

        assert_eq!(
            p_codeg.get("modelProvider").and_then(|v| v.as_str()),
            Some("codeg")
        );
        assert_eq!(
            p_other.get("modelProvider").and_then(|v| v.as_str()),
            Some("other")
        );
        // Same endpoint resolved for both providers...
        assert_eq!(p_codeg.get("apiBaseUrl"), p_other.get("apiBaseUrl"));
        // ...yet the projections differ, so the launch-config fingerprint does too.
        assert_ne!(p_codeg, p_other);

        // Deterministic for identical input.
        assert_eq!(codex_config_projection_from_toml(codeg), p_codeg);

        // `modelProvider` must NOT be an AgentRuntimeConfig key, or
        // build_runtime_env_from_setting would mirror it back into a runtime env
        // var (reintroducing the very MODEL_PROVIDER pin we removed).
        assert!(
            serde_json::from_value::<AgentRuntimeConfig>(serde_json::Value::Object(
                p_codeg.clone()
            ))
            .is_ok()
        );

        // No model_provider declared (official OpenAI / ChatGPT) → no
        // modelProvider key, matching the pre-1.0.1 "leave MODEL_PROVIDER unset"
        // behavior; the bare `model` still projects.
        let bare = codex_config_projection_from_toml("model = \"gpt-5-codex\"\n");
        assert!(!bare.contains_key("modelProvider"));
        assert_eq!(bare.get("model").and_then(|v| v.as_str()), Some("gpt-5-codex"));

        // Malformed TOML must not panic — yields an empty projection.
        assert!(codex_config_projection_from_toml("model_provider = ").is_empty());
    }

    fn unique_test_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("codeg-acp-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create test directory");
        dir
    }

    #[test]
    fn kimi_code_skill_storage_spec_targets_kimi_home() {
        // `resolve_kimi_code_home_dir()` reads the process-wide `$HOME` (when
        // `KIMI_CODE_HOME` is unset), and other tests mutate HOME via `temp_env`.
        // Pin it (and clear `KIMI_CODE_HOME`) so the spec and the expected path
        // resolve against one consistent home instead of racing a concurrent
        // HOME-mutating test. Deriving `expected` from the same production helper
        // keeps it correct on Windows, where `dirs::home_dir()` ignores HOME.
        let tmp = tempfile::tempdir().expect("tempdir");
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("KIMI_CODE_HOME", None::<&std::path::Path>),
            ],
            || {
                let spec =
                    skill_storage_spec(AgentType::KimiCode).expect("Kimi Code supports skills");
                assert_eq!(spec.kind, SkillStorageKind::SkillDirectoryOnly);
                assert_eq!(
                    spec.project_rel_dirs,
                    vec![".kimi-code/skills", ".agents/skills"]
                );
                // Kimi-native dir first (preferred link target), shared
                // cross-agent store second. The two hang off DIFFERENT bases:
                // the brand dir off the data home `KIMI_CODE_HOME` moves, the
                // shared store off the OS home it does not.
                let expected = vec![
                    crate::parsers::kimi_code::resolve_kimi_code_home_dir().join("skills"),
                    home_dir_or_default().join(".agents").join("skills"),
                ];
                assert_eq!(spec.global_dirs, expected);
            },
        );
    }

    #[test]
    fn kimi_code_skill_storage_spec_shared_store_ignores_kimi_code_home() {
        // `KIMI_CODE_HOME` relocates Kimi's own `skills/` dir but NOT the
        // shared `~/.agents/skills` store: upstream's `userRoots(homeDir,
        // osHomeDir)` joins the brand dirs onto the data home and the generic
        // dirs onto the OS home. Getting this backwards would silently point
        // the shared column at a directory nothing reads.
        let home = tempfile::tempdir().expect("tempdir");
        let kimi_home = tempfile::tempdir().expect("tempdir");
        temp_env::with_vars(
            [
                ("HOME", Some(home.path())),
                ("KIMI_CODE_HOME", Some(kimi_home.path())),
            ],
            || {
                let spec =
                    skill_storage_spec(AgentType::KimiCode).expect("Kimi Code supports skills");
                assert_eq!(
                    spec.global_dirs[0],
                    kimi_home.path().join("skills"),
                    "the brand dir follows KIMI_CODE_HOME"
                );
                assert_eq!(
                    spec.global_dirs[1],
                    home_dir_or_default().join(".agents").join("skills"),
                    "the shared store follows the OS home, not KIMI_CODE_HOME"
                );
            },
        );
    }

    #[test]
    fn pi_skill_storage_spec_targets_pi_agent_dir() {
        // `pi_agent_dir()` and `home_dir_or_default()` both read the process-wide
        // `$HOME`, and other tests mutate HOME via `temp_env`. Pin it (and clear
        // the BYO `PI_CODING_AGENT_DIR` override) so this test serializes against
        // those mutators through temp_env's shared lock and reads one consistent
        // home for both the spec and the expected paths. Deriving `expected` from
        // the same production helpers keeps it correct on Windows, where
        // `dirs::home_dir()` ignores the pinned HOME.
        let tmp = tempfile::tempdir().expect("tempdir");
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("PI_CODING_AGENT_DIR", None::<&std::path::Path>),
            ],
            || {
                let spec = skill_storage_spec(AgentType::Pi).expect("Pi supports skills");
                // pi's native dir accepts standalone `.md` files, like Codex.
                assert_eq!(spec.kind, SkillStorageKind::SkillDirectoryOrMarkdownFile);
                assert_eq!(spec.project_rel_dirs, vec![".pi/skills", ".agents/skills"]);
                // Native pi dir first (preferred link target), shared store second.
                let expected = vec![
                    pi_agent_dir().join("skills"),
                    home_dir_or_default().join(".agents").join("skills"),
                ];
                assert_eq!(spec.global_dirs, expected);
            },
        );
    }

    #[test]
    fn deepseek_skill_storage_spec_mirrors_dsh_skill_roots() {
        // Both resolvers read the process-wide `$HOME` when their env override
        // is unset, and other tests mutate HOME via `temp_env`. Pin it (and
        // clear both overrides) so the spec and the expected paths resolve
        // against one consistent home. `expected` comes from the same
        // production helpers so this stays correct on Windows, where
        // `dirs::home_dir()` ignores the pinned HOME.
        let tmp = tempfile::tempdir().expect("tempdir");
        temp_env::with_vars(
            [
                ("HOME", Some(tmp.path())),
                ("DSH_HOME", None::<&std::path::Path>),
                ("DSH_AGENTS_HOME", None::<&std::path::Path>),
            ],
            || {
                let spec =
                    skill_storage_spec(AgentType::DeepSeek).expect("DeepSeek supports skills");
                // `dsh-skill-filesystem` discovers directory bundles AND flat
                // `.md` files, like Codex and pi.
                assert_eq!(spec.kind, SkillStorageKind::SkillDirectoryOrMarkdownFile);
                assert_eq!(spec.project_rel_dirs, vec![".dsh/skills", ".agents/skills"]);
                // Harness-native dir first (preferred link target), shared
                // cross-agent store second.
                let expected = vec![
                    crate::parsers::deepseek::resolve_dsh_home_dir().join("skills"),
                    crate::parsers::deepseek::resolve_dsh_agents_home_dir().join("skills"),
                ];
                assert_eq!(spec.global_dirs, expected);
                // The product CLI owns `$DSH_HOME/skills/.system` (the provider
                // sets `skipSystem` on that root), so codeg never writes there.
                assert!(is_read_only_skill_path(
                    AgentType::DeepSeek,
                    &expected[0].join(".system").join("imagegen")
                ));
                assert!(!is_read_only_skill_path(
                    AgentType::DeepSeek,
                    &expected[0].join("my-skill")
                ));
            },
        );
    }

    #[test]
    fn deepseek_project_skills_hang_off_the_git_root() {
        // `dsh-skill-filesystem` resolves project roots by walking up to the
        // nearest `.git`, so opening a package subdirectory must still target
        // the repo root — otherwise codeg writes a skill the agent never scans.
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        let nested = repo.join("packages").join("app");
        std::fs::create_dir_all(&nested).expect("create nested");
        // A linked worktree records `.git` as a FILE, which upstream's
        // `pathExists` accepts — so must this.
        std::fs::write(repo.join(".git"), "gitdir: /elsewhere\n").expect("write .git file");

        let dirs = scoped_skill_dirs(
            AgentType::DeepSeek,
            AgentSkillScope::Project,
            Some(nested.to_str().expect("utf-8 path")),
        )
        .expect("project dirs");
        assert_eq!(
            dirs,
            vec![repo.join(".dsh/skills"), repo.join(".agents/skills")]
        );

        // No `.git` anywhere above ⇒ fall back to the workspace itself.
        let bare = tmp.path().join("bare");
        std::fs::create_dir_all(&bare).expect("create bare");
        let fallback = scoped_skill_dirs(
            AgentType::DeepSeek,
            AgentSkillScope::Project,
            Some(bare.to_str().expect("utf-8 path")),
        )
        .expect("fallback dirs");
        assert_eq!(fallback[0], bare.join(".dsh/skills"));

        // Every other agent keeps the plain workspace-relative layout.
        let codex = scoped_skill_dirs(
            AgentType::Codex,
            AgentSkillScope::Project,
            Some(nested.to_str().expect("utf-8 path")),
        )
        .expect("codex dirs");
        assert_eq!(codex[0], nested.join(".codex/skills"));

        // ...and the LIST path must resolve the same base as the WRITE path:
        // a skill saved from the nested workspace lands at the repo root, so
        // listing the workspace directly would show it as missing.
        let saved = repo.join(".dsh/skills").join("demo");
        std::fs::create_dir_all(&saved).expect("create skill dir");
        std::fs::write(saved.join("SKILL.md"), "---\nname: demo\n---\nbody\n")
            .expect("write SKILL.md");
        let listed = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_list_agent_skills(
                AgentType::DeepSeek,
                Some(nested.to_string_lossy().to_string()),
            ))
            .expect("list skills");
        assert!(
            listed.skills.iter().any(|s| s.id == "demo"),
            "skill saved at the git root must be listed from a nested workspace: {:?}",
            listed.skills
        );
        assert!(
            listed
                .locations
                .iter()
                .any(|l| l.path == repo.join(".dsh/skills").to_string_lossy()),
            "the listed project location must be the git root: {:?}",
            listed.locations
        );
    }

    #[test]
    fn kimi_code_project_skills_hang_off_the_git_root() {
        // Kimi's `skillRoots.projectRoots` walks up to the nearest `.git`
        // exactly like DeepSeek's, so opening a package subdirectory must still
        // target the repo root. Confirmed live: `kimi acp` with `cwd` at
        // `<repo>/sub` advertised `<repo>/.kimi-code/skills` and
        // `<repo>/.agents/skills` and ignored both `<repo>/sub` copies.
        let tmp = tempfile::tempdir().expect("tempdir");
        let repo = tmp.path().join("repo");
        let nested = repo.join("packages").join("app");
        std::fs::create_dir_all(&nested).expect("create nested");
        // A linked worktree records `.git` as a FILE, and upstream probes it
        // with a bare `stat`, which accepts that — so must this.
        std::fs::write(repo.join(".git"), "gitdir: /elsewhere\n").expect("write .git file");

        let dirs = scoped_skill_dirs(
            AgentType::KimiCode,
            AgentSkillScope::Project,
            Some(nested.to_str().expect("utf-8 path")),
        )
        .expect("project dirs");
        assert_eq!(
            dirs,
            vec![repo.join(".kimi-code/skills"), repo.join(".agents/skills")]
        );

        // No `.git` anywhere above ⇒ fall back to the workspace itself, which
        // is also what `findUpwardRoot` does when it reaches the filesystem
        // root.
        let bare = tmp.path().join("bare");
        std::fs::create_dir_all(&bare).expect("create bare");
        let fallback = scoped_skill_dirs(
            AgentType::KimiCode,
            AgentSkillScope::Project,
            Some(bare.to_str().expect("utf-8 path")),
        )
        .expect("fallback dirs");
        assert_eq!(fallback[0], bare.join(".kimi-code/skills"));

        // The LIST path must resolve the same base as the WRITE path.
        let saved = repo.join(".kimi-code/skills").join("demo");
        std::fs::create_dir_all(&saved).expect("create skill dir");
        std::fs::write(saved.join("SKILL.md"), "---\nname: demo\n---\nbody\n")
            .expect("write SKILL.md");
        let listed = tokio::runtime::Runtime::new()
            .expect("runtime")
            .block_on(acp_list_agent_skills(
                AgentType::KimiCode,
                Some(nested.to_string_lossy().to_string()),
            ))
            .expect("list skills");
        assert!(
            listed.skills.iter().any(|s| s.id == "demo"),
            "skill saved at the git root must be listed from a nested workspace: {:?}",
            listed.skills
        );
        assert!(
            listed
                .locations
                .iter()
                .any(|l| l.path == repo.join(".kimi-code/skills").to_string_lossy()),
            "the listed project location must be the git root: {:?}",
            listed.locations
        );
    }

    #[test]
    fn parse_provider_model_emits_claude_custom_model_option_trio() {
        // A Claude provider that defines the custom model option must surface all
        // three ANTHROPIC_CUSTOM_MODEL_OPTION* env vars (Some => set) alongside
        // the standard model fields.
        let raw = r#"{
            "main": "gw/opus",
            "customOption": "gw/opus-preview",
            "customOptionName": "Gateway Opus",
            "customOptionDescription": "via gateway"
        }"#;
        let out = parse_provider_model(AgentType::ClaudeCode, Some(raw));
        assert_eq!(
            out.get("ANTHROPIC_CUSTOM_MODEL_OPTION"),
            Some(&Some("gw/opus-preview".to_string()))
        );
        assert_eq!(
            out.get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"),
            Some(&Some("Gateway Opus".to_string()))
        );
        assert_eq!(
            out.get("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"),
            Some(&Some("via gateway".to_string()))
        );
        assert_eq!(out.get("ANTHROPIC_MODEL"), Some(&Some("gw/opus".to_string())));

        // Omitted custom keys are authoritative clears (None => remove from env),
        // matching the five model fields' overwrite semantics.
        let bare = parse_provider_model(AgentType::ClaudeCode, Some(r#"{"main":"x"}"#));
        assert_eq!(bare.get("ANTHROPIC_CUSTOM_MODEL_OPTION"), Some(&None));
        assert_eq!(bare.get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"), Some(&None));
        assert_eq!(
            bare.get("ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION"),
            Some(&None)
        );
    }

    #[test]
    fn parse_provider_model_codex_uses_default_slug() {
        // A structured codex catalog resolves OPENAI_MODEL to its default slug,
        // not the whole JSON blob.
        let raw = r#"{"models":[{"slug":"gw/a","base":"gpt-5.4"},{"slug":"gw/b","base":"gpt-5.4"}],"default":"gw/b"}"#;
        let out = parse_provider_model(AgentType::Codex, Some(raw));
        assert_eq!(out.get("OPENAI_MODEL"), Some(&Some("gw/b".to_string())));

        // A legacy plain slug passes through as the model.
        let legacy = parse_provider_model(AgentType::Codex, Some("gpt-5.5"));
        assert_eq!(legacy.get("OPENAI_MODEL"), Some(&Some("gpt-5.5".to_string())));

        // No models → OPENAI_MODEL cleared (None).
        let empty = parse_provider_model(AgentType::Codex, Some(r#"{"models":[]}"#));
        assert_eq!(empty.get("OPENAI_MODEL"), Some(&None));
    }

    #[test]
    fn merge_json_values_clears_stale_custom_model_option_via_null() {
        // The local-config cascade (cascade_update_agent_config) encodes a
        // cleared model key as JSON-null. merge_json_values must DELETE that key
        // from the on-disk config (nested under `env`) while preserving sibling
        // keys — this is what stops a stale ANTHROPIC_CUSTOM_MODEL_OPTION* in
        // ~/.claude/settings.json from winning after binding to a provider that
        // omits the trio (parse_provider_model yields `None` => null here).
        let mut base = serde_json::json!({
            "env": {
                "ANTHROPIC_CUSTOM_MODEL_OPTION": "gw/opus-stale",
                "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": "Stale",
                "ANTHROPIC_MODEL": "keep-me"
            }
        });
        let patch = serde_json::json!({
            "env": {
                "ANTHROPIC_CUSTOM_MODEL_OPTION": null,
                "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME": null
            }
        });
        merge_json_values(&mut base, &patch);
        let env = base
            .get("env")
            .and_then(|v| v.as_object())
            .expect("env object survives the merge");
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_MODEL_OPTION"));
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME"));
        assert_eq!(
            env.get("ANTHROPIC_MODEL").and_then(|v| v.as_str()),
            Some("keep-me")
        );
    }

    #[test]
    fn merge_json_values_never_materializes_a_removal_into_a_missing_parent() {
        // The regression: binding a Claude provider that configures NO models
        // against a ~/.claude/settings.json that has no `env` object yet. Every
        // ANTHROPIC_*_MODEL entry of the cascade patch is a removal, and the old
        // merge copied the whole `env` subtree in verbatim because the key was
        // absent — writing the sentinels out as real JSON nulls. The Claude Code
        // CLI stringifies settings env into `process.env`, so those became the
        // model name "null" and every row of the composer's model picker read
        // `null`.
        let mut base = serde_json::json!({ "effortLevel": "high" });
        let patch = serde_json::json!({
            "env": {
                "ANTHROPIC_BASE_URL": "https://gw.example",
                "ANTHROPIC_AUTH_TOKEN": "sk-1",
                "ANTHROPIC_MODEL": null,
                "ANTHROPIC_DEFAULT_OPUS_MODEL": null,
                "ANTHROPIC_CUSTOM_MODEL_OPTION": null
            }
        });
        merge_json_values(&mut base, &patch);
        let env = base
            .get("env")
            .and_then(|v| v.as_object())
            .expect("env object created for the real values");
        assert_eq!(
            env.get("ANTHROPIC_BASE_URL").and_then(|v| v.as_str()),
            Some("https://gw.example")
        );
        assert_eq!(
            env.get("ANTHROPIC_AUTH_TOKEN").and_then(|v| v.as_str()),
            Some("sk-1")
        );
        // Not "present and null" — absent.
        assert!(!env.contains_key("ANTHROPIC_MODEL"));
        assert!(!env.contains_key("ANTHROPIC_DEFAULT_OPUS_MODEL"));
        assert!(!env.contains_key("ANTHROPIC_CUSTOM_MODEL_OPTION"));
        // Untouched siblings survive.
        assert_eq!(
            base.get("effortLevel").and_then(|v| v.as_str()),
            Some("high")
        );
    }

    #[test]
    fn merge_json_values_skips_a_patch_subtree_that_is_only_removals() {
        // Same missing-parent case, but the patch has nothing real to add:
        // creating an empty `env` husk in a config that never had one would be
        // writing a key the user never asked for.
        let mut base = serde_json::json!({});
        merge_json_values(
            &mut base,
            &serde_json::json!({ "env": { "ANTHROPIC_MODEL": null } }),
        );
        assert!(!base.as_object().expect("object").contains_key("env"));

        // An object the patch author wrote as empty IS a value — it still lands.
        let mut base = serde_json::json!({});
        merge_json_values(&mut base, &serde_json::json!({ "env": {} }));
        assert_eq!(base.get("env"), Some(&serde_json::json!({})));
    }

    #[test]
    fn merge_json_values_strips_removals_when_replacing_a_mistyped_base() {
        // A base whose `env` is not an object can't be merged into, so the patch
        // replaces it — still without materializing the sentinels.
        let mut base = serde_json::json!({ "env": "not-an-object" });
        merge_json_values(
            &mut base,
            &serde_json::json!({ "env": { "ANTHROPIC_BASE_URL": "https://gw", "ANTHROPIC_MODEL": null } }),
        );
        assert_eq!(
            base.get("env"),
            Some(&serde_json::json!({ "ANTHROPIC_BASE_URL": "https://gw" }))
        );

        // Arrays are data, not key/value maps: a null element is preserved.
        let mut base = serde_json::json!({});
        merge_json_values(&mut base, &serde_json::json!({ "xs": [1, null, 2] }));
        assert_eq!(base.get("xs"), Some(&serde_json::json!([1, null, 2])));
    }

    #[test]
    fn agent_runtime_config_env_survives_a_non_string_value() {
        // A settings.json corrupted by the old merge (env values as JSON null)
        // must not cost the launch env everything else in the file: the bad
        // entries are skipped, the rest — including the credentials — still land.
        let config: AgentRuntimeConfig = serde_json::from_str(
            r#"{"env":{"ANTHROPIC_BASE_URL":"https://gw","ANTHROPIC_MODEL":null,"PORT":8080}}"#,
        )
        .expect("a null env value must not fail the whole parse");
        assert_eq!(
            config.env.get("ANTHROPIC_BASE_URL").map(String::as_str),
            Some("https://gw")
        );
        assert!(!config.env.contains_key("ANTHROPIC_MODEL"));
        assert!(!config.env.contains_key("PORT"));
    }

    #[test]
    fn fingerprint_config_is_deterministic_and_excludes_volatile_keys() {
        let agent = AgentType::Codex;
        let mut env = BTreeMap::new();
        env.insert("OPENAI_BASE_URL".to_string(), "https://a".to_string());
        env.insert("OPENAI_API_KEY".to_string(), "k1".to_string());

        // `fingerprint_config` folds in the on-disk native config, so this test
        // must pin CODEX_HOME the way the Grok/Cursor fingerprint tests below
        // pin theirs. Reading the developer's real ~/.codex would make the
        // "same inputs → same fingerprint" assertions depend on whether another
        // test happened to be inside its own `temp_env` CODEX_HOME scope at the
        // time — temp_env mutates the process environment, and only tests that
        // take its lock are serialized against each other.
        let dir = tempfile::tempdir().expect("tempdir");
        temp_env::with_var("CODEX_HOME", Some(dir.path()), || {
            // Same inputs → same fingerprint (the native-config read is
            // identical across all calls in this test, so only the env varies).
            let fp1 = fingerprint_config(agent, &env);
            assert_eq!(fp1, fingerprint_config(agent, &env));

            // Changing a real config value changes the fingerprint.
            let mut env_changed = env.clone();
            env_changed.insert("OPENAI_API_KEY".to_string(), "k2".to_string());
            assert_ne!(fp1, fingerprint_config(agent, &env_changed));

            // The per-launch volatile key is excluded — adding it must NOT
            // change the fingerprint (otherwise OpenClaw would look stale once a
            // real session id is assigned and the reset flag drops).
            let mut env_volatile = env.clone();
            env_volatile.insert("OPENCLAW_RESET_SESSION".to_string(), "1".to_string());
            assert_eq!(fp1, fingerprint_config(agent, &env_volatile));
        });
    }

    #[test]
    fn grok_fingerprint_tracks_config_toml_changes() {
        // Grok's ~/.grok/config.toml is edited via the Grok settings panel but
        // is NOT in `agent_local_config_path`, so `fingerprint_config` must fold
        // it in explicitly — otherwise `refresh_config_staleness` never marks a
        // running Grok session restart-required after a config.toml change.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("config.toml");
        temp_env::with_var("GROK_HOME", Some(dir.path()), || {
            let env: BTreeMap<String, String> = BTreeMap::new();
            let empty_fp = fingerprint_config(AgentType::Grok, &env);

            std::fs::write(&path, "[models]\ndefault_reasoning_effort = \"low\"\n")
                .expect("write low");
            let low_fp = fingerprint_config(AgentType::Grok, &env);
            assert_ne!(
                empty_fp, low_fp,
                "adding ~/.grok/config.toml must change the fingerprint"
            );

            std::fs::write(&path, "[models]\ndefault_reasoning_effort = \"high\"\n")
                .expect("write high");
            let high_fp = fingerprint_config(AgentType::Grok, &env);
            assert_ne!(
                low_fp, high_fp,
                "changing default_reasoning_effort must change the fingerprint"
            );
        });
    }

    /// Parse a provider table out of a TOML fragment so the auth-default tests
    /// read like the config.toml a user would actually write.
    fn provider_table_of(raw: &str) -> toml::map::Map<String, toml::Value> {
        raw.parse::<toml::Value>()
            .expect("fragment must parse")
            .get("model_providers")
            .and_then(toml::Value::as_table)
            .and_then(|providers| providers.get("codeg"))
            .and_then(toml::Value::as_table)
            .cloned()
            .expect("fragment must define model_providers.codeg")
    }

    fn auth_flag_of(table: &toml::map::Map<String, toml::Value>) -> Option<bool> {
        table.get("requires_openai_auth").and_then(toml::Value::as_bool)
    }

    #[test]
    fn codex_auth_default_is_supplied_only_when_absent() {
        // codeg provisions its provider with the key in auth.json and no
        // `env_key`, so a provider WE create needs requires_openai_auth = true.
        let mut fresh = provider_table_of("[model_providers.codeg]\nbase_url = \"https://x/v1\"\n");
        ensure_codex_provider_auth_default(&mut fresh);
        assert_eq!(auth_flag_of(&fresh), Some(true));

        // An explicit false is the user's call and must survive every path —
        // this is the regression the whole change exists for.
        let mut explicit_false = provider_table_of(
            "[model_providers.codeg]\nbase_url = \"https://x/v1\"\nrequires_openai_auth = false\n",
        );
        ensure_codex_provider_auth_default(&mut explicit_false);
        assert_eq!(auth_flag_of(&explicit_false), Some(false));

        // An explicit true is left alone rather than rewritten.
        let mut explicit_true = provider_table_of(
            "[model_providers.codeg]\nrequires_openai_auth = true\n",
        );
        ensure_codex_provider_auth_default(&mut explicit_true);
        assert_eq!(auth_flag_of(&explicit_true), Some(true));
    }

    #[test]
    fn codex_auth_default_yields_to_actor_authorization() {
        // codex's uses_openai_actor_authorization() is
        // `!requires_openai_auth && <non-empty x-openai-actor-authorization>`,
        // so writing the default here would silently disable that auth path.
        let mut header_present = provider_table_of(
            "[model_providers.codeg]\nbase_url = \"https://x/v1\"\n\n\
             [model_providers.codeg.http_headers]\n\
             x-openai-actor-authorization = \"local-image-extension\"\n",
        );
        ensure_codex_provider_auth_default(&mut header_present);
        assert_eq!(auth_flag_of(&header_present), None);

        // Header matching is case-insensitive, mirroring eq_ignore_ascii_case.
        let mut mixed_case = provider_table_of(
            "[model_providers.codeg.http_headers]\n\
             X-OpenAI-Actor-Authorization = \"local-image-extension\"\n",
        );
        ensure_codex_provider_auth_default(&mut mixed_case);
        assert_eq!(auth_flag_of(&mixed_case), None);

        // An inline table is the same table to the parser.
        let mut inline = provider_table_of(
            "[model_providers.codeg]\n\
             http_headers = { \"x-openai-actor-authorization\" = \"local-image-extension\" }\n",
        );
        ensure_codex_provider_auth_default(&mut inline);
        assert_eq!(auth_flag_of(&inline), None);

        // An empty header value does not enable the path upstream
        // (`!value.trim().is_empty()`), so the default still applies.
        let mut empty_value = provider_table_of(
            "[model_providers.codeg.http_headers]\nx-openai-actor-authorization = \"  \"\n",
        );
        ensure_codex_provider_auth_default(&mut empty_value);
        assert_eq!(auth_flag_of(&empty_value), Some(true));

        // A header plus an explicit true is a contradictory config, but it is
        // the user's: never rewrite or remove it.
        let mut header_and_true = provider_table_of(
            "[model_providers.codeg]\nrequires_openai_auth = true\n\n\
             [model_providers.codeg.http_headers]\n\
             x-openai-actor-authorization = \"local-image-extension\"\n",
        );
        ensure_codex_provider_auth_default(&mut header_and_true);
        assert_eq!(auth_flag_of(&header_and_true), Some(true));

        // A quoted key containing dots is ONE literal key, not an http_headers
        // sub-table, so it must not suppress the default.
        let mut literal_dotted_key = provider_table_of(
            "[model_providers.codeg]\n\
             \"http_headers.x-openai-actor-authorization\" = \"local-image-extension\"\n",
        );
        ensure_codex_provider_auth_default(&mut literal_dotted_key);
        assert_eq!(auth_flag_of(&literal_dotted_key), Some(true));
    }

    #[test]
    fn codex_cascade_preserves_explicit_auth_flag_and_headers() {
        // Repro path 2 from issue #406: editing a bound model provider's URL /
        // key / model cascades into ~/.codex/config.toml, which used to
        // overwrite requires_openai_auth on the way through.
        let dir = tempfile::tempdir().expect("tempdir");
        temp_env::with_var("CODEX_HOME", Some(dir.path()), || {
            let config_path = dir.path().join("config.toml");
            std::fs::write(
                &config_path,
                "model_provider = \"codeg\"\n\n\
                 [model_providers.codeg]\n\
                 base_url = \"https://old.example/v1\"\n\
                 name = \"codeg\"\n\
                 wire_api = \"responses\"\n\
                 requires_openai_auth = false\n\n\
                 [model_providers.codeg.http_headers]\n\
                 x-openai-actor-authorization = \"local-image-extension\"\n",
            )
            .expect("seed config.toml");

            cascade_update_agent_config(
                AgentType::Codex,
                "https://new.example/v1",
                "sk-test",
                &BTreeMap::new(),
                &CodexModelAction::Set("gpt-5-codex".to_string()),
                None,
            )
            .expect("cascade must succeed");

            let written = std::fs::read_to_string(&config_path).expect("read back");
            let table = provider_table_of(&written);
            assert_eq!(
                auth_flag_of(&table),
                Some(false),
                "an explicit requires_openai_auth = false must survive the cascade"
            );
            assert!(
                codex_provider_uses_actor_authorization(&table),
                "the actor-authorization header must survive the cascade"
            );
            assert_eq!(
                table.get("base_url").and_then(toml::Value::as_str),
                Some("https://new.example/v1"),
                "the cascade must still apply the new base_url"
            );
        });
    }

    #[test]
    fn codex_cascade_seeds_auth_flag_for_a_fresh_provider() {
        let dir = tempfile::tempdir().expect("tempdir");
        temp_env::with_var("CODEX_HOME", Some(dir.path()), || {
            cascade_update_agent_config(
                AgentType::Codex,
                "https://new.example/v1",
                "sk-test",
                &BTreeMap::new(),
                &CodexModelAction::NoOp,
                None,
            )
            .expect("cascade must succeed");

            let written =
                std::fs::read_to_string(dir.path().join("config.toml")).expect("read back");
            assert_eq!(
                auth_flag_of(&provider_table_of(&written)),
                Some(true),
                "a provider codeg creates still gets the default"
            );
        });
    }

    #[test]
    fn codex_cascade_leaves_a_non_codeg_provider_alone() {
        let dir = tempfile::tempdir().expect("tempdir");
        temp_env::with_var("CODEX_HOME", Some(dir.path()), || {
            let config_path = dir.path().join("config.toml");
            std::fs::write(
                &config_path,
                "model_provider = \"custom\"\n\n\
                 [model_providers.custom]\n\
                 base_url = \"https://old.example/v1\"\n",
            )
            .expect("seed config.toml");

            cascade_update_agent_config(
                AgentType::Codex,
                "https://new.example/v1",
                "sk-test",
                &BTreeMap::new(),
                &CodexModelAction::NoOp,
                None,
            )
            .expect("cascade must succeed");

            let written = std::fs::read_to_string(&config_path).expect("read back");
            let parsed = written.parse::<toml::Value>().expect("must parse");
            let custom = parsed
                .get("model_providers")
                .and_then(toml::Value::as_table)
                .and_then(|providers| providers.get("custom"))
                .and_then(toml::Value::as_table)
                .expect("custom provider must survive");
            assert!(
                !custom.contains_key("requires_openai_auth"),
                "only the codeg provider is codeg-managed"
            );
        });
    }

    #[test]
    fn cursor_fingerprint_tracks_cli_config_changes() {
        // Cursor's ~/.cursor/cli-config.json (permission rules / sandbox) is
        // edited via the Cursor settings panel but is NOT in
        // `agent_local_config_path`, so `fingerprint_config` must fold it in
        // explicitly — otherwise a permission-rule change never marks a running
        // Cursor session restart-required.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("cli-config.json");
        temp_env::with_var("CURSOR_CONFIG_DIR", Some(dir.path()), || {
            let env: BTreeMap<String, String> = BTreeMap::new();
            let empty_fp = fingerprint_config(AgentType::Cursor, &env);

            std::fs::write(&path, "{\"permissions\":{\"allow\":[\"Shell(ls)\"]}}")
                .expect("write allow");
            let allow_fp = fingerprint_config(AgentType::Cursor, &env);
            assert_ne!(
                empty_fp, allow_fp,
                "adding cli-config.json must change the fingerprint"
            );

            std::fs::write(&path, "{\"permissions\":{\"deny\":[\"Shell(rm)\"]}}")
                .expect("write deny");
            let deny_fp = fingerprint_config(AgentType::Cursor, &env);
            assert_ne!(
                allow_fp, deny_fp,
                "changing permission rules must change the fingerprint"
            );
        });
    }

    #[test]
    fn cursor_structured_config_merges_preserving_unknown_keys() {
        // The panel's structured save must only touch the managed keys —
        // editor prefs and other CLI-owned keys survive verbatim, and
        // empty-string scalars remove their key.
        let base = r#"{
  "version": 1,
  "editor": { "vimMode": true },
  "approvalMode": "allowlist",
  "sandbox": { "mode": "disabled", "networkAccess": "full" },
  "permissions": { "allow": ["Shell(ls)"], "deny": [] }
}"#;
        let patch = crate::acp::types::CursorStructuredConfig {
            sandbox_mode: Some("enabled".to_string()),
            permissions_allow: Some(vec![
                "Shell(npm run build)".to_string(),
                "  ".to_string(), // blank rows are dropped
            ]),
            permissions_deny: None, // untouched
        };
        let merged = apply_cursor_structured_config(base, &patch).expect("merge");
        let v: serde_json::Value = serde_json::from_str(&merged).expect("valid json");
        assert_eq!(v.pointer("/editor/vimMode"), Some(&serde_json::json!(true)));
        assert_eq!(
            v.pointer("/sandbox/networkAccess"),
            Some(&serde_json::json!("full"))
        );
        assert!(
            v.get("approvalMode").is_none(),
            "the legacy approvalMode key is dropped: the CLI never reads it \
             from cli-config.json"
        );
        assert_eq!(v.pointer("/sandbox/mode"), Some(&serde_json::json!("enabled")));
        assert_eq!(
            v.pointer("/permissions/allow"),
            Some(&serde_json::json!(["Shell(npm run build)"]))
        );
        assert_eq!(v.pointer("/permissions/deny"), Some(&serde_json::json!([])));
    }

    #[tokio::test]
    async fn qoder_probe_env_materializes_the_token() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        // The form value wins over saved env and is trimmed.
        let env = qoder_probe_env(&db, Some("  pat-123  ")).await;
        assert_eq!(
            env.get("QODER_PERSONAL_ACCESS_TOKEN").map(String::as_str),
            Some("pat-123")
        );

        // No token on screen → present but empty, so `run_qoder_probe` strips
        // any inherited one instead of probing a credential a launch wouldn't use.
        let cleared = qoder_probe_env(&db, Some("")).await;
        assert_eq!(
            cleared.get("QODER_PERSONAL_ACCESS_TOKEN").map(String::as_str),
            Some("")
        );
        let unset = qoder_probe_env(&db, None).await;
        assert_eq!(
            unset.get("QODER_PERSONAL_ACCESS_TOKEN").map(String::as_str),
            Some("")
        );
    }

    #[tokio::test]
    async fn cursor_probe_env_materializes_key_and_scrubs_base_url() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;

        // API-key mode: the form value wins over saved env and is trimmed; the
        // base URL is always scrubbed to empty (⇒ removed by run_cursor_probe).
        let env = cursor_probe_env(&db, Some("  my-key  ")).await;
        assert_eq!(env.get("CURSOR_API_KEY").map(String::as_str), Some("my-key"));
        assert_eq!(
            env.get("CURSOR_API_BASE_URL").map(String::as_str),
            Some("")
        );

        // Subscription passes an empty key → present but empty, so the probe
        // strips any inherited value instead of leaking it.
        let cleared = cursor_probe_env(&db, Some("")).await;
        assert_eq!(cleared.get("CURSOR_API_KEY").map(String::as_str), Some(""));
        assert_eq!(
            cleared.get("CURSOR_API_BASE_URL").map(String::as_str),
            Some("")
        );

        // No override + empty DB → key still materialized empty.
        let none = cursor_probe_env(&db, None).await;
        assert_eq!(none.get("CURSOR_API_KEY").map(String::as_str), Some(""));
        assert_eq!(
            none.get("CURSOR_API_BASE_URL").map(String::as_str),
            Some("")
        );
    }

    #[test]
    fn parse_cursor_models_reads_id_label_and_default() {
        // Verbatim shape of `cursor-agent models` (id - label [(default)]).
        let stdout = "Available models\n\n\
             auto - Auto (default)\n\
             claude-opus-4-8-high - Opus 4.8 1M\n\
             gpt-5.3-codex - Codex 5.3\n\
             claude-fable-5-thinking-high - Fable 5 1M Thinking (NO ZDR)\n";
        let (models, default_model) = parse_cursor_models(stdout);

        // The "Available models" header (has whitespace, no " - ") is skipped.
        assert_eq!(models.len(), 4);
        assert_eq!(default_model.as_deref(), Some("auto"));

        assert_eq!(models[0].id, "auto");
        assert_eq!(models[0].label, "Auto");
        assert!(models[0].is_default);

        assert_eq!(models[1].id, "claude-opus-4-8-high");
        assert_eq!(models[1].label, "Opus 4.8 1M");
        assert!(!models[1].is_default);

        // A parenthetical that isn't the default marker stays in the label.
        assert_eq!(models[3].label, "Fable 5 1M Thinking (NO ZDR)");
    }

    // `cursor-agent status` reports a login from token PRESENCE alone, so it
    // keeps saying "authenticated" long after the access token has aged out —
    // while `cursor-agent acp` refuses every `session/new` for exactly that
    // token. The one thing in the status output that tells them apart is the
    // `getMe` branch, and the panel's card is read off it.
    #[test]
    fn cursor_credential_verified_separates_a_stored_login_from_a_working_one() {
        // Real shape when the token still works.
        let working = serde_json::json!({
            "status": "authenticated",
            "isAuthenticated": true,
            "hasAccessToken": true,
            "hasRefreshToken": true,
            "userInfo": { "email": "itpkcn@gmail.com" }
        });
        assert_eq!(cursor_credential_verified(&working), Some(true));

        // Real shape when it does not: `isAuthenticated` is STILL true.
        let expired = serde_json::json!({
            "status": "authenticated",
            "isAuthenticated": true,
            "hasAccessToken": true,
            "hasRefreshToken": true,
            "message": "Logged in (unable to fetch user details)"
        });
        assert_eq!(cursor_credential_verified(&expired), Some(false));

        // The CLI's other "no email" branch means `getMe` SUCCEEDED; it must
        // not be read as a broken credential.
        let no_details = serde_json::json!({
            "status": "authenticated",
            "isAuthenticated": true,
            "message": "Logged in (user details not available)"
        });
        assert_eq!(cursor_credential_verified(&no_details), Some(true));

        // Nothing to verify — the card already says "not signed in".
        for absent in [
            serde_json::json!({ "status": "unauthenticated", "isAuthenticated": false }),
            serde_json::json!({
                "status": "partially-authenticated",
                "isAuthenticated": false,
                "message": "Partially authenticated (missing refresh token)"
            }),
            serde_json::json!({}),
        ] {
            assert_eq!(cursor_credential_verified(&absent), None);
        }
    }

    #[test]
    fn parse_cursor_models_tolerates_ansi_markers_and_bare_ids() {
        // ANSI SGR + a leading list marker + a bare-id line with no label.
        let stdout =
            "\u{1b}[1mAvailable models\u{1b}[0m\n- gpt-5.2 - GPT-5.2\ncomposer-2.5\n";
        let (models, default_model) = parse_cursor_models(stdout);
        assert_eq!(default_model, None);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "gpt-5.2");
        assert_eq!(models[0].label, "GPT-5.2");
        // Bare id (no " - <label>") → id kept, label empty.
        assert_eq!(models[1].id, "composer-2.5");
        assert_eq!(models[1].label, "");
    }

    #[tokio::test]
    async fn find_connection_for_conversation_core_returns_info_when_bound() {
        // A live connection bound to the conversation → discovery returns its
        // id plus the current event_seq (informational; the viewer cold-attaches
        // with a full snapshot, not a cursor replay).
        use crate::acp::manager::ConnectionManager;
        use crate::models::AgentType;
        use crate::web::event_bridge::EventEmitter;

        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        {
            let state = mgr.get_state("c1").await.expect("state present");
            let mut s = state.write().await;
            s.conversation_id = Some(42);
            s.event_seq = 7;
        }

        let info = acp_find_connection_for_conversation_core(&mgr, 42, None, AgentType::ClaudeCode)
            .await
            .expect("ok")
            .expect("a live connection is bound to conversation 42");
        assert_eq!(info.connection_id, "c1");
        assert_eq!(info.event_seq, 7);
    }

    #[tokio::test]
    async fn find_connection_for_conversation_core_none_when_unbound() {
        // No live connection owns the conversation → None (the client spawns +
        // owns one instead of attaching as a viewer).
        use crate::acp::manager::ConnectionManager;
        use crate::models::AgentType;
        use crate::web::event_bridge::EventEmitter;

        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        assert!(
            acp_find_connection_for_conversation_core(&mgr, 999, None, AgentType::ClaudeCode)
                .await
                .expect("ok")
                .is_none()
        );
    }

    #[tokio::test]
    async fn find_connection_for_conversation_core_falls_back_to_session_id() {
        // A live connection exists with its external_id set but its
        // conversation_id NOT yet bound (the pre-first-prompt window). The
        // by-conversation lookup misses; the session_id fallback finds it, so a
        // second client opening the same historical conversation attaches as a
        // viewer instead of reusing-as-owner and later killing the connection.
        use crate::acp::manager::ConnectionManager;
        use crate::models::AgentType;
        use crate::web::event_bridge::EventEmitter;

        let mgr = ConnectionManager::new();
        mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;
        {
            let state = mgr.get_state("c1").await.expect("state present");
            let mut s = state.write().await;
            s.external_id = Some("sess-abc".to_string());
            s.event_seq = 3;
            // conversation_id intentionally left None.
        }

        // by-conversation misses, no session fallback → None.
        assert!(
            acp_find_connection_for_conversation_core(&mgr, 42, None, AgentType::ClaudeCode)
                .await
                .expect("ok")
                .is_none(),
            "without a session_id fallback an unbound connection is undiscoverable"
        );

        // session fallback finds the live owner (matching agent_type).
        let info = acp_find_connection_for_conversation_core(
            &mgr,
            42,
            Some("sess-abc"),
            AgentType::ClaudeCode,
        )
        .await
        .expect("ok")
        .expect("session_id fallback finds the unbound live connection");
        assert_eq!(info.connection_id, "c1");
        assert_eq!(info.event_seq, 3);

        // a non-matching session id still misses.
        assert!(acp_find_connection_for_conversation_core(
            &mgr,
            42,
            Some("other"),
            AgentType::ClaudeCode
        )
        .await
        .expect("ok")
        .is_none());

        // the SAME session id but a DIFFERENT agent_type must NOT match
        // (external_id is unique only per agent) — otherwise a viewer could
        // attach to the wrong agent's connection.
        assert!(
            acp_find_connection_for_conversation_core(&mgr, 42, Some("sess-abc"), AgentType::Codex)
                .await
                .expect("ok")
                .is_none(),
            "external_id fallback must be scoped by agent_type"
        );
    }

    #[tokio::test]
    async fn find_connection_for_conversation_core_none_when_terminal_status() {
        // A connection bound to the conversation but already in a terminal
        // status (teardown wrote it before the map entry was removed) is NOT a
        // live attach target → None, so the viewer reads persisted detail
        // instead of attaching to a dying stream.
        use crate::acp::manager::ConnectionManager;
        use crate::models::AgentType;
        use crate::web::event_bridge::EventEmitter;

        for terminal in [ConnectionStatus::Disconnected, ConnectionStatus::Error] {
            let mgr = ConnectionManager::new();
            mgr.insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
                .await;
            {
                let state = mgr.get_state("c1").await.expect("state present");
                let mut s = state.write().await;
                s.conversation_id = Some(42);
                s.status = terminal.clone();
            }
            assert!(
                acp_find_connection_for_conversation_core(&mgr, 42, None, AgentType::ClaudeCode)
                    .await
                    .expect("ok")
                    .is_none(),
                "terminal status {terminal:?} must not be returned as a live connection"
            );
        }
    }

    #[test]
    fn sanitize_custom_version_accepts_version_like_inputs() {
        assert_eq!(sanitize_custom_version("0.44.1").as_deref(), Some("0.44.1"));
        assert_eq!(
            sanitize_custom_version("  v1.2.3 ").as_deref(),
            Some("1.2.3")
        );
        assert_eq!(
            sanitize_custom_version("2026.5.20").as_deref(),
            Some("2026.5.20")
        );
        assert_eq!(
            sanitize_custom_version("1.2.3-beta.1").as_deref(),
            Some("1.2.3-beta.1")
        );
        assert_eq!(
            sanitize_custom_version("1.0.0+build.5").as_deref(),
            Some("1.0.0+build.5")
        );
    }

    #[test]
    fn sanitize_custom_version_rejects_invalid_inputs() {
        for bad in [
            "",
            "   ",
            "latest",
            "next",
            "v",
            "2",
            "v9",
            "1.2 .3",
            "1.2.3@evil",
            "../etc",
        ] {
            assert_eq!(
                sanitize_custom_version(bad),
                None,
                "expected {bad:?} rejected"
            );
        }
    }

    #[test]
    fn build_npm_install_spec_uses_registry_when_no_override() {
        assert_eq!(
            build_npm_install_spec("@google/gemini-cli@0.44.1", None).unwrap(),
            "@google/gemini-cli@0.44.1"
        );
        assert_eq!(
            build_npm_install_spec("@google/gemini-cli@0.44.1", Some("  ")).unwrap(),
            "@google/gemini-cli@0.44.1"
        );
    }

    #[test]
    fn build_npm_install_spec_applies_custom_version() {
        assert_eq!(
            build_npm_install_spec("@google/gemini-cli@0.44.1", Some("0.43.0")).unwrap(),
            "@google/gemini-cli@0.43.0"
        );
        // Scoped/plain package name is preserved; a leading `v` is stripped.
        assert_eq!(
            build_npm_install_spec("cline@3.0.9", Some("v2.0.0")).unwrap(),
            "cline@2.0.0"
        );
    }

    #[test]
    fn build_npm_install_spec_rejects_invalid_override() {
        assert!(build_npm_install_spec("cline@3.0.9", Some("latest")).is_err());
    }

    // The pinned default is byte-identical to what `build_npm_install_spec`
    // produced before the channel existed, with no fallback attempt.
    #[test]
    fn npm_install_attempts_defaults_to_the_pinned_spec() {
        assert_eq!(
            npm_install_attempts("@google/gemini-cli@0.44.1", None, false).unwrap(),
            ("@google/gemini-cli@0.44.1".to_string(), None)
        );
        assert_eq!(
            npm_install_attempts("@google/gemini-cli@0.44.1", Some("  "), false).unwrap(),
            ("@google/gemini-cli@0.44.1".to_string(), None)
        );
    }

    // The latest channel tries the `latest` dist-tag first and keeps the
    // registry pin as the fallback, so a failed latest install degrades to the
    // reviewed version instead of no install at all.
    #[test]
    fn npm_install_attempts_maps_latest_channel_onto_the_dist_tag() {
        assert_eq!(
            npm_install_attempts("@google/gemini-cli@0.44.1", None, true).unwrap(),
            (
                "@google/gemini-cli@latest".to_string(),
                Some("@google/gemini-cli@0.44.1".to_string())
            )
        );
        // A blank override is the same as none.
        assert_eq!(
            npm_install_attempts("cline@3.0.9", Some(" "), true).unwrap(),
            ("cline@latest".to_string(), Some("cline@3.0.9".to_string()))
        );
    }

    // An explicit custom version wins on either channel and never falls back:
    // the user asked for that exact version, and quietly installing another
    // would relabel their choice.
    #[test]
    fn npm_install_attempts_lets_an_explicit_override_win() {
        assert_eq!(
            npm_install_attempts("cline@3.0.9", Some("2.0.0"), true).unwrap(),
            ("cline@2.0.0".to_string(), None)
        );
        assert!(npm_install_attempts("cline@3.0.9", Some("nightly"), true).is_err());
    }

    // The latest channel introduces a NEW SPEC SHAPE (`<name>@latest`), and the
    // spec — not the agent type — is what every downstream step keys off.
    // `npm_package_requires_scripts` is the one that bites: hermes-agent's
    // postinstall bootstraps its runtime, and it is the only package codeg
    // force-enables lifecycle scripts for. A spec shape that hid the package
    // name from it would install a shim that only fails later, at connect,
    // with "runtime is not ready". Both attempts must be recognized, since
    // either one can be the spec that actually lands.
    #[test]
    fn the_latest_spec_still_names_the_package_downstream_readers_key_off() {
        let (latest, pinned) = npm_install_attempts("hermes-agent@0.21.4", None, true).unwrap();
        assert_eq!(latest, "hermes-agent@latest");
        assert!(npm_package_requires_scripts(&latest));
        assert!(npm_package_requires_scripts(&pinned.unwrap()));
        // And the `@latest` tag is never mistaken for a version number, so a
        // successful latest install falls through to the real post-install
        // probe instead of recording "latest" as the installed version.
        assert_eq!(version_from_package_spec(&latest), None);
    }

    // Only the exact (trimmed) sentinel opts into the latest channel; absence
    // and every other value stay on the pin, matching the frontend reader.
    #[test]
    fn adapter_channel_reads_only_the_exact_latest_sentinel() {
        let env = |value: Option<&str>| {
            let mut map = BTreeMap::new();
            map.insert("XAI_API_KEY".to_string(), "abc".to_string());
            if let Some(value) = value {
                map.insert(ADAPTER_CHANNEL_ENV.to_string(), value.to_string());
            }
            map
        };
        assert!(!adapter_channel_is_latest(&env(None)));
        assert!(adapter_channel_is_latest(&env(Some("latest"))));
        assert!(adapter_channel_is_latest(&env(Some(" latest "))));
        assert!(!adapter_channel_is_latest(&env(Some("pinned"))));
        assert!(!adapter_channel_is_latest(&env(Some("Latest"))));
        assert!(!adapter_channel_is_latest(&env(Some(""))));
    }

    #[test]
    fn apply_custom_version_to_url_substitutes_all_occurrences() {
        // Codex URL embeds the version twice (path tag + asset filename).
        let codex = "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-aarch64-apple-darwin.tar.gz";
        assert_eq!(
            apply_custom_version_to_url(codex, "0.15.0", "0.14.0"),
            "https://github.com/zed-industries/codex-acp/releases/download/v0.14.0/codex-acp-0.14.0-aarch64-apple-darwin.tar.gz"
        );

        // OpenCode URL embeds the version once (path tag only).
        let opencode = "https://github.com/anomalyco/opencode/releases/download/v1.15.12/opencode-darwin-arm64.zip";
        assert_eq!(
            apply_custom_version_to_url(opencode, "1.15.12", "1.16.0"),
            "https://github.com/anomalyco/opencode/releases/download/v1.16.0/opencode-darwin-arm64.zip"
        );
    }

    #[test]
    fn parses_npm_global_prefix_stdout() {
        let prefix = npm_global_prefix_from_stdout(b"npm-prefix\n");
        assert_eq!(prefix.as_deref(), Some(Path::new("npm-prefix")));

        assert_eq!(npm_global_prefix_from_stdout(b"\n"), None);
    }

    #[test]
    fn resolves_npx_command_from_npm_prefix_bin_dir() {
        let prefix = unique_test_dir("npm-prefix");
        let bin_dir = npm_prefix_bin_dir(&prefix);
        std::fs::create_dir_all(&bin_dir).expect("create npm prefix bin directory");

        #[cfg(windows)]
        let command_path = bin_dir.join("gemini.cmd");
        #[cfg(not(windows))]
        let command_path = bin_dir.join("gemini");

        std::fs::write(&command_path, "").expect("write command shim");
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = std::fs::metadata(&command_path)
                .expect("read command shim metadata")
                .permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&command_path, permissions)
                .expect("mark command shim executable");
        }

        let resolved = resolve_npx_command_from_npm_prefix("gemini", &prefix);

        assert_eq!(resolved.as_deref(), Some(command_path.as_path()));
        let _ = std::fs::remove_dir_all(prefix);
    }

    #[tokio::test]
    async fn does_not_cache_failed_npm_global_prefix_resolution() {
        let cache = tokio::sync::OnceCell::const_new();
        let first = cached_npm_global_prefix_with(&cache, || async { None }).await;
        assert_eq!(first, None);

        let expected = PathBuf::from("npm-prefix");
        let second =
            cached_npm_global_prefix_with(&cache, || async { Some(expected.clone()) }).await;

        assert_eq!(second, Some(expected));
    }

    #[cfg(not(windows))]
    #[test]
    fn ignores_non_executable_npx_command_from_npm_prefix_bin_dir() {
        let prefix = unique_test_dir("npm-prefix-non-executable");
        let bin_dir = npm_prefix_bin_dir(&prefix);
        std::fs::create_dir_all(&bin_dir).expect("create npm prefix bin directory");
        let command_path = bin_dir.join("gemini");
        std::fs::write(&command_path, "").expect("write command shim");

        let resolved = resolve_npx_command_from_npm_prefix("gemini", &prefix);

        assert_eq!(resolved, None);
        let _ = std::fs::remove_dir_all(prefix);
    }

    fn write_skill_md(name: &str, body: &str) -> (PathBuf, PathBuf) {
        let dir = unique_test_dir(name);
        let path = dir.join("SKILL.md");
        std::fs::write(&path, body).expect("write skill markdown");
        (dir, path)
    }

    #[test]
    fn frontmatter_scalar_strips_quotes_and_rejects_blocks() {
        assert_eq!(
            parse_frontmatter_scalar(" \"hello world\"  ").as_deref(),
            Some("hello world")
        );
        assert_eq!(
            parse_frontmatter_scalar(" 'single quoted' ").as_deref(),
            Some("single quoted")
        );
        assert_eq!(
            parse_frontmatter_scalar("  unquoted value  ").as_deref(),
            Some("unquoted value")
        );
        assert_eq!(parse_frontmatter_scalar("   ").as_deref(), None);
        assert_eq!(parse_frontmatter_scalar(" |").as_deref(), None);
        assert_eq!(parse_frontmatter_scalar(" > folded").as_deref(), None);
    }

    #[test]
    fn skill_description_reads_top_level_description() {
        let (dir, path) = write_skill_md(
            "skill-top-desc",
            "---\nname: demo\ndescription: top level desc\n---\nbody\n",
        );
        assert_eq!(
            read_skill_description(&path).as_deref(),
            Some("top level desc")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_prefers_nested_short_description() {
        let (dir, path) = write_skill_md(
            "skill-short-desc",
            "---\nname: demo\ndescription: long fallback\nmetadata:\n  short-description: pithy summary\n---\nbody\n",
        );
        assert_eq!(
            read_skill_description(&path).as_deref(),
            Some("pithy summary")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_falls_back_when_no_short() {
        let (dir, path) = write_skill_md(
            "skill-fallback",
            "---\nname: demo\ndescription: \"quoted fallback\"\nmetadata:\n  other: value\n---\nbody\n",
        );
        assert_eq!(
            read_skill_description(&path).as_deref(),
            Some("quoted fallback")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_ignores_nested_description_key() {
        // A nested `description:` (e.g. inside `metadata:` or a tool block)
        // must not be picked up as the top-level fallback.
        let (dir, path) = write_skill_md(
            "skill-nested-desc",
            "---\nname: demo\nmetadata:\n  description: nested only\n---\nbody\n",
        );
        assert_eq!(read_skill_description(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_requires_frontmatter_fence() {
        let (dir, path) = write_skill_md(
            "skill-no-fence",
            "name: demo\ndescription: not really frontmatter\n",
        );
        assert_eq!(read_skill_description(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_stops_at_closing_fence() {
        let (dir, path) = write_skill_md(
            "skill-closed",
            "---\nname: demo\n---\ndescription: in body, not frontmatter\n",
        );
        assert_eq!(read_skill_description(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_handles_utf8_content() {
        let (dir, path) = write_skill_md(
            "skill-utf8",
            "---\nname: demo\ndescription: 中文 描述 🚀\n---\nbody\n",
        );
        assert_eq!(
            read_skill_description(&path).as_deref(),
            Some("中文 描述 🚀")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skill_description_returns_none_for_missing_file() {
        let dir = unique_test_dir("skill-missing");
        let path = dir.join("does-not-exist.md");
        assert_eq!(read_skill_description(&path), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    // ----- Hermes config helpers -----

    #[test]
    fn parse_env_file_ignores_comments_and_strips_quotes() {
        let raw = "# comment\n\nexport OPENROUTER_API_KEY=\"sk-or-123\"\nOPENAI_BASE_URL='https://x.test/v1'\nBARE=plain\n=novalue\n";
        let map = parse_env_file(raw);
        assert_eq!(map.get("OPENROUTER_API_KEY").map(String::as_str), Some("sk-or-123"));
        assert_eq!(map.get("OPENAI_BASE_URL").map(String::as_str), Some("https://x.test/v1"));
        assert_eq!(map.get("BARE").map(String::as_str), Some("plain"));
        assert!(!map.contains_key(""));
    }

    #[test]
    fn patch_env_text_replaces_in_place_and_preserves_rest() {
        let existing = "# secrets\nOPENROUTER_API_KEY=old\n\nOTHER_TOKEN=keep\n";
        let out = patch_env_text(existing, &[("OPENROUTER_API_KEY", "new")]);
        assert!(out.contains("# secrets"), "comment preserved: {out}");
        assert!(out.contains("OPENROUTER_API_KEY=new"), "key replaced: {out}");
        assert!(!out.contains("OPENROUTER_API_KEY=old"), "old value gone: {out}");
        assert!(out.contains("OTHER_TOKEN=keep"), "unrelated key preserved: {out}");
        // Replacement happens in place, not appended at the end.
        assert_eq!(out.matches("OPENROUTER_API_KEY=").count(), 1);
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn patch_env_text_drops_duplicate_keys() {
        // A pre-existing duplicate must not survive: parse_env_file is
        // last-occurrence-wins, so a stale second line would shadow the update.
        let existing = "OPENAI_API_KEY=old1\nKEEP=1\nOPENAI_API_KEY=old2\n";
        let out = patch_env_text(existing, &[("OPENAI_API_KEY", "new")]);
        assert_eq!(out.matches("OPENAI_API_KEY=").count(), 1, "single key: {out}");
        assert!(out.contains("OPENAI_API_KEY=new"));
        assert!(!out.contains("old1") && !out.contains("old2"), "stale gone: {out}");
        assert!(out.contains("KEEP=1"));
        // And a reader of the result sees the new value, not a stale shadow.
        assert_eq!(
            parse_env_file(&out).get("OPENAI_API_KEY").map(String::as_str),
            Some("new")
        );
    }

    #[test]
    fn patch_env_text_appends_missing_key() {
        let out = patch_env_text("EXISTING=1\n", &[("ANTHROPIC_API_KEY", "sk-ant")]);
        assert!(out.contains("EXISTING=1"));
        assert!(out.contains("ANTHROPIC_API_KEY=sk-ant"));
        let empty = patch_env_text("", &[("OPENAI_API_KEY", "k")]);
        assert_eq!(empty, "OPENAI_API_KEY=k\n");
    }

    #[test]
    fn patch_env_text_empty_value_clears_present_and_appends_to_mask() {
        // Clearing a PRESENT key rewrites it to `KEY=` in place.
        let cleared = patch_env_text("OPENAI_API_KEY=secret\nKEEP=1\n", &[("OPENAI_API_KEY", "")]);
        assert!(cleared.contains("OPENAI_API_KEY="));
        assert!(!cleared.contains("OPENAI_API_KEY=secret"));
        assert!(cleared.contains("KEEP=1"));
        // An ABSENT key is still appended as an explicit empty line — under
        // Hermes' dotenv override loading that is what masks a value of the same
        // name inherited from the process environment.
        let absent = patch_env_text("KEEP=1\n", &[("OPENAI_API_KEY", "")]);
        assert!(absent.contains("KEEP=1"));
        assert!(absent.contains("OPENAI_API_KEY="));
    }

    #[test]
    fn merge_hermes_model_config_sets_model_and_keeps_other_keys() {
        let existing = "terminal:\n  backend: local\nmodel:\n  default: old-model\n  provider: openai\n";
        let merged = merge_hermes_model_config(
            Some(existing),
            "openrouter",
            "moonshotai/kimi-k2",
            BaseUrlWrite::Preserve,
            InlineApiKeyWrite::Clear,
        )
        .expect("merge");
        let value: serde_yaml::Value = serde_yaml::from_str(&merged).expect("parse merged");
        let model = value.get("model").expect("model section");
        assert_eq!(model.get("provider").and_then(|v| v.as_str()), Some("openrouter"));
        assert_eq!(
            model.get("default").and_then(|v| v.as_str()),
            Some("moonshotai/kimi-k2")
        );
        // Unrelated top-level keys survive the targeted merge.
        assert_eq!(
            value.get("terminal").and_then(|t| t.get("backend")).and_then(|v| v.as_str()),
            Some("local")
        );
        // No base_url was requested, so none is written.
        assert!(model.get("base_url").is_none());
    }

    #[test]
    fn merge_hermes_model_config_set_writes_clears_and_preserve_keeps_base_url() {
        let with_base = merge_hermes_model_config(
            None,
            "openai-api",
            "my-model",
            BaseUrlWrite::Set("https://api.test/v1"),
            InlineApiKeyWrite::Clear,
        )
        .expect("merge with base");
        let value: serde_yaml::Value = serde_yaml::from_str(&with_base).expect("parse");
        assert_eq!(
            value.get("model").and_then(|m| m.get("base_url")).and_then(|v| v.as_str()),
            Some("https://api.test/v1")
        );
        // Set("") clears the field (user emptied the API URL input).
        let cleared = merge_hermes_model_config(
            Some(&with_base),
            "openai-api",
            "my-model",
            BaseUrlWrite::Set(""),
            InlineApiKeyWrite::Clear,
        )
        .expect("merge clear");
        let value: serde_yaml::Value = serde_yaml::from_str(&cleared).expect("parse");
        assert!(value.get("model").and_then(|m| m.get("base_url")).is_none());
        // Preserve leaves an existing endpoint untouched (provider whose base URL
        // is not user-editable in the panel must not lose an out-of-band value).
        let kept = merge_hermes_model_config(
            Some(&with_base),
            "anthropic",
            "my-model",
            BaseUrlWrite::Preserve,
            InlineApiKeyWrite::Clear,
        )
        .expect("merge preserve");
        let value: serde_yaml::Value = serde_yaml::from_str(&kept).expect("parse");
        assert_eq!(
            value.get("model").and_then(|m| m.get("base_url")).and_then(|v| v.as_str()),
            Some("https://api.test/v1")
        );
    }

    #[test]
    fn merge_hermes_model_config_custom_writes_and_clears_inline_key() {
        // custom writes the key inline in `model.api_key` (+ keeps base_url).
        let with_key = merge_hermes_model_config(
            None,
            "custom",
            "gpt-5.5",
            BaseUrlWrite::Set("https://endpoint.test/v1"),
            InlineApiKeyWrite::Set {
                key: "sk-abc",
                scrub_mode: true,
            },
        )
        .expect("merge custom");
        let value: serde_yaml::Value = serde_yaml::from_str(&with_key).expect("parse");
        let model = value.get("model").expect("model section");
        assert_eq!(model.get("provider").and_then(|v| v.as_str()), Some("custom"));
        assert_eq!(model.get("api_key").and_then(|v| v.as_str()), Some("sk-abc"));
        assert_eq!(
            model.get("base_url").and_then(|v| v.as_str()),
            Some("https://endpoint.test/v1")
        );

        // A blank inline key drops the field (keyless local server).
        let keyless = merge_hermes_model_config(
            Some(&with_key),
            "custom",
            "gpt-5.5",
            BaseUrlWrite::Set("https://endpoint.test/v1"),
            InlineApiKeyWrite::Set {
                key: "",
                scrub_mode: false,
            },
        )
        .expect("merge keyless");
        let value: serde_yaml::Value = serde_yaml::from_str(&keyless).expect("parse");
        assert!(value.get("model").and_then(|m| m.get("api_key")).is_none());

        // custom→custom re-save with scrub_mode=false preserves a raw-editor
        // `api_mode`; switching in with scrub_mode=true drops it.
        let with_mode = "model:\n  provider: custom\n  default: m\n  api_mode: anthropic_messages\n";
        let resaved = merge_hermes_model_config(
            Some(with_mode),
            "custom",
            "m",
            BaseUrlWrite::Set("https://e/v1"),
            InlineApiKeyWrite::Set {
                key: "sk-1",
                scrub_mode: false,
            },
        )
        .expect("merge resave");
        let value: serde_yaml::Value = serde_yaml::from_str(&resaved).expect("parse");
        assert_eq!(
            value
                .get("model")
                .and_then(|m| m.get("api_mode"))
                .and_then(|v| v.as_str()),
            Some("anthropic_messages"),
            "custom→custom re-save preserves api_mode"
        );
        let switched_in = merge_hermes_model_config(
            Some(with_mode),
            "custom",
            "m",
            BaseUrlWrite::Set("https://e/v1"),
            InlineApiKeyWrite::Set {
                key: "sk-1",
                scrub_mode: true,
            },
        )
        .expect("merge switch-in");
        let value: serde_yaml::Value = serde_yaml::from_str(&switched_in).expect("parse");
        assert!(
            value.get("model").and_then(|m| m.get("api_mode")).is_none(),
            "switching TO custom scrubs a stale api_mode"
        );

        // Switching to a keyed provider scrubs the stale inline key + api_mode.
        let stale = "model:\n  provider: custom\n  default: gpt-5.5\n  api_key: sk-old\n  api_mode: chat_completions\n";
        let switched = merge_hermes_model_config(
            Some(stale),
            "anthropic",
            "claude",
            BaseUrlWrite::Set(""),
            InlineApiKeyWrite::Clear,
        )
        .expect("merge switch");
        let value: serde_yaml::Value = serde_yaml::from_str(&switched).expect("parse");
        let model = value.get("model").expect("model section");
        assert!(model.get("api_key").is_none(), "stale inline key must be scrubbed");
        assert!(model.get("api_mode").is_none(), "stale api_mode must be scrubbed");
    }

    #[test]
    fn plan_hermes_write_preserves_base_url_for_fixed_endpoint_provider() {
        // Anthropic (needsBaseUrl: false) behind a proxy: a structured save that
        // doesn't touch the hidden API URL field must keep the existing endpoint.
        let existing = "model:\n  provider: anthropic\n  default: old\n  base_url: https://my-proxy/v1\n";
        let (yaml, env) = plan_hermes_write(
            "anthropic",
            Some("sk-ant"),
            "claude-x",
            None,
            None,
            Some(existing),
        )
        .expect("plan");
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        assert_eq!(
            value.get("model").and_then(|m| m.get("base_url")).and_then(|v| v.as_str()),
            Some("https://my-proxy/v1"),
            "out-of-band base_url must survive a structured save"
        );
        // Only the API key is touched in `.env`; no base-URL var for anthropic.
        assert_eq!(env, vec![("ANTHROPIC_API_KEY", "sk-ant".to_string())]);
    }

    #[test]
    fn plan_hermes_write_clears_stale_base_url_on_provider_switch() {
        // Existing config is `openai-api` with a custom proxy endpoint; the user
        // switches to `anthropic` (fixed endpoint, field hidden). The stale OpenAI
        // base URL must NOT carry over to anthropic.
        let existing =
            "model:\n  provider: openai-api\n  default: gpt-x\n  base_url: https://openai-proxy/v1\n";
        let (yaml, _env) = plan_hermes_write(
            "anthropic",
            Some("sk-ant"),
            "claude-x",
            None,
            None,
            Some(existing),
        )
        .expect("plan");
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        assert_eq!(
            value.get("model").and_then(|m| m.get("provider")).and_then(|v| v.as_str()),
            Some("anthropic")
        );
        assert!(
            value.get("model").and_then(|m| m.get("base_url")).is_none(),
            "stale base_url from the previous provider must be cleared on switch: {yaml}"
        );
    }

    #[test]
    fn plan_hermes_write_neutralizes_openrouter_openai_fallback() {
        // Saving openrouter ALWAYS writes empty OPENAI_API_KEY/OPENAI_BASE_URL —
        // hermes 0.16.0 openrouter resolution falls back to OPENAI_API_KEY (and
        // treats OPENAI_BASE_URL as an override). It runs regardless of the
        // previous provider, including legacy ids no longer in the table.
        for prev in ["openai-api", "openai", "custom", "anthropic"] {
            let existing = format!("model:\n  provider: {prev}\n  default: m\n");
            let (_, env) = plan_hermes_write("openrouter", None, "m", None, None, Some(&existing))
                .expect("→openrouter");
            assert!(
                env.contains(&("OPENAI_API_KEY", String::new())),
                "OPENAI_API_KEY must be neutralized (prev={prev}): {env:?}"
            );
            assert!(env.contains(&("OPENAI_BASE_URL", String::new())));
            // Blank openrouter key → its own var is left untouched.
            assert!(!env.iter().any(|(k, _)| *k == "OPENROUTER_API_KEY"));
        }
        // A provided key is written alongside the neutralization.
        let (_, env) = plan_hermes_write("openrouter", Some("sk-or"), "m", None, None, None)
            .expect("keyed");
        assert!(env.contains(&("OPENROUTER_API_KEY", "sk-or".to_string())));
        assert!(env.contains(&("OPENAI_API_KEY", String::new())));
    }

    #[test]
    fn plan_hermes_write_switch_preserves_unrelated_previous_credential() {
        // Switching anthropic → zai must NOT wipe the still-valid ANTHROPIC_API_KEY
        // (zai does not read it, so clearing it would only destroy a good
        // credential). Only zai's own key var is written.
        let existing = "model:\n  provider: anthropic\n  default: m\n";
        let (_, env) = plan_hermes_write("zai", Some("sk-glm"), "m", None, None, Some(existing))
            .expect("anthropic→zai");
        assert_eq!(env, vec![("GLM_API_KEY", "sk-glm".to_string())]);
        assert!(!env.iter().any(|(k, _)| *k == "ANTHROPIC_API_KEY"));
    }

    #[cfg(unix)]
    #[test]
    fn write_hermes_secret_file_secures_fresh_and_preserves_existing() {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let mode_of = |p: &Path| fs::metadata(p).expect("metadata").permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path().join(".hermes");
        fs::create_dir_all(&home).expect("home");

        // A brand-new secret is created owner-only (0600) and round-trips.
        let env_path = home.join(".env");
        write_hermes_secret_file(&env_path, "OPENROUTER_API_KEY=sk-1\n", ".env")
            .expect("write env");
        assert_eq!(mode_of(&env_path), 0o600, "fresh .env must be 0600");
        assert_eq!(
            fs::read_to_string(&env_path).unwrap(),
            "OPENROUTER_API_KEY=sk-1\n"
        );
        let cfg_path = home.join("config.yaml");
        write_hermes_secret_file(&cfg_path, "model:\n  provider: openai-api\n", "config.yaml")
            .expect("write config.yaml");
        assert_eq!(mode_of(&cfg_path), 0o600, "fresh config.yaml must be 0600");

        // An existing file is written through IN PLACE: a managed group-readable
        // mode (0640) and the inode itself are preserved (so owner/group, ACL and
        // xattrs ride along), while the content updates.
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o640)).expect("loosen");
        let inode_before = fs::metadata(&env_path).unwrap().ino();
        write_hermes_secret_file(&env_path, "OPENROUTER_API_KEY=sk-2\n", ".env")
            .expect("rewrite env");
        assert_eq!(mode_of(&env_path), 0o640, "existing managed mode must be preserved");
        assert_eq!(
            fs::metadata(&env_path).unwrap().ino(),
            inode_before,
            "existing file must be rewritten in place (same inode), not replaced"
        );
        assert_eq!(
            fs::read_to_string(&env_path).unwrap(),
            "OPENROUTER_API_KEY=sk-2\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_hermes_secret_file_writes_through_symlink() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        // A dotfile/secret-manager layout: config.yaml is a symlink to the real
        // file. Saving must update the real target and keep the symlink intact.
        let real = dir.join("real-config.yaml");
        fs::write(&real, "model:\n  provider: openai-api\n").unwrap();
        let link = dir.join("config.yaml");
        std::os::unix::fs::symlink(&real, &link).unwrap();

        write_hermes_secret_file(&link, "model:\n  provider: anthropic\n", "config.yaml")
            .expect("write through symlink");
        assert!(
            fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the symlink must be preserved, not replaced by a regular file"
        );
        assert_eq!(
            fs::read_to_string(&real).unwrap(),
            "model:\n  provider: anthropic\n",
            "the symlink's real target must be updated"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_hermes_secret_file_secures_dangling_symlink_target() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        // A managed layout: `.env` symlinks to a target that doesn't exist yet.
        let real = dir.join("vault-hermes.env");
        let link = dir.join(".env");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        assert!(fs::metadata(&link).is_err(), "precondition: dangling symlink");

        write_hermes_secret_file(&link, "OPENROUTER_API_KEY=sk\n", ".env").expect("write");
        // The target is created THROUGH the symlink and is owner-only (0600), not
        // the umask default (0644) — a fresh secret must never be world-readable.
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600,
            "a freshly created symlink target must be 0600"
        );
        assert_eq!(fs::read_to_string(&real).unwrap(), "OPENROUTER_API_KEY=sk\n");
        assert!(
            fs::symlink_metadata(&link).unwrap().file_type().is_symlink(),
            "the symlink itself must be preserved"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_hermes_secret_file_tightens_world_readable_existing_secret() {
        use std::os::unix::fs::PermissionsExt;
        // The tightening is honored only where Hermes would chmod (not a
        // container/managed opt-out, e.g. a Docker CI runner with /.dockerenv).
        if hermes_skip_chmod() {
            return;
        }
        let mode_of = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();

        // A secret left world-readable (0644) by an older build is repaired to
        // owner-only 0600 on the next save (0640 would still expose it to a broad
        // group like staff); content updates.
        let env_path = dir.join(".env");
        fs::write(&env_path, "OPENROUTER_API_KEY=old\n").unwrap();
        fs::set_permissions(&env_path, fs::Permissions::from_mode(0o644)).unwrap();
        write_hermes_secret_file(&env_path, "OPENROUTER_API_KEY=new\n", ".env").unwrap();
        assert_eq!(mode_of(&env_path), 0o600, "a world-readable 0644 secret → 0600");
        assert_eq!(
            fs::read_to_string(&env_path).unwrap(),
            "OPENROUTER_API_KEY=new\n"
        );

        // A deliberately group-shared managed mode (0640, no world bits) survives.
        let managed = dir.join("managed.env");
        fs::write(&managed, "K=1\n").unwrap();
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o640)).unwrap();
        write_hermes_secret_file(&managed, "K=2\n", ".env").unwrap();
        assert_eq!(mode_of(&managed), 0o640, "managed group-shared mode preserved");
    }

    #[cfg(unix)]
    #[test]
    fn ensure_hermes_home_secure_respects_existing_and_managed_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let mode_of = |p: &Path| fs::metadata(p).expect("metadata").permissions().mode() & 0o777;
        let tmp = tempfile::tempdir().expect("tempdir");

        // Fresh home → 0700 by default (HERMES_HOME_MODE cleared so the assertion
        // is deterministic regardless of the ambient env; skipped when this env
        // opts out of chmod, like a Docker CI runner).
        temp_env::with_var("HERMES_HOME_MODE", None::<&str>, || {
            let fresh = tmp.path().join("fresh-hermes");
            ensure_hermes_home_secure(&fresh).expect("ensure fresh");
            if !hermes_skip_chmod() {
                assert_eq!(mode_of(&fresh), 0o700, "fresh hermes home must be 0700");
            }
        });

        // HERMES_HOME_MODE overrides the default for a freshly-created home (e.g.
        // 0750 for a web server that traverses HERMES_HOME).
        temp_env::with_var("HERMES_HOME_MODE", Some("0750"), || {
            let fresh = tmp.path().join("fresh-hermes-moded");
            ensure_hermes_home_secure(&fresh).expect("ensure fresh moded");
            if !hermes_skip_chmod() {
                assert_eq!(mode_of(&fresh), 0o750, "HERMES_HOME_MODE must be honored");
            }
        });

        // A pre-existing, group-accessible home (managed/NixOS layout) is left
        // untouched — revoking shared access would break other Hermes processes.
        let managed = tmp.path().join("managed-hermes");
        fs::create_dir_all(&managed).unwrap();
        fs::set_permissions(&managed, fs::Permissions::from_mode(0o755)).unwrap();
        ensure_hermes_home_secure(&managed).expect("ensure managed");
        assert_eq!(mode_of(&managed), 0o755, "existing hermes home mode preserved");
    }

    // ── Hermes base-URL reconcile (auxiliary/main endpoint parity) ──────────

    #[test]
    fn plan_hermes_base_url_reconcile_mirrors_yaml_when_env_absent() {
        // openai-api with config.yaml model.base_url but no .env OPENAI_BASE_URL
        // → write the var so the auxiliary path matches the main loop.
        assert_eq!(
            plan_hermes_base_url_reconcile("openai-api", Some("https://sub2api/v1"), None),
            Some(("OPENAI_BASE_URL", "https://sub2api/v1".to_string()))
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_no_op_when_equal() {
        assert_eq!(
            plan_hermes_base_url_reconcile(
                "openai-api",
                Some("https://sub2api/v1"),
                Some("https://sub2api/v1"),
            ),
            None
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_ignores_trailing_slash() {
        // Trailing-slash-only differences must not churn .env (both directions).
        assert_eq!(
            plan_hermes_base_url_reconcile("openai-api", Some("https://x/v1/"), Some("https://x/v1")),
            None
        );
        assert_eq!(
            plan_hermes_base_url_reconcile("openai-api", Some("https://x/v1"), Some("https://x/v1/")),
            None
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_clears_stale_when_yaml_empty() {
        // config.yaml has no base_url but .env carries a stale override → clear it
        // (empty value) so it can't shadow the registry default in the aux path.
        assert_eq!(
            plan_hermes_base_url_reconcile("openai-api", None, Some("https://old/v1")),
            Some(("OPENAI_BASE_URL", String::new()))
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_no_op_when_both_empty() {
        // Absent var and explicitly-empty var both → no-op (no redundant `KEY=`).
        assert_eq!(plan_hermes_base_url_reconcile("openai-api", None, None), None);
        assert_eq!(plan_hermes_base_url_reconcile("openai-api", None, Some("")), None);
        assert_eq!(plan_hermes_base_url_reconcile("openai-api", Some("  "), Some("")), None);
    }

    #[test]
    fn plan_hermes_base_url_reconcile_skips_unknown_provider() {
        for p in ["custom", "openai", "custom:my-proxy", "totally-unknown"] {
            assert_eq!(
                plan_hermes_base_url_reconcile(p, Some("https://x/v1"), None),
                None,
                "unknown provider {p} must be a no-op"
            );
        }
    }

    #[test]
    fn plan_hermes_base_url_reconcile_skips_providers_without_base_url_var() {
        // OAuth / AWS / kimi-coding-cn carry no base-URL env var → never written,
        // even when config.yaml has a base_url.
        for p in ["nous", "bedrock", "kimi-coding-cn"] {
            assert_eq!(
                plan_hermes_base_url_reconcile(p, Some("https://x/v1"), None),
                None,
                "provider {p} has no base_url env var"
            );
        }
    }

    #[test]
    fn plan_hermes_base_url_reconcile_openrouter_only_touches_its_own_var() {
        // openrouter never returns an OPENAI_BASE_URL write (that would re-pollute
        // the panel's neutralization); it only reconciles OPENROUTER_BASE_URL.
        assert_eq!(plan_hermes_base_url_reconcile("openrouter", None, None), None);
        assert_eq!(
            plan_hermes_base_url_reconcile("openrouter", Some("https://or/api/v1"), None),
            Some(("OPENROUTER_BASE_URL", "https://or/api/v1".to_string()))
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_covers_non_needs_base_url_providers() {
        // The aux/main asymmetry is not limited to openai-api — a proxied anthropic
        // (base_url in YAML, not in .env) has the same divergence.
        assert_eq!(
            plan_hermes_base_url_reconcile("anthropic", Some("https://proxy/anthropic"), None),
            Some(("ANTHROPIC_BASE_URL", "https://proxy/anthropic".to_string()))
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_writes_verbatim_not_normalized() {
        // When a write IS needed, the trailing slash is preserved in the value
        // (only the comparison normalizes it).
        assert_eq!(
            plan_hermes_base_url_reconcile(
                "openai-api",
                Some("https://x/v1/"),
                Some("https://x/other"),
            ),
            Some(("OPENAI_BASE_URL", "https://x/v1/".to_string()))
        );
    }

    #[test]
    fn plan_hermes_base_url_reconcile_rejects_embedded_newline() {
        // A base_url carrying a newline must never be mirrored — it would inject an
        // extra `.env` line (another provider's var) through patch_env_text.
        assert_eq!(
            plan_hermes_base_url_reconcile(
                "openai-api",
                Some("https://x/v1\nOPENROUTER_BASE_URL=https://evil"),
                None,
            ),
            None
        );
        assert_eq!(
            plan_hermes_base_url_reconcile(
                "openai-api",
                Some("https://x/v1\rFOO=bar"),
                Some("https://x/v1"),
            ),
            None
        );
    }

    #[test]
    fn reconcile_writes_env_and_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openai-api\n  default: gpt-5.5\n  base_url: https://sub2api/v1\n",
        )
        .unwrap();
        fs::write(home.join(".env"), "OPENAI_API_KEY=sk-secret\n").unwrap();

        reconcile_hermes_runtime_env_in(home).expect("reconcile");
        let env = fs::read_to_string(home.join(".env")).unwrap();
        assert!(
            env.contains("OPENAI_BASE_URL=https://sub2api/v1"),
            "base url mirrored: {env:?}"
        );
        assert!(
            env.contains("OPENAI_API_KEY=sk-secret"),
            "existing key preserved: {env:?}"
        );

        // Second run is a pure no-op: content AND mtime unchanged (the planner
        // returns None, so .env is never reopened for writing).
        let mtime1 = fs::metadata(home.join(".env")).unwrap().modified().unwrap();
        reconcile_hermes_runtime_env_in(home).expect("reconcile again");
        assert_eq!(
            fs::read_to_string(home.join(".env")).unwrap(),
            env,
            "idempotent content"
        );
        assert_eq!(
            fs::metadata(home.join(".env")).unwrap().modified().unwrap(),
            mtime1,
            "idempotent run must not rewrite .env"
        );
    }

    #[test]
    fn reconcile_no_op_without_config_yaml() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(home.join(".env"), "OPENAI_API_KEY=sk\n").unwrap();
        reconcile_hermes_runtime_env_in(home).expect("reconcile");
        assert_eq!(
            fs::read_to_string(home.join(".env")).unwrap(),
            "OPENAI_API_KEY=sk\n",
            ".env must be byte-identical when there is no config.yaml"
        );
    }

    #[test]
    fn reconcile_preserves_openrouter_neutralization() {
        // openrouter with no model.base_url + the panel's empty OPENAI_* masks must
        // survive untouched (reconcile only ever considers OPENROUTER_BASE_URL).
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openrouter\n  default: x\n",
        )
        .unwrap();
        let env = "OPENROUTER_API_KEY=sk-or\nOPENAI_API_KEY=\nOPENAI_BASE_URL=\n";
        fs::write(home.join(".env"), env).unwrap();
        reconcile_hermes_runtime_env_in(home).expect("reconcile");
        assert_eq!(
            fs::read_to_string(home.join(".env")).unwrap(),
            env,
            "neutralization preserved"
        );
    }

    #[test]
    fn reconcile_clears_stale_base_url_on_disk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        // openai-api with no base_url in config.yaml, but a stale OPENAI_BASE_URL.
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openai-api\n  default: gpt-5.5\n",
        )
        .unwrap();
        fs::write(
            home.join(".env"),
            "OPENAI_API_KEY=sk\nOPENAI_BASE_URL=https://old/v1\n",
        )
        .unwrap();
        reconcile_hermes_runtime_env_in(home).expect("reconcile");
        let env = fs::read_to_string(home.join(".env")).unwrap();
        assert!(env.contains("OPENAI_BASE_URL=\n"), "stale base url cleared: {env:?}");
        assert!(env.contains("OPENAI_API_KEY=sk"), "key preserved: {env:?}");
    }

    #[test]
    fn reconcile_skips_unreadable_env_without_clobbering() {
        // An existing-but-unreadable `.env` (invalid UTF-8) must abort the
        // reconcile, not be rewritten from an empty baseline — otherwise the
        // user's API keys/comments would be dropped on launch.
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openai-api\n  base_url: https://sub2api/v1\n",
        )
        .unwrap();
        let raw: &[u8] = b"\xff\xfeOPENAI_API_KEY=sk-secret\n";
        fs::write(home.join(".env"), raw).unwrap();
        assert!(
            reconcile_hermes_runtime_env_in(home).is_err(),
            "an unreadable .env must surface an error, not silently patch from empty"
        );
        assert_eq!(
            fs::read(home.join(".env")).unwrap(),
            raw.to_vec(),
            "an unreadable .env must be left byte-identical, never clobbered"
        );
    }

    #[test]
    fn hermes_home_for_launch_matches_hermes_resolution() {
        // A non-empty override is used VERBATIM — Hermes' get_hermes_home does
        // `Path(val.strip())` with no `~` expansion, so reconcile must not expand
        // either (both an absolute path and a literal `~/…` path are passed as-is).
        let mut abs = BTreeMap::new();
        abs.insert("HERMES_HOME".to_string(), "/tmp/hermes-alt".to_string());
        assert_eq!(hermes_home_for_launch(&abs), PathBuf::from("/tmp/hermes-alt"));

        let mut tilde = BTreeMap::new();
        tilde.insert("HERMES_HOME".to_string(), "~/alt-hermes".to_string());
        assert_eq!(hermes_home_for_launch(&tilde), PathBuf::from("~/alt-hermes"));

        // A blank override REPLACES the parent value in the child, and Hermes then
        // falls back to the default `~/.hermes` — not the parent's HERMES_HOME.
        let mut blank = BTreeMap::new();
        blank.insert("HERMES_HOME".to_string(), "  ".to_string());
        assert_eq!(
            hermes_home_for_launch(&blank),
            home_dir_or_default().join(".hermes")
        );

        // No override → the child inherits the parent env (codeg's resolution).
        assert_eq!(hermes_home_for_launch(&BTreeMap::new()), hermes_home_dir());
    }

    #[test]
    fn reconcile_wrapper_targets_runtime_env_home() {
        // End-to-end: the wrapper must patch the `.env` under the launch env's
        // HERMES_HOME, not the parent/default home.
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openai-api\n  base_url: https://sub2api/v1\n",
        )
        .unwrap();
        fs::write(home.join(".env"), "OPENAI_API_KEY=sk\n").unwrap();
        let mut runtime_env = BTreeMap::new();
        runtime_env.insert("HERMES_HOME".to_string(), home.display().to_string());

        reconcile_hermes_runtime_env(&runtime_env);
        let env = fs::read_to_string(home.join(".env")).unwrap();
        assert!(
            env.contains("OPENAI_BASE_URL=https://sub2api/v1"),
            "wrapper reconciled the runtime_env HERMES_HOME: {env:?}"
        );
        assert!(env.contains("OPENAI_API_KEY=sk"), "key preserved: {env:?}");
    }

    #[cfg(unix)]
    #[test]
    fn reconcile_writes_through_symlinked_env() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        fs::write(
            home.join("config.yaml"),
            "model:\n  provider: openai-api\n  base_url: https://sub2api/v1\n",
        )
        .unwrap();
        // .env is a symlink to a real target (dotfile-manager layout).
        let real = home.join("vault.env");
        fs::write(&real, "OPENAI_API_KEY=sk\n").unwrap();
        std::os::unix::fs::symlink(&real, home.join(".env")).unwrap();

        reconcile_hermes_runtime_env_in(home).expect("reconcile");
        assert!(
            fs::symlink_metadata(home.join(".env"))
                .unwrap()
                .file_type()
                .is_symlink(),
            "symlink preserved"
        );
        let env = fs::read_to_string(&real).unwrap();
        assert!(
            env.contains("OPENAI_BASE_URL=https://sub2api/v1"),
            "target updated: {env:?}"
        );
        assert!(env.contains("OPENAI_API_KEY=sk"), "key preserved: {env:?}");
    }

    #[cfg(unix)]
    #[test]
    fn hermes_skip_chmod_requires_a_non_empty_opt_out() {
        // A non-empty opt-out enables skip.
        temp_env::with_vars(
            [
                ("HERMES_SKIP_CHMOD", Some("1")),
                ("HERMES_CONTAINER", None),
            ],
            || assert!(hermes_skip_chmod(), "non-empty HERMES_SKIP_CHMOD skips"),
        );
        // An EMPTY opt-out must NOT skip (Hermes' Python truthiness treats `` as
        // falsy) — but only assert that on a host that isn't itself a container.
        let host_is_container = temp_env::with_vars(
            [
                ("HERMES_SKIP_CHMOD", None::<&str>),
                ("HERMES_CONTAINER", None),
            ],
            hermes_skip_chmod,
        );
        if !host_is_container {
            temp_env::with_vars(
                [
                    ("HERMES_SKIP_CHMOD", Some("")),
                    ("HERMES_CONTAINER", Some("")),
                ],
                || assert!(!hermes_skip_chmod(), "an empty opt-out must not skip"),
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn parse_hermes_home_mode_handles_octal_and_defaults() {
        assert_eq!(parse_hermes_home_mode(None), 0o700);
        assert_eq!(parse_hermes_home_mode(Some("")), 0o700);
        assert_eq!(parse_hermes_home_mode(Some("0701")), 0o701);
        assert_eq!(parse_hermes_home_mode(Some(" 750 ")), 0o750);
        assert_eq!(parse_hermes_home_mode(Some("0o700")), 0o700);
        assert_eq!(parse_hermes_home_mode(Some("nonsense")), 0o700);
    }

    #[test]
    fn hermes_provider_maps_key_var_and_base_url_flag() {
        let openrouter = hermes_provider("openrouter").expect("openrouter");
        assert_eq!(openrouter.key_env_var, "OPENROUTER_API_KEY");
        assert!(!openrouter.needs_base_url);
        // `openai-api` is the OpenAI-compatible path: OPENAI_API_KEY + a
        // user-supplied base URL.
        let openai_api = hermes_provider("openai-api").expect("openai-api");
        assert_eq!(openai_api.key_env_var, "OPENAI_API_KEY");
        assert!(openai_api.needs_base_url);
        // Hermes' first-priority key var per provider (auth.py PROVIDER_REGISTRY).
        assert_eq!(hermes_provider("zai").expect("zai").key_env_var, "GLM_API_KEY");
        assert_eq!(
            hermes_provider("kimi-coding").expect("kimi-coding").key_env_var,
            "KIMI_API_KEY"
        );
        // OAuth + AWS providers carry no API-key env var (set via terminal --setup
        // or the AWS SDK chain).
        assert_eq!(hermes_provider("nous").expect("nous").key_env_var, "");
        assert_eq!(hermes_provider("bedrock").expect("bedrock").key_env_var, "");
        // `custom` IS in the table — the OpenAI-compatible BYO endpoint. It has
        // no `.env` key/base-url var (both ride inline in config.yaml), but is
        // flagged user-editable so the API URL field renders.
        let custom = hermes_provider("custom").expect("custom");
        assert_eq!(custom.key_env_var, "");
        assert_eq!(custom.base_url_env_var, "");
        assert!(custom.needs_base_url);
        assert!(hermes_inlines_api_key("custom"));
        assert!(!hermes_inlines_api_key("openai-api"));
        // The legacy bare `openai` alias (which Hermes routes to OpenRouter) is
        // intentionally not in the table.
        assert!(hermes_provider("openai").is_none());
        assert!(hermes_provider("does-not-exist").is_none());
    }

    #[test]
    fn hermes_provider_key_env_vars_match_authoritative_registry() {
        // The full id → first api-key env var mapping from Hermes' own
        // `hermes_cli/auth.py` PROVIDER_REGISTRY (empty for OAuth/AWS providers).
        // Locks the table down so a wrong mapping (e.g. zai → ZAI_API_KEY instead
        // of GLM_API_KEY) fails CI rather than silently sending the wrong key var.
        let expected: &[(&str, &str)] = &[
            ("openrouter", "OPENROUTER_API_KEY"),
            ("openai-api", "OPENAI_API_KEY"),
            ("anthropic", "ANTHROPIC_API_KEY"),
            ("gemini", "GOOGLE_API_KEY"),
            ("deepseek", "DEEPSEEK_API_KEY"),
            ("xai", "XAI_API_KEY"),
            ("zai", "GLM_API_KEY"),
            ("minimax", "MINIMAX_API_KEY"),
            ("minimax-cn", "MINIMAX_CN_API_KEY"),
            ("kimi-coding", "KIMI_API_KEY"),
            ("kimi-coding-cn", "KIMI_CN_API_KEY"),
            ("nvidia", "NVIDIA_API_KEY"),
            ("alibaba", "DASHSCOPE_API_KEY"),
            ("alibaba-coding-plan", "ALIBABA_CODING_PLAN_API_KEY"),
            ("copilot", "COPILOT_GITHUB_TOKEN"),
            ("lmstudio", "LM_API_KEY"),
            ("azure-foundry", "AZURE_FOUNDRY_API_KEY"),
            ("stepfun", "STEPFUN_API_KEY"),
            ("arcee", "ARCEEAI_API_KEY"),
            ("gmi", "GMI_API_KEY"),
            ("huggingface", "HF_TOKEN"),
            ("kilocode", "KILOCODE_API_KEY"),
            ("opencode-zen", "OPENCODE_ZEN_API_KEY"),
            ("opencode-go", "OPENCODE_GO_API_KEY"),
            ("xiaomi", "XIAOMI_API_KEY"),
            ("tencent-tokenhub", "TOKENHUB_API_KEY"),
            ("ollama-cloud", "OLLAMA_API_KEY"),
            ("novita", "NOVITA_API_KEY"),
            ("ai-gateway", "AI_GATEWAY_API_KEY"),
            // BYO OpenAI-compatible endpoint — key rides inline in config.yaml,
            // so it has no `.env` key var.
            ("custom", ""),
            ("nous", ""),
            ("openai-codex", ""),
            ("minimax-oauth", ""),
            ("xai-oauth", ""),
            ("qwen-oauth", ""),
            ("google-gemini-cli", ""),
            ("copilot-acp", ""),
            ("bedrock", ""),
            // Vertex AI authenticates via Google service-account/ADC OAuth2 —
            // no key var, no base-URL var (endpoint computed per request).
            ("vertex", ""),
        ];
        assert_eq!(
            expected.len(),
            HERMES_PROVIDERS.len(),
            "expected list must cover every table entry"
        );
        for (id, key) in expected {
            let p = hermes_provider(id).unwrap_or_else(|| panic!("missing provider {id}"));
            assert_eq!(p.key_env_var, *key, "{id} key_env_var");
        }
        // No table entry is left unverified.
        for p in HERMES_PROVIDERS {
            assert!(
                expected.iter().any(|(id, _)| *id == p.id),
                "untested provider {}",
                p.id
            );
        }
        // The base-URL env var for the three user-supplied-endpoint providers.
        assert_eq!(
            hermes_provider("openai-api").unwrap().base_url_env_var,
            "OPENAI_BASE_URL"
        );
        assert_eq!(
            hermes_provider("lmstudio").unwrap().base_url_env_var,
            "LM_BASE_URL"
        );
        assert_eq!(
            hermes_provider("azure-foundry").unwrap().base_url_env_var,
            "AZURE_FOUNDRY_BASE_URL"
        );
    }

    #[test]
    fn plan_hermes_write_structured_maps_key_and_config() {
        let (yaml, env) =
            plan_hermes_write("anthropic", Some("sk-ant-1"), "kimi", None, None, None)
                .expect("plan");
        assert_eq!(env, vec![("ANTHROPIC_API_KEY", "sk-ant-1".to_string())]);
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        assert_eq!(
            value.get("model").and_then(|m| m.get("provider")).and_then(|v| v.as_str()),
            Some("anthropic")
        );
    }

    #[test]
    fn plan_hermes_write_custom_inlines_key_and_base_url_never_touching_env() {
        let (yaml, env) = plan_hermes_write(
            "custom",
            Some("sk-custom-1"),
            "gpt-5.5",
            Some("https://endpoint.test/v1"),
            None,
            None,
        )
        .expect("plan custom");
        // custom NEVER writes `.env` — key + endpoint live inline in config.yaml.
        assert!(env.is_empty(), "custom must not write any .env var");
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        let model = value.get("model").expect("model section");
        assert_eq!(model.get("provider").and_then(|v| v.as_str()), Some("custom"));
        assert_eq!(model.get("default").and_then(|v| v.as_str()), Some("gpt-5.5"));
        assert_eq!(model.get("api_key").and_then(|v| v.as_str()), Some("sk-custom-1"));
        assert_eq!(
            model.get("base_url").and_then(|v| v.as_str()),
            Some("https://endpoint.test/v1")
        );
        // A newline in the inline key is rejected (same guard as the `.env` path).
        assert!(plan_hermes_write(
            "custom",
            Some("sk\nbad"),
            "m",
            Some("https://x/v1"),
            None,
            None
        )
        .is_err());

        // Switching TO custom from another provider that carried an `api_mode`
        // scrubs the stale mode (it must not bleed into the custom endpoint).
        let prior = "model:\n  provider: openai-api\n  default: gpt\n  api_mode: chat_completions\n";
        let (yaml, _env) = plan_hermes_write(
            "custom",
            Some("sk-2"),
            "gpt-5.5",
            Some("https://e/v1"),
            None,
            Some(prior),
        )
        .expect("plan switch-in");
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        assert!(
            value.get("model").and_then(|m| m.get("api_mode")).is_none(),
            "stale api_mode must be scrubbed when switching to custom"
        );
    }

    #[test]
    fn plan_hermes_write_raw_mode_never_touches_env() {
        // Even if a caller sends an apiKey alongside rawConfigYaml, the .env must
        // not be updated (server-side contract, not payload-dependent).
        let (yaml, env) = plan_hermes_write(
            "openrouter",
            Some("sk-or-should-be-ignored"),
            "kimi",
            None,
            Some("model:\n  provider: anthropic\n"),
            None,
        )
        .expect("plan");
        assert!(env.is_empty(), "raw mode must not write .env");
        assert!(yaml.contains("anthropic"), "raw yaml written verbatim: {yaml}");
    }

    #[test]
    fn plan_hermes_write_oauth_and_blank_key_produce_no_env() {
        // OAuth provider (empty key var) → no .env update.
        let (_, env) = plan_hermes_write("nous", Some("ignored"), "m", None, None, None)
            .expect("oauth");
        assert!(env.is_empty());
        // Blank key on a keyed provider with no base-URL var → nothing touched.
        let (_, env) = plan_hermes_write("anthropic", Some("   "), "m", None, None, None)
            .expect("blank");
        assert!(env.is_empty());
        let (_, env) =
            plan_hermes_write("anthropic", None, "m", None, None, None).expect("none");
        assert!(env.is_empty());
    }

    #[test]
    fn plan_hermes_write_rejects_newline_key_and_invalid_yaml() {
        assert!(
            plan_hermes_write("openai-api", Some("a\nb"), "m", None, None, None).is_err(),
            "newline in key must be rejected"
        );
        assert!(
            plan_hermes_write("openai-api", None, "m", None, Some("model: [unterminated"), None)
                .is_err(),
            "invalid raw yaml must be rejected"
        );
    }

    #[test]
    fn plan_hermes_write_openai_api_provider_writes_base_url() {
        let (yaml, env) = plan_hermes_write(
            "openai-api",
            Some("sk-x"),
            "m",
            Some("https://api.test/v1"),
            None,
            None,
        )
        .expect("plan");
        // The endpoint is written to BOTH the key var's sibling base-URL var and
        // config.yaml model.base_url, so the two agree under either resolution path.
        assert_eq!(
            env,
            vec![
                ("OPENAI_API_KEY", "sk-x".to_string()),
                ("OPENAI_BASE_URL", "https://api.test/v1".to_string()),
            ]
        );
        let value: serde_yaml::Value = serde_yaml::from_str(&yaml).expect("yaml");
        assert_eq!(
            value.get("model").and_then(|m| m.get("base_url")).and_then(|v| v.as_str()),
            Some("https://api.test/v1")
        );
        // Clearing the base URL writes an empty override so a stale `.env` value
        // can't shadow the default endpoint.
        let (_, env) = plan_hermes_write("openai-api", None, "m", None, None, None)
            .expect("clear base");
        assert_eq!(env, vec![("OPENAI_BASE_URL", String::new())]);
    }

    #[test]
    fn plan_hermes_write_structured_rejects_unknown_provider() {
        // Legacy/unknown ids can't be mapped to a credential layout → reject in
        // structured mode so we never write a provider with no credential.
        // (`custom` IS handled now — see `plan_hermes_write_custom_*`.)
        assert!(plan_hermes_write("openai", Some("k"), "m", None, None, None).is_err());
        assert!(plan_hermes_write("totally-made-up", None, "m", None, None, None).is_err());
        // Raw mode stays the escape hatch: any provider id is accepted verbatim.
        let (yaml, env) = plan_hermes_write(
            "custom:my-proxy",
            None,
            "m",
            None,
            Some("model:\n  provider: custom:my-proxy\n"),
            None,
        )
        .expect("raw mode accepts any provider");
        assert!(env.is_empty());
        assert!(yaml.contains("custom:my-proxy"));
    }

    #[test]
    fn project_hermes_key_and_base_falls_back_to_env_base_url() {
        let mut env = BTreeMap::new();
        env.insert("OPENAI_API_KEY".to_string(), "sk-1".to_string());
        env.insert("OPENAI_BASE_URL".to_string(), "https://proxy/v1".to_string());
        // No YAML base_url → the panel still sees the endpoint from `.env`, so a
        // later save won't clear it (regression guard for the dual-write change).
        let (key, base) = project_hermes_key_and_base("openai-api", &env, None, None);
        assert_eq!(key, Some("sk-1".to_string()));
        assert_eq!(base, Some("https://proxy/v1".to_string()));
        // YAML base_url wins over the env fallback.
        let (_, base) =
            project_hermes_key_and_base("openai-api", &env, Some("https://yaml/v1"), None);
        assert_eq!(base, Some("https://yaml/v1".to_string()));
        // A keyed provider with no base-URL var and no YAML base → no base URL.
        let mut env2 = BTreeMap::new();
        env2.insert("ANTHROPIC_API_KEY".to_string(), "sk-a".to_string());
        let (key, base) = project_hermes_key_and_base("anthropic", &env2, None, None);
        assert_eq!(key, Some("sk-a".to_string()));
        assert_eq!(base, None);
        // `custom` reads its key from config.yaml `model.api_key`, NOT `.env`.
        let (key, base) = project_hermes_key_and_base(
            "custom",
            &env,
            Some("https://endpoint/v1"),
            Some("sk-inline"),
        );
        assert_eq!(key, Some("sk-inline".to_string()));
        assert_eq!(base, Some("https://endpoint/v1".to_string()));
        // Unknown provider → nothing projected from `.env`.
        let (key, base) = project_hermes_key_and_base("custom:x", &env, None, None);
        assert_eq!(key, None);
        assert_eq!(base, None);
    }

    #[test]
    fn uvx_python_args_pins_interpreter_or_is_empty() {
        assert_eq!(
            uvx_python_args(Some("3.13")),
            vec!["--python".to_string(), "3.13".to_string()]
        );
        assert!(uvx_python_args(None).is_empty());
    }

    #[test]
    fn shell_quote_arg_leaves_spacefree_windows_paths_unquoted() {
        // A backslash path with no spaces must NOT be quoted on Windows. A
        // leading double-quoted string makes PowerShell parse the line as a
        // string expression and fail with "Unexpected token" instead of running
        // uvx; an unquoted bare path runs in both cmd and PowerShell.
        let path = r"C:\Users\Administrator\AppData\Local\app.codeg\acp-binaries\uv-tool\windows-x86_64\uvx.exe";
        assert_eq!(shell_quote_arg_for(path, true), path);
        // On POSIX the backslash is the escape char, so it still forces quoting.
        assert_eq!(shell_quote_arg_for(path, false), format!("'{path}'"));
    }

    #[test]
    fn shell_quote_arg_still_quotes_when_required() {
        // Spaces force quoting on both platforms (this case is the known
        // PowerShell-incompatible residual: a quoted leading path needs `&`).
        assert_eq!(
            shell_quote_arg_for(r"C:\Program Files\uv-tool\uvx.exe", true),
            "\"C:\\Program Files\\uv-tool\\uvx.exe\""
        );
        // The pinned package's brackets and comma must stay quoted so PowerShell
        // does not split `[acp,mcp]` into an array argument.
        let pkg = "hermes-agent[acp,mcp]==0.19.0";
        assert_eq!(shell_quote_arg_for(pkg, true), format!("\"{pkg}\""));
        assert_eq!(shell_quote_arg_for(pkg, false), format!("'{pkg}'"));
        // Plain flag/value tokens are never quoted on either platform.
        for windows in [true, false] {
            assert_eq!(shell_quote_arg_for("--python", windows), "--python");
            assert_eq!(shell_quote_arg_for("3.13", windows), "3.13");
            assert_eq!(shell_quote_arg_for("hermes-acp", windows), "hermes-acp");
        }
    }

    #[tokio::test]
    async fn hermes_setup_argvs_address_the_hermes_bin() {
        // Every recipe form must drive the wrapper's `hermes` bin (the ACP
        // CLI): `<hermes> acp --setup` / `<hermes> model` when a binary
        // resolves, else `npx -y --package <pin> hermes …`. The `--package`
        // flag is load-bearing in the npx form — the package's DEFAULT bin is
        // `hermes-agent` (`run_agent:main`), not the `hermes` CLI — and the
        // pinned spec keeps the on-demand bootstrap on the audited version.
        let (setup, model) = hermes_setup_argvs().await;
        assert_eq!(setup.last().map(String::as_str), Some("--setup"));
        assert_eq!(model.last().map(String::as_str), Some("model"));
        for argv in [&setup, &model] {
            if argv.first().map(String::as_str) == Some("npx") {
                let pkg_idx = argv
                    .iter()
                    .position(|a| a == "--package")
                    .expect("npx recipe must pin via --package");
                assert_eq!(
                    argv.get(pkg_idx + 1).map(String::as_str),
                    Some("hermes-agent@0.21.4")
                );
                assert_eq!(argv.get(pkg_idx + 2).map(String::as_str), Some("hermes"));
            } else {
                // Resolved-binary form: bare `hermes` from PATH or an absolute
                // npm-prefix path ending in the hermes bin.
                let first = argv.first().expect("non-empty argv");
                assert!(
                    first == "hermes"
                        || std::path::Path::new(first)
                            .file_name()
                            .and_then(|n| n.to_str())
                            .is_some_and(|n| n.trim_end_matches(".cmd").trim_end_matches(".exe")
                                == "hermes"),
                    "unexpected launcher: {argv:?}"
                );
            }
        }
    }

    #[test]
    fn kimi_parse_provider_model_uses_kimi_model_name() {
        let out = parse_provider_model(AgentType::KimiCode, Some("kimi-for-coding"));
        assert_eq!(
            out.get("KIMI_MODEL_NAME"),
            Some(&Some("kimi-for-coding".to_string()))
        );
        assert!(!out.contains_key("OPENAI_MODEL"));
    }

    #[test]
    fn kimi_managed_block_writes_provider_model_and_default() {
        let spec = KimiManagedSpec {
            interface_type: "anthropic".to_string(),
            base_url: Some("https://api.anthropic.com".to_string()),
            api_key: Some("sk-ant".to_string()),
            env: BTreeMap::new(),
            model: "claude-opus-4-7".to_string(),
            max_context_size: Some(200_000),
            capabilities: Vec::new(),
            support_efforts: Vec::new(),
            default_effort: None,
        };
        let mut doc = toml::Value::Table(toml::map::Map::new());
        // Pre-existing user content that must survive a managed-block write.
        doc.as_table_mut()
            .unwrap()
            .insert("telemetry".to_string(), toml::Value::Boolean(true));
        apply_kimi_managed_block(&mut doc, Some(&spec)).expect("write managed block");
        // Round-trip through the serializer the real writer uses.
        let serialized = toml::to_string_pretty(&doc).expect("serialize");
        let reparsed: toml::Value = serialized.parse().expect("valid toml");
        let t = reparsed.as_table().unwrap();
        assert_eq!(t.get("telemetry").and_then(toml::Value::as_bool), Some(true));
        assert_eq!(
            t.get("default_model").and_then(toml::Value::as_str),
            Some(KIMI_MANAGED_MODEL_ALIAS)
        );
        let provider = t
            .get("providers")
            .and_then(|p| p.get(KIMI_MANAGED_PROVIDER))
            .and_then(toml::Value::as_table)
            .expect("managed provider present");
        assert_eq!(
            provider.get("type").and_then(toml::Value::as_str),
            Some("anthropic")
        );
        assert_eq!(
            provider.get("api_key").and_then(toml::Value::as_str),
            Some("sk-ant")
        );
        let model = t
            .get("models")
            .and_then(|m| m.get(KIMI_MANAGED_MODEL_ALIAS))
            .and_then(toml::Value::as_table)
            .expect("managed model present");
        assert_eq!(
            model.get("provider").and_then(toml::Value::as_str),
            Some(KIMI_MANAGED_PROVIDER)
        );
        assert_eq!(
            model.get("model").and_then(toml::Value::as_str),
            Some("claude-opus-4-7")
        );
        assert_eq!(
            model.get("max_context_size").and_then(toml::Value::as_integer),
            Some(200_000)
        );
    }

    #[test]
    fn kimi_managed_block_always_writes_positive_max_context_size() {
        // Regression: kimi's schema requires `max_context_size` to be a positive
        // integer and silently discards the whole `[models.*]` block when it is
        // missing — leaving `default_model` dangling so every prompt ends with no
        // reply. A blank field MUST therefore still serialize a positive default.
        for ctx in [None, Some(0), Some(-5)] {
            let spec = KimiManagedSpec {
                interface_type: "kimi".to_string(),
                base_url: Some("https://api.moonshot.cn/v1".to_string()),
                api_key: Some("sk-test".to_string()),
                env: BTreeMap::new(),
                model: "kimi-k2.7-code".to_string(),
                max_context_size: ctx,
                capabilities: Vec::new(),
                support_efforts: Vec::new(),
                default_effort: None,
            };
            let mut doc = toml::Value::Table(toml::map::Map::new());
            apply_kimi_managed_block(&mut doc, Some(&spec)).expect("write managed block");
            let serialized = toml::to_string_pretty(&doc).expect("serialize");
            let reparsed: toml::Value = serialized.parse().expect("valid toml");
            let written = reparsed
                .get("models")
                .and_then(|m| m.get(KIMI_MANAGED_MODEL_ALIAS))
                .and_then(|m| m.get("max_context_size"))
                .and_then(toml::Value::as_integer)
                .expect("max_context_size present for ctx input");
            assert!(
                written > 0,
                "expected a positive max_context_size for input {ctx:?}, got {written}"
            );
            assert_eq!(written, KIMI_DEFAULT_MAX_CONTEXT_SIZE);
        }
    }

    #[test]
    fn kimi_managed_block_clear_preserves_user_sections() {
        let mut doc: toml::Value = r#"
default_model = "mine"
[providers.codeg]
type = "openai"
api_key = "sk"
[providers.mine]
type = "openai"
api_key = "sk-user"
[models.codeg-managed]
provider = "codeg"
model = "x"
[models.mine]
provider = "mine"
model = "gpt"
"#
        .parse()
        .expect("valid toml");
        apply_kimi_managed_block(&mut doc, None).expect("clear managed block");
        let t = doc.as_table().unwrap();
        // A user-owned default_model (not our alias) survives untouched.
        assert_eq!(
            t.get("default_model").and_then(toml::Value::as_str),
            Some("mine")
        );
        let providers = t.get("providers").and_then(toml::Value::as_table).unwrap();
        assert!(!providers.contains_key(KIMI_MANAGED_PROVIDER));
        assert!(providers.contains_key("mine"));
        let models = t.get("models").and_then(toml::Value::as_table).unwrap();
        assert!(!models.contains_key(KIMI_MANAGED_MODEL_ALIAS));
        assert!(models.contains_key("mine"));
    }

    #[test]
    fn kimi_managed_block_clear_resets_our_default_and_empties() {
        let mut doc: toml::Value = r#"
default_model = "codeg-managed"
[providers.codeg]
type = "kimi"
[models.codeg-managed]
provider = "codeg"
model = "kimi-for-coding"
"#
        .parse()
        .expect("valid toml");
        apply_kimi_managed_block(&mut doc, None).expect("clear");
        let t = doc.as_table().unwrap();
        assert!(t.get("default_model").is_none());
        // Emptied tables are dropped entirely.
        assert!(t.get("providers").is_none());
        assert!(t.get("models").is_none());
    }

    #[test]
    fn kimi_build_spec_env_auth_writes_provider_key_var() {
        let update = KimiCodeConfigUpdate {
            mode: "apikey".to_string(),
            interface_type: Some("openai".to_string()),
            auth_type: Some("env".to_string()),
            base_url: Some("https://api.deepseek.com/v1".to_string()),
            api_key: Some("sk-deep".to_string()),
            model: Some("deepseek-chat".to_string()),
            max_context_size: None,
            vertex_project: None,
            vertex_location: None,
            raw_config_toml: None,
            reasoning_enabled: None,
            always_thinking: None,
            support_efforts: None,
            default_effort: None,
        };
        let spec = build_kimi_managed_spec(&update).expect("valid spec");
        // env auth → key lands in the provider env sub-table, NOT the inline field.
        assert!(spec.api_key.is_none());
        assert_eq!(spec.env.get("OPENAI_API_KEY"), Some(&"sk-deep".to_string()));
    }

    #[test]
    fn kimi_build_spec_vertex_uses_adc_not_api_key() {
        let update = KimiCodeConfigUpdate {
            mode: "apikey".to_string(),
            interface_type: Some("vertexai".to_string()),
            auth_type: None,
            base_url: None,
            api_key: Some("ignored".to_string()),
            model: Some("gemini-2.5-pro".to_string()),
            max_context_size: None,
            vertex_project: Some("my-proj".to_string()),
            vertex_location: Some("us-central1".to_string()),
            raw_config_toml: None,
            reasoning_enabled: None,
            always_thinking: None,
            support_efforts: None,
            default_effort: None,
        };
        let spec = build_kimi_managed_spec(&update).expect("valid vertex spec");
        assert!(spec.api_key.is_none());
        assert_eq!(
            spec.env.get("GOOGLE_CLOUD_PROJECT"),
            Some(&"my-proj".to_string())
        );
        assert_eq!(
            spec.env.get("GOOGLE_CLOUD_LOCATION"),
            Some(&"us-central1".to_string())
        );
    }

    #[test]
    fn kimi_build_spec_rejects_unknown_type_and_missing_model() {
        let base = KimiCodeConfigUpdate {
            mode: "apikey".to_string(),
            interface_type: Some("nope".to_string()),
            auth_type: None,
            base_url: None,
            api_key: None,
            model: Some("m".to_string()),
            max_context_size: None,
            vertex_project: None,
            vertex_location: None,
            raw_config_toml: None,
            reasoning_enabled: None,
            always_thinking: None,
            support_efforts: None,
            default_effort: None,
        };
        assert!(build_kimi_managed_spec(&base).is_err());
        let no_model = KimiCodeConfigUpdate {
            interface_type: Some("kimi".to_string()),
            model: None,
            ..base.clone()
        };
        assert!(build_kimi_managed_spec(&no_model).is_err());
    }

    /// A minimal valid api-key update; reasoning fields are filled per test.
    fn kimi_reasoning_update(
        reasoning_enabled: Option<bool>,
        always_thinking: Option<bool>,
        support_efforts: Option<Vec<String>>,
        default_effort: Option<&str>,
    ) -> KimiCodeConfigUpdate {
        KimiCodeConfigUpdate {
            mode: "apikey".to_string(),
            interface_type: Some("kimi".to_string()),
            auth_type: None,
            base_url: None,
            api_key: Some("sk-x".to_string()),
            model: Some("kimi-k2".to_string()),
            max_context_size: None,
            vertex_project: None,
            vertex_location: None,
            raw_config_toml: None,
            reasoning_enabled,
            always_thinking,
            support_efforts,
            default_effort: default_effort.map(str::to_string),
        }
    }

    #[test]
    fn kimi_reasoning_off_writes_no_capability_keys() {
        // With reasoning off the model block must stay byte-identical to the
        // pre-feature shape: an ABSENT `capabilities` is what keeps kimi's
        // permissive "allow every modality" default in force.
        let spec = build_kimi_managed_spec(&kimi_reasoning_update(None, None, None, None))
            .expect("valid spec");
        assert!(spec.capabilities.is_empty());
        assert!(spec.support_efforts.is_empty());
        assert!(spec.default_effort.is_none());

        let mut doc = toml::Value::Table(toml::map::Map::new());
        apply_kimi_managed_block(&mut doc, Some(&spec)).expect("applied");
        let model = doc
            .get("models")
            .and_then(|m| m.get(KIMI_MANAGED_MODEL_ALIAS))
            .and_then(toml::Value::as_table)
            .expect("model block");
        assert!(model.get("capabilities").is_none());
        assert!(model.get("support_efforts").is_none());
        assert!(model.get("default_effort").is_none());
    }

    #[test]
    fn kimi_reasoning_on_declares_thinking_plus_the_permissive_modalities() {
        // `thinking` alone would REVOKE image/video input, because kimi only
        // treats an absent capabilities array as "allow all".
        let spec = build_kimi_managed_spec(&kimi_reasoning_update(
            Some(true),
            None,
            Some(vec!["low".into(), "high".into()]),
            Some("high"),
        ))
        .expect("valid spec");
        assert_eq!(
            spec.capabilities,
            vec!["thinking", "image_in", "video_in", "tool_use"]
        );
        assert_eq!(spec.support_efforts, vec!["low", "high"]);
        assert_eq!(spec.default_effort.as_deref(), Some("high"));

        let mut doc = toml::Value::Table(toml::map::Map::new());
        apply_kimi_managed_block(&mut doc, Some(&spec)).expect("applied");
        let model = doc
            .get("models")
            .and_then(|m| m.get(KIMI_MANAGED_MODEL_ALIAS))
            .and_then(toml::Value::as_table)
            .expect("model block");
        let caps: Vec<&str> = model["capabilities"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(toml::Value::as_str)
            .collect();
        assert!(caps.contains(&"thinking") && caps.contains(&"image_in"));
        assert_eq!(
            model["default_effort"].as_str(),
            Some("high"),
            "default_effort must reach config.toml"
        );
    }

    #[test]
    fn kimi_reasoning_off_clears_keys_a_previous_save_wrote() {
        // Turning reasoning back off must REMOVE the keys, not just stop
        // refreshing them: a lingering `capabilities` array would keep kimi in
        // whitelist mode (and keep advertising a Thinking picker) forever.
        let mut doc = toml::Value::Table(toml::map::Map::new());
        let on = build_kimi_managed_spec(&kimi_reasoning_update(
            Some(true),
            Some(true),
            Some(vec!["low".into(), "high".into()]),
            Some("high"),
        ))
        .expect("valid spec");
        apply_kimi_managed_block(&mut doc, Some(&on)).expect("write reasoning on");
        assert!(doc["models"][KIMI_MANAGED_MODEL_ALIAS]
            .get("capabilities")
            .is_some());

        let off = build_kimi_managed_spec(&kimi_reasoning_update(Some(false), None, None, None))
            .expect("valid spec");
        apply_kimi_managed_block(&mut doc, Some(&off)).expect("write reasoning off");
        let model = doc["models"][KIMI_MANAGED_MODEL_ALIAS]
            .as_table()
            .expect("model block");
        assert!(model.get("capabilities").is_none(), "capabilities must go");
        assert!(model.get("support_efforts").is_none());
        assert!(model.get("default_effort").is_none());
        // The keys that are NOT part of reasoning must survive the rewrite.
        assert_eq!(model["model"].as_str(), Some("kimi-k2"));
        assert!(model.get("max_context_size").is_some());
    }

    #[test]
    fn kimi_reasoning_always_thinking_swaps_the_capability() {
        let spec = build_kimi_managed_spec(&kimi_reasoning_update(
            Some(true),
            Some(true),
            Some(vec!["high".into()]),
            None,
        ))
        .expect("valid spec");
        assert!(spec.capabilities.contains(&"always_thinking".to_string()));
        assert!(!spec.capabilities.contains(&"thinking".to_string()));
    }

    #[test]
    fn kimi_reasoning_normalizes_efforts_and_drops_an_unlisted_default() {
        let spec = build_kimi_managed_spec(&kimi_reasoning_update(
            Some(true),
            None,
            Some(vec![
                "  low  ".into(),
                "".into(),
                "low".into(),
                "high".into(),
            ]),
            // kimi clamps an unlisted default to the middle entry anyway, so
            // writing it would only misreport what the composer will show.
            Some("max"),
        ))
        .expect("valid spec");
        assert_eq!(spec.support_efforts, vec!["low", "high"]);
        assert!(spec.default_effort.is_none());
    }

    #[test]
    fn kimi_reasoning_rejects_a_newline_in_an_effort() {
        let err = build_kimi_managed_spec(&kimi_reasoning_update(
            Some(true),
            None,
            Some(vec!["hi\ngh".into()]),
            None,
        ));
        assert!(err.is_err());
    }

    #[test]
    fn kimi_project_managed_config_round_trips_reasoning_metadata() {
        let value: toml::Value = r#"
default_model = "codeg-managed"
[providers.codeg]
type = "openai_responses"
[models.codeg-managed]
provider = "codeg"
model = "gpt-5.6-sol"
max_context_size = 1000000
capabilities = ["thinking", "image_in", "video_in", "tool_use"]
support_efforts = ["low", "medium", "high"]
default_effort = "high"
"#
        .parse()
        .expect("valid toml");
        let proj = project_kimi_managed_config(&value);
        let caps: Vec<&str> = proj["capabilities"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(caps.contains(&"thinking"));
        let efforts: Vec<&str> = proj["supportEfforts"]
            .as_array()
            .expect("array")
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert_eq!(efforts, vec!["low", "medium", "high"]);
        assert_eq!(proj.get("defaultEffort").and_then(|v| v.as_str()), Some("high"));
    }

    #[test]
    fn kimi_project_managed_config_omits_reasoning_keys_when_absent() {
        // The shape the panel wrote before this feature — the projection must
        // not invent empty arrays, or the panel would read reasoning as "on".
        let value: toml::Value = r#"
[providers.codeg]
type = "kimi"
[models.codeg-managed]
provider = "codeg"
model = "kimi-k2"
max_context_size = 262144
"#
        .parse()
        .expect("valid toml");
        let proj = project_kimi_managed_config(&value);
        assert!(proj.get("capabilities").is_none());
        assert!(proj.get("supportEfforts").is_none());
        assert!(proj.get("defaultEffort").is_none());
    }

    #[test]
    fn kimi_project_managed_config_uses_non_colliding_keys() {
        // The projection MUST avoid AgentRuntimeConfig keys (apiKey / apiBaseUrl /
        // model / env); otherwise `build_runtime_env_from_setting` would mirror the
        // config.toml values back into the KIMI_MODEL_* runtime env, defeating the
        // single-source-of-truth between env override and config.toml.
        let value: toml::Value = r#"
default_model = "codeg-managed"
[providers.codeg]
type = "anthropic"
base_url = "https://api.anthropic.com"
api_key = "sk-ant"
[models.codeg-managed]
provider = "codeg"
model = "claude-opus-4-7"
max_context_size = 200000
"#
        .parse()
        .expect("valid toml");
        let proj = project_kimi_managed_config(&value);
        assert_eq!(
            proj.get("interfaceType").and_then(|v| v.as_str()),
            Some("anthropic")
        );
        assert_eq!(
            proj.get("baseUrl").and_then(|v| v.as_str()),
            Some("https://api.anthropic.com")
        );
        assert_eq!(proj.get("key").and_then(|v| v.as_str()), Some("sk-ant"));
        assert_eq!(proj.get("authType").and_then(|v| v.as_str()), Some("api_key"));
        assert_eq!(
            proj.get("modelId").and_then(|v| v.as_str()),
            Some("claude-opus-4-7")
        );
        assert_eq!(
            proj.get("maxContextSize").and_then(|v| v.as_i64()),
            Some(200000)
        );
        assert_eq!(proj.get("hasManagedBlock"), Some(&serde_json::Value::Bool(true)));
        for forbidden in [
            "apiKey",
            "apiBaseUrl",
            "api_key",
            "api_base_url",
            "model",
            "env",
        ] {
            assert!(
                !proj.contains_key(forbidden),
                "projection must not contain colliding key {forbidden}"
            );
        }
    }

    #[test]
    fn kimi_project_managed_config_env_subtable_surfaces_as_env_auth() {
        let value: toml::Value = r#"
[providers.codeg]
type = "openai"
[providers.codeg.env]
OPENAI_API_KEY = "sk-x"
[models.codeg-managed]
provider = "codeg"
model = "gpt"
"#
        .parse()
        .expect("valid toml");
        let proj = project_kimi_managed_config(&value);
        assert_eq!(proj.get("key").and_then(|v| v.as_str()), Some("sk-x"));
        assert_eq!(proj.get("authType").and_then(|v| v.as_str()), Some("env"));
    }

    #[test]
    fn kimi_seed_synthetic_credential_opens_gate() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("credentials").join("kimi-code.json");
        seed_kimi_synthetic_credential_at(&path).expect("seed");
        let token = read_kimi_token_at(&path).expect("token written");
        // A non-empty access_token is exactly what `kimi acp`'s session gate
        // (`harnessIsAuthed`) checks — and it must be flagged as ours.
        assert!(kimi_token_has_access(&token));
        assert!(kimi_token_is_synthetic(&token));
        assert_eq!(
            token.get("access_token").and_then(|v| v.as_str()),
            Some(KIMI_SYNTHETIC_TOKEN_ACCESS)
        );
    }

    #[test]
    fn kimi_seed_preserves_a_real_login_token() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("credentials").join("kimi-code.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // A real OAuth login: non-empty access_token, no synthetic marker.
        std::fs::write(
            &path,
            r#"{"access_token":"real-oauth-abc","token_type":"Bearer"}"#,
        )
        .unwrap();
        seed_kimi_synthetic_credential_at(&path).expect("seed");
        let token = read_kimi_token_at(&path).expect("token");
        assert_eq!(
            token.get("access_token").and_then(|v| v.as_str()),
            Some("real-oauth-abc"),
            "a real login must never be clobbered by the synthetic seed"
        );
        assert!(!kimi_token_is_synthetic(&token));
    }

    #[test]
    fn kimi_remove_if_ours_deletes_synthetic_but_keeps_real() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("credentials").join("kimi-code.json");
        // Synthetic → removed.
        seed_kimi_synthetic_credential_at(&path).expect("seed");
        assert!(path.exists());
        remove_kimi_synthetic_credential_if_ours_at(&path).expect("remove");
        assert!(!path.exists());
        // Real login → preserved.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"access_token":"real-oauth-abc"}"#).unwrap();
        remove_kimi_synthetic_credential_if_ours_at(&path).expect("remove");
        assert!(path.exists(), "a real login token must not be removed");
    }

    #[test]
    fn npm_bootstrap_failure_names_the_proxy_only_for_a_wrapper_download() {
        let download = || {
            AcpError::Protocol(
                "failed to install npm package globally: Installation failed: fetch failed"
                    .to_string(),
            )
        };

        let annotated = annotate_npm_bootstrap_failure("hermes-agent@0.21.4", download());
        let text = annotated.to_string();
        assert!(text.contains("fetch failed"), "keeps the original error");
        assert!(text.contains("HTTP(S)_PROXY"), "adds the proxy hint");

        // A package whose install runs no bootstrap can't fail this way, so the
        // hint would be noise even on a matching message.
        let other = annotate_npm_bootstrap_failure("@zed-industries/claude-code-acp", download());
        assert!(!other.to_string().contains("HTTP(S)_PROXY"));

        // A hermes failure that isn't a download stays untouched.
        let permissions = annotate_npm_bootstrap_failure(
            "hermes-agent@0.21.4",
            AcpError::Protocol("failed to install npm package globally: EACCES".to_string()),
        );
        assert!(!permissions.to_string().contains("HTTP(S)_PROXY"));
    }

    /// The proxy hint is keyed on npm's URL-parse failure, so every other way an
    /// install can die has to pass through untouched. (The positive branch also
    /// requires a scheme-less proxy in the process env; asserting that would
    /// mean mutating env under a parallel test binary.)
    #[test]
    fn npm_proxy_url_hint_leaves_unrelated_failures_alone() {
        for err in [
            AcpError::Protocol("failed to install npm package globally: EACCES".to_string()),
            AcpError::Protocol("failed to install npm package globally: ETIMEDOUT".to_string()),
            AcpError::SdkNotInstalled("npm is not installed".to_string()),
        ] {
            let before = err.to_string();
            assert_eq!(
                annotate_npm_proxy_url_failure(err).to_string(),
                before,
                "only an ERR_INVALID_URL failure may be annotated"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Cline provider store + auth-gate launch env
    // -----------------------------------------------------------------------

    /// Everything cline's zod schema rejects, in one place: a rejected
    /// `providers.json` does not degrade gracefully, it reads back EMPTY, so
    /// each of these assertions is the difference between a working agent and a
    /// user whose every provider silently vanished.
    fn assert_valid_cline_provider_store(root: &serde_json::Value) {
        assert_eq!(root["version"], serde_json::json!(1), "version is a zod literal");
        assert!(root["modes"].is_object(), "`modes` must be an object");
        for (id, entry) in root["providers"].as_object().expect("providers object") {
            let token_source = entry["tokenSource"].as_str().unwrap_or_default();
            assert!(
                matches!(token_source, "manual" | "oauth" | "migration"),
                "{id}: tokenSource {token_source:?} is outside the schema enum"
            );
            let updated_at = entry["updatedAt"].as_str().expect("updatedAt string");
            assert!(
                updated_at.ends_with('Z'),
                "{id}: updatedAt {updated_at:?} must be a UTC instant for z.string().datetime()"
            );
            chrono::DateTime::parse_from_rfc3339(updated_at)
                .unwrap_or_else(|e| panic!("{id}: updatedAt {updated_at:?} is not RFC3339: {e}"));
            assert_eq!(
                entry["settings"]["provider"].as_str(),
                Some(id.as_str()),
                "{id}: settings.provider must match its key"
            );
        }
    }

    fn read_cline_json(path: &Path) -> serde_json::Value {
        serde_json::from_str(&std::fs::read_to_string(path).expect("read")).expect("parse")
    }

    struct ClineStore {
        _dir: tempfile::TempDir,
        providers: PathBuf,
        models: PathBuf,
    }

    impl ClineStore {
        fn new() -> Self {
            let dir = tempfile::tempdir().expect("tempdir");
            let settings = dir.path().join("settings");
            Self {
                providers: settings.join("providers.json"),
                models: settings.join("models.json"),
                _dir: dir,
            }
        }

        fn save(
            &self,
            provider: &str,
            api_key: Option<&str>,
            model: Option<&str>,
            base_url: Option<&str>,
        ) -> Result<(), AcpError> {
            persist_cline_provider_settings_at(
                &self.providers,
                &self.models,
                provider,
                api_key,
                model,
                base_url,
            )
        }
    }

    #[test]
    fn cline_save_writes_a_store_cline_will_actually_parse() {
        let store = ClineStore::new();
        store
            .save(
                "openai-compatible",
                Some("sk-test"),
                Some("my-model"),
                Some("https://proxy.example/v1"),
            )
            .expect("save");

        let root = read_cline_json(&store.providers);
        assert_valid_cline_provider_store(&root);
        assert_eq!(root["lastUsedProvider"], "openai-compatible");
        let settings = &root["providers"]["openai-compatible"]["settings"];
        assert_eq!(settings["apiKey"], "sk-test");
        assert_eq!(settings["model"], "my-model");
        assert_eq!(settings["baseUrl"], "https://proxy.example/v1");

        // …and the panel reads its own write back verbatim.
        let loaded = load_cline_provider_settings_at(&store.providers).expect("reload");
        assert_eq!(loaded["apiProvider"], "openai-compatible");
        assert_eq!(loaded["apiKey"], "sk-test");
        assert_eq!(loaded["model"], "my-model");
        assert_eq!(loaded["apiBaseUrl"], "https://proxy.example/v1");
    }

    #[test]
    fn cline_save_keeps_other_providers_and_their_oauth_credentials() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "lastUsedProvider": "cline",
                "modes": {},
                "providers": {
                    "cline": {
                        "settings": {
                            "provider": "cline",
                            "auth": { "accessToken": "oauth-token", "accountId": "acct" },
                        },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "oauth",
                    },
                    "deepseek": {
                        "settings": { "provider": "deepseek", "apiKey": "sk-deep", "reasoning": { "effort": "high" } },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "manual",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        store
            .save("deepseek", Some("sk-rotated"), Some("deepseek-chat"), None)
            .expect("save");

        let root = read_cline_json(&store.providers);
        assert_valid_cline_provider_store(&root);
        // A `cline auth` login on ANOTHER provider survives a panel save…
        assert_eq!(
            root["providers"]["cline"]["settings"]["auth"]["accessToken"],
            "oauth-token"
        );
        assert_eq!(root["providers"]["cline"]["tokenSource"], "oauth");
        // …as do fields on the edited provider that codeg does not own.
        assert_eq!(
            root["providers"]["deepseek"]["settings"]["reasoning"]["effort"],
            "high"
        );
        assert_eq!(root["providers"]["deepseek"]["settings"]["apiKey"], "sk-rotated");
        assert_eq!(root["lastUsedProvider"], "deepseek");
    }

    #[test]
    fn cline_save_clears_a_field_the_panel_emptied() {
        let store = ClineStore::new();
        store
            .save("openai-native", Some("sk-a"), Some("gpt-5.4"), Some("https://a.example/v1"))
            .expect("save");
        store.save("openai-native", Some("sk-a"), None, None).expect("save 2");

        let settings = read_cline_json(&store.providers)["providers"]["openai-native"]["settings"].clone();
        assert!(settings.get("model").is_none(), "cleared model must be removed");
        assert!(settings.get("baseUrl").is_none(), "cleared base URL must be removed");
    }

    #[test]
    fn cline_save_preserves_an_oauth_token_source_on_the_edited_provider() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "modes": {},
                "providers": {
                    "openai-codex": {
                        "settings": { "provider": "openai-codex" },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "oauth",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        store.save("openai-codex", Some("sk-x"), None, None).expect("save");
        assert_eq!(
            read_cline_json(&store.providers)["providers"]["openai-codex"]["tokenSource"],
            "oauth",
            "an OAuth entry must not be demoted to `manual`"
        );
    }

    #[test]
    fn cline_save_repairs_a_token_source_cline_would_reject() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "modes": {},
                "providers": {
                    "deepseek": {
                        "settings": { "provider": "deepseek" },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "codeg",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        store.save("deepseek", Some("sk-x"), None, None).expect("save");
        // Round-tripping the out-of-enum value would hand cline a file it reads
        // as empty — every provider gone, endpoint and key with it.
        assert_valid_cline_provider_store(&read_cline_json(&store.providers));
    }

    #[test]
    fn cline_custom_model_is_registered_in_the_models_catalog() {
        let store = ClineStore::new();
        store
            .save(
                "openai-compatible",
                Some("sk-test"),
                Some("my-model"),
                Some("https://proxy.example/v1"),
            )
            .expect("save");

        // Without this entry `session/new` silently falls back to the
        // provider's built-in default model instead of the configured one.
        let entry = read_cline_json(&store.models)["providers"]["openai-compatible"].clone();
        assert_eq!(entry["provider"]["baseUrl"], "https://proxy.example/v1");
        assert_eq!(entry["provider"]["defaultModelId"], "my-model");
        assert_eq!(entry["models"]["my-model"]["id"], "my-model");
    }

    #[test]
    fn cline_models_catalog_is_left_alone_for_catalogued_providers() {
        let store = ClineStore::new();
        store
            .save("anthropic", Some("sk-test"), Some("claude-opus-5"), None)
            .expect("save");
        assert!(
            !store.models.exists(),
            "providers with a built-in catalogue need no models.json entry"
        );
    }

    #[test]
    fn cline_models_catalog_keeps_models_registered_elsewhere() {
        let store = ClineStore::new();
        store
            .save("openai-compatible", Some("sk"), Some("first"), Some("https://a.example/v1"))
            .expect("save");
        store
            .save("openai-compatible", Some("sk"), Some("second"), Some("https://b.example/v1"))
            .expect("save 2");

        let entry = read_cline_json(&store.models)["providers"]["openai-compatible"].clone();
        assert_eq!(entry["provider"]["defaultModelId"], "second");
        assert_eq!(entry["provider"]["baseUrl"], "https://b.example/v1");
        assert!(entry["models"]["first"].is_object(), "earlier model stays selectable");
        assert!(entry["models"]["second"].is_object());
    }

    #[test]
    fn cline_rejects_a_base_url_that_would_blank_the_whole_store() {
        let store = ClineStore::new();
        for bad in ["proxy.example/v1", "https://", "   ", "/v1"] {
            let err = store
                .save("openai-compatible", Some("sk"), Some("m"), Some(bad))
                .expect_err(&format!("{bad:?} must be rejected"));
            assert!(
                err.to_string().contains("invalid Cline base URL"),
                "unexpected error for {bad:?}: {err}"
            );
        }
        assert!(
            !store.providers.exists(),
            "a rejected save must not have written a store cline reads as empty"
        );

        store
            .save("openai-compatible", Some("sk"), Some("m"), Some("http://127.0.0.1:11434/v1"))
            .expect("a plain-http loopback endpoint is legitimate");
    }

    #[test]
    fn cline_reader_picks_the_last_used_provider() {
        let store = ClineStore::new();
        store.save("deepseek", Some("sk-deep"), Some("deepseek-chat"), None).expect("save");
        store
            .save("openai-compatible", Some("sk-compat"), Some("m"), Some("https://a.example/v1"))
            .expect("save 2");

        let loaded = load_cline_provider_settings_at(&store.providers).expect("load");
        assert_eq!(loaded["apiProvider"], "openai-compatible");
        assert_eq!(loaded["apiKey"], "sk-compat");
    }

    #[test]
    fn cline_reader_normalizes_a_legacy_openai_entry() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "modes": {},
                "providers": {
                    "openai": {
                        "settings": { "provider": "openai", "apiKey": "sk-legacy" },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "manual",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        // Single entry → no `lastUsedProvider` needed, and the id the panel sees
        // is the one the ACP path understands.
        let loaded = load_cline_provider_settings_at(&store.providers).expect("load");
        assert_eq!(loaded["apiProvider"], "openai-compatible");
    }

    #[test]
    fn cline_reader_declines_to_guess_between_providers() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "modes": {},
                "providers": {
                    "deepseek": { "settings": { "provider": "deepseek" }, "updatedAt": "2026-01-01T00:00:00.000Z", "tokenSource": "manual" },
                    "anthropic": { "settings": { "provider": "anthropic" }, "updatedAt": "2026-01-01T00:00:00.000Z", "tokenSource": "manual" },
                },
            })
            .to_string(),
        )
        .expect("seed");

        // Guessing here would show one provider's row and overwrite it on the
        // next save; the legacy reader is the better fallback.
        assert!(load_cline_provider_settings_at(&store.providers).is_none());
    }

    fn cline_launch_env(config: serde_json::Value) -> BTreeMap<String, String> {
        build_runtime_env_from_setting(AgentType::Cline, None, Some(&config.to_string()))
    }

    #[test]
    fn cline_launch_env_clears_the_acp_auth_gate() {
        // `tryRestoreAuth` only knows cline/cline-pass/openai-codex, so without
        // this trio every BYO session dies on "Call authenticate before
        // starting a session".
        let env = cline_launch_env(serde_json::json!({
            "apiProvider": "openai-compatible",
            "apiKey": "sk-test",
            "model": "my-model",
            "apiBaseUrl": "https://proxy.example/v1",
        }));
        assert_eq!(env.get("CLINE_API_KEY").map(String::as_str), Some("sk-test"));
        assert_eq!(
            env.get("CLINE_PROVIDER").map(String::as_str),
            Some("openai-compatible"),
            "without the provider the gate opens onto Cline's own billing"
        );
        assert_eq!(env.get("CLINE_MODEL").map(String::as_str), Some("my-model"));
        // The endpoint travels in providers.json — `CLINE_API_BASE_URL` is
        // cline's ACCOUNT service and must never receive an LLM endpoint.
        assert!(!env.contains_key("CLINE_API_BASE_URL"));
        assert!(!env.contains_key("OPENAI_API_KEY"), "the cline key must not leak into OPENAI_*");
    }

    #[test]
    fn cline_launch_env_normalizes_the_legacy_provider_id() {
        let env = cline_launch_env(serde_json::json!({
            "apiProvider": "openai",
            "apiKey": "sk-test",
        }));
        // `CLINE_PROVIDER=openai` reaches session/new as an unknown provider
        // with an empty model list.
        assert_eq!(
            env.get("CLINE_PROVIDER").map(String::as_str),
            Some("openai-compatible")
        );
    }

    #[test]
    fn cline_launch_env_stays_out_of_the_way_without_a_credential() {
        let env = cline_launch_env(serde_json::json!({ "apiProvider": "anthropic" }));
        // Injecting a provider with no key would mask a working `cline auth`
        // login: the gate would still refuse, but on the wrong provider.
        assert!(!env.contains_key("CLINE_API_KEY"));
        assert!(!env.contains_key("CLINE_PROVIDER"));
    }

    #[test]
    fn a_cline_auth_sign_in_is_left_for_the_agent_to_restore() {
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "lastUsedProvider": "cline",
                "modes": {},
                "providers": {
                    "cline": {
                        // An OAuth login keeps its credential under `auth`, not
                        // `apiKey` — the shape `cline auth` writes.
                        "settings": { "provider": "cline", "auth": { "accessToken": "oauth-token" } },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "oauth",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        let loaded = load_cline_provider_settings_at(&store.providers).expect("load");
        // The panel shows the signed-in provider rather than a blank row…
        assert_eq!(loaded["apiProvider"], "cline");
        assert!(loaded.get("apiKey").is_none());

        // …and the launch carries no credential of its own, so `tryRestoreAuth`
        // finds the login instead of codeg forcing a half-filled BYO provider
        // over it. Both keys are blanked rather than merely omitted: the spawn
        // layer reads an empty value as `env_remove`, which is the only way to
        // strip one the child would otherwise inherit.
        let env = cline_launch_env(serde_json::Value::Object(loaded));
        assert_eq!(env.get("CLINE_API_KEY").map(String::as_str), Some(""));
        assert_eq!(env.get("CLINE_PROVIDER").map(String::as_str), Some(""));
    }

    #[test]
    fn the_sign_in_scrub_survives_a_leftover_model_provider_binding() {
        // `apply_model_provider_env` writes the agent's generic credential trio
        // for ANY agent with a `model_provider_id`, so a binding left from a BYO
        // setup used to put `CLINE_API_KEY` back after the scrub — short-circuiting
        // the gate and billing a ClinePass account as plain Cline. Running cline's
        // policy last has to win, and has to stay idempotent for BYO.
        let signed_in = serde_json::json!({ "apiProvider": "cline-pass" }).to_string();
        let mut env: BTreeMap<String, String> = BTreeMap::new();
        apply_cline_launch_env(Some(&signed_in), &mut env);
        // The binding lands after the first pass…
        env.insert("CLINE_API_KEY".to_string(), "sk-from-provider".to_string());
        env.insert(
            "CLINE_BASE_URL".to_string(),
            "https://proxy.example/v1".to_string(),
        );
        // …and the re-application scrubs it again.
        apply_cline_launch_env(Some(&signed_in), &mut env);
        assert_eq!(env.get("CLINE_API_KEY").map(String::as_str), Some(""));
        assert_eq!(env.get("CLINE_PROVIDER").map(String::as_str), Some(""));

        // Idempotent for BYO: running it twice changes nothing.
        let byo = serde_json::json!({
            "apiProvider": "openai-compatible",
            "apiKey": "sk-byo",
        })
        .to_string();
        let mut byo_env: BTreeMap<String, String> = BTreeMap::new();
        apply_cline_launch_env(Some(&byo), &mut byo_env);
        let once = byo_env.clone();
        apply_cline_launch_env(Some(&byo), &mut byo_env);
        assert_eq!(byo_env, once);
    }

    #[test]
    fn a_stray_key_cannot_hijack_a_cline_sign_in() {
        // The failure this prevents is silent and expensive: a non-empty
        // `CLINE_API_KEY` opens the gate WITHOUT setting `authResult`, so
        // `newSession` falls back to `"cline"` and a ClinePass or ChatGPT
        // subscription quietly bills as plain Cline.
        for provider in ["cline", "cline-pass", "openai-codex"] {
            let env = cline_launch_env(serde_json::json!({
                "apiProvider": provider,
                // Left over from a BYO provider the user configured earlier.
                "apiKey": "sk-stale",
                "model": "claude-sonnet-5",
            }));
            assert_eq!(
                env.get("CLINE_API_KEY").map(String::as_str),
                Some(""),
                "{provider}: a stale key must not short-circuit the gate"
            );
            assert_eq!(
                env.get("CLINE_PROVIDER").map(String::as_str),
                Some(""),
                "{provider}: an empty value is the spawn layer's `env_remove`, which is what \
                 strips a stale row or one exported in the launching shell"
            );
            // The model still travels — `newSession` reads CLINE_MODEL for
            // every provider, sign-in included.
            assert_eq!(
                env.get("CLINE_MODEL").map(String::as_str),
                Some("claude-sonnet-5")
            );
        }
    }

    #[test]
    fn saving_a_sign_in_provider_leaves_its_credential_alone() {
        // The panel shows no key or endpoint field for these, so an empty draft
        // is the absence of an opinion — not an instruction to log the user out.
        let store = ClineStore::new();
        std::fs::create_dir_all(store.providers.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &store.providers,
            serde_json::json!({
                "version": 1,
                "lastUsedProvider": "openai-compatible",
                "modes": {},
                "providers": {
                    "cline": {
                        "settings": {
                            "provider": "cline",
                            "apiKey": "account-key",
                            "auth": { "accessToken": "oauth-token" },
                        },
                        "updatedAt": "2026-01-01T00:00:00.000Z",
                        "tokenSource": "oauth",
                    },
                },
            })
            .to_string(),
        )
        .expect("seed");

        persist_cline_provider_settings_at(
            &store.providers,
            &store.models,
            "cline",
            None,
            Some("claude-sonnet-5"),
            None,
        )
        .expect("save");

        let root = read_json_object(&store.providers).expect("read back");
        assert_valid_cline_provider_store(&root);
        let entry = &root["providers"]["cline"];
        assert_eq!(entry["tokenSource"], "oauth");
        assert_eq!(
            entry["settings"]["apiKey"], "account-key",
            "clearing a field the panel never showed would end the session"
        );
        assert_eq!(entry["settings"]["auth"]["accessToken"], "oauth-token");
        // The model IS the panel's to set, and switching providers is the point
        // of the save.
        assert_eq!(entry["settings"]["model"], "claude-sonnet-5");
        assert_eq!(root["lastUsedProvider"], "cline");
    }

    #[test]
    fn cline_launch_env_lets_keyless_local_providers_through() {
        let env = cline_launch_env(serde_json::json!({
            "apiProvider": "ollama",
            "model": "qwen3",
        }));
        // Ollama has no API key, but the gate only tests the var for emptiness.
        assert_eq!(env.get("CLINE_API_KEY").map(String::as_str), Some("local"));
        assert_eq!(env.get("CLINE_PROVIDER").map(String::as_str), Some("ollama"));
    }

    #[test]
    fn an_explicit_cline_provider_env_row_still_wins() {
        let now = chrono::Utc::now();
        let setting = crate::db::entities::agent_setting::Model {
            id: 1,
            agent_type: "cline".to_string(),
            registry_id: "cline".to_string(),
            enabled: true,
            sort_order: 0,
            installed_version: None,
            env_json: Some(serde_json::json!({ "CLINE_PROVIDER": "cline-pass" }).to_string()),
            model_provider_id: None,
            created_at: now,
            updated_at: now,
        };
        let env = build_runtime_env_from_setting(
            AgentType::Cline,
            Some(&setting),
            Some(&serde_json::json!({ "apiProvider": "deepseek", "apiKey": "sk" }).to_string()),
        );
        assert_eq!(env.get("CLINE_PROVIDER").map(String::as_str), Some("cline-pass"));
    }
}
