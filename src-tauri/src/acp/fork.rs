//! ACP `session/fork` support.
//!
//! The request is the schema's typed `ForkSessionRequest` (behind
//! `unstable_session_fork`). It goes out untyped for the one reason
//! `session/new` and `session/resume` do: grok's top-level `models` has no field
//! on the typed response, so [`send_capturing_models`] reads it off the raw
//! reply first.

use agent_client_protocol::schema::v1::{
    ForkSessionRequest, ForkSessionResponse, McpServer, Meta, SessionId, AGENT_METHOD_NAMES,
};
use agent_client_protocol::{Agent, ConnectionTo};

use crate::acp::connection::{
    agent_error_text, claude_raw_sdk_session_meta, send_capturing_models, ClaudeSessionOptions,
};

use crate::acp::error::AcpError;
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// Where in the history to fork, for the agents that can honour it.
///
/// Rides as `_meta.jetbrains.air.fork` on `session/fork`. Every adapter that
/// implements it reads the same block and they all fall back to forking at the
/// TAIL when it is absent, so omitting this is always the old behaviour.
///
/// They resolve it differently, which is why all three halves exist:
///
/// * **claude-agent-acp 0.75.1** resolves in three levels: `message_id` against
///   the live id map, then against `messageIdForGrouping` (the API message id,
///   else the record uuid) along the ACTIVE parentUuid chain, then — new in
///   0.75.1 — against the full persisted transcript INCLUDING abandoned
///   branches, where a failed id finally falls through to the fingerprint. Up
///   to 0.74.0 it ignored the fingerprint entirely, so codeg sent the id alone;
///   from 0.75.1 both halves are sent, which is what turns a fork point on an
///   abandoned branch from a silent tail-fork into an exact hit.
///   `crate::parsers::claude` derives the id into
///   [`crate::models::MessageTurn::agent_message_id`], and the hash side is
///   byte-compatible with what `fingerprint_agent_message` computes (a single
///   fingerprint match even wins regardless of occurrence).
/// * **codex-acp 1.8.0** first matches `message_id` against `items[].id`, then
///   falls back to hashing each agent message and taking the
///   `message_occurrence`-th match. Newer Codex rollouts carry the native
///   assistant item id; older records use the fingerprint of the source text.
/// * **deepseek-acp 0.8.0** can also use both halves. Its id side accepts
///   either the wire id it stamps on message
///   chunks (`<turn>:<step>`) or the session log's own `message.id`, and
///   `crate::parsers::deepseek` records the latter. Its fingerprint side hashes
///   the history TWICE — once per assistant message, once per whole turn — and
///   refuses (`invalid_params`) when the two land on different turns; codeg
///   renders one bubble per log turn, so the per-turn reading is the one that
///   matches, and the id is what keeps the ambiguous case from ever being
///   reached.
///
/// All three strip a trailing `:segment:<n>` before matching, so ids must not
/// carry one.
#[derive(Debug, Clone)]
pub struct ForkPoint {
    pub message_id: String,
    pub message_fingerprint: Option<String>,
    /// 1-based index among agent messages sharing the same fingerprint.
    pub message_occurrence: Option<u32>,
}

/// `sha256:<64 lowercase hex>` of `text`, the shape codex-acp compares against.
pub fn fingerprint_agent_message(text: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

/// This turn's agent text, as one string — what codex fingerprints.
fn turn_text(turn: &MessageTurn) -> String {
    turn.blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect()
}

/// 1-based index of `turns[idx]` among the assistant turns sharing its
/// fingerprint — what both fingerprint-matching adapters count, so an answer
/// repeated verbatim earlier in the session still forks at the right one.
///
/// Assistant turns only: both hash agent messages, so a user turn with
/// identical text must not shift the count.
fn fingerprint_occurrence(turns: &[MessageTurn], idx: usize, fingerprint: &str) -> usize {
    turns[..idx]
        .iter()
        .filter(|t| {
            matches!(t.role, TurnRole::Assistant)
                && fingerprint_agent_message(&turn_text(t)) == fingerprint
        })
        .count()
        + 1
}

/// Build the fork point naming `turn_id`, or `None` when this agent/turn cannot
/// be named. The caller decides whether a tail fork is appropriate.
///
/// Only ASSISTANT turns are fork points: every adapter resolves the point
/// against an agent message, and "continue from my own prompt" is already what
/// a plain fork-send does.
pub fn resolve_fork_point(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_type: AgentType,
) -> Option<ForkPoint> {
    let idx = turns
        .iter()
        .position(|t| t.id == turn_id && matches!(t.role, TurnRole::Assistant))?;
    let turn = &turns[idx];

    match agent_type {
        // Prefer the agent's own item id. Older transcripts may only have
        // assistant text; pass its fingerprint and its one-based occurrence.
        AgentType::Codex | AgentType::ClaudeCode | AgentType::DeepSeek => {
            let text = turn_text(turn);
            let fingerprint = (!text.trim().is_empty()).then(|| fingerprint_agent_message(&text));
            // Neither half can name this turn — an assistant bubble opened by a
            // tool result alone, with no message of its own to point at.
            if turn.agent_message_id.is_none() && fingerprint.is_none() {
                return None;
            }
            let occurrence = fingerprint
                .as_ref()
                .map(|fp| fingerprint_occurrence(turns, idx, fp));
            Some(ForkPoint {
                // The field is required, and codeg's own turn id (`turn-<n>`,
                // a position, never a record uuid) is deliberately something
                // the adapter will not find, so it falls through to the fingerprint.
                message_id: turn
                    .agent_message_id
                    .clone()
                    .unwrap_or_else(|| turn_id.to_string()),
                message_fingerprint: fingerprint,
                message_occurrence: occurrence.and_then(|n| u32::try_from(n).ok()),
            })
        }
        // Every other agent either has no `session/fork` or no fork point in
        // it; forking at the tail is the honest fallback.
        _ => None,
    }
}

/// A missing anchor can describe the tail of a live transcript. For a named
/// historical Codex turn, only fall back to the tail if it really is the tail
/// (see [`is_thread_tail`]).
pub(super) fn requested_fork_point(
    turns: &[MessageTurn],
    turn_id: &str,
    agent_type: AgentType,
) -> Result<Option<ForkPoint>, AcpError> {
    let point = resolve_fork_point(turns, turn_id, agent_type);
    if point.is_none()
        && agent_type == AgentType::Codex
        && turn_id
            .strip_prefix("turn-")
            .is_some_and(|n| n.parse::<usize>().is_ok())
        && !is_thread_tail(turns, turn_id)
    {
        return Err(AcpError::protocol(format!(
            "Cannot locate the selected Codex fork point {turn_id}"
        )));
    }
    Ok(point)
}

/// Whether a tail fork lands on `turn_id`: nothing the agent carries on from
/// follows it. Mirrors the UI's `markThreadTail`, which steps over a failed
/// round's closing line and over turns that render nothing, so the reply
/// before them is still offered "fork from here" as the tail.
fn is_thread_tail(turns: &[MessageTurn], turn_id: &str) -> bool {
    let Some(idx) = turns.iter().position(|t| t.id == turn_id) else {
        return false;
    };
    turns[idx + 1..].iter().all(|t| {
        t.blocks.is_empty()
            || (matches!(t.role, TurnRole::System)
                && t.blocks
                    .iter()
                    .all(|b| matches!(b, ContentBlock::TurnError { .. })))
    })
}

impl ForkPoint {
    fn to_meta(&self) -> Meta {
        let mut fork = serde_json::Map::new();
        fork.insert("version".into(), serde_json::json!(1));
        fork.insert("messageId".into(), serde_json::json!(self.message_id));
        if let Some(fp) = &self.message_fingerprint {
            fork.insert("messageFingerprint".into(), serde_json::json!(fp));
        }
        if let Some(n) = self.message_occurrence {
            fork.insert("messageOccurrence".into(), serde_json::json!(n));
        }
        let mut meta = Meta::new();
        meta.insert(
            "jetbrains".into(),
            serde_json::json!({ "air": { "fork": fork } }),
        );
        meta
    }
}

/// Send a `session/fork` request over an existing ACP connection.
///
/// Returns the full `ForkSessionResponse` — what the caller attaches when the
/// agent cannot resume the fork — plus the raw top-level `models` value so the
/// Grok path can parse per-model reasoning-effort data (`None` when the
/// response has none).
///
/// `fork_point` forks at a chosen message instead of the tail; see [`ForkPoint`].
/// An agent that does not implement it ignores the unknown `_meta` key, so this
/// is inert rather than an error wherever it isn't understood. An agent that
/// DOES implement it but cannot resolve the point answers `invalid_params`,
/// which surfaces as a fork failure the user can retry from a different turn.
///
/// What else the request names depends on the agent; see [`build_fork_request`].
#[allow(clippy::too_many_arguments)]
pub async fn fork_session(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    agent_type: AgentType,
    cwd: &str,
    mcp_servers: &[McpServer],
    claude: &ClaudeSessionOptions,
    fork_point: Option<&ForkPoint>,
) -> Result<(ForkSessionResponse, Option<serde_json::Value>), AcpError> {
    send_capturing_models(
        cx,
        AGENT_METHOD_NAMES.session_fork,
        build_fork_request(session_id, agent_type, cwd, mcp_servers, claude, fork_point),
    )
    .await
    .map_err(|e| AcpError::protocol(format!("session/fork failed: {}", agent_error_text(&e))))
}

/// The `session/fork` request: the fork point, if any, plus — for Claude and
/// Codex — the MCP servers the session runs with (and, for Claude, its
/// `_meta.claudeCode`).
///
/// `handle_fork_or_exit` resumes the forked session straight away with the
/// connection's MCP servers. glm-acp-agent and deepseek-acp mount them there:
/// glm connects them on the fork and reconnects on the resume, deepseek mounts
/// them on a session handle the resume replaces with a new one. So for those
/// agents the fork names no MCP servers, on purpose, since naming them on the
/// fork too only starts them twice. When there is no resume (the agent does not
/// advertise it, or it fails) the fork is attached as-is, without servers.
///
/// Codex cannot get its servers from the resume (#1105). codex-acp builds the
/// forked thread's config, `mcp_servers` included, from the fork request's own
/// list (`request.mcpServers ?? []`), and from 2.2.0 it keeps the forked thread
/// subscribed. The codex app-server answers a `thread/resume` of a loaded thread
/// that still has a subscriber by rejoining it and ignoring every config
/// override ("thread/resume overrides ignored for loaded thread"). A fork that
/// named no servers therefore stayed without them, codeg-mcp included, for the
/// whole life of the session: measured live on codex-acp 2.4.0 to 2.6.0, the
/// fork's model requests carried no codeg-mcp tool while the parent's did. So
/// Codex's fork names the servers itself, which mounts them once. codex-acp
/// 1.13 through 2.1.x unsubscribed the fork, and there the resume cold-restarts
/// the thread with the resume's identical list: the servers start twice, which
/// costs a process restart but loses nothing.
///
/// claude-agent-acp is the other way round from 0.90.0 (#1317). The fork STARTS
/// the forked session — a Claude Code process of its own — from the request's
/// `cwd`, MCP servers and `_meta`, and the resume that follows reuses it only
/// when those match what the session was started with (the adapter's session
/// fingerprint: `cwd`, the servers, `_meta.claudeCode` and a few `_meta` keys
/// codeg never sends; the AIR fork point is not part of it). A fork that names
/// nothing makes the resume tear that process down and start a second one,
/// measured live: two CLI processes per fork where one does. So Claude's fork
/// names exactly what `build_resume_session_request` names — the same servers
/// and the same `claude_raw_sdk_session_meta` — and the resume then returns the
/// running session at once (measured 1 ms, where the restart took ~240 ms).
/// From 0.73.0 through 0.89.x the fork only copied the transcript and read
/// neither field, so one request serves every version codeg may launch.
fn build_fork_request(
    session_id: &SessionId,
    agent_type: AgentType,
    cwd: &str,
    mcp_servers: &[McpServer],
    claude: &ClaudeSessionOptions,
    fork_point: Option<&ForkPoint>,
) -> ForkSessionRequest {
    let mut req = ForkSessionRequest::new(session_id.clone(), cwd);
    let mut meta = fork_point.map(ForkPoint::to_meta).unwrap_or_default();
    let claude_meta = claude_raw_sdk_session_meta(agent_type, claude);
    let names_servers = claude_meta.is_some() || agent_type == AgentType::Codex;
    if let Some(session_meta) = claude_meta {
        // Disjoint keys: the fork point lives under `jetbrains`, the session's
        // own settings under `claudeCode`.
        meta.extend(session_meta);
    }
    if names_servers && !mcp_servers.is_empty() {
        req = req.mcp_servers(mcp_servers.to_vec());
    }
    if meta.is_empty() {
        req
    } else {
        req.meta(meta)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn turn(id: &str, role: TurnRole, text: &str, agent_message_id: Option<&str>) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role,
            blocks: vec![ContentBlock::Text { text: text.into() }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: agent_message_id.map(str::to_string),
        }
    }

    /// The shape both adapters parse — version 1, and the id under
    /// `jetbrains.air.fork` — as the request's own top-level `_meta`, which is
    /// where the typed request puts it.
    #[test]
    fn fork_request_carries_the_air_fork_block_as_its_meta() {
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: Some("sha256:ab".into()),
            message_occurrence: Some(2),
        };
        let wire = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &[server("other")],
            &ClaudeSessionOptions::new(true),
            Some(&point),
        ))
        .unwrap();
        assert_eq!(wire["sessionId"], "sess-1");
        assert_eq!(wire["cwd"], "/work");
        assert_eq!(
            wire["_meta"],
            serde_json::json!({"jetbrains": {"air": {"fork": {
                "version": 1,
                "messageId": "msg_01",
                "messageFingerprint": "sha256:ab",
                "messageOccurrence": 2,
            }}}})
        );
        // Codex's fork also names the connection's servers (#1105).
        assert_eq!(wire["mcpServers"][0]["name"], "other");
    }

    fn server(name: &str) -> McpServer {
        McpServer::Stdio(agent_client_protocol::schema::v1::McpServerStdio::new(
            name, "/bin/mcp",
        ))
    }

    /// For DeepSeek and Grok a tail fork is the bare request: no fork point,
    /// and no MCP servers — the resume that follows every fork is what mounts
    /// them (see [`build_fork_request`]), so naming them here would start them
    /// twice.
    #[test]
    fn a_tail_fork_names_neither_a_fork_point_nor_mcp_servers() {
        for agent_type in [AgentType::DeepSeek, AgentType::Grok] {
            let wire = serde_json::to_value(build_fork_request(
                &SessionId::new("sess-1"),
                agent_type,
                "/work",
                &[server("codeg-mcp")],
                &ClaudeSessionOptions::new(true),
                None,
            ))
            .unwrap();
            assert_eq!(
                wire,
                serde_json::json!({"sessionId": "sess-1", "cwd": "/work"}),
                "{agent_type:?}"
            );
        }
    }

    /// Codex's fork names the servers its resume names (#1105): codex-acp
    /// builds the forked thread's MCP config from the fork request alone, and
    /// the resume of that still-subscribed thread cannot add any. It carries no
    /// `_meta` of Claude's.
    #[test]
    fn a_codex_fork_names_the_servers_its_resume_sends() {
        let servers = vec![server("codeg-mcp"), server("docs")];
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &servers,
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::Codex,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            servers.clone(),
            &ClaudeSessionOptions::new(true),
        ))
        .unwrap();
        assert_eq!(fork["mcpServers"], resume["mcpServers"]);
        assert_eq!(fork["mcpServers"].as_array().map(Vec::len), Some(2));
        assert_eq!(fork["mcpServers"][0]["name"], "codeg-mcp");
        assert!(fork.get("_meta").is_none());

        // No servers: the bare request.
        let bare = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::Codex,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        assert_eq!(
            bare,
            serde_json::json!({"sessionId": "sess-1", "cwd": "/work"})
        );
    }

    /// Claude's fork names exactly the settings its resume names — the same
    /// servers and the same `_meta.claudeCode` — because claude-agent-acp
    /// 0.90.0 starts the forked session from the fork, and the resume reuses
    /// that session only when the two agree (anything else restarts it).
    #[test]
    fn a_claude_fork_names_the_settings_its_resume_sends() {
        let servers = vec![server("codeg-mcp"), server("docs")];
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &servers,
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::ClaudeCode,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            servers.clone(),
            &ClaudeSessionOptions::new(true),
        ))
        .unwrap();
        assert_eq!(fork["cwd"], resume["cwd"]);
        assert_eq!(fork["mcpServers"], resume["mcpServers"]);
        assert_eq!(fork["_meta"], resume["_meta"]);
        assert_eq!(
            fork["_meta"],
            serde_json::json!({"claudeCode": {"emitRawSDKMessages": true}})
        );
        assert_eq!(fork["mcpServers"].as_array().map(Vec::len), Some(2));

        // No servers: none named on either request.
        let bare = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            None,
        ))
        .unwrap();
        assert!(bare.get("mcpServers").is_none());
        assert_eq!(
            bare["_meta"],
            serde_json::json!({"claudeCode": {"emitRawSDKMessages": true}})
        );
    }

    /// A connection that asks for no predicted prompts (an automation run, a
    /// chat-channel bot) says so on the fork as on the resume: the option is
    /// part of the adapter's session fingerprint, so a fork that left it out
    /// would make the resume restart the forked session.
    #[test]
    fn a_claude_fork_without_prompt_suggestions_matches_its_resume() {
        let fork = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[server("codeg-mcp")],
            &ClaudeSessionOptions::new(false),
            None,
        ))
        .unwrap();
        let resume = serde_json::to_value(crate::acp::connection::build_resume_session_request(
            AgentType::ClaudeCode,
            SessionId::new("sess-2"),
            std::path::Path::new("/work"),
            vec![server("codeg-mcp")],
            &ClaudeSessionOptions::new(false),
        ))
        .unwrap();
        assert_eq!(fork["_meta"], resume["_meta"]);
        assert_eq!(
            fork["_meta"],
            serde_json::json!({"claudeCode": {
                "emitRawSDKMessages": true,
                "options": {"promptSuggestions": false},
            }})
        );
    }

    /// The fork point and the session's settings ride the same `_meta`, side by
    /// side: neither replaces the other, and the adapter's session fingerprint
    /// reads only the `claudeCode` half.
    #[test]
    fn a_claude_fork_point_rides_beside_the_session_settings() {
        let point = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        };
        let wire = serde_json::to_value(build_fork_request(
            &SessionId::new("sess-1"),
            AgentType::ClaudeCode,
            "/work",
            &[],
            &ClaudeSessionOptions::new(true),
            Some(&point),
        ))
        .unwrap();
        assert_eq!(
            wire["_meta"],
            serde_json::json!({
                "claudeCode": {"emitRawSDKMessages": true},
                "jetbrains": {"air": {"fork": {"version": 1, "messageId": "msg_01"}}},
            })
        );
    }

    /// The optional halves stay absent rather than null — every adapter
    /// validates the fingerprint's shape when present, so sending `null` would
    /// be worse than sending nothing.
    #[test]
    fn meta_omits_absent_fingerprint_and_occurrence() {
        let meta = ForkPoint {
            message_id: "msg_01".into(),
            message_fingerprint: None,
            message_occurrence: None,
        }
        .to_meta();
        let fork = &meta["jetbrains"]["air"]["fork"];
        assert!(fork.get("messageFingerprint").is_none());
        assert!(fork.get("messageOccurrence").is_none());
    }

    /// The id the parser derived leads, and 0.75.1 also reads the fingerprint,
    /// so both go out: the id resolves on the active chain, the fingerprint is
    /// what still resolves once the point has drifted onto an abandoned branch.
    #[test]
    fn claude_sends_the_derived_id_and_the_fingerprint_together() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01")),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        // Claude needs BOTH halves to use the fingerprint at all, so an
        // occurrence must ride along with it.
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// A turn Claude never named still forks by content — 0.75.1 falls through
    /// to the fingerprint when the id misses, and `turn-<n>` is a position that
    /// can never collide with a record uuid.
    #[test]
    fn claude_falls_back_to_the_fingerprint_with_no_agent_id() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", None)];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "turn-1");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
    }

    /// The one case that must stay a tail fork: a turn codeg synthesized with
    /// no text and no id. `fingerprint("")` would match every text-free
    /// grouping on Claude's side, so guessing between them by occurrence is
    /// strictly worse than not naming a point at all.
    #[test]
    fn claude_declines_a_synthesized_turn_with_neither_id_nor_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::ToolUse {
            tool_use_id: Some("tl-tool-0".into()),
            tool_name: "Bash".into(),
            input_preview: None,
            status: None,
            meta: None,
        }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::ClaudeCode).is_none());
    }

    /// A textless turn Claude DID name is still a fork point by id alone.
    #[test]
    fn claude_forks_a_textless_named_turn_by_its_id_alone() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", Some("msg_01"));
        t.blocks = Vec::new();
        let point = resolve_fork_point(&[t], "turn-1", AgentType::ClaudeCode).unwrap();
        assert_eq!(point.message_id, "msg_01");
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    #[test]
    fn codex_fork_preserves_native_ids_and_fingerprints_before_rendering_citations() {
        use crate::parsers::{
            codex::{CodexParser, CodexText},
            AgentParser,
        };
        use serde_json::json;

        let original = r#"See :codex-file-citation{path="src/main.rs"}."#;
        let response = |citation: &str| {
            json!({"type":"message", "role":"assistant",
            "content":[{"type":"output_text", "text":format!("{original}<oai-mem-citation>{citation}</oai-mem-citation>")}]})
        };
        let completion = |kind: &str, id: &str, source: &str| {
            json!({"type":"item_completed", "thread_id":source,
            "item":{"type":kind, "id":id, "content":[{"type":"Text","text":original}]}})
        };
        let mut selected = response("selected");
        selected["id"] = "msg-selected".into();
        let mut unnamed = response("third");
        unnamed["id"] = "  ".into();
        let records = [
            (
                "session_meta",
                json!({"id":"fork-test","cwd":"/repo","forked_from_id":"parent"}),
            ),
            ("session_meta", json!({"id":"parent","cwd":"/repo"})),
            ("response_item", selected),
            (
                "event_msg",
                completion("AgentMessage", "msg-completed", "fork-test"),
            ),
            ("response_item", response("second")),
            (
                "event_msg",
                completion("McpToolCall", "tool-id", "fork-test"),
            ),
            ("response_item", unnamed),
            (
                "event_msg",
                completion("AgentMessage", "foreign-id", "other-thread"),
            ),
            ("response_item", response("fourth")),
        ];
        let dir = tempfile::tempdir().unwrap();
        let transcript = records
            .into_iter()
            .map(|(kind, payload)| {
                json!({"timestamp":"2026-10-29T10:00:00Z","type":kind,"payload":payload})
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("fork-test.jsonl"), transcript).unwrap();
        let parser = CodexParser::with_base_dir(dir.path().to_owned());
        let display = parser.get_conversation("fork-test").unwrap();
        assert!(turn_text(&display.turns[0]).contains("[src/main.rs]"));
        assert!(turn_text(&display.turns[0]).contains("<oai-mem-citation>selected"));
        let native = parser
            .with_text(CodexText::Fork)
            .get_conversation("fork-test")
            .unwrap();
        let fingerprint = fingerprint_agent_message(original);
        for (index, expected_id) in ["msg-selected", "msg-completed", "turn-2", "turn-3"]
            .into_iter()
            .enumerate()
        {
            let clicked = &display.turns[index].id;
            let point = requested_fork_point(&native.turns, clicked, AgentType::Codex)
                .unwrap()
                .unwrap();
            let wire = serde_json::to_value(build_fork_request(
                &SessionId::new("fork-test"),
                AgentType::Codex,
                "/repo",
                &[],
                &ClaudeSessionOptions::new(true),
                Some(&point),
            ))
            .unwrap();
            let anchor = &wire["_meta"]["jetbrains"]["air"]["fork"];
            assert_eq!(anchor["messageId"], expected_id);
            assert_eq!(anchor["messageFingerprint"], fingerprint);
            assert_eq!(anchor["messageOccurrence"], index + 1);
        }
    }

    #[test]
    fn codex_does_not_tail_fork_an_unnamed_historical_turn() {
        let turns = [
            turn("turn-0", TurnRole::Assistant, "", None),
            turn("turn-1", TurnRole::User, "later", None),
        ];
        assert!(requested_fork_point(&turns, "turn-0", AgentType::Codex).is_err());
        assert!(requested_fork_point(&[], "turn-0", AgentType::Codex).is_err());
        assert!(
            requested_fork_point(&turns[..1], "turn-0", AgentType::Codex)
                .unwrap()
                .is_none()
        );
    }

    /// Codex builds a multi-part reply's item from its parts concatenated as-is,
    /// while codeg renders them joined by newlines. The completion twin must be
    /// matched on Codex's text, or an id-less record loses the only id it has
    /// and falls back to a fingerprint no Codex item carries.
    #[test]
    fn codex_multi_part_reply_takes_its_completion_id() {
        use crate::parsers::{
            codex::{CodexParser, CodexText},
            AgentParser,
        };
        use serde_json::json;

        let records = [
            ("session_meta", json!({"id":"multi-part","cwd":"/repo"})),
            (
                "event_msg",
                json!({"type":"item_completed", "thread_id":"multi-part",
                "item":{"type":"AgentMessage", "id":"msg-completed",
                "content":[{"type":"Text","text":"Read this."}]}}),
            ),
            (
                "response_item",
                json!({"type":"message", "role":"assistant", "content":[
                    {"type":"output_text", "text":"Read "},
                    {"type":"output_text",
                     "text":"<oai-mem-citation>memory</oai-mem-citation>this."}
                ]}),
            ),
        ];
        let dir = tempfile::tempdir().unwrap();
        let transcript = records
            .into_iter()
            .map(|(kind, payload)| {
                json!({"timestamp":"2026-10-29T10:00:00Z","type":kind,"payload":payload})
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.path().join("multi-part.jsonl"), transcript).unwrap();
        let native = CodexParser::with_base_dir(dir.path().to_owned())
            .with_text(CodexText::Fork)
            .get_conversation("multi-part")
            .unwrap();
        let point = requested_fork_point(&native.turns, &native.turns[0].id, AgentType::Codex)
            .unwrap()
            .unwrap();
        assert_eq!(point.message_id, "msg-completed");
    }

    /// A failed round's closing line (and a turn with nothing to render) is
    /// stepped over by the UI's tail marker, so the text-less reply before it
    /// is still the tail and must still tail-fork, as it did before.
    #[test]
    fn codex_tail_forks_an_unnamed_reply_before_a_failed_rounds_closing_line() {
        let failure = MessageTurn {
            role: TurnRole::System,
            blocks: vec![ContentBlock::TurnError {
                message: "API Error: 503".into(),
            }],
            ..turn("turn-1", TurnRole::System, "", None)
        };
        let empty = MessageTurn {
            blocks: vec![],
            ..turn("turn-2", TurnRole::Assistant, "", None)
        };
        let unnamed = turn("turn-0", TurnRole::Assistant, "", None);
        let tail = [unnamed.clone(), failure.clone(), empty];
        assert!(requested_fork_point(&tail, "turn-0", AgentType::Codex)
            .unwrap()
            .is_none());
        let later = [
            unnamed,
            failure,
            turn("turn-2", TurnRole::User, "later", None),
        ];
        assert!(requested_fork_point(&later, "turn-0", AgentType::Codex).is_err());
    }

    #[test]
    fn codex_forks_by_content_fingerprint() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", None),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::Codex).unwrap();
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// An answer repeated verbatim must still fork at the one the user clicked,
    /// which is the only thing `messageOccurrence` is for.
    #[test]
    fn codex_counts_repeated_answers() {
        let turns = vec![
            turn("turn-0", TurnRole::Assistant, "same", None),
            turn("turn-1", TurnRole::User, "again", None),
            turn("turn-2", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-0", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(1)
        );
        assert_eq!(
            resolve_fork_point(&turns, "turn-2", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(2)
        );
    }

    /// Codex hashes agent messages only, so a user turn with identical text
    /// must not shift the count.
    #[test]
    fn codex_occurrence_ignores_user_turns() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "same", None),
            turn("turn-1", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-1", AgentType::Codex)
                .unwrap()
                .message_occurrence,
            Some(1)
        );
    }

    /// The fingerprint is the only thing that can resolve on codex, so a turn
    /// with no text to hash is not a fork point.
    #[test]
    fn codex_declines_a_turn_with_no_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::Text { text: "   ".into() }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::Codex).is_none());
    }

    /// DeepSeek reads BOTH halves, so both are sent — unlike codex, whose id
    /// half can never resolve.
    #[test]
    fn deepseek_sends_the_log_id_and_the_fingerprint_together() {
        let turns = vec![
            turn("turn-0", TurnRole::User, "hi", None),
            turn("turn-1", TurnRole::Assistant, "hello", Some("uuid-a2")),
        ];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "uuid-a2");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
        assert_eq!(point.message_occurrence, Some(1));
    }

    /// A log that named nothing still forks by content, the codex shape: the id
    /// is codeg's own turn id, which DeepSeek cannot match, so it falls through
    /// to the fingerprint instead of failing.
    #[test]
    fn deepseek_falls_back_to_the_fingerprint_with_no_log_id() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", None)];
        let point = resolve_fork_point(&turns, "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "turn-1");
        assert_eq!(
            point.message_fingerprint.as_deref(),
            Some(fingerprint_agent_message("hello").as_str())
        );
    }

    /// An id with no text is still a fork point on DeepSeek — a bubble whose
    /// whole turn was tool calls names a message the adapter can look up, which
    /// is exactly what codex cannot do.
    #[test]
    fn deepseek_forks_a_textless_turn_by_its_id_alone() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", Some("uuid-a1"));
        t.blocks = Vec::new();
        let point = resolve_fork_point(&[t], "turn-1", AgentType::DeepSeek).unwrap();
        assert_eq!(point.message_id, "uuid-a1");
        // Nothing to hash, so no fingerprint — and none to count occurrences of.
        assert!(point.message_fingerprint.is_none());
        assert!(point.message_occurrence.is_none());
    }

    /// Neither half available (a bubble opened by a tool result alone) is not a
    /// fork point; the caller degrades to the tail.
    #[test]
    fn deepseek_declines_a_turn_with_neither_id_nor_text() {
        let mut t = turn("turn-1", TurnRole::Assistant, "", None);
        t.blocks = vec![ContentBlock::Text { text: "   ".into() }];
        assert!(resolve_fork_point(&[t], "turn-1", AgentType::DeepSeek).is_none());
    }

    /// The fingerprint half counts the same way codex's does, so a repeated
    /// answer in a log that named nothing still forks at the one clicked.
    #[test]
    fn deepseek_counts_repeated_answers() {
        let turns = vec![
            turn("turn-0", TurnRole::Assistant, "same", None),
            turn("turn-1", TurnRole::User, "again", None),
            turn("turn-2", TurnRole::Assistant, "same", None),
        ];
        assert_eq!(
            resolve_fork_point(&turns, "turn-2", AgentType::DeepSeek)
                .unwrap()
                .message_occurrence,
            Some(2)
        );
    }

    /// Forking "up to" a user turn is what a plain fork-send already does, and
    /// no adapter resolves an id against a user message.
    #[test]
    fn user_turns_are_not_fork_points() {
        let turns = vec![turn("turn-0", TurnRole::User, "hi", Some("msg_01"))];
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::ClaudeCode).is_none());
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::Codex).is_none());
        assert!(resolve_fork_point(&turns, "turn-0", AgentType::DeepSeek).is_none());
    }

    /// Every other agent forks at the tail — advertising a fork point they do
    /// not implement would silently change what their fork means.
    #[test]
    fn other_agents_have_no_fork_point() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01"))];
        for agent in [AgentType::Gemini, AgentType::Grok, AgentType::Custom("acme")] {
            assert!(resolve_fork_point(&turns, "turn-1", agent).is_none());
        }
    }

    #[test]
    fn unknown_turn_id_is_not_a_fork_point() {
        let turns = vec![turn("turn-1", TurnRole::Assistant, "hello", Some("msg_01"))];
        assert!(resolve_fork_point(&turns, "turn-9", AgentType::ClaudeCode).is_none());
    }

    /// Pinned against a digest computed outside this crate, so a change of hash
    /// or encoding cannot pass by agreeing with itself.
    #[test]
    fn fingerprint_is_sha256_hex() {
        assert_eq!(
            fingerprint_agent_message("abc"),
            "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
