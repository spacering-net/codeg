use std::ffi::OsString;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use serde_json::Value;

use crate::models::{
    AgentExecutionStats, AgentToolCall, AgentType, ContentBlock, ConversationDetail,
    ConversationSummary, MessageTurn, TurnRole, TurnUsage,
};
use crate::acp::connection::grok_failed_compaction_meta;
use crate::acp::types::PromptInputBlock;
use crate::parsers::claude::BACKGROUND_TASK_MARKER;
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, is_safe_subagent_id, merge_context_window_stats,
    relocate_orphaned_tool_results, structurize_read_tool_output, title_from_user_text,
    truncate_str, AgentParser, ParseError,
};

/// Cap for a single tool result / tool input preview stored on a turn. Grok's
/// `tool_call_update.content` is **cumulative** (each update carries the whole
/// output so far), and long-running commands can emit tens of KB — bound it so
/// a single noisy command can't bloat a conversation detail payload.
const GROK_TOOL_OUTPUT_CAP: usize = 100_000;
const GROK_TOOL_INPUT_CAP: usize = 8_000;

/// Budget for a serialized `TaskOutput` envelope (see `grok_task_output_envelope`).
/// Deliberately below the live path's `MAX_SINGLE_EMIT_BYTES` (64 KiB, see
/// `acp::connection`): the envelope is JSON the frontend parses, and the live
/// emitter truncates from the head with a marker — which would corrupt it. Both
/// paths share this function, so a background command's output is capped here
/// rather than shredded downstream.
const GROK_TASK_OUTPUT_CAP: usize = 48 * 1024;

/// Tool name the parser assigns to grok's native `ask_user_question` (from its
/// `_meta["x.ai/tool"].name`). Used to find the ask ToolResults whose answer must
/// be recovered from `chat_history.jsonl` (see `inject_grok_ask_answers`).
const GROK_ASK_TOOL_NAME: &str = "ask_user_question";

/// Grok's native sub-agent launcher (`_meta["x.ai/tool"].name`). Rewritten to
/// `"Agent"` at parse time — the same parser-side rename opencode/codex/
/// codebuddy do — so the frontend routes the call to the dedicated
/// `AgentToolCallPart` instead of a generic tool card. The `rawInput` already
/// carries the standard `{description, prompt, subagent_type, …}` shape, so
/// only the name changes (mirrors `parsers/codebuddy.rs`).
const GROK_SPAWN_SUBAGENT_TOOL_NAME: &str = "spawn_subagent";

/// Prefix of the `spawn_subagent(background: true)` completion ack ("Subagent
/// started in background.\nsubagent_id: …" — verified against grok 0.2.99 and
/// the 0.2.112 binary's template). Internal metadata text never meant for
/// users; rewritten into a [`BACKGROUND_TASK_MARKER`] payload like Claude's
/// async-launch acks (see `attach_subagent_stats`).
const GROK_SUBAGENT_STARTED_ACK_PREFIX: &str = "Subagent started in background";

/// Cap for a subagent's final output folded into the background-task marker /
/// a nested tool-call preview. Mirrors `claude.rs::BACKGROUND_RESULT_MAX_CHARS`
/// and the 500-char nested previews of `claude.rs`/`codebuddy.rs`.
const GROK_SUBAGENT_RESULT_CAP: usize = 16_000;
const GROK_SUBAGENT_PREVIEW_CAP: usize = 500;

/// Resolve Grok's data home, honoring `GROK_HOME`, else `~/.grok` (mirrors the
/// CLI's own `GROK_HOME` override). The transcript store lives under the
/// `sessions/` subdirectory of this path.
pub(crate) fn resolve_grok_home_dir() -> PathBuf {
    resolve_grok_home_from(std::env::var_os("GROK_HOME"), dirs::home_dir())
}

fn resolve_grok_home_from(grok_home_env: Option<OsString>, home_dir: Option<PathBuf>) -> PathBuf {
    grok_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".grok"))
}

/// The context window Grok itself assigns to `model`, read from its own on-disk
/// catalog — the authoritative number, and the same one the live ACP path gets
/// from `availableModels[]._meta.totalContextTokens` (see
/// `acp::connection::parse_grok_model_specs`).
///
/// Two sources, in precedence order:
///   1. `$GROK_HOME/models_cache.json` — the catalog Grok fetches from its API
///      and rewrites on every model refresh (`models.<id>.info.context_window`).
///   2. `$GROK_HOME/config.toml` — a BYO endpoint's `[model.<id>].context_window`
///      (see `commands::acp::apply_grok_custom_model`), which never appears in
///      the fetched catalog.
///
/// `None` when neither names the model, and the caller falls back to
/// [`infer_context_window_max_tokens`]'s name heuristic. Reading these beats
/// guessing from the model id: a new Grok model, or a self-hosted one, gets its
/// real window instead of the conservative default.
///
/// Shared with the live path (`acp::connection::grok_current_model_context_window`)
/// so a session's ring reads the same denominator whether it comes from the wire
/// or from re-parsed history.
pub(crate) fn grok_catalog_context_window(home: &Path, model: &str) -> Option<u64> {
    let read = |name: &str| fs::read_to_string(home.join(name)).ok();
    read("models_cache.json")
        .and_then(|raw| grok_context_window_from_models_cache(&raw, model))
        .or_else(|| {
            read("config.toml").and_then(|raw| grok_context_window_from_config_toml(&raw, model))
        })
}

/// `models.<id>.info.context_window` from Grok's `models_cache.json`. Non-positive
/// / missing / malformed → `None`.
fn grok_context_window_from_models_cache(raw: &str, model: &str) -> Option<u64> {
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("models")?
        .get(model)?
        .get("info")?
        .get("context_window")?
        .as_u64()
        .filter(|window| *window > 0)
}

/// `[model.<id>].context_window` from Grok's `config.toml` — a BYO endpoint's
/// declared window. Mirrors the read `commands::acp::parse_grok_settings` does
/// for the settings panel. Non-positive / missing / malformed → `None`.
fn grok_context_window_from_config_toml(raw: &str, model: &str) -> Option<u64> {
    raw.parse::<toml::Table>()
        .ok()?
        .get("model")?
        .as_table()?
        .get(model)?
        .as_table()?
        .get("context_window")?
        .as_integer()
        .filter(|window| *window > 0)
        .map(|window| window as u64)
}

/// Grok Build (xAI) stores each conversation as a **directory-per-session**,
/// grouped by the (percent-encoded) working directory:
///
/// ```text
/// $GROK_HOME/                        (default ~/.grok)
/// └── sessions/
///     └── <percent-encoded-cwd>/     # e.g. %2FUsers%2Fme%2Fproj ; or slug+hash
///         │                          #   with a sibling `.cwd` file when >255 bytes
///         └── <session-uuid>/        # UUIDv7
///             ├── summary.json       # metadata index (see below)
///             ├── updates.jsonl      # ACP session/update stream — the conversation
///             ├── chat_history.jsonl # raw model messages (not read here)
///             ├── plan.json          # TODO state
///             ├── terminal/<id>.log  # full background-command output
///             └── subagents/<id>/    # per-spawned-subagent snapshot
///                 ├── meta.json      #   parent/child link, status, counts
///                 └── output.json    #   final output text
/// ```
///
/// A `spawn_subagent` child is ALSO a full sibling `<session-uuid>/` directory
/// (its `summary.json` says `session_kind: "subagent"`, `agent_name: <type>`);
/// a `cwd`/worktree-isolated child lands under a different group. Children are
/// excluded from `list_conversations` and instead surface as nested
/// `agent_stats` on the parent's Agent card (see `attach_subagent_stats`).
///
/// `base_dir` points at the `sessions/` directory.
///
/// `summary.json` is the authoritative metadata source: `info.cwd`, timestamps,
/// `current_model_id`, `generated_title`/`session_summary`, `head_branch`, and
/// message counts. We read the working directory from here rather than decoding
/// the group directory name (which may be a slug+hash for long paths).
///
/// `updates.jsonl` is a newline-delimited **ACP `session/update` stream** — each
/// line is a JSON-RPC notification `{"method": "session/update" |
/// "_x.ai/session/update", "params": {"sessionId", "update": {…}}, "timestamp":
/// <unix secs>}`. The `update.sessionUpdate` discriminator is one of:
///
/// - `user_message_chunk` — a user prompt (`content.text`; `_meta.promptIndex`,
///   `_meta.modelId`). Starts a new user turn.
/// - `agent_message_chunk` — a complete assistant text segment (`content.text`).
///   NOT a streaming delta; a turn can contain several, interleaved with tools.
/// - `agent_thought_chunk` — a reasoning segment (`content.text`).
/// - `tool_call` — a tool invocation (`toolCallId`, `title`, `rawInput`,
///   `_meta["x.ai/tool"].{name,kind,label}`).
/// - `tool_call_update` — cumulative status/output for a call (`toolCallId`,
///   `status` ∈ {in_progress, completed, failed}, `content[]`, `rawOutput`).
///   The last update per `toolCallId` holds the full output.
/// - `task_backgrounded` / `task_completed` — a command that was moved to the
///   background. Both are ignored here (the launch call and the polls already
///   carry everything rendered); note `task_backgrounded` is the ONLY event
///   pairing `tool_call_id` with `task_id`, since `task_completed.task_snapshot`
///   is keyed by `task_id` alone.
/// - `turn_completed` — closes the current assistant turn (`stop_reason`).
///
/// Turn model: one user turn per `user_message_chunk`, then a single assistant
/// turn accumulating every reasoning/text/tool block until `turn_completed`
/// (or the next user prompt), preserving interleave order.
pub struct GrokParser {
    base_dir: PathBuf,
}

impl GrokParser {
    pub fn new() -> Self {
        Self {
            base_dir: resolve_grok_home_dir().join("sessions"),
        }
    }

    /// Construct a parser pointed at an explicit `sessions` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Grok's data home — the parent of the `sessions/` tree this parser reads,
    /// which is where its `models_cache.json` / `config.toml` live. Derived from
    /// `base_dir` rather than re-resolving `GROK_HOME` so a fixture-scoped parser
    /// stays inside its fixture instead of reading the host's real `~/.grok`.
    fn grok_home(&self) -> PathBuf {
        self.base_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.base_dir.clone())
    }

    fn build_summary(&self, session_dir: &Path, session_id: &str) -> Option<ConversationSummary> {
        // Cheap gate BEFORE the full updates.jsonl parse: a `spawn_subagent`
        // child is a complete sibling session directory whose `summary.json`
        // carries `session_kind: "subagent"`. Its transcript belongs INSIDE the
        // parent conversation's Agent card (see `attach_subagent_stats`), not in
        // the sidebar as a stray top-level conversation — mirroring how Claude
        // Code / CodeBuddy subagent transcripts never surface as sessions.
        // `get_conversation` deliberately keeps resolving the child by id.
        let meta = read_summary_json(session_dir);
        if meta.session_kind.as_deref() == Some("subagent") {
            return None;
        }
        let parsed = parse_updates(&session_dir.join("updates.jsonl"));
        // A session that never produced any user/assistant/tool content (only
        // metadata) is treated as empty — matches the "metadata-only is not
        // listed" rule of the other parsers.
        if parsed.content_events == 0 {
            return None;
        }
        Some(self.summary_from(session_id, &meta, &parsed))
    }

    fn summary_from(
        &self,
        session_id: &str,
        meta: &SummaryMeta,
        parsed: &ParsedUpdates,
    ) -> ConversationSummary {
        let cwd = meta.cwd.clone();
        let folder_name = cwd.as_deref().map(folder_name_from_path);
        let title = meta
            .title
            .clone()
            .or_else(|| parsed.first_user_text.as_deref().map(title_from_user_text));
        ConversationSummary {
            id: session_id.to_string(),
            agent_type: AgentType::Grok,
            folder_path: cwd,
            folder_name,
            title,
            started_at: meta.created_at.or(parsed.first_ts).unwrap_or_else(Utc::now),
            ended_at: meta.updated_at.or(parsed.last_ts),
            message_count: parsed.turns.len() as u32,
            model: meta.model.clone().or_else(|| parsed.model.clone()),
            git_branch: meta.git_branch.clone(),
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }
    }

    fn build_detail(&self, session_dir: &Path, session_id: &str) -> ConversationDetail {
        let mut parsed = parse_updates(&session_dir.join("updates.jsonl"));
        let meta = read_summary_json(session_dir);

        // Defensive normalization shared with the other parsers: hoist any tool
        // result that landed outside its call's turn, and structurize file-read
        // output. Harmless no-ops when nothing matches.
        relocate_orphaned_tool_results(&mut parsed.turns);
        structurize_read_tool_output(&mut parsed.turns);

        // Sub-agent enrichment: pair each `spawn_subagent` call with its
        // `subagent_spawned`/`subagent_finished` lifecycle, load the child
        // session's own transcript into `agent_stats`, and fold a background
        // launch's ack text into the structured background-task marker.
        self.attach_subagent_stats(session_dir, &mut parsed);

        // Grok resolves its native `ask_user_question` over the `_x.ai/ask_user_question`
        // ext round-trip and never writes the answer into `updates.jsonl`, so the
        // parsed ToolResult is empty and the `AskQuestionResultCard` shows "未选择".
        // Recover the user's picks from `chat_history.jsonl` (the model-facing
        // transcript, which DOES record the answer as a `tool_result`) and inject
        // them as the tool output. No-op when the file is absent or there's no ask.
        inject_grok_ask_answers(&mut parsed.turns, &session_dir.join("chat_history.jsonl"));

        // Fill assistant turns that carried no in-stream `modelId` with the
        // session model (summary `current_model_id`, else the first in-stream
        // model) so the message footer shows the model even for older/sparse
        // transcripts.
        if let Some(session_model) = meta.model.clone().or_else(|| parsed.model.clone()) {
            for turn in &mut parsed.turns {
                if matches!(turn.role, TurnRole::Assistant) && turn.model.is_none() {
                    turn.model = Some(session_model.clone());
                }
            }
        }

        // Grok times a turn from its own update spans; this reaches only the
        // turns whose updates carried no usable timestamps.
        backfill_turn_durations(&mut parsed.turns, &[]);

        // Grok sends no ACP `usage_update`, so the live meter stays empty; derive
        // the context ring here instead. The "used" figure is Grok's own
        // `params._meta.totalTokens` (`ParsedUpdates::context_tokens`) — NOT the
        // turn usage totals, which are the token SPEND and run to many multiples
        // of the resident context once a turn makes several model calls. Pair it
        // with the model's window so the status bar shows the ring (mirrors
        // gemini/kimi/opencode — the bare `compute_session_stats` leaves the
        // context fields `None`).
        let session_model = meta.model.as_deref().or(parsed.model.as_deref());
        // Grok publishes each model's real window in its own on-disk catalog, so
        // read that first and keep the id-shaped guess only as the fallback for
        // a model neither file names.
        let context_window = session_model.and_then(|model| {
            grok_catalog_context_window(&self.grok_home(), model)
                .or_else(|| infer_context_window_max_tokens(Some(model)))
        });
        let session_stats = merge_context_window_stats(
            compute_session_stats(&parsed.turns),
            parsed.context_tokens,
            context_window,
        );
        let summary = self.summary_from(session_id, &meta, &parsed);

        ConversationDetail {
            summary,
            turns: parsed.turns,
            session_stats,
            transcript_watermark: None,
        }
    }

    /// Locate the `<session-uuid>` directory matching `conversation_id` across
    /// the `base_dir/<group>/` buckets (two shallow levels).
    fn find_session_dir(&self, conversation_id: &str) -> Option<PathBuf> {
        for group in read_subdirs(&self.base_dir) {
            let candidate = group.join(conversation_id);
            if candidate.join("updates.jsonl").is_file() {
                return Some(candidate);
            }
        }
        None
    }

    /// Enrich each `spawn_subagent` ("Agent") call with its child's execution:
    ///
    /// * `agent_stats` — nested tool calls parsed from the CHILD session's own
    ///   `updates.jsonl` (a subagent is a full sibling session directory; a
    ///   worktree-isolated child lands under a different cwd group, hence the
    ///   `find_session_dir` fallback), plus totals from `subagent_finished`.
    /// * a background launch's "Subagent started in background…" ack —
    ///   internal metadata text — becomes the same [`BACKGROUND_TASK_MARKER`]
    ///   payload Claude's async launches use, so the card renders the settled
    ///   status + final output instead of the raw ack.
    /// * a blocking spawn interrupted before its completion frame still gets
    ///   the child's final output from the lifecycle event.
    ///
    /// Pairing walks spawn calls and `subagent_spawned` events in stream order
    /// (grok emits them in call order; the live path pairs the same way). The
    /// background ack's `subagent_id: …` line, when present, overrides the
    /// positional pick — and an errored spawn (depth-limit, config) consumes no
    /// lifecycle so later pairs can't shift.
    fn attach_subagent_stats(&self, session_dir: &Path, parsed: &mut ParsedUpdates) {
        if parsed.spawn_call_ids.is_empty() {
            return;
        }
        let lifecycles = std::mem::take(&mut parsed.subagents);
        let mut consumed = vec![false; lifecycles.len()];
        for call_id in &parsed.spawn_call_ids {
            let Some((output_preview, is_error)) =
                find_tool_result(&parsed.turns, call_id).map(|r| match r {
                    ContentBlock::ToolResult {
                        output_preview,
                        is_error,
                        ..
                    } => (output_preview.clone(), *is_error),
                    _ => (None, false),
                })
            else {
                continue;
            };
            let ack_id = output_preview.as_deref().and_then(subagent_id_from_ack);
            let lifecycle_idx = match &ack_id {
                Some(id) => lifecycles.iter().position(|l| &l.subagent_id == id),
                // A spawn that failed outright never produced a lifecycle;
                // consuming one here would shift every later pair.
                None if is_error => None,
                None => consumed.iter().position(|used| !used),
            };
            let Some(idx) = lifecycle_idx else { continue };
            if consumed[idx] {
                continue;
            }
            consumed[idx] = true;
            let lifecycle = &lifecycles[idx];

            let stats = self.subagent_stats(session_dir, lifecycle);
            let marker = output_preview
                .as_deref()
                .is_some_and(|o| o.trim_start().starts_with(GROK_SUBAGENT_STARTED_ACK_PREFIX))
                .then(|| background_marker_payload(lifecycle));
            apply_subagent_result(&mut parsed.turns, call_id, stats, marker, lifecycle);
        }
    }

    /// Build the `agent_stats` for one subagent: totals from the lifecycle
    /// (`subagent_finished`), the nested tool-call list from the child
    /// session's transcript, gaps filled from the on-disk
    /// `subagents/<id>/meta.json` snapshot (covers a parent transcript cut
    /// short before `subagent_finished` landed).
    fn subagent_stats(
        &self,
        session_dir: &Path,
        lifecycle: &GrokSubagentLifecycle,
    ) -> Option<AgentExecutionStats> {
        let disk_meta = read_subagent_meta(session_dir, &lifecycle.subagent_id);
        let child_id = lifecycle
            .child_session_id
            .as_deref()
            .or(disk_meta.as_ref().and_then(|m| m.child_session_id.as_deref()))
            .unwrap_or(&lifecycle.subagent_id);
        let tool_calls = if is_safe_subagent_id(child_id) {
            // The child usually sits in the SAME cwd group as the parent; a
            // `cwd`/worktree-isolated child lands elsewhere, so fall back to
            // the full two-level scan.
            let child_dir = session_dir
                .parent()
                .map(|group| group.join(child_id))
                .filter(|dir| dir.join("updates.jsonl").is_file())
                .or_else(|| self.find_session_dir(child_id));
            child_dir
                .map(|dir| subagent_tool_calls(&dir.join("updates.jsonl")))
                .unwrap_or_default()
        } else {
            Vec::new()
        };

        let status = lifecycle
            .status
            .clone()
            .or_else(|| disk_meta.as_ref().and_then(|m| m.status.clone()));
        let duration_ms = lifecycle
            .duration_ms
            .or(disk_meta.as_ref().and_then(|m| m.duration_ms));
        let tool_count = lifecycle
            .tool_calls
            .or(disk_meta.as_ref().and_then(|m| m.tool_calls))
            .or_else(|| u32::try_from(tool_calls.len()).ok().filter(|n| *n > 0));
        if tool_calls.is_empty() && status.is_none() && duration_ms.is_none() && tool_count.is_none()
        {
            return None;
        }
        Some(AgentExecutionStats {
            agent_type: lifecycle.subagent_type.clone(),
            status,
            total_duration_ms: duration_ms,
            total_tokens: lifecycle.tokens_used,
            total_tool_use_count: tool_count,
            read_count: None,
            search_count: None,
            bash_count: None,
            edit_file_count: None,
            lines_added: None,
            lines_removed: None,
            other_tool_count: None,
            tool_calls,
            // Grok runs every sub-agent as a full session of its own, so the
            // card can offer to open the child's transcript. Only hand over an
            // id that passed the path-traversal guard — it is used to look up a
            // session directory. `get_conversation` resolves it even though
            // `build_summary` keeps sub-agent sessions out of the sidebar.
            child_session_id: is_safe_subagent_id(child_id).then(|| child_id.to_string()),
        })
    }
}

impl Default for GrokParser {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentParser for GrokParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        if !self.base_dir.is_dir() {
            return Ok(conversations);
        }
        for group in read_subdirs(&self.base_dir) {
            for session_dir in read_subdirs(&group) {
                let Some(session_id) = session_dir
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                else {
                    continue;
                };
                if let Some(summary) = self.build_summary(&session_dir, &session_id) {
                    conversations.push(summary);
                }
            }
        }
        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let session_dir = self
            .find_session_dir(conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;
        Ok(self.build_detail(&session_dir, conversation_id))
    }
}

// ---------------------------------------------------------------------------
// summary.json
// ---------------------------------------------------------------------------

#[derive(Default)]
struct SummaryMeta {
    cwd: Option<String>,
    title: Option<String>,
    model: Option<String>,
    git_branch: Option<String>,
    created_at: Option<DateTime<Utc>>,
    updated_at: Option<DateTime<Utc>>,
    /// `"primary"` for a normal session, `"subagent"` for a `spawn_subagent`
    /// child (grok 0.2.9x+ writes this discriminator; absent on older files).
    session_kind: Option<String>,
}

fn read_summary_json(session_dir: &Path) -> SummaryMeta {
    let Ok(raw) = fs::read_to_string(session_dir.join("summary.json")) else {
        return SummaryMeta::default();
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return SummaryMeta::default();
    };
    let non_empty = |s: &str| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    };
    SummaryMeta {
        cwd: v
            .pointer("/info/cwd")
            .and_then(Value::as_str)
            .and_then(non_empty),
        // `generated_title` is the model-generated title; `session_summary` is
        // the fallback one-liner. Prefer the title.
        title: v
            .get("generated_title")
            .and_then(Value::as_str)
            .and_then(non_empty)
            .or_else(|| {
                v.get("session_summary")
                    .and_then(Value::as_str)
                    .and_then(non_empty)
            }),
        model: v
            .get("current_model_id")
            .and_then(Value::as_str)
            .and_then(non_empty),
        git_branch: v
            .get("head_branch")
            .and_then(Value::as_str)
            .and_then(non_empty),
        created_at: v
            .get("created_at")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339),
        updated_at: v
            .get("updated_at")
            .and_then(Value::as_str)
            .and_then(parse_rfc3339),
        session_kind: v
            .get("session_kind")
            .and_then(Value::as_str)
            .and_then(non_empty),
    }
}

fn parse_rfc3339(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

// ---------------------------------------------------------------------------
// updates.jsonl
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ParsedUpdates {
    turns: Vec<MessageTurn>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    content_events: u32,
    first_user_text: Option<String>,
    /// Model discovered in-stream (`user_message_chunk._meta.modelId`); a
    /// fallback when `summary.json` lacks `current_model_id`.
    model: Option<String>,
    /// `spawn_subagent` tool_call ids in encounter order, paired against
    /// `subagents` by `attach_subagent_stats`.
    spawn_call_ids: Vec<String>,
    /// Sub-agent lifecycles observed on the `_x.ai/session/update` stream
    /// (`subagent_spawned` opens one, `subagent_finished` completes it), in
    /// spawn order.
    subagents: Vec<GrokSubagentLifecycle>,
    /// Context-window occupancy: `params._meta.totalTokens` as of the last turn
    /// to state one. Feeds the context ring, and is kept apart from turn `usage`
    /// because the two measure different things — occupancy is what currently
    /// sits in the window, `usage` is what the turn spent getting there.
    context_tokens: Option<u64>,
}

/// One subagent's lifecycle, folded from the parent-stream extension
/// notifications. `subagent_finished` carries the child's FULL final output —
/// the only in-stream source for a background subagent the model never polled.
#[derive(Default)]
struct GrokSubagentLifecycle {
    subagent_id: String,
    /// Distinct from `subagent_id` in principle (`== subagent_id` in every
    /// observed capture); the child session directory is named by this.
    child_session_id: Option<String>,
    subagent_type: Option<String>,
    status: Option<String>,
    output: Option<String>,
    duration_ms: Option<u64>,
    tool_calls: Option<u32>,
    tokens_used: Option<u64>,
}

fn parse_updates(path: &Path) -> ParsedUpdates {
    let Ok(file) = fs::File::open(path) else {
        return ParsedUpdates::default();
    };

    let mut out = ParsedUpdates::default();
    // The in-flight assistant turn, plus a `toolCallId → index-of-its-ToolResult`
    // map scoped to that turn (cleared on every turn boundary).
    let mut assistant: Option<MessageTurn> = None;
    let mut tool_result_idx: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    // Stats for the in-flight turn (tokens/timing/model), applied to the
    // assistant turn when it is finalized. Reset at each turn boundary.
    let mut turn_meta = GrokTurnMeta::default();
    // `promptIndex` of the currently-open user turn. Grok splits one prompt into
    // several `user_message_chunk`s (prose, image, …) sharing a `promptIndex`;
    // this lets consecutive same-prompt chunks merge into a single user turn
    // instead of each opening a new (often empty) one.
    let mut open_user_prompt_index: Option<i64> = None;

    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };

        let ts = v
            .get("timestamp")
            .and_then(Value::as_i64)
            .and_then(|secs| Utc.timestamp_opt(secs, 0).single());
        if let Some(t) = ts {
            if out.first_ts.is_none() {
                out.first_ts = Some(t);
            }
            out.last_ts = Some(t);
        }
        let now = ts.unwrap_or_else(Utc::now);

        let Some(update) = v.pointer("/params/update") else {
            continue;
        };
        let kind = update
            .get("sessionUpdate")
            .and_then(Value::as_str)
            .unwrap_or("");

        // Grok injects its own reminders (a background task finishing, …) as
        // `user_message_chunk`s and marks them `_meta.hideFromScrollback` — its
        // TUI never shows them. Honor the flag: rendered as a user bubble, such a
        // chunk splits one reply into two turns with a raw `<system-reminder>`
        // block wedged between them. Skipped BEFORE the turn-boundary logic below,
        // so a reminder injected mid-turn doesn't cut the open assistant turn
        // either.
        if kind == "user_message_chunk"
            && update
                .pointer("/_meta/hideFromScrollback")
                .and_then(Value::as_bool)
                == Some(true)
        {
            continue;
        }

        // Grok's per-turn stats live in the OUTER `params._meta` (token total +
        // timing) plus `update._meta.modelId`. Accumulate them into `turn_meta`
        // and apply at the turn boundary. A `user_message_chunk` that opens a NEW
        // prompt closes+resets the prior turn's accumulator; a continuation chunk
        // of the SAME prompt (see below) keeps accumulating.
        let params_meta = v.pointer("/params/_meta");
        let update_meta = update.get("_meta");
        // Grok emits each content piece of one prompt (prose, image, …) as its
        // own `user_message_chunk` sharing a `promptIndex`. Merge consecutive
        // user chunks of the same prompt into ONE user turn so a "text + image"
        // prompt renders as a single bubble (matching the live path) rather than
        // a trailing empty/image-only turn. A chunk continues the open user turn
        // when no assistant content has intervened and the `promptIndex` matches
        // (or is absent on either side).
        let user_chunk_continues = kind == "user_message_chunk"
            && assistant.is_none()
            && matches!(out.turns.last(), Some(t) if matches!(t.role, TurnRole::User))
            && update
                .pointer("/_meta/promptIndex")
                .and_then(Value::as_i64)
                .zip(open_user_prompt_index)
                .is_none_or(|(a, b)| a == b);
        if kind == "user_message_chunk" && !user_chunk_continues {
            if let Some(prev) = assistant.as_mut() {
                turn_meta.apply(prev, &mut out.context_tokens);
            }
            flush_assistant(&mut assistant, &mut out.turns, &mut tool_result_idx);
            turn_meta = GrokTurnMeta::default();
        }
        turn_meta.observe(params_meta, update_meta);

        match kind {
            "user_message_chunk" => {
                let input = user_chunk_to_input(update);
                let block = input.as_ref().map(crate::parsers::user_turn_block);
                out.content_events += 1;
                // Title/first-prompt text comes only from PROSE chunks: an image
                // chunk carries no text, and an attachment projects to a
                // `[name](uri)` marker that would make a poor title.
                if let Some(PromptInputBlock::Text { text }) = &input {
                    if out.first_user_text.is_none() && !text.trim().is_empty() {
                        out.first_user_text = Some(text.clone());
                    }
                }
                if out.model.is_none() {
                    out.model = update
                        .pointer("/_meta/modelId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                if user_chunk_continues {
                    // Same prompt: append the block to the open user turn.
                    if let (Some(b), Some(turn)) = (block, out.turns.last_mut()) {
                        turn.blocks.push(b);
                    }
                } else {
                    open_user_prompt_index = update
                        .pointer("/_meta/promptIndex")
                        .and_then(Value::as_i64);
                    out.turns.push(MessageTurn {
                        id: String::new(), // assigned in a final pass
                        role: TurnRole::User,
                        blocks: block.into_iter().collect(),
                        timestamp: now,
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: None,
                    agent_message_id: None,
                    });
                }
            }
            "agent_message_chunk" => {
                out.content_events += 1;
                let text = update_text(update);
                append_text(ensure_assistant(&mut assistant, now), text);
            }
            "agent_thought_chunk" => {
                out.content_events += 1;
                let text = update_text(update);
                append_thinking(ensure_assistant(&mut assistant, now), text);
            }
            "tool_call" => {
                out.content_events += 1;
                let id = str_field(update, "toolCallId");
                // Grok wraps every MCP call in a `use_tool` envelope; peel it so
                // the call is classified/parsed as a direct MCP call (matches the
                // live path, connection.rs::unwrap_grok_use_tool). Native tools —
                // whose args are top-level — pass through unchanged.
                let raw_input = update.get("rawInput");
                let unwrapped = unwrap_use_tool(raw_input);
                let mut tool_name = match unwrapped {
                    Some((name, _)) => name.to_string(),
                    None => update
                        .get("_meta")
                        .and_then(|m| m.get("x.ai/tool"))
                        .and_then(|t| t.get("name"))
                        .and_then(Value::as_str)
                        .or_else(|| update.get("title").and_then(Value::as_str))
                        .unwrap_or("tool")
                        .to_string(),
                };
                // Native sub-agent launch → the dedicated Agent card (see
                // `GROK_SPAWN_SUBAGENT_TOOL_NAME`). Recorded for the
                // lifecycle/stats pairing pass; the MCP-unwrapped branch is
                // untouched (an MCP tool can't be grok's native launcher).
                if unwrapped.is_none() && tool_name == GROK_SPAWN_SUBAGENT_TOOL_NAME {
                    tool_name = "Agent".to_string();
                    if !id.is_empty() {
                        out.spawn_call_ids.push(id.clone());
                    }
                }
                let input_preview = match unwrapped {
                    // Valid-JSON-preserving cap so the delegation card can parse a
                    // long task; native inputs keep the opaque byte-truncation.
                    Some((_, input)) => grok_mcp_input_preview(input),
                    None => tool_input_preview(raw_input),
                };
                let turn = ensure_assistant(&mut assistant, now);
                turn.blocks.push(ContentBlock::ToolUse {
                    tool_use_id: Some(id.clone()),
                    tool_name,
                    input_preview,
                    // Grok is the one agent whose transcript is read WHILE it is
                    // being written (`SubagentSessionDialog` polls a running
                    // `spawn_subagent` child's file), so it is the one agent
                    // that has to say whether a call is still working. The
                    // paired placeholder result below cannot answer that: it
                    // stays `output_preview: None` for an empty completion too.
                    status: grok_line_status(&v, update),
                    meta: None,
                });
                turn.blocks.push(ContentBlock::ToolResult {
                    tool_use_id: Some(id.clone()),
                    output_preview: None,
                    is_error: false,
                    agent_stats: None,
                    images: Vec::new(),
                });
                if !id.is_empty() {
                    tool_result_idx.insert(id, turn.blocks.len() - 1);
                }
            }
            "tool_call_update" => {
                let id = str_field(update, "toolCallId");
                let output = update_tool_output(update);
                let status = grok_line_status(&v, update);
                let failed = status.as_deref() == Some("failed");
                // Cumulative updates: the latest STATED status wins, so a call
                // that settles overwrites its own `pending`; a content-only
                // update states nothing and leaves it standing.
                apply_tool_status(assistant.as_mut(), &tool_result_idx, &id, status.as_deref());
                apply_tool_result(assistant.as_mut(), &tool_result_idx, &id, output, failed);
            }
            "turn_completed" => {
                if let Some(mut turn) = assistant.take() {
                    // The one place Grok states real token spend, scoped to the
                    // prompt this update closes (see `prompt_usage`).
                    turn_meta.usage = update.get("usage").and_then(prompt_usage);
                    turn_meta.apply(&mut turn, &mut out.context_tokens);
                    turn.completed_at = Some(now);
                    out.turns.push(turn);
                }
                turn_meta = GrokTurnMeta::default();
                tool_result_idx.clear();
            }
            // Grok's auto-compaction (`/compact` or threshold-triggered) lands in
            // updates.jsonl on the namespaced `_x.ai/session/update` method as
            // `auto_compact_completed` {tokens_before, tokens_after}. Mirror the
            // live synthesis (connection.rs::map_grok_ext_notification): a completed
            // ToolUse tagged `meta.contextCompaction` so the history path renders the
            // shared ContextCompactionCard with the token delta instead of dropping
            // it. The paired ToolResult keeps the block well-formed (no orphan
            // tool_use). The `/compact` command itself is not recoverable — Grok
            // never persists slash commands as `user_message_chunk`s — so only the
            // compaction OUTCOME shows, not a "/compact" user bubble.
            "auto_compact_completed" => {
                out.content_events += 1;
                let mut meta = serde_json::Map::new();
                meta.insert("contextCompaction".to_string(), Value::Bool(true));
                if let Some(before) = update.get("tokens_before").and_then(Value::as_u64) {
                    meta.insert("tokensBefore".to_string(), before.into());
                }
                if let Some(after) = update.get("tokens_after").and_then(Value::as_u64) {
                    meta.insert("tokensAfter".to_string(), after.into());
                }
                // A stable id from the event id (deterministic across re-parses);
                // the paired blocks are self-contained, so no `tool_result_idx`
                // registration or later update is needed.
                let id = params_meta
                    .and_then(|m| m.get("eventId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("grok-compaction-{}", out.content_events));
                let turn = ensure_assistant(&mut assistant, now);
                turn.blocks.push(ContentBlock::ToolUse {
                    tool_use_id: Some(id.clone()),
                    tool_name: "context_compaction".to_string(),
                    input_preview: None,
                    status: None,
                    meta: Some(Value::Object(meta)),
                });
                turn.blocks.push(ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview: None,
                    is_error: false,
                    agent_stats: None,
                    images: Vec::new(),
                });
            }
            // A failed auto-compaction: the same card in its failed state, as the
            // live mapper renders it (the two share `grok_failed_compaction_meta`,
            // whose `error` is the card's reason). `is_error` on the paired
            // result is what marks the card failed.
            "auto_compact_failed" => {
                out.content_events += 1;
                let id = params_meta
                    .and_then(|m| m.get("eventId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("grok-compaction-{}", out.content_events));
                let turn = ensure_assistant(&mut assistant, now);
                turn.blocks.push(ContentBlock::ToolUse {
                    tool_use_id: Some(id.clone()),
                    tool_name: "context_compaction".to_string(),
                    input_preview: None,
                    status: None,
                    meta: Some(grok_failed_compaction_meta(update)),
                });
                turn.blocks.push(ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview: None,
                    is_error: true,
                    agent_stats: None,
                    images: Vec::new(),
                });
            }
            // Sub-agent lifecycle (namespaced `_x.ai/session/update` method).
            // Metadata, not content — deliberately NOT counted into
            // `content_events` and never a turn boundary. Collected in spawn
            // order for `attach_subagent_stats`.
            "subagent_spawned" => {
                let Some(subagent_id) = update
                    .get("subagent_id")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                out.subagents.push(GrokSubagentLifecycle {
                    subagent_id: subagent_id.to_string(),
                    child_session_id: update
                        .get("child_session_id")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    subagent_type: update
                        .get("subagent_type")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    ..GrokSubagentLifecycle::default()
                });
            }
            "subagent_finished" => {
                let Some(subagent_id) = update.get("subagent_id").and_then(Value::as_str) else {
                    continue;
                };
                // Pair by id; a finished-without-spawned event (defensive —
                // not observed on real streams) still lands as its own entry
                // so its output is not lost.
                let lifecycle = match out
                    .subagents
                    .iter_mut()
                    .find(|l| l.subagent_id == subagent_id)
                {
                    Some(l) => l,
                    None => {
                        out.subagents.push(GrokSubagentLifecycle {
                            subagent_id: subagent_id.to_string(),
                            child_session_id: update
                                .get("child_session_id")
                                .and_then(Value::as_str)
                                .map(str::to_string),
                            ..GrokSubagentLifecycle::default()
                        });
                        out.subagents.last_mut().expect("just pushed")
                    }
                };
                lifecycle.status = update
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                lifecycle.output = update
                    .get("output")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| truncate_str(s, GROK_SUBAGENT_RESULT_CAP));
                lifecycle.duration_ms = update.get("duration_ms").and_then(Value::as_u64);
                lifecycle.tool_calls = update
                    .get("tool_calls")
                    .and_then(Value::as_u64)
                    .and_then(|n| u32::try_from(n).ok());
                lifecycle.tokens_used = update.get("tokens_used").and_then(Value::as_u64);
            }
            // `task_backgrounded` / `task_completed` / plan / other extension
            // updates carry no distinct rendered content beyond what the tool
            // stream already has.
            //
            // In particular `task_completed`'s snapshot is deliberately NOT
            // applied to the launching tool call: Grok reports that CALL as
            // `completed` on the wire (it did start the task), the live path
            // never receives this ext notification at all, and the task's real
            // outcome — command, exit code, output — renders from the
            // `get_command_or_subagent_output` polls (see
            // `grok_task_output_envelope`). Writing the snapshot here would make
            // history contradict live for the same conversation.
            //
            // Known gap: a task the model never polls has its output ONLY in
            // this snapshot, so neither path surfaces it.
            _ => {}
        }
    }

    // A session that ends mid-turn (no trailing `turn_completed`) still gets its
    // accumulated stats. Its `usage` stays `None` — Grok has not stated the
    // spend yet — but the context occupancy it did state still reaches the ring.
    if let Some(prev) = assistant.as_mut() {
        turn_meta.apply(prev, &mut out.context_tokens);
    }
    flush_assistant(&mut assistant, &mut out.turns, &mut tool_result_idx);

    // Assign stable, unique, index-based ids (the transcript is append-only, so
    // positional ids are stable across re-parses).
    for (i, turn) in out.turns.iter_mut().enumerate() {
        turn.id = format!("grok-turn-{i}");
    }
    out
}

fn update_text(update: &Value) -> String {
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Classify a `user_message_chunk`'s `content` into a display block.
///
/// Grok sends prose as `{type:"text"}`. Current codeg prompts send a native
/// `{type:"image"}` chunk (so grok's describe sidecar runs). Older transcripts
/// still carry the embedded `{type:"resource", resource:{blob, mimeType, uri}}`
/// shape from when we followed grok's `image:false` advertisement.
///
/// All of it goes through [`crate::parsers::user_turn_block_from_wire`], the
/// one projection every surface uses for a user's own message — so both image
/// carriages become a thumbnail, and an attached file becomes the same
/// `[name](uri)` marker a viewer saw live. This parser used to fold resources
/// itself and had no `resource_link` case at all, which silently dropped
/// plain file attachments from a reloaded grok turn.
///
/// Returns the block the chunk was SENT as, so the caller can both render it
/// (via [`crate::parsers::user_turn_block`]) and tell prose from an attachment
/// — an attachment projects to a `Text` marker, and the conversation's title
/// must not latch onto `[report.pdf](…)` when the prose follows it.
///
/// `None` for a chunk with nothing to render (empty prose, a malformed
/// resource): the caller still opens the user turn, it just starts empty.
fn user_chunk_to_input(update: &Value) -> Option<PromptInputBlock> {
    crate::acp::types::prompt_block_from_wire(update.get("content")?)
}

// ---------------------------------------------------------------------------
// chat_history.jsonl — grok native ask_user_question answers
// ---------------------------------------------------------------------------

/// Inject the user's `ask_user_question` picks — recorded only in
/// `chat_history.jsonl`, never in `updates.jsonl` — into the matching ToolResult
/// so the `AskQuestionResultCard` renders the answer instead of "未选择". Mirrors
/// the live path (`connection.rs::handle_grok_ask_user_question`): both feed the
/// card the same `{answers, declined}` envelope with an empty `header`, so a
/// conversation renders identically live and after reload. No-op when there is no
/// ask or `chat_history.jsonl` is absent.
fn inject_grok_ask_answers(turns: &mut [MessageTurn], chat_history: &Path) {
    // The native ask carries meta `x.ai/tool.kind == "ask_user"`, which the
    // tool_call arm mapped to this tool name; collect those call ids.
    let ask_ids: std::collections::HashSet<String> = turns
        .iter()
        .flat_map(|t| t.blocks.iter())
        .filter_map(|b| match b {
            ContentBlock::ToolUse {
                tool_use_id: Some(id),
                tool_name,
                ..
            } if tool_name == GROK_ASK_TOOL_NAME => Some(id.clone()),
            _ => None,
        })
        .collect();
    if ask_ids.is_empty() {
        return;
    }
    let answers = read_grok_ask_answers(chat_history, &ask_ids);
    if answers.is_empty() {
        return;
    }
    for turn in turns.iter_mut() {
        for block in turn.blocks.iter_mut() {
            if let ContentBlock::ToolResult {
                tool_use_id: Some(id),
                output_preview,
                is_error,
                ..
            } = block
            {
                if let Some(env) = answers.get(id) {
                    *output_preview = Some(env.clone());
                    *is_error = false;
                }
            }
        }
    }
}

/// Read `chat_history.jsonl` and, for each `tool_result` whose `tool_call_id` is a
/// known ask id, parse its content into the `{answers, declined}` envelope JSON.
/// `chat_history.jsonl` is grok's model-facing transcript; an ask result there is
/// `{type:"tool_result", tool_call_id, content}` and its id matches the
/// `updates.jsonl` call id verbatim. Empty map when the file is missing.
fn read_grok_ask_answers(
    chat_history: &Path,
    ask_ids: &std::collections::HashSet<String>,
) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Ok(file) = fs::File::open(chat_history) else {
        return out;
    };
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { continue };
        if line.trim().is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(Value::as_str) != Some("tool_result") {
            continue;
        }
        let Some(id) = v.get("tool_call_id").and_then(Value::as_str) else {
            continue;
        };
        if !ask_ids.contains(id) {
            continue;
        }
        let content = v.get("content").and_then(Value::as_str).unwrap_or("");
        if let Some(envelope) = grok_history_answer_to_envelope(content) {
            out.insert(id.to_string(), envelope.to_string());
        }
    }
    out
}

/// Parse a grok `ask_user_question` `tool_result` content string into the codeg
/// `{answers, declined}` envelope (the shape `parseAskQuestionOutcome` reads).
///
/// Verified against grok-0.2.101. The accepted template is `User has answered
/// your questions: "Q"="A", "Q2"="B, C". You can now …` (a multi-select value is
/// joined with `, `); the declined / skip_interview template is `The user has
/// indicated they have provided enough answers …` / `(No answer provided)`.
///
/// `header` is emitted empty to match the header-less card input (grok's questions
/// carry no header). Returns `None` for anything that is not one of these shapes,
/// leaving the ToolResult untouched (today's behavior) — safe by construction.
fn grok_history_answer_to_envelope(content: &str) -> Option<Value> {
    let content = content.trim();
    // Declined / skip_interview: distinct template, no per-question picks to show.
    if content.starts_with("The user has indicated they have provided enough answers")
        || content.contains("(No answer provided)")
    {
        return Some(serde_json::json!({ "answers": [], "declined": true }));
    }
    // Accepted: only this exact prefix (English — grok's internal template, not
    // localized) carries `"Q"="A"` pairs.
    if !content.starts_with("User has answered your questions:") {
        return None;
    }
    // Split on the `"` delimiter. For `"Q1"="A1", "Q2"="A2". You can now …` the
    // tokens are ["…: ", Q1, "=", A1, ", ", Q2, "=", A2, ". You can now …"], so a
    // pair is (toks[i], toks[i+2]) with toks[i+1] == "=", advancing by 4. Trailing
    // prose after the last quote is ignored. Lossy only if a question or label
    // contains a literal `"` (then that pair's `=` guard fails and we stop) —
    // questions rarely do, matching the existing text-fallback's tolerance.
    let toks: Vec<&str> = content.split('"').collect();
    let mut answers: Vec<Value> = Vec::new();
    let mut i = 1;
    while i + 2 < toks.len() {
        if toks[i + 1] != "=" {
            break;
        }
        let question = toks[i];
        // Multi-select values are joined with ", "; split them back into the label
        // array the card partitions against the offered options.
        let selected: Vec<String> = toks[i + 2]
            .split(", ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect();
        answers.push(serde_json::json!({
            "header": "",
            "question": question,
            "selected": selected,
        }));
        i += 4;
    }
    if answers.is_empty() {
        return None;
    }
    Some(serde_json::json!({ "answers": answers, "declined": false }))
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// The call's status as this LINE states it, read from wherever the wire
/// actually put it.
///
/// Grok never sets `update.status` on the initial `tool_call` (486/486 in the
/// real transcripts on this machine) and only sets it on TERMINAL
/// `tool_call_update`s; the affirmative running value — `"Pending"` — lives in
/// the line-level `params._meta.updateParams.status`, a SIBLING of
/// `params.update`. Mid-run cumulative updates carry neither, which correctly
/// yields `None` ("this line states nothing") so the last stated value stands.
/// The inner field wins when both are present (terminal updates carry both);
/// the result is lowercased so the persisted value space stays the model's
/// documented `pending`/`in_progress`/`completed`/`failed` regardless of the
/// meta's capitalized spelling (`"Pending"`, `"Completed"`, …).
fn grok_line_status(line: &Value, update: &Value) -> Option<String> {
    update
        .get("status")
        .and_then(Value::as_str)
        .or_else(|| {
            line.pointer("/params/_meta/updateParams/status")
                .and_then(Value::as_str)
        })
        .filter(|s| !s.is_empty())
        .map(str::to_ascii_lowercase)
}

/// Peel Grok's `use_tool` MCP envelope (`{tool_name, tool_input}`) into its inner
/// `(tool_name, tool_input)`. Mirrors `connection.rs::unwrap_grok_use_tool` so the
/// history and live paths classify Grok's MCP calls identically. Native tools
/// (args at the top level, no such shape) return `None`.
fn unwrap_use_tool(raw_input: Option<&Value>) -> Option<(&str, &Value)> {
    let obj = raw_input?.as_object()?;
    let tool_name = obj
        .get("tool_name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())?;
    let tool_input = obj.get("tool_input")?;
    Some((tool_name, tool_input))
}

/// Extract the readable text from a Grok MCP `rawOutput`
/// (`{"type":"MCP","output":{"OkayOutput":"…"}}`, an `*Output` error variant, or
/// a bare string `output`). Mirrors `connection.rs::grok_mcp_output_text`. The
/// result text is the first string value under `output`. Non-MCP → `None`.
fn grok_mcp_output_text(raw_output: &Value) -> Option<String> {
    if raw_output.get("type").and_then(Value::as_str) != Some("MCP") {
        return None;
    }
    let output = raw_output.get("output")?;
    if let Some(text) = output.as_str() {
        return (!text.is_empty()).then(|| text.to_string());
    }
    // First NON-EMPTY string value (the singleton `*Output` variant); filter
    // inside `find_map` so an earlier empty sibling can't shadow a later one.
    output
        .as_object()?
        .values()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()))
        .map(str::to_string)
}

/// Extract the tool output text from a `tool_call_update`. Prefers the ACP
/// `content[]` array (`{type:"content", content:{type:"text", text}}`), then
/// `rawOutput.output_for_prompt` (Bash/terminal), then a `TaskOutput` envelope
/// (background-task polls — see `grok_task_output_envelope`), then an MCP
/// `rawOutput`'s `output` text (`use_tool`). All are cumulative, so the last
/// update per call carries the full output.
fn update_tool_output(update: &Value) -> Option<String> {
    if let Some(items) = update.get("content").and_then(Value::as_array) {
        let mut buf = String::new();
        for item in items {
            if let Some(text) = item
                .get("content")
                .and_then(|c| c.get("text"))
                .and_then(Value::as_str)
            {
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(text);
            }
        }
        if !buf.is_empty() {
            return Some(truncate_str(&buf, GROK_TOOL_OUTPUT_CAP));
        }
    }
    if let Some(text) = update
        .get("rawOutput")
        .and_then(|r| r.get("output_for_prompt"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        return Some(truncate_str(text, GROK_TOOL_OUTPUT_CAP));
    }
    if let Some(envelope) = update.get("rawOutput").and_then(grok_task_output_envelope) {
        return Some(envelope);
    }
    update
        .get("rawOutput")
        .and_then(grok_mcp_output_text)
        .map(|s| truncate_str(&s, GROK_TOOL_OUTPUT_CAP))
}

fn tool_input_preview(raw: Option<&Value>) -> Option<String> {
    let raw = raw?;
    if raw.is_null() {
        return None;
    }
    let serialized = serde_json::to_string(raw).ok()?;
    Some(truncate_str(&serialized, GROK_TOOL_INPUT_CAP))
}

/// Serialize an unwrapped MCP `tool_input` for storage as VALID JSON bounded by
/// `GROK_TOOL_INPUT_CAP`. The frontend delegation card `JSON.parse`s this to
/// recover the task/agent_type, so — unlike `tool_input_preview`'s opaque byte
/// truncation, which can corrupt a long-task prompt into unparseable JSON — this
/// truncates the string VALUES (preserving structure) and shrinks the per-string
/// cap until the WHOLE serialized preview also fits the budget. Checking the
/// actual serialized byte length each pass is what bounds every bloat vector
/// (many strings, long arrays, and JSON/UTF-8 escaping that expands bytes),
/// which a single per-field cap could not. Converges in O(log cap) passes; the
/// common (already-small) input returns on the first pass unchanged.
fn grok_mcp_input_preview(input: &Value) -> Option<String> {
    if input.is_null() {
        return None;
    }
    cap_json_to_budget(input, GROK_TOOL_INPUT_CAP)
}

/// Serialize `value` as JSON that stays VALID within `budget` bytes: cap every
/// string value, halving the per-string cap until the WHOLE serialized form
/// fits. Checking the actual serialized length each pass is what bounds every
/// bloat vector (many strings, long arrays, JSON/UTF-8 escaping that expands
/// bytes) — a single per-field cap could not. Converges in O(log budget) passes;
/// an already-small value returns on the first pass unchanged.
/// `pub(crate)`: the DeepSeek parser bounds its oversized tool arguments with
/// the same valid-JSON guarantee (`deepseek_tool_input_preview`).
pub(crate) fn cap_json_to_budget(value: &Value, budget: usize) -> Option<String> {
    let mut per_string = budget;
    loop {
        let serialized = serde_json::to_string(&cap_json_string_values(value, per_string)).ok()?;
        if serialized.len() <= budget || per_string == 0 {
            return Some(serialized);
        }
        per_string /= 2;
    }
}

/// Serialize a Grok `TaskOutput` / `SubagentCompleted` `rawOutput` — the result
/// of a `get_command_or_subagent_output` poll — for the frontend, which parses
/// it into a background-task card (`@/lib/background-task`). Returns `None` for
/// every other `rawOutput`, so the caller falls through to its normal paths.
///
/// The WHOLE envelope is passed through verbatim (bounded by
/// [`GROK_TASK_OUTPUT_CAP`]): its `type` discriminator is what lets the frontend
/// claim it without hijacking other JSON tool output, and passing it whole means
/// the variants Grok can put beside it (`Result`, `MultiResult`, `TaskNotFound`)
/// need no per-variant handling here. Without this the readable output — the
/// command, exit code and shell text all live under `Result` — is dropped
/// entirely: `content[]` is absent on these updates, and the `output_for_prompt`
/// / MCP paths don't match.
///
/// `SubagentCompleted` is the sibling `ToolOutput` variant grok 0.2.11x emits
/// when the SAME poll tool retrieves a background SUB-AGENT's result (flat
/// `{subagent_id, subagent_type, tool_calls, turns, duration_ms, …}` fields —
/// 0.2.9x instead folded subagents into a `TaskOutput.Result` whose `command`
/// reads `[subagent:<type>] <description>`). Passing it through the same
/// door keeps subagent polls from being the one shape both paths still drop.
///
/// Shared with the live path (`acp::connection::grok_live_tool_output`) so both
/// hand the frontend a byte-identical string.
pub(crate) fn grok_task_output_envelope(raw_output: &Value) -> Option<String> {
    if !matches!(
        raw_output.get("type").and_then(Value::as_str),
        Some("TaskOutput") | Some("SubagentCompleted")
    ) {
        return None;
    }
    cap_json_to_budget(raw_output, GROK_TASK_OUTPUT_CAP)
}

/// Truncate every string value in a JSON value to `cap` chars, preserving
/// structure so the result re-serializes to valid JSON.
fn cap_json_string_values(value: &Value, cap: usize) -> Value {
    match value {
        Value::String(s) => Value::String(truncate_str(s, cap)),
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|v| cap_json_string_values(v, cap))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), cap_json_string_values(v, cap)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// Record the agent's own status on the `ToolUse` block correlated to `id`.
///
/// The `ToolUse` is pushed immediately before its placeholder `ToolResult` (see
/// the `tool_call` arm), so it sits one slot earlier — but the slot is only
/// written after its `tool_use_id` is confirmed to match, so a future change to
/// that ordering degrades to "no status" (unknown) rather than to a status
/// stamped on the wrong call. An absent status leaves the slot untouched: the
/// last value the wire actually stated wins.
fn apply_tool_status(
    turn: Option<&mut MessageTurn>,
    tool_result_idx: &std::collections::HashMap<String, usize>,
    id: &str,
    status: Option<&str>,
) {
    let Some(status) = status.filter(|s| !s.is_empty()) else {
        return;
    };
    let Some(turn) = turn else { return };
    let Some(&result_idx) = tool_result_idx.get(id) else {
        return;
    };
    let Some(use_idx) = result_idx.checked_sub(1) else {
        return;
    };
    if let Some(ContentBlock::ToolUse {
        tool_use_id: Some(existing),
        status: slot,
        ..
    }) = turn.blocks.get_mut(use_idx)
    {
        if existing == id {
            *slot = Some(status.to_string());
        }
    }
}

/// Update the `ToolResult` block correlated to `id` in the current turn. Grok's
/// `tool_call_update.content` is cumulative, and callers only pass `Some` output
/// when non-empty, so the last non-empty output wins; `failed` only ever sets
/// the error flag (never clears it). Ordering vs. `task_completed` is enforced
/// by the caller's `finalized_tools` gate, not here.
fn apply_tool_result(
    turn: Option<&mut MessageTurn>,
    tool_result_idx: &std::collections::HashMap<String, usize>,
    id: &str,
    output: Option<String>,
    failed: bool,
) {
    let Some(turn) = turn else { return };
    let Some(&idx) = tool_result_idx.get(id) else {
        return;
    };
    if let Some(ContentBlock::ToolResult {
        output_preview,
        is_error,
        ..
    }) = turn.blocks.get_mut(idx)
    {
        if let Some(text) = output {
            *output_preview = Some(text);
        }
        if failed {
            *is_error = true;
        }
    }
}

/// Per-turn stats accumulated from Grok's metadata and applied to the assistant
/// turn at its boundary. Grok exposes the numbers the message footer needs, but
/// in three sibling places the update loop otherwise ignores: context occupancy
/// and timing in the OUTER `params._meta` (`totalTokens`, `turnStartMs`,
/// `agentTimestampMs`), the model in `params.update._meta.modelId`, and the real
/// token split in `turn_completed`'s `update.usage` (see [`prompt_usage`]).
/// Duration is `end - start` in ms.
#[derive(Default)]
struct GrokTurnMeta {
    /// `params._meta.totalTokens` — the context-window OCCUPANCY, not a spend.
    /// It rides nearly every update and feeds the context ring; it is
    /// deliberately never folded into `usage`, which would bill a prompt's
    /// resident context as if it were freshly consumed input.
    total_tokens: Option<u64>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    model: Option<String>,
    /// The prompt's real token spend, stated once by `turn_completed`. `None`
    /// for a turn that never completed.
    usage: Option<TurnUsage>,
}

impl GrokTurnMeta {
    /// Fold one update's metadata in. `params_meta` is `params._meta` (token
    /// total + timing); `update_meta` is `params.update._meta` (carries
    /// `modelId`). `totalTokens` climbs as the turn fills the window, so keep
    /// the max; `turnStartMs` is constant per turn (keep the min defensively);
    /// `agentTimestampMs` advances (keep the max as the turn end).
    fn observe(&mut self, params_meta: Option<&Value>, update_meta: Option<&Value>) {
        if let Some(pm) = params_meta {
            if let Some(tt) = pm.get("totalTokens").and_then(Value::as_u64) {
                self.total_tokens = Some(self.total_tokens.map_or(tt, |cur| cur.max(tt)));
            }
            if let Some(s) = pm.get("turnStartMs").and_then(Value::as_i64) {
                self.start_ms = Some(self.start_ms.map_or(s, |cur| cur.min(s)));
            }
            if let Some(e) = pm.get("agentTimestampMs").and_then(Value::as_i64) {
                self.end_ms = Some(self.end_ms.map_or(e, |cur| cur.max(e)));
            }
        }
        if self.model.is_none() {
            self.model = update_meta
                .and_then(|m| m.get("modelId"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
    }

    /// Apply the accumulated stats to a finalized assistant turn, publishing the
    /// turn's context occupancy into the session-level `context_tokens` (the last
    /// turn to state one wins — that is the session's occupancy now). Never
    /// overwrites a turn field already set.
    fn apply(&self, turn: &mut MessageTurn, context_tokens: &mut Option<u64>) {
        if turn.model.is_none() {
            if let Some(model) = &self.model {
                turn.model = Some(model.clone());
            }
        }
        if let Some(tt) = self.total_tokens.filter(|t| *t > 0) {
            *context_tokens = Some(tt);
        }
        if turn.usage.is_none() {
            if let Some(usage) = &self.usage {
                turn.usage = Some(usage.clone());
            }
        }
        if turn.duration_ms.is_none() {
            if let (Some(start), Some(end)) = (self.start_ms, self.end_ms) {
                if end > start {
                    turn.duration_ms = Some((end - start) as u64);
                }
            }
        }
    }
}

/// Read the `usage` object Grok attaches to `turn_completed` into disjoint
/// `TurnUsage` buckets. `None` when it states nothing at all (every counter
/// absent or zero).
///
/// The figures are PER PROMPT, not running session totals — each
/// `turn_completed` carries its own `prompt_id` and, per Grok's docs, "`usage`
/// sums tokens for the prompt, including subagents that finished before turn
/// end" (`~/.grok/docs/user-guide/14-headless-mode.md`). So the snapshot is
/// attached to its own turn as-is and `compute_session_stats` sums the prompts.
/// The counters do climb from one `turn_completed` to the next in a captured
/// session, which reads as cumulative at a glance; it isn't. In `019f96d5` the
/// second prompt states 198457 input over 7 `modelCalls` — a shade under 28.4K
/// per call against that session's 31628-token peak occupancy — whereas reading
/// the pair as cumulative would charge its 2 additional calls 112283 tokens
/// (56K per call), which no call could have sent through a window that size.
///
/// Bucket semantics: this is the ACP `PromptUsage` flavour, whose `inputTokens`
/// is the WHOLE prompt side, with `cachedReadTokens` / `cacheCreationTokens`
/// naming cached SLICES OF IT rather than separate addends —
/// `inputTokens + outputTokens == totalTokens` holds in every capture, which it
/// could not if the cache counters sat outside `inputTokens`. `TurnUsage`
/// follows Anthropic's DISJOINT convention, where `input_tokens` excludes both
/// cache buckets (see `parsers::claude`), so the cached slices are subtracted
/// back out; the four buckets then re-sum to Grok's own `totalTokens`, which is
/// what the composer's breakdown adds up for its "total" row.
/// `reasoningTokens` is a subset of `outputTokens` and so is deliberately
/// dropped, mirroring `parsers::deepseek`.
///
/// Only the ACP spellings are read. Grok's headless projector publishes the same
/// quantities under `cacheReadInputTokens` / `input_tokens`, but with the cache
/// ALREADY subtracted out ("`usage.input_tokens` … are **uncached only**" —
/// same doc). Aliasing those names in here would silently double-subtract the
/// cached prefix the day a build emits them.
fn prompt_usage(usage: &Value) -> Option<TurnUsage> {
    let field = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    let input = field("inputTokens");
    let output = field("outputTokens");
    // `cacheCreationTokens` reaches only newer Grok builds; older ones report
    // reads alone, and an absent counter reads as 0 either way.
    let cache_read = field("cachedReadTokens");
    let cache_create = field("cacheCreationTokens");
    if input == 0 && output == 0 && cache_read == 0 && cache_create == 0 {
        return None;
    }
    Some(TurnUsage {
        // Saturating rather than wrapping: a build that ever reports cache
        // counters exceeding `inputTokens` keeps its cache buckets and drops the
        // uncached remainder to zero, instead of inventing a colossal input.
        input_tokens: input.saturating_sub(cache_read).saturating_sub(cache_create),
        output_tokens: output,
        cache_creation_input_tokens: cache_create,
        cache_read_input_tokens: cache_read,
    })
}

fn ensure_assistant(
    assistant: &mut Option<MessageTurn>,
    ts: DateTime<Utc>,
) -> &mut MessageTurn {
    if assistant.is_none() {
        *assistant = Some(MessageTurn {
            id: String::new(),
            role: TurnRole::Assistant,
            blocks: Vec::new(),
            timestamp: ts,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
        agent_message_id: None,
        });
    }
    assistant.as_mut().expect("assistant just set")
}

fn flush_assistant(
    assistant: &mut Option<MessageTurn>,
    turns: &mut Vec<MessageTurn>,
    tool_result_idx: &mut std::collections::HashMap<String, usize>,
) {
    if let Some(turn) = assistant.take() {
        turns.push(turn);
    }
    tool_result_idx.clear();
}

/// Append assistant text, merging into the trailing `Text` block when adjacent
/// (streaming deltas concatenate; distinct segments separated by tools/thoughts
/// stay separate blocks).
fn append_text(turn: &mut MessageTurn, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(ContentBlock::Text { text: last }) = turn.blocks.last_mut() {
        last.push_str(&text);
    } else {
        turn.blocks.push(ContentBlock::Text { text });
    }
}

fn append_thinking(turn: &mut MessageTurn, text: String) {
    if text.is_empty() {
        return;
    }
    if let Some(ContentBlock::Thinking { text: last }) = turn.blocks.last_mut() {
        last.push('\n');
        last.push_str(&text);
    } else {
        turn.blocks.push(ContentBlock::Thinking { text });
    }
}

// ---------------------------------------------------------------------------
// spawn_subagent — child transcripts, lifecycle pairing, background marker
// ---------------------------------------------------------------------------

/// The ToolResult block belonging to `call_id`, wherever it landed.
fn find_tool_result<'a>(turns: &'a [MessageTurn], call_id: &str) -> Option<&'a ContentBlock> {
    turns.iter().flat_map(|t| t.blocks.iter()).find(|b| {
        matches!(
            b,
            ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == call_id
        )
    })
}

/// Extract the `subagent_id: <uuid>` line from the background-launch ack
/// ("Subagent started in background.\nsubagent_id: 019f…\ntype: explore…").
/// `None` for any other text — notably a BLOCKING spawn's result, which is the
/// child's final output.
fn subagent_id_from_ack(output: &str) -> Option<String> {
    if !output.trim_start().starts_with(GROK_SUBAGENT_STARTED_ACK_PREFIX) {
        return None;
    }
    output.lines().find_map(|line| {
        line.trim()
            .strip_prefix("subagent_id:")
            .map(|id| id.trim().trim_matches('`').to_string())
            .filter(|id| !id.is_empty())
    })
}

/// Build the [`BACKGROUND_TASK_MARKER`] payload replacing a background
/// launch's ack text — the exact contract `parseBackgroundTaskMarker`
/// (`src/lib/background-agent.ts`) renders: settled status + folded result,
/// or "launched · result pending" while `status` is null. Byte-compatible
/// with `claude.rs::apply_background_lifecycle`'s shape. Shared with the live
/// `subagent_finished` settle (`acp::connection`) so a card flipped live and
/// one re-parsed from disk render identically. `output` is capped here so both
/// callers stay bounded.
pub(crate) fn grok_background_subagent_marker(
    subagent_id: &str,
    status: Option<&str>,
    output: Option<&str>,
) -> String {
    let payload = serde_json::json!({
        "task_id": subagent_id,
        "status": status,
        "summary": Value::Null,
        "result": output.map(|o| truncate_str(o, GROK_SUBAGENT_RESULT_CAP)),
    });
    format!("{BACKGROUND_TASK_MARKER}{payload}")
}

fn background_marker_payload(lifecycle: &GrokSubagentLifecycle) -> String {
    grok_background_subagent_marker(
        &lifecycle.subagent_id,
        lifecycle.status.as_deref(),
        lifecycle.output.as_deref(),
    )
}

/// Apply one paired subagent's enrichment to its spawn call blocks:
/// `agent_stats` onto the ToolResult, the background marker (when the recorded
/// output was the launch ack), and — for a blocking spawn cut short before its
/// completion frame — the child's final output. An errored spawn keeps its
/// error text untouched.
fn apply_subagent_result(
    turns: &mut [MessageTurn],
    call_id: &str,
    stats: Option<AgentExecutionStats>,
    marker: Option<String>,
    lifecycle: &GrokSubagentLifecycle,
) {
    for turn in turns.iter_mut() {
        for block in turn.blocks.iter_mut() {
            let ContentBlock::ToolResult {
                tool_use_id: Some(id),
                output_preview,
                is_error,
                agent_stats,
                ..
            } = block
            else {
                continue;
            };
            if id != call_id {
                continue;
            }
            if stats.is_some() {
                *agent_stats = stats.clone();
            }
            if let Some(marker) = &marker {
                *output_preview = Some(marker.clone());
            } else if !*is_error
                && output_preview.as_deref().is_none_or(|o| o.trim().is_empty())
            {
                if let Some(final_output) = &lifecycle.output {
                    *output_preview = Some(final_output.clone());
                }
            }
            return;
        }
    }
}

/// On-disk `subagents/<id>/meta.json` snapshot beside the parent session —
/// the fallback source for status/duration/counts when the parent transcript
/// was cut short before `subagent_finished` landed.
struct GrokSubagentDiskMeta {
    child_session_id: Option<String>,
    status: Option<String>,
    duration_ms: Option<u64>,
    tool_calls: Option<u32>,
}

fn read_subagent_meta(session_dir: &Path, subagent_id: &str) -> Option<GrokSubagentDiskMeta> {
    // `subagent_id` comes straight from transcript JSON; it becomes a path
    // component, so reject anything that couldn't be a plain directory name.
    if !is_safe_subagent_id(subagent_id) {
        return None;
    }
    let raw = fs::read_to_string(
        session_dir
            .join("subagents")
            .join(subagent_id)
            .join("meta.json"),
    )
    .ok()?;
    let v = serde_json::from_str::<Value>(&raw).ok()?;
    Some(GrokSubagentDiskMeta {
        child_session_id: v
            .get("child_session_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        status: v.get("status").and_then(Value::as_str).map(str::to_string),
        duration_ms: v.get("duration_ms").and_then(Value::as_u64),
        tool_calls: v
            .get("tool_calls")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok()),
    })
}

/// Nested tool calls from a CHILD session's `updates.jsonl` — the same
/// wire format as the parent, so the child runs through [`parse_updates`]
/// and its ToolUse/ToolResult pairs (kept adjacent by that parser) fold into
/// the `AgentToolCall` list the Agent card renders. Previews are capped like
/// `claude.rs`/`codebuddy.rs` nested calls. Missing/empty file → empty vec.
fn subagent_tool_calls(child_updates: &Path) -> Vec<AgentToolCall> {
    let parsed = parse_updates(child_updates);
    let mut out = Vec::new();
    for turn in &parsed.turns {
        let mut pending: Option<(String, String, Option<String>)> = None;
        for block in &turn.blocks {
            match block {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_preview,
                    ..
                } => {
                    pending = Some((
                        tool_use_id.clone().unwrap_or_default(),
                        tool_name.clone(),
                        input_preview
                            .as_deref()
                            .map(|s| truncate_str(s, GROK_SUBAGENT_PREVIEW_CAP)),
                    ));
                }
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } => {
                    let Some((pending_id, tool_name, input_preview)) = pending.take() else {
                        continue;
                    };
                    if tool_use_id.as_deref().unwrap_or_default() != pending_id {
                        continue;
                    }
                    out.push(AgentToolCall {
                        tool_name,
                        input_preview,
                        output_preview: output_preview
                            .as_deref()
                            .map(|s| truncate_str(s, GROK_SUBAGENT_PREVIEW_CAP)),
                        is_error: *is_error,
                    });
                }
                _ => {}
            }
        }
    }
    out
}

/// Immediate subdirectories of `dir` (non-recursive). Missing dir → empty.
fn read_subdirs(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write(dir: &Path, name: &str, contents: &str) {
        let mut f = fs::File::create(dir.join(name)).unwrap();
        f.write_all(contents.as_bytes()).unwrap();
    }

    /// Build a `sessions/<group>/<uuid>/` fixture with the given summary +
    /// updates, returning the base `sessions/` dir.
    fn fixture(summary: &str, updates: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let sessions = tmp.path().join("sessions");
        let session = sessions
            .join("%2FUsers%2Fme%2Fproj")
            .join("019f45e3-e1ef-7690-a29f-fe2554382b49");
        fs::create_dir_all(&session).unwrap();
        write(&session, "summary.json", summary);
        write(&session, "updates.jsonl", updates);
        (tmp, sessions)
    }

    const SUMMARY: &str = r#"{
        "info": {"id": "019f45e3-e1ef-7690-a29f-fe2554382b49", "cwd": "/Users/me/proj"},
        "session_summary": "Fallback summary",
        "generated_title": "Build the project",
        "created_at": "2026-07-09T07:59:50.598122Z",
        "updated_at": "2026-07-09T08:02:09.789572Z",
        "num_messages": 6,
        "current_model_id": "grok-4.5",
        "head_branch": "main"
    }"#;

    // Two turns: a plain Q&A, then a prompt that runs a backgrounded command.
    const UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"你会做什么"},"_meta":{"modelId":"grok-4.5","promptIndex":0}}},"timestamp":1783584019}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"Thinking about it"}}},"timestamp":1783584019}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"我是 Grok"}}},"timestamp":1783584024}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p0","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"执行 pnpm build"},"_meta":{"promptIndex":1}}},"timestamp":1783584029}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"正在执行"}}},"timestamp":1783584029}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-1","title":"run_terminal_command","rawInput":{"command":"pnpm build","background":true},"_meta":{"x.ai/tool":{"name":"run_terminal_command","kind":"execute"}}}},"timestamp":1783584029}"#, "\n",
        // The only event pairing the task id with the launching tool call.
        r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"task_backgrounded","tool_call_id":"call-1","task_id":"term_x","command":"pnpm build"}},"timestamp":1783584029}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-1","status":"completed","title":"[bg] pnpm build (term_x)","content":[{"type":"content","content":{"type":"text","text":"Background task term_x started"}}]}},"timestamp":1783584033}"#, "\n",
        // Snapshot keyed by `task_id` — deliberately ignored, so the launch call
        // stays exactly as the wire (and the live path) reports it.
        r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"task_completed","task_snapshot":{"task_id":"term_x","command":"/bin/bash -lc 'pnpm build'","output":"boom","exit_code":1}}},"timestamp":1783584122}"#, "\n",
        // The model polls the task; its whole result lives in `rawOutput`.
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-2","title":"get_command_or_subagent_output","rawInput":{"task_ids":["term_x"],"timeout_ms":15000},"_meta":{"x.ai/tool":{"name":"get_command_or_subagent_output","kind":"background_task_action"}}}},"timestamp":1783584123}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-2","status":"completed","title":"/bin/bash -lc 'pnpm build' (term_x)","rawOutput":{"type":"TaskOutput","Result":{"task_id":"term_x","command":"/bin/bash -lc 'pnpm build'","status":"failed","exit_code":1,"output":"boom"}}}},"timestamp":1783584124}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","stop_reason":"end_turn"}},"timestamp":1783584129}"#, "\n",
    );

    #[test]
    fn lists_session_with_metadata() {
        let (_tmp, sessions) = fixture(SUMMARY, UPDATES);
        let parser = GrokParser::with_base_dir(sessions);
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.id, "019f45e3-e1ef-7690-a29f-fe2554382b49");
        assert_eq!(s.agent_type, AgentType::Grok);
        assert_eq!(s.title.as_deref(), Some("Build the project"));
        assert_eq!(s.model.as_deref(), Some("grok-4.5"));
        assert_eq!(s.folder_path.as_deref(), Some("/Users/me/proj"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        // 2 user + 2 assistant turns.
        assert_eq!(s.message_count, 4);
    }

    #[test]
    fn parses_turns_blocks_and_tool_result() {
        let (_tmp, sessions) = fixture(SUMMARY, UPDATES);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let turns = &detail.turns;
        assert_eq!(turns.len(), 4);

        assert!(matches!(turns[0].role, TurnRole::User));
        assert!(matches!(&turns[0].blocks[0], ContentBlock::Text { text } if text == "你会做什么"));

        assert!(matches!(turns[1].role, TurnRole::Assistant));
        assert!(matches!(&turns[1].blocks[0], ContentBlock::Thinking { text } if text == "Thinking about it"));
        assert!(matches!(&turns[1].blocks[1], ContentBlock::Text { text } if text == "我是 Grok"));

        // Assistant turn 2: text, then tool use + tool result.
        let last = &turns[3];
        assert!(matches!(last.role, TurnRole::Assistant));
        let tool_use = last
            .blocks
            .iter()
            .find(|b| matches!(b, ContentBlock::ToolUse { .. }))
            .unwrap();
        assert!(
            matches!(tool_use, ContentBlock::ToolUse { tool_name, .. } if tool_name == "run_terminal_command")
        );
        // The launch keeps its own "started" text and its wire status: Grok
        // reports the CALL as completed (it did start the task), and the failing
        // `task_completed` snapshot is not applied — otherwise history would
        // contradict the live path, which never sees that ext notification. The
        // task's failure surfaces on the poll below.
        let tool_result = last
            .blocks
            .iter()
            .find(|b| matches!(b, ContentBlock::ToolResult { .. }))
            .unwrap();
        assert!(matches!(
            tool_result,
            ContentBlock::ToolResult { output_preview, is_error, .. }
                if output_preview.as_deref() == Some("Background task term_x started") && !*is_error
        ));
    }

    /// A `get_command_or_subagent_output` poll carries its whole result in
    /// `rawOutput` (no `content[]`, no `output_for_prompt`), which used to be
    /// dropped — leaving the card empty. It must reach the frontend verbatim so
    /// the background-task card can render command/status/exit code/output.
    #[test]
    fn background_task_poll_surfaces_task_output_envelope() {
        let (_tmp, sessions) = fixture(SUMMARY, UPDATES);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let blocks = &detail.turns[3].blocks;

        let poll = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    tool_use_id,
                    ..
                } => Some((tool_name, tool_use_id)),
                _ => None,
            })
            .find(|(name, _)| name.as_str() == "get_command_or_subagent_output")
            .expect("poll tool use");
        assert_eq!(poll.1.as_deref(), Some("call-2"));

        let output = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    ..
                } if tool_use_id.as_deref() == Some("call-2") => output_preview.clone(),
                _ => None,
            })
            .expect("poll ToolResult output");
        let env: Value = serde_json::from_str(&output).expect("envelope is valid JSON");
        assert_eq!(env["type"], "TaskOutput");
        assert_eq!(env["Result"]["exit_code"], 1);
        assert_eq!(env["Result"]["status"], "failed");
        assert_eq!(env["Result"]["output"], "boom");
    }

    /// Grok injects reminders as `user_message_chunk`s flagged
    /// `_meta.hideFromScrollback`. Rendering them as user bubbles split one reply
    /// into two turns with a raw `<system-reminder>` wedged between.
    #[test]
    fn hidden_user_chunk_does_not_split_the_reply() {
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"启动服务"},"_meta":{"modelId":"grok-4.5","promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"已启动"}}},"timestamp":1783584020}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p0","stop_reason":"end_turn"}},"timestamp":1783584021}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"<system-reminder>\nBackground task \"term_x\" completed (exit code: 1).\n</system-reminder>"},"_meta":{"modelId":"grok-4.5","promptIndex":1,"hideFromScrollback":true}}},"timestamp":1783584022}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"那次失败可以忽略"}}},"timestamp":1783584023}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p1","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();

        // One real prompt + the two assistant replies; no reminder bubble.
        assert_eq!(
            detail
                .turns
                .iter()
                .filter(|t| matches!(t.role, TurnRole::User))
                .count(),
            1
        );
        assert!(!detail.turns.iter().any(|t| t
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text.contains("system-reminder")))));
        assert!(matches!(&detail.turns[2].blocks[0], ContentBlock::Text { text } if text == "那次失败可以忽略"));
    }

    #[test]
    fn history_renders_auto_compaction_as_context_compaction_tool() {
        // Grok's auto-compaction lands on the namespaced `_x.ai/session/update`
        // method as `auto_compact_completed` (real capture, session 019f9432:
        // 51777 → 4616 tokens), preceded by a `compaction_checkpoint` (ignored).
        // History must surface the outcome as a completed ToolUse tagged
        // `meta.contextCompaction` with the token delta — mirroring the live path —
        // rather than dropping it.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"plan a page"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}},"timestamp":1783584020}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584021}"#, "\n",
            r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"compaction_checkpoint","checkpoint_id":"c1","prompt_index_at_compaction":0},"_meta":{"eventId":"ev-compact-1"}},"timestamp":1783584030}"#, "\n",
            r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"auto_compact_completed","tokens_before":51777,"tokens_after":4616,"summary_preview":null},"_meta":{"eventId":"ev-compact-2"}},"timestamp":1783584030}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"promptIndex":1}}},"timestamp":1783584031}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        // The compaction ToolUse carries the shared card's meta anywhere in the
        // timeline (rendered between the prior turn and the next "hi" prompt).
        let compaction = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolUse { meta: Some(m), .. }
                    if m.get("contextCompaction").and_then(|v| v.as_bool()) == Some(true) =>
                {
                    Some(m.clone())
                }
                _ => None,
            })
            .expect("compaction tool_use present in history");
        assert_eq!(
            compaction.get("tokensBefore").and_then(|v| v.as_u64()),
            Some(51777)
        );
        assert_eq!(
            compaction.get("tokensAfter").and_then(|v| v.as_u64()),
            Some(4616)
        );
        // The paired ToolResult keeps the block well-formed (no orphan tool_use).
        let has_result = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .any(|b| matches!(b, ContentBlock::ToolResult { .. }));
        assert!(has_result, "compaction tool_result present");
    }

    #[test]
    fn history_renders_failed_auto_compaction_as_failed_compaction_tool() {
        // The live mapper renders `auto_compact_failed` as the compaction card in
        // its failed state; a reopened conversation has to show the same card,
        // not drop the failure.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"plan a page"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}},"timestamp":1783584020}"#, "\n",
            r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"auto_compact_failed","reason":"API error (status 503)"},"_meta":{"eventId":"ev-compact-failed"}},"timestamp":1783584021}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584022}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let blocks: Vec<_> = detail.turns.iter().flat_map(|t| &t.blocks).collect();
        let meta = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    meta: Some(m),
                    ..
                } if id == "ev-compact-failed" => Some(m.clone()),
                _ => None,
            })
            .expect("failed compaction tool_use present in history");
        assert_eq!(
            meta,
            serde_json::json!({
                "contextCompaction": { "version": 1, "error": "API error (status 503)" }
            })
        );
        // The paired result is what marks the card failed.
        assert!(blocks.iter().any(|b| matches!(
            b,
            ContentBlock::ToolResult { tool_use_id: Some(id), is_error: true, .. }
                if id == "ev-compact-failed"
        )));
    }

    #[test]
    fn merges_prompt_text_and_native_image_into_one_user_turn() {
        // Grok echoes a native ACP image as its own `user_message_chunk` (same
        // `promptIndex` as the prose) — the shape captured from a live 1.0.0 and
        // re-checked on 1.0.3. Same merge rule as the legacy resource-blob shape
        // below.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"这是什么"},"_meta":{"modelId":"grok-4.6","promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"image","data":"QUJD","mimeType":"image/png"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"一张截图"}}},"timestamp":1783584024}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let turns = &detail.turns;
        assert_eq!(turns.len(), 2);
        assert!(matches!(turns[0].role, TurnRole::User));
        assert_eq!(turns[0].blocks.len(), 2);
        assert!(
            matches!(&turns[0].blocks[0], ContentBlock::Text { text } if text == "这是什么")
        );
        assert!(matches!(
            &turns[0].blocks[1],
            ContentBlock::Image { data, mime_type, .. }
                if data == "QUJD" && mime_type == "image/png"
        ));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
    }

    #[test]
    fn merges_prompt_text_and_image_resource_into_one_user_turn() {
        // Older transcripts: Grok echoed a pasted image as an embedded
        // resource blob (`user_message_chunk` after the prose, same
        // `promptIndex`). Both must still land in ONE user turn as
        // [Text, Image] — not a text turn plus a trailing image-only turn.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"这是什么"},"_meta":{"modelId":"grok-4.5","promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"resource","resource":{"blob":"QUJD","mimeType":"image/png","uri":"clipboard://image.png-abc"}},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"一张截图"}}},"timestamp":1783584024}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let turns = &detail.turns;
        // One user turn + one assistant turn — NOT two user turns.
        assert_eq!(turns.len(), 2);
        assert!(matches!(turns[0].role, TurnRole::User));
        assert_eq!(turns[0].blocks.len(), 2);
        assert!(
            matches!(&turns[0].blocks[0], ContentBlock::Text { text } if text == "这是什么")
        );
        assert!(matches!(
            &turns[0].blocks[1],
            ContentBlock::Image { data, mime_type, uri }
                if data == "QUJD"
                    && mime_type == "image/png"
                    && uri.as_deref() == Some("clipboard://image.png-abc")
        ));
        assert!(matches!(turns[1].role, TurnRole::Assistant));
    }

    /// A plain (non-image) file attachment. This parser folded resources
    /// itself and had no `resource_link` case at all, so an attached file came
    /// back from history as an empty block — the same gap `acp_native` had.
    /// Both now go through the one projection a viewer saw live.
    #[test]
    fn plain_file_attachments_survive_a_reload_as_their_markers() {
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"看看"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"resource_link","name":"report.pdf","uri":"file:///tmp/report.pdf"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"resource","resource":{"text":"body","mimeType":"text/plain","uri":"clipboard://notes.txt-1"}},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"读了"}}},"timestamp":1783584024}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let turns = &detail.turns;
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0].blocks.len(), 3);
        assert!(matches!(&turns[0].blocks[0], ContentBlock::Text { text } if text == "看看"));
        assert!(
            matches!(&turns[0].blocks[1], ContentBlock::Text { text } if text == "[report.pdf](file:///tmp/report.pdf)")
        );
        // A text resource: the attachment it is shown as, without its body.
        assert!(
            matches!(&turns[0].blocks[2], ContentBlock::Text { text } if text == "clipboard://notes.txt-1\n<context ref=\"clipboard://notes.txt-1\">\n\n</context>")
        );
    }

    /// One turn whose stats live where Grok really puts them: model in
    /// `update._meta.modelId`, occupancy `totalTokens` and timing in the OUTER
    /// `params._meta`. Shared by the context-ring tests below.
    const RING_UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"modelId":"grok-4.5-fast","promptIndex":0}},"_meta":{"turnStartMs":1000,"totalTokens":100}},"timestamp":1783584019}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}},"_meta":{"totalTokens":500,"agentTimestampMs":3000}},"timestamp":1783584024}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"},"_meta":{"agentTimestampMs":5000}},"timestamp":1783584024}"#, "\n",
    );

    #[test]
    fn assistant_turn_carries_model_tokens_and_duration() {
        // Grok reports the footer's stats in two sibling metadata places the
        // loop must fold in: model in `update._meta.modelId`, and context
        // occupancy + timing in the OUTER `params._meta` (`totalTokens`,
        // `turnStartMs` → `agentTimestampMs`).
        let updates = RING_UPDATES;
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let assistant = detail.turns.last().expect("assistant turn");
        assert!(matches!(assistant.role, TurnRole::Assistant));
        // In-stream modelId wins over the summary's current_model_id.
        assert_eq!(assistant.model.as_deref(), Some("grok-4.5-fast"));
        // `totalTokens` is occupancy, not spend: it feeds the ring below and
        // must NOT be dressed up as `input_tokens`. This fixture's
        // `turn_completed` states no `usage`, so the turn honestly has none.
        assert!(assistant.usage.is_none());
        // Duration = last agentTimestampMs (5000) − turnStartMs (1000).
        assert_eq!(assistant.duration_ms, Some(4000));

        // Session stats aggregate the turn duration; with no turn stating usage
        // there is no token breakdown to report.
        let stats = detail.session_stats.expect("session stats");
        assert!(stats.total_usage.is_none());
        assert_eq!(stats.total_duration_ms, 4000);
        // Context ring: occupancy (500) as "used", paired with the session
        // model's window (summary current_model_id = grok-4.5 → 500K).
        // Without this the status bar shows no context ring for Grok.
        assert_eq!(stats.context_window_used_tokens, Some(500));
        assert_eq!(stats.context_window_max_tokens, Some(500_000));
        let pct = stats
            .context_window_usage_percent
            .expect("context window percent");
        assert!((pct - 0.1).abs() < 1e-6, "pct = {pct}");
    }

    /// Two prompts, each closed by a `turn_completed` stating that PROMPT's own
    /// `usage`. Numbers (and the distinct `prompt_id`s) lifted verbatim from a
    /// real capture (`~/.grok/sessions/…/019f96d5…/updates.jsonl`), which is what
    /// makes the arithmetic below meaningful rather than self-referential.
    const USAGE_UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"one"},"_meta":{"promptIndex":0}},"_meta":{"turnStartMs":1000,"totalTokens":9000}},"timestamp":1783584019}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"first"}},"_meta":{"totalTokens":18000,"agentTimestampMs":3000}},"timestamp":1783584024}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"e526ba42","stop_reason":"rate_limit","usage":{"inputTokens":86174,"outputTokens":1652,"totalTokens":87826,"cachedReadTokens":56960,"reasoningTokens":574,"modelCalls":5,"numTurns":5}}},"timestamp":1783584025}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"two"},"_meta":{"promptIndex":1}},"_meta":{"turnStartMs":6000,"totalTokens":22000}},"timestamp":1783584030}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"second"}},"_meta":{"totalTokens":31628,"agentTimestampMs":9000}},"timestamp":1783584035}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"56468252","stop_reason":"end_turn","usage":{"inputTokens":198457,"outputTokens":6224,"totalTokens":204681,"cachedReadTokens":167680,"reasoningTokens":931,"modelCalls":7,"numTurns":7}}},"timestamp":1783584036}"#, "\n",
    );

    #[test]
    fn turn_completed_usage_fills_the_token_breakdown() {
        // The bug this covers: Grok's real token split rides `turn_completed`'s
        // `usage`, and the parser used to ignore it wholesale — synthesizing
        // usage from `_meta.totalTokens` with output and both cache buckets
        // hardcoded to 0, so the composer's breakdown read "output 0, cache 0"
        // for every Grok session no matter how much it had actually spent.
        let (_tmp, sessions) = fixture(SUMMARY, USAGE_UPDATES);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let assistants: Vec<_> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .collect();
        assert_eq!(assistants.len(), 2);

        // Each prompt's own spend, split into DISJOINT buckets: the cached read
        // is carved OUT of `inputTokens` (86174 − 56960), not added to it.
        let first = assistants[0].usage.as_ref().expect("first usage");
        assert_eq!(first.input_tokens, 29_214);
        assert_eq!(first.output_tokens, 1_652);
        assert_eq!(first.cache_read_input_tokens, 56_960);
        assert_eq!(first.cache_creation_input_tokens, 0);
        // The four buckets re-sum to Grok's own `totalTokens` for that prompt,
        // which is what keeps the composer's "total" row honest.
        assert_eq!(total_of(first), 87_826);

        // The second prompt is taken at face value, NOT deltaed against the
        // first: `usage` is per-prompt, so the climb from 86174 to 198457 is the
        // second prompt being bigger, not a running total being restated.
        let second = assistants[1].usage.as_ref().expect("second usage");
        assert_eq!(second.input_tokens, 30_777);
        assert_eq!(second.output_tokens, 6_224);
        assert_eq!(second.cache_read_input_tokens, 167_680);
        assert_eq!(total_of(second), 204_681);

        // So the session total is the SUM of the two prompts. Deltaing would
        // report 204681 here and silently drop the first prompt's 87826.
        let stats = detail.session_stats.expect("session stats");
        let total = stats.total_usage.as_ref().expect("total usage");
        assert_eq!(total_of(total), 87_826 + 204_681);
        assert_eq!(stats.total_tokens, Some(292_507));
        assert_eq!(total.output_tokens, 1_652 + 6_224);
        assert_eq!(total.cache_read_input_tokens, 56_960 + 167_680);

        // And the context ring still reads the OCCUPANCY (`_meta.totalTokens`,
        // last value 31628) — not the 204681 the session spent getting there.
        assert_eq!(stats.context_window_used_tokens, Some(31_628));
        assert_eq!(stats.context_window_max_tokens, Some(500_000));
    }

    /// The sum the composer's "total" row shows for a usage record.
    fn total_of(usage: &TurnUsage) -> u64 {
        usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens
    }

    #[test]
    fn repeated_prompt_usage_is_not_mistaken_for_a_running_total() {
        // Two prompts that spend exactly the same amount state the same numbers
        // — they are per-prompt, not a counter. A delta-based reading would see
        // "no movement" and report the second prompt as free.
        let usage = serde_json::json!({
            "inputTokens": 15_000, "outputTokens": 500,
            "totalTokens": 15_500, "cachedReadTokens": 6_000,
        });
        let first = prompt_usage(&usage).expect("first");
        let second = prompt_usage(&usage).expect("second");
        assert_eq!(total_of(&first), 15_500);
        assert_eq!(total_of(&second), 15_500);

        // An absent or all-zero `usage` still states nothing.
        assert!(prompt_usage(&serde_json::json!({})).is_none());
        assert!(prompt_usage(&serde_json::json!({
            "inputTokens": 0, "outputTokens": 0, "cachedReadTokens": 0,
        }))
        .is_none());
    }

    #[test]
    fn headless_only_usage_spellings_are_not_aliased() {
        // Grok's headless projector publishes `cacheReadInputTokens` with the
        // cache ALREADY subtracted from its `inputTokens`. Reading those names
        // here would double-subtract, so they are deliberately not accepted —
        // this record states nothing rather than something wrong.
        assert!(prompt_usage(&serde_json::json!({
            "cacheReadInputTokens": 41_000, "cache_creation_input_tokens": 2_000,
        }))
        .is_none());
    }

    #[test]
    fn cache_creation_tokens_are_carved_out_of_input_too() {
        // Newer Grok builds add `cacheCreationTokens` alongside the reads. It is
        // a slice of `inputTokens` on the same footing, so it is subtracted out
        // as well — leaving the four buckets summing to `totalTokens`.
        let usage = serde_json::json!({
            "inputTokens": 10_000, "outputTokens": 400, "totalTokens": 10_400,
            "cachedReadTokens": 6_000, "cacheCreationTokens": 1_500,
        });
        let parsed = prompt_usage(&usage).expect("usage");
        assert_eq!(parsed.input_tokens, 2_500);
        assert_eq!(parsed.cache_read_input_tokens, 6_000);
        assert_eq!(parsed.cache_creation_input_tokens, 1_500);
        assert_eq!(parsed.output_tokens, 400);
        assert_eq!(total_of(&parsed), 10_400);

        // Cache counters that overshoot `inputTokens` saturate to a zero
        // remainder rather than wrapping to a colossal input.
        let overshoot = serde_json::json!({
            "inputTokens": 100, "outputTokens": 10, "cachedReadTokens": 900,
        });
        let parsed = prompt_usage(&overshoot).expect("usage");
        assert_eq!(parsed.input_tokens, 0);
        assert_eq!(parsed.cache_read_input_tokens, 900);
    }

    /// Grok's own catalog outranks the id-shaped guess. The fixture's session
    /// model (summary `current_model_id` = `grok-4.5`) would infer 500K from its
    /// name, so a distinct cached window proves the ring read `models_cache.json`
    /// and not the heuristic.
    #[test]
    fn context_window_prefers_groks_models_cache() {
        let (tmp, sessions) = fixture(SUMMARY, RING_UPDATES);
        write(
            tmp.path(),
            "models_cache.json",
            r#"{"models":{"grok-4.5":{"info":{"context_window":314000}}}}"#,
        );
        let parser = GrokParser::with_base_dir(sessions);
        let stats = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap()
            .session_stats
            .expect("session stats");
        assert_eq!(stats.context_window_max_tokens, Some(314_000));
    }

    /// A BYO endpoint (`[model.<id>]` in `config.toml`) never appears in the
    /// fetched catalog, so its declared window is the second source.
    #[test]
    fn context_window_falls_back_to_byo_config_toml() {
        let (tmp, sessions) = fixture(SUMMARY, RING_UPDATES);
        write(
            tmp.path(),
            "models_cache.json",
            r#"{"models":{"some-other-model":{"info":{"context_window":999}}}}"#,
        );
        write(
            tmp.path(),
            "config.toml",
            "[models]\ndefault = \"grok-4.5\"\n\n[model.\"grok-4.5\"]\nmodel = \"grok-4.5\"\ncontext_window = 123456\n",
        );
        let parser = GrokParser::with_base_dir(sessions);
        let stats = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap()
            .session_stats
            .expect("session stats");
        assert_eq!(stats.context_window_max_tokens, Some(123_456));
    }

    /// No catalog on disk (the common case for a machine that only ever ran
    /// grok through codeg) → the name heuristic still supplies a window.
    #[test]
    fn context_window_falls_back_to_the_name_heuristic() {
        let (_tmp, sessions) = fixture(SUMMARY, RING_UPDATES);
        let parser = GrokParser::with_base_dir(sessions);
        let stats = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap()
            .session_stats
            .expect("session stats");
        assert_eq!(stats.context_window_max_tokens, Some(500_000));
    }

    #[test]
    fn catalog_context_window_readers_reject_junk() {
        // Real `models_cache.json` shape (trimmed) → the model's own window.
        let cache = r#"{"grok_version":"1.0.0","models":{"grok-4.5":{"info":{
            "id":"grok-4.5","context_window":500000,"agent_type":"grok-build-plan"},
            "api_key":null}}}"#;
        assert_eq!(
            grok_context_window_from_models_cache(cache, "grok-4.5"),
            Some(500_000)
        );
        // Unknown model / malformed JSON / non-positive window → no opinion.
        assert_eq!(grok_context_window_from_models_cache(cache, "nope"), None);
        assert_eq!(grok_context_window_from_models_cache("{oops", "grok-4.5"), None);
        assert_eq!(
            grok_context_window_from_models_cache(
                r#"{"models":{"m":{"info":{"context_window":0}}}}"#,
                "m"
            ),
            None
        );
        // Same for the BYO TOML block.
        let toml = "[model.mine]\nmodel = \"mine\"\ncontext_window = 64000\n";
        assert_eq!(grok_context_window_from_config_toml(toml, "mine"), Some(64_000));
        assert_eq!(grok_context_window_from_config_toml(toml, "other"), None);
        assert_eq!(grok_context_window_from_config_toml("[model", "mine"), None);
        assert_eq!(
            grok_context_window_from_config_toml("[model.mine]\ncontext_window = -1\n", "mine"),
            None
        );
    }

    #[test]
    fn assistant_turn_model_falls_back_to_summary() {
        // No in-stream modelId anywhere → the assistant turn's model is filled
        // from summary.json `current_model_id`, and without `params._meta` no
        // token stats are fabricated. The elapsed time is not a fabrication
        // though — the records are timestamped, so `backfill_turn_durations`
        // reads the reply's span straight off the prompt→reply clock.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"hi"},"_meta":{"promptIndex":0}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}},"timestamp":1783584024}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584024}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let assistant = detail.turns.last().expect("assistant turn");
        assert_eq!(assistant.model.as_deref(), Some("grok-4.5"));
        assert!(assistant.usage.is_none());
        assert_eq!(
            assistant.duration_ms,
            Some(5_000),
            "1783584024 - 1783584019"
        );
    }

    #[test]
    fn unwraps_use_tool_mcp_delegate_envelope() {
        // Grok wraps MCP calls in a `use_tool` envelope; history must peel it so
        // the delegation card classifies + shows the task, and the ack (carrying
        // task_id, in an MCP `rawOutput`) surfaces as the tool result.
        let updates = concat!(
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"委派构建"}}},"timestamp":1783584019}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-d","title":"use_tool","rawInput":{"tool_name":"codeg-mcp__delegate_to_agent","tool_input":{"agent_type":"codex","working_dir":"/w","task":"run build"}},"_meta":{"x.ai/tool":{"name":"use_tool"}}}},"timestamp":1783584029}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-d","status":"completed","rawOutput":{"type":"MCP","tool_name":"delegate_to_agent","server_name":"codeg-mcp","output":{"OkayOutput":"Delegation successful. task_id=2dc85849-5426-44f7."}}}},"timestamp":1783584122}"#, "\n",
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1783584129}"#, "\n",
        );
        let (_tmp, sessions) = fixture(SUMMARY, updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let assistant = detail.turns.last().expect("assistant turn");

        let (tool_name, input_preview) = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } => Some((tool_name.clone(), input_preview.clone())),
                _ => None,
            })
            .expect("tool use present");
        // Tool name unwrapped to the MCP tool, not the "use_tool" wrapper.
        assert_eq!(tool_name, "codeg-mcp__delegate_to_agent");
        // Input preview is the inner tool_input (carries the task); wrapper gone.
        let input = input_preview.expect("input preview present");
        assert!(
            input.contains("\"task\":\"run build\""),
            "input carries the task: {input}"
        );
        assert!(!input.contains("tool_input"), "the wrapper is peeled: {input}");

        // The MCP ack (with task_id) is the tool result.
        let result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => output_preview.clone(),
                _ => None,
            })
            .expect("tool result present");
        assert!(
            result.contains("task_id=2dc85849"),
            "the delegate ack surfaces as the result: {result}"
        );
    }

    #[test]
    fn use_tool_long_task_input_preview_stays_valid_json() {
        // A task prompt longer than the input cap must still yield VALID JSON
        // (string values truncated, structure intact) so the frontend delegation
        // card can JSON.parse it and recover the description — a raw byte
        // truncation of the whole serialized blob would corrupt it.
        let long_task = "x".repeat(GROK_TOOL_INPUT_CAP + 5_000);
        let updates = format!(
            concat!(
                r#"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"user_message_chunk","content":{{"type":"text","text":"go"}}}}}},"timestamp":1783584019}}"#, "\n",
                r#"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"tool_call","toolCallId":"call-d","title":"use_tool","rawInput":{{"tool_name":"codeg-mcp__delegate_to_agent","tool_input":{{"agent_type":"codex","task":"{}"}}}}}}}},"timestamp":1783584029}}"#, "\n",
                r#"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}}}},"timestamp":1783584129}}"#, "\n",
            ),
            long_task
        );
        let (_tmp, sessions) = fixture(SUMMARY, &updates);
        let parser = GrokParser::with_base_dir(sessions);
        let detail = parser
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();
        let input = detail
            .turns
            .last()
            .unwrap()
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse { input_preview, .. } => input_preview.clone(),
                _ => None,
            })
            .expect("tool use present");
        // The stored preview parses as valid JSON, preserving the structure, and
        // stays within the input cap (a raw byte truncation would corrupt it).
        let parsed: Value =
            serde_json::from_str(&input).expect("input_preview must be valid JSON");
        assert_eq!(
            parsed.get("agent_type").and_then(Value::as_str),
            Some("codex")
        );
        assert!(parsed
            .get("task")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty()));
        assert!(
            input.len() <= GROK_TOOL_INPUT_CAP,
            "preview stays within the cap: {} bytes",
            input.len()
        );
    }

    #[test]
    fn grok_mcp_input_preview_is_valid_and_bounded_for_compound_input() {
        // Every bloat vector at once — multiple oversized strings, a long array
        // of oversized strings, and multibyte/escaped text — must still yield
        // VALID JSON, preserve `agent_type`, keep a non-empty (truncated) `task`,
        // and respect the total serialized-size cap.
        let big = "x".repeat(GROK_TOOL_INPUT_CAP * 3);
        let multibyte = "行".repeat(GROK_TOOL_INPUT_CAP);
        let newlines = "\n".repeat(GROK_TOOL_INPUT_CAP);
        let input = serde_json::json!({
            "agent_type": "codex",
            "task": big,
            "working_dir": big,
            "notes": multibyte,
            "escaped": newlines,
            "list": [big, big, big],
        });
        let preview = grok_mcp_input_preview(&input).expect("preview produced");
        let parsed: Value = serde_json::from_str(&preview).expect("valid JSON");
        assert_eq!(
            parsed.get("agent_type").and_then(Value::as_str),
            Some("codex")
        );
        assert!(parsed
            .get("task")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty()));
        assert!(
            preview.len() <= GROK_TOOL_INPUT_CAP,
            "compound preview is bounded: {} bytes",
            preview.len()
        );
    }

    #[test]
    fn missing_conversation_errors() {
        let (_tmp, sessions) = fixture(SUMMARY, UPDATES);
        let parser = GrokParser::with_base_dir(sessions);
        assert!(matches!(
            parser.get_conversation("does-not-exist"),
            Err(ParseError::ConversationNotFound(_))
        ));
    }

    #[test]
    fn honors_grok_home_env() {
        let home = resolve_grok_home_from(Some("/custom/grok".into()), Some("/home/me".into()));
        assert_eq!(home, PathBuf::from("/custom/grok"));
        let fallback = resolve_grok_home_from(None, Some("/home/me".into()));
        assert_eq!(fallback, PathBuf::from("/home/me/.grok"));
    }

    // --- grok native ask_user_question answer recovery (chat_history.jsonl) ---

    #[test]
    fn history_answer_single_select() {
        let env = grok_history_answer_to_envelope(
            "User has answered your questions: \"你更喜欢哪种演示方式？\"=\"随便看看\". \
             You can now continue with the user's answers in mind.",
        )
        .unwrap();
        assert_eq!(env["declined"], false);
        assert_eq!(env["answers"][0]["header"], "");
        assert_eq!(env["answers"][0]["question"], "你更喜欢哪种演示方式？");
        assert_eq!(env["answers"][0]["selected"], serde_json::json!(["随便看看"]));
    }

    #[test]
    fn history_answer_multi_select_splits_on_comma() {
        // Grok joins a multi-select array with ", " inside the answer quotes.
        let env = grok_history_answer_to_envelope(
            "User has answered your questions: \"Which colors do you like?\"=\"Red, Green\". \
             You can now continue with the user's answers in mind.",
        )
        .unwrap();
        assert_eq!(
            env["answers"][0]["selected"],
            serde_json::json!(["Red", "Green"])
        );
    }

    #[test]
    fn history_answer_two_questions() {
        let env = grok_history_answer_to_envelope(
            "User has answered your questions: \"Q1\"=\"A1\", \"Q2\"=\"A2\". \
             You can now continue with the user's answers in mind.",
        )
        .unwrap();
        assert_eq!(env["answers"].as_array().unwrap().len(), 2);
        assert_eq!(env["answers"][0]["question"], "Q1");
        assert_eq!(env["answers"][0]["selected"], serde_json::json!(["A1"]));
        assert_eq!(env["answers"][1]["question"], "Q2");
        assert_eq!(env["answers"][1]["selected"], serde_json::json!(["A2"]));
    }

    #[test]
    fn history_answer_declined() {
        let env = grok_history_answer_to_envelope(
            "The user has indicated they have provided enough answers for the plan interview.\n\
             Stop asking clarifying questions and proceed to finish the plan.\n\n\
             Questions asked and answers provided:\n- \"Pick a size\"\n  (No answer provided)",
        )
        .unwrap();
        assert_eq!(env["declined"], true);
        assert_eq!(env["answers"], serde_json::json!([]));
    }

    #[test]
    fn history_answer_non_ask_is_none() {
        // A normal (non-ask) tool_result must never be mistaken for an answer.
        assert!(grok_history_answer_to_envelope("build ok\nexit code 0").is_none());
        assert!(grok_history_answer_to_envelope("").is_none());
        // Accepted prefix but no parseable pairs → None (leaves ToolResult as-is).
        assert!(grok_history_answer_to_envelope("User has answered your questions: none.").is_none());
    }

    // Updates carrying grok's native ask_user_question (meta kind "ask_user"),
    // whose answer never lands in updates.jsonl — only in chat_history.jsonl.
    const ASK_UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"给我看看提问工具"},"_meta":{"promptIndex":0}}},"timestamp":1784334515}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-ask-0","title":"ask_user_question","rawInput":{"questions":[{"question":"你更喜欢哪种演示方式？","options":[{"label":"单选示例","description":"a"},{"label":"多选示例","description":"b"},{"label":"随便看看","description":"c"}]}]},"_meta":{"x.ai/tool":{"name":"ask_user_question","kind":"ask_user","namespace":"grok_build","label":"Ask User","read_only":true}}}},"timestamp":1784334520}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p0","stop_reason":"end_turn"}},"timestamp":1784334532}"#, "\n",
    );

    fn ask_session_dir(sessions: &Path) -> PathBuf {
        sessions
            .join("%2FUsers%2Fme%2Fproj")
            .join("019f45e3-e1ef-7690-a29f-fe2554382b49")
    }

    fn ask_detail(sessions: PathBuf) -> ConversationDetail {
        GrokParser::with_base_dir(sessions)
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap()
    }

    fn ask_result_output(detail: &ConversationDetail) -> Option<String> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult { output_preview, .. } => Some(output_preview.clone()),
                _ => None,
            })
            .flatten()
    }

    #[test]
    fn injects_ask_answer_from_chat_history() {
        let (_tmp, sessions) = fixture(SUMMARY, ASK_UPDATES);
        write(
            &ask_session_dir(&sessions),
            "chat_history.jsonl",
            concat!(
                r#"{"type":"assistant","content":"演示","tool_calls":[{"id":"call-ask-0","name":"ask_user_question","arguments":"{}"}]}"#, "\n",
                r#"{"type":"tool_result","tool_call_id":"call-ask-0","content":"User has answered your questions: \"你更喜欢哪种演示方式？\"=\"随便看看\". You can now continue with the user's answers in mind."}"#, "\n",
            ),
        );
        let detail = ask_detail(sessions);
        let output = ask_result_output(&detail).expect("ask ToolResult output injected");
        let env: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(env["declined"], false);
        assert_eq!(env["answers"][0]["question"], "你更喜欢哪种演示方式？");
        assert_eq!(env["answers"][0]["selected"], serde_json::json!(["随便看看"]));
        assert_eq!(env["answers"][0]["header"], "");
    }

    #[test]
    fn injects_declined_ask_from_chat_history() {
        let (_tmp, sessions) = fixture(SUMMARY, ASK_UPDATES);
        write(
            &ask_session_dir(&sessions),
            "chat_history.jsonl",
            concat!(
                r#"{"type":"tool_result","tool_call_id":"call-ask-0","content":"The user has indicated they have provided enough answers for the plan interview.\n\nQuestions asked and answers provided:\n- \"你更喜欢哪种演示方式？\"\n  (No answer provided)"}"#, "\n",
            ),
        );
        let detail = ask_detail(sessions);
        let output = ask_result_output(&detail).expect("declined ask ToolResult output injected");
        let env: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(env["declined"], true);
        assert_eq!(env["answers"], serde_json::json!([]));
    }

    #[test]
    fn ask_without_chat_history_leaves_output_empty() {
        // No chat_history.jsonl → injection is a no-op; the ask ToolResult output
        // stays None (the pre-fix "未选择", never a crash).
        let (_tmp, sessions) = fixture(SUMMARY, ASK_UPDATES);
        let detail = ask_detail(sessions);
        assert!(ask_result_output(&detail).is_none());
    }

    // -----------------------------------------------------------------------
    // spawn_subagent
    // -----------------------------------------------------------------------

    const PARENT_ID: &str = "019f45e3-e1ef-7690-a29f-fe2554382b49";
    const CHILD_ID: &str = "019f9432-e0d8-74c3-bd02-0772c4e04a65";

    /// A BACKGROUND spawn mirroring the real 019f9432 capture: the launch call
    /// completes with the "Subagent started in background…" ack, then the
    /// `_x.ai` lifecycle events arrive, and the model polls the child with
    /// `get_command_or_subagent_output` (0.2.11x `SubagentCompleted` shape).
    fn background_spawn_updates() -> String {
        [
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"探索代码库"},"_meta":{"modelId":"grok-4.5","promptIndex":0}}},"timestamp":1784897780}"#,
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-s1","title":"spawn_subagent","rawInput":{"description":"Explore test pages","prompt":"Explore this codebase","subagent_type":"explore","capability_mode":"read-only"},"_meta":{"x.ai/tool":{"version":1,"name":"spawn_subagent","kind":"task","namespace":"grok_build","label":"Subagent","read_only":false},"subagentBackground":true}}},"timestamp":1784897790}"#,
            &format!(
                r#"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"tool_call_update","toolCallId":"call-s1","status":"completed","content":[{{"type":"content","content":{{"type":"text","text":"Subagent started in background.\nsubagent_id: {CHILD_ID}\ntype: explore\ndescription: Explore test pages\n\nUse get_command_or_subagent_output with task_ids=[\"{CHILD_ID}\"] and timeout_ms to wait for results."}}}}],"rawOutput":{{"type":"Text","text":"Subagent started in background.\nsubagent_id: {CHILD_ID}"}}}}}},"timestamp":1784897790}}"#
            ),
            &format!(
                r#"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_spawned","subagent_id":"{CHILD_ID}","parent_session_id":"{PARENT_ID}","child_session_id":"{CHILD_ID}","subagent_type":"explore","description":"Explore test pages","capability_mode":"read-only","model":"grok-4.5"}}}},"timestamp":1784897790}}"#
            ),
            &format!(
                r###"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_finished","subagent_id":"{CHILD_ID}","child_session_id":"{CHILD_ID}","status":"completed","tool_calls":2,"turns":1,"duration_ms":63775,"tokens_used":29477,"output":"## Codebase exploration summary\n\nNext.js 16 app."}}}},"timestamp":1784897853}}"###
            ),
            &format!(
                r#"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"tool_call","toolCallId":"call-p1","title":"get_command_or_subagent_output","rawInput":{{"task_ids":["{CHILD_ID}"],"timeout_ms":120000}},"_meta":{{"x.ai/tool":{{"name":"get_command_or_subagent_output","kind":"background_task_action"}}}}}}}},"timestamp":1784897860}}"#
            ),
            &format!(
                r###"{{"method":"session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"tool_call_update","toolCallId":"call-p1","status":"completed","rawOutput":{{"type":"SubagentCompleted","subagent_id":"{CHILD_ID}","subagent_type":"explore","status":"completed","tool_calls":2,"turns":1,"duration_ms":63775,"output":"## Codebase exploration summary"}}}}}},"timestamp":1784897861}}"###
            ),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","prompt_id":"p0","stop_reason":"end_turn"}},"timestamp":1784897870}"#,
        ]
        .join("\n")
    }

    /// Child transcript (same wire format as the parent) with two tool calls.
    const CHILD_UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"Explore this codebase"},"_meta":{"promptIndex":0}}},"timestamp":1784897791}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"tool_call","toolCallId":"cc-1","title":"list_dir","rawInput":{"target_directory":"/Users/me/proj"},"_meta":{"x.ai/tool":{"name":"list_dir","kind":"list"}}}},"timestamp":1784897792}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"tool_call_update","toolCallId":"cc-1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"- app/\n- package.json"}}]}},"timestamp":1784897793}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"tool_call","toolCallId":"cc-2","title":"read_file","rawInput":{"target_file":"/Users/me/proj/package.json"},"_meta":{"x.ai/tool":{"name":"read_file","kind":"read"}}}},"timestamp":1784897794}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"tool_call_update","toolCallId":"cc-2","status":"failed","content":[{"type":"content","content":{"type":"text","text":"boom"}}]}},"timestamp":1784897795}"#, "\n",
        r###"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"## Codebase exploration summary"}}},"timestamp":1784897796}"###, "\n",
        r#"{"method":"session/update","params":{"sessionId":"c","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1784897797}"#, "\n",
    );

    fn child_summary(kind: &str) -> String {
        format!(
            r#"{{
                "info": {{"id": "{CHILD_ID}", "cwd": "/Users/me/proj"}},
                "generated_title": "Explore this codebase",
                "created_at": "2026-07-24T12:56:30.176279Z",
                "session_kind": "{kind}",
                "agent_name": "explore",
                "current_model_id": "grok-4.5"
            }}"#
        )
    }

    /// Create the child session dir as a SIBLING of the parent (same group).
    fn write_child_session(sessions: &Path) {
        let child = sessions.join("%2FUsers%2Fme%2Fproj").join(CHILD_ID);
        fs::create_dir_all(&child).unwrap();
        write(&child, "summary.json", &child_summary("subagent"));
        write(&child, "updates.jsonl", CHILD_UPDATES);
    }

    fn spawn_blocks(detail: &ConversationDetail) -> (&ContentBlock, &ContentBlock) {
        let blocks: Vec<&ContentBlock> = detail.turns.iter().flat_map(|t| &t.blocks).collect();
        let tool_use = blocks
            .iter()
            .find(|b| {
                matches!(b, ContentBlock::ToolUse { tool_use_id: Some(id), .. } if id == "call-s1")
            })
            .expect("spawn ToolUse");
        let tool_result = blocks
            .iter()
            .find(|b| {
                matches!(b, ContentBlock::ToolResult { tool_use_id: Some(id), .. } if id == "call-s1")
            })
            .expect("spawn ToolResult");
        (tool_use, tool_result)
    }

    #[test]
    fn background_spawn_renames_to_agent_with_stats_and_marker() {
        let (_tmp, sessions) = fixture(SUMMARY, &background_spawn_updates());
        write_child_session(&sessions);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation(PARENT_ID)
            .unwrap();
        let (tool_use, tool_result) = spawn_blocks(&detail);

        // The launcher renames to "Agent" (→ AgentToolCallPart) with its
        // standard input untouched.
        let ContentBlock::ToolUse {
            tool_name,
            input_preview: Some(input),
            ..
        } = tool_use
        else {
            panic!("spawn ToolUse shape");
        };
        assert_eq!(tool_name, "Agent");
        let input: Value = serde_json::from_str(input).unwrap();
        assert_eq!(input["subagent_type"], "explore");

        // The ack is replaced by the background-task marker carrying the
        // settled status + the child's final output, and the child transcript
        // becomes nested agent_stats.
        let ContentBlock::ToolResult {
            output_preview: Some(output),
            agent_stats: Some(stats),
            is_error: false,
            ..
        } = tool_result
        else {
            panic!("spawn ToolResult shape");
        };
        let payload = output
            .strip_prefix(BACKGROUND_TASK_MARKER)
            .expect("background ack folded into the marker");
        let payload: Value = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["task_id"], CHILD_ID);
        assert_eq!(payload["status"], "completed");
        assert!(payload["result"]
            .as_str()
            .unwrap()
            .starts_with("## Codebase exploration summary"));

        assert_eq!(stats.agent_type.as_deref(), Some("explore"));
        assert_eq!(stats.status.as_deref(), Some("completed"));
        assert_eq!(stats.total_duration_ms, Some(63775));
        assert_eq!(stats.total_tokens, Some(29477));
        assert_eq!(stats.total_tool_use_count, Some(2));
        assert_eq!(stats.tool_calls.len(), 2);
        assert_eq!(stats.tool_calls[0].tool_name, "list_dir");
        assert!(!stats.tool_calls[0].is_error);
        assert_eq!(stats.tool_calls[1].tool_name, "read_file");
        assert!(stats.tool_calls[1].is_error);
        // The child's own session travels with the stats so the Agent card can
        // offer to open its transcript (grok runs every child as a full
        // session; `get_conversation` resolves it despite the sidebar hiding
        // `session_kind: "subagent"`).
        assert_eq!(stats.child_session_id.as_deref(), Some(CHILD_ID));
    }

    /// The 0.2.11x subagent poll (`rawOutput.type == "SubagentCompleted"`)
    /// must reach the frontend as the verbatim envelope — it previously
    /// matched none of the output paths and the poll card streamed empty.
    #[test]
    fn subagent_poll_surfaces_subagent_completed_envelope() {
        let (_tmp, sessions) = fixture(SUMMARY, &background_spawn_updates());
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation(PARENT_ID)
            .unwrap();
        let output = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    ..
                } if tool_use_id.as_deref() == Some("call-p1") => output_preview.clone(),
                _ => None,
            })
            .expect("poll ToolResult output");
        let env: Value = serde_json::from_str(&output).unwrap();
        assert_eq!(env["type"], "SubagentCompleted");
        assert_eq!(env["subagent_id"], CHILD_ID);
        assert_eq!(env["output"], "## Codebase exploration summary");
    }

    /// A `session_kind: "subagent"` child session never appears in the sidebar
    /// list (it renders INSIDE the parent's Agent card), but stays openable by
    /// direct id.
    #[test]
    fn subagent_child_sessions_are_hidden_from_list_but_openable() {
        let (_tmp, sessions) = fixture(SUMMARY, &background_spawn_updates());
        write_child_session(&sessions);
        let parser = GrokParser::with_base_dir(sessions);
        let list = parser.list_conversations().unwrap();
        assert_eq!(list.len(), 1, "child must not pollute the conversation list");
        assert_eq!(list[0].id, PARENT_ID);
        let child = parser.get_conversation(CHILD_ID).unwrap();
        assert!(!child.turns.is_empty(), "direct open still parses the child");
    }

    /// A BLOCKING spawn (no background ack): the lifecycle pairs positionally,
    /// stats attach, and the recorded output — the child's own final text — is
    /// left untouched (no marker). An interrupted session missing the
    /// completion frame still gets the child's output from the lifecycle.
    #[test]
    fn blocking_spawn_keeps_output_and_attaches_stats() {
        let updates = [
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"探索"},"_meta":{"promptIndex":0}}},"timestamp":1784897780}"#.to_string(),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-s1","title":"spawn_subagent","rawInput":{"description":"Explore","prompt":"Explore this","subagent_type":"explore"},"_meta":{"x.ai/tool":{"name":"spawn_subagent","kind":"task"}}}},"timestamp":1784897790}"#.to_string(),
            format!(
                r#"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_spawned","subagent_id":"{CHILD_ID}","child_session_id":"{CHILD_ID}","subagent_type":"explore"}}}},"timestamp":1784897791}}"#
            ),
            format!(
                r###"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_finished","subagent_id":"{CHILD_ID}","child_session_id":"{CHILD_ID}","status":"completed","tool_calls":2,"duration_ms":1000,"output":"## Findings"}}}},"timestamp":1784897853}}"###
            ),
            // No completion frame for call-s1 (interrupted session).
        ]
        .join("\n");
        let (_tmp, sessions) = fixture(SUMMARY, &updates);
        write_child_session(&sessions);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation(PARENT_ID)
            .unwrap();
        let (tool_use, tool_result) = spawn_blocks(&detail);
        assert!(matches!(
            tool_use,
            ContentBlock::ToolUse { tool_name, .. } if tool_name == "Agent"
        ));
        let ContentBlock::ToolResult {
            output_preview: Some(output),
            agent_stats: Some(stats),
            ..
        } = tool_result
        else {
            panic!("blocking spawn result should carry output + stats");
        };
        assert_eq!(output, "## Findings", "lifecycle output fills the gap, no marker");
        assert_eq!(stats.tool_calls.len(), 2);
    }

    /// A hostile `child_session_id` must never escape the sessions directory;
    /// the lifecycle's own totals still attach (no file access needed).
    #[test]
    fn hostile_subagent_ids_never_touch_the_filesystem() {
        let updates = [
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"go"},"_meta":{"promptIndex":0}}},"timestamp":1784897780}"#.to_string(),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-s1","title":"spawn_subagent","rawInput":{"description":"X","prompt":"Y","subagent_type":"explore"},"_meta":{"x.ai/tool":{"name":"spawn_subagent","kind":"task"}}}},"timestamp":1784897790}"#.to_string(),
            r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"subagent_spawned","subagent_id":"../evil","child_session_id":"../../etc","subagent_type":"explore"}},"timestamp":1784897791}"#.to_string(),
            r#"{"method":"_x.ai/session/update","params":{"sessionId":"s","update":{"sessionUpdate":"subagent_finished","subagent_id":"../evil","status":"completed","duration_ms":5,"output":"out"}},"timestamp":1784897792}"#.to_string(),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1784897793}"#.to_string(),
        ]
        .join("\n");
        let (_tmp, sessions) = fixture(SUMMARY, &updates);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation(PARENT_ID)
            .unwrap();
        let (_, tool_result) = spawn_blocks(&detail);
        let ContentBlock::ToolResult {
            agent_stats: Some(stats),
            ..
        } = tool_result
        else {
            panic!("lifecycle totals still attach");
        };
        assert!(stats.tool_calls.is_empty(), "no transcript may load from a hostile id");
        assert_eq!(stats.total_duration_ms, Some(5));
        // …and the id is not handed to the frontend either: the card's "open
        // the child's session" action would feed it straight back into a
        // session-directory lookup.
        assert_eq!(stats.child_session_id, None);
    }

    /// An errored spawn (depth limit, config) consumes no lifecycle, so a
    /// following successful spawn still pairs with ITS OWN lifecycle.
    #[test]
    fn failed_spawn_does_not_shift_lifecycle_pairing() {
        let updates = [
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"go"},"_meta":{"promptIndex":0}}},"timestamp":1784897780}"#.to_string(),
            // Spawn #1 fails outright — grok emits no subagent_spawned for it.
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-s1","title":"spawn_subagent","rawInput":{"description":"A","prompt":"PA","subagent_type":"explore"},"_meta":{"x.ai/tool":{"name":"spawn_subagent","kind":"task"}}}},"timestamp":1784897790}"#.to_string(),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-s1","status":"failed","content":[{"type":"content","content":{"type":"text","text":"subagents cannot spawn subagents"}}]}},"timestamp":1784897791}"#.to_string(),
            // Spawn #2 succeeds (blocking) and finishes.
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"call-s2","title":"spawn_subagent","rawInput":{"description":"B","prompt":"PB","subagent_type":"plan"},"_meta":{"x.ai/tool":{"name":"spawn_subagent","kind":"task"}}}},"timestamp":1784897792}"#.to_string(),
            format!(
                r#"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_spawned","subagent_id":"{CHILD_ID}","child_session_id":"{CHILD_ID}","subagent_type":"plan"}}}},"timestamp":1784897793}}"#
            ),
            format!(
                r#"{{"method":"_x.ai/session/update","params":{{"sessionId":"s","update":{{"sessionUpdate":"subagent_finished","subagent_id":"{CHILD_ID}","status":"completed","tool_calls":1,"duration_ms":9,"output":"plan done"}}}},"timestamp":1784897794}}"#
            ),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"call-s2","status":"completed","content":[{"type":"content","content":{"type":"text","text":"plan done"}}]}},"timestamp":1784897795}"#.to_string(),
            r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"turn_completed","stop_reason":"end_turn"}},"timestamp":1784897796}"#.to_string(),
        ]
        .join("\n");
        let (_tmp, sessions) = fixture(SUMMARY, &updates);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation(PARENT_ID)
            .unwrap();
        let results: std::collections::HashMap<String, Option<AgentExecutionStats>> = detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    agent_stats,
                    ..
                } if id.starts_with("call-s") => Some((id.clone(), agent_stats.clone())),
                _ => None,
            })
            .collect();
        assert!(
            results["call-s1"].is_none(),
            "the failed spawn must not steal the next lifecycle"
        );
        let stats = results["call-s2"].as_ref().expect("stats on the real spawn");
        assert_eq!(stats.agent_type.as_deref(), Some("plan"));
        assert_eq!(stats.status.as_deref(), Some("completed"));
    }

    // ── per-call status: the only honest "is it still working?" signal ──────
    //
    // A grok sub-agent's transcript is read WHILE the child writes it
    // (`SubagentSessionDialog` polls the file). The paired placeholder
    // `ToolResult` cannot answer that question — it stays `output_preview:
    // None` for an empty completion too, and `apply_tool_result` only backfills
    // non-empty output — so the call's own status has to be recorded.

    fn status_of<'a>(detail: &'a ConversationDetail, id: &str) -> Option<&'a str> {
        detail
            .turns
            .iter()
            .flat_map(|t| &t.blocks)
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(tid),
                    status,
                    ..
                } if tid == id => Some(status.as_deref()),
                _ => None,
            })
            .expect("ToolUse block")
    }

    // The REAL wire shape, measured across every grok transcript on this
    // machine (486 `tool_call` lines): the initial update NEVER carries
    // `update.status`; the affirmative `"Pending"` sits in the LINE-level
    // `params._meta.updateParams.status` (a sibling of `params.update`, with
    // capitalized values). Terminal `tool_call_update`s carry both (inner
    // lowercase + meta capitalized); mid-run cumulative updates carry neither.
    const STATUS_UPDATES: &str = concat!(
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"c-run","title":"read_file","rawInput":{"target_file":"a.rs"}},"_meta":{"updateParams":{"toolCallId":"c-run","status":"Pending"}}},"timestamp":1784897790}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"c-done","title":"read_file","rawInput":{"target_file":"b.rs"}},"_meta":{"updateParams":{"toolCallId":"c-done","status":"Pending"}}},"timestamp":1784897791}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"c-done","content":[{"type":"content","content":{"type":"text","text":"partial"}}]}},"timestamp":1784897792}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"c-done","status":"completed","content":[{"type":"content","content":{"type":"text","text":"ok"}}]},"_meta":{"updateParams":{"toolCallId":"c-done","status":"Completed"}}},"timestamp":1784897793}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"c-empty","title":"write_file","rawInput":{"target_file":"c.rs"}},"_meta":{"updateParams":{"toolCallId":"c-empty","status":"Pending"}}},"timestamp":1784897794}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call_update","toolCallId":"c-empty","status":"completed"},"_meta":{"updateParams":{"toolCallId":"c-empty","status":"Completed"}}},"timestamp":1784897795}"#, "\n",
        r#"{"method":"session/update","params":{"sessionId":"s","update":{"sessionUpdate":"tool_call","toolCallId":"c-silent","title":"read_file","rawInput":{"target_file":"d.rs"}}},"timestamp":1784897796}"#, "\n",
    );

    #[test]
    fn tool_use_records_the_calls_own_status() {
        let (_tmp, sessions) = fixture(SUMMARY, STATUS_UPDATES);
        let detail = GrokParser::with_base_dir(sessions)
            .get_conversation("019f45e3-e1ef-7690-a29f-fe2554382b49")
            .unwrap();

        // Initial status comes from the line-level meta ("Pending", lowercased)
        // — the inner update has none. This is the running call, and the status
        // is the ONLY thing that says so: its placeholder result looks
        // identical to an empty completion's.
        assert_eq!(status_of(&detail, "c-run"), Some("pending"));
        // A content-only update states no status and must not clear it; the
        // terminal update then wins.
        assert_eq!(status_of(&detail, "c-done"), Some("completed"));
        // A completion carrying NO output is still a completion: this is the
        // case that makes "empty output" useless as a liveness signal.
        assert_eq!(status_of(&detail, "c-empty"), Some("completed"));
        // Absent everywhere stays absent — unknown, never a guess.
        assert_eq!(status_of(&detail, "c-silent"), None);
    }
}
