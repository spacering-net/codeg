use serde::Serialize;
use std::sync::Mutex;

use crate::acp::binary_cache;
use crate::acp::registry::{self, AcpAdapterRelation, AcpAgentMeta, AgentDistribution};
use crate::models::agent::AgentType;

/// Cache for npm environment check results.
/// Stores `Some(checks)` after a successful (all-pass) run;
/// stays `None` if checks failed so they are retried next time.
static NPM_ENV_CACHE: Mutex<Option<Vec<CheckItem>>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FixActionKind {
    OpenUrl,
    InstallOpencodePlugins,
    InstallUv,
}

#[derive(Debug, Clone, Serialize)]
pub struct FixAction {
    pub label: String,
    pub kind: FixActionKind,
    pub payload: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
    Pass,
    Fail,
    Warn,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckItem {
    pub check_id: String,
    pub label: String,
    pub status: CheckStatus,
    pub message: String,
    pub fixes: Vec<FixAction>,
}

/// Everything the UI needs to explain that codeg's entry for this agent is an
/// ACP *adapter*, not the vendor CLI the user already has — see
/// [`registry::acp_adapter_relation`]. Deliberately STRUCTURED (no prose): the
/// frontend owns the wording so it is localized, the same way
/// `buildVersionCheck` already builds the version card.
///
/// `None` on [`PreflightResult`] for every non-adapter agent.
#[derive(Debug, Clone, Serialize)]
pub struct AdapterInfo {
    /// npm spec codeg installs, e.g. "@agentclientprotocol/claude-agent-acp@0.81.1".
    pub adapter_package: String,
    /// Command the launch gate resolves, e.g. "claude-agent-acp".
    pub adapter_cmd: String,
    /// Whether that command currently resolves.
    pub adapter_installed: bool,
    /// The vendor CLI, e.g. "claude".
    pub native_cmd: String,
    /// Display name for the vendor CLI, e.g. "Claude Code CLI".
    pub native_label: String,
    /// Where the user's own vendor CLI was found, if at all. codeg never
    /// launches it — it is named so the user sees we did look.
    pub native_path: Option<String>,
    /// Config dir both read, so no second login is needed.
    pub shared_config_dir: String,
    pub docs_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreflightResult {
    pub agent_type: AgentType,
    pub agent_name: String,
    pub passed: bool,
    pub checks: Vec<CheckItem>,
    /// Adapter-vs-vendor-CLI explainer data; `None` unless this agent is an
    /// ACP adapter. Never affects `passed` — it explains, it does not gate.
    pub adapter: Option<AdapterInfo>,
}

pub fn clear_npm_env_cache() {
    *NPM_ENV_CACHE.lock().unwrap() = None;
}

pub async fn run_preflight(agent_type: AgentType) -> PreflightResult {
    let meta = registry::get_agent_meta(agent_type);
    debug_assert_eq!(meta.agent_type, agent_type);
    let checks = match &meta.distribution {
        AgentDistribution::Npx { node_required, .. } => check_npm_environment(*node_required).await,
        AgentDistribution::Binary {
            version,
            cmd,
            platforms,
            ..
        } => check_binary_environment(agent_type, version, cmd, platforms).await,
        AgentDistribution::Uvx {
            uv_required,
            system_cmd,
            ..
        } => check_uv_environment(*uv_required, *system_cmd).await,
    };

    let passed = checks
        .iter()
        .all(|c| !matches!(c.status, CheckStatus::Fail));

    PreflightResult {
        agent_type,
        agent_name: meta.name.to_string(),
        passed,
        checks,
        adapter: probe_adapter(&meta).await,
    }
}

/// Probe the adapter/vendor-CLI split for an adapter agent (`None` otherwise).
///
/// Path resolution ONLY — no `--version` spawns. The Settings page runs a full
/// preflight for every agent each time it opens, so this stays off the process
/// spawner in the common case; the heavier version probe lives in the on-demand
/// diagnostics report, which bounds every command with `DIAG_PROBE_TIMEOUT`.
///
/// The two lookups run concurrently because either can fall through to
/// `resolve_npx_command`'s `npm prefix -g` probe (only when `which` misses), and
/// a FAILED prefix resolution is never cached — `cached_npm_global_prefix_with`
/// short-circuits on `None` before it reaches `OnceCell::set`. On a machine
/// where that probe stalls, running these in sequence would pay
/// `NPM_PREFIX_TIMEOUT` twice per adapter agent; overlapping them costs the same
/// two spawns but bounds the added Settings latency to one timeout.
async fn probe_adapter(meta: &AcpAgentMeta) -> Option<AdapterInfo> {
    let relation = registry::acp_adapter_relation(meta.agent_type)?;
    let adapter_cmd = match &meta.distribution {
        AgentDistribution::Npx { cmd, .. } => *cmd,
        // Both adapters are npx-distributed; a future non-npx one would need a
        // launchability probe of its own rather than a silently wrong answer.
        _ => return None,
    };
    let (adapter_installed, native_path) = tokio::join!(
        crate::commands::acp::is_cmd_available(adapter_cmd),
        crate::commands::acp::resolve_vendor_cli(relation.native_cmd, relation.extra_dirs),
    );

    Some(build_adapter_info(
        meta,
        &relation,
        adapter_installed,
        native_path.map(|p| p.to_string_lossy().to_string()),
    ))
}

/// Pure assembly half of [`probe_adapter`], split out so the mapping is
/// unit-testable without touching PATH or the filesystem.
fn build_adapter_info(
    meta: &AcpAgentMeta,
    relation: &AcpAdapterRelation,
    adapter_installed: bool,
    native_path: Option<String>,
) -> AdapterInfo {
    let (adapter_package, adapter_cmd) = match &meta.distribution {
        AgentDistribution::Npx { package, cmd, .. } => (package.to_string(), cmd.to_string()),
        _ => (String::new(), String::new()),
    };
    AdapterInfo {
        adapter_package,
        adapter_cmd,
        adapter_installed,
        native_cmd: relation.native_cmd.to_string(),
        native_label: relation.native_label.to_string(),
        native_path,
        shared_config_dir: relation.shared_config_dir.to_string(),
        docs_url: relation.docs_url.to_string(),
    }
}

async fn check_npm_environment(node_required: Option<&str>) -> Vec<CheckItem> {
    // Return cached result if a previous check passed.
    // The cache stores only the base checks (node_available + npm_available);
    // the per-agent node_version check is appended separately.
    let cached = NPM_ENV_CACHE.lock().unwrap().clone();
    if let Some(cached) = cached {
        let mut checks = cached;
        if let Some(required) = node_required {
            // Extract node version string from the cached node_available message
            // (format: "Node.js v20.19.0 available")
            let node_ver = extract_node_version_from_message(&checks[0].message);
            checks.push(build_node_version_check(node_ver.as_deref(), required));
        }
        return checks;
    }

    // Resolve absolute paths via `which` crate to avoid GUI PATH issues,
    // then run version checks in parallel.
    let node_path = which::which("node").ok();
    let npm_path = which::which("npm").ok();

    let (node_result, npm_result) = tokio::join!(
        async {
            match &node_path {
                Some(p) => {
                    crate::process::tokio_command(p)
                        .arg("--version")
                        .output()
                        .await
                }
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "node not found in PATH",
                )),
            }
        },
        async {
            match &npm_path {
                Some(p) => {
                    crate::process::tokio_command(p)
                        .arg("--version")
                        .output()
                        .await
                }
                None => Err(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "npm not found in PATH",
                )),
            }
        },
    );

    // Track the raw node version string for reuse in the version check
    let mut node_version_str: Option<String> = None;

    let node_check = match node_result {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            node_version_str = Some(version.clone());
            CheckItem {
                check_id: "node_available".into(),
                label: "Node.js".into(),
                status: CheckStatus::Pass,
                message: format!("Node.js {version} available"),
                fixes: vec![],
            }
        }
        _ => CheckItem {
            check_id: "node_available".into(),
            label: "Node.js".into(),
            status: CheckStatus::Fail,
            message: "Node.js is not installed or not in PATH".into(),
            fixes: vec![FixAction {
                label: "Install Node.js".into(),
                kind: FixActionKind::OpenUrl,
                payload: "https://nodejs.org/".into(),
            }],
        },
    };

    let npm_check = match npm_result {
        Ok(output) if output.status.success() => {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            CheckItem {
                check_id: "npm_available".into(),
                label: "npm".into(),
                status: CheckStatus::Pass,
                message: format!("npm {version} available"),
                fixes: vec![],
            }
        }
        _ => CheckItem {
            check_id: "npm_available".into(),
            label: "npm".into(),
            status: CheckStatus::Fail,
            message: "npm is not installed or not in PATH".into(),
            fixes: vec![FixAction {
                label: "Install Node.js".into(),
                kind: FixActionKind::OpenUrl,
                payload: "https://nodejs.org/".into(),
            }],
        },
    };

    let mut checks = vec![node_check, npm_check];

    // Cache only if all checks passed — failed results are not cached so
    // the user can retry after installing the missing tools.
    let all_passed = checks
        .iter()
        .all(|c| !matches!(c.status, CheckStatus::Fail));
    if all_passed {
        *NPM_ENV_CACHE.lock().unwrap() = Some(checks.clone());
    }

    // After caching the base checks, append the per-agent Node.js version
    // requirement if specified. Only meaningful when node is available.
    if let Some(required) = node_required {
        if all_passed {
            checks.push(build_node_version_check(
                node_version_str.as_deref(),
                required,
            ));
        }
    }

    checks
}

/// Parse a Node.js version string like "v20.19.0" or "20.19.0" into (major, minor, patch).
/// Handles pre-release suffixes such as "v22.0.0-nightly" by stripping non-numeric tails.
fn parse_node_version(v: &str) -> Option<(u32, u32, u32)> {
    let v = v.trim().trim_start_matches('v');
    let mut parts = v.splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch_str = parts.next()?;
    // Strip pre-release/build suffixes: "0-nightly" → "0", "3+build" → "3"
    let patch_digits: String = patch_str
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let patch = patch_digits.parse().ok()?;
    Some((major, minor, patch))
}

/// Extract the node version string from a cached node_available message.
/// Expected format: "Node.js v20.19.0 available" → Some("v20.19.0")
fn extract_node_version_from_message(message: &str) -> Option<String> {
    message
        .split_whitespace()
        .find(|s| s.starts_with('v') && s.contains('.'))
        .map(|s| s.to_string())
}

/// Build a `CheckItem` for the Node.js version requirement check.
/// `current_version` is the raw output from `node --version` (e.g. "v20.19.0").
fn build_node_version_check(current_version: Option<&str>, required: &str) -> CheckItem {
    let current_version = match current_version {
        Some(v) => v,
        None => {
            return CheckItem {
                check_id: "node_version".into(),
                label: "Node.js version".into(),
                status: CheckStatus::Fail,
                message: "Cannot determine Node.js version".into(),
                fixes: vec![],
            };
        }
    };

    let current = parse_node_version(current_version);
    let required_parsed = parse_node_version(required);

    match (current, required_parsed) {
        (Some(cur), Some(req)) if cur >= req => CheckItem {
            check_id: "node_version".into(),
            label: "Node.js version".into(),
            status: CheckStatus::Pass,
            message: format!(
                "Node.js {current_version} meets the minimum requirement (>={required})"
            ),
            fixes: vec![],
        },
        (Some(_), Some(_)) => CheckItem {
            check_id: "node_version".into(),
            label: "Node.js version".into(),
            status: CheckStatus::Fail,
            message: format!(
                "Node.js {current_version} is too old — this package requires Node.js >={required}"
            ),
            fixes: vec![FixAction {
                label: "Update Node.js".into(),
                kind: FixActionKind::OpenUrl,
                payload: "https://nodejs.org/".into(),
            }],
        },
        _ => CheckItem {
            check_id: "node_version".into(),
            label: "Node.js version".into(),
            status: CheckStatus::Warn,
            message: format!("Cannot parse Node.js version; required >={required}"),
            fixes: vec![],
        },
    }
}

/// Preflight for `Uvx` agents (custom ACP agents distributed as Python
/// packages and launched via `uvx`). Passes when either the `uv` tool runner
/// is resolvable, or — as a fallback — the agent's own CLI is already
/// installed on PATH.
async fn check_uv_environment(
    uv_required: Option<&str>,
    system_cmd: Option<(&str, &[&str])>,
) -> Vec<CheckItem> {
    // Primary: the `uv` tool runner (uvx) fetches + launches the agent package.
    if let Some(uvx_path) = crate::commands::acp::resolve_uvx_command() {
        let version = run_uv_version(&uvx_path).await;
        let mut checks = vec![CheckItem {
            check_id: "uv_available".into(),
            label: "uv".into(),
            status: CheckStatus::Pass,
            message: match &version {
                Some(v) => format!("uv {v} available"),
                None => "uv available".into(),
            },
            fixes: vec![],
        }];
        if let Some(required) = uv_required {
            checks.push(build_uv_version_check(version.as_deref(), required));
        }
        return checks;
    }

    // Fallback: the agent's own CLI is already installed on PATH (e.g. a user
    // who ran the official installer has `hermes` available). The agent is
    // launchable as-is, but installing uv unlocks codeg's managed install /
    // upgrade flow, so offer it as a non-blocking action.
    if let Some((cmd, _)) = system_cmd {
        if crate::commands::acp::resolve_command_on_path(cmd).is_some() {
            return vec![CheckItem {
                check_id: "uv_available".into(),
                label: "uv".into(),
                status: CheckStatus::Warn,
                message: format!(
                    "uv not found; will launch via the system `{cmd}` command on PATH. Install uv to enable managed install/upgrade."
                ),
                fixes: vec![FixAction {
                    label: "Install uv".into(),
                    kind: FixActionKind::InstallUv,
                    payload: String::new(),
                }],
            }];
        }
    }

    // uv is required and not installed: a hard failure with an actionable
    // installer. Installing uv is a separate step from installing the agent.
    vec![CheckItem {
        check_id: "uv_available".into(),
        label: "uv".into(),
        status: CheckStatus::Fail,
        message: "uv (the Python tool runner) is not installed. Click Install uv to set it up."
            .into(),
        fixes: vec![FixAction {
            label: "Install uv".into(),
            kind: FixActionKind::InstallUv,
            payload: String::new(),
        }],
    }]
}

/// Run `<uvx> --version` and extract the version token (output looks like
/// "uvx 0.8.10 (hash date)").
async fn run_uv_version(uvx_path: &std::path::Path) -> Option<String> {
    let output = crate::process::tokio_command(uvx_path)
        .arg("--version")
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.split_whitespace().nth(1).map(|s| s.to_string())
}

/// Build a `CheckItem` for the `uv` minimum-version requirement. Too-old is a
/// `Warn` (not `Fail`): recent uv releases are backward compatible for the
/// `uvx --from <pkg>==<ver>` invocation, so an old uv should not hard-block.
fn build_uv_version_check(current: Option<&str>, required: &str) -> CheckItem {
    match (current.and_then(parse_node_version), parse_node_version(required)) {
        (Some(cur), Some(req)) if cur >= req => CheckItem {
            check_id: "uv_version".into(),
            label: "uv version".into(),
            status: CheckStatus::Pass,
            message: format!("uv {} meets the minimum requirement (>={required})", current.unwrap_or("")),
            fixes: vec![],
        },
        (Some(_), Some(_)) => CheckItem {
            check_id: "uv_version".into(),
            label: "uv version".into(),
            status: CheckStatus::Warn,
            message: format!(
                "uv {} is older than the recommended >={required}; consider `uv self update`",
                current.unwrap_or("")
            ),
            fixes: vec![],
        },
        _ => CheckItem {
            check_id: "uv_version".into(),
            label: "uv version".into(),
            status: CheckStatus::Warn,
            message: format!("Cannot parse uv version; recommended >={required}"),
            fixes: vec![],
        },
    }
}

async fn check_binary_environment(
    agent_type: AgentType,
    version: &str,
    cmd: &str,
    platforms: &[registry::PlatformBinary],
) -> Vec<CheckItem> {
    let mut checks = Vec::new();

    // Check platform support
    let current = registry::current_platform();
    let platform_supported = platforms.iter().any(|p| p.platform == current);

    let platform_check = if platform_supported {
        CheckItem {
            check_id: "platform_supported".into(),
            label: "Platform".into(),
            status: CheckStatus::Pass,
            message: format!("Platform {current} is supported"),
            fixes: vec![],
        }
    } else {
        CheckItem {
            check_id: "platform_supported".into(),
            label: "Platform".into(),
            status: CheckStatus::Fail,
            message: format!("Platform {current} is not supported"),
            fixes: vec![],
        }
    };
    checks.push(platform_check);

    // Check binary cache.
    //
    // Pass as long as *any* cached version is present — the session-page
    // connect path uses the best cached version via
    // `find_best_cached_binary_for_agent`, so an older-but-working cache
    // should still be considered "ready". If the cached version differs
    // from the registry's recommended version, we note it in the message
    // but still pass — the Settings page's version-badge flow is the
    // canonical place to surface "upgrade available".
    if platform_supported {
        let cache_check = match binary_cache::find_best_cached_binary_for_agent(agent_type, cmd) {
            Ok(Some((_, cached_version))) => {
                let message = if cached_version == version {
                    "Binary is cached locally".to_string()
                } else {
                    format!("Binary {cached_version} is cached locally (recommended: {version})")
                };
                CheckItem {
                    check_id: "binary_cached".into(),
                    label: "Binary cache".into(),
                    status: CheckStatus::Pass,
                    message,
                    fixes: vec![],
                }
            }
            // A user-installed CLI is launchable as-is, so report ready
            // instead of a misleading warn.
            //
            // This used to be gated on `binary_dir_entry(..).is_some()`, i.e.
            // dir-tree agents only (Cursor). That made preflight STRICTER than
            // the thing it predicts: `build_agent` falls back to a system
            // binary for every Binary agent, dir-tree or not, so a working
            // `opencode` on PATH connected fine while this check called it not
            // installed. `dir_entry` describes the shape of the archive codeg
            // downloads; it says nothing about whether a system binary can be
            // launched.
            Ok(None)
                if crate::commands::acp::resolve_system_agent_binary_for(agent_type, cmd)
                    .is_some() =>
            {
                CheckItem {
                    check_id: "binary_cached".into(),
                    label: "Binary cache".into(),
                    status: CheckStatus::Pass,
                    message: format!(
                        "Using the system-installed {cmd} (codeg-managed download also available)"
                    ),
                    fixes: vec![],
                }
            }
            Ok(None) => CheckItem {
                check_id: "binary_cached".into(),
                label: "Binary cache".into(),
                status: CheckStatus::Warn,
                message:
                    "Binary is not installed. Download it from Agent Settings before connecting."
                        .into(),
                fixes: vec![],
            },
            Err(_) => CheckItem {
                check_id: "binary_cached".into(),
                label: "Binary cache".into(),
                status: CheckStatus::Warn,
                message: "Cannot determine binary cache path".into(),
                fixes: vec![],
            },
        };
        checks.push(cache_check);
    }

    // OpenCode plugin checks
    if agent_type == AgentType::OpenCode {
        use crate::acp::opencode_plugins::{self, spec_has_floating_version, PluginStatus};
        match opencode_plugins::check_opencode_plugins(None) {
            Ok(summary) => {
                // Anything the install pass can actually fix, which includes a
                // package sitting in the legacy flat layout: present on disk,
                // invisible to the pinned opencode, and re-downloaded on every
                // start. Reporting that as installed is how the original bug
                // stayed hidden.
                //
                // Path plugins are NOT in here: opencode imports those off disk,
                // so "install" has nothing to do for them and listing them under
                // a fix action that cannot clear promises a repair that never
                // comes.
                let missing: Vec<_> = summary
                    .plugins
                    .iter()
                    .filter(|p| {
                        matches!(
                            p.status,
                            PluginStatus::Missing | PluginStatus::NeedsMigration
                        )
                    })
                    .collect();

                if summary.plugins.is_empty() {
                    checks.push(CheckItem {
                        check_id: "opencode_plugins".into(),
                        label: "OpenCode plugins".into(),
                        status: CheckStatus::Pass,
                        message: "No plugins declared".into(),
                        fixes: vec![],
                    });
                } else if missing.is_empty() {
                    checks.push(CheckItem {
                        check_id: "opencode_plugins".into(),
                        label: "OpenCode plugins".into(),
                        status: CheckStatus::Pass,
                        // "ready", not "installed": a path plugin is never
                        // installed anywhere and is still perfectly loadable.
                        // The count leaves out the ones the warning below says
                        // are not on disk, so the two rows cannot contradict
                        // each other.
                        message: format!(
                            "{} plugin(s) ready",
                            summary
                                .plugins
                                .iter()
                                .filter(|p| p.status != PluginStatus::PathMissing)
                                .count()
                        ),
                        fixes: vec![],
                    });
                } else {
                    let names: Vec<&str> = missing.iter().map(|p| p.name.as_str()).collect();
                    let stale = missing
                        .iter()
                        .filter(|p| p.status == PluginStatus::NeedsMigration)
                        .count();
                    let detail = if stale > 0 {
                        format!(
                            " ({stale} installed in the old cache layout OpenCode no longer reads)"
                        )
                    } else {
                        String::new()
                    };
                    checks.push(CheckItem {
                        check_id: "opencode_plugins".into(),
                        label: "OpenCode plugins".into(),
                        status: CheckStatus::Fail,
                        message: format!(
                            "{} plugin(s) not installed: {}{detail}",
                            missing.len(),
                            names.join(", ")
                        ),
                        fixes: vec![FixAction {
                            label: "Install Plugins".into(),
                            kind: FixActionKind::InstallOpencodePlugins,
                            payload: String::new(),
                        }],
                    });
                }

                // A declared path plugin with nothing at the end of it. Warn
                // rather than Fail: opencode starts fine and publishes a load
                // error for that one plugin. No fix action — the file has to be
                // put there or the path corrected; installing cannot help.
                let path_missing: Vec<String> = summary
                    .plugins
                    .iter()
                    .filter(|p| p.status == PluginStatus::PathMissing)
                    .map(|p| {
                        p.resolved_path
                            .clone()
                            .unwrap_or_else(|| p.declared_spec.clone())
                    })
                    .collect();
                if !path_missing.is_empty() {
                    checks.push(CheckItem {
                        check_id: "opencode_plugins_path".into(),
                        label: "Plugin files".into(),
                        status: CheckStatus::Warn,
                        message: format!(
                            "{} path plugin(s) declared in opencode.json do not exist: {}. \
                             OpenCode will report a load error for each; fix the path or restore \
                             the file (these are loaded from disk, not installed).",
                            path_missing.len(),
                            path_missing.join(", ")
                        ),
                        fixes: vec![],
                    });
                }

                // Warn about @latest specs that cause slow startup
                let floating: Vec<&str> = summary
                    .plugins
                    .iter()
                    .filter(|p| spec_has_floating_version(&p.declared_spec))
                    .map(|p| p.name.as_str())
                    .collect();
                if !floating.is_empty() {
                    checks.push(CheckItem {
                        check_id: "opencode_plugins_floating".into(),
                        label: "Plugin versions".into(),
                        status: CheckStatus::Warn,
                        message: format!(
                            "{} plugin(s) use @latest which forces a network check on every startup: {}. \
                             Install via the plugin manager to auto-pin versions.",
                            floating.len(),
                            floating.join(", ")
                        ),
                        fixes: vec![FixAction {
                            label: "Install Plugins".into(),
                            kind: FixActionKind::InstallOpencodePlugins,
                            payload: String::new(),
                        }],
                    });
                }

                // Project-level config hint
                if summary.has_project_config_hint {
                    checks.push(CheckItem {
                        check_id: "opencode_project_config_hint".into(),
                        label: "Project config".into(),
                        status: CheckStatus::Warn,
                        message:
                            "Project-level opencode config detected; its plugins are not checked. \
                             Expect slower first connect if it declares plugins."
                                .into(),
                        fixes: vec![],
                    });
                }
            }
            Err(e) => {
                checks.push(CheckItem {
                    check_id: "opencode_plugins".into(),
                    label: "OpenCode plugins".into(),
                    status: CheckStatus::Warn,
                    message: format!("Failed to parse opencode.json: {e}"),
                    fixes: vec![],
                });
            }
        }
    }

    checks
}

#[cfg(test)]
mod adapter_tests {
    use super::*;

    fn info_for(agent_type: AgentType, native_path: Option<&str>, installed: bool) -> AdapterInfo {
        let meta = registry::get_agent_meta(agent_type);
        let relation = registry::acp_adapter_relation(agent_type)
            .expect("agent under test must be an adapter agent");
        build_adapter_info(
            &meta,
            &relation,
            installed,
            native_path.map(str::to_string),
        )
    }

    // The card's whole argument rests on these four fields being concrete: the
    // package we install, the command we look for, the vendor CLI we did NOT
    // find under that name, and the config dir both share.
    #[test]
    fn claude_adapter_info_names_package_command_and_shared_config() {
        let info = info_for(
            AgentType::ClaudeCode,
            Some("/opt/homebrew/bin/claude"),
            false,
        );
        assert_eq!(
            info.adapter_package,
            "@agentclientprotocol/claude-agent-acp@0.81.1"
        );
        assert_eq!(info.adapter_cmd, "claude-agent-acp");
        assert!(!info.adapter_installed);
        assert_eq!(info.native_cmd, "claude");
        assert_eq!(info.native_label, "Claude Code CLI");
        assert_eq!(info.native_path.as_deref(), Some("/opt/homebrew/bin/claude"));
        assert_eq!(info.shared_config_dir, "~/.claude");
        assert!(info.docs_url.ends_with("#acp-adapters"));
    }

    #[test]
    fn codex_adapter_info_uses_codex_home() {
        let info = info_for(AgentType::Codex, None, true);
        assert_eq!(info.adapter_package, "@agentclientprotocol/codex-acp@1.13.1");
        assert_eq!(info.adapter_cmd, "codex-acp");
        assert!(info.adapter_installed);
        assert_eq!(info.native_cmd, "codex");
        assert!(info.native_path.is_none());
        assert_eq!(info.shared_config_dir, "~/.codex");
    }

    // Non-adapter agents must produce nothing: `probe_adapter` short-circuits
    // on the registry relation, so an agent whose `cmd` IS the vendor CLI never
    // gets an explainer claiming otherwise.
    #[tokio::test]
    async fn non_adapter_agents_have_no_adapter_info() {
        for agent_type in [
            AgentType::Gemini,
            AgentType::Cline,
            AgentType::OpenCode,
            AgentType::Hermes,
        ] {
            let meta = registry::get_agent_meta(agent_type);
            assert!(
                probe_adapter(&meta).await.is_none(),
                "unexpected adapter info for {agent_type:?}"
            );
        }
    }
}
