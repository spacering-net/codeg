use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde_json::Value;
use walkdir::WalkDir;

use crate::models::{
    AgentType, ContentBlock, ConversationDetail, ConversationSummary, MessageRole, TurnUsage,
    UnifiedMessage,
};
use crate::parsers::claude::{
    capture_title_record, extract_assistant_content, extract_usage, extract_user_content,
    extract_user_text, group_into_turns, is_interrupt_marker, is_meta_message,
    is_synthetic_assistant, slash_command_display, ClaudeRecordAccumulator,
};
use crate::parsers::{
    backfill_turn_durations, compute_session_stats, folder_name_from_path,
    infer_context_window_max_tokens, latest_turn_prompt_usage_tokens, merge_context_window_stats,
    relocate_orphaned_tool_results, resolve_patch_line_numbers, structurize_read_tool_output,
    title_from_user_text, with_reported_context_percent, AgentParser, ParseError,
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
    resolve_qoder_config_dir_from(
        std::env::var_os("QODER_CONFIG_DIR"),
        std::env::var_os("QODER_CLI_HOME").or_else(|| std::env::var_os("GEMINI_CLI_HOME")),
        std::env::var_os("QODER_CONFIG_DIR_NAME"),
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
        Self {
            base_dir: resolve_qoder_config_dir().join("projects"),
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
/// reason. Deliberately NOT a `FACT_SCHEMA_VERSION` bump: the only transcripts
/// that can carry non-zero counters are ones recorded with the launch env this
/// release also introduces, so there are no stored rows computed the old way to
/// rebuild.
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
    /// injections and `<synthetic>` error placeholders are already gone.
    fn message_count(&self) -> u32 {
        self.messages.len() as u32
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
/// unauthenticated user would see, since every turn fails that way.
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
                    None => extract_user_content(value),
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
                let entry_model = value
                    .pointer("/message/model")
                    .and_then(Value::as_str)
                    .map(String::from);
                if model.is_none() {
                    model.clone_from(&entry_model);
                }
                let message_id = value
                    .pointer("/message/id")
                    .and_then(Value::as_str)
                    .map(String::from);

                // One API response streams as SEVERAL records (thinking,
                // tool_use, final text) sharing one `message.id`; adjacent
                // fragments merge into a single bubble. Every one of them
                // repeats the response's full usage, so the claim below keeps it
                // on exactly one message — including across the turn boundary a
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
                // every fragment repeats the same one. Taking it here keeps the
                // figure even when the claim handed the usage to an earlier
                // bubble.
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
    let session_stats = with_reported_context_percent(
        merge_context_window_stats(compute_session_stats(&turns), used_tokens, max_tokens),
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
        assert_eq!(detail.turns.len(), 1);
        assert!(matches!(detail.turns[0].role, crate::models::TurnRole::User));
        assert_eq!(text_of(&detail.turns[0]), "hi");
        assert!(
            !detail.turns.iter().any(|t| text_of(t).contains("pricingUrl")),
            "a failed API turn must not render as the assistant's answer"
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
}
