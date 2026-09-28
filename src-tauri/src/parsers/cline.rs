use std::fs;
use std::path::PathBuf;

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageTurn, TurnRole,
    TurnUsage,
};

use super::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path, title_from_user_text,
    truncate_str, AgentParser, ParseError,
};

// ---------------------------------------------------------------------------
// On-disk JSON structures — cline 3.x session store
// ---------------------------------------------------------------------------
//
// cline 3.x keeps one directory per session under `~/.cline/data/sessions/`:
//
//   sessions/<id>/<id>.json            the manifest (below)
//   sessions/<id>/<id>.messages.json   the transcript
//   sessions/<id>/<other>.messages.json  one per agent-team teammate
//   sessions/<id>/<id>.compaction.json   compacted history, when one exists
//
// `db/sessions.db` indexes the same records and is the only place a spawned
// SUB-agent is written — those get a row and a sibling messages file, never a
// manifest of their own. Listing manifests therefore yields exactly the root
// sessions, which is what the index's own `rootOnly` filter selects, without
// codeg opening a live SQLite store owned by another process.
//
// The pre-3.x layout (`state/taskHistory.json` + `tasks/<id>/`) is still read
// as a fallback so history written by an older cline does not disappear.

/// `sessions/<id>/<id>.json`. Mirrors the columns of the `sessions` table;
/// only the fields codeg surfaces are declared.
#[derive(Debug, Default, Deserialize)]
struct SessionManifest {
    #[serde(default)]
    session_id: String,
    #[serde(default)]
    started_at: Option<String>,
    #[serde(default)]
    ended_at: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    workspace_root: Option<String>,
    #[serde(default)]
    prompt: Option<String>,
    #[serde(default)]
    metadata: Option<SessionMetadata>,
    #[serde(default)]
    messages_path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SessionMetadata {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    git: Option<SessionGit>,
}

#[derive(Debug, Default, Deserialize)]
struct SessionGit {
    #[serde(default)]
    branch: Option<String>,
}

/// `sessions/<id>/<id>.messages.json`.
#[derive(Debug, Default, Deserialize)]
struct SessionMessagesFile {
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    messages: Vec<SessionMessage>,
}

/// The same file read for its shape alone — how many messages, and when it
/// was last written. Used by the listing, which needs neither the bodies nor
/// the allocations they cost.
#[derive(Debug, Default, Deserialize)]
struct SessionMessagesCount {
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    messages: Vec<serde::de::IgnoredAny>,
}

/// One entry of the transcript's `messages` array. cline stores the model
/// conversation itself, so the content blocks are Anthropic-shaped (`text`,
/// `thinking`, `tool_use`, `tool_result`) and tool results arrive as
/// `role:"user"` messages.
#[derive(Debug, Deserialize)]
struct SessionMessage {
    role: String,
    #[serde(default)]
    content: serde_json::Value,
    #[serde(default)]
    ts: Option<i64>,
    #[serde(default, rename = "modelInfo")]
    model_info: Option<SessionModelInfo>,
    #[serde(default)]
    metrics: Option<SessionMetrics>,
}

#[derive(Debug, Deserialize)]
struct SessionModelInfo {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMetrics {
    #[serde(default)]
    input_tokens: Option<u64>,
    #[serde(default)]
    output_tokens: Option<u64>,
    #[serde(default)]
    cache_read_tokens: Option<u64>,
    #[serde(default)]
    cache_write_tokens: Option<u64>,
}

// ---------------------------------------------------------------------------
// On-disk JSON structures — pre-3.x task store (fallback)
// ---------------------------------------------------------------------------

/// One entry in `~/.cline/data/state/taskHistory.json`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskHistoryEntry {
    id: String,
    ts: i64,
    task: Option<String>,
    #[allow(dead_code)]
    tokens_in: Option<u64>,
    #[allow(dead_code)]
    tokens_out: Option<u64>,
    #[allow(dead_code)]
    total_cost: Option<f64>,
    cwd_on_task_initialization: Option<String>,
    #[serde(default)]
    model_id: Option<String>,
}

/// `task_metadata.json` – we only need `model_usage`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskMetadata {
    #[serde(default)]
    model_usage: Vec<ModelUsageEntry>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsageEntry {
    model_id: Option<String>,
    #[allow(dead_code)]
    model_provider_id: Option<String>,
}

/// One message in `api_conversation_history.json`.
#[derive(Debug, Deserialize)]
struct ApiMessage {
    role: String,
    #[serde(default)]
    content: serde_json::Value,
    ts: Option<i64>,
    #[serde(default, rename = "modelInfo")]
    model_info: Option<ApiModelInfo>,
    #[serde(default)]
    metrics: Option<ApiMetrics>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiModelInfo {
    model_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiMetrics {
    tokens: Option<ApiTokenMetrics>,
}

#[derive(Debug, Deserialize)]
struct ApiTokenMetrics {
    #[serde(default)]
    prompt: Option<u64>,
    #[serde(default)]
    completion: Option<u64>,
    #[serde(default)]
    cached: Option<u64>,
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

pub(crate) fn cline_data_dir() -> PathBuf {
    if let Ok(custom) = std::env::var("CLINE_DIR") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".cline")
        .join("data")
}

fn ts_to_datetime(ts: i64) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(ts).single().unwrap_or_default()
}

pub struct ClineParser {
    base_dir: PathBuf,
}

impl Default for ClineParser {
    fn default() -> Self {
        Self::new()
    }
}

impl ClineParser {
    pub fn new() -> Self {
        Self {
            base_dir: cline_data_dir(),
        }
    }

    /// Test-only constructor that lets callers point the parser at a fixture
    /// directory instead of `~/.cline/data`.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn sessions_dir(&self) -> PathBuf {
        self.base_dir.join("sessions")
    }

    fn read_manifest(&self, session_id: &str) -> Option<SessionManifest> {
        let path = self
            .sessions_dir()
            .join(session_id)
            .join(format!("{session_id}.json"));
        let raw = fs::read_to_string(path).ok()?;
        let mut manifest: SessionManifest = serde_json::from_str(&raw).ok()?;
        // A manifest whose `session_id` is missing or disagrees with its own
        // directory is still readable — the directory name is the id every
        // other path is built from, and the id codeg recorded as `external_id`.
        if manifest.session_id != session_id {
            manifest.session_id = session_id.to_string();
        }
        Some(manifest)
    }

    fn read_messages(&self, manifest: &SessionManifest) -> SessionMessagesFile {
        self.read_messages_as(manifest)
    }

    fn read_messages_as<T: Default + serde::de::DeserializeOwned>(
        &self,
        manifest: &SessionManifest,
    ) -> T {
        let id = &manifest.session_id;
        // The conventional path wins over the manifest's own `messages_path`:
        // that field records the ABSOLUTE path the writing process saw, which
        // stops being true the moment the store moves — `CLINE_DIR`, a
        // restored backup, a test fixture. The recorded path stays as the
        // fallback, for a layout this convention does not predict.
        let conventional = self
            .sessions_dir()
            .join(id)
            .join(format!("{id}.messages.json"));
        let candidates = [
            Some(conventional),
            manifest
                .messages_path
                .as_deref()
                .map(|p| p.trim())
                .filter(|p| !p.is_empty())
                .map(PathBuf::from),
        ];
        for path in candidates.into_iter().flatten() {
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(parsed) = serde_json::from_str::<T>(&raw) {
                return parsed;
            }
        }
        T::default()
    }

    /// Every root session in the 3.x store, newest-first ordering left to the
    /// caller. A directory without a readable manifest is skipped rather than
    /// failing the listing — a session being written right now is the common
    /// case, and one unreadable session must not hide the rest.
    fn list_session_store(&self) -> Vec<ConversationSummary> {
        let Ok(entries) = fs::read_dir(self.sessions_dir()) else {
            return Vec::new();
        };

        let mut summaries = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            let Some(session_id) = entry.file_name().to_str().map(String::from) else {
                continue;
            };
            let Some(manifest) = self.read_manifest(&session_id) else {
                continue;
            };
            // Counting, not rendering: `SessionMessagesCount` drops every
            // message body on the floor, so listing a store does not
            // materialize every transcript in it.
            let counted = self.read_messages_as::<SessionMessagesCount>(&manifest);
            summaries.push(session_summary(
                &manifest,
                counted.updated_at.as_deref(),
                counted.messages.len() as u32,
            ));
        }
        summaries
    }

    fn session_detail(&self, manifest: &SessionManifest) -> ConversationDetail {
        let conversation_id = manifest.session_id.clone();
        let messages = self.read_messages(manifest);
        let manifest_model = non_empty(manifest.model.clone());

        // A message without a usable `ts` inherits the previous one's instead
        // of `now`: stamping the current time mid-transcript reorders a
        // reopened session and makes every gap look like it happened today.
        let mut last_ts = manifest
            .started_at
            .as_deref()
            .and_then(parse_iso8601)
            .unwrap_or_else(Utc::now);

        let mut turns: Vec<MessageTurn> = Vec::new();
        let mut turn_counter = 0u32;
        let next_turn_id = |counter: &mut u32| {
            *counter += 1;
            format!("{conversation_id}-{counter}")
        };

        for msg in &messages.messages {
            let timestamp = match msg.ts.filter(|ts| *ts > 0).map(ts_to_datetime) {
                Some(ts) => {
                    last_ts = ts;
                    ts
                }
                None => last_ts,
            };

            match msg.role.as_str() {
                "assistant" => {
                    let blocks = parse_content_blocks(&msg.content, clean_session_text);
                    if blocks.is_empty() {
                        continue;
                    }
                    let model = msg
                        .model_info
                        .as_ref()
                        .and_then(|info| non_empty(info.id.clone()))
                        .or_else(|| manifest_model.clone());
                    turns.push(MessageTurn {
                        id: next_turn_id(&mut turn_counter),
                        role: TurnRole::Assistant,
                        blocks,
                        timestamp,
                        usage: msg.metrics.as_ref().map(session_usage),
                        duration_ms: None,
                        model,
                        completed_at: Some(timestamp),
                        agent_message_id: None,
                    });
                }
                "user" => {
                    let parsed = parse_session_user_parts(&msg.content);
                    if !parsed.tool_results.is_empty() {
                        turns.push(MessageTurn {
                            id: next_turn_id(&mut turn_counter),
                            role: TurnRole::System,
                            blocks: parsed.tool_results,
                            timestamp,
                            usage: None,
                            duration_ms: None,
                            model: None,
                            completed_at: Some(timestamp),
                            agent_message_id: None,
                        });
                    }
                    if !parsed.user_blocks.is_empty() {
                        turns.push(MessageTurn {
                            id: next_turn_id(&mut turn_counter),
                            role: TurnRole::User,
                            blocks: parsed.user_blocks,
                            timestamp,
                            usage: None,
                            duration_ms: None,
                            model: None,
                            completed_at: Some(timestamp),
                            agent_message_id: None,
                        });
                    }
                }
                _ => continue,
            }
        }

        backfill_turn_durations(&mut turns, &[]);
        let session_stats = compute_session_stats(&turns);
        let summary = session_summary(
            manifest,
            messages.updated_at.as_deref(),
            turns.len() as u32,
        );

        ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

fn parse_iso8601(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn session_usage(metrics: &SessionMetrics) -> TurnUsage {
    TurnUsage {
        input_tokens: metrics.input_tokens.unwrap_or(0),
        output_tokens: metrics.output_tokens.unwrap_or(0),
        cache_creation_input_tokens: metrics.cache_write_tokens.unwrap_or(0),
        cache_read_input_tokens: metrics.cache_read_tokens.unwrap_or(0),
    }
}

fn session_summary(
    manifest: &SessionManifest,
    transcript_updated_at: Option<&str>,
    message_count: u32,
) -> ConversationSummary {
    let folder_path = non_empty(manifest.cwd.clone())
        .or_else(|| non_empty(manifest.workspace_root.clone()));
    let folder_name = folder_path.as_deref().map(folder_name_from_path);

    // `metadata.title` is cline's own summary of the session; the opening
    // prompt (still carrying its `<user_input>` wrapper on disk) is the
    // fallback for a session too young to have been titled.
    let title = non_empty(
        manifest
            .metadata
            .as_ref()
            .and_then(|meta| meta.title.clone()),
    )
    .or_else(|| {
        non_empty(manifest.prompt.clone())
            .map(|prompt| clean_session_text(&prompt))
            .filter(|prompt| !prompt.is_empty())
    })
    .map(|title| title_from_user_text(title.trim()));

    let started_at = manifest
        .started_at
        .as_deref()
        .and_then(parse_iso8601)
        .unwrap_or_else(Utc::now);
    let ended_at = manifest
        .ended_at
        .as_deref()
        .and_then(parse_iso8601)
        .or_else(|| transcript_updated_at.and_then(parse_iso8601));

    ConversationSummary {
        id: manifest.session_id.clone(),
        agent_type: AgentType::Cline,
        folder_path,
        folder_name,
        title,
        started_at,
        ended_at,
        message_count,
        model: non_empty(manifest.model.clone()),
        git_branch: non_empty(
            manifest
                .metadata
                .as_ref()
                .and_then(|meta| meta.git.as_ref())
                .and_then(|git| git.branch.clone()),
        ),
        parent_id: None,
        parent_tool_use_id: None,
        delegation_call_id: None,
    }
}

impl AgentParser for ClineParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut summaries = self.list_session_store();
        summaries.extend(self.list_legacy_tasks()?);
        Ok(summaries)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        if let Some(manifest) = self.read_manifest(conversation_id) {
            return Ok(self.session_detail(&manifest));
        }
        self.legacy_conversation(conversation_id)
    }
}

impl ClineParser {
    fn list_legacy_tasks(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let history_path = self.base_dir.join("state").join("taskHistory.json");
        if !history_path.exists() {
            return Ok(vec![]);
        }

        let raw = fs::read_to_string(&history_path)?;
        let entries: Vec<TaskHistoryEntry> = serde_json::from_str(&raw)?;

        let mut summaries = Vec::new();
        for entry in entries {
            let tasks_dir = self.base_dir.join("tasks").join(&entry.id);
            if !tasks_dir.exists() {
                continue;
            }

            // Read model from task_metadata.json or taskHistory entry
            let model = entry.model_id.clone().or_else(|| {
                let meta_path = tasks_dir.join("task_metadata.json");
                fs::read_to_string(meta_path)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<TaskMetadata>(&raw).ok())
                    .and_then(|meta| meta.model_usage.first().and_then(|u| u.model_id.clone()))
            });

            let folder_path = entry.cwd_on_task_initialization.clone();
            let folder_name = folder_path.as_deref().map(folder_name_from_path);

            let title = entry.task.as_deref().map(|t| title_from_user_text(t.trim()));

            // Count messages from api_conversation_history.json
            let api_path = tasks_dir.join("api_conversation_history.json");
            let message_count = fs::read_to_string(&api_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<Vec<serde_json::Value>>(&raw).ok())
                .map(|msgs| msgs.len() as u32)
                .unwrap_or(0);

            // started_at from task id (which is a timestamp), ended_at from ts
            let started_at = ts_to_datetime(entry.id.parse::<i64>().unwrap_or(entry.ts));
            let ended_at = if entry.ts > 0 {
                Some(ts_to_datetime(entry.ts))
            } else {
                None
            };

            summaries.push(ConversationSummary {
                id: entry.id,
                agent_type: AgentType::Cline,
                folder_path,
                folder_name,
                title,
                started_at,
                ended_at,
                message_count,
                model,
                git_branch: None,
                parent_id: None,
                parent_tool_use_id: None,
                delegation_call_id: None,
            });
        }

        Ok(summaries)
    }

    fn legacy_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let tasks_dir = self.base_dir.join("tasks").join(conversation_id);
        if !tasks_dir.exists() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }

        let api_path = tasks_dir.join("api_conversation_history.json");
        if !api_path.exists() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }

        let raw = fs::read_to_string(&api_path)?;
        let messages: Vec<ApiMessage> = serde_json::from_str(&raw)?;

        // Read metadata for model/cwd
        let meta_path = tasks_dir.join("task_metadata.json");
        let metadata = fs::read_to_string(&meta_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<TaskMetadata>(&raw).ok());

        let default_model = metadata
            .as_ref()
            .and_then(|m| m.model_usage.first())
            .and_then(|u| u.model_id.clone());

        // Read taskHistory for cwd and title
        let history_path = self.base_dir.join("state").join("taskHistory.json");
        let history_entry = fs::read_to_string(&history_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<TaskHistoryEntry>>(&raw).ok())
            .and_then(|entries| entries.into_iter().find(|e| e.id == conversation_id));

        let folder_path = history_entry
            .as_ref()
            .and_then(|e| e.cwd_on_task_initialization.clone());
        let folder_name = folder_path.as_deref().map(folder_name_from_path);
        let title = history_entry
            .as_ref()
            .and_then(|e| e.task.as_deref())
            .map(|t| title_from_user_text(t.trim()));

        let mut turns: Vec<MessageTurn> = Vec::new();
        let mut turn_counter = 0u32;

        for msg in &messages {
            let ts = msg.ts.unwrap_or(0);
            let timestamp = if ts > 0 {
                ts_to_datetime(ts)
            } else {
                Utc::now()
            };

            let model = msg
                .model_info
                .as_ref()
                .and_then(|info| info.model_id.clone())
                .or_else(|| default_model.clone());

            let usage = msg.metrics.as_ref().and_then(|m| {
                m.tokens.as_ref().map(|t| TurnUsage {
                    input_tokens: t.prompt.unwrap_or(0),
                    output_tokens: t.completion.unwrap_or(0),
                    cache_creation_input_tokens: 0,
                    cache_read_input_tokens: t.cached.unwrap_or(0),
                })
            });

            match msg.role.as_str() {
                "assistant" => {
                    let blocks = parse_content_blocks(&msg.content, strip_environment_details);
                    if blocks.is_empty() {
                        continue;
                    }
                    turn_counter += 1;
                    turns.push(MessageTurn {
                        id: format!("{}-{}", conversation_id, turn_counter),
                        role: TurnRole::Assistant,
                        blocks,
                        timestamp,
                        usage,
                        duration_ms: None,
                        model,
                        completed_at: Some(timestamp),
                    agent_message_id: None,
                    });
                }
                "user" => {
                    // Cline packs tool results, user feedback, and automated
                    // messages into role:"user".  Split them into proper turns.
                    let parsed = parse_user_message_parts(&msg.content);

                    // Emit tool-result blocks as a system turn so they attach
                    // to the preceding assistant tool_use.
                    if !parsed.tool_results.is_empty() {
                        turn_counter += 1;
                        turns.push(MessageTurn {
                            id: format!("{}-{}", conversation_id, turn_counter),
                            role: TurnRole::System,
                            blocks: parsed.tool_results,
                            timestamp,
                            usage: None,
                            duration_ms: None,
                            model: None,
                            completed_at: Some(timestamp),
                        agent_message_id: None,
                        });
                    }

                    // Emit real user text (feedback / initial task) as a user turn.
                    if !parsed.user_blocks.is_empty() {
                        turn_counter += 1;
                        turns.push(MessageTurn {
                            id: format!("{}-{}", conversation_id, turn_counter),
                            role: TurnRole::User,
                            blocks: parsed.user_blocks,
                            timestamp,
                            usage: None,
                            duration_ms: None,
                            model: None,
                            completed_at: Some(timestamp),
                        agent_message_id: None,
                        });
                    }
                }
                _ => continue,
            }
        }

        let started_at = turns.first().map(|t| t.timestamp).unwrap_or_else(Utc::now);
        let ended_at = turns.last().map(|t| t.timestamp);

        backfill_turn_durations(&mut turns, &[]);
        let session_stats = compute_session_stats(&turns);

        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Cline,
            folder_path,
            folder_name,
            title,
            started_at,
            ended_at,
            message_count: turns.len() as u32,
            model: default_model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        };

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }
}

// ---------------------------------------------------------------------------
// Content block parsing
// ---------------------------------------------------------------------------

/// Result of splitting a Cline `role:"user"` message.
struct UserMessageParts {
    /// Tool result blocks (e.g. `[read_file for ...] Result:`)
    tool_results: Vec<ContentBlock>,
    /// Real user content (initial task text or `<feedback>` text)
    user_blocks: Vec<ContentBlock>,
}

/// Cline puts tool results, feedback, and automated prompts all into
/// `role:"user"` messages.  This function splits them apart.
fn parse_user_message_parts(content: &serde_json::Value) -> UserMessageParts {
    let texts = collect_text_parts(content);
    let mut tool_results = Vec::new();
    let mut user_blocks = Vec::new();

    for text in texts {
        let cleaned = strip_environment_details(&text);
        if cleaned.is_empty() {
            continue;
        }

        // Tool result pattern: `[tool_name ...] Result:`
        if is_tool_result_text(&cleaned) {
            let (tool_name, output, is_error) = parse_tool_result_text(&cleaned);
            tool_results.push(ContentBlock::ToolResult {
                tool_use_id: None,
                output_preview: Some(truncate_str(&output, 2000)),
                is_error,
                agent_stats: None,
                images: Vec::new(),
            });

            // If the tool result also contains <feedback>, extract it
            if let Some(feedback) = extract_feedback(&text) {
                let fb = feedback.trim();
                if !fb.is_empty() {
                    user_blocks.push(ContentBlock::Text {
                        text: fb.to_string(),
                    });
                }
            }
            // After extracting tool result, also check for non-feedback user
            // text following the result (e.g. "The user has provided feedback...")
            // — we intentionally skip these automated bridging messages.
            let _ = tool_name;
            continue;
        }

        // Pure feedback without tool result prefix
        if let Some(feedback) = extract_feedback(&cleaned) {
            let fb = feedback.trim();
            if !fb.is_empty() {
                user_blocks.push(ContentBlock::Text {
                    text: fb.to_string(),
                });
            }
            continue;
        }

        // Regular user text (initial task, etc.)
        user_blocks.push(ContentBlock::Text { text: cleaned });
    }

    UserMessageParts {
        tool_results,
        user_blocks,
    }
}

/// Collect all text strings from a content value (string or array of text blocks).
fn collect_text_parts(content: &serde_json::Value) -> Vec<String> {
    match content {
        serde_json::Value::String(s) => vec![s.clone()],
        serde_json::Value::Array(arr) => arr
            .iter()
            .filter_map(|item| {
                let t = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if t == "text" || t.is_empty() {
                    item.get("text")
                        .and_then(|v| v.as_str())
                        .map(String::from)
                        .or_else(|| {
                            if t.is_empty() {
                                item.as_str().map(String::from)
                            } else {
                                None
                            }
                        })
                } else {
                    None
                }
            })
            .collect(),
        _ => vec![],
    }
}

/// Markers Cline wraps around the parts of a user message.
const ENV_OPEN: &str = "<environment_details>";
const ENV_CLOSE: &str = "</environment_details>";
const TASK_OPEN: &str = "<task>";
const TASK_CLOSE: &str = "</task>";
const FEEDBACK_OPEN: &str = "<feedback>";
const FEEDBACK_CLOSE: &str = "</feedback>";
const TASK_PROGRESS_MARKER: &str = "# task_progress RECOMMENDED";

/// Check if text looks like a Cline tool result: `[tool_name ...] Result:`
fn is_tool_result_text(text: &str) -> bool {
    let trimmed = text.trim_start();
    trimmed.starts_with('[') && trimmed.contains("] Result:")
}

/// Parse `[tool_name for 'arg'] Result:\ncontent` into (tool_name, output, is_error).
fn parse_tool_result_text(text: &str) -> (String, String, bool) {
    let trimmed = text.trim_start();
    // Extract tool name from [tool_name ...] or [tool_name] prefix
    let tool_name = trimmed
        .strip_prefix('[')
        .and_then(|s| s.find([']', ' ']).map(|i| s[..i].to_string()))
        .unwrap_or_default();

    let is_error = trimmed.contains("[ERROR]") || trimmed.contains("Error:");

    // Extract the content after "Result:\n"
    let output = trimmed
        .find("] Result:")
        .map(|i| {
            let after = &trimmed[i + "] Result:".len()..];
            after.trim().to_string()
        })
        .unwrap_or_default();

    // Strip automated bridging text that follows some results
    let output = strip_automated_bridging(&output);

    (tool_name, output, is_error)
}

/// Remove automated bridging messages that Cline appends after tool results.
fn strip_automated_bridging(text: &str) -> String {
    let mut result = text.to_string();

    // Remove "The user has provided feedback..." bridging
    if let Some(pos) = result.find("The user has provided feedback") {
        result = result[..pos].to_string();
    }

    // Remove "(This is an automated message...)" blocks
    if let Some(pos) = result.find("(This is an automated message") {
        result = result[..pos].to_string();
    }

    // Remove "# Next Steps" blocks
    if let Some(pos) = result.find("# Next Steps") {
        result = result[..pos].to_string();
    }

    result.trim().to_string()
}

/// Extract text from `<feedback>...</feedback>` tags.
///
/// The closing tag is searched from after the opening one, for the reason
/// spelled out on [`strip_environment_details`]: a message that quotes
/// `</feedback>` ahead of the real block would otherwise drop the feedback.
fn extract_feedback(text: &str) -> Option<String> {
    let start = text.find(FEEDBACK_OPEN)?;
    let inner_start = start + FEEDBACK_OPEN.len();
    let end = inner_start + text[inner_start..].find(FEEDBACK_CLOSE)?;
    if end > inner_start {
        Some(text[inner_start..end].to_string())
    } else {
        None
    }
}

/// Turn one message's `content` into render blocks.
///
/// `clean` is the store's own text cleanup — the wrappers cline puts around
/// what the user typed differ between the 3.x session store and the pre-3.x
/// task store, and running the wrong one over a message either leaves markup
/// in the bubble or eats text that happens to look like a retired tag.
fn parse_content_blocks(
    content: &serde_json::Value,
    clean: fn(&str) -> String,
) -> Vec<ContentBlock> {
    match content {
        serde_json::Value::String(text) => {
            let cleaned = clean(text);
            if cleaned.is_empty() {
                vec![]
            } else {
                vec![ContentBlock::Text { text: cleaned }]
            }
        }
        serde_json::Value::Array(arr) => {
            let mut blocks = Vec::new();
            for item in arr {
                let block_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match block_type {
                    "text" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            let cleaned = clean(text);
                            if !cleaned.is_empty() {
                                blocks.push(ContentBlock::Text { text: cleaned });
                            }
                        }
                    }
                    "tool_use" => {
                        let tool_name = item
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("unknown")
                            .to_string();
                        let tool_use_id = item.get("id").and_then(|v| v.as_str()).map(String::from);
                        let input_preview = item.get("input").map(|v| {
                            let s = v.to_string();
                            truncate_str(&s, 2000)
                        });
                        blocks.push(ContentBlock::ToolUse {
                            tool_use_id,
                            tool_name,
                            input_preview,
                            status: None,
                            meta: None,
                        });
                    }
                    "tool_result" => {
                        let tool_use_id = item
                            .get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .map(String::from);
                        let is_error = item
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let output_preview = tool_result_output(item.get("content"))
                            .map(|s| truncate_str(&s, 500));
                        blocks.push(ContentBlock::ToolResult {
                            tool_use_id,
                            output_preview,
                            is_error,
                            agent_stats: None,
                            images: Vec::new(),
                        });
                    }
                    "thinking" => {
                        if let Some(text) = item.get("thinking").and_then(|v| v.as_str()) {
                            if !text.is_empty() {
                                blocks.push(ContentBlock::Thinking {
                                    text: text.to_string(),
                                });
                            }
                        }
                    }
                    _ => {}
                }
            }
            blocks
        }
        _ => vec![],
    }
}

/// A tool result's payload is `string | Array<block>` in cline's own message
/// type. Anything else (an object, a number) has no text to preview.
fn tool_result_output(content: Option<&serde_json::Value>) -> Option<String> {
    match content? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Array(items) => {
            let joined = items
                .iter()
                .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
                .collect::<Vec<_>>()
                .join("\n");
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

/// Wrappers cline 3.x puts around a user message. `<environment_details>`,
/// `<task>` and the `task_progress` block below belong to the pre-3.x prompt
/// format and are gone from 3.x entirely — these three are what replaced them.
const USER_INPUT_TAG: &str = "user_input";
const USER_COMMAND_TAG: &str = "user_command";
const MODE_NOTICE_TAG: &str = "mode_notice";

/// Replace every `<tag …>inner</tag>` with `inner` (or drop the block whole
/// when `keep_inner` is false).
///
/// The closing tag is searched from AFTER the opening tag's `>`, never from
/// the start of the string. A message that quotes `</user_input>` ahead of the
/// real block would otherwise be rebuilt around that earlier tag, splicing the
/// opening tag back in and making the string LONGER on every pass — the
/// exponential hang this parser already shipped once, in
/// `strip_environment_details`. Each pass here removes one opening and one
/// closing tag, so the string strictly shrinks and the loop always ends.
fn rewrite_wrapper(text: &str, tag: &str, keep_inner: bool) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut result = text.to_string();
    let mut from = 0usize;

    while let Some(rel) = result[from..].find(&open) {
        let start = from + rel;
        let after_name = start + open.len();
        // `<user_input` must be the whole tag name, not a prefix of
        // `<user_inputs>`; the next character is what decides.
        let rest = &result[after_name..];
        let is_tag = rest
            .chars()
            .next()
            .is_some_and(|c| c == '>' || c.is_whitespace());
        if !is_tag {
            from = after_name;
            continue;
        }
        let Some(gt) = rest.find('>') else { break };
        let inner_start = after_name + gt + 1;
        let Some(close_rel) = result[inner_start..].find(&close) else {
            break;
        };
        let inner_end = inner_start + close_rel;
        let inner = if keep_inner {
            result[inner_start..inner_end].to_string()
        } else {
            String::new()
        };
        let tail = result[inner_end + close.len()..].to_string();
        result = format!("{}{}{}", &result[..start], inner, tail);
        // Rescan from the same offset: the tag that was there is gone, and a
        // nested wrapper that moved into its place still has to be unwrapped.
        from = start;
    }

    result
}

/// Text cleanup for the 3.x session store.
fn clean_session_text(text: &str) -> String {
    let unwrapped = rewrite_wrapper(text, USER_INPUT_TAG, true);
    let unwrapped = rewrite_wrapper(&unwrapped, USER_COMMAND_TAG, true);
    rewrite_wrapper(&unwrapped, MODE_NOTICE_TAG, false)
        .trim()
        .to_string()
}

fn has_user_wrapper(text: &str) -> bool {
    text.contains("<user_input") || text.contains("<user_command")
}

/// Split a 3.x `role:"user"` message into tool results and what the user
/// actually typed.
///
/// cline wraps a real prompt in `<user_input>`/`<user_command>`; everything
/// else arriving under this role is machinery — tool results, the synthesized
/// "you skipped a tool result" filler, mode notices. So a wrapper is the
/// signal, and when a message carries one, only the wrapped parts are the
/// user's words. A message with NO wrapper and no tool results is still
/// surfaced verbatim: that is the shape a future cline would use if it stopped
/// wrapping, and dropping it would silently swallow the prompt.
fn parse_session_user_parts(content: &serde_json::Value) -> UserMessageParts {
    let mut tool_results = Vec::new();
    let mut texts: Vec<String> = Vec::new();

    match content {
        serde_json::Value::String(text) => texts.push(text.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "text" => {
                        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
                            texts.push(text.to_string());
                        }
                    }
                    "tool_result" => {
                        tool_results.push(ContentBlock::ToolResult {
                            tool_use_id: item
                                .get("tool_use_id")
                                .and_then(|v| v.as_str())
                                .map(String::from),
                            output_preview: tool_result_output(item.get("content"))
                                .map(|s| truncate_str(&s, 2000)),
                            is_error: item
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false),
                            agent_stats: None,
                            images: Vec::new(),
                        });
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }

    let any_wrapped = texts.iter().any(|text| has_user_wrapper(text));
    let user_blocks = texts
        .into_iter()
        .filter(|text| {
            if any_wrapped {
                has_user_wrapper(text)
            } else {
                tool_results.is_empty()
            }
        })
        .filter_map(|text| {
            let cleaned = clean_session_text(&text);
            (!cleaned.is_empty()).then_some(ContentBlock::Text { text: cleaned })
        })
        .collect();

    UserMessageParts {
        tool_results,
        user_blocks,
    }
}

/// Strip Cline's `<environment_details>...</environment_details>` blocks and
/// `<task>...</task>` wrappers from user messages to keep content clean.
///
/// Every closing tag is searched from after the opening tag it belongs to, not
/// from the start of the message. Cline wraps what the user typed, so the
/// user's own words land in the same string as these markers, and a message
/// that quotes `</environment_details>` or `</task>` (asking about the wrapper,
/// or pasting a transcript) puts a closing tag ahead of the block it appears to
/// close. Rebuilding the message around that earlier tag splices the opening
/// tag back in and makes the string longer every pass, and reads a reversed
/// byte range.
fn strip_environment_details(text: &str) -> String {
    let mut result = text.to_string();

    // Remove <environment_details>...</environment_details>
    while let Some(start) = result.find(ENV_OPEN) {
        let before = result.len();
        let inner_start = start + ENV_OPEN.len();
        if let Some(close) = result[inner_start..].find(ENV_CLOSE) {
            let end = inner_start + close + ENV_CLOSE.len();
            result = format!("{}{}", &result[..start], &result[end..]);
        } else {
            // Unclosed tag — remove from start to end
            result = result[..start].to_string();
        }
        // Searching the closing tag from `inner_start` is what keeps every
        // pass strictly shorter, and a pass that does not shrink is a pass
        // this loop repeats forever. Asserted rather than left implied
        // because the regression it guards grew the string exponentially: a
        // test that trips it again would hang the run and exhaust memory
        // instead of failing, and this fails it on the first pass.
        debug_assert!(
            result.len() < before,
            "environment strip must shrink the message on every pass"
        );
    }

    // Remove <task>...</task> wrappers, keeping inner content
    while let Some(start) = result.find(TASK_OPEN) {
        let inner_start = start + TASK_OPEN.len();
        let Some(close) = result[inner_start..]
            .find(TASK_CLOSE)
            .map(|i| inner_start + i)
        else {
            break;
        };
        let inner = result[inner_start..close].to_string();
        let after = &result[close + TASK_CLOSE.len()..];
        result = format!("{}{}{}", &result[..start], inner, after);
    }

    // Remove task_progress RECOMMENDED blocks
    while let Some(start) = result.find(TASK_PROGRESS_MARKER) {
        // Find the end: whichever section boundary comes first, or end of
        // string. A `\n#` heading between the block and the next `\n<` tag
        // starts its own section, so it ends this one.
        let rest = &result[start..];
        let end = match (rest.find("\n<"), rest.find("\n#")) {
            (Some(tag), Some(heading)) => Some(tag.min(heading)),
            (tag, heading) => tag.or(heading),
        }
        .map(|i| start + i)
        .unwrap_or(result.len());
        result = format!("{}{}", &result[..start], &result[end..]);
    }

    // Remove [ERROR] automated retry messages
    if result.contains("[ERROR] You did not use a tool") {
        return String::new();
    }

    result.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -----------------------------------------------------------------------
    // cline 3.x session store
    // -----------------------------------------------------------------------

    /// Lay down one `sessions/<id>/` directory the way cline 3.x writes it.
    /// `manifest` and `messages` are the two files verbatim, so a test can
    /// change one field without restating the whole shape.
    fn write_session(
        base: &std::path::Path,
        session_id: &str,
        manifest: serde_json::Value,
        messages: serde_json::Value,
    ) {
        let dir = base.join("sessions").join(session_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{session_id}.json")),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        fs::write(
            dir.join(format!("{session_id}.messages.json")),
            serde_json::to_string(&messages).unwrap(),
        )
        .unwrap();
    }

    /// `ContentBlock` is not `PartialEq`, so assertions read the text out
    /// rather than comparing block values.
    fn texts(blocks: &[ContentBlock]) -> Vec<&str> {
        blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect()
    }

    /// The manifest shape observed from cline 3.0.62, trimmed to the fields
    /// codeg reads.
    fn manifest(session_id: &str) -> serde_json::Value {
        json!({
            "version": 1,
            "session_id": session_id,
            "source": "cli",
            "started_at": "2026-09-16T03:01:23.695Z",
            "status": "idle",
            "interactive": true,
            "provider": "deepseek",
            "model": "deepseek-v4-flash",
            "cwd": "/Users/dev/my-app",
            "workspace_root": "/Users/dev/my-app",
            "prompt": "<user_input mode=\"act\">hi</user_input>",
            "metadata": {
                "title": "Fix the parser",
                "git": {"branch": "master"}
            },
            "messages_path": format!(
                "/Users/dev/.cline/data/sessions/{session_id}/{session_id}.messages.json"
            ),
        })
    }

    fn one_exchange() -> serde_json::Value {
        json!({
            "version": 1,
            "updated_at": "2026-09-16T03:01:34.018Z",
            "agent": "lead",
            "messages": [
                {
                    "id": "msg_1",
                    "role": "user",
                    "content": [{"type": "text", "text": "<user_input mode=\"act\">hi</user_input>"}],
                    "ts": 1_789_527_685_143_i64
                },
                {
                    "id": "msg_2",
                    "role": "assistant",
                    "content": [{"type": "text", "text": "Hi! How can I help?"}],
                    "ts": 1_789_527_686_646_i64,
                    "modelInfo": {"id": "deepseek-v4-flash", "provider": "deepseek"},
                    "metrics": {
                        "inputTokens": 24806,
                        "outputTokens": 108,
                        "cacheReadTokens": 24576,
                        "cacheWriteTokens": 0,
                        "cost": 0.000173
                    }
                }
            ]
        })
    }

    /// The whole point: cline 3.x moved its transcripts from
    /// `tasks/<id>/api_conversation_history.json` to
    /// `sessions/<id>/<id>.messages.json`, and a parser still reading the old
    /// location returns zero turns for every session — which is what the
    /// conversation view renders as "no messages", and what leaves a finished
    /// reply with no model, no tokens and no timestamp under it.
    #[test]
    fn a_3x_session_is_read_from_the_sessions_directory() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", manifest("s1"), one_exchange());

        let parser = ClineParser::with_base_dir(tmp.path().to_path_buf());
        let detail = parser.get_conversation("s1").expect("detail");

        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert_eq!(texts(&detail.turns[0].blocks), vec!["hi"]);

        let reply = &detail.turns[1];
        assert!(matches!(reply.role, TurnRole::Assistant));
        assert_eq!(reply.model.as_deref(), Some("deepseek-v4-flash"));
        let usage = reply.usage.as_ref().expect("per-reply usage");
        assert_eq!(usage.input_tokens, 24806);
        assert_eq!(usage.output_tokens, 108);
        assert_eq!(usage.cache_read_input_tokens, 24576);
        assert!(reply.completed_at.is_some());

        assert_eq!(detail.summary.title.as_deref(), Some("Fix the parser"));
        assert_eq!(detail.summary.folder_path.as_deref(), Some("/Users/dev/my-app"));
        assert_eq!(detail.summary.git_branch.as_deref(), Some("master"));
        assert_eq!(detail.summary.model.as_deref(), Some("deepseek-v4-flash"));
    }

    /// Listing is what the folder fallback searches when the recorded
    /// `external_id` no longer resolves, so it has to see 3.x sessions too.
    /// One directory is one conversation: an agent-team teammate writes a
    /// SIBLING `<other>.messages.json` into the same directory, and a spawned
    /// sub-agent gets no manifest at all, so neither may become a second row.
    #[test]
    fn listing_reports_one_conversation_per_session_directory() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", manifest("s1"), one_exchange());
        fs::write(
            tmp.path()
                .join("sessions")
                .join("s1")
                .join("teammate-7.messages.json"),
            serde_json::to_string(&one_exchange()).unwrap(),
        )
        .unwrap();

        let parser = ClineParser::with_base_dir(tmp.path().to_path_buf());
        let summaries = parser.list_conversations().expect("list");

        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, "s1");
        assert_eq!(summaries[0].message_count, 2);
        assert_eq!(summaries[0].folder_path.as_deref(), Some("/Users/dev/my-app"));
    }

    /// `messages_path` in the manifest is the absolute path the WRITING
    /// process saw. It stops being true the moment the store moves — a
    /// restored backup, `CLINE_DIR`, a test fixture — so the conventional
    /// path next to the manifest has to win, or a relocated store reads as
    /// empty for every session in it.
    #[test]
    fn a_stale_recorded_messages_path_does_not_hide_the_transcript() {
        let tmp = tempfile::tempdir().unwrap();
        let mut manifest = manifest("s1");
        manifest["messages_path"] =
            json!("/nonexistent/machine/.cline/data/sessions/s1/s1.messages.json");
        write_session(tmp.path(), "s1", manifest, one_exchange());

        let parser = ClineParser::with_base_dir(tmp.path().to_path_buf());
        let detail = parser.get_conversation("s1").expect("detail");

        assert_eq!(detail.turns.len(), 2);
    }

    /// Tool results arrive as `role:"user"` messages alongside the automated
    /// filler cline writes next to them. The result belongs on its own system
    /// turn (that is where the renderer pairs it with the `tool_use` above);
    /// the filler is not something the user said and must not be painted as a
    /// prompt.
    #[test]
    fn a_tool_result_is_split_off_from_the_message_carrying_it() {
        let tmp = tempfile::tempdir().unwrap();
        let messages = json!({
            "version": 1,
            "messages": [
                {
                    "role": "assistant",
                    "content": [
                        {"type": "tool_use", "id": "call_1", "name": "read_files",
                         "input": {"files": ["src/main.rs"]}}
                    ],
                    "ts": 1_789_527_685_000_i64
                },
                {
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": "call_1",
                         "content": [{"type": "text", "text": "fn main() {}"}]},
                        {"type": "text", "text": "Continue with the task."}
                    ],
                    "ts": 1_789_527_686_000_i64
                },
                {
                    "role": "user",
                    "content": [{"type": "text", "text": "<user_input mode=\"act\">thanks</user_input>"}],
                    "ts": 1_789_527_687_000_i64
                }
            ]
        });
        write_session(tmp.path(), "s1", manifest("s1"), messages);

        let parser = ClineParser::with_base_dir(tmp.path().to_path_buf());
        let detail = parser.get_conversation("s1").expect("detail");

        let roles: Vec<_> = detail
            .turns
            .iter()
            .map(|t| format!("{:?}", t.role))
            .collect();
        assert_eq!(roles, vec!["Assistant", "System", "User"]);
        match detail.turns[1].blocks.as_slice() {
            [ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            }] => {
                assert_eq!(tool_use_id.as_deref(), Some("call_1"));
                assert_eq!(output_preview.as_deref(), Some("fn main() {}"));
                assert!(!is_error);
            }
            other => panic!("expected exactly one tool result, got {other:?}"),
        }
        assert_eq!(texts(&detail.turns[2].blocks), vec!["thanks"]);
    }

    /// A user message with no wrapper and no tool result is the shape a future
    /// cline would write if it stopped wrapping prompts. Treating the wrapper
    /// as mandatory would swallow the prompt silently, so it is a preference,
    /// not a requirement.
    #[test]
    fn an_unwrapped_lone_prompt_is_still_shown() {
        let tmp = tempfile::tempdir().unwrap();
        let messages = json!({
            "version": 1,
            "messages": [{
                "role": "user",
                "content": [{"type": "text", "text": "plain prompt"}],
                "ts": 1_789_527_685_000_i64
            }]
        });
        write_session(tmp.path(), "s1", manifest("s1"), messages);

        let parser = ClineParser::with_base_dir(tmp.path().to_path_buf());
        let detail = parser.get_conversation("s1").expect("detail");

        assert_eq!(detail.turns.len(), 1);
        assert_eq!(texts(&detail.turns[0].blocks), vec!["plain prompt"]);
    }

    /// Same trap as the pre-3.x stripper, on the tags that replaced those. A
    /// user quoting `</user_input>` puts a closing tag ahead of the opener it
    /// appears to close; rebuilding the message around that earlier tag
    /// splices the opening tag back in and makes the string LONGER every pass,
    /// so the loop never ends and memory runs out. A regression here HANGS the
    /// run rather than failing it, which is why both shapes are pinned.
    #[test]
    fn a_quoted_closing_tag_does_not_hang_the_session_cleanup() {
        // Quoted ahead of the real block: the prompt has to survive whole.
        assert_eq!(
            clean_session_text(
                "</user_input> is the tag. <user_input mode=\"act\">what does it do?</user_input>"
            ),
            "</user_input> is the tag. what does it do?"
        );

        // Quoted INSIDE its own wrapper is markup cline cannot express and
        // codeg cannot recover: the first closing tag ends the block, and the
        // rest is left as written. Asserted so the ambiguity is a recorded
        // outcome rather than an accident — what matters is that the pass
        // shrinks the string and terminates.
        assert_eq!(
            clean_session_text("<user_input mode=\"act\">why is </user_input> in my logs?"),
            "why is  in my logs?"
        );
    }

    #[test]
    fn session_wrappers_are_unwrapped_and_notices_dropped() {
        assert_eq!(
            clean_session_text("<user_command slash=\"init\">/init</user_command>"),
            "/init"
        );
        assert_eq!(
            clean_session_text(
                "<mode_notice>The user switched from plan mode to act mode</mode_notice>\
                 <user_input mode=\"act\">go</user_input>"
            ),
            "go"
        );
        // A tag name must match whole — `<user_inputs>` is not `<user_input>`.
        assert_eq!(
            clean_session_text("<user_inputs>kept</user_inputs>"),
            "<user_inputs>kept</user_inputs>"
        );
        // Every splice below is a byte offset from `str::find`; a CJK or emoji
        // message has to survive it rather than panic on a char boundary.
        assert_eq!(
            clean_session_text("<user_input mode=\"act\">环境说明 🎉</user_input>"),
            "环境说明 🎉"
        );
    }

    /// An unclosed opener is left alone rather than eating the rest of the
    /// message: the transcript of a session still being written ends mid-tag.
    #[test]
    fn an_unclosed_session_wrapper_keeps_its_text() {
        assert_eq!(
            clean_session_text("<user_input mode=\"act\">half a prompt"),
            "<user_input mode=\"act\">half a prompt"
        );
    }

    // -----------------------------------------------------------------------
    // pre-3.x task store (fallback)
    // -----------------------------------------------------------------------

    /// The whole message Cline writes for one user turn: the wrapper, then the
    /// environment block it appends. Everything here reaches
    /// `strip_environment_details` as a single string.
    fn cline_user_message(task: &str) -> String {
        format!(
            "<task>\n{task}\n</task>\n\n<environment_details>\n# VSCode Visible Files\nsrc/main.rs\n\n# Current Time\n2026-03-01T08:00:00Z\n</environment_details>"
        )
    }

    #[test]
    fn strips_the_wrapper_and_the_environment_block() {
        assert_eq!(
            strip_environment_details(&cline_user_message("Fix the parser")),
            "Fix the parser"
        );
    }

    /// A user asking about the wrapper puts `</environment_details>` in their
    /// own text, ahead of the block Cline appends. Closing the block at that
    /// earlier tag re-splices the opening tag into the result and makes the
    /// string longer on every pass, so the loop never ends: opening the
    /// conversation used to hang the parse and grow memory without bound.
    #[test]
    fn a_quoted_closing_tag_does_not_hang_the_environment_strip() {
        let quoted = "Why do I see </environment_details> in my logs?";
        let cleaned = strip_environment_details(&cline_user_message(quoted));
        assert_eq!(cleaned, quoted);
    }

    /// Same slip in the `<task>` loop reads a reversed byte range instead of
    /// looping, because the close tag ends up before the open tag's inner
    /// start. `&result[23..0]` panics.
    #[test]
    fn a_leading_closing_task_tag_does_not_panic() {
        assert_eq!(
            strip_environment_details("</task> leftover\n<task>real work</task>"),
            "</task> leftover\nreal work"
        );
    }

    /// Nested wrappers must still collapse to their innermost content, which is
    /// the behaviour the first closing tag after the opening one already gave.
    #[test]
    fn nested_task_wrappers_collapse() {
        assert_eq!(
            strip_environment_details("<task>outer <task>inner</task> tail</task>"),
            "outer inner tail"
        );
    }

    /// An unclosed opening tag still truncates at it, and an unclosed `<task>`
    /// still leaves the message alone rather than dropping the rest of it.
    #[test]
    fn unclosed_openers_keep_their_old_behaviour() {
        assert_eq!(
            strip_environment_details("kept\n<environment_details>\nnoise"),
            "kept"
        );
        assert_eq!(
            strip_environment_details("<task>no close"),
            "<task>no close"
        );
    }

    /// `# task_progress RECOMMENDED` runs to the next section. A markdown
    /// heading is a section, so a heading between the block and the next tag
    /// ends it. Preferring `\n<` regardless of position swallowed everything
    /// in between, here the whole `# Notes` section. The tag has to be one the
    /// earlier loops leave alone, which is every Cline tool tag.
    #[test]
    fn the_task_progress_block_ends_at_the_first_boundary() {
        let text = "intro\n# task_progress RECOMMENDED\n- [ ] step one\n# Notes\nkeep this\n<read_file>\n<path>src/main.rs</path>\n</read_file>";
        assert_eq!(
            strip_environment_details(text),
            "intro\n\n# Notes\nkeep this\n<read_file>\n<path>src/main.rs</path>\n</read_file>"
        );
    }

    /// The block Cline really sends, so the boundary above is pinned against
    /// the shape it exists for and not only against the synthetic one. Cline
    /// pushes the focus-chain instructions as their own content part
    /// (`FocusChainManager.generateFocusChainInstructions` →
    /// `userContent.push`), and no line inside them opens with `#` or `<`, so
    /// both searches come back empty and the whole block runs off the end of
    /// the string. Ending at the first boundary therefore changes nothing for
    /// a real transcript. Text mirrors cline's
    /// `src/core/task/focus-chain/prompts.ts`.
    #[test]
    fn the_real_task_progress_block_is_removed_whole() {
        let recommended = "\n\
             # task_progress RECOMMENDED\n\
             \n\
             When starting a new task, it is recommended to include a todo list \
             using the task_progress parameter.\n\
             \n\
             \n\
             1. Include a todo list using the task_progress parameter in your next tool call\n\
             2. Create a comprehensive checklist of all steps needed\n\
             3. Use markdown format: - [ ] for incomplete, - [x] for complete\n\
             \n\
             **Benefits of creating a todo/task_progress list now:**\n\
             \t- Clear roadmap for implementation\n\
             \t- Progress tracking throughout the task\n\
             \t- Nothing gets forgotten or missed\n\
             \t- Users can see, monitor, and edit the plan\n\
             \n\
             **Example structure:**```\n\
             - [ ] Analyze requirements\n\
             - [ ] Set up necessary files\n\
             - [ ] Implement main functionality\n\
             - [ ] Handle edge cases\n\
             - [ ] Test the implementation\n\
             - [ ] Verify results```\n\
             \n\
             Keeping the task_progress list updated helps track progress and \
             ensures nothing is missed.\n";
        assert!(recommended.starts_with("\n# task_progress RECOMMENDED\n"));
        assert_eq!(strip_environment_details(recommended), "");
    }

    /// Every index this file splices on comes from `str::find` and is a byte
    /// offset, so a message in a non-ASCII script has to come through intact:
    /// an offset that lands inside a multi-byte character panics with `byte
    /// index is not a char boundary` on the very next slice.
    #[test]
    fn multibyte_text_around_the_markers_survives() {
        let quoted = "环境说明 </environment_details> 是什么？🎉";
        assert_eq!(
            strip_environment_details(&cline_user_message(quoted)),
            quoted
        );
    }

    /// Feedback quoted ahead of the real block used to come back as `None`,
    /// because the closing tag found first sat before the opening one.
    #[test]
    fn feedback_is_read_from_its_own_closing_tag() {
        assert_eq!(
            extract_feedback("the </feedback> tag: <feedback>looks good</feedback>"),
            Some("looks good".to_string())
        );
        assert_eq!(
            extract_feedback("<feedback>plain</feedback>"),
            Some("plain".to_string())
        );
        assert_eq!(extract_feedback("no tags here"), None);
        assert_eq!(extract_feedback("<feedback>unclosed"), None);
    }
}
