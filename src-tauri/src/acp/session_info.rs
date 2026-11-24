//! Session-info lookup domain types — backing the `get_session_info` MCP tool.
//!
//! When the user references a session in the composer it serializes into the
//! agent's prompt as `[title](codeg://session/<conversation_id>)`. The agent
//! reads the numeric id out of that link and calls `get_session_info`, which
//! resolves it to the session's metadata + token-usage stats and, on demand, a
//! bounded compacted view of its recent messages.
//!
//! This module holds the layer-shared pieces (mirroring [`crate::acp::question`]
//! / [`crate::acp::feedback`]):
//!   * [`SessionInfo`] / [`SessionMessages`] / [`SessionMessageItem`] — the
//!     self-describing outcome delivered over the broker socket to the tool (so
//!     the companion renders it without re-querying).
//!   * [`SessionInfoAccess`] — the listener-facing trait the production
//!     `DbSessionInfoLookup` (in `crate::commands::session_info`) implements; kept
//!     here so the listener can be unit-tested with an in-memory stub.
//!   * [`SessionInfoRuntimeConfig`] — the hot-swappable "is the feature on?" flag,
//!     read at MCP injection time (mirrors [`crate::acp::question`]).

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::models::conversation::SessionStats;

/// Hard cap on how many recent turns a single `get_session_info` call may
/// request. The companion clamps the agent-supplied `max_messages` to this, and
/// the resolver treats it as the authoritative ceiling so a pathological value
/// can't blow up the UDS frame or the LLM context.
pub const MAX_SESSION_MESSAGES: u32 = 200;

/// One compacted turn from the referenced session's transcript. NEVER carries a
/// raw `MessageTurn` / image bytes — only role + truncated text + tool names — so
/// the UDS frame and the agent's context window stay bounded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMessageItem {
    /// `"user"` | `"assistant"` | `"system"`.
    pub role: String,
    /// Concatenated text/thinking content of the turn, truncated to a per-turn
    /// character budget.
    pub text: String,
    /// Tool names invoked in this turn (deduped, first-seen order); empty when
    /// the turn ran no tools.
    pub tools: Vec<String>,
}

/// The recent-messages slice of a [`SessionInfo`], present only when the caller
/// asked for messages (`max_messages > 0`) and the transcript parsed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionMessages {
    /// Total number of turns in the session.
    pub total: u32,
    /// How many turns are included in `items` (the most recent ones).
    pub included: u32,
    /// True when older turns were dropped to fit `included` / the char budget.
    pub truncated: bool,
    pub items: Vec<SessionMessageItem>,
}

/// The resolved session description handed back to the `get_session_info` tool.
/// `found == false` is a soft "no such session" result the LLM reads (not an
/// error), produced via [`SessionInfo::not_found`].
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionInfo {
    pub found: bool,
    /// The id that was queried (codeg's internal conversation PK). Echoed so the
    /// companion can render a precise not-found message.
    pub session_id: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_branch: Option<String>,
    /// Absolute path of the session's workspace folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<DateTime<Utc>>,
    /// The parent conversation id when this session is a delegation child.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<i32>,
    /// `true` when this session was spawned by a `delegate_to_agent` call.
    pub is_delegation_child: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stats: Option<SessionStats>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<SessionMessages>,
    /// Human-readable note for a not-found result, or a partial one (e.g. the
    /// transcript parse timed out so `messages` is absent). `None` on a clean
    /// full result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl SessionInfo {
    /// A "no session matches this id" outcome — the id was well-formed but no
    /// non-deleted conversation row exists for it.
    pub fn not_found(session_id: i32) -> Self {
        Self {
            found: false,
            session_id,
            note: Some(format!(
                "No session matches id {session_id}. It may have been deleted, \
                 or never imported into codeg."
            )),
            ..Default::default()
        }
    }
}

/// History is bounded independently from the compact session preview.
pub const MAX_HISTORY_CHARS: u32 = 16_000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SessionHistoryOptions {
    pub limit: u32,
    /// Exclusive original transcript turn ID, never a numeric offset.
    pub before: Option<String>,
    pub query: Option<String>,
    pub include_tools: bool,
    pub max_chars: u32,
}

impl Default for SessionHistoryOptions {
    fn default() -> Self {
        Self {
            limit: 20,
            before: None,
            query: None,
            include_tools: false,
            max_chars: MAX_HISTORY_CHARS,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryTool {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionHistoryItem {
    pub id: String,
    pub role: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<SessionHistoryTool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionHistory {
    pub found: bool,
    pub session_id: i32,
    pub items: Vec<SessionHistoryItem>,
    pub oldest_id: Option<String>,
    pub has_more: bool,
    pub truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl SessionHistory {
    pub fn not_found(session_id: i32) -> Self {
        Self {
            session_id,
            note: SessionInfo::not_found(session_id).note,
            ..Default::default()
        }
    }
}

/// Listener-facing access to resolve a session by its codeg conversation id. The
/// production impl (`crate::commands::session_info::DbSessionInfoLookup`) reads
/// the DB + parses the on-disk transcript; tests use an in-memory stub. Mirrors
/// [`crate::acp::feedback::SessionFeedbackAccess`] and
/// [`crate::acp::question::SessionQuestionAccess`].
#[async_trait]
pub trait SessionInfoAccess: Send + Sync {
    /// Resolve `session_id` (codeg's internal conversation PK) into a
    /// [`SessionInfo`]. When `max_messages > 0`, include up to that many of the
    /// most recent compacted turns (capped at [`MAX_SESSION_MESSAGES`]). A
    /// missing / deleted id yields [`SessionInfo::not_found`].
    async fn resolve(&self, session_id: i32, max_messages: u32) -> SessionInfo;

    /// The listener supplies the caller from its authenticated connection.
    async fn rename(&self, caller_id: i32, session_id: i32, title: String) -> Result<(), String>;

    async fn read_history(
        &self,
        session_id: i32,
        _options: SessionHistoryOptions,
    ) -> SessionHistory {
        SessionHistory::not_found(session_id)
    }
}

/// The hot-swappable feature config read at MCP injection time. Kept tiny and
/// separate from the other feature configs so the `sessions` tool group toggles
/// independently — `codeg-mcp` is injected when ANY feature is enabled, and each
/// tool is listed only when its own feature is on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionInfoConfig {
    pub enabled: bool,
}

/// Shared, hot-swappable handle to [`SessionInfoConfig`]. Cloned into
/// `DelegationInjection` (read at injection) and `AppState` (updated on save).
/// Byte-for-byte mirror of [`crate::acp::question::QuestionRuntimeConfig`].
#[derive(Clone, Default)]
pub struct SessionInfoRuntimeConfig {
    inner: Arc<RwLock<SessionInfoConfig>>,
}

impl SessionInfoRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> SessionInfoConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: SessionInfoConfig) {
        *self.inner.write().await = cfg;
    }

    /// Convenience read used at MCP injection time.
    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_found_is_soft_and_carries_id() {
        let info = SessionInfo::not_found(42);
        assert!(!info.found);
        assert_eq!(info.session_id, 42);
        assert!(info.messages.is_none());
        assert!(info.note.as_deref().unwrap().contains("42"));
    }

    #[test]
    fn not_found_serializes_without_absent_option_fields() {
        // The skip_serializing_if Options keep the not-found envelope compact.
        let v = serde_json::to_value(SessionInfo::not_found(7)).unwrap();
        assert_eq!(v["found"], false);
        assert_eq!(v["session_id"], 7);
        assert!(v.get("title").is_none());
        assert!(v.get("messages").is_none());
        assert!(v.get("note").is_some());
    }

    #[tokio::test]
    async fn runtime_config_round_trips() {
        let cfg = SessionInfoRuntimeConfig::new();
        assert!(!cfg.is_enabled().await);
        cfg.set(SessionInfoConfig { enabled: true }).await;
        assert!(cfg.is_enabled().await);
        assert_eq!(cfg.snapshot().await, SessionInfoConfig { enabled: true });
    }
}
