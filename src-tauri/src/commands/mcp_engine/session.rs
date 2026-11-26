//! What a session gets: the servers codeg sends an agent when it starts one,
//! and what the agent said it can take.
//!
//! [`config_for_session`] reads the same file as the MCP inventory. Its enabled
//! user definitions feed the ACP request and session snapshot together. Built-in
//! paths follow the launch environment, and custom agents use Codeg's data dir.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;
use crate::parsers::AgentEnv;

use super::agents::{
    app_of, codeg_dir, custom_paths, custom_spec, format_of, resolve_paths, spec, AgentPaths,
    AgentSpec,
};
use super::fsio;
use super::inventory::to_entry;
use super::model::{McpDefinition, McpDelivery, McpDisableMode, McpSessionCapabilities};
use super::paused::{self, PausedFile};
use super::store::{decode, read_view, ServersView};

fn config_source(agent: AgentType, env: &AgentEnv, dir: &Path) -> Option<(AgentSpec, AgentPaths)> {
    match agent {
        AgentType::Custom(id) => Some((custom_spec(true), custom_paths(dir, id)?)),
        builtin => {
            let app = app_of(builtin)?;
            Some((spec(app), resolve_paths(app, env)))
        }
    }
}

pub(crate) fn delivery_for_agent(agent: AgentType) -> McpDelivery {
    app_of(agent).map_or(McpDelivery::CodegSession, |app| spec(app).delivery)
}

pub(crate) struct SessionConfig {
    pub basis: Option<String>,
    pub servers: BTreeMap<String, McpDefinition>,
}

/// A single read supplies the definitions sent over ACP and the corresponding
/// snapshot basis. Native-only agents use these entries for their snapshot.
pub(crate) fn config_for_session(
    agent: AgentType,
    env: &AgentEnv,
    dir: &Path,
) -> Result<SessionConfig, AppCommandError> {
    let mut config = SessionConfig {
        basis: None,
        servers: BTreeMap::new(),
    };
    let Some((spec, paths)) = config_source(agent, env, dir) else {
        return Ok(config);
    };
    let path = &paths.servers;
    let bytes = fsio::read_bytes(path).map_err(|error| {
        let detail = format!("{}: {error}", path.display());
        AppCommandError::io(error).with_detail(detail)
    })?;
    let view = decode(bytes.as_deref())
        .and_then(|text| read_view(spec.app, format_of(spec.app, path), text))
        .map_err(|problem| {
            AppCommandError::configuration_invalid(format!(
                "cannot read MCP servers from {}: {}{}",
                path.display(),
                problem.code,
                problem
                    .detail
                    .as_deref()
                    .map(|detail| format!(" ({detail})"))
                    .unwrap_or_default()
            ))
        })?;
    let native_basis = fsio::basis_of(bytes.as_deref());
    config.basis = if spec.disable_mode() == McpDisableMode::CodegPause {
        PausedFile::read(&dir.join(paused::FILE_NAME))
            .ok()
            .map(|file| paused::basis(&native_basis, file.entries(spec.app)))
    } else {
        Some(native_basis)
    };
    for raw in &view.entries {
        let entry = to_entry(&spec, raw, &view.disabled_names);
        let Some(definition) = entry.definition else {
            tracing::warn!(agent = %agent, server = %entry.key, "[MCP] skipping unusable definition");
            continue;
        };
        if entry.enabled
            && !entry.reserved
            && (spec.delivery == McpDelivery::AgentFile || spec.supports(definition.transport()))
        {
            config.servers.insert(entry.key, definition);
        }
    }
    Ok(config)
}

/// The canonical definitions available to a session, using the effective data dir.
pub(crate) fn servers_for_session(
    agent: AgentType,
    env: &AgentEnv,
) -> Result<BTreeMap<String, Value>, AppCommandError> {
    if agent == AgentType::Pi {
        return Ok(BTreeMap::new());
    }
    servers_for_session_at(agent, env, &codeg_dir())
}

fn servers_for_session_at(
    agent: AgentType,
    env: &AgentEnv,
    dir: &Path,
) -> Result<BTreeMap<String, Value>, AppCommandError> {
    let builtin = app_of(agent).map(spec);
    Ok(config_for_session(agent, env, dir)?
        .servers
        .into_iter()
        .filter(|(_, definition)| builtin.is_none_or(|spec| spec.supports(definition.transport())))
        .map(|(name, definition)| (name, definition.to_canonical_json()))
        .collect())
}

/// Hash only the MCP parts of the file, including native flags and extras.
/// File creation and formatting alone do not change the effective config, so
/// adding and then removing a server returns a connection to its launch basis.
pub(crate) fn config_fingerprint(agent: AgentType, env: &AgentEnv, dir: &Path) -> Option<String> {
    let (spec, paths) = config_source(agent, env, dir)?;
    let native = match fsio::read_bytes(&paths.servers) {
        Ok(bytes) => match decode(bytes.as_deref())
            .and_then(|text| read_view(spec.app, format_of(spec.app, &paths.servers), text))
        {
            Ok(view) if view.container_invalid.is_none() => fingerprint_view(&spec, view),
            _ => Some(fsio::basis_of(bytes.as_deref())),
        },
        Err(error) => Some(format!("unreadable:{:?}", error.kind())),
    };
    let paused = app_of(agent).and_then(|app| {
        PausedFile::read(&dir.join(paused::FILE_NAME))
            .ok()
            .and_then(|file| {
                file.entries(app)
                    .map(|entries| paused::basis("", Some(entries)))
            })
            .filter(|basis| !basis.is_empty())
    });
    if native.is_none() && paused.is_none() {
        return None;
    }
    Some(fsio::sha256_hex(
        &serde_json::to_vec(&(native, paused)).expect("MCP digests are strings"),
    ))
}

fn fingerprint_view(spec: &AgentSpec, view: ServersView) -> Option<String> {
    if view.entries.is_empty() && view.disabled_names.is_empty() {
        return None;
    }
    let entries: BTreeMap<_, _> = view
        .entries
        .into_iter()
        .map(|raw| {
            let entry = to_entry(spec, &raw, &view.disabled_names);
            let value = if let Some(definition) = entry.definition {
                serde_json::json!([definition, entry.extra, entry.enabled])
            } else {
                raw.value
            };
            ((raw.key, raw.legacy), value)
        })
        .collect();
    let entries: Vec<_> = entries.into_iter().collect();
    Some(fsio::sha256_hex(
        &serde_json::to_vec(&(entries, view.disabled_names)).expect("MCP entries are JSON values"),
    ))
}

fn declared() -> &'static Mutex<HashMap<AgentType, McpSessionCapabilities>> {
    static DECLARED: OnceLock<Mutex<HashMap<AgentType, McpSessionCapabilities>>> = OnceLock::new();
    DECLARED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Remember what `agent_type` declared in `initialize` just now: whether it
/// connects HTTP and SSE servers sent to it. codeg sends a session only the
/// servers its agent declared a transport for, so the page can say which
/// ones a session will leave out. Kept for the life of this process.
pub fn record_declared_capabilities(agent_type: AgentType, http: bool, sse: bool) {
    let mut table = declared().lock().unwrap_or_else(|e| e.into_inner());
    table.insert(
        agent_type,
        McpSessionCapabilities {
            http,
            sse,
            recorded_at: chrono::Utc::now(),
        },
    );
}

/// What the most recent session of `agent_type` declared, if one has started
/// since codeg did.
pub(crate) fn declared_capabilities(agent_type: AgentType) -> Option<McpSessionCapabilities> {
    declared()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&agent_type)
        .copied()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn custom_session_reads_only_enabled_non_reserved_servers() {
        let dir = tempfile::tempdir().unwrap();
        let agent = AgentType::custom("mcp-session-custom").unwrap();
        let file = custom_paths(dir.path(), "mcp-session-custom")
            .unwrap()
            .servers;
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(
            file,
            r#"{"mcpServers": {
            "local": {"command":"example", "args":["--stdio"], "env":{"KEY":"example"}},
            "sse": {"type":"sse", "url":"https://example.test/events"},
            "http": {"type":"http", "url":"https://example.test/mcp"},
            "paused": {"command":"paused", "disabled":true},
            "codeg-mcp": {"command":"reserved"},
            "broken": {"type":"stdio"}
        }}"#,
        )
        .unwrap();
        let servers = servers_for_session_at(agent, &AgentEnv::inherited(), dir.path()).unwrap();
        assert_eq!(
            servers.keys().map(String::as_str).collect::<Vec<_>>(),
            ["http", "local", "sse"]
        );
        assert_eq!(
            servers["local"],
            json!({"type": "stdio", "command": "example", "args": ["--stdio"], "env": {"KEY":"example"}})
        );
        assert!(servers_for_session_at(
            AgentType::Custom("../escape"),
            &AgentEnv::inherited(),
            dir.path()
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn the_last_declaration_of_an_agent_is_the_one_kept() {
        // An agent type no other test declares for.
        let agent = AgentType::Custom("mcp-engine-capabilities-test");
        assert_eq!(declared_capabilities(agent), None);
        record_declared_capabilities(agent, true, false);
        let first = declared_capabilities(agent).unwrap();
        assert!(first.http && !first.sse);
        record_declared_capabilities(agent, false, true);
        let second = declared_capabilities(agent).unwrap();
        assert!(!second.http && second.sse);
        assert!(second.recorded_at >= first.recorded_at);
    }
}
