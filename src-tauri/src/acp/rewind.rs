//! `_session/rewind`: cut the live session back to just before one of the
//! user's messages, so an edited version of it can be sent in its place.
//!
//! claude-agent-acp 0.112.0 (#1704) and codex-acp 2.12.0 (#801) implement the
//! same AIR extension: `{sessionId, cursorId}` → `{rewound, reason?}`, offered
//! only to a client that lists `"sessionRewind"` in its
//! `_meta.jetbrains.air.capabilities` (and only on ACP v1). The adapter cuts
//! the SAME provider session — Claude resumes at the entry before the message,
//! Codex reverts the thread before the turn — and persists the cut, so model,
//! mode and everything before the point carry over.
//!
//! **The cursor is built here, not taken from the wire.** Both adapters can
//! announce cursors as `cursor_update` session updates, but only to a client
//! declaring `clientCapabilities.session.cursors`, and the schema crate codeg
//! builds against has neither the capability nor the update. They don't need
//! announcing: each adapter resolves a cursor against its stored history, and
//! both spell it `before:<id>` with an id the transcript already holds —
//! Claude's prompt record uuid, Codex's `task_started.turn_id`. The parsers
//! put that id on the user turn ([`MessageTurn::agent_message_id`]); measured
//! live on both releases, a rewind with a cursor built from it succeeds in the
//! session that sent the prompt and in one resumed later.
//!
//! **Which turn the user means** is named by that agent id and nothing else:
//! the fresh parse is searched for exactly it, which no amount of history
//! arriving meanwhile, and no parser dedup of a repeated message, can move. A
//! message this session sent gets its id from the post-turn reparse, which
//! names a local user turn only where every one of the batch's prompts lines
//! up with the parse, text for text (`computeTurnMetadataPatches`); until then
//! it offers no edit. The message's text rides along as a second check.

use agent_client_protocol::schema::v1::SessionId;
use agent_client_protocol::{Agent, ConnectionTo, UntypedMessage};

use crate::acp::error::AcpError;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

/// The AIR capability both adapters gate `_session/rewind` on.
pub const SESSION_REWIND_CAPABILITY: &str = "sessionRewind";

const REWIND_METHOD: &str = "_session/rewind";

/// A codeg-side `reason`: the agent refused the cursor itself (`-32602`) —
/// the first message, a slash command, a turn opened by a hidden message, a
/// point before the session's newest compaction on Codex. Nothing changed.
pub const REASON_UNAVAILABLE: &str = "unavailable";

/// The edited message to cut the session back for, riding on its own prompt
/// (`acp_prompt`'s `rewind`): the session is cut and the prompt admitted in one
/// step, under the prompt lock, so no other prompt and no fork can take the
/// cut session's first turn.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RewindTarget {
    /// The agent's id for the message (`MessageTurn::agent_message_id`).
    pub agent_message_id: String,
    /// The message's text as the user saw it, checked against the parse.
    pub text: String,
}

/// A safety net only: the hold is released by the edited prompt itself a
/// moment after it is set. A caller that disappears in between frees the
/// connection when this runs out.
pub const REWIND_HOLD: std::time::Duration = std::time::Duration::from_secs(20);

/// Between the rewind and the admission of the edited prompt that follows it
/// in the same call, the prompt lock keeps out every prompt that takes it — but
/// the chat channel's `send_prompt` does not, and goes by `turn_in_flight`
/// alone. The hold covers that gap: set before the rewind is sent, it turns
/// away every prompt but the one carrying its token, which releases it.
#[derive(Debug, Clone)]
pub struct RewindHold {
    pub client_message_id: String,
    pub until: std::time::Instant,
}

impl RewindHold {
    pub fn new(client_message_id: String) -> Self {
        Self {
            client_message_id,
            until: std::time::Instant::now() + REWIND_HOLD,
        }
    }
}

/// Whether `hold` turns away a prompt carrying `message_id`: it is still
/// running and the prompt is not the edited message it waits for.
pub fn hold_blocks(hold: Option<&RewindHold>, message_id: Option<&str>) -> bool {
    hold.is_some_and(|h| {
        std::time::Instant::now() < h.until && message_id != Some(h.client_message_id.as_str())
    })
}

/// What `_session/rewind` answered. `rewound: false` always means the
/// conversation is exactly as it was; `reason` is the adapter's word for why
/// (`busy`, `backgroundWork`, `beforeCompaction`, `clearedContext`,
/// `persistFailed`, `providerRefused`) or [`REASON_UNAVAILABLE`].
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct RewindOutcome {
    pub rewound: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl RewindOutcome {
    fn refused(reason: impl Into<String>) -> Self {
        Self {
            rewound: false,
            reason: Some(reason.into()),
        }
    }
}

/// Whether the agent's `initialize` response offers `_session/rewind`. Both
/// adapters echo the capability into their own `_meta.jetbrains.air
/// .capabilities` only when the client declared it, so this is also the
/// version gate: older releases never list it.
pub fn agent_offers_rewind(meta: Option<&serde_json::Map<String, serde_json::Value>>) -> bool {
    meta.and_then(|m| m.get("jetbrains"))
        .and_then(|j| j.get("air"))
        .and_then(|air| air.get("capabilities"))
        .and_then(serde_json::Value::as_array)
        .is_some_and(|caps| {
            caps.iter()
                .any(|c| c.as_str() == Some(SESSION_REWIND_CAPABILITY))
        })
}

/// The text of a user turn as both sides compare it: its text blocks joined,
/// whitespace runs collapsed. The frontend sends the same join of the turn it
/// renders (`handleEditUserTurn`).
pub fn user_turn_text(turn: &MessageTurn) -> String {
    let joined: String = turn
        .blocks
        .iter()
        .filter_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    joined.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Resolve the cursor of the user turn whose agent id the frontend names,
/// checked against the text the user saw.
pub fn resolve_rewind_cursor(
    turns: &[MessageTurn],
    agent_message_id: &str,
    expected_text: &str,
) -> Result<String, AcpError> {
    let wanted = agent_message_id.trim();
    let turn = turns
        .iter()
        .filter(|t| matches!(t.role, TurnRole::User))
        .find(|t| !wanted.is_empty() && t.agent_message_id.as_deref() == Some(wanted))
        .ok_or_else(|| {
            AcpError::protocol(
                "The message to edit is not in the agent's history; reopen the \
                 conversation and try again"
                    .to_string(),
            )
        })?;
    let expected: String = expected_text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if user_turn_text(turn) != expected {
        return Err(AcpError::protocol(
            "The agent's history does not match the conversation on screen; reopen the \
             conversation and try again"
                .to_string(),
        ));
    }
    let id = turn
        .agent_message_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| AcpError::protocol("This message cannot be edited in place".to_string()))?;
    Ok(format!("before:{id}"))
}

/// Send `_session/rewind` and read its answer. An `-32602` (the adapter does
/// not accept this cursor) is an ordinary refusal, not a failure: the
/// conversation is untouched and the user only needs to hear why.
pub async fn send_rewind_request(
    cx: &ConnectionTo<Agent>,
    session_id: &SessionId,
    cursor_id: &str,
) -> Result<RewindOutcome, AcpError> {
    let params = serde_json::json!({
        "sessionId": session_id.0.as_ref(),
        "cursorId": cursor_id,
    });
    let request = UntypedMessage::new(REWIND_METHOD, params)
        .map_err(|e| AcpError::protocol(format!("Failed to build rewind request: {e}")))?;
    match cx.send_request_to(Agent, request).block_task().await {
        Ok(raw) => parse_rewind_outcome(&raw),
        Err(e)
            if matches!(
                e.code,
                agent_client_protocol::schema::v1::ErrorCode::InvalidParams
            ) =>
        {
            tracing::info!("[ACP] rewind refused by the agent: {e}");
            Ok(RewindOutcome::refused(REASON_UNAVAILABLE))
        }
        Err(e) => Err(AcpError::protocol(format!(
            "Rewind request failed: {}",
            crate::acp::connection::agent_error_text(&e)
        ))),
    }
}

/// Strict on the one field that matters: an answer that does not say whether
/// the cut happened must not be read as either.
fn parse_rewind_outcome(raw: &serde_json::Value) -> Result<RewindOutcome, AcpError> {
    let rewound = raw
        .get("rewound")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| AcpError::protocol(format!("unexpected _session/rewind answer: {raw}")))?;
    let reason = (!rewound).then(|| {
        raw.get("reason")
            .and_then(serde_json::Value::as_str)
            .filter(|r| !r.is_empty())
            .unwrap_or(REASON_UNAVAILABLE)
            .to_string()
    });
    Ok(RewindOutcome { rewound, reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use serde_json::json;

    fn turn(id: &str, role: TurnRole, text: &str, agent_message_id: Option<&str>) -> MessageTurn {
        MessageTurn {
            id: id.to_string(),
            role,
            blocks: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: agent_message_id.map(str::to_string),
        }
    }

    fn convo() -> Vec<MessageTurn> {
        vec![
            turn("turn-0", TurnRole::User, "first", Some("u1")),
            turn("turn-1", TurnRole::Assistant, "ok", Some("msg_1")),
            turn("turn-2", TurnRole::User, "second  question", Some("u2")),
            turn("turn-3", TurnRole::Assistant, "ok", Some("msg_2")),
            turn("turn-4", TurnRole::User, "third", Some("u3")),
            turn("turn-5", TurnRole::Assistant, "ok", None),
        ]
    }

    #[test]
    fn the_agent_id_names_the_turn_and_its_cursor() {
        let turns = convo();
        assert_eq!(
            resolve_rewind_cursor(&turns, "u3", "third").unwrap(),
            "before:u3"
        );
        // Whitespace is compared collapsed on both sides.
        assert_eq!(
            resolve_rewind_cursor(&turns, "u2", "second question\n").unwrap(),
            "before:u2"
        );
    }

    #[test]
    fn an_agent_id_names_the_turn_wherever_it_now_sits() {
        // More exchanges landed after the user's view, one repeating the
        // edited message word for word: the id still names the one clicked.
        let mut turns = convo();
        turns.push(turn(
            "turn-6",
            TurnRole::User,
            "second question",
            Some("u4"),
        ));
        turns.push(turn("turn-7", TurnRole::Assistant, "ok", None));
        assert_eq!(
            resolve_rewind_cursor(&turns, "u2", "second question").unwrap(),
            "before:u2"
        );
    }

    #[test]
    fn an_unknown_id_or_a_text_mismatch_refuses() {
        let turns = convo();
        assert!(resolve_rewind_cursor(&turns, "gone", "third").is_err());
        assert!(resolve_rewind_cursor(&turns, "", "third").is_err());
        // The text has to match the message the id names.
        assert!(resolve_rewind_cursor(&turns, "u3", "second question").is_err());
        // An assistant turn's id is no rewind point.
        assert!(resolve_rewind_cursor(&turns, "msg_1", "ok").is_err());
    }

    #[test]
    fn a_hold_lets_only_its_own_message_through_until_it_runs_out() {
        let hold = RewindHold::new("optimistic-1".to_string());
        assert!(hold_blocks(Some(&hold), None));
        assert!(hold_blocks(Some(&hold), Some("optimistic-2")));
        assert!(!hold_blocks(Some(&hold), Some("optimistic-1")));
        assert!(!hold_blocks(None, None));
        let expired = RewindHold {
            client_message_id: "optimistic-1".to_string(),
            until: std::time::Instant::now() - std::time::Duration::from_secs(1),
        };
        assert!(!hold_blocks(Some(&expired), None));
    }

    #[test]
    fn the_capability_is_read_from_the_agents_air_meta() {
        let meta = json!({"jetbrains": {"air": {"version": 1, "capabilities": ["sessionFailure", "sessionRewind"]}}});
        assert!(agent_offers_rewind(meta.as_object()));
        let older =
            json!({"jetbrains": {"air": {"version": 1, "capabilities": ["sessionFailure"]}}});
        assert!(!agent_offers_rewind(older.as_object()));
        assert!(!agent_offers_rewind(None));
    }

    #[test]
    fn the_answer_is_read_strictly() {
        assert_eq!(
            parse_rewind_outcome(&json!({"rewound": true})).unwrap(),
            RewindOutcome {
                rewound: true,
                reason: None
            }
        );
        assert_eq!(
            parse_rewind_outcome(&json!({"rewound": false, "reason": "busy"})).unwrap(),
            RewindOutcome::refused("busy")
        );
        assert_eq!(
            parse_rewind_outcome(&json!({"rewound": false})).unwrap(),
            RewindOutcome::refused(REASON_UNAVAILABLE)
        );
        assert!(parse_rewind_outcome(&json!({})).is_err());
    }
}
