//! Fold observations from the live ACP event stream into the MCP snapshot.

use serde_json::Value;

use super::session_state::{SessionState, ToolCallState, ToolCallStatus};
use super::types::{AcpEvent, SessionMcpServerEntry, SessionMcpServerStatus, SessionMcpState};
use crate::commands::mcp_engine::model::{
    is_valid_new_key, McpDelivery, McpTransport, RESERVED_KEY,
};

const MAX_CONFIRMED_TOOLS: usize = 64;
const INITIALIZATION_FAILED: &str = "MCP server failed to initialize.";

impl SessionState {
    /// Called under the state lock before applying the triggering event, so a
    /// status-only tool update can still use the name and metadata of its open.
    pub(crate) fn mcp_event(&self, event: &AcpEvent) -> Option<AcpEvent> {
        let state = self.mcp_state.as_ref()?;
        match event {
            AcpEvent::ToolCall {
                status,
                title,
                meta,
                ..
            } if tool_completed(status) => {
                let (server, tool) = tool_identity(state, Some(title), meta.as_ref())?;
                self.confirm_mcp_server(server, tool)
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                status,
                title,
                meta,
                ..
            } => {
                let previous = self.active_tool_calls.get(tool_call_id);
                if !status.as_deref().map_or_else(
                    || previous.is_some_and(|call| call.status == ToolCallStatus::Completed),
                    tool_completed,
                ) {
                    return None;
                }
                let (server, tool) = tool_identity(state, title.as_deref(), meta.as_ref())
                    .or_else(|| previous_tool_identity(state, previous?))?;
                self.confirm_mcp_server(server, tool)
            }
            AcpEvent::SessionFailure { record }
                if self
                    .session_failures
                    .get(&record.id)
                    .is_none_or(|existing| record.revision > existing.revision) =>
            {
                self.fail_mcp_servers([Some(record.title.as_str()), record.details.as_deref()])
            }
            AcpEvent::Error {
                message, details, ..
            } => self.fail_mcp_servers([Some(message.as_str()), details.as_deref()]),
            AcpEvent::SessionLoadFailed { message, .. } => {
                self.fail_mcp_servers([Some(message.as_str())])
            }
            _ => None,
        }
    }

    pub(crate) fn confirm_mcp_server(&self, key: &str, tool: Option<&str>) -> Option<AcpEvent> {
        let state = self.mcp_state.as_ref()?;
        let mut next = state.clone();
        let entry = server_entry(&mut next, key)?;
        entry.status = SessionMcpServerStatus::Confirmed;
        entry.detail = None;
        if let Some(tool) = tool.filter(|tool| valid_tool_name(tool)) {
            if entry.confirmed_tools.len() < MAX_CONFIRMED_TOOLS
                && !entry.confirmed_tools.iter().any(|name| name == tool)
            {
                entry.confirmed_tools.push(tool.to_owned());
            }
        }
        (next != *state).then_some(AcpEvent::SessionMcpState { state: next })
    }

    fn fail_mcp_servers<'a>(
        &self,
        messages: impl IntoIterator<Item = Option<&'a str>>,
    ) -> Option<AcpEvent> {
        let state = self.mcp_state.as_ref()?;
        let mut names = messages
            .into_iter()
            .flatten()
            .flat_map(failed_server_names)
            .peekable();
        names.peek()?;
        let mut next = state.clone();
        for key in names.filter(|key| *key != "chrome_devtools") {
            if let Some(entry) = server_entry(&mut next, key) {
                entry.status = SessionMcpServerStatus::Failed;
                // The adapter's failure tail can contain credentials, env,
                // or arbitrary stderr. Only the diagnosed failure class is public.
                entry.detail = Some(INITIALIZATION_FAILED.into());
            }
        }
        (next != *state).then_some(AcpEvent::SessionMcpState { state: next })
    }
}

fn server_entry<'a>(
    state: &'a mut SessionMcpState,
    key: &str,
) -> Option<&'a mut SessionMcpServerEntry> {
    if key == RESERVED_KEY {
        return None;
    }
    if let Some(index) = state.servers.iter().position(|entry| entry.key == key) {
        return state.servers.get_mut(index);
    }
    // A native agent may load a project-local server outside the user file.
    if !is_valid_new_key(key) {
        return None;
    }
    state.servers.push(SessionMcpServerEntry {
        key: key.to_owned(),
        transport: McpTransport::Stdio,
        origin: McpDelivery::AgentFile,
        fingerprint: None,
        status: SessionMcpServerStatus::Confirmed,
        confirmed_tools: Vec::new(),
        detail: None,
    });
    state.servers.last_mut()
}

fn tool_completed(status: &str) -> bool {
    matches!(status, "completed" | "success" | "succeeded")
}

fn valid_tool_name(tool: &str) -> bool {
    (1..=128).contains(&tool.len())
        && tool
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn previous_tool_identity<'a>(
    state: &SessionMcpState,
    call: &'a ToolCallState,
) -> Option<(&'a str, Option<&'a str>)> {
    tool_identity(state, Some(&call.label), call.meta.as_ref())
}

fn tool_identity<'a>(
    state: &SessionMcpState,
    title: Option<&'a str>,
    meta: Option<&'a Value>,
) -> Option<(&'a str, Option<&'a str>)> {
    let name_from = |value: &'a Value| {
        value
            .get("toolName")
            .or_else(|| value.get("tool_name"))
            .and_then(Value::as_str)
    };
    if let Some(meta) = meta {
        for scope in
            std::iter::once(meta).chain(meta.as_object().into_iter().flat_map(|map| map.values()))
        {
            let server = scope
                .get("mcpServerName")
                .or_else(|| scope.get("mcp_server_name"))
                .or_else(|| scope.get("mcpServer"));
            if let Some(server) = server.and_then(Value::as_str) {
                let tool = name_from(scope).or(title);
                let tool = tool.and_then(|name| match namespaced_tool(state, name) {
                    Some((named_server, tool)) if named_server == server => tool,
                    _ => Some(name),
                });
                return Some((server, tool));
            }
            if let Some(name) = scope
                .get("canonicalToolName")
                .and_then(Value::as_str)
                .or_else(|| name_from(scope))
            {
                if let Some(identity) = namespaced_tool(state, name) {
                    return Some(identity);
                }
            }
        }
        if let Some(mcp) = meta.get("mcp") {
            if let Some(server) = mcp.get("server").and_then(Value::as_str) {
                return Some((
                    server,
                    mcp.get("tool")
                        .and_then(Value::as_str)
                        .or_else(|| name_from(mcp)),
                ));
            }
        }
    }
    let title = title?;
    namespaced_tool(state, title)
        .or_else(|| {
            // Codex titles use server/tool; only a server already known to the
            // session qualifies so ordinary paths cannot become an MCP observation.
            let (server, tool) = title.split_once('/')?;
            (valid_tool_name(tool) && state.servers.iter().any(|entry| entry.key == server))
                .then_some((server, Some(tool)))
        })
        .or_else(|| {
            // Antigravity marks the MCP titles it emits as mcp.<server>.<tool>.
            if !meta
                .and_then(|meta| meta.get("is_mcp_tool_call"))
                .and_then(Value::as_bool)
                .unwrap_or_default()
            {
                return None;
            }
            let (server, tool) = title.strip_prefix("mcp.")?.split_once('.')?;
            Some((server, Some(tool)))
        })
}

fn namespaced_tool<'a>(
    state: &SessionMcpState,
    name: &'a str,
) -> Option<(&'a str, Option<&'a str>)> {
    let name = name.trim().strip_prefix("mcp__")?;
    // A server name can itself contain `__`. Prefer the longest known name.
    if let Some((server, tool)) = state
        .servers
        .iter()
        .filter_map(|entry| {
            let tool = name.strip_prefix(&entry.key)?.strip_prefix("__")?;
            Some((&name[..entry.key.len()], tool))
        })
        .max_by_key(|(server, _)| server.len())
    {
        return Some((server, Some(tool)));
    }
    let (server, tool) = name.split_once("__")?;
    Some((server, Some(tool)))
}

fn failed_server_names(message: &str) -> impl Iterator<Item = &str> {
    let raw = message
        .match_indices("MCP load failed for ")
        .filter_map(|(index, prefix)| {
            let (key, _) = message[index + prefix.len()..].split_once(':')?;
            Some(key.trim())
        });
    let displayed = message
        .match_indices("The MCP server '")
        .filter_map(|(index, prefix)| {
            let (key, reason) = message[index + prefix.len()..].split_once('\'')?;
            reason.starts_with(" failed to initialize").then_some(key)
        });
    raw.chain(displayed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_state::LiveSessionSnapshot;
    use crate::acp::types::SessionFailureRecord;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::{emit_with_state, EventEmitter};
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::RwLock;

    fn initial_state() -> SessionState {
        let mut state = SessionState::new(
            "mcp-test".into(),
            AgentType::Codex,
            None,
            "test".into(),
            None,
        );
        let mcp = SessionMcpState {
            delivery: McpDelivery::CodegSession,
            supports_mcp: true,
            codeg_mcp_attached: false,
            capabilities: None,
            config_basis: Some("test-basis".into()),
            servers: vec![SessionMcpServerEntry {
                key: "team__docs".into(),
                transport: McpTransport::Http,
                origin: McpDelivery::CodegSession,
                fingerprint: Some("test-fingerprint".into()),
                status: SessionMcpServerStatus::Attached,
                confirmed_tools: Vec::new(),
                detail: None,
            }],
        };
        state.apply_event(&AcpEvent::SessionMcpState { state: mcp });
        state
    }

    #[tokio::test]
    async fn completed_tool_uses_opening_identity_and_emits_only_changed_mcp_state() {
        let state = Arc::new(RwLock::new(initial_state()));
        let mut events = state.read().await.event_stream().subscribe();
        let opened: AcpEvent = serde_json::from_value(json!({
            "type": "tool_call", "tool_call_id": "test-call",
            "title": "Search", "kind": "other", "status": "in_progress",
            "meta": { "claudeCode": { "toolName": "mcp__team__docs__search" } }
        }))
        .unwrap();
        let completed: AcpEvent = serde_json::from_value(json!({
            "type": "tool_call_update", "tool_call_id": "test-call", "status": "completed"
        }))
        .unwrap();
        emit_with_state(&state, &EventEmitter::Noop, opened).await;
        assert!(matches!(
            events.try_recv().unwrap().payload,
            AcpEvent::ToolCall { .. }
        ));
        assert!(events.try_recv().is_err());
        emit_with_state(&state, &EventEmitter::Noop, completed.clone()).await;
        let tool = events.try_recv().unwrap();
        let mcp = events.try_recv().unwrap();
        assert_eq!(mcp.seq, tool.seq + 1);
        let AcpEvent::SessionMcpState { state: update } = &mcp.payload else {
            panic!("missing MCP update");
        };
        assert_eq!(update.servers[0].status, SessionMcpServerStatus::Confirmed);
        assert_eq!(update.servers[0].confirmed_tools, ["search"]);
        assert_eq!(update.servers[0].transport, McpTransport::Http);
        emit_with_state(&state, &EventEmitter::Noop, completed).await;
        assert!(matches!(
            events.try_recv().unwrap().payload,
            AcpEvent::ToolCallUpdate { .. }
        ));
        assert!(events.try_recv().is_err());

        let wire = serde_json::to_value(state.read().await.to_snapshot()).unwrap();
        assert_eq!(wire["mcp_state"]["servers"][0]["status"], "confirmed");
        assert_eq!(wire["mcp_state"]["config_basis"], "test-basis");
        let restored: LiveSessionSnapshot = serde_json::from_value(wire).unwrap();
        assert_eq!(restored.mcp_state.as_ref(), Some(update));
    }

    #[test]
    fn runtime_only_servers_and_confirmed_tools_are_capped_and_reserved_is_ignored() {
        let mut state = initial_state();
        assert!(state
            .confirm_mcp_server(RESERVED_KEY, Some("tool"))
            .is_none());
        assert!(state
            .confirm_mcp_server("../escape", Some("tool"))
            .is_none());
        for index in 0..MAX_CONFIRMED_TOOLS {
            let observed = state
                .confirm_mcp_server("project-source", Some(&format!("tool_{index}")))
                .unwrap();
            state.apply_event(&observed);
        }
        assert!(state
            .confirm_mcp_server("project-source", Some("tool_0"))
            .is_none());
        assert!(state
            .confirm_mcp_server("project-source", Some("overflow"))
            .is_none());
        let snapshot = state.to_snapshot().mcp_state.unwrap();
        let dynamic = &snapshot.servers[1];
        assert_eq!(dynamic.status, SessionMcpServerStatus::Confirmed);
        assert_eq!(dynamic.origin, McpDelivery::AgentFile);
        assert_eq!(dynamic.transport, McpTransport::Stdio);
        assert_eq!(dynamic.fingerprint, None);
        assert_eq!(dynamic.confirmed_tools.len(), 64);
    }

    #[test]
    fn connection_and_session_failures_mark_only_user_servers_and_redact_the_reason() {
        let mut state = initial_state();
        let incoming = AcpEvent::SessionFailure {
            record: SessionFailureRecord {
                id: "failure".into(),
                revision: 1,
                category: "connection".into(),
                severity: "error".into(),
                title: "MCP load failed for chrome_devtools: internal browser".into(),
                details: Some(
                    "The MCP server 'team__docs' failed to initialize: secret-token".into(),
                ),
                actions: Vec::new(),
                resolved: false,
                echoed_in_reply: false,
            },
        };
        let change = state.mcp_event(&incoming).unwrap();
        state.apply_event(&incoming);
        state.apply_event(&change);
        assert!(state.mcp_event(&incoming).is_none());
        let failed = state.mcp_state.as_ref().unwrap();
        assert_eq!(failed.servers.len(), 1);
        assert_eq!(failed.servers[0].status, SessionMcpServerStatus::Failed);
        assert_eq!(
            failed.servers[0].detail.as_deref(),
            Some(INITIALIZATION_FAILED)
        );
        assert!(!serde_json::to_string(&change)
            .unwrap()
            .contains("secret-token"));
        let error = AcpEvent::Error {
            message: "MCP load failed for project-source: credential".into(),
            agent_type: "codex".into(),
            code: None,
            details: None,
            terminal: true,
        };
        state.apply_event(&state.mcp_event(&error).unwrap());
        assert!(state.mcp_event(&error).is_none());
        let recovered = state
            .confirm_mcp_server("team__docs", Some("search"))
            .unwrap();
        state.apply_event(&recovered);
        let snapshot = state.to_snapshot().mcp_state.unwrap();
        assert_eq!(
            snapshot.servers[0].status,
            SessionMcpServerStatus::Confirmed
        );
        assert_eq!(snapshot.servers[0].detail, None);
        assert_eq!(snapshot.servers[1].status, SessionMcpServerStatus::Failed);
    }
}
