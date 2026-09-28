use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    AgentExecutionStats, AgentToolCall, AgentType, ContentBlock, ConversationDetail,
    ConversationSummary, MessageRole, MessageTurn, TurnRole, TurnUsage, UnifiedMessage,
};
use crate::parsers::claude::{
    capture_tag, task_notification_status_regex, task_notification_summary_regex,
    task_notification_task_id_regex, BACKGROUND_TASK_MARKER,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, is_safe_subagent_id, latest_turn_total_usage_tokens,
    merge_context_window_stats, relocate_orphaned_tool_results, resolve_patch_line_numbers,
    structurize_read_tool_output, title_from_user_text, truncate_str, AgentParser, ParseError,
};

/// Resolve CodeBuddy's config dir, honoring `CODEBUDDY_CONFIG_DIR`, else
/// `~/.codebuddy` (mirrors `resolve_claude_config_dir`).
pub(crate) fn resolve_codebuddy_config_dir() -> PathBuf {
    resolve_codebuddy_config_dir_from(std::env::var_os("CODEBUDDY_CONFIG_DIR"), dirs::home_dir())
}

fn resolve_codebuddy_config_dir_from(
    codebuddy_config_dir_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    codebuddy_config_dir_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".codebuddy"))
}

/// CodeBuddy (Tencent Cloud) stores its transcripts under
/// `~/.codebuddy/projects/<encoded-cwd>/<sessionId>.jsonl`, borrowing Claude
/// Code's *directory layout* — but the per-line record schema is the OpenAI
/// Agents SDK "items" shape, NOT Claude's: top-level `type`
/// (`message`/`reasoning`/`function_call`/`function_call_result`/`ai-title`/…),
/// a top-level `role` with a `content[]` array of `input_text`/`output_text`
/// items, and millisecond-epoch timestamps. So this parser reads those records
/// directly rather than reusing the Claude parser.
pub struct CodeBuddyParser {
    base_dir: PathBuf,
}

impl CodeBuddyParser {
    pub fn new() -> Self {
        Self {
            base_dir: resolve_codebuddy_config_dir().join("projects"),
        }
    }

    /// Construct a parser pointed at an explicit `projects` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    fn parse_summary(&self, path: &Path) -> Option<ConversationSummary> {
        let reader = BufReader::new(fs::File::open(path).ok()?);

        let mut first_ts: Option<DateTime<Utc>> = None;
        let mut last_ts: Option<DateTime<Utc>> = None;
        let mut titles = CodeBuddyTitles::default();
        let mut first_user_text: Option<String> = None;
        let mut model: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut session_id: Option<String> = None;
        let mut message_count: u32 = 0;

        for line in reader.lines() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if is_content_record(record_type) {
                if let Some(ts) = record_millis(&value) {
                    first_ts.get_or_insert(ts);
                    last_ts = Some(ts);
                }
            }
            if cwd.is_none() {
                cwd = record_cwd(&value);
            }
            if session_id.is_none() {
                session_id = value
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .map(String::from);
            }
            if model.is_none() {
                model = record_model(&value);
            }

            match record_type {
                "custom-title" | "ai-title" | "topic" => titles.feed(record_type, &value),
                "message" => match value.get("role").and_then(|r| r.as_str()).unwrap_or("") {
                    // A system-injected user record is not a prompt (see
                    // `is_injected_user_record`): it must not be counted, nor
                    // become the fallback title. The guard makes it fall to the
                    // `_` arm — `parse_detail` applies the SAME exclusion, and
                    // the two paths MUST agree or the auto-title backfill would
                    // oscillate between them.
                    "user" if !is_injected_user_record(&value) => {
                        message_count += 1;
                        if first_user_text.is_none() {
                            let text = collect_text(&value, "input_text");
                            if !text.trim().is_empty() {
                                first_user_text = Some(title_from_user_text(text.trim()));
                            }
                        }
                    }
                    "assistant" => message_count += 1,
                    _ => {}
                },
                _ => {}
            }
        }

        let started_at = first_ts?;
        let id = session_id.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        });
        let folder_name = cwd.as_deref().map(folder_name_from_path);

        Some(ConversationSummary {
            id,
            agent_type: AgentType::CodeBuddy,
            folder_path: cwd,
            folder_name,
            title: titles.resolve(first_user_text),
            started_at,
            ended_at: last_ts,
            message_count,
            model,
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }

    fn parse_detail(
        &self,
        path: &Path,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let reader = BufReader::new(fs::File::open(path)?);

        let mut messages: Vec<UnifiedMessage> = Vec::new();
        let mut first_ts: Option<DateTime<Utc>> = None;
        let mut last_ts: Option<DateTime<Utc>> = None;
        let mut titles = CodeBuddyTitles::default();
        let mut first_user_text: Option<String> = None;
        let mut model: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut message_count: u32 = 0;
        // `callId`s of `function_call`s classified as an `Agent` delegation. Only
        // their paired results may load a sub-agent transcript — so an ordinary
        // tool result that happens to carry a `subAgent` block (corruption,
        // schema drift, a future tool) can never gain `agent_stats`. Uses the
        // same agent classification as the tool-use rename, so it tracks "Agent"
        // and the Claude-style "Task"+subagent_type form alike.
        let mut agent_call_ids: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        // Async `Agent` launch acks: tool `callId` → the detached worker's task
        // id (`spawned_task_id`). Joined with `background_notifications` by
        // `apply_background_lifecycle` once every record has been read.
        let mut background_acks: std::collections::HashMap<String, String> =
            std::collections::HashMap::new();
        // task id → `(status, summary)` of its LATEST `<task-notification>`. The
        // same id can notify more than once (a resumed worker re-notifies), so
        // last wins — mirroring `claude.rs`.
        let mut background_notifications: std::collections::HashMap<
            String,
            (String, Option<String>),
        > = std::collections::HashMap::new();

        for (idx, line) in reader.lines().enumerate() {
            let Ok(line) = line else { continue };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };

            let record_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
            let ts_raw = record_millis(&value);
            if is_content_record(record_type) {
                if let Some(ts) = ts_raw {
                    first_ts.get_or_insert(ts);
                    last_ts = Some(ts);
                }
            }
            let ts = ts_raw.or(last_ts).unwrap_or_else(Utc::now);

            if cwd.is_none() {
                cwd = record_cwd(&value);
            }
            if model.is_none() {
                model = record_model(&value);
            }

            match record_type {
                "custom-title" | "ai-title" | "topic" => titles.feed(record_type, &value),
                "message" => match value.get("role").and_then(|r| r.as_str()).unwrap_or("") {
                    "user" => {
                        let text = collect_text(&value, "input_text");
                        if is_injected_user_record(&value) {
                            // Never a prompt (see `is_injected_user_record`):
                            // harvest the background-worker settlement it
                            // carries for the lifecycle fold, then drop the
                            // record entirely — no user turn, no message count,
                            // no fallback title.
                            capture_task_notification(&text, &mut background_notifications);
                        } else {
                            message_count += 1;
                            if first_user_text.is_none() && !text.trim().is_empty() {
                                first_user_text = Some(title_from_user_text(text.trim()));
                            }
                            if !text.trim().is_empty() {
                                messages.push(text_message(
                                    format!("cb-user-{idx}"),
                                    MessageRole::User,
                                    text,
                                    ts,
                                    None,
                                    None,
                                ));
                            }
                        }
                    }
                    "assistant" => {
                        message_count += 1;
                        let text = collect_text(&value, "output_text");
                        if !text.trim().is_empty() {
                            messages.push(text_message(
                                format!("cb-assistant-{idx}"),
                                MessageRole::Assistant,
                                text,
                                ts,
                                usage_from_raw(&value),
                                record_model(&value),
                            ));
                        }
                    }
                    _ => {}
                },
                "reasoning" => {
                    let text = reasoning_text(&value);
                    if !text.trim().is_empty() {
                        messages.push(UnifiedMessage {
                            id: format!("cb-reasoning-{idx}"),
                            role: MessageRole::Assistant,
                            content: vec![ContentBlock::Thinking { text }],
                            timestamp: ts,
                            usage: None,
                            duration_ms: None,
                            model: record_model(&value),
                            completed_at: Some(ts),
                        agent_message_id: None,
                        });
                    }
                }
                "function_call" => {
                    let tool_call_id = call_id(&value);
                    let tool_name = resolve_tool_call_name(&value);
                    if tool_name == "Agent" {
                        if let Some(id) = &tool_call_id {
                            agent_call_ids.insert(id.clone());
                        }
                    }
                    messages.push(UnifiedMessage {
                        id: format!("cb-toolcall-{idx}"),
                        role: MessageRole::Assistant,
                        content: vec![ContentBlock::ToolUse {
                            tool_use_id: tool_call_id,
                            tool_name,
                            input_preview: tool_input_preview(&value),
                            status: None,
                            meta: None,
                        }],
                        timestamp: ts,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: Some(ts),
                    agent_message_id: None,
                    });
                }
                "function_call_result" => {
                    let tool_call_id = call_id(&value);
                    // Both the sub-agent transcript load and the async-launch
                    // accounting below are gated on the result being paired (by
                    // callId) to a `function_call` we classified as an `Agent`
                    // delegation — the historical mirror of the live path. Every
                    // ordinary tool result stays untouched, even one that carries
                    // a stray `subAgent` / spawn renderer (corruption, schema
                    // drift, a future tool).
                    let is_agent_result = tool_call_id
                        .as_deref()
                        .is_some_and(|id| agent_call_ids.contains(id));
                    if is_agent_result {
                        if let (Some(id), Some(task_id)) =
                            (tool_call_id.clone(), spawned_task_id(&value))
                        {
                            background_acks.insert(id, task_id);
                        }
                    }
                    let agent_stats = is_agent_result
                        .then(|| agent_stats_from_subagent(&value, path))
                        .flatten();
                    messages.push(UnifiedMessage {
                        id: format!("cb-toolresult-{idx}"),
                        role: MessageRole::Tool,
                        content: vec![ContentBlock::ToolResult {
                            tool_use_id: tool_call_id,
                            output_preview: tool_output_preview(&value),
                            is_error: tool_is_error(&value),
                            agent_stats,
                            images: Vec::new(),
                        }],
                        timestamp: ts,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: Some(ts),
                    agent_message_id: None,
                    });
                }
                _ => {}
            }
        }

        apply_background_lifecycle(&mut messages, &background_acks, &background_notifications);

        let mut turns = group_into_turns(messages);
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        resolve_patch_line_numbers(&mut turns, cwd.as_deref());
        backfill_turn_durations(&mut turns, &[]);

        let used_tokens = latest_turn_total_usage_tokens(&turns);
        let max_tokens = infer_context_window_max_tokens(model.as_deref());
        let session_stats =
            merge_context_window_stats(compute_session_stats(&turns), used_tokens, max_tokens);

        let folder_name = cwd.as_deref().map(folder_name_from_path);
        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::CodeBuddy,
            folder_path: cwd,
            folder_name,
            // Same precedence as `parse_summary` — the two paths MUST agree, or
            // the auto-title backfill would oscillate between them.
            title: titles.resolve(first_user_text),
            started_at: first_ts.unwrap_or_else(Utc::now),
            ended_at: last_ts,
            message_count,
            model,
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

impl Default for CodeBuddyParser {
    fn default() -> Self {
        Self::new()
    }
}

/// True when `path` is a CodeBuddy sub-agent transcript rather than a top-level
/// session, so the conversation scan can skip it — otherwise a sub-agent's
/// internal execution transcript would surface as a bogus top-level conversation
/// (and `get_conversation` would open it). It only feeds an Agent result's
/// `agent_stats` (loaded by constructed path in `agent_stats_from_subagent`, not
/// via this scan), so hiding it from the list is safe.
///
/// CodeBuddy's documented layout is `<projects>/<encoded-cwd>/<sessionId>.jsonl`
/// for a top-level session and `<encoded-cwd>/<sessionId>/subagents/<agent>.jsonl`
/// for a sub-agent transcript. So a transcript is a `.jsonl` whose immediate
/// parent directory is `subagents`, nested at least that deep
/// (encoded-cwd + session + `subagents` + file ⇒ ≥ 4 components below
/// `base_dir`). The depth floor is what keeps a *legitimate* session whose own
/// encoded-cwd dir is literally named `subagents`
/// (`<projects>/subagents/<sessionId>.jsonl`, only 2 components) from being
/// mistaken for one. Computed on the components below `base_dir` so a `subagents`
/// segment in the base path's own prefix can't over-match either.
fn is_subagent_transcript(base_dir: &Path, path: &Path) -> bool {
    let relative = path.strip_prefix(base_dir).unwrap_or(path);
    let components: Vec<_> = relative.components().collect();
    components.len() >= 4 && components[components.len() - 2].as_os_str() == "subagents"
}

impl AgentParser for CodeBuddyParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        for entry in WalkDir::new(&self.base_dir)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            // A sub-agent transcript (`<session>/subagents/<agent>.jsonl`) is not
            // a top-level conversation; it only feeds an Agent result's
            // `agent_stats`. Skip it so the history list isn't polluted.
            if is_subagent_transcript(&self.base_dir, path) {
                continue;
            }
            if let Ok(Some(summary)) = super::summary_cache::get_or_parse(
                AgentType::CodeBuddy,
                path,
                || Ok(self.parse_summary(path)),
            ) {
                conversations.push(summary);
            }
        }

        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        if self.base_dir.exists() {
            for entry in WalkDir::new(&self.base_dir)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                // Never open a sub-agent transcript as a top-level conversation,
                // even if its file stem happens to match the requested id.
                if is_subagent_transcript(&self.base_dir, path) {
                    continue;
                }
                if path.file_stem().map(|s| s.to_string_lossy()).as_deref() == Some(conversation_id)
                {
                    return self.parse_detail(path, conversation_id);
                }
            }
        }

        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

/// Epoch-millisecond `timestamp` → `DateTime<Utc>` (CodeBuddy uses numeric ms,
/// not Claude's ISO strings).
fn record_millis(value: &Value) -> Option<DateTime<Utc>> {
    DateTime::from_timestamp_millis(value.get("timestamp")?.as_i64()?)
}

fn record_cwd(value: &Value) -> Option<String> {
    value
        .get("cwd")
        .and_then(|c| c.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// CodeBuddy's session title, resolved exactly like its own
/// `getEffectiveSessionTitle`: the newest non-empty `custom-title` (what
/// `/rename` writes), else the newest usable `ai-title`, else the newest usable
/// `topic`, else the first real user message. All three records are appended
/// (never rewritten) and repeat over a session's life — CodeBuddy scans them
/// back-to-front — so the LAST value of each kind wins.
#[derive(Default)]
struct CodeBuddyTitles {
    custom: Option<String>,
    ai: Option<String>,
    topic: Option<String>,
}

impl CodeBuddyTitles {
    /// Feed one record. Non-title records are ignored, so callers can route the
    /// three types through a single match arm.
    fn feed(&mut self, record_type: &str, value: &Value) {
        let (field, slot) = match record_type {
            "custom-title" => ("customTitle", &mut self.custom),
            "ai-title" => ("aiTitle", &mut self.ai),
            "topic" => ("topic", &mut self.topic),
            _ => return,
        };
        let Some(text) = value.get(field).and_then(|t| t.as_str()).map(str::trim) else {
            return;
        };
        // A `custom-title` is user-typed and taken verbatim; only the generated
        // kinds can carry CodeBuddy's placeholders, which it skips rather than
        // showing.
        if text.is_empty() || (record_type != "custom-title" && is_placeholder_title(text)) {
            return;
        }
        *slot = Some(truncate_str(text, 100));
    }

    fn resolve(self, first_user_text: Option<String>) -> Option<String> {
        self.custom.or(self.ai).or(self.topic).or(first_user_text)
    }
}

/// CodeBuddy's `isGeneratedPlaceholderTitle`: what its titler emits when there
/// was nothing to summarize. Showing one of these as the session name is worse
/// than falling through to the first user message.
fn is_placeholder_title(text: &str) -> bool {
    text == "(No content)"
        || text == "/compact"
        || (text.starts_with("<image_local_path>") && text.ends_with("</image_local_path>"))
}

/// Record types that carry actual conversation content, as opposed to the
/// `ai-title` / `summary` / `file-history-snapshot` metadata records (which also
/// carry timestamps). Only content records define the session's
/// `started_at`/`ended_at` span and whether a transcript is listed at all — so a
/// metadata-only file is treated as empty rather than surfacing as a
/// zero-message conversation.
fn is_content_record(record_type: &str) -> bool {
    matches!(
        record_type,
        "message" | "reasoning" | "function_call" | "function_call_result"
    )
}

/// Display model name from `providerData`: prefer `requestModelName` (e.g.
/// "GLM-5.1"), falling back to the lowercase `model` id. Each candidate is taken
/// only when present AND non-empty, so a blank/null `requestModelName` does not
/// shadow a valid `model`.
fn record_model(value: &Value) -> Option<String> {
    let provider_data = value.get("providerData")?;
    ["requestModelName", "model"].into_iter().find_map(|key| {
        provider_data
            .get(key)
            .and_then(|m| m.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
    })
}

fn call_id(value: &Value) -> Option<String> {
    value
        .get("callId")
        .or_else(|| value.get("id"))
        .and_then(|i| i.as_str())
        .map(String::from)
}

/// Concatenate the `text` of every `content[]` item of the given `item_type`
/// (`input_text` for user turns, `output_text` for assistant turns).
fn collect_text(value: &Value, item_type: &str) -> String {
    let mut out = String::new();
    if let Some(items) = value.get("content").and_then(|c| c.as_array()) {
        for item in items {
            if item.get("type").and_then(|t| t.as_str()) == Some(item_type) {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                }
            }
        }
    }
    out
}

/// Reasoning text lives in `rawContent[].text` (`reasoning_text` items); some
/// records mirror it under `content[]`, so fall back to that.
fn reasoning_text(value: &Value) -> String {
    for key in ["rawContent", "content"] {
        if let Some(items) = value.get(key).and_then(|c| c.as_array()) {
            let mut out = String::new();
            for item in items {
                if let Some(text) = item.get("text").and_then(|t| t.as_str()) {
                    out.push_str(text);
                }
            }
            if !out.trim().is_empty() {
                return out;
            }
        }
    }
    String::new()
}

/// Map CodeBuddy's `providerData.rawUsage` (OpenAI completions shape) onto
/// `TurnUsage`. `prompt_tokens` already includes the cached prefix, so subtract
/// `cached_tokens` to get the non-cached input.
fn usage_from_raw(value: &Value) -> Option<TurnUsage> {
    let raw = value.get("providerData")?.get("rawUsage")?;
    let prompt = raw.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0);
    let completion = raw
        .get("completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let cached = raw
        .get("prompt_tokens_details")
        .and_then(|d| d.get("cached_tokens"))
        .and_then(Value::as_u64)
        .unwrap_or(0);
    if prompt == 0 && completion == 0 && cached == 0 {
        return None;
    }
    Some(TurnUsage {
        input_tokens: prompt.saturating_sub(cached),
        output_tokens: completion,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cached,
    })
}

/// Parse a `function_call`'s `arguments` — a JSON string (or, defensively, an
/// already-decoded object) — into a `Value` for field inspection. Returns `None`
/// for missing/unparseable/non-object arguments.
fn parse_tool_arguments(value: &Value) -> Option<Value> {
    match value.get("arguments")? {
        Value::String(s) => serde_json::from_str::<Value>(s).ok(),
        obj @ Value::Object(_) => Some(obj.clone()),
        _ => None,
    }
}

/// CodeBuddy invokes MCP tools indirectly through its `DeferExecuteTool`
/// virtualization layer (after a `ToolSearch` discovery step), packing the real
/// tool name and parameters into `{ "toolName": "mcp__…__delegate_to_agent",
/// "params": { … } }`. When a tool call's parsed `arguments` carry that wrapper,
/// return the inner `toolName` so the call resolves to its real identity — and
/// renders the dedicated delegation/question card via the existing
/// `normalizeToolName` suffix rules — instead of the opaque `DeferExecuteTool`
/// shell. The `params` wrapper is deliberately left on `input_preview`: the
/// frontend cards (`findDelegationArgs`, `findTaskId`) peel it themselves, and
/// keeping it also stops the live `inferFromInput` from misclassifying
/// `cancel_delegation`'s `{task_id}` as a generic task. Shared with the live ACP
/// path in `acp/connection.rs`.
pub(crate) fn deferred_tool_name(arguments: &Value) -> Option<&str> {
    let obj = arguments.as_object()?;
    obj.get("params")?;
    obj.get("toolName")
        .and_then(|n| n.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// True when the parsed `arguments` carry a non-empty string `subagent_type` —
/// the agent-agnostic sub-agent delegation marker (also used by
/// `acp/connection.rs:is_subagent_invocation` and the frontend `inferFromInput`).
fn declares_subagent(arguments: &Value) -> bool {
    arguments
        .get("subagent_type")
        .and_then(|s| s.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
}

/// Resolve a tool call's display name from its `arguments`:
///   1. a `DeferExecuteTool` wrapper unwraps to its inner `toolName`;
///   2. a native call carrying `subagent_type` is renamed to "Agent" (so the
///      renderer routes it into `AgentToolCallPart`, mirroring the OpenCode
///      `parsers/opencode.rs` and Codex `parsers/codex.rs` parsers);
///   3. otherwise the literal `name` is kept.
fn resolve_tool_call_name(value: &Value) -> String {
    if let Some(arguments) = parse_tool_arguments(value) {
        if let Some(inner) = deferred_tool_name(&arguments) {
            return inner.to_string();
        }
        if declares_subagent(&arguments) {
            return "Agent".to_string();
        }
    }
    value
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("unknown")
        .to_string()
}

/// `function_call.arguments` is a JSON string (or, defensively, an object).
fn tool_input_preview(value: &Value) -> Option<String> {
    let arguments = value.get("arguments")?;
    if let Some(s) = arguments.as_str() {
        (!s.is_empty()).then(|| s.to_string())
    } else if arguments.is_object() || arguments.is_array() {
        serde_json::to_string(arguments).ok()
    } else {
        None
    }
}

/// Rebuild the MCP `CallToolResult` envelope from CodeBuddy's
/// `providerData.toolResult.mcpMeta.structuredContent`. Deferred MCP tools
/// (`DeferExecuteTool`) carry their real structured result here, while
/// `output.text` is only the human-readable ack line; surfacing the envelope the
/// frontend delegation/question cards parse (`parseToolOutput` /
/// `parseStatusReport` / `parseAskQuestionOutcome`) lets them recover
/// `child_conversation_id`, status, tasks, and selections. Returns `None` for
/// plain tools (no `mcpMeta`) or MCP tools that return no structured content, so
/// those fall through to the normal text path.
fn deferred_result_envelope(value: &Value) -> Option<String> {
    let tool_result = value.get("providerData")?.get("toolResult")?;
    let mcp_meta = tool_result.get("mcpMeta")?;
    let structured = mcp_meta.get("structuredContent")?;
    if structured.is_null() {
        return None;
    }
    let text = value
        .get("output")
        .and_then(|o| o.get("text").and_then(|t| t.as_str()).or_else(|| o.as_str()))
        .or_else(|| tool_result.get("content").and_then(|c| c.as_str()))
        .unwrap_or("");
    let is_error = mcp_meta
        .get("isError")
        .and_then(|e| e.as_bool())
        .unwrap_or(false);
    serde_json::to_string(&serde_json::json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": is_error,
    }))
    .ok()
}

/// `function_call_result.output` is `{type:"text", text}`; fall back to the raw
/// string or `providerData.toolResult.content`. Deferred MCP tools first surface
/// their structured `mcpMeta` envelope (see `deferred_result_envelope`).
fn tool_output_preview(value: &Value) -> Option<String> {
    if let Some(envelope) = deferred_result_envelope(value) {
        return Some(envelope);
    }
    if let Some(output) = value.get("output") {
        if let Some(text) = output.as_str() {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        } else if let Some(text) = output.get("text").and_then(|t| t.as_str()) {
            return Some(text.to_string());
        }
    }
    let content = value.get("providerData")?.get("toolResult")?.get("content")?;
    if let Some(text) = content.as_str() {
        Some(text.to_string())
    } else {
        serde_json::to_string(content).ok()
    }
}

/// A tool call failed when `providerData.toolResult.error` is set (CodeBuddy
/// reports tool failures here even while `status` stays "completed"), the
/// status is a failure, or the output text begins with "Error:".
fn tool_is_error(value: &Value) -> bool {
    if let Some(error) = value
        .get("providerData")
        .and_then(|p| p.get("toolResult"))
        .and_then(|tr| tr.get("error"))
    {
        match error {
            Value::Null => {}
            Value::String(s) => {
                if !s.trim().is_empty() {
                    return true;
                }
            }
            _ => return true,
        }
    }

    if let Some(status) = value.get("status").and_then(|s| s.as_str()) {
        if matches!(
            status.trim().to_ascii_lowercase().as_str(),
            "error" | "failed" | "failure" | "cancelled" | "canceled"
        ) {
            return true;
        }
    }

    value
        .get("output")
        .and_then(|o| o.get("text"))
        .and_then(|t| t.as_str())
        .and_then(|t| t.trim_start().get(..6).map(str::to_string))
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("error:"))
}

/// True when a `message`/`role:"user"` record is one of CodeBuddy's
/// SYSTEM-INJECTED messages rather than something the human typed. CodeBuddy
/// marks every one of them `providerData.isMeta: true` — the
/// `<task-notification>` a finished background worker enqueues
/// (`BackgroundTaskNotifier::enqueueAndScheduleDrain` calls
/// `kQ(xml, {isMeta: true})`), a `/goal` kick-off, and the like.
///
/// CodeBuddy's OWN renderer skips exactly these records when it replays a
/// session (`"message" === type && "user" === role && (isMeta ||
/// !InputItemUtils.isRealUserMessageItem(item))` → `continue`), so rendering
/// them as user turns was a codeg-only artifact: it split one exchange into two
/// prompts and dropped the raw notification XML — plus the model-facing guidance
/// prose that follows the closing tag — into a chat bubble. The payload is not
/// lost: `capture_task_notification` folds it onto the launching Agent card.
///
/// Read only on `role:"user"` records, so an assistant/tool record that happens
/// to carry the flag is unaffected.
fn is_injected_user_record(value: &Value) -> bool {
    value
        .get("providerData")
        .and_then(|p| p.get("isMeta"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Record the `<task-notification>` an injected user message carries, keyed by
/// `<task-id>`. Anything else (a `/goal` kick-off, a future injection kind) is
/// ignored — it is simply dropped from the stream by the caller.
///
/// Status defaults to `"completed"` when the tag is absent, matching
/// `claude.rs`. CodeBuddy writes NO `<result>` tag — neither
/// `buildAgentTaskNotificationXml` (agent workers) nor
/// `BackgroundTaskNotifier::buildNotificationXml` (background shells) emits one
/// — so the fold carries the headline only; the full report stays on the
/// `TaskOutput` card that read it.
fn capture_task_notification(
    text: &str,
    out: &mut std::collections::HashMap<String, (String, Option<String>)>,
) {
    if !text.trim_start().starts_with("<task-notification>") {
        return;
    }
    let Some(task_id) = capture_tag(task_notification_task_id_regex(), text) else {
        return;
    };
    let status = capture_tag(task_notification_status_regex(), text)
        .unwrap_or_else(|| "completed".to_string());
    let summary = capture_tag(task_notification_summary_regex(), text);
    out.insert(task_id, (status, summary));
}

/// Decode a `providerData.toolResult.renderer` payload of the given `type`.
/// CodeBuddy serializes every renderer `value` to a JSON *string* (not an
/// object), so it needs a second parse; an already-decoded object is accepted
/// defensively.
fn renderer_payload(result: &Value, expected_type: &str) -> Option<Value> {
    let renderer = result
        .get("providerData")?
        .get("toolResult")?
        .get("renderer")?;
    if renderer.get("type").and_then(|t| t.as_str()) != Some(expected_type) {
        return None;
    }
    match renderer.get("value")? {
        Value::String(s) => serde_json::from_str(s).ok(),
        obj @ Value::Object(_) => Some(obj.clone()),
        _ => None,
    }
}

/// The detached worker's task id on an ASYNC `Agent` launch
/// (`run_in_background: true`). Such a call returns an ack immediately, so its
/// result carries an `agent-spawned` renderer naming the worker
/// (`{"taskId":"agent-…","description":…,"subagentType":…}`) INSTEAD of the
/// `subAgent` block a BLOCKING delegation gets — that block only exists once the
/// child has actually finished. `None` for a blocking delegation and for every
/// ordinary tool.
fn spawned_task_id(result: &Value) -> Option<String> {
    renderer_payload(result, "agent-spawned")?
        .get("taskId")?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// The sub-agent transcript id CodeBuddy records on an `Agent` tool result. The
/// transcript lives at `<session_dir>/subagents/<id>.jsonl` — Claude Code's
/// directory layout.
///
/// A BLOCKING delegation names it directly
/// (`providerData.toolResult.subAgent.sessionId`, e.g. `"agent-cdd7c1ea"`). An
/// ASYNC launch has no `subAgent` block at all, but its detached worker writes
/// the SAME transcript under its task id, so the spawn renderer's `taskId`
/// reaches it too — without this fallback every backgrounded worker's nested
/// tool calls were dropped. Ordinary tool results carry neither, so this returns
/// `None` for them.
fn subagent_transcript_id(result: &Value) -> Option<String> {
    result
        .get("providerData")
        .and_then(|p| p.get("toolResult"))
        .and_then(|tr| tr.get("subAgent"))
        .and_then(|sa| sa.get("sessionId"))
        .and_then(|s| s.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| spawned_task_id(result))
}

/// Rewrite each async `Agent` launch ack's `output_preview` into the structured
/// [`BACKGROUND_TASK_MARKER`] payload the frontend's lifecycle card reads
/// (`lib/background-agent.ts`), joined with the latest `<task-notification>`
/// observed for that task.
///
/// The ack CodeBuddy returns is model-facing scheduling instruction ("The worker
/// is running detached (no team). The returned agent_id is the task_id. End this
/// turn unless the user asked for progress. …"), so rendering it verbatim leaked
/// plumbing into the card where a settled/pending badge belongs.
///
/// `status: null` means no notification was observed — the frontend renders that
/// as "launched, result pending", NEVER as "running": a transcript alone cannot
/// distinguish a live worker from one whose CLI died. `result` is always null
/// here (CodeBuddy emits no `<result>` tag; see `capture_task_notification`).
/// Mirrors `claude.rs`'s `ClaudeRecordAccumulator::apply_background_lifecycle`,
/// including its `is_error: false` gate — a failed ack has a real error to show.
fn apply_background_lifecycle(
    messages: &mut [UnifiedMessage],
    acks: &std::collections::HashMap<String, String>,
    notifications: &std::collections::HashMap<String, (String, Option<String>)>,
) {
    if acks.is_empty() {
        return;
    }
    for msg in messages {
        for block in &mut msg.content {
            let ContentBlock::ToolResult {
                tool_use_id: Some(id),
                output_preview,
                is_error: false,
                ..
            } = block
            else {
                continue;
            };
            let Some(task_id) = acks.get(id) else {
                continue;
            };
            let notification = notifications.get(task_id);
            let payload = serde_json::json!({
                "task_id": task_id,
                "status": notification.map(|(status, _)| status.clone()),
                "summary": notification.and_then(|(_, summary)| summary.clone()),
                "result": Value::Null,
            });
            *output_preview = Some(format!("{BACKGROUND_TASK_MARKER}{payload}"));
        }
    }
}

/// Parse a CodeBuddy sub-agent transcript and extract its tool calls.
///
/// The sub-agent JSONL uses the same OpenAI-items schema as the main session
/// (`function_call` / `function_call_result` records); we pair them by `callId`
/// and reuse the outer parser's name/preview/error helpers so nested calls
/// render identically to top-level ones. Mirrors `claude.rs`'s
/// `parse_subagent_tool_calls`, which does the same for Claude's schema.
fn parse_codebuddy_subagent_tool_calls(path: &Path) -> Vec<AgentToolCall> {
    let Ok(file) = fs::File::open(path) else {
        return Vec::new();
    };
    let reader = BufReader::new(file);

    // (callId, name, input) in encounter order, paired against results by callId.
    let mut calls: Vec<(Option<String>, String, Option<String>)> = Vec::new();
    let mut results: std::collections::HashMap<String, (Option<String>, bool)> =
        std::collections::HashMap::new();

    for line in reader.lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "function_call" => {
                calls.push((
                    call_id(&value),
                    resolve_tool_call_name(&value),
                    tool_input_preview(&value).map(|s| truncate_str(&s, 500)),
                ));
            }
            "function_call_result" => {
                if let Some(id) = call_id(&value) {
                    let output = tool_output_preview(&value).map(|s| truncate_str(&s, 500));
                    results.insert(id, (output, tool_is_error(&value)));
                }
            }
            _ => {}
        }
    }

    calls
        .into_iter()
        .map(|(id, tool_name, input_preview)| {
            let (output_preview, is_error) =
                id.and_then(|i| results.remove(&i)).unwrap_or((None, false));
            AgentToolCall {
                tool_name,
                input_preview,
                output_preview,
                is_error,
            }
        })
        .collect()
}

/// Build `agent_stats` for an `Agent` `function_call_result` by loading the
/// sub-agent's own transcript and extracting its nested tool calls — the
/// historical mirror of the live path, which synthesizes the same `agent_stats`
/// from the streamed child tool calls (`conversation-runtime-context.tsx`).
///
/// Returns `None` for ordinary results (no sub-agent linkage — see
/// [`subagent_transcript_id`]), a missing/empty transcript, or a sub-agent that
/// ran no tools, so the common case stays a plain tool result. A still-running
/// async worker also lands here (its transcript has no completed calls yet) and
/// recovers on the next refetch. `main_session_path` is the real `.jsonl` path
/// the parser is reading; the transcript sits beside it under
/// `<session_dir>/subagents/`.
fn agent_stats_from_subagent(
    result: &Value,
    main_session_path: &Path,
) -> Option<AgentExecutionStats> {
    let id = subagent_transcript_id(result)?;
    // Path-traversal guard: `id` becomes a filename under the session dir, so it
    // must be a single plain component (rejects separators, `..`, a Windows
    // drive colon, and NUL). See `is_safe_subagent_id`.
    if !is_safe_subagent_id(&id) {
        return None;
    }
    let transcript = main_session_path
        .with_extension("")
        .join("subagents")
        .join(format!("{id}.jsonl"));
    if !transcript.exists() {
        return None;
    }
    let tool_calls = parse_codebuddy_subagent_tool_calls(&transcript);
    if tool_calls.is_empty() {
        return None;
    }
    let tool_count = tool_calls.len() as u32;
    Some(AgentExecutionStats {
        agent_type: None,
        status: None,
        total_duration_ms: None,
        total_tokens: None,
        total_tool_use_count: Some(tool_count),
        read_count: None,
        search_count: None,
        bash_count: None,
        edit_file_count: None,
        lines_added: None,
        lines_removed: None,
        other_tool_count: None,
        tool_calls,
        // CodeBuddy's sub-agent transcript is a file under the parent session,
        // not a session of its own.
        child_session_id: None,
    })
}

fn text_message(
    id: String,
    role: MessageRole,
    text: String,
    ts: DateTime<Utc>,
    usage: Option<TurnUsage>,
    model: Option<String>,
) -> UnifiedMessage {
    UnifiedMessage {
        id,
        role,
        content: vec![ContentBlock::Text { text }],
        timestamp: ts,
        usage,
        duration_ms: None,
        model,
        completed_at: Some(ts),
    agent_message_id: None,
    }
}

/// Group the flat, chronologically-ordered `UnifiedMessage`s into `MessageTurn`s:
/// User/System messages each become their own turn; an Assistant message starts
/// a turn that absorbs the immediately-following Tool messages (its tool
/// results), stopping at the next Assistant message to keep turns small for
/// virtualization.
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
            // Assistant or Tool — start a group and absorb following Tool messages.
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
    use crate::models::TurnRole;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn config_dir_env_overrides_home() {
        let resolved = resolve_codebuddy_config_dir_from(
            Some(OsString::from("/custom/codebuddy")),
            Some(PathBuf::from("/Users/default")),
        );
        assert_eq!(resolved, PathBuf::from("/custom/codebuddy"));
    }

    #[test]
    fn config_dir_defaults_to_home_dot_codebuddy() {
        let resolved =
            resolve_codebuddy_config_dir_from(None, Some(PathBuf::from("/Users/default")));
        assert_eq!(resolved, PathBuf::from("/Users/default/.codebuddy"));
    }

    #[test]
    fn empty_env_falls_back_to_home() {
        let resolved =
            resolve_codebuddy_config_dir_from(Some(OsString::new()), Some(PathBuf::from("/home/u")));
        assert_eq!(resolved, PathBuf::from("/home/u/.codebuddy"));
    }

    fn write_session(root: &Path, encoded_cwd: &str, session_id: &str, records: &[Value]) {
        let dir = root.join(encoded_cwd);
        std::fs::create_dir_all(&dir).expect("create project dir");
        let mut file =
            std::fs::File::create(dir.join(format!("{session_id}.jsonl"))).expect("create jsonl");
        for record in records {
            writeln!(file, "{}", serde_json::to_string(record).expect("serialize"))
                .expect("write line");
        }
    }

    #[test]
    fn parses_item_format_text_session() {
        let root = std::env::temp_dir().join(format!("codeg-cb-text-{}", uuid::Uuid::new_v4()));
        let sid = "sess-text";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1781821844178i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"你会做什么"}]}),
                json!({"type":"ai-title","timestamp":1781821846252i64,"aiTitle":"能力询问","cwd":"/Users/demo/app","sessionId":sid}),
                json!({"type":"reasoning","timestamp":1781821848958i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "rawContent":[{"type":"reasoning_text","text":"thinking about it"}],
                       "providerData":{"requestModelName":"GLM-5.1"}}),
                json!({"type":"message","role":"assistant","timestamp":1781821848958i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"output_text","text":"我是 CodeBuddy"}],
                       "providerData":{"requestModelName":"GLM-5.1","model":"glm-5.1",
                         "rawUsage":{"prompt_tokens":24049,"completion_tokens":267,"total_tokens":24316,
                           "prompt_tokens_details":{"cached_tokens":12800}}}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());

        let summaries = parser.list_conversations().expect("list");
        assert_eq!(summaries.len(), 1);
        let summary = &summaries[0];
        assert_eq!(summary.agent_type, AgentType::CodeBuddy);
        assert_eq!(summary.title.as_deref(), Some("能力询问"));
        assert_eq!(summary.folder_path.as_deref(), Some("/Users/demo/app"));
        assert_eq!(summary.model.as_deref(), Some("GLM-5.1"));
        assert_eq!(summary.message_count, 2);

        let detail = parser.get_conversation(sid).expect("detail");
        assert_eq!(detail.summary.agent_type, AgentType::CodeBuddy);

        let has_user_text = detail.turns.iter().any(|t| {
            matches!(t.role, TurnRole::User)
                && t.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("你会做什么")))
        });
        assert!(has_user_text, "user input_text must become a User turn");

        let has_thinking = detail.turns.iter().any(|t| {
            t.blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Thinking { text } if text.contains("thinking")))
        });
        assert!(has_thinking, "reasoning must become a Thinking block");

        let has_assistant_text = detail.turns.iter().any(|t| {
            matches!(t.role, TurnRole::Assistant)
                && t.blocks.iter().any(
                    |b| matches!(b, ContentBlock::Text { text } if text.contains("CodeBuddy")),
                )
        });
        assert!(has_assistant_text, "assistant output_text must render");

        let usage = detail
            .session_stats
            .as_ref()
            .and_then(|s| s.total_usage.as_ref())
            .expect("usage");
        assert_eq!(usage.output_tokens, 267);
        assert_eq!(usage.cache_read_input_tokens, 12800);
        assert_eq!(usage.input_tokens, 24049 - 12800);

        std::fs::remove_dir_all(&root).ok();
    }

    /// Parse one session through BOTH title paths (list + detail) and assert
    /// they agree on `expected` — a divergence makes the auto-title backfill
    /// oscillate between them.
    fn assert_title(tag: &str, records: &[Value], expected: Option<&str>) {
        let root = std::env::temp_dir().join(format!("codeg-cb-{tag}-{}", uuid::Uuid::new_v4()));
        let sid = "sess-title";
        write_session(&root, "Users-demo-app", sid, records);

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let summaries = parser.list_conversations().expect("list");
        assert_eq!(summaries.len(), 1, "{tag}: one session expected");
        let listed = summaries[0].title.clone();
        let detail = parser.get_conversation(sid).expect("detail");
        std::fs::remove_dir_all(&root).ok();

        assert_eq!(listed.as_deref(), expected, "{tag}: list title");
        assert_eq!(
            detail.summary.title.as_deref(),
            expected,
            "{tag}: detail title"
        );
    }

    fn cb_user(text: &str) -> Value {
        json!({"type":"message","role":"user","timestamp":1781821844178i64,"cwd":"/Users/demo/app",
               "sessionId":"sess-title","content":[{"type":"input_text","text":text}]})
    }

    #[test]
    fn title_prefers_rename_over_generated_titles() {
        // CodeBuddy's `/rename` appends `{"type":"custom-title","customTitle":…}`
        // and its own `getEffectiveSessionTitle` scans custom → ai → topic, so a
        // generated title written afterwards never displaces the user's name.
        assert_title(
            "title-custom",
            &[
                cb_user("first prompt"),
                json!({"type":"ai-title","timestamp":1781821846000i64,"aiTitle":"stale title","sessionId":"sess-title"}),
                json!({"type":"custom-title","timestamp":1781821847000i64,"customTitle":"auth-refactor","sessionId":"sess-title"}),
                json!({"type":"ai-title","timestamp":1781821848000i64,"aiTitle":"fresh title","sessionId":"sess-title"}),
            ],
            Some("auth-refactor"),
        );
    }

    #[test]
    fn title_takes_the_newest_generated_value() {
        // CodeBuddy re-titles a session as it grows, appending a new record each
        // time. The NEWEST value wins (it used to keep the first one, pinning a
        // long session to the title of its opening exchange).
        assert_title(
            "title-newest",
            &[
                cb_user("first prompt"),
                json!({"type":"ai-title","timestamp":1781821846000i64,"aiTitle":"stale title","sessionId":"sess-title"}),
                json!({"type":"ai-title","timestamp":1781821848000i64,"aiTitle":"fresh title","sessionId":"sess-title"}),
            ],
            Some("fresh title"),
        );
    }

    #[test]
    fn title_skips_placeholders_and_falls_through_to_topic() {
        assert_title(
            "title-topic",
            &[
                cb_user("first prompt"),
                json!({"type":"ai-title","timestamp":1781821846000i64,"aiTitle":"(No content)","sessionId":"sess-title"}),
                json!({"type":"topic","timestamp":1781821847000i64,"topic":"重构鉴权","sessionId":"sess-title"}),
            ],
            Some("重构鉴权"),
        );
    }

    #[test]
    fn title_falls_back_to_first_prompt_when_every_generated_value_is_a_placeholder() {
        assert_title(
            "title-fallback",
            &[
                cb_user("first prompt"),
                json!({"type":"ai-title","timestamp":1781821846000i64,"aiTitle":"/compact","sessionId":"sess-title"}),
                json!({"type":"topic","timestamp":1781821847000i64,"topic":"   ","sessionId":"sess-title"}),
            ],
            Some("first prompt"),
        );
    }

    #[test]
    fn parses_tool_calls_with_error_detection() {
        let root = std::env::temp_dir().join(format!("codeg-cb-tool-{}", uuid::Uuid::new_v4()));
        let sid = "sess-tool";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"run build"}]}),
                json!({"type":"function_call","timestamp":1782193811284i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"call_1","arguments":"{\"command\": \"pnpm build\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811300i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"call_1","status":"completed",
                       "output":{"type":"text","text":"Error: Bash error: Internal error"},
                       "providerData":{"toolResult":{"content":"Error: Bash error: Internal error","error":"Bash error: Internal error"}}}),
                json!({"type":"function_call","timestamp":1782193812000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Glob","callId":"call_2","arguments":"{\"pattern\": \"*.ts\"}"}),
                json!({"type":"function_call_result","timestamp":1782193812100i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Glob","callId":"call_2","status":"completed",
                       "output":{"type":"text","text":"a.ts\nb.ts"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");

        let mut uses = Vec::new();
        let mut results = Vec::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                match block {
                    ContentBlock::ToolUse {
                        tool_name,
                        tool_use_id,
                        input_preview,
                        ..
                    } => uses.push((
                        tool_name.clone(),
                        tool_use_id.clone(),
                        input_preview.clone(),
                    )),
                    ContentBlock::ToolResult {
                        tool_use_id,
                        is_error,
                        output_preview,
                        ..
                    } => results.push((tool_use_id.clone(), *is_error, output_preview.clone())),
                    _ => {}
                }
            }
        }

        assert_eq!(uses.len(), 2);
        assert!(uses.iter().any(|(name, id, input)| name == "Bash"
            && id.as_deref() == Some("call_1")
            && input.as_deref().unwrap_or_default().contains("pnpm build")));

        let bash = results
            .iter()
            .find(|(id, _, _)| id.as_deref() == Some("call_1"))
            .expect("bash result");
        assert!(bash.1, "toolResult.error must set is_error even when status=completed");

        let glob = results
            .iter()
            .find(|(id, _, _)| id.as_deref() == Some("call_2"))
            .expect("glob result");
        assert!(!glob.1, "successful result must not be an error");
        assert!(glob.2.as_deref().unwrap_or_default().contains("a.ts"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn empty_session_file_is_handled() {
        let root = std::env::temp_dir().join(format!("codeg-cb-empty-{}", uuid::Uuid::new_v4()));
        let dir = root.join("Users-demo-app");
        std::fs::create_dir_all(&dir).expect("create dir");
        std::fs::File::create(dir.join("empty.jsonl")).expect("create empty");

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        assert!(
            parser.list_conversations().expect("list").is_empty(),
            "an empty transcript has no timestamp and must be skipped from the list"
        );
        let detail = parser.get_conversation("empty").expect("detail");
        assert!(detail.turns.is_empty());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn metadata_only_session_is_not_listed() {
        let root = std::env::temp_dir().join(format!("codeg-cb-meta-{}", uuid::Uuid::new_v4()));
        let sid = "sess-meta";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"file-history-snapshot","timestamp":1781821844000i64,"cwd":"/Users/demo/app","sessionId":sid,"snapshot":{}}),
                json!({"type":"ai-title","timestamp":1781821846000i64,"aiTitle":"orphan","cwd":"/Users/demo/app","sessionId":sid}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        assert!(
            parser.list_conversations().expect("list").is_empty(),
            "a transcript with only metadata records (no message/reasoning/tool) must not be listed"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn model_falls_back_to_model_id_when_request_model_name_blank() {
        let root = std::env::temp_dir().join(format!("codeg-cb-model-{}", uuid::Uuid::new_v4()));
        let sid = "sess-model";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1781821844000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"hi"}]}),
                json!({"type":"message","role":"assistant","timestamp":1781821845000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"output_text","text":"hello"}],
                       "providerData":{"requestModelName":"","model":"glm-5.1"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let summaries = parser.list_conversations().expect("list");
        assert_eq!(
            summaries[0].model.as_deref(),
            Some("glm-5.1"),
            "a blank requestModelName must fall back to the model id"
        );
        let detail = parser.get_conversation(sid).expect("detail");
        assert_eq!(detail.summary.model.as_deref(), Some("glm-5.1"));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn read_tool_output_is_structurized() {
        let root = std::env::temp_dir().join(format!("codeg-cb-read-{}", uuid::Uuid::new_v4()));
        let sid = "sess-read";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1781821844000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"read it"}]}),
                json!({"type":"function_call","timestamp":1781821845000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Read","callId":"r1","arguments":"{\"file_path\": \"/x\"}"}),
                json!({"type":"function_call_result","timestamp":1781821845100i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Read","callId":"r1","status":"completed",
                       "output":{"type":"text","text":"   1→hello\n   2→world"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let read_output = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == "r1" => output_preview.clone(),
                _ => None,
            })
            .expect("read tool result");
        assert!(
            read_output.contains("\"start_line\""),
            "the shared structurize_read_tool_output post-processor must run on Read results, got: {read_output}"
        );
        assert!(
            !read_output.contains("1→"),
            "line-number prefixes must be stripped, got: {read_output}"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn subagent_task_is_rewritten_to_agent() {
        let root = std::env::temp_dir().join(format!("codeg-cb-agent-{}", uuid::Uuid::new_v4()));
        let sid = "sess-agent";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"delegate it"}]}),
                // Sub-agent delegation: CodeBuddy's AgentTool, same arguments shape
                // as Claude Code's Task ({description, prompt, subagent_type}).
                json!({"type":"function_call","timestamp":1782193811200i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Task","callId":"a1",
                       "arguments":"{\"description\": \"Explore structure\", \"prompt\": \"map the repo\", \"subagent_type\": \"general-purpose\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811400i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Task","callId":"a1","status":"completed",
                       "output":{"type":"text","text":"Done: 12 files"}}),
                // A plain tool in the same session must keep its name.
                json!({"type":"function_call","timestamp":1782193811600i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","arguments":"{\"command\": \"ls\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811700i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","status":"completed","output":{"type":"text","text":"a.ts"}}),
                // Empty subagent_type must NOT be treated as a delegation.
                json!({"type":"function_call","timestamp":1782193811800i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Task","callId":"c1","arguments":"{\"subagent_type\": \"\"}"}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");

        let mut uses = Vec::new();
        let mut results = Vec::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                match block {
                    ContentBlock::ToolUse {
                        tool_name,
                        tool_use_id,
                        input_preview,
                        ..
                    } => uses.push((
                        tool_name.clone(),
                        tool_use_id.clone(),
                        input_preview.clone(),
                    )),
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output_preview,
                        ..
                    } => results.push((tool_use_id.clone(), output_preview.clone())),
                    _ => {}
                }
            }
        }

        // The Task delegation is renamed to "Agent" so the frontend routes it into
        // AgentToolCallPart; its arguments (subagent_type/description/prompt) are
        // preserved verbatim for the card to render.
        let agent = uses
            .iter()
            .find(|(_, id, _)| id.as_deref() == Some("a1"))
            .expect("delegation tool use");
        assert_eq!(
            agent.0, "Agent",
            "a Task call carrying subagent_type must be renamed to Agent"
        );
        let agent_input = agent.2.as_deref().unwrap_or_default();
        assert!(
            agent_input.contains("subagent_type") && agent_input.contains("general-purpose"),
            "input_preview must keep subagent_type, got: {agent_input}"
        );
        assert!(
            agent_input.contains("Explore structure"),
            "description must be preserved, got: {agent_input}"
        );
        assert!(
            agent_input.contains("map the repo"),
            "prompt must be preserved, got: {agent_input}"
        );

        // call_id pairing is unaffected by the rename — the Agent result resolves.
        let agent_result = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("a1"))
            .expect("delegation result");
        assert!(agent_result
            .1
            .as_deref()
            .unwrap_or_default()
            .contains("Done: 12 files"));

        // A plain tool keeps its original name.
        let bash = uses
            .iter()
            .find(|(_, id, _)| id.as_deref() == Some("b1"))
            .expect("bash tool use");
        assert_eq!(
            bash.0, "Bash",
            "non-delegation tools must keep their original name"
        );

        // Empty subagent_type is not a delegation — the name stays "Task".
        let empty = uses
            .iter()
            .find(|(_, id, _)| id.as_deref() == Some("c1"))
            .expect("empty-subagent tool use");
        assert_eq!(
            empty.0, "Task",
            "an empty subagent_type must not trigger the rename"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// Write a CodeBuddy sub-agent transcript at
    /// `<root>/<encoded_cwd>/<session_id>/subagents/<agent_id>.jsonl`.
    fn write_subagent(
        root: &Path,
        encoded_cwd: &str,
        session_id: &str,
        agent_id: &str,
        records: &[Value],
    ) {
        let dir = root.join(encoded_cwd).join(session_id).join("subagents");
        std::fs::create_dir_all(&dir).expect("create subagents dir");
        let mut file =
            std::fs::File::create(dir.join(format!("{agent_id}.jsonl"))).expect("create subagent");
        for record in records {
            writeln!(file, "{}", serde_json::to_string(record).expect("serialize"))
                .expect("write line");
        }
    }

    #[test]
    fn subagent_tool_calls_loaded_into_agent_stats() {
        let root = std::env::temp_dir().join(format!("codeg-cb-substats-{}", uuid::Uuid::new_v4()));
        let sid = "sess-substats";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"build it"}]}),
                // Agent delegation whose result links to a sub-agent transcript.
                json!({"type":"function_call","timestamp":1782193811200i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a1",
                       "arguments":"{\"description\": \"build\", \"prompt\": \"run the build\", \"subagent_type\": \"general-purpose\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811400i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a1","status":"completed",
                       "output":{"type":"text","text":"Build succeeded [Agent ID: agent-test01]"},
                       "providerData":{"toolResult":{"content":"Build succeeded","subAgent":{"sessionId":"agent-test01","lastId":"x"}}}}),
                // A second Agent delegation whose transcript file is absent.
                json!({"type":"function_call","timestamp":1782193811500i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a2",
                       "arguments":"{\"subagent_type\": \"general-purpose\", \"prompt\": \"x\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811600i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a2","status":"completed",
                       "output":{"type":"text","text":"done"},
                       "providerData":{"toolResult":{"content":"done","subAgent":{"sessionId":"agent-missing"}}}}),
                // A plain tool with no sub-agent linkage.
                json!({"type":"function_call","timestamp":1782193811700i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","arguments":"{\"command\": \"ls\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811800i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","status":"completed","output":{"type":"text","text":"a.ts"}}),
                // Isolation guard: a non-Agent tool whose result carries a stray
                // `subAgent` block (corruption / schema drift) pointing at a real
                // transcript must still get no agent_stats — it is gated on the
                // paired call being an `Agent`, not on the block's presence.
                json!({"type":"function_call","timestamp":1782193811820i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b2","arguments":"{\"command\": \"echo hi\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811840i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b2","status":"completed","output":{"type":"text","text":"hi"},
                       "providerData":{"toolResult":{"content":"hi","subAgent":{"sessionId":"agent-test01"}}}}),
            ],
        );

        // The sub-agent ran two tools: a successful Bash and a failed Read. The
        // transcript is CodeBuddy's own items format, same as the main session.
        write_subagent(
            &root,
            "Users-demo-app",
            sid,
            "agent-test01",
            &[
                json!({"type":"function_call","timestamp":1782193811250i64,"sessionId":"agent-test01",
                       "name":"Bash","callId":"s1","arguments":"{\"command\": \"pnpm build\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811300i64,"sessionId":"agent-test01",
                       "name":"Bash","callId":"s1","status":"completed",
                       "output":{"type":"text","text":"Exited with code 0"}}),
                json!({"type":"function_call","timestamp":1782193811320i64,"sessionId":"agent-test01",
                       "name":"Read","callId":"s2","arguments":"{\"file_path\": \"/missing\"}"}),
                // CodeBuddy reports tool failure via providerData.toolResult.error.
                json!({"type":"function_call_result","timestamp":1782193811350i64,"sessionId":"agent-test01",
                       "name":"Read","callId":"s2","status":"completed",
                       "output":{"type":"text","text":"boom"},
                       "providerData":{"toolResult":{"content":"boom","error":"file not found"}}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");

        let mut results: Vec<(Option<String>, Option<AgentExecutionStats>)> = Vec::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                if let ContentBlock::ToolResult {
                    tool_use_id,
                    agent_stats,
                    ..
                } = block
                {
                    results.push((tool_use_id.clone(), agent_stats.clone()));
                }
            }
        }

        // The Agent result carries the sub-agent's nested tool calls.
        let stats = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("a1"))
            .expect("agent result")
            .1
            .as_ref()
            .expect("agent_stats populated from subagent transcript");
        assert_eq!(stats.tool_calls.len(), 2, "two nested tool calls");
        assert_eq!(stats.total_tool_use_count, Some(2));

        let bash = &stats.tool_calls[0];
        assert_eq!(bash.tool_name, "Bash");
        assert!(bash
            .input_preview
            .as_deref()
            .unwrap_or_default()
            .contains("pnpm build"));
        assert!(bash
            .output_preview
            .as_deref()
            .unwrap_or_default()
            .contains("Exited with code 0"));
        assert!(!bash.is_error, "successful Bash is not an error");

        let read = &stats.tool_calls[1];
        assert_eq!(read.tool_name, "Read");
        assert!(
            read.is_error,
            "providerData.toolResult.error must mark the nested call failed"
        );

        // A delegation whose transcript file is missing degrades to no stats.
        let missing = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("a2"))
            .expect("second agent result");
        assert!(
            missing.1.is_none(),
            "absent subagent transcript must leave agent_stats None"
        );

        // A plain tool result is untouched.
        let plain = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("b1"))
            .expect("plain tool result");
        assert!(
            plain.1.is_none(),
            "non-Agent results must never carry agent_stats"
        );

        // A non-Agent result with a stray subAgent block pointing at a REAL
        // transcript is still gated out by the call-side Agent classification.
        let stray = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("b2"))
            .expect("stray-subagent tool result");
        assert!(
            stray.1.is_none(),
            "a non-Agent result must not gain agent_stats even with a stray subAgent block"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    /// An async `Agent` launch's result renderer: CodeBuddy serializes the
    /// payload to a JSON *string*, which is what the parser has to decode.
    fn spawn_renderer(task_id: &str) -> Value {
        json!({
            "type": "agent-spawned",
            "value": serde_json::to_string(&json!({
                "taskId": task_id,
                "description": "Run pnpm build",
                "displayName": "pnpm-build",
                "subagentType": "general-purpose",
                "alreadyLive": false,
            }))
            .expect("serialize renderer value"),
        })
    }

    /// The `providerData.isMeta` user record CodeBuddy injects when a detached
    /// worker settles — the notification XML plus the model-facing guidance
    /// prose that follows the closing tag (verbatim shape from a real session).
    fn task_notification_record(ts: i64, task_id: &str, status: &str, summary: &str) -> Value {
        json!({
            "type": "message", "role": "user", "timestamp": ts,
            "cwd": "/Users/demo/app", "sessionId": "sess-bg",
            "content": [{"type": "input_text", "text": format!(
                "<task-notification>\n<task-id>{task_id}</task-id>\n<kind>agent</kind>\n\
                 <status>{status}</status>\n<summary>{summary}</summary>\n</task-notification>\n\n\
                 A worker finished. Notification <summary> is a short headline, not the report \
                 body. Call TaskOutput once (block is forced false) to read the full report."
            )}],
            "providerData": {"isMeta": true, "agent": "multitask"},
        })
    }

    /// `[[codeg-background-task]]{…}` payload of the tool result with this id.
    fn lifecycle_marker(detail: &ConversationDetail, tool_use_id: &str) -> Value {
        let raw = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == tool_use_id => output_preview.clone(),
                _ => None,
            })
            .unwrap_or_else(|| panic!("tool result {tool_use_id}"));
        let json = raw.strip_prefix(BACKGROUND_TASK_MARKER).unwrap_or_else(|| {
            panic!("async launch ack must be rewritten to the lifecycle marker, got: {raw}")
        });
        serde_json::from_str(json).expect("marker payload is one-line JSON")
    }

    /// Records for a session that dispatches ONE async worker; the caller
    /// appends the settlement (or not).
    fn async_launch_records() -> Vec<Value> {
        vec![
            json!({"type":"message","role":"user","timestamp":1789450922480i64,"cwd":"/Users/demo/app","sessionId":"sess-bg",
                   "content":[{"type":"input_text","text":"派发worker 执行 pnpm build"}]}),
            json!({"type":"function_call","timestamp":1789450928193i64,"cwd":"/Users/demo/app","sessionId":"sess-bg",
                   "name":"Agent","callId":"a1",
                   "arguments":"{\"description\": \"Run pnpm build\", \"prompt\": \"run it\", \"name\": \"pnpm-build\", \"run_in_background\": true}"}),
            json!({"type":"function_call_result","timestamp":1789450928182i64,"cwd":"/Users/demo/app","sessionId":"sess-bg",
                   "name":"Agent","callId":"a1","status":"completed",
                   "output":{"type":"text","text":"Started general-purpose agent: Run pnpm build\nagent_id: agent-x1\nThe worker is running detached (no team). The returned agent_id is the task_id. End this turn unless the user asked for progress.\n[Agent ID: agent-x1]"},
                   "providerData":{"toolResult":{"content":"Started general-purpose agent: Run pnpm build","renderer": spawn_renderer("agent-x1")}}}),
            json!({"type":"message","role":"assistant","timestamp":1789450930520i64,"cwd":"/Users/demo/app","sessionId":"sess-bg",
                   "content":[{"type":"output_text","text":"Worker dispatched. I'll wait for it to finish."}],
                   "providerData":{"requestModelName":"Hy3"}}),
        ]
    }

    #[test]
    fn injected_meta_user_record_is_not_a_prompt() {
        // Regression: CodeBuddy enqueues a worker settlement as a
        // `providerData.isMeta` user message. It used to render as a SECOND user
        // bubble inside one exchange, dumping the raw notification XML and its
        // model-facing guidance prose into the chat. CodeBuddy's own renderer
        // skips these records; codeg folds the payload onto the launch card
        // instead.
        let root = std::env::temp_dir().join(format!("codeg-cb-meta-user-{}", uuid::Uuid::new_v4()));
        let sid = "sess-bg";
        let mut records = async_launch_records();
        records.push(task_notification_record(
            1789450948007,
            "agent-x1",
            "completed",
            "Build succeeded (exit code 0).",
        ));
        records.push(
            json!({"type":"message","role":"assistant","timestamp":1789450954134i64,"cwd":"/Users/demo/app","sessionId":sid,
                   "content":[{"type":"output_text","text":"构建成功。"}],
                   "providerData":{"requestModelName":"Hy3"}}),
        );
        write_session(&root, "Users-demo-app", sid, &records);

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let listed = parser.list_conversations().expect("list");

        // (1) Exactly one User turn — the human's prompt.
        let user_turns: Vec<&MessageTurn> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .collect();
        assert_eq!(
            user_turns.len(),
            1,
            "an injected settlement must not become a second user turn"
        );
        assert!(user_turns[0]
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("派发worker"))));

        // (2) Neither the XML nor its guidance prose leaks into ANY block.
        let rendered: String = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                ContentBlock::Text { text } | ContentBlock::Thinking { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(
            !rendered.contains("<task-notification>"),
            "raw notification XML must never reach a rendered text block"
        );
        assert!(
            !rendered.contains("Call TaskOutput once"),
            "the notification's model-facing guidance prose must not reach the chat"
        );

        // (3) Both paths agree on the count, and neither counts the injection
        // (user + 2 assistant = 3).
        assert_eq!(detail.summary.message_count, 3);
        assert_eq!(listed[0].message_count, 3);

        // (4) The settlement is folded onto the launch card instead.
        let marker = lifecycle_marker(&detail, "a1");
        assert_eq!(marker["task_id"], "agent-x1");
        assert_eq!(marker["status"], "completed");
        assert_eq!(marker["summary"], "Build succeeded (exit code 0).");
        assert!(
            marker["result"].is_null(),
            "CodeBuddy writes no <result> tag, so the marker must not invent one"
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unsettled_async_launch_marker_reports_no_status() {
        // No `<task-notification>` yet (the worker is still running, or the CLI
        // died): `status: null` renders as "launched, result pending" — never as
        // a zombie "running". Mirrors `claude.rs`.
        let root = std::env::temp_dir().join(format!("codeg-cb-unsettled-{}", uuid::Uuid::new_v4()));
        let sid = "sess-bg";
        write_session(&root, "Users-demo-app", sid, &async_launch_records());

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let marker = lifecycle_marker(&detail, "a1");
        assert_eq!(marker["task_id"], "agent-x1");
        assert!(marker["status"].is_null());
        assert!(marker["summary"].is_null());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_failed_worker_notification_keeps_its_status() {
        let root = std::env::temp_dir().join(format!("codeg-cb-bgfail-{}", uuid::Uuid::new_v4()));
        let sid = "sess-bg";
        let mut records = async_launch_records();
        // A resumed worker re-notifies under the SAME id — last wins.
        records.push(task_notification_record(
            1789450948007,
            "agent-x1",
            "completed",
            "first",
        ));
        records.push(task_notification_record(
            1789450949007,
            "agent-x1",
            "failed",
            "worker failed",
        ));
        write_session(&root, "Users-demo-app", sid, &records);

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let marker = lifecycle_marker(&detail, "a1");
        assert_eq!(marker["status"], "failed");
        assert_eq!(marker["summary"], "worker failed");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn async_launch_loads_the_detached_workers_transcript() {
        // An async launch carries no `subAgent` block (that only appears once a
        // BLOCKING delegation finishes), but the detached worker still writes
        // `<session>/subagents/<taskId>.jsonl`. Without the spawn-renderer
        // fallback every backgrounded worker's nested tool calls were dropped.
        let root = std::env::temp_dir().join(format!("codeg-cb-asyncsub-{}", uuid::Uuid::new_v4()));
        let sid = "sess-bg";
        write_session(&root, "Users-demo-app", sid, &async_launch_records());
        write_subagent(
            &root,
            "Users-demo-app",
            sid,
            "agent-x1",
            &[
                json!({"type":"function_call","timestamp":1789450930000i64,"sessionId":"agent-x1",
                       "name":"Bash","callId":"s1","arguments":"{\"command\": \"pnpm build\"}"}),
                json!({"type":"function_call_result","timestamp":1789450931000i64,"sessionId":"agent-x1",
                       "name":"Bash","callId":"s1","status":"completed",
                       "output":{"type":"text","text":"Compiled successfully"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let stats = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("a1") => agent_stats.clone(),
                _ => None,
            })
            .expect("async launch must load the detached worker's transcript");
        assert_eq!(stats.total_tool_use_count, Some(1));
        assert_eq!(stats.tool_calls[0].tool_name, "Bash");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_non_agent_result_is_never_touched_by_the_background_fold() {
        // Isolation, mirroring `subagent_tool_calls_loaded_into_agent_stats`'s
        // stray-`subAgent` guard: both the lifecycle rewrite and the transcript
        // load are gated on the PAIRED CALL being an `Agent`, not on the
        // renderer's presence — so a stray spawn renderer on a Bash result can
        // neither rewrite its output nor pull in a transcript.
        let root = std::env::temp_dir().join(format!("codeg-cb-bgiso-{}", uuid::Uuid::new_v4()));
        let sid = "sess-bg";
        let mut records = async_launch_records();
        records.push(
            json!({"type":"function_call","timestamp":1789450940000i64,"cwd":"/Users/demo/app","sessionId":sid,
                   "name":"Bash","callId":"b1","arguments":"{\"command\": \"ls\"}"}),
        );
        records.push(
            json!({"type":"function_call_result","timestamp":1789450940100i64,"cwd":"/Users/demo/app","sessionId":sid,
                   "name":"Bash","callId":"b1","status":"completed",
                   "output":{"type":"text","text":"a.ts"},
                   "providerData":{"toolResult":{"content":"a.ts","renderer": spawn_renderer("agent-x1")}}}),
        );
        records.push(task_notification_record(
            1789450948007,
            "agent-x1",
            "completed",
            "done",
        ));
        write_session(&root, "Users-demo-app", sid, &records);
        write_subagent(
            &root,
            "Users-demo-app",
            sid,
            "agent-x1",
            &[
                json!({"type":"function_call","timestamp":1789450930000i64,"sessionId":"agent-x1",
                       "name":"Bash","callId":"s1","arguments":"{\"command\": \"pnpm build\"}"}),
                json!({"type":"function_call_result","timestamp":1789450931000i64,"sessionId":"agent-x1",
                       "name":"Bash","callId":"s1","status":"completed",
                       "output":{"type":"text","text":"ok"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");
        let (output, stats) = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("b1") => {
                    Some((output_preview.clone(), agent_stats.clone()))
                }
                _ => None,
            })
            .expect("bash result");
        assert_eq!(output.as_deref(), Some("a.ts"));
        assert!(stats.is_none());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn deferred_mcp_tool_is_unwrapped() {
        let root = std::env::temp_dir().join(format!("codeg-cb-defer-{}", uuid::Uuid::new_v4()));
        let sid = "sess-defer";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"delegate it"}]}),
                // CodeBuddy invokes MCP tools via DeferExecuteTool: the real tool
                // name + params are packed under arguments.{toolName,params}.
                json!({"type":"function_call","timestamp":1782193811200i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"DeferExecuteTool","callId":"d1",
                       "arguments":"{\"params\":{\"agent_type\":\"codex\",\"task\":\"build\",\"working_dir\":\"/Users/demo/app\"},\"toolName\":\"mcp__codeg-mcp__delegate_to_agent\"}"}),
                // The result carries the real MCP report under providerData.toolResult.mcpMeta.
                json!({"type":"function_call_result","timestamp":1782193811400i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"DeferExecuteTool","callId":"d1","status":"completed",
                       "output":{"type":"text","text":"Delegation successful. task_id=e5c9"},
                       "providerData":{"toolResult":{"content":"Delegation successful. task_id=e5c9",
                         "mcpMeta":{"structuredContent":{"agent_type":"codex","child_conversation_id":15,"status":"running","task_id":"e5c9","message":"ok"}}}}}),
                json!({"type":"function_call","timestamp":1782193811600i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"DeferExecuteTool","callId":"d2",
                       "arguments":"{\"params\":{\"task_ids\":[\"e5c9\"],\"wait_ms\":60000},\"toolName\":\"mcp__codeg-mcp__get_delegation_status\"}"}),
                json!({"type":"function_call","timestamp":1782193811700i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"DeferExecuteTool","callId":"d3",
                       "arguments":"{\"params\":{\"task_id\":\"e5c9\"},\"toolName\":\"mcp__codeg-mcp__cancel_delegation\"}"}),
                // A plain (non-deferred) tool must keep its name and text output.
                json!({"type":"function_call","timestamp":1782193811800i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","arguments":"{\"command\": \"ls\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811900i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Bash","callId":"b1","status":"completed","output":{"type":"text","text":"a.ts"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());
        let detail = parser.get_conversation(sid).expect("detail");

        let mut uses = Vec::new();
        let mut results = Vec::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                match block {
                    ContentBlock::ToolUse {
                        tool_name,
                        tool_use_id,
                        input_preview,
                        ..
                    } => uses.push((
                        tool_name.clone(),
                        tool_use_id.clone(),
                        input_preview.clone(),
                    )),
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output_preview,
                        ..
                    } => results.push((tool_use_id.clone(), output_preview.clone())),
                    _ => {}
                }
            }
        }

        let name_of = |id: &str| {
            uses.iter()
                .find(|(_, u, _)| u.as_deref() == Some(id))
                .unwrap_or_else(|| panic!("tool use {id}"))
                .0
                .clone()
        };
        // Each DeferExecuteTool resolves to its inner MCP tool name; normalizeToolName
        // (frontend) then collapses the `mcp__…__` prefix to the canonical card name.
        assert_eq!(name_of("d1"), "mcp__codeg-mcp__delegate_to_agent");
        assert_eq!(name_of("d2"), "mcp__codeg-mcp__get_delegation_status");
        assert_eq!(name_of("d3"), "mcp__codeg-mcp__cancel_delegation");
        // Plain tool untouched.
        assert_eq!(name_of("b1"), "Bash");

        // input_preview keeps the wrapper — the frontend cards peel `params`.
        let d1_input = uses
            .iter()
            .find(|(_, u, _)| u.as_deref() == Some("d1"))
            .and_then(|(_, _, i)| i.clone())
            .unwrap_or_default();
        assert!(
            d1_input.contains("params") && d1_input.contains("agent_type"),
            "input must keep the params wrapper, got: {d1_input}"
        );

        // The result surfaces the MCP envelope so delegation cards recover
        // structuredContent / child_conversation_id (not just the ack text).
        let d1_output = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("d1"))
            .and_then(|(_, o)| o.clone())
            .expect("d1 result");
        assert!(
            d1_output.contains("structuredContent") && d1_output.contains("child_conversation_id"),
            "delegation result must surface the structured MCP report, got: {d1_output}"
        );

        // A plain tool's output stays its text (no envelope).
        let b1_output = results
            .iter()
            .find(|(id, _)| id.as_deref() == Some("b1"))
            .and_then(|(_, o)| o.clone())
            .expect("b1 result");
        assert_eq!(b1_output, "a.ts");

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn subagent_transcript_is_excluded_from_conversation_list() {
        // Regression: a sub-agent transcript lives at `<session>/subagents/<agent>.jsonl`
        // inside the recursively-scanned projects tree. It must feed ONLY the
        // Agent result's agent_stats — never surface as a top-level conversation,
        // nor be openable by its own id via get_conversation.
        let root = std::env::temp_dir().join(format!("codeg-cb-sublist-{}", uuid::Uuid::new_v4()));
        let sid = "sess-list";
        write_session(
            &root,
            "Users-demo-app",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "content":[{"type":"input_text","text":"build it"}]}),
                json!({"type":"function_call","timestamp":1782193811200i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a1",
                       "arguments":"{\"description\": \"build\", \"prompt\": \"run the build\", \"subagent_type\": \"general-purpose\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811400i64,"cwd":"/Users/demo/app","sessionId":sid,
                       "name":"Agent","callId":"a1","status":"completed",
                       "output":{"type":"text","text":"Build succeeded"},
                       "providerData":{"toolResult":{"content":"Build succeeded","subAgent":{"sessionId":"agent-list01"}}}}),
            ],
        );
        // The sub-agent transcript carries its own sessionId + content records, so
        // WITHOUT the skip it would parse into a (bogus) top-level summary.
        write_subagent(
            &root,
            "Users-demo-app",
            sid,
            "agent-list01",
            &[
                json!({"type":"message","role":"user","timestamp":1782193811250i64,"sessionId":"agent-list01",
                       "content":[{"type":"input_text","text":"internal subagent prompt"}]}),
                json!({"type":"function_call","timestamp":1782193811260i64,"sessionId":"agent-list01",
                       "name":"Bash","callId":"s1","arguments":"{\"command\": \"pnpm build\"}"}),
                json!({"type":"function_call_result","timestamp":1782193811300i64,"sessionId":"agent-list01",
                       "name":"Bash","callId":"s1","status":"completed","output":{"type":"text","text":"ok"}}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());

        // (1) Only the real session is listed; the sub-agent transcript is not.
        let list = parser.list_conversations().expect("list");
        assert_eq!(list.len(), 1, "only the top-level session is listed");
        assert_eq!(list[0].id, sid);
        assert!(
            !list.iter().any(|c| c.id == "agent-list01"),
            "a sub-agent transcript must not appear as a conversation"
        );

        // (2) It can't be opened as a conversation by its own id either.
        assert!(
            matches!(
                parser.get_conversation("agent-list01"),
                Err(ParseError::ConversationNotFound(_))
            ),
            "a sub-agent transcript id must not resolve to a conversation"
        );

        // (3) But it STILL feeds the Agent result's agent_stats in the real session.
        let detail = parser.get_conversation(sid).expect("detail");
        let agent_stats = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("a1") => agent_stats.clone(),
                _ => None,
            })
            .expect("Agent result still carries agent_stats from the subagent transcript");
        assert_eq!(agent_stats.total_tool_use_count, Some(1));

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn top_level_session_under_subagents_named_project_dir_is_listed() {
        // False-positive guard: a legitimate top-level session whose encoded-cwd
        // project dir is literally named `subagents`
        // (`<projects>/subagents/<sessionId>.jsonl`, 2 components) must still be
        // listed/opened — the nested sub-agent transcript shape is one level
        // deeper (`<project>/<session>/subagents/<agent>.jsonl`, 4 components).
        let root = std::env::temp_dir().join(format!("codeg-cb-subdir-{}", uuid::Uuid::new_v4()));
        let sid = "sess-in-subagents-dir";
        write_session(
            &root,
            "subagents",
            sid,
            &[
                json!({"type":"message","role":"user","timestamp":1782193811000i64,"cwd":"/Users/demo/subagents","sessionId":sid,
                       "content":[{"type":"input_text","text":"hi"}]}),
                json!({"type":"message","role":"assistant","timestamp":1782193811100i64,"cwd":"/Users/demo/subagents","sessionId":sid,
                       "content":[{"type":"output_text","text":"hello"}]}),
            ],
        );

        let parser = CodeBuddyParser::with_base_dir(root.clone());

        let list = parser.list_conversations().expect("list");
        assert_eq!(
            list.len(),
            1,
            "a session whose project dir is named `subagents` is still a conversation"
        );
        assert_eq!(list[0].id, sid);
        // And it opens normally rather than 404-ing.
        assert!(
            parser.get_conversation(sid).is_ok(),
            "the session must be openable, not skipped as a transcript"
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
