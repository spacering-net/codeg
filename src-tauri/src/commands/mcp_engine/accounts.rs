//! MCP configuration inherited by a named account's native CLI. Only managed
//! server entries and their enablement travel; all other config stays local.
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use serde_json::Value;
use crate::acp::{agent_accounts, codex_catalog_commit};
use crate::app_error::AppCommandError;
use crate::commands::mcp::McpAppType;
use crate::models::AgentType;
use crate::parsers::{AgentEnv, AgentEnvs};
use super::agents::{self, AgentPaths, EngineCtx};
use super::apply::{self, CodexAccess};
use super::model::{McpApplyRequest, McpFileStatus, McpOp, McpOpAction, RESERVED_KEY};
use super::{fsio, inventory};

pub(super) const MANIFEST: &str = ".codeg-mcp-servers.json";

pub(super) fn managed(bytes: Option<&[u8]>) -> Result<BTreeSet<String>, serde_json::Error> {
    match bytes {
        Some(bytes) => serde_json::from_slice(bytes),
        None => Ok(BTreeSet::new()),
    }
}

/// Resolve the existing portion too: a missing file below a linked directory
/// must not turn a named-account write into a write to another account.
fn resolved_path(path: &Path) -> std::io::Result<std::path::PathBuf> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => path.canonicalize(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match (path.parent(), path.file_name()) {
                (Some(parent), Some(name)) => Ok(resolved_path(parent)?.join(name)),
                _ => Err(e),
            }
        }
        Err(e) => Err(e),
    }
}

pub(crate) fn paths_for(
    agent: AgentType,
    home: &Path,
) -> Result<Option<(McpAppType, AgentPaths)>, AppCommandError> {
    let Some(app) = agents::app_of(agent) else {
        return Ok(None);
    };
    if agents::spec(app).scan_only
        || agent == AgentType::Cursor
        || agent_accounts::unsupported_reason(agent).is_some()
    {
        // A managed store belongs to its agent. Cursor's MCP file stays in the real home.
        return Ok(None);
    }
    let env = agent_accounts::isolation_env(agent, home)
        .map_err(AppCommandError::configuration_invalid)?;
    let paths = agents::resolve_paths(app, &AgentEnv::from_overrides(env));
    let root = resolved_path(home).map_err(AppCommandError::io)?;
    let manifest = home.join(MANIFEST);
    let inside = |file: &Path| {
        file.starts_with(home)
            && resolved_path(file).is_ok_and(|resolved| resolved.starts_with(&root))
    };
    if !home.is_absolute()
        || !inside(&paths.servers)
        || !inside(&manifest)
        || paths.plugin_gate.as_ref().is_some_and(|path| !inside(path))
    {
        return Err(AppCommandError::configuration_invalid(
            "The account's MCP configuration is outside its folder.",
        ));
    }
    Ok(Some((app, paths)))
}

pub(crate) fn shared(
    agent: AgentType,
    source: &AgentEnv,
) -> Result<BTreeMap<String, Value>, AppCommandError> {
    let Some(app) = agents::app_of(agent) else {
        return Ok(BTreeMap::new());
    };
    if agents::spec(app).scan_only {
        return Ok(BTreeMap::new());
    }
    let (file, entries) = inventory::read_agent(app, &agents::resolve_paths(app, source));
    let readable = matches!(file.status, McpFileStatus::Missing | McpFileStatus::Ok)
        || file
            .reason
            .as_ref()
            .is_some_and(|reason| reason.code == super::model::codes::FILE_NOT_WRITABLE);
    if !readable {
        return Err(AppCommandError::configuration_invalid(format!(
            "Cannot read MCP settings from {}",
            file.path
        )));
    }
    let mut out = BTreeMap::new();
    for entry in entries {
        if entry.reserved {
            continue;
        }
        let Some(definition) = entry.definition.filter(|_| !entry.read_only) else {
            return Err(AppCommandError::configuration_invalid(format!(
                "Cannot read MCP server {} in {}",
                entry.key, file.path
            )));
        };
        let mut value = definition.to_canonical_json();
        if !entry.enabled {
            value["disabled"] = Value::Bool(true);
        }
        out.insert(entry.key, value);
    }
    Ok(out)
}

/// The caller holds the global MCP lock while reading the family's config and
/// applying this snapshot. Codex also needs the commit lock for this one home.
pub(crate) fn sync_account(
    agent: AgentType,
    home: &Path,
    source: &BTreeMap<String, Value>,
    preflight: bool,
) -> Result<bool, AppCommandError> {
    if !home.is_absolute() || !home.is_dir() {
        return Err(AppCommandError::configuration_invalid(
            "Restore the account folder before continuing.",
        ));
    }
    let Some((app, paths)) = paths_for(agent, home)? else {
        return Ok(false);
    };
    let manifest = home.join(MANIFEST);
    let original = fsio::read_bytes(&manifest).map_err(AppCommandError::io)?;
    let previous = managed(original.as_deref()).map_err(|e| {
        AppCommandError::configuration_invalid(format!("Invalid account MCP manifest: {e}"))
    })?;
    let mut ops = Vec::new();
    for key in previous
        .into_iter()
        .filter(|k| !source.contains_key(k) && k != RESERVED_KEY)
    {
        ops.push(McpOp {
            agent: app,
            key,
            action: McpOpAction::Remove,
        });
    }
    for (key, value) in source {
        if key == RESERVED_KEY {
            continue;
        }
        let definition = serde_json::from_value(value.clone()).map_err(|e| {
            AppCommandError::configuration_invalid(format!("Invalid MCP server {key}: {e}"))
        })?;
        ops.push(McpOp {
            agent: app,
            key: key.clone(),
            action: McpOpAction::Set { definition },
        });
        if agents::spec(app).disable.is_supported() {
            ops.push(McpOp {
                agent: app,
                key: key.clone(),
                action: McpOpAction::SetEnabled {
                    enabled: value.get("disabled") != Some(&Value::Bool(true)),
                },
            });
        }
    }
    if ops.is_empty() {
        return Ok(false);
    }
    let path = paths.servers.clone();
    let mut ctx = EngineCtx::from_envs(&AgentEnvs::default());
    ctx.paths.insert(app, paths);
    ctx.manifests.insert(path.clone(), manifest);
    let locked = if !preflight && app == McpAppType::Codex {
        Some(
            codex_catalog_commit::lock_home_blocking(home)
                .map_err(|e| AppCommandError::configuration_invalid(e.message))?,
        )
    } else {
        None
    };
    let original = fsio::read_bytes(&path).map_err(AppCommandError::io)?;
    let request = McpApplyRequest {
        basis: BTreeMap::from([(app, fsio::basis_of(original.as_deref()))]),
        ops,
        preflight,
    };
    let access = locked
        .as_ref()
        .map_or(CodexAccess::Unlocked, |gate| CodexAccess::Locked(gate));
    let result = apply::apply_locked(&ctx, &request, &access);
    if result.ok {
        Ok(result.agents.iter().any(|agent| !agent.writes.is_empty()))
    } else {
        let code = result
            .agents
            .iter()
            .flat_map(|a| &a.issues)
            .next()
            .map(|i| i.code.as_str())
            .unwrap_or("write_failed");
        Err(AppCommandError::configuration_invalid(format!(
            "Cannot synchronize MCP settings in {}: {code}",
            path.display()
        )))
    }
}
