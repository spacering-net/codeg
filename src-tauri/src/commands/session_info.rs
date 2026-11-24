//! `get_session_info` backing logic + settings persistence.
//!
//! Two surfaces live here, mirroring `crate::commands::question`:
//!
//!   * [`DbSessionInfoLookup`] — the production [`SessionInfoAccess`] impl the
//!     delegation listener calls to resolve a referenced session
//!     (`codeg://session/<id>`) into metadata + token stats and, on demand, a
//!     bounded compacted view of its recent messages. It reuses
//!     [`get_folder_conversation_core`] (which reads the conversation row, uses
//!     its bound `external_id` + `agent_type` to pick the right parser, and parses
//!     the on-disk transcript off the runtime via `spawn_blocking`).
//!   * The `session_info.enabled` settings knob (**default true**) — read at MCP
//!     injection time via [`SessionInfoRuntimeConfig`]. Persist + apply + broadcast
//!     follows the exact shape of the ask-question / feedback toggles.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::session_info::{
    SessionChild, SessionHistory, SessionHistoryItem, SessionHistoryOptions, SessionHistoryTool,
    SessionInfo, SessionInfoAccess, SessionInfoConfig, SessionInfoRuntimeConfig,
    SessionMessageItem, SessionMessages, MAX_HISTORY_CHARS, MAX_SESSION_MESSAGES,
};
use crate::app_error::AppCommandError;
use crate::commands::conversations::get_folder_conversation_core;
use crate::db::service::{app_metadata_service, conversation_service, folder_service};
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};
use crate::web::event_bridge::{emit_event, EventEmitter, SESSION_INFO_SETTINGS_CHANGED_EVENT};

/// Upper bound on a single compacted turn's text. Keeps one chatty turn from
/// dominating the budget; longer text is truncated with an ellipsis marker.
const PER_TURN_CHARS: usize = 1_500;

/// Overall character budget across all included turns (text AND tool names).
/// Walked newest-first so the most recent context survives; older turns are
/// dropped once this is exhausted.
const OVERALL_CHARS: usize = 16_000;

/// Per-turn caps on the collected tool names, so a turn with thousands of
/// `ToolUse` blocks (or one with a pathologically long tool name) can't inflate
/// the payload past the text budget. Tool-name chars are ALSO charged against
/// [`OVERALL_CHARS`].
const MAX_TOOLS_PER_TURN: usize = 16;
const MAX_TOOL_NAME_CHARS: usize = 64;

/// How long the transcript parse may run before the resolver gives up and returns
/// metadata only. The session keeps existing; the agent simply gets no messages
/// this call (with a `note` explaining why). Generous for large session files,
/// bounded so a pathological file can't pin the round-trip.
///
/// NOTE: this bounds the *response latency*, not the underlying work — the parse
/// runs on tokio's blocking pool (`spawn_blocking` inside
/// `get_folder_conversation_core`), which cannot be canceled, so a timed-out parse
/// keeps running to completion in the background. [`MAX_CONCURRENT_PARSES`] is what
/// actually protects the blocking pool from a flood of large-session reads.
const PARSE_TIMEOUT: Duration = Duration::from_secs(8);

/// Cap on concurrent transcript parses across all `get_session_info` calls. A
/// small bound keeps a burst of reads on large sessions from saturating tokio's
/// blocking pool (each parse pins one blocking thread, uncancelable). Excess
/// concurrent callers do NOT queue — `bounded_parse` uses a non-blocking
/// `try_acquire`, so a call that finds every slot taken returns `Busy` and
/// degrades to metadata-only immediately.
const MAX_CONCURRENT_PARSES: usize = 4;

/// Production [`SessionInfoAccess`]: resolves a session by codeg conversation id
/// against the DB + on-disk transcript. Wraps an `Arc<AppDatabase>` (like
/// `DbDepthLookup` / `DbChildStatusLookup`) plus a semaphore bounding concurrent
/// transcript parses. Construct via [`DbSessionInfoLookup::new`].
pub struct DbSessionInfoLookup {
    pub db: Arc<AppDatabase>,
    /// Limits concurrent `get_folder_conversation_core` parses (see
    /// [`MAX_CONCURRENT_PARSES`]).
    parse_limit: Arc<tokio::sync::Semaphore>,
}

impl DbSessionInfoLookup {
    pub fn new(db: Arc<AppDatabase>) -> Self {
        Self {
            db,
            parse_limit: Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_PARSES)),
        }
    }
}

#[async_trait]
impl SessionInfoAccess for DbSessionInfoLookup {
    async fn resolve(&self, session_id: i32, max_messages: u32) -> SessionInfo {
        let conn = &self.db.conn;
        // get_by_id is the authoritative existence + metadata source (cheap PK
        // lookup, already filters soft-deleted). Resolve it FIRST so a missing
        // session is cleanly "not found" rather than conflated with a parse error.
        let summary = match conversation_service::get_by_id(conn, session_id).await {
            Ok(s) => s,
            Err(_) => return SessionInfo::not_found(session_id),
        };

        let (workspace_path, workspace_name) =
            match folder_service::get_folder_by_id(conn, summary.folder_id).await {
                Ok(Some(folder)) => (Some(folder.path), Some(folder.name)),
                _ => (None, None),
            };

        let mut info = SessionInfo {
            found: true,
            session_id: summary.id,
            external_id: summary.external_id.clone(),
            agent_type: Some(agent_type_str(summary.agent_type)),
            title: summary.title.clone().filter(|t| !t.trim().is_empty()),
            status: Some(summary.status.clone()),
            model: summary.model.clone(),
            git_branch: summary.git_branch.clone(),
            workspace_path,
            workspace_name,
            message_count: Some(summary.message_count),
            created_at: Some(summary.created_at),
            updated_at: Some(summary.updated_at),
            parent_id: summary.parent_id,
            is_delegation_child: summary.kind
                == crate::db::entities::conversation::ConversationKind::Delegate,
            stats: None,
            messages: None,
            children: Vec::new(),
            children_truncated: false,
            note: None,
        };

        match conversation_service::list_children(conn, session_id).await {
            Ok(children) => {
                info.children_truncated = children.len() > MAX_SESSION_MESSAGES as usize;
                info.children = children
                    .into_iter()
                    .take(MAX_SESSION_MESSAGES as usize)
                    .map(|child| SessionChild {
                        session_id: child.id,
                        task_id: child.delegation_call_id,
                        status: child.status,
                    })
                    .collect();
            }
            Err(_) => info.note = Some("Delegation children could not be read.".into()),
        }

        if max_messages == 0 {
            return info;
        }
        let max = max_messages.min(MAX_SESSION_MESSAGES);

        // Parse the transcript off the hot path, gated by `parse_limit` and bounded
        // by PARSE_TIMEOUT (see `bounded_parse`). A busy / timeout / parse error all
        // degrade to metadata-only with an explanatory note rather than failing the
        // whole tool call.
        let conn_owned = self.db.conn.clone();
        let parse = async move { get_folder_conversation_core(&conn_owned, session_id).await };
        match bounded_parse(self.parse_limit.clone(), PARSE_TIMEOUT, parse).await {
            ParseSlot::Ready(Ok((detail, parsed_title))) => {
                if info.title.is_none() {
                    info.title = parsed_title.filter(|t| !t.trim().is_empty());
                }
                // get_folder_conversation_core sets summary.message_count to the
                // parsed turn count — more accurate than the stored row.
                info.message_count = Some(detail.summary.message_count);
                info.stats = detail.session_stats;
                info.messages = Some(compact_turns(&detail.turns, max));
            }
            ParseSlot::Ready(Err(_)) => {
                info.note = Some(
                    "Recent messages are unavailable — the session transcript could not be parsed."
                        .to_string(),
                );
            }
            ParseSlot::Busy => {
                info.note = Some(
                    "Recent messages are unavailable — too many session reads are in progress. \
                     Retry, or call again with max_messages: 0 for metadata only."
                        .to_string(),
                );
            }
            ParseSlot::TimedOut => {
                info.note = Some(
                    "Recent messages are unavailable — reading the session transcript timed out. \
                     Retry, or call again with max_messages: 0 for metadata only."
                        .to_string(),
                );
            }
        }
        info
    }

    async fn read_history(
        &self,
        session_id: i32,
        options: SessionHistoryOptions,
    ) -> SessionHistory {
        if conversation_service::get_by_id(&self.db.conn, session_id)
            .await
            .is_err()
        {
            return SessionHistory::not_found(session_id);
        }
        let conn = self.db.conn.clone();
        let parse = async move { get_folder_conversation_core(&conn, session_id).await };
        let note = match bounded_parse(self.parse_limit.clone(), PARSE_TIMEOUT, parse).await {
            ParseSlot::Ready(Ok((detail, _))) => {
                return history_page(session_id, &detail.turns, &options)
            }
            ParseSlot::Ready(Err(_)) => {
                "History is unavailable: the session transcript could not be parsed."
            }
            ParseSlot::Busy => {
                "History is unavailable: too many session reads are in progress. Retry later."
            }
            ParseSlot::TimedOut => {
                "History is unavailable: reading the session transcript timed out. Retry later."
            }
        };
        SessionHistory {
            found: true,
            session_id,
            note: Some(note.into()),
            ..Default::default()
        }
    }
}

/// Outcome of a permit-gated, timeout-bounded parse (see [`bounded_parse`]).
enum ParseSlot<T> {
    /// The parse completed within the timeout; carries its result.
    Ready(T),
    /// No parse slot was free — work was NOT started (caller should degrade now).
    Busy,
    /// A slot was taken and the parse started, but the caller's wait elapsed. The
    /// detached worker keeps its permit until the (uncancelable) work finishes, so
    /// the slot count keeps bounding real blocking concurrency.
    TimedOut,
}

/// Run `parse` under a real concurrency bound: acquire one of `parse_limit`'s
/// permits with a NON-blocking `try_acquire` (so a flood returns [`ParseSlot::Busy`]
/// instead of queueing), spawn the work into a detached task that holds the permit
/// until `parse` actually returns, and wait for it for at most `timeout`.
///
/// The permit lives with the spawned task — NOT with the caller's `timeout` future
/// — so when the caller gives up ([`ParseSlot::TimedOut`]) the permit stays held
/// until the underlying (uncancelable `spawn_blocking`) parse completes. That is
/// what makes `MAX_CONCURRENT_PARSES` bound the number of in-flight blocking parses
/// even under repeated timeouts, rather than just the number of waiting callers.
async fn bounded_parse<Fut, T>(
    parse_limit: Arc<tokio::sync::Semaphore>,
    timeout: Duration,
    parse: Fut,
) -> ParseSlot<T>
where
    Fut: std::future::Future<Output = T> + Send + 'static,
    T: Send + 'static,
{
    // try_acquire (not acquire): don't queue behind busy parses — fail fast so the
    // caller can return metadata-only immediately instead of piling up tasks.
    let Ok(permit) = parse_limit.try_acquire_owned() else {
        return ParseSlot::Busy;
    };
    let handle = tokio::spawn(async move {
        // Hold the permit for the WHOLE parse; released only when `parse` returns.
        let _permit = permit;
        parse.await
    });
    match tokio::time::timeout(timeout, handle).await {
        Ok(Ok(value)) => ParseSlot::Ready(value),
        // Task panicked — treat as a failed parse (no value).
        Ok(Err(_join)) => ParseSlot::TimedOut,
        // Caller's wait elapsed; the detached task keeps running with its permit.
        Err(_) => ParseSlot::TimedOut,
    }
}

/// Snake_case wire form of an [`AgentType`] (e.g. `claude_code`) — matches the
/// `conversation.agent_type` column and the frontend's `ALL_AGENT_TYPES`.
fn agent_type_str(at: AgentType) -> String {
    serde_json::to_value(at)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Compact the most recent `max` turns into [`SessionMessages`]. Walks the turns
/// newest-first so the freshest context is kept under [`OVERALL_CHARS`], always
/// retaining at least the newest turn, then restores chronological order.
fn compact_turns(turns: &[MessageTurn], max: u32) -> SessionMessages {
    let total = turns.len();
    let max = max as usize;
    let mut items: Vec<SessionMessageItem> = Vec::new();
    let mut budget = OVERALL_CHARS;

    for turn in turns.iter().rev() {
        if items.len() >= max {
            break;
        }
        let item = compact_turn(turn);
        // Charge BOTH the text and the (bounded) tool names against the budget so
        // a turn can't smuggle an oversized payload through `tools`.
        let cost =
            item.text.chars().count() + item.tools.iter().map(|t| t.chars().count()).sum::<usize>();
        // Always keep the newest turn; stop once the budget can't fit the next.
        if !items.is_empty() && cost > budget {
            break;
        }
        budget = budget.saturating_sub(cost);
        items.push(item);
    }
    items.reverse();

    let included = items.len();
    SessionMessages {
        total: total as u32,
        included: included as u32,
        truncated: included < total,
        items,
    }
}

/// One turn → role + truncated text (Text/Thinking blocks, and a failed
/// turn's account of the failure) + tool names.
fn compact_turn(turn: &MessageTurn) -> SessionMessageItem {
    let role = compact_turn_role(&turn.role).to_string();

    let mut parts: Vec<&str> = Vec::new();
    let mut tools: Vec<String> = Vec::new();
    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text }
            | ContentBlock::Thinking { text }
            | ContentBlock::TurnError { message: text } => {
                let t = text.trim();
                if !t.is_empty() {
                    parts.push(t);
                }
            }
            // Bound the count per turn and each name's length; dedup on the
            // truncated form so the collected `tools` can't exceed
            // MAX_TOOLS_PER_TURN * MAX_TOOL_NAME_CHARS. Once the cap is hit the
            // guard fails and further ToolUse blocks fall through to `_`.
            ContentBlock::ToolUse { tool_name, .. }
                if tools.len() < MAX_TOOLS_PER_TURN && !tool_name.is_empty() =>
            {
                let name = truncate_chars(tool_name, MAX_TOOL_NAME_CHARS);
                if !tools.contains(&name) {
                    tools.push(name);
                }
            }
            // Tool results, images, and image-generation carry no useful plain
            // text for a compact preview — skipped to keep the payload lean.
            _ => {}
        }
    }
    let text = truncate_chars(&parts.join("\n"), PER_TURN_CHARS);
    SessionMessageItem { role, text, tools }
}

/// Truncate to at most `cap` characters, appending an ellipsis marker when cut.
fn truncate_chars(s: &str, cap: usize) -> String {
    if s.chars().count() <= cap {
        return s.to_string();
    }
    let mut out: String = s.chars().take(cap).collect();
    out.push('…');
    out
}

/// Read-only projection. Searches untruncated content, then selects newest
/// matches before the exclusive cursor; restores transcript order on output.
fn history_page(
    session_id: i32,
    turns: &[MessageTurn],
    options: &SessionHistoryOptions,
) -> SessionHistory {
    let mut out = SessionHistory {
        found: true,
        session_id,
        ..Default::default()
    };
    let end = match options.before.as_deref() {
        None => turns.len(),
        Some(id) => match turns.iter().position(|t| t.id == id) {
            Some(index) => index,
            None => {
                out.note = Some("The before turn ID is absent from this transcript. It may have been rewritten or compacted; omit before to restart.".into());
                return out;
            }
        },
    };
    let budget = options.max_chars.min(MAX_HISTORY_CHARS) as usize;
    let limit = options.limit.clamp(1, MAX_SESSION_MESSAGES) as usize;
    let query = options
        .query
        .as_deref()
        .map(str::to_lowercase)
        .filter(|s| !s.is_empty());
    let size = |value: &SessionHistory| {
        serde_json::to_string(value)
            .map(|s| s.chars().count())
            .unwrap_or(usize::MAX)
    };
    // Reserve the longer boolean spellings throughout budget calculation.
    if size(&out) > budget {
        out.has_more = turns[..end]
            .iter()
            .any(|turn| history_matches(turn, query.as_deref(), options.include_tools));
        out.truncated = true;
        out.note = Some("max_chars is smaller than the response metadata; no turns returned. Metadata is not omitted.".into());
        return out;
    }
    for turn in turns[..end].iter().rev() {
        if !history_matches(turn, query.as_deref(), options.include_tools) {
            continue;
        }
        if out.items.len() >= limit {
            out.has_more = true;
            out.truncated = true;
            break;
        }
        let (item, clipped) = history_item(turn, options.include_tools, budget);
        let previous_oldest = out.oldest_id.clone();
        out.oldest_id = Some(item.id.clone());
        out.items.push(item);
        if size(&out) > budget {
            if out.items.len() > 1 {
                out.items.pop();
                out.oldest_id = previous_oldest;
                out.has_more = true;
                out.truncated = true;
                break;
            }
            // Fit even a single long turn. Remove optional previews first, then
            // binary-search a Unicode-safe text prefix against serialized size
            // (JSON escaping consumes budget too).
            out.truncated = true;
            out.items[0].tools.clear();
            let text: Vec<char> = out.items[0].text.chars().collect();
            let (mut lo, mut hi) = (0, text.len());
            while lo < hi {
                let mid = lo + (hi - lo).div_ceil(2);
                out.items[0].text = text[..mid].iter().collect();
                if size(&out) <= budget {
                    lo = mid;
                } else {
                    hi = mid - 1;
                }
            }
            out.items[0].text = text[..lo].iter().collect();
            if size(&out) > budget {
                out.items.clear();
                out.oldest_id = None;
                out.has_more = true;
                out.note = Some(
                    "max_chars cannot fit this turn's ID and metadata; increase it to continue."
                        .into(),
                );
                break;
            }
        }
        out.truncated |= clipped;
    }
    out.items.reverse();
    out
}

fn history_matches(turn: &MessageTurn, query: Option<&str>, include_tools: bool) -> bool {
    let Some(query) = query else {
        return true;
    };
    let contains = |s: &str| s.to_lowercase().contains(query);
    turn.blocks.iter().any(|block| match block {
        ContentBlock::Text { text }
        | ContentBlock::Thinking { text }
        | ContentBlock::TurnError { message: text } => contains(text),
        ContentBlock::ToolUse {
            tool_name,
            input_preview,
            ..
        } if include_tools => contains(tool_name) || input_preview.as_deref().is_some_and(contains),
        ContentBlock::ToolResult { output_preview, .. } if include_tools => {
            output_preview.as_deref().is_some_and(contains)
        }
        _ => false,
    })
}

fn history_item(
    turn: &MessageTurn,
    include_tools: bool,
    budget: usize,
) -> (SessionHistoryItem, bool) {
    let mut item = SessionHistoryItem {
        id: turn.id.clone(),
        role: compact_turn_role(&turn.role).into(),
        text: String::new(),
        tools: Vec::new(),
    };
    let mut remaining = budget;
    let mut clipped = false;
    for block in &turn.blocks {
        match block {
            ContentBlock::Text { text }
            | ContentBlock::Thinking { text }
            | ContentBlock::TurnError { message: text } => {
                if !item.text.is_empty() && remaining > 0 {
                    item.text.push('\n');
                    remaining -= 1;
                }
                let part: String = text.chars().take(remaining).collect();
                let count = part.chars().count();
                clipped |= text.chars().count() > count;
                remaining -= count;
                item.text.push_str(&part);
            }
            ContentBlock::ToolUse {
                tool_name,
                input_preview,
                ..
            } if include_tools => {
                if remaining < 80 {
                    clipped = true;
                    continue;
                }
                remaining -= 80;
                let name: String = tool_name.chars().take(remaining).collect();
                remaining -= name.chars().count();
                let input = input_preview
                    .as_ref()
                    .map(|s| s.chars().take(remaining).collect::<String>());
                remaining -= input.as_ref().map_or(0, |s| s.chars().count());
                clipped |= name != *tool_name || input != *input_preview;
                if !name.is_empty() {
                    item.tools.push(SessionHistoryTool {
                        name: Some(name),
                        input,
                        output: None,
                        is_error: None,
                    });
                } else {
                    clipped = true;
                }
            }
            ContentBlock::ToolResult {
                output_preview,
                is_error,
                ..
            } if include_tools => {
                if remaining < 80 {
                    clipped = true;
                    continue;
                }
                remaining -= 80;
                let output = output_preview
                    .as_ref()
                    .map(|s| s.chars().take(remaining).collect::<String>());
                remaining -= output.as_ref().map_or(0, |s| s.chars().count());
                clipped |= output != *output_preview;
                item.tools.push(SessionHistoryTool {
                    name: None,
                    input: None,
                    output,
                    is_error: Some(*is_error),
                });
            }
            _ => {}
        }
    }
    (item, clipped)
}

fn compact_turn_role(role: &TurnRole) -> &'static str {
    match role {
        TurnRole::User => "user",
        TurnRole::Assistant => "assistant",
        TurnRole::System => "system",
    }
}

// ===========================================================================
// Settings persistence — `session_info.enabled` (default ON). Mirrors
// `crate::commands::question`.
// ===========================================================================

pub const KEY_SESSION_INFO_ENABLED: &str = "session_info.enabled";

/// On by default (`enabled: true`). The `get_session_info` tool is read-only and
/// only fires when the user references a session, so — like `ask_user_question` —
/// it ships enabled; a user who never wants agents reading session data can turn
/// it off in settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionInfoSettings {
    pub enabled: bool,
}

impl Default for SessionInfoSettings {
    fn default() -> Self {
        Self { enabled: true }
    }
}

impl SessionInfoSettings {
    fn into_runtime_config(self) -> SessionInfoConfig {
        SessionInfoConfig {
            enabled: self.enabled,
        }
    }
}

/// Read the persisted key from `app_metadata`, falling back to the default
/// (enabled) for a missing or malformed value. Never errors hard.
pub async fn load_session_info_settings(conn: &DatabaseConnection) -> SessionInfoSettings {
    let mut settings = SessionInfoSettings::default();
    if let Ok(Some(raw)) = app_metadata_service::get_value(conn, KEY_SESSION_INFO_ENABLED).await {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    settings
}

/// Pull settings from the DB and push the resulting `SessionInfoConfig` onto the
/// shared runtime handle. Idempotent — safe on startup or after any save.
pub async fn apply_persisted_session_info_config(
    conn: &DatabaseConnection,
    config: &SessionInfoRuntimeConfig,
) {
    let settings = load_session_info_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

/// Persist + apply + broadcast. Shared by the Tauri command and the HTTP handler
/// so the write + re-apply + notify chain lives in one place.
pub async fn set_session_info_settings_core(
    conn: &DatabaseConnection,
    config: &SessionInfoRuntimeConfig,
    emitter: &EventEmitter,
    desired: SessionInfoSettings,
) -> Result<SessionInfoSettings, AppCommandError> {
    app_metadata_service::upsert_value(
        conn,
        KEY_SESSION_INFO_ENABLED,
        &desired.enabled.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, SESSION_INFO_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_session_info_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<SessionInfoSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_session_info_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_session_info_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, SessionInfoRuntimeConfig>,
    settings: SessionInfoSettings,
) -> Result<SessionInfoSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::from_app(&app);
        set_session_info_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::message::ContentBlock;
    use chrono::Utc;

    fn turn(role: TurnRole, blocks: Vec<ContentBlock>) -> MessageTurn {
        MessageTurn {
            id: "t".into(),
            role,
            blocks,
            timestamp: Utc::now(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    #[test]
    fn compact_turn_joins_text_and_collects_tools() {
        let item = compact_turn(&turn(
            TurnRole::Assistant,
            vec![
                ContentBlock::Text {
                    text: "hello".into(),
                },
                ContentBlock::ToolUse {
                    tool_use_id: None,
                    tool_name: "Read".into(),
                    input_preview: None,
                    status: None,
                    meta: None,
                },
                ContentBlock::ToolUse {
                    tool_use_id: None,
                    tool_name: "Read".into(),
                    input_preview: None,
                    status: None,
                    meta: None,
                },
                ContentBlock::Thinking { text: "hmm".into() },
            ],
        ));
        assert_eq!(item.role, "assistant");
        assert_eq!(item.text, "hello\nhmm");
        assert_eq!(item.tools, vec!["Read".to_string()]); // deduped
    }

    /// A failed turn reads as its system line, so an agent looking at the
    /// session sees that the turn failed, and why.
    #[test]
    fn compact_turn_keeps_a_failed_turn_s_account() {
        let item = compact_turn(&turn(
            TurnRole::System,
            vec![ContentBlock::TurnError {
                message: "API Error: 503".into(),
            }],
        ));
        assert_eq!(item.role, "system");
        assert_eq!(item.text, "API Error: 503");
    }

    #[test]
    fn compact_turns_keeps_most_recent_within_max() {
        let turns: Vec<MessageTurn> = (0..5)
            .map(|i| {
                turn(
                    TurnRole::User,
                    vec![ContentBlock::Text {
                        text: format!("msg{i}"),
                    }],
                )
            })
            .collect();
        let out = compact_turns(&turns, 2);
        assert_eq!(out.total, 5);
        assert_eq!(out.included, 2);
        assert!(out.truncated);
        // Chronological order preserved, newest two kept.
        assert_eq!(out.items[0].text, "msg3");
        assert_eq!(out.items[1].text, "msg4");
    }

    #[test]
    fn compact_turn_bounds_tool_names() {
        // A turn with thousands of distinct, long tool names must collapse to at
        // most MAX_TOOLS_PER_TURN names, each ≤ MAX_TOOL_NAME_CHARS.
        let blocks: Vec<ContentBlock> = (0..5000)
            .map(|i| ContentBlock::ToolUse {
                tool_use_id: None,
                tool_name: format!("{}_{i}", "x".repeat(500)),
                input_preview: None,
                status: None,
                meta: None,
            })
            .collect();
        let item = compact_turn(&turn(TurnRole::Assistant, blocks));
        assert!(item.tools.len() <= MAX_TOOLS_PER_TURN);
        for name in &item.tools {
            assert!(name.chars().count() <= MAX_TOOL_NAME_CHARS + 1); // +1 for the ellipsis
        }
    }

    #[test]
    fn compact_turns_charges_tools_against_budget() {
        // Many turns, each carrying the max tool payload, must still be bounded:
        // the budget accounts for tool-name chars, so `included` stays small and
        // `truncated` is set rather than returning every turn.
        let one_turn = || {
            let blocks: Vec<ContentBlock> = (0..MAX_TOOLS_PER_TURN)
                .map(|i| ContentBlock::ToolUse {
                    tool_use_id: None,
                    tool_name: format!("{}_{i}", "t".repeat(MAX_TOOL_NAME_CHARS)),
                    input_preview: None,
                    status: None,
                    meta: None,
                })
                .collect();
            turn(TurnRole::Assistant, blocks)
        };
        let turns: Vec<MessageTurn> = (0..500).map(|_| one_turn()).collect();
        let out = compact_turns(&turns, 500);
        // Total payload chars (text + tools) stays within ~one turn of the budget.
        let total_chars: usize = out
            .items
            .iter()
            .map(|i| {
                i.text.chars().count() + i.tools.iter().map(|t| t.chars().count()).sum::<usize>()
            })
            .sum();
        assert!(total_chars <= OVERALL_CHARS + PER_TURN_CHARS);
        assert!(out.truncated);
        assert!((out.included as usize) < out.total as usize);
    }

    #[test]
    fn compact_turns_not_truncated_when_all_fit() {
        let turns = vec![turn(
            TurnRole::User,
            vec![ContentBlock::Text {
                text: "only".into(),
            }],
        )];
        let out = compact_turns(&turns, 20);
        assert_eq!(out.total, 1);
        assert_eq!(out.included, 1);
        assert!(!out.truncated);
    }

    #[test]
    fn history_pages_with_original_ids_and_exclusive_cursor() {
        let mut turns: Vec<_> = ["z", "a", "m", "b"]
            .into_iter()
            .map(|id| {
                let mut t = turn(TurnRole::User, vec![ContentBlock::Text { text: id.into() }]);
                t.id = id.into();
                t
            })
            .collect();
        let options = SessionHistoryOptions {
            limit: 2,
            ..Default::default()
        };
        let page = history_page(42, &turns, &options);
        assert_eq!(
            page.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["m", "b"]
        );
        assert_eq!(page.oldest_id.as_deref(), Some("m"));
        assert!(page.has_more);
        turns.push(turn(TurnRole::Assistant, vec![]));
        let older = history_page(
            42,
            &turns,
            &SessionHistoryOptions {
                before: page.oldest_id,
                ..options
            },
        );
        assert_eq!(
            older
                .items
                .iter()
                .map(|t| t.id.as_str())
                .collect::<Vec<_>>(),
            ["z", "a"]
        );
        assert!(!older.has_more);
    }

    #[test]
    fn history_search_pages_across_unmatched_turns() {
        let turns: Vec<_> = (0..5)
            .map(|i| {
                let mut t = turn(
                    TurnRole::User,
                    vec![ContentBlock::Text {
                        text: if i % 2 == 0 {
                            "match".into()
                        } else {
                            "other".into()
                        },
                    }],
                );
                t.id = format!("id-{i}");
                t
            })
            .collect();
        let options = SessionHistoryOptions {
            limit: 2,
            query: Some("match".into()),
            ..Default::default()
        };
        let page = history_page(42, &turns, &options);
        assert_eq!(
            page.items.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["id-2", "id-4"]
        );
        let page = history_page(
            42,
            &turns,
            &SessionHistoryOptions {
                before: page.oldest_id,
                ..options
            },
        );
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].id, "id-0");
        assert!(!page.has_more);
    }

    #[test]
    fn history_defaults_to_twenty_and_caps_large_limits() {
        let turns: Vec<_> = (0..250)
            .map(|i| {
                let mut t = turn(TurnRole::User, vec![]);
                t.id = format!("id-{i}");
                t
            })
            .collect();
        assert_eq!(
            history_page(42, &turns, &SessionHistoryOptions::default())
                .items
                .len(),
            20
        );
        let page = history_page(
            42,
            &turns,
            &SessionHistoryOptions {
                limit: 1000,
                ..Default::default()
            },
        );
        assert_eq!(page.items.len(), 200);
        assert_eq!(page.oldest_id.as_deref(), Some("id-50"));
        assert!(page.has_more);
    }

    #[test]
    fn history_missing_cursor_does_not_restart_at_latest() {
        let turns = vec![turn(TurnRole::User, vec![])];
        let out = history_page(
            42,
            &turns,
            &SessionHistoryOptions {
                before: Some("missing".into()),
                ..Default::default()
            },
        );
        assert!(out.items.is_empty());
        assert!(out.note.unwrap().contains("before"));
    }

    #[test]
    fn history_searches_full_text_and_opt_in_tool_previews() {
        let mut t = turn(
            TurnRole::Assistant,
            vec![
                ContentBlock::Text {
                    text: format!("{}Needle", "x".repeat(3000)),
                },
                ContentBlock::ToolUse {
                    tool_use_id: None,
                    tool_name: "Read".into(),
                    input_preview: Some("secret-path".into()),
                    status: None,
                    meta: None,
                },
            ],
        );
        t.id = "original".into();
        let options = SessionHistoryOptions {
            query: Some("NEEDLE".into()),
            ..Default::default()
        };
        let out = history_page(42, &[t.clone()], &options);
        assert_eq!(out.items.len(), 1);
        assert!(out.items[0].tools.is_empty());
        assert!(out.items[0].text.ends_with("Needle"));
        let options = SessionHistoryOptions {
            query: Some("secret-path".into()),
            ..options
        };
        assert!(history_page(42, &[t.clone()], &options).items.is_empty());
        let out = history_page(
            42,
            &[t],
            &SessionHistoryOptions {
                include_tools: true,
                ..options
            },
        );
        assert_eq!(out.items.len(), 1);
        assert_eq!(out.items[0].tools[0].input.as_deref(), Some("secret-path"));
    }

    #[test]
    fn history_bounds_entire_serialized_response_and_unicode() {
        let turns: Vec<_> = (0..10)
            .map(|i| {
                let mut t = turn(
                    TurnRole::User,
                    vec![ContentBlock::Text {
                        text: "\\\"汉字\n".repeat(3000),
                    }],
                );
                t.id = format!("turn-{i}");
                t
            })
            .collect();
        let options = SessionHistoryOptions {
            max_chars: 1024,
            limit: 200,
            ..Default::default()
        };
        let out = history_page(42, &turns, &options);
        assert!(out.truncated);
        assert_eq!(out.oldest_id.as_deref(), Some("turn-9"));
        assert!(out.has_more);
        assert!(serde_json::to_string(&out).unwrap().chars().count() <= 1024);
        assert!(!out.items[0].text.is_empty());
    }

    #[test]
    fn truncate_chars_marks_when_cut() {
        assert_eq!(truncate_chars("abc", 5), "abc");
        assert_eq!(truncate_chars("abcdef", 3), "abc…");
    }

    #[test]
    fn agent_type_str_is_snake_case() {
        assert_eq!(agent_type_str(AgentType::ClaudeCode), "claude_code");
        assert_eq!(agent_type_str(AgentType::OpenClaw), "open_claw");
    }

    #[tokio::test]
    async fn bounded_parse_returns_value_within_timeout() {
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let out = bounded_parse(sem.clone(), Duration::from_secs(5), async { 7 }).await;
        assert!(matches!(out, ParseSlot::Ready(7)));
        // The permit is released once the work completes.
        assert_eq!(sem.available_permits(), 1);
    }

    #[tokio::test]
    async fn bounded_parse_reports_busy_when_no_slot_free() {
        // A semaphore with zero permits → no slot → Busy, work never starts.
        let sem = Arc::new(tokio::sync::Semaphore::new(0));
        let out: ParseSlot<i32> = bounded_parse(sem, Duration::from_secs(5), async { 1 }).await;
        assert!(matches!(out, ParseSlot::Busy));
    }

    /// Regression for the review finding: a timed-out parse must keep occupying its
    /// slot until the underlying (uncancelable) work actually finishes — NOT be
    /// released the moment the caller gives up waiting.
    #[tokio::test]
    async fn bounded_parse_holds_permit_past_caller_timeout() {
        let sem = Arc::new(tokio::sync::Semaphore::new(1));
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        // A "parse" that blocks until we signal it, modeling a slow spawn_blocking.
        let parse = async move {
            let _ = release_rx.await;
            99
        };
        // Caller waits only briefly while the work is still blocked → TimedOut.
        let out = bounded_parse(sem.clone(), Duration::from_millis(50), parse).await;
        assert!(matches!(out, ParseSlot::TimedOut));
        // The permit is STILL held by the detached worker (work hasn't finished).
        assert_eq!(sem.available_permits(), 0);
        assert!(sem.try_acquire().is_err());

        // Now let the work complete; the worker drops the permit.
        release_tx.send(()).unwrap();
        // Await the permit returning (generous bound; no fixed sleep) to prove it
        // is released only after the underlying work finishes.
        let _permit = tokio::time::timeout(Duration::from_secs(2), sem.acquire())
            .await
            .expect("permit must be released once the parse completes")
            .unwrap();
    }

    #[tokio::test]
    async fn settings_default_on_and_round_trip() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assert!(load_session_info_settings(&db.conn).await.enabled);

        let config = SessionInfoRuntimeConfig::new();
        set_session_info_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            SessionInfoSettings { enabled: false },
        )
        .await
        .unwrap();
        assert!(!load_session_info_settings(&db.conn).await.enabled);
        assert!(!config.is_enabled().await);
    }

    #[tokio::test]
    async fn session_info_recovers_persisted_children_without_transcript() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder = crate::db::test_helpers::seed_folder(&db, "/history-test").await;
        let parent = conversation_service::create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .unwrap();
        let child = conversation_service::create_with_delegation(
            &db.conn,
            folder,
            AgentType::Codex,
            None,
            None,
            Some(crate::acp::delegation::spawner::DelegationLink {
                parent_conversation_id: parent.id,
                parent_tool_use_id: "tool-use".into(),
                delegation_call_id: "persisted-task".into(),
                assistant: None,
            }),
        )
        .await
        .unwrap();
        let lookup = DbSessionInfoLookup::new(Arc::new(AppDatabase {
            conn: db.conn.clone(),
        }));
        let info = lookup.resolve(parent.id, 0).await;
        assert!(info.found);
        assert!(info.messages.is_none());
        assert_eq!(info.children.len(), 1);
        assert_eq!(info.children[0].session_id, child.id);
        assert_eq!(info.children[0].task_id.as_deref(), Some("persisted-task"));
        assert_eq!(info.children[0].status, child.status);
        assert!(!info.children_truncated);
    }

    #[tokio::test]
    async fn history_uses_the_same_parse_semaphore_as_session_info() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let folder = crate::db::test_helpers::seed_folder(&db, "/history-busy-test").await;
        let session = conversation_service::create(&db.conn, folder, AgentType::Codex, None, None)
            .await
            .unwrap();
        let lookup = DbSessionInfoLookup::new(Arc::new(AppDatabase {
            conn: db.conn.clone(),
        }));
        let _permits = lookup
            .parse_limit
            .clone()
            .acquire_many_owned(MAX_CONCURRENT_PARSES as u32)
            .await
            .unwrap();
        let out = lookup
            .read_history(session.id, SessionHistoryOptions::default())
            .await;
        assert!(out.found);
        assert!(out.items.is_empty());
        assert!(out.note.unwrap().contains("too many session reads"));
        let info = lookup.resolve(session.id, 20).await;
        assert!(info.messages.is_none());
        assert!(info.note.unwrap().contains("too many session reads"));
    }

    #[test]
    fn history_zero_budget_is_explicit_empty_result() {
        let out = history_page(
            42,
            &[turn(TurnRole::User, vec![])],
            &SessionHistoryOptions {
                max_chars: 0,
                ..Default::default()
            },
        );
        assert!(out.items.is_empty());
        assert!(out.truncated);
        assert!(out.note.unwrap().contains("metadata"));
    }

    #[tokio::test]
    async fn resolve_unknown_id_is_not_found() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let lookup = DbSessionInfoLookup::new(Arc::new(AppDatabase {
            conn: db.conn.clone(),
        }));
        let info = lookup.resolve(999_999, 10).await;
        assert!(!info.found);
        assert_eq!(info.session_id, 999_999);
    }
}
