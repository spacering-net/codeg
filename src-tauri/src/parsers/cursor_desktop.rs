use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageTurn, TurnRole,
    TurnUsage,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    merge_context_window_stats, relocate_orphaned_tool_results, structurize_read_tool_output,
    title_from_user_text, truncate_str, AgentEnv, AgentParser, ParseError,
};

const TOOL_INPUT_CAP: usize = 8_000;
const TOOL_OUTPUT_CAP: usize = 100_000;

pub struct CursorDesktopParser {
    stores: Vec<DesktopStore>,
}

struct DesktopStore {
    db_path: PathBuf,
    user_dir: PathBuf,
    workspace_path: Option<String>,
    modified: Option<SystemTime>,
}

#[derive(Default)]
struct ComposerHead {
    workspace_id: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    is_subagent: bool,
    document: Option<Value>,
}

struct BubbleRef {
    id: String,
    role: Option<i64>,
    created_at: Option<DateTime<Utc>>,
    completed_at: Option<DateTime<Utc>>,
}

impl CursorDesktopParser {
    pub fn for_env(env: &AgentEnv) -> Self {
        let mut stores: Vec<DesktopStore> = desktop_user_dirs(env)
            .into_iter()
            .flat_map(|dir| discover_stores(&dir))
            .collect();
        stores.sort_by_key(|store| std::cmp::Reverse(store.modified));
        Self { stores }
    }

    #[cfg(any(test, feature = "test-utils"))]
    pub fn empty() -> Self {
        Self { stores: vec![] }
    }

    fn build_summary(
        &self,
        conn: &Connection,
        store: &DesktopStore,
        id: &str,
        head: ComposerHead,
    ) -> Option<ConversationSummary> {
        let doc = read_composer(conn, id, &head)?;
        if head.is_subagent || doc.get("isSubagent").and_then(Value::as_bool) == Some(true) {
            return None;
        }
        let (_, refs) = bubble_refs(conn, &doc, id);
        if refs.is_empty() {
            return None;
        }
        let summary = summary_from(conn, store, id, &doc, &head, &refs, refs.len() as u32);
        let model = summary.model.clone();
        let has_decodable_turn = refs.iter().any(|reference| {
            build_turn(
                conn,
                id,
                reference,
                &doc,
                model.as_deref(),
                summary.started_at,
            )
            .is_some()
        });
        has_decodable_turn.then_some(summary)
    }

    fn build_detail(
        &self,
        conn: &Connection,
        store: &DesktopStore,
        id: &str,
    ) -> Option<ConversationDetail> {
        let head = composer_head(conn, id).unwrap_or_default();
        let doc = read_composer(conn, id, &head)?;
        let (_, refs) = bubble_refs(conn, &doc, id);
        if refs.is_empty() {
            return None;
        }
        let mut summary = summary_from(conn, store, id, &doc, &head, &refs, refs.len() as u32);
        let fallback_ts = summary.started_at;
        let model = summary.model.clone();
        let mut turns: Vec<MessageTurn> = refs
            .iter()
            .filter_map(|reference| {
                build_turn(conn, id, reference, &doc, model.as_deref(), fallback_ts)
            })
            .collect();
        if turns.is_empty() {
            return None;
        }
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        backfill_turn_durations(&mut turns, &[]);
        summary.message_count = turns.len() as u32;
        summary.ended_at = turns
            .last()
            .and_then(|turn| turn.completed_at.or(Some(turn.timestamp)))
            .or(summary.ended_at);
        if summary.title.is_none() {
            summary.title = turns.iter().find_map(|turn| {
                if !matches!(turn.role, TurnRole::User) {
                    return None;
                }
                turn.blocks.iter().find_map(|block| match block {
                    ContentBlock::Text { text } if !text.trim().is_empty() => {
                        Some(title_from_user_text(text))
                    }
                    _ => None,
                })
            });
        }
        let session_stats = merge_context_window_stats(
            compute_session_stats(&turns),
            doc.get("contextTokensUsed").and_then(Value::as_u64),
            doc.get("contextTokenLimit").and_then(Value::as_u64),
        );
        Some(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: None,
        })
    }
}

impl AgentParser for CursorDesktopParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        let mut seen = HashSet::new();
        for store in &self.stores {
            let Some(conn) = open_store(&store.db_path) else {
                continue;
            };
            for (id, head) in composer_heads(&conn) {
                if seen.contains(&id) {
                    continue;
                }
                if let Some(summary) = self.build_summary(&conn, store, &id, head) {
                    seen.insert(id);
                    conversations.push(summary);
                }
            }
        }
        conversations.sort_by_key(|summary| std::cmp::Reverse(summary.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        for store in &self.stores {
            let Some(conn) = open_store(&store.db_path) else {
                continue;
            };
            if let Some(detail) = self.build_detail(&conn, store, conversation_id) {
                return Ok(detail);
            }
        }
        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

fn desktop_user_dirs(env: &AgentEnv) -> Vec<PathBuf> {
    if let Some(dir) = env
        .var_os("CURSOR_DESKTOP_USER_DIR")
        .filter(|v| !v.is_empty())
    {
        return vec![PathBuf::from(dir)];
    }
    let mut out = Vec::new();
    #[cfg(target_os = "macos")]
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("Library/Application Support/Cursor/User"));
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(app_data) = env.var_os("APPDATA").filter(|v| !v.is_empty()) {
            out.push(PathBuf::from(app_data).join("Cursor/User"));
        } else if let Some(home) = dirs::home_dir() {
            out.push(home.join("AppData/Roaming/Cursor/User"));
        }
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        if let Some(config) = env.var_os("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
            out.push(PathBuf::from(config).join("Cursor/User"));
        } else if let Some(home) = dirs::home_dir() {
            out.push(home.join(".config/Cursor/User"));
        }
    }
    out
}

fn discover_stores(user_dir: &Path) -> Vec<DesktopStore> {
    let mut stores = Vec::new();
    if let Some(store) =
        DesktopStore::new(user_dir, user_dir.join("globalStorage/state.vscdb"), None)
    {
        stores.push(store);
    }
    let workspace_root = user_dir.join("workspaceStorage");
    let Ok(entries) = std::fs::read_dir(workspace_root) else {
        return stores;
    };
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let workspace_path = read_workspace_path(&entry.path());
        if let Some(store) =
            DesktopStore::new(user_dir, entry.path().join("state.vscdb"), workspace_path)
        {
            stores.push(store);
        }
    }
    stores
}

fn read_workspace_path(workspace_dir: &Path) -> Option<String> {
    let bytes = std::fs::read(workspace_dir.join("workspace.json")).ok()?;
    let json = serde_json::from_slice::<Value>(&bytes).ok()?;
    ["folder", "workspace", "directory"]
        .into_iter()
        .find_map(|key| json.get(key).and_then(Value::as_str))
        .and_then(uri_to_path)
}

impl DesktopStore {
    fn new(user_dir: &Path, db_path: PathBuf, workspace_path: Option<String>) -> Option<Self> {
        let metadata = std::fs::metadata(&db_path).ok()?;
        if !metadata.is_file() || metadata.len() == 0 {
            return None;
        }
        Some(Self {
            db_path,
            user_dir: user_dir.to_path_buf(),
            workspace_path,
            modified: metadata.modified().ok(),
        })
    }
}

fn open_store(path: &Path) -> Option<Connection> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(200));
    conn.query_row("SELECT 1 FROM cursorDiskKV LIMIT 1", [], |row| {
        row.get::<_, i64>(0)
    })
    .ok()?;
    Some(conn)
}

fn composer_heads(conn: &Connection) -> Vec<(String, ComposerHead)> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let has_headers = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master \
             WHERE type = 'table' AND name = 'composerHeaders'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if has_headers {
        if let Ok(mut stmt) = conn.prepare(
            "SELECT composerId, workspaceId, createdAt, lastUpdatedAt, isSubagent, value \
             FROM composerHeaders",
        ) {
            if let Ok(rows) = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    ComposerHead {
                        workspace_id: row.get::<_, Option<String>>(1)?,
                        created_at: row.get::<_, Option<i64>>(2)?.and_then(ms_to_utc),
                        updated_at: row.get::<_, Option<i64>>(3)?.and_then(ms_to_utc),
                        is_subagent: row.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                        document: row
                            .get::<_, Option<String>>(5)?
                            .and_then(|raw| serde_json::from_str(&raw).ok()),
                    },
                ))
            }) {
                for (id, head) in rows.flatten() {
                    if seen.insert(id.clone()) {
                        out.push((id, head));
                    }
                }
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare(
        "SELECT key FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;'",
    ) {
        if let Ok(rows) = stmt.query_map([], |row| row.get::<_, String>(0)) {
            for key in rows.flatten() {
                let Some(id) = key.strip_prefix("composerData:") else {
                    continue;
                };
                if !id.is_empty() && seen.insert(id.to_string()) {
                    out.push((id.to_string(), ComposerHead::default()));
                }
            }
        }
    }
    out
}

fn composer_head(conn: &Connection, id: &str) -> Option<ComposerHead> {
    conn.query_row(
        "SELECT workspaceId, createdAt, lastUpdatedAt, isSubagent, value \
         FROM composerHeaders WHERE composerId = ?1",
        [id],
        |row| {
            Ok(ComposerHead {
                workspace_id: row.get::<_, Option<String>>(0)?,
                created_at: row.get::<_, Option<i64>>(1)?.and_then(ms_to_utc),
                updated_at: row.get::<_, Option<i64>>(2)?.and_then(ms_to_utc),
                is_subagent: row.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                document: row
                    .get::<_, Option<String>>(4)?
                    .and_then(|raw| serde_json::from_str(&raw).ok()),
            })
        },
    )
    .ok()
}

fn read_composer(conn: &Connection, id: &str, head: &ComposerHead) -> Option<Value> {
    read_json(conn, &format!("composerData:{id}")).or_else(|| head.document.clone())
}

fn read_json(conn: &Connection, key: &str) -> Option<Value> {
    let raw = conn
        .query_row(
            "SELECT value FROM cursorDiskKV WHERE key = ?1",
            [key],
            |row| Ok(row.get_ref(0)?.as_bytes()?.to_vec()),
        )
        .ok()?;
    serde_json::from_slice(&raw).ok()
}

fn bubble_refs(conn: &Connection, doc: &Value, id: &str) -> (bool, Vec<BubbleRef>) {
    if let Some(headers) = doc
        .get("fullConversationHeadersOnly")
        .and_then(Value::as_array)
        .filter(|headers| !headers.is_empty())
    {
        return (true, refs_from_headers(headers.iter()));
    }
    if let Some(log) = doc.get("headerLog") {
        let chunk_count = log.get("chunkCount").and_then(Value::as_u64).unwrap_or(0);
        if chunk_count > 10_000 {
            return (true, Vec::new());
        }
        let mut refs = Vec::new();
        for index in 0..chunk_count {
            let key = format!("composerConvHeaders:{id}:{index:06}");
            let Some(chunk) = read_json(conn, &key) else {
                return (true, Vec::new());
            };
            let Some(headers) = chunk.as_array() else {
                return (true, Vec::new());
            };
            refs.extend(refs_from_headers(headers.iter()));
        }
        return (true, refs);
    }

    let mut refs = Vec::new();
    if let Ok(mut stmt) =
        conn.prepare("SELECT key FROM cursorDiskKV WHERE key >= ?1 AND key < ?2 ORDER BY rowid")
    {
        let prefix = format!("bubbleId:{id}:");
        let upper = format!("{prefix}\u{10ffff}");
        if let Ok(rows) = stmt.query_map([prefix.clone(), upper], |row| row.get::<_, String>(0)) {
            for key in rows.flatten() {
                if let Some(bubble_id) = key.strip_prefix(&prefix) {
                    refs.push(BubbleRef {
                        id: bubble_id.to_string(),
                        role: None,
                        created_at: None,
                        completed_at: None,
                    });
                }
            }
        }
    }
    (false, refs)
}

fn refs_from_headers<'a>(headers: impl Iterator<Item = &'a Value>) -> Vec<BubbleRef> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for header in headers {
        if header
            .get("grouping")
            .and_then(|group| group.get("isRenderable"))
            .and_then(Value::as_bool)
            == Some(false)
        {
            continue;
        }
        let Some(id) = header.get("bubbleId").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(BubbleRef {
            id: id.to_string(),
            role: header.get("type").and_then(Value::as_i64),
            created_at: json_datetime(header.get("createdAt"))
                .or_else(|| json_datetime(header.get("startedAtMs"))),
            completed_at: json_datetime(header.get("completedAtMs")),
        });
    }
    out
}

fn summary_from(
    conn: &Connection,
    store: &DesktopStore,
    id: &str,
    doc: &Value,
    head: &ComposerHead,
    refs: &[BubbleRef],
    message_count: u32,
) -> ConversationSummary {
    let title = non_empty_field(doc, "name")
        .or_else(|| non_empty_field(doc, "title"))
        .or_else(|| {
            refs.iter()
                .find(|reference| reference.role == Some(1))
                .and_then(|reference| {
                    let bubble = read_json(conn, &format!("bubbleId:{id}:{}", reference.id))?;
                    bubble_text(&bubble).map(|text| title_from_user_text(&text))
                })
        });
    let folder_path = workspace_path(doc)
        .or_else(|| {
            head.workspace_id
                .as_deref()
                .or_else(|| {
                    doc.get("workspaceIdentifier")
                        .and_then(|workspace| workspace.get("id"))
                        .and_then(Value::as_str)
                })
                .and_then(|workspace_id| {
                    read_workspace_path(&store.user_dir.join("workspaceStorage").join(workspace_id))
                })
        })
        .or_else(|| store.workspace_path.clone());
    let started_at = json_datetime(doc.get("createdAt"))
        .or(head.created_at)
        .or_else(|| refs.first().and_then(|reference| reference.created_at))
        .unwrap_or_else(Utc::now);
    let ended_at = refs
        .last()
        .and_then(|reference| reference.completed_at.or(reference.created_at))
        .or_else(|| json_datetime(doc.get("lastUpdatedAt")))
        .or(head.updated_at);
    ConversationSummary {
        id: id.to_string(),
        agent_type: AgentType::Cursor,
        folder_name: folder_path.as_deref().map(folder_name_from_path),
        folder_path,
        title,
        started_at,
        ended_at,
        message_count,
        model: doc
            .get("modelConfig")
            .and_then(|config| non_empty_field(config, "modelName")),
        git_branch: doc
            .get("trackedGitRepos")
            .and_then(Value::as_array)
            .and_then(|repos| repos.first())
            .and_then(|repo| {
                non_empty_field(repo, "branchName").or_else(|| non_empty_field(repo, "branch"))
            }),
        parent_id: None,
        parent_tool_use_id: None,
        delegation_call_id: None,
    }
}

fn workspace_path(doc: &Value) -> Option<String> {
    for key in ["projectPath", "workspaceDirectory"] {
        if let Some(path) = doc.get(key).and_then(Value::as_str).and_then(uri_to_path) {
            return Some(path);
        }
    }
    for container in ["workspaceIdentifier", "agentLocation"] {
        let Some(value) = doc.get(container) else {
            continue;
        };
        let uri = if container == "agentLocation" {
            value.get("environment").and_then(|env| env.get("uri"))
        } else {
            value.get("uri")
        };
        if let Some(uri) = uri {
            for key in ["fsPath", "path", "external"] {
                if let Some(path) = uri.get(key).and_then(Value::as_str).and_then(uri_to_path) {
                    return Some(path);
                }
            }
        }
    }
    doc.get("trackedGitRepos")
        .and_then(Value::as_array)
        .and_then(|repos| repos.first())
        .and_then(|repo| non_empty_field(repo, "repoPath"))
}

fn uri_to_path(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    if raw.starts_with("file://") {
        if let Ok(url) = url::Url::parse(raw) {
            if let Ok(path) = url.to_file_path() {
                return Some(path.to_string_lossy().into_owned());
            }
        }
        let stripped = raw.trim_start_matches("file://");
        return urlencoding::decode(stripped)
            .ok()
            .map(|path| path.into_owned());
    }
    Some(raw.to_string())
}

fn build_turn(
    conn: &Connection,
    composer_id: &str,
    reference: &BubbleRef,
    _doc: &Value,
    composer_model: Option<&str>,
    fallback_ts: DateTime<Utc>,
) -> Option<MessageTurn> {
    let bubble = read_json(conn, &format!("bubbleId:{composer_id}:{}", reference.id))?;
    let mut blocks = Vec::new();
    if let Some(thinking) = bubble
        .get("thinking")
        .and_then(|value| non_empty_field(value, "text"))
    {
        blocks.push(ContentBlock::Thinking { text: thinking });
    }
    if let Some(text) = bubble_text(&bubble) {
        if !text.trim().is_empty() {
            blocks.push(ContentBlock::Text { text });
        }
    }
    if let Some(tool) = bubble.get("toolFormerData").filter(|tool| tool.is_object()) {
        decode_tool(tool, reference, &mut blocks);
    }
    if blocks.is_empty() {
        return None;
    }

    let timing = bubble.get("timingInfo");
    let start_ms = timing
        .and_then(|value| value.get("clientStartTime"))
        .and_then(Value::as_f64);
    let end_ms = timing
        .and_then(|value| value.get("clientEndTime"))
        .and_then(Value::as_f64)
        .or_else(|| {
            timing
                .and_then(|value| value.get("clientSettleTime"))
                .and_then(Value::as_f64)
        });
    let timestamp = json_datetime(bubble.get("createdAt"))
        .or(reference.created_at)
        .or_else(|| start_ms.and_then(float_ms_to_utc))
        .unwrap_or(fallback_ts);
    let completed_at = end_ms.and_then(float_ms_to_utc).or(reference.completed_at);
    let duration_ms = start_ms
        .zip(end_ms)
        .and_then(|(start, end)| (end > start).then_some((end - start).round() as u64));
    let role = bubble
        .get("type")
        .and_then(Value::as_i64)
        .or(reference.role)
        .unwrap_or(2);
    let usage = bubble.get("tokenCount").map(|tokens| TurnUsage {
        input_tokens: tokens
            .get("inputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: tokens
            .get("outputTokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
    });
    let model = bubble
        .get("modelInfo")
        .and_then(|info| non_empty_field(info, "modelName"))
        .or_else(|| composer_model.map(str::to_string));
    let id = bubble
        .get("bubbleId")
        .and_then(Value::as_str)
        .unwrap_or(&reference.id)
        .to_string();
    let agent_message_id = bubble
        .get("serverBubbleId")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some(MessageTurn {
        id,
        role: if role == 1 {
            TurnRole::User
        } else {
            TurnRole::Assistant
        },
        blocks,
        timestamp,
        usage,
        duration_ms,
        model,
        completed_at,
        agent_message_id,
    })
}

fn bubble_text(bubble: &Value) -> Option<String> {
    for key in ["text", "markdown", "message"] {
        if let Some(text) = bubble.get(key).and_then(text_value) {
            return Some(text);
        }
    }
    if let Some(content) = bubble.get("content").and_then(text_value) {
        return Some(content);
    }
    bubble
        .get("richText")
        .and_then(Value::as_str)
        .filter(|text| {
            let trimmed = text.trim_start();
            !trimmed.starts_with('{') && !trimmed.starts_with('[')
        })
        .map(str::to_string)
}

fn text_value(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_string());
    }
    if let Some(items) = value.as_array() {
        let text = items
            .iter()
            .filter_map(text_value)
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.is_empty()).then_some(text);
    }
    if let Some(object) = value.as_object() {
        for key in ["text", "content"] {
            if let Some(text) = object.get(key).and_then(text_value) {
                return Some(text);
            }
        }
    }
    None
}

fn decode_tool(tool: &Value, reference: &BubbleRef, blocks: &mut Vec<ContentBlock>) {
    let name = non_empty_field(tool, "name")
        .or_else(|| {
            tool.get("tool").and_then(Value::as_i64).map(|id| match id {
                15 => "run_terminal_command_v2".to_string(),
                40 => "read_file_v2".to_string(),
                41 => "ripgrep_raw_search".to_string(),
                42 => "glob_file_search".to_string(),
                51 => "ask_question".to_string(),
                other => format!("cursor-tool-{other}"),
            })
        })
        .unwrap_or_else(|| "tool".to_string());
    let id = non_empty_field(tool, "toolCallId")
        .unwrap_or_else(|| format!("cursor-desktop-tool-{}", reference.id));
    let input = tool
        .get("params")
        .or_else(|| tool.get("rawArgs"))
        .map(preview_value)
        .map(|value| truncate_str(&value, TOOL_INPUT_CAP));
    let output = tool
        .get("result")
        .map(preview_value)
        .map(|value| truncate_str(&value, TOOL_OUTPUT_CAP));
    let status = tool.get("status").and_then(Value::as_str);
    let exit_code = tool
        .get("result")
        .and_then(|result| match result {
            Value::String(raw) => serde_json::from_str::<Value>(raw).ok(),
            other => Some(other.clone()),
        })
        .and_then(|result| {
            result
                .get("exitCode")
                .or_else(|| result.get("exit_code"))
                .and_then(Value::as_i64)
        });
    let is_error = status.is_some_and(|status| {
        matches!(
            status.to_ascii_lowercase().as_str(),
            "error" | "failed" | "rejected" | "cancelled" | "canceled"
        )
    }) || exit_code.is_some_and(|code| code != 0);
    blocks.push(ContentBlock::ToolUse {
        tool_use_id: Some(id.clone()),
        tool_name: name,
        input_preview: input,
        status: status.map(str::to_string),
        meta: None,
    });
    blocks.push(ContentBlock::ToolResult {
        tool_use_id: Some(id),
        output_preview: output,
        is_error,
        agent_stats: None,
        images: Vec::new(),
        exit_code,
    });
}

fn preview_value(value: &Value) -> String {
    match value {
        Value::String(raw) => raw.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn non_empty_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn json_datetime(value: Option<&Value>) -> Option<DateTime<Utc>> {
    let value = value?;
    if let Some(ms) = value.as_i64() {
        return ms_to_utc(ms);
    }
    if let Some(ms) = value.as_f64() {
        return float_ms_to_utc(ms);
    }
    let text = value.as_str()?;
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.with_timezone(&Utc))
        .or_else(|| text.parse::<i64>().ok().and_then(ms_to_utc))
}

fn ms_to_utc(ms: i64) -> Option<DateTime<Utc>> {
    Utc.timestamp_millis_opt(ms).single()
}

fn float_ms_to_utc(ms: f64) -> Option<DateTime<Utc>> {
    if !ms.is_finite() || ms < i64::MIN as f64 || ms > i64::MAX as f64 {
        return None;
    }
    ms_to_utc(ms.round() as i64)
}
