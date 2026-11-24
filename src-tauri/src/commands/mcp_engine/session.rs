//! What a session gets: the servers codeg sends an agent when it starts one,
//! and what the agent said it can take.
//!
//! [`servers_for_session`] is the reader behind
//! `acp::connection::load_mcp_servers_for_agent`. It reads the same file the
//! Harness page shows for the agent — resolved with the environment the agent
//! is launched with — and leaves out what must not be sent: an entry the
//! agent's own flag turns off, an entry named like codeg's built-in
//! companion (which is injected separately and would collide), an entry
//! codeg cannot describe, and an entry whose transport the agent cannot run.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;
use crate::parsers::AgentEnv;

use super::agents::{app_of, format_of, resolve_paths, spec};
use super::fsio;
use super::inventory::to_entry;
use super::model::McpSessionCapabilities;
use super::store::{decode, read_view};
use crate::commands::mcp::McpAppType;

/// The servers to send `agent_type`, launched with `env`, at session start:
/// name → `{type, command/args/env | url/headers}`.
pub(crate) fn servers_for_session(
    agent_type: AgentType,
    env: &AgentEnv,
) -> Result<BTreeMap<String, Value>, AppCommandError> {
    let mut out = BTreeMap::new();
    // A custom agent has no config file codeg knows; pi-acp drops what it is
    // sent, and scanning the pi extension's file must not change that.
    let Some(app) = app_of(agent_type).filter(|app| *app != McpAppType::Pi) else {
        return Ok(out);
    };
    let spec = spec(app);
    let paths = resolve_paths(app, env);
    let path = &paths.servers;
    let bytes = fsio::read_bytes(path).map_err(|error| {
        let detail = format!("{}: {error}", path.display());
        AppCommandError::io(error).with_detail(detail)
    })?;
    let view = decode(bytes.as_deref())
        .and_then(|text| read_view(app, format_of(app, path), text))
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
    for raw in &view.entries {
        let entry = to_entry(&spec, raw, &view.disabled_names);
        let Some(definition) = entry.definition else {
            tracing::warn!(
                agent = %agent_type,
                server = %entry.key,
                problems = ?entry.problems.iter().map(|p| p.code.as_str()).collect::<Vec<_>>(),
                "[MCP] an entry that is not a usable server is not sent to the session"
            );
            continue;
        };
        if !entry.enabled || entry.reserved || !spec.supports(definition.transport()) {
            continue;
        }
        out.insert(entry.key, definition.to_canonical_json());
    }
    Ok(out)
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
