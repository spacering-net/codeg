use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, QueryResult,
    Statement,
};

use crate::models::*;
use crate::parsers::{folder_name_from_path, AgentEnv, AgentParser, ParseError};

/// Parser for Hermes Agent (Nous Research) transcripts.
///
/// Hermes self-manages its history in `~/.hermes/state.db` (SQLite, WAL, FTS5)
/// across two tables:
/// - `sessions(id, source, model, model_config, parent_session_id, started_at,
///   ended_at, cwd, title, archived, input_tokens/output_tokens/…)`
/// - `messages(id, session_id, role, content, tool_call_id, tool_calls,
///   tool_name, reasoning, reasoning_content, timestamp, active, …)`
///
/// Several shapes differ from the OpenCode SQLite parser and are load-bearing:
/// timestamps are Unix epoch **seconds** as REAL floats (not millis); an ACP
/// session's working directory is in `model_config` JSON (the `cwd` column was
/// NULL for ACP sessions when this parser was written; the v2026.9.24 and
/// v0.21.6 adapters fill both); messages are ordered by `id` (insertion order,
/// not timestamp); rewound rows have `active = 0`; `sessions.ended_at` is not
/// the last activity (see [`LAST_ACTIVE_AT_SQL`]); and multimodal `content` is
/// stored with a leading NUL-byte `\x00json:` sentinel followed by a JSON parts
/// array. See the inline notes on each function.
pub struct HermesParser {
    base_dir: PathBuf,
}

impl Default for HermesParser {
    fn default() -> Self {
        Self::new()
    }
}

impl HermesParser {
    pub fn new() -> Self {
        Self::for_env(&AgentEnv::inherited())
    }

    /// The history of the Hermes launched with `env`.
    pub fn for_env(env: &AgentEnv) -> Self {
        Self {
            base_dir: resolve_hermes_home_dir_for_env(env),
        }
    }

    /// Test-only constructor that points the parser at a fixture directory
    /// containing a `state.db` SQLite file.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn sqlite_db_path(&self) -> PathBuf {
        self.base_dir.join("state.db")
    }

    fn block_on<F, T>(&self, fut: F) -> Result<T, ParseError>
    where
        F: Future<Output = Result<T, ParseError>>,
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| ParseError::InvalidData(format!("failed to build runtime: {e}")))?;
        runtime.block_on(fut)
    }

    /// Open the Hermes state DB read-only. `mode=ro` reads committed WAL frames
    /// even while the Hermes ACP server is actively writing (verified against a
    /// live process), and guarantees codeg never mutates Hermes data.
    async fn open_sqlite_connection(&self) -> Result<DatabaseConnection, ParseError> {
        let db_path = self.sqlite_db_path();
        let db_url = format!(
            "sqlite:{}?mode=ro",
            urlencoding::encode(&db_path.to_string_lossy())
        );

        let mut opts = ConnectOptions::new(db_url);
        opts.max_connections(1)
            .min_connections(1)
            .connect_timeout(Duration::from_secs(5))
            .idle_timeout(Duration::from_secs(30))
            .sqlx_logging(false);

        let conn = Database::connect(opts).await?;
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA busy_timeout=3000;".to_owned(),
        ))
        .await?;

        Ok(conn)
    }

    async fn list_conversations_from_sqlite(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let conn = self.open_sqlite_connection().await?;

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                // `cwd` falls back to `model_config` JSON, where ACP sessions
                // keep it (the column was NULL for them in older builds);
                // `json_valid` guards against non-JSON blobs aborting the whole
                // SELECT. Archived sessions are hidden. `message_count` counts
                // only active, non-system rows.
                format!(
                    r#"
                SELECT
                    s.id AS id,
                    COALESCE(
                        NULLIF(s.cwd, ''),
                        CASE WHEN json_valid(s.model_config)
                             THEN json_extract(s.model_config, '$.cwd') END
                    ) AS folder_path,
                    s.title AS title,
                    s.model AS model,
                    s.started_at AS started_at,
                    {LAST_ACTIVE_AT_SQL} AS last_active_at,
                    s.parent_session_id AS parent_id,
                    (
                        SELECT COUNT(*) FROM messages m
                        WHERE m.session_id = s.id
                          AND m.active = 1
                          AND m.role <> 'system'
                    ) AS message_count
                FROM sessions s
                WHERE COALESCE(s.archived, 0) = 0
                ORDER BY s.started_at DESC
                "#
                ),
            ))
            .await?;

        let mut conversations = Vec::with_capacity(rows.len());
        for row in rows {
            let summary = parse_sqlite_summary_row(&row)?;
            if summary.message_count == 0 {
                continue;
            }
            conversations.push(summary);
        }

        Ok(conversations)
    }

    /// Fetch a single session by id. Unlike the list query this does NOT filter
    /// `archived` — a persisted/opened tab may reference an archived session and
    /// must still resolve.
    async fn sqlite_summary_by_id(
        &self,
        conn: &DatabaseConnection,
        conversation_id: &str,
    ) -> Result<Option<ConversationSummary>, ParseError> {
        let row = conn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                format!(
                    r#"
                SELECT
                    s.id AS id,
                    COALESCE(
                        NULLIF(s.cwd, ''),
                        CASE WHEN json_valid(s.model_config)
                             THEN json_extract(s.model_config, '$.cwd') END
                    ) AS folder_path,
                    s.title AS title,
                    s.model AS model,
                    s.started_at AS started_at,
                    {LAST_ACTIVE_AT_SQL} AS last_active_at,
                    s.parent_session_id AS parent_id,
                    (
                        SELECT COUNT(*) FROM messages m
                        WHERE m.session_id = s.id
                          AND m.active = 1
                          AND m.role <> 'system'
                    ) AS message_count
                FROM sessions s
                WHERE s.id = ?
                LIMIT 1
                "#
                ),
                [conversation_id.into()],
            ))
            .await?;

        row.map(|r| parse_sqlite_summary_row(&r)).transpose()
    }

    async fn get_conversation_from_sqlite(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let conn = self.open_sqlite_connection().await?;
        let summary = self
            .sqlite_summary_by_id(&conn, conversation_id)
            .await?
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;

        let messages = self
            .load_sqlite_messages(&conn, conversation_id, summary.model.as_deref())
            .await?;
        let mut turns = group_into_turns(messages);
        super::relocate_orphaned_tool_results(&mut turns);
        super::structurize_read_tool_output(&mut turns);
        super::resolve_patch_line_numbers(&mut turns, summary.folder_path.as_deref());
        super::backfill_turn_durations(&mut turns, &[]);

        let session_stats = self
            .build_session_stats(&conn, conversation_id, summary.model.as_deref())
            .await?;

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }

    /// Map active message rows (insertion order) into `UnifiedMessage`s.
    ///
    /// Hermes stores an assistant turn as one `assistant` row carrying
    /// `tool_calls`, followed by N separate `role="tool"` rows (each a result
    /// matched by `tool_call_id`). `group_into_turns` later folds the tool rows
    /// back into the assistant turn.
    async fn load_sqlite_messages(
        &self,
        conn: &DatabaseConnection,
        conversation_id: &str,
        session_model: Option<&str>,
    ) -> Result<Vec<UnifiedMessage>, ParseError> {
        let rows = conn
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                // ORDER BY id ASC only — Hermes deliberately avoids ORDER BY
                // timestamp (WSL2 clock-regression). `id` is INTEGER AUTOINCREMENT.
                r#"
                SELECT id, role, content, tool_call_id, tool_calls, tool_name,
                       reasoning, reasoning_content, timestamp, finish_reason
                FROM messages
                WHERE session_id = ? AND active = 1
                ORDER BY id ASC
                "#,
                [conversation_id.into()],
            ))
            .await?;

        let mut messages = Vec::with_capacity(rows.len());

        for row in rows {
            // `messages.id` is INTEGER (not TEXT like `sessions.id`).
            let msg_id: i64 = row.try_get("", "id")?;
            let role_str: String = row.try_get("", "role")?;
            let content: Option<String> = row.try_get("", "content")?;
            let timestamp = get_real(&row, "timestamp")
                .map(secs_f64_to_datetime)
                .unwrap_or_else(Utc::now);

            let role = match role_str.as_str() {
                "user" => MessageRole::User,
                "assistant" => MessageRole::Assistant,
                "tool" => MessageRole::Tool,
                // System rows are the assembled system prompt (infra noise, also
                // stored separately in `sessions.system_prompt`); skip them.
                _ => continue,
            };

            let mut blocks: Vec<ContentBlock> = Vec::new();
            let mut msg_model: Option<String> = None;

            match role {
                MessageRole::User => {
                    blocks.extend(decode_hermes_content(content.as_deref()));
                }
                MessageRole::Assistant => {
                    msg_model = session_model.map(str::to_string);

                    // 1) reasoning → Thinking (prefer reasoning_content).
                    let reasoning_content: Option<String> =
                        row.try_get("", "reasoning_content")?;
                    let reasoning: Option<String> = row.try_get("", "reasoning")?;
                    if let Some(text) = reasoning_content
                        .as_deref()
                        .or(reasoning.as_deref())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        blocks.push(ContentBlock::Thinking {
                            text: text.to_string(),
                        });
                    }

                    // 2) assistant text / inline images.
                    blocks.extend(decode_hermes_content(content.as_deref()));

                    // 3) tool calls → ToolUse (results arrive as separate rows).
                    let tool_calls: Option<String> = row.try_get("", "tool_calls")?;
                    if let Some(raw) = tool_calls.as_deref() {
                        for (tool_use_id, tool_name, input_preview) in
                            parse_hermes_tool_calls(raw)
                        {
                            blocks.push(ContentBlock::ToolUse {
                                tool_use_id,
                                tool_name,
                                input_preview,
                                status: None,
                                meta: None,
                            });
                        }
                    }
                }
                MessageRole::Tool => {
                    let tool_call_id: Option<String> = row.try_get("", "tool_call_id")?;
                    blocks.push(ContentBlock::ToolResult {
                        tool_use_id: normalize_optional_string(tool_call_id),
                        // ToolResult carries a single text preview; reduce any
                        // multimodal tool output to text.
                        output_preview: content_to_text(content.as_deref()),
                        // Hermes has no explicit error flag on tool rows.
                        is_error: false,
                        agent_stats: None,
                        images: Vec::new(),
                    });
                }
                MessageRole::System => continue,
            }

            // Drop messages that produced nothing (empty content, no tool calls).
            // This keeps empty user/assistant turns out of the transcript.
            if blocks.is_empty() {
                continue;
            }

            messages.push(UnifiedMessage {
                id: msg_id.to_string(),
                role,
                content: blocks,
                timestamp,
                usage: None,
                duration_ms: None,
                model: msg_model,
                // Hermes logs rows post-generation; the row timestamp is the best
                // end-marker available.
                completed_at: Some(timestamp),
            agent_message_id: None,
            });
        }

        Ok(messages)
    }

    /// Build session stats from the session's cumulative token columns.
    ///
    /// Per-message rows have no input/output/cache split, so per-turn aggregation
    /// would under-report; the session columns are the authoritative totals. The
    /// cumulative `input_tokens` is NOT a valid "current context window used", so
    /// that field is left `None` (only the model-inferred max is surfaced).
    async fn build_session_stats(
        &self,
        conn: &DatabaseConnection,
        conversation_id: &str,
        model: Option<&str>,
    ) -> Result<Option<SessionStats>, ParseError> {
        let row = conn
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                r#"
                SELECT input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
                FROM sessions WHERE id = ? LIMIT 1
                "#,
                [conversation_id.into()],
            ))
            .await?;

        let (input, output, cache_read, cache_write) = match row {
            Some(r) => (
                get_u64(&r, "input_tokens"),
                get_u64(&r, "output_tokens"),
                get_u64(&r, "cache_read_tokens"),
                get_u64(&r, "cache_write_tokens"),
            ),
            None => (0, 0, 0, 0),
        };

        let total = input
            .saturating_add(output)
            .saturating_add(cache_read)
            .saturating_add(cache_write);

        let base = SessionStats {
            total_usage: (total > 0).then_some(TurnUsage {
                input_tokens: input,
                output_tokens: output,
                cache_creation_input_tokens: cache_write,
                cache_read_input_tokens: cache_read,
            }),
            total_tokens: (total > 0).then_some(total),
            total_duration_ms: 0,
            context_window_used_tokens: None,
            context_window_max_tokens: None,
            context_window_usage_percent: None,
        };

        let max = super::infer_context_window_max_tokens(model);
        Ok(super::merge_context_window_stats(Some(base), None, max))
    }
}

impl AgentParser for HermesParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        if !self.sqlite_db_path().exists() {
            return Ok(Vec::new());
        }
        self.block_on(self.list_conversations_from_sqlite())
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        if !self.sqlite_db_path().exists() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }
        self.block_on(self.get_conversation_from_sqlite(conversation_id))
    }
}

/// Hermes config/data directory. Mirrors `commands::acp::hermes_home_dir`
/// semantics exactly so the history path resolves to the same DB the live ACP
/// path uses: honors `HERMES_HOME` (trimmed, then taken VERBATIM — Hermes'
/// own `get_hermes_home` does NOT expand `~`), defaults to `~/.hermes`, falls
/// back to `.` when the home dir is unknown.
pub(crate) fn resolve_hermes_home_dir() -> PathBuf {
    resolve_hermes_home_dir_for_env(&AgentEnv::inherited())
}

/// [`resolve_hermes_home_dir`] for the Hermes launched with `env`.
pub(crate) fn resolve_hermes_home_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_hermes_home(env.var("HERMES_HOME"), dirs::home_dir())
}

fn resolve_hermes_home(env: Option<String>, home: Option<PathBuf>) -> PathBuf {
    let home_dir = || home.clone().unwrap_or_else(|| PathBuf::from("."));
    let configured = env.and_then(|raw| {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    match configured {
        // VERBATIM — no tilde expansion. Hermes' own `get_hermes_home`
        // (`hermes_constants.py`, the file it calls "the single source of
        // truth") is `Path(os.environ["HERMES_HOME"].strip())` with no
        // `expanduser`, so `HERMES_HOME=~/somewhere` really does make Hermes
        // create and use a directory LITERALLY named `~`, next to wherever it
        // was launched. Expanding here pointed codeg at `$HOME/somewhere`
        // instead — a directory Hermes never touches — so the session list came
        // back empty and the `.env` base-URL reconcile
        // (`commands::acp::reconcile_hermes_runtime_env`) patched a file the
        // agent never read. That reconcile's own resolver,
        // `hermes_home_for_launch`, already had this right; the two now agree.
        //
        // Contrast Antigravity and DeepSeek, whose upstreams DO expand — see
        // `parsers::expand_home_prefix` for who is who.
        Some(value) => PathBuf::from(value),
        None => home_dir().join(".hermes"),
    }
}

/// A session's last activity, as the summary's `ended_at`: its newest active,
/// non-system message, else `sessions.ended_at` for a session without one.
///
/// `sessions.ended_at` by itself is not activity. Since v0.21.6 the ACP adapter
/// stamps it (`end_reason = 'acp_disconnect'`) on every session it holds when
/// its stdio closes (`end_all_sessions`, called from `acp_adapter/entry.py`),
/// and `session/load` / `session/resume` clear it again, so a conversation that
/// is only opened and closed gets a fresh `ended_at` and no new message. codeg
/// reads a summary's `ended_at` as where the transcript ends: import stamps
/// `updated_at` with it, and the import scan moves a conversation forward
/// whenever it grows, which floated every merely-opened conversation to the
/// top of the sidebar. Upstream ranks sessions by the newest message timestamp
/// too (`_sql_freshest_of`, which also folds in a heartbeat column codeg does
/// not need), and skips the same out-of-window values: a timestamp outside
/// `EPOCH_MIN..=EPOCH_MAX` (0 to 4.2e9 seconds; the garbage doubles a damaged
/// page leaves behind, or TEXT) must not pin the session's recency.
const LAST_ACTIVE_AT_SQL: &str = "COALESCE(
                        (
                            SELECT MAX(m.timestamp) FROM messages m
                            WHERE m.session_id = s.id
                              AND m.active = 1
                              AND m.role <> 'system'
                              AND m.timestamp BETWEEN 0.0 AND 4200000000.0
                        ),
                        s.ended_at
                    )";

fn parse_sqlite_summary_row(row: &QueryResult) -> Result<ConversationSummary, ParseError> {
    let id: String = row.try_get("", "id")?;
    let folder_path: Option<String> = row.try_get("", "folder_path")?;
    let title: Option<String> = row.try_get("", "title")?;
    let model: Option<String> = row.try_get("", "model")?;
    let parent_id: Option<String> = row.try_get("", "parent_id")?;
    let message_count_i64: i64 = row.try_get("", "message_count")?;

    let started_at = get_real(row, "started_at")
        .map(secs_f64_to_datetime)
        .unwrap_or_else(Utc::now);
    // Unlike `started_at`, an unusable value is no activity at all rather than
    // "now": every refresh would otherwise move the conversation to the top.
    let ended_at = get_real(row, "last_active_at").and_then(secs_f64_to_datetime_opt);

    let folder_path = normalize_optional_string(folder_path);
    let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

    let message_count = if message_count_i64 <= 0 {
        0
    } else {
        u32::try_from(message_count_i64).unwrap_or(u32::MAX)
    };

    Ok(ConversationSummary {
        id,
        agent_type: AgentType::Hermes,
        folder_path,
        folder_name,
        title: normalize_optional_string(title),
        started_at,
        ended_at,
        message_count,
        model: normalize_optional_string(model),
        git_branch: None,
        parent_id: normalize_optional_string(parent_id),
        parent_tool_use_id: None,
        delegation_call_id: None,
    })
}

/// Read a REAL column tolerantly. SQLite is dynamically typed: a value in a
/// REAL-affinity column may be stored with INTEGER storage class (e.g. a whole
/// number), which a strict `f64` decode rejects. Try `f64`, then fall back to
/// `i64`. NULL/missing → `None`.
fn get_real(row: &QueryResult, col: &str) -> Option<f64> {
    if let Ok(Some(v)) = row.try_get::<Option<f64>>("", col) {
        return Some(v);
    }
    if let Ok(Some(v)) = row.try_get::<Option<i64>>("", col) {
        return Some(v as f64);
    }
    None
}

/// Read a token-count column as a non-negative `u64`. NULL/negative → 0.
fn get_u64(row: &QueryResult, col: &str) -> u64 {
    match row.try_get::<Option<i64>>("", col) {
        Ok(Some(v)) if v > 0 => v as u64,
        _ => 0,
    }
}

/// Convert a Unix epoch timestamp expressed as REAL **seconds** to a UTC time,
/// "now" when it is unusable. (Contrast OpenCode, whose timestamps are
/// milliseconds.)
fn secs_f64_to_datetime(secs: f64) -> DateTime<Utc> {
    secs_f64_to_datetime_opt(secs).unwrap_or_else(Utc::now)
}

/// [`secs_f64_to_datetime`] without the fallback: `None` for a non-finite,
/// non-positive or unrepresentable value.
fn secs_f64_to_datetime_opt(secs: f64) -> Option<DateTime<Utc>> {
    if !secs.is_finite() || secs <= 0.0 {
        return None;
    }
    let mut whole = secs.trunc() as i64;
    let mut nanos = (secs.fract() * 1_000_000_000.0).round() as i64;
    // Carry a rounding overflow (fraction ≈ 0.999…) into the next whole second
    // so chrono never receives a >= 1e9 nanosecond value, which would otherwise
    // render as a spurious leap second.
    if nanos >= 1_000_000_000 {
        whole += 1;
        nanos -= 1_000_000_000;
    }
    Utc.timestamp_opt(whole, nanos as u32).single()
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

/// Sentinel that prefixes JSON-encoded multimodal `content` (a NUL byte, which
/// cannot appear in normal text, followed by `json:`). Mirrors Hermes'
/// `SessionDB._CONTENT_JSON_PREFIX`.
const CONTENT_JSON_PREFIX: &str = "\u{0000}json:";

/// Decode a `messages.content` value into content blocks.
///
/// Plain text is stored verbatim. Multimodal content is `CONTENT_JSON_PREFIX`
/// followed by an OpenAI-style parts array
/// (`[{"type":"text",…},{"type":"image_url",…}]`).
fn decode_hermes_content(raw: Option<&str>) -> Vec<ContentBlock> {
    let Some(s) = raw else {
        return Vec::new();
    };

    if let Some(rest) = s.strip_prefix(CONTENT_JSON_PREFIX) {
        match serde_json::from_str::<serde_json::Value>(rest) {
            Ok(serde_json::Value::Array(parts)) => {
                return parts.iter().filter_map(content_part_to_block).collect();
            }
            // Since v0.21.6 a LITERAL text that itself begins with the sentinel
            // is stored as the sentinel plus that text as a JSON string
            // (`_encode_content`), and read back verbatim. It is text, never
            // parts: decoding it a second time would let a crafted message
            // choose its own structure, which is what the escape prevents.
            // Upstream keeps that promise only until the session is reopened:
            // `session/load` and `session/resume` rewrite the session's rows
            // from the decoded history (seen on v0.22.0 and v0.22.2), and a
            // literal that decodes as a parts array is then stored as one,
            // which the arm above cannot tell from a real one.
            Ok(serde_json::Value::String(literal)) => {
                return text_block(literal.trim_start_matches('\u{0000}').trim());
            }
            _ => {}
        }
        // Malformed after the sentinel: show the payload as text, minus the
        // unrenderable NUL sentinel.
        let trimmed = rest.trim();
        return text_block(trimmed);
    }

    text_block(s.trim())
}

fn text_block(text: &str) -> Vec<ContentBlock> {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![ContentBlock::Text {
            text: text.to_string(),
        }]
    }
}

fn content_part_to_block(part: &serde_json::Value) -> Option<ContentBlock> {
    // A part may be a bare string (treated as text) or a typed object.
    if let Some(s) = part.as_str() {
        let trimmed = s.trim();
        return (!trimmed.is_empty()).then(|| ContentBlock::Text {
            text: trimmed.to_string(),
        });
    }

    match part.get("type").and_then(|v| v.as_str()).unwrap_or("") {
        "text" => {
            let text = part.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
            (!text.is_empty()).then(|| ContentBlock::Text {
                text: text.to_string(),
            })
        }
        "image_url" => {
            let url = part
                .get("image_url")
                .and_then(|i| i.get("url"))
                .and_then(|v| v.as_str())?;
            if let Some((mime_type, data)) = parse_data_uri_image(url) {
                Some(ContentBlock::Image {
                    data,
                    mime_type,
                    uri: None,
                })
            } else {
                // Non-data URL (http/file): keep a textual reference rather than
                // silently dropping it.
                let trimmed = url.trim();
                (!trimmed.is_empty()).then(|| ContentBlock::Text {
                    text: format!("[image] {trimmed}"),
                })
            }
        }
        _ => None,
    }
}

/// Flatten a `content` value to a single text string (for tool results, whose
/// `output_preview` is a single `Option<String>`). Images become `[image]`.
fn content_to_text(raw: Option<&str>) -> Option<String> {
    let mut parts = Vec::new();
    for block in decode_hermes_content(raw) {
        match block {
            ContentBlock::Text { text } => parts.push(text),
            ContentBlock::Image { .. } => parts.push("[image]".to_string()),
            _ => {}
        }
    }
    let joined = parts.join("\n");
    let trimmed = joined.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Parse a `data:<mime>;base64,<data>` image URI into `(mime_type, data)`.
/// Returns `None` for non-image or non-data URIs. (Local copy of the private
/// OpenCode helper.)
fn parse_data_uri_image(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    let without_prefix = trimmed.strip_prefix("data:")?;
    let marker = ";base64,";
    let marker_idx = without_prefix.find(marker)?;
    let mime_type = without_prefix.get(..marker_idx)?.trim();
    if !mime_type.starts_with("image/") {
        return None;
    }
    let data = without_prefix.get(marker_idx + marker.len()..)?.trim();
    if data.is_empty() {
        return None;
    }
    Some((mime_type.to_string(), data.to_string()))
}

/// Normalize an OpenAI tool-call `arguments` value into a preview string.
/// `arguments` may be a JSON string (passed through) or an object (stringified).
fn normalize_tool_arguments(args: &serde_json::Value) -> Option<String> {
    match args {
        serde_json::Value::Null => None,
        serde_json::Value::String(s) => {
            let trimmed = s.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        }
        other => serde_json::to_string(other).ok(),
    }
}

/// Parse a `messages.tool_calls` JSON array into `(id, name, input_preview)`
/// tuples. OpenAI function-call shape:
/// `[{"id","type":"function","function":{"name","arguments"}}]`.
fn parse_hermes_tool_calls(raw: &str) -> Vec<(Option<String>, String, Option<String>)> {
    let value: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };

    arr.iter()
        .map(|tc| {
            let id = tc
                .get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let function = tc.get("function");
            let name = function
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let input_preview = function
                .and_then(|f| f.get("arguments"))
                .and_then(normalize_tool_arguments);
            (id, name, input_preview)
        })
        .collect()
}

/// Group flat messages into turns: a user/system message becomes its own turn;
/// an assistant message absorbs immediately-following tool-result rows. Mirrors
/// the OpenCode/Codex strategy. The `relocate_orphaned_tool_results` post-pass
/// then repairs any tool result that landed in the wrong turn.
fn group_into_turns(messages: Vec<UnifiedMessage>) -> Vec<MessageTurn> {
    let mut turns = Vec::new();
    let mut i = 0;

    while i < messages.len() {
        let msg = &messages[i];

        if matches!(msg.role, MessageRole::User) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::User,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: msg.completed_at,
            agent_message_id: None,
            });
            i += 1;
        } else if matches!(msg.role, MessageRole::System) {
            turns.push(MessageTurn {
                id: format!("turn-{}", turns.len()),
                role: TurnRole::System,
                blocks: msg.content.clone(),
                timestamp: msg.timestamp,
                usage: None,
                duration_ms: None,
                model: None,
                completed_at: msg.completed_at,
            agent_message_id: None,
            });
            i += 1;
        } else {
            let mut blocks: Vec<ContentBlock> = msg.content.clone();
            let mut usage = msg.usage.clone();
            let mut duration_ms = msg.duration_ms;
            let mut turn_model = msg.model.clone();
            let timestamp = msg.timestamp;
            let mut completed_at = msg.completed_at;
            i += 1;

            while i < messages.len() && matches!(messages[i].role, MessageRole::Tool) {
                blocks.extend(messages[i].content.clone());
                if usage.is_none() {
                    usage = messages[i].usage.clone();
                }
                if duration_ms.is_none() {
                    duration_ms = messages[i].duration_ms;
                }
                if turn_model.is_none() {
                    turn_model = messages[i].model.clone();
                }
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

    turns
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_hermes_home_matches_acp_semantics() {
        let home = Some(PathBuf::from("/Users/demo"));
        assert_eq!(
            resolve_hermes_home(None, home.clone()),
            PathBuf::from("/Users/demo/.hermes")
        );
        assert_eq!(
            resolve_hermes_home(Some(String::new()), home.clone()),
            PathBuf::from("/Users/demo/.hermes")
        );
        assert_eq!(
            resolve_hermes_home(Some("   ".to_string()), home.clone()),
            PathBuf::from("/Users/demo/.hermes")
        );
        // A tilde is NOT expanded, because Hermes does not expand it: its own
        // `get_hermes_home` (`hermes_constants.py`) is
        // `Path(os.environ["HERMES_HOME"].strip())`, so it creates and uses a
        // directory literally named `~`. This used to answer `/Users/demo` and
        // `/Users/demo/work` — directories Hermes never opens — which is why
        // the session list came back empty for anyone who set it that way,
        // while `commands::acp::hermes_home_for_launch` (the same resolution,
        // written from the same source) disagreed with this one all along.
        assert_eq!(
            resolve_hermes_home(Some("~".to_string()), home.clone()),
            PathBuf::from("~")
        );
        assert_eq!(
            resolve_hermes_home(Some("~/work".to_string()), home.clone()),
            PathBuf::from("~/work")
        );
        assert_eq!(
            resolve_hermes_home(Some("/custom/hermes".to_string()), home),
            PathBuf::from("/custom/hermes")
        );
        // Unknown home dir falls back to ".".
        assert_eq!(
            resolve_hermes_home(None, None),
            PathBuf::from(".").join(".hermes")
        );
    }

    #[test]
    fn secs_f64_to_datetime_handles_fractional_and_invalid() {
        let dt = secs_f64_to_datetime(1_780_980_974.5);
        assert_eq!(dt.timestamp(), 1_780_980_974);
        assert_eq!(dt.timestamp_subsec_millis(), 500);

        // Invalid inputs must not panic.
        let _ = secs_f64_to_datetime(0.0);
        let _ = secs_f64_to_datetime(-1.0);
        let _ = secs_f64_to_datetime(f64::NAN);
        let _ = secs_f64_to_datetime(f64::INFINITY);
    }

    #[test]
    fn secs_f64_to_datetime_carries_rounding_overflow() {
        // A fraction that rounds to 1e9 nanoseconds must carry into the next
        // whole second rather than producing a leap second or falling back to now.
        let dt = secs_f64_to_datetime(1_000.999_999_999_9);
        assert_eq!(dt.timestamp(), 1_001);
        assert_eq!(dt.timestamp_subsec_nanos(), 0);
    }

    #[test]
    fn decode_plain_text_content() {
        let blocks = decode_hermes_content(Some("hello hermes"));
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "hello hermes"));
        assert!(decode_hermes_content(Some("   ")).is_empty());
        assert!(decode_hermes_content(None).is_empty());
    }

    #[test]
    fn decode_multimodal_content_text_and_image() {
        let raw = format!(
            "{CONTENT_JSON_PREFIX}{}",
            r#"[{"type":"text","text":"look:"},{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}]"#
        );
        let blocks = decode_hermes_content(Some(&raw));
        assert_eq!(blocks.len(), 2);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "look:"));
        assert!(matches!(
            &blocks[1],
            ContentBlock::Image { data, mime_type, uri }
            if data == "QUJD" && mime_type == "image/png" && uri.is_none()
        ));
    }

    #[test]
    fn decode_non_data_image_url_keeps_text_reference() {
        let raw = format!(
            "{CONTENT_JSON_PREFIX}{}",
            r#"[{"type":"image_url","image_url":{"url":"https://example.com/a.png"}}]"#
        );
        let blocks = decode_hermes_content(Some(&raw));
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "[image] https://example.com/a.png"));
    }

    #[test]
    fn decode_malformed_json_after_prefix_falls_back_to_text() {
        let raw = format!("{CONTENT_JSON_PREFIX}not json at all");
        let blocks = decode_hermes_content(Some(&raw));
        assert_eq!(blocks.len(), 1);
        assert!(matches!(&blocks[0], ContentBlock::Text { text } if text == "not json at all"));
    }

    /// v0.21.6 stores a literal message that starts with the sentinel as the
    /// sentinel plus a JSON string (what `json.dumps` writes for it). The
    /// literal below spells out a parts array; it must come back as that text,
    /// not as the parts it imitates.
    #[test]
    fn decode_an_escaped_sentinel_literal_as_its_text() {
        let literal = format!(r#"{CONTENT_JSON_PREFIX}[{{"type":"text","text":"smuggled"}}]"#);
        let stored = format!(
            "{CONTENT_JSON_PREFIX}{}",
            serde_json::to_string(&literal).unwrap()
        );
        let blocks = decode_hermes_content(Some(&stored));
        assert_eq!(blocks.len(), 1);
        assert!(
            matches!(&blocks[0], ContentBlock::Text { text } if text == r#"json:[{"type":"text","text":"smuggled"}]"#),
            "{blocks:?}"
        );
    }

    #[test]
    fn secs_f64_to_datetime_opt_rejects_what_the_fallback_would_call_now() {
        assert_eq!(
            secs_f64_to_datetime_opt(1_780_980_974.5).map(|dt| dt.timestamp()),
            Some(1_780_980_974)
        );
        for unusable in [0.0, -1.0, f64::NAN, f64::INFINITY, 8.4e252] {
            assert_eq!(secs_f64_to_datetime_opt(unusable), None, "{unusable}");
        }
    }

    #[test]
    fn normalize_tool_arguments_string_vs_object() {
        assert_eq!(
            normalize_tool_arguments(&serde_json::json!("{\"a\":1}")),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(
            normalize_tool_arguments(&serde_json::json!({"a": 1})),
            Some("{\"a\":1}".to_string())
        );
        assert_eq!(normalize_tool_arguments(&serde_json::Value::Null), None);
        assert_eq!(normalize_tool_arguments(&serde_json::json!("  ")), None);
    }

    #[test]
    fn parse_tool_calls_extracts_id_name_args() {
        let raw = r#"[
            {"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\"path\":\"a.txt\"}"}},
            {"id":"call_2","type":"function","function":{"name":"patch","arguments":{"path":"b.txt"}}}
        ]"#;
        let calls = parse_hermes_tool_calls(raw);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0.as_deref(), Some("call_1"));
        assert_eq!(calls[0].1, "read_file");
        assert_eq!(calls[0].2.as_deref(), Some("{\"path\":\"a.txt\"}"));
        assert_eq!(calls[1].1, "patch");
        assert_eq!(calls[1].2.as_deref(), Some("{\"path\":\"b.txt\"}"));

        assert!(parse_hermes_tool_calls("not json").is_empty());
        assert!(parse_hermes_tool_calls("{}").is_empty());
    }

    #[test]
    fn content_to_text_reduces_multimodal_to_text() {
        let raw = format!(
            "{CONTENT_JSON_PREFIX}{}",
            r#"[{"type":"text","text":"out"},{"type":"image_url","image_url":{"url":"data:image/png;base64,QUJD"}}]"#
        );
        assert_eq!(content_to_text(Some(&raw)).as_deref(), Some("out\n[image]"));
        assert_eq!(content_to_text(Some("plain")).as_deref(), Some("plain"));
        assert_eq!(content_to_text(Some("  ")), None);
        assert_eq!(content_to_text(None), None);
    }

    /// #948: built with an agent's launch env, the parser reads where THAT
    /// env puts the agent's files, not where codeg's own environment does.
    #[test]
    fn for_env_reads_the_home_of_the_launch_env() {
        // Trimmed like Hermes' own `get_hermes_home`, then taken verbatim.
        let env = AgentEnv::with_overrides(&[("HERMES_HOME", " /relocated/hermes ")]);
        assert_eq!(
            HermesParser::for_env(&env).base_dir,
            PathBuf::from("/relocated/hermes")
        );
    }
}
