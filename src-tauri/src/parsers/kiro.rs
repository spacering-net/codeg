//! Kiro CLI session history.
//!
//! Every Kiro session — interactive, headless, and the `kiro-cli acp` ones
//! codeg drives — is two sibling files under `<KIRO_HOME>/sessions/cli/`
//! (default `~/.kiro/sessions/cli/`):
//!
//! * `<id>.jsonl` — the append-only event log. One `{"version":"v1","kind":…,
//!   "data":…}` record per line. The kinds 2.24.1 writes are `Prompt`,
//!   `AssistantMessage`, `ToolResults`, `Compaction`, `Clear`, `ResetTo` and
//!   `CancelledPrompt`.
//! * `<id>.json` — session metadata, REWRITTEN at the end of every turn:
//!   `cwd`, `title`, `created_at` / `updated_at`, and a `session_state` whose
//!   `conversation_metadata.user_turn_metadatas[]` lists each user turn's
//!   `message_ids` with its `end_timestamp`, and whose `rts_model_state` names
//!   the model and its context window.
//!
//! Neither file is sufficient alone: only `Prompt` records carry a timestamp
//! (epoch seconds), so the time an answer finished comes from the metadata;
//! and the metadata holds no content. The summary cache is therefore keyed on
//! the log with the metadata as a companion
//! ([`super::summary_cache::get_or_parse_with_companions`]).
//!
//! Also in that directory, and deliberately ignored: `<id>.lock` (the pid of a
//! live process), `<id>.history` (the prompt-line history of the TUI) and
//! `<id>/` (the session's task list).

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use base64::Engine;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, ImageData, MessageRole,
    UnifiedMessage,
};
use crate::parsers::claude::group_into_turns;
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, is_safe_subagent_id, merge_context_window_stats,
    relocate_orphaned_tool_results, title_from_user_text, with_reported_context_percent,
    AgentParser, ParseError,
};

/// `KIRO_HOME` if set (and non-empty), else `~/.kiro`.
///
/// `KIRO_HOME` names the `.kiro` directory ITSELF — Kiro's docs: "Overrides the
/// `~/.kiro` directory used for global agents, prompts, skills, steering,
/// settings, and sessions". Verified against 2.24.1: with
/// `KIRO_HOME=/tmp/kh`, `kiro-cli acp` writes `/tmp/kh/sessions/cli/<id>.json`
/// and `/tmp/kh/settings/cli.json`. The value is taken verbatim (no `~`
/// expansion), which is what the file-system runtime's root slot mirrors.
pub(crate) fn resolve_kiro_home_dir() -> PathBuf {
    resolve_kiro_home_dir_from(std::env::var_os("KIRO_HOME"), dirs::home_dir())
}

fn resolve_kiro_home_dir_from(kiro_home: Option<OsString>, home: Option<PathBuf>) -> PathBuf {
    if let Some(dir) = kiro_home.filter(|value| !value.is_empty()) {
        return PathBuf::from(dir);
    }
    home.unwrap_or_default().join(".kiro")
}

/// `<KIRO_HOME>/sessions` — the whole sessions tree (only `cli/` today).
pub(crate) fn resolve_kiro_sessions_root() -> PathBuf {
    resolve_kiro_home_dir().join("sessions")
}

pub struct KiroParser {
    sessions_dir: PathBuf,
}

impl KiroParser {
    pub fn new() -> Self {
        Self {
            sessions_dir: resolve_kiro_sessions_root().join("cli"),
        }
    }

    /// Construct a parser pointed at an explicit `sessions/cli` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(sessions_dir: PathBuf) -> Self {
        Self { sessions_dir }
    }
}

impl Default for KiroParser {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Metadata (`<id>.json`)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct SessionMeta {
    cwd: Option<String>,
    title: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    model: Option<String>,
    context_window: Option<u64>,
    context_percent: Option<f64>,
    /// The LAST message of each user turn → that turn's `end_timestamp`.
    ///
    /// Only the last one: an assistant message in the middle of a turn (the one
    /// that asked for a tool) did not finish when the turn did, and stamping it
    /// with the turn's end would hand it the whole turn's duration.
    turn_ends: HashMap<String, DateTime<Utc>>,
}

fn parse_rfc3339(value: Option<&Value>) -> Option<DateTime<Utc>> {
    value
        .and_then(Value::as_str)
        .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
        .map(|t| t.with_timezone(&Utc))
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_meta(bytes: Option<&[u8]>) -> SessionMeta {
    let Some(root) = bytes.and_then(|b| serde_json::from_slice::<Value>(b).ok()) else {
        return SessionMeta::default();
    };
    let state = root.get("session_state");
    let conversation = state.and_then(|s| s.get("conversation_metadata"));
    let rts = state.and_then(|s| s.get("rts_model_state"));
    let model_info = rts.and_then(|r| r.get("model_info"));
    let last_usage = conversation.and_then(|c| c.get("last_context_usage"));

    let mut turn_ends = HashMap::new();
    let mut last_turn_model = None;
    if let Some(turns) = conversation
        .and_then(|c| c.get("user_turn_metadatas"))
        .and_then(Value::as_array)
    {
        for turn in turns {
            if let Some(model) = non_empty_str(turn.get("model")) {
                last_turn_model = Some(model);
            }
            let Some(end) = parse_rfc3339(turn.get("end_timestamp")) else {
                continue;
            };
            // A cancelled turn records `[<prompt id>, null]`: the answer it
            // was waiting for never got an id. The end then belongs to no
            // message on disk — stamping it on the PROMPT would date the user
            // turn to when the cancel landed — so it is dropped.
            let last_id = turn
                .get("message_ids")
                .and_then(Value::as_array)
                .and_then(|ids| ids.last())
                .and_then(Value::as_str);
            if let Some(id) = last_id {
                // A later turn can repeat an earlier turn's ids (a `/compact`
                // records the turn it summarized); the first end stands.
                turn_ends.entry(id.to_string()).or_insert(end);
            }
        }
    }

    SessionMeta {
        cwd: non_empty_str(root.get("cwd")),
        title: non_empty_str(root.get("title")),
        created_at: parse_rfc3339(root.get("created_at")),
        updated_at: parse_rfc3339(root.get("updated_at")),
        model: non_empty_str(model_info.and_then(|m| m.get("model_id")))
            .or_else(|| non_empty_str(last_usage.and_then(|u| u.get("model_id"))))
            .or(last_turn_model),
        context_window: model_info
            .and_then(|m| m.get("context_window_tokens"))
            .and_then(Value::as_u64)
            .filter(|w| *w > 0),
        context_percent: last_usage
            .and_then(|u| u.get("percentage"))
            .and_then(Value::as_f64)
            .or_else(|| {
                rts.and_then(|r| r.get("context_usage_percentage"))
                    .and_then(Value::as_f64)
            })
            .filter(|p| p.is_finite() && *p >= 0.0),
        turn_ends,
    }
}

// ---------------------------------------------------------------------------
// Event log (`<id>.jsonl`)
// ---------------------------------------------------------------------------

struct Transcript {
    messages: Vec<UnifiedMessage>,
    first_prompt_text: Option<String>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    /// The model named by the newest thinking block, when the metadata names
    /// none.
    thinking_model: Option<String>,
}

impl Transcript {
    /// What the conversation renders: prompts, answers and markers — the tool
    /// results fold into the answer that asked for them.
    fn message_count(&self) -> u32 {
        self.messages
            .iter()
            .filter(|m| {
                !(matches!(m.role, MessageRole::User)
                    && m.content
                        .iter()
                        .all(|b| matches!(b, ContentBlock::ToolResult { .. })))
            })
            .count() as u32
    }
}

/// `Prompt.data.meta.timestamp`: epoch SECONDS (integer in 2.24.1; a float is
/// tolerated).
fn prompt_timestamp(data: &Value) -> Option<DateTime<Utc>> {
    let raw = data.pointer("/meta/timestamp")?;
    let millis = raw
        .as_i64()
        .map(|s| s.saturating_mul(1000))
        .or_else(|| raw.as_f64().map(|s| (s * 1000.0) as i64))?;
    Utc.timestamp_millis_opt(millis).single()
}

/// An image block's bytes, as Kiro stores them: `{"format":"png","source":
/// {"kind":"bytes","data":[137,80,78,…]}}`. A base64 string source is accepted
/// too, in case a writer stores one.
fn image_data(data: &Value) -> Option<ImageData> {
    let format = data
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("png")
        .to_ascii_lowercase();
    let source = data.get("source")?;
    let encoded = match source.get("data")? {
        Value::Array(bytes) => {
            let raw: Option<Vec<u8>> = bytes
                .iter()
                .map(|b| b.as_u64().and_then(|n| u8::try_from(n).ok()))
                .collect();
            base64::engine::general_purpose::STANDARD.encode(raw?)
        }
        Value::String(b64) if !b64.is_empty() => b64.clone(),
        _ => return None,
    };
    let subtype = if format == "jpg" { "jpeg" } else { &format };
    Some(ImageData {
        data: encoded,
        mime_type: format!("image/{subtype}"),
        uri: None,
    })
}

/// Blocks of a `Prompt` (user text and pasted images).
fn prompt_blocks(data: &Value) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    for item in data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        match item.get("kind").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = item.get("data").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
            }
            Some("image") => {
                if let Some(image) = item.get("data").and_then(image_data) {
                    blocks.push(ContentBlock::Image {
                        data: image.data,
                        mime_type: image.mime_type,
                        uri: image.uri,
                    });
                }
            }
            _ => {}
        }
    }
    blocks
}

/// Blocks of an `AssistantMessage`, plus the model its thinking block names.
///
/// Empty thinking is dropped: for models whose reasoning is withheld Kiro
/// writes `{"text":"","redactedContent":[…]}`, which has nothing to show. So is
/// the empty `text` block Kiro writes in front of every tool call.
///
/// A built-in tool is renamed and its input rewritten ([`canonical_tool`]);
/// `tools` remembers each one by id for the result that answers it.
fn assistant_blocks(
    data: &Value,
    tools: &mut HashMap<String, CanonicalTool>,
) -> (Vec<ContentBlock>, Option<String>) {
    let mut blocks = Vec::new();
    let mut model = None;
    for item in data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let body = item.get("data");
        match item.get("kind").and_then(Value::as_str) {
            Some("thinking") => {
                if let Some(id) = non_empty_str(body.and_then(|b| b.get("modelId"))) {
                    model = Some(id);
                }
                if let Some(text) = body.and_then(|b| b.get("text")).and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        blocks.push(ContentBlock::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
            }
            Some("text") => {
                if let Some(text) = body.and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
            }
            Some("toolUse") => {
                let Some(body) = body else { continue };
                let Some(name) = non_empty_str(body.get("name")) else {
                    continue;
                };
                // MCP tools arrive under their bare tool name (the server is
                // named only in the paired result's `results` map), which is
                // also how the frontend's alias table already knows codeg-mcp's
                // own tools (`delegate_to_agent`, …).
                let tool_use_id = non_empty_str(body.get("toolUseId"));
                let input = body.get("input");
                let canonical = input.and_then(|input| canonical_tool(&name, input));
                let input = canonical.as_ref().map(|tool| &tool.input).or(input);
                let input_preview = input.map(|input| {
                    serde_json::to_string_pretty(input).unwrap_or_else(|_| input.to_string())
                });
                let tool_name = canonical
                    .as_ref()
                    .map_or(name, |tool| tool.name.to_string());
                if let (Some(id), Some(tool)) = (&tool_use_id, canonical) {
                    tools.insert(id.clone(), tool);
                }
                blocks.push(ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_preview,
                    status: None,
                    meta: None,
                });
            }
            _ => {}
        }
    }
    (blocks, model)
}

/// Blocks of a `ToolResults` record: one `ToolResult` per `toolResult` item.
///
/// A result's `content` is a list of `text` / `json` / `image` items; texts
/// and JSON values join into the preview (see [`result_json_text`]), images
/// ride alongside. `status: "error"` covers both a failed tool and one the
/// user denied (Kiro records the denial as the text "User denied tool
/// execution"). `tools` is what [`assistant_blocks`] canonicalized, by id.
fn tool_result_blocks(data: &Value, tools: &HashMap<String, CanonicalTool>) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    for item in data
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if item.get("kind").and_then(Value::as_str) != Some("toolResult") {
            continue;
        }
        let Some(body) = item.get("data") else {
            continue;
        };
        let mut texts: Vec<String> = Vec::new();
        let mut images = Vec::new();
        for part in body
            .get("content")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let part_data = part.get("data");
            match part.get("kind").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = part_data.and_then(Value::as_str) {
                        texts.push(text.to_string());
                    }
                }
                Some("json") => {
                    if let Some(value) = part_data {
                        texts.push(result_json_text(value));
                    }
                }
                Some("image") => {
                    if let Some(image) = part_data.and_then(image_data) {
                        images.push(image);
                    }
                }
                _ => {}
            }
        }
        let tool_use_id = non_empty_str(body.get("toolUseId"));
        let canonical = tool_use_id.as_ref().and_then(|id| tools.get(id));
        blocks.push(ContentBlock::ToolResult {
            output_preview: (!texts.is_empty())
                .then(|| structure_tool_output(canonical, texts.join("\n"))),
            tool_use_id,
            is_error: body.get("status").and_then(Value::as_str) == Some("error"),
            agent_stats: None,
            images,
        });
    }
    blocks
}

// ── Tool calls ───────────────────────────────────────────────────────────

/// Codeg's own name and argument shape for a call to one of Kiro's built-in
/// tools.
///
/// Kiro's tools take arguments no card reads. `write` is ONE tool whose
/// `command` (`create` / `strReplace` / `insert`) picks the operation, `read`
/// takes a list of `operations`, and every call carries the model's
/// `__tool_use_purpose`. Left like that, the input-shape classifier reads
/// `write`'s `command` as a shell command — a `$ strReplace` terminal card —
/// and finds no path to read in `read`. This maps them onto the arguments the
/// dedicated cards take (Claude Code's), for the history parser and the live
/// stream alike (`acp::connection`), so a card renders the same while it runs
/// and after a reload.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanonicalTool {
    pub name: &'static str,
    pub input: Value,
}

const TOOL_PURPOSE_KEY: &str = "__tool_use_purpose";

/// See [`CanonicalTool`]. `None` leaves the call as Kiro sent it: a tool with
/// no dedicated card (`code`, `use_aws`, `todo_list`, …), an MCP tool, a
/// `read` of several targets at once, or a shape this doesn't recognize.
///
/// The purpose becomes `description`, which the terminal card shows as the
/// command's caption (and the tool header as its title), exactly like Claude
/// Code's own `Bash` description.
pub(crate) fn canonical_tool(name: &str, input: &Value) -> Option<CanonicalTool> {
    let args = input.as_object()?;
    let text = |key: &str| args.get(key).and_then(Value::as_str);
    let mut out = serde_json::Map::new();
    let name: &'static str = match name {
        "shell" => {
            out.insert("command".into(), text("command")?.into());
            if let Some(dir) = text("working_dir") {
                out.insert("cwd".into(), dir.into());
            }
            "bash"
        }
        "write" => {
            out.insert("file_path".into(), text("path")?.into());
            match text("command")? {
                // A created file renders as new (the write card's
                // `--- /dev/null` diff), not as an edit of an empty one.
                "create" => {
                    out.insert("content".into(), text("content").unwrap_or("").into());
                    "write"
                }
                "strReplace" => {
                    out.insert("old_string".into(), text("oldStr").unwrap_or("").into());
                    out.insert("new_string".into(), text("newStr").unwrap_or("").into());
                    if args.get("replaceAll") == Some(&Value::Bool(true)) {
                        out.insert("replace_all".into(), true.into());
                    }
                    "edit"
                }
                // Lines added at `insertLine`, nothing removed. The live frame
                // also carries a whole-file diff, but the log does not, and
                // both surfaces must read the same arguments.
                "insert" => {
                    out.insert("old_string".into(), "".into());
                    out.insert("new_string".into(), text("content").unwrap_or("").into());
                    // 0-based "insert at"; the edit card's `_start_line` is the
                    // 1-based line the new text starts on.
                    if let Some(line) = args.get("insertLine").and_then(Value::as_u64) {
                        out.insert("_start_line".into(), (line + 1).into());
                    }
                    "edit"
                }
                _ => return None,
            }
        }
        "read" => {
            let [op] = args.get("operations")?.as_array()?.as_slice() else {
                return None;
            };
            let op_text = |key: &str| op.get(key).and_then(Value::as_str);
            match op_text("mode").unwrap_or("Line") {
                "Line" => {
                    out.insert("file_path".into(), op_text("path")?.into());
                    // Kiro's `offset` is how many lines to skip (its own title
                    // for offset 6396 reads `:6397-…`); the read card's
                    // `offset` is the first line shown. A negative one (from
                    // the end) has no such line, so it passes through.
                    if let Some(offset) = op.get("offset") {
                        match offset.as_i64() {
                            Some(0) => {}
                            Some(skip) if skip > 0 => {
                                out.insert("offset".into(), (skip + 1).into());
                            }
                            _ => {
                                out.insert("offset".into(), offset.clone());
                            }
                        }
                    }
                    if let Some(limit) = op.get("limit") {
                        out.insert("limit".into(), limit.clone());
                    }
                    "read"
                }
                "Directory" => {
                    out.insert("path".into(), op_text("path")?.into());
                    if let Some(depth) = op.get("depth") {
                        out.insert("depth".into(), depth.clone());
                    }
                    "ls"
                }
                "Image" => {
                    let [path] = op.get("image_paths")?.as_array()?.as_slice() else {
                        return None;
                    };
                    out.insert("file_path".into(), path.as_str()?.into());
                    "read"
                }
                _ => return None,
            }
        }
        // Already the arguments the search and web cards read; only the name
        // (and the purpose) differ.
        "grep" | "glob" | "web_fetch" | "web_search" => {
            for (key, value) in args {
                if key != TOOL_PURPOSE_KEY {
                    out.insert(key.clone(), value.clone());
                }
            }
            match name {
                "grep" => "grep",
                "glob" => "glob",
                "web_fetch" => "webfetch",
                _ => "websearch",
            }
        }
        _ => return None,
    };
    if let Some(purpose) = text(TOOL_PURPOSE_KEY)
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        out.entry("description")
            .or_insert_with(|| purpose.to_string().into());
    }
    Some(CanonicalTool {
        name,
        input: Value::Object(out),
    })
}

/// Which built-in tool a call is, from its arguments alone — for the one
/// frame that names none: a permission request's `toolCall` carries no
/// `_meta`. Only the tools whose raw arguments render WRONG are recognized
/// (`write`'s `command` reads as a shell command, `read` has no path); a
/// `command` with no `path` beside it is `shell`, which Kiro spells no other
/// way.
pub(crate) fn tool_name_from_input(input: &Value) -> Option<&'static str> {
    let args = input.as_object()?;
    if args.get("operations").is_some_and(Value::is_array) {
        return Some("read");
    }
    let command = args.get("command")?.as_str()?;
    if args.get("path").is_some_and(Value::is_string) {
        return matches!(command, "create" | "strReplace" | "insert").then_some("write");
    }
    Some("shell")
}

/// The text one part of a tool result contributes. `json` parts are
/// flattened where a card expects text: a shell result (`{exit_status,
/// stdout, stderr}`) becomes what the terminal printed, an MCP result (`{content:
/// [{type:"text",text}]}`) its text — which the codeg-mcp companion cards
/// parse. Any other JSON (`grep`'s match list, `glob`'s file list, …) is shown
/// pretty-printed.
fn result_json_text(value: &Value) -> String {
    if let Some(obj) = value.as_object() {
        let stdout = obj.get("stdout").and_then(Value::as_str);
        let stderr = obj.get("stderr").and_then(Value::as_str);
        if stdout.is_some() || stderr.is_some() {
            let mut out = String::new();
            for stream in [stdout, stderr].into_iter().flatten() {
                if stream.is_empty() {
                    continue;
                }
                if !out.is_empty() && !out.ends_with('\n') {
                    out.push('\n');
                }
                out.push_str(stream);
            }
            // "exit status: 3" — Kiro's own wording; a success says nothing.
            if let Some(status) = obj.get("exit_status").and_then(Value::as_str) {
                if !status.trim_end().ends_with(": 0") {
                    if !out.is_empty() && !out.ends_with('\n') {
                        out.push('\n');
                    }
                    out.push_str(status);
                }
            }
            return out;
        }
        if let Some(parts) = obj.get("content").and_then(Value::as_array) {
            let texts: Vec<&str> = parts
                .iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect();
            if !texts.is_empty() {
                return texts.join("\n");
            }
        }
    }
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

/// A live `rawOutput` — `{"items":[{"Text":"…"} | {"Json":{…}} | {"Image":…}]}`
/// — as the text the same result gets from the history parser. `None` when it
/// is not that envelope, so the caller keeps its generic handling.
pub(crate) fn live_tool_output_text(raw_output: &Value) -> Option<String> {
    let items = raw_output.get("items")?.as_array()?;
    let texts: Vec<String> = items
        .iter()
        .filter_map(|item| {
            if let Some(text) = item.get("Text").and_then(Value::as_str) {
                return Some(text.to_string());
            }
            item.get("Json").map(result_json_text)
        })
        .collect();
    Some(texts.join("\n"))
}

/// A `read` result that starts past line 1, as the `{start_line, content}`
/// the read card numbers its lines from (Kiro returns the bare lines). Every
/// other result is returned unchanged.
pub(crate) fn structure_tool_output(canonical: Option<&CanonicalTool>, text: String) -> String {
    let start_line = canonical
        .filter(|tool| tool.name == "read")
        .and_then(|tool| tool.input.get("offset"))
        .and_then(Value::as_u64)
        .filter(|line| *line > 1);
    match start_line {
        Some(start_line) => {
            serde_json::json!({ "start_line": start_line, "content": text }).to_string()
        }
        None => text,
    }
}

fn parse_transcript(log: &[u8], meta: &SessionMeta) -> Transcript {
    let mut messages: Vec<UnifiedMessage> = Vec::new();
    let mut seen_ids: HashSet<String> = HashSet::new();
    let mut first_prompt_text = None;
    let mut thinking_model = None;
    let mut tools: HashMap<String, CanonicalTool> = HashMap::new();
    // The newest prompt's time: every record after it happened no earlier.
    let mut cursor = meta.created_at;

    for line in log.split(|b| *b == b'\n') {
        let Ok(line) = std::str::from_utf8(line) else {
            continue;
        };
        if line.trim().is_empty() {
            continue;
        }
        // A trailing line can be half-written while a turn streams.
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(data) = record.get("data") else {
            continue;
        };
        let kind = record.get("kind").and_then(Value::as_str).unwrap_or("");
        let message_id = non_empty_str(data.get("message_id"));
        // `CancelledPrompt` (never observed in a 2.24.1 log — a cancel mid-reply
        // leaves the `Prompt` and an "interrupted" `AssistantMessage`) is read
        // like a `Prompt`, so a record that repeats one must not render twice.
        if let Some(id) = &message_id {
            if !seen_ids.insert(id.clone()) {
                continue;
            }
        }

        let (role, content, model) = match kind {
            "Prompt" | "CancelledPrompt" => {
                if let Some(ts) = prompt_timestamp(data) {
                    cursor = Some(cursor.map_or(ts, |c| c.max(ts)));
                }
                let blocks = prompt_blocks(data);
                if first_prompt_text.is_none() {
                    first_prompt_text = blocks.iter().find_map(|b| match b {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    });
                }
                (MessageRole::User, blocks, None)
            }
            "AssistantMessage" => {
                let (blocks, model) = assistant_blocks(data, &mut tools);
                if model.is_some() {
                    thinking_model.clone_from(&model);
                }
                (MessageRole::Assistant, blocks, model)
            }
            // Folded into the answer that asked for them by `group_into_turns`.
            "ToolResults" => (MessageRole::User, tool_result_blocks(data, &tools), None),
            // `/compact`: the summary is what the conversation carries on with.
            // The records it summarized stay in the log, and keep rendering.
            "Compaction" => {
                let blocks = non_empty_str(data.get("summary"))
                    .map(|text| vec![ContentBlock::Text { text }])
                    .unwrap_or_default();
                (MessageRole::System, blocks, None)
            }
            // `/clear` writes no `Prompt`, only this marker. Rendered as the
            // command the user typed; the history before it stays visible.
            "Clear" => (
                MessageRole::User,
                vec![ContentBlock::Text {
                    text: "/clear".to_string(),
                }],
                None,
            ),
            // `ResetTo` (`/rewind`, which forks into a NEW session) and any
            // kind a later release adds: rendering nothing is safer than
            // guessing at a shape — and truncating on a guessed index could
            // hide messages the user really sent.
            _ => continue,
        };
        if content.is_empty() {
            continue;
        }
        let Some(timestamp) = cursor else {
            continue;
        };
        let completed_at = message_id
            .as_ref()
            .and_then(|id| meta.turn_ends.get(id).copied())
            .filter(|end| *end >= timestamp);
        messages.push(UnifiedMessage {
            id: message_id.unwrap_or_else(|| format!("kiro-{}", messages.len())),
            role,
            content,
            timestamp,
            usage: None,
            duration_ms: None,
            model,
            completed_at,
            agent_message_id: None,
        });
    }

    let first_ts = messages.first().map(|m| m.timestamp);
    let last_ts = messages
        .iter()
        .map(|m| m.completed_at.unwrap_or(m.timestamp))
        .max();
    Transcript {
        messages,
        first_prompt_text,
        first_ts,
        last_ts,
        thinking_model,
    }
}

/// Everything both the summary and the detail path need, read ONCE so the two
/// can never disagree (a title that differed between them would make the
/// auto-title backfill oscillate).
struct Session {
    meta: SessionMeta,
    transcript: Transcript,
}

impl Session {
    fn read(log_path: &Path) -> std::io::Result<(Self, u64)> {
        let log = fs::read(log_path)?;
        let meta_bytes = fs::read(log_path.with_extension("json")).ok();
        let meta = parse_meta(meta_bytes.as_deref());
        let transcript = parse_transcript(&log, &meta);
        Ok((Self { meta, transcript }, log.len() as u64))
    }

    fn title(&self) -> Option<String> {
        self.meta.title.clone().or_else(|| {
            self.transcript
                .first_prompt_text
                .as_deref()
                .map(title_from_user_text)
        })
    }

    fn model(&self) -> Option<String> {
        self.meta
            .model
            .clone()
            .or_else(|| self.transcript.thinking_model.clone())
    }

    fn summary(&self, id: String) -> Option<ConversationSummary> {
        let started_at = self.transcript.first_ts?;
        Some(ConversationSummary {
            id,
            agent_type: AgentType::Kiro,
            folder_name: self.meta.cwd.as_deref().map(folder_name_from_path),
            folder_path: self.meta.cwd.clone(),
            title: self.title(),
            started_at,
            // Whichever is later: a turn end the log could not be tied to
            // (metadata from a newer writer, a cancelled turn) still moves
            // `updated_at`.
            ended_at: match (self.transcript.last_ts, self.meta.updated_at) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            },
            message_count: self.transcript.message_count(),
            model: self.model(),
            git_branch: None,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        })
    }
}

fn parse_summary(log_path: &Path) -> Option<ConversationSummary> {
    // The FILE STEM is the id: it is what `get_conversation` is handed back,
    // and Kiro itself names both files after the session id.
    let id = log_path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())?;
    let (session, _) = Session::read(log_path).ok()?;
    session.summary(id)
}

impl AgentParser for KiroParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        let Ok(entries) = fs::read_dir(&self.sessions_dir) else {
            return Ok(conversations);
        };
        for entry in entries.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl")
                || !entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            {
                continue;
            }
            let meta_path = path.with_extension("json");
            if let Ok(Some(summary)) = super::summary_cache::get_or_parse_with_companions(
                AgentType::Kiro,
                &path,
                &[meta_path.as_path()],
                || Ok(parse_summary(&path)),
            ) {
                conversations.push(summary);
            }
        }
        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        if !is_safe_subagent_id(conversation_id) {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }
        let log_path = self.sessions_dir.join(format!("{conversation_id}.jsonl"));
        if !log_path.is_file() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }
        // The watermark is EXACTLY the byte length this parse consumed — see
        // the same contract in `parsers::claude`.
        let (session, transcript_watermark) = Session::read(&log_path)?;
        let summary = session
            .summary(conversation_id.to_string())
            .unwrap_or_else(|| ConversationSummary {
                id: conversation_id.to_string(),
                agent_type: AgentType::Kiro,
                folder_name: session.meta.cwd.as_deref().map(folder_name_from_path),
                folder_path: session.meta.cwd.clone(),
                title: session.title(),
                started_at: session.meta.created_at.unwrap_or_else(Utc::now),
                ended_at: session.meta.updated_at,
                message_count: 0,
                model: session.model(),
                git_branch: None,
                parent_id: None,
                parent_tool_use_id: None,
                delegation_call_id: None,
            });

        let Session { meta, transcript } = session;
        let mut turns = group_into_turns(transcript.messages);
        relocate_orphaned_tool_results(&mut turns);
        backfill_turn_durations(&mut turns, &[]);

        // Kiro reports every token counter as 0 (its turn metadata carries
        // `input_token_count: 0` even for long sessions) but states occupancy
        // directly as a percentage, and the model's window beside it. The
        // used count is derived from those two so the gauge's used/max pair
        // agrees with the percentage it shows.
        let max_tokens = meta
            .context_window
            .or_else(|| infer_context_window_max_tokens(summary.model.as_deref()));
        let used_tokens = match (meta.context_percent, max_tokens) {
            (Some(percent), Some(max)) => Some(((percent / 100.0) * max as f64).round() as u64),
            _ => None,
        };
        let session_stats = with_reported_context_percent(
            merge_context_window_stats(compute_session_stats(&turns), used_tokens, max_tokens),
            meta.context_percent,
        );

        Ok(ConversationDetail {
            summary,
            turns,
            session_stats,
            transcript_watermark: Some(transcript_watermark),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TurnRole;

    const SID: &str = "7787f985-7083-420e-b99d-a74ccce5c00f";

    // Records captured from a real `kiro-cli acp` 2.24.1 session (signatures
    // and digests trimmed; ids kept).
    const PROMPT_1: &str = r#"{"version":"v1","kind":"Prompt","data":{"message_id":"p1","content":[{"kind":"text","data":"Run the shell command `echo kiro-probe` and then reply DONE."}],"meta":{"timestamp":1790509942}}}"#;
    const ASK_TOOL: &str = r#"{"version":"v1","kind":"AssistantMessage","data":{"message_id":"a1","content":[{"kind":"thinking","data":{"text":"","redactedContent":[46,75],"modelId":"auto","toolsDigest":"f1"}},{"kind":"text","data":""},{"kind":"toolUse","data":{"toolUseId":"tooluse_1","name":"shell","input":{"__tool_use_purpose":"Run the requested echo command.","command":"echo kiro-probe"}}}]}}"#;
    const DENIED: &str = r#"{"version":"v1","kind":"ToolResults","data":{"message_id":"r1","content":[{"kind":"toolResult","data":{"toolUseId":"tooluse_1","content":[{"kind":"text","data":"User denied tool execution"}],"status":"error"}}],"results":{}}}"#;
    const DONE: &str = r#"{"version":"v1","kind":"AssistantMessage","data":{"message_id":"a2","content":[{"kind":"thinking","data":{"text":"","redactedContent":[46],"modelId":"auto","toolsDigest":"f1"}},{"kind":"text","data":"DONE"}]}}"#;
    const PROMPT_2: &str = r#"{"version":"v1","kind":"Prompt","data":{"message_id":"p2","content":[{"kind":"text","data":"Reply with exactly: OK2"}],"meta":{"timestamp":1790510069}}}"#;
    const OK2: &str = r#"{"version":"v1","kind":"AssistantMessage","data":{"message_id":"a3","content":[{"kind":"thinking","data":{"text":"Short answer.","signature":"sig","redactedContent":[],"modelId":"claude-opus-5.5","toolsDigest":"f1"}},{"kind":"text","data":"OK2"}]}}"#;
    const CLEAR: &str = r#"{"version":"v1","kind":"Clear","data":{}}"#;
    const COMPACTION: &str = r###"{"version":"v1","kind":"Compaction","data":{"summary":"## OBJECTIVE\nEcho a probe string.","strategy":{"message_pairs_to_exclude":2},"messages_snapshot":[]}}"###;

    fn meta_json(title: Option<&str>) -> String {
        serde_json::json!({
            "session_id": SID,
            "cwd": "/tmp/kprobe/cwd",
            "created_at": "2026-09-27T11:52:15.670458Z",
            "updated_at": "2026-09-27T11:54:29.957575Z",
            "title": title,
            "session_created_reason": "subagent",
            "session_state": {
                "version": "v1",
                "conversation_metadata": {
                    "user_turn_metadatas": [
                        {
                            "message_ids": ["p1", "a1", "r1", "a2"],
                            "end_reason": "UserTurnEnd",
                            "end_timestamp": "2026-09-27T11:52:26.709231Z",
                            "input_token_count": 0,
                            "model": "auto"
                        },
                        {
                            "message_ids": ["p2", "a3"],
                            "end_reason": "UserTurnEnd",
                            "end_timestamp": "2026-09-27T11:54:34Z",
                            "model": "claude-opus-5.5"
                        }
                    ],
                    "last_context_usage": {"percentage": 10.0, "model_id": "claude-opus-5.5"}
                },
                "rts_model_state": {
                    "model_info": {"model_id": "claude-opus-5.5", "context_window_tokens": 1000000},
                    "context_usage_percentage": 10.0
                }
            }
        })
        .to_string()
    }

    fn write_session(dir: &Path, id: &str, lines: &[&str], meta: Option<&str>) {
        std::fs::write(dir.join(format!("{id}.jsonl")), lines.join("\n") + "\n").unwrap();
        if let Some(meta) = meta {
            std::fs::write(dir.join(format!("{id}.json")), meta).unwrap();
        }
    }

    fn texts(turn: &crate::models::MessageTurn) -> Vec<String> {
        turn.blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn home_dir_honours_kiro_home_verbatim() {
        assert_eq!(
            resolve_kiro_home_dir_from(Some("/opt/kiro".into()), Some("/home/u".into())),
            PathBuf::from("/opt/kiro")
        );
        assert_eq!(
            resolve_kiro_home_dir_from(Some("".into()), Some("/home/u".into())),
            PathBuf::from("/home/u/.kiro")
        );
        assert_eq!(
            resolve_kiro_home_dir_from(None, Some("/home/u".into())),
            PathBuf::from("/home/u/.kiro")
        );
    }

    #[test]
    fn summary_reads_metadata_and_log() {
        let tmp = tempfile::tempdir().unwrap();
        let meta = meta_json(Some("Run the shell command"));
        write_session(
            tmp.path(),
            SID,
            &[PROMPT_1, ASK_TOOL, DENIED, DONE, PROMPT_2, OK2],
            Some(&meta),
        );

        let list = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .list_conversations()
            .unwrap();
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.id, SID);
        assert_eq!(s.agent_type, AgentType::Kiro);
        assert_eq!(s.title.as_deref(), Some("Run the shell command"));
        assert_eq!(s.folder_path.as_deref(), Some("/tmp/kprobe/cwd"));
        assert_eq!(s.folder_name.as_deref(), Some("cwd"));
        assert_eq!(s.model.as_deref(), Some("claude-opus-5.5"));
        // 2 prompts + 3 answers; the tool result folds into its answer.
        assert_eq!(s.message_count, 5);
        assert_eq!(s.started_at.timestamp(), 1_790_509_942);
        assert_eq!(
            s.ended_at.map(|t| t.to_rfc3339()),
            Some("2026-09-27T11:54:34+00:00".to_string())
        );
    }

    #[test]
    fn title_falls_back_to_the_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), SID, &[PROMPT_2, OK2], Some(&meta_json(None)));
        let list = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .list_conversations()
            .unwrap();
        assert_eq!(list[0].title.as_deref(), Some("Reply with exactly: OK2"));
    }

    // `kiro-cli acp` writes both files the moment a session opens; one that
    // never got a prompt has an empty log and must not become a row.
    #[test]
    fn sessions_without_content_stay_unlisted() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("empty.jsonl"), "").unwrap();
        std::fs::write(tmp.path().join("empty.json"), meta_json(None)).unwrap();
        // Metadata alone (no log) is not a session either.
        std::fs::write(tmp.path().join("orphan.json"), meta_json(Some("x"))).unwrap();
        let list = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .list_conversations()
            .unwrap();
        assert!(list.is_empty());
    }

    #[test]
    fn detail_pairs_tool_results_and_times_turns() {
        let tmp = tempfile::tempdir().unwrap();
        let meta = meta_json(None);
        write_session(
            tmp.path(),
            SID,
            &[PROMPT_1, ASK_TOOL, DENIED, DONE, PROMPT_2, OK2],
            Some(&meta),
        );
        let detail = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .get_conversation(SID)
            .unwrap();
        assert_eq!(
            detail.transcript_watermark,
            Some(
                std::fs::metadata(tmp.path().join(format!("{SID}.jsonl")))
                    .unwrap()
                    .len()
            )
        );

        let roles: Vec<_> = detail
            .turns
            .iter()
            .map(|t| match t.role {
                TurnRole::User => "user",
                TurnRole::Assistant => "assistant",
                TurnRole::System => "system",
            })
            .collect();
        assert_eq!(
            roles,
            ["user", "assistant", "assistant", "user", "assistant"]
        );

        // The tool call and its (denied) result land in the same turn, and the
        // empty text + redacted thinking in front of the call are dropped.
        let ask = &detail.turns[1];
        assert_eq!(ask.blocks.len(), 2, "{:?}", ask.blocks);
        match &ask.blocks[0] {
            ContentBlock::ToolUse {
                tool_use_id,
                tool_name,
                input_preview,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("tooluse_1"));
                // Kiro's `shell`, in the terminal card's name and shape.
                assert_eq!(tool_name, "bash");
                let input: Value = serde_json::from_str(input_preview.as_deref().unwrap()).unwrap();
                assert_eq!(
                    input,
                    serde_json::json!({
                        "command": "echo kiro-probe",
                        "description": "Run the requested echo command."
                    })
                );
            }
            other => panic!("expected tool use, got {other:?}"),
        }
        match &ask.blocks[1] {
            ContentBlock::ToolResult {
                tool_use_id,
                output_preview,
                is_error,
                ..
            } => {
                assert_eq!(tool_use_id.as_deref(), Some("tooluse_1"));
                assert_eq!(
                    output_preview.as_deref(),
                    Some("User denied tool execution")
                );
                assert!(is_error);
            }
            other => panic!("expected tool result, got {other:?}"),
        }
        assert_eq!(texts(&detail.turns[2]), ["DONE"]);
        // The turn's END is the metadata's `end_timestamp`, placed on the
        // turn's last message only, so the whole span lands on the answer.
        // Prompt at 11:52:22 (epoch 1790509942), turn end 11:52:26.709231.
        assert_eq!(detail.turns[2].duration_ms, Some(4_709));
        assert!(detail.turns[1].duration_ms.is_none());

        // Real thinking text survives, and names the model.
        let answer = &detail.turns[4];
        assert!(answer
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Thinking { text } if text == "Short answer.")));
        assert_eq!(answer.model.as_deref(), Some("claude-opus-5.5"));

        let stats = detail.session_stats.expect("stats");
        assert_eq!(stats.context_window_max_tokens, Some(1_000_000));
        assert_eq!(stats.context_window_used_tokens, Some(100_000));
        assert_eq!(stats.context_window_usage_percent, Some(10.0));
    }

    /// Tool uses and results as kiro-cli 2.24.1 logs them (trimmed from a
    /// real session), one per built-in tool shape the cards care about.
    #[test]
    fn builtin_tools_take_the_names_and_shapes_their_cards_read() {
        let uses = r#"{"version":"v1","kind":"AssistantMessage","data":{"message_id":"a1","content":[
            {"kind":"toolUse","data":{"toolUseId":"w1","name":"write","input":{"__tool_use_purpose":"Fix","command":"strReplace","path":"/w/a.txt","oldStr":"line two","newStr":"line 2"}}},
            {"kind":"toolUse","data":{"toolUseId":"w2","name":"write","input":{"__tool_use_purpose":"New","command":"create","path":"/w/b.txt","content":"hello"}}},
            {"kind":"toolUse","data":{"toolUseId":"w3","name":"write","input":{"__tool_use_purpose":"Top","command":"insert","path":"/w/a.txt","content":"line zero","insertLine":0}}},
            {"kind":"toolUse","data":{"toolUseId":"r1","name":"read","input":{"__tool_use_purpose":"Look","operations":[{"mode":"Line","path":"/w/a.txt","offset":1}]}}},
            {"kind":"toolUse","data":{"toolUseId":"s1","name":"shell","input":{"__tool_use_purpose":"Fail","command":"echo hi >&2; exit 3"}}},
            {"kind":"toolUse","data":{"toolUseId":"m1","name":"get_session_info","input":{"__tool_use_purpose":"Look up","session_id":7}}}
        ]}}"#.replace('\n', "");
        let results = r#"{"version":"v1","kind":"ToolResults","data":{"message_id":"r1","content":[
            {"kind":"toolResult","data":{"toolUseId":"r1","content":[{"kind":"text","data":"line 2"}],"status":"success"}},
            {"kind":"toolResult","data":{"toolUseId":"s1","content":[{"kind":"json","data":{"exit_status":"exit status: 3","stdout":"","stderr":"hi\n"}}],"status":"success"}},
            {"kind":"toolResult","data":{"toolUseId":"m1","content":[{"kind":"json","data":{"content":[{"type":"text","text":"{\"found\":false}"}]}}],"status":"success"}}
        ],"results":{}}}"#.replace('\n', "");
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            SID,
            &[PROMPT_1, &uses, &results],
            Some(&meta_json(None)),
        );
        let detail = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .get_conversation(SID)
            .unwrap();
        let blocks: Vec<&ContentBlock> = detail.turns.iter().flat_map(|t| &t.blocks).collect();
        let uses: Vec<(&str, Value)> = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } => Some((
                    tool_name.as_str(),
                    serde_json::from_str(input_preview.as_deref().unwrap()).unwrap(),
                )),
                _ => None,
            })
            .collect();
        assert_eq!(
            uses,
            [
                (
                    "edit",
                    serde_json::json!({"file_path": "/w/a.txt", "old_string": "line two", "new_string": "line 2", "description": "Fix"})
                ),
                (
                    "write",
                    serde_json::json!({"file_path": "/w/b.txt", "content": "hello", "description": "New"})
                ),
                (
                    "edit",
                    serde_json::json!({"file_path": "/w/a.txt", "old_string": "", "new_string": "line zero", "_start_line": 1, "description": "Top"})
                ),
                (
                    "read",
                    serde_json::json!({"file_path": "/w/a.txt", "offset": 2, "description": "Look"})
                ),
                (
                    "bash",
                    serde_json::json!({"command": "echo hi >&2; exit 3", "description": "Fail"})
                ),
                // An MCP tool keeps its bare name and its own arguments.
                (
                    "get_session_info",
                    serde_json::json!({"__tool_use_purpose": "Look up", "session_id": 7})
                ),
            ]
        );
        let outputs: Vec<&str> = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => output_preview.as_deref(),
                _ => None,
            })
            .collect();
        assert_eq!(
            outputs,
            [
                // Numbered from line 2, where the read started.
                r#"{"start_line":2,"content":"line 2"}"#,
                "hi\nexit status: 3",
                r#"{"found":false}"#,
            ]
        );
    }

    #[test]
    fn canonical_tool_leaves_what_it_does_not_know_alone() {
        // Several targets in one read: no single card shows them.
        let multi = serde_json::json!({"operations": [
            {"mode": "Line", "path": "/a"}, {"mode": "Line", "path": "/b"}
        ]});
        assert_eq!(canonical_tool("read", &multi), None);
        assert_eq!(
            canonical_tool(
                "write",
                &serde_json::json!({"command": "append", "path": "/a"})
            ),
            None
        );
        assert_eq!(
            canonical_tool("use_aws", &serde_json::json!({"service_name": "s3"})),
            None
        );
        let dir =
            serde_json::json!({"operations": [{"mode": "Directory", "path": "/w", "depth": 1}]});
        assert_eq!(
            canonical_tool("read", &dir).map(|t| (t.name, t.input)),
            Some(("ls", serde_json::json!({"path": "/w", "depth": 1})))
        );
        let glob =
            serde_json::json!({"__tool_use_purpose": "Find", "pattern": "*.txt", "path": "/w"});
        assert_eq!(
            canonical_tool("glob", &glob).map(|t| (t.name, t.input)),
            Some((
                "glob",
                serde_json::json!({"pattern": "*.txt", "path": "/w", "description": "Find"})
            ))
        );
    }

    #[test]
    fn a_tool_is_told_from_its_arguments_where_no_name_rides_along() {
        let name = |v: Value| tool_name_from_input(&v);
        assert_eq!(
            name(serde_json::json!({"command": "create", "path": "/a", "content": "x"})),
            Some("write")
        );
        assert_eq!(
            name(serde_json::json!({"command": "strReplace", "path": "/a"})),
            Some("write")
        );
        assert_eq!(name(serde_json::json!({"operations": []})), Some("read"));
        assert_eq!(name(serde_json::json!({"command": "ls"})), Some("shell"));
        // A `path` beside an unknown command is not a shell call either.
        assert_eq!(
            name(serde_json::json!({"command": "ls", "path": "/a"})),
            None
        );
        assert_eq!(name(serde_json::json!({"query": "x"})), None);
    }

    #[test]
    fn clear_and_compaction_render_as_markers() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            SID,
            &[PROMPT_1, DONE, COMPACTION, CLEAR, PROMPT_2, OK2],
            Some(&meta_json(None)),
        );
        let detail = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .get_conversation(SID)
            .unwrap();
        let system = detail
            .turns
            .iter()
            .find(|t| matches!(t.role, TurnRole::System))
            .expect("compaction summary turn");
        assert!(texts(system)[0].contains("OBJECTIVE"));
        assert!(detail
            .turns
            .iter()
            .any(|t| matches!(t.role, TurnRole::User) && texts(t) == ["/clear"]));
        // Nothing before the clear disappears.
        assert!(detail.turns.iter().any(|t| texts(t) == ["DONE"]));
    }

    #[test]
    fn a_cancelled_turn_keeps_its_interruption_notice() {
        let tmp = tempfile::tempdir().unwrap();
        let interrupted = r#"{"version":"v1","kind":"AssistantMessage","data":{"message_id":"ax","content":[{"kind":"text","data":"Response was interrupted by the user"}]}}"#;
        let meta = serde_json::json!({
            "cwd": "/w",
            "created_at": "2026-09-27T11:52:00Z",
            "session_state": {"conversation_metadata": {"user_turn_metadatas": [
                {"message_ids": ["p1", null], "end_reason": "Cancelled", "end_timestamp": "2026-09-27T11:52:30Z"}
            ]}}
        })
        .to_string();
        write_session(tmp.path(), SID, &[PROMPT_1, interrupted], Some(&meta));
        let detail = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .get_conversation(SID)
            .unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(
            texts(&detail.turns[1]),
            ["Response was interrupted by the user"]
        );
    }

    #[test]
    fn images_decode_from_byte_arrays() {
        let image = image_data(&serde_json::json!({
            "format": "png",
            "source": {"kind": "bytes", "data": [137, 80, 78, 71]}
        }))
        .unwrap();
        assert_eq!(image.mime_type, "image/png");
        assert_eq!(image.data, "iVBORw==");
        let jpg = image_data(&serde_json::json!({
            "format": "jpg",
            "source": {"kind": "bytes", "data": [255]}
        }))
        .unwrap();
        assert_eq!(jpg.mime_type, "image/jpeg");
        // A byte out of range is corrupt data, not an image.
        assert!(image_data(&serde_json::json!({
            "format": "png",
            "source": {"kind": "bytes", "data": [256]}
        }))
        .is_none());
    }

    #[test]
    fn a_half_written_tail_and_unknown_kinds_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let reset = r#"{"version":"v1","kind":"ResetTo","data":{"target_index":1}}"#;
        std::fs::write(
            tmp.path().join(format!("{SID}.jsonl")),
            format!("{PROMPT_2}\n{reset}\n{OK2}\n{{\"version\":\"v1\",\"kind\":\"Assis"),
        )
        .unwrap();
        let detail = KiroParser::with_base_dir(tmp.path().to_path_buf())
            .get_conversation(SID)
            .unwrap();
        assert_eq!(detail.turns.len(), 2);
    }

    #[test]
    fn unsafe_ids_are_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let parser = KiroParser::with_base_dir(tmp.path().to_path_buf());
        for id in ["../escape", "a/b", ""] {
            assert!(matches!(
                parser.get_conversation(id),
                Err(ParseError::ConversationNotFound(_))
            ));
        }
    }
}
