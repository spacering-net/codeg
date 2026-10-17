use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    AgentExecutionStats, AgentType, ContentBlock, ConversationDetail, ConversationSummary,
    MessageRole, MessageTurn, TurnRole, TurnUsage, UnifiedMessage,
};
use crate::parsers::claude::{
    api_error_text, capture_title_record, extract_assistant_content, extract_usage,
    extract_user_content, extract_user_text, group_into_turns, is_interrupt_marker,
    is_meta_message, is_synthetic_assistant, slash_command_display, ClaudeRecordAccumulator,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, latest_turn_prompt_usage_tokens, merge_context_window_stats,
    relocate_orphaned_tool_results, resolve_patch_line_numbers, structurize_read_tool_output,
    title_from_user_text, with_reported_context_percent, AgentEnv, AgentParser, ParseError,
};

/// Resolve Qoder's global config dir the way Qoder itself does.
///
/// The resolver is three env vars deep, and reading only the first of them
/// puts codeg in a different directory than the CLI it just launched —
/// sessions vanish from the list, and skills install where nothing loads them:
///
/// ```js
/// function homeRoot(){ return firstEnv(QODER_CLI_HOME, GEMINI_CLI_HOME) || os.homedir() }
/// function getGlobalConfigDir(){
///   let e = /* --config-dir flag */, t = firstEnv(QODER_CONFIG_DIR)
///   if (e) A = e
///   else if (t) A = path.resolve(t)
///   else A = path.join(homeRoot(), userConfigDirName)
/// }
/// ```
///
/// (The names are built from a `QODER_`/`QODERCN_` prefix at runtime —
/// `<id>=<helper>("CLI_HOME")`, `…("CONFIG_DIR")`, `…("CONFIG_DIR_NAME")` — so
/// they do not appear as literals in the bundle. Re-verify by grepping those
/// bare SUFFIXES, never the minified identifiers: they are renamed on most
/// releases (`$t`/`b8A`/`L8A`/`H8A` at 1.1.23 became `ln`/`I1A`/`h1A`/`Q1A` at
/// 1.1.28, then `on`/`F4A`/`U4A`/`N4A` at 1.1.31, then `Yi`/`JJA`/`YJA`/`WJA`
/// at 1.1.33, then `Zn`/`MYA`/`FYA`/`UYA` at 1.1.40–1.1.41, then
/// `qn`/`A7A`/`t7A`/`n7A` at 1.1.44, then `Ai`/`d7A`/`g7A`/`f7A` at 1.1.45),
/// so a grep written against the old names returns zero hits and reads as
/// "the resolver is gone" when nothing moved. `GEMINI_CLI_HOME` really is a
/// second key on the home lookup: qodercli carries its ancestry.
/// Re-checked against the pinned 1.1.45 bundle: same precedence, same keys,
/// same `.qoder` config-dir name.)
///
/// Not mirrored, deliberately: the `--config-dir` FLAG, which codeg never
/// passes, and the `QODERCN_*` twin, which belongs to the separate `.qoder-cn`
/// distribution rather than the `@qoder-ai/qodercli` package pinned here.
pub(crate) fn resolve_qoder_config_dir() -> PathBuf {
    resolve_qoder_config_dir_for_env(&AgentEnv::inherited())
}

/// [`resolve_qoder_config_dir`] for the Qoder launched with `env`.
pub(crate) fn resolve_qoder_config_dir_for_env(env: &AgentEnv) -> PathBuf {
    resolve_qoder_config_dir_from(
        env.var_os("QODER_CONFIG_DIR"),
        env.var_os("QODER_CLI_HOME")
            .or_else(|| env.var_os("GEMINI_CLI_HOME")),
        env.var_os("QODER_CONFIG_DIR_NAME"),
        dirs::home_dir(),
    )
}

/// The home Qoder hangs its SHARED trees off — `pa()` above.
///
/// Distinct from [`resolve_qoder_config_dir`] on purpose: the cross-agent
/// `.agents` store is not inside the config dir, so `QODER_CONFIG_DIR` does not
/// move it, but `QODER_CLI_HOME` does —
/// `getGlobalAgentsDir(){ return join(pa(), ".agents") }`, and
/// `getUserAgentSkillsDir()` joins `skills` onto that.
pub(crate) fn resolve_qoder_home() -> PathBuf {
    std::env::var_os("QODER_CLI_HOME")
        .or_else(|| std::env::var_os("GEMINI_CLI_HOME"))
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_default()
}

fn resolve_qoder_config_dir_from(
    config_dir_env: Option<OsString>,
    cli_home_env: Option<OsString>,
    config_dir_name_env: Option<OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    if let Some(config_dir) = config_dir_env.filter(|value| !value.is_empty()) {
        return PathBuf::from(config_dir);
    }
    let root = cli_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or(home_dir)
        .unwrap_or_default();
    root.join(
        config_dir_name_env
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| OsString::from(".qoder")),
    )
}

/// Qoder's per-project skills root, relative to the workspace.
///
/// `SkillCommandHandler.enumerate` resolves it as
/// `join(workDir, projectConfigDirName)`, and the same `QODER_CONFIG_DIR_NAME`
/// that renames the user dir renames this one — both default to `.qoder`.
///
/// Cached in a `OnceLock` rather than returned by value because
/// [`super::super::commands::acp::SkillStorageSpec`] holds `&'static str`: the
/// variable is read once per process and cannot change under a running CLI, so
/// a process-lifetime string is the honest representation, not a leak.
pub(crate) fn qoder_project_skills_rel_dir() -> &'static str {
    static REL_DIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    REL_DIR
        .get_or_init(|| {
            let name = std::env::var("QODER_CONFIG_DIR_NAME")
                .ok()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| ".qoder".to_string());
            format!("{name}/skills")
        })
        .as_str()
}

/// Qoder (Alibaba) stores one JSONL transcript per session under
/// `$QODER_CONFIG_DIR/projects/<encoded-cwd>/<sessionId>.jsonl` (default
/// `~/.qoder/…`), in the Claude-Code-style chunk-log envelope: `user` /
/// `assistant` records chained by `uuid`/`parentUuid`, whose `message.content`
/// is a string OR a block array, interleaved with metadata records that repeat
/// at the file tail.
///
/// Two properties of that envelope drive this parser and are easy to get wrong:
///
/// * **It is an append-only message GRAPH, not a list.** Qoder replays a
///   session by walking `parentUuid` back from the current `active-leaf`;
///   records left behind by a rewind or a fork stay in the file forever. Reading
///   the file in append order therefore splices abandoned branches into the
///   conversation and double-counts their tokens — see [`active_branch`].
/// * **Its record vocabulary is a SUPERSET of Claude Code's**, adding
///   `runtime-config`, `active-leaf`, `last-prompt`, `token-stats`,
///   `content-replacement`, `mode`, `tag` and `workspace-directories` on top of
///   the shared `user`/`assistant`/`attachment`/`system`/`summary`/
///   `custom-title`/`ai-title` set.
///
/// Everything the two envelopes share is read through `parsers::claude`'s own
/// extractors rather than a second spelling of the same rules, so block arrays,
/// images, `<system-reminder>` stripping, `isMeta` injections, interrupt
/// bookkeeping, `<synthetic>` placeholders and per-`message.id` usage
/// de-duplication all behave identically for both agents.
pub struct QoderParser {
    base_dir: PathBuf,
}

impl QoderParser {
    pub fn new() -> Self {
        Self::for_env(&AgentEnv::inherited())
    }

    /// The history of the Qoder launched with `env`.
    pub fn for_env(env: &AgentEnv) -> Self {
        Self {
            base_dir: resolve_qoder_config_dir_for_env(env).join("projects"),
        }
    }

    /// Construct a parser pointed at an explicit `projects` directory (test
    /// fixtures).
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Locate a session's transcript file by id: `<base>/<encoded-cwd>/<id>.jsonl`.
    /// The encoded-cwd segment is unknowable from the id alone, so this scans
    /// the projects tree for a matching file stem — the same shape Claude's
    /// per-project `read_dir` lookup has.
    fn transcript_path_for(&self, conversation_id: &str) -> Option<PathBuf> {
        let expected = format!("{conversation_id}.jsonl");
        WalkDir::new(&self.base_dir)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
            .find(|entry| entry.file_name().to_str() == Some(expected.as_str()))
            .map(|entry| entry.into_path())
    }
}

impl Default for QoderParser {
    fn default() -> Self {
        Self::new()
    }
}

/// One transcript, resolved ONCE.
///
/// The summary and the detail paths both read this, so they cannot disagree —
/// notably about the title, where a mismatch would make the auto-title backfill
/// oscillate between the two answers.
struct Transcript {
    messages: Vec<UnifiedMessage>,
    session_id: Option<String>,
    cwd: Option<String>,
    git_branch: Option<String>,
    model: Option<String>,
    title: Option<String>,
    first_ts: Option<DateTime<Utc>>,
    last_ts: Option<DateTime<Utc>>,
    /// Prompt tokens Qoder itself reported (`token-stats`), when it did.
    reported_prompt_tokens: Option<u64>,
    /// Context window Qoder itself reported (`runtime-config.contextWindow`).
    reported_context_window: Option<u64>,
    /// Occupancy from the newest response that stated one, if any.
    reported_context: Option<ReportedContext>,
}

/// Qoder's own context-occupancy report, attached to every response's `usage`
/// as `context_usage_ratio`.
///
/// Worth reading even though the same object carries token counters, because
/// for Qoder's hosted models those counters are REDACTED to zero before they
/// reach the transcript (the ratio is computed from the real figures first and
/// copied onto the redacted usage, so it survives — see
/// `acp::registry`'s `QODER_EXPOSE_TOKEN_USAGE` note). For a session recorded
/// without that env this is the only occupancy signal in the file.
///
/// It also names the window, which nothing else here does: `token-stats` gives
/// prompt tokens only, `runtime-config.contextWindow` is null even when Qoder
/// writes the record, and the model ids are account-internal keys that
/// [`infer_context_window_max_tokens`] cannot match.
#[derive(Debug, Clone, Copy)]
struct ReportedContext {
    /// `0.0..=1.0`, as Qoder clamps it.
    ratio: f64,
    /// Raw `input_tokens` from the SAME usage object, i.e. the numerator of
    /// Qoder's own `min(1, max(0, input_tokens / window))`. Zero when the
    /// counters were redacted.
    ///
    /// This is the WHOLE prompt, cached prefix included (see
    /// [`qoder_turn_usage`]), so after that normalization it equals the turn's
    /// [`latest_turn_prompt_usage_tokens`] — which is what keeps the gauge's
    /// percentage and its used/max pair from contradicting each other.
    input_tokens: u64,
}

impl ReportedContext {
    fn percent(self) -> f64 {
        self.ratio * 100.0
    }

    /// The model's context window, recovered by inverting Qoder's own formula.
    ///
    /// Exact in practice — the ratio is written as a full-precision float, so
    /// the division lands on the integer (verified against a live transcript:
    /// `0.015572222222222222 × 180000 = 2803`, and `2803 / ratio` rounds back
    /// to 180000).
    ///
    /// `None` unless the inversion is trustworthy. A redacted (zero) numerator
    /// carries no information, and a ratio Qoder clamped to 1.0 means "full or
    /// overflowing", where the quotient is the occupancy rather than the
    /// window. Both would otherwise invent a number and show it as fact.
    fn window(self) -> Option<u64> {
        if self.input_tokens == 0 || self.ratio <= 0.0 || self.ratio >= 1.0 {
            return None;
        }
        let window = (self.input_tokens as f64 / self.ratio).round();
        if !window.is_finite() || window < self.input_tokens as f64 {
            return None;
        }
        // Past 2^53 an f64 no longer holds every integer, and past `u64::MAX`
        // the cast below SATURATES rather than failing — so a preposterous
        // ratio (1 token at 5e-20) would otherwise be reported as a real
        // window instead of no window at all. 2^53 is the boundary where the
        // arithmetic itself stops being exact, which is the honest place to
        // stop trusting it; every real context window is nine orders of
        // magnitude below it.
        const MAX_EXACT_INTEGER: f64 = 9_007_199_254_740_992.0; // 2^53
        if window > MAX_EXACT_INTEGER {
            return None;
        }
        Some(window as u64)
    }
}

/// Qoder's `usage` as ANTHROPIC-shaped counters.
///
/// The field NAMES are Anthropic's, but the semantics behind them are OpenAI's
/// — Qoder's own `model_config` says `"format":"openai"`, and its gateway fills
/// `input_tokens` with the whole prompt, of which `cache_read_input_tokens` is
/// a SUBSET rather than a second helping. Summing the two (which every shared
/// helper does, because for Claude they really are disjoint) counts the cached
/// prefix twice: a real session measured 20513 input / 18871 cache-read, so the
/// gauge read 39384 against a 200000 window — 19.7% — while Qoder itself
/// reported 10.26% for the same turn.
///
/// Splitting the cached part out restores the invariant the rest of the
/// pipeline assumes, and makes `input + cache_read + cache_creation` come back
/// out as the original `input_tokens` — the exact numerator of
/// [`ReportedContext`]'s ratio, so the percentage and the used/max pair agree
/// by construction.
///
/// Same correction `parsers::codex::codex_usage_counters` applies for the same
/// reason. This is what `FACT_SCHEMA_VERSION` 3 exists for: sessions with real
/// counters are not only the ones codeg launched with the usage launch env —
/// a custom/BYO model has always exposed them, and the parser reads every
/// session under `~/.qoder/projects` — so stored rows need a full rebuild
/// under the new rule.
fn qoder_turn_usage(value: &Value) -> Option<TurnUsage> {
    let mut usage = extract_usage(value)?;
    let cached = usage
        .cache_read_input_tokens
        .saturating_add(usage.cache_creation_input_tokens);
    // `saturating_sub` rather than an assertion: a payload where the cached
    // part exceeds the prompt is nonsense, and clamping to zero degrades to
    // "the prompt was entirely cache" instead of wrapping to ~1.8e19.
    usage.input_tokens = usage.input_tokens.saturating_sub(cached);
    Some(usage)
}

/// Read `message.usage.context_usage_ratio` off an assistant record.
///
/// Absent on every record Qoder wrote before it started reporting one, and on
/// responses that never reached the model, so a missing field is ordinary.
fn extract_reported_context(value: &Value) -> Option<ReportedContext> {
    let usage = value.get("message")?.get("usage")?;
    let ratio = usage.get("context_usage_ratio").and_then(Value::as_f64)?;
    if !ratio.is_finite() || ratio < 0.0 {
        return None;
    }
    Some(ReportedContext {
        ratio: ratio.min(1.0),
        input_tokens: usage
            .get("input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    })
}

impl Transcript {
    /// Messages, not raw records: the count the sessions list shows should be
    /// what the conversation actually renders, so rewound branches, `isMeta`
    /// injections and `<synthetic>` placeholders are already gone. A failed
    /// turn's line is drawn but is nobody's message, so it does not count —
    /// as Claude Code's own does not (`parsers::claude`).
    fn message_count(&self) -> u32 {
        self.messages
            .iter()
            .filter(|m| !matches!(m.content.as_slice(), [ContentBlock::TurnError { .. }]))
            .count() as u32
    }

    fn folder_name(&self) -> Option<String> {
        self.cwd.as_deref().map(folder_name_from_path)
    }
}

/// A record that carries conversation content. The metadata records interleave
/// with these and repeat at the file tail; their `timestamp` is an integer
/// epoch (content records use ISO strings), which is why they can never move
/// `started_at` / `ended_at`.
fn is_content_record(value: &Value) -> bool {
    matches!(
        value.get("type").and_then(Value::as_str),
        Some("user" | "assistant")
    )
}

fn is_sidechain(value: &Value) -> bool {
    value
        .get("isSidechain")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// ISO-8601 `timestamp` string on a content record.
fn record_timestamp(value: &Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.with_timezone(&Utc))
}

/// The assistant records that are bookkeeping rather than an answer.
///
/// Beyond Claude's `<synthetic>` placeholder, Qoder writes a FAILED turn as a
/// real assistant record: `isApiErrorMessage: true`, `model: "<synthetic>"`,
/// and a `content` whose text is the raw provider payload (e.g.
/// `{"pricingUrl":"https://qoder.com/pricing?client=qoder"}` for an
/// unentitled account). Rendering that as the model's reply puts an internal
/// error string in the assistant's mouth — and it is the FIRST thing an
/// unauthenticated user would see, since every turn fails that way. So it is
/// drawn as the turn's failure line instead (`claude::api_error_text`).
fn is_non_conversational_assistant(value: &Value) -> bool {
    is_synthetic_assistant(value)
        || value
            .get("isApiErrorMessage")
            .and_then(Value::as_bool)
            .unwrap_or(false)
}

/// Indices of the `user`/`assistant` records that make up the conversation as
/// Qoder itself would replay it, in chronological order.
///
/// Qoder's own reader resolves history by walking `parentUuid` back from a leaf
/// and reversing, tolerating cycles and broken links (it records them as
/// diagnostics and stops). This mirrors that, with two choices worth naming:
///
/// * **Which leaf.** The newest `active-leaf` record wins when it appears after
///   the last content record — that is the marker Qoder rewrites on every
///   commit, and it is the only thing that knows about a rewind the user made
///   without sending anything afterwards. Otherwise the last content record is
///   the leaf, which is what a rewind-then-continue produces anyway (the new
///   message descends from the rewound leaf, so the abandoned branch is simply
///   not among its ancestors).
/// * **When NOT to trust the walk.** Every fallback here errs toward showing
///   MORE history, because hiding a message the user really sent is the only
///   unrecoverable outcome. So append order wins whenever the graph does not
///   fully explain the file: no `parentUuid` links anywhere (an older writer),
///   a walk that dies on a dangling parent or a cycle instead of reaching a
///   root, or a tail-chosen leaf that is itself a root while older content
///   exists (a writer that chained only some records — a genuine rewind to the
///   session's first message can only be selected by an explicit `active-leaf`).
///   A rewind never produces any of those: the abandoned records stay in the
///   file, so the live chain still resolves cleanly to the root.
///
/// `attachment` and `system` records are indexed but not returned: they sit ON
/// the chain between content records, so the walk has to be able to step
/// through them even though they render nothing here.
fn active_branch(records: &[Value]) -> Vec<usize> {
    let append_order: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(_, v)| is_content_record(v) && !is_sidechain(v))
        .map(|(i, _)| i)
        .collect();

    let mut by_uuid: HashMap<&str, usize> = HashMap::new();
    let mut has_links = false;
    for (i, value) in records.iter().enumerate() {
        if is_sidechain(value) {
            continue;
        }
        if let Some(uuid) = value.get("uuid").and_then(Value::as_str) {
            by_uuid.entry(uuid).or_insert(i);
        }
        has_links |= value
            .get("parentUuid")
            .and_then(Value::as_str)
            .is_some_and(|p| !p.is_empty());
    }
    let tail = append_order.last().copied();

    // `leafUuid: null` is Qoder saying the branch is EMPTY — not that the marker
    // is broken. The record schema declares the field nullable
    // (`gpr(A,"leafUuid")`, the same nullable-string check `parentUuid` gets),
    // and the rewind path persists whatever it retained:
    // `recordActiveLeaf(n.retainedLeafUuid, {explicit:true, rewound:true})`,
    // which is null exactly when the user rewound the FIRST prompt and kept
    // nothing. Qoder then replays an empty conversation; treating the marker as
    // malformed and falling back to the tail would re-display the prompt, the
    // reply, the title and the token usage that the user just cleared.
    //
    // Two conditions keep this from ever blanking a live session — the one
    // outcome worse than showing too much. The marker must be NEWER than every
    // content record (a stale null followed by fresh messages must not erase
    // them), and `leafUuid` must be PRESENT and literally null: a missing or
    // malformed key is a writer this parser does not understand, and those still
    // fall through to showing history.
    let newest_marker = records
        .iter()
        .enumerate()
        .rev()
        .find(|(_, value)| value.get("type").and_then(Value::as_str) == Some("active-leaf"));
    if let Some((marker_pos, marker)) = newest_marker {
        if matches!(marker.get("leafUuid"), Some(Value::Null))
            && tail.is_none_or(|tail_idx| marker_pos > tail_idx)
        {
            return Vec::new();
        }
    }

    if !has_links {
        return append_order;
    }

    let marker = records.iter().enumerate().rev().find_map(|(pos, value)| {
        if value.get("type").and_then(Value::as_str) != Some("active-leaf") {
            return None;
        }
        let leaf = value.get("leafUuid").and_then(Value::as_str)?;
        by_uuid.get(leaf).copied().map(|idx| (pos, idx))
    });
    let (leaf, chosen_by_marker) = match (marker, tail) {
        // The marker only overrides the tail when it was written LATER: a stale
        // `active-leaf` followed by fresh messages must not truncate them away.
        (Some((marker_pos, marker_idx)), Some(tail_idx)) => {
            if marker_pos > tail_idx {
                (marker_idx, true)
            } else {
                (tail_idx, false)
            }
        }
        (Some((_, marker_idx)), None) => (marker_idx, true),
        (None, Some(tail_idx)) => (tail_idx, false),
        (None, None) => return append_order,
    };

    let mut chain = Vec::new();
    let mut seen: HashSet<usize> = HashSet::new();
    let mut reached_root = false;
    let mut cursor = Some(leaf);
    while let Some(index) = cursor {
        if !seen.insert(index) {
            break; // parent cycle — the graph is not trustworthy
        }
        chain.push(index);
        // `logicalParentUuid` is how the chain survives a COMPACTION. Qoder
        // writes the `system`/`compact_boundary` record with `parentUuid: null`
        // on purpose — that is what makes the post-compaction segment its own
        // root for replay — and stashes the real predecessor in
        // `logicalParentUuid`. Following only `parentUuid` would stop dead at
        // the boundary and hide every message the user sent before it.
        match records[index]
            .get("parentUuid")
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty())
            .or_else(|| {
                records[index]
                    .get("logicalParentUuid")
                    .and_then(Value::as_str)
                    .filter(|parent| !parent.is_empty())
            })
        {
            // `null`, absent or empty on BOTH: this record starts the session.
            None => {
                reached_root = true;
                break;
            }
            Some(parent) => cursor = by_uuid.get(parent).copied(),
        }
    }
    if !reached_root {
        return append_order;
    }

    chain.reverse();
    chain.retain(|&i| is_content_record(&records[i]));

    if chain.is_empty() || (!chosen_by_marker && chain.len() < 2 && append_order.len() > 1) {
        return append_order;
    }
    reattach_parallel_tool_results(records, &mut chain, &by_uuid);
    chain
}

/// Re-attach the tool results that hang OFF the chain instead of sitting on it.
///
/// A batch of PARALLEL tool calls is not one record. The 1.1.23 bundle writes
/// one assistant record per `tool_use` and then one `user` record per result —
/// `…map(A => WMA([A], o.get(A.tool_use_id) ?? …))`, where `o` maps a
/// `tool_use.id` to the uuid of the assistant record that issued it, and that
/// uuid becomes the result's `sourceToolAssistantUUID` and hence its
/// `parentUuid`. The results are therefore SIBLINGS: each descends from its own
/// call, and only the last one appended is an ancestor of whatever the model
/// says next.
///
/// A pure ancestor walk consequently keeps exactly one result per parallel
/// batch and silently drops the others, leaving their `tool_use` cards looking
/// like calls that never came back. Anything reading two files at once — a
/// completely ordinary turn — hits this.
///
/// Gating on `sourceToolAssistantUUID` is what keeps the repair from
/// resurrecting an abandoned branch: a rewind re-roots on a HUMAN prompt, which
/// carries no such marker, and the tool results re-run under it point at the new
/// assistant records, not the live ones.
fn reattach_parallel_tool_results(
    records: &[Value],
    chain: &mut Vec<usize>,
    by_uuid: &HashMap<&str, usize>,
) {
    let on_chain: HashSet<usize> = chain.iter().copied().collect();
    let mut recovered: Vec<usize> = records
        .iter()
        .enumerate()
        .filter(|(index, value)| {
            !on_chain.contains(index)
                && is_content_record(value)
                && !is_sidechain(value)
                && value
                    .get("sourceToolAssistantUUID")
                    .and_then(Value::as_str)
                    .and_then(|uuid| by_uuid.get(uuid))
                    .is_some_and(|issuer| on_chain.contains(issuer))
        })
        .map(|(index, _)| index)
        .collect();
    if recovered.is_empty() {
        return;
    }
    chain.append(&mut recovered);
    // The transcript is append-only, so file order IS turn order: sorting the
    // merged set puts every recovered result back beside its siblings.
    chain.sort_unstable();
}

/// Read every JSON record out of a transcript's bytes, skipping blank and
/// unparsable lines (a partially-written trailing line is normal for a session
/// still in flight).
fn load_records(bytes: &[u8]) -> Vec<Value> {
    bytes
        .split(|b| *b == b'\n')
        .filter_map(|chunk| std::str::from_utf8(chunk).ok())
        .filter(|line| !line.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn parse_transcript(bytes: &[u8]) -> Transcript {
    let records = load_records(bytes);

    let mut session_id = None;
    let mut cwd = None;
    let mut git_branch = None;
    let mut launch_model = None;
    let mut custom_title = None;
    let mut ai_title = None;
    let mut reported_prompt_tokens = None;
    let mut reported_context_window = None;

    // Metadata sweep over EVERY record, including the tail repeats: these are
    // snapshots, so the newest value of each wins. Deliberately independent of
    // the branch walk — a title or a context window stays true no matter which
    // branch is live.
    for value in &records {
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if is_sidechain(value) {
            continue;
        }
        capture_title_record(value, record_type, &mut custom_title, &mut ai_title);
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(Value::as_str)
                .map(String::from);
        }
        if cwd.is_none() {
            cwd = value.get("cwd").and_then(Value::as_str).map(String::from);
        }
        if git_branch.is_none() {
            git_branch = value
                .get("gitBranch")
                .and_then(Value::as_str)
                .map(String::from);
        }
        match record_type {
            "runtime-config" => {
                if let Some(model) = value.get("model").and_then(Value::as_str) {
                    launch_model = Some(model.to_string());
                }
                // The CLI's own window for the launch model. Authoritative where
                // it exists: `infer_context_window_max_tokens` cannot size a
                // Qoder model id (`qmodel_38max` and friends carry no lane
                // marker), so without this the gauge simply has no maximum.
                if let Some(window) = value
                    .get("contextWindow")
                    .and_then(Value::as_u64)
                    .filter(|w| *w > 0)
                {
                    reported_context_window = Some(window);
                }
            }
            "token-stats" => {
                if let Some(prompt_tokens) = value
                    .get("promptTokenCount")
                    .and_then(Value::as_u64)
                    .filter(|t| *t > 0)
                {
                    reported_prompt_tokens = Some(prompt_tokens);
                }
            }
            _ => {}
        }
    }

    let mut messages: Vec<UnifiedMessage> = Vec::new();
    let mut usage_owner_by_message_id: HashMap<String, usize> = HashMap::new();
    // `message.id` of the assistant response currently accumulating; `None`
    // whenever the previous message was not one of its fragments.
    let mut pending_assistant_chat_id: Option<String> = None;
    let mut model: Option<String> = None;
    let mut first_prompt_title: Option<String> = None;
    let mut first_ts: Option<DateTime<Utc>> = None;
    let mut last_ts: Option<DateTime<Utc>> = None;
    // Newest wins, and only over the ACTIVE branch: occupancy is a statement
    // about the context the next prompt will carry, so a figure left behind by
    // a rewound branch describes history that no longer exists.
    let mut reported_context: Option<ReportedContext> = None;

    for index in active_branch(&records) {
        let value = &records[index];
        // Addressed to the MODEL, not spoken by anyone: hook injections, the
        // max-output-token retry prompt and slash-command expansions all arrive
        // as `isMeta` records that ALSO carry `origin.kind: "human"`, so origin
        // alone cannot tell them apart from a real prompt.
        if is_meta_message(value) || is_interrupt_marker(value) {
            continue;
        }
        let record_type = value.get("type").and_then(Value::as_str).unwrap_or("");
        if record_type == "assistant" && is_non_conversational_assistant(value) {
            // A FAILED turn's record still closes its round, as the failure
            // line rather than as the model's reply.
            if let Some(failure) = api_error_text(value).and_then(|text| {
                let uuid = value.get("uuid").and_then(Value::as_str).unwrap_or("");
                let timestamp = record_timestamp(value).or(last_ts)?;
                super::turn_error_message(uuid.to_string(), &text, timestamp)
            }) {
                pending_assistant_chat_id = None;
                messages.push(failure);
            }
            continue;
        }
        let Some(timestamp) = record_timestamp(value).or(last_ts) else {
            continue;
        };
        let uuid = value.get("uuid").and_then(Value::as_str).map(String::from);

        match record_type {
            "user" => {
                // A slash command is persisted as the tag soup Claude Code
                // invented and Qoder copied verbatim (`command-name` /
                // `command-message` / `command-args` are literal string
                // constants in the 1.1.23 bundle). `strip_system_tags` erases
                // ALL of them, so without reconstructing the invocation first
                // the record renders empty and is dropped — the `/command` the
                // user typed just disappears from the transcript.
                let slash = raw_user_text(value)
                    .as_deref()
                    .and_then(slash_command_display);
                // Otherwise: both content shapes — a bare string, and the block
                // array Qoder writes for every ACP-entrypoint prompt and for any
                // prompt carrying an attachment. Tool results (which Qoder, like
                // Claude Code, delivers as `user` records) come back as
                // `ToolResult` blocks and are folded into the assistant turn by
                // `group_into_turns`.
                let content = match &slash {
                    Some(display) => vec![ContentBlock::Text {
                        text: display.clone(),
                    }],
                    None => with_recorded_ask_answers(value, extract_user_content(value)),
                };
                if content.is_empty() {
                    continue;
                }
                let furniture = is_transcript_furniture(value);
                if !furniture && first_prompt_title.is_none() && is_human_prompt(value) {
                    if let Some(text) = slash.or_else(|| extract_user_text(value)) {
                        first_prompt_title = Some(title_from_user_text(&text));
                    }
                }
                messages.push(UnifiedMessage {
                    id: uuid.unwrap_or_else(|| format!("q-user-{}", messages.len())),
                    role: if furniture {
                        MessageRole::System
                    } else {
                        MessageRole::User
                    },
                    content,
                    timestamp,
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: Some(timestamp),
                agent_message_id: None,
                });
                pending_assistant_chat_id = None;
            }
            "assistant" => {
                let content = extract_assistant_content(value);
                if content.is_empty() {
                    continue;
                }
                // A blank `model` names nothing, so it is dropped here, once,
                // for every use below: stored, it would overwrite the last valid
                // model, block the launch-model fallback, and give its bubble
                // (and turn) an empty name.
                let entry_model = value
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .filter(|m| !m.trim().is_empty())
                    .map(String::from);
                // Last NON-EMPTY model wins: a mid-session switch has to land
                // in `summary.model` (the details dialog reads it ahead of the
                // turns) and in the context-window fallback below. Pinning the
                // FIRST model here left both on the session's opening model —
                // a switch to Qwen3.8-Flash still displayed DeepSeek-Flash
                // next to the new model's 200K window.
                if entry_model.is_some() {
                    model.clone_from(&entry_model);
                }
                let message_id = value
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(String::from);

                // One API response streams as SEVERAL records (thinking,
                // tool_use, final text) sharing one `message.id`; adjacent
                // fragments merge into a single bubble. 1.1.65 repeats the
                // response's full usage on every one of them, 1.1.67 writes it
                // on the last one only; either way the claim below keeps it on
                // exactly one message — including across the turn boundary a
                // tool result opens, where the trailing fragment lands in a
                // different bubble than its siblings.
                let merges_into_pending = message_id.is_some()
                    && pending_assistant_chat_id == message_id
                    && matches!(
                        messages.last(),
                        Some(UnifiedMessage {
                            role: MessageRole::Assistant,
                            ..
                        })
                    );
                let owner_index = if merges_into_pending {
                    messages.len() - 1
                } else {
                    messages.len()
                };
                let usage = ClaudeRecordAccumulator::claim_assistant_usage(
                    &mut messages,
                    &mut usage_owner_by_message_id,
                    message_id.as_deref(),
                    qoder_turn_usage(value),
                    owner_index,
                );
                // Read off the RAW record rather than the claimed usage: the
                // claim exists to stop one response's counters being added up
                // once per fragment, but occupancy is a level, not a sum, and
                // every fragment that carries usage carries the same one. Taking
                // it here keeps the figure even when the claim handed the usage
                // to an earlier bubble.
                if let Some(reported) = extract_reported_context(value) {
                    reported_context = Some(reported);
                }

                if merges_into_pending {
                    let last = messages.last_mut().expect("checked non-empty");
                    last.content.extend(content);
                    last.completed_at = Some(timestamp);
                    if usage.is_some() {
                        last.usage = usage;
                    }
                    if entry_model.is_some() {
                        last.model = entry_model;
                    }
                } else {
                    messages.push(UnifiedMessage {
                        id: uuid.unwrap_or_else(|| format!("q-assistant-{}", messages.len())),
                        role: MessageRole::Assistant,
                        content,
                        timestamp,
                        usage,
                        duration_ms: None,
                        model: entry_model,
                        completed_at: Some(timestamp),
                    agent_message_id: None,
                    });
                }
                pending_assistant_chat_id = message_id;
            }
            _ => continue,
        }

        first_ts.get_or_insert(timestamp);
        last_ts = Some(timestamp);
    }

    Transcript {
        messages,
        session_id,
        cwd,
        git_branch,
        // A real reply names the model; `runtime-config` only says what the
        // session was LAUNCHED with, which is also all an error-only session
        // (every turn `<synthetic>`) can offer.
        model: model.or(launch_model),
        // The user's own name for the session, then Qoder's generated one, then
        // the first prompt. Same precedence Qoder's session picker applies.
        title: custom_title.or(ai_title).or(first_prompt_title),
        first_ts,
        last_ts,
        reported_prompt_tokens,
        reported_context_window,
        reported_context,
    }
}

/// A `user` record that is transcript furniture rather than something the user
/// said: Qoder's own "is this a real prompt" predicate rejects exactly these
/// three flags alongside `isMeta`.
///
/// * `isCompactSummary` — the continuation summary compaction writes back into
///   the stream. It is content worth SEEING, but it is not a prompt, so it
///   renders as a system turn and can never become the session's title.
/// * `isVisibleInTranscriptOnly` — shown to the user, never sent to the model.
/// * `isVirtual` — a record Qoder materializes for its own bookkeeping; its own
///   payload builder skips these outright (`case "user": if (i.isVirtual) break`).
///
/// All three keep their content and render as a system turn rather than being
/// dropped: none of them is the user talking, but none is worth hiding either.
fn is_transcript_furniture(value: &Value) -> bool {
    ["isCompactSummary", "isVisibleInTranscriptOnly", "isVirtual"]
        .iter()
        .any(|flag| value.get(*flag).and_then(Value::as_bool).unwrap_or(false))
}

/// A user record's text BEFORE any tag stripping, across both content shapes.
///
/// Only [`slash_command_display`] wants this: everything else goes through
/// Claude's extractors, which strip the system tags on the way out.
fn raw_user_text(value: &Value) -> Option<String> {
    match value.pointer("/message/content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(items) => {
            let texts: Vec<&str> = items
                .iter()
                .filter(|item| item.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|item| item.get("text").and_then(Value::as_str))
                .collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// Whether a `user` record is a prompt a HUMAN typed, as opposed to a tool
/// result or a synthetic continuation.
///
/// Qoder marks real prompts with `origin.kind == "human"`. A record with no
/// `origin` at all is treated as human — the field is a newer addition, and a
/// missing marker must not cost an old session its title.
fn is_human_prompt(value: &Value) -> bool {
    match value.pointer("/origin/kind").and_then(Value::as_str) {
        Some(kind) => kind == "human",
        None => true,
    }
}

/// A `user` record's content, with an answered `AskUserQuestion` result
/// carrying the answers Qoder recorded (`toolUseResult`) rather than the
/// sentence it handed the model (see [`qoder_ask_envelope_from_recorded`]).
///
/// Qoder writes one tool result per `user` record, and `toolUseResult` belongs
/// to it; with any other number of results the pairing is not certain, so the
/// content is left as it is.
fn with_recorded_ask_answers(record: &Value, mut content: Vec<ContentBlock>) -> Vec<ContentBlock> {
    let mut results = content
        .iter_mut()
        .filter(|block| matches!(block, ContentBlock::ToolResult { .. }));
    let (
        Some(ContentBlock::ToolResult {
            output_preview,
            is_error: false,
            ..
        }),
        None,
    ) = (results.next(), results.next())
    else {
        return content;
    };
    if let Some(envelope) = record
        .get("toolUseResult")
        .and_then(qoder_ask_envelope_from_recorded)
    {
        *output_preview = Some(envelope);
    }
    content
}

/// Qoder's native question tool, by the name it records in transcripts and
/// stamps on its live `tool_call` (`_meta.qoder.toolName`).
pub(crate) const QODER_ASK_USER_QUESTION_TOOL: &str = "AskUserQuestion";

/// One question of a Qoder `AskUserQuestion` call, as the call's own input
/// states it: `questions[i]` of the live `tool_call`'s `rawInput`, and of the
/// `toolUseResult` the transcript records next to the result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct QoderAskQuestion {
    question: String,
    header: String,
    multi_select: bool,
    labels: Vec<String>,
}

impl QoderAskQuestion {
    /// The questions of an `AskUserQuestion` input, in order. `None` unless
    /// every entry carries its `question` text: that text is what Qoder keys
    /// each answer by, so a list missing one cannot be matched to the answers.
    pub(crate) fn list_from(questions: Option<&Value>) -> Option<Vec<Self>> {
        let parsed = questions?
            .as_array()?
            .iter()
            .map(|item| {
                Some(Self {
                    question: item.get("question")?.as_str()?.to_string(),
                    header: item
                        .get("header")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    multi_select: item
                        .get("multiSelect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    labels: item
                        .get("options")
                        .and_then(Value::as_array)
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| option.get("label").and_then(Value::as_str))
                                .filter(|label| !label.is_empty())
                                .map(String::from)
                                .collect()
                        })
                        .unwrap_or_default(),
                })
            })
            .collect::<Option<Vec<_>>>()?;
        (!parsed.is_empty()).then_some(parsed)
    }

    /// One RECORDED answer back as the picks the question card partitions
    /// against the options, claiming no choice the record cannot prove.
    ///
    /// A single-select answer is one pick, verbatim: an offered label or the
    /// user's own text. A multi-select answer reaches Qoder as a list, but
    /// Qoder keeps it as one string, `values.join(", ")`, with the user's own
    /// "Other" text in that same list (codeg's card writes it after the chosen
    /// labels; see `crate::acp::question::build_elicitation_response`). So:
    ///
    /// - read exactly one way as offered labels joined by ", " → those labels;
    /// - not readable as labels at all (the user's own text is in it) → the
    ///   literal text, one pick, which the card shows as typed text — it
    ///   cannot equal a label, or it would have read as one;
    /// - readable several ways (options like "Red", "Green" and "Red, Green")
    ///   → the literal text if it is no label, and no pick at all if it is
    ///   one, since the card would show that label as chosen.
    ///
    /// A live call codeg answered itself does not need this: it renders the
    /// reply as sent, before Qoder flattened it (see
    /// [`qoder_ask_envelope_from_reply`]).
    fn picks(&self, answer: &str) -> Vec<String> {
        if answer.is_empty() {
            return Vec::new();
        }
        if !self.multi_select {
            return vec![answer.to_string()];
        }
        match self.label_reading(answer) {
            LabelReading::Unique(labels) => labels,
            LabelReading::Unreadable => vec![answer.to_string()],
            LabelReading::Ambiguous if self.labels.iter().any(|label| label == answer) => {
                Vec::new()
            }
            LabelReading::Ambiguous => vec![answer.to_string()],
        }
    }

    /// How `answer` reads as offered labels joined by ", ".
    ///
    /// Counted per suffix from the end, capped at two (all [`Self::picks`]
    /// needs is none, one, or several), so the cost stays linear in the
    /// answer's length even when labels are joins of one another ("A",
    /// "A, A") and a long answer could otherwise be split in exponentially
    /// many ways.
    fn label_reading(&self, answer: &str) -> LabelReading {
        let mut labels: Vec<&str> = self.labels.iter().map(String::as_str).collect();
        labels.sort_unstable();
        labels.dedup();
        let end = answer.len();
        // How many readings `label`, placed at byte `at`, opens: none unless
        // it ends the answer (one) or is followed by ", " and a suffix that
        // reads (as many as that suffix does).
        let through = |readings: &[u8], at: usize, label: &str| -> u8 {
            if !answer[at..].starts_with(label) {
                return 0;
            }
            let after = at + label.len();
            if after == end {
                1
            } else if answer[after..].starts_with(", ") {
                readings[after + 2]
            } else {
                0
            }
        };
        // `readings[at]`: the readings of `answer[at..]`, 2 meaning "several".
        let mut readings = vec![0u8; end + 1];
        for at in (0..end).rev().filter(|&at| answer.is_char_boundary(at)) {
            readings[at] = labels
                .iter()
                .map(|label| through(&readings, at, label))
                .fold(0u8, |total, count| total.saturating_add(count).min(2));
        }
        match readings[0] {
            0 => LabelReading::Unreadable,
            1 => {
                // Exactly one label opens the only reading at each step.
                let mut picks = Vec::new();
                let mut at = 0;
                while let Some(label) = labels
                    .iter()
                    .find(|label| through(&readings, at, label) > 0)
                {
                    picks.push((*label).to_string());
                    at += label.len() + 2;
                    if at > end {
                        break;
                    }
                }
                LabelReading::Unique(picks)
            }
            _ => LabelReading::Ambiguous,
        }
    }
}

/// How a recorded multi-select answer reads as the offered labels; see
/// [`QoderAskQuestion::picks`].
enum LabelReading {
    /// Not as labels at all: the user's own text is in it.
    Unreadable,
    /// Exactly one way.
    Unique(Vec<String>),
    /// More than one way, so no reading can be trusted.
    Ambiguous,
}

/// The answers codeg itself sent back for a Qoder `AskUserQuestion`, as the
/// envelope the question card reads.
///
/// This is the one source that is exact: Qoder's form keys question `n` as
/// `q<n>` and codeg's reply writes a multi-select's chosen labels and the
/// user's own text as separate entries, before Qoder flattens them into one
/// string for everything it records or streams (see [`QoderAskQuestion::picks`]).
/// `questions` are the call's own, in order, as its opening `tool_call`
/// carried them.
pub(crate) fn qoder_ask_envelope_from_reply(
    questions: &[QoderAskQuestion],
    reply: &serde_json::Map<String, Value>,
) -> Option<String> {
    let answered: Vec<_> = questions
        .iter()
        .enumerate()
        .filter_map(|(index, question)| {
            let picks: Vec<String> = match reply.get(&format!("q{index}"))? {
                Value::String(answer) => vec![answer.clone()],
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect(),
                _ => return None,
            };
            let picks: Vec<String> = picks.into_iter().filter(|pick| !pick.is_empty()).collect();
            (!picks.is_empty()).then_some((question, picks))
        })
        .collect();
    (!answered.is_empty()).then(|| qoder_ask_envelope(answered))
}

/// The answer envelope codeg's question card reads (`parseAskQuestionOutcome`
/// in `src/lib/ask-question.ts`): the `{answers: [{header, question, selected}],
/// declined}` shape codeg-mcp's `ask_user_question` records, and the one the
/// OpenCode and Grok history parsers rebuild for their own native asks.
fn qoder_ask_envelope(answered: Vec<(&QoderAskQuestion, Vec<String>)>) -> String {
    let answers: Vec<Value> = answered
        .into_iter()
        .map(|(question, selected)| {
            serde_json::json!({
                "header": question.header,
                "question": question.question,
                "selected": selected,
            })
        })
        .collect();
    serde_json::json!({ "answers": answers, "declined": false }).to_string()
}

/// The answers Qoder recorded for an `AskUserQuestion` call, as the envelope
/// the question card reads: `{questions, answers: {"<question>": "<answer>"}}`,
/// one string per answered question (a multi-select flattened to one
/// `", "`-joined string, which [`QoderAskQuestion::picks`] splits only when
/// that is unambiguous).
///
/// Qoder keeps this object in two places: the transcript record that carries
/// the call's result (`toolUseResult`), and the `rawOutput` of the single,
/// already-completed `tool_call` a `session/load` replay sends for the call.
/// Beside it is only the sentence Qoder hands the model (see
/// [`qoder_ask_envelope_from_result_text`]), which the card cannot read, so
/// without this every answered question reloads with nothing selected.
///
/// `None` for anything else, including a declined ask, whose recorded result
/// is only `{isHardFailure}`; and when no question was answered, which leaves
/// the call's own output in place.
pub(crate) fn qoder_ask_envelope_from_recorded(recorded: &Value) -> Option<String> {
    let questions = QoderAskQuestion::list_from(recorded.get("questions"))?;
    let answers = recorded.get("answers")?.as_object()?;
    let answered: Vec<_> = questions
        .iter()
        .filter_map(|question| {
            let picks = match answers.get(&question.question)? {
                Value::String(answer) => question.picks(answer),
                Value::Array(values) => values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(String::from)
                    .collect(),
                _ => return None,
            };
            (!picks.is_empty()).then_some((question, picks))
        })
        .collect();
    (!answered.is_empty()).then(|| qoder_ask_envelope(answered))
}

/// The start and end of the sentence Qoder's `AskUserQuestion` returns once
/// questions are answered (deobfuscated from the 1.1.67 bundle; the same
/// strings ship in every release from 1.1.23 through 1.1.69, and again in
/// 1.1.72).
const QODER_ANSWERED_PREFIX: &str = "Your questions have been answered: ";
const QODER_ANSWERED_SUFFIX: &str = ". You can now continue with these answers in mind.";

/// The answers in the result text Qoder's completion frame carries for an
/// `AskUserQuestion` call, read against the questions the call was opened
/// with, as the envelope the question card reads: the live path's fallback
/// for a call codeg did not answer itself (when it did, the reply it sent is
/// exact; see [`qoder_ask_envelope_from_reply`]).
///
/// That frame's `rawOutput` and `content` are both the sentence handed to the
/// model:
/// `Your questions have been answered: "Q1"="A1", "Q2"="B, C". You can now
/// continue with these answers in mind.`, one entry per answered question in
/// question order (`AskUserQuestion.execute`). Knowing the question texts is
/// what lets each answer be cut out whole: an entry opens with
/// `"<question>"="` and its answer runs to the next answered question's
/// `", "<question>"="` or to the closing quote, so quotes or ", " inside a
/// question or an answer do not split it. The answer text is then the same
/// string the transcript records, and splits into picks by the same rule
/// ([`QoderAskQuestion::picks`]).
///
/// `None`, leaving the frame's own output in place, for any text that is not
/// that sentence: a rejection, the "did not answer" sentence, a future
/// rewording, or entries that do not line up with the questions.
pub(crate) fn qoder_ask_envelope_from_result_text(
    questions: &[QoderAskQuestion],
    text: &str,
) -> Option<String> {
    let mut rest = text
        .trim()
        .strip_prefix(QODER_ANSWERED_PREFIX)?
        .strip_suffix(QODER_ANSWERED_SUFFIX)?;
    let mut answered = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        let Some(entry) = rest.strip_prefix(&format!("\"{}\"=\"", question.question)) else {
            // Unanswered questions have no entry.
            continue;
        };
        let next_entry = questions[index + 1..]
            .iter()
            .filter_map(|later| entry.find(&format!("\", \"{}\"=\"", later.question)))
            .min();
        let answer = match next_entry {
            Some(end) => {
                // Past the `", ` that closes this entry and separates the next.
                rest = &entry[end + 3..];
                &entry[..end]
            }
            None => {
                let answer = entry.strip_suffix('"')?;
                rest = "";
                answer
            }
        };
        answered.push((question, question.picks(answer)));
    }
    (rest.is_empty() && !answered.is_empty()).then(|| qoder_ask_envelope(answered))
}

impl AgentParser for QoderParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();
        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        for entry in WalkDir::new(&self.base_dir)
            .max_depth(2)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            if !entry.file_type().is_file()
                || path.extension().and_then(|e| e.to_str()) != Some("jsonl")
            {
                continue;
            }
            if let Ok(Some(summary)) =
                super::summary_cache::get_or_parse(AgentType::Qoder, path, || {
                    Ok(parse_summary(path))
                })
            {
                conversations.push(summary);
            }
        }

        conversations.sort_by_key(|c| std::cmp::Reverse(c.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        let path = self
            .transcript_path_for(conversation_id)
            .ok_or_else(|| ParseError::ConversationNotFound(conversation_id.to_string()))?;
        parse_detail(&path, conversation_id)
    }
}

fn parse_summary(path: &Path) -> Option<ConversationSummary> {
    let bytes = fs::read(path).ok()?;
    let transcript = parse_transcript(&bytes);
    let started_at = transcript.first_ts?;
    // The FILE STEM, not the in-record `sessionId`: this id is what
    // `get_conversation` is later handed, and that resolves it by searching the
    // projects tree for `<id>.jsonl` (which is also how Qoder itself addresses a
    // session — `getFilePath(id) => <dir>/<id>.jsonl`). The two agree for every
    // file Qoder wrote itself; preferring the record would mean a copied or
    // renamed transcript lists a row whose id nothing can open.
    let id = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .filter(|stem| !stem.is_empty())
        .or_else(|| transcript.session_id.clone())?;

    Some(ConversationSummary {
        id,
        agent_type: AgentType::Qoder,
        folder_name: transcript.folder_name(),
        folder_path: transcript.cwd.clone(),
        title: transcript.title.clone(),
        started_at,
        ended_at: transcript.last_ts,
        message_count: transcript.message_count(),
        model: transcript.model.clone(),
        git_branch: transcript.git_branch.clone(),
        parent_id: None,
        parent_tool_use_id: None,
        delegation_call_id: None,
    })
}

fn parse_detail(path: &Path, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
    // Read the file fully up front so `transcript_watermark` is EXACTLY the
    // byte length this parse consumed — see the same contract in
    // `parsers::claude`. An over-claiming watermark (e.g. from a stat around the
    // read) would make the frontend retire background-overlay turns whose
    // content this detail does not include.
    let bytes = fs::read(path)?;
    let transcript_watermark = bytes.len() as u64;
    let transcript = parse_transcript(&bytes);

    let message_count = transcript.message_count();
    let folder_name = transcript.folder_name();
    let mut turns = group_into_turns(transcript.messages);
    relocate_orphaned_tool_results(&mut turns);
    structurize_read_tool_output(&mut turns);
    resolve_patch_line_numbers(&mut turns, transcript.cwd.as_deref());
    backfill_turn_durations(&mut turns, &[]);
    attach_subagent_tool_calls(&mut turns, path);

    // Qoder's own `token-stats` beats any reconstruction; the Anthropic-shaped
    // fallback is prompt tokens only (`output_tokens` is the reply, which does
    // not occupy the window that produced it).
    let used_tokens = transcript
        .reported_prompt_tokens
        .or_else(|| latest_turn_prompt_usage_tokens(&turns));
    // An explicit `runtime-config.contextWindow` first; then the window
    // inverted out of Qoder's own occupancy ratio, which beats the id-prefix
    // table because it is this account's actual limit for this model rather
    // than a family default — and because the ids are internal keys
    // (`qfmodel`) that the table cannot match at all.
    let max_tokens = transcript
        .reported_context_window
        .or_else(|| transcript.reported_context.and_then(ReportedContext::window))
        .or_else(|| infer_context_window_max_tokens(transcript.model.as_deref()));
    // The stated occupancy goes on LAST, over whatever the used/max division
    // produced: for a session recorded before `QODER_EXPOSE_TOKEN_USAGE` there
    // is no division to do, and where there is, Qoder's figure is the original
    // and the division is a round-trip through a rounded window.
    //
    // Sub-agent spend lands on the TURNS, after the occupancy above was read:
    // a sub-agent's context is its own and never occupied the parent's window
    // (claude attributes in the same order). Landing it on turns is also what
    // keeps the details dialog, its totals and the Token board on ONE number —
    // the board's per-turn facts come from turn usage.
    attribute_subagent_usage(&mut turns, path);
    let session_stats = compute_session_stats(&turns);
    let session_stats = with_reported_context_percent(
        merge_context_window_stats(session_stats, used_tokens, max_tokens),
        transcript.reported_context.map(ReportedContext::percent),
    );

    Ok(ConversationDetail {
        summary: ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Qoder,
            folder_name,
            folder_path: transcript.cwd,
            title: transcript.title,
            started_at: transcript.first_ts.unwrap_or_else(Utc::now),
            ended_at: transcript.last_ts,
            message_count,
            model: transcript.model,
            git_branch: transcript.git_branch,
            parent_id: None,
            parent_tool_use_id: None,
            delegation_call_id: None,
        },
        turns,
        session_stats,
        transcript_watermark: Some(transcript_watermark),
    })
}

/// Attach each sub-agent's own transcript to the `Agent` tool result that
/// launched it, as `agent_stats`.
///
/// Qoder (1.1.68, same layout as Claude Code) writes one
/// `subagents/agent-<agentId>.jsonl` per delegated run, an
/// `agent-<agentId>.meta.json` naming the agent type (`agentType`) and the
/// launching tool call (`toolUseId`, absent when there is none), and a
/// `task-<taskId>.json` keyed back by `parentToolUseId`. The task file records
/// the run's lifecycle — `status` (`running` → `completed` / `failed` /
/// `cancelled`, or `interrupted` once a later process finds its owner gone)
/// and `result` (the final report, the error message, or a placeholder) — but
/// no usage or duration: those ride only on the task notification the run
/// delivers to the parent. The conversation itself stays the main chain; this
/// only annotates the Agent card with the sub-agent's PROCESS, mirroring what
/// `parsers::claude` does for Claude Code's sidechain layout.
///
/// The mapping is explicit (`meta.json` → parent tool-call id), never
/// positional: it survives parallel sub-agents, interleaved streams, and a
/// session resumed long after the run. Only runs whose tool call is in the
/// turns being built are parsed — a run launched on a branch since rewound
/// away has nothing to annotate here.
fn attach_subagent_tool_calls(turns: &mut [MessageTurn], session_path: &Path) {
    let dir = session_path.with_extension("").join("subagents");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };

    // The tool results in view that still have no stats: the only ids a meta
    // or task file is worth reading for.
    let mut pending: HashSet<String> = turns
        .iter()
        .flat_map(|turn| turn.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                agent_stats: None,
                ..
            } => Some(id.clone()),
            _ => None,
        })
        .collect();
    if pending.is_empty() {
        return;
    }

    struct TaskInfo {
        status: Option<String>,
        // What the task file filed as the run's outcome. For a COMPLETED run
        // that is the child's final report — reachable here even when the
        // parent turn died before the async result was delivered. The parser
        // attaches it whatever the status; the card decides what to show.
        result: Option<String>,
    }

    // Directory order is filesystem-defined. Read in name order so that two
    // files naming the same tool call resolve the same way on every parse
    // (the first one wins, below and in `tasks`).
    let mut paths: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    paths.sort();

    let mut tasks: HashMap<String, TaskInfo> = HashMap::new();
    // (parent tool-call id, transcript path, agent type)
    let mut agents: Vec<(String, PathBuf, Option<String>)> = Vec::new();
    for path in paths {
        let Some(name) = path.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        if name.starts_with("task-") && name.ends_with(".json") {
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(parent) = value
                .get("parentToolUseId")
                .and_then(Value::as_str)
                .filter(|s| pending.contains(*s))
            else {
                continue;
            };
            tasks.entry(parent.to_string()).or_insert_with(|| TaskInfo {
                status: value
                    .get("status")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                result: value
                    .get("result")
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                    .map(str::to_string),
            });
        } else if name.starts_with("agent-") && name.ends_with(".meta.json") {
            let Ok(bytes) = fs::read(&path) else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Some(parent) = value
                .get("toolUseId")
                .and_then(Value::as_str)
                .filter(|s| pending.contains(*s))
            else {
                continue;
            };
            let transcript = path.with_file_name(format!(
                "{}.jsonl",
                name.trim_end_matches(".meta.json")
            ));
            if transcript.exists() {
                agents.push((
                    parent.to_string(),
                    transcript,
                    value
                        .get("agentType")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                ));
            }
        }
    }

    for (parent, transcript, agent_type) in agents {
        // A second run naming the same tool call: the first (in name order)
        // already landed, and stats are never overwritten.
        if !pending.remove(&parent) {
            continue;
        }
        let (calls, timeline, _usage, _started, transcript_duration) =
            crate::parsers::claude::parse_subagent_tool_calls(&transcript);
        let info = tasks.remove(&parent);
        let stats = AgentExecutionStats {
            agent_type,
            status: info.as_ref().and_then(|i| i.status.clone()),
            // Neither the task nor the meta file records a duration; the child
            // transcript's own first/last-record span stands in.
            total_duration_ms: transcript_duration,
            total_tool_use_count: Some(calls.len() as u32),
            tool_calls: calls,
            timeline,
            recovered_result: info.and_then(|i| i.result),
            ..Default::default()
        };
        let target = turns
            .iter_mut()
            .flat_map(|turn| turn.blocks.iter_mut())
            .find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    agent_stats,
                    ..
                } if *id == parent && agent_stats.is_none() => Some(agent_stats),
                _ => None,
            });
        if let Some(slot) = target {
            *slot = Some(stats);
        }
    }
}

/// Fold this session's SUB-AGENT spend into its turns, from the sub-agent
/// transcripts Qoder writes beside it.
///
/// Every delegated run gets `<sessionId>/subagents/agent-<agentId>.jsonl` —
/// the same layout Claude Code uses (`parsers::claude::attribute_subagent_usage`)
/// — and it is the unit of truth here for the same reasons: the run's own
/// counters ride its assistant records (Anthropic FIELD NAMES over Qoder's
/// OpenAI SEMANTICS, so [`qoder_turn_usage`] splits the cached prefix out),
/// while the alternative — the run's segment log under
/// `logs/sessions/<encoded-cwd>/<sessionId>/segments/` — is rotated by Qoder's
/// 30-day `sessionRetention`, and in some entrypoints its sub-agent turns are
/// indistinguishable from main-chain ones by `turn_id`.
///
/// One API response streams as SEVERAL records sharing one `message.id` —
/// 1.1.65 repeats the same counters on each, 1.1.67 writes them on the last one
/// only — so calls are deduped by that id: counted once, exactly as the main
/// transcript does (`ClaudeRecordAccumulator`).
///
/// Every file in the directory is read exactly once, referenced or not
/// (mirroring claude): a sub-agent that was interrupted, or one launched on a
/// branch that was later rewound away, still spent its tokens. The MAIN chain
/// counts only the current branch; sub-agent transcripts do not participate in
/// that walk, so their spend is counted regardless — a deliberate rule, noted
/// here rather than derived.
///
/// Each call lands on the assistant turn current when THAT call was recorded
/// (by its own timestamp), not on the run's launching turn: a background
/// sub-agent keeps working while the parent has moved on, and per-call
/// placement keeps the turn-level numbers — which the Token board reads —
/// closer to where the spend actually happened. The board attributes the spend
/// to the parent turn's model; that limitation is claude's too.
///
/// Runs AFTER the context-window occupancy was read: a sub-agent's context is
/// its own and never occupied the parent's window.
fn attribute_subagent_usage(turns: &mut [MessageTurn], session_path: &Path) {
    let dir = session_path.with_extension("").join("subagents");
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let mut transcripts: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "jsonl"))
        .collect();
    // Directory order is filesystem-defined; sort so attribution is identical
    // on every parse of the same session.
    transcripts.sort();

    for transcript in transcripts {
        for (recorded_at, usage) in subagent_call_usage(&transcript) {
            // The turn that was speaking when this call happened. Falling back
            // to the last assistant turn keeps the tokens in the session even
            // when the record carries no usable timestamp.
            let target = recorded_at
                .and_then(|ts| {
                    turns
                        .iter()
                        .rposition(|t| matches!(t.role, TurnRole::Assistant) && t.timestamp <= ts)
                })
                .or_else(|| {
                    turns
                        .iter()
                        .rposition(|t| matches!(t.role, TurnRole::Assistant))
                });
            let Some(turn) = target.and_then(|i| turns.get_mut(i)) else {
                continue;
            };
            turn.usage = Some(match turn.usage.take() {
                Some(own) => TurnUsage {
                    input_tokens: own.input_tokens.saturating_add(usage.input_tokens),
                    output_tokens: own.output_tokens.saturating_add(usage.output_tokens),
                    cache_creation_input_tokens: own
                        .cache_creation_input_tokens
                        .saturating_add(usage.cache_creation_input_tokens),
                    cache_read_input_tokens: own
                        .cache_read_input_tokens
                        .saturating_add(usage.cache_read_input_tokens),
                },
                None => usage,
            });
        }
    }
}

/// One sub-agent transcript's calls: `(recorded at, usage)` per API response,
/// deduped by `message.id` with the largest counters winning, and a record
/// without an id counted on its own — the same rule the main transcript
/// applies (`ClaudeRecordAccumulator::claim_assistant_usage`).
/// Local rather than the shared `parsers::claude::parse_subagent_tool_calls`:
/// that one reads usage with `extract_usage` (Anthropic semantics, where the
/// cached counters are disjoint), while Qoder's counters need
/// [`qoder_turn_usage`]'s cache split.
fn subagent_call_usage(path: &Path) -> Vec<(Option<DateTime<Utc>>, TurnUsage)> {
    let Ok(bytes) = fs::read(path) else {
        return Vec::new();
    };
    let mut per_call: HashMap<String, (Option<DateTime<Utc>>, TurnUsage)> = HashMap::new();
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(value) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("assistant") {
            continue;
        }
        let Some(usage) = qoder_turn_usage(&value) else {
            continue;
        };
        // A record with no `message.id` cannot be grouped with anything, so it
        // gets a key of its own rather than being dropped — the parent
        // transcript and claude's sub-agent reader treat the same shape so.
        let key = value
            .pointer("/message/id")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(String::from)
            .unwrap_or_else(|| format!("__ungrouped-{}__", per_call.len()));
        let billable = |u: &TurnUsage| {
            u.input_tokens
                .saturating_add(u.output_tokens)
                .saturating_add(u.cache_creation_input_tokens)
                .saturating_add(u.cache_read_input_tokens)
        };
        match per_call.get_mut(&key) {
            Some(slot) => {
                if billable(&usage) > billable(&slot.1) {
                    slot.1 = usage;
                }
                if slot.0.is_none() {
                    slot.0 = record_timestamp(&value);
                }
            }
            None => {
                per_call.insert(key, (record_timestamp(&value), usage));
            }
        }
    }
    per_call.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::ContentBlock;

    fn parser_in(tmp: &std::path::Path) -> QoderParser {
        QoderParser::with_base_dir(tmp.join("projects"))
    }

    fn write_session(tmp: &std::path::Path, id: &str, lines: &[&str]) -> PathBuf {
        let dir = tmp.join("projects").join("-private-tmp-probe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn text_of(turn: &crate::models::MessageTurn) -> String {
        turn.blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("|")
    }

    // Lines captured verbatim from a real qoder 1.1.23 session (paths and ids
    // trimmed to the essentials the parser reads).
    const RUNTIME_CONFIG: &str = r#"{"type":"runtime-config","sessionId":"s1","model":"qmodel_38max","reasoningEffort":null,"contextWindow":262144,"generation":null,"timestamp":1786895127277}"#;
    const USER_LINE: &str = r#"{"type":"user","uuid":"u1","timestamp":"2026-08-16T15:45:27.384Z","message":{"role":"user","content":"read NOTES.md and reply"},"permissionMode":"default","origin":{"kind":"human"},"promptId":"s1","humanInput":{"text":"read NOTES.md and reply","mode":"prompt"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const THINKING_LINE: &str = r#"{"type":"assistant","uuid":"a1","timestamp":"2026-08-16T15:45:33.089Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":null,"content":[{"type":"thinking","thinking":"Need to read the file.","signature":""}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":2}},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const TOOL_USE_LINE: &str = r#"{"type":"assistant","uuid":"a2","timestamp":"2026-08-16T15:45:33.100Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"/private/tmp/probe/NOTES.md"}}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":2}},"parentUuid":"a1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const TOOL_RESULT_LINE: &str = r#"{"type":"user","uuid":"u2","timestamp":"2026-08-16T15:45:33.200Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"1\tthe secret number is 42\n2\t"}]},"sourceToolAssistantUUID":"a2","promptId":"s1","toolUseResult":{"type":"text","file":{"filePath":"NOTES.md","content":"the secret number is 42\n","numLines":2,"startLine":1,"totalLines":2}},"parentUuid":"a2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const ANSWER_LINE: &str = r#"{"type":"assistant","uuid":"a3","timestamp":"2026-08-16T15:45:34.000Z","message":{"id":"chatcmpl-1","type":"message","role":"assistant","model":"qmodel_38max","stop_reason":"end_turn","content":[{"type":"text","text":"42","citations":null}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":2,"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}},"parentUuid":"u2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;
    const ACTIVE_LEAF_LINE: &str = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"a3","explicit":false,"timestamp":1786895133089}"#;
    const LAST_PROMPT_LINE: &str = r#"{"type":"last-prompt","sessionId":"s1","lastPrompt":"read NOTES.md and reply"}"#;
    const SIDECHAIN_LINE: &str = r#"{"type":"assistant","uuid":"sc1","timestamp":"2026-08-16T15:45:35.000Z","message":{"role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"sub-agent internal output"}]},"parentUuid":null,"isSidechain":true,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.23","gitBranch":"main"}"#;

    // The shape a REAL ACP-entrypoint session writes (captured from
    // `~/.qoder/projects/*/*.jsonl` on a machine codeg drove): the human prompt
    // is a block ARRAY, not a string, and there is no `gitBranch`.
    const ACP_USER_LINE: &str = r#"{"type":"user","uuid":"au1","timestamp":"2026-07-25T12:08:58.095Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]},"permissionMode":"bypassPermissions","origin":{"kind":"human"},"promptId":"351c","parentUuid":null,"isSidechain":false,"cwd":"/Users/x/work/codeg","sessionId":"s2","userType":"external","entrypoint":"acp","version":"unknown"}"#;
    // …and a failed turn is a real assistant record carrying the raw provider
    // payload under `<synthetic>` + `isApiErrorMessage`.
    const ACP_ERROR_LINE: &str = r#"{"type":"assistant","uuid":"aa1","timestamp":"2026-07-25T12:09:00.807Z","message":{"id":"eb4c","type":"message","role":"assistant","model":"<synthetic>","stop_reason":"stop_sequence","content":[{"type":"text","text":"{\"pricingUrl\":\"https://qoder.com/pricing?client=qoder\"}"}]},"isApiErrorMessage":true,"error":"unknown","displayErrorCode":"112","parentUuid":"au1","isSidechain":false,"cwd":"/Users/x/work/codeg","sessionId":"s2","userType":"external","entrypoint":"acp","version":"unknown"}"#;

    #[test]
    fn summary_reads_real_layout() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
                ACTIVE_LEAF_LINE,
                LAST_PROMPT_LINE,
                // The tail repeats metadata records verbatim; none may move
                // the timestamps or counts.
                RUNTIME_CONFIG,
                ACTIVE_LEAF_LINE,
            ],
        );

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        assert_eq!(summaries.len(), 1);
        let s = &summaries[0];
        assert_eq!(s.id, "s1");
        assert_eq!(s.agent_type, AgentType::Qoder);
        assert_eq!(s.title.as_deref(), Some("read NOTES.md and reply"));
        assert_eq!(s.folder_path.as_deref(), Some("/private/tmp/probe"));
        assert_eq!(s.folder_name.as_deref(), Some("probe"));
        assert_eq!(s.model.as_deref(), Some("qmodel_38max"));
        assert_eq!(s.git_branch.as_deref(), Some("main"));
        // 2 user + 2 assistant bubbles (the thinking/tool_use fragments merge);
        // metadata records don't count.
        assert_eq!(s.message_count, 4);
        assert_eq!(s.started_at.to_rfc3339(), "2026-08-16T15:45:27.384+00:00");
        assert_eq!(
            s.ended_at.as_ref().map(|t| t.to_rfc3339()),
            Some("2026-08-16T15:45:34+00:00".to_string())
        );
    }

    // A mid-session model switch must reach the summary: the details dialog
    // reads `summary.model` ahead of the turns, so a summary pinned to the
    // session's OPENING model contradicted the context gauge (which follows
    // the last turn's window — Qwen3.8-Flash's 200K next to DeepSeek-Flash).
    #[test]
    fn summary_model_follows_a_mid_session_switch() {
        let tmp = tempfile::tempdir().unwrap();
        const SWITCHED_ANSWER_LINE: &str = r#"{"type":"assistant","uuid":"b1","timestamp":"2026-08-16T15:46:00.000Z","message":{"id":"chatcmpl-2","type":"message","role":"assistant","model":"qfmodel","stop_reason":"end_turn","content":[{"type":"text","text":"second","citations":null}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}},"parentUuid":"a3","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.45","gitBranch":"main"}"#;
        write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
                SWITCHED_ANSWER_LINE,
            ],
        );

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        assert_eq!(summaries[0].model.as_deref(), Some("qfmodel"));
        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.model.as_deref(), Some("qfmodel"));
    }

    // A blank `model` on a later record must not blank the summary (or block
    // the launch-model fallback): only non-empty strings may overwrite the
    // last valid one, matching the "Last NON-EMPTY model wins" contract.
    #[test]
    fn summary_model_ignores_a_blank_later_model() {
        let tmp = tempfile::tempdir().unwrap();
        const BLANK_MODEL_LINE: &str = r#"{"type":"assistant","uuid":"b2","timestamp":"2026-08-16T15:47:00.000Z","message":{"id":"chatcmpl-3","type":"message","role":"assistant","model":"","stop_reason":"end_turn","content":[{"type":"text","text":"third","citations":null}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}},"parentUuid":"a3","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.45","gitBranch":"main"}"#;
        write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE, BLANK_MODEL_LINE]);

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        assert_eq!(summaries[0].model.as_deref(), Some("qmodel_38max"));
        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.model.as_deref(), Some("qmodel_38max"));
        // Nor does it name the turn it opens: that turn names no model (the
        // Token board then falls back to the session's) rather than "".
        let blank_turn = detail
            .turns
            .iter()
            .rev()
            .find(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .expect("assistant turn");
        assert_eq!(blank_turn.model, None);
    }

    // The same on a later FRAGMENT of one response: the bubble it merges into
    // keeps the model its earlier fragment named.
    #[test]
    fn a_blank_model_on_a_later_fragment_keeps_the_bubbles_model() {
        let tmp = tempfile::tempdir().unwrap();
        let blank_tool_use = TOOL_USE_LINE.replace(r#""model":"qmodel_38max""#, r#""model":"""#);
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, THINKING_LINE, &blank_tool_use],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let assistants: Vec<_> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .collect();
        assert_eq!(assistants.len(), 1, "the two fragments are one bubble");
        assert!(
            assistants[0]
                .blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { .. })),
            "the blank-model fragment's tool call is kept, not dropped"
        );
        assert_eq!(assistants[0].model.as_deref(), Some("qmodel_38max"));
    }

    /// Write one sub-agent transcript beside a session, in the layout Qoder
    /// (and Claude Code) uses: `<sessionId>/subagents/agent-<agentId>.jsonl`.
    fn write_subagent(tmp: &std::path::Path, session_id: &str, agent_id: &str, lines: &[&str]) {
        let dir = tmp
            .join("projects")
            .join("-private-tmp-probe")
            .join(session_id)
            .join("subagents");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("agent-{agent_id}.jsonl")),
            lines.join("\n") + "\n",
        )
        .unwrap();
    }

    /// One sub-agent API response as Qoder writes it: Anthropic field NAMES
    /// over OpenAI SEMANTICS — `input_tokens` 35,000 of which 34,000 is the
    /// cached prefix, `output_tokens` 300.
    const SUB_AGENT_CALL: &str = r#"{"type":"assistant","uuid":"c1","timestamp":"2026-08-16T15:45:35.000Z","isSidechain":true,"agentId":"aExplore-1","parent_tool_use_id":"call_1","message":{"id":"msg-sub-1","type":"message","role":"assistant","model":"auto","stop_reason":"end_turn","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":35000,"cache_creation_input_tokens":0,"cache_read_input_tokens":34000,"output_tokens":300}},"version":"1.1.65"}"#;

    // Sub-agent spend lives in the run's OWN transcript
    // (`<sessionId>/subagents/agent-<agentId>.jsonl`, the layout claude uses):
    // one API response streams as several records sharing one `message.id`,
    // each repeating the same counters in 1.1.65, and Qoder's counters need
    // the cache split. This pins the whole fold: dedup, split, and turn
    // placement. (1.1.67 writes them on the last record only: see
    // `usage_on_the_last_fragment_only_counts_once`.)
    #[test]
    fn sub_agent_usage_folds_from_its_transcript_with_cache_split() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE]);
        // The same response as Qoder 1.1.65 streams it — several fragments,
        // each repeating the identical usage block.
        write_subagent(
            tmp.path(),
            "s1",
            "aExplore-1",
            &[SUB_AGENT_CALL, SUB_AGENT_CALL],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        // The call (15:45:35) lands on the assistant turn current then —
        // ANSWER_LINE's, at 15:45:34.
        let turn = detail
            .turns
            .iter()
            .rev()
            .find(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .expect("assistant turn");
        let usage = turn.usage.clone().expect("turn usage");
        // 35,000 input of which 34,000 cached → 1,000 fresh in; counted ONCE
        // despite two records sharing `msg-sub-1`.
        assert_eq!(usage.input_tokens, 5 + 1_000);
        assert_eq!(usage.cache_read_input_tokens, 5 + 34_000);
        assert_eq!(usage.output_tokens, 2 + 300);

        // The details dialog's total is the sum of the turns, sub-agent spend
        // included — one number for the dialog and the Token board.
        let stats = detail.session_stats.expect("session stats");
        assert_eq!(
            stats.total_tokens,
            Some(5 + 2 + 5 + 1_000 + 34_000 + 300)
        );
        // The board's side of that number: its per-turn facts are built from
        // turn usage, which is why the fold lands there and not only in the
        // session total.
        let facts = crate::commands::token_usage::facts_from_turns(
            &detail.turns,
            detail.summary.model.as_deref(),
        );
        let board_total: i64 = facts.iter().map(|f| f.total_tokens()).sum();
        assert_eq!(board_total, 5 + 2 + 5 + 1_000 + 34_000 + 300);
    }

    // A record with no `message.id` cannot be grouped with any other, so each
    // one is its own call — counted, not dropped (the parent transcript's rule).
    #[test]
    fn sub_agent_records_without_a_message_id_each_count() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE]);
        let no_id = SUB_AGENT_CALL.replace(r#""id":"msg-sub-1","#, "");
        let empty_id = SUB_AGENT_CALL.replace(r#""id":"msg-sub-1""#, r#""id":"""#);
        // Two of each shape: neither the missing ids nor the empty ones may
        // collapse into one call between themselves.
        write_subagent(
            tmp.path(),
            "s1",
            "aExplore-1",
            &[&no_id, &no_id, &empty_id, &empty_id],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let usage = detail
            .turns
            .iter()
            .rev()
            .find(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .and_then(|t| t.usage.clone())
            .expect("turn usage");
        assert_eq!(usage.input_tokens, 5 + 4 * 1_000);
        assert_eq!(usage.cache_read_input_tokens, 5 + 4 * 34_000);
        assert_eq!(usage.output_tokens, 2 + 4 * 300);
    }

    // 1.1.67 writes a response's usage on its LAST fragment only, in the main
    // transcript and a sub-agent's alike, where 1.1.65 repeated it on every
    // one. A response whose opening fragment carries nothing must still count,
    // once, on the bubble its fragments merged into.
    #[test]
    fn usage_on_the_last_fragment_only_counts_once() {
        let tmp = tempfile::tempdir().unwrap();
        let thinking = THINKING_LINE.replace(
            r#","usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":5,"output_tokens":2}"#,
            "",
        );
        assert_ne!(thinking, THINKING_LINE, "fixture must lose its usage");
        // In 1.1.67 the answer after a tool result is a response of its own.
        let answer = ANSWER_LINE.replace(r#""id":"chatcmpl-1""#, r#""id":"chatcmpl-2""#);
        write_session(
            tmp.path(),
            "s1",
            &[
                USER_LINE,
                &thinking,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                &answer,
            ],
        );
        let opening = SUB_AGENT_CALL.replace(
            r#","usage":{"input_tokens":35000,"cache_creation_input_tokens":0,"cache_read_input_tokens":34000,"output_tokens":300}"#,
            "",
        );
        assert_ne!(opening, SUB_AGENT_CALL, "fixture must lose its usage");
        write_subagent(tmp.path(), "s1", "aExplore-1", &[&opening, SUB_AGENT_CALL]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let assistant: Vec<_> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .collect();
        assert_eq!(assistant.len(), 2);
        // The thinking + tool_use bubble keeps the usage its second fragment
        // brought: input 10 of which 5 cached.
        let first = assistant[0].usage.clone().expect("first response's usage");
        assert_eq!(first.input_tokens, 5);
        assert_eq!(first.cache_read_input_tokens, 5);
        assert_eq!(first.output_tokens, 2);
        // The sub-agent call (15:45:35) lands on the answer (15:45:34), once.
        let second = assistant[1].usage.clone().expect("second response's usage");
        assert_eq!(second.input_tokens, 5 + 1_000);
        assert_eq!(second.cache_read_input_tokens, 5 + 34_000);
        assert_eq!(second.output_tokens, 2 + 300);
        assert_eq!(
            detail.session_stats.expect("session stats").total_tokens,
            Some(2 * (5 + 5 + 2) + 1_000 + 34_000 + 300)
        );
    }

    #[test]
    fn sub_agent_calls_land_on_the_turn_current_when_each_happened() {
        let tmp = tempfile::tempdir().unwrap();
        const SWITCHED_ANSWER_LINE: &str = r#"{"type":"assistant","uuid":"b1","timestamp":"2026-08-16T15:46:00.000Z","message":{"id":"chatcmpl-2","type":"message","role":"assistant","model":"qfmodel","stop_reason":"end_turn","content":[{"type":"text","text":"second","citations":null}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}},"parentUuid":"a3","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"cli","version":"1.1.45","gitBranch":"main"}"#;
        const SECOND_CALL: &str = r#"{"type":"assistant","uuid":"c2","timestamp":"2026-08-16T15:46:30.000Z","isSidechain":true,"agentId":"aExplore-1","parent_tool_use_id":"call_1","message":{"id":"msg-sub-2","type":"message","role":"assistant","model":"auto","stop_reason":"end_turn","content":[{"type":"text","text":"done"}],"usage":{"input_tokens":35000,"cache_creation_input_tokens":0,"cache_read_input_tokens":34000,"output_tokens":300}},"version":"1.1.65"}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, ANSWER_LINE, SWITCHED_ANSWER_LINE],
        );
        // First call right after the first answer; second after the switch.
        write_subagent(
            tmp.path(),
            "s1",
            "aExplore-1",
            &[SUB_AGENT_CALL, SECOND_CALL],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let assistants: Vec<_> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, crate::models::TurnRole::Assistant))
            .collect();
        assert_eq!(assistants.len(), 2, "two answers, two turns");
        let first = assistants[0].usage.clone().expect("first turn usage");
        let second = assistants[1].usage.clone().expect("second turn usage");
        // Each call lands on the turn current at ITS OWN timestamp — a
        // background sub-agent keeps working after the parent moves on.
        assert_eq!(first.input_tokens, 5 + 1_000);
        assert_eq!(first.cache_read_input_tokens, 5 + 34_000);
        assert_eq!(first.output_tokens, 2 + 300);
        assert_eq!(second.input_tokens, 10 + 1_000);
        assert_eq!(second.cache_read_input_tokens, 34_000);
        assert_eq!(second.output_tokens, 2 + 300);
    }

    #[test]
    fn sub_agent_usage_does_not_touch_the_context_window() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[RUNTIME_CONFIG, USER_LINE, ANSWER_LINE],
        );
        // Control parse: no `subagents/` directory at all.
        let baseline = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let baseline_stats = baseline.session_stats.clone().expect("baseline stats");
        assert_eq!(baseline_stats.total_tokens, Some(5 + 2 + 5));

        write_subagent(tmp.path(), "s1", "aExplore-1", &[SUB_AGENT_CALL]);
        let with_sub = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let stats = with_sub.session_stats.expect("stats");
        // A sub-agent's context is its own: occupancy and window are untouched
        // (the fold runs after they were read) while the totals grow.
        assert_eq!(
            stats.context_window_used_tokens,
            baseline_stats.context_window_used_tokens
        );
        assert_eq!(
            stats.context_window_max_tokens,
            baseline_stats.context_window_max_tokens
        );
        assert!(stats.total_tokens.unwrap() > baseline_stats.total_tokens.unwrap());
    }

    #[test]
    fn agent_card_stats_carry_the_childs_mixed_timeline_in_arrival_order() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_use = r#"{"type":"assistant","uuid":"a9","timestamp":"2026-08-16T15:45:33.100Z","message":{"role":"assistant","model":"qmodel","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_agent1","name":"Agent","input":{"description":"读文件","subagent_type":"Explore"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let agent_result = r#"{"type":"user","uuid":"u9","timestamp":"2026-08-16T15:45:39.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_agent1","content":"以下是文件前 60 行…"}]},"sourceToolAssistantUUID":"a9","promptId":"s1","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"aExplore-abc123","description":"读文件"},"parentUuid":"a9","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let active_leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"u9","explicit":false,"timestamp":1786895139000}"#;
        let path = write_session(tmp.path(), "s1", &[USER_LINE, agent_use, agent_result, active_leaf]);

        let sub = path.with_extension("").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("agent-aExplore-abc123.meta.json"),
            r#"{"agentType":"Explore","toolUseId":"call_agent1","description":"读文件","invocationName":"Explore"}"#,
        )
        .unwrap();
        // The child thinks, narrates, calls, then reports — the exact shape
        // Anthropic-form transcripts interleave on disk.
        let child_thinking = r#"{"type":"assistant","uuid":"c0","timestamp":"2026-08-16T15:45:34.000Z","message":{"id":"cm1","role":"assistant","model":"qmodel","content":[{"type":"thinking","thinking":"Need the notes first.","signature":""}]}}"#;
        let child_text = r#"{"type":"assistant","uuid":"c0b","timestamp":"2026-08-16T15:45:34.200Z","message":{"id":"cm1","role":"assistant","model":"qmodel","content":[{"type":"text","text":"Reading."}]}}"#;
        let child_use = r#"{"type":"assistant","uuid":"c1","timestamp":"2026-08-16T15:45:35.000Z","message":{"role":"assistant","model":"qmodel","content":[{"type":"tool_use","id":"call_r1","name":"Read","input":{"file_path":"/private/tmp/probe/NOTES.md"}}]},"isSidechain":true,"sessionId":"s1"}"#;
        let child_result = r#"{"type":"user","uuid":"c2","timestamp":"2026-08-16T15:45:35.500Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_r1","content":"1\t# NOTES"}]},"isSidechain":true,"sessionId":"s1"}"#;
        std::fs::write(
            sub.join("agent-aExplore-abc123.jsonl"),
            [child_thinking, child_text, child_use, child_result].join("\n") + "\n",
        )
        .unwrap();

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let stats = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("call_agent1") => agent_stats.clone(),
                _ => None,
            })
            .expect("Agent result carries agent_stats");
        assert_eq!(
            stats
                .timeline
                .iter()
                .map(|e| (e.entry_type.as_str(), e.child_index, e.text.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("thinking", None, Some("Need the notes first.")),
                ("text", None, Some("Reading.")),
                ("tool_call", Some(0), None),
            ]
        );
        assert_eq!(stats.tool_calls[0].tool_name, "Read");
        // No task file here, and Qoder's never records a duration anyway: the
        // child transcript's own first-to-last record span (34.000 → 35.500).
        assert_eq!(stats.total_duration_ms, Some(1_500));
    }

    /// A turn the provider killed mid-flight: the CLI writes an `is_error`
    /// tool_result for each still-pending Agent call, while the children
    /// actually completed — their task files carry the full reports. The
    /// attach ignores the error flag (the FRONTEND decides what to show) and
    /// lands the stats, the timeline AND the recovered report on the errored
    /// result.
    #[test]
    fn an_errored_agent_result_still_carries_stats_and_the_recovered_result() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_use = r#"{"type":"assistant","uuid":"a9","timestamp":"2026-08-16T15:45:33.100Z","message":{"role":"assistant","model":"qmodel","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_agent1","name":"Agent","input":{"description":"调研","subagent_type":"Explore"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let agent_result = r#"{"type":"user","uuid":"u9","timestamp":"2026-08-16T15:45:39.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_agent1","is_error":true,"content":"Error: tool execution produced no result"}]},"sourceToolAssistantUUID":"a9","promptId":"s1","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"aExplore-abc123","description":"调研"},"parentUuid":"a9","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let active_leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"u9","explicit":false,"timestamp":1786895139000}"#;
        let path = write_session(tmp.path(), "s1", &[USER_LINE, agent_use, agent_result, active_leaf]);

        let sub = path.with_extension("").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("agent-aExplore-abc123.meta.json"),
            r#"{"agentType":"Explore","toolUseId":"call_agent1","description":"调研","invocationName":"Explore"}"#,
        )
        .unwrap();
        std::fs::write(
            sub.join("task-t1.json"),
            // The shape qodercli 1.1.68 writes once the run completes: no
            // usage or duration (those ride only on the task notification).
            r#"{"taskId":"t1","sessionId":"s1","executionId":"e1","agentId":"aExplore-abc123","agentType":"Explore","description":"调研","invocationName":"Explore","parentToolUseId":"call_agent1","status":"completed","summary":"Agent \"Explore\" finished","result":"The full research report, thousands of words.","createdAt":1786895133100,"updatedAt":1786895138000,"completedAt":1786895138000}"#,
        )
        .unwrap();
        let child_use = r#"{"type":"assistant","uuid":"c1","timestamp":"2026-08-16T15:45:35.000Z","message":{"role":"assistant","model":"qmodel","content":[{"type":"tool_use","id":"call_r1","name":"Read","input":{"file_path":"/private/tmp/probe/NOTES.md"}}]},"isSidechain":true,"sessionId":"s1"}"#;
        let child_result = r#"{"type":"user","uuid":"c2","timestamp":"2026-08-16T15:45:35.500Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_r1","content":"1\t# NOTES"}]},"isSidechain":true,"sessionId":"s1"}"#;
        std::fs::write(
            sub.join("agent-aExplore-abc123.jsonl"),
            [child_use, child_result].join("\n") + "\n",
        )
        .unwrap();

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let (is_error, stats) = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    is_error,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("call_agent1") => {
                    Some((*is_error, agent_stats.clone()))
                }
                _ => None,
            })
            .expect("Agent result present");
        assert!(is_error, "fixture precondition: the result is an error");
        let stats = stats.expect("errored Agent result still carries stats");
        assert_eq!(stats.status.as_deref(), Some("completed"));
        assert_eq!(
            stats.recovered_result.as_deref(),
            Some("The full research report, thousands of words.")
        );
        assert_eq!(
            stats
                .timeline
                .iter()
                .map(|e| e.entry_type.as_str())
                .collect::<Vec<_>>(),
            vec!["tool_call"]
        );
    }

    #[test]
    fn a_task_file_without_a_result_field_leaves_recovered_result_absent() {
        let tmp = tempfile::tempdir().unwrap();
        let agent_use = r#"{"type":"assistant","uuid":"a9","timestamp":"2026-08-16T15:45:33.100Z","message":{"role":"assistant","model":"qmodel","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_agent1","name":"Agent","input":{"description":"调研","subagent_type":"Explore"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let agent_result = r#"{"type":"user","uuid":"u9","timestamp":"2026-08-16T15:45:39.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_agent1","content":"以下是文件前 60 行…"}]},"sourceToolAssistantUUID":"a9","promptId":"s1","toolUseResult":{"isAsync":true,"status":"async_launched","agentId":"aExplore-abc123","description":"调研"},"parentUuid":"a9","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.67","gitBranch":"main"}"#;
        let active_leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"u9","explicit":false,"timestamp":1786895139000}"#;
        let path = write_session(tmp.path(), "s1", &[USER_LINE, agent_use, agent_result, active_leaf]);

        let sub = path.with_extension("").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(
            sub.join("agent-aExplore-abc123.meta.json"),
            r#"{"agentType":"Explore","toolUseId":"call_agent1","description":"调研","invocationName":"Explore"}"#,
        )
        .unwrap();
        // A task still `running` — the only state Qoder writes without a
        // `result` (every terminal transition files one).
        std::fs::write(
            sub.join("task-t1.json"),
            r#"{"taskId":"t1","sessionId":"s1","executionId":"e1","agentId":"aExplore-abc123","agentType":"Explore","description":"调研","invocationName":"Explore","parentToolUseId":"call_agent1","status":"running","createdAt":1786895133100,"updatedAt":1786895133100}"#,
        )
        .unwrap();
        let child_use = r#"{"type":"assistant","uuid":"c1","timestamp":"2026-08-16T15:45:35.000Z","message":{"role":"assistant","model":"qmodel","content":[{"type":"tool_use","id":"call_r1","name":"Read","input":{"file_path":"/private/tmp/probe/NOTES.md"}}]},"isSidechain":true,"sessionId":"s1"}"#;
        let child_result = r#"{"type":"user","uuid":"c2","timestamp":"2026-08-16T15:45:35.500Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_r1","content":"1\t# NOTES"}]},"isSidechain":true,"sessionId":"s1"}"#;
        std::fs::write(
            sub.join("agent-aExplore-abc123.jsonl"),
            [child_use, child_result].join("\n") + "\n",
        )
        .unwrap();

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let stats = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    agent_stats,
                    ..
                } if tool_use_id.as_deref() == Some("call_agent1") => agent_stats.clone(),
                _ => None,
            })
            .expect("Agent result carries agent_stats");
        assert_eq!(stats.status.as_deref(), Some("running"));
        assert_eq!(stats.recovered_result, None);
    }

    /// Session `s1` launching one Agent call (`call_agent1`) whose tool_result
    /// is `agent_result`; returns its (created) `subagents` directory.
    fn agent_session_with_subagents(root: &Path, agent_result: &str) -> PathBuf {
        let agent_use = r#"{"type":"assistant","uuid":"a9","timestamp":"2026-08-16T15:45:33.100Z","message":{"role":"assistant","model":"qmodel","stop_reason":"tool_use","content":[{"type":"tool_use","id":"call_agent1","name":"Agent","input":{"description":"调研","subagent_type":"Explore"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.68","gitBranch":"main"}"#;
        let active_leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"u9","explicit":false,"timestamp":1786895139000}"#;
        let path = write_session(
            root,
            "s1",
            &[USER_LINE, agent_use, agent_result, active_leaf],
        );
        let sub = path.with_extension("").join("subagents");
        std::fs::create_dir_all(&sub).unwrap();
        sub
    }

    /// One child run under `sub`: its meta file naming `tool_use_id`, and a
    /// transcript holding a single call of `tool` (and that call's result).
    fn write_child_run(sub: &Path, agent_id: &str, tool_use_id: &str, tool: &str) {
        std::fs::write(
            sub.join(format!("agent-{agent_id}.meta.json")),
            format!(
                r#"{{"agentType":"Explore","toolUseId":"{tool_use_id}","description":"调研"}}"#
            ),
        )
        .unwrap();
        let call = format!(
            r#"{{"type":"assistant","uuid":"c1","timestamp":"2026-08-16T15:45:35.000Z","message":{{"role":"assistant","model":"qmodel","content":[{{"type":"tool_use","id":"call_{agent_id}","name":"{tool}","input":{{}}}}]}},"isSidechain":true,"sessionId":"s1"}}"#
        );
        let result = format!(
            r#"{{"type":"user","uuid":"c2","timestamp":"2026-08-16T15:45:36.000Z","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"call_{agent_id}","content":"ok"}}]}},"isSidechain":true,"sessionId":"s1"}}"#
        );
        std::fs::write(
            sub.join(format!("agent-{agent_id}.jsonl")),
            format!("{call}\n{result}\n"),
        )
        .unwrap();
    }

    fn agent_stats_of(tmp: &Path, tool_use_id: &str) -> Option<AgentExecutionStats> {
        parser_in(tmp)
            .get_conversation("s1")
            .unwrap()
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    agent_stats,
                    ..
                } if id == tool_use_id => Some(agent_stats.clone()),
                _ => None,
            })
            .expect("the Agent result is in the turns")
    }

    /// A dead process's `running` task is rewritten to `interrupted` with a
    /// placeholder `result` (qodercli 1.1.68). The parser stays dumb and lands
    /// both; the status is what lets the card refuse to present the
    /// placeholder as the child's report.
    #[test]
    fn an_interrupted_tasks_placeholder_result_rides_along_with_its_status() {
        let tmp = tempfile::tempdir().unwrap();
        let errored = r#"{"type":"user","uuid":"u9","timestamp":"2026-08-16T15:45:39.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_agent1","is_error":true,"content":"Error: tool execution produced no result"}]},"sourceToolAssistantUUID":"a9","promptId":"s1","parentUuid":"a9","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.68","gitBranch":"main"}"#;
        let sub = agent_session_with_subagents(tmp.path(), errored);
        write_child_run(&sub, "aExplore-abc123", "call_agent1", "Read");
        std::fs::write(
            sub.join("task-t1.json"),
            r#"{"taskId":"t1","agentId":"aExplore-abc123","parentToolUseId":"call_agent1","status":"interrupted","summary":"Agent task \"调研\" stopped before it could finish.","result":"The process that owned this subagent task is no longer running.","createdAt":1786895133100,"updatedAt":1786895200000,"completedAt":1786895200000}"#,
        )
        .unwrap();

        let stats = agent_stats_of(tmp.path(), "call_agent1").expect("stats attached");
        assert_eq!(stats.status.as_deref(), Some("interrupted"));
        assert_eq!(
            stats.recovered_result.as_deref(),
            Some("The process that owned this subagent task is no longer running.")
        );
    }

    /// Runs naming the same tool call resolve the same way on every parse —
    /// the first in file-name order — whatever order the directory lists them
    /// in; a run naming a tool call that is not in the turns is skipped.
    #[test]
    fn the_first_run_in_name_order_wins_a_shared_tool_call() {
        let tmp = tempfile::tempdir().unwrap();
        let result = r#"{"type":"user","uuid":"u9","timestamp":"2026-08-16T15:45:39.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_agent1","content":"report"}]},"sourceToolAssistantUUID":"a9","promptId":"s1","parentUuid":"a9","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"1.1.68","gitBranch":"main"}"#;
        let sub = agent_session_with_subagents(tmp.path(), result);
        // Twelve rivals, each calling a tool named after its run, created out
        // of name order with the winner neither first nor last: a listing in
        // creation order (or its reverse) never agrees with name order, and a
        // hash-ordered one only by a one-in-twelve chance.
        for n in [7, 3, 0, 10, 5, 1, 11, 8, 2, 9, 4, 6] {
            let run = format!("run-{n:02}");
            write_child_run(&sub, &run, "call_agent1", &run);
        }
        // Sorts ahead of every rival, but its tool call is not in the turns.
        write_child_run(&sub, "a-elsewhere", "call_rewound_away", "Grep");

        let stats = agent_stats_of(tmp.path(), "call_agent1").expect("stats attached");
        assert_eq!(
            stats
                .tool_calls
                .iter()
                .map(|c| c.tool_name.as_str())
                .collect::<Vec<_>>(),
            vec!["run-00"]
        );
    }

    #[test]
    fn detail_builds_turns_with_tool_pairing() {
        let tmp = tempfile::tempdir().unwrap();
        let path = write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.id, "s1");
        assert_eq!(
            detail.transcript_watermark,
            Some(std::fs::metadata(&path).unwrap().len())
        );

        // One user turn, then TWO assistant turns: the thinking + tool_use
        // fragments share a `message.id` and merge into one message whose
        // paired tool result is absorbed, and the end-turn answer (which lands
        // after that tool-result boundary) forms the next turn.
        assert_eq!(detail.turns.len(), 3);
        assert!(matches!(detail.turns[0].role, crate::models::TurnRole::User));
        assert!(matches!(
            detail.turns[1].role,
            crate::models::TurnRole::Assistant
        ));
        assert!(matches!(
            detail.turns[2].role,
            crate::models::TurnRole::Assistant
        ));

        let assistant = &detail.turns[1];
        let tool_use = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    ..
                } => Some((tool_use_id.clone(), tool_name.clone())),
                _ => None,
            })
            .expect("tool_use block");
        assert_eq!(tool_use, (Some("call_1".to_string()), "Read".to_string()));
        let tool_result = assistant
            .blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    ..
                } => Some((tool_use_id.clone(), output_preview.clone())),
                _ => None,
            })
            .expect("tool_result block paired into the turn");
        assert_eq!(tool_result.0.as_deref(), Some("call_1"));
        assert!(tool_result.1.as_deref().unwrap().contains("42"));
        assert!(assistant.blocks.iter().any(
            |b| matches!(b, ContentBlock::Thinking { text } if text.contains("read the file"))
        ));
        assert!(assistant
            .blocks
            .iter()
            .all(|b| !matches!(b, ContentBlock::Text { text } if text == "42")));
        let answer = &detail.turns[2];
        assert!(answer
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Text { text } if text == "42")));

        // All three fragments repeat ONE response's usage. Exactly one bubble
        // may keep it, or the session totals bill the response twice.
        let charged: Vec<u64> = detail
            .turns
            .iter()
            .filter_map(|t| t.usage.as_ref().map(|u| u.output_tokens))
            .collect();
        assert_eq!(charged, vec![2], "one claim per message.id");
        // Prompt occupancy excludes `output_tokens`, and the window comes from
        // `runtime-config` (no heuristic can size `qmodel_38max`).
        //
        // 10, not 15: the fixture's `input_tokens: 10` already CONTAINS its
        // `cache_read_input_tokens: 5` (Qoder's counters are OpenAI-shaped —
        // see `qoder_turn_usage`), so the prompt is ten tokens of which five
        // came from cache, not fifteen.
        let stats = detail.session_stats.expect("session stats");
        assert_eq!(stats.context_window_used_tokens, Some(10));
        assert_eq!(stats.context_window_max_tokens, Some(262_144));
    }

    // Two tools called in ONE batch. Qoder writes a separate assistant record
    // per `tool_use` and a separate `user` record per result, each result
    // pointing back at ITS OWN call — so the results are siblings and only the
    // last is an ancestor of the answer. Walking ancestors alone keeps
    // `call_2`'s result and drops `call_1`'s, leaving a Read card that looks
    // like it never returned.
    #[test]
    fn parallel_tool_results_all_survive_the_branch_walk() {
        let tmp = tempfile::tempdir().unwrap();
        let call_1 = r#"{"type":"assistant","uuid":"p1","timestamp":"2026-08-16T15:45:33.000Z","message":{"id":"cc-par","role":"assistant","model":"qmodel_38max","content":[{"type":"tool_use","id":"call_1","name":"Read","input":{"file_path":"/private/tmp/probe/A.md"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let call_2 = r#"{"type":"assistant","uuid":"p2","timestamp":"2026-08-16T15:45:33.010Z","message":{"id":"cc-par","role":"assistant","model":"qmodel_38max","content":[{"type":"tool_use","id":"call_2","name":"Read","input":{"file_path":"/private/tmp/probe/B.md"}}]},"parentUuid":"p1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let result_1 = r#"{"type":"user","uuid":"r1","timestamp":"2026-08-16T15:45:33.100Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_1","content":"ALPHA"}]},"sourceToolAssistantUUID":"p1","parentUuid":"p1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let result_2 = r#"{"type":"user","uuid":"r2","timestamp":"2026-08-16T15:45:33.110Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_2","content":"BETA"}]},"sourceToolAssistantUUID":"p2","parentUuid":"p2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let answer = r#"{"type":"assistant","uuid":"p3","timestamp":"2026-08-16T15:45:34.000Z","message":{"id":"cc-ans","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"read both"}]},"parentUuid":"r2","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, call_1, call_2, result_1, result_2, answer],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let results: Vec<String> = detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    output_preview: Some(output),
                    ..
                } => Some(output.clone()),
                _ => None,
            })
            .collect();
        assert!(
            results.iter().any(|c| c.contains("ALPHA")),
            "the FIRST call's result is the one a pure ancestor walk loses: {results:?}"
        );
        assert!(
            results.iter().any(|c| c.contains("BETA")),
            "the last call's result must still be there: {results:?}"
        );
    }

    // …and the repair is scoped to tool results, so it cannot drag an abandoned
    // branch back in: a rewind re-roots on a human prompt, which has no
    // `sourceToolAssistantUUID`.
    #[test]
    fn reattaching_tool_results_does_not_resurrect_a_rewound_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let abandoned_call = r#"{"type":"assistant","uuid":"x1","timestamp":"2026-08-16T15:45:30.000Z","message":{"id":"cc-x","role":"assistant","model":"qmodel_38max","content":[{"type":"tool_use","id":"call_x","name":"Read","input":{"file_path":"/private/tmp/probe/X.md"}}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let abandoned_result = r#"{"type":"user","uuid":"x2","timestamp":"2026-08-16T15:45:30.100Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"call_x","content":"ABANDONED-RESULT"}]},"sourceToolAssistantUUID":"x1","parentUuid":"x1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let retried = r#"{"type":"assistant","uuid":"y1","timestamp":"2026-08-16T15:45:40.000Z","message":{"id":"cc-y","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"KEPT"}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, abandoned_call, abandoned_result, retried],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let rendered = format!("{:?}", detail.turns);
        assert!(rendered.contains("KEPT"));
        assert!(
            !rendered.contains("ABANDONED-RESULT"),
            "the abandoned branch's issuer is off-chain, so its result stays off too"
        );
    }

    #[test]
    fn sidechain_entries_are_excluded() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE, SIDECHAIN_LINE]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.summary.message_count, 2);
        assert!(detail.turns.iter().all(|t| t
            .blocks
            .iter()
            .all(|b| !matches!(b, ContentBlock::Text { text } if text.contains("sub-agent")))));
    }

    #[test]
    fn tail_metadata_records_do_not_extend_timestamps() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, ANSWER_LINE, ACTIVE_LEAF_LINE, RUNTIME_CONFIG],
        );

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        // `active-leaf` carries a LATER epoch than any content record; it must
        // not leak into `ended_at`.
        assert_eq!(
            summaries[0].ended_at.as_ref().map(|t| t.to_rfc3339()),
            Some("2026-08-16T15:45:34+00:00".to_string())
        );
    }

    #[test]
    fn missing_session_is_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let err = parser_in(tmp.path()).get_conversation("nope").unwrap_err();
        assert!(matches!(err, ParseError::ConversationNotFound(_)));
    }

    #[test]
    fn config_dir_env_overrides_user_home() {
        let home = || Some(PathBuf::from("/Users/default"));
        // `QODER_CONFIG_DIR` is an absolute path and outranks everything else.
        let resolved =
            resolve_qoder_config_dir_from(Some("/tmp/qoder-home".into()), None, None, home());
        assert_eq!(resolved, PathBuf::from("/tmp/qoder-home"));
        let resolved = resolve_qoder_config_dir_from(
            Some("/tmp/qoder-home".into()),
            Some("/elsewhere".into()),
            Some(".other".into()),
            home(),
        );
        assert_eq!(
            resolved,
            PathBuf::from("/tmp/qoder-home"),
            "the absolute override wins over both of the other two"
        );
        // Empty is the same as unset, everywhere — never an empty path segment.
        let resolved =
            resolve_qoder_config_dir_from(Some("".into()), Some("".into()), Some("".into()), home());
        assert_eq!(resolved, PathBuf::from("/Users/default/.qoder"));
        let resolved = resolve_qoder_config_dir_from(None, None, None, home());
        assert_eq!(resolved, PathBuf::from("/Users/default/.qoder"));
        // `QODER_CLI_HOME` relocates the HOME the dir name hangs off…
        let resolved =
            resolve_qoder_config_dir_from(None, Some("/sandbox/home".into()), None, home());
        assert_eq!(resolved, PathBuf::from("/sandbox/home/.qoder"));
        // …and `QODER_CONFIG_DIR_NAME` renames the dir itself, independently.
        let resolved = resolve_qoder_config_dir_from(None, None, Some(".qoder-work".into()), home());
        assert_eq!(resolved, PathBuf::from("/Users/default/.qoder-work"));
        let resolved = resolve_qoder_config_dir_from(
            None,
            Some("/sandbox/home".into()),
            Some(".qoder-work".into()),
            home(),
        );
        assert_eq!(resolved, PathBuf::from("/sandbox/home/.qoder-work"));
    }

    // Rewinding the FIRST prompt leaves nothing to replay, and Qoder says so by
    // persisting `leafUuid: null` (`recordActiveLeaf(retainedLeafUuid, …)`).
    // Reading that as a malformed marker resurrects the conversation the user
    // just cleared — content, title and token usage.
    #[test]
    fn a_null_active_leaf_clears_the_conversation() {
        let tmp = tempfile::tempdir().unwrap();
        let cleared = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":null,"explicit":true,"rewound":true,"timestamp":1786895140000}"#;
        let path = write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE, cleared]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert!(
            detail.turns.is_empty(),
            "a null leaf is an EMPTY branch, not a broken marker: {:?}",
            detail.turns
        );
        assert_eq!(detail.summary.message_count, 0);
        // The consequence, named on purpose: with no content record left there
        // is no `started_at`, so a cleared session drops out of the SCAN list —
        // the same path every content-free transcript already takes. It is not a
        // deletion: an already-imported session keeps its row in codeg's DB, and
        // the file itself is untouched.
        assert!(parse_summary(&path).is_none());
    }

    // …but only when it is the newest word on the subject, and only when the key
    // is really there and really null. Both guards exist because blanking a live
    // session is the one outcome worse than showing too much.
    #[test]
    fn a_null_active_leaf_never_hides_newer_or_malformed_state() {
        let tmp = tempfile::tempdir().unwrap();
        let cleared = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":null,"explicit":true,"rewound":true,"timestamp":1786895140000}"#;
        // Cleared, then the user typed again: the fresh turn must survive.
        write_session(tmp.path(), "s1", &[USER_LINE, cleared, ANSWER_LINE]);
        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert!(
            !detail.turns.is_empty(),
            "a stale null marker must not erase what came after it"
        );

        // A marker with no `leafUuid` at all is a writer this parser does not
        // understand — fall through to showing history, never to hiding it.
        let malformed =
            r#"{"type":"active-leaf","sessionId":"s1","explicit":true,"timestamp":1786895140000}"#;
        write_session(tmp.path(), "s2", &[USER_LINE, ANSWER_LINE, malformed]);
        let detail = parser_in(tmp.path()).get_conversation("s2").unwrap();
        assert!(!detail.turns.is_empty(), "missing key is not an empty branch");
    }

    // The ACP entrypoint — the one codeg itself drives — writes the human
    // prompt as a block ARRAY. Reading only `content.as_str()` dropped the whole
    // user turn AND left the session untitled.
    #[test]
    fn acp_block_array_prompt_renders_and_titles() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s2", &[ACP_USER_LINE, ACP_ERROR_LINE]);

        let summary = &parser_in(tmp.path()).list_conversations().unwrap()[0];
        assert_eq!(summary.title.as_deref(), Some("hi"));
        assert_eq!(summary.message_count, 1, "the error record is not a reply");
        // `<synthetic>` is a placeholder, never a model the session ran on.
        assert_eq!(summary.model, None);

        let detail = parser_in(tmp.path()).get_conversation("s2").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(detail.turns[0].role, crate::models::TurnRole::User));
        assert_eq!(text_of(&detail.turns[0]), "hi");
        assert!(
            !detail.turns.iter().any(|t| text_of(t).contains("pricingUrl")),
            "a failed API turn must not render as the assistant's answer"
        );
        // It closes the round as the failure line instead.
        assert!(matches!(
            detail.turns[1].role,
            crate::models::TurnRole::System
        ));
        assert!(
            matches!(
                detail.turns[1].blocks.as_slice(),
                [ContentBlock::TurnError { message }]
                    if message == r#"{"pricingUrl":"https://qoder.com/pricing?client=qoder"}"#
            ),
            "{:?}",
            detail.turns[1].blocks
        );
    }

    #[test]
    fn image_prompts_survive() {
        let tmp = tempfile::tempdir().unwrap();
        let line = r#"{"type":"user","uuid":"iu1","timestamp":"2026-08-16T15:45:27.384Z","message":{"role":"user","content":[{"type":"text","text":"what is this"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]},"origin":{"kind":"human"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s3"}"#;
        write_session(tmp.path(), "s3", &[line]);

        let detail = parser_in(tmp.path()).get_conversation("s3").unwrap();
        assert_eq!(detail.turns.len(), 1);
        assert!(detail
            .turns[0]
            .blocks
            .iter()
            .any(|b| matches!(b, ContentBlock::Image { mime_type, .. } if mime_type == "image/png")));
        assert_eq!(detail.summary.title.as_deref(), Some("what is this"));
    }

    // `isMeta` records ALSO carry `origin.kind: "human"` (hook injections, the
    // max-output-token retry prompt, slash-command expansions), so origin alone
    // cannot tell them from a real prompt.
    #[test]
    fn meta_injections_never_render_as_user_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let meta = r#"{"type":"user","uuid":"m1","timestamp":"2026-08-16T15:45:20.000Z","message":{"role":"user","content":[{"type":"text","text":"Continue from where you left off"}]},"isMeta":true,"origin":{"kind":"human"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        write_session(tmp.path(), "s1", &[meta, USER_LINE, ANSWER_LINE]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert!(
            !detail
                .turns
                .iter()
                .any(|t| text_of(t).contains("Continue from where")),
            "meta injections are addressed to the model"
        );
        assert_eq!(detail.summary.title.as_deref(), Some("read NOTES.md and reply"));
    }

    // A rewind leaves the abandoned branch in the file forever. Replaying in
    // append order would splice it back in — and bill its tokens.
    #[test]
    fn rewound_branch_is_not_replayed() {
        let tmp = tempfile::tempdir().unwrap();
        let abandoned = r#"{"type":"assistant","uuid":"old","timestamp":"2026-08-16T15:45:30.000Z","message":{"id":"chatcmpl-old","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"ABANDONED"}],"usage":{"input_tokens":900,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":900}},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let retried = r#"{"type":"assistant","uuid":"new","timestamp":"2026-08-16T15:45:40.000Z","message":{"id":"chatcmpl-new","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"KEPT"}],"usage":{"input_tokens":10,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1}},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        write_session(tmp.path(), "s1", &[USER_LINE, abandoned, retried]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let rendered: Vec<String> = detail.turns.iter().map(text_of).collect();
        assert!(rendered.iter().any(|t| t == "KEPT"));
        assert!(
            !rendered.iter().any(|t| t.contains("ABANDONED")),
            "rewound branch must not be replayed: {rendered:?}"
        );
        assert_eq!(detail.summary.message_count, 2);
    }

    // …and when the user rewinds WITHOUT sending anything after, only the
    // `active-leaf` marker knows which branch is live.
    #[test]
    fn active_leaf_marker_selects_the_live_branch() {
        let tmp = tempfile::tempdir().unwrap();
        let branch_a = r#"{"type":"assistant","uuid":"ba","timestamp":"2026-08-16T15:45:30.000Z","message":{"id":"cc-a","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"BRANCH-A"}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let branch_b = r#"{"type":"assistant","uuid":"bb","timestamp":"2026-08-16T15:45:31.000Z","message":{"id":"cc-b","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"BRANCH-B"}]},"parentUuid":"u1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let leaf_a = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"ba","explicit":true,"rewound":true,"timestamp":1786895140000}"#;
        write_session(tmp.path(), "s1", &[USER_LINE, branch_a, branch_b, leaf_a]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let rendered: Vec<String> = detail.turns.iter().map(text_of).collect();
        assert!(rendered.iter().any(|t| t == "BRANCH-A"));
        assert!(!rendered.iter().any(|t| t == "BRANCH-B"));
    }

    // A stale marker followed by fresh messages must not truncate them away.
    #[test]
    fn stale_active_leaf_does_not_hide_newer_messages() {
        let tmp = tempfile::tempdir().unwrap();
        let leaf_u1 = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"u1","explicit":false,"timestamp":1786895127400}"#;
        write_session(tmp.path(), "s1", &[USER_LINE, leaf_u1, ANSWER_LINE]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(detail.turns.iter().any(|t| text_of(t) == "42"));
    }

    // Sessions from a writer that never set `parentUuid` are not a graph;
    // walking one would collapse it to a single message.
    #[test]
    fn unlinked_records_fall_back_to_append_order() {
        let tmp = tempfile::tempdir().unwrap();
        let a = r#"{"type":"user","uuid":"x1","timestamp":"2026-08-16T15:45:27.000Z","message":{"role":"user","content":"first"},"origin":{"kind":"human"},"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s4"}"#;
        let b = r#"{"type":"assistant","uuid":"x2","timestamp":"2026-08-16T15:45:28.000Z","message":{"id":"cc-1","role":"assistant","model":"m","content":[{"type":"text","text":"second"}]},"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s4"}"#;
        let c = r#"{"type":"user","uuid":"x3","timestamp":"2026-08-16T15:45:29.000Z","message":{"role":"user","content":"third"},"origin":{"kind":"human"},"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s4"}"#;
        write_session(tmp.path(), "s4", &[a, b, c]);

        let detail = parser_in(tmp.path()).get_conversation("s4").unwrap();
        assert_eq!(detail.turns.len(), 3);
        assert_eq!(detail.summary.title.as_deref(), Some("first"));
    }

    // `custom-title` (the user's own `/rename`) outranks `ai-title`, which
    // outranks the first prompt. Both are plaintext records in the transcript —
    // the encrypted `state.json` is not the only source.
    #[test]
    fn title_records_outrank_the_first_prompt() {
        let tmp = tempfile::tempdir().unwrap();
        let ai = r#"{"type":"ai-title","sessionId":"s1","aiTitle":"Reading project notes"}"#;
        let custom = r#"{"type":"custom-title","sessionId":"s1","customTitle":"notes probe"}"#;

        write_session(tmp.path(), "s1", &[USER_LINE, ANSWER_LINE, ai]);
        assert_eq!(
            parser_in(tmp.path()).list_conversations().unwrap()[0]
                .title
                .as_deref(),
            Some("Reading project notes")
        );

        let tmp2 = tempfile::tempdir().unwrap();
        write_session(tmp2.path(), "s1", &[USER_LINE, ANSWER_LINE, ai, custom]);
        let summary_title = parser_in(tmp2.path()).list_conversations().unwrap()[0]
            .title
            .clone();
        assert_eq!(summary_title.as_deref(), Some("notes probe"));
        // Summary and detail MUST agree or the auto-title backfill oscillates.
        assert_eq!(
            parser_in(tmp2.path())
                .get_conversation("s1")
                .unwrap()
                .summary
                .title,
            summary_title
        );
    }

    // Qoder persists slash commands with Claude Code's exact tag names (they
    // are literal constants in the 1.1.23 bundle). Every one of those tags is
    // on the strip list, so the record's text is empty AFTER stripping —
    // reconstructing the invocation is the only thing that keeps it visible.
    #[test]
    fn slash_commands_render_as_the_invocation() {
        let tmp = tempfile::tempdir().unwrap();
        let cmd = r#"{"type":"user","uuid":"c1","timestamp":"2026-08-16T15:45:27.000Z","message":{"role":"user","content":"<command-message>init</command-message>\n<command-name>/init</command-name>\n<command-args>--force</command-args>"},"origin":{"kind":"human"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s5"}"#;
        write_session(tmp.path(), "s5", &[cmd]);

        let detail = parser_in(tmp.path()).get_conversation("s5").unwrap();
        assert_eq!(detail.turns.len(), 1, "the record must not be dropped");
        assert_eq!(text_of(&detail.turns[0]), "/init --force");
        assert_eq!(detail.summary.title.as_deref(), Some("/init --force"));
    }

    // The same command arriving in the ACP block-array shape.
    #[test]
    fn slash_commands_render_from_block_arrays_too() {
        let tmp = tempfile::tempdir().unwrap();
        let cmd = r#"{"type":"user","uuid":"c2","timestamp":"2026-08-16T15:45:27.000Z","message":{"role":"user","content":[{"type":"text","text":"<command-name>/compact</command-name>"}]},"origin":{"kind":"human"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s6"}"#;
        write_session(tmp.path(), "s6", &[cmd]);

        let detail = parser_in(tmp.path()).get_conversation("s6").unwrap();
        assert_eq!(text_of(&detail.turns[0]), "/compact");
    }

    // A prompt that merely QUOTES the tags is still a prompt, not a command:
    // `slash_command_display` requires the captured name to start with `/`.
    #[test]
    fn a_prompt_without_a_command_name_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let line = r#"{"type":"user","uuid":"c3","timestamp":"2026-08-16T15:45:27.000Z","message":{"role":"user","content":"explain <command-args>foo</command-args> please"},"origin":{"kind":"human"},"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s7"}"#;
        write_session(tmp.path(), "s7", &[line]);

        let detail = parser_in(tmp.path()).get_conversation("s7").unwrap();
        assert_eq!(text_of(&detail.turns[0]), "explain  please");
    }

    // Compaction is the one place Qoder deliberately writes `parentUuid: null`
    // in the MIDDLE of a session: the `system`/`compact_boundary` record roots
    // the post-compaction segment for replay and stashes the real predecessor
    // in `logicalParentUuid`. Following only `parentUuid` stops there and hides
    // everything the user sent before the compaction.
    #[test]
    fn compaction_boundary_does_not_hide_earlier_history() {
        let tmp = tempfile::tempdir().unwrap();
        let boundary = r#"{"type":"system","uuid":"cb1","subtype":"compact_boundary","timestamp":"2026-08-16T15:45:35.000Z","parentUuid":null,"logicalParentUuid":"a3","requiresActiveLeafCommit":true,"isSidechain":false,"sessionId":"s1"}"#;
        let summary = r#"{"type":"user","uuid":"cs1","timestamp":"2026-08-16T15:45:36.000Z","message":{"role":"user","content":[{"type":"text","text":"SUMMARY OF EARLIER WORK"}]},"isCompactSummary":true,"parentUuid":"cb1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let after = r#"{"type":"assistant","uuid":"post","timestamp":"2026-08-16T15:45:37.000Z","message":{"id":"cc-post","role":"assistant","model":"qmodel_38max","content":[{"type":"text","text":"AFTER COMPACTION"}]},"parentUuid":"cs1","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        let leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"post","explicit":false,"timestamp":1786895137000}"#;
        write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                THINKING_LINE,
                TOOL_USE_LINE,
                TOOL_RESULT_LINE,
                ANSWER_LINE,
                boundary,
                summary,
                after,
                leaf,
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let rendered: Vec<String> = detail.turns.iter().map(text_of).collect();
        assert!(
            rendered.iter().any(|t| t.contains("read NOTES.md")),
            "pre-compaction history must survive: {rendered:?}"
        );
        assert!(rendered.iter().any(|t| t == "42"));
        assert!(rendered.iter().any(|t| t == "AFTER COMPACTION"));

        // The summary is content worth seeing, but it is not something the user
        // said — so it is a system turn, and it never becomes the title.
        let summary_turn = detail
            .turns
            .iter()
            .find(|t| text_of(t).contains("SUMMARY OF EARLIER WORK"))
            .expect("summary rendered");
        assert!(matches!(
            summary_turn.role,
            crate::models::TurnRole::System
        ));
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("read NOTES.md and reply")
        );
    }

    // A compaction summary that arrives BEFORE any real prompt must still not
    // become the title — the flag, not the ordering, is what disqualifies it.
    #[test]
    fn a_leading_compaction_summary_is_never_the_title() {
        let tmp = tempfile::tempdir().unwrap();
        let summary = r#"{"type":"user","uuid":"cs2","timestamp":"2026-08-16T15:45:20.000Z","message":{"role":"user","content":[{"type":"text","text":"SUMMARY OF EARLIER WORK"}]},"isCompactSummary":true,"parentUuid":null,"isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1"}"#;
        write_session(tmp.path(), "s1", &[summary, USER_LINE, ANSWER_LINE]);

        let summaries = parser_in(tmp.path()).list_conversations().unwrap();
        assert_eq!(
            summaries[0].title.as_deref(),
            Some("read NOTES.md and reply")
        );
    }

    #[test]
    fn token_stats_beat_reconstructed_usage() {
        let tmp = tempfile::tempdir().unwrap();
        let stats = r#"{"type":"token-stats","sessionId":"s1","promptTokenCount":4242,"timestamp":1786895134000}"#;
        write_session(
            tmp.path(),
            "s1",
            &[RUNTIME_CONFIG, USER_LINE, ANSWER_LINE, stats],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_used_tokens, Some(4242));
        assert_eq!(s.context_window_max_tokens, Some(262_144));
    }

    // Byte-for-byte usage shapes from a real `entrypoint:"acp"` transcript.
    // REDACTED is what Qoder writes for its own hosted models with no
    // `QODER_EXPOSE_TOKEN_USAGE`: every counter zeroed, the ratio intact.
    // EXPOSED is the same response with the env set.
    fn answer_with_usage(uuid: &str, parent: &str, usage: &str) -> String {
        format!(
            r#"{{"type":"assistant","uuid":"{uuid}","timestamp":"2026-09-19T10:51:07.266Z","message":{{"id":"chatcmpl-{uuid}","type":"message","role":"assistant","model":"qfmodel","stop_reason":"end_turn","content":[{{"type":"text","text":"ok","citations":null}}],"usage":{usage}}},"parentUuid":"{parent}","isSidechain":false,"cwd":"/private/tmp/probe","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown"}}"#
        )
    }

    const REDACTED: &str = r#"{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0,"credits":0.269,"billable":false,"context_usage_ratio":0.16721666666666668}"#;
    const EXPOSED: &str = r#"{"input_tokens":2803,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":19,"credits":0.025,"billable":false,"context_usage_ratio":0.015572222222222222}"#;

    // The whole point of reading the ratio: these sessions have NO token
    // counters at all, so the gauge used to have nothing to draw and sat dark
    // at "0" forever.
    #[test]
    fn redacted_usage_still_yields_a_context_percentage() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, &answer_with_usage("a9", "u1", REDACTED)],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 16.721_666_666_666_668).abs() < 1e-9, "{percent}");
        // Nothing to divide and nothing to invert, so neither figure is
        // invented — the gauge shows a percentage with no "x / y".
        assert_eq!(s.context_window_used_tokens, None);
        assert_eq!(s.context_window_max_tokens, None);
    }

    // With the counters present the ratio also names the window, which no
    // record in the file states and `qfmodel` matches no entry in the
    // id-prefix table.
    #[test]
    fn exposed_usage_inverts_the_ratio_into_the_window() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, &answer_with_usage("a9", "u1", EXPOSED)],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_used_tokens, Some(2803));
        assert_eq!(s.context_window_max_tokens, Some(180_000));
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 1.557_222_222_222_222_2).abs() < 1e-9, "{percent}");
    }

    // Occupancy is a level, not a sum: the newest response describes the
    // context the next prompt will carry.
    #[test]
    fn the_newest_reported_ratio_wins() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[
                USER_LINE,
                &answer_with_usage("a8", "u1", REDACTED),
                &answer_with_usage("a9", "a8", EXPOSED),
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 1.557_222_222_222_222_2).abs() < 1e-9, "{percent}");
    }

    // A rewound branch describes a context that no longer exists. `a8` stays in
    // the file forever; the active leaf says `a9` is the live tail.
    #[test]
    fn a_rewound_branch_does_not_supply_the_ratio() {
        let tmp = tempfile::tempdir().unwrap();
        let leaf = r#"{"type":"active-leaf","sessionId":"s1","leafUuid":"a9","explicit":true,"rewound":true,"timestamp":1789815619554}"#;
        write_session(
            tmp.path(),
            "s1",
            &[
                USER_LINE,
                &answer_with_usage("a9", "u1", EXPOSED),
                &answer_with_usage("a8", "u1", REDACTED),
                leaf,
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 1.557_222_222_222_222_2).abs() < 1e-9, "{percent}");
        assert_eq!(s.context_window_max_tokens, Some(180_000));
    }

    // An explicit `runtime-config.contextWindow` is Qoder stating the window
    // outright; the inversion is a derivation and must not displace it.
    #[test]
    fn runtime_config_window_beats_the_inverted_one() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[
                RUNTIME_CONFIG,
                USER_LINE,
                &answer_with_usage("a9", "u1", EXPOSED),
            ],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_max_tokens, Some(262_144));
        // ...but the percentage is still Qoder's own, not 2803/262144.
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 1.557_222_222_222_222_2).abs() < 1e-9, "{percent}");
    }

    // A ratio Qoder clamped to 1.0 means "full or overflowing"; inverting it
    // would report the occupancy AS the window and draw a gauge that can never
    // move.
    #[test]
    fn a_saturated_ratio_names_no_window() {
        let tmp = tempfile::tempdir().unwrap();
        let full = r#"{"input_tokens":190000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":5,"context_usage_ratio":1}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, &answer_with_usage("a9", "u1", full)],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_max_tokens, None);
        assert_eq!(s.context_window_usage_percent, Some(100.0));
    }

    // The gauge's three figures must agree. Qoder's `input_tokens` already
    // CONTAINS its cache counters, so before the split the occupancy read
    // `2803 + 900 + 100 = 3803` against a 180000 window (2.11%) while Qoder
    // reported 1.56% for the same turn — a gauge contradicting its own caption.
    // Measured on a real session at 20513 input / 18871 cache-read, where the
    // error was nearly 2x.
    #[test]
    fn the_gauge_does_not_count_the_cached_prefix_twice() {
        let tmp = tempfile::tempdir().unwrap();
        let cached = r#"{"input_tokens":2803,"cache_creation_input_tokens":100,"cache_read_input_tokens":900,"output_tokens":19,"context_usage_ratio":0.015572222222222222}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, &answer_with_usage("a9", "u1", cached)],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_max_tokens, Some(180_000));
        // The whole prompt, cached part included exactly once — and therefore
        // the very numerator Qoder divided to get its ratio.
        assert_eq!(s.context_window_used_tokens, Some(2803));
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 1.557_222_222_222_222_2).abs() < 1e-9, "{percent}");
        // The stated percentage and the used/max pair now tell the same story.
        let recomputed = 2803.0 / 180_000.0 * 100.0;
        assert!((percent - recomputed).abs() < 1e-6, "{percent} vs {recomputed}");

        // The split is a re-labelling, not a deduction: the turn's own counters
        // still add back up to the prompt Qoder charged for.
        let usage = detail.turns[1].usage.as_ref().expect("usage");
        assert_eq!(usage.input_tokens, 1803);
        assert_eq!(usage.cache_read_input_tokens, 900);
        assert_eq!(usage.cache_creation_input_tokens, 100);
        assert_eq!(
            usage.input_tokens
                + usage.cache_read_input_tokens
                + usage.cache_creation_input_tokens,
            2803
        );
    }

    // A ratio small enough to blow the quotient past what an f64 holds exactly
    // must yield NO window: `as u64` saturates instead of failing, so the
    // alternative is reporting `u64::MAX` as this model's context window.
    #[test]
    fn an_absurd_ratio_names_no_window() {
        let tmp = tempfile::tempdir().unwrap();
        let absurd = r#"{"input_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":1,"context_usage_ratio":5e-20}"#;
        write_session(
            tmp.path(),
            "s1",
            &[USER_LINE, &answer_with_usage("a9", "u1", absurd)],
        );

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_max_tokens, None);
        // The occupancy it stated is still its own statement, and still shown.
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - 5e-18).abs() < 1e-24, "{percent}");
    }

    // A transcript that states no ratio still gets a gauge, the old way: the
    // window from `runtime-config` and the occupancy reconstructed from the
    // counters (10 = the fixture's cache-inclusive `input_tokens`, not 10+5).
    #[test]
    fn a_transcript_without_a_ratio_falls_back_to_the_counters() {
        let tmp = tempfile::tempdir().unwrap();
        write_session(tmp.path(), "s1", &[RUNTIME_CONFIG, USER_LINE, ANSWER_LINE]);

        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        let s = detail.session_stats.expect("session stats");
        assert_eq!(s.context_window_used_tokens, Some(10));
        assert_eq!(s.context_window_max_tokens, Some(262_144));
        let percent = s.context_window_usage_percent.expect("percent");
        assert!((percent - (10.0 / 262_144.0) * 100.0).abs() < 1e-9, "{percent}");
    }

    // An `AskUserQuestion` round captured from a real qodercli 1.1.67 ACP
    // session (driven over `elicitation/create` with `--fake-responses`; usage,
    // anchors and paths trimmed): a single-select and a multi-select question,
    // answered "B" and "X" plus the user's own text.
    const ASK_PROMPT_LINE: &str = r#"{"type":"user","uuid":"q-u1","timestamp":"2026-10-12T23:56:20.355Z","message":{"role":"user","content":[{"type":"text","text":"Ask me a question."}]},"permissionMode":"default","origin":{"kind":"human"},"promptId":"p1","parentUuid":null,"isSidechain":false,"cwd":"/w","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown","gitBranch":"HEAD"}"#;
    const ASK_TOOL_USE_LINE: &str = r#"{"type":"assistant","uuid":"q-a1","timestamp":"2026-10-12T23:56:20.647Z","message":{"id":"msg_1","type":"message","role":"assistant","model":"auto","stop_reason":"tool_use","stop_sequence":null,"content":[{"type":"tool_use","id":"toolu_b857","name":"AskUserQuestion","input":{"questions":[{"question":"Pick A or B?","header":"Choice","options":[{"label":"A","description":"Option A."},{"label":"B","description":"Option B."}],"multiSelect":false},{"question":"Which extras?","header":"Extras","options":[{"label":"X","description":"Extra X."},{"label":"Y","description":"Extra Y."}],"multiSelect":true}]}}]},"parentUuid":"q-u1","isSidechain":false,"cwd":"/w","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown","gitBranch":"HEAD"}"#;
    const ASK_RESULT_LINE: &str = r#"{"type":"user","uuid":"q-u2","timestamp":"2026-10-12T23:56:20.751Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b857","content":"Your questions have been answered: \"Pick A or B?\"=\"B\", \"Which extras?\"=\"X, free text\". You can now continue with these answers in mind."}]},"sourceToolAssistantUUID":"q-a1","promptId":"p1","toolUseResult":{"questions":[{"question":"Pick A or B?","header":"Choice","options":[{"label":"A","description":"Option A."},{"label":"B","description":"Option B."}],"multiSelect":false},{"question":"Which extras?","header":"Extras","options":[{"label":"X","description":"Extra X."},{"label":"Y","description":"Extra Y."}],"multiSelect":true}],"answers":{"Pick A or B?":"B","Which extras?":"X, free text"}},"parentUuid":"q-a1","isSidechain":false,"cwd":"/w","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown","gitBranch":"HEAD"}"#;
    // The same ask declined: Qoder rejects the call like any denied tool.
    const ASK_DECLINED_LINE: &str = r#"{"type":"user","uuid":"q-u2","timestamp":"2026-10-12T23:56:20.751Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_b857","content":"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Do not repeat this call; take a different approach, or if you cannot proceed without it, tell the user what you were trying to do and why you need it.","is_error":true}]},"sourceToolAssistantUUID":"q-a1","promptId":"p1","toolUseResult":{"isHardFailure":false},"toolDenialKind":"user-rejected","parentUuid":"q-a1","isSidechain":false,"cwd":"/w","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown","gitBranch":"HEAD"}"#;
    const ASK_DONE_LINE: &str = r#"{"type":"assistant","uuid":"q-a2","timestamp":"2026-10-12T23:56:20.880Z","message":{"id":"msg_2","type":"message","role":"assistant","model":"auto","stop_reason":"end_turn","stop_sequence":null,"content":[{"type":"text","text":"done","citations":null}]},"parentUuid":"q-u2","isSidechain":false,"cwd":"/w","sessionId":"s1","userType":"external","entrypoint":"acp","version":"unknown","gitBranch":"HEAD"}"#;

    fn ask_result_output(result_line: &str) -> (Option<String>, bool) {
        let tmp = tempfile::tempdir().unwrap();
        write_session(
            tmp.path(),
            "s1",
            &[
                ASK_PROMPT_LINE,
                ASK_TOOL_USE_LINE,
                result_line,
                ASK_DONE_LINE,
            ],
        );
        let detail = parser_in(tmp.path()).get_conversation("s1").unwrap();
        detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .find_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } if tool_use_id.as_deref() == Some("toolu_b857") => {
                    Some((output_preview.clone(), *is_error))
                }
                _ => None,
            })
            .expect("the ask's result is in the transcript")
    }

    // The question card cannot read the sentence Qoder hands the model, so an
    // answered ask has to reload carrying the answers Qoder recorded beside it
    // — or every question shows nothing selected. "X" plus the user's own text
    // is one `", "`-joined string by now, and stays the text the agent got.
    #[test]
    fn an_answered_ask_reloads_with_its_recorded_answers() {
        let (output, is_error) = ask_result_output(ASK_RESULT_LINE);
        assert!(!is_error);
        let envelope: Value = serde_json::from_str(&output.expect("output")).unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({
                "answers": [
                    {"header": "Choice", "question": "Pick A or B?", "selected": ["B"]},
                    {"header": "Extras", "question": "Which extras?", "selected": ["X, free text"]},
                ],
                "declined": false,
            })
        );
    }

    // A declined ask keeps Qoder's own rejection: there are no answers to show.
    #[test]
    fn a_declined_ask_keeps_its_rejection() {
        let (output, is_error) = ask_result_output(ASK_DECLINED_LINE);
        assert!(is_error);
        assert!(output
            .expect("output")
            .starts_with("The user doesn't want to proceed with this tool use."));
    }

    fn ask_questions(questions: Value) -> Vec<QoderAskQuestion> {
        QoderAskQuestion::list_from(Some(&questions)).expect("questions")
    }

    // A multi-select answer is one `", "`-joined string. It splits back into
    // picks only when every part is an offered label (a label containing ", "
    // staying whole); with the user's own text in it, "Blue, teal" could be
    // Blue plus "teal" or the text "Blue, teal", so it stays the literal text
    // rather than claim a choice the user may have typed.
    #[test]
    fn a_multi_select_answer_splits_only_into_offered_labels() {
        let questions = ask_questions(serde_json::json!([{
            "question": "Colors?",
            "header": "Colors",
            "multiSelect": true,
            "options": [{"label": "Red, Green"}, {"label": "Red"}, {"label": "Blue"}],
        }]));
        assert_eq!(
            questions[0].picks("Red, Green, Blue"),
            ["Red, Green", "Blue"]
        );
        assert_eq!(questions[0].picks("Blue, Red"), ["Blue", "Red"]);
        assert_eq!(
            questions[0].picks("Red, Green, Blue, teal, maybe"),
            ["Red, Green, Blue, teal, maybe"]
        );
        assert_eq!(questions[0].picks("Bluest"), ["Bluest"]);
        assert_eq!(questions[0].picks("my own"), ["my own"]);
        assert!(questions[0].picks("").is_empty());

        // "Red, Green" is both an option and Red plus Green: nothing it shows
        // as chosen could be trusted, so it claims nothing — and the text,
        // being an option itself, cannot stand in either.
        let questions = ask_questions(serde_json::json!([{
            "question": "Colors?",
            "multiSelect": true,
            "options": [{"label": "Red, Green"}, {"label": "Red"}, {"label": "Green"}],
        }]));
        assert!(questions[0].picks("Red, Green").is_empty());
        // Several readings again, but the text is no option: it stays the text.
        let questions = ask_questions(serde_json::json!([{
            "question": "Colors?",
            "multiSelect": true,
            "options": [{"label": "Red, Green"}, {"label": "Red"}, {"label": "Green"},
                        {"label": "Blue"}],
        }]));
        assert_eq!(questions[0].picks("Red, Green, Blue"), ["Red, Green, Blue"]);
        assert_eq!(questions[0].picks("Blue, Red"), ["Blue", "Red"]);
    }

    // Labels that are joins of each other read a long answer in exponentially
    // many ways; counting readings per suffix keeps that linear, and every
    // outcome still claims nothing it cannot prove.
    #[test]
    fn self_similar_labels_are_read_in_linear_time() {
        let questions = ask_questions(serde_json::json!([{
            "question": "Pick?",
            "multiSelect": true,
            "options": [{"label": "A"}, {"label": "A, A"}],
        }]));
        // Thousands of "A" before the user's own text: unreadable as labels,
        // so the literal text — after a linear pass, not a combinatorial one.
        let long = format!("{}custom", "A, ".repeat(5_000));
        assert_eq!(questions[0].picks(&long), [long.as_str()]);
        // A, A is the option "A, A" or A twice; the text is an option itself,
        // so nothing is claimed.
        assert!(questions[0].picks("A, A").is_empty());
        // Several readings, and the text is no option: it stays the text.
        assert_eq!(questions[0].picks("A, A, A"), ["A, A, A"]);
        assert_eq!(questions[0].picks("A"), ["A"]);
    }

    // What codeg itself sent back is exact: each question's own entry, chosen
    // labels and the user's own text kept apart.
    #[test]
    fn the_reply_codeg_sent_is_read_as_sent() {
        let questions = ask_questions(serde_json::json!([
            {"question": "Pick A or B?", "header": "Choice", "options": [{"label": "A"}, {"label": "B"}]},
            {"question": "Skipped?", "header": "Skip", "options": [{"label": "No"}]},
            {"question": "Which extras?", "header": "Extras", "multiSelect": true,
             "options": [{"label": "X"}, {"label": "Y"}]},
        ]));
        let reply = serde_json::json!({"q0": "B", "q2": ["X", "free, text"]});
        let envelope: Value = serde_json::from_str(
            &qoder_ask_envelope_from_reply(&questions, reply.as_object().unwrap())
                .expect("envelope"),
        )
        .unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({
                "answers": [
                    {"header": "Choice", "question": "Pick A or B?", "selected": ["B"]},
                    {"header": "Extras", "question": "Which extras?", "selected": ["X", "free, text"]},
                ],
                "declined": false,
            })
        );
        assert_eq!(
            qoder_ask_envelope_from_reply(&questions, &serde_json::Map::new()),
            None
        );
    }

    // A single-select answer is one pick, whatever punctuation it carries.
    #[test]
    fn a_single_select_answer_is_never_split() {
        let questions = ask_questions(serde_json::json!([{
            "question": "Pick?",
            "options": [{"label": "A"}, {"label": "B"}],
        }]));
        assert_eq!(questions[0].picks("A, B"), ["A, B"]);
    }

    // The live completion carries only the sentence; read against the known
    // questions it gives the same envelope the transcript does — quotes and
    // ", " inside a question or an answer included, unanswered questions left
    // out.
    #[test]
    fn the_answered_sentence_reads_back_against_its_questions() {
        let questions = ask_questions(serde_json::json!([
            {"question": "Rename \"foo\"?", "header": "Rename", "options": [{"label": "Yes"}]},
            {"question": "Skipped?", "header": "Skip", "options": [{"label": "No"}]},
            {"question": "Which extras?", "header": "Extras", "multiSelect": true,
             "options": [{"label": "X"}, {"label": "Y"}]},
            {"question": "Which\nlines?", "header": "Lines", "multiSelect": true,
             "options": [{"label": "X"}, {"label": "Y"}]},
        ]));
        let text = concat!(
            "Your questions have been answered: ",
            "\"Rename \"foo\"?\"=\"say \"hi\", then go\", ",
            "\"Which extras?\"=\"X, Y, free text\", ",
            "\"Which\nlines?\"=\"Y, X\". ",
            "You can now continue with these answers in mind.",
        );
        let envelope: Value = serde_json::from_str(
            &qoder_ask_envelope_from_result_text(&questions, text).expect("envelope"),
        )
        .unwrap();
        assert_eq!(
            envelope,
            serde_json::json!({
                "answers": [
                    {"header": "Rename", "question": "Rename \"foo\"?", "selected": ["say \"hi\", then go"]},
                    {"header": "Extras", "question": "Which extras?", "selected": ["X, Y, free text"]},
                    {"header": "Lines", "question": "Which\nlines?", "selected": ["Y", "X"]},
                ],
                "declined": false,
            })
        );

        // Only a later question answered: the earlier ones have no entry.
        let text = "Your questions have been answered: \"Which extras?\"=\"Y\". You can now \
                    continue with these answers in mind.";
        let envelope: Value = serde_json::from_str(
            &qoder_ask_envelope_from_result_text(&questions, text).expect("envelope"),
        )
        .unwrap();
        assert_eq!(
            envelope["answers"],
            serde_json::json!([{"header": "Extras", "question": "Which extras?", "selected": ["Y"]}])
        );
    }

    // Anything but the answered sentence is left as it came.
    #[test]
    fn other_result_text_is_not_read_as_answers() {
        let questions = ask_questions(serde_json::json!([
            {"question": "Pick A or B?", "options": [{"label": "A"}, {"label": "B"}]},
        ]));
        for text in [
            "The user doesn't want to proceed with this tool use. The tool use was rejected.",
            "The user did not answer the questions.",
            // An entry for a question this call never asked.
            "Your questions have been answered: \"Other?\"=\"A\". You can now continue with \
             these answers in mind.",
            "Your questions have been answered: . You can now continue with these answers in \
             mind.",
        ] {
            assert_eq!(
                qoder_ask_envelope_from_result_text(&questions, text),
                None,
                "{text}"
            );
        }
        assert!(
            QoderAskQuestion::list_from(Some(&serde_json::json!([{"header": "No text"}])))
                .is_none()
        );
    }

    /// #948: built with an agent's launch env, the parser reads where THAT
    /// env puts the agent's files, not where codeg's own environment does.
    #[test]
    fn for_env_reads_the_config_dir_of_the_launch_env() {
        let env = AgentEnv::with_overrides(&[("QODER_CONFIG_DIR", "/relocated/qoder")]);
        assert_eq!(
            QoderParser::for_env(&env).base_dir,
            PathBuf::from("/relocated/qoder").join("projects")
        );

        // No config-dir override: the home keys, in order, and the dir name.
        let env = AgentEnv::with_overrides(&[
            ("QODER_CONFIG_DIR", ""),
            ("QODER_CLI_HOME", "/relocated/qoder-home"),
            ("GEMINI_CLI_HOME", "/relocated/unused"),
            ("QODER_CONFIG_DIR_NAME", ".qoder-alt"),
        ]);
        assert_eq!(
            QoderParser::for_env(&env).base_dir,
            PathBuf::from("/relocated/qoder-home")
                .join(".qoder-alt")
                .join("projects")
        );
        let env = AgentEnv::with_overrides(&[
            ("QODER_CONFIG_DIR", ""),
            ("QODER_CLI_HOME", ""),
            ("GEMINI_CLI_HOME", "/relocated/gemini-home"),
            ("QODER_CONFIG_DIR_NAME", ""),
        ]);
        assert_eq!(
            QoderParser::for_env(&env).base_dir,
            PathBuf::from("/relocated/gemini-home")
                .join(".qoder")
                .join("projects")
        );
    }
}
