use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, TimeZone, Utc};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::models::*;
use crate::parsers::{folder_name_from_path, title_from_user_text, AgentParser, ParseError};

/// Parser for Devin CLI (Cognition) transcripts. **Import-only**: Devin has no
/// built-in ACP launch metadata in codeg — a live Devin agent is registered as
/// a custom ACP agent — so this parser is the whole of the integration.
///
/// Devin keeps every session in ONE live SQLite store (WAL mode), by default
/// `~/.local/share/devin/cli/sessions.db` (see [`resolve_devin_sessions_db`]):
///
/// - `sessions(id, working_directory, backend_type, model, agent_mode,
///   created_at, last_activity_at, title, main_chain_id, hidden, …)` — one row
///   per session; `id` is a word-pair slug (`bead-people`), timestamps are
///   Unix **seconds** as INTEGER, `title` may be NULL and `model` may be `''`.
/// - `message_nodes(row_id, session_id, node_id, parent_node_id, chat_message,
///   created_at, …)` — a FOREST per session. `parent_node_id IS NULL` is a
///   root. Every time Devin re-sends the system prompt (a retry, a new turn
///   after an interruption, a compaction) it starts a fresh root, so a
///   session has several roots and many leaves; `sessions.main_chain_id` is
///   the node_id of the HEAD (leaf) of the chain the user actually sees. The
///   transcript is that chain walked root-ward and reversed; every other
///   chain is an abandoned branch, a retry, or a sub-agent chain
///   (`subagent_heads`) and is ignored.
/// - `chat_message` is JSON: `{message_id, role, content, tool_calls?,
///   tool_call_id?, thinking?, metadata}` — an OpenAI-style message with a
///   Devin `metadata` envelope (`is_user_input`, `metrics`, `telemetry`,
///   `extensions`). See [`node_to_message`] for what each role contributes.
///
/// The store is written by a running Devin process and can exceed 1 GB, so
/// it is opened strictly read-only and `message_nodes` is only ever read
/// per-session along the main chain — never `SELECT *` across sessions.
pub struct DevinParser {
    db_path: PathBuf,
}

impl Default for DevinParser {
    fn default() -> Self {
        Self::new()
    }
}

/// Sessions launched by codeg itself run under codeg's per-chat cwd; they are
/// already recorded through the ACP transcript, so importing them from
/// Devin's store would duplicate them.
const CODEG_LAUNCHED_CWD_MARKER: &str = "/app.codeg/chat-sessions/";

/// The system message Devin injects on the fresh root it opens after a
/// context compaction. The compacted history lives only in this message (the
/// pre-compaction chain is abandoned), so it is the one system message that
/// is rendered rather than skipped.
const CONTINUATION_PREFIX: &str = "You are continuing work from a previous conversation thread";

/// Hard ceiling on the main-chain walk. `parent_node_id` is unconstrained in
/// the schema, so a corrupt row could form a cycle and a recursive CTE would
/// otherwise never terminate.
const MAX_CHAIN_DEPTH: u32 = 100_000;

impl DevinParser {
    pub fn new() -> Self {
        Self {
            db_path: resolve_devin_sessions_db(),
        }
    }

    /// Test-only constructor pointing the parser at a fixture `sessions.db`.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_db_path(db_path: PathBuf) -> Self {
        Self { db_path }
    }

    fn open(&self) -> Option<Connection> {
        open_store(&self.db_path)
    }
}

impl AgentParser for DevinParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        if !self.db_path.is_file() {
            return Ok(Vec::new());
        }
        let Some(conn) = self.open() else {
            return Ok(Vec::new());
        };
        let rows = load_session_rows(&conn, None)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            if row.is_codeg_launched() {
                continue;
            }
            let summary = row.into_summary(&conn)?;
            if summary.message_count == 0 {
                continue;
            }
            out.push(summary);
        }
        Ok(out)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let not_found = || ParseError::ConversationNotFound(conversation_id.to_string());
        if !self.db_path.is_file() {
            return Err(not_found());
        }
        let conn = self.open().ok_or_else(not_found)?;
        // Unlike the listing this does NOT filter `hidden` or the codeg cwd: a
        // persisted tab may still reference such a session and must resolve.
        let row = load_session_rows(&conn, Some(conversation_id))?
            .pop()
            .ok_or_else(not_found)?;
        let head = row.main_chain_id;
        let mut summary = row.into_summary(&conn)?;

        let nodes = match head {
            Some(head) => load_main_chain(&conn, conversation_id, head)?,
            None => Vec::new(),
        };
        let mut session_model = summary.model.clone();
        let mut messages = Vec::with_capacity(nodes.len());
        for node in &nodes {
            let Ok(value) = serde_json::from_str::<Value>(&node.chat_message) else {
                continue;
            };
            if let Some(msg) = node_to_message(node, &value, &mut session_model) {
                messages.push(msg);
            }
        }
        if summary.model.is_none() {
            summary.model = session_model;
        }

        let mut turns = group_into_turns(messages);
        super::relocate_orphaned_tool_results(&mut turns);
        super::structurize_read_tool_output(&mut turns);
        super::resolve_patch_line_numbers(&mut turns, summary.folder_path.as_deref());
        super::backfill_turn_durations(&mut turns, &[]);

        // `metrics.input_tokens` on an assistant node is the whole prompt that
        // produced it (cache reads are reported separately), so the latest
        // turn's prompt side is the current context occupancy.
        let base = super::compute_session_stats(&turns);
        let used = super::latest_turn_prompt_usage_tokens(&turns);
        let max = super::infer_context_window_max_tokens(summary.model.as_deref());
        let session_stats = super::merge_context_window_stats(base, used, max);

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }
}

/// Where Devin CLI keeps its session store.
///
/// `DEVIN_SESSIONS_DB` (a file path) overrides everything — it exists so
/// tests and unusual installs can point codeg at a copy. Otherwise the store
/// is `$XDG_DATA_HOME/devin/cli/sessions.db`, with `XDG_DATA_HOME` defaulting
/// to `~/.local/share` per the XDG base-directory spec. Values are taken
/// verbatim (no `~` expansion), the same way the spec requires them to be
/// absolute.
pub(crate) fn resolve_devin_sessions_db() -> PathBuf {
    resolve_devin_sessions_db_from(
        std::env::var("DEVIN_SESSIONS_DB").ok(),
        std::env::var("XDG_DATA_HOME").ok(),
        dirs::home_dir(),
    )
}

fn resolve_devin_sessions_db_from(
    override_db: Option<String>,
    xdg_data_home: Option<String>,
    home: Option<PathBuf>,
) -> PathBuf {
    let non_empty = |v: Option<String>| {
        v.and_then(|raw| {
            let trimmed = raw.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
    };
    if let Some(path) = non_empty(override_db) {
        return PathBuf::from(path);
    }
    let data_home = match non_empty(xdg_data_home) {
        Some(dir) => PathBuf::from(dir),
        None => home
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".local")
            .join("share"),
    };
    data_home.join("devin").join("cli").join("sessions.db")
}

/// Open the store read-only, the way `parsers::cursor` opens Cursor's.
///
/// No read-write fallback here, deliberately: the file is a live WAL store
/// owned by a running Devin process and codeg must never write to it — not
/// even the wal-index recovery a read-write open would run after a Devin
/// crash. In that rare state listing simply yields nothing until Devin's own
/// next open repairs it.
fn open_store(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    // Devin may hold a write transaction while codeg lists sessions; give
    // reads a short grace period instead of failing on a transient lock.
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));
    // Opening is lazy — probe so a handle that cannot actually read (stale
    // WAL index, foreign schema) reports failure here instead of no rows.
    conn.query_row("SELECT count(*) FROM sessions", [], |row| {
        row.get::<_, i64>(0)
    })
    .ok()?;
    Some(conn)
}

fn db_err(e: rusqlite::Error) -> ParseError {
    ParseError::InvalidData(format!("devin sessions.db: {e}"))
}

struct SessionRow {
    id: String,
    working_directory: Option<String>,
    model: Option<String>,
    created_at: i64,
    last_activity_at: i64,
    title: Option<String>,
    main_chain_id: Option<i64>,
}

impl SessionRow {
    fn is_codeg_launched(&self) -> bool {
        self.working_directory
            .as_deref()
            .is_some_and(|cwd| cwd.contains(CODEG_LAUNCHED_CWD_MARKER))
    }

    fn into_summary(self, conn: &Connection) -> Result<ConversationSummary, ParseError> {
        let head = self.main_chain_id;
        let message_count = match head {
            Some(head) => count_main_chain_messages(conn, &self.id, head)?,
            None => 0,
        };
        // NULL title → the first real user prompt, capped like every other
        // parser's derived title.
        let title = match (self.title, head) {
            (Some(title), _) => Some(title),
            (None, Some(head)) => first_user_prompt(conn, &self.id, head)?
                .as_deref()
                .map(title_from_user_text),
            (None, None) => None,
        };
        // `sessions.model` is `''` on some sessions; the model is then only
        // stated by the `You are powered by <model>.` system message.
        let model = match (self.model, head) {
            (Some(model), _) => Some(model),
            (None, Some(head)) => powered_by_model(conn, &self.id, head)?,
            (None, None) => None,
        };
        let folder_name = self.working_directory.as_deref().map(folder_name_from_path);
        Ok(ConversationSummary {
            id: self.id,
            agent_type: AgentType::Devin,
            folder_path: self.working_directory,
            folder_name,
            title,
            started_at: secs_to_datetime(self.created_at),
            ended_at: Some(secs_to_datetime(self.last_activity_at)),
            message_count,
            model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }
}

/// Session rows, newest activity first. `only_id` fetches a single row
/// WITHOUT the `hidden` filter (see `get_conversation`); the listing skips
/// `hidden = 1` (Devin's own summarizer / helper sessions).
fn load_session_rows(
    conn: &Connection,
    only_id: Option<&str>,
) -> Result<Vec<SessionRow>, ParseError> {
    const COLUMNS: &str =
        "id, working_directory, model, created_at, last_activity_at, title, main_chain_id";
    let map = |row: &rusqlite::Row<'_>| -> rusqlite::Result<SessionRow> {
        Ok(SessionRow {
            id: row.get(0)?,
            working_directory: normalize_optional_string(row.get(1)?),
            model: normalize_optional_string(row.get(2)?),
            created_at: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
            last_activity_at: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            title: normalize_optional_string(row.get(5)?),
            main_chain_id: row.get(6)?,
        })
    };
    let rows = match only_id {
        Some(id) => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM sessions WHERE id = ?1 LIMIT 1"
                ))
                .map_err(db_err)?;
            let rows = stmt.query_map([id], map).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        }
        None => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT {COLUMNS} FROM sessions WHERE COALESCE(hidden, 0) = 0 \
                     ORDER BY last_activity_at DESC, created_at DESC"
                ))
                .map_err(db_err)?;
            let rows = stmt.query_map([], map).map_err(db_err)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)?
        }
    };
    Ok(rows)
}

/// The recursive walk from `main_chain_id` to its root, as a CTE prefix. Bound
/// parameters: `?1` = session id, `?2` = head node id. Yields `(node_id,
/// depth)` with depth 0 at the head, so `ORDER BY depth DESC` is root → head.
/// Only `node_id`/`parent_node_id` are touched in the recursion — those are
/// read off the row header without loading the (possibly huge) `chat_message`
/// blob, which is what keeps this affordable across every session at once.
const MAIN_CHAIN_CTE: &str = "WITH RECURSIVE chain(node_id, parent_node_id, depth) AS ( \
        SELECT node_id, parent_node_id, 0 FROM message_nodes \
         WHERE session_id = ?1 AND node_id = ?2 \
        UNION ALL \
        SELECT m.node_id, m.parent_node_id, c.depth + 1 FROM message_nodes m \
          JOIN chain c ON m.session_id = ?1 AND m.node_id = c.parent_node_id \
         WHERE c.depth < ?3 \
    ) ";

/// Non-system messages on the main chain — the count the sidebar shows, in
/// line with the Hermes parser (user + assistant + tool rows, no scaffolding).
fn count_main_chain_messages(
    conn: &Connection,
    session_id: &str,
    head: i64,
) -> Result<u32, ParseError> {
    let sql = format!(
        "{MAIN_CHAIN_CTE} SELECT COUNT(*) FROM chain c \
           JOIN message_nodes m ON m.session_id = ?1 AND m.node_id = c.node_id \
          WHERE COALESCE(json_extract(m.chat_message, '$.role'), '') <> 'system'"
    );
    let n: i64 = conn
        .query_row(
            &sql,
            rusqlite::params![session_id, head, MAX_CHAIN_DEPTH],
            |row| row.get(0),
        )
        .map_err(db_err)?;
    Ok(u32::try_from(n.max(0)).unwrap_or(u32::MAX))
}

/// The first `is_user_input` user prompt on the main chain, for a NULL title.
fn first_user_prompt(
    conn: &Connection,
    session_id: &str,
    head: i64,
) -> Result<Option<String>, ParseError> {
    let sql = format!(
        "{MAIN_CHAIN_CTE} SELECT json_extract(m.chat_message, '$.content') FROM chain c \
           JOIN message_nodes m ON m.session_id = ?1 AND m.node_id = c.node_id \
          WHERE json_extract(m.chat_message, '$.role') = 'user' \
            AND json_extract(m.chat_message, '$.metadata.is_user_input') = 1 \
          ORDER BY c.depth DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mut rows = stmt
        .query(rusqlite::params![session_id, head, MAX_CHAIN_DEPTH])
        .map_err(db_err)?;
    let Some(row) = rows.next().map_err(db_err)? else {
        return Ok(None);
    };
    let content: Option<String> = row.get(0).map_err(db_err)?;
    Ok(normalize_optional_string(content))
}

/// The model named by a `You are powered by <model>.` system message on the
/// main chain, for a session whose `model` column is empty.
fn powered_by_model(
    conn: &Connection,
    session_id: &str,
    head: i64,
) -> Result<Option<String>, ParseError> {
    let sql = format!(
        "{MAIN_CHAIN_CTE} SELECT json_extract(m.chat_message, '$.content') FROM chain c \
           JOIN message_nodes m ON m.session_id = ?1 AND m.node_id = c.node_id \
          WHERE json_extract(m.chat_message, '$.role') = 'system' \
            AND json_extract(m.chat_message, '$.content') LIKE 'You are powered by %' \
          ORDER BY c.depth DESC LIMIT 1"
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let mut rows = stmt
        .query(rusqlite::params![session_id, head, MAX_CHAIN_DEPTH])
        .map_err(db_err)?;
    let Some(row) = rows.next().map_err(db_err)? else {
        return Ok(None);
    };
    let content: Option<String> = row.get(0).map_err(db_err)?;
    Ok(content.as_deref().and_then(parse_powered_by))
}

fn powered_by_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^\s*You are powered by (.+?)\.\s*$").unwrap())
}

fn parse_powered_by(text: &str) -> Option<String> {
    powered_by_regex()
        .captures(text)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim().to_string())
        .filter(|s| !s.is_empty())
}

struct ChainNode {
    node_id: i64,
    created_at: i64,
    chat_message: String,
}

/// The main chain's nodes, root first.
fn load_main_chain(
    conn: &Connection,
    session_id: &str,
    head: i64,
) -> Result<Vec<ChainNode>, ParseError> {
    let sql = format!(
        "{MAIN_CHAIN_CTE} SELECT m.node_id, m.created_at, m.chat_message FROM chain c \
           JOIN message_nodes m ON m.session_id = ?1 AND m.node_id = c.node_id \
          ORDER BY c.depth DESC"
    );
    let mut stmt = conn.prepare(&sql).map_err(db_err)?;
    let rows = stmt
        .query_map(
            rusqlite::params![session_id, head, MAX_CHAIN_DEPTH],
            |row| {
                Ok(ChainNode {
                    node_id: row.get(0)?,
                    created_at: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                    chat_message: row.get(2)?,
                })
            },
        )
        .map_err(db_err)?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_err)
}

/// One `chat_message` → at most one message.
///
/// - `system`: prompt scaffolding (`sysprompt` / `rules` / `<system_info>` /
///   `<available_skills>`), skipped — except the post-compaction continuation
///   (see [`CONTINUATION_PREFIX`]), which becomes the shared
///   `context_compaction` divider followed by the summary text, and the
///   `You are powered by …` line, which only supplies `session_model` when
///   the session row left it empty.
/// - `user`: only `metadata.is_user_input == true` rows are real prompts.
///   The rest are Devin's own injections — `telemetry.source =
///   "cache_keepalive"` rows whose content is the literal `continue`, and the
///   `Conversation to summarize:` / `Now summarize …` pair it feeds its
///   summarizer — and are dropped rather than shown as user turns.
/// - `assistant`: `thinking.thinking` → Thinking, `content` → Text,
///   `tool_calls[*]` → ToolUse. Token metrics ride on `metadata.metrics`.
/// - `tool`: one ToolResult keyed by `tool_call_id`; `extensions.
///   "chisel/tool_result_meta".success == false` marks it an error.
fn node_to_message(
    node: &ChainNode,
    value: &Value,
    session_model: &mut Option<String>,
) -> Option<UnifiedMessage> {
    let role = value.get("role").and_then(Value::as_str).unwrap_or("");
    let content = value.get("content").and_then(Value::as_str).unwrap_or("");
    let metadata = value.get("metadata");
    let meta_created = metadata
        .and_then(|m| m.get("created_at"))
        .and_then(Value::as_str)
        .and_then(parse_rfc3339);
    let row_time = secs_to_datetime(node.created_at);
    let timestamp = meta_created.unwrap_or(row_time);
    let id = value
        .get("message_id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("node-{}", node.node_id));

    match role {
        "system" => {
            if session_model.is_none() {
                if let Some(model) = parse_powered_by(content) {
                    *session_model = Some(model);
                }
            }
            let trimmed = content.trim_start();
            if !trimmed.starts_with(CONTINUATION_PREFIX) {
                return None;
            }
            Some(UnifiedMessage {
                id: id.clone(),
                role: MessageRole::Assistant,
                content: compaction_blocks(id, trimmed),
                timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: Some(timestamp),
                agent_message_id: None,
            })
        }
        "user" => {
            let is_user_input = metadata
                .and_then(|m| m.get("is_user_input"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let text = content.trim();
            if !is_user_input || text.is_empty() {
                return None;
            }
            Some(UnifiedMessage {
                id,
                role: MessageRole::User,
                content: vec![ContentBlock::Text {
                    text: text.to_string(),
                }],
                timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: Some(timestamp),
                agent_message_id: None,
            })
        }
        "assistant" => {
            let mut blocks = Vec::new();
            if let Some(thinking) = value
                .get("thinking")
                .and_then(|t| t.get("thinking"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                blocks.push(ContentBlock::Thinking {
                    text: thinking.to_string(),
                });
            }
            let text = content.trim();
            if !text.is_empty() {
                blocks.push(ContentBlock::Text {
                    text: text.to_string(),
                });
            }
            if let Some(calls) = value.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let tool_use_id = call.get("id").and_then(Value::as_str).map(str::to_string);
                    let tool_name = call
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string();
                    let input_preview = call.get("arguments").and_then(normalize_tool_arguments);
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id,
                        tool_name,
                        input_preview,
                        status: None,
                        meta: None,
                    });
                }
            }
            if blocks.is_empty() {
                return None;
            }

            let metrics = metadata.and_then(|m| m.get("metrics"));
            let count = |key: &str| {
                metrics
                    .and_then(|m| m.get(key))
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
            };
            let usage = TurnUsage {
                input_tokens: count("input_tokens"),
                output_tokens: count("output_tokens"),
                cache_creation_input_tokens: count("cache_creation_tokens"),
                cache_read_input_tokens: count("cache_read_tokens"),
            };
            let usage = (usage != TurnUsage::default()).then_some(usage);
            // `started_generation_at` → `created_at` is the wall-clock span of
            // the inference; `total_time_ms` is the same span as Devin measured
            // it and wins when present.
            let started = metadata
                .and_then(|m| m.get("started_generation_at"))
                .and_then(Value::as_str)
                .and_then(parse_rfc3339);
            let duration_ms = metrics
                .and_then(|m| m.get("total_time_ms"))
                .and_then(Value::as_u64)
                .filter(|ms| *ms > 0)
                .or_else(|| {
                    let ms = (meta_created? - started?).num_milliseconds();
                    (ms > 0).then_some(ms as u64)
                });
            let model = metadata
                .and_then(|m| m.get("generation_model"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .or_else(|| session_model.clone());

            Some(UnifiedMessage {
                id,
                role: MessageRole::Assistant,
                content: blocks,
                timestamp: started.unwrap_or(timestamp),
                usage,
                duration_ms,
                model,
                completed_at: Some(timestamp),
                agent_message_id: None,
            })
        }
        "tool" => {
            let tool_use_id = value
                .get("tool_call_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let is_error = metadata
                .and_then(|m| m.get("extensions"))
                .and_then(|e| e.get("chisel/tool_result_meta"))
                .and_then(|r| r.get("success"))
                .and_then(Value::as_bool)
                .is_some_and(|ok| !ok);
            let text = content.trim();
            Some(UnifiedMessage {
                id,
                role: MessageRole::Tool,
                content: vec![ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview: (!text.is_empty()).then(|| text.to_string()),
                    is_error,
                    agent_stats: None,
                    images: Vec::new(),
                }],
                timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: Some(timestamp),
                agent_message_id: None,
            })
        }
        _ => None,
    }
}

/// The compaction divider every agent's compaction renders through (the
/// `context_compaction` ToolUse/ToolResult pair `<ContextCompactionCard>`
/// matches on `meta.contextCompaction` — see `parsers::claude`), followed by
/// the summary Devin carried across as text. Devin records no token counts
/// for the compaction, so the marker carries only the trigger.
fn compaction_blocks(tool_use_id: String, continuation: &str) -> Vec<ContentBlock> {
    let mut marker = serde_json::Map::new();
    marker.insert("version".to_string(), Value::from(1));
    marker.insert("trigger".to_string(), Value::from("automatic"));
    let mut blocks = vec![
        ContentBlock::ToolUse {
            tool_use_id: Some(tool_use_id.clone()),
            tool_name: "context_compaction".to_string(),
            input_preview: None,
            status: None,
            meta: Some(Value::Object(
                [("contextCompaction".to_string(), Value::Object(marker))]
                    .into_iter()
                    .collect(),
            )),
        },
        ContentBlock::ToolResult {
            tool_use_id: Some(tool_use_id),
            output_preview: None,
            is_error: false,
            agent_stats: None,
            images: Vec::new(),
        },
    ];
    // Prefer the `<summary>…</summary>` body; a continuation without one
    // (older builds) is shown whole rather than dropped.
    let summary = crate::parsers::claude::task_notification_summary_regex()
        .captures(continuation)
        .and_then(|c| c.get(1))
        .map(|m| m.as_str().trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(continuation.trim());
    if !summary.is_empty() {
        blocks.push(ContentBlock::Text {
            text: summary.to_string(),
        });
    }
    blocks
}

/// Devin stores `arguments` as a JSON object (not the OpenAI JSON string);
/// stringify it for the preview, passing a string form through unchanged.
fn normalize_tool_arguments(args: &Value) -> Option<String> {
    match args {
        Value::Null => None,
        Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        other => serde_json::to_string(other).ok(),
    }
}

fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// `sessions.*_at` / `message_nodes.created_at` are Unix **seconds**.
fn secs_to_datetime(secs: i64) -> DateTime<Utc> {
    if secs <= 0 {
        return Utc::now();
    }
    Utc.timestamp_opt(secs, 0).single().unwrap_or_else(Utc::now)
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    })
}

/// Group flat messages into turns: a user message is its own turn; an
/// assistant message absorbs the `tool` rows that follow it (Devin writes one
/// `tool` node per call, after the assistant node that made the calls).
/// Mirrors the Hermes/OpenCode strategy; `relocate_orphaned_tool_results`
/// then repairs any result that landed in the wrong turn.
fn group_into_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    let mut turns: Vec<MessageTurn> = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];

        match msg.role {
            MessageRole::User | MessageRole::System => {
                turns.push(MessageTurn {
                    id: format!("turn-{}", turns.len()),
                    role: if matches!(msg.role, MessageRole::User) {
                        TurnRole::User
                    } else {
                        TurnRole::System
                    },
                    blocks: msg.content.clone(),
                    timestamp: msg.timestamp,
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: msg.completed_at,
                    agent_message_id: None,
                });
                i += 1;
            }
            MessageRole::Assistant | MessageRole::Tool => {
                let mut blocks: Vec<ContentBlock> = msg.content.clone();
                let usage = msg.usage.clone();
                let duration_ms = msg.duration_ms;
                let turn_model = msg.model.clone();
                let timestamp = msg.timestamp;
                let mut completed_at = msg.completed_at;
                i += 1;

                while i < messages.len() && matches!(messages[i].role, MessageRole::Tool) {
                    blocks.extend(messages[i].content.clone());
                    if messages[i].completed_at.is_some() {
                        completed_at = messages[i].completed_at;
                    }
                    i += 1;
                }

                turns.push(MessageTurn {
                    id: format!("turn-{}", turns.len()),
                    role: TurnRole::Assistant,
                    blocks,
                    timestamp,
                    usage,
                    duration_ms,
                    model: turn_model,
                    completed_at,
                    agent_message_id: None,
                });
            }
        }
    }

    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fixture `sessions.db` with Devin's two tables and:
    /// - `bead-people`: visible, NULL title, `model = ''`; two roots — an
    ///   abandoned first attempt (nodes 0-2) and the main chain (3-11) whose
    ///   head is `main_chain_id = 11`; the chain has scaffolding system rows,
    ///   a `powered by` row, a real user prompt, an `<available_skills>` row, a
    ///   thinking + tool-call assistant node, its tool result, a failed tool
    ///   call, a `cache_keepalive` user row, and a final assistant reply. Node
    ///   12 is a dangling branch off node 6 that must not appear.
    /// - `hidden-helper`: `hidden = 1`, must be skipped by the listing.
    /// - `codeg-launched`: cwd under `/app.codeg/chat-sessions/`, skipped.
    /// - `compacted`: a single root whose chain opens with the continuation
    ///   system message.
    fn fixture_db(dir: &Path) -> PathBuf {
        let path = dir.join("sessions.db");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE sessions (id TEXT PRIMARY KEY, working_directory TEXT NOT NULL, backend_type TEXT NOT NULL, model TEXT NOT NULL, agent_mode TEXT NOT NULL, created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, title TEXT, main_chain_id INTEGER, shell_last_seen_index INTEGER DEFAULT 0, cogs_json TEXT, workspace_dirs TEXT, hidden INTEGER NOT NULL DEFAULT 0, metadata TEXT);
            CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, parent_node_id INTEGER, chat_message TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT, UNIQUE(session_id, node_id));
            "#,
        )
        .unwrap();

        let mut insert_session = conn
            .prepare(
                "INSERT INTO sessions (id, working_directory, backend_type, model, agent_mode, created_at, last_activity_at, title, main_chain_id, hidden) \
                 VALUES (?1, ?2, 'windsurf', ?3, 'bypass', ?4, ?5, ?6, ?7, ?8)",
            )
            .unwrap();
        insert_session
            .execute(rusqlite::params![
                "bead-people",
                "/Users/me/Fred",
                "",
                1_790_496_048_i64,
                1_790_496_206_i64,
                Option::<String>::None,
                11_i64,
                0
            ])
            .unwrap();
        insert_session
            .execute(rusqlite::params![
                "hidden-helper",
                "/",
                "swe-1-6-slow",
                1_790_000_000_i64,
                1_790_000_010_i64,
                "Output a summary from the following messages",
                1_i64,
                1
            ])
            .unwrap();
        insert_session
            .execute(rusqlite::params![
                "codeg-launched",
                "/Users/me/Library/Application Support/app.codeg/chat-sessions/2026-09-27/abc",
                "swe-2-high",
                1_790_100_000_i64,
                1_790_100_010_i64,
                "Hello Greeting",
                1_i64,
                0
            ])
            .unwrap();
        insert_session
            .execute(rusqlite::params![
                "compacted",
                "/Users/me/proj",
                "swe-2-high",
                1_790_200_000_i64,
                1_790_200_100_i64,
                "Daily log",
                3_i64,
                0
            ])
            .unwrap();
        drop(insert_session);

        let mut insert_node = conn
            .prepare(
                "INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .unwrap();
        let mut node = |session: &str, node_id: i64, parent: Option<i64>, msg: Value, at: i64| {
            insert_node
                .execute(rusqlite::params![
                    session,
                    node_id,
                    parent,
                    msg.to_string(),
                    at
                ])
                .unwrap();
        };

        let sys = |content: &str, source: &str| {
            serde_json::json!({
                "message_id": format!("sys-{source}-{}", content.len()),
                "role": "system",
                "content": content,
                "metadata": {"is_user_input": null, "telemetry": {"source": source}}
            })
        };
        let user = |id: &str, content: &str, is_input: Option<bool>, source: &str, at: &str| {
            serde_json::json!({
                "message_id": id,
                "role": "user",
                "content": content,
                "metadata": {"is_user_input": is_input, "created_at": at, "telemetry": {"source": source}}
            })
        };

        // Abandoned first root of bead-people (a retry re-sent the prompt).
        node(
            "bead-people",
            0,
            None,
            sys(
                "You are Devin, an interactive command line agent from Cognition.",
                "sysprompt",
            ),
            1_790_496_048,
        );
        node(
            "bead-people",
            1,
            Some(0),
            sys("You are powered by SWE-2 High.", "system"),
            1_790_496_048,
        );
        node(
            "bead-people",
            2,
            Some(1),
            user(
                "u-abandoned",
                "请执行每日工作日志任务",
                Some(true),
                "user",
                "2026-09-27T08:00:48.905057Z",
            ),
            1_790_496_048,
        );

        // Main chain.
        node(
            "bead-people",
            3,
            None,
            sys(
                "You are Devin, an interactive command line agent from Cognition.",
                "sysprompt",
            ),
            1_790_496_051,
        );
        node(
            "bead-people",
            4,
            Some(3),
            sys("You are powered by SWE-2 High.", "system"),
            1_790_496_051,
        );
        node(
            "bead-people",
            5,
            Some(4),
            sys("<rules type=\"always-on\">…</rules>", "rules"),
            1_790_496_051,
        );
        node(
            "bead-people",
            6,
            Some(5),
            user(
                "u-main",
                "请执行每日工作日志任务：目标日 2026-09-26",
                Some(true),
                "user",
                "2026-09-27T08:00:51.000000Z",
            ),
            1_790_496_051,
        );
        node(
            "bead-people",
            7,
            Some(6),
            sys("<available_skills>…</available_skills>", "system"),
            1_790_496_051,
        );
        node(
            "bead-people",
            8,
            Some(7),
            serde_json::json!({
                "message_id": "a-1",
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_1", "name": "exec", "arguments": {"command": "ls -la"}, "index": 0, "kind": "function"}],
                "thinking": {"thinking": "Check the files first.", "signature": "sealed"},
                "metadata": {
                    "num_tokens": 250,
                    "is_user_input": null,
                    "metrics": {"ttft_ms": 7973, "total_time_ms": 8831, "input_tokens": 34828, "output_tokens": 250, "cache_read_tokens": 8192, "cache_creation_tokens": null},
                    "started_generation_at": "2026-09-27T08:00:58.891272Z",
                    "created_at": "2026-09-27T08:01:00.781551Z",
                    "generation_model": "swe-2-high",
                    "telemetry": {"source": "assistant", "operation": "inference"}
                }
            }),
            1_790_496_060,
        );
        node(
            "bead-people",
            9,
            Some(8),
            serde_json::json!({
                "message_id": "t-1",
                "role": "tool",
                "content": "Output from command in shell 5b1eed:\ntotal 0",
                "tool_call_id": "call_1",
                "metadata": {
                    "is_user_input": null,
                    "created_at": "2026-09-27T08:01:01.000000Z",
                    "extensions": {"chisel/tool_result_meta": {"success": true, "kind": "execute"}},
                    "telemetry": {"source": "tool_result"}
                }
            }),
            1_790_496_061,
        );
        node(
            "bead-people",
            10,
            Some(9),
            user(
                "u-keepalive",
                "continue",
                None,
                "cache_keepalive",
                "2026-09-27T08:02:00.000000Z",
            ),
            1_790_496_120,
        );
        node(
            "bead-people",
            11,
            Some(10),
            serde_json::json!({
                "message_id": "a-2",
                "role": "assistant",
                "content": "Done. The directory is empty.",
                "metadata": {
                    "is_user_input": null,
                    "metrics": {"total_time_ms": 1200, "input_tokens": 35000, "output_tokens": 12, "cache_read_tokens": null, "cache_creation_tokens": null},
                    "started_generation_at": "2026-09-27T08:03:24.000000Z",
                    "created_at": "2026-09-27T08:03:26.000000Z",
                    "generation_model": "swe-2-high",
                    "telemetry": {"source": "assistant", "operation": "inference"}
                }
            }),
            1_790_496_206,
        );
        // Dangling branch off node 6 — an alternative reply that was never
        // adopted as the main chain.
        node(
            "bead-people",
            12,
            Some(6),
            serde_json::json!({
                "message_id": "a-branch",
                "role": "assistant",
                "content": "BRANCH REPLY MUST NOT APPEAR",
                "metadata": {"is_user_input": null, "created_at": "2026-09-27T08:00:55.000000Z", "telemetry": {"source": "assistant"}}
            }),
            1_790_496_055,
        );

        node(
            "hidden-helper",
            0,
            None,
            sys("You are a Summarizer.", "system"),
            1_790_000_000,
        );
        node(
            "hidden-helper",
            1,
            Some(0),
            user(
                "u-h",
                "Output a summary from the following messages",
                Some(true),
                "user",
                "2026-09-16T04:00:00Z",
            ),
            1_790_000_001,
        );

        node(
            "codeg-launched",
            0,
            None,
            sys("You are Devin.", "sysprompt"),
            1_790_100_000,
        );
        node(
            "codeg-launched",
            1,
            Some(0),
            user("u-c", "Hello", Some(true), "user", "2026-09-17T04:00:00Z"),
            1_790_100_001,
        );

        node(
            "compacted",
            0,
            None,
            sys(
                "You are Devin, an interactive command line agent from Cognition.",
                "sysprompt",
            ),
            1_790_200_000,
        );
        node(
            "compacted",
            1,
            Some(0),
            sys(
                "You are continuing work from a previous conversation thread. Below is a summary of the previous conversation thread:\nFull conversation history saved at /tmp/history.md.\nSummary:\n<summary>\n1. Request and Intent: run the daily pipeline.\n</summary>",
                "system",
            ),
            1_790_200_000,
        );
        node(
            "compacted",
            2,
            Some(1),
            serde_json::json!({
                "message_id": "a-c1",
                "role": "assistant",
                "content": "",
                "tool_calls": [{"id": "call_c", "name": "read", "arguments": {"path": "/tmp/x"}, "index": 0, "kind": "function"}],
                "metadata": {"is_user_input": null, "created_at": "2026-09-18T04:00:05Z", "telemetry": {"source": "assistant"}}
            }),
            1_790_200_005,
        );
        node(
            "compacted",
            3,
            Some(2),
            serde_json::json!({
                "message_id": "t-c1",
                "role": "tool",
                "content": "",
                "tool_call_id": "call_c",
                "metadata": {
                    "is_user_input": null,
                    "created_at": "2026-09-18T04:00:06Z",
                    "extensions": {"chisel/tool_result_meta": {"success": false, "failure_reason": "Canceled", "kind": "read"}},
                    "telemetry": {"source": "tool_result"}
                }
            }),
            1_790_200_006,
        );
        drop(insert_node);
        path
    }

    fn parser() -> (tempfile::TempDir, DevinParser) {
        let dir = tempfile::tempdir().unwrap();
        let db = fixture_db(dir.path());
        (dir, DevinParser::with_db_path(db))
    }

    #[test]
    fn lists_visible_non_codeg_sessions_newest_first() {
        let (_dir, parser) = parser();
        let list = parser.list_conversations().unwrap();
        let ids: Vec<&str> = list.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, vec!["bead-people", "compacted"]);

        let bead = &list[0];
        assert_eq!(bead.agent_type, AgentType::Devin);
        assert_eq!(bead.folder_path.as_deref(), Some("/Users/me/Fred"));
        assert_eq!(bead.folder_name.as_deref(), Some("Fred"));
        // NULL title → first real user prompt on the MAIN chain.
        assert_eq!(
            bead.title.as_deref(),
            Some("请执行每日工作日志任务：目标日 2026-09-26")
        );
        // `model = ''` → the `You are powered by …` system line.
        assert_eq!(bead.model.as_deref(), Some("SWE-2 High"));
        assert_eq!(bead.started_at.timestamp(), 1_790_496_048);
        assert_eq!(bead.ended_at.unwrap().timestamp(), 1_790_496_206);
        // Main-chain non-system rows: user, assistant, tool, keepalive-user,
        // assistant = 5. The abandoned root and the branch are not counted.
        assert_eq!(bead.message_count, 5);

        let compacted = &list[1];
        assert_eq!(compacted.title.as_deref(), Some("Daily log"));
        assert_eq!(compacted.model.as_deref(), Some("swe-2-high"));
        assert_eq!(compacted.message_count, 2);
    }

    #[test]
    fn detail_walks_only_the_main_chain() {
        let (_dir, parser) = parser();
        let detail = parser.get_conversation("bead-people").unwrap();
        assert_eq!(detail.summary.model.as_deref(), Some("SWE-2 High"));

        let turns = &detail.turns;
        assert_eq!(
            turns.len(),
            3,
            "user, assistant(+tool), assistant: {turns:#?}"
        );

        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(
            &turns[0].blocks[..],
            [ContentBlock::Text { text }] if text == "请执行每日工作日志任务：目标日 2026-09-26"
        ));
        assert_eq!(turns[0].timestamp.to_rfc3339(), "2026-09-27T08:00:51+00:00");

        assert!(matches!(turns[1].role, TurnRole::Assistant));
        assert!(
            matches!(&turns[1].blocks[0], ContentBlock::Thinking { text } if text == "Check the files first.")
        );
        assert!(matches!(
            &turns[1].blocks[1],
            ContentBlock::ToolUse { tool_use_id: Some(id), tool_name, input_preview: Some(args), .. }
                if id == "call_1" && tool_name == "exec" && args == r#"{"command":"ls -la"}"#
        ));
        assert!(matches!(
            &turns[1].blocks[2],
            ContentBlock::ToolResult { tool_use_id: Some(id), output_preview: Some(out), is_error: false, .. }
                if id == "call_1" && out.starts_with("Output from command")
        ));
        assert_eq!(turns[1].model.as_deref(), Some("swe-2-high"));
        assert_eq!(turns[1].duration_ms, Some(8831));
        assert_eq!(
            turns[1].usage,
            Some(TurnUsage {
                input_tokens: 34828,
                output_tokens: 250,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 8192,
            })
        );
        // Turn opens at generation start and closes at the last tool result.
        assert_eq!(
            turns[1].timestamp.to_rfc3339(),
            "2026-09-27T08:00:58.891272+00:00"
        );
        assert_eq!(
            turns[1].completed_at.unwrap().to_rfc3339(),
            "2026-09-27T08:01:01+00:00"
        );

        // The `cache_keepalive` "continue" row is not a user turn.
        assert!(matches!(turns[2].role, TurnRole::Assistant));
        assert!(
            matches!(&turns[2].blocks[..], [ContentBlock::Text { text }] if text == "Done. The directory is empty.")
        );

        let all_text: String = format!("{turns:?}");
        assert!(!all_text.contains("BRANCH REPLY MUST NOT APPEAR"));
        assert!(!all_text.contains("available_skills"));
        assert!(!all_text.contains("powered by"));

        let stats = detail.session_stats.expect("usage → session stats");
        assert_eq!(stats.total_usage.as_ref().unwrap().output_tokens, 262);
        assert_eq!(stats.total_duration_ms, 8831 + 1200);
        assert_eq!(stats.context_window_used_tokens, Some(35000));
    }

    #[test]
    fn continuation_becomes_compaction_divider_and_failed_tool_is_error() {
        let (_dir, parser) = parser();
        let detail = parser.get_conversation("compacted").unwrap();
        let turns = &detail.turns;
        assert_eq!(turns.len(), 2, "{turns:#?}");

        assert!(matches!(turns[0].role, TurnRole::Assistant));
        assert!(matches!(
            &turns[0].blocks[0],
            ContentBlock::ToolUse { tool_name, meta: Some(meta), .. }
                if tool_name == "context_compaction"
                    && meta["contextCompaction"]["trigger"] == "automatic"
        ));
        assert!(matches!(
            &turns[0].blocks[1],
            ContentBlock::ToolResult {
                is_error: false,
                ..
            }
        ));
        assert!(matches!(
            &turns[0].blocks[2],
            ContentBlock::Text { text } if text == "1. Request and Intent: run the daily pipeline."
        ));

        assert!(matches!(
            &turns[1].blocks[1],
            ContentBlock::ToolResult { tool_use_id: Some(id), output_preview: None, is_error: true, .. } if id == "call_c"
        ));
    }

    #[test]
    fn hidden_and_codeg_sessions_still_resolve_by_id() {
        let (_dir, parser) = parser();
        // Skipped by the listing, but an open tab may still reference them.
        assert_eq!(
            parser
                .get_conversation("hidden-helper")
                .unwrap()
                .turns
                .len(),
            1
        );
        assert_eq!(
            parser
                .get_conversation("codeg-launched")
                .unwrap()
                .turns
                .len(),
            1
        );
        assert!(matches!(
            parser.get_conversation("nope"),
            Err(ParseError::ConversationNotFound(id)) if id == "nope"
        ));
    }

    #[test]
    fn missing_store_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let parser = DevinParser::with_db_path(dir.path().join("sessions.db"));
        assert!(parser.list_conversations().unwrap().is_empty());
        assert!(matches!(
            parser.get_conversation("x"),
            Err(ParseError::ConversationNotFound(_))
        ));
    }

    #[test]
    fn store_path_resolution() {
        let home = PathBuf::from("/home/u");
        assert_eq!(
            resolve_devin_sessions_db_from(None, None, Some(home.clone())),
            PathBuf::from("/home/u/.local/share/devin/cli/sessions.db")
        );
        assert_eq!(
            resolve_devin_sessions_db_from(None, Some(" /data ".into()), Some(home.clone())),
            PathBuf::from("/data/devin/cli/sessions.db")
        );
        assert_eq!(
            resolve_devin_sessions_db_from(
                Some("/tmp/copy.db".into()),
                Some("/data".into()),
                Some(home.clone())
            ),
            PathBuf::from("/tmp/copy.db")
        );
        // Blank overrides fall through.
        assert_eq!(
            resolve_devin_sessions_db_from(Some("  ".into()), Some("".into()), Some(home)),
            PathBuf::from("/home/u/.local/share/devin/cli/sessions.db")
        );
    }

    #[test]
    fn powered_by_extraction() {
        assert_eq!(
            parse_powered_by("You are powered by SWE-2 High."),
            Some("SWE-2 High".into())
        );
        assert_eq!(
            parse_powered_by("You are powered by Summarizer.\n"),
            Some("Summarizer".into())
        );
        assert_eq!(parse_powered_by("## Parallel tool calls"), None);
    }
    /// Manual smoke test against the real store on this machine (read-only).
    /// Run with:
    /// `cargo test --features test-utils parsers::devin -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a real ~/.local/share/devin/cli/sessions.db"]
    fn smoke_real_store() {
        let parser = DevinParser::new();
        let list = parser.list_conversations().expect("list");
        eprintln!(
            "[devin smoke] store = {}",
            resolve_devin_sessions_db().display()
        );
        eprintln!("[devin smoke] {} sessions listed", list.len());
        for s in list.iter().take(5) {
            eprintln!(
                "[devin smoke]   {:<24} msgs={:<4} model={:<14} title={:?}",
                s.id,
                s.message_count,
                s.model.as_deref().unwrap_or("-"),
                s.title.as_deref().map(|t| truncate_for_log(t, 60))
            );
        }
        let Some(first) = list.first() else {
            return;
        };
        let detail = parser.get_conversation(&first.id).expect("detail");
        let users = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .count();
        let tool_uses: usize = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter(|b| matches!(b, ContentBlock::ToolUse { .. }))
            .count();
        eprintln!(
            "[devin smoke] detail {}: {} turns ({} user), {} tool uses, stats={:?}",
            first.id,
            detail.turns.len(),
            users,
            tool_uses,
            detail
                .session_stats
                .as_ref()
                .map(|s| (s.total_tokens, s.total_duration_ms))
        );
        for t in detail.turns.iter().take(4) {
            let kinds: Vec<&str> = t
                .blocks
                .iter()
                .map(|b| match b {
                    ContentBlock::Text { .. } => "text",
                    ContentBlock::Thinking { .. } => "thinking",
                    ContentBlock::ToolUse { .. } => "tool_use",
                    ContentBlock::ToolResult { .. } => "tool_result",
                    _ => "other",
                })
                .collect();
            eprintln!("[devin smoke]   {:?} {} {:?}", t.role, t.timestamp, kinds);
        }
        assert!(!detail.turns.is_empty());
    }

    fn truncate_for_log(s: &str, n: usize) -> String {
        s.chars().take(n).collect()
    }
}
