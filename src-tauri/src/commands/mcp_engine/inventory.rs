//! `mcp_inventory`: what every agent's config says, agent by agent.
//!
//! Nothing is merged. A server named the same in two agents is two entries,
//! each with its own definition and fingerprint, so a difference between them
//! is visible instead of resolved in favour of whichever agent was read
//! first. An entry codeg cannot make sense of is listed with the reason, and
//! a file codeg cannot read takes only its own agent out: the others are
//! listed, and stay editable.

use std::collections::{BTreeMap, BTreeSet};

use crate::commands::mcp::McpAppType;

use super::agents::{agent_type_of, all_apps, format_of, spec, AgentPaths, AgentSpec, EngineCtx};
use super::apply::entry_flag;
use super::dialect;
use super::fsio;
use super::model::{
    codes, McpAgentInventory, McpConfigFile, McpConfigFormat, McpDelivery, McpEntry, McpFileStatus,
    McpInventory, McpIssue, McpRelatedFile, KEY_PATTERN, RESERVED_KEY,
};
use super::plugin_gate;
use super::store::{decode, read_view_with_duplicates, DuplicateKey, RawEntry};
use super::yaml_doc;

/// One entry as the inventory lists it.
pub(crate) fn to_entry(
    spec: &AgentSpec,
    raw: &RawEntry,
    disabled_names: &BTreeSet<String>,
) -> McpEntry {
    let read = dialect::read_entry(spec.app, &raw.value, entry_flag(spec, raw.legacy));
    let mut problems = read.problems;
    if let Some(definition) = &read.definition {
        if !spec.supports(definition.transport()) {
            problems.push(
                McpIssue::new(codes::UNSUPPORTED_TRANSPORT).detail(definition.transport().as_str()),
            );
        }
    }
    if raw.legacy {
        problems.push(McpIssue::new(codes::LEGACY_LOCATION));
    }
    let reserved = raw.key == RESERVED_KEY;
    if reserved {
        problems.push(McpIssue::new(codes::RESERVED_KEY));
    }
    // There twice: what is shown is what a reader of the file ends up with,
    // and no edit is taken (see `store::DuplicateKey`).
    match &raw.duplicate {
        None => {}
        Some(DuplicateKey::Entry) => problems.push(McpIssue::new(codes::DUPLICATE_KEY)),
        Some(DuplicateKey::Field(path)) => {
            problems.push(McpIssue::new(codes::DUPLICATE_KEY).field(path))
        }
    }
    McpEntry {
        key: raw.key.clone(),
        fingerprint: read.definition.as_ref().map(|d| d.fingerprint()),
        definition: read.definition,
        extra: read.extra,
        enabled: read.enabled && !disabled_names.contains(&raw.key),
        read_only: reserved || spec.scan_only || raw.duplicate.is_some(),
        reserved,
        legacy: raw.legacy,
        problems,
    }
}

fn io_reason(error: &std::io::Error) -> McpIssue {
    let code = if error.kind() == std::io::ErrorKind::PermissionDenied {
        codes::IO_PERMISSION_DENIED
    } else {
        codes::IO_ERROR
    };
    McpIssue::new(code).detail(error.to_string())
}

/// Why the settings file at `path` — the one whose `enabledPlugins` follows
/// an agent's servers — cannot be edited, when it cannot.
fn related_reason(path: &std::path::Path) -> Option<McpIssue> {
    match fsio::read_bytes(path) {
        Err(error) => Some(io_reason(&error)),
        Ok(bytes) => match decode(bytes.as_deref()) {
            Err(problem) => Some(problem),
            Ok(text) => plugin_gate::inspect(text),
        },
    }
}

/// An agent's config file, read: its state and the entries it holds.
pub(crate) fn read_agent(app: McpAppType, paths: &AgentPaths) -> (McpConfigFile, Vec<McpEntry>) {
    let spec = spec(app);
    let path = &paths.servers;
    let format = format_of(app, path);
    let mut config = McpConfigFile {
        path: path.display().to_string(),
        format,
        status: McpFileStatus::Ok,
        reason: None,
        basis: None,
        symlink: fsio::is_symlink(path),
        comments_lost_on_write: false,
        related: paths
            .plugin_gate
            .iter()
            .map(|gate| McpRelatedFile {
                role: "plugin_gate".to_string(),
                path: gate.display().to_string(),
                reason: related_reason(gate),
            })
            .collect(),
    };
    let mut entries = Vec::new();
    match fsio::read_bytes(path) {
        Err(error) => {
            config.status = McpFileStatus::Unreadable;
            config.reason = Some(io_reason(&error));
        }
        Ok(bytes) => {
            config.basis = Some(fsio::basis_of(bytes.as_deref()));
            let read = decode(bytes.as_deref()).and_then(|text| {
                read_view_with_duplicates(app, format, text).map(|view| (text, view))
            });
            match read {
                Err(problem) => {
                    config.status = McpFileStatus::Unreadable;
                    config.reason = Some(problem);
                }
                Ok((text, view)) => {
                    entries = view
                        .entries
                        .iter()
                        .map(|raw| to_entry(&spec, raw, &view.disabled_names))
                        .collect();
                    config.comments_lost_on_write =
                        format == McpConfigFormat::Yaml && yaml_doc::has_comments(text);
                    if bytes.is_none() {
                        config.status = McpFileStatus::Missing;
                    } else if let Some(container) = view.container_invalid {
                        config.status = McpFileStatus::ReadOnly;
                        config.reason =
                            Some(McpIssue::new(codes::CONTAINER_INVALID).detail(container));
                    } else if spec.scan_only {
                        config.status = McpFileStatus::ReadOnly;
                        config.reason = Some(McpIssue::new(codes::MANAGED_BY_AGENT));
                    } else if let Some(container) = view.duplicate_container {
                        config.status = McpFileStatus::ReadOnly;
                        config.reason = Some(McpIssue::new(codes::DUPLICATE_KEY).detail(container));
                    } else if fsio::is_write_protected(path) {
                        config.status = McpFileStatus::ReadOnly;
                        config.reason = Some(McpIssue::new(codes::FILE_NOT_WRITABLE));
                    }
                }
            }
        }
    }
    (config, entries)
}

fn scan_agent(ctx: &EngineCtx, app: McpAppType, installed: Option<bool>) -> McpAgentInventory {
    let spec = spec(app);
    let agent_type = agent_type_of(app);
    let empty = AgentPaths {
        servers: Default::default(),
        plugin_gate: None,
    };
    let (config, entries) = read_agent(app, ctx.paths_of(app).unwrap_or(&empty));
    let writable =
        !spec.scan_only && matches!(config.status, McpFileStatus::Ok | McpFileStatus::Missing);
    McpAgentInventory {
        agent: app,
        installed,
        writable,
        transports: spec.transports.to_vec(),
        delivery: spec.delivery,
        can_disable: spec.disable.is_supported(),
        codeg_mcp: crate::acp::connection::agent_takes_codeg_mcp(agent_type),
        session_capabilities: (spec.delivery == McpDelivery::CodegSession)
            .then(|| super::session::declared_capabilities(agent_type))
            .flatten(),
        config,
        entries,
    }
}

/// The inventory of every agent in `ctx`. `installed` says which agents are
/// on this machine, for the ones codeg could tell.
pub(crate) fn inventory(ctx: &EngineCtx, installed: &BTreeMap<McpAppType, bool>) -> McpInventory {
    McpInventory {
        agents: all_apps()
            .iter()
            .filter(|app| ctx.paths_of(**app).is_some())
            .map(|app| scan_agent(ctx, *app, installed.get(app).copied()))
            .collect(),
        reserved_keys: vec![RESERVED_KEY.to_string()],
        key_pattern: KEY_PATTERN.to_string(),
    }
}
