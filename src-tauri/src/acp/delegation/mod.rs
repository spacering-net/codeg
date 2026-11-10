//! Multi-agent delegation: the parent agent's LLM can call the built-in MCP
//! tool `delegate_to_agent` to spawn a fresh ACP session of any (possibly
//! different) agent type, wait for its first turn to finish, and receive the
//! sub-agent's final assistant text as the MCP tool_result.
//!
//! The high-level wiring is:
//!
//! ```text
//!   parent LLM ─┐
//!               │ ToolUse(delegate_to_agent, ...)
//!               ▼
//!   parent CLI ──stdio──► codeg-mcp (per-launch companion binary)
//!                                 │
//!                                 │ UDS / named pipe (token-authed)
//!                                 ▼
//!                       DelegationBroker (this module)
//!                                 │
//!                                 │ ConnectionSpawner trait
//!                                 ▼
//!                       ConnectionManager.spawn_agent / send_prompt_linked
//!                                 │
//!                                 ▼
//!                       child ACP session  ── TurnComplete ──┐
//!                                                            │
//!   parent LLM ◄── MCP tool_result ◄── DelegationOutcome ◄───┘
//! ```
//!
//! v1 is one-shot (function-call semantics): after the child's first
//! `TurnComplete`, the broker resolves the pending call, sends `disconnect`
//! to the child, and returns. v2 will introduce `continue_with_session` /
//! `close_session` tools without protocol breakage.
//!
//! One deliberate exception to one-shot: `resume_delegation` revives a task
//! that was INTERRUPTED (canceled, or stranded by a crash) by re-spawning its
//! child connection with the recorded agent session id and re-arming the same
//! `delegation_call_id` routing — strictly a continuation of the original
//! task, never a second iteration on it (the tool takes no task text).

pub mod assistants;
pub mod broker;
pub mod companion;
pub mod depth;
pub mod event_emitter;
pub mod listener;
pub mod live_reply;
pub mod meta_writer;
pub mod parent_watcher;
pub mod service;
pub mod spawner;
pub mod transport;
pub mod types;

/// Canonical titles written onto a parent tool call that was announced
/// identity-less (Cursor's `"MCP: tool"` — see
/// `acp::lifecycle::CURSOR_IDENTITYLESS_MCP_TITLE`) once the companion
/// round-trip reveals which codeg-mcp tool it actually is. Two writers must
/// agree on these strings: the broker/listener call-time rewrite
/// (`DelegationBroker::rewrite_identityless_tool_call`) and the
/// completion-time result sniff in `acp::connection`
/// (`cursor_companion_title_from_content`). The `codeg-mcp__<tool>` shape is
/// what the frontend's tool-name normalizer already resolves to the dedicated
/// delegation / status cards.
pub const DELEGATE_TOOL_REWRITE_TITLE: &str = "codeg-mcp__delegate_to_agent";
pub const STATUS_TOOL_REWRITE_TITLE: &str = "codeg-mcp__get_delegation_status";
pub const CANCEL_TOOL_REWRITE_TITLE: &str = "codeg-mcp__cancel_delegation";
pub const RESUME_TOOL_REWRITE_TITLE: &str = "codeg-mcp__resume_delegation";

/// Whether a host's name for a tool is codeg-mcp's own `tool`, in whatever
/// spelling the host composed it — `mcp__codeg-mcp__ask_user_question` from
/// claude-agent-acp, `codeg-mcp__ask_user_question`, `codeg-mcp/…`,
/// `codeg-mcp: …`, `mcp.codeg-mcp.…`, any case. The name is cut at the first
/// separator between server and tool (`__`, `/`, `:` or `.`, after an optional
/// leading `mcp`), and each half must be exactly codeg-mcp's and the tool's: a
/// server named `other-codeg-mcp` or `codeg` (whose `mcp_submit_result` would
/// read the same with the boundary gone), or a tool named
/// `ask_user_question_twice`, is someone else's. It decides auto-approvals, so a
/// near miss keeps its approval card.
pub fn is_codeg_mcp_tool(name: &str, tool: &str) -> bool {
    const BOUNDARIES: [&str; 4] = ["__", "/", ":", "."];
    let name = name.trim().to_ascii_lowercase();
    let name = BOUNDARIES
        .iter()
        .find_map(|sep| name.strip_prefix(&format!("mcp{sep}")))
        .unwrap_or(&name);
    let Some((at, sep)) = BOUNDARIES
        .iter()
        .filter_map(|sep| name.find(sep).map(|at| (at, *sep)))
        .min_by_key(|(at, _)| *at)
    else {
        return false;
    };
    let (server, named_tool) = (name[..at].trim(), name[at + sep.len()..].trim());
    matches!(server, "codeg-mcp" | "codeg_mcp") && named_tool == tool
}

#[cfg(test)]
mod tests {
    use super::is_codeg_mcp_tool;

    #[test]
    fn a_codeg_mcp_tool_is_known_by_its_whole_name_only() {
        for name in [
            "mcp__codeg-mcp__submit_result",
            "codeg-mcp__submit_result",
            "codeg-mcp/submit_result",
            "codeg-mcp: submit_result",
            "mcp.codeg-mcp.submit_result",
            "  MCP__Codeg-MCP__Submit_Result  ",
        ] {
            assert!(is_codeg_mcp_tool(name, "submit_result"), "{name}");
        }
        for name in [
            "mcp__other-codeg-mcp__submit_result",
            "mcp__codeg-mcp-x__submit_result",
            "mcp__codeg-mcp__submit_result_twice",
            "mcp__codeg-mcp__ask_user_question",
            // A server named `codeg` with a tool `mcp_submit_result`: the same
            // words, another boundary.
            "mcp__codeg__mcp_submit_result",
            "codeg/mcp_submit_result",
            "submit_result",
            "codeg-mcp",
            "",
        ] {
            assert!(!is_codeg_mcp_tool(name, "submit_result"), "{name}");
        }
    }
}
