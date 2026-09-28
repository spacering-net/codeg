use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use chrono::{DateTime, TimeZone, Utc};
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, QueryResult,
    Statement,
};

use crate::models::*;
use crate::parsers::{folder_name_from_path, truncate_str, AgentParser, ParseError};

pub struct OpenCodeParser {
    base_dir: PathBuf,
}

impl Default for OpenCodeParser {
    fn default() -> Self {
        Self::new()
    }
}

impl OpenCodeParser {
    pub fn new() -> Self {
        let base_dir = resolve_opencode_base_dir();
        Self { base_dir }
    }

    /// Test-only constructor that lets callers point the parser at a fixture
    /// directory containing an `opencode.db` SQLite file.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn sqlite_db_path(&self) -> PathBuf {
        self.base_dir.join("opencode.db")
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

    fn parse_sqlite_summary_row(row: &QueryResult) -> Result<ConversationSummary, ParseError> {
        let id: String = row.try_get("", "id")?;
        let directory: Option<String> = row.try_get("", "directory")?;
        let parent_id: Option<String> = row.try_get("", "parent_id")?;
        let title: Option<String> = row.try_get("", "title")?;
        let first_user_text: Option<String> = row.try_get("", "first_user_text")?;
        let created_ms: i64 = row.try_get("", "created_ms")?;
        let updated_ms: i64 = row.try_get("", "updated_ms")?;
        let message_count_i64: i64 = row.try_get("", "message_count")?;
        let model: Option<String> = row.try_get("", "model")?;

        let folder_path = normalize_optional_string(directory);
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        let message_count = if message_count_i64 <= 0 {
            0
        } else {
            u32::try_from(message_count_i64).unwrap_or(u32::MAX)
        };

        Ok(ConversationSummary {
            id,
            agent_type: AgentType::OpenCode,
            folder_path,
            folder_name,
            title: resolve_title(title, first_user_text),
            started_at: millis_to_datetime(created_ms),
            ended_at: (updated_ms > 0).then(|| millis_to_datetime(updated_ms)),
            message_count,
            model: normalize_optional_string(model),
            git_branch: None,
            // A `task` tool call runs its sub-agent in its own session row,
            // linked by `parent_id`. Dropping it listed every delegated
            // sub-agent alongside the real conversations instead of nesting it
            // under the one that spawned it.
            parent_id: normalize_optional_string(parent_id),
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }

    async fn list_conversations_from_sqlite(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let conn = self.open_sqlite_connection().await?;

        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                format!(
                    r#"
                SELECT
                    s.id AS id,
                    s.directory AS directory,
                    s.parent_id AS parent_id,
                    s.title AS title,
                    {FIRST_USER_TEXT_SQL},
                    s.time_created AS created_ms,
                    s.time_updated AS updated_ms,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM message m
                        WHERE m.session_id = s.id
                    ), 0) AS message_count,
                    (
                        SELECT json_extract(m2.data, '$.modelID')
                        FROM message m2
                        WHERE m2.session_id = s.id
                          AND json_extract(m2.data, '$.role') = 'assistant'
                        ORDER BY m2.time_created DESC
                        LIMIT 1
                    ) AS model
                FROM session s
                ORDER BY s.time_created DESC
                "#
                ),
            ))
            .await?;

        let mut conversations = Vec::with_capacity(rows.len());
        for row in rows {
            let summary = Self::parse_sqlite_summary_row(&row)?;
            if summary.message_count == 0 {
                continue;
            }
            conversations.push(summary);
        }

        Ok(conversations)
    }

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
                    s.directory AS directory,
                    s.parent_id AS parent_id,
                    s.title AS title,
                    {FIRST_USER_TEXT_SQL},
                    s.time_created AS created_ms,
                    s.time_updated AS updated_ms,
                    COALESCE((
                        SELECT COUNT(*)
                        FROM message m
                        WHERE m.session_id = s.id
                    ), 0) AS message_count,
                    (
                        SELECT json_extract(m2.data, '$.modelID')
                        FROM message m2
                        WHERE m2.session_id = s.id
                          AND json_extract(m2.data, '$.role') = 'assistant'
                        ORDER BY m2.time_created DESC
                        LIMIT 1
                    ) AS model
                FROM session s
                WHERE s.id = ?
                LIMIT 1
                "#
                ),
                [conversation_id.into()],
            ))
            .await?;

        row.map(|r| Self::parse_sqlite_summary_row(&r)).transpose()
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

        let messages = self.load_sqlite_messages(&conn, conversation_id).await?;
        let mut turns = group_into_turns(messages);
        super::relocate_orphaned_tool_results(&mut turns);
        super::structurize_read_tool_output(&mut turns);
        super::resolve_patch_line_numbers(&mut turns, summary.folder_path.as_deref());
        // OpenCode stamps `time.created` / `time.completed` on assistant
        // messages itself; this only covers ones written with no completion.
        super::backfill_turn_durations(&mut turns, &[]);
        let context_window_used_tokens = super::latest_turn_total_usage_tokens(&turns);
        let context_window_max_tokens =
            super::infer_context_window_max_tokens(summary.model.as_deref());
        let session_stats = super::merge_context_window_stats(
            super::compute_session_stats(&turns),
            context_window_used_tokens,
            context_window_max_tokens,
        );

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }

    async fn load_sqlite_messages(
        &self,
        conn: &DatabaseConnection,
        conversation_id: &str,
    ) -> Result<Vec<UnifiedMessage>, ParseError> {
        let rows = conn
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                r#"
                SELECT id, time_created, data
                FROM message
                WHERE session_id = ?
                ORDER BY time_created ASC, id ASC
                "#,
                [conversation_id.into()],
            ))
            .await?;

        // Pre-scan: collect all subagent session IDs from task tool parts so we
        // can batch-load their tool calls in a single query instead of N queries.
        let subagent_session_ids = self.scan_subagent_session_ids(conn, conversation_id).await;
        let subagent_tools = batch_load_subagent_tool_calls(conn, &subagent_session_ids).await;

        let mut messages = Vec::with_capacity(rows.len());

        for row in rows {
            let msg_id: String = row.try_get("", "id")?;
            let row_time_created: i64 = row.try_get("", "time_created")?;
            let data_raw: String = row.try_get("", "data")?;

            let value: serde_json::Value = match serde_json::from_str(&data_raw) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let role = match value.get("role").and_then(|r| r.as_str()) {
                Some("user") => MessageRole::User,
                Some("assistant") => MessageRole::Assistant,
                Some("system") => MessageRole::System,
                Some("tool") => MessageRole::Tool,
                _ => continue,
            };

            let created_ms = value
                .get("time")
                .and_then(|t| t.get("created"))
                .and_then(|c| c.as_i64())
                .unwrap_or(row_time_created);
            let timestamp = millis_to_datetime(created_ms);

            let is_assistant = matches!(role, MessageRole::Assistant);
            let msg_model = if is_assistant {
                value
                    .get("modelID")
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            } else {
                None
            };

            let (mut content_blocks, usage_from_step_finish) = self
                .load_sqlite_parts(conn, &msg_id, &subagent_tools)
                .await?;

            // A turn the provider rejected (or the user cancelled) leaves its
            // only record in the message's `error` — the parts are empty or cut
            // off mid-write — so without this the assistant bubble was blank
            // with no hint that anything went wrong. 83 of the 2 849 messages in
            // a real 430-session library carry one (48 aborts, 25 API errors).
            if is_assistant {
                if let Some(error) = assistant_error_text(&value) {
                    content_blocks.push(ContentBlock::Text { text: error });
                }
            }

            // A user message whose every part was synthetic (a plan/build switch
            // reminder, the post-compaction continuation) is not a turn the user
            // took — OpenCode's own prompt builder makes the same exclusion
            // (`!m.parts.every(p => p.synthetic)`). Dropping it here keeps the
            // now-empty bubble out of the transcript. Assistant messages are
            // left alone: an empty one is still a turn that happened, and the
            // error text above usually fills it.
            if matches!(role, MessageRole::User) && content_blocks.is_empty() {
                continue;
            }

            // OpenCode files the compaction boundary under a synthetic USER
            // message (its continuation prompt is what resumes the turn), but a
            // compaction is the system's act, not the user's — and the shared
            // divider only hoists out of an assistant group
            // (`compactionOnlyMeta` in `message-list-view.tsx`). Left as a user
            // turn it renders as a tool card inside a user bubble instead of the
            // subtle "context compacted" row every other agent gets. Scoped to a
            // message that carries NOTHING else, which is how OpenCode writes it.
            let role = if matches!(role, MessageRole::User) && is_compaction_only(&content_blocks) {
                MessageRole::Assistant
            } else {
                role
            };

            let usage = if is_assistant {
                extract_opencode_usage(&value).or(usage_from_step_finish)
            } else {
                None
            };

            let completed_ms = if is_assistant {
                value
                    .get("time")
                    .and_then(|t| t.get("completed"))
                    .and_then(|c| c.as_i64())
            } else {
                None
            };
            let duration_ms = match completed_ms {
                Some(done) if done > created_ms => Some((done - created_ms) as u64),
                _ => None,
            };
            // OpenCode is the only parser whose `timestamp` is the message
            // creation time; for assistants the real completion is the
            // explicit `time.completed` millisecond. Reject values that
            // aren't strictly after `created_ms` (zero, partial writes,
            // clock skew) — those would render as 1970 or before the start.
            // Fall back to the creation timestamp in that case.
            let completed_at = match completed_ms {
                Some(done) if done > created_ms => Some(millis_to_datetime(done)),
                _ => Some(timestamp),
            };

            messages.push(UnifiedMessage {
                id: msg_id,
                role,
                content: content_blocks,
                timestamp,
                usage,
                duration_ms,
                model: msg_model,
                completed_at,
            agent_message_id: None,
            });
        }

        Ok(messages)
    }

    /// Scan all tool parts in this conversation to extract subagent session IDs.
    async fn scan_subagent_session_ids(
        &self,
        conn: &DatabaseConnection,
        conversation_id: &str,
    ) -> Vec<String> {
        let rows = match conn
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                r#"
                SELECT DISTINCT json_extract(p.data, '$.state.metadata.sessionId') AS sid
                FROM part p
                INNER JOIN message m ON m.id = p.message_id
                WHERE m.session_id = ?
                  AND json_extract(p.data, '$.type') = 'tool'
                  AND json_extract(p.data, '$.tool') = 'task'
                  AND json_extract(p.data, '$.state.input.subagent_type') IS NOT NULL
                  AND sid IS NOT NULL
                "#,
                [conversation_id.into()],
            ))
            .await
        {
            Ok(r) => r,
            Err(_) => return Vec::new(),
        };

        rows.iter()
            .filter_map(|row| row.try_get::<String>("", "sid").ok())
            .collect()
    }

    async fn load_sqlite_parts(
        &self,
        conn: &DatabaseConnection,
        message_id: &str,
        subagent_tools: &HashMap<String, Vec<AgentToolCall>>,
    ) -> Result<(Vec<ContentBlock>, Option<TurnUsage>), ParseError> {
        let rows = conn
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                r#"
                SELECT id, data
                FROM part
                WHERE message_id = ?
                ORDER BY time_created ASC, id ASC
                "#,
                [message_id.into()],
            ))
            .await?;

        let mut blocks = Vec::new();
        let mut usage_from_step_finish: Option<TurnUsage> = None;

        for row in rows {
            let part_id: String = row.try_get("", "id")?;
            let data_raw: String = row.try_get("", "data")?;
            let value: serde_json::Value = match serde_json::from_str(&data_raw) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let part_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            match part_type {
                // `synthetic` marks text OpenCode injected for the model, not
                // words anyone typed: plan/build switch reminders, the
                // post-compaction "continue" prompt, sub-agent recap requests,
                // "The following tool was executed by the user". Its ACP adapter
                // labels them `annotations.audience: ["assistant"]` and its own
                // CLI filters them out of the transcript (`!part.synthetic` in
                // `cli/cmd/run/session.shared.ts`); rendering them as the user's
                // prose put whole system prompts in the user's bubble. The
                // caller drops a user message that has nothing left.
                "text" if value.get("synthetic").and_then(|v| v.as_bool()) == Some(true) => {}
                "text" => {
                    if let Some(text) = value
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
                // A context compaction, as the provider-neutral tool pair every
                // agent's compaction renders through (`_meta.contextCompaction`
                // on a ToolUse plus its settled ToolResult — see
                // `parsers::pi::parse_compaction`). OpenCode writes it as the
                // ONLY part of a synthetic user message, so without this the
                // compaction showed up as an empty user bubble and the
                // conversation appeared to lose its middle for no reason.
                //
                // `auto` is OpenCode's own flag for "the context filled up"
                // versus a `/compact` the user ran; `overflow` (optional) marks
                // the compaction that ran because the provider rejected the
                // request outright.
                "compaction" => {
                    let mut marker = serde_json::Map::new();
                    marker.insert("version".to_string(), serde_json::Value::from(1));
                    let auto = value.get("auto").and_then(|v| v.as_bool()).unwrap_or(false);
                    marker.insert(
                        "trigger".to_string(),
                        serde_json::Value::from(if auto { "automatic" } else { "manual" }),
                    );
                    if let Some(overflow) = value.get("overflow").and_then(|v| v.as_bool()) {
                        marker.insert("overflow".to_string(), serde_json::Value::from(overflow));
                    }
                    blocks.push(ContentBlock::ToolUse {
                        tool_use_id: Some(part_id.clone()),
                        tool_name: "context_compaction".to_string(),
                        input_preview: None,
                        status: None,
                        meta: Some(serde_json::Value::Object(
                            [("contextCompaction".to_string(), serde_json::Value::Object(marker))]
                                .into_iter()
                                .collect(),
                        )),
                    });
                    // The pair is required: a ToolUse with no result reads as a
                    // call still running.
                    blocks.push(ContentBlock::ToolResult {
                        tool_use_id: Some(part_id),
                        output_preview: None,
                        is_error: false,
                        agent_stats: None,
                        images: Vec::new(),
                    });
                }
                // A slash command that targets a sub-agent is recorded as a
                // `subtask` part INSTEAD of the expanded prompt text the
                // non-sub-agent branch writes (`session/prompt.ts`'s command
                // handler), so the user's turn rendered completely blank.
                //
                // Rendered as prose rather than an Agent card on purpose: the
                // sub-agent's own run is a separate session and its work shows
                // up through the assistant side, so a card here would either sit
                // unsettled forever or duplicate one. This is the user's half —
                // which command they ran, which agent it went to, and the prompt
                // it expanded into.
                "subtask" => {
                    if let Some(line) = subtask_summary(&value) {
                        blocks.push(ContentBlock::Text { text: line });
                    }
                }
                "reasoning" => {
                    if let Some(text) = value
                        .get("text")
                        .and_then(|t| t.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        blocks.push(ContentBlock::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
                "tool" => {
                    let raw_tool_name = value
                        .get("tool")
                        .and_then(|t| t.as_str())
                        .unwrap_or("unknown");

                    let call_id = value
                        .get("callID")
                        .and_then(|c| c.as_str())
                        .map(|s| s.to_string());

                    let state = value.get("state");
                    let status = state
                        .and_then(|s| s.get("status"))
                        .and_then(|s| s.as_str())
                        .unwrap_or("");

                    let state_input = state.and_then(|s| s.get("input"));
                    let is_agent_task = raw_tool_name == "task"
                        && state_input
                            .and_then(|i| i.get("subagent_type"))
                            .and_then(|v| v.as_str())
                            .is_some();

                    if is_agent_task {
                        // Transform task tool into Agent card
                        let subagent_type = state_input
                            .and_then(|i| i.get("subagent_type"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("agent");
                        let prompt = state_input
                            .and_then(|i| i.get("prompt"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let description = state
                            .and_then(|s| s.get("title"))
                            .and_then(|v| v.as_str())
                            .or_else(|| {
                                state_input
                                    .and_then(|i| i.get("description"))
                                    .and_then(|v| v.as_str())
                            })
                            .unwrap_or("");

                        let metadata = state.and_then(|s| s.get("metadata"));
                        let model_id = metadata
                            .and_then(|m| m.get("model"))
                            .and_then(|m| m.get("modelID"))
                            .and_then(|v| v.as_str());
                        let session_id = metadata
                            .and_then(|m| m.get("sessionId"))
                            .and_then(|v| v.as_str());

                        let mut agent_input = serde_json::json!({
                            "subagent_type": subagent_type,
                            "description": description,
                            "prompt": prompt,
                        });
                        if let Some(model) = model_id {
                            agent_input["model"] = serde_json::Value::String(model.to_string());
                        }

                        blocks.push(ContentBlock::ToolUse {
                            tool_use_id: call_id.clone(),
                            tool_name: "Agent".to_string(),
                            input_preview: Some(agent_input.to_string()),
                            status: None,
                            meta: None,
                        });

                        // A sub-agent that failed carries `state.error` and no
                        // `state.output`; without the fallback the Agent card
                        // showed nothing at all for the failure.
                        let output_preview = state
                            .and_then(|s| s.get("output"))
                            .and_then(|v| value_to_preview(Some(v)))
                            .map(|s| extract_task_result_content(&s))
                            .or_else(|| pick_str(state, &["error"]).map(str::to_string));

                        // Compute duration from time fields
                        let time = state.and_then(|s| s.get("time"));
                        let start_ms = time.and_then(|t| t.get("start")).and_then(|v| v.as_i64());
                        let end_ms = time.and_then(|t| t.get("end")).and_then(|v| v.as_i64());
                        let duration_ms = match (start_ms, end_ms) {
                            (Some(s), Some(e)) if e > s => Some((e - s) as u64),
                            _ => None,
                        };

                        // Look up pre-fetched sub-agent tool calls
                        let tool_calls = session_id
                            .and_then(|sid| subagent_tools.get(sid))
                            .cloned()
                            .unwrap_or_default();

                        let tool_count = tool_calls.len() as u32;
                        let agent_stats = Some(AgentExecutionStats {
                            agent_type: Some(subagent_type.to_string()),
                            status: Some(status.to_string()),
                            total_duration_ms: duration_ms,
                            total_tokens: None,
                            total_tool_use_count: if tool_count > 0 {
                                Some(tool_count)
                            } else {
                                None
                            },
                            read_count: None,
                            search_count: None,
                            bash_count: None,
                            edit_file_count: None,
                            lines_added: None,
                            lines_removed: None,
                            other_tool_count: None,
                            tool_calls,
                            // OpenCode's sub-agent transcript is already folded
                            // into this stats block; there is no separate
                            // session for the card to open.
                            child_session_id: None,
                        });

                        let has_error_field = state.and_then(|s| s.get("error")).is_some();
                        blocks.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            output_preview,
                            is_error: is_error_status(status) || has_error_field,
                            agent_stats,
                            images: Vec::new(),
                        });
                    } else {
                        let normalized = normalize_tool_call(raw_tool_name, state);

                        blocks.push(ContentBlock::ToolUse {
                            tool_use_id: call_id.clone(),
                            tool_name: normalized.tool_name,
                            input_preview: normalized.input_preview,
                            status: None,
                            meta: None,
                        });

                        blocks.push(ContentBlock::ToolResult {
                            tool_use_id: call_id,
                            output_preview: normalized.output_preview,
                            // Authoritative: `normalize_tool_call` folds the
                            // state's own status in, and a couple of tools
                            // override it in both directions (`invalid`
                            // completes "successfully" but IS a failure; a
                            // dismissed `question` unwinds through the error
                            // channel but is an outcome, not a failure).
                            is_error: normalized.is_error,
                            agent_stats: None,
                            images: Vec::new(),
                        });
                    }
                }
                "file" => {
                    if let Some(image_block) = extract_opencode_file_image(&value) {
                        blocks.push(image_block);
                    } else if let Some(file_ref) = extract_file_reference(&value) {
                        blocks.push(ContentBlock::Text {
                            text: format!("@{}", file_ref),
                        });
                    }
                }
                // `patch` records the snapshot diff OpenCode took across a
                // step; it always restates files the `edit`/`write` calls in
                // the same turn already show, with absolute paths. OpenCode's
                // own UI filters it out of the transcript alongside
                // `step-start`/`step-finish`, so rendering it as assistant
                // prose ("Applied patch: /abs/path") was pure noise.
                "patch" => {}
                "step-finish" => {
                    // Keep the LAST step-finish: a message can contain several
                    // steps, and OpenCode restates the message's running total
                    // on each one, so the first is the least complete.
                    if let Some(usage) = value
                        .get("tokens")
                        .and_then(extract_opencode_usage_from_tokens)
                    {
                        usage_from_step_finish = Some(usage);
                    }
                }
                _ => {}
            }
        }

        Ok((blocks, usage_from_step_finish))
    }
}

impl AgentParser for OpenCodeParser {
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

pub(crate) fn resolve_opencode_base_dir() -> PathBuf {
    resolve_xdg_data_home(std::env::var_os("XDG_DATA_HOME"), dirs::home_dir())
        .map(|xdg_data_home| xdg_data_home.join("opencode"))
        .unwrap_or_else(|| PathBuf::from("opencode"))
}

fn resolve_xdg_data_home(
    xdg_data_home_env: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    xdg_data_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| home_dir.map(|home| home.join(".local").join("share")))
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

/// The first words the user actually typed in a session, used to stand in for
/// OpenCode's placeholder title (see [`resolve_title`]).
///
/// A correlated subquery rather than a join, so the listing stays a single
/// statement; the `CASE` guard keeps it from running at all for the sessions
/// that already carry a real title — which, on a healthy install, is most of
/// them. `synthetic` parts are excluded for the same reason the transcript
/// drops them: they are text OpenCode injected for the model, not words anyone
/// typed, and a session that opens with one would otherwise be named after a
/// plan/build switch reminder.
const FIRST_USER_TEXT_SQL: &str = r#"CASE
                        WHEN s.title LIKE 'New session - %'
                          OR s.title LIKE 'Child session - %' THEN (
                            SELECT json_extract(p.data, '$.text')
                            FROM message um
                            JOIN part p ON p.message_id = um.id
                            WHERE um.session_id = s.id
                              AND json_extract(um.data, '$.role') = 'user'
                              AND json_extract(p.data, '$.type') = 'text'
                              AND COALESCE(json_extract(p.data, '$.synthetic'), 0) = 0
                              AND TRIM(COALESCE(json_extract(p.data, '$.text'), '')) <> ''
                            ORDER BY um.time_created ASC, um.id ASC,
                                     p.time_created ASC, p.id ASC
                            LIMIT 1
                        )
                    END AS first_user_text"#;

/// OpenCode names a session at creation time, before anyone has said anything:
/// `title: q.title ?? (q.parentID ? "Child session - " : "New session - ") +
/// new Date().toISOString()`. A real title is supposed to replace it on the
/// first turn (`SessionPrompt.ensureTitle` asks the `title` agent for one), but
/// that call is forked and its failures swallowed (`.pipe(ignore, forkIn)`), so
/// whenever the small model is unreachable the placeholder is simply what the
/// session is called forever — 243 of the 432 sessions in the author's store.
const DEFAULT_TITLE_PREFIXES: [&str; 2] = ["New session - ", "Child session - "];

/// Whether `title` is one of OpenCode's placeholders. Mirrors its own
/// `Session.isDefaultTitle`, which anchors the timestamp exactly:
/// `^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`.
/// Matching the full shape rather than just the prefix is what keeps a session
/// the user deliberately named "New session - notes" out of the fallback.
fn is_default_title(title: &str) -> bool {
    DEFAULT_TITLE_PREFIXES
        .iter()
        .any(|prefix| title.strip_prefix(prefix).is_some_and(is_iso_instant))
}

/// Whether `value` has the exact shape `new Date().toISOString()` produces.
fn is_iso_instant(value: &str) -> bool {
    // `0` stands for "any ASCII digit"; every other byte must match literally.
    const SHAPE: &[u8] = b"0000-00-00T00:00:00.000Z";
    let bytes = value.as_bytes();
    bytes.len() == SHAPE.len()
        && bytes.iter().zip(SHAPE).all(|(byte, slot)| match slot {
            b'0' => byte.is_ascii_digit(),
            _ => byte == slot,
        })
}

/// Split OpenCode's fork marker off a title. Forking renames `<title>` to
/// `<title> (fork #1)` and `<title> (fork #N)` to `<title> (fork #N+1)`, which
/// means a fork of an unnamed session inherits the placeholder with a suffix —
/// a string OpenCode's own `isDefaultTitle` no longer recognises. Peeling the
/// marker lets the fallback see the placeholder underneath, and re-attaching it
/// keeps the one genuinely meaningful part: which fork this is.
fn split_fork_suffix(title: &str) -> (&str, &str) {
    const MARKER: &str = " (fork #";
    let Some(without_paren) = title.strip_suffix(')') else {
        return (title, "");
    };
    let Some(at) = without_paren.rfind(MARKER) else {
        return (title, "");
    };
    let number = &without_paren[at + MARKER.len()..];
    if number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()) {
        return (title, "");
    }
    (&title[..at], &title[at..])
}

/// Resolve what to call a session: its own title when it has one, otherwise the
/// opening user message — the same substitution OpenCode's TUI makes
/// (`if (title && !isDefaultTitle(title)) … else first non-empty message text`).
///
/// Falling back to `None` when there is nothing to derive from is deliberate:
/// the UI's own "untitled" label reads better than a machine placeholder, and
/// it is what every other agent's untitled session already shows.
fn resolve_title(title: Option<String>, first_user_text: Option<String>) -> Option<String> {
    let Some(title) = normalize_optional_string(title) else {
        return derived_title(first_user_text, "");
    };
    let (base, fork) = split_fork_suffix(&title);
    if !is_default_title(base) {
        return Some(title);
    }
    derived_title(first_user_text, fork)
}

fn derived_title(first_user_text: Option<String>, fork_suffix: &str) -> Option<String> {
    let text = normalize_optional_string(first_user_text)?;
    let derived = super::title_from_user_text(&text);
    if derived.is_empty() {
        return None;
    }
    Some(format!("{derived}{fork_suffix}"))
}

fn value_to_preview(value: Option<&serde_json::Value>) -> Option<String> {
    let v = value?;
    if v.is_null() {
        return None;
    }

    if let Some(s) = v.as_str() {
        let trimmed = s.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else {
        serde_json::to_string(v).ok()
    }
}

fn extract_file_reference(value: &serde_json::Value) -> Option<String> {
    value
        .get("source")
        .and_then(|s| s.get("path"))
        .and_then(|v| v.as_str())
        .or_else(|| value.get("filename").and_then(|v| v.as_str()))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

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

fn extract_opencode_file_image(value: &serde_json::Value) -> Option<ContentBlock> {
    let mime = value
        .get("mime")
        .or_else(|| value.get("mimeType"))
        .or_else(|| value.get("mime_type"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|m| !m.is_empty() && m.starts_with("image/"))
        .map(|s| s.to_string());

    let url = value
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let Some(raw_url) = url {
        if let Some((mime_type, data)) = parse_data_uri_image(raw_url) {
            let uri = value
                .get("filename")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            return Some(ContentBlock::Image {
                data,
                mime_type,
                uri,
            });
        }
    }

    let mime_type = mime?;
    let data = value
        .get("data")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())?;
    let uri = value
        .get("filename")
        .and_then(|v| v.as_str())
        .or_else(|| {
            value
                .get("source")
                .and_then(|s| s.get("path"))
                .and_then(|v| v.as_str())
        })
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    Some(ContentBlock::Image {
        data,
        mime_type,
        uri,
    })
}

/// One OpenCode tool call rewritten into codeg's shared tool vocabulary.
struct NormalizedToolCall {
    tool_name: String,
    input_preview: Option<String>,
    output_preview: Option<String>,
    is_error: bool,
}

/// First present, non-empty string among `keys`, trimmed. For labels only
/// (paths, names, error messages) — NEVER for source text, which must stay
/// byte-exact (see `pick_str_verbatim`).
fn pick_str<'a>(value: Option<&'a serde_json::Value>, keys: &[&str]) -> Option<&'a str> {
    let obj = value?;
    keys.iter().find_map(|key| {
        obj.get(*key)
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
    })
}

/// First present string among `keys`, byte-for-byte. For source text —
/// `oldString`/`newString`/`patchText` — where trimming corrupts the payload:
/// an indentation-only edit trims both sides to the same string and renders as
/// an empty diff with zero changed-line stats. An empty string is returned
/// as-is (an empty `oldString` is OpenCode's create-file form of `edit`).
fn pick_str_verbatim<'a>(value: Option<&'a serde_json::Value>, keys: &[&str]) -> Option<&'a str> {
    let obj = value?;
    keys.iter().find_map(|key| obj.get(*key).and_then(|v| v.as_str()))
}

/// Copy `value[from]` into `out[to]` verbatim when present and not null.
fn copy_field(
    out: &mut serde_json::Map<String, serde_json::Value>,
    value: Option<&serde_json::Value>,
    from: &str,
    to: &str,
) {
    if let Some(v) = value.and_then(|o| o.get(from)) {
        if !v.is_null() {
            out.insert(to.to_string(), v.clone());
        }
    }
}

fn insert_str(out: &mut serde_json::Map<String, serde_json::Value>, key: &str, value: &str) {
    out.insert(key.to_string(), serde_json::Value::String(value.to_string()));
}

/// Start line of the first hunk in a unified diff (`@@ -12,7 +12,8 @@` → 12).
///
/// OpenCode hands us the real patch it applied, so the Edit card can label its
/// hunks with true file line numbers instead of restarting at 1. This is the
/// same `_start_line` hint the live ACP path injects by re-reading the file
/// from disk (`acp/connection.rs::inject_start_line`) — here it is exact and
/// needs no filesystem access.
fn first_hunk_start_line(diff: &str) -> Option<u64> {
    diff.lines()
        .find(|line| line.starts_with("@@ -"))
        .and_then(|line| {
            let rest = line.strip_prefix("@@ -")?;
            let end = rest.find([',', ' '])?;
            rest.get(..end)?.parse::<u64>().ok()
        })
        .filter(|n| *n > 0)
}

/// Unwrap the `<skill_content name="…">…</skill_content>` envelope the `skill`
/// tool returns, keeping only the skill body. The envelope repeats the skill
/// name three ways and appends a base-directory blurb plus a sampled
/// `<skill_files>` listing — a wall of boilerplate in front of every skill
/// load. Returns the input unchanged when the envelope is absent.
fn unwrap_skill_content(raw: &str) -> String {
    let Some(open_end) = raw.find("<skill_content").and_then(|start| {
        raw[start..]
            .find('>')
            .map(|offset| start + offset + 1)
            .filter(|end| *end <= raw.len())
    }) else {
        return raw.to_string();
    };
    let close = raw[open_end..]
        .find("</skill_content>")
        .map(|i| open_end + i)
        .unwrap_or(raw.len());

    let mut body = raw[open_end..close].trim();
    if let Some(files_start) = body.find("\n<skill_files>") {
        body = body[..files_start].trim_end();
    }
    // Drop the trailing "Base directory for this skill: …" preamble block,
    // which is machine guidance rather than skill content.
    if let Some(base_dir) = body.find("\nBase directory for this skill:") {
        body = body[..base_dir].trim_end();
    }

    if body.is_empty() {
        raw.to_string()
    } else {
        body.to_string()
    }
}

/// Rewrite OpenCode's tool call into the canonical names and snake_case input
/// keys every renderer in codeg dispatches on (`file_path`, `old_string`,
/// `new_string`, `pattern`, …).
///
/// OpenCode names its tool arguments in camelCase (`filePath`, `oldString`),
/// so without this pass the dedicated cards found none of the fields they look
/// for: the Edit card rendered an empty diff, the Write/Read cards lost their
/// file path, and the changed-line tallies in `session-files.ts` came up zero.
/// Doing it here rather than in the renderer follows `parsers/cursor.rs`, which
/// likewise maps its agent's wire arguments onto the shared vocabulary.
fn normalize_tool_call(raw_tool: &str, state: Option<&serde_json::Value>) -> NormalizedToolCall {
    let input = state.and_then(|s| s.get("input"));
    let metadata = state.and_then(|s| s.get("metadata"));
    let name = raw_tool.trim().to_ascii_lowercase();

    // A failed call carries `state.error` and no `state.output`. Reading only
    // `output` left every failure rendering as an empty red card with no
    // indication of what went wrong.
    let error_text = pick_str(state, &["error"]).map(str::to_string);
    let raw_output = state
        .and_then(|s| s.get("output"))
        .and_then(|v| value_to_preview(Some(v)));
    // Folded in here rather than at the call site so this function is the
    // single source of truth: the arms below override the verdict in BOTH
    // directions (`invalid` completes "successfully" but is a failure; a
    // dismissed `question` unwinds through `state.error` but is an outcome).
    let mut is_error =
        error_text.is_some() || is_error_status(pick_str(state, &["status"]).unwrap_or(""));
    let mut output_preview = raw_output.clone().or_else(|| error_text.clone());

    let mut obj = serde_json::Map::new();
    let mut tool_name = raw_tool.to_string();
    let mut input_preview: Option<String> = None;

    match name.as_str() {
        "edit" => {
            // `filePath` is the long-standing argument; `path` is what the
            // rewritten (v2) edit tool takes. `metadata.filediff.file` is the
            // absolute path OpenCode resolved, used when neither is present.
            if let Some(path) = pick_str(input, &["filePath", "path", "file_path"]).or_else(|| {
                pick_str(
                    metadata.and_then(|m| m.get("filediff")),
                    &["file", "filePath"],
                )
            }) {
                insert_str(&mut obj, "file_path", path);
            }
            if let Some(old) = pick_str_verbatim(input, &["oldString", "old_string"]) {
                insert_str(&mut obj, "old_string", old);
            }
            if let Some(new) = pick_str_verbatim(input, &["newString", "new_string"]) {
                insert_str(&mut obj, "new_string", new);
            }
            copy_field(&mut obj, input, "replaceAll", "replace_all");
            copy_field(&mut obj, input, "replace_all", "replace_all");

            if let Some(start_line) = pick_str(metadata, &["diff"])
                .or_else(|| pick_str(metadata.and_then(|m| m.get("filediff")), &["patch"]))
                .and_then(first_hunk_start_line)
            {
                obj.insert("_start_line".to_string(), serde_json::json!(start_line));
            }
        }
        "write" => {
            tool_name = "write".to_string();
            if let Some(path) = pick_str(input, &["filePath", "path", "file_path"])
                .or_else(|| pick_str(metadata, &["filepath", "filePath"]))
            {
                insert_str(&mut obj, "file_path", path);
            }
            copy_field(&mut obj, input, "content", "content");
        }
        "read" => {
            tool_name = "read".to_string();
            if let Some(path) = pick_str(input, &["filePath", "path", "file_path"]) {
                insert_str(&mut obj, "file_path", path);
            }
            copy_field(&mut obj, input, "offset", "offset");
            copy_field(&mut obj, input, "limit", "limit");
            if let Some(structured) = structure_read_output(metadata) {
                output_preview = Some(structured);
            }
        }
        "bash" => {
            tool_name = "bash".to_string();
            copy_field(&mut obj, input, "command", "command");
            copy_field(&mut obj, input, "description", "description");
            // A command that only writes to stderr leaves `state.output`
            // empty while `metadata.output` still holds the combined stream.
            if output_preview.is_none() {
                output_preview = pick_str(metadata, &["output"]).map(str::to_string);
            }
        }
        "grep" => {
            tool_name = "grep".to_string();
            copy_field(&mut obj, input, "pattern", "pattern");
            copy_field(&mut obj, input, "path", "path");
            // OpenCode calls the file filter `include`; every renderer and the
            // `glob`-vs-`grep` classifier read it as `glob` (see cursor.rs).
            copy_field(&mut obj, input, "include", "glob");
            copy_field(&mut obj, input, "limit", "limit");
        }
        "glob" => {
            tool_name = "glob".to_string();
            copy_field(&mut obj, input, "pattern", "pattern");
            copy_field(&mut obj, input, "path", "path");
            copy_field(&mut obj, input, "limit", "limit");
        }
        // The v1 `patch` tool and the v2 `apply_patch` tool both take one
        // freeform patch document. The Apply-Patch card takes that text
        // directly, not a JSON envelope.
        "patch" | "apply_patch" => {
            tool_name = "apply_patch".to_string();
            // Verbatim: patch text is source material — context lines begin
            // with a significant leading space.
            input_preview = pick_str_verbatim(input, &["patchText", "patch_text", "patch"])
                .filter(|s| !s.trim().is_empty())
                .map(str::to_string)
                .or_else(|| input.and_then(|v| value_to_preview(Some(v))));
        }
        "skill" => {
            tool_name = "skill".to_string();
            if let Some(skill) = pick_str(input, &["name", "skill"])
                .or_else(|| pick_str(metadata, &["name", "skill"]))
            {
                // `skill` is the field the card titles itself from; `name` is
                // kept so the raw argument still shows in the generic view.
                insert_str(&mut obj, "skill", skill);
                insert_str(&mut obj, "name", skill);
            }
            if let Some(raw) = raw_output.as_deref() {
                output_preview = Some(unwrap_skill_content(raw));
            }
        }
        // OpenCode substitutes the `invalid` tool when the model calls a tool
        // with arguments that fail schema validation. It completes
        // successfully from OpenCode's point of view, so nothing downstream
        // would flag it without this.
        "invalid" => {
            tool_name = "invalid".to_string();
            copy_field(&mut obj, input, "tool", "tool");
            copy_field(&mut obj, input, "error", "error");
            is_error = true;
        }
        "webfetch" => {
            tool_name = "webfetch".to_string();
            copy_field(&mut obj, input, "url", "url");
            copy_field(&mut obj, input, "format", "format");
        }
        "websearch" => {
            tool_name = "websearch".to_string();
            copy_field(&mut obj, input, "query", "query");
        }
        "question" => {
            tool_name = "question".to_string();
            input_preview = normalize_question_input(input);
            if let Some(structured) =
                structure_question_output(input, metadata, error_text.as_deref())
            {
                output_preview = Some(structured);
                // Dismissing a question is an outcome, not a tool failure —
                // OpenCode only reports it through `state.error` because the
                // tool has to unwind. The card renders "declined" from the
                // envelope; flagging the result as an error on top of that
                // would show a red failure card instead.
                is_error = false;
            }
        }
        // Already canonical (`todowrite` → `{todos}`, MCP and `lsp_*` tools
        // carry server-defined shapes).
        _ => {
            input_preview = input.and_then(|v| value_to_preview(Some(v)));
        }
    }

    if input_preview.is_none() {
        input_preview = if obj.is_empty() {
            input.and_then(|v| value_to_preview(Some(v)))
        } else {
            Some(serde_json::Value::Object(obj).to_string())
        };
    }

    NormalizedToolCall {
        tool_name,
        input_preview,
        output_preview,
        is_error,
    }
}

/// Rebuild a `read` result from `state.metadata.display`.
///
/// `state.output` wraps the file in `<path>`/`<type>`/`<content>` tags and
/// prefixes every line with `N: `. `parsers::strip_numbered_lines` only knows
/// the `→`/tab delimiters, so the envelope and the prefixes both survived into
/// the card. `display` carries the same content already clean, plus the true
/// first line number, which is exactly the `{start_line, content}` shape the
/// shared read-output structurizer produces for the other agents.
///
/// Shared with the LIVE path (`acp::connection::opencode_live_tool_output`):
/// OpenCode's completion frame ships the same `metadata` under `rawOutput`, so
/// both halves hand the Read card the identical payload and a reload no longer
/// changes how a finished `read` renders. `metadata.display` is unique to the
/// `read` tool, which is what makes it safe to key on the shape alone.
pub(crate) fn structure_read_output(metadata: Option<&serde_json::Value>) -> Option<String> {
    let display = metadata?.get("display")?;
    match display.get("type").and_then(|v| v.as_str())? {
        "file" => {
            let text = display.get("text").and_then(|v| v.as_str())?;
            let start_line = display
                .get("lineStart")
                .and_then(|v| v.as_u64())
                .filter(|n| *n > 0)
                .unwrap_or(1);
            Some(
                serde_json::json!({ "start_line": start_line, "content": text })
                    .to_string(),
            )
        }
        "directory" => {
            let entries: Vec<&str> = display
                .get("entries")?
                .as_array()?
                .iter()
                .filter_map(|e| e.as_str())
                .collect();
            (!entries.is_empty()).then(|| entries.join("\n"))
        }
        _ => None,
    }
}

/// Whether `blocks` is nothing but the compaction divider pair this parser
/// synthesizes for a `compaction` part — the test that decides whether a
/// message gets re-filed from user to assistant (see the call site).
fn is_compaction_only(blocks: &[ContentBlock]) -> bool {
    let mut saw_compaction = false;
    for block in blocks {
        match block {
            ContentBlock::ToolUse { tool_name, .. } if tool_name == "context_compaction" => {
                saw_compaction = true;
            }
            // The paired result carries no name of its own; it is only ever
            // emitted beside the ToolUse above.
            ContentBlock::ToolResult { .. } => {}
            _ => return false,
        }
    }
    saw_compaction
}

/// The failure notice for an assistant message OpenCode settled with an
/// `error`, or `None` for a turn that finished normally.
///
/// OpenCode's `AssistantMessage.error` is a named-error envelope —
/// `{name, data: {message, …}}` — covering both provider failures
/// (`APIError`, `ProviderAuthError`, `ContextOverflowError`,
/// `MessageOutputLengthError`, `UnknownError`) and the user pressing stop
/// (`MessageAbortedError`). The parts of such a message are empty or
/// half-written, so the fact that it errored is itself the thing worth showing —
/// otherwise a rejected request is indistinguishable from a turn that simply
/// said nothing. Same shape as `parsers::pi::assistant_error_text`.
///
/// An abort is reported as an abort rather than an error: OpenCode fills its
/// `message` with boilerplate ("The operation was aborted.") that says less than
/// the name does.
fn assistant_error_text(message: &serde_json::Value) -> Option<String> {
    let error = message.get("error")?;
    let name = pick_str(Some(error), &["name"]).unwrap_or("UnknownError");
    if name == "MessageAbortedError" {
        return Some("[opencode aborted]".to_string());
    }
    Some(match pick_str(error.get("data"), &["message"]) {
        Some(detail) => format!("[opencode {name}] {}", truncate_str(detail, 2000)),
        None => format!("[opencode {name}]"),
    })
}

/// One-line header plus body for a `subtask` part: the command the user ran,
/// the sub-agent it was routed to, and the prompt it expanded into.
///
/// `command` and `description` are both optional in the schema, so the header
/// degrades to whichever parts exist; with none of the three fields present
/// there is nothing worth showing and the part is dropped.
fn subtask_summary(value: &serde_json::Value) -> Option<String> {
    let agent = pick_str(Some(value), &["agent"]);
    let command = pick_str(Some(value), &["command"]);
    let description = pick_str(Some(value), &["description"]);
    let prompt = pick_str(Some(value), &["prompt"]);

    let mut header = String::new();
    if let Some(command) = command {
        header.push('/');
        header.push_str(command);
    }
    if let Some(agent) = agent {
        if !header.is_empty() {
            header.push_str(" → ");
        }
        header.push('@');
        header.push_str(agent);
    }
    if let Some(description) = description {
        if !header.is_empty() {
            header.push_str(": ");
        }
        header.push_str(description);
    }

    match (header.is_empty(), prompt) {
        (true, None) => None,
        (true, Some(prompt)) => Some(prompt.to_string()),
        (false, None) => Some(header),
        (false, Some(prompt)) => Some(format!("{header}\n\n{prompt}")),
    }
}

/// Rebuild the ask-question outcome envelope from an OpenCode `question` tool
/// call, so the read-only question card shows what the user actually picked.
///
/// OpenCode records the authoritative answers positionally in
/// `state.metadata.answers` — `[["No Claude subscription"], ["No"], …]`, one
/// inner array per question in `state.input.questions` order — and flattens the
/// same information into a one-line `state.output` sentence:
///   `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now …`
/// `parseAskQuestionOutcome` reads neither: the sentence is not JSON, and its
/// line-based fallback wants the companion's numbered `1. [Header] Q` / `→ a, b`
/// layout. So every answered question rendered as "no selection" even though the
/// answers were sitting right there. Emitting the canonical
/// `{"answers":[{header,question,selected}],"declined":false}` envelope — the
/// same shape `render_ask_result` writes for codeg's own companion — routes it
/// through the parser both cards already share.
///
/// A dismissal surfaces as `state.error` carrying `Question.RejectedError`'s
/// message ("The user dismissed this question"), which has no `metadata.answers`
/// at all; it maps to `declined`.
///
/// Returns `None` for every tool that is not `question` (nothing else writes
/// `metadata.answers`), leaving the generic path untouched.
fn structure_question_output(
    input: Option<&serde_json::Value>,
    metadata: Option<&serde_json::Value>,
    error: Option<&str>,
) -> Option<String> {
    let questions = input
        .and_then(|i| i.get("questions"))
        .and_then(|q| q.as_array());

    let Some(answers) = metadata
        .and_then(|m| m.get("answers"))
        .and_then(|a| a.as_array())
    else {
        // Only claim the dismissal when this really is a question call: without
        // `questions` the error belongs to some other tool.
        let dismissed = questions.is_some()
            && error.is_some_and(|e| e.to_ascii_lowercase().contains("dismissed"));
        return dismissed
            .then(|| serde_json::json!({ "declined": true, "answers": [] }).to_string());
    };

    let entries: Vec<serde_json::Value> = answers
        .iter()
        .enumerate()
        .map(|(index, picked)| {
            let question = questions.and_then(|list| list.get(index));
            // OpenCode stores each answer as an array of chosen labels; a
            // single-select question still arrives as a one-element array.
            let selected: Vec<&str> = match picked {
                serde_json::Value::Array(items) => {
                    items.iter().filter_map(|v| v.as_str()).collect()
                }
                serde_json::Value::String(one) => vec![one.as_str()],
                _ => Vec::new(),
            };
            serde_json::json!({
                "header": pick_str(question, &["header"]).unwrap_or_default(),
                "question": pick_str(question, &["question"]).unwrap_or_default(),
                "selected": selected,
            })
        })
        .collect();

    Some(serde_json::json!({ "declined": false, "answers": entries }).to_string())
}

/// Rewrite an OpenCode `question` tool's input into the shape the question card
/// reads.
///
/// Only one key differs: OpenCode names the multi-select flag `multiple`, while
/// `parseAskQuestionInput` accepts `multiSelect` / `multi_select`. Without the
/// rename a multi-select question rendered as single-select. Everything else
/// (`question`, `header`, `options[].label/description`) already matches, so the
/// rest of the payload is passed through verbatim.
fn normalize_question_input(input: Option<&serde_json::Value>) -> Option<String> {
    let questions = input?.get("questions")?.as_array()?;
    let rewritten: Vec<serde_json::Value> = questions
        .iter()
        .map(|question| {
            let Some(obj) = question.as_object() else {
                return question.clone();
            };
            let Some(multiple) = obj.get("multiple").and_then(|v| v.as_bool()) else {
                return question.clone();
            };
            let mut out = obj.clone();
            out.entry("multiSelect".to_string())
                .or_insert(serde_json::Value::Bool(multiple));
            serde_json::Value::Object(out)
        })
        .collect();
    Some(serde_json::json!({ "questions": rewritten }).to_string())
}

fn is_error_status(status: &str) -> bool {
    matches!(
        status.to_ascii_lowercase().as_str(),
        "error" | "failed" | "failure" | "cancelled" | "canceled"
    )
}

fn extract_opencode_usage(value: &serde_json::Value) -> Option<TurnUsage> {
    value
        .get("tokens")
        .and_then(extract_opencode_usage_from_tokens)
}

fn extract_opencode_usage_from_tokens(tokens: &serde_json::Value) -> Option<TurnUsage> {
    let input = tokens.get("input").and_then(|v| v.as_u64()).unwrap_or(0);
    let output = tokens.get("output").and_then(|v| v.as_u64()).unwrap_or(0);
    let cache = tokens.get("cache");
    let cache_write = cache
        .and_then(|c| c.get("write"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read = cache
        .and_then(|c| c.get("read"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if input == 0 && output == 0 && cache_write == 0 && cache_read == 0 {
        return None;
    }

    Some(TurnUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
    })
}

fn millis_to_datetime(ms: i64) -> DateTime<Utc> {
    let secs = ms / 1000;
    let nsecs = ((ms.rem_euclid(1000)) * 1_000_000) as u32;
    Utc.timestamp_opt(secs, nsecs)
        .single()
        .unwrap_or_else(Utc::now)
}

/// Group flat messages into conversation turns (same strategy as Codex).
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

            // Only absorb immediately following Tool messages
            // (stop at the next assistant message to keep turns small for virtualization)
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

/// Extract the content inside `<task_result>…</task_result>` tags from OpenCode
/// task output, stripping the `task_id:` preamble and the wrapper tags.
/// Returns the original string unchanged if no tags are found.
fn extract_task_result_content(raw: &str) -> String {
    if let Some(start) = raw.find("<task_result>") {
        let content_start = start + "<task_result>".len();
        let content_end = raw[content_start..]
            .find("</task_result>")
            .map(|i| content_start + i)
            .unwrap_or(raw.len());
        let extracted = raw[content_start..content_end].trim();
        if !extracted.is_empty() {
            return extracted.to_string();
        }
    }
    raw.to_string()
}

/// Batch-load tool calls from multiple sub-agent sessions in a single query.
///
/// Returns a map from session_id to its list of `AgentToolCall` records.
/// This avoids N+1 queries when a conversation has many agent tasks.
async fn batch_load_subagent_tool_calls(
    conn: &DatabaseConnection,
    session_ids: &[String],
) -> HashMap<String, Vec<AgentToolCall>> {
    if session_ids.is_empty() {
        return HashMap::new();
    }

    // Build parameterized IN clause
    let placeholders: Vec<&str> = session_ids.iter().map(|_| "?").collect();
    let sql = format!(
        r#"
        SELECT m.session_id, p.data
        FROM part p
        INNER JOIN message m ON m.id = p.message_id
        WHERE m.session_id IN ({})
          AND json_extract(p.data, '$.type') = 'tool'
        ORDER BY m.session_id, p.time_created ASC, p.id ASC
        "#,
        placeholders.join(", ")
    );
    let values: Vec<sea_orm::Value> = session_ids.iter().map(|s| s.as_str().into()).collect();

    let rows = match conn
        .query_all(Statement::from_sql_and_values(
            DbBackend::Sqlite,
            &sql,
            values,
        ))
        .await
    {
        Ok(r) => r,
        Err(_) => return HashMap::new(),
    };

    let mut result: HashMap<String, Vec<AgentToolCall>> = HashMap::new();
    for row in rows {
        let sid: String = match row.try_get("", "session_id") {
            Ok(s) => s,
            Err(_) => continue,
        };
        let data_raw: String = match row.try_get("", "data") {
            Ok(d) => d,
            Err(_) => continue,
        };
        let value: serde_json::Value = match serde_json::from_str(&data_raw) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let tool_name = value
            .get("tool")
            .and_then(|t| t.as_str())
            .unwrap_or("unknown")
            .to_string();

        // Skip nested task calls to avoid recursion
        let is_nested_task = tool_name == "task"
            && value
                .get("state")
                .and_then(|s| s.get("input"))
                .and_then(|i| i.get("subagent_type"))
                .is_some();
        if is_nested_task {
            continue;
        }

        // Same rewrite as top-level tool blocks (`normalize_tool_call`):
        // without it the Agent card's nested rows kept camelCase inputs, the
        // read XML envelope, the skill wrapper, and — worst — dropped
        // `state.error`, so a failed child tool showed no output at all.
        let state = value.get("state");
        let normalized = normalize_tool_call(&tool_name, state);
        let status = state
            .and_then(|s| s.get("status"))
            .and_then(|s| s.as_str())
            .unwrap_or("");

        result.entry(sid).or_default().push(AgentToolCall {
            tool_name: normalized.tool_name,
            input_preview: normalized.input_preview.map(|s| truncate_str(&s, 500)),
            output_preview: normalized.output_preview.map(|s| truncate_str(&s, 500)),
            is_error: is_error_status(status) || normalized.is_error,
        });
    }

    result
}

#[cfg(test)]
mod tests {
    use super::{extract_opencode_file_image, resolve_xdg_data_home};
    use crate::models::ContentBlock;
    use std::path::PathBuf;

    #[test]
    fn xdg_data_home_env_overrides_home_fallback() {
        let resolved = resolve_xdg_data_home(
            Some(std::ffi::OsString::from("/tmp/xdg-data")),
            Some(PathBuf::from("/Users/default")),
        );
        assert_eq!(resolved, Some(PathBuf::from("/tmp/xdg-data")));
    }

    #[test]
    fn xdg_data_home_falls_back_to_home_local_share() {
        let resolved = resolve_xdg_data_home(None, Some(PathBuf::from("/Users/default")));
        assert_eq!(resolved, Some(PathBuf::from("/Users/default/.local/share")));
    }

    #[test]
    fn parses_opencode_user_image_file_part_from_data_uri() {
        let value = serde_json::json!({
            "type": "file",
            "mime": "image/jpeg",
            "filename": "avatar.jpg",
            "url": "data:image/jpeg;base64,QUJD"
        });

        let block = extract_opencode_file_image(&value);
        assert!(matches!(
            block,
            Some(ContentBlock::Image { data, mime_type, uri })
            if data == "QUJD" && mime_type == "image/jpeg" && uri.as_deref() == Some("avatar.jpg")
        ));
    }

    // The payloads below are verbatim `part.data` rows captured from a real
    // opencode 1.18.14 run, trimmed only where a field is irrelevant here.

    fn normalized(raw_tool: &str, state: serde_json::Value) -> super::NormalizedToolCall {
        super::normalize_tool_call(raw_tool, Some(&state))
    }

    fn input_of(call: &super::NormalizedToolCall) -> serde_json::Value {
        serde_json::from_str(call.input_preview.as_deref().expect("input preview"))
            .expect("input preview is JSON")
    }

    #[test]
    fn edit_input_becomes_canonical_and_carries_real_start_line() {
        let call = normalized(
            "edit",
            serde_json::json!({
                "status": "completed",
                "input": {
                    "filePath": "src/app.ts",
                    "oldString": "hello ${name}",
                    "newString": "Hello, ${name}!"
                },
                "output": "Edit applied successfully.",
                "metadata": {
                    "diff": "Index: /p/src/app.ts\n===\n--- /p/src/app.ts\n+++ /p/src/app.ts\n@@ -12,5 +12,5 @@\n-  return `hello ${name}`\n+  return `Hello, ${name}!`\n",
                    "filediff": {
                        "file": "/p/src/app.ts",
                        "patch": "…",
                        "additions": 1,
                        "deletions": 1
                    }
                }
            }),
        );

        assert_eq!(call.tool_name, "edit");
        assert!(!call.is_error);
        assert_eq!(
            input_of(&call),
            serde_json::json!({
                "file_path": "src/app.ts",
                "old_string": "hello ${name}",
                "new_string": "Hello, ${name}!",
                "_start_line": 12,
            })
        );
    }

    #[test]
    fn edit_falls_back_to_metadata_file_path_and_v2_path_key() {
        let from_v2 = normalized(
            "edit",
            serde_json::json!({
                "status": "completed",
                "input": { "path": "src/app.ts", "oldString": "a", "newString": "b", "replaceAll": true },
            }),
        );
        assert_eq!(
            input_of(&from_v2),
            serde_json::json!({
                "file_path": "src/app.ts",
                "old_string": "a",
                "new_string": "b",
                "replace_all": true,
            })
        );

        let from_metadata = normalized(
            "edit",
            serde_json::json!({
                "status": "completed",
                "input": { "oldString": "a", "newString": "b" },
                "metadata": { "filediff": { "file": "/abs/src/app.ts" } },
            }),
        );
        assert_eq!(
            input_of(&from_metadata)["file_path"],
            serde_json::json!("/abs/src/app.ts")
        );
    }

    #[test]
    fn edit_strings_stay_byte_exact_including_whitespace() {
        // Indentation-only change: trimming either side would collapse both
        // to "return value" — an identical pair, i.e. an empty diff.
        let call = normalized(
            "edit",
            serde_json::json!({
                "status": "completed",
                "input": {
                    "filePath": "src/app.ts",
                    "oldString": "  return value\n",
                    "newString": "    return value\n"
                },
            }),
        );

        let input = input_of(&call);
        assert_eq!(input["old_string"], serde_json::json!("  return value\n"));
        assert_eq!(input["new_string"], serde_json::json!("    return value\n"));
    }

    #[test]
    fn empty_old_string_is_kept_as_the_create_file_form() {
        let call = normalized(
            "edit",
            serde_json::json!({
                "status": "completed",
                "input": { "filePath": "src/new.ts", "oldString": "", "newString": "body\n" },
            }),
        );

        let input = input_of(&call);
        assert_eq!(input["old_string"], serde_json::json!(""));
        assert_eq!(input["new_string"], serde_json::json!("body\n"));
    }

    #[test]
    fn patch_text_keeps_significant_leading_context_spaces() {
        let patch = " context line\n-old\n+new\n";
        let call = normalized(
            "apply_patch",
            serde_json::json!({
                "status": "completed",
                "input": { "patchText": patch },
            }),
        );

        assert_eq!(call.input_preview.as_deref(), Some(patch));
    }

    #[test]
    fn failed_tool_call_reports_its_error_message() {
        let call = normalized(
            "edit",
            serde_json::json!({
                "status": "error",
                "input": { "filePath": "src/missing.ts", "oldString": "nope", "newString": "yep" },
                "error": "File /p/src/missing.ts not found",
                "time": { "start": 1, "end": 2 }
            }),
        );

        assert!(call.is_error);
        assert_eq!(
            call.output_preview.as_deref(),
            Some("File /p/src/missing.ts not found")
        );
    }

    #[test]
    fn invalid_tool_call_is_flagged_as_an_error() {
        let call = normalized(
            "invalid",
            serde_json::json!({
                "status": "completed",
                "input": { "tool": "edit", "error": "Missing key at [\"filePath\"]" },
                "output": "The arguments provided to the tool are invalid: …",
            }),
        );

        assert!(call.is_error);
        assert_eq!(input_of(&call)["tool"], serde_json::json!("edit"));
    }

    #[test]
    fn write_and_read_inputs_become_canonical() {
        let write = normalized(
            "write",
            serde_json::json!({
                "status": "completed",
                "input": { "filePath": "src/new.ts", "content": "export const A = 1\n" },
                "output": "Wrote file successfully.",
                "metadata": { "filepath": "/p/src/new.ts", "exists": false },
            }),
        );
        assert_eq!(
            input_of(&write),
            serde_json::json!({ "file_path": "src/new.ts", "content": "export const A = 1\n" })
        );

        let read = normalized(
            "read",
            serde_json::json!({
                "status": "completed",
                "input": { "filePath": "src/app.ts" },
                "output": "<path>/p/src/app.ts</path>\n<type>file</type>\n<content>\n1: export const A = 1\n</content>",
                "metadata": {
                    "display": {
                        "type": "file",
                        "path": "/p/src/app.ts",
                        "text": "export const A = 1",
                        "lineStart": 1,
                        "lineEnd": 1
                    }
                },
            }),
        );
        assert_eq!(
            input_of(&read),
            serde_json::json!({ "file_path": "src/app.ts" })
        );
        // The `<path>`/`<content>` envelope and the `N: ` prefixes are gone.
        assert_eq!(
            read.output_preview.as_deref(),
            Some(r#"{"start_line":1,"content":"export const A = 1"}"#)
        );
    }

    #[test]
    fn read_of_a_directory_lists_its_entries() {
        let call = normalized(
            "read",
            serde_json::json!({
                "status": "completed",
                "input": { "filePath": "src" },
                "output": "<path>/p/src</path>\n<type>directory</type>\n<entries>\napp.ts\n</entries>",
                "metadata": {
                    "display": { "type": "directory", "path": "/p/src", "entries": ["app.ts", "new.ts"] }
                },
            }),
        );

        assert_eq!(call.output_preview.as_deref(), Some("app.ts\nnew.ts"));
    }

    #[test]
    fn grep_include_is_renamed_to_glob() {
        let call = normalized(
            "grep",
            serde_json::json!({
                "status": "completed",
                "input": { "pattern": "VERSION", "path": ".", "include": "*.ts" },
            }),
        );

        assert_eq!(
            input_of(&call),
            serde_json::json!({ "pattern": "VERSION", "path": ".", "glob": "*.ts" })
        );
    }

    #[test]
    fn bash_falls_back_to_metadata_output() {
        let call = normalized(
            "bash",
            serde_json::json!({
                "status": "completed",
                "input": { "command": "echo probe", "description": "probe" },
                "metadata": { "output": "probe\n", "exit": 0 },
            }),
        );

        // Trimmed like every other preview (`value_to_preview`).
        assert_eq!(call.output_preview.as_deref(), Some("probe"));
        assert_eq!(input_of(&call)["command"], serde_json::json!("echo probe"));
    }

    #[test]
    fn skill_call_titles_itself_and_drops_the_envelope() {
        let call = normalized(
            "skill",
            serde_json::json!({
                "status": "completed",
                "input": { "name": "demo-skill" },
                "output": "<skill_content name=\"demo-skill\">\n# Skill: demo-skill\n\n# Demo Skill\n\n1. Read the target file.\n\nBase directory for this skill: /c/skills/demo-skill\nRelative paths in this skill (e.g., scripts/) are relative to this base directory.\nNote: file list is sampled.\n\n<skill_files>\n<file>/c/skills/demo-skill/run.sh</file>\n</skill_files>\n</skill_content>",
                "title": "Loaded skill: demo-skill",
                "metadata": { "name": "demo-skill", "dir": "/c/skills/demo-skill" },
            }),
        );

        assert_eq!(input_of(&call)["skill"], serde_json::json!("demo-skill"));
        assert_eq!(
            call.output_preview.as_deref(),
            Some("# Skill: demo-skill\n\n# Demo Skill\n\n1. Read the target file.")
        );
    }

    #[test]
    fn skill_output_without_the_envelope_is_left_alone() {
        assert_eq!(super::unwrap_skill_content("plain body"), "plain body");
    }

    #[test]
    fn apply_patch_input_is_the_patch_text_itself() {
        let call = normalized(
            "patch",
            serde_json::json!({
                "status": "completed",
                "input": { "patchText": "*** Begin Patch\n*** End Patch" },
            }),
        );

        assert_eq!(call.tool_name, "apply_patch");
        assert_eq!(
            call.input_preview.as_deref(),
            Some("*** Begin Patch\n*** End Patch")
        );
    }

    #[test]
    fn canonical_tool_inputs_pass_through_untouched() {
        let call = normalized(
            "todowrite",
            serde_json::json!({
                "status": "completed",
                "input": { "todos": [{ "content": "Probe", "status": "completed" }] },
            }),
        );

        assert_eq!(call.tool_name, "todowrite");
        assert_eq!(
            input_of(&call),
            serde_json::json!({ "todos": [{ "content": "Probe", "status": "completed" }] })
        );
    }

    #[test]
    fn ignores_non_image_file_part_for_image_parsing() {
        let value = serde_json::json!({
            "type": "file",
            "mime": "text/plain",
            "filename": "notes.txt",
            "url": "file:///tmp/notes.txt"
        });

        assert!(extract_opencode_file_image(&value).is_none());
    }

    /// Verbatim `state` of a `question` tool part captured from a real
    /// `~/.local/share/opencode/opencode.db`, trimmed to two questions.
    fn question_state() -> serde_json::Value {
        serde_json::json!({
            "status": "completed",
            "input": {
                "questions": [
                    {
                        "question": "Do you have a Claude Pro/Max subscription?",
                        "header": "Claude Subscription",
                        "options": [
                            { "label": "Yes, I'm on max20", "description": "20x mode" },
                            { "label": "No Claude subscription", "description": "None" }
                        ]
                    },
                    {
                        "question": "Pick the integrations",
                        "header": "Integrations",
                        "multiple": true,
                        "options": [
                            { "label": "Gemini", "description": "" },
                            { "label": "Copilot", "description": "" }
                        ]
                    }
                ]
            },
            "output": "User has answered your questions: \"Do you have a Claude Pro/Max subscription?\"=\"No Claude subscription\", \"Pick the integrations\"=\"Gemini, Copilot\". You can now continue with the user's answers in mind.",
            "title": "Asked 2 questions",
            "metadata": {
                "answers": [["No Claude subscription"], ["Gemini", "Copilot"]],
                "truncated": false
            }
        })
    }

    #[test]
    fn question_output_becomes_the_structured_answer_envelope() {
        // `metadata.answers` is positional against `input.questions`; the
        // one-line `output` sentence the tool also writes is what
        // `parseAskQuestionOutcome` could not read, so every answered question
        // rendered as "no selection".
        let call = normalized("question", question_state());
        assert_eq!(call.tool_name, "question");
        let outcome: serde_json::Value =
            serde_json::from_str(call.output_preview.as_deref().expect("output")).expect("json");
        assert_eq!(
            outcome,
            serde_json::json!({
                "declined": false,
                "answers": [
                    {
                        "header": "Claude Subscription",
                        "question": "Do you have a Claude Pro/Max subscription?",
                        "selected": ["No Claude subscription"],
                    },
                    {
                        "header": "Integrations",
                        "question": "Pick the integrations",
                        "selected": ["Gemini", "Copilot"],
                    },
                ],
            })
        );
    }

    #[test]
    fn question_input_gains_the_multi_select_key_the_card_reads() {
        // OpenCode spells the flag `multiple`; `parseAskQuestionInput` only
        // accepts `multiSelect` / `multi_select`, so a multi-select question
        // rendered as single-select.
        let call = normalized("question", question_state());
        let input = input_of(&call);
        assert_eq!(input["questions"][1]["multiSelect"], serde_json::json!(true));
        // Untouched where the source said nothing, and the rest is verbatim.
        assert!(input["questions"][0].get("multiSelect").is_none());
        assert_eq!(
            input["questions"][0]["options"][0]["label"],
            serde_json::json!("Yes, I'm on max20")
        );
    }

    #[test]
    fn a_dismissed_question_reports_declined() {
        let call = normalized(
            "question",
            serde_json::json!({
                "status": "error",
                "input": { "questions": [{ "question": "Continue?", "header": "Gate" }] },
                "error": "The user dismissed this question",
            }),
        );
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(call.output_preview.as_deref().unwrap())
                .unwrap(),
            serde_json::json!({ "declined": true, "answers": [] })
        );
    }

    #[test]
    fn a_dismissal_from_another_tool_is_not_claimed_as_a_question() {
        // No `questions` in the input → not a question call, so the error text
        // stays the plain failure output the generic card renders.
        assert!(super::structure_question_output(
            Some(&serde_json::json!({ "command": "rm -rf /" })),
            None,
            Some("The user dismissed this question"),
        )
        .is_none());
    }

    #[test]
    fn read_output_is_rebuilt_from_the_display_metadata() {
        // Same `metadata` OpenCode ships under `rawOutput` on the live wire, so
        // this is the shared half of the live/history parity fix.
        let structured = super::structure_read_output(Some(&serde_json::json!({
            "display": {
                "type": "file",
                "path": "/w/notes.txt",
                "text": "hello world\nsecond line",
                "lineStart": 40,
                "lineEnd": 41
            }
        })))
        .expect("structured read output");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&structured).unwrap(),
            serde_json::json!({ "start_line": 40, "content": "hello world\nsecond line" })
        );

        // Only the `read` tool writes `metadata.display`, which is what makes
        // the live path safe to key on the shape alone.
        assert!(super::structure_read_output(Some(&serde_json::json!({ "exit": 0 }))).is_none());
        assert!(super::structure_read_output(None).is_none());
    }

    #[test]
    fn assistant_errors_and_aborts_get_a_visible_marker() {
        // 83 of 2 849 messages in a real 430-session library carry one, and the
        // parts of such a message are empty — so without a marker the bubble is
        // blank.
        assert_eq!(
            super::assistant_error_text(&serde_json::json!({
                "role": "assistant",
                "error": { "name": "APIError", "data": { "message": "Invalid Authentication" } }
            }))
            .as_deref(),
            Some("[opencode APIError] Invalid Authentication")
        );
        // An abort's own message is boilerplate ("The operation was aborted.")
        // that says less than the name does.
        assert_eq!(
            super::assistant_error_text(&serde_json::json!({
                "error": {
                    "name": "MessageAbortedError",
                    "data": { "message": "The operation was aborted." }
                }
            }))
            .as_deref(),
            Some("[opencode aborted]")
        );
        assert_eq!(
            super::assistant_error_text(&serde_json::json!({
                "error": { "name": "UnknownError", "data": {} }
            }))
            .as_deref(),
            Some("[opencode UnknownError]")
        );
        assert!(super::assistant_error_text(&serde_json::json!({ "role": "assistant" })).is_none());
    }

    #[test]
    fn only_a_bare_compaction_message_gets_refiled_as_assistant() {
        let compaction = || ContentBlock::ToolUse {
            tool_use_id: Some("prt_1".into()),
            tool_name: "context_compaction".into(),
            input_preview: None,
            status: None,
            meta: None,
        };
        let result = || ContentBlock::ToolResult {
            tool_use_id: Some("prt_1".into()),
            output_preview: None,
            is_error: false,
            agent_stats: None,
            images: Vec::new(),
        };

        assert!(super::is_compaction_only(&[compaction(), result()]));
        // Anything the user actually said keeps the message theirs.
        assert!(!super::is_compaction_only(&[
            ContentBlock::Text { text: "carry on".into() },
            compaction(),
        ]));
        // A different tool's pair is not a compaction, and neither is nothing.
        assert!(!super::is_compaction_only(&[
            ContentBlock::ToolUse {
                tool_use_id: Some("prt_2".into()),
                tool_name: "read".into(),
                input_preview: None,
                status: None,
                meta: None,
            },
            result(),
        ]));
        assert!(!super::is_compaction_only(&[]));
        assert!(!super::is_compaction_only(&[result()]));
    }

    #[test]
    fn subtask_parts_describe_the_delegation_they_replaced() {
        // A slash command routed to a sub-agent writes a `subtask` part INSTEAD
        // of the expanded prompt text, so the user's turn was blank.
        assert_eq!(
            super::subtask_summary(&serde_json::json!({
                "type": "subtask",
                "agent": "explore",
                "command": "review",
                "description": "review changes",
                "prompt": "Review the uncommitted diff."
            }))
            .as_deref(),
            Some("/review → @explore: review changes\n\nReview the uncommitted diff.")
        );
        // `command` and `description` are both optional in the schema.
        assert_eq!(
            super::subtask_summary(&serde_json::json!({
                "agent": "explore",
                "prompt": "Look around."
            }))
            .as_deref(),
            Some("@explore\n\nLook around.")
        );
        assert!(super::subtask_summary(&serde_json::json!({ "type": "subtask" })).is_none());
    }

    /// The placeholder test has to match the whole shape, not just the prefix:
    /// "New session - " is a legal thing for a person to call a session, and
    /// renaming one to that must not send it back to the fallback.
    #[test]
    fn only_opencodes_own_generated_name_counts_as_untitled() {
        assert!(super::is_default_title("New session - 2026-09-16T03:09:14.543Z"));
        assert!(super::is_default_title(
            "Child session - 2026-09-16T03:09:14.543Z"
        ));

        for kept in [
            "New session - notes",
            "New session - 2026-09-16",
            "New session - 2026-09-16T03:09:14.543Z ",
            "New session - 2026-09-16T03:09:14.543Z extra",
            "New session - 20X6-09-16T03:09:14.543Z",
            "Fix the login flow",
            "",
        ] {
            assert!(!super::is_default_title(kept), "{kept:?} is a real title");
        }
    }

    #[test]
    fn the_fork_marker_is_peeled_off_and_nothing_else_is() {
        assert_eq!(
            super::split_fork_suffix("New session - 2026-09-16T03:09:14.543Z (fork #12)"),
            ("New session - 2026-09-16T03:09:14.543Z", " (fork #12)")
        );
        // Forking a fork nests the count rather than the marker, so only ever
        // one suffix to peel.
        assert_eq!(
            super::split_fork_suffix("Fix login (fork #2)"),
            ("Fix login", " (fork #2)")
        );
        for untouched in [
            "Fix login",
            "Fix login (fork #)",
            "Fix login (fork #2) ",
            "Fix login (fork #two)",
            "(fork #2)",
        ] {
            assert_eq!(
                super::split_fork_suffix(untouched),
                (untouched, ""),
                "{untouched:?} should be left whole"
            );
        }
    }

    /// OpenCode names a session before anyone has spoken and is supposed to
    /// replace that name on the first turn — but the call is forked and its
    /// errors swallowed, so an unreachable small model leaves every session
    /// called "New session - <timestamp>" forever. Stand in for it the same way
    /// OpenCode's own TUI does: with the opening user message.
    #[test]
    fn a_placeholder_title_gives_way_to_what_the_user_actually_said() {
        let derived = super::resolve_title(
            Some("New session - 2026-09-16T03:09:14.543Z".into()),
            Some("执行一下 pnpm build".into()),
        );
        assert_eq!(derived.as_deref(), Some("执行一下 pnpm build"));

        // A real title always wins, even with a first message to fall back to.
        assert_eq!(
            super::resolve_title(Some("Fix the login flow".into()), Some("hi".into())).as_deref(),
            Some("Fix the login flow")
        );

        // A fork of an unnamed session inherits the placeholder plus a marker —
        // a string OpenCode's own `isDefaultTitle` no longer recognises. Keep
        // the marker (it is the only thing telling the two rows apart) and
        // replace the placeholder under it.
        assert_eq!(
            super::resolve_title(
                Some("New session - 2026-09-04T07:11:47.236Z (fork #1)".into()),
                Some("hi".into()),
            )
            .as_deref(),
            Some("hi (fork #1)")
        );

        // Nothing to derive from: report untitled and let the UI use its own
        // localized label rather than showing a machine placeholder.
        assert_eq!(
            super::resolve_title(Some("New session - 2026-09-16T03:09:14.543Z".into()), None),
            None
        );
        assert_eq!(
            super::resolve_title(
                Some("New session - 2026-09-16T03:09:14.543Z".into()),
                Some("   ".into()),
            ),
            None
        );
        assert_eq!(super::resolve_title(None, Some("hi".into())).as_deref(), Some("hi"));
    }

    /// The fallback runs the same folding and capping every other agent's
    /// derived title does, so a session opened with a file mention is named
    /// after the label rather than a truncated `file://` URL.
    #[test]
    fn a_derived_title_is_folded_and_capped_like_every_other_agents() {
        let long = "x".repeat(150);
        assert_eq!(
            super::resolve_title(
                Some("New session - 2026-09-16T03:09:14.543Z".into()),
                Some(long.clone()),
            ),
            Some(super::super::title_from_user_text(&long))
        );
        assert_eq!(
            super::resolve_title(
                Some("New session - 2026-09-16T03:09:14.543Z".into()),
                Some("look at [notes.md](file:///tmp/a/very/long/path/notes.md)".into()),
            )
            .as_deref(),
            Some("look at notes.md")
        );
    }
}
