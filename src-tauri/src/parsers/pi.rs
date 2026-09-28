use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, ImageData, MessageRole,
    MessageTurn, TurnRole, TurnUsage, UnifiedMessage,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, latest_turn_total_usage_tokens, merge_context_window_stats,
    relocate_orphaned_tool_results, resolve_patch_line_numbers, structurize_read_tool_output,
    title_from_user_text, truncate_str, AgentParser, ParseError,
};

/// Resolve the `pi` coding agent's sessions directory, honoring (highest
/// precedence first):
///   1. `PI_CODING_AGENT_SESSION_DIR` — the sessions dir directly;
///   2. `<agent dir>/settings.json` → `"sessionDir"`, when it is ABSOLUTE
///      (see [`session_dir_from_settings`] for why only then);
///   3. `<agent dir>/sessions`.
///
/// `<agent dir>` is `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. Both env values go
/// through pi's tilde rule ([`expand_pi_tilde`]), because pi reads them through
/// `expandTildePath`.
///
/// That is pi's own documented order minus its `--session-dir` flag, which codeg
/// never passes (`docs/settings.md`: "precedence is `--session-dir`,
/// `PI_CODING_AGENT_SESSION_DIR`, then `sessionDir` in settings.json"). The
/// settings layer is not optional garnish: pi-acp reads it too
/// (`getPiSessionsDir` → `readSessionDirFromSettings`), so a user who sets
/// `sessionDir` and is missing this layer gets a pi that resumes fine while
/// codeg's history list stays permanently empty.
///
/// Mirrors the `resolve_*`/`resolve_*_from` split of `parsers::kimi_code` so the
/// environment lookup is a pure function over its inputs (testable without
/// touching the process environment). The parser's `base_dir` IS this sessions
/// directory; it is walked recursively, which covers both layouts — the default
/// `--<dashed-cwd>--/` buckets and the FLAT directory a custom `sessionDir`
/// produces (pi uses the configured path verbatim, with no per-cwd bucket).
pub(crate) fn resolve_pi_sessions_dir() -> PathBuf {
    resolve_pi_sessions_dir_from(
        std::env::var_os("PI_CODING_AGENT_SESSION_DIR"),
        std::env::var_os("PI_CODING_AGENT_DIR"),
        dirs::home_dir(),
    )
}

/// Pi's agent directory: `PI_CODING_AGENT_DIR` (through pi's tilde rule), else
/// `~/.pi/agent`. The same rule [`resolve_pi_sessions_dir_from`] applies before
/// it looks for `sessions`, kept in one place so the two can't drift.
fn resolve_pi_agent_dir_from(agent_dir_env: Option<OsString>, home_dir: Option<&Path>) -> PathBuf {
    match agent_dir_env
        .filter(|value| !value.is_empty())
        .and_then(|value| value.into_string().ok())
    {
        Some(dir) => expand_pi_tilde(&dir, home_dir),
        None => home_dir
            .map(Path::to_path_buf)
            .unwrap_or_default()
            .join(".pi")
            .join("agent"),
    }
}

fn resolve_pi_agent_dir() -> PathBuf {
    resolve_pi_agent_dir_from(
        std::env::var_os("PI_CODING_AGENT_DIR"),
        dirs::home_dir().as_deref(),
    )
}

/// What pi gives a `models.json` model that declares no `contextWindow`:
/// `provider-composer.js`'s `modelFromJson` ends with
/// `contextWindow: definition.contextWindow ?? 128000`. The entry REPLACES any
/// built-in model of the same id (`applyModelsJson` upserts by id and only
/// borrows `api`/`baseUrl` from the one it replaces), so 128K is what pi runs
/// with — not the built-in catalog's number, and not codeg's name table's.
const PI_DEFAULT_MODEL_CONTEXT_WINDOW: u64 = 128_000;

/// The context window `<agent_dir>/models.json` settles on for a model.
///
/// Why this is needed: `infer_context_window_max_tokens` guesses from a table of
/// known model names — Claude / Gemini / Gemma / Kimi / Grok / OpenAI — and
/// returns `None` for anything else. Model ids served by a self-hosted
/// OpenAI-compatible endpoint land on `None` (no context meter at all) or, when
/// the id merely LOOKS familiar — a proxy answering to `gpt-5.5` — on a
/// confident number the guess cannot actually know.
///
/// Pi records the real window per provider, which beats guessing by name and
/// keeps working when the model changes. Any read failure (file absent, bad
/// JSON, model not listed) yields `None` and falls back to the existing
/// name-based guess, so behaviour is never worse than before.
///
/// Takes the directory rather than resolving it, mirroring
/// `grok::grok_catalog_context_window(home, model)`: the lookup stays a function
/// of its inputs, so a test drives it from a fixture instead of whatever
/// `models.json` the machine running the suite happens to have.
pub(crate) fn pi_declared_context_window(
    agent_dir: &Path,
    provider: Option<&str>,
    model: Option<&str>,
) -> Option<u64> {
    let model = model?.trim();
    if model.is_empty() {
        return None;
    }
    let raw = fs::read_to_string(agent_dir.join("models.json")).ok()?;
    pi_declared_context_window_from(&raw, provider, model)
}

/// Pure over the file contents so it can be tested without touching the disk.
///
/// pi keys a model by `(provider, id)`, and the transcript records both, so the
/// session's own provider decides which entry applies — a provider this file
/// does not define is a BUILT-IN one, whose catalogue lives inside pi rather
/// than on disk, and correctly yields `None`. Only a session that recorded no
/// provider at all scans every provider, and then only an unambiguous answer
/// counts: two providers disagreeing about the same id is exactly the case
/// where picking one would be a guess wearing a declaration's clothes.
fn pi_declared_context_window_from(raw: &str, provider: Option<&str>, model: &str) -> Option<u64> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let providers = value.get("providers")?.as_object()?;

    if let Some(provider) = provider.map(str::trim).filter(|p| !p.is_empty()) {
        return provider_declared_context_window(providers.get(provider)?, model);
    }

    let mut agreed: Option<u64> = None;
    for config in providers.values() {
        let Some(window) = provider_declared_context_window(config, model) else {
            continue;
        };
        if agreed.is_some_and(|previous| previous != window) {
            return None;
        }
        agreed = Some(window);
    }
    agreed
}

/// One provider's answer for `model`, in pi's own layering order.
fn provider_declared_context_window(config: &Value, model: &str) -> Option<u64> {
    // `modelOverrides` is the topmost layer pi applies ("they apply once, after
    // custom-model upserts, extension model replacement, and legacy OAuth
    // projection"), and it patches rather than replaces: an override without a
    // `contextWindow` leaves the layer below in charge.
    let overridden = config
        .get("modelOverrides")
        .and_then(Value::as_object)
        .and_then(|overrides| overrides.get(model))
        .and_then(|entry| entry.get("contextWindow"))
        .and_then(Value::as_u64)
        .filter(|window| *window > 0);
    if overridden.is_some() {
        return overridden;
    }

    // Last declaration wins: `applyModelsJson` walks `models` in order and
    // upserts by id (`models[existingIndex] = model`), so a repeated id ends up
    // holding the LAST entry's fields.
    let declared = config
        .get("models")
        .and_then(Value::as_array)?
        .iter()
        .rev()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(model))?;
    match declared.get("contextWindow") {
        // Absent is not unknown — it is pi's `?? 128000`.
        None | Some(Value::Null) => Some(PI_DEFAULT_MODEL_CONTEXT_WINDOW),
        // A window pi itself rejects (`invalid contextWindow` for `<= 0`), or
        // one that is not a number at all, is not a declaration to honor.
        Some(window) => window.as_u64().filter(|window| *window > 0),
    }
}

fn resolve_pi_sessions_dir_from(
    session_dir_env: Option<OsString>,
    agent_dir_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    if let Some(session_dir) = session_dir_env
        .filter(|value| !value.is_empty())
        .and_then(|value| value.into_string().ok())
    {
        return expand_pi_tilde(&session_dir, home_dir.as_deref());
    }
    let agent_dir = resolve_pi_agent_dir_from(agent_dir_env, home_dir.as_deref());
    session_dir_from_settings(&agent_dir, home_dir.as_deref())
        .unwrap_or_else(|| agent_dir.join("sessions"))
}

/// pi's `normalizePath` tilde rule, exactly: a bare `~` is the home dir and a
/// `~/…` (or `~\…` on Windows) prefix is joined onto it. Anything else — notably
/// `~other/path` — is NOT a tilde path to pi and is returned verbatim.
///
/// Applied to `PI_CODING_AGENT_SESSION_DIR` and `PI_CODING_AGENT_DIR` because pi
/// runs both through `expandTildePath`, which IS `normalizePath`.
fn expand_pi_tilde(value: &str, home_dir: Option<&Path>) -> PathBuf {
    let Some(home) = home_dir else {
        return PathBuf::from(value);
    };
    if value == "~" {
        return home.to_path_buf();
    }
    let rest = value
        .strip_prefix("~/")
        .or_else(|| cfg!(windows).then(|| value.strip_prefix("~\\")).flatten());
    match rest {
        Some(rest) => home.join(rest),
        None => PathBuf::from(value),
    }
}

/// `<agent_dir>/settings.json` → `"sessionDir"`, but ONLY when it resolves to an
/// absolute path.
///
/// pi's `SettingsManager.getSessionDir()` is `normalizePath(sessionDir)`, which
/// expands `~` and otherwise returns the string UNCHANGED — it does not make a
/// relative path absolute. The path is then used by the pi process, whose cwd
/// pi-acp sets to the ACP session's WORKSPACE (`PiRpcProcess.spawn`'s
/// `cwd: params.cwd`). So the value pi's own docs use as their example,
/// `{"sessionDir": ".pi/sessions"}`, writes to `<workspace>/.pi/sessions` — a
/// different directory per workspace, and not one this parser can name: it
/// resolves a single sessions root with no workspace in hand.
///
/// Guessing is worse than declining. Resolving a relative value against the agent
/// dir (which is what pi-acp's own discovery helper does) would point codeg at a
/// directory nobody writes to AND would shadow the default — costing the user the
/// history pi wrote to `<agent_dir>/sessions` before they ever set the option.
/// Falling through keeps that history listed.
///
/// Also not visible here: pi deep-merges a TRUSTED project's
/// `<cwd>/.pi/settings.json` over the global one, so a project can override
/// `sessionDir` too. Same reason, same answer — no cwd, no resolution.
///
/// `None` for a missing / unreadable / non-object file, for an absent, empty or
/// non-string `sessionDir`, and for any value that is not absolute after tilde
/// expansion — so every uncertainty falls through to the default. "Not absolute"
/// is the HOST's grammar, which on Windows also covers a drive-relative `\srv\x`
/// / `/srv/x` (root, no drive prefix): that resolves against whatever drive the
/// pi process's cwd sits on, and that cwd is again the per-session workspace.
fn session_dir_from_settings(agent_dir: &Path, home_dir: Option<&Path>) -> Option<PathBuf> {
    let raw = fs::read_to_string(agent_dir.join("settings.json")).ok()?;
    let settings: Value = serde_json::from_str(&raw).ok()?;
    let configured = settings
        .get("sessionDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let expanded = expand_pi_tilde(configured, home_dir);
    expanded.is_absolute().then_some(expanded)
}

/// `pi` (pi.dev) stores its transcripts as **one JSONL file per session** under
/// a working-directory bucket — Claude Code's / CodeBuddy's archetype:
///
/// ```text
/// <base_dir>/                         (default ~/.pi/agent/sessions)
/// └── --<cwd-with-'/'-replaced-by-'-'>--/
///     └── <timestamp>_<uuid>.jsonl     # one session, JSONL
/// ```
///
/// The dashed directory name is a one-way encoding of the working directory, so
/// the real `cwd` is read from the session's HEADER line — never reverse-decoded
/// from the directory name.
///
/// Line 1 is the header
/// (`{"type":"session","version":3,"id":…,"timestamp":…,"cwd":…}`); its `id` is
/// the stable external conversation id. Every other line shares `type` / `id` /
/// `parentId` / `timestamp` and is one of:
///
/// - `message` — a nested `message` object keyed by `role`:
///   - `user`: `content` is a STRING or an ARRAY of `text` / `image` blocks,
///   - `assistant`: `content` is an ARRAY of `{type:"text"|"thinking"|"toolCall"}`
///     blocks, plus `provider` / `model` / `usage` / `stopReason` /
///     `errorMessage`. NOTE the thinking block spells its payload `thinking`,
///     NOT `text` (`docs/session-format.md`; same as `parsers::openclaw`),
///   - `toolResult`: `toolCallId` / `toolName` / `content` / `details` /
///     `isError`, where `content` is an ARRAY of MCP-shaped blocks
///     (`[{"type":"text","text":…}]`, plus `image` blocks for a `read` of a
///     picture) for every tool — bash, read, write alike (see
///     `tool_result_content_text`).
/// - `bashExecution` — a `command` + `output` + `exitCode` triple (plus
///   `cancelled` / `truncated` / `fullOutputPath`), surfaced as a synthetic
///   `bash` tool use + result.
/// - `usage` — `{input,output,cacheRead,cacheWrite,totalTokens,cost}` per step.
/// - `model_change` — `{provider,modelId}`; tracks the latest model.
/// - `session_info` — `{name}`; the session's display name (preferred title).
///   The LAST one wins, matching pi's own `getSessionName()`, so a `/name`
///   rename is what shows.
/// - `compaction` / `branch_summary` / `custom_message` — conversation artifacts
///   pi's own TUI renders; surfaced as a compaction divider / system messages.
/// - `thinking_level_change` / `label` / `custom` / … — metadata that is
///   skipped; an unknown line NEVER errors.
///
/// # The file is a TREE, not a log
///
/// Entries link by `id` / `parentId`, and pi branches IN PLACE (`/tree`,
/// re-asking after a rewind) rather than opening a new file — so a session that
/// has ever branched holds records that are NOT part of the conversation pi
/// itself shows. pi resolves the live conversation as `buildSessionPath()`:
/// `_buildIndex()` walks the file assigning `leafId = entry.id` for every
/// non-header entry (so the leaf is the LAST one), then the path is the walk
/// from that leaf up through `parentId` to the root, reversed. This parser does
/// exactly that (see [`active_branch`]); reading the file linearly instead used
/// to splice abandoned branches into the transcript.
///
/// Unknown / malformed lines are skipped (`continue`) so a forward-compatible or
/// partially-written log is read robustly rather than panicking.
pub struct PiParser {
    base_dir: PathBuf,
    /// Where `models.json` lives. Resolved separately from `base_dir` because a
    /// custom `sessionDir` moves the sessions OUT of the agent dir, so the one
    /// cannot be derived from the other.
    agent_dir: PathBuf,
}

impl PiParser {
    pub fn new() -> Self {
        Self {
            base_dir: resolve_pi_sessions_dir(),
            agent_dir: resolve_pi_agent_dir(),
        }
    }

    /// Construct a parser pointed at an explicit `sessions` directory (test
    /// fixtures). The agent dir is taken to be its parent — pi's default
    /// `<agent dir>/sessions` layout — so a fixture can place `models.json`
    /// next to the sessions folder and nothing reaches the real `~/.pi`.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        let agent_dir = base_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| base_dir.clone());
        Self {
            base_dir,
            agent_dir,
        }
    }

    fn parse_summary(&self, path: &Path) -> Option<ConversationSummary> {
        let parsed = parse_session(path);
        // A file with no header AND no content events is treated as empty.
        let started_at = parsed.first_ts?;
        if parsed.content_events == 0 {
            return None;
        }

        let id = parsed.session_id.unwrap_or_else(|| fallback_id(path));
        let folder_name = parsed.cwd.as_deref().map(folder_name_from_path);

        Some(ConversationSummary {
            id,
            agent_type: AgentType::Pi,
            folder_path: parsed.cwd,
            folder_name,
            title: resolve_title(parsed.session_name, parsed.first_user_text),
            started_at,
            ended_at: parsed.last_ts,
            message_count: parsed.message_count,
            model: parsed.model,
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
        let parsed = parse_session(path);

        let mut turns = group_into_turns(parsed.messages);
        relocate_orphaned_tool_results(&mut turns);
        structurize_read_tool_output(&mut turns);
        resolve_patch_line_numbers(&mut turns, parsed.cwd.as_deref());
        backfill_turn_durations(&mut turns, &[]);

        let used_tokens = latest_turn_total_usage_tokens(&turns);
        // Ask Pi what the provider declared first; only then guess by name.
        // Self-hosted model ids are absent from the built-in table, so guessing
        // alone drops the context meter entirely.
        let max_tokens = pi_declared_context_window(
            &self.agent_dir,
            parsed.provider.as_deref(),
            parsed.model.as_deref(),
        )
        .or_else(|| infer_context_window_max_tokens(parsed.model.as_deref()));
        let session_stats =
            merge_context_window_stats(compute_session_stats(&turns), used_tokens, max_tokens);

        let folder_name = parsed.cwd.as_deref().map(folder_name_from_path);
        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Pi,
            folder_path: parsed.cwd,
            folder_name,
            title: resolve_title(parsed.session_name, parsed.first_user_text),
            started_at: parsed.first_ts.unwrap_or_else(Utc::now),
            ended_at: parsed.last_ts,
            message_count: parsed.message_count,
            model: parsed.model,
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

impl Default for PiParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for PiParser {
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
            if let Ok(Some(summary)) =
                super::summary_cache::get_or_parse(AgentType::Pi, path, || {
                    Ok(self.parse_summary(path))
                })
            {
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
                // Match by the header `id` (the stable external id); fall back to
                // the filename uuid when a malformed file has no header.
                if session_id_of(path).as_deref() == Some(conversation_id) {
                    return self.parse_detail(path, conversation_id);
                }
            }
        }

        Err(ParseError::ConversationNotFound(
            conversation_id.to_string(),
        ))
    }
}

/// The accumulated result of scanning one session `.jsonl`.
#[derive(Default)]
struct SessionParse {
    messages: Vec<UnifiedMessage>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    /// Header `id` (the stable external id; `None` when the header is missing).
    session_id: Option<String>,
    /// Header `cwd`.
    cwd: Option<String>,
    /// `session_info.name` — the preferred display title.
    session_name: Option<String>,
    /// First user prompt, already truncated for use as a fallback title.
    first_user_text: Option<String>,
    /// Latest model from an assistant message's `model` or a `model_change`.
    model: Option<String>,
    /// The provider named alongside that model, always written with it so the
    /// pair can never be mixed across a switch. pi identifies a model by
    /// `(provider, id)` — see [`pi_declared_context_window`].
    provider: Option<String>,
    /// User + assistant turns (tool calls/results and thinking excluded), the
    /// list-view activity count.
    message_count: u32,
    /// Number of content-bearing records — decides whether the session is listed.
    content_events: u32,
}

/// One parsed line of a session file, kept with its original line index so the
/// synthetic message ids stay stable across parses even when tree filtering
/// removes records in between.
struct SessionRecord {
    value: Value,
    line_idx: usize,
}

/// Parse a `pi` session `.jsonl` into a flat, chronologically-ordered list of
/// `UnifiedMessage`s plus session metadata, covering only the ACTIVE branch (see
/// the type docs). Unknown / malformed lines are skipped so a forward-compatible
/// or partially-written log never panics.
fn parse_session(path: &Path) -> SessionParse {
    let mut sp = SessionParse::default();
    let Ok(file) = fs::File::open(path) else {
        return sp;
    };

    // Pass 1 — read every line, splitting the header off the tree. `entries`
    // mirrors pi's `_buildIndex`, which skips EVERY `type:"session"` record (not
    // just the first), so a header can never be picked as the leaf.
    let mut header: Option<Value> = None;
    let mut entries: Vec<SessionRecord> = Vec::new();
    for (line_idx, line) in BufReader::new(file).lines().enumerate() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if header.is_none() {
                header = Some(value);
            }
            continue;
        }
        entries.push(SessionRecord { value, line_idx });
    }

    // The header seeds the id / cwd / span before any entry extends it.
    if let Some(header) = &header {
        sp.session_id = string_field(header, "id");
        sp.cwd = string_field(header, "cwd");
        note_ts(&mut sp, record_iso_ts(header));
    }
    sp.session_name = session_name(&entries);

    // Pass 2 — replay the active branch in file order (which IS path order:
    // every entry on the path was appended after its parent).
    let active = active_branch(&entries);
    for (index, record) in entries.iter().enumerate() {
        if !keeps_record(active.as_ref(), index, record) {
            continue;
        }
        let value = &record.value;
        let idx = record.line_idx;
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = note_ts(&mut sp, record_iso_ts(value));

        match record_type {
            // `session_info` is resolved up front over ALL entries — see
            // `session_name` — not here, where the branch filter would hide it.
            "model_change" => {
                if let Some(model) = string_field(value, "modelId") {
                    sp.model = Some(model);
                    sp.provider = string_field(value, "provider");
                }
            }
            "message" => parse_message_record(&mut sp, value, ts, idx),
            "bashExecution" => parse_bash_execution(&mut sp, value, ts, idx),
            "compaction" => parse_compaction(&mut sp, value, ts, idx),
            "branch_summary" => parse_branch_summary(&mut sp, value, ts, idx),
            "custom_message" => parse_custom_message(&mut sp, value, ts, idx),
            // `usage`, `thinking_level_change`, `label`, `custom`, and any
            // unknown line: best-effort / skip.
            _ => {}
        }
    }

    sp
}

/// The session's display name, ported from pi's `getSessionName()`:
///
/// ```js
/// getSessionName(){let entries=this.getEntries();
///   for(let i=entries.length-1;i>=0;i--){let entry=entries[i];
///     if(entry.type==="session_info")return entry.name?.trim()||void 0}}
/// ```
///
/// Two details that a "last one wins while replaying" loop gets wrong, and which
/// are the reason this is its own pass:
///
///  - it scans `getEntries()` — every physical entry, header excluded — NOT the
///    active branch, so a `/name` issued on a since-abandoned branch still names
///    the session;
///  - it returns at the FIRST `session_info` it reaches, so a latest entry whose
///    name is empty clears the name rather than letting an older one resurface.
fn session_name(entries: &[SessionRecord]) -> Option<String> {
    entries
        .iter()
        .rev()
        .find(|record| record.value.get("type").and_then(Value::as_str) == Some("session_info"))
        .and_then(|record| string_field(&record.value, "name"))
}

/// A trimmed, non-empty string field, or `None`.
fn string_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

/// The indices of `entries` that lie on pi's active branch — its
/// `buildSessionPath()`, ported.
///
/// `None` means "keep every record in file order", and it is returned for three
/// separate reasons, all of them the same principle: the cost of a wrong `Some`
/// is a SILENTLY TRUNCATED conversation, so every uncertainty resolves towards
/// showing more.
///
///   1. no entry carries an `id` — a v1 linear session, which predates
///      `id`/`parentId` entirely;
///   2. the trailing entry carries no `id`, so there is no leaf to anchor on;
///   3. **the file contains no fork at all** ([`has_fork`]). Pruning is only ever
///      meant to drop an ABANDONED BRANCH, and a branch needs a parent with two
///      children. If no parent has two, a walk that fails to reach some entry has
///      hit a defective `parentId` chain, not a branch — and dropping records
///      over a defect is exactly the failure this guard exists to prevent. Real
///      pi always writes a complete chain (verified: every entry of every local
///      transcript carries `parentId`, and the walk covers 100% of them), so this
///      costs nothing on well-formed files and only ever engages on malformed
///      ones.
///
/// Duplicate ids resolve last-wins (pi's `byId.set`), and the walk carries a
/// visited set so a corrupted file that links a cycle terminates instead of
/// hanging.
fn active_branch(entries: &[SessionRecord]) -> Option<HashSet<usize>> {
    let mut by_id: HashMap<&str, usize> = HashMap::new();
    for (index, record) in entries.iter().enumerate() {
        if let Some(id) = entry_id(&record.value) {
            by_id.insert(id, index);
        }
    }
    if by_id.is_empty() {
        return None;
    }
    let leaf = entries.len().checked_sub(1)?;
    entry_id(&entries[leaf].value)?;

    let mut on_path: HashSet<usize> = HashSet::new();
    let mut current = Some(leaf);
    while let Some(index) = current {
        if !on_path.insert(index) {
            break;
        }
        current = parent_index(&entries[index].value, &by_id).filter(|&parent| parent != index);
    }
    if on_path.len() == entries.len() {
        // Nothing to prune; skip the fork scan entirely.
        return Some(on_path);
    }
    has_fork(entries, &by_id).then_some(on_path)
}

/// What an entry hangs off, for fork counting.
#[derive(PartialEq, Eq, Hash, Clone, Copy)]
enum ParentKey {
    /// An explicit `"parentId": null` — pi's virtual root. Two of these ARE
    /// siblings (see [`has_fork`]).
    Root,
    /// A `parentId` that resolves to another entry.
    Entry(usize),
}

/// What an entry hangs off, or `None` when the link tells us nothing: a
/// `parentId` that resolves to no entry (a dangling link — a defect, not a
/// fork), or a MISSING `parentId` key. Real pi always writes the key (verified
/// on every entry of every local transcript), so absence means the record did
/// not come from pi and must not be read as a root.
fn parent_key(value: &Value, by_id: &HashMap<&str, usize>) -> Option<ParentKey> {
    match value.get("parentId")? {
        Value::Null => Some(ParentKey::Root),
        Value::String(parent) if !parent.is_empty() => {
            by_id.get(parent.as_str()).copied().map(ParentKey::Entry)
        }
        _ => None,
    }
}

/// The index of an entry's parent, or `None` for a root / dangling link.
fn parent_index(value: &Value, by_id: &HashMap<&str, usize>) -> Option<usize> {
    match parent_key(value, by_id) {
        Some(ParentKey::Entry(index)) => Some(index),
        _ => None,
    }
}

/// Whether any parent has two or more children — the structural signature of a
/// branch, and the only thing that makes pruning meaningful.
///
/// **The virtual root counts.** Re-editing a user message in `/tree` branches
/// from `targetEntry.parentId`, and for the FIRST prompt that is `null`, so pi
/// calls `resetLeaf()` (or `branchWithSummary(null, …)`) and the replacement is
/// appended with `parentId: null` — a SECOND explicit root. Rewinding to the very
/// first question is an ordinary thing to do, so treating multiple roots as
/// "malformed rather than a fork" left that abandoned first branch rendering
/// inside the conversation, which is exactly the bug the pruning exists to fix.
///
/// A MISSING `parentId` key still does not count, and that distinction is what
/// keeps the guard honest: pi writes the key on every entry, so its absence marks
/// a record pi did not write, where pruning would be guesswork.
fn has_fork(entries: &[SessionRecord], by_id: &HashMap<&str, usize>) -> bool {
    let mut seen: HashSet<ParentKey> = HashSet::new();
    entries
        .iter()
        .filter_map(|record| parent_key(&record.value, by_id))
        .any(|parent| !seen.insert(parent))
}

/// Whether a record survives the branch filter. An entry WITHOUT an `id` is
/// always kept: it has no place in the tree, so dropping it would be pure loss
/// rather than branch pruning.
fn keeps_record(
    active: Option<&HashSet<usize>>,
    index: usize,
    record: &SessionRecord,
) -> bool {
    match active {
        None => true,
        Some(on_path) => on_path.contains(&index) || entry_id(&record.value).is_none(),
    }
}

fn entry_id(value: &Value) -> Option<&str> {
    value
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
}

/// Parse a `message` record (nested `message` object keyed by `role`).
fn parse_message_record(sp: &mut SessionParse, value: &Value, ts: DateTime<Utc>, idx: usize) {
    let Some(message) = value.get("message") else {
        return;
    };
    let role = message.get("role").and_then(Value::as_str).unwrap_or("");

    match role {
        "user" => {
            let text = user_content_text(message.get("content"));
            let images = content_images(message.get("content"));
            if text.trim().is_empty() && images.is_empty() {
                return;
            }
            sp.content_events += 1;
            sp.message_count += 1;
            if sp.first_user_text.is_none() && !text.trim().is_empty() {
                sp.first_user_text = Some(title_from_user_text(text.trim()));
            }
            let mut blocks = Vec::with_capacity(1 + images.len());
            if !text.is_empty() {
                blocks.push(ContentBlock::Text { text });
            }
            blocks.extend(images.into_iter().map(|image| ContentBlock::Image {
                data: image.data,
                mime_type: image.mime_type,
                uri: image.uri,
            }));
            sp.messages.push(text_message(
                format!("pi-user-{idx}"),
                MessageRole::User,
                blocks,
                ts,
                None,
                None,
            ));
        }
        "assistant" => {
            let model = string_field(message, "model");
            if let Some(ref m) = model {
                sp.model = Some(m.clone());
                sp.provider = string_field(message, "provider");
            }

            let mut blocks = assistant_content_blocks(message.get("content"));
            // `stopReason: "error"` is the only record a failed turn leaves. Its
            // content is usually empty or half-written, so without this the turn
            // renders as a blank assistant bubble (or vanishes at the
            // `is_empty()` guard) with no hint that the provider errored.
            if let Some(error) = assistant_error_text(message) {
                blocks.push(ContentBlock::Text { text: error });
            }
            if blocks.is_empty() {
                return;
            }
            sp.content_events += 1;
            sp.message_count += 1;
            sp.messages.push(text_message(
                format!("pi-assistant-{idx}"),
                MessageRole::Assistant,
                blocks,
                ts,
                usage_from_object(message.get("usage")),
                model,
            ));
        }
        "toolResult" => {
            let tool_call_id = message
                .get("toolCallId")
                .and_then(Value::as_str)
                .map(String::from);
            let output_preview = tool_result_output_text(message).map(|s| truncate_str(&s, 4000));
            let is_error = message
                .get("isError")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            sp.content_events += 1;
            sp.messages.push(text_message(
                format!("pi-toolresult-{idx}"),
                MessageRole::Tool,
                vec![ContentBlock::ToolResult {
                    tool_use_id: tool_call_id,
                    output_preview,
                    is_error,
                    agent_stats: None,
                    images: content_images(message.get("content")),
                }],
                ts,
                None,
                None,
            ));
        }
        _ => {}
    }
}

/// The failure text for an assistant message pi settled with `stopReason:
/// "error"`, or `None` for every other stop reason.
///
/// pi's own `errorMessage` when it has one; otherwise a bare marker, because the
/// fact that the turn errored is itself the thing worth showing — a turn that
/// stopped on an error and left no content is indistinguishable from a turn that
/// simply said nothing.
fn assistant_error_text(message: &Value) -> Option<String> {
    if message.get("stopReason").and_then(Value::as_str) != Some("error") {
        return None;
    }
    Some(match string_field(message, "errorMessage") {
        Some(error) => format!("[pi error] {}", truncate_str(&error, 2000)),
        None => "[pi error]".to_string(),
    })
}

/// Surface a compaction as the provider-neutral tool pair every agent's
/// compaction renders through — `_meta.contextCompaction` on a `ToolUse` plus
/// its settled `ToolResult`, matched by `<ContextCompactionCard>` on the meta key
/// alone (see `parsers::claude::compaction_blocks`, which does the same for
/// Claude Code's `compact_boundary`). Without it, pi's context compaction leaves
/// no mark at all in history and the conversation appears to lose its middle.
///
/// `tokensBefore` becomes `preTokens`; pi records no post-compaction count, and
/// the card degrades to its plain "compacted" label when either side is missing.
/// `fromHook` is pi's (legacy-named) flag for "an extension generated this",
/// which is the closest thing it has to a manual trigger.
///
/// The ToolUse needs its paired ToolResult or the card reads as a call still
/// running, and the id is the entry's own so re-parsing is stable.
fn parse_compaction(sp: &mut SessionParse, value: &Value, ts: DateTime<Utc>, idx: usize) {
    let tool_use_id = entry_id(value)
        .map(String::from)
        .unwrap_or_else(|| format!("pi-compaction-{idx}"));

    let mut marker = serde_json::Map::new();
    marker.insert("version".to_string(), Value::from(1));
    let from_hook = value
        .get("fromHook")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    marker.insert(
        "trigger".to_string(),
        Value::from(if from_hook { "manual" } else { "automatic" }),
    );
    if let Some(before) = value.get("tokensBefore").and_then(Value::as_u64) {
        marker.insert("preTokens".to_string(), Value::from(before));
    }

    sp.content_events += 1;
    sp.messages.push(text_message(
        format!("pi-compaction-{idx}"),
        MessageRole::Assistant,
        vec![
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
        ],
        ts,
        None,
        None,
    ));
}

/// `/tree`'s branch summary — the LLM-written recap of the path pi walked away
/// from, which is real conversational context (pi feeds it back to the model as
/// a `branchSummary` message and renders it in its own TUI). A System turn, the
/// same shell the other parsers use for injected context.
fn parse_branch_summary(sp: &mut SessionParse, value: &Value, ts: DateTime<Utc>, idx: usize) {
    let Some(summary) = string_field(value, "summary") else {
        return;
    };
    sp.content_events += 1;
    sp.messages.push(text_message(
        format!("pi-branchsummary-{idx}"),
        MessageRole::System,
        vec![ContentBlock::Text {
            text: truncate_str(&summary, 4000),
        }],
        ts,
        None,
        None,
    ));
}

/// An extension-injected message that DOES participate in the LLM context
/// (`custom_message`). `display: false` is the extension asking for it to stay
/// hidden in the TUI, and codeg honors that rather than second-guessing it.
fn parse_custom_message(sp: &mut SessionParse, value: &Value, ts: DateTime<Utc>, idx: usize) {
    if !value
        .get("display")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return;
    }
    let text = user_content_text(value.get("content"));
    if text.trim().is_empty() {
        return;
    }
    sp.content_events += 1;
    sp.messages.push(text_message(
        format!("pi-custommessage-{idx}"),
        MessageRole::System,
        vec![ContentBlock::Text {
            text: truncate_str(&text, 4000),
        }],
        ts,
        None,
        None,
    ));
}

/// Parse a `bashExecution` record into a synthetic `bash` tool use + result pair
/// (so it threads and renders like an ordinary tool call).
///
/// A run counts as failed when it was `cancelled`, when `exitCode` is non-zero,
/// or when `exitCode` is ABSENT — the schema types it `number | undefined`
/// (`docs/session-format.md`) precisely because an interrupted run never got
/// one, so defaulting a missing code to `0` painted a Ctrl-C'd command as a
/// success.
///
/// `truncated` is appended as a notice rather than dropped: the stored `output`
/// is then a prefix, and a reader who cannot tell is reading a command's output
/// as complete when it is not. `fullOutputPath` rides along when pi spilled the
/// rest to a file, since that is the only pointer to it.
fn parse_bash_execution(sp: &mut SessionParse, value: &Value, ts: DateTime<Utc>, idx: usize) {
    let command = value
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let mut output = value
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let exit_code = value.get("exitCode").and_then(Value::as_i64);
    let cancelled = value
        .get("cancelled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let is_error = cancelled || exit_code.is_none_or(|code| code != 0);
    let tool_use_id = value
        .get("id")
        .and_then(Value::as_str)
        .map(|id| format!("bash-{id}"));

    output = truncate_str(&output, 4000);
    for notice in bash_execution_notices(value, cancelled) {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&notice);
    }

    sp.content_events += 1;
    sp.messages.push(text_message(
        format!("pi-bashcall-{idx}"),
        MessageRole::Assistant,
        vec![ContentBlock::ToolUse {
            tool_use_id: tool_use_id.clone(),
            tool_name: "bash".to_string(),
            input_preview: (!command.is_empty()).then_some(command),
            status: None,
            meta: None,
        }],
        ts,
        None,
        None,
    ));
    sp.messages.push(text_message(
        format!("pi-bashresult-{idx}"),
        MessageRole::Tool,
        vec![ContentBlock::ToolResult {
            tool_use_id,
            output_preview: (!output.is_empty()).then_some(output),
            is_error,
            agent_stats: None,
            images: Vec::new(),
        }],
        ts,
        None,
        None,
    ));
}

/// The trailing `[…]` notices for a `bashExecution`: cancellation, truncation
/// and the spill file, in that order. Empty for the ordinary complete run.
fn bash_execution_notices(value: &Value, cancelled: bool) -> Vec<String> {
    let mut notices = Vec::new();
    if cancelled {
        notices.push("[cancelled]".to_string());
    }
    if value
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        notices.push(match string_field(value, "fullOutputPath") {
            Some(path) => format!("[output truncated by pi; full output: {path}]"),
            None => "[output truncated by pi]".to_string(),
        });
    }
    notices
}

/// A `user` message's `content` is either a plain string or an array of blocks;
/// join the text of every string / `{type:"text",text}` part.
fn user_content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            let mut out = String::new();
            for item in items {
                if let Some(text) = item.as_str() {
                    out.push_str(text);
                } else if item.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        out.push_str(text);
                    }
                }
            }
            out
        }
        _ => String::new(),
    }
}

/// Base64 `image` blocks (`{type:"image",data,mimeType}`) inside a `content`
/// array — pi's shape for a user attachment and for a `read` of a picture, which
/// returns `[{type:"text",text:"Read image file […]"},{type:"image",…}]`.
///
/// Returned separately from the text so the caller can put them where they
/// belong (`ContentBlock::Image` for a prompt, `ToolResult.images` for a
/// result), matching the live ACP path, which carries the same bytes.
fn content_images(content: Option<&Value>) -> Vec<ImageData> {
    let Some(items) = content.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("image"))
        .filter_map(|item| {
            let data = item
                .get("data")
                .and_then(Value::as_str)
                .filter(|data| !data.is_empty())?;
            Some(ImageData {
                data: data.to_string(),
                mime_type: item
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_string(),
                uri: None,
            })
        })
        .collect()
}

/// An `assistant` message's `content` is an array of blocks: `text` → `Text`,
/// `thinking` → `Thinking`, `toolCall` → `ToolUse`. Unknown block types are
/// skipped.
fn assistant_content_blocks(content: Option<&Value>) -> Vec<ContentBlock> {
    let mut blocks = Vec::new();
    let Some(items) = content.and_then(Value::as_array) else {
        return blocks;
    };
    for item in items {
        match item.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        blocks.push(ContentBlock::Text {
                            text: text.to_string(),
                        });
                    }
                }
            }
            // pi's `ThinkingContent` is `{type:"thinking", thinking, thinkingSignature?}`
            // — the payload key is `thinking`, NOT `text` (`docs/session-format.md`;
            // `parsers::openclaw`, which reads the same pi-family message shape,
            // already does this). Reading `text` here matched nothing at all, so
            // every reasoning block pi ever wrote was silently dropped. `text` is
            // kept as a fallback only so a future rename degrades instead of
            // regressing.
            "thinking" => {
                let text = item
                    .get("thinking")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("text").and_then(Value::as_str));
                if let Some(text) = text {
                    if !text.is_empty() {
                        blocks.push(ContentBlock::Thinking {
                            text: text.to_string(),
                        });
                    }
                }
            }
            "toolCall" => {
                let tool_use_id = item.get("id").and_then(Value::as_str).map(String::from);
                let tool_name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string();
                blocks.push(ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_preview: tool_arguments_preview(item.get("arguments")),
                    status: None,
                    meta: None,
                });
            }
            _ => {}
        }
    }
    blocks
}

/// Serialize a `toolCall.arguments` value (an object/array — or, defensively, a
/// pre-stringified string) into a compact JSON preview, truncated. `None` for a
/// missing / null value.
fn tool_arguments_preview(arguments: Option<&Value>) -> Option<String> {
    let arguments = arguments?;
    let serialized = if let Some(text) = arguments.as_str() {
        if text.is_empty() {
            return None;
        }
        text.to_string()
    } else if arguments.is_null() {
        return None;
    } else {
        serde_json::to_string(arguments).ok()?
    };
    Some(truncate_str(&serialized, 4000))
}

/// Flatten a pi tool-result `content` value into the text pi itself displays.
///
/// Every pi tool — `bash`, `read`, `write` — writes its result as an ARRAY of
/// MCP-shaped blocks (`[{"type":"text","text":…}]`); a bare string is accepted
/// defensively. Only `text` blocks carry readable output and pi joins them with
/// no separator, so this returns byte-for-byte what pi-acp puts on the live
/// `content[]` channel (its `toolResultToText`) — history and live must not
/// render two different strings for the same result.
///
/// `None` for a missing / null / empty value, and for any shape carrying no text
/// block at all; callers decide what to fall back to.
pub(crate) fn tool_result_content_text(content: &Value) -> Option<String> {
    if let Some(text) = content.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    let mut out = String::new();
    for item in content.as_array()? {
        if item.get("type").and_then(Value::as_str) == Some("text") {
            if let Some(text) = item.get("text").and_then(Value::as_str) {
                out.push_str(text);
            }
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The text to show for a `toolResult` record.
///
/// Prefers `details.patch` when it is a unified diff: pi's `edit` tool writes
/// `{content:[{type:"text",text:"Successfully replaced N block(s) in <path>."}],
/// details:{diff, patch, firstChangedLine}}`, where `patch` is a real
/// `createTwoFilesPatch` unified diff and `content` is a one-line receipt. The
/// receipt is what the history used to render, so an edit whose LIVE card shows
/// a full structured diff (pi-acp emits a `ToolCallContent::Diff` built from its
/// own before/after snapshots) collapsed to a single sentence once the
/// conversation was reopened. Handing the patch up instead lets the renderer's
/// existing `/^@@ /m` branch draw the same `<UnifiedDiffPreview>` Claude's
/// `structuredPatch` gets.
///
/// The `looks_like_unified_diff` gate keeps this narrow: only a payload the
/// renderer can actually parse displaces pi's own text, so any other `patch`
/// field shape falls through untouched.
fn tool_result_output_text(message: &Value) -> Option<String> {
    if let Some(patch) = message
        .pointer("/details/patch")
        .and_then(Value::as_str)
        .filter(|patch| looks_like_unified_diff(patch))
    {
        return Some(patch.to_string());
    }
    content_to_text(message.get("content"))
}

/// A cheap structural check for a unified diff: the `--- ` / `+++ ` file headers
/// plus at least one `@@` hunk header, each anchored at the start of a line.
/// Deliberately stricter than the renderer's own sniff — this decides whether to
/// REPLACE pi's text, so a false positive costs the result, not just a plain
/// rendering.
fn looks_like_unified_diff(text: &str) -> bool {
    let mut has_old = false;
    let mut has_new = false;
    let mut has_hunk = false;
    for line in text.lines() {
        if line.starts_with("--- ") {
            has_old = true;
        } else if line.starts_with("+++ ") {
            has_new = true;
        } else if line.starts_with("@@ ") {
            has_hunk = true;
        }
    }
    has_old && has_new && has_hunk
}

/// A tool result's `content` — the MCP block array pi actually writes (or, for
/// robustness, a plain string). Anything else is serialized as a fallback so an
/// unrecognized future shape still surfaces something rather than nothing.
/// `None` for a missing / null / empty value.
fn content_to_text(content: Option<&Value>) -> Option<String> {
    let content = content?;
    if let Some(text) = tool_result_content_text(content) {
        return Some(text);
    }
    if content.is_null() || content.is_string() {
        return None;
    }
    serde_json::to_string(content).ok()
}

/// Map a `usage` object (`{input,output,cacheRead,cacheWrite,…}`) onto
/// `TurnUsage`; `None` when every counter is absent or zero so an empty object
/// does not create spurious usage. Missing fields default to 0.
fn usage_from_object(usage: Option<&Value>) -> Option<TurnUsage> {
    let usage = usage?;
    let field = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = field("input");
    let output = field("output");
    let cache_read = field("cacheRead");
    let cache_write = field("cacheWrite");
    if input == 0 && output == 0 && cache_read == 0 && cache_write == 0 {
        return None;
    }
    Some(TurnUsage {
        input_tokens: input,
        output_tokens: output,
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
    })
}

/// ISO-8601 `timestamp` string → `DateTime<Utc>` (chrono's RFC3339 `FromStr`),
/// mirroring `parsers::openclaw::parse_iso_timestamp`.
fn record_iso_ts(value: &Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

/// Record a line's timestamp into the session span and return a concrete
/// timestamp for the message (falling back to the last seen one, then now).
fn note_ts(sp: &mut SessionParse, ts_raw: Option<DateTime<Utc>>) -> DateTime<Utc> {
    if let Some(ts) = ts_raw {
        sp.first_ts.get_or_insert(ts);
        sp.last_ts = Some(ts);
    }
    ts_raw.or(sp.last_ts).unwrap_or_else(Utc::now)
}

/// Read just the header `id` of a session file (falling back to the filename
/// uuid), used to match `get_conversation` without parsing the whole file.
fn session_id_of(path: &Path) -> Option<String> {
    let file = fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) == Some("session") {
            if let Some(id) = value
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(id.to_string());
            }
        }
        // The header is line 1; stop after the first non-empty record so a
        // headerless file falls back to the filename uuid rather than scanning.
        break;
    }
    Some(fallback_id(path))
}

/// Recover a conversation id from a `<timestamp>_<uuid>.jsonl` filename when the
/// header is missing: the `<uuid>` after the first `_`, else the whole stem.
fn fallback_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    stem.split_once('_')
        .map(|(_ts, uuid)| uuid.to_string())
        .filter(|uuid| !uuid.is_empty())
        .unwrap_or(stem)
}

fn resolve_title(session_name: Option<String>, first_user_text: Option<String>) -> Option<String> {
    session_name.or(first_user_text)
}

fn text_message(
    id: String,
    role: MessageRole,
    content: Vec<ContentBlock>,
    ts: DateTime<Utc>,
    usage: Option<TurnUsage>,
    model: Option<String>,
) -> UnifiedMessage {
    UnifiedMessage {
        id,
        role,
        content,
        timestamp: ts,
        usage,
        duration_ms: None,
        model,
        completed_at: Some(ts),
    agent_message_id: None,
    }
}

/// Group the flat, chronologically-ordered `UnifiedMessage`s into `MessageTurn`s:
/// User/System messages each become their own turn; an Assistant message starts a
/// turn that absorbs the immediately-following Tool messages (its tool results),
/// stopping at the next Assistant message to keep turns small for virtualization.
/// (Private copy mirroring the other single-file-per-session parsers.)
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
    use serde_json::json;
    use std::io::Write;
    use tempfile::tempdir;

    /// Two providers, same id, different windows — the file pi would resolve
    /// with the session's own provider, not with a tie-break.
    const TWO_PROVIDER_MODELS_JSON: &str = r#"{
      "providers": {
        "openai-compatible": { "models": [
          { "id": "qwen-flash", "contextWindow": 262144, "maxTokens": 32768 }
        ]},
        "other": { "models": [
          { "id": "qwen-flash", "contextWindow": 131072 }
        ]}
      }
    }"#;

    #[test]
    fn declared_context_window_resolves_the_session_s_own_provider() {
        let window = |provider: Option<&str>| {
            pi_declared_context_window_from(TWO_PROVIDER_MODELS_JSON, provider, "qwen-flash")
        };
        // The recorded provider decides. Taking the largest instead would have
        // told a session on `other` it had twice the room it really has.
        assert_eq!(window(Some("openai-compatible")), Some(262_144));
        assert_eq!(window(Some("other")), Some(131_072));
        // A provider this file does not define is a BUILT-IN one, whose
        // catalogue lives inside pi — nothing to read here.
        assert_eq!(window(Some("anthropic")), None);
        // Without a recorded provider, two disagreeing declarations are not an
        // answer; one agreed answer still is.
        assert_eq!(window(None), None);
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"a":{"models":[{"id":"m","contextWindow":50}]},
                                  "b":{"models":[{"id":"m","contextWindow":50}]}}}"#,
                None,
                "m"
            ),
            Some(50)
        );
        // An id the file does not list → None, so the name-based guess still runs.
        assert_eq!(
            pi_declared_context_window_from(TWO_PROVIDER_MODELS_JSON, None, "nope"),
            None
        );
    }

    /// pi's `modelFromJson` ends `contextWindow: definition.contextWindow ??
    /// 128000`, and the entry REPLACES any built-in of the same id. So a listed
    /// model that declares nothing is not unknown — it is 128K, including for
    /// an id codeg's own name table would answer differently. This is the shape
    /// codeg's Pi settings panel writes (`apply_pi_custom_model` records `id` +
    /// `name` + reasoning, never a window).
    #[test]
    fn a_listed_model_without_a_window_takes_pi_s_own_default() {
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"gs":{"baseUrl":"http://127.0.0.1:8080/v1",
                     "models":[{"id":"gpt-5.5","name":"gpt-5.5"}]}}}"#,
                Some("gs"),
                "gpt-5.5"
            ),
            Some(128_000),
            "the name table's 258K is what pi is NOT running with"
        );
    }

    /// One provider listing an id twice: pi's `applyModelsJson` upserts in file
    /// order, so the second entry overwrites the first and 100K is what pi
    /// runs with. Reading the first instead would report 9× the room.
    #[test]
    fn a_repeated_model_id_resolves_to_its_last_declaration() {
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"p":{"models":[
                     {"id":"m","contextWindow":900000},
                     {"id":"m","contextWindow":100000}
                   ]}}}"#,
                Some("p"),
                "m"
            ),
            Some(100_000)
        );
    }

    /// `modelOverrides` is the topmost layer in pi's composer, and it patches:
    /// a window there wins, its absence leaves the layer below in charge.
    #[test]
    fn a_model_override_wins_over_the_models_entry() {
        let raw = r#"{"providers":{"p":{
            "models":[{"id":"m","contextWindow":100}],
            "modelOverrides":{"m":{"contextWindow":900},"other":{"contextWindow":7}}
        }}}"#;
        assert_eq!(
            pi_declared_context_window_from(raw, Some("p"), "m"),
            Some(900)
        );
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"p":{"models":[{"id":"m","contextWindow":100}],
                     "modelOverrides":{"m":{"name":"renamed"}}}}}"#,
                Some("p"),
                "m"
            ),
            Some(100),
            "an override that declares no window must not erase the declaration"
        );
    }

    #[test]
    fn declared_context_window_declines_junk_without_panicking() {
        // Unreadable, not JSON, missing fields or a zero window must be None, never a panic.
        assert_eq!(
            pi_declared_context_window_from("", None, "qwen-flash"),
            None
        );
        assert_eq!(
            pi_declared_context_window_from("not json", None, "qwen-flash"),
            None
        );
        assert_eq!(
            pi_declared_context_window_from(r#"{"providers": "wrong"}"#, None, "qwen-flash"),
            None
        );
        // pi throws `invalid contextWindow` for `<= 0` rather than defaulting,
        // so a file it would refuse to load must not be read as a declaration.
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"p":{"models":[{"id":"m","contextWindow":0}]}}}"#,
                Some("p"),
                "m"
            ),
            None
        );
        assert_eq!(
            pi_declared_context_window_from(
                r#"{"providers":{"p":{"models":[{"id":"m","contextWindow":"wide"}]}}}"#,
                Some("p"),
                "m"
            ),
            None
        );
    }

    /// The lookup only pays off if `get_conversation` actually consults it —
    /// and only if the declaration OUTRANKS the name table, which is the whole
    /// point (a proxy in front of a known model id serves a window the table
    /// cannot know). `sample_records` runs `claude-sonnet-4-6`, which the table
    /// answers with 200K, so the two readings are distinguishable.
    #[test]
    fn a_declared_window_outranks_the_name_table_through_get_conversation() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        let sessions = agent_dir.join("sessions");
        let id = "0f3c1d2e-1111-2222-3333-444455556666";
        write_session(
            &sessions,
            "--Users-demo-my-app--",
            "2026-06-27T10-00-00_0f3c1d2e.jsonl",
            &sample_records(id),
        );

        let window = || {
            PiParser::with_base_dir(sessions.clone())
                .get_conversation(id)
                .expect("detail")
                .session_stats
                .expect("session stats")
                .context_window_max_tokens
        };
        let declare = |json: &str| std::fs::write(agent_dir.join("models.json"), json).unwrap();

        // No models.json at all: unchanged behaviour, the name table answers.
        assert_eq!(window(), Some(200_000));

        // The session runs `anthropic`/`claude-sonnet-4-6` (`model_change`
        // carries the pair). A declaration under a DIFFERENT provider is a
        // different model to pi, so the table keeps the answer.
        declare(
            r#"{"providers":{"proxy":{"baseUrl":"http://127.0.0.1:8080/v1",
                 "models":[{"id":"claude-sonnet-4-6","contextWindow":900000}]}}}"#,
        );
        assert_eq!(window(), Some(200_000));

        // Declared under the provider the session actually used — even though
        // the other provider's window is larger, and even though it is SMALLER
        // than what the name table would have guessed.
        declare(
            r#"{"providers":{
                 "proxy":{"baseUrl":"http://127.0.0.1:8080/v1",
                   "models":[{"id":"claude-sonnet-4-6","contextWindow":900000}]},
                 "anthropic":{"baseUrl":"http://127.0.0.1:9090/v1",
                   "models":[{"id":"claude-sonnet-4-6","contextWindow":150000}]}
               }}"#,
        );
        assert_eq!(window(), Some(150_000));
    }

    /// Same fixture — and same reason — as `acp::file_system_runtime`'s tests: a
    /// unix-shaped `/srv/x` has a root but NO drive prefix on Windows, so
    /// `Path::is_absolute` (the gate in [`session_dir_from_settings`]) calls it
    /// drive-relative and declines it. Hard-coding the unix shape made the
    /// honored-path assertions quietly exercise the FALLBACK there.
    #[cfg(windows)]
    const ABS_PREFIX: &str = "C:";
    #[cfg(not(windows))]
    const ABS_PREFIX: &str = "";

    /// An absolute path for the HOST platform, built from unix-style segments —
    /// as the STRING a settings file or env var carries, which is how every
    /// caller here needs it. Nothing opens these paths, so the synthetic drive
    /// letter needs no counterpart on disk.
    fn absolute_path(segments: &str) -> String {
        format!("{ABS_PREFIX}/{segments}")
    }

    #[test]
    fn resolve_sessions_dir_prefers_session_dir_env() {
        let resolved = resolve_pi_sessions_dir_from(
            Some(OsString::from("/custom/pi/sessions")),
            Some(OsString::from("/custom/pi-home")),
            Some(PathBuf::from("/home/demo")),
        );
        assert_eq!(resolved, PathBuf::from("/custom/pi/sessions"));
    }

    #[test]
    fn resolve_sessions_dir_appends_sessions_to_agent_dir() {
        let resolved = resolve_pi_sessions_dir_from(
            None,
            Some(OsString::from("/custom/pi-home")),
            Some(PathBuf::from("/home/demo")),
        );
        assert_eq!(resolved, PathBuf::from("/custom/pi-home/sessions"));
    }

    #[test]
    fn resolve_sessions_dir_defaults_to_home_dot_pi() {
        let resolved = resolve_pi_sessions_dir_from(None, None, Some(PathBuf::from("/home/demo")));
        assert_eq!(
            resolved,
            PathBuf::from("/home/demo/.pi/agent/sessions")
        );
    }

    #[test]
    fn resolve_sessions_dir_ignores_empty_env() {
        let resolved = resolve_pi_sessions_dir_from(
            Some(OsString::new()),
            Some(OsString::new()),
            Some(PathBuf::from("/home/demo")),
        );
        assert_eq!(
            resolved,
            PathBuf::from("/home/demo/.pi/agent/sessions")
        );
    }

    #[test]
    fn nonexistent_base_dir_lists_nothing() {
        let parser = PiParser::with_base_dir(PathBuf::from("/nonexistent/pi/sessions"));
        assert!(parser
            .list_conversations()
            .expect("list is infallible")
            .is_empty());
    }

    /// Write one session JSONL at
    /// `<base>/--<dashed-cwd>--/<timestamp>_<uuid>.jsonl`.
    fn write_session(base: &Path, dashed_cwd: &str, filename: &str, records: &[Value]) {
        let dir = base.join(dashed_cwd);
        std::fs::create_dir_all(&dir).expect("create session dir");
        let mut file = std::fs::File::create(dir.join(filename)).expect("create jsonl");
        for record in records {
            writeln!(file, "{}", serde_json::to_string(record).expect("serialize"))
                .expect("write line");
        }
    }

    /// A faithful v3 session: every entry links to the one before it, which is
    /// what pi actually writes (`_appendEntry` stamps `parentId = leafId` and
    /// then moves the leaf), and only the first entry has a `null` parent.
    fn sample_records(id: &str) -> Vec<Value> {
        vec![
            json!({"type":"session","version":3,"id":id,"timestamp":"2026-06-27T10:00:00.000Z","cwd":"/Users/demo/my-app"}),
            json!({"type":"session_info","id":"i1","parentId":null,"timestamp":"2026-06-27T10:00:00.100Z","name":"Build the app"}),
            json!({"type":"message","id":"m1","parentId":"i1","timestamp":"2026-06-27T10:00:01.000Z",
                   "message":{"role":"user","content":"run pnpm build"}}),
            json!({"type":"model_change","id":"mc1","parentId":"m1","timestamp":"2026-06-27T10:00:01.500Z",
                   "provider":"anthropic","modelId":"claude-sonnet-4-6"}),
            json!({"type":"message","id":"m2","parentId":"mc1","timestamp":"2026-06-27T10:00:02.000Z",
                   "message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-6","stopReason":"tool_use",
                     "usage":{"input":1200,"output":80,"cacheRead":4000,"cacheWrite":0,"totalTokens":5280,"cost":0.01},
                     "content":[
                       // The REAL on-disk shape: the payload key is `thinking`.
                       {"type":"thinking","thinking":"check the build first","thinkingSignature":"sig"},
                       {"type":"text","text":"Running the build now."},
                       {"type":"toolCall","id":"call_1","name":"bash","arguments":{"command":"pnpm build"}}
                     ]}}),
            json!({"type":"message","id":"m3","parentId":"m2","timestamp":"2026-06-27T10:00:09.000Z",
                   "message":{"role":"toolResult","toolCallId":"call_1","toolName":"bash",
                     "content":[{"type":"text","text":"Compiled successfully"}],"isError":false}}),
            json!({"type":"message","id":"m4","parentId":"m3","timestamp":"2026-06-27T10:00:10.000Z",
                   "message":{"role":"assistant","provider":"anthropic","model":"claude-sonnet-4-6","stopReason":"end_turn",
                     "content":[{"type":"text","text":"Build succeeded."}]}}),
        ]
    }

    #[test]
    fn parses_pi_v3_session_shape() {
        let dir = tempdir().expect("tempdir");
        let base = dir.path();
        let id = "0f3c1d2e-1111-2222-3333-444455556666";
        write_session(
            base,
            "--Users-demo-my-app--",
            "2026-06-27T10-00-00_0f3c1d2e.jsonl",
            &sample_records(id),
        );

        let parser = PiParser::with_base_dir(base.to_path_buf());

        // ---- list_conversations -------------------------------------------
        let summaries = parser.list_conversations().expect("list");
        assert_eq!(summaries.len(), 1, "one session listed");
        let summary = &summaries[0];
        assert_eq!(summary.agent_type, AgentType::Pi);
        assert_eq!(summary.id, id, "header id is the external id");
        assert_eq!(
            summary.title.as_deref(),
            Some("Build the app"),
            "session_info.name is the preferred title"
        );
        assert_eq!(
            summary.folder_path.as_deref(),
            Some("/Users/demo/my-app"),
            "cwd is read from the header, not the dashed dir name"
        );
        assert_eq!(summary.folder_name.as_deref(), Some("my-app"));
        assert_eq!(
            summary.model.as_deref(),
            Some("claude-sonnet-4-6"),
            "latest assistant/model_change model"
        );
        assert_eq!(
            summary.message_count, 3,
            "one user + two assistant turns (tool result excluded)"
        );

        // ---- get_conversation ---------------------------------------------
        let detail = parser.get_conversation(id).expect("detail");
        assert_eq!(detail.summary.agent_type, AgentType::Pi);
        assert_eq!(detail.summary.id, id);

        let has_user = detail.turns.iter().any(|t| {
            matches!(t.role, TurnRole::User)
                && t.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("pnpm build")))
        });
        assert!(has_user, "user message becomes a User turn");

        let has_thinking = detail.turns.iter().any(|t| {
            t.blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::Thinking { text } if text.contains("check the build")))
        });
        assert!(has_thinking, "assistant thinking block becomes Thinking");

        let has_assistant_text = detail.turns.iter().any(|t| {
            matches!(t.role, TurnRole::Assistant)
                && t.blocks
                    .iter()
                    .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("Running the build")))
        });
        assert!(has_assistant_text, "assistant text block renders");

        // A ToolUse and a matching ToolResult, threaded by call id.
        let tool_use_id = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    tool_use_id,
                    input_preview,
                    ..
                } if tool_name == "bash" => {
                    assert!(input_preview
                        .as_deref()
                        .unwrap_or_default()
                        .contains("pnpm build"));
                    tool_use_id.clone()
                }
                _ => None,
            })
            .expect("a bash ToolUse");
        assert_eq!(tool_use_id, "call_1");

        let result = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "call_1" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("a matching ToolResult");
        assert_eq!(
            result.0.as_deref(),
            Some("Compiled successfully"),
            "the MCP block array is flattened to its text, not dumped as JSON"
        );
        assert!(!result.1, "a successful tool result is not an error");

        // The ToolUse and ToolResult must land in the same (assistant) turn.
        let same_turn = detail.turns.iter().any(|t| {
            let has_use = t.blocks.iter().any(|b| matches!(b, ContentBlock::ToolUse { tool_use_id: Some(id), .. } if id == "call_1"));
            let has_res = t.blocks.iter().any(|b| matches!(b, ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "call_1"));
            has_use && has_res
        });
        assert!(same_turn, "ToolUse and ToolResult thread into one turn");

        // Assistant usage is summed into the session stats.
        let usage = detail
            .session_stats
            .as_ref()
            .and_then(|s| s.total_usage.as_ref())
            .expect("usage");
        assert_eq!(usage.input_tokens, 1200);
        assert_eq!(usage.output_tokens, 80);
        assert_eq!(usage.cache_read_input_tokens, 4000);
    }

    /// Regression: a `bash` result is an MCP block array, and serializing it
    /// painted the terminal card with the JSON source string
    /// (`[{"text":"$ next build\n…","type":"text"}]`) instead of the output.
    #[test]
    fn tool_result_content_shapes() {
        assert_eq!(
            tool_result_content_text(&json!([{"type":"text","text":"$ next build\nok\n"}]))
                .as_deref(),
            Some("$ next build\nok\n"),
            "the real on-disk shape: one text block, unwrapped"
        );
        assert_eq!(
            tool_result_content_text(&json!([
                {"type":"text","text":"part one "},
                {"type":"image","data":"…"},
                {"type":"text","text":"part two"}
            ]))
            .as_deref(),
            Some("part one part two"),
            "text blocks join with no separator; non-text blocks are skipped"
        );
        assert_eq!(
            tool_result_content_text(&json!("plain string")).as_deref(),
            Some("plain string"),
            "a bare string is accepted defensively"
        );
        assert_eq!(tool_result_content_text(&json!([])), None, "empty array");
        assert_eq!(
            tool_result_content_text(&json!([{"type":"image","data":"…"}])),
            None,
            "no text block at all — caller decides the fallback"
        );

        // `content_to_text` keeps the JSON fallback for shapes with no text.
        assert_eq!(content_to_text(None), None);
        assert_eq!(content_to_text(Some(&Value::Null)), None);
        assert_eq!(content_to_text(Some(&json!(""))), None);
        assert_eq!(
            content_to_text(Some(&json!({"exitCode": 0}))).as_deref(),
            Some(r#"{"exitCode":0}"#),
            "an unrecognized object still surfaces something"
        );
    }

    #[test]
    fn user_content_array_text_parts_are_joined() {
        let dir = tempdir().expect("tempdir");
        let base = dir.path();
        let id = "array-user-0001";
        write_session(
            base,
            "--Users-demo-app--",
            "ts_array-user-0001.jsonl",
            &[
                json!({"type":"session","version":3,"id":id,"timestamp":"2026-06-27T10:00:00.000Z","cwd":"/Users/demo/app"}),
                json!({"type":"message","id":"m1","timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":[
                         {"type":"text","text":"part one "},
                         {"type":"text","text":"part two"}
                       ]}}),
                json!({"type":"message","id":"m2","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"claude-sonnet-4-6",
                         "content":[{"type":"text","text":"ok"}]}}),
            ],
        );

        let parser = PiParser::with_base_dir(base.to_path_buf());
        let detail = parser.get_conversation(id).expect("detail");
        let joined = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::Text { text } if text.contains("part one") => Some(text.clone()),
                _ => None,
            })
            .expect("user text");
        assert!(
            joined.contains("part one") && joined.contains("part two"),
            "array text parts are joined, got: {joined}"
        );
        // No session_info.name → falls back to the first user message text.
        assert_eq!(detail.summary.title.as_deref(), Some("part one part two"));
    }

    #[test]
    fn bash_execution_becomes_tool_pair_with_error_on_nonzero_exit() {
        let dir = tempdir().expect("tempdir");
        let base = dir.path();
        let id = "bash-exec-0001";
        write_session(
            base,
            "--Users-demo-app--",
            "ts_bash-exec-0001.jsonl",
            &[
                json!({"type":"session","version":3,"id":id,"timestamp":"2026-06-27T10:00:00.000Z","cwd":"/Users/demo/app"}),
                json!({"type":"message","id":"m1","timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"run it"}}),
                json!({"type":"bashExecution","id":"b1","timestamp":"2026-06-27T10:00:02.000Z",
                       "command":"exit 1","output":"boom","exitCode":1,"cancelled":false,"truncated":false}),
            ],
        );

        let parser = PiParser::with_base_dir(base.to_path_buf());
        let detail = parser.get_conversation(id).expect("detail");

        let has_bash_use = detail.turns.iter().flat_map(|t| &t.blocks).any(|b| {
            matches!(b, ContentBlock::ToolUse { tool_name, input_preview, .. }
                if tool_name == "bash" && input_preview.as_deref() == Some("exit 1"))
        });
        assert!(has_bash_use, "bashExecution becomes a bash ToolUse");

        let errored = detail.turns.iter().flat_map(|t| &t.blocks).any(|b| {
            matches!(b, ContentBlock::ToolResult { is_error, output_preview, .. }
                if *is_error && output_preview.as_deref() == Some("boom"))
        });
        assert!(errored, "a non-zero exitCode marks the bash result an error");
    }

    #[test]
    fn malformed_lines_are_skipped_without_error() {
        let dir = tempdir().expect("tempdir");
        let base = dir.path();
        let id = "robust-0001";
        let session_dir = base.join("--Users-demo-app--");
        std::fs::create_dir_all(&session_dir).expect("dir");
        let mut file =
            std::fs::File::create(session_dir.join("ts_robust-0001.jsonl")).expect("file");
        writeln!(
            file,
            "{}",
            json!({"type":"session","version":3,"id":id,"timestamp":"2026-06-27T10:00:00.000Z","cwd":"/Users/demo/app"})
        )
        .unwrap();
        writeln!(file, "{{ this is not valid json").unwrap();
        writeln!(file).unwrap(); // blank line
        writeln!(
            file,
            "{}",
            json!({"type":"message","id":"m1","timestamp":"2026-06-27T10:00:01.000Z",
                   "message":{"role":"user","content":"hello"}})
        )
        .unwrap();
        // Unknown record type must not error.
        writeln!(
            file,
            "{}",
            json!({"type":"branch_summary","id":"x","timestamp":"2026-06-27T10:00:02.000Z","summary":"noise"})
        )
        .unwrap();

        let parser = PiParser::with_base_dir(base.to_path_buf());
        let summaries = parser.list_conversations().expect("list survives malformed lines");
        assert_eq!(summaries.len(), 1);
        assert_eq!(summaries[0].id, id);
        let detail = parser.get_conversation(id).expect("detail survives malformed lines");
        assert!(detail.turns.iter().any(|t| matches!(t.role, TurnRole::User)));
    }

    #[test]
    fn unknown_conversation_is_not_found() {
        let dir = tempdir().expect("tempdir");
        let parser = PiParser::with_base_dir(dir.path().to_path_buf());
        assert!(matches!(
            parser.get_conversation("nope"),
            Err(ParseError::ConversationNotFound(_))
        ));
    }

    /// Collect every `Thinking` block's text across a detail.
    fn thinking_texts(detail: &ConversationDetail) -> Vec<String> {
        detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                ContentBlock::Thinking { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// Collect every `Text` block's text across a detail.
    fn text_blocks(detail: &ConversationDetail) -> Vec<String> {
        detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    fn parse_one(records: &[Value], id: &str) -> ConversationDetail {
        let dir = tempdir().expect("tempdir");
        write_session(dir.path(), "--Users-demo-app--", "ts_x.jsonl", records);
        PiParser::with_base_dir(dir.path().to_path_buf())
            .get_conversation(id)
            .expect("detail")
    }

    fn header(id: &str) -> Value {
        json!({"type":"session","version":3,"id":id,
               "timestamp":"2026-06-27T10:00:00.000Z","cwd":"/Users/demo/app"})
    }

    /// REGRESSION: pi's thinking block spells its payload `thinking`, not `text`
    /// (`docs/session-format.md`; 21/21 blocks in real local transcripts carry
    /// exactly `["thinking","thinkingSignature","type"]`). Reading `text` matched
    /// nothing, so every reasoning block pi had ever written was dropped on the
    /// floor — silently, because an unmatched block is simply skipped.
    #[test]
    fn thinking_block_reads_pi_field_name() {
        let id = "thinking-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"go"}}),
                json!({"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[
                         {"type":"thinking","thinking":"weighing the options","thinkingSignature":"abc"},
                         {"type":"text","text":"done"}
                       ]}}),
            ],
            id,
        );
        assert_eq!(
            thinking_texts(&detail),
            vec!["weighing the options".to_string()],
        );
    }

    /// The `text` fallback exists only so a future upstream rename degrades
    /// instead of regressing to the same silent drop.
    #[test]
    fn thinking_block_falls_back_to_text_field() {
        let id = "thinking-0002";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"assistant","model":"m","content":[
                         {"type":"thinking","text":"legacy shape"}
                       ]}}),
            ],
            id,
        );
        assert_eq!(thinking_texts(&detail), vec!["legacy shape".to_string()]);
    }

    /// REGRESSION: a pi session file is a TREE. After the user rewinds and asks
    /// something else (`/tree`, or re-prompting from an earlier entry), the
    /// abandoned reply is STILL in the file — pi branches in place. pi itself
    /// renders only the path from the last entry back to the root
    /// (`_buildIndex` + `buildSessionPath`), so reading the file linearly spliced
    /// a reply the user had thrown away into the middle of the conversation.
    #[test]
    fn abandoned_branch_is_not_rendered() {
        let id = "branch-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"first question"}}),
                json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"first answer"}]}}),
                // ── abandoned branch off a1 ──────────────────────────────────
                json!({"type":"message","id":"u2a","parentId":"a1","timestamp":"2026-06-27T10:00:03.000Z",
                       "message":{"role":"user","content":"abandoned question"}}),
                json!({"type":"message","id":"a2a","parentId":"u2a","timestamp":"2026-06-27T10:00:04.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"abandoned answer"}]}}),
                // ── the branch the user kept, also off a1 ────────────────────
                json!({"type":"message","id":"u2b","parentId":"a1","timestamp":"2026-06-27T10:00:05.000Z",
                       "message":{"role":"user","content":"kept question"}}),
                json!({"type":"message","id":"a2b","parentId":"u2b","timestamp":"2026-06-27T10:00:06.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"kept answer"}]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(
            texts.iter().any(|t| t == "first answer")
                && texts.iter().any(|t| t == "kept question")
                && texts.iter().any(|t| t == "kept answer"),
            "the active path renders whole, got: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains("abandoned")),
            "the abandoned branch must not render, got: {texts:?}"
        );
        assert_eq!(
            detail.summary.message_count, 4,
            "counts follow the active branch too"
        );
    }

    /// A v1 (pre-tree) session has no `id`/`parentId` at all. There is no leaf to
    /// walk from, so every record is kept in file order — the pruning must never
    /// be able to empty a conversation it cannot analyze.
    #[test]
    fn session_without_entry_ids_keeps_every_record() {
        let id = "legacy-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"one"}}),
                json!({"type":"message","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"two"}]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(texts.iter().any(|t| t == "one") && texts.iter().any(|t| t == "two"));
    }

    /// REGRESSION: re-editing the FIRST prompt forks at the virtual root. pi's
    /// `/tree` branches from `targetEntry.parentId`, which for the first user
    /// message is `null`, so it calls `resetLeaf()` and appends the replacement
    /// with `parentId: null` — two explicit roots, no shared parent entry. Fork
    /// detection that only counted resolvable parents saw no fork here and kept
    /// the abandoned first exchange in the transcript.
    #[test]
    fn root_reedit_fork_drops_the_abandoned_first_branch() {
        let id = "rootfork-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"the typo'd question"}}),
                json!({"type":"message","id":"a1","parentId":"u1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"answer to the typo"}]}}),
                // The user rewinds to the very first prompt and re-asks:
                // `newLeafId = u1.parentId = null` → `resetLeaf()`.
                json!({"type":"message","id":"u1b","parentId":null,"timestamp":"2026-06-27T10:00:03.000Z",
                       "message":{"role":"user","content":"the fixed question"}}),
                json!({"type":"message","id":"a1b","parentId":"u1b","timestamp":"2026-06-27T10:00:04.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"answer to the fix"}]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(
            texts.iter().any(|t| t == "the fixed question")
                && texts.iter().any(|t| t == "answer to the fix"),
            "the kept root branch renders whole, got: {texts:?}"
        );
        assert!(
            !texts.iter().any(|t| t.contains("typo")),
            "the abandoned root branch must not render, got: {texts:?}"
        );
        assert_eq!(
            detail.summary.message_count, 2,
            "counts follow the active root branch too"
        );
    }

    /// A file with a BROKEN chain but no fork keeps everything. Pruning exists to
    /// drop an abandoned branch; with no parent holding two children there is no
    /// branch, so an unreachable entry is a defect in the file — and silently
    /// deleting a user's messages over a defect is far worse than showing a
    /// record pi would have skipped.
    #[test]
    fn broken_chain_without_a_fork_keeps_every_record() {
        let id = "broken-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"orphaned but real"}}),
                // Points at an id that is not in the file: the walk from the leaf
                // can never reach `m1`.
                json!({"type":"message","id":"m2","parentId":"missing","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"reply"}]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(
            texts.iter().any(|t| t == "orphaned but real"),
            "got: {texts:?}"
        );
        assert!(texts.iter().any(|t| t == "reply"), "got: {texts:?}");
    }

    /// A `parentId` chain that loops must terminate rather than hang.
    #[test]
    fn cyclic_parent_chain_terminates() {
        let id = "cycle-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"x","parentId":"y","timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"loop a"}}),
                json!({"type":"message","id":"y","parentId":"x","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"assistant","model":"m","content":[{"type":"text","text":"loop b"}]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(texts.iter().any(|t| t == "loop b"));
    }

    /// pi's `getSessionName()` scans backwards, so a `/name` rename is the title.
    #[test]
    fn last_session_info_wins() {
        let id = "rename-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"session_info","id":"s1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z","name":"Old name"}),
                json!({"type":"message","id":"m1","parentId":"s1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"user","content":"hi"}}),
                json!({"type":"session_info","id":"s2","parentId":"m1","timestamp":"2026-06-27T10:00:03.000Z","name":"New name"}),
            ],
            id,
        );
        assert_eq!(detail.summary.title.as_deref(), Some("New name"));
    }

    /// `getSessionName()` scans `getEntries()` — every PHYSICAL entry — backwards
    /// and returns at the first `session_info` it reaches. So a `/name` issued on
    /// a branch the user later abandoned still names the session (the name is
    /// session-wide, not branch-scoped), and a latest entry with an empty name
    /// CLEARS the name rather than letting an older one resurface.
    #[test]
    fn session_name_follows_pi_over_all_physical_entries() {
        let id = "rename-0002";
        // The rename lives on the abandoned branch; the active branch has none.
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"u1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":"first"}}),
                json!({"type":"session_info","id":"s1","parentId":"u1","timestamp":"2026-06-27T10:00:02.000Z","name":"Named on a dead branch"}),
                json!({"type":"message","id":"u2","parentId":"u1","timestamp":"2026-06-27T10:00:03.000Z",
                       "message":{"role":"user","content":"second"}}),
            ],
            id,
        );
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("Named on a dead branch"),
            "the name is session-wide, not branch-scoped"
        );

        // An empty latest name clears it — pi returns at the first hit either way.
        let id = "rename-0003";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"session_info","id":"s1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z","name":"Old name"}),
                json!({"type":"message","id":"m1","parentId":"s1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"user","content":"a prompt worth titling"}}),
                json!({"type":"session_info","id":"s2","parentId":"m1","timestamp":"2026-06-27T10:00:03.000Z","name":"   "}),
            ],
            id,
        );
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("a prompt worth titling"),
            "an emptied name falls back to the first user text, not to the older name"
        );
    }

    /// pi's `edit` writes a one-line receipt into `content` and the real unified
    /// diff into `details.patch`. Surfacing the receipt made an edit whose LIVE
    /// card renders a full diff collapse to a sentence once reopened.
    #[test]
    fn edit_result_surfaces_the_unified_patch() {
        let id = "patch-0001";
        let patch = "--- src/a.ts\n+++ src/a.ts\n@@ -1,3 +1,3 @@\n ctx\n-old\n+new\n";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"assistant","model":"m","content":[
                         {"type":"toolCall","id":"c1","name":"edit","arguments":{"path":"src/a.ts"}}]}}),
                json!({"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"toolResult","toolCallId":"c1","toolName":"edit","isError":false,
                         "content":[{"type":"text","text":"Successfully replaced 1 block(s) in src/a.ts."}],
                         "details":{"diff":"-1 old\n+1 new","patch":patch,"firstChangedLine":2}}}),
            ],
            id,
        );
        let output = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => output_preview.clone(),
                _ => None,
            })
            .expect("a tool result");
        assert_eq!(output, patch, "the unified patch replaces pi's receipt");
    }

    /// A `details.patch` that is not a unified diff must NOT displace pi's own
    /// text — the swap is only worth doing when the renderer can parse it.
    #[test]
    fn non_diff_details_patch_leaves_the_text_alone() {
        let id = "patch-0002";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"toolResult","toolCallId":"c1","toolName":"edit","isError":false,
                         "content":[{"type":"text","text":"the real output"}],
                         "details":{"patch":"not a diff at all"}}}),
            ],
            id,
        );
        let output = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => output_preview.clone(),
                _ => None,
            })
            .expect("a tool result");
        assert_eq!(output, "the real output");
    }

    /// `read` of a picture returns `[{type:"text"},{type:"image",data,mimeType}]`,
    /// and a user can attach one the same way. Both used to be dropped, leaving
    /// only pi's "Read image file […]" placeholder.
    #[test]
    fn images_survive_in_prompts_and_tool_results() {
        let id = "image-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"user","content":[
                         {"type":"text","text":"look at this"},
                         {"type":"image","data":"QUJD","mimeType":"image/jpeg"}]}}),
                json!({"type":"message","id":"m2","parentId":"m1","timestamp":"2026-06-27T10:00:02.000Z",
                       "message":{"role":"toolResult","toolCallId":"c1","toolName":"read","isError":false,
                         "content":[
                           {"type":"text","text":"Read image file [image/png]"},
                           {"type":"image","data":"REVG","mimeType":"image/png"}]}}),
            ],
            id,
        );
        let prompt_image = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::Image {
                    data, mime_type, ..
                } => Some((data.clone(), mime_type.clone())),
                _ => None,
            })
            .expect("the attached image");
        assert_eq!(prompt_image, ("QUJD".to_string(), "image/jpeg".to_string()));

        let result_images = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult { images, .. } if !images.is_empty() => {
                    Some(images.clone())
                }
                _ => None,
            })
            .expect("the read image");
        assert_eq!(result_images.len(), 1);
        assert_eq!(result_images[0].data, "REVG");
        assert_eq!(result_images[0].mime_type, "image/png");
    }

    /// REGRESSION: `exitCode` is `number | undefined` — an interrupted run never
    /// gets one — so defaulting a missing code to `0` painted a Ctrl-C'd command
    /// as a success. The truncation notice keeps a prefix from reading as the
    /// whole output.
    #[test]
    fn cancelled_and_truncated_bash_executions_are_marked() {
        let id = "bash-0002";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"bashExecution","id":"b1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "command":"sleep 100","output":"partial","cancelled":true,"truncated":true,
                       "fullOutputPath":"/tmp/pi-out.txt"}),
            ],
            id,
        );
        let (output, is_error) = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    output_preview,
                    is_error,
                    ..
                } => Some((output_preview.clone().unwrap_or_default(), *is_error)),
                _ => None,
            })
            .expect("the bash result");
        assert!(is_error, "a cancelled run is not a success");
        assert!(output.contains("partial"), "the output is kept: {output}");
        assert!(output.contains("[cancelled]"), "got: {output}");
        assert!(output.contains("/tmp/pi-out.txt"), "got: {output}");
    }

    /// A clean run stays clean — no notices, no error.
    #[test]
    fn successful_bash_execution_is_untouched() {
        let id = "bash-0003";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"bashExecution","id":"b1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "command":"echo hi","output":"hi","exitCode":0,"cancelled":false,"truncated":false}),
            ],
            id,
        );
        let (output, is_error) = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    output_preview,
                    is_error,
                    ..
                } => Some((output_preview.clone().unwrap_or_default(), *is_error)),
                _ => None,
            })
            .expect("the bash result");
        assert!(!is_error);
        assert_eq!(output, "hi");
    }

    /// `stopReason: "error"` is the only trace a failed provider call leaves; its
    /// content is usually empty, so the turn used to render blank or vanish.
    #[test]
    fn errored_assistant_turn_surfaces_the_error() {
        let id = "error-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"message","id":"m1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "message":{"role":"assistant","model":"m","stopReason":"error",
                         "errorMessage":"429 rate limited","content":[]}}),
            ],
            id,
        );
        let texts = text_blocks(&detail);
        assert!(
            texts.iter().any(|t| t.contains("429 rate limited")),
            "got: {texts:?}"
        );
    }

    /// A compaction renders through the same provider-neutral pair every other
    /// agent's compaction uses (`_meta.contextCompaction` + a settled result).
    #[test]
    fn compaction_becomes_the_shared_divider_pair() {
        let id = "compaction-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"compaction","id":"c1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "summary":"earlier work","tokensBefore":50000}),
            ],
            id,
        );
        let meta = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name, meta, ..
                } if tool_name == "context_compaction" => meta.clone(),
                _ => None,
            })
            .expect("the compaction ToolUse");
        assert_eq!(meta.pointer("/contextCompaction/version"), Some(&json!(1)));
        assert_eq!(
            meta.pointer("/contextCompaction/preTokens"),
            Some(&json!(50000))
        );
        assert_eq!(
            meta.pointer("/contextCompaction/trigger"),
            Some(&json!("automatic"))
        );
        assert!(
            detail.turns.iter().flat_map(|t| &t.blocks).any(|b| matches!(
                b,
                ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "c1"
            )),
            "the pair must settle or the card reads as still running"
        );
    }

    /// `/tree`'s branch recap and a displayed extension message are conversation,
    /// not bookkeeping — both become System turns.
    #[test]
    fn branch_summary_and_custom_message_become_system_turns() {
        let id = "system-0001";
        let detail = parse_one(
            &[
                header(id),
                json!({"type":"branch_summary","id":"b1","parentId":null,"timestamp":"2026-06-27T10:00:01.000Z",
                       "fromId":"x","summary":"explored approach A"}),
                json!({"type":"custom_message","id":"c1","parentId":"b1","timestamp":"2026-06-27T10:00:02.000Z",
                       "customType":"my-ext","content":"injected note","display":true}),
                json!({"type":"custom_message","id":"c2","parentId":"c1","timestamp":"2026-06-27T10:00:03.000Z",
                       "customType":"my-ext","content":"hidden note","display":false}),
            ],
            id,
        );
        let system: Vec<String> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::System))
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert!(system.iter().any(|t| t == "explored approach A"));
        assert!(system.iter().any(|t| t == "injected note"));
        assert!(
            !system.iter().any(|t| t == "hidden note"),
            "`display: false` is the extension asking to stay hidden"
        );
    }

    /// pi-acp resolves `<agentDir>/settings.json` → `sessionDir` before falling
    /// back to `<agentDir>/sessions`, so a user who sets it kept a pi that
    /// resumed fine and a codeg history list that was permanently empty.
    #[test]
    fn settings_json_session_dir_is_honored() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let home = PathBuf::from(absolute_path("home/demo"));
        // Serialized, never hand-written: a Windows path's `\` is not a legal
        // JSON escape, and an unparseable file falls through to the default.
        let write_settings = |session_dir: &str| {
            std::fs::write(
                agent_dir.join("settings.json"),
                serde_json::to_string(&json!({ "sessionDir": session_dir })).expect("json"),
            )
            .expect("settings");
        };

        // Absolute.
        write_settings(&absolute_path("srv/pi-sessions"));
        assert_eq!(
            resolve_pi_sessions_dir_from(
                None,
                Some(agent_dir.clone().into_os_string()),
                Some(home.clone()),
            ),
            PathBuf::from(absolute_path("srv/pi-sessions")),
        );

        // `~`-rooted.
        write_settings("~/pi-sessions");
        assert_eq!(
            resolve_pi_sessions_dir_from(
                None,
                Some(agent_dir.clone().into_os_string()),
                Some(home.clone()),
            ),
            home.join("pi-sessions"),
        );

        // The env var still outranks it.
        assert_eq!(
            resolve_pi_sessions_dir_from(
                Some(OsString::from(absolute_path("env/sessions"))),
                Some(agent_dir.clone().into_os_string()),
                Some(home),
            ),
            PathBuf::from(absolute_path("env/sessions")),
        );
    }

    /// REGRESSION: a RELATIVE `sessionDir` must fall through to the default.
    ///
    /// pi's `normalizePath` leaves a relative value relative, and the pi process
    /// runs with the ACP session's WORKSPACE as its cwd (pi-acp's
    /// `PiRpcProcess.spawn` passes `cwd: params.cwd`) — so pi's own documented
    /// example, `{"sessionDir": ".pi/sessions"}`, writes to
    /// `<workspace>/.pi/sessions`, which this parser cannot name. Resolving it
    /// against the agent dir pointed at a directory nobody writes to AND shadowed
    /// the default, costing the user the history pi had already written to
    /// `<agent_dir>/sessions`.
    #[test]
    fn relative_settings_session_dir_falls_back_to_the_default() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let default = agent_dir.join("sessions");

        for relative in [".pi/sessions", "custom/sessions", "./sessions", "~other/x"] {
            std::fs::write(
                agent_dir.join("settings.json"),
                serde_json::to_string(&json!({ "sessionDir": relative })).expect("json"),
            )
            .expect("settings");
            assert_eq!(
                resolve_pi_sessions_dir_from(
                    None,
                    Some(agent_dir.clone().into_os_string()),
                    Some(PathBuf::from("/home/demo")),
                ),
                default,
                "relative sessionDir {relative:?} must not shadow the default"
            );
        }
    }

    /// A DRIVE-relative `sessionDir` falls through for the same reason a plain
    /// relative one does: `\srv\x` (and `/srv/x`) carries a root but no drive
    /// prefix, so Windows resolves it against whatever drive the pi process's cwd
    /// sits on — and that cwd is the per-session workspace pi-acp passes. Widening
    /// the gate from `is_absolute` to `has_root` would name a directory codeg
    /// cannot know AND shadow the history in `<agent_dir>\sessions`.
    #[test]
    #[cfg(windows)]
    fn drive_relative_settings_session_dir_falls_back_to_the_default() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let default = agent_dir.join("sessions");

        for rooted in [r"\srv\pi-sessions", "/srv/pi-sessions"] {
            std::fs::write(
                agent_dir.join("settings.json"),
                serde_json::to_string(&json!({ "sessionDir": rooted })).expect("json"),
            )
            .expect("settings");
            assert_eq!(
                resolve_pi_sessions_dir_from(
                    None,
                    Some(agent_dir.clone().into_os_string()),
                    Some(PathBuf::from(absolute_path("home/demo"))),
                ),
                default,
                "drive-relative sessionDir {rooted:?} must not shadow the default"
            );
        }
    }

    /// pi expands a tilde only for a bare `~` and a `~/` prefix
    /// (`normalizePath`); `~other/path` is an ordinary relative path to pi, not
    /// the home of a user called `other`. Applied to both env overrides, which pi
    /// reads through `expandTildePath`.
    #[test]
    fn tilde_expansion_matches_pi_normalize_path() {
        let home = PathBuf::from("/home/demo");
        assert_eq!(expand_pi_tilde("~", Some(&home)), home);
        assert_eq!(
            expand_pi_tilde("~/pi-sessions", Some(&home)),
            home.join("pi-sessions")
        );
        assert_eq!(
            expand_pi_tilde("~other/path", Some(&home)),
            PathBuf::from("~other/path"),
            "not a tilde path to pi — left verbatim"
        );
        assert_eq!(
            expand_pi_tilde("/abs/path", Some(&home)),
            PathBuf::from("/abs/path")
        );
        assert_eq!(
            expand_pi_tilde("~/x", None),
            PathBuf::from("~/x"),
            "no home to expand against"
        );

        // The env overrides go through it too.
        assert_eq!(
            resolve_pi_sessions_dir_from(Some(OsString::from("~/env-sessions")), None, Some(home)),
            PathBuf::from("/home/demo/env-sessions"),
        );
    }

    /// A settings file that is missing, unreadable as JSON, or carries no usable
    /// `sessionDir` must fall through to the default rather than to nothing.
    #[test]
    fn unusable_settings_json_falls_back_to_default() {
        let dir = tempdir().expect("tempdir");
        let agent_dir = dir.path().join("agent");
        std::fs::create_dir_all(&agent_dir).expect("agent dir");
        let default = agent_dir.join("sessions");

        for contents in ["{ not json", "[]", "{}", r#"{"sessionDir": "  "}"#] {
            std::fs::write(agent_dir.join("settings.json"), contents).expect("settings");
            assert_eq!(
                resolve_pi_sessions_dir_from(
                    None,
                    Some(agent_dir.clone().into_os_string()),
                    Some(PathBuf::from("/home/demo")),
                ),
                default,
                "contents: {contents}"
            );
        }
    }
}
