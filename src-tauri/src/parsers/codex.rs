use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::{DateTime, Utc};
use regex::Regex;
use walkdir::WalkDir;

use crate::acp::agent_mentions::{
    contains_only_internal_agent_routes, strip_internal_agent_routes,
};
use crate::models::*;
use crate::parsers::codex_code_mode::{
    extract_chunk_ids, extract_shell_session_ids, is_code_mode_call, parse_code_mode_script,
    script_card_input,
    split_code_mode_output, with_note, CodeModeCall, CodeModeOutput, CodeModeScript, ScriptStatus,
    Separator, CODEX_SCRIPT_TOOL_NAME,
};
use crate::parsers::{
    folder_name_from_path, title_from_user_text, truncate_str, AgentParser, ParseError,
};

pub struct CodexParser {
    base_dir: PathBuf,
}

/// How far into a rollout to look for the `session_meta` carrying its history
/// pointer. It is line 0 in every file on disk; the slack is for a future
/// preamble, and the bound is what keeps this off the cost of a full parse for
/// the overwhelming majority of rollouts, which inherit no history.
const FORK_HEADER_SCAN_LINES: usize = 4;

/// What a canonical rollout filename encodes.
///
/// codex names a thread's rollout `rollout-<YYYY-MM-DDTHH-MM-SS>-<thread>.jsonl`.
/// `thread/revert` then moves the thread onto a NEW immutable file,
/// `rollout-<ts>-<thread>_<rollout>.jsonl`, and leaves the old one in place: the
/// thread id is the conversation, the rollout id names one file — and is what a
/// `history_base` points at. An ordinary rollout's rollout id is its thread id.
#[derive(Clone, Copy)]
struct RolloutFileName<'a> {
    timestamp: &'a str,
    thread_id: &'a str,
    rollout_id: &'a str,
}

impl<'a> RolloutFileName<'a> {
    fn parse(path: &'a Path) -> Option<Self> {
        let core = path
            .file_name()?
            .to_str()?
            .strip_prefix("rollout-")?
            .strip_suffix(".jsonl")?;
        let timestamp = core.get(..19)?;
        chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H-%M-%S").ok()?;
        let ids = core.get(19..)?.strip_prefix('-')?;
        let (thread_id, rollout_id) = ids.split_once('_').unwrap_or((ids, ids));
        (!thread_id.is_empty() && !rollout_id.is_empty()).then_some(Self {
            timestamp,
            thread_id,
            rollout_id,
        })
    }

    /// Orders one thread's rollouts the way codex does when it has no SQLite
    /// pointer to ask: by the filename's timestamp, then — for files created in
    /// the same second — by the rollout id, a time-ordered UUIDv7.
    fn recency(&self) -> (&'a str, &'a str) {
        (self.timestamp, self.rollout_id)
    }
}

/// Where a rollout's inherited history lives: the index of its header, the
/// rollout id it continues, and the first ordinal NOT taken from that rollout.
/// `None` for a rollout that holds its whole history itself.
///
/// Only the rollout's OWN header counts — the first `session_meta`. Anything
/// after it is content, such as a parent header a legacy fork replayed inline.
///
/// `history_base` is the physical pointer, and the only one codex follows to
/// read a thread. Forks write it, and so does `thread/revert`, which is why it
/// names a ROLLOUT: a revert keeps the thread id and swaps the file, so the
/// pointer can name an earlier file of this very thread. A fork's
/// `forked_from_id` + `forked_from_ordinal_exclusive` is its logical lineage —
/// codex keeps it when the fork is reverted and `history_base` moves to the
/// fork's own earlier rollout — so it is read only when `history_base` is
/// absent. Its id is a thread id, which is also the rollout id of that thread's
/// original file.
fn inherited_history_pointer(lines: &[String]) -> Option<(usize, String, u64)> {
    let (header_idx, header) = lines
        .iter()
        .take(FORK_HEADER_SCAN_LINES)
        .enumerate()
        .find_map(|(idx, line)| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            (value.get("type").and_then(serde_json::Value::as_str) == Some("session_meta"))
                .then_some((idx, value))
        })?;
    let payload = header.get("payload")?;
    let pointer = |id: Option<&serde_json::Value>, cut: Option<&serde_json::Value>| {
        let id = id?.as_str().map(str::trim).filter(|id| !id.is_empty())?;
        Some((header_idx, id.to_string(), cut?.as_u64()?))
    };
    let history_base = payload.get("history_base");
    pointer(
        history_base.and_then(|base| base.get("thread_id")),
        history_base.and_then(|base| base.get("end_ordinal_exclusive")),
    )
    .or_else(|| {
        pointer(
            payload.get("forked_from_id"),
            payload.get("forked_from_ordinal_exclusive"),
        )
    })
}

/// A rollout line's `ordinal`, the position codex assigns within a thread's
/// stream. `None` for older rollouts, which predate the field.
fn codex_line_ordinal(line: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(line)
        .ok()?
        .get("ordinal")?
        .as_u64()
}

/// Drop the parent history a sub-agent rollout opens with, keeping the child's
/// own header and everything it did itself.
///
/// A codex sub-agent runs as a full rollout of its own, but codex seeds the file
/// with however much of the parent's thread the spawn asked to carry
/// (`fork_turns`). Those records are the PARENT's, and at the record level they
/// are indistinguishable from the child's — reading the file whole is what puts
/// somebody else's conversation at the top of the child's transcript.
///
/// `subagent_history_start_ordinal` is codex's own declaration of where the seed
/// ends, so the cut is exact rather than inferred. It is REQUIRED: rollouts
/// without it (codex ≤ 0.147, `history_mode: "legacy"`) are returned untouched.
/// Guessing a boundary there would be a bad trade — the obvious candidate, the
/// first inter-agent message addressed to this child, also appears inside the
/// replayed prefix whenever the parent had already talked to an earlier
/// sub-agent of the same name.
///
/// Independent of the by-reference splice in `rollout_lines`, which runs it on
/// every rollout it reads before splicing them together, so the seed is dropped
/// from whichever file of a lineage holds it.
fn trim_subagent_replay_prefix(own: Vec<String>) -> Vec<String> {
    let Some((header_idx, cut)) = own
        .iter()
        .enumerate()
        .take_while(|(idx, _)| *idx < FORK_HEADER_SCAN_LINES)
        .find_map(|(idx, line)| {
            let value: serde_json::Value = serde_json::from_str(line).ok()?;
            if value.get("type").and_then(serde_json::Value::as_str) != Some("session_meta") {
                return None;
            }
            let payload = value.get("payload")?;
            // Both are required: the ordinal alone would let an ordinary thread
            // that happens to carry the field lose its opening records.
            codex_parent_thread_id(payload)?;
            let cut = payload
                .get("subagent_history_start_ordinal")
                .and_then(serde_json::Value::as_u64)?;
            Some((idx, cut))
        })
    else {
        return own;
    };

    // The seed is a PREFIX of the stream — `subagent_history_start_ordinal` is
    // an index into it, not a predicate — so scan for the boundary and keep the
    // rest verbatim. That costs one JSON parse per SEEDED record (ten or so in
    // practice) instead of one per line: the session viewer re-reads a running
    // child every couple of seconds, and these files run past a thousand lines.
    //
    // A record with no ordinal ends the scan too. It cannot be placed on either
    // side, and stopping there can only keep more than necessary — never drop
    // work the child did.
    let boundary = own
        .iter()
        .position(|line| codex_line_ordinal(line).is_none_or(|ord| ord >= cut))
        .unwrap_or(own.len());
    // Nothing was seeded ahead of the child's own stream (a `cut` of 0, or a
    // header that is already at or past it) — there is nothing to drop, and
    // splicing the header back in would duplicate it.
    if boundary <= header_idx {
        return own;
    }

    // The header declares the lineage the parser latches identity from, and
    // sits below the cut itself.
    let mut kept = Vec::with_capacity(own.len() - boundary + 1);
    kept.push(own[header_idx].clone());
    kept.extend(own.into_iter().skip(boundary));
    kept
}

impl Default for CodexParser {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexParser {
    pub fn new() -> Self {
        let base_dir = resolve_codex_home_dir().join("sessions");
        Self { base_dir }
    }

    /// Test-only constructor that lets callers point the parser at a fixture
    /// directory instead of `~/.codex/sessions`.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
    }

    /// Every line of a rollout, with the history it inherits BY REFERENCE
    /// spliced in ahead of its own.
    ///
    /// Two things write a rollout that holds only part of its history plus a
    /// pointer to the rest (see `inherited_history_pointer`):
    ///
    /// * A fork. codex-acp 1.8.0's `session/fork` writes the child a rollout
    ///   that contains no history at all — just `session_meta` naming where it
    ///   forked from, then whatever the child does next. Read alone it parses to
    ///   zero turns, which is what put "this session has no messages" under
    ///   every `[Fork] …` row.
    /// * `thread/revert` (Codex Desktop's edit / retry). The thread keeps its
    ///   id but moves onto a NEW rollout that inherits the old one only up to
    ///   the reverted turn. Read alone it loses every turn before that; the old
    ///   file instead shows the turns the revert discarded and nothing after.
    ///
    /// Older forks are not like this: they REPLAY the parent inline (that is the
    /// second `session_meta` header `is_forked_thread_header` keys off) and so
    /// need no help. They carry no cut, which is what tells the shapes apart,
    /// and the ordinal filter makes that distinction self-enforcing rather than
    /// a bet: the inherited rollout contributes ordinals BELOW the cut and this
    /// one only its own at-or-above, so a child that did replay inline can't
    /// end up with the history twice. The same filter drops a revert's
    /// abandoned tail — the new rollout's ordinals resume AT the cut, so the old
    /// file's records past it are exactly the ones it replaced.
    ///
    /// Pointers chain — a fork of a fork, and every revert adds a rollout — so
    /// they are followed to the root. A chain ends early at a rollout it has
    /// already visited (a malformed cycle) or one codeg cannot find, which is
    /// not an error: the rollout may have been pruned, or live in a codex home
    /// this parser isn't pointed at. What was reached renders on its own rather
    /// than the conversation being refused. One that is there but fails to
    /// open is an error, as this rollout's own file would be: the summary cache
    /// keys on this rollout alone, so rendering what was reached would keep
    /// serving the truncated history after the failure cleared.
    ///
    /// The assembled order reproduces codex's own inline shape exactly — the
    /// child's header, then the inherited stream, then the child's body —
    /// because the parser latches `parent_id` from the FIRST header it sees and
    /// the child's is the one that declares the lineage.
    fn rollout_lines(&self, path: &Path) -> Result<Vec<String>, ParseError> {
        let read = |path: &Path| -> Result<Vec<String>, ParseError> {
            let own = BufReader::new(fs::File::open(path)?)
                .lines()
                .map_while(Result::ok)
                .collect();
            Ok(trim_subagent_replay_prefix(own))
        };

        let mut lines = read(path)?;
        // Newest first: every rollout that continues another, with its header's
        // index and the cut into the one it continues.
        let mut continuations = Vec::new();
        let mut visited: HashSet<String> = RolloutFileName::parse(path)
            .map(|name| name.rollout_id.to_string())
            .into_iter()
            .collect();
        while let Some((header_idx, base_id, cut)) = inherited_history_pointer(&lines) {
            if !visited.insert(base_id.clone()) {
                tracing::warn!(
                    rollout_id = %base_id,
                    "[codex] rollout history points back into itself; rendering what was reached"
                );
                break;
            }
            let Some(base_path) = self.find_rollout_by_rollout_id(&base_id) else {
                tracing::debug!(
                    rollout_id = %base_id,
                    "[codex] rollout inherits from a rollout with no file here"
                );
                break;
            };
            let base = read(&base_path)?;
            continuations.push((std::mem::replace(&mut lines, base), header_idx, cut));
        }
        if continuations.is_empty() {
            return Ok(lines);
        }

        // Oldest first from here, each record's ordinal read once however many
        // splices it passes through.
        let with_ordinals = |lines: Vec<String>| -> Vec<(Option<u64>, String)> {
            lines
                .into_iter()
                .map(|line| (codex_line_ordinal(&line), line))
                .collect()
        };
        let mut assembled = with_ordinals(lines);
        for (own, header_idx, cut) in continuations.into_iter().rev() {
            let mut own = with_ordinals(own);
            let header = own.remove(header_idx);
            let mut spliced = Vec::with_capacity(assembled.len() + own.len() + 1);
            spliced.push(header);
            spliced.extend(
                assembled
                    .into_iter()
                    .filter(|(ord, _)| ord.is_none_or(|ord| ord < cut)),
            );
            spliced.extend(
                own.into_iter()
                    .filter(|(ord, _)| ord.is_none_or(|ord| ord >= cut)),
            );
            assembled = spliced;
        }
        Ok(assembled.into_iter().map(|(_, line)| line).collect())
    }

    /// Every session id that still has a rollout under `sessions/` or
    /// `archived_sessions/`. Used to prune DB rows whose agent-side files are
    /// gone without opening each file.
    ///
    /// Returns `Err` when the walk hits an I/O / permission error: callers must
    /// treat that as "disk presence unknown" and **skip** prune, never as an
    /// empty set (an empty set means "successfully observed zero rollouts").
    pub(crate) fn present_session_ids(&self) -> Result<HashSet<String>, std::io::Error> {
        let mut ids = HashSet::new();
        self.collect_session_ids_from_dir(&self.base_dir, &mut ids)?;
        if let Some(home) = self.base_dir.parent() {
            self.collect_session_ids_from_dir(&home.join("archived_sessions"), &mut ids)?;
        }
        Ok(ids)
    }

    fn collect_session_ids_from_dir(
        &self,
        dir: &Path,
        ids: &mut HashSet<String>,
    ) -> Result<(), std::io::Error> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in WalkDir::new(dir).into_iter() {
            let entry = entry.map_err(|e| {
                std::io::Error::new(
                    e.io_error()
                        .map(|io| io.kind())
                        .unwrap_or(std::io::ErrorKind::Other),
                    e.to_string(),
                )
            })?;
            let path = entry.path();
            let ext = path.extension().and_then(|e| e.to_str());
            if ext != Some("jsonl") && ext != Some("json") {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy();
            if let Some(id) = session_id_from_rollout_filename(&name) {
                ids.insert(id);
            }
        }
        Ok(())
    }

    /// Every rollout file under the sessions root, in traversal order.
    fn rollout_paths(&self) -> impl Iterator<Item = PathBuf> + '_ {
        WalkDir::new(&self.base_dir)
            .into_iter()
            .filter_map(Result::ok)
            .map(walkdir::DirEntry::into_path)
            .filter(|path| {
                path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                    && path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .starts_with("rollout-")
            })
    }

    /// The rollout file a history pointer names. Codex embeds the id in the
    /// filename, so this never opens a file — but it matches the rollout id the
    /// name encodes, never a substring: a revert's new file carries the thread
    /// id too, and a pointer to the thread's original rollout must not resolve
    /// to the file holding the pointer.
    fn find_rollout_by_rollout_id(&self, rollout_id: &str) -> Option<PathBuf> {
        self.rollout_paths().find(|path| {
            RolloutFileName::parse(path).is_some_and(|name| name.rollout_id == rollout_id)
        })
    }

    /// The rollout a thread currently uses.
    ///
    /// Usually its only one. `thread/revert` moves a thread onto a new rollout
    /// under the same thread id and leaves the old file in place, so the id
    /// matches several files and traversal order would decide — on NTFS, whose
    /// listings are name-sorted, always in favour of the stale original. codex
    /// records the switch in its SQLite state; codeg reads only the rollouts, so
    /// this is codex's own rule for when that state is unavailable: the newest
    /// file.
    fn find_current_rollout(&self, thread_id: &str) -> Option<PathBuf> {
        self.rollout_paths()
            .filter_map(|path| {
                let name = RolloutFileName::parse(&path)?;
                let recency = (name.thread_id == thread_id)
                    .then(|| (name.timestamp.to_string(), name.rollout_id.to_string()))?;
                Some((recency, path))
            })
            .max_by(|(a, _), (b, _)| a.cmp(b))
            .map(|(_, path)| path)
    }

    /// Load Codex's append-only session title index. The transcript remains the
    /// fallback source, so a missing/unreadable index or a malformed line is
    /// deliberately ignored. Later non-empty records for the same session win.
    pub(crate) fn load_thread_name_index(&self) -> HashMap<String, String> {
        let mut titles = HashMap::new();
        let Some(home_dir) = self.base_dir.parent() else {
            return titles;
        };
        let Ok(file) = fs::File::open(home_dir.join("session_index.jsonl")) else {
            return titles;
        };

        for line in BufReader::new(file).lines() {
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
            };
            if line.trim().is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let session_id = value.get("id").and_then(serde_json::Value::as_str);
            let thread_name = value
                .get("thread_name")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty());
            if let (Some(id), Some(name)) = (session_id, thread_name) {
                titles.insert(id.to_string(), truncate_str(name, 100));
            }
        }

        titles
    }

    fn parse_jsonl_summary(
        &self,
        path: &Path,
    ) -> Result<Option<ConversationSummary>, ParseError> {
        let lines = self.rollout_lines(path)?;

        let mut conversation_id: Option<String> = None;
        let mut cwd: Option<String> = None;
        let mut parent_id: Option<String> = None;
        let mut session_header_seen = false;
        let mut git_branch: Option<String> = None;
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        let mut _cli_version: Option<String> = None;
        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;
        let mut message_count: u32 = 0;
        // Mirror the detail parser's leading-`/goal` fallback in the lightweight
        // list path: newer codex records `/goal` only as `thread_goal_updated` (no
        // `user_message`), so without this the sidebar/import entry is titleless
        // and under-counted. Decide it POSITIONALLY, exactly like the detail
        // parser: the goal is the opener iff no real user turn preceded it, and it
        // then supplies the title + one synthetic-turn count even when a LATER real
        // reply (e.g. "确认") exists. `has_real_user` tracks the same real-user-turn
        // sources detail uses (an `event_msg.user_message`, or an image-bearing
        // `response_item` user); `goal_objective` latches the first opening goal;
        // `goal_opens_session` snapshots whether it opened the session.
        let mut has_real_user = false;
        let mut goal_objective: Option<String> = None;
        let mut goal_opens_session = false;
        // Mirror of the detail parser's `response_item.message` promotion — see
        // [`ResponseItemPromotion`]. The two must agree or the sidebar entry and
        // the opened conversation disagree about count and title. Only the
        // per-candidate PAYLOAD differs (the list path needs no blocks): here it
        // is `(is_user, title_candidate)`, kept parallel to the shared tracker's
        // own candidate vector.
        let mut promotion = ResponseItemPromotion::new();
        let mut pending_promotions: Vec<(bool, Option<String>)> = Vec::new();
        let mut first_goal_ordinal: Option<u64> = None;
        let mut title_source_ordinal: Option<u64> = None;
        let mut title_from_thread_name = false;
        // Cross-channel dedup, mirroring the detail parser's
        // `should_skip_duplicate_user_message`: codex writes the same prompt
        // through BOTH `event_msg` and `response_item`, so counting each one
        // would put the sidebar's message count one ahead of the turns the
        // opened conversation actually renders.
        let mut recent_user_records: Vec<(DateTime<Utc>, UserTurnFingerprint)> = Vec::new();
        // Plan mode, mirroring the detail parser so the sidebar count tracks the
        // turns the opened conversation renders: a plan document counts once
        // (whichever of its two copies is seen first), and the synthetic
        // approval prompt counts not at all. Pairing slot and approval guard are
        // separate for the same reason they are there — see that parser.
        let mut collaboration_mode_is_plan = false;
        let mut plan_approval_expected = false;
        let mut pending_plan_twin: Option<String> = None;
        let mut plan_counted = false;

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            let record_ordinal =
                promotion.note_record(msg_type, promotion_payload_type(msg_type, &value));

            if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
                if let Ok(ts) = ts_str.parse::<DateTime<Utc>>() {
                    if first_timestamp.is_none() {
                        first_timestamp = Some(ts);
                    }
                    last_timestamp = Some(ts);
                }
            }

            match msg_type {
                "session_meta" => {
                    // The FIRST header is this thread's own; every later one
                    // belongs to a parent. Two shapes put a second header in
                    // this stream: an inline-replay fork writes the parent's
                    // header into its own file, and a by-reference fork gets
                    // the parent's lines spliced in by `rollout_lines`. In both
                    // the parent header carries the PARENT's `id`, `cwd` and
                    // branch, so a last-one-wins read would file the child's
                    // whole summary under the parent's session id — two rollouts
                    // claiming one id, which the conversation-list dedup then
                    // collapses, losing the fork. Latch every identity field,
                    // not just `parent_id`. Same rule `parse_codex_subagent_stats`
                    // uses.
                    if let Some(payload) = value.get("payload").filter(|_| !session_header_seen) {
                        session_header_seen = true;
                        conversation_id = payload
                            .get("id")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        cwd = payload
                            .get("cwd")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        parent_id = codex_parent_thread_id(payload);
                        _cli_version = payload
                            .get("cli_version")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        git_branch = payload
                            .get("git")
                            .and_then(|g| g.get("branch"))
                            .and_then(|b| b.as_str())
                            .map(|s| s.to_string());
                    }
                }
                "turn_context" => {
                    if model.is_none() {
                        model = value
                            .get("payload")
                            .and_then(|p| p.get("model"))
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string());
                    }
                    // Arm the plan-approval filter — see the detail parser's
                    // `turn_context` arm for why the mode flip is the signal and
                    // why a repeated context must not disarm.
                    if let Some(mode) = turn_collaboration_mode(&value) {
                        let is_plan = mode == "plan";
                        if is_plan {
                            plan_approval_expected = false;
                        } else if collaboration_mode_is_plan {
                            plan_approval_expected = true;
                        }
                        collaboration_mode_is_plan = is_plan;
                    }
                }
                "event_msg" => {
                    if let Some(payload) = value.get("payload") {
                        let payload_type =
                            payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        match payload_type {
                            "user_message" => {
                                let raw_text = payload
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("");
                                // codex's own post-approval prompt — suppressed in
                                // the detail parser, so it must not be counted here
                                // either. Both signals required, and the wording
                                // compared verbatim; see that arm. Consumed as the
                                // FIRST thing this arm does, matching the detail
                                // parser: the arm names the next user record, so a
                                // record that later `continue`s must still spend it.
                                let approval_armed = std::mem::take(&mut plan_approval_expected);
                                if approval_armed
                                    && raw_text == CODEX_PLAN_APPROVAL_PROMPT
                                    && std::mem::take(&mut plan_counted)
                                {
                                    continue;
                                }

                                let visible_text = strip_internal_agent_routes(raw_text);
                                let has_images = payload
                                    .get("images")
                                    .and_then(|v| v.as_array())
                                    .is_some_and(|images| !images.is_empty());
                                if contains_only_internal_agent_routes(raw_text) && !has_images {
                                    continue;
                                }
                                if skip_duplicate_user_record(
                                    &mut recent_user_records,
                                    UserTurnFingerprint::from_event_message(payload),
                                    parse_codex_timestamp(&value).unwrap_or_else(Utc::now),
                                ) {
                                    continue;
                                }
                                message_count += 1;
                                has_real_user = true;
                                if title.is_none() {
                                    title = extract_codex_title_candidate(&visible_text, true);
                                    if title.is_some() {
                                        title_source_ordinal = Some(record_ordinal);
                                    }
                                }
                            }
                            "agent_message" => {
                                message_count += 1;
                            }
                            "item_completed" => {
                                // A Plan turn publishes its answer here instead of
                                // on `agent_message`, so it counts like one. The
                                // body is remembered so this plan's assistant
                                // `response_item` copy does not count a second time.
                                if let Some(plan) = completed_plan_item_text(payload) {
                                    message_count += 1;
                                    pending_plan_twin = Some(plan.to_string());
                                    plan_counted = true;
                                }
                            }
                            "thread_goal_updated" => {
                                // Capture the first OPENING goal for the fallback,
                                // through the SAME shared mapping the detail parser
                                // uses — so the summary keys off exactly the objective
                                // the detail parser would synthesize from: only a
                                // `create_goal` (an active goal with an objective),
                                // never a `goal:null` clear, a blank objective, or a
                                // terminal-status goal.
                                if goal_objective.is_none() {
                                    if let Some(marker) = payload
                                        .get("goal")
                                        .and_then(crate::acp::codex_goal::goal_marker)
                                    {
                                        if marker.tool_name == "create_goal" {
                                            // Positional, mirroring the detail parser:
                                            // the goal opened the session iff no real
                                            // user turn preceded it. Claim the title
                                            // from the objective HERE, in stream order,
                                            // so a later `user_message` can't steal it
                                            // while a native `thread_name_updated` still
                                            // overrides it.
                                            goal_opens_session = !has_real_user;
                                            if goal_opens_session && title.is_none() {
                                                title = extract_codex_title_candidate(
                                                    &marker.objective,
                                                    true,
                                                );
                                                if title.is_some() {
                                                    title_source_ordinal = Some(record_ordinal);
                                                }
                                            }
                                            goal_objective = Some(marker.objective);
                                            first_goal_ordinal = Some(record_ordinal);
                                        }
                                    }
                                }
                            }
                            "thread_name_updated" => {
                                // Codex native thread name — newest non-empty wins
                                // (parity with the detail parser). Accept both the
                                // rollout `thread_name` and the live `threadName`.
                                if let Some(name) = payload
                                    .get("thread_name")
                                    .or_else(|| payload.get("threadName"))
                                    .or_else(|| payload.get("name"))
                                    .and_then(|n| n.as_str())
                                    .map(str::trim)
                                    .filter(|n| !n.is_empty())
                                {
                                    title = Some(truncate_str(name, 100));
                                    title_from_thread_name = true;
                                }
                            }
                            _ => {}
                        }
                    }
                }
                "response_item" => {
                    if let Some(payload) = value.get("payload") {
                        let payload_type =
                            payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        if payload_type == "message" {
                            let role = payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
                            // The detail parser turns an IMAGE-bearing
                            // `response_item` user into a real user turn
                            // (`extract_response_item_user_image_blocks`) and titles
                            // from that same turn — unconditionally, because the
                            // canonical channel never carries the image. Everything
                            // else goes through the same held-back promotion the
                            // detail parser uses, so the two stay in exact sync on
                            // both the count and the pure-`/goal` fallback.
                            if role == "user" && response_item_user_has_image(payload) {
                                // Same dedup the detail parser applies before
                                // pushing this turn — without it a prompt codex
                                // wrote to BOTH channels counts twice here and
                                // once there.
                                if skip_duplicate_user_record(
                                    &mut recent_user_records,
                                    UserTurnFingerprint::from_response_item(payload),
                                    parse_codex_timestamp(&value).unwrap_or_else(Utc::now),
                                ) {
                                    continue;
                                }
                                message_count += 1;
                                has_real_user = true;
                                if title.is_none() {
                                    title = extract_codex_text_content(payload)
                                        .and_then(|t| extract_codex_title_candidate(&t, false));
                                    if title.is_some() {
                                        title_source_ordinal = Some(record_ordinal);
                                    }
                                }
                            } else if let Some(is_user) = match role {
                                "user" => Some(true),
                                "assistant" => Some(false),
                                _ => None,
                            } {
                                if let Some(blocks) =
                                    extract_response_item_message_blocks(payload, is_user)
                                {
                                    let text = first_text_block(&blocks).unwrap_or_default();

                                    // Plan document, counted outside the promotion
                                    // gate exactly as the detail parser renders it
                                    // outside that gate — once per plan, no matter
                                    // which of its two copies the rollout carries.
                                    // The pairing slot is consumed either way, so
                                    // two plan turns proposing the same body still
                                    // count twice.
                                    if !is_user {
                                        if let Some(body) = proposed_plan_body(&text) {
                                            let is_twin = pending_plan_twin
                                                .take()
                                                .is_some_and(|seen| seen == body);
                                            if !is_twin {
                                                message_count += 1;
                                            }
                                            plan_counted = true;
                                            continue;
                                        }
                                    }

                                    let promotable = if text.trim().is_empty() {
                                        true
                                    } else if is_user {
                                        is_promotable_user_text(&text)
                                    } else {
                                        is_promotable_assistant_text(&text)
                                    };
                                    if promotable {
                                        promotion.push_candidate(record_ordinal, is_user);
                                        pending_promotions.push((
                                            is_user,
                                            is_user
                                                .then(|| {
                                                    extract_codex_title_candidate(&text, true)
                                                })
                                                .flatten(),
                                        ));
                                    }
                                }
                            }
                        }
                    }
                }
                _ => {}
            }
        }

        // Promote the held-back `response_item.message` records — see the twin
        // block in `parse_conversation_detail`, whose `turns.len()` this count
        // has to track.
        let survivors = promotion.resolve();
        let promoted_user_ordinal = promotion.first_surviving_user_ordinal(&survivors);
        message_count += survivors.iter().filter(|keep| **keep).count() as u32;

        if let (Some(goal_ordinal), Some(user_ordinal)) =
            (first_goal_ordinal, promoted_user_ordinal)
        {
            if user_ordinal < goal_ordinal {
                goal_opens_session = false;
            }
        }

        // NOTE: `has_real_user` deliberately is NOT back-filled here. Its only
        // consumer is the in-loop `goal_opens_session = !has_real_user`, whose
        // outcome the ordinal comparison above already corrects; assigning it
        // post-loop would be dead code that reads as if it did something.

        if !title_from_thread_name {
            if let Some(user_ordinal) = promoted_user_ordinal {
                let promoted_title = pending_promotions
                    .into_iter()
                    .zip(&survivors)
                    .find(|((is_user, _), keep)| **keep && *is_user)
                    .and_then(|((_, candidate), _)| candidate);
                if let Some(candidate) = promoted_title {
                    if title.is_none()
                        || title_source_ordinal.is_none_or(|current| user_ordinal < current)
                    {
                        title = Some(candidate);
                    }
                }
            }
        }

        let started_at = match first_timestamp {
            Some(ts) => ts,
            None => return Ok(None),
        };

        // Leading-`/goal` fallback, positional and mirroring the detail parser:
        // when a `/goal` opened the session (before any real user turn), the detail
        // view synthesizes a leading user message from the objective — so count
        // that one turn here, even when a LATER real reply exists, keeping the list
        // entry in sync with the opened conversation. The title was already claimed
        // in-loop (see the goal arm).
        if goal_opens_session {
            message_count += 1;
        }

        let id = conversation_id.unwrap_or_else(|| {
            path.file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string()
        });

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        Ok(Some(ConversationSummary {
            id,
            agent_type: AgentType::Codex,
            folder_path,
            folder_name,
            title,
            started_at,
            ended_at: last_timestamp,
            message_count,
            model,
            git_branch,
            parent_id,
            parent_tool_use_id: None,
            delegation_call_id: None,
        }))
    }
}

pub(crate) fn resolve_codex_home_dir() -> PathBuf {
    resolve_codex_home_dir_from(std::env::var_os("CODEX_HOME"), dirs::home_dir())
}

fn resolve_codex_home_dir_from(
    codex_home_env: Option<std::ffi::OsString>,
    home_dir: Option<PathBuf>,
) -> PathBuf {
    codex_home_env
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home_dir.unwrap_or_default().join(".codex"))
}

impl AgentParser for CodexParser {
    fn list_conversations(&self) -> Result<Vec<ConversationSummary>, ParseError> {
        let mut conversations = Vec::new();

        if !self.base_dir.exists() {
            return Ok(conversations);
        }

        // Apply this outside `summary_cache`: changing only session_index.jsonl
        // must refresh a title even when the rollout itself is unchanged.
        let indexed_titles = self.load_thread_name_index();

        let paths: Vec<PathBuf> = self.rollout_paths().collect();
        let names: Vec<Option<RolloutFileName>> = paths
            .iter()
            .map(|path| RolloutFileName::parse(path))
            .collect();
        // A reverted thread's earlier rollouts stay on disk under its id, but
        // they are prefixes its current one inherits (see `rollout_lines`), not
        // conversations of their own.
        let mut current: HashMap<&str, (&str, &str)> = HashMap::new();
        for name in names.iter().flatten() {
            current
                .entry(name.thread_id)
                .and_modify(|newest| *newest = (*newest).max(name.recency()))
                .or_insert(name.recency());
        }

        for (path, name) in paths.iter().zip(&names) {
            if name.is_some_and(|name| current.get(name.thread_id) != Some(&name.recency())) {
                continue;
            }

            match super::summary_cache::get_or_parse(AgentType::Codex, path, || {
                self.parse_jsonl_summary(path)
            }) {
                Ok(Some(mut summary)) => {
                    if let Some(title) = indexed_titles.get(&summary.id) {
                        summary.title = Some(title.clone());
                    }
                    conversations.push(summary);
                }
                _ => continue,
            }
        }

        conversations.sort_by_key(|b| std::cmp::Reverse(b.started_at));
        Ok(conversations)
    }

    fn get_conversation(&self, conversation_id: &str) -> Result<ConversationDetail, ParseError> {
        if !self.base_dir.exists() {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        }

        // A conversation id is a thread id, read from the rollout the thread
        // currently uses. One that names no rollout's thread — a summary that
        // fell back to its file stem — still finds its file by name.
        let path = self.find_current_rollout(conversation_id).or_else(|| {
            WalkDir::new(&self.base_dir)
                .into_iter()
                .filter_map(|e| e.ok())
                .map(walkdir::DirEntry::into_path)
                .find(|path| {
                    path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                        && path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .contains(conversation_id)
                })
        });
        let Some(path) = path else {
            return Err(ParseError::ConversationNotFound(
                conversation_id.to_string(),
            ));
        };

        let mut detail = self.parse_conversation_detail(&path, conversation_id)?;
        if let Some(title) = self.load_thread_name_index().get(conversation_id) {
            detail.summary.title = Some(title.clone());
        }
        Ok(detail)
    }
}

/// Reuse the rollout filename owner so reverted rollouts count as their thread,
/// not as the new physical rollout id. Keep historical `.json` names readable.
fn session_id_from_rollout_filename(name: &str) -> Option<String> {
    let normalized = name.strip_suffix(".json").map(|stem| format!("{stem}.jsonl"));
    let path = Path::new(normalized.as_deref().unwrap_or(name));
    RolloutFileName::parse(path).map(|name| name.thread_id.to_string())
}

fn parse_codex_json_arg(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let args = payload.get("arguments").or_else(|| payload.get("input"))?;
    if let Some(s) = args.as_str() {
        serde_json::from_str(s).ok()
    } else if args.is_object() || args.is_array() {
        Some(args.clone())
    } else {
        None
    }
}

fn parse_codex_json_output(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let output = payload.get("output")?;
    if let Some(s) = output.as_str() {
        serde_json::from_str(s).ok()
    } else if output.is_object() || output.is_array() {
        Some(output.clone())
    } else {
        None
    }
}

/// A `tools.exec_command()` result the script printed verbatim
/// (`text(JSON.stringify(r))`) — the object form of the very envelope the
/// string path spells out as `Chunk ID: …` / `Wall time: …` / `Output:`.
/// Reduce it to the output it wraps so the card reads like the terminal it is:
/// 9% of code-mode chunks are this shape, and the ones announcing a background
/// session carry an empty `output`, so today those cards show nothing but the
/// envelope. Callers must read whatever they need from the raw text (the
/// session announcement lives in `session_id`) before cleaning.
fn unwrap_exec_chunk_envelope(text: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(text.trim()).ok()?;
    let obj = value.as_object()?;
    // The whole shape, not just `chunk_id`: a command whose own stdout is JSON
    // carrying those two keys would otherwise be truncated to its `output`
    // field, silently dropping the rest. Every envelope in real transcripts
    // carries all four.
    if !ENVELOPE_KEYS.iter().all(|key| obj.contains_key(*key)) {
        return None;
    }
    Some(obj.get("output")?.as_str()?.to_string())
}

/// Keys every `tools.exec_command()` result object carries, in both the
/// `exit_code` (finished) and `session_id` (still running) variants.
const ENVELOPE_KEYS: [&str; 4] = [
    "chunk_id",
    "wall_time_seconds",
    "original_token_count",
    "output",
];

/// The command line and body of a codex exec envelope, or `None` when the text
/// carries neither — i.e. when there is no envelope to strip. Distinct from
/// `clean_codex_exec_output` in exactly one case that matters to a background
/// session: an envelope whose body is empty answers `Some("")` (that poll
/// collected nothing) rather than falling back to the header text.
fn split_codex_exec_output(text: &str) -> Option<String> {
    let mut cmd_line: Option<&str> = None;
    let mut in_output = false;
    let mut output_lines = Vec::new();

    for line in text.lines() {
        if cmd_line.is_none() && line.starts_with("$ ") {
            cmd_line = Some(line);
            continue;
        }
        if line.trim_end() == "Output:" {
            in_output = true;
            continue;
        }
        if in_output {
            output_lines.push(line);
        }
    }

    if cmd_line.is_none() && !in_output {
        return None;
    }

    let mut result = String::new();
    if let Some(cmd) = cmd_line {
        result.push_str(cmd);
    }
    if !output_lines.is_empty() {
        if !result.is_empty() {
            result.push('\n');
        }
        result.push_str(&output_lines.join("\n"));
    }
    Some(result)
}

fn clean_codex_exec_output(text: &str) -> String {
    split_codex_exec_output(text)
        .filter(|cleaned| !cleaned.is_empty())
        .unwrap_or_else(|| text.to_string())
}

/// Strip whichever exec envelope `text` is wrapped in — the object form or the
/// `Chunk ID:` / `Wall time:` / `Output:` header — or `None` when it is wrapped
/// in neither. The header form is only stripped when the FIRST line announces
/// it: an `Output:` line in the middle of a build log is a build log, not an
/// envelope, and stripping on that alone would swallow everything above it.
fn strip_exec_envelope(text: &str) -> Option<String> {
    if let Some(unwrapped) = unwrap_exec_chunk_envelope(text) {
        return Some(unwrapped);
    }
    let first = text.lines().next()?.trim_start().to_ascii_lowercase();
    let announced = ["chunk id:", "wall time", "process ", "script "]
        .iter()
        .any(|prefix| first.starts_with(prefix));
    if !announced {
        return None;
    }
    split_codex_exec_output(text)
}

/// Banner codex puts in front of a script's `text()` stream when it re-rendered
/// the whole stream as one blob instead of passing the parts through.
const TRUNCATION_WARNING: &str = "Warning: truncated output";
const TOTAL_OUTPUT_LINES: &str = "Total output lines: ";

/// The per-`text()` chunks hiding inside a collapsed output blob, or `None` when
/// recovering them is not provable.
///
/// Codex re-renders a long script's whole `text()` stream as ONE chunk behind a
/// `Warning: truncated output (original token count: N)` / `Total output lines:
/// M` banner. The boundaries survive in it — one physical line per `text()` —
/// so the per-call split is still there to be had, and without it a
/// `Promise.all` of four commands shows up as a single card whose body is four
/// lines of raw envelope JSON.
///
/// Recovering it is only sound while all M lines are present: past the cap codex
/// drops whole lines, and it drops them from the MIDDLE, so the survivors'
/// positions stop naming their calls. Measured over the newest 400 rollouts: with
/// every line present, line *i* is call *i* in 36 of 36 checkable cases; with
/// lines dropped, 13 of 57 land on the wrong command. So all three counts have to
/// agree — declared, present, and calls — and every line has to be a complete
/// exec envelope, which is also what tells this blob apart from a single
/// command's stdout that merely got truncated (the far more common banner).
fn uncollapse_truncated_chunks(blob: Option<&TruncatedBlob>, calls: usize) -> Option<Vec<String>> {
    if calls == 0 {
        return None;
    }
    let blob = blob?;
    if blob.body.len() != blob.declared || blob.declared != calls {
        return None;
    }
    blob.body
        .iter()
        .all(|line| unwrap_exec_chunk_envelope(line).is_some())
        .then(|| blob.body.iter().map(|line| line.to_string()).collect())
}

/// The line count a collapsed blob declares, and the lines it actually kept.
///
/// Reading it costs a pass over the whole blob, and three of the paths below
/// want it, so `unwrap_code_mode_script` reads it once and hands it down.
struct TruncatedBlob<'a> {
    declared: usize,
    body: Vec<&'a str>,
}

impl TruncatedBlob<'_> {
    /// Codex dropped lines from the middle to fit the cap.
    fn truncated(&self) -> bool {
        self.declared > self.body.len()
    }
}

fn truncated_blob(parsed: &CodeModeOutput) -> Option<TruncatedBlob<'_>> {
    let [collapsed] = parsed.chunks.as_slice() else {
        return None;
    };
    let mut lines = collapsed.lines();
    if !lines.next()?.starts_with(TRUNCATION_WARNING) {
        return None;
    }
    let declared: usize = lines
        .next()?
        .strip_prefix(TOTAL_OUTPUT_LINES)?
        .trim()
        .parse()
        .ok()?;
    if !lines.next()?.is_empty() {
        return None;
    }
    Some(TruncatedBlob {
        declared,
        body: lines.collect(),
    })
}

/// One call's share of a collapsed blob that was split on the separator lines
/// the script printed.
struct SeparatorSlot {
    /// The lines this call owns. `None` means it printed nothing between its
    /// separator and the next — which is not the same as having no separator,
    /// hence `placed`.
    text: Option<String>,
    /// Whether a span of the blob could be attributed to this call at all. False
    /// when truncation removed its separator, leaving nothing to cut on.
    placed: bool,
    /// Calls whose separators were truncated away, leaving their output inside
    /// this slot with no boundary to cut on. Empty in the normal case.
    shares_with: Vec<usize>,
}

/// At least this many separators have to be found, so a split rests on at least
/// one proven boundary. One anchor divides nothing — it would hand the whole
/// blob to the first call and leave the rest empty.
const MIN_ANCHORS: usize = 2;

/// The blob split on the separator lines the script printed before each result,
/// or `None` when it cannot be read that way.
///
/// This is the only handle left once codex re-renders a long `text()` stream as
/// one truncated blob: 89% of collapsed blobs are missing lines, so the counts
/// `uncollapse_truncated_chunks` compares never agree. But scripts of this shape
/// label their results — ``text(`===== ${k} =====\n${r.output}`)`` — and the
/// labels come from the same literal table the commands do. So the separator
/// each call printed can be *predicted* from the source and then looked up in
/// the output, which is a far stronger check than counting: a wrong prediction
/// does not match and the split is simply refused.
///
/// Truncation cannot reorder — it only deletes — so lines between two surviving
/// separators belong to the earlier one and nothing else. When the separator
/// *between* them was dropped, the span covers several calls with no way to
/// tell where each begins; that span stays whole, attributed to the call it
/// provably starts with, and the calls sharing it are named in `shares_with`
/// rather than silently given someone else's output.
///
/// One residual, deliberately accepted: a matched line is only *probably* the
/// separator the script printed. A command whose own stdout contains a line
/// identical to another row's separator — printing this very transcript, say —
/// would be cut there, and the tail of its output would be filed under that
/// row. Uniqueness makes this impossible whenever every separator survived (a
/// look-alike would be a second match and reject the candidate), so the risk
/// only exists in the truncated case, and only when the look-alike stands in
/// for a separator that is genuinely gone. Refusing truncated blobs would avoid
/// it at the cost of the case this exists for — 89% of collapsed blobs are
/// missing lines — so the split is kept and the labels are what it rests on.
fn split_by_separators(
    blob: Option<&TruncatedBlob>,
    calls: &[CodeModeCall],
    separators: &[Separator],
) -> Option<Vec<SeparatorSlot>> {
    if calls.len() < 2 || separators.is_empty() {
        return None;
    }
    let body = &blob?.body;

    let labels: Option<Vec<&str>> = calls.iter().map(|c| c.label.as_deref()).collect();
    let by_index = |offset: usize| (0..calls.len()).map(|i| (i + offset).to_string()).collect();
    // `---RESULT ${i+1}---` is as common as a label in this corpus, and costs
    // nothing to try: the output either contains the line or it does not.
    let candidates: Vec<Vec<String>> = labels
        .map(|names| names.iter().map(|n| n.to_string()).collect())
        .into_iter()
        .chain([by_index(0), by_index(1)])
        .collect();

    let index = index_body_lines(body);
    let mut best: Option<Vec<Option<usize>>> = None;
    for separator in separators {
        for values in &candidates {
            let Some(found) = locate_anchors(&index, separator, values) else {
                continue;
            };
            let hits = found.iter().flatten().count();
            if hits < MIN_ANCHORS {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|b| hits > b.iter().flatten().count())
            {
                best = Some(found);
            }
        }
    }

    Some(slots_from_anchors(body, &best?))
}

/// Every line of the blob, trimmed of trailing whitespace, mapped to where it
/// sits — or to `None` when it occurs more than once.
///
/// Built once and read by every candidate, which is what keeps the split from
/// costing a pass over the blob per command: a run of separators is looked up,
/// not searched for.
fn index_body_lines<'a>(body: &[&'a str]) -> HashMap<&'a str, Option<usize>> {
    let mut index = HashMap::with_capacity(body.len());
    for (at, line) in body.iter().enumerate() {
        index
            .entry(line.trim_end())
            .and_modify(|seen| *seen = None)
            .or_insert(Some(at));
    }
    index
}

/// Where each value's separator line sits in the blob, or `None` for the ones
/// truncation removed. Refuses the whole candidate when a line repeats or the
/// lines run backwards — either means the match is not the separator run.
fn locate_anchors(
    index: &HashMap<&str, Option<usize>>,
    separator: &Separator,
    values: &[String],
) -> Option<Vec<Option<usize>>> {
    let mut found = Vec::with_capacity(values.len());
    let mut previous = None;

    for value in values {
        let anchor = separator.anchor(value);
        let hit = match index.get(anchor.trim_end()) {
            // The line occurs twice, so it is not a boundary to cut on. Only a
            // line some value actually predicts can refuse a candidate; an
            // ordinary output line repeating is nobody's separator.
            Some(None) => return None,
            Some(Some(at)) => Some(*at),
            None => None,
        };
        if let Some(at) = hit {
            if previous.is_some_and(|before| at <= before) {
                return None;
            }
            previous = Some(at);
        }
        found.push(hit);
    }

    Some(found)
}

fn slots_from_anchors(body: &[&str], found: &[Option<usize>]) -> Vec<SeparatorSlot> {
    // A call whose separator survived owns the lines after it. The first call
    // owns the head of the blob even without one: deletion never moves a line,
    // so nothing can precede the first call's output.
    let mut owners: Vec<(usize, Option<usize>)> = Vec::new();
    if found.first().is_some_and(Option::is_none) {
        owners.push((0, None));
    }
    owners.extend(
        found
            .iter()
            .enumerate()
            .filter_map(|(call, at)| at.map(|at| (call, Some(at)))),
    );

    let mut slots: Vec<SeparatorSlot> = (0..found.len())
        .map(|_| SeparatorSlot {
            text: None,
            placed: false,
            shares_with: Vec::new(),
        })
        .collect();

    for (position, (call, anchor)) in owners.iter().enumerate() {
        let start = anchor.map_or(0, |at| at + 1);
        let (end, next_call) = match owners.get(position + 1) {
            // The next owner's separator line is not part of this slot.
            Some((next_call, Some(at))) => (*at, *next_call),
            _ => (body.len(), found.len()),
        };
        let mut text = body.get(start..end).unwrap_or_default().join("\n");
        let kept = text.trim_end().len();
        text.truncate(kept);
        slots[*call] = SeparatorSlot {
            text: (!text.is_empty()).then_some(text),
            placed: true,
            shares_with: (call + 1..next_call).collect(),
        };
    }

    slots
}

/// `text` trimmed with every run of digits collapsed to `#`, so `---RESULT 1---`
/// and `---RESULT 2---` compare equal while `--- dto diff ---` and
/// `--- handler diff ---` do not.
fn digit_blind(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut digits = false;
    for ch in text.trim().chars() {
        if ch.is_ascii_digit() {
            if !digits {
                out.push('#');
                digits = true;
            }
        } else {
            digits = false;
            out.push(ch);
        }
    }
    out
}

/// How many `text()` chunks each call contributed — 1 for the plain
/// `results.forEach(r => text(r.output))` shape — or `None` when the chunks do
/// not provably divide into one group per call.
///
/// Scripts routinely print more than one chunk per call: a `---RESULT n---`
/// header before the output, an `exit_code=0` after it. 268 of the 1297
/// multi-call scripts that fail the 1:1 count in the newest 400 rollouts are
/// exactly this, and they render as one undecomposable script card today.
///
/// The count alone proves nothing — a script that prints every output first and
/// every exit code after hands over the same chunks in the wrong order, and
/// slicing those into pairs would pin each command's output to the previous
/// command's card. The proof is `text_run` (see `CodeModeScript`): exactly
/// `stride` `text()` calls with no loop between the first and the last, so that
/// run emitted its chunks together, `calls` times over. A repeating slot is kept
/// as corroboration — it is only evidence, since a command's own stdout can be
/// `exit_code=0` — and costs 13 of 256 candidates, which stay script cards.
///
/// Measured with commands whose output names its own call (`nl -ba F | sed -n
/// 'A,Bp'` must start at line A): 152 of 153 groups land on the right command,
/// and the one exception is the check's own blind spot — that `nl` failed and
/// printed a usage error, so there was no line number to match.
fn call_chunk_stride(chunks: &[String], calls: usize, text_run: Option<usize>) -> Option<usize> {
    if calls == 0 || chunks.is_empty() || !chunks.len().is_multiple_of(calls) {
        return None;
    }
    let stride = chunks.len() / calls;
    if stride == 1 {
        return Some(1);
    }
    if text_run != Some(stride) {
        return None;
    }
    (0..stride)
        .any(|slot| {
            let marker = digit_blind(&chunks[slot]);
            !marker.is_empty()
                && (1..calls).all(|index| digit_blind(&chunks[index * stride + slot]) == marker)
        })
        .then_some(stride)
}

/// Turn one code-mode script + its output envelope into the tool blocks the
/// pre-code-mode history path produced.
///
/// Returns `(replacement tool_use blocks, tool_result blocks)`. The first is
/// `None` when the script could not be decomposed — the placeholder script card
/// stays and simply receives the whole output.
///
/// Splitting per call needs the chunks to divide into one group per call, in
/// order — see `call_chunk_stride` for what counts as proof. Anything less falls
/// back to the script card rather than misattributing output, including the
/// collapsed blob codex renders in place of the chunks when the stream is long,
/// unless `uncollapse_truncated_chunks` can prove the chunks back out of it.
fn unwrap_code_mode_script(
    call_id: &str,
    script: &CodeModeScript,
    parsed: &CodeModeOutput,
    payload: &serde_json::Value,
    sessions: &mut HashMap<String, ShellSession>,
    poll_origins: &mut HashMap<String, String>,
) -> (Option<Vec<ContentBlock>>, Vec<ContentBlock>) {
    let calls = script.calls.as_deref().unwrap_or_default();

    let result_block = |tool_use_id: Option<String>, text: Option<String>, note: Option<&str>| {
        let output_preview = with_note(text, note);
        let is_error = parsed.is_error()
            || infer_tool_call_output_is_error(payload, None, output_preview.as_deref());
        ContentBlock::ToolResult {
            tool_use_id,
            output_preview,
            is_error,
            agent_stats: None,
            images: Vec::new(),
        }
    };

    let non_empty = |text: String| {
        if text.is_empty() {
            None
        } else {
            Some(text)
        }
    };

    // NB: the envelope note (`Script running with cell ID N`) is deliberately
    // NOT registered as a shell session here. That cell is the SCRIPT — it has
    // not finished — so the `wait` collecting it carries this very script's
    // return value and is folded back onto these cards by the caller
    // (`DeferredScript`), never rendered as a session of its own.

    // A collapsed blob stands in for the chunks it was rendered from, when the
    // counts prove which is which. Nothing changes when it does not: the
    // fallback is `parsed.chunks` itself, banner and all.
    // Every path that reads it bails on the call count first, so a script that
    // recovered nothing does not pay to have its blob split into lines.
    let blob = (!calls.is_empty())
        .then(|| truncated_blob(parsed))
        .flatten();
    let uncollapsed = uncollapse_truncated_chunks(blob.as_ref(), calls.len());
    let chunks: &[String] = uncollapsed.as_deref().unwrap_or(&parsed.chunks);

    if calls.len() == 1 {
        let call = &calls[0];
        let joined = chunks.join("\n");
        let uses = vec![ContentBlock::ToolUse {
            tool_use_id: Some(call_id.to_string()),
            tool_name: call.tool_name.clone(),
            input_preview: Some(shell_session_input_preview(
                call,
                call_id,
                sessions,
                poll_origins,
            )),
            status: None,
            meta: codex_script_meta(call.label.as_deref(), false, &[], false),
        }];
        register_shell_sessions(call, call_id, &joined, sessions);
        let results = vec![result_block(
            Some(call_id.to_string()),
            non_empty(exec_chunk_display(call, joined)),
            parsed.note.as_deref(),
        )];
        return (Some(uses), results);
    }

    if let Some(stride) = (calls.len() > 1)
        .then(|| call_chunk_stride(chunks, calls.len(), script.text_run))
        .flatten()
    {
        let last = calls.len() - 1;
        let mut uses = Vec::with_capacity(calls.len());
        let mut results = Vec::with_capacity(calls.len());
        for (index, call) in calls.iter().enumerate() {
            let id = format!("{call_id}#{index}");
            let note = if index == last {
                parsed.note.as_deref()
            } else {
                None
            };
            let group = &chunks[index * stride..(index + 1) * stride];
            uses.push(ContentBlock::ToolUse {
                tool_use_id: Some(id.clone()),
                tool_name: call.tool_name.clone(),
                input_preview: Some(shell_session_input_preview(
                    call,
                    &id,
                    sessions,
                    poll_origins,
                )),
                status: None,
                meta: codex_script_meta(call.label.as_deref(), false, &[], false),
            });
            // Announcements are read from the chunks as written: unwrapping an
            // envelope drops the `session_id` that names the session.
            register_shell_sessions(call, &id, &group.join("\n"), sessions);
            let shown = group
                .iter()
                .map(|chunk| exec_chunk_display(call, chunk.clone()))
                .collect::<Vec<_>>()
                .join("\n");
            results.push(result_block(Some(id), non_empty(shown), note));
        }
        return (Some(uses), results);
    }

    // The chunks did not divide, but the script may have labelled its results
    // on their way out. Only reachable for a collapsed blob — anything with real
    // chunks was already handled above.
    if let Some(slots) = split_by_separators(blob.as_ref(), calls, &script.separators) {
        let truncated = blob.as_ref().is_some_and(TruncatedBlob::truncated);
        let last = calls.len() - 1;
        let mut uses = Vec::with_capacity(calls.len());
        let mut results = Vec::with_capacity(calls.len());
        for (index, (call, slot)) in calls.iter().zip(&slots).enumerate() {
            let id = format!("{call_id}#{index}");
            let note = if index == last {
                parsed.note.as_deref()
            } else {
                None
            };
            let shared: Vec<String> = slot
                .shares_with
                .iter()
                .filter_map(|other| calls.get(*other))
                .map(call_display_name)
                .collect();
            uses.push(ContentBlock::ToolUse {
                tool_use_id: Some(id.clone()),
                tool_name: call.tool_name.clone(),
                input_preview: Some(shell_session_input_preview(
                    call,
                    &id,
                    sessions,
                    poll_origins,
                )),
                status: None,
                meta: codex_script_meta(
                    call.label.as_deref(),
                    // A command that ran and printed nothing is not a command
                    // whose output went missing; only the second is worth a
                    // notice, and saying it of the first would be false.
                    !slot.placed,
                    &shared,
                    truncated,
                ),
            });
            if let Some(text) = &slot.text {
                register_shell_sessions(call, &id, text, sessions);
            }
            let shown = slot
                .text
                .clone()
                .and_then(|text| non_empty(exec_chunk_display(call, text)));
            results.push(result_block(Some(id), shown, note));
        }
        return (Some(uses), results);
    }

    // Undecomposable script: the card stays a script card, and no session it
    // announced is attributed. There is no way to tell which of its calls
    // started one — that is exactly why it did not decompose.
    let joined = chunks.join("\n");
    (
        None,
        vec![result_block(
            Some(call_id.to_string()),
            non_empty(joined),
            parsed.note.as_deref(),
        )],
    )
}

#[derive(Debug)]
struct CompletedMcpCall {
    id: String,
    server: String,
    tool: String,
    input_preview: Option<String>,
    output_preview: Option<String>,
    is_error: bool,
}

/// How much of a serialized MCP result stands in for a call that answered in
/// blocks with no text of its own. Matches `pi`'s cap on the same shape: enough
/// to show what came back, not enough for a base64 blob to swamp the card.
const MCP_RESULT_FALLBACK_CAP: usize = 4000;

/// A sink that accepts `budget` bytes and then refuses, so a serializer writing
/// into it stops instead of running to the end of its input.
struct BudgetedSink {
    buf: Vec<u8>,
    budget: usize,
}

impl std::io::Write for BudgetedSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        let room = self.budget.saturating_sub(self.buf.len());
        if room == 0 {
            return Err(std::io::Error::other("preview budget reached"));
        }
        let take = room.min(data.len());
        self.buf.extend_from_slice(&data[..take]);
        Ok(take)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// `value` serialized into a `max_chars` preview without ever building an
/// UNBOUNDED serialization. A value that fits is still written out whole —
/// into a buffer that cannot grow past the budget.
///
/// `serde_json::to_string` materializes all of it first — for an image-only
/// MCP result that is the entire base64 blob, allocated and then walked twice
/// more by `truncate_str`, to keep a few thousand characters of it. This
/// produces exactly the same string while the buffer stays at
/// `4 * max_chars + 1` bytes. UTF-8 spends at most 4 bytes per character, so
/// that many always cover `max_chars` of them — and the `+ 1` is what makes it
/// STRICTLY more, which is the whole proof: a full buffer therefore always
/// decodes to more than `max_chars` characters, so it is always truncated, so
/// the partial character a byte cut leaves behind is always among the ones
/// dropped. At `4 * max_chars` alone the strictness would rest on JSON always
/// opening with an ASCII byte and so never letting a full buffer land on
/// exactly `max_chars` — which holds for every `max_chars` but zero, and even
/// then is a fact about the format rather than about this function. The `+ 1`
/// is what makes it a property of the arithmetic.
///
/// What it bounds is the MEMORY, which is the part that can fail. Time is only
/// mostly bounded: `serde_json` walks a string looking for escapes before
/// offering any of it to the writer, so one oversized string is still read
/// through once — a pass over bytes already resident, not a second copy of
/// them. Stopping even that would mean replacing the serializer.
///
/// `None` for a value that serializes to nothing at all.
fn serialize_preview(value: &serde_json::Value, max_chars: usize) -> Option<String> {
    let mut sink = BudgetedSink {
        buf: Vec::new(),
        budget: max_chars.saturating_mul(4).saturating_add(1),
    };
    // A value that fits reports `Ok`; one that does not aborts with the sink's
    // own error. Both leave `buf` holding the prefix, and `serde_json` cannot
    // fail on a `Value` for any other reason.
    let _ = serde_json::to_writer(&mut sink, value);
    let text = String::from_utf8_lossy(&sink.buf);
    (!text.is_empty()).then(|| truncate_str(&text, max_chars))
}

fn completed_mcp_call(payload: &serde_json::Value) -> Option<CompletedMcpCall> {
    let item = payload.get("item")?;
    if item.get("type").and_then(|v| v.as_str()) != Some("McpToolCall") {
        return None;
    }
    let result = item.get("result").filter(|value| !value.is_null());
    let stated_error = item.get("error").filter(|value| is_stated_error(value));
    // Text first, then the structured twin. The last two are for the shapes
    // that carry neither — a transport failure that answered with `error` and
    // no result, or a `content` array holding only blocks this reader cannot
    // render (an image, a resource). The semantic path DISCARDS the wrapper's
    // own printed output, so a `None` here is not a quiet degradation, it is a
    // card that says nothing at all where the script card used to show the
    // run's text.
    //
    // Only the LAST one is truncated, and only for what the card SHOWS — it is
    // the shape that can be a base64 blob, and a card must not be flooded with
    // one. Nothing may decide an OUTCOME from a cut string: the heuristic below
    // re-parses a preview that opens with `{` or `[` and looks for a failed
    // `status` inside it (`infer_output_text_is_error`), and truncating valid
    // JSON makes that parse fail silently, settling a call that reported
    // failure GREEN. So the cut branch also hands back the value it cut, and
    // the outcome is read from that instead.
    let output_preview = result
        .and_then(|result| result.get("content"))
        .and_then(crate::parsers::pi::tool_result_content_text)
        .or_else(|| {
            result
                .and_then(|result| result.get("structuredContent"))
                .and_then(|value| serde_json::to_string(value).ok())
        })
        .or_else(|| value_to_preview(stated_error));
    // `content` rather than the whole envelope. A call that returned NOTHING
    // still says nothing — `{"content":[]}` is not worth rendering.
    let blocks = output_preview
        .is_none()
        .then(|| result?.get("content"))
        .flatten()
        .filter(|content| content.as_array().is_some_and(|blocks| !blocks.is_empty()));
    let output_preview = output_preview
        .or_else(|| blocks.and_then(|content| serialize_preview(content, MCP_RESULT_FALLBACK_CAP)));
    // The record STATES its outcome — `result.isError`, the item's own terminal
    // `status`, and an `error` when the call never reached the server. Believe
    // them. `infer_tool_call_output_is_error` reads tea leaves out of the
    // output text because a script card has no such field; run against an
    // authoritative record it can only invent failures, and a tool that
    // legitimately PRINTS `exit code: 1` or answers with a line opening
    // `Error:` returned perfectly well. Kept as the fallback for a record that
    // states nothing. Stated failure outranks stated success, so a record
    // contradicting itself settles as the error it reported.
    let stated_is_error = result
        .and_then(|result| result.get("isError"))
        .and_then(serde_json::Value::as_bool);
    let claimed_failed =
        stated_is_error == Some(true)
            || stated_error.is_some()
            || item
                .get("status")
                .and_then(serde_json::Value::as_str)
                .is_some_and(is_failed_status);
    let claimed_ok = stated_is_error == Some(false)
        || item.get("status").and_then(serde_json::Value::as_str) == Some("completed");
    Some(CompletedMcpCall {
        id: item.get("id")?.as_str()?.to_string(),
        server: item.get("server")?.as_str()?.to_string(),
        tool: item.get("tool")?.as_str()?.to_string(),
        input_preview: value_to_preview(item.get("arguments")),
        is_error: claimed_failed
            || (!claimed_ok
                && (infer_tool_call_output_is_error(item, result, output_preview.as_deref())
                    || blocks_report_failure(blocks))),
        output_preview,
    })
}

/// Whether any block in a result's `content` array REPORTS a failure.
///
/// The blocks are what the preview above was cut out of, and the cut string
/// no longer re-parses, so the outcome has to be read here or not at all —
/// truncation may cost a card characters, never a call its verdict.
///
/// A block's own report, deliberately, and no descent. A full
/// `infer_output_value_is_error` walk follows `data`, which in a tool-output
/// envelope is a nested result but on an MCP block is the PAYLOAD — the base64
/// the cap above refuses to copy, and which `infer_output_text_is_error` would
/// lowercase into a second copy of itself anyway. A payload that happens to
/// read like an error is still just bytes. Depth 4 is how that is said to a
/// walker whose own limit is 4: it reads the outcome fields it recognizes and
/// then every descent refuses. Only OBJECT blocks are asked, because only they
/// can carry such a field — MCP `content` holds typed blocks, and a bare
/// string among them is not a shape this can read a verdict out of.
///
/// Still not free in the worst case: a recognized field can itself be huge
/// (`{"stderr": "<megabytes of spaces>"}` costs a `trim`). That is a pass over
/// one already-resident string, not a copy of it, and unlike `data` it is a
/// field a block would have to have gone out of its way to carry.
fn blocks_report_failure(blocks: Option<&serde_json::Value>) -> bool {
    blocks
        .and_then(serde_json::Value::as_array)
        .is_some_and(|blocks| {
            blocks
                .iter()
                .filter(|block| block.is_object())
                .any(|block| infer_output_value_is_error(block, 4))
        })
}

fn unwrap_completed_mcp_calls(
    script: &CodeModeScript,
    completed: Vec<CompletedMcpCall>,
) -> Option<(Vec<ContentBlock>, Vec<ContentBlock>)> {
    if script.tool_names.len() != completed.len() || script.tool_names.is_empty() {
        return None;
    }
    let names_match = script
        .tool_names
        .iter()
        .zip(&completed)
        .all(|(tool_name, item)| {
            let server = item.server.replace('-', "_");
            tool_name == &format!("mcp__{server}__{}", item.tool)
        });
    if !names_match {
        return None;
    }
    let mut uses = Vec::with_capacity(completed.len());
    let mut results = Vec::with_capacity(completed.len());
    for (index, item) in completed.into_iter().enumerate() {
        uses.push(ContentBlock::ToolUse {
            tool_use_id: Some(item.id.clone()),
            tool_name: script.tool_names[index].clone(),
            input_preview: item.input_preview,
            // Read off the item's OWN outcome, never hardcoded: a code-mode
            // script whose MCP call failed still prints `Script completed`
            // (measured: a `delegate_to_agent` refused for `depth_limit`
            // settles the script fine), so claiming `completed` here would
            // contradict the very result block written next to it. This is a
            // per-call terminal record — not `ScriptStatus`, which
            // `ContentBlock::ToolUse::status` documents as unsafe to copy.
            status: Some(if item.is_error { "failed" } else { "completed" }.into()),
            meta: None,
        });
        results.push(ContentBlock::ToolResult {
            tool_use_id: Some(item.id),
            output_preview: item.output_preview,
            is_error: item.is_error,
            agent_stats: None,
            images: Vec::new(),
        });
    }
    Some((uses, results))
}

/// What the renderer needs to know about a call recovered from a code-mode
/// script, as facts rather than prose: the backend states them, the frontend
/// words them in the reader's language.
fn codex_script_meta(
    label: Option<&str>,
    output_missing: bool,
    shares_with: &[String],
    truncated: bool,
) -> Option<serde_json::Value> {
    let mut marks = serde_json::Map::new();
    if let Some(label) = label {
        marks.insert("label".to_string(), label.into());
    }
    if output_missing {
        marks.insert("outputMissing".to_string(), true.into());
    }
    if !shares_with.is_empty() {
        marks.insert("sharedWith".to_string(), shares_with.into());
    }
    if truncated {
        marks.insert("truncated".to_string(), true.into());
    }
    (!marks.is_empty()).then(|| serde_json::json!({ "codeg.codexScript": marks }))
}

/// How to name a call when telling the reader whose output shares a card.
fn call_display_name(call: &CodeModeCall) -> String {
    call.label.clone().unwrap_or_else(|| {
        truncate_str(
            call.input_preview.lines().next().unwrap_or_default().trim(),
            60,
        )
    })
}

/// A code-mode script whose output was `Script running with cell ID N`: the
/// script itself has not finished. Remembers where its cards were written so
/// the `wait` that collects cell N — its real return value, arriving any number
/// of turns later — can be folded back onto them instead of rendering as a
/// separate card. Indices are stable because the parse loop only appends.
#[derive(Clone)]
struct DeferredScript {
    call_id: String,
    /// Index of the message holding the script's ToolUse block(s).
    use_index: usize,
    /// Index of the message holding its ToolResult block(s).
    result_index: usize,
    script: CodeModeScript,
    /// Everything the script has printed so far. A `wait` answers with what has
    /// been printed SINCE — measured on real transcripts, the collected answer
    /// shares nothing with the one that parked the script — so the chunks have
    /// to be accumulated and re-decomposed as one sequence. Replacing the cards
    /// from the `wait` alone would drop whatever the script had already printed,
    /// and would decompose against a chunk count that is missing its front.
    chunks: Vec<String>,
}

/// codex's unified-exec session tools. Neither carries a command of its own:
/// both address a background shell started by an earlier `exec_command`, by the
/// id that command's output announced (`wait` calls it `cell_id`,
/// `write_stdin` calls it `session_id`).
const SHELL_SESSION_TOOLS: [&str; 2] = ["wait", "write_stdin"];

/// Key added to a `wait` / `write_stdin` `input_preview` carrying the command
/// that started the session it addresses.
///
/// Deliberately NOT `command`: `inferFromInput` (`tool-call-normalization.ts`)
/// classifies any live input carrying `command`/`cmd`/… as a terminal call, so
/// that spelling would hijack the live classification of these tools.
const SESSION_COMMAND_KEY: &str = "session_command";

/// A background shell an `exec_command` left running: unified-exec answers that
/// command with whatever it printed so far plus `Process running with session
/// ID N`, and the rest of the output has to be collected by later `wait` /
/// `write_stdin` calls addressing N.
#[derive(Clone)]
struct ShellSession {
    /// The command that started it. Titles the calls that address it.
    command: String,
    /// `tool_use_id` of the card holding that command's output, while more of
    /// it may still be appended there. `None` once the session got a card of
    /// its own (keystrokes, termination): output arriving after that card
    /// belongs below it, not folded back above it.
    origin: Option<String>,
}

fn is_shell_session_tool(tool_name: &str) -> bool {
    SHELL_SESSION_TOOLS.contains(&tool_name)
}

/// The text a recovered call's card shows. Only the exec family answers with
/// the chunk envelope, and only there is unwrapping it provably right — another
/// tool returning an object that happens to carry `chunk_id` would be showing
/// its own result, not a terminal's.
fn exec_chunk_display(call: &CodeModeCall, chunk: String) -> String {
    if call.tool_name != "exec_command" && !is_shell_session_tool(&call.tool_name) {
        return chunk;
    }
    strip_exec_envelope(&chunk).unwrap_or(chunk)
}

/// Whether a `wait` / `write_stdin` only collects output — no keystrokes to
/// show, no termination to report. Such a call *is* the earlier command still
/// running, so it gets no card and its output is appended to that command's.
fn is_pure_poll(args: &serde_json::Map<String, serde_json::Value>) -> bool {
    let sends_input = args
        .get("chars")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.is_empty());
    let terminates = args
        .get("terminate")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    !sends_input && !terminates
}

/// The session id a `wait` / `write_stdin` argument object addresses, as a
/// string — `wait` sends `"cell_id":"7106"`, `write_stdin` sends
/// `"session_id":33067`.
fn shell_session_id(args: &serde_json::Map<String, serde_json::Value>) -> Option<String> {
    let value = args.get("cell_id").or_else(|| args.get("session_id"))?;
    match value {
        serde_json::Value::String(s) => Some(s.clone()),
        serde_json::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Annotate a `wait` / `write_stdin` argument JSON with the command that
/// started the session it addresses, so the card can be titled by that command
/// instead of a bare `wait`. Returns `None` when the arguments aren't an
/// object, carry no session id, or the id was never announced — the caller then
/// keeps the arguments untouched rather than inventing a command.
fn annotate_shell_session_args(
    args: &serde_json::Value,
    sessions: &HashMap<String, ShellSession>,
) -> Option<String> {
    let obj = args.as_object()?;
    let session = sessions.get(&shell_session_id(obj)?)?;
    let mut annotated = obj.clone();
    annotated.insert(
        SESSION_COMMAND_KEY.to_string(),
        serde_json::Value::String(session.command.clone()),
    );
    Some(serde_json::Value::Object(annotated).to_string())
}

/// Same annotation for a session tool recovered from a code-mode script, whose
/// `input_preview` is already the argument object's JSON.
fn shell_session_input_preview(
    call: &CodeModeCall,
    tool_use_id: &str,
    sessions: &mut HashMap<String, ShellSession>,
    poll_origins: &mut HashMap<String, String>,
) -> String {
    if !is_shell_session_tool(&call.tool_name) {
        return call.input_preview.clone();
    }
    let args = serde_json::from_str::<serde_json::Value>(&call.input_preview).ok();
    note_shell_session_call(Some(tool_use_id), args.as_ref(), sessions, poll_origins);
    args.and_then(|args| annotate_shell_session_args(&args, sessions))
        .unwrap_or_else(|| call.input_preview.clone())
}

/// Record `session id → command` for every background session this call's
/// output announced. Only `exec_command` starts sessions, and only its own
/// output can name them, so nothing else is registered — a wrong mapping would
/// put someone else's command in a `wait` card's title.
fn register_shell_sessions(
    call: &CodeModeCall,
    origin: &str,
    output: &str,
    sessions: &mut HashMap<String, ShellSession>,
) {
    // `args_inline` is the proof that this command is what actually ran: one
    // call site executes any number of times, and arguments reached through a
    // variable can be reassigned between iterations, leaving the recovered
    // command a guess. Titling — and now folding — a session under a guess is
    // exactly the failure this parser must not have.
    if call.tool_name != "exec_command" || !call.args_inline {
        return;
    }
    // `input_preview` of a recovered `exec_command` is the bare command string.
    register_announced_sessions(&call.input_preview, origin, output, sessions);
}

/// `origin` is the `tool_use_id` of the card this output is being written to —
/// where the session's remaining output gets appended once a later poll
/// collects it.
fn register_announced_sessions(
    command: &str,
    origin: &str,
    output: &str,
    sessions: &mut HashMap<String, ShellSession>,
) {
    if command.trim().is_empty() {
        return;
    }
    let announced = extract_shell_session_ids(output);
    if announced.is_empty() {
        return;
    }
    // The chunk ids of the same output are aliases for the cells it announced —
    // codex addresses them either way. Registered only alongside a real
    // announcement, so a chunk id from a command that already exited stays
    // meaningless.
    for id in announced.into_iter().chain(extract_chunk_ids(output)) {
        sessions.insert(
            id,
            ShellSession {
                command: command.to_string(),
                origin: Some(origin.to_string()),
            },
        );
    }
}

/// Classify a `wait` / `write_stdin` against the session it addresses: either
/// it only collects more of that session's output — in which case it is marked
/// for folding into the card of the command producing it — or it is an action
/// (keystrokes, termination) that earns a card, and everything the session
/// prints from then on belongs below that card rather than folded back above
/// it. Sessions nobody announced fall through both: nothing to fold into.
fn note_shell_session_call(
    tool_use_id: Option<&str>,
    args: Option<&serde_json::Value>,
    sessions: &mut HashMap<String, ShellSession>,
    poll_origins: &mut HashMap<String, String>,
) {
    let Some(args) = args.and_then(|a| a.as_object()) else {
        return;
    };
    let Some(session_id) = shell_session_id(args) else {
        return;
    };
    let Some(origin) = sessions.get(&session_id).and_then(|s| s.origin.clone()) else {
        return;
    };
    if is_pure_poll(args) {
        if let Some(call_id) = tool_use_id {
            poll_origins.insert(call_id.to_string(), origin);
        }
        return;
    }
    // End the folding for every id naming this cell, not just the one this call
    // addressed: the numeric session id and the hex chunk id are aliases, and a
    // poll arriving through the other spelling would otherwise still be folded
    // in above the card that caused it.
    for session in sessions.values_mut() {
        if session.origin.as_deref() == Some(origin.as_str()) {
            session.origin = None;
        }
    }
}

/// Drop every card that only collects more of an earlier command's output,
/// moving what it collected onto that command's card. Runs on the finished
/// message list so a poll codex called directly and one a code-mode script
/// wrote are folded the same way — the script path builds its cards inside
/// `unwrap_code_mode_script`, long after the call itself was read.
fn fold_shell_session_polls(
    messages: &mut Vec<UnifiedMessage>,
    poll_origins: &HashMap<String, String>,
) {
    if poll_origins.is_empty() {
        return;
    }

    // Where every tool block lives, and — in transcript order — the polls to
    // fold. Collected up front: a poll's origin always sits earlier, so folding
    // as we walk would need the map anyway, and both blocks of a poll have to be
    // located before either can be dropped.
    let mut result_at: HashMap<String, (usize, usize)> = HashMap::new();
    let mut use_at: HashMap<String, (usize, usize)> = HashMap::new();
    let mut folds: Vec<(String, String, usize, usize)> = Vec::new();
    for (mi, message) in messages.iter().enumerate() {
        for (bi, block) in message.content.iter().enumerate() {
            match block {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    ..
                } => {
                    use_at.insert(id.clone(), (mi, bi));
                }
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    ..
                } => match poll_origins.get(id) {
                    Some(origin) => folds.push((id.clone(), origin.clone(), mi, bi)),
                    None => {
                        result_at.insert(id.clone(), (mi, bi));
                    }
                },
                _ => {}
            }
        }
    }

    let mut drop_at: Vec<(usize, usize)> = Vec::new();
    for (poll_id, origin, mi, bi) in folds {
        // No origin block left — a code-mode script re-decomposed under it, say.
        // Leave the poll's own card alone rather than dropping what it collected.
        let Some(&(omi, obi)) = result_at.get(&origin) else {
            continue;
        };
        let ContentBlock::ToolResult {
            output_preview,
            is_error,
            ..
        } = &messages[mi].content[bi]
        else {
            continue;
        };
        let collected = output_preview.clone().unwrap_or_default();
        let collected = collected.trim_end().to_string();
        let collected_error = *is_error;

        let ContentBlock::ToolResult {
            output_preview,
            is_error,
            ..
        } = &mut messages[omi].content[obi]
        else {
            continue;
        };
        if !collected.is_empty() {
            match output_preview {
                Some(existing) if !existing.trim().is_empty() => {
                    while existing.ends_with('\n') {
                        existing.pop();
                    }
                    existing.push('\n');
                    existing.push_str(&collected);
                }
                _ => *output_preview = Some(collected),
            }
        }
        *is_error = *is_error || collected_error;

        drop_at.push((mi, bi));
        if let Some(&at) = use_at.get(&poll_id) {
            drop_at.push(at);
        }
    }

    if drop_at.is_empty() {
        return;
    }
    let emptied: HashSet<usize> = drop_at.iter().map(|(mi, _)| *mi).collect();
    drop_at.sort_unstable();
    // Two polls sharing a `tool_use_id` would name the same use block twice, and
    // removing a block index twice panics. Ids are unique in practice; a broken
    // transcript must not take the whole conversation down with it.
    drop_at.dedup();
    for (mi, bi) in drop_at.into_iter().rev() {
        messages[mi].content.remove(bi);
    }
    let mut index = 0;
    messages.retain(|m| {
        let keep = !m.content.is_empty() || !emptied.contains(&index);
        index += 1;
        keep
    });
}

fn value_to_preview(value: Option<&serde_json::Value>) -> Option<String> {
    let v = value?;
    if v.is_null() {
        return None;
    }
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    serde_json::to_string(v).ok()
}

fn is_failed_status(status: &str) -> bool {
    let status = status.trim();
    status.eq_ignore_ascii_case("error")
        || status.eq_ignore_ascii_case("failed")
        || status.eq_ignore_ascii_case("failure")
        || status.eq_ignore_ascii_case("cancelled")
        || status.eq_ignore_ascii_case("canceled")
}

fn parse_nonzero_exit_code_from_line(line: &str) -> Option<i64> {
    let trimmed = line.trim();
    let (label, rest) = trimmed.split_once(':')?;
    if !label.trim_end().eq_ignore_ascii_case("exit code") {
        return None;
    }
    let number_text = rest.split_whitespace().next()?;
    let code = number_text.parse::<i64>().ok()?;
    if code == 0 {
        None
    } else {
        Some(code)
    }
}

fn infer_output_text_is_error(text: &str) -> bool {
    for line in text.lines().take(16) {
        if parse_nonzero_exit_code_from_line(line).is_some() {
            return true;
        }
    }

    for line in text.lines().take(32) {
        let lower = line.trim().to_ascii_lowercase();
        let shell_prefix =
            lower.starts_with("bash:") || lower.starts_with("zsh:") || lower.starts_with("sh:");
        if shell_prefix
            && (lower.contains("command not found")
                || lower.contains("no such file or directory")
                || lower.contains("permission denied"))
        {
            return true;
        }
    }

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && serde_json::from_str::<serde_json::Value>(trimmed)
            .ok()
            .map(|v| infer_output_value_is_error(&v, 0))
            .unwrap_or(false)
    {
        return true;
    }

    trimmed
        .get(..6)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("error:"))
}

/// Whether an `error` field STATES an error rather than merely existing.
/// `null`, `false` and a blank string are how a record says "no error", and a
/// reader that took their presence for failure would fail every clean call
/// that carries the key.
fn is_stated_error(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Null | serde_json::Value::Bool(false) => false,
        serde_json::Value::String(text) => !text.trim().is_empty(),
        _ => true,
    }
}

fn infer_output_value_is_error(value: &serde_json::Value, depth: usize) -> bool {
    if depth > 4 {
        return false;
    }

    match value {
        serde_json::Value::Null => false,
        serde_json::Value::Bool(_) | serde_json::Value::Number(_) => false,
        serde_json::Value::String(text) => infer_output_text_is_error(text),
        serde_json::Value::Array(items) => items
            .iter()
            .any(|item| infer_output_value_is_error(item, depth + 1)),
        serde_json::Value::Object(map) => {
            if map
                .get("is_error")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
            {
                return true;
            }

            if map.get("ok").and_then(|v| v.as_bool()) == Some(false)
                || map.get("success").and_then(|v| v.as_bool()) == Some(false)
            {
                return true;
            }

            if let Some(status) = map.get("status").and_then(|v| v.as_str()) {
                if is_failed_status(status) {
                    return true;
                }
            }

            if let Some(exit_code) = map.get("exit_code").and_then(|v| v.as_i64()) {
                if exit_code != 0 {
                    return true;
                }
            }

            if let Some(stderr) = map.get("stderr").and_then(|v| v.as_str()) {
                if !stderr.trim().is_empty() {
                    return true;
                }
            }

            if map.get("error").is_some_and(is_stated_error) {
                return true;
            }

            for key in ["output", "result", "details", "data"] {
                if let Some(child) = map.get(key) {
                    if infer_output_value_is_error(child, depth + 1) {
                        return true;
                    }
                }
            }

            false
        }
    }
}

fn infer_tool_call_output_is_error(
    payload: &serde_json::Value,
    output_value: Option<&serde_json::Value>,
    output_preview: Option<&str>,
) -> bool {
    if payload
        .get("is_error")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return true;
    }

    if let Some(status) = payload.get("status").and_then(|s| s.as_str()) {
        if is_failed_status(status) {
            return true;
        }
    }

    if payload.get("error").is_some_and(is_stated_error) {
        return true;
    }

    if let Some(output) = output_value {
        if infer_output_value_is_error(output, 0) {
            return true;
        }
    }

    output_preview
        .map(infer_output_text_is_error)
        .unwrap_or(false)
}

/// Synthetic rawInput key the live input shaper uses to carry the collab op
/// through to the card (see frontend `collab-tool.ts` `COLLAB_OP_KEY`). Kept in
/// sync here so history `wait_agent` capsules render with an op-aware title.
const COLLAB_OP_KEY: &str = "__codegCollabOp";

/// Whether a collab status string is an error (mirrors the frontend
/// `isErrorCollabStatusKind`: only `errored` / `failed` / `notFound`).
fn is_error_collab_status(status: &str) -> bool {
    matches!(status, "errored" | "failed" | "notFound")
}

/// Prefix of codex's encrypted payload envelope — a Fernet token, whose version
/// byte `0x80` always base64s to `gA`. codex uses it for `reasoning`'s
/// `encrypted_content` and, since 0.147, for the inter-agent `message` a
/// `spawn_agent` / `send_message` carries.
const CODEX_ENCRYPTED_PREFIX: &str = "gAAAAA";

/// Shortest blob worth treating as an envelope: the token's own header (version
/// byte + 8-byte timestamp + 16-byte IV + HMAC) is already well past this, so
/// the bound only rules out a short string that merely starts the same way.
const CODEX_ENCRYPTED_MIN_LEN: usize = 64;

/// Whether a payload is one of codex's opaque encrypted envelopes rather than
/// text a human wrote.
///
/// codex 0.147 encrypts every inter-agent message: what reaches the rollout for
/// a `spawn_agent` is `"gAAAAABqgWsi0g7g…"`, ~500 characters of base64 that only
/// codex can open. Rendering it verbatim is what put a wall of base64 in the
/// sub-agent capsule's title and prompt. There is no plaintext to recover — the
/// capsule simply shows no prompt.
///
/// Deliberately narrow: the exact prefix AND no whitespace AND long enough. A
/// prompt that merely *contains* base64, or discusses one, still renders.
fn is_encrypted_envelope(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with(CODEX_ENCRYPTED_PREFIX)
        && trimmed.len() >= CODEX_ENCRYPTED_MIN_LEN
        && !trimmed.chars().any(char::is_whitespace)
}

/// What an encrypted envelope renders as inside a tool card's argument preview.
const CODEX_ENCRYPTED_PLACEHOLDER: &str = "[encrypted]";

/// Synthetic input key marking a sub-agent capsule as ONLY a launch — the card
/// settles when codex acknowledges the spawn, not when the child finishes (see
/// the frontend `agent-tool-call.tsx`, which turns it into a translated note).
///
/// Only codex 0.147's native team-of-agents needs it. In the older collab flow
/// the spawn capsule really did stand for the sub-agent's run, because a
/// `wait_agent` / `close_agent` capsule carried its result; 0.147 emits neither,
/// so an unmarked "completed" would claim a still-running child had finished.
///
/// Public because the LIVE path writes the same key
/// (`acp/connection.rs::classify_codex_subagent_activity`) — streaming and
/// reload must not disagree about what the card means.
pub const CODEX_SUBAGENT_LAUNCH_KEY: &str = "__codegCodexSubagentLaunch";

/// Whether a `spawn_agent`'s arguments are codex 0.147's native team-of-agents
/// shape: `task_name` and no `agent_type` (which that release removed).
fn is_native_team_spawn(args: Option<&serde_json::Value>) -> bool {
    args.is_some_and(|a| a.get("agent_type").is_none() && a.get("task_name").is_some())
}

/// Synthetic input key naming the sub-agent's TERMINAL state, when codex
/// reported one. Absent while the child is still working (or was never heard
/// from again), which is the state [`CODEX_SUBAGENT_LAUNCH_KEY`] describes.
///
/// Written by both the rollout parser and the live path
/// (`acp/connection.rs`), so a reload cannot disagree with the stream about
/// whether the child finished.
pub const CODEX_SUBAGENT_STATE_KEY: &str = "__codegCodexSubagentState";

/// One `SubAgentActivity` record, normalized across the two on-disk shapes.
///
/// `call_id` is the SPAWN's own `call_id` for a `started` record — the key that
/// ties a child thread back to the capsule that launched it. A terminal record
/// carries a synthetic id of its own (`subagent-completed-<uuid>`) instead, so
/// only `thread_id` correlates there.
struct CodexSubagentActivityRecord<'a> {
    call_id: Option<&'a str>,
    thread_id: &'a str,
    agent_path: Option<&'a str>,
    kind: &'a str,
}

/// Read one `event_msg` payload as a `SubAgentActivity`, whichever shape codex
/// wrote it in.
///
/// TWO shapes are live on disk and neither may be dropped:
///
/// * `event_msg.sub_agent_activity` with flat
///   `{event_id, agent_thread_id, agent_path, kind}` — codex ≤ 0.147.
/// * `event_msg.item_completed.item` with
///   `{type: "SubAgentActivity", id, agent_thread_id, agent_path, kind}` —
///   codex 0.153.4, which retired the flat event entirely (measured on a real
///   0.153.4 parent rollout: flat 0 records, nested 26).
///
/// Reading only the flat one — as this did before — meant every 0.153.4
/// sub-agent capsule reloaded with no `agent_id` at all, so the badge the live
/// stream showed disappeared on refresh and nothing could resolve the child's
/// own rollout. `item.id` is the same spawn `call_id` the flat `event_id`
/// carried, so the two normalize onto one record with no correlation loss.
fn codex_subagent_activity_record<'a>(
    payload_type: &str,
    payload: &'a serde_json::Value,
) -> Option<CodexSubagentActivityRecord<'a>> {
    let source = match payload_type {
        "sub_agent_activity" => payload,
        "item_completed" => {
            let item = payload.get("item")?;
            if item.get("type").and_then(serde_json::Value::as_str) != Some("SubAgentActivity") {
                return None;
            }
            item
        }
        _ => return None,
    };
    let str_field = |key: &str| {
        source
            .get(key)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    Some(CodexSubagentActivityRecord {
        // `event_id` on the flat shape, `id` on the nested item.
        call_id: str_field("event_id").or_else(|| str_field("id")),
        thread_id: str_field("agent_thread_id")?,
        agent_path: str_field("agent_path"),
        kind: str_field("kind").unwrap_or(""),
    })
}

/// The envelope header codex puts on an inter-agent `agent_message`, and the
/// only message type whose payload is readable.
const CODEX_FINAL_ANSWER_HEADER: &str = "Message Type: FINAL_ANSWER";

/// Where the envelope's own preamble ends and the sender's text begins.
const CODEX_INTER_AGENT_PAYLOAD_MARKER: &str = "Payload:\n";

/// A sub-agent's finished report, read off a `response_item.agent_message` in
/// the PARENT's rollout: `(author path, body)`.
///
/// This is the one piece of a codex team-of-agents exchange that is not sealed.
/// Every inter-agent message rides the same envelope, but only the terminal one
/// carries plaintext — measured across every such record on disk for two
/// months: `FINAL_ANSWER` 8/8 plaintext with a body, `MESSAGE` and `NEW_TASK`
/// 0/82 (both are Fernet blobs in a sibling `encrypted_content` part, in the
/// child's own rollout too, so there is nothing to recover for those).
///
/// The header match is anchored at the start of the text rather than a
/// substring search: a sub-agent that merely writes ABOUT the protocol — which
/// one reviewing this repository will — must not have its `MESSAGE` mistaken
/// for a report.
fn codex_inter_agent_final_answer(payload: &serde_json::Value) -> Option<(&str, String)> {
    let author = payload
        .get("author")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    let text: String = payload
        .get("content")?
        .as_array()?
        .iter()
        .filter(|part| part.get("type").and_then(serde_json::Value::as_str) == Some("input_text"))
        .filter_map(|part| part.get("text").and_then(serde_json::Value::as_str))
        .collect();
    if !text.starts_with(CODEX_FINAL_ANSWER_HEADER) {
        return None;
    }
    let body = text
        .split_once(CODEX_INTER_AGENT_PAYLOAD_MARKER)
        .map(|(_, body)| body)?
        .trim();
    (!body.is_empty()).then(|| (author, body.to_string()))
}

/// Replace every encrypted envelope inside a parsed argument tree with
/// [`CODEX_ENCRYPTED_PLACEHOLDER`], returning whether anything was replaced.
///
/// `spawn_agent` is not the only carrier: `send_message` (the collaboration call
/// a parent uses to talk to a running sub-agent, and a sub-agent to answer)
/// takes the same sealed `message`, and it has no capsule of its own — it lands
/// on the generic tool card, whose preview is the whole argument JSON. Without
/// this, that card shows ~500 characters of base64. Nothing is lost by
/// replacing it: only codex can open the envelope.
///
/// Recurses so a nested payload is caught too, and reports whether it changed
/// anything so the caller can leave every other tool's preview byte-identical.
fn redact_encrypted_args(value: &mut serde_json::Value) -> bool {
    match value {
        serde_json::Value::String(s) => {
            if is_encrypted_envelope(s) {
                *s = CODEX_ENCRYPTED_PLACEHOLDER.to_string();
                return true;
            }
            false
        }
        serde_json::Value::Array(items) => redact_encrypted_children(items.iter_mut()),
        serde_json::Value::Object(map) => redact_encrypted_children(map.values_mut()),
        _ => false,
    }
}

/// Redact every child of a container and report whether any of them changed.
///
/// Deliberately a loop and not `Iterator::any`: the return value is a
/// by-product, the traversal is the point, and `any` short-circuits — it would
/// leave every envelope after the first one unredacted.
fn redact_encrypted_children<'a>(
    children: impl Iterator<Item = &'a mut serde_json::Value>,
) -> bool {
    let mut changed = false;
    for child in children {
        changed |= redact_encrypted_args(child);
    }
    changed
}

/// Add `agent_id` — and the child's terminal state, once codex has reported one
/// — to a spawn execution capsule's input JSON (the
/// `{subagent_type,prompt,description}` object), so the card can show the
/// sub-agent UUID and stop claiming the child's fate is unknowable. Tolerates a
/// missing/!object input by starting fresh.
fn inject_agent_id_into_input(
    input: Option<&str>,
    agent_id: &str,
    terminal_kind: Option<&str>,
) -> String {
    let mut obj = input
        .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    obj.insert(
        "agent_id".to_string(),
        serde_json::Value::String(agent_id.to_string()),
    );
    if let Some(kind) = terminal_kind {
        obj.insert(
            CODEX_SUBAGENT_STATE_KEY.to_string(),
            serde_json::Value::String(kind.to_string()),
        );
    }
    serde_json::Value::Object(obj).to_string()
}

/// Pull a single sub-agent's `(status, message)` out of one `wait_agent`
/// `output.status` value, e.g. `{ "completed": "<result>" }`. Generalizes over
/// the terminal key: prefer `completed`, else the first string-valued key, so a
/// future `{ "errored": "<msg>" }` maps to `status="errored"`.
fn extract_wait_agent_status(value: &serde_json::Value) -> (String, Option<String>) {
    if let Some(obj) = value.as_object() {
        if let Some(text) = obj.get("completed").and_then(|v| v.as_str()) {
            return ("completed".to_string(), Some(text.to_string()));
        }
        for (key, val) in obj {
            if let Some(text) = val.as_str() {
                return (key.clone(), Some(text.to_string()));
            }
        }
    } else if let Some(text) = value.as_str() {
        return (text.to_string(), None);
    }
    ("completed".to_string(), None)
}

/// Build a synthesized live-shaped collab `rawInput` JSON (and whether any agent
/// errored) for a history `wait_agent` capsule, from that wait's own
/// `output.status` map `{ agent_id: { <terminal-key>: <text> } }`. The result
/// routes through the same `CollabAgentCard` as the live `wait` capsule (matches
/// the shape `collab-tool.ts` `parseCollabToolInput` expects). Caller guarantees
/// `status` is non-empty.
/// Build the history capsule for codex 0.147's `wait_agent`, whose output is
/// `{"message":"Wait completed.","timed_out":false}` — no per-agent map at all.
///
/// It stays worth showing even though it carries nothing: with the native
/// team-of-agents the spawn capsule settles the instant codex acknowledges the
/// launch, so this wait is the ONLY thing in the timeline that spans the child's
/// actual run. Live already renders it (codex-acp forwards the wait as a
/// `collabAgentToolCall`, unlike the spawn), and the reload must agree — a
/// contentless capsule live and nothing at all on reload is the disagreement
/// this exists to remove. Both sides come out as a bare pill: no agents, no
/// prompt, so `AgentCapsule` renders no body.
///
/// The legacy shape is NOT routed here — it carries per-agent results, and a
/// content-free one there means "timed out with nothing to report", which is
/// noise the caller still drops. `timed_out` (a real bool) is the shape gate:
/// only the native-team output has it, and a timeout is a real outcome, so it
/// flags the capsule as failed.
fn native_team_wait_input(output: &serde_json::Value) -> Option<(String, bool)> {
    let timed_out = output.get("timed_out")?.as_bool()?;
    let input = serde_json::json!({
        "senderThreadId": "",
        "receiverThreadIds": [],
        "agentsStates": {},
        "status": if timed_out { "failed" } else { "completed" },
        COLLAB_OP_KEY: "wait",
    });
    Some((input.to_string(), timed_out))
}

fn build_collab_wait_input(status: &serde_json::Map<String, serde_json::Value>) -> (String, bool) {
    let mut receiver_ids: Vec<serde_json::Value> = Vec::new();
    let mut agents_states = serde_json::Map::new();
    let mut any_error = false;
    for (agent_id, value) in status {
        receiver_ids.push(serde_json::Value::String(agent_id.clone()));
        let (st, msg) = extract_wait_agent_status(value);
        if is_error_collab_status(&st) {
            any_error = true;
        }
        agents_states.insert(
            agent_id.clone(),
            serde_json::json!({
                "status": st,
                "message": msg,
            }),
        );
    }
    let input = serde_json::json!({
        "senderThreadId": "",
        "receiverThreadIds": receiver_ids,
        "agentsStates": serde_json::Value::Object(agents_states),
        "status": if any_error { "failed" } else { "completed" },
        COLLAB_OP_KEY: "wait",
    });
    (input.to_string(), any_error)
}

/// The primary agent's own path in codex's team-of-agents tree. Every other
/// path under it is a sub-agent.
const CODEX_ROOT_AGENT_PATH: &str = "/root";

/// Build a `collab_agent` capsule for `list_agents`, whose output is a roster:
/// `{"agents":[{"agent_name","agent_status"}]}` where `agent_status` is either a
/// bare state string (`"running"`) or the same terminal map a wait returns
/// (`{"completed": "<full report>"}`).
///
/// Worth a capsule of its own because a finished child's ENTIRE report is in
/// there: with the native team-of-agents there is no `close_agent`, and the wait
/// carries only `{"message":"Wait completed.","timed_out":false}`, so a roster
/// taken after a child finished is one of the few places its text survives in a
/// readable form. It rendered as a wall of raw JSON on the generic tool card
/// before this.
///
/// The root row is dropped: codex reports the parent through the same roster,
/// and listing the conversation you are already reading as one of its own
/// sub-agents is noise. `None` when nothing is left to show.
fn build_collab_list_input(output: &serde_json::Value) -> Option<(String, bool)> {
    let mut receiver_ids: Vec<serde_json::Value> = Vec::new();
    let mut agents_states = serde_json::Map::new();
    let mut any_error = false;
    for entry in output.get("agents")?.as_array()? {
        // `continue`, never `?`: the root row is present in every roster, so
        // bailing out on it would drop the whole capsule.
        let Some(name) = entry
            .get("agent_name")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|n| !n.is_empty() && *n != CODEX_ROOT_AGENT_PATH)
        else {
            continue;
        };
        let (st, msg) = match entry.get("agent_status") {
            Some(value) => extract_wait_agent_status(value),
            None => continue,
        };
        if is_error_collab_status(&st) {
            any_error = true;
        }
        receiver_ids.push(serde_json::Value::String(name.to_string()));
        agents_states.insert(
            name.to_string(),
            serde_json::json!({ "status": st, "message": msg }),
        );
    }
    if agents_states.is_empty() {
        return None;
    }
    let input = serde_json::json!({
        "senderThreadId": "",
        "receiverThreadIds": receiver_ids,
        "agentsStates": serde_json::Value::Object(agents_states),
        "status": if any_error { "failed" } else { "completed" },
        COLLAB_OP_KEY: "list",
    });
    Some((input.to_string(), any_error))
}

/// The parent thread id a rollout's `session_meta` payload declares, or `None`
/// for a root session.
///
/// TWO shapes carry it and both are live on disk, so neither branch may be
/// dropped. The structured `source.subagent.thread_spawn.parent_thread_id` is
/// the one every sub-agent rollout has (checked across on-disk rollouts from
/// 0.117 through 0.147); the flat `parent_thread_id` is a later, additive
/// mirror that only some versions write, always alongside the structured form
/// and never on its own. Reading only the flat field — as this did before —
/// therefore misses real sub-agents, which is what let their rollouts list as
/// importable root sessions and let their replayed history be counted as their
/// own (see [`is_forked_thread_header`]).
///
/// A present-but-blank id is treated as absent: it names no parent, and a
/// whitespace `parent_id` would still read as "this is a child" downstream.
fn codex_parent_thread_id(payload: &serde_json::Value) -> Option<String> {
    payload
        .get("parent_thread_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .or_else(|| {
            payload
                .pointer("/source/subagent/thread_spawn/parent_thread_id")
                .and_then(serde_json::Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
        })
        .map(ToOwned::to_owned)
}

/// Whether a transcript's opening record declares it a FORKED thread — codex
/// 0.147's `fork_turns` sub-agent shape, where the child is a rollout of its own
/// and the parent's history is copied into its head.
///
/// That copy is the problem: the parent's own tool calls sit at the top of the
/// child's file, indistinguishable at the record level from the child's, so
/// counting the whole file would credit the child with work the PARENT did. The
/// hand-off that separates them (the addressed inter-agent `agent_message`) is
/// not a reliable boundary either — a parent that already collected an earlier
/// sibling's reply carries one inside the forked prefix too.
///
/// So a forked thread yields no stats at all rather than wrong ones. The capsule
/// still names the sub-agent and badges its thread id (both come from the
/// PARENT's rollout); only the nested tool-call list is absent. The legacy
/// `agent-<id>.jsonl` shape has no such prefix and is unaffected.
///
/// BOTH markers are required, because "is a sub-agent" and "replays the parent"
/// are different things and only the second one may be refused. A parent thread
/// id alone says a thread was spawned by another; `forked_from_id` is codex's
/// own declaration that this rollout was seeded with that thread's history. On
/// disk they split cleanly — of 46 sub-agent rollouts, the 23 carrying
/// `forked_from_id` are exactly the 23 that also replay a second `session_meta`
/// header, and the other 23 are ordinary children whose tool calls are their
/// own. Refusing on the parent id alone silently blanks the capsule for those.
fn is_forked_thread_header(value: &serde_json::Value) -> bool {
    if value.get("type").and_then(|t| t.as_str()) != Some("session_meta") {
        return false;
    }
    let Some(payload) = value.get("payload") else {
        return false;
    };
    codex_parent_thread_id(payload).is_some()
        && payload
            .get("forked_from_id")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| !id.trim().is_empty())
}

fn parse_codex_subagent_stats(
    session_dir: &std::path::Path,
    agent_id: &str,
) -> Option<AgentExecutionStats> {
    if agent_id.len() > 64 || agent_id.contains("..") || agent_id.contains('/') {
        return None;
    }

    // Try exact filename first (e.g., "agent-{agent_id}.jsonl"), then fall
    // back to files whose stem ends with the agent_id. Collect and sort
    // candidates to ensure deterministic selection across platforms.
    let exact_path = session_dir.join(format!("agent-{}.jsonl", agent_id));
    let session_file = if exact_path.is_file() {
        exact_path
    } else {
        let mut candidates: Vec<_> = fs::read_dir(session_dir)
            .ok()?
            .filter_map(|entry| {
                let path = entry.ok()?.path();
                if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    return None;
                }
                let stem = path.file_stem()?.to_string_lossy().into_owned();
                // Match only if the stem ends with the agent_id after a separator
                // (e.g., "session-abc123" matches agent_id "abc123")
                if stem == agent_id
                    || stem
                        .strip_suffix(agent_id)
                        .is_some_and(|prefix| prefix.ends_with('-') || prefix.ends_with('_'))
                {
                    Some(path)
                } else {
                    None
                }
            })
            .collect();
        candidates.sort();
        candidates.into_iter().next()?
    };

    let file = fs::File::open(&session_file).ok()?;
    let reader = BufReader::new(file);

    let mut tool_calls = Vec::new();
    // A code-mode `exec` call expands to one entry per inner `tools.*` call, so
    // the sub-agent stats count real tools instead of a pile of `exec`.
    let mut pending_calls: HashMap<String, Vec<AgentToolCall>> = HashMap::new();
    let mut first_ts: Option<DateTime<Utc>> = None;
    let mut last_ts: Option<DateTime<Utc>> = None;
    let mut checked_header = false;

    for line in reader.lines().map_while(Result::ok) {
        if line.trim().is_empty() {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // The header decides whether this file can be counted at all — see
        // `is_forked_thread_header`. Checked on the first record that parses,
        // and never again.
        if !checked_header {
            checked_header = true;
            if is_forked_thread_header(&value) {
                return None;
            }
        }

        if let Some(ts) = parse_codex_timestamp(&value) {
            if first_ts.is_none() {
                first_ts = Some(ts);
            }
            last_ts = Some(ts);
        }

        if value.get("type").and_then(|t| t.as_str()) != Some("response_item") {
            continue;
        }
        let payload = match value.get("payload") {
            Some(p) => p,
            None => continue,
        };
        let payload_type = payload.get("type").and_then(|t| t.as_str()).unwrap_or("");

        match payload_type {
            "function_call" | "custom_tool_call" => {
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("tool_call_id"))
                    .or_else(|| payload.get("id"))
                    .and_then(|id| id.as_str())
                    .map(|s| s.to_string());
                let tool_name = payload
                    .get("name")
                    .or_else(|| payload.get("tool_name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("unknown")
                    .to_string();

                let entries = if is_code_mode_call(&tool_name) {
                    let source = payload
                        .get("input")
                        .or_else(|| payload.get("arguments"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let script = parse_code_mode_script(source);
                    match script.calls {
                        Some(calls) if !calls.is_empty() => calls
                            .into_iter()
                            .map(|call| AgentToolCall {
                                tool_name: call.tool_name,
                                input_preview: Some(truncate_str(&call.input_preview, 500)),
                                output_preview: None,
                                is_error: false,
                            })
                            .collect(),
                        _ => vec![AgentToolCall {
                            tool_name: CODEX_SCRIPT_TOOL_NAME.to_string(),
                            input_preview: script
                                .summary
                                .or_else(|| Some(source.to_string()))
                                .map(|s| truncate_str(&s, 500)),
                            output_preview: None,
                            is_error: false,
                        }],
                    }
                } else {
                    let input_preview = if tool_name == "exec_command" {
                        parse_codex_json_arg(payload)
                            .and_then(|a| {
                                a.get("cmd").and_then(|v| v.as_str()).map(|s| s.to_string())
                            })
                            .or_else(|| {
                                value_to_preview(
                                    payload.get("arguments").or_else(|| payload.get("input")),
                                )
                            })
                    } else {
                        value_to_preview(payload.get("arguments").or_else(|| payload.get("input")))
                    };

                    vec![AgentToolCall {
                        tool_name,
                        input_preview: input_preview.map(|s| truncate_str(&s, 500)),
                        output_preview: None,
                        is_error: false,
                    }]
                };

                if let Some(id) = call_id {
                    pending_calls.insert(id, entries);
                } else {
                    tool_calls.extend(entries);
                }
            }
            "function_call_output" | "custom_tool_call_output" => {
                let call_id = payload
                    .get("call_id")
                    .or_else(|| payload.get("tool_call_id"))
                    .or_else(|| payload.get("id"))
                    .and_then(|id| id.as_str());

                if let Some(id) = call_id {
                    if let Some(entries) = pending_calls.remove(id) {
                        let output_value = payload.get("output");
                        let envelope = split_code_mode_output(output_value);
                        let per_call = entries.len() > 1 && envelope.chunks.len() == entries.len();
                        let joined = if envelope.status != ScriptStatus::Unknown
                            || output_value.is_some_and(|v| v.is_array())
                        {
                            Some(envelope.joined())
                        } else {
                            value_to_preview(output_value)
                        };

                        for (index, mut tc) in entries.into_iter().enumerate() {
                            let raw_output = if per_call {
                                Some(envelope.chunks[index].clone())
                            } else if index == 0 {
                                joined.clone()
                            } else {
                                None
                            };
                            if tc.tool_name == "exec_command" {
                                tc.output_preview = raw_output
                                    .map(|s| truncate_str(&clean_codex_exec_output(&s), 500));
                            } else {
                                tc.output_preview = raw_output.map(|s| truncate_str(&s, 500));
                            }
                            tc.is_error = envelope.is_error()
                                || infer_tool_call_output_is_error(
                                    payload,
                                    output_value,
                                    tc.output_preview.as_deref(),
                                );
                            tool_calls.push(tc);
                        }
                    }
                }
            }
            _ => {}
        }
    }

    tool_calls.extend(pending_calls.into_values().flatten());

    let total_duration_ms = match (first_ts, last_ts) {
        (Some(f), Some(l)) => {
            let dur = (l - f).num_milliseconds();
            if dur > 0 {
                Some(dur as u64)
            } else {
                None
            }
        }
        _ => None,
    };

    let tool_count = tool_calls.len() as u32;
    Some(AgentExecutionStats {
        agent_type: None,
        status: None,
        total_duration_ms,
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
        // Codex's sub-agent rollout is folded into these stats; there is no
        // separate session for the card to open.
        child_session_id: None,
    })
}

impl CodexParser {
    fn parse_conversation_detail(
        &self,
        path: &Path,
        conversation_id: &str,
    ) -> Result<ConversationDetail, ParseError> {
        let lines = self.rollout_lines(path)?;

        let mut messages = Vec::new();
        let mut cwd: Option<String> = None;
        let mut parent_id: Option<String> = None;
        let mut session_header_seen = false;
        let mut git_branch: Option<String> = None;
        let mut model: Option<String> = None;
        let mut title: Option<String> = None;
        // Objective of the goal run currently open while replaying `/goal`
        // transitions, so a persisted `thread_goal_updated` with `goal: null`
        // closes the run by objective — identical to the live path. See
        // `crate::acp::codex_goal::next_goal_marker`.
        let mut codex_open_goal: Option<String> = None;
        // Objective of the FIRST goal opened, captured for a post-parse fallback:
        // newer codex consumes `/goal <objective>` as a slash command (persists
        // `thread_goal_updated` but no `user_message`), so the typed `/goal …`
        // prompt has no user turn on reload. We surface the objective as the
        // leading user message AFTER the loop — never mid-loop — so the synthetic
        // message can never poison `should_skip_duplicate_user_message` and drop a
        // real same-text user message that arrives later in the file.
        let mut first_goal_objective: Option<String> = None;
        // Whether that first `/goal` OPENED the session — i.e. no real user turn
        // had been recorded when it arrived. This is positional, not "no user turn
        // anywhere": newer codex records the goal first with no `user_message`, so
        // the objective IS the opening prompt and must be surfaced as the leading
        // user turn even when a LATER real reply (e.g. a "确认") exists. Older codex
        // persisted the `/goal` text as the opening `user_message`, which arrives
        // BEFORE the goal — there the flag stays false and nothing is synthesized.
        let mut goal_opens_session = false;
        // Start-of-turn markers, chronological, fed to
        // `backfill_turn_durations` so the first reply of a turn is measured
        // from when codex began working — not from the previous turn's end,
        // which would charge it the user's thinking time.
        //
        // Two lists because the two events are not equally trustworthy.
        // `task_started` fires exactly once per turn. `turn_context` normally
        // follows it within milliseconds, but newer codex re-emits it MID-turn
        // (it carries a `turn_id` and is rewritten when the turn's config
        // changes) — 6 of 495 records across the local rollout corpus. Since a
        // marker only ever moves the boundary forward, a mid-turn one would
        // truncate the reply that follows it and silently drop that slice from
        // the turn's total. So `turn_context` is used only as a fallback, for
        // rollouts old enough to predate `task_started`.
        let mut task_start_markers: Vec<DateTime<Utc>> = Vec::new();
        let mut turn_context_markers: Vec<DateTime<Utc>> = Vec::new();
        let mut context_window_used_tokens: Option<u64> = None;
        let mut context_window_max_tokens: Option<u64> = None;
        let mut latest_total_usage: Option<TurnUsage> = None;
        let mut latest_total_tokens: Option<u64> = None;
        // Cumulative `total_token_usage` as of the previous `token_count`, so
        // each event can be reduced to what its own round-trip added.
        let mut previous_total_usage: Option<TurnUsage> = None;
        // Previous `last_token_usage`, used only by the no-total fallback to
        // recognize a restated event.
        let mut previous_last_usage: Option<TurnUsage> = None;
        // Round-trip spend recorded before any assistant message existed to
        // carry it; flushed onto the first one that appears.
        let mut pending_round_usage: Option<TurnUsage> = None;
        // Everything every round-trip reported, kept independently of which
        // message ended up carrying it — see `reconcile_turn_usage`.
        let mut recorded_round_usage = TurnUsage::default();

        let mut first_timestamp: Option<DateTime<Utc>> = None;
        let mut last_timestamp: Option<DateTime<Utc>> = None;

        // Agent subagent tracking (spawn_agent / wait_agent / close_agent).
        //
        // Capsule model (mirrors the live frontend, see collab-tool.ts):
        //   - spawn_agent → an "Agent" execution capsule (this file + nested
        //     stats from `agent-<id>.jsonl`). Shows the task + process; it does
        //     NOT carry the final result text (that lives in the wait capsule).
        //   - wait_agent  → a synthesized `collab_agent` capsule per wait, built
        //     from THAT wait's own `output.status` (the agents it returned). The
        //     full result text is shown here, via the same `CollabAgentCard` the
        //     live `wait` capsule uses. codex returns each agent's result in
        //     exactly one wait, so wait capsules never overlap.
        //   - close_agent → folded into the execution capsule (no own capsule);
        //     its result is only a fallback for agents never waited on.
        // codex-acp 1.0.1 (#223) maps `collabAgentToolCall` onto live ACP
        // `tool_call`s; 1.1.3+ (#304) additionally emits `subAgentActivity` as a
        // SEPARATE live `tool_call` (`_meta.codex.subagent`), but codeg
        // suppresses it (redundant with the collab capsule — see
        // `is_codex_subagent_activity`) and it carries no transcript content, so
        // the nested `agent-<id>.jsonl` stats still only exist on history reload.
        // Live and reconstructed capsules never double-render (live during
        // streaming, this on reload).
        let mut spawn_agent_call_ids: HashSet<String> = HashSet::new();
        let mut agent_id_to_spawn_call_id: HashMap<String, String> = HashMap::new();
        // `agent_path` ("/root/history_limits") → the thread id currently
        // answering to it. Last write wins, which is exactly the pairing an
        // inter-agent message needs: the child that replies is whichever one
        // that path most recently named. A path CAN be reused (codex re-spawns
        // under the same task name), so a first-wins map would misfile the
        // second child's result onto the first child's capsule.
        let mut agent_path_to_thread_id: HashMap<String, String> = HashMap::new();
        // Terminal `SubAgentActivity` kinds by thread id (`completed` /
        // `interrupted`). Stamped onto the launch capsule so it stops reading as
        // "codex will never report this child again" once codex has.
        let mut agent_terminal_kind: HashMap<String, String> = HashMap::new();
        // Result text used to FILL the execution capsule only as a fallback for
        // agents that were never returned by a wait (keyed by agent_id). Filled
        // from close_agent's `previous_status`.
        let mut agent_fallback_results: HashMap<String, String> = HashMap::new();
        // Agents whose result was already shown in a wait capsule — their
        // execution capsule must NOT also show the result (no duplication).
        let mut agent_waited: HashSet<String> = HashSet::new();
        // Agents that ended in an error state (see `is_error_collab_status`:
        // errored/failed/notFound) in any wait or close — used to mark the
        // execution capsule as failed (live parity).
        let mut agent_errored: HashSet<String> = HashSet::new();
        let mut wait_agent_call_ids: HashSet<String> = HashSet::new();
        let mut list_agents_call_ids: HashSet<String> = HashSet::new();
        let mut close_agent_call_ids: HashSet<String> = HashSet::new();
        let mut close_agent_targets: HashMap<String, String> = HashMap::new();
        let mut active_agent_count: u32 = 0;
        let mut call_id_tool_names: HashMap<String, String> = HashMap::new();
        // Code-mode scripts (`custom_tool_call` named `exec`) awaiting their
        // output. A placeholder script card is pushed when the call is read, so
        // an interrupted turn still shows it in place; the output arm rewrites
        // that message's blocks once it knows how many `text()` chunks came
        // back. See `parsers/codex_code_mode.rs`.
        let mut pending_exec_scripts: HashMap<String, (usize, CodeModeScript)> = HashMap::new();
        // App-server persists each MCP call executed inside a code-mode script
        // as a semantic `item_completed.McpToolCall`. Keep those authoritative
        // ids/results with the sole open script; its output can then replace the
        // wrapper even when several results were printed as one JSON chunk.
        let mut completed_mcp_by_exec: HashMap<String, Vec<CompletedMcpCall>> = HashMap::new();
        // `exec_command` call_id → the command it ran, and the background shell
        // sessions that command's output announced (`session id → command`).
        // A later `wait` / `write_stdin` carries only the session id, so this is
        // what lets its card be titled by the command it is waiting on instead
        // of a bare `wait`. See `extract_shell_session_ids`.
        let mut call_id_commands: HashMap<String, String> = HashMap::new();
        let mut shell_sessions: HashMap<String, ShellSession> = HashMap::new();
        // Calls that only collect more of an earlier command's output: poll
        // `tool_use_id` → `tool_use_id` of the card holding that command. The
        // fold happens once parsing is done (`fold_shell_session_polls`), which
        // is what lets a poll written inside a code-mode script be folded on the
        // same footing as one codex called directly.
        let mut poll_origins: HashMap<String, String> = HashMap::new();
        // Scripts that answered `Script running with cell ID N` — they have NOT
        // finished, and the `wait` that later collects cell N carries their own
        // return value. Keyed by cell id so a parallel batch of waits each folds
        // into the right script no matter what order the records interleave in.
        let mut deferred_scripts: HashMap<String, DeferredScript> = HashMap::new();
        let mut deferred_waits: HashMap<String, String> = HashMap::new();
        // Codex 0.129+ writes a generated image both as `event_msg.image_generation_end`
        // and as `response_item.image_generation_call`, sharing the same call_id/id.
        // Emit at most one ContentBlock::Image per id to avoid duplicate display.
        let mut emitted_image_ids: HashSet<String> = HashSet::new();
        // Streaming reasoning buffer, held open across a whole reasoning RUN —
        // every section codex wrote before the next visible record (a tool call,
        // a message, …). Live streams such a run as one growing thought, so
        // history has to as well, and neither of codex's two on-disk records is
        // that run on its own:
        //   - `event_msg.agent_reasoning` — one per section;
        //   - `response_item.reasoning.summary` — the sections of ONE model
        //     response, grouped. A long run spans several responses, so codex
        //     writes several of these back to back (up to 28 in real rollouts),
        //     and emitting a card per record is what tore one thought into a
        //     column of 思考 cards.
        // So `grouped_reasoning` accumulates the settled text of the run while
        // `pending_reasoning` holds the section events not yet restated by a
        // grouped summary; the summary supersedes them (it is the same text,
        // grouped) and joins the run. Both are flushed as ONE Thinking block
        // when the run ends, so an interrupted rollout that never wrote its
        // summary still keeps its streaming reasoning. `pending_reasoning_ts`
        // stamps that block with the run's last reasoning record.
        let mut grouped_reasoning: Vec<String> = Vec::new();
        let mut pending_reasoning: Vec<String> = Vec::new();
        let mut pending_reasoning_ts: Option<DateTime<Utc>> = None;

        // Plan mode. `turn_context.collaboration_mode.mode` is the structured,
        // per-turn record of which mode produced the turn, and its flip out of
        // `plan` is the only in-band evidence that the user approved the plan
        // (see the `user_message` arm).
        //
        // The two plan flags are deliberately separate. `pending_plan_twin` is
        // a PAIRING slot — filled only by an `item_completed` announcement,
        // claimed only by the next `<proposed_plan>` record — and conflating it
        // with "a plan exists" would make two identical plan bodies collapse
        // into one. `plan_rendered` is the approval guard, so a stray approval
        // can never emit a decision marker with no plan above it.
        let mut collaboration_mode_is_plan = false;
        let mut plan_approval_expected = false;
        let mut pending_plan_twin: Option<(usize, String)> = None;
        let mut plan_rendered = false;

        // `response_item.message` records held back until EOF, when their turn
        // segment's canonical-channel coverage is known. See
        // [`ResponseItemPromotion`] for why the gate is per-segment.
        let mut promotion = ResponseItemPromotion::new();
        let mut pending_promotions: Vec<PendingPromotedMessage> = Vec::new();
        // Ordinals of the two in-loop decisions that promoted records can
        // legitimately override, recorded so they can be replayed POSITIONALLY
        // once the survivors are known — never "does a user exist anywhere",
        // which would cancel a valid goal opener answered by a later prompt.
        let mut first_goal_ordinal: Option<u64> = None;
        let mut title_source_ordinal: Option<u64> = None;
        // codex's own thread name outranks any prompt-derived title, and its arm
        // assigns unconditionally (newest wins), so it needs its own flag rather
        // than an ordinal comparison.
        let mut title_from_thread_name = false;

        for line in lines {
            if line.trim().is_empty() {
                continue;
            }

            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");

            // Fed EVERY record, before the parser's own handling: segment
            // boundaries, canonical-channel coverage and compaction adjacency
            // are all positional properties of the raw stream.
            let record_ordinal =
                promotion.note_record(msg_type, promotion_payload_type(msg_type, &value));

            if let Some(ts_str) = value.get("timestamp").and_then(|t| t.as_str()) {
                if let Ok(ts) = ts_str.parse::<DateTime<Utc>>() {
                    if first_timestamp.is_none() {
                        first_timestamp = Some(ts);
                    }
                    last_timestamp = Some(ts);
                }
            }

            match msg_type {
                "session_meta" => {
                    // First header wins for every identity field — see the same
                    // latch in `parse_jsonl_summary`: the parent header that
                    // follows a forked child's own (replayed inline, or spliced
                    // in by `rollout_lines`) carries the PARENT's cwd and branch.
                    if let Some(payload) = value.get("payload").filter(|_| !session_header_seen) {
                        session_header_seen = true;
                        cwd = payload
                            .get("cwd")
                            .and_then(|s| s.as_str())
                            .map(|s| s.to_string());
                        parent_id = codex_parent_thread_id(payload);
                        git_branch = payload
                            .get("git")
                            .and_then(|g| g.get("branch"))
                            .and_then(|b| b.as_str())
                            .map(|s| s.to_string());
                    }
                }
                "turn_context" => {
                    // A new API turn means any prior agent lifecycle is complete.
                    active_agent_count = 0;
                    if model.is_none() {
                        model = value
                            .get("payload")
                            .and_then(|p| p.get("model"))
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string());
                    }
                    // Approving a plan ends Plan mode: codex opens the very next
                    // turn with a non-`plan` collaboration mode and prompts
                    // ITSELF with `CODEX_PLAN_APPROVAL_PROMPT`. Arm the one-shot
                    // flag the `user_message` arm consumes. A rollout predating
                    // Plan mode reports no mode at all and so never arms.
                    //
                    // Only the flip arms, and only re-entering `plan` disarms —
                    // a REPEATED non-plan context must leave the arm standing.
                    // Newer codex re-emits `turn_context` mid-turn (the same
                    // reason `ResponseItemPromotion` prefers `task_started` for
                    // segmentation), and rewriting the flag on every context
                    // would let a second `default` context between the flip and
                    // the prompt silently restore the bug this filter fixes.
                    if let Some(mode) = turn_collaboration_mode(&value) {
                        let is_plan = mode == "plan";
                        if is_plan {
                            plan_approval_expected = false;
                        } else if collaboration_mode_is_plan {
                            plan_approval_expected = true;
                        }
                        collaboration_mode_is_plan = is_plan;
                    }
                    if let Some(ts) = parse_codex_timestamp(&value) {
                        push_turn_start(&mut turn_context_markers, ts);
                    }
                }
                "event_msg" => {
                    if let Some(payload) = value.get("payload") {
                        let payload_type =
                            payload.get("type").and_then(|t| t.as_str()).unwrap_or("");

                        let timestamp = parse_codex_timestamp(&value).unwrap_or_else(Utc::now);

                        // A new reasoning section keeps the run open; `token_count`
                        // is metadata with no visible message and never splits one.
                        // Anything else closes the run — emit the reasoning gathered
                        // so far as one card, here, so it can't be reordered behind
                        // this event.
                        if payload_type != "agent_reasoning" && payload_type != "token_count" {
                            flush_pending_reasoning(
                                &mut messages,
                                &mut grouped_reasoning,
                                &mut pending_reasoning,
                                pending_reasoning_ts,
                            );
                        }

                        // codex 0.147 stopped returning the sub-agent's id from
                        // `spawn_agent` (its output is empty, or just
                        // `{"task_name":"/root/pnpm_build"}`). `SubAgentActivity`
                        // is now the only place the parent's rollout names the
                        // child thread, and it correlates back by carrying the
                        // spawn's own `call_id`.
                        //
                        // Read BEFORE the match, not as an arm of it: 0.153.4
                        // moved these records inside `item_completed`, whose arm
                        // `continue`s on anything that is not a plan document.
                        if let Some(activity) =
                            codex_subagent_activity_record(payload_type, payload)
                        {
                            if let Some(path) = activity.agent_path {
                                agent_path_to_thread_id
                                    .insert(path.to_string(), activity.thread_id.to_string());
                            }
                            // Only a launch names the capsule to attach to; a
                            // terminal record carries a synthetic id of its own.
                            if let Some(call_id) = activity
                                .call_id
                                .filter(|id| spawn_agent_call_ids.contains(*id))
                            {
                                agent_id_to_spawn_call_id
                                    .entry(activity.thread_id.to_string())
                                    .or_insert_with(|| call_id.to_string());
                            }
                            match activity.kind {
                                "completed" | "interrupted" => {
                                    agent_terminal_kind.insert(
                                        activity.thread_id.to_string(),
                                        activity.kind.to_string(),
                                    );
                                }
                                // A terminal child can be brought back
                                // (`resumeAgent` / `followup_task`), and it
                                // announces that with a fresh `started`. Clear
                                // the old outcome rather than leave the capsule
                                // claiming a run that has since resumed. The
                                // live path self-corrects the same way: a new
                                // launch replaces the remembered input, which
                                // carries no state key.
                                "started" => {
                                    agent_terminal_kind.remove(activity.thread_id);
                                }
                                _ => {}
                            }
                        }

                        match payload_type {
                            "task_started" => {
                                if context_window_max_tokens.is_none() {
                                    context_window_max_tokens = payload
                                        .get("model_context_window")
                                        .and_then(|v| v.as_u64());
                                }
                                // The one marker codex writes exactly once per
                                // turn; it precedes `turn_context` and the
                                // prompt.
                                if let Some(ts) = parse_codex_timestamp(&value) {
                                    push_turn_start(&mut task_start_markers, ts);
                                }
                            }
                            "user_message" => {
                                active_agent_count = 0;
                                let text = payload
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("")
                                    .to_string();

                                // Plan-mode approval, not a prompt. codex writes
                                // its own follow-up as an ordinary user message,
                                // structurally identical to typed input, so
                                // rendering it splits ONE plan interaction into two
                                // user turns (live keeps both halves inside a
                                // single `session/prompt`). Both signals are
                                // required — the mode flip this turn AND codex's
                                // fixed wording — so a user who literally types
                                // that sentence still gets their bubble.
                                //
                                // The decision is not dropped, it MOVES: the plan
                                // call settles with codex-acp's own approval
                                // wording, which is what renders the live
                                // <PlanModeCard>'s "已同意" marker.
                                //
                                // Compared verbatim, NOT trimmed: codex writes
                                // this sentence with no surrounding whitespace
                                // (18/18 occurrences across the local corpus), so
                                // trimming would only widen the filter onto text a
                                // person could have typed.
                                let approval_armed = std::mem::take(&mut plan_approval_expected);
                                if approval_armed
                                    && text == CODEX_PLAN_APPROVAL_PROMPT
                                    && std::mem::take(&mut plan_rendered)
                                {
                                    push_plan_review_marker(&mut messages, timestamp);
                                    continue;
                                }

                                let normalized = strip_blocked_resource_mentions(&text);
                                if title.is_none() {
                                    title = extract_codex_title_candidate(&normalized, true);
                                    if title.is_some() {
                                        title_source_ordinal = Some(record_ordinal);
                                    }
                                }
                                let mut blocks: Vec<ContentBlock> = Vec::new();
                                if !normalized.is_empty() {
                                    blocks.push(ContentBlock::Text { text: normalized });
                                }

                                if let Some(images) =
                                    payload.get("images").and_then(|v| v.as_array())
                                {
                                    for image in images {
                                        let Some(raw) = image.as_str() else {
                                            continue;
                                        };
                                        let Some((mime_type, data)) = parse_data_uri_image(raw)
                                        else {
                                            continue;
                                        };
                                        blocks.push(ContentBlock::Image {
                                            data,
                                            mime_type,
                                            uri: None,
                                        });
                                    }
                                }

                                if blocks.is_empty() && contains_only_internal_agent_routes(&text) {
                                    continue;
                                }

                                if blocks.is_empty() {
                                    blocks.push(ContentBlock::Text {
                                        text: "Attached resources".to_string(),
                                    });
                                }

                                if should_skip_duplicate_user_message(&messages, &blocks, timestamp)
                                {
                                    continue;
                                }

                                messages.push(UnifiedMessage {
                                    id: format!("user-{}", messages.len()),
                                    role: MessageRole::User,
                                    content: blocks,
                                    timestamp,
                                    usage: None,
                                    duration_ms: None,
                                    model: None,
                                    completed_at: Some(timestamp),
                                agent_message_id: None,
                                });
                            }
                            "agent_message" => {
                                // Parent narration is emitted even while a
                                // sub-agent is active (active_agent_count > 0).
                                // Every `event_msg.agent_message` is the
                                // parent's: a sub-agent's own work goes to a
                                // transcript of its own, never into this channel
                                // (verified across 180 real rollouts: 0
                                // sub-agent leaks). The old
                                // `active_agent_count == 0` guard wrongly dropped
                                // the parent's between-capsule narration — and,
                                // when no close_agent ran (active never returns to
                                // 0), even the final answer. Images keep their own
                                // guard (see image_generation arms).
                                //
                                // A sub-agent CAN speak into the parent's
                                // rollout, but on a different channel: the
                                // addressed `response_item.agent_message`
                                // handled below. That one carries `author` /
                                // `recipient` and a `message` ARRAY, so it
                                // cannot be confused with this shape's bare
                                // `message` string.
                                let text = payload
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                messages.push(UnifiedMessage {
                                    id: format!("assistant-{}", messages.len()),
                                    role: MessageRole::Assistant,
                                    content: vec![ContentBlock::Text { text }],
                                    timestamp,
                                    usage: None,
                                    duration_ms: None,
                                    model: None,
                                    completed_at: Some(timestamp),
                                agent_message_id: None,
                                });
                            }
                            "thread_goal_updated" => {
                                // codex-acp v1.1.0 (#263) routes live goals through
                                // `session_info_update`; the CLI has always persisted
                                // each `/goal` transition to the rollout as
                                // `event_msg.thread_goal_updated.goal`. Synthesize the
                                // same canonical create_goal/update_goal
                                // tool_use+tool_result the live path emits (shared
                                // mapping in `crate::acp::codex_goal`) so a reloaded
                                // conversation renders goal cards identical to live —
                                // history that never surfaced goals before.
                                if let Some(marker) = payload.get("goal").and_then(|goal| {
                                    crate::acp::codex_goal::next_goal_marker(
                                        &mut codex_open_goal,
                                        goal,
                                    )
                                }) {
                                    // Remember the first opened goal's objective for
                                    // the post-parse leading-user-message fallback (see
                                    // `first_goal_objective`). Deferred, not synthesized
                                    // here, so it can't interfere with duplicate
                                    // suppression of a later real user message.
                                    if marker.tool_name == "create_goal"
                                        && first_goal_objective.is_none()
                                    {
                                        // Positional: the goal opened the session iff no
                                        // real user turn exists yet.
                                        goal_opens_session = !messages
                                            .iter()
                                            .any(|m| matches!(m.role, MessageRole::User));
                                        // Claim the title from the objective HERE, in
                                        // stream order, when the goal is the opener — so
                                        // a LATER `user_message` (its own guard is
                                        // `title.is_none()`) can't steal it, while an
                                        // EARLIER real user (older codex) or a native
                                        // `thread_name_updated` still wins.
                                        if goal_opens_session && title.is_none() {
                                            title = extract_codex_title_candidate(
                                                &marker.objective,
                                                true,
                                            );
                                            if title.is_some() {
                                                title_source_ordinal = Some(record_ordinal);
                                            }
                                        }
                                        first_goal_objective = Some(marker.objective.clone());
                                        first_goal_ordinal = Some(record_ordinal);
                                    }
                                    // Occurrence id from the message index — unique
                                    // per goal event, stable across reparse, and
                                    // shared by this event's ToolUse + ToolResult.
                                    let id = crate::acp::codex_goal::goal_tool_call_id(
                                        messages.len() as u64,
                                    );
                                    messages.push(UnifiedMessage {
                                        id: format!("tool-{}", messages.len()),
                                        role: MessageRole::Assistant,
                                        content: vec![
                                            ContentBlock::ToolUse {
                                                tool_use_id: Some(id.clone()),
                                                tool_name: marker.tool_name.to_string(),
                                                input_preview: Some(marker.input_json),
                                                status: None,
                                                meta: None,
                                            },
                                            ContentBlock::ToolResult {
                                                tool_use_id: Some(id),
                                                output_preview: Some(marker.output_json),
                                                is_error: false,
                                                agent_stats: None,
                                                images: Vec::new(),
                                            },
                                        ],
                                        timestamp,
                                        usage: None,
                                        duration_ms: None,
                                        model: None,
                                        completed_at: Some(timestamp),
                                    agent_message_id: None,
                                    });
                                }
                            }
                            "thread_name_updated" => {
                                // Codex's native thread name — adopt it as the
                                // auto-title (parity with Claude `aiTitle`, Gemini
                                // `update_topic`, OpenCode `session.title`). Newest
                                // non-empty wins, overriding the first-prompt
                                // fallback; `refresh_auto_title`'s `title_locked`
                                // guard still respects a manual rename.
                                // Rollout persists `thread_name` (snake_case); the
                                // live ACP notification uses `threadName`. Accept
                                // both so the parser is robust to either source.
                                if let Some(name) = payload
                                    .get("thread_name")
                                    .or_else(|| payload.get("threadName"))
                                    .or_else(|| payload.get("name"))
                                    .and_then(|n| n.as_str())
                                    .map(str::trim)
                                    .filter(|n| !n.is_empty())
                                {
                                    title = Some(truncate_str(name, 100));
                                    title_from_thread_name = true;
                                }
                            }
                            "item_completed" => {
                                if let Some(call) = completed_mcp_call(payload) {
                                    let exec_id = if deferred_scripts.is_empty()
                                        && pending_exec_scripts.len() == 1
                                    {
                                        pending_exec_scripts
                                            .keys()
                                            .next()
                                            .expect("one pending exec")
                                            .clone()
                                    } else if pending_exec_scripts.is_empty() {
                                        let mut deferred_exec_ids = deferred_scripts
                                            .values()
                                            .map(|script| script.call_id.as_str());
                                        let Some(exec_id) = deferred_exec_ids.next() else {
                                            continue;
                                        };
                                        if deferred_exec_ids.all(|id| id == exec_id) {
                                            exec_id.to_string()
                                        } else {
                                            continue;
                                        }
                                    } else {
                                        continue;
                                    };
                                    completed_mcp_by_exec
                                        .entry(exec_id)
                                        .or_default()
                                        .push(call);
                                    continue;
                                }
                                // Plan mode's finished plan document. This is the
                                // ONLY place a plan turn speaks on the canonical
                                // event channel — codex publishes the plan here
                                // INSTEAD of as `agent_message` — so without this
                                // arm the whole turn renders as nothing but its
                                // reasoning (issue: plan card vanishes on reload).
                                //
                                // Re-wrapped in codex's own `<proposed_plan>` tags
                                // so it lands on the exact adapter path the live
                                // stream uses (`expandProposedPlanText` → plan
                                // card). The assistant `response_item` twin, which
                                // carries the same body PLUS any surrounding prose,
                                // upgrades this message in place when it arrives.
                                let Some(plan) = completed_plan_item_text(payload) else {
                                    continue;
                                };
                                if active_agent_count > 0 {
                                    continue;
                                }
                                messages.push(UnifiedMessage {
                                    id: format!("assistant-plan-{}", messages.len()),
                                    role: MessageRole::Assistant,
                                    content: vec![ContentBlock::Text {
                                        text: format!(
                                            "{PROPOSED_PLAN_OPEN}\n{plan}\n{PROPOSED_PLAN_CLOSE}"
                                        ),
                                    }],
                                    timestamp,
                                    usage: None,
                                    duration_ms: None,
                                    model: None,
                                    completed_at: Some(timestamp),
                                    agent_message_id: None,
                                });
                                pending_plan_twin = Some((messages.len() - 1, plan.to_string()));
                                plan_rendered = true;
                            }
                            "agent_reasoning" => {
                                // Buffer this streaming reasoning section into the
                                // open run. The grouped
                                // `response_item.reasoning.summary` (parsed in the
                                // `response_item` match below) normally arrives right
                                // after the section events and supersedes the buffer
                                // with the same text; either way the run renders as
                                // ONE 思考 card (live parity) instead of one card per
                                // section, and if no grouped summary arrives
                                // (interrupted/older rollouts) nothing is lost.
                                let text = payload
                                    .get("text")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("");
                                if !text.trim().is_empty() {
                                    pending_reasoning.push(text.to_string());
                                    pending_reasoning_ts = Some(timestamp);
                                }
                            }
                            "image_generation_end" => {
                                if active_agent_count > 0 {
                                    continue;
                                }
                                let call_id = payload
                                    .get("call_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                let result =
                                    payload.get("result").and_then(|v| v.as_str()).unwrap_or("");
                                if result.is_empty() {
                                    continue;
                                }
                                if !call_id.is_empty() && emitted_image_ids.contains(&call_id) {
                                    continue;
                                }
                                let mime_type = payload
                                    .get("mime_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("image/png")
                                    .to_string();
                                let uri = payload
                                    .get("saved_path")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string());
                                let revised_prompt = payload
                                    .get("revised_prompt")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .filter(|s| !s.trim().is_empty());
                                messages.push(UnifiedMessage {
                                    id: format!("assistant-imagegen-{}", messages.len()),
                                    role: MessageRole::Assistant,
                                    content: vec![ContentBlock::ImageGeneration {
                                        revised_prompt,
                                        image: Some(ImageData {
                                            data: result.to_string(),
                                            mime_type,
                                            uri,
                                        }),
                                    }],
                                    timestamp,
                                    usage: None,
                                    duration_ms: None,
                                    model: None,
                                    completed_at: Some(timestamp),
                                agent_message_id: None,
                                });
                                if !call_id.is_empty() {
                                    emitted_image_ids.insert(call_id);
                                }
                            }
                            "token_count" => {
                                if let Some(info) = payload.get("info") {
                                    if let Some(total_usage_payload) = info.get("total_token_usage")
                                    {
                                        if let Some(total_usage) =
                                            extract_turn_usage_from_codex_usage(total_usage_payload)
                                        {
                                            latest_total_usage = Some(total_usage);
                                        }
                                        if let Some(total_tokens) =
                                            extract_total_tokens_from_usage(total_usage_payload)
                                        {
                                            latest_total_tokens = Some(total_tokens);
                                        }
                                    }

                                    let total_tokens =
                                        extract_context_window_used_tokens_from_token_count_info(
                                            info,
                                        );
                                    if total_tokens.is_some() {
                                        context_window_used_tokens = total_tokens;
                                    }

                                    let context_window =
                                        info.get("model_context_window").and_then(|v| v.as_u64());
                                    if context_window.is_some() {
                                        context_window_max_tokens = context_window;
                                    }

                                    if !info.is_null() {
                                        // What this round-trip spent. Preferred
                                        // as the rise in the session's own
                                        // cumulative counter; `last_token_usage`
                                        // is the fallback for transcripts that
                                        // report no total, and there a repeat of
                                        // the previous event is dropped since it
                                        // restates one call rather than adding
                                        // another.
                                        let round = match info.get("total_token_usage") {
                                            Some(total_payload) => {
                                                let total = codex_usage_counters(total_payload);
                                                let round = codex_round_usage(
                                                    previous_total_usage.as_ref(),
                                                    &total,
                                                );
                                                previous_total_usage = Some(total);
                                                round
                                            }
                                            None => match info.get("last_token_usage") {
                                                Some(last_payload) => {
                                                    let last = codex_usage_counters(last_payload);
                                                    let repeated = previous_last_usage
                                                        .as_ref()
                                                        .is_some_and(|prev| prev == &last);
                                                    previous_last_usage = Some(last.clone());
                                                    if repeated {
                                                        TurnUsage::default()
                                                    } else {
                                                        // Carry this round into the
                                                        // cumulative baseline too.
                                                        // A transcript that mixes
                                                        // both shapes would
                                                        // otherwise count it twice:
                                                        // once here, and again
                                                        // inside the next
                                                        // total-bearing event's
                                                        // delta, which is measured
                                                        // from a baseline that
                                                        // never learned about it.
                                                        let base = previous_total_usage
                                                            .clone()
                                                            .unwrap_or_default();
                                                        previous_total_usage =
                                                            Some(codex_usage_add(&base, &last));
                                                        last
                                                    }
                                                }
                                                None => TurnUsage::default(),
                                            },
                                        };

                                        if !codex_usage_is_zero(&round) {
                                            recorded_round_usage =
                                                codex_usage_add(&recorded_round_usage, &round);
                                            // Every round of a turn belongs to
                                            // the assistant message it worked
                                            // for, so they accumulate onto it
                                            // rather than the first one winning
                                            // and the rest being dropped. A
                                            // round that ran before any
                                            // assistant message (the model went
                                            // straight to a tool call) waits
                                            // here for one to arrive — 3 % of
                                            // all recorded spend, previously
                                            // discarded outright.
                                            pending_round_usage = Some(match pending_round_usage {
                                                Some(ref pending) => {
                                                    codex_usage_add(pending, &round)
                                                }
                                                None => round,
                                            });
                                        }
                                        // A `token_count` that lands INSIDE an open
                                        // reasoning run reports what the response
                                        // that produced that reasoning spent, and
                                        // the run's card has not been emitted yet.
                                        // Attaching now would bill the round to the
                                        // previous turn, so let it keep waiting for
                                        // the card the run is still gathering.
                                        let last_assistant = if grouped_reasoning.is_empty()
                                            && pending_reasoning.is_empty()
                                        {
                                            messages
                                                .iter_mut()
                                                .rev()
                                                .find(|m| matches!(m.role, MessageRole::Assistant))
                                        } else {
                                            None
                                        };
                                        if let (Some(pending), Some(last_msg)) =
                                            (pending_round_usage.clone(), last_assistant)
                                        {
                                            last_msg.usage = Some(match last_msg.usage {
                                                Some(ref existing) => {
                                                    codex_usage_add(existing, &pending)
                                                }
                                                None => pending,
                                            });
                                            pending_round_usage = None;
                                        }
                                    }
                                }
                                // Durations are NOT derived here. `token_count`
                                // fires once per model request, so measuring
                                // turn_context → token_count restated the whole
                                // elapsed turn on every sub-turn; the UI sums
                                // sub-turns into one card, which multiplied a
                                // reply's reported time several-fold. See
                                // `backfill_turn_durations`, applied after
                                // grouping, which partitions the turn instead.
                            }
                            _ => {}
                        }
                    }
                }
                "response_item" => {
                    if let Some(payload) = value.get("payload") {
                        let payload_type =
                            payload.get("type").and_then(|t| t.as_str()).unwrap_or("");
                        let timestamp = parse_codex_timestamp(&value).unwrap_or_else(Utc::now);

                        // A `reasoning` item joins the open run (handled in its arm).
                        // Any other response item closes it — emit the reasoning
                        // gathered so far as one card, here, so it can't be reordered
                        // behind this item.
                        if payload_type != "reasoning" {
                            flush_pending_reasoning(
                                &mut messages,
                                &mut grouped_reasoning,
                                &mut pending_reasoning,
                                pending_reasoning_ts,
                            );
                        }

                        match payload_type {
                            // A sub-agent reporting back. Distinct from the
                            // `event_msg.agent_message` arm above (which is the
                            // PARENT speaking, and carries a bare `message`
                            // string): this one is addressed
                            // `author` → `recipient` and wraps its body in
                            // codex's inter-agent envelope.
                            //
                            // It has no `item_completed` twin — codex publishes
                            // no ThreadItem for it — so codex-acp never sees it
                            // and it cannot arrive live. The rollout is the only
                            // place a child's report exists, which is why an
                            // otherwise-complete team run used to show nothing
                            // at all of what its sub-agents concluded.
                            //
                            // Not emitted as a message of its own: it belongs to
                            // the child, not the parent's narration. It is filed
                            // by thread id and the back-patch at the end of the
                            // parse folds it into that child's launch capsule,
                            // through the same `agent_fallback_results` channel
                            // the legacy `close_agent` result uses.
                            "agent_message" => {
                                if let Some((author, body)) =
                                    codex_inter_agent_final_answer(payload)
                                {
                                    if let Some(thread_id) = agent_path_to_thread_id.get(author) {
                                        agent_fallback_results
                                            .insert(thread_id.clone(), body);
                                    }
                                }
                            }
                            "reasoning" => {
                                // Codex records one model response's reasoning as a
                                // `summary` array of `{type:"summary_text", text}`
                                // parts — one part per section — grouping the same
                                // sections the streaming `event_msg.agent_reasoning`
                                // events carry one-by-one (buffered in
                                // `pending_reasoning`). So this item settles the
                                // buffer, superseding it; it does NOT end the run,
                                // because the next record may be one more of these
                                // (a run spanning several model responses) and live
                                // shows that as a single growing thought. The card
                                // is emitted when something visible finally closes
                                // the run.
                                //
                                // An empty summary (encrypted-only reasoning, the
                                // common case) restates nothing, so it must not
                                // clear the buffer — it only seals what is buffered
                                // so far, keeping those sections out of reach of a
                                // LATER summary that never covered them.
                                let text = payload
                                    .get("summary")
                                    .and_then(|s| s.as_array())
                                    .map(|parts| {
                                        parts
                                            .iter()
                                            .filter_map(|p| {
                                                p.get("text").and_then(|t| t.as_str())
                                            })
                                            .filter(|t| !t.trim().is_empty())
                                            .collect::<Vec<_>>()
                                            .join("\n\n")
                                    })
                                    .unwrap_or_default();
                                if !text.is_empty() {
                                    pending_reasoning.clear();
                                    grouped_reasoning.push(text);
                                    pending_reasoning_ts = Some(timestamp);
                                } else {
                                    grouped_reasoning.append(&mut pending_reasoning);
                                }
                            }
                            "function_call" | "custom_tool_call" => {
                                let tool_use_id = payload
                                    .get("call_id")
                                    .or_else(|| payload.get("tool_call_id"))
                                    .or_else(|| payload.get("id"))
                                    .and_then(|id| id.as_str())
                                    .map(|s| s.to_string());
                                let raw_tool_name = payload
                                    .get("name")
                                    .or_else(|| payload.get("tool_name"))
                                    .and_then(|n| n.as_str())
                                    .unwrap_or("unknown");

                                // A `wait` collecting a code-mode script that
                                // has not finished. Matched by cell id, never by
                                // adjacency — parallel calls interleave freely.
                                let deferred_cell = if raw_tool_name == "wait" {
                                    parse_codex_json_arg(payload)
                                        .as_ref()
                                        .and_then(|a| a.as_object())
                                        .and_then(shell_session_id)
                                        .filter(|cell| deferred_scripts.contains_key(cell))
                                } else {
                                    None
                                };

                                match raw_tool_name {
                                    // No card of its own: the output it is about
                                    // to collect IS the parked script's return
                                    // value, and the output arm writes it back
                                    // onto that script's cards.
                                    _ if deferred_cell.is_some() => {
                                        if let (Some(id), Some(cell)) = (tool_use_id, deferred_cell)
                                        {
                                            deferred_waits.insert(id, cell);
                                        }
                                    }
                                    "spawn_agent" => {
                                        let args = parse_codex_json_arg(payload);
                                        // codex 0.147's team-of-agents renamed the
                                        // label: the old `agent_type` became
                                        // `task_name` (`pnpm_build`). Reading only
                                        // the old key left every capsule titled
                                        // "agent".
                                        let agent_type = args
                                            .as_ref()
                                            .and_then(|a| {
                                                a.get("agent_type").or_else(|| a.get("task_name"))
                                            })
                                            .and_then(|v| v.as_str())
                                            .filter(|s| !s.trim().is_empty())
                                            .unwrap_or("agent");
                                        // Same release made the hand-off message an
                                        // encrypted envelope; rendering it verbatim
                                        // filled the capsule's title and prompt with
                                        // a wall of base64 (see `is_encrypted_envelope`).
                                        let message = args
                                            .as_ref()
                                            .and_then(|a| a.get("message"))
                                            .and_then(|v| v.as_str())
                                            .filter(|m| !is_encrypted_envelope(m))
                                            .unwrap_or("");
                                        let description =
                                            truncate_str(message.lines().next().unwrap_or(""), 60);

                                        if let Some(ref id) = tool_use_id {
                                            spawn_agent_call_ids.insert(id.clone());
                                        }
                                        active_agent_count += 1;

                                        let mut agent_input = serde_json::json!({
                                            "subagent_type": agent_type,
                                            "prompt": message,
                                            "description": description,
                                        });
                                        // The 0.147 shape (`task_name`, no
                                        // `agent_type`) is the one where this
                                        // capsule is ONLY a launch: there is no
                                        // wait/close capsule to carry the result,
                                        // so the card must not read as "the
                                        // sub-agent finished". Legacy spawns keep
                                        // their old meaning and no marker.
                                        if is_native_team_spawn(args.as_ref()) {
                                            if let Some(obj) = agent_input.as_object_mut() {
                                                obj.insert(
                                                    CODEX_SUBAGENT_LAUNCH_KEY.to_string(),
                                                    serde_json::Value::Bool(true),
                                                );
                                            }
                                        }

                                        messages.push(UnifiedMessage {
                                            id: format!("tool-{}", messages.len()),
                                            role: MessageRole::Assistant,
                                            content: vec![ContentBlock::ToolUse {
                                                tool_use_id,
                                                tool_name: "Agent".to_string(),
                                                input_preview: Some(agent_input.to_string()),
                                                status: None,
                                                meta: None,
                                            }],
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                    }
                                    "wait_agent" => {
                                        if let Some(ref id) = tool_use_id {
                                            wait_agent_call_ids.insert(id.clone());
                                        }
                                    }
                                    "list_agents" => {
                                        if let Some(ref id) = tool_use_id {
                                            list_agents_call_ids.insert(id.clone());
                                        }
                                    }
                                    "close_agent" => {
                                        if let Some(ref id) = tool_use_id {
                                            close_agent_call_ids.insert(id.clone());
                                            let target =
                                                parse_codex_json_arg(payload).and_then(|a| {
                                                    a.get("target")
                                                        .and_then(|v| v.as_str())
                                                        .map(|s| s.to_string())
                                                });
                                            if let Some(target) = target {
                                                close_agent_targets.insert(id.clone(), target);
                                            }
                                        }
                                    }
                                    // Code mode: the whole turn's tool calls are
                                    // wrapped in one JS script. Park a script
                                    // card here and let the output arm replace
                                    // it with the real per-call cards — the
                                    // split depends on how many `text()` chunks
                                    // came back, which is only known then. An
                                    // interrupted turn never gets an output, so
                                    // the placeholder must be pushed now to keep
                                    // its position.
                                    _ if is_code_mode_call(raw_tool_name) => {
                                        let source = payload
                                            .get("input")
                                            .or_else(|| payload.get("arguments"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");
                                        let script = parse_code_mode_script(source);
                                        if let Some(ref id) = tool_use_id {
                                            pending_exec_scripts.insert(
                                                id.clone(),
                                                (messages.len(), script.clone()),
                                            );
                                        }
                                        messages.push(UnifiedMessage {
                                            id: format!("tool-{}", messages.len()),
                                            role: MessageRole::Assistant,
                                            content: vec![ContentBlock::ToolUse {
                                                tool_use_id,
                                                tool_name: CODEX_SCRIPT_TOOL_NAME.to_string(),
                                                input_preview: Some(script_card_input(
                                                    source,
                                                    script.summary.as_deref(),
                                                    script.call_sites,
                                                )),
                                                status: None,
                                                meta: None,
                                            }],
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                    }
                                    _ => {
                                        if let Some(ref id) = tool_use_id {
                                            call_id_tool_names
                                                .insert(id.clone(), raw_tool_name.to_string());
                                        }
                                        let raw_args = || {
                                            // `send_message` and friends carry a
                                            // sealed inter-agent `message`; show a
                                            // marker instead of half a kilobyte of
                                            // base64 (see `redact_encrypted_args`).
                                            // Every other tool takes the original
                                            // path and renders byte-identically.
                                            if let Some(mut args) = parse_codex_json_arg(payload) {
                                                if redact_encrypted_args(&mut args) {
                                                    return value_to_preview(Some(&args));
                                                }
                                            }
                                            value_to_preview(
                                                payload
                                                    .get("arguments")
                                                    .or_else(|| payload.get("input")),
                                            )
                                        };
                                        let input_preview = if raw_tool_name == "exec_command" {
                                            let cmd = parse_codex_json_arg(payload).and_then(|a| {
                                                a.get("cmd")
                                                    .and_then(|v| v.as_str())
                                                    .map(|s| s.to_string())
                                            });
                                            // Remembered so this command can be
                                            // attached to whatever background
                                            // session its output announces.
                                            if let (Some(id), Some(cmd)) =
                                                (tool_use_id.as_ref(), cmd.as_ref())
                                            {
                                                call_id_commands.insert(id.clone(), cmd.clone());
                                            }
                                            cmd.or_else(raw_args)
                                        } else if is_shell_session_tool(raw_tool_name) {
                                            // `wait` / `write_stdin`: carry the
                                            // command that started the session
                                            // they address, when it is known.
                                            let args = parse_codex_json_arg(payload);
                                            note_shell_session_call(
                                                tool_use_id.as_deref(),
                                                args.as_ref(),
                                                &mut shell_sessions,
                                                &mut poll_origins,
                                            );
                                            args.and_then(|args| {
                                                annotate_shell_session_args(&args, &shell_sessions)
                                            })
                                            .or_else(raw_args)
                                        } else {
                                            raw_args()
                                        };
                                        messages.push(UnifiedMessage {
                                            id: format!("tool-{}", messages.len()),
                                            role: MessageRole::Assistant,
                                            content: vec![ContentBlock::ToolUse {
                                                tool_use_id,
                                                tool_name: raw_tool_name.to_string(),
                                                input_preview,
                                                status: None,
                                                meta: None,
                                            }],
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                    }
                                }
                            }
                            "function_call_output" | "custom_tool_call_output" => {
                                let tool_use_id = payload
                                    .get("call_id")
                                    .or_else(|| payload.get("tool_call_id"))
                                    .or_else(|| payload.get("id"))
                                    .and_then(|id| id.as_str())
                                    .map(|s| s.to_string());

                                let is_spawn = tool_use_id
                                    .as_ref()
                                    .is_some_and(|id| spawn_agent_call_ids.contains(id));
                                let is_wait = tool_use_id
                                    .as_ref()
                                    .is_some_and(|id| wait_agent_call_ids.contains(id));
                                let is_list = tool_use_id
                                    .as_ref()
                                    .is_some_and(|id| list_agents_call_ids.contains(id));
                                let is_close = tool_use_id
                                    .as_ref()
                                    .is_some_and(|id| close_agent_call_ids.contains(id));
                                let pending_script = tool_use_id
                                    .as_ref()
                                    .and_then(|id| pending_exec_scripts.remove(id));
                                let deferred = tool_use_id
                                    .as_ref()
                                    .and_then(|id| deferred_waits.remove(id))
                                    .and_then(|cell| deferred_scripts.remove(&cell));

                                if let Some(deferred) = deferred {
                                    // The parked script's real return value, at
                                    // last. Re-decompose it against that script
                                    // and rewrite the cards it already owns —
                                    // this `wait` contributes no card of its own.
                                    let collected = split_code_mode_output(payload.get("output"));
                                    // The whole run, not just this instalment:
                                    // see `DeferredScript::chunks`.
                                    let parsed = CodeModeOutput {
                                        status: collected.status,
                                        chunks: deferred
                                            .chunks
                                            .iter()
                                            .cloned()
                                            .chain(collected.chunks)
                                            .collect(),
                                        note: collected.note,
                                    };
                                    let semantic = (parsed.status == ScriptStatus::Completed)
                                        .then(|| {
                                            completed_mcp_by_exec.remove(&deferred.call_id)
                                        })
                                        .flatten();
                                    let (uses, results) = semantic
                                        .and_then(|calls| {
                                            unwrap_completed_mcp_calls(&deferred.script, calls)
                                        })
                                        .map(|(uses, results)| (Some(uses), results))
                                        .unwrap_or_else(|| {
                                            unwrap_code_mode_script(
                                                &deferred.call_id,
                                                &deferred.script,
                                                &parsed,
                                                payload,
                                                &mut shell_sessions,
                                                &mut poll_origins,
                                            )
                                        });
                                    if let Some(uses) = uses {
                                        messages[deferred.use_index].content = uses;
                                    }
                                    messages[deferred.result_index].content = results;
                                    // Still not done: whatever cell it reports
                                    // now is what the next `wait` collects.
                                    if parsed.status == ScriptStatus::Running {
                                        let deferred = DeferredScript {
                                            chunks: parsed.chunks,
                                            ..deferred
                                        };
                                        for cell in extract_shell_session_ids(
                                            parsed.note.as_deref().unwrap_or_default(),
                                        ) {
                                            deferred_scripts.insert(cell, deferred.clone());
                                        }
                                    }
                                } else if let Some((message_index, script)) = pending_script {
                                    let call_id = tool_use_id.unwrap_or_default();
                                    let parsed = split_code_mode_output(payload.get("output"));
                                    let semantic = (parsed.status == ScriptStatus::Completed)
                                        .then(|| completed_mcp_by_exec.remove(&call_id))
                                        .flatten();
                                    let (uses, results) = semantic
                                        .and_then(|calls| {
                                            unwrap_completed_mcp_calls(&script, calls)
                                        })
                                        .map(|(uses, results)| (Some(uses), results))
                                        .unwrap_or_else(|| {
                                            unwrap_code_mode_script(
                                                &call_id,
                                                &script,
                                                &parsed,
                                                payload,
                                                &mut shell_sessions,
                                                &mut poll_origins,
                                            )
                                        });
                                    if let Some(uses) = uses {
                                        messages[message_index].content = uses;
                                    }
                                    if parsed.status == ScriptStatus::Running {
                                        let deferred = DeferredScript {
                                            call_id: call_id.clone(),
                                            use_index: message_index,
                                            result_index: messages.len(),
                                            script: script.clone(),
                                            chunks: parsed.chunks.clone(),
                                        };
                                        for cell in extract_shell_session_ids(
                                            parsed.note.as_deref().unwrap_or_default(),
                                        ) {
                                            deferred_scripts.insert(cell, deferred.clone());
                                        }
                                    }
                                    messages.push(UnifiedMessage {
                                        id: format!("tool-result-{}", messages.len()),
                                        role: MessageRole::Tool,
                                        content: results,
                                        timestamp,
                                        usage: None,
                                        duration_ms: None,
                                        model: None,
                                        completed_at: Some(timestamp),
                                    agent_message_id: None,
                                    });
                                } else if is_spawn {
                                    if let Some(output_obj) = parse_codex_json_output(payload) {
                                        if let (Some(agent_id), Some(call_id)) = (
                                            output_obj.get("agent_id").and_then(|v| v.as_str()),
                                            tool_use_id.as_ref(),
                                        ) {
                                            agent_id_to_spawn_call_id
                                                .insert(agent_id.to_string(), call_id.clone());
                                        }
                                    }
                                    messages.push(UnifiedMessage {
                                        id: format!("tool-result-{}", messages.len()),
                                        role: MessageRole::Tool,
                                        content: vec![ContentBlock::ToolResult {
                                            tool_use_id,
                                            output_preview: None,
                                            is_error: false,
                                            agent_stats: None,
                                            images: Vec::new(),
                                        }],
                                        timestamp,
                                        usage: None,
                                        duration_ms: None,
                                        model: None,
                                        completed_at: Some(timestamp),
                                    agent_message_id: None,
                                    });
                                } else if is_wait || is_list {
                                    // Emit one `collab_agent` capsule per wait or
                                    // roster, routed through the same
                                    // CollabAgentCard as the live capsule. Two
                                    // wait output shapes — see
                                    // `native_team_wait_input`.
                                    //
                                    // A roster deliberately does NOT mark its
                                    // agents `agent_waited`: listing an agent is
                                    // not collecting it, and suppressing the
                                    // spawn capsule's own result on the strength
                                    // of a `list_agents` the model happened to
                                    // call would lose the report entirely.
                                    let capsule = parse_codex_json_output(payload).and_then(
                                        |output_obj| {
                                            if is_list {
                                                return build_collab_list_input(&output_obj);
                                            }
                                            match output_obj.get("status").and_then(|s| s.as_object())
                                            {
                                                Some(status) => {
                                                    // Mark returned agents so the spawn
                                                    // capsule won't also show their
                                                    // result, and record per-agent error
                                                    // state so the execution capsule can
                                                    // render failed (live parity).
                                                    for (agent_id, value) in status {
                                                        agent_waited.insert(agent_id.clone());
                                                        let (st, _) =
                                                            extract_wait_agent_status(value);
                                                        if is_error_collab_status(&st) {
                                                            agent_errored.insert(agent_id.clone());
                                                        }
                                                    }
                                                    (!status.is_empty())
                                                        .then(|| build_collab_wait_input(status))
                                                }
                                                None => native_team_wait_input(&output_obj),
                                            }
                                        },
                                    );
                                    if let Some((collab_input, is_error)) = capsule {
                                        messages.push(UnifiedMessage {
                                            id: format!("tool-{}", messages.len()),
                                            role: MessageRole::Assistant,
                                            content: vec![ContentBlock::ToolUse {
                                                tool_use_id: tool_use_id.clone(),
                                                tool_name: "collab_agent".to_string(),
                                                input_preview: Some(collab_input),
                                                status: None,
                                                meta: None,
                                            }],
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                        messages.push(UnifiedMessage {
                                            id: format!("tool-result-{}", messages.len()),
                                            role: MessageRole::Tool,
                                            content: vec![ContentBlock::ToolResult {
                                                tool_use_id,
                                                output_preview: None,
                                                is_error,
                                                agent_stats: None,
                                                images: Vec::new(),
                                            }],
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                    }
                                } else if is_close {
                                    active_agent_count = active_agent_count.saturating_sub(1);
                                    if let Some(output_obj) = parse_codex_json_output(payload) {
                                        if let Some(agent_id) = tool_use_id
                                            .as_ref()
                                            .and_then(|id| close_agent_targets.get(id))
                                        {
                                            // Generalize over the terminal key (not
                                            // just `completed`): an errored/notFound
                                            // close with no wait must not lose its
                                            // message or its error state.
                                            if let Some(prev) =
                                                output_obj.get("previous_status")
                                            {
                                                let (st, msg) =
                                                    extract_wait_agent_status(prev);
                                                if let Some(text) = msg {
                                                    agent_fallback_results
                                                        .entry(agent_id.clone())
                                                        .or_insert(text);
                                                }
                                                if is_error_collab_status(&st) {
                                                    agent_errored.insert(agent_id.clone());
                                                }
                                            }
                                        }
                                    }
                                } else {
                                    let is_exec = tool_use_id.as_ref().is_some_and(|id| {
                                        call_id_tool_names
                                            .get(id)
                                            .is_some_and(|n| n == "exec_command")
                                    });
                                    let output_value = payload.get("output");
                                    // Unified-exec tools (`wait`, …) share the
                                    // code-mode output shape: an ARRAY of
                                    // `{type:"input_text", text}` parts behind a
                                    // `Script …/Wall time …/Output:` header.
                                    // `value_to_preview` would dump that array as
                                    // raw JSON into the result panel.
                                    let envelope = split_code_mode_output(output_value);
                                    // An `exec_command` that left a background
                                    // shell running announces its id here; bind
                                    // it to the command so the `wait` /
                                    // `write_stdin` calls that address it later
                                    // can be titled by that command. Read before
                                    // `clean_codex_exec_output`, which drops
                                    // everything above the `Output:` line — the
                                    // announcement included.
                                    if let Some((origin, command)) =
                                        tool_use_id.as_ref().and_then(|id| {
                                            call_id_commands.get(id).map(|cmd| (id.clone(), cmd))
                                        })
                                    {
                                        let mut announced = envelope.joined();
                                        if let Some(note) = envelope.note.as_deref() {
                                            announced.push('\n');
                                            announced.push_str(note);
                                        }
                                        register_announced_sessions(
                                            command,
                                            &origin,
                                            &announced,
                                            &mut shell_sessions,
                                        );
                                    }
                                    let (raw_output, envelope_error) =
                                        if envelope.status != ScriptStatus::Unknown
                                            || output_value.is_some_and(|v| v.is_array())
                                        {
                                            (
                                                with_note(
                                                    Some(envelope.joined()),
                                                    envelope.note.as_deref(),
                                                )
                                                .filter(|s| !s.is_empty()),
                                                envelope.is_error(),
                                            )
                                        } else {
                                            (value_to_preview(output_value), false)
                                        };
                                    // A poll about to be folded into the card of
                                    // the command it is collecting for: its
                                    // envelope has to go, and an envelope that
                                    // wrapped nothing has to end up empty rather
                                    // than falling back to its own header.
                                    let is_folded_poll = tool_use_id
                                        .as_ref()
                                        .is_some_and(|id| poll_origins.contains_key(id));
                                    let output = if is_folded_poll {
                                        raw_output
                                            .map(|s| strip_exec_envelope(&s).unwrap_or(s))
                                            .filter(|s| !s.is_empty())
                                    } else if is_exec {
                                        raw_output.map(|s| clean_codex_exec_output(&s))
                                    } else {
                                        raw_output
                                    };
                                    let is_error = envelope_error
                                        || infer_tool_call_output_is_error(
                                            payload,
                                            output_value,
                                            output.as_deref(),
                                        );
                                    messages.push(UnifiedMessage {
                                        id: format!("tool-result-{}", messages.len()),
                                        role: MessageRole::Tool,
                                        content: vec![ContentBlock::ToolResult {
                                            tool_use_id,
                                            output_preview: output,
                                            is_error,
                                            agent_stats: None,
                                            images: Vec::new(),
                                        }],
                                        timestamp,
                                        usage: None,
                                        duration_ms: None,
                                        model: None,
                                        completed_at: Some(timestamp),
                                    agent_message_id: None,
                                    });
                                }
                            }
                            "message" => {
                                let role =
                                    payload.get("role").and_then(|r| r.as_str()).unwrap_or("");
                                if role == "user" {
                                    active_agent_count = 0;
                                    if let Some(blocks) =
                                        extract_response_item_user_image_blocks(payload)
                                    {
                                        if should_skip_duplicate_user_message(
                                            &messages, &blocks, timestamp,
                                        ) {
                                            continue;
                                        }

                                        if title.is_none() {
                                            if let Some(text) = first_text_block(&blocks) {
                                                title = extract_codex_title_candidate(
                                                    text.as_str(),
                                                    true,
                                                );
                                                if title.is_some() {
                                                    title_source_ordinal = Some(record_ordinal);
                                                }
                                            }
                                        }

                                        messages.push(UnifiedMessage {
                                            id: format!("user-{}", messages.len()),
                                            role: MessageRole::User,
                                            content: blocks,
                                            timestamp,
                                            usage: None,
                                            duration_ms: None,
                                            model: None,
                                            completed_at: Some(timestamp),
                                        agent_message_id: None,
                                        });
                                        continue;
                                    }
                                }

                                // Everything the arm above did not emit: text-only
                                // users and EVERY assistant record. Normally these
                                // are same-millisecond duplicates of the
                                // `event_msg` channel and must stay dropped — but
                                // in a rollout whose event channel never spoke for
                                // this turn they are the only copy that exists.
                                // Held back rather than pushed, because coverage is
                                // not known until the segment (or the file) ends.
                                let is_user = match role {
                                    "user" => true,
                                    "assistant" => false,
                                    // `developer` / `system` / anything else is
                                    // machinery, never a conversation turn.
                                    _ => continue,
                                };
                                let Some(blocks) =
                                    extract_response_item_message_blocks(payload, is_user)
                                else {
                                    continue;
                                };
                                // An image-only record has nothing for the
                                // deny-lists (which are text rules) to judge.
                                let text = first_text_block(&blocks).unwrap_or_default();

                                // Plan mode's plan document, intercepted ahead of
                                // the promotion gate. It must render even where the
                                // event channel DID speak for this turn, so the
                                // per-segment coverage rule (right for prose) is
                                // simply the wrong test here.
                                //
                                // This record is the richer of the plan's two
                                // copies: `item_completed` announces the body
                                // alone, while this one keeps the prose codex
                                // writes around the block. So when it IS the
                                // pending announcement's twin, it takes that
                                // message over rather than adding a second.
                                //
                                // The slot is consumed either way. Only an
                                // announcement may fill it, and only the next plan
                                // record may claim it — otherwise two plan turns
                                // that happen to propose the SAME body (a legacy
                                // rollout with no announcements, where codex
                                // re-proposes an unchanged plan) would read as one
                                // plan written twice, and the second turn would
                                // render empty.
                                if !is_user {
                                    if let Some(body) = proposed_plan_body(&text) {
                                        let twin = pending_plan_twin
                                            .take()
                                            .filter(|(_, seen)| seen == body)
                                            .map(|(index, _)| index);
                                        match twin.and_then(|index| messages.get_mut(index)) {
                                            Some(existing) => existing.content = blocks,
                                            None => {
                                                messages.push(UnifiedMessage {
                                                    id: format!("assistant-plan-{}", messages.len()),
                                                    role: MessageRole::Assistant,
                                                    content: blocks,
                                                    timestamp,
                                                    usage: None,
                                                    duration_ms: None,
                                                    model: None,
                                                    completed_at: Some(timestamp),
                                                    agent_message_id: None,
                                                });
                                            }
                                        }
                                        plan_rendered = true;
                                        continue;
                                    }
                                }

                                let promotable = if text.trim().is_empty() {
                                    true
                                } else if is_user {
                                    is_promotable_user_text(&text)
                                } else {
                                    is_promotable_assistant_text(&text)
                                };
                                if !promotable {
                                    continue;
                                }

                                let title_candidate = if is_user {
                                    extract_codex_title_candidate(&text, true)
                                } else {
                                    None
                                };
                                promotion.push_candidate(record_ordinal, is_user);
                                pending_promotions.push(PendingPromotedMessage {
                                    insert_at: messages.len(),
                                    is_user,
                                    blocks,
                                    timestamp,
                                    title_candidate,
                                });
                            }
                            "image_generation_call" => {
                                // codex 0.129+ writes the same generated image as both an
                                // `event_msg.image_generation_end` (earlier in the file) and
                                // a `response_item.image_generation_call` (here). They share
                                // the same id; emit at most once via emitted_image_ids.
                                // Subagent suppression mirrors the event_msg arm: parent
                                // timeline must not host children's generated images.
                                if active_agent_count > 0 {
                                    continue;
                                }
                                let id = payload
                                    .get("id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("")
                                    .to_string();
                                if !id.is_empty() && emitted_image_ids.contains(&id) {
                                    continue;
                                }
                                let result =
                                    payload.get("result").and_then(|v| v.as_str()).unwrap_or("");
                                if result.is_empty() {
                                    continue;
                                }
                                let mime_type = payload
                                    .get("mime_type")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("image/png")
                                    .to_string();
                                let revised_prompt = payload
                                    .get("revised_prompt")
                                    .and_then(|v| v.as_str())
                                    .map(|s| s.to_string())
                                    .filter(|s| !s.trim().is_empty());
                                messages.push(UnifiedMessage {
                                    id: format!("assistant-imagegen-{}", messages.len()),
                                    role: MessageRole::Assistant,
                                    content: vec![ContentBlock::ImageGeneration {
                                        revised_prompt,
                                        image: Some(ImageData {
                                            data: result.to_string(),
                                            mime_type,
                                            // response_item.image_generation_call has no
                                            // saved_path; event_msg.image_generation_end is
                                            // the only carrier of the on-disk file URI.
                                            uri: None,
                                        }),
                                    }],
                                    timestamp,
                                    usage: None,
                                    duration_ms: None,
                                    model: None,
                                    completed_at: Some(timestamp),
                                agent_message_id: None,
                                });
                                if !id.is_empty() {
                                    emitted_image_ids.insert(id);
                                }
                            }
                            _ => {}
                        }
                    }
                }
                _ => {}
            }
        }

        // A reasoning run the file ended on — either the last thing the session
        // did, or a truncated/interrupted rollout whose `agent_reasoning` events
        // were written before the grouped summary. Emit it so it isn't lost.
        flush_pending_reasoning(
            &mut messages,
            &mut grouped_reasoning,
            &mut pending_reasoning,
            pending_reasoning_ts,
        );

        // A round still waiting for an assistant message to bill — the transcript
        // ended before the next `token_count` could hand it to one (a run's card
        // was only just flushed above, or the model went straight to a tool call
        // and never spoke again). Bill it here rather than discard it.
        if let (Some(pending), Some(last_msg)) = (
            pending_round_usage.take(),
            messages
                .iter_mut()
                .rev()
                .find(|m| matches!(m.role, MessageRole::Assistant)),
        ) {
            last_msg.usage = Some(match last_msg.usage {
                Some(ref existing) => codex_usage_add(existing, &pending),
                None => pending,
            });
        }

        // Fill in subagent tool call stats (and, only as a fallback, the result)
        // on each spawn execution capsule.
        if !agent_id_to_spawn_call_id.is_empty() {
            let spawn_call_to_agent: HashMap<&str, &str> = agent_id_to_spawn_call_id
                .iter()
                .map(|(agent_id, call_id)| (call_id.as_str(), agent_id.as_str()))
                .collect();

            let session_dir = path.parent();
            let mut agent_stats_cache: HashMap<String, Option<AgentExecutionStats>> =
                HashMap::new();

            for msg in &mut messages {
                for block in &mut msg.content {
                    match block {
                        ContentBlock::ToolResult {
                            tool_use_id: Some(ref id),
                            ref mut output_preview,
                            ref mut is_error,
                            ref mut agent_stats,
                            ..
                        } => {
                            if let Some(&agent_id) = spawn_call_to_agent.get(id.as_str()) {
                                // The result text normally lives in the wait
                                // capsule; only show it on the execution capsule
                                // when this agent was never returned by a wait
                                // (else duplicate).
                                if !agent_waited.contains(agent_id) {
                                    if let Some(result) = agent_fallback_results.get(agent_id) {
                                        *output_preview = Some(result.clone());
                                    }
                                }
                                // Mark the execution capsule failed when the agent
                                // ended in error (in a wait or close) — live parity.
                                if agent_errored.contains(agent_id) {
                                    *is_error = true;
                                }
                                if let Some(dir) = session_dir {
                                    let stats = agent_stats_cache.entry(agent_id.to_string())
                                        .or_insert_with(|| {
                                            parse_codex_subagent_stats(dir, agent_id)
                                        });
                                    if stats.is_some() {
                                        *agent_stats = stats.clone();
                                    }
                                }
                            }
                        }
                        // Stamp the sub-agent's id onto the spawn execution capsule
                        // input so the card can render it (parity with the wait
                        // capsule, whose agentsStates already carry the id), plus
                        // the terminal state when codex reported one.
                        ContentBlock::ToolUse {
                            tool_use_id: Some(ref id),
                            ref tool_name,
                            ref mut input_preview,
                            ..
                        } if tool_name == "Agent" => {
                            if let Some(&agent_id) = spawn_call_to_agent.get(id.as_str()) {
                                *input_preview = Some(inject_agent_id_into_input(
                                    input_preview.as_deref(),
                                    agent_id,
                                    agent_terminal_kind.get(agent_id).map(String::as_str),
                                ));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }

        // Promote the held-back `response_item.message` records, now that the
        // whole file has been seen and every turn segment's canonical-channel
        // coverage is known.
        //
        // Ordering matters and is load-bearing:
        //   1. splice FIRST — `insert_at` indexes `messages` as it stood at EOF,
        //      and both steps below mutate it;
        //   2. then the `/goal` opener, which inserts at index 0;
        //   3. then `fold_shell_session_polls`, which rebuilds all of its own
        //      (message, block) indices from whatever vector it is handed.
        let survivors = promotion.resolve();
        let promoted_user_ordinal = promotion.first_surviving_user_ordinal(&survivors);
        let mut kept: Vec<PendingPromotedMessage> = pending_promotions
            .into_iter()
            .zip(&survivors)
            .filter(|(_, keep)| **keep)
            .map(|(pending, _)| pending)
            .collect();

        // Resolved before the vector is drained by the splice below.
        let promoted_title = kept
            .iter()
            .find(|pending| pending.is_user)
            .and_then(|pending| pending.title_candidate.clone());

        // Descending by insertion point so earlier indices stay valid — but
        // GROUPED, because several records can share one `insert_at` (nothing
        // was pushed between them) and splicing those one at a time in reverse
        // would invert their transcript order.
        while let Some(insert_at) = kept.last().map(|pending| pending.insert_at) {
            let group_start = kept
                .iter()
                .rposition(|pending| pending.insert_at != insert_at)
                .map(|index| index + 1)
                .unwrap_or(0);
            let group: Vec<UnifiedMessage> = kept
                .split_off(group_start)
                .into_iter()
                .enumerate()
                .map(|(offset, pending)| UnifiedMessage {
                    // Namespaced so a promoted record can never collide with a
                    // `user-N` / `assistant-N` id minted inside the loop.
                    id: format!("codex-ri-{insert_at}-{offset}"),
                    role: if pending.is_user {
                        MessageRole::User
                    } else {
                        MessageRole::Assistant
                    },
                    content: pending.blocks,
                    timestamp: pending.timestamp,
                    usage: None,
                    duration_ms: None,
                    model: None,
                    completed_at: Some(pending.timestamp),
                agent_message_id: None,
                })
                .collect();
            messages.splice(insert_at..insert_at, group);
        }

        // A promoted user that PRECEDES the goal means the goal did not open the
        // session after all — the same positional rule the in-loop code applies
        // to native users. One that comes AFTER it (the "确认" reply shape) must
        // leave the opener intact, which is why this compares ordinals rather
        // than asking whether a user exists anywhere.
        if let (Some(goal_ordinal), Some(user_ordinal)) =
            (first_goal_ordinal, promoted_user_ordinal)
        {
            if user_ordinal < goal_ordinal {
                goal_opens_session = false;
            }
        }

        // Same precedence the in-loop claims follow: codex's own thread name
        // always wins, otherwise the EARLIEST prompt-shaped source does.
        if !title_from_thread_name {
            if let (Some(user_ordinal), Some(candidate)) = (promoted_user_ordinal, promoted_title) {
                if title.is_none()
                    || title_source_ordinal.is_none_or(|current| user_ordinal < current)
                {
                    title = Some(candidate);
                }
            }
        }

        // Leading-`/goal` fallback: when a `/goal` opened the session (before any
        // real user turn), newer codex recorded only `thread_goal_updated` — no
        // `user_message` — so the typed `/goal <objective>` prompt would be missing
        // on reload (headless, or, when a later reply like "确认" exists, starting
        // mid-conversation). Surface it as the leading user message, prefixed with
        // `/goal ` to match what the user actually typed and the live optimistic
        // bubble. The title was already claimed in-loop (see the goal-capture
        // block). Applied here, after parsing, so the synthetic turn never
        // participates in `should_skip_duplicate_user_message`.
        if let Some(objective) = first_goal_objective {
            if goal_opens_session {
                messages.insert(
                    0,
                    UnifiedMessage {
                        id: "codex-goal-user".to_string(),
                        role: MessageRole::User,
                        content: vec![ContentBlock::Text {
                            text: format!("/goal {objective}"),
                        }],
                        // Earliest event time so it sorts ahead of the goal card.
                        timestamp: first_timestamp.unwrap_or_else(Utc::now),
                        usage: None,
                        duration_ms: None,
                        model: None,
                        completed_at: first_timestamp,
                    agent_message_id: None,
                    },
                );
            }
        }

        let folder_path = cwd.clone();
        let folder_name = folder_path.as_ref().map(|p| folder_name_from_path(p));

        fold_shell_session_polls(&mut messages, &poll_origins);
        let mut turns = group_into_turns(messages);
        reconcile_turn_usage(&mut turns, &recorded_round_usage);
        super::relocate_orphaned_tool_results(&mut turns);
        super::structurize_read_tool_output(&mut turns);
        super::resolve_patch_line_numbers(&mut turns, cwd.as_deref());
        // After relocation every turn's `completed_at` is final — tile the
        // timeline into per-reply durations before stats aggregate them.
        let turn_starts = if task_start_markers.is_empty() {
            &turn_context_markers
        } else {
            &task_start_markers
        };
        super::backfill_turn_durations(&mut turns, turn_starts);
        let mut session_stats = super::compute_session_stats(&turns);
        session_stats =
            merge_codex_total_usage_stats(session_stats, latest_total_usage, latest_total_tokens);
        session_stats = merge_codex_context_window_stats(
            session_stats,
            context_window_used_tokens,
            context_window_max_tokens,
        );

        let summary = ConversationSummary {
            id: conversation_id.to_string(),
            agent_type: AgentType::Codex,
            folder_path,
            folder_name,
            title,
            started_at: first_timestamp.unwrap_or_else(Utc::now),
            ended_at: last_timestamp,
            message_count: turns.len() as u32,
            model,
            git_branch,
            parent_id,
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

fn extract_total_tokens_from_usage(usage: &serde_json::Value) -> Option<u64> {
    if let Some(total_tokens) = usage.get("total_tokens").and_then(|v| v.as_u64()) {
        return Some(total_tokens);
    }

    let input_tokens = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cached_input_tokens = usage
        .get("cached_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let reasoning_output_tokens = usage
        .get("reasoning_output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    // Codex payloads use `input_tokens` as the full input (cache read included),
    // so fallback totals should not double-count cached tokens.
    let total = if cached_input_tokens <= input_tokens {
        input_tokens + output_tokens + reasoning_output_tokens
    } else {
        input_tokens + cached_input_tokens + output_tokens + reasoning_output_tokens
    };
    if total > 0 {
        Some(total)
    } else {
        None
    }
}

fn extract_turn_usage_from_codex_usage(usage: &serde_json::Value) -> Option<TurnUsage> {
    let input_tokens = usage
        .get("input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let output_tokens = usage
        .get("output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cache_read_input_tokens = usage
        .get("cached_input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if input_tokens == 0 && output_tokens == 0 && cache_read_input_tokens == 0 {
        return None;
    }

    Some(TurnUsage {
        input_tokens: input_tokens.saturating_sub(cache_read_input_tokens),
        output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens,
    })
}

/// A codex usage payload read as raw counters, keeping zeros.
///
/// [`extract_turn_usage_from_codex_usage`] answers "is there anything to show",
/// so it collapses an all-zero payload to `None`. The running-total arithmetic
/// below needs the opposite: a cumulative counter that legitimately still reads
/// zero is a real datapoint, not an absent one.
fn codex_usage_counters(usage: &serde_json::Value) -> TurnUsage {
    let field = |name: &str| usage.get(name).and_then(|v| v.as_u64()).unwrap_or(0);
    let cache_read = field("cached_input_tokens");
    TurnUsage {
        // Codex reports `input_tokens` *inclusive* of the cached prefix, so the
        // cached part is split out rather than counted twice.
        input_tokens: field("input_tokens").saturating_sub(cache_read),
        output_tokens: field("output_tokens"),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cache_read,
    }
}

fn codex_usage_is_zero(usage: &TurnUsage) -> bool {
    usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_creation_input_tokens == 0
        && usage.cache_read_input_tokens == 0
}

fn codex_usage_add(base: &TurnUsage, extra: &TurnUsage) -> TurnUsage {
    TurnUsage {
        input_tokens: base.input_tokens.saturating_add(extra.input_tokens),
        output_tokens: base.output_tokens.saturating_add(extra.output_tokens),
        cache_creation_input_tokens: base
            .cache_creation_input_tokens
            .saturating_add(extra.cache_creation_input_tokens),
        cache_read_input_tokens: base
            .cache_read_input_tokens
            .saturating_add(extra.cache_read_input_tokens),
    }
}

/// What one model round-trip added, as the rise in the session's cumulative
/// counter.
///
/// Codex emits a `token_count` event after **every** model call — including the
/// tool-calling rounds inside a turn — and each one restates
/// `total_token_usage` for the whole session. Differencing that counter is what
/// makes the accounting exact: it cannot double-count a `token_count` that is
/// emitted twice for the same call (7 380 of 31 846 events in a real session
/// tree are such repeats), and it cannot lose a round whose event went
/// unrecorded, because the next event's total absorbs it.
///
/// A total that moves *backwards* means the counter restarted (a fresh context
/// after compaction), so the new value is the round's own spend.
fn codex_round_usage(previous_total: Option<&TurnUsage>, total: &TurnUsage) -> TurnUsage {
    let grand = |u: &TurnUsage| {
        u.input_tokens
            .saturating_add(u.output_tokens)
            .saturating_add(u.cache_creation_input_tokens)
            .saturating_add(u.cache_read_input_tokens)
    };
    // No baseline, or the counter restarted below it: the whole figure is this
    // round's own spend. Differencing per field instead would clamp every field
    // to zero and silently drop the rest of the session.
    let Some(previous) = previous_total.filter(|prev| grand(prev) <= grand(total)) else {
        return total.clone();
    };
    TurnUsage {
        input_tokens: total.input_tokens.saturating_sub(previous.input_tokens),
        output_tokens: total.output_tokens.saturating_sub(previous.output_tokens),
        cache_creation_input_tokens: total
            .cache_creation_input_tokens
            .saturating_sub(previous.cache_creation_input_tokens),
        cache_read_input_tokens: total
            .cache_read_input_tokens
            .saturating_sub(previous.cache_read_input_tokens),
    }
}

/// Make the turns account for every token the transcript reported.
///
/// Round-trip usage is attached to the assistant message that was current when
/// the `token_count` arrived, which is right whenever that message survives —
/// but presentation is allowed to drop or fold messages (a tool call absorbed
/// into a capsule, a duplicate agent message collapsed away), and a message
/// that disappears takes its usage with it. Across a real session tree that
/// silently lost 7 % of Codex spend, concentrated in exactly the sessions that
/// worked hardest.
///
/// So the recorded rounds are also summed independently, and any shortfall is
/// put back on the last turn that can hold it. The invariant this establishes
/// is worth stating plainly: **the per-turn usage of a Codex session always
/// sums to what its own counter reported**, whatever the renderer did to the
/// turns in between.
///
/// A surplus is left alone. It would mean the turns claim more than the
/// transcript ever reported, which no path here can produce, and inventing a
/// correction for an impossible state would only hide the bug that caused it.
fn reconcile_turn_usage(turns: &mut [MessageTurn], recorded: &TurnUsage) {
    if codex_usage_is_zero(recorded) {
        return;
    }
    let attributed = turns
        .iter()
        .filter_map(|t| t.usage.as_ref())
        .fold(TurnUsage::default(), |acc, u| codex_usage_add(&acc, u));

    let missing = TurnUsage {
        input_tokens: recorded.input_tokens.saturating_sub(attributed.input_tokens),
        output_tokens: recorded
            .output_tokens
            .saturating_sub(attributed.output_tokens),
        cache_creation_input_tokens: recorded
            .cache_creation_input_tokens
            .saturating_sub(attributed.cache_creation_input_tokens),
        cache_read_input_tokens: recorded
            .cache_read_input_tokens
            .saturating_sub(attributed.cache_read_input_tokens),
    };
    if codex_usage_is_zero(&missing) {
        return;
    }

    // Prefer a turn that already reports usage — it is one the transcript
    // itself tied to a model call, so the recovered tokens land beside spend
    // that really happened rather than on an unrelated bubble.
    let target = turns
        .iter()
        .rposition(|t| t.usage.is_some())
        .or_else(|| turns.iter().rposition(|t| matches!(t.role, TurnRole::Assistant)));
    if let Some(turn) = target.and_then(|i| turns.get_mut(i)) {
        turn.usage = Some(match turn.usage {
            Some(ref existing) => codex_usage_add(existing, &missing),
            None => missing,
        });
    }
}

fn extract_context_window_used_tokens_from_token_count_info(
    info: &serde_json::Value,
) -> Option<u64> {
    // `last_token_usage` is the current turn usage and best matches context window occupancy.
    if let Some(last_usage) = info.get("last_token_usage") {
        if let Some(total) = extract_total_tokens_from_usage(last_usage) {
            return Some(total);
        }
    }

    // Fallback: some payloads may only have cumulative totals.
    info.get("total_token_usage")
        .and_then(extract_total_tokens_from_usage)
}

fn merge_codex_context_window_stats(
    stats: Option<SessionStats>,
    used_tokens: Option<u64>,
    max_tokens: Option<u64>,
) -> Option<SessionStats> {
    if used_tokens.is_none() && max_tokens.is_none() {
        return stats;
    }

    let usage_percent = match (used_tokens, max_tokens) {
        (Some(used), Some(max)) if max > 0 => Some((used as f64 / max as f64) * 100.0),
        _ => None,
    };

    match stats {
        Some(mut s) => {
            s.context_window_used_tokens = used_tokens;
            s.context_window_max_tokens = max_tokens;
            s.context_window_usage_percent = usage_percent;
            Some(s)
        }
        None => Some(SessionStats {
            total_usage: None,
            total_tokens: None,
            total_duration_ms: 0,
            context_window_used_tokens: used_tokens,
            context_window_max_tokens: max_tokens,
            context_window_usage_percent: usage_percent,
        }),
    }
}

fn merge_codex_total_usage_stats(
    stats: Option<SessionStats>,
    total_usage: Option<TurnUsage>,
    total_tokens: Option<u64>,
) -> Option<SessionStats> {
    match stats {
        Some(mut s) => {
            if let Some(total) = total_usage {
                s.total_usage = Some(total);
            }
            if total_tokens.is_some() {
                s.total_tokens = total_tokens;
            }
            Some(s)
        }
        None if total_usage.is_some() || total_tokens.is_some() => Some(SessionStats {
            total_usage,
            total_tokens,
            total_duration_ms: 0,
            context_window_used_tokens: None,
            context_window_max_tokens: None,
            context_window_usage_percent: None,
        }),
        None => None,
    }
}

fn parse_codex_timestamp(value: &serde_json::Value) -> Option<DateTime<Utc>> {
    value
        .get("timestamp")
        .and_then(|t| t.as_str())
        .and_then(|s| s.parse::<DateTime<Utc>>().ok())
}

/// Append a start-of-turn marker to one of the two marker lists (see their
/// declaration for why `task_started` and `turn_context` are kept apart).
///
/// An out-of-order arrival (skewed clocks in a rollout) is dropped rather than
/// inserted: the backfill scans the list once, in order.
fn push_turn_start(turn_starts: &mut Vec<DateTime<Utc>>, ts: DateTime<Utc>) {
    match turn_starts.last() {
        Some(last) if ts <= *last => {}
        _ => turn_starts.push(ts),
    }
}

/// Close an open reasoning run: emit everything it gathered as a single Thinking
/// message and reset both buffers. No-op when the run is empty.
///
/// `grouped` is the settled text — the summaries codex wrote for each model
/// response the run spanned — and `pending` the streaming sections no summary
/// has restated yet (an interrupted rollout, or the tail of a run that is still
/// being written). Joining the two in that order is the run in document order,
/// which is the one 思考 card live shows for it.
fn flush_pending_reasoning(
    messages: &mut Vec<UnifiedMessage>,
    grouped: &mut Vec<String>,
    pending: &mut Vec<String>,
    ts: Option<DateTime<Utc>>,
) {
    if grouped.is_empty() && pending.is_empty() {
        return;
    }
    let text = grouped
        .iter()
        .chain(pending.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n");
    grouped.clear();
    pending.clear();
    let timestamp = ts.unwrap_or_else(Utc::now);
    messages.push(UnifiedMessage {
        id: format!("thinking-{}", messages.len()),
        role: MessageRole::Assistant,
        content: vec![ContentBlock::Thinking { text }],
        timestamp,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: Some(timestamp),
    agent_message_id: None,
    });
}

fn agents_instructions_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?s)\A# AGENTS\.md instructions for [^\n]+\n\s*\n<INSTRUCTIONS>.*?</INSTRUCTIONS>\s*",
        )
        .expect("valid agents instructions regex")
    })
}

fn strip_agents_instructions_block(input: &str) -> String {
    let text = agents_instructions_regex().replace(input, "");
    text.trim().to_string()
}

/// Whether `input` is the AGENTS.md context codex injects as a `role: "user"`
/// record — in either of the two shapes it ships in.
///
/// Upstream (`UserInstructions` in
/// `codex-rs/core/src/context/user_instructions.rs`) renders it as the header,
/// then `{" for {dir}"|""}`, then `\n\n<INSTRUCTIONS>\n{text}\n`, then the
/// closing tag. The directory is an `Option`, and a GLOBAL `~/.codex/AGENTS.md`
/// has no directory to name — so newer codex emits the header bare, which used
/// to slip past the old `"…instructions for "` prefix and become the
/// conversation title (#789).
///
/// The `<INSTRUCTIONS>` opener is unconditional in both shapes (2554 of 2554
/// such records in the local corpus carry it), so requiring it costs nothing
/// and keeps a human prompt that merely OPENS with this heading from being
/// swallowed as machinery. The record often carries `<environment_context>`
/// as a second content item, joined onto the same text, which is why the
/// closing tag is deliberately NOT anchored to the end.
fn is_agents_instruction_message(input: &str) -> bool {
    const HEADER: &str = "# AGENTS.md instructions";

    let Some(suffix) = input.trim_start().strip_prefix(HEADER) else {
        return false;
    };

    // `\r` covers the CRLF rollouts Windows codex writes.
    (suffix.starts_with('\n') || suffix.starts_with('\r') || suffix.starts_with(" for "))
        && suffix.contains("<INSTRUCTIONS>")
}

fn is_environment_context_message(input: &str) -> bool {
    let trimmed = input.trim();
    trimmed.starts_with("<environment_context>") && trimmed.ends_with("</environment_context>")
}

/// codex re-injects `<codex_internal_context source="goal">Continue working …`
/// user turns while a `/goal` is active. These are machine context, never a real
/// prompt, so they must never become a conversation title (they otherwise leak in
/// on the summary path, whose title fallback doesn't gate on image blocks).
fn is_codex_internal_context_message(input: &str) -> bool {
    input.trim_start().starts_with("<codex_internal_context")
}

/// Machine-authored `role: "user"` records that codex injects into the model's
/// history but never shows as a prompt. They are unreachable on the canonical
/// path (`event_msg.user_message` carries only what the human typed) and only
/// become visible through [`ResponseItemPromotion`], so the list lives with the
/// promotion logic rather than with the title helpers.
///
/// Derived from a census of every user-role `response_item.message` text in the
/// local rollout corpus, not from guesswork: `<environment_context>` (1248),
/// `<turn_aborted>` (152), `<codex_internal_context source="goal">` (52),
/// `<subagent_notification>` (24), `<skill>` (10). The one untagged member is
/// the correction codex injects when a model calls `apply_patch` through
/// `exec_command` (34 occurrences) — matching English prose is admittedly
/// brittle, but the failure mode is one stray user bubble in a rollout that
/// would otherwise render nothing at all.
///
/// `<recommended_plugins>` is the newest member and was NOT in that census —
/// codex only writes it once the `recommended_plugins` feature is on, which no
/// local rollout had. It is upstream's `RecommendedPluginsInstructions`
/// (`codex-rs/core/src/context/recommended_plugins_instructions.rs`), a
/// `role: "user"` fragment rendered as the marker pair wrapped around
/// `"\nHere is a list of plugins that are available but not installed.\n\n…"`.
/// Because codex injects it BEFORE the first prompt it does not merely add a
/// stray bubble: it wins the promoted-title race, which is how whole fleets of
/// sessions ended up named `<recommended_plugins> Here is a list of plugins…`.
const PROMOTED_USER_DENY_PREFIXES: &[&str] = &[
    "<turn_aborted>",
    "<subagent_notification",
    "<skill",
    "<user_instructions",
    "<permissions instructions",
    "<skills_instructions",
    "<recommended_plugins>",
    "Warning: apply_patch was requested via exec_command",
];

/// Whether a candidate user record is machine context rather than a prompt.
fn is_promotable_user_text(input: &str) -> bool {
    let trimmed = input.trim();
    if trimmed.is_empty()
        || is_agents_instruction_message(trimmed)
        || is_environment_context_message(trimmed)
        || is_codex_internal_context_message(trimmed)
    {
        return false;
    }
    !PROMOTED_USER_DENY_PREFIXES
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

/// Whether a candidate assistant record is renderable prose.
///
/// `<proposed_plan>` is codex's plan-mode payload. It is NOT prose and never
/// rides the generic promotion path: the detail parser intercepts it in a
/// dedicated arm (see [`proposed_plan_body`]) which renders it regardless of
/// the segment's canonical-channel coverage, because a plan turn has no
/// `agent_message` twin to be covered by in the first place. Keeping the deny
/// here is what stops the two paths from both emitting the same plan.
/// The compaction/handoff summary is excluded separately, by adjacency
/// (see [`ResponseItemPromotion::note_record`]).
fn is_promotable_assistant_text(input: &str) -> bool {
    let trimmed = input.trim();
    !trimmed.is_empty() && !trimmed.starts_with(PROPOSED_PLAN_OPEN)
}

/// codex Plan-mode markers. The plan document reaches the model's own history
/// as an assistant `response_item` wrapped in these tags, optionally with prose
/// before or after the block ("如果你希望调整…" follow-ups are common). The
/// frontend adapter (`expandProposedPlanText`) already splits that shape into a
/// plan card plus the surrounding text parts, so the parser hands the record
/// over verbatim instead of reshaping it here.
const PROPOSED_PLAN_OPEN: &str = "<proposed_plan>";
const PROPOSED_PLAN_CLOSE: &str = "</proposed_plan>";

/// The plan document inside a `<proposed_plan>` block, or `None` when `input`
/// carries no such block.
///
/// Used to pair an assistant record with the `event_msg.item_completed`
/// announcement of the SAME plan: codex writes every plan twice — once as a
/// structured `Plan` item (body only) and once as this record (body plus any
/// surrounding prose) — and only one of them may render. An unclosed block
/// (the turn was interrupted mid-plan) yields everything after the opener.
fn proposed_plan_body(input: &str) -> Option<&str> {
    let opened = input.find(PROPOSED_PLAN_OPEN)? + PROPOSED_PLAN_OPEN.len();
    let rest = &input[opened..];
    let body = match rest.find(PROPOSED_PLAN_CLOSE) {
        Some(closed) => &rest[..closed],
        None => rest,
    };
    Some(body.trim())
}

/// The plan document announced by `event_msg.item_completed`, or `None` for
/// every other completed item. codex's Plan-mode turn publishes its final
/// answer here INSTEAD of on `event_msg.agent_message`, which is why a plan
/// turn otherwise parses to nothing but its reasoning.
fn completed_plan_item_text(payload: &serde_json::Value) -> Option<&str> {
    let item = payload.get("item")?;
    if item.get("type").and_then(|v| v.as_str()) != Some("Plan") {
        return None;
    }
    let text = item.get("text").and_then(|v| v.as_str())?.trim();
    (!text.is_empty()).then_some(text)
}

/// codex's own follow-up prompt after the user approves a plan. It is written
/// to the rollout as an ordinary `user_message` — same fields, same empty
/// `text_elements` as something the user typed — so the wording is the only
/// per-record signal, and it is deliberately paired with the collaboration-mode
/// flip below rather than trusted alone.
const CODEX_PLAN_APPROVAL_PROMPT: &str = "Implement the approved plan.";

/// codex-acp's wording for an approved plan review, echoed as the historical
/// `plan_review` call's output so the card reports the same decision the live
/// one does (`CODEX_PLAN_APPROVED_PREFIX` in `plan-mode-card.tsx`).
const CODEX_PLAN_APPROVED_OUTPUT: &str = "User approved the plan.";

/// Append the settled `plan_review` call that reports an approved plan.
///
/// Deliberately the same shape the LIVE path produces: codeg seeds codex-acp's
/// unannounced plan-review call with `raw_input: None` (see
/// `handle_permission_request`) because the plan is already in the transcript,
/// and the frontend renders that input-less call as a bare decision marker. So
/// history and live resolve to one `<PlanModeCard>` with no rendering change
/// on either side.
///
/// Appended rather than inserted next to the plan: held `insert_at` positions
/// in `pending_promotions` are indices into this very vector, and the approval
/// belongs after the plan chronologically anyway.
fn push_plan_review_marker(messages: &mut Vec<UnifiedMessage>, timestamp: DateTime<Utc>) {
    let tool_use_id = format!("codex-plan-review-{}", messages.len());
    messages.push(UnifiedMessage {
        id: format!("assistant-plan-review-{}", messages.len()),
        role: MessageRole::Assistant,
        content: vec![
            ContentBlock::ToolUse {
                tool_use_id: Some(tool_use_id.clone()),
                // Resolved verbatim by the historical adapter, which passes
                // `block.tool_name` straight through to the renderer's
                // underscore-preserving gate.
                tool_name: "plan_review".to_string(),
                input_preview: None,
                status: None,
                meta: None,
            },
            ContentBlock::ToolResult {
                tool_use_id: Some(tool_use_id),
                output_preview: Some(CODEX_PLAN_APPROVED_OUTPUT.to_string()),
                is_error: false,
                agent_stats: None,
                images: Vec::new(),
            },
        ],
        timestamp,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: Some(timestamp),
        agent_message_id: None,
    });
}

/// This turn's collaboration mode, from `turn_context.collaboration_mode.mode`
/// (`"plan"` while Plan mode is active). Absent on rollouts predating Plan
/// mode, which is why every caller treats `None` as "not plan".
fn turn_collaboration_mode(value: &serde_json::Value) -> Option<&str> {
    value
        .get("payload")?
        .get("collaboration_mode")?
        .get("mode")?
        .as_str()
}

fn extract_codex_title_candidate(input: &str, fallback_attached: bool) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty()
        || is_agents_instruction_message(trimmed)
        || is_environment_context_message(trimmed)
        || is_codex_internal_context_message(trimmed)
    {
        return None;
    }

    let without_agents = strip_agents_instructions_block(trimmed);
    if without_agents.is_empty()
        || is_agents_instruction_message(&without_agents)
        || is_environment_context_message(&without_agents)
        || is_codex_internal_context_message(&without_agents)
    {
        return None;
    }

    let cleaned = strip_blocked_resource_mentions(&without_agents);
    if cleaned.is_empty() {
        if fallback_attached {
            Some("Attached resources".to_string())
        } else {
            None
        }
    } else {
        Some(title_from_user_text(&cleaned))
    }
}

fn extract_codex_text_content(payload: &serde_json::Value) -> Option<String> {
    let content = payload.get("content")?;
    if let Some(arr) = content.as_array() {
        for item in arr {
            let t = item.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if t == "input_text" {
                return item
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(|t| t.to_string());
            }
        }
    }
    None
}

fn parse_data_uri_image(raw: &str) -> Option<(String, String)> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("data:") {
        return None;
    }
    let marker = ";base64,";
    let marker_idx = trimmed.find(marker)?;
    let mime_type = trimmed.get(5..marker_idx)?.trim();
    if !mime_type.starts_with("image/") {
        return None;
    }
    let data = trimmed.get(marker_idx + marker.len()..)?.trim();
    if data.is_empty() {
        return None;
    }
    Some((mime_type.to_string(), data.to_string()))
}

fn parse_input_image_data_uri(item: &serde_json::Value) -> Option<(String, String)> {
    let data_uri = item
        .get("image_url")
        .and_then(|v| v.as_str())
        .or_else(|| {
            item.get("image_url")
                .and_then(|v| v.get("url"))
                .and_then(|v| v.as_str())
        })
        .or_else(|| item.get("url").and_then(|v| v.as_str()))?;
    parse_data_uri_image(data_uri)
}

fn first_text_block(blocks: &[ContentBlock]) -> Option<String> {
    blocks.iter().find_map(|block| match block {
        ContentBlock::Text { text } => Some(text.clone()),
        _ => None,
    })
}

fn blocks_equal(a: &[ContentBlock], b: &[ContentBlock]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    serde_json::to_value(a).ok() == serde_json::to_value(b).ok()
}

fn should_skip_duplicate_user_message(
    messages: &[UnifiedMessage],
    blocks: &[ContentBlock],
    timestamp: DateTime<Utc>,
) -> bool {
    // Some Codex logs emit the same user message through both `response_item`
    // and `event_msg`, sometimes with a non-trivial delay. Deduplicate by
    // content in a bounded recent time window.
    const DUP_WINDOW_MS: i64 = 120_000;

    for msg in messages.iter().rev() {
        if !matches!(msg.role, MessageRole::User) {
            continue;
        }
        let delta_ms = (timestamp - msg.timestamp).num_milliseconds().abs();
        if delta_ms > DUP_WINDOW_MS {
            break;
        }
        if blocks_equal(&msg.content, blocks) {
            return true;
        }
    }

    false
}

/// Content identity of a user turn, in the exact terms the DETAIL parser
/// compares (`blocks_equal` over the blocks it would build for that record).
///
/// The summary parser must apply the same cross-channel dedup as
/// [`should_skip_duplicate_user_message`] — codex writes the same prompt
/// through both `event_msg` and `response_item` — but it is the LIGHTWEIGHT
/// pass and must not materialize blocks (or decode images) to do it. This is
/// the cheap stand-in: same text normalization, same image-parse predicate,
/// same ordering, no allocation of the block vector itself.
#[derive(Debug, PartialEq, Eq)]
struct UserTurnFingerprint {
    text: Option<String>,
    images: Vec<(String, String)>,
}

impl UserTurnFingerprint {
    /// Mirrors the detail parser's `event_msg`/`user_message` arm.
    fn from_event_message(payload: &serde_json::Value) -> Self {
        let text = strip_blocked_resource_mentions(
            payload.get("message").and_then(|m| m.as_str()).unwrap_or(""),
        );
        let images = payload
            .get("images")
            .and_then(|v| v.as_array())
            .map(|images| {
                images
                    .iter()
                    .filter_map(|image| image.as_str())
                    .filter_map(parse_data_uri_image)
                    .collect()
            })
            .unwrap_or_default();
        Self::new(text, images)
    }

    /// Mirrors [`extract_response_item_user_image_blocks`].
    fn from_response_item(payload: &serde_json::Value) -> Self {
        let mut text_parts: Vec<String> = Vec::new();
        let mut images = Vec::new();
        if let Some(content) = payload.get("content").and_then(|c| c.as_array()) {
            for item in content {
                match item.get("type").and_then(|v| v.as_str()).unwrap_or("") {
                    "input_text" => {
                        let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
                            continue;
                        };
                        if text.is_empty() || text.trim() == "<image>" {
                            continue;
                        }
                        text_parts.push(text.to_string());
                    }
                    "input_image" => {
                        if let Some(image) = parse_input_image_data_uri(item) {
                            images.push(image);
                        }
                    }
                    _ => {}
                }
            }
        }
        Self::new(
            strip_blocked_resource_mentions(&text_parts.join("\n")),
            images,
        )
    }

    fn new(text: String, images: Vec<(String, String)>) -> Self {
        // The detail parser substitutes this placeholder when a user record
        // would otherwise carry nothing, so two such records compare equal
        // there and must compare equal here too.
        let text = if text.is_empty() {
            images.is_empty().then(|| "Attached resources".to_string())
        } else {
            Some(text)
        };
        Self { text, images }
    }
}

/// Summary-side mirror of [`should_skip_duplicate_user_message`]: same 120s
/// window, same reverse scan, same content equality. Prunes as it goes so the
/// list stays bounded by the window rather than by the transcript length.
fn skip_duplicate_user_record(
    recent: &mut Vec<(DateTime<Utc>, UserTurnFingerprint)>,
    fingerprint: UserTurnFingerprint,
    timestamp: DateTime<Utc>,
) -> bool {
    const DUP_WINDOW_MS: i64 = 120_000;
    while let Some((first, _)) = recent.first() {
        if (timestamp - *first).num_milliseconds().abs() > DUP_WINDOW_MS {
            recent.remove(0);
        } else {
            break;
        }
    }
    if recent.iter().any(|(_, seen)| *seen == fingerprint) {
        return true;
    }
    recent.push((timestamp, fingerprint));
    false
}

/// Route-only ACP blocks are transport metadata, not canonical user coverage.
/// Some codex-acp versions persist each text block as its own `user_message`;
/// letting that record mark coverage would suppress a later visible
/// `response_item` fallback in the same turn segment.
fn promotion_payload_type<'a>(msg_type: &str, value: &'a serde_json::Value) -> &'a str {
    let payload = value.get("payload");
    let payload_type = payload
        .and_then(|payload| payload.get("type"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if msg_type == "event_msg" && payload_type == "user_message" {
        let route_only = payload
            .and_then(|payload| payload.get("message"))
            .and_then(serde_json::Value::as_str)
            .is_some_and(contains_only_internal_agent_routes);
        let has_images = payload
            .and_then(|payload| payload.get("images"))
            .and_then(serde_json::Value::as_array)
            .is_some_and(|images| !images.is_empty());
        if route_only && !has_images {
            return "";
        }
    }
    payload_type
}

/// Canonical-channel coverage for one turn segment.
#[derive(Debug, Default, Clone, Copy)]
struct SegmentCoverage {
    user: bool,
    assistant: bool,
}

/// Bookkeeping for one held-back `response_item.message` record.
#[derive(Debug, Clone, Copy)]
struct PromotionCandidate {
    /// Per-record counter. The ONLY safe key for "did this come before the
    /// goal / before the title claim": several candidates can share one
    /// insertion point in `messages`, so vector positions cannot order them.
    ordinal: u64,
    task_seg: usize,
    ctx_seg: usize,
    is_user: bool,
    /// Set by the compaction-adjacency rule after the record was accepted.
    denied: bool,
}

/// A held-back `response_item.message`, kept parallel to
/// [`ResponseItemPromotion::candidates`] so one shared decision drives both.
#[derive(Debug)]
struct PendingPromotedMessage {
    /// Where in `messages` this record would have been pushed. Valid only until
    /// something else mutates `messages`, which is why the splice runs first in
    /// the post-loop sequence.
    insert_at: usize,
    is_user: bool,
    blocks: Vec<ContentBlock>,
    timestamp: DateTime<Utc>,
    /// Title this record would claim if it turns out to be the opening prompt.
    /// `None` for assistants, and for a user whose text is not title-worthy.
    title_candidate: Option<String>,
}

/// Decides which `response_item.payload.type == "message"` records may be
/// promoted into the transcript.
///
/// # Why this exists
///
/// Every message codex writes to a rollout is recorded TWICE: once on the
/// canonical event channel (`event_msg.user_message` / `event_msg.agent_message`)
/// and once as a `response_item` for the model's own history. This parser has
/// always read the event channel and ignored the `response_item` twin, which is
/// correct — until a producer writes a rollout with no event channel at all
/// (issue #452: a session created by an embedder that sets its own `CODEX_HOME`).
/// Then the tool calls still parse from `response_item.function_call` while every
/// user and assistant bubble vanishes, and the conversation renders as a bare
/// "Used N tools".
///
/// # Why the gate is per-segment
///
/// The obvious rules both fail:
///
/// * *Per record, when no same-text twin exists* — 101 assistant records across
///   60 files in the local corpus have no twin, and they are all `<proposed_plan>`
///   blocks and compaction summaries, i.e. text codex deliberately keeps out of
///   the chat. That rule regresses 60 existing conversations.
/// * *Per file, when the event channel is absent anywhere* — this is inert on the
///   corpus, but it evaporates the moment the user resumes the session in codeg:
///   native `event_msg` records append to the SAME rollout, the gate flips off,
///   and the whole imported prefix disappears again. That is exactly the workflow
///   #452 reports.
///
/// So coverage is tracked per turn segment and per role: a `response_item`
/// message is promoted only where the event channel never spoke for its role in
/// its own turn. A resumed mixed file keeps the imported prefix AND the native
/// suffix, each exactly once.
///
/// Verified inert: 0 promotions across all ~2.7k rollouts in the local corpus.
#[derive(Debug)]
struct ResponseItemPromotion {
    ordinal: u64,
    /// Coverage under each segmentation. Both are accumulated because which one
    /// applies is only known at EOF (see [`Self::resolve`]).
    task_segments: Vec<SegmentCoverage>,
    ctx_segments: Vec<SegmentCoverage>,
    saw_task_started: bool,
    candidates: Vec<PromotionCandidate>,
    /// Index of the assistant candidate that is still a compaction-summary
    /// suspect — i.e. nothing but `token_count` has been seen since it.
    compaction_watch: Option<usize>,
}

impl ResponseItemPromotion {
    fn new() -> Self {
        Self {
            ordinal: 0,
            task_segments: vec![SegmentCoverage::default()],
            ctx_segments: vec![SegmentCoverage::default()],
            saw_task_started: false,
            candidates: Vec::new(),
            compaction_watch: None,
        }
    }

    /// Feed one parsed rollout record, BEFORE the parser's own handling of it.
    /// Returns the record's ordinal.
    fn note_record(&mut self, msg_type: &str, payload_type: &str) -> u64 {
        self.ordinal += 1;

        // Compaction adjacency. codex writes the pre-compaction handoff summary
        // as an assistant message immediately followed by the `compacted`
        // record, with at most a `token_count` between them. Denying by
        // adjacency rather than "anywhere in this segment" matters: a rollout
        // with no turn markers collapses into ONE segment, so a segment-wide
        // rule would let a single compaction erase an entire imported prefix.
        match (msg_type, payload_type) {
            // Transparent — keeps the suspect under watch.
            ("event_msg", "token_count") => {}
            ("compacted", _) | ("event_msg", "context_compacted") => {
                if let Some(index) = self.compaction_watch.take() {
                    self.candidates[index].denied = true;
                }
            }
            _ => self.compaction_watch = None,
        }

        // Segment boundaries. `task_started` fires exactly once per turn;
        // `turn_context` is the weaker fallback because newer codex re-emits it
        // MID-turn (same trade-off, same precedent as `backfill_turn_durations`).
        if msg_type == "event_msg" && payload_type == "task_started" {
            self.saw_task_started = true;
            self.task_segments.push(SegmentCoverage::default());
        } else if msg_type == "turn_context" {
            self.ctx_segments.push(SegmentCoverage::default());
        }

        // Canonical-channel coverage — "did the event channel already speak for
        // this role in this turn?".
        //
        // `thread_goal_updated` counts as USER input: newer codex consumes a
        // typed `/goal <objective>` as a slash command and records it as this
        // event INSTEAD of a `user_message`, and both parsers already synthesize
        // the opening user turn from it. Without this, the `response_item` twin
        // of that same prompt would be promoted alongside the synthesized turn
        // and the opener would render twice.
        //
        // Deliberately not narrowed to an opening `create_goal` (which would
        // mean threading the payload in and re-running `goal_marker`): a
        // `goal: null` clear is ALSO something the user typed, and a
        // terminal-status update is not, but suppressing a promotion after one
        // needs a turn that carries a goal event yet no `user_message` — i.e. a
        // rollout that HAS the event channel, which is exactly where promotion
        // is not needed. Accepted, not overlooked.
        //
        // Notably absent: `item_completed`. It has no parsing arm here, so
        // treating it as coverage would suppress a candidate and render nothing
        // in its place.
        let (user, assistant) = match (msg_type, payload_type) {
            ("event_msg", "user_message") | ("event_msg", "thread_goal_updated") => (true, false),
            ("event_msg", "agent_message") => (false, true),
            _ => (false, false),
        };
        if user || assistant {
            for segments in [&mut self.task_segments, &mut self.ctx_segments] {
                if let Some(current) = segments.last_mut() {
                    current.user |= user;
                    current.assistant |= assistant;
                }
            }
        }

        self.ordinal
    }

    /// Register a record the caller has already accepted (role allowlisted,
    /// deny-lists passed, blocks non-empty). Returns its candidate index, which
    /// is also its index into the caller's own parallel payload vector.
    fn push_candidate(&mut self, ordinal: u64, is_user: bool) -> usize {
        let index = self.candidates.len();
        self.candidates.push(PromotionCandidate {
            ordinal,
            task_seg: self.task_segments.len() - 1,
            ctx_seg: self.ctx_segments.len() - 1,
            is_user,
            denied: false,
        });
        if !is_user {
            self.compaction_watch = Some(index);
        }
        index
    }

    /// Which candidates survive, as a mask parallel to `candidates` (and to the
    /// caller's payload vector). Callable only at EOF — the segmentation choice
    /// depends on whether the whole file ever produced a `task_started`.
    fn resolve(&self) -> Vec<bool> {
        self.candidates
            .iter()
            .map(|candidate| {
                if candidate.denied {
                    return false;
                }
                let coverage = if self.saw_task_started {
                    self.task_segments[candidate.task_seg]
                } else {
                    self.ctx_segments[candidate.ctx_seg]
                };
                if candidate.is_user {
                    !coverage.user
                } else {
                    !coverage.assistant
                }
            })
            .collect()
    }

    /// Ordinal of the earliest surviving user candidate, used to replay the
    /// positional `/goal`-opener and title decisions the in-loop code made
    /// before these records were known.
    fn first_surviving_user_ordinal(&self, survivors: &[bool]) -> Option<u64> {
        self.candidates
            .iter()
            .zip(survivors)
            .filter(|(candidate, kept)| **kept && candidate.is_user)
            .map(|(candidate, _)| candidate.ordinal)
            .min()
    }
}

/// Pull renderable blocks out of a `response_item.payload` of type `message`,
/// deliberately WITHOUT keying on each content item's `type` tag.
///
/// codex's item vocabulary keeps growing upstream, and this path only ever runs
/// for a rollout whose canonical channel is missing — the one situation where
/// guessing the tag wrong costs the user the entire transcript. So `input_image`
/// gets its handling and everything else carrying a string `text` is taken as
/// text (`output_text`, `input_text`, `text`, `summary_text`, …); an item with
/// neither is skipped rather than voiding the record.
///
/// `strip_blocked_resource_mentions` is applied to user text only. It collapses
/// runs of whitespace, which is right for a typed prompt (and is what the
/// `event_msg.user_message` arm does) but would mangle indentation in assistant
/// markdown — the `event_msg.agent_message` arm passes its text through
/// verbatim, and this must match it.
fn extract_response_item_message_blocks(
    payload: &serde_json::Value,
    is_user: bool,
) -> Option<Vec<ContentBlock>> {
    let content = payload.get("content")?;

    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();

    match content {
        serde_json::Value::String(text) => text_parts.push(text.clone()),
        serde_json::Value::Array(items) => {
            for item in items {
                if item.get("type").and_then(|v| v.as_str()) == Some("input_image") {
                    if let Some((mime_type, data)) = parse_input_image_data_uri(item) {
                        blocks.push(ContentBlock::Image {
                            data,
                            mime_type,
                            uri: None,
                        });
                    }
                    continue;
                }
                let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                if text.is_empty() || text.trim() == "<image>" {
                    continue;
                }
                text_parts.push(text.to_string());
            }
        }
        _ => return None,
    }

    let joined = text_parts.join("\n");
    let text = if is_user {
        strip_blocked_resource_mentions(&joined)
    } else {
        joined
    };
    if !text.trim().is_empty() {
        blocks.insert(0, ContentBlock::Text { text });
    }

    if blocks.is_empty() {
        None
    } else {
        Some(blocks)
    }
}

/// Whether a `response_item` user message carries an `input_image` — the exact
/// condition under which [`extract_response_item_user_image_blocks`] yields a
/// real user turn in the detail parser. The lightweight summary parser uses this
/// to detect the same real-user-turn so its pure-`/goal` fallback stays in sync.
fn response_item_user_has_image(payload: &serde_json::Value) -> bool {
    payload
        .get("content")
        .and_then(|c| c.as_array())
        .is_some_and(|items| {
            items.iter().any(|item| {
                item.get("type").and_then(|v| v.as_str()) == Some("input_image")
            })
        })
}

fn extract_response_item_user_image_blocks(
    payload: &serde_json::Value,
) -> Option<Vec<ContentBlock>> {
    let content = payload.get("content")?.as_array()?;
    let mut blocks: Vec<ContentBlock> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    let mut has_input_image = false;

    for item in content {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        match item_type {
            "input_text" => {
                let Some(text) = item.get("text").and_then(|v| v.as_str()) else {
                    continue;
                };
                if text.trim() == "<image>" {
                    continue;
                }
                if !text.is_empty() {
                    text_parts.push(text.to_string());
                }
            }
            "input_image" => {
                has_input_image = true;
                let Some((mime_type, data)) = parse_input_image_data_uri(item) else {
                    continue;
                };
                blocks.push(ContentBlock::Image {
                    data,
                    mime_type,
                    uri: None,
                });
            }
            _ => {}
        }
    }

    if !has_input_image {
        return None;
    }

    let text = strip_blocked_resource_mentions(&text_parts.join("\n"));
    if !text.is_empty() {
        blocks.insert(0, ContentBlock::Text { text });
    }

    if blocks.is_empty() {
        blocks.push(ContentBlock::Text {
            text: "Attached resources".to_string(),
        });
    }

    Some(blocks)
}

fn strip_blocked_resource_mentions(input: &str) -> String {
    let blocked_re = Regex::new(r"@([^\s@]+)\s*\[blocked[^\]]*\]").expect("valid blocked regex");
    let image_tag_re = Regex::new(r"(?i)</?image\s*/?>").expect("valid image tag regex");
    let collapsed_ws_re = Regex::new(r"[ \t]{2,}").expect("valid whitespace regex");
    let visible = strip_internal_agent_routes(input);
    let text = blocked_re.replace_all(&visible, "").to_string();
    let text = image_tag_re.replace_all(&text, "").to_string();
    let text = collapsed_ws_re.replace_all(&text, " ").to_string();
    text.trim().to_string()
}

/// Group flat messages into conversation turns.
/// Codex rule: consecutive Assistant + Tool messages merge into one Assistant turn.
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
            // Assistant or Tool — start a group
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

#[cfg(test)]
mod tests {

    /// An empty, readable sessions dir is a successful empty presence set —
    /// callers may prune. An unreadable dir must return Err so callers skip
    /// prune instead of treating the failure as "zero rollouts".
    #[test]
    fn present_session_ids_distinguishes_empty_from_unreadable() {
        let temp_dir = tempfile::tempdir().expect("temp");
        let sessions_dir = temp_dir.path().join("sessions");
        fs::create_dir_all(&sessions_dir).expect("sessions");
        let parser = CodexParser::with_base_dir(sessions_dir.clone());
        assert!(
            parser
                .present_session_ids()
                .expect("readable empty dir")
                .is_empty()
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&sessions_dir, fs::Permissions::from_mode(0o000))
                .expect("chmod");
            let result = CodexParser::with_base_dir(sessions_dir.clone()).present_session_ids();
            // Restore so tempfile cleanup can remove the dir.
            fs::set_permissions(&sessions_dir, fs::Permissions::from_mode(0o755))
                .expect("chmod restore");
            assert!(
                result.is_err(),
                "unreadable sessions dir must not look like an empty successful walk"
            );
        }
    }

    #[test]
    fn present_session_ids_uses_thread_ids_for_reverted_and_archived_rollouts() {
        let temp_dir = tempfile::tempdir().expect("temp");
        let sessions = temp_dir.path().join("sessions");
        let archived = temp_dir.path().join("archived_sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&archived).unwrap();
        let thread_id = "11111111-1111-4111-8111-111111111111";
        let rollout_id = "22222222-2222-4222-8222-222222222222";
        let archived_id = "33333333-3333-4333-8333-333333333333";
        fs::write(sessions.join(format!("rollout-2026-09-28T10-00-00-{thread_id}_{rollout_id}.jsonl")), "").unwrap();
        fs::write(archived.join(format!("rollout-2026-09-27T10-00-00-{archived_id}.json")), "").unwrap();
        let present = CodexParser::with_base_dir(sessions).present_session_ids().unwrap();
        assert_eq!(present, HashSet::from([thread_id.to_string(), archived_id.to_string()]));
        assert!(!present.contains(rollout_id));
    }

    /// codex-acp 1.8.0 forks BY REFERENCE: the child's rollout carries no
    /// history, only `forked_from_id` + `forked_from_ordinal_exclusive`. Read
    /// alone it parses to zero turns, which is what put "this session has no
    /// messages" under every `[Fork] …` row. The parent's stream below the cut
    /// has to be spliced in.
    #[test]
    fn a_by_reference_fork_inherits_the_parent_history_up_to_the_cut() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let rollout_dir = sessions_dir.join("2026").join("09").join("02");
        fs::create_dir_all(&rollout_dir).expect("create rollout dir");

        let parent_id = "01a06222-7b39-7521-8ad1-e3d114374095";
        let child_id = "01a06227-c220-7302-b0ee-6c296c1cacd1";

        let user = |ord: u64, text: &str| {
            serde_json::json!({
                "timestamp": "2026-09-02T12:40:22Z",
                "ordinal": ord,
                "type": "event_msg",
                "payload": {"type": "user_message", "message": text}
            })
            .to_string()
        };

        fs::write(
            rollout_dir.join(format!("rollout-2026-09-02T20-40-22-{parent_id}.jsonl")),
            format!(
                "{}\n",
                [
                    serde_json::json!({
                        "timestamp": "2026-09-02T12:40:22Z",
                        "ordinal": 0,
                        "type": "session_meta",
                        "payload": {"id": parent_id, "cwd": "/tmp/work"}
                    })
                    .to_string(),
                    user(1, "kept: before the cut"),
                    // Past the cut — the fork point was chosen before this turn,
                    // so the child must NOT inherit it.
                    user(2, "dropped: after the cut"),
                ]
                .join("\n")
            ),
        )
        .expect("write parent");

        fs::write(
            rollout_dir.join(format!("rollout-2026-09-02T20-46-07-{child_id}.jsonl")),
            format!(
                "{}\n",
                [
                    serde_json::json!({
                        "timestamp": "2026-09-02T12:46:07Z",
                        "ordinal": 2,
                        "type": "session_meta",
                        "payload": {
                            "id": child_id,
                            "cwd": "/tmp/work",
                            "forked_from_id": parent_id,
                            "forked_from_ordinal_exclusive": 2
                        }
                    })
                    .to_string(),
                    user(3, "the child's own turn"),
                ]
                .join("\n")
            ),
        )
        .expect("write child");

        let parser = CodexParser::with_base_dir(sessions_dir);
        let detail = parser
            .get_conversation(child_id)
            .expect("forked conversation parses");
        let texts: Vec<String> = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect();

        assert_eq!(
            texts,
            vec![
                "kept: before the cut".to_string(),
                "the child's own turn".to_string(),
            ],
            "inherited history stops at the cut and the child's own turn follows"
        );
    }

    /// The OLD fork shape replays the parent inline and carries no
    /// `forked_from_ordinal_exclusive`. Splicing there would show every
    /// inherited turn twice, so the pointer alone must not trigger it.
    #[test]
    fn an_inline_replayed_fork_is_not_spliced_again() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let rollout_dir = sessions_dir.join("2026").join("04").join("17");
        fs::create_dir_all(&rollout_dir).expect("create rollout dir");

        let parent_id = "019d995a-347d-7072-a2ec-66646d41b05b";
        let child_id = "019d995a-89cf-7190-8358-1ab96226c173";

        let user = |text: &str| {
            serde_json::json!({
                "timestamp": "2026-04-17T10:52:20Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": text}
            })
            .to_string()
        };

        fs::write(
            rollout_dir.join(format!("rollout-2026-04-17T10-52-00-{parent_id}.jsonl")),
            format!(
                "{}\n",
                [
                    serde_json::json!({
                        "timestamp": "2026-04-17T10:52:00Z",
                        "type": "session_meta",
                        "payload": {"id": parent_id, "cwd": "/tmp/work"}
                    })
                    .to_string(),
                    user("inherited once"),
                ]
                .join("\n")
            ),
        )
        .expect("write parent");

        // Child header, then the parent replayed inline, then its own turn —
        // codex's own on-disk order for this shape.
        fs::write(
            rollout_dir.join(format!("rollout-2026-04-17T10-52-20-{child_id}.jsonl")),
            format!(
                "{}\n",
                [
                    serde_json::json!({
                        "timestamp": "2026-04-17T10:52:20Z",
                        "type": "session_meta",
                        "payload": {
                            "id": child_id,
                            "cwd": "/tmp/work",
                            "forked_from_id": parent_id
                        }
                    })
                    .to_string(),
                    serde_json::json!({
                        "timestamp": "2026-04-17T10:52:00Z",
                        "type": "session_meta",
                        "payload": {"id": parent_id, "cwd": "/tmp/work"}
                    })
                    .to_string(),
                    user("inherited once"),
                    user("the child's own turn"),
                ]
                .join("\n")
            ),
        )
        .expect("write child");

        let parser = CodexParser::with_base_dir(sessions_dir);
        let detail = parser
            .get_conversation(child_id)
            .expect("forked conversation parses");
        let inherited = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter(|b| matches!(b, ContentBlock::Text { text } if text == "inherited once"))
            .count();
        assert_eq!(inherited, 1, "the inline replay must not be doubled");
    }

    /// One paginated rollout record, shaped exactly as codex writes it.
    fn paginated_line(ts: &str, ord: u64, msg_type: &str, payload: serde_json::Value) -> String {
        serde_json::json!({"timestamp": ts, "ordinal": ord, "type": msg_type, "payload": payload})
            .to_string()
    }

    fn event_line(ts: &str, ord: u64, payload: serde_json::Value) -> String {
        paginated_line(ts, ord, "event_msg", payload)
    }

    /// `thread/revert` output, byte for byte in the shape codex writes it: the
    /// thread's original rollout is left intact, and a NEW file named
    /// `rollout-<ts>-<thread>_<rollout>.jsonl` — same `id` / `session_id` inside —
    /// declares `history_base`, the prefix of the original it keeps. Its own
    /// ordinals resume AT the cut, so they collide with the abandoned tail's.
    ///
    /// Here turn 2 was interrupted and the user sent the prompt again: the
    /// revert cut sits at turn 2's `task_started` (ordinal 5).
    fn reverted_thread_fixture(sessions_dir: &Path, thread_id: &str, rollout_id: &str) {
        let rollout_dir = sessions_dir.join("2026").join("09").join("20");
        fs::create_dir_all(&rollout_dir).expect("create rollout dir");

        let original = [
            paginated_line(
                "2026-09-20T02:00:00.000Z",
                0,
                "session_meta",
                serde_json::json!({
                    "id": thread_id,
                    "session_id": thread_id,
                    "timestamp": "2026-09-20T02:00:00.000Z",
                    "cwd": "/tmp/work",
                    "originator": "Codex Desktop",
                    "cli_version": "0.147.0-alpha.6.6",
                    "history_mode": "paginated"
                }),
            ),
            event_line(
                "2026-09-20T02:00:01.000Z",
                1,
                serde_json::json!({"type": "task_started", "turn_id": "turn-1"}),
            ),
            event_line(
                "2026-09-20T02:00:01.100Z",
                2,
                serde_json::json!({"type": "user_message", "message": "first prompt"}),
            ),
            event_line(
                "2026-09-20T02:00:05.000Z",
                3,
                serde_json::json!({"type": "agent_message", "message": "first answer"}),
            ),
            event_line(
                "2026-09-20T02:00:05.100Z",
                4,
                serde_json::json!({"type": "task_complete", "turn_id": "turn-1"}),
            ),
            // Turn 2, abandoned by the revert.
            event_line(
                "2026-09-20T02:01:00.000Z",
                5,
                serde_json::json!({"type": "task_started", "turn_id": "turn-2"}),
            ),
            event_line(
                "2026-09-20T02:01:00.100Z",
                6,
                serde_json::json!({"type": "user_message", "message": "second prompt"}),
            ),
            event_line(
                "2026-09-20T02:01:03.000Z",
                7,
                serde_json::json!({"type": "agent_message", "message": "abandoned partial answer"}),
            ),
            event_line(
                "2026-09-20T02:01:04.000Z",
                8,
                serde_json::json!({"type": "turn_aborted", "turn_id": "turn-2", "reason": "interrupted"}),
            ),
        ];
        let cut = 5;
        // Byte offset immediately after the last kept record — the file is
        // written `\n`-separated below, so each record costs its length + 1.
        let end_byte_offset: usize = original[..cut].iter().map(|line| line.len() + 1).sum();
        fs::write(
            rollout_dir.join(format!("rollout-2026-09-20T10-00-00-{thread_id}.jsonl")),
            format!("{}\n", original.join("\n")),
        )
        .expect("write original rollout");

        let replacement = [
            paginated_line(
                "2026-09-20T02:05:00.000Z",
                cut as u64,
                "session_meta",
                serde_json::json!({
                    "id": thread_id,
                    "session_id": thread_id,
                    "timestamp": "2026-09-20T02:05:00.000Z",
                    "cwd": "/tmp/work",
                    "originator": "Codex Desktop",
                    "cli_version": "0.154.0-alpha.6.2",
                    "history_mode": "paginated",
                    "history_base": {
                        "thread_id": thread_id,
                        "end_ordinal_exclusive": cut,
                        "end_byte_offset": end_byte_offset
                    }
                }),
            ),
            event_line(
                "2026-09-20T02:05:01.000Z",
                6,
                serde_json::json!({"type": "task_started", "turn_id": "turn-3"}),
            ),
            event_line(
                "2026-09-20T02:05:01.100Z",
                7,
                serde_json::json!({"type": "user_message", "message": "second prompt"}),
            ),
            event_line(
                "2026-09-20T02:05:09.000Z",
                8,
                serde_json::json!({"type": "agent_message", "message": "complete answer"}),
            ),
            event_line(
                "2026-09-20T02:05:09.100Z",
                9,
                serde_json::json!({"type": "task_complete", "turn_id": "turn-3"}),
            ),
        ];
        fs::write(
            rollout_dir.join(format!(
                "rollout-2026-09-20T10-05-00-{thread_id}_{rollout_id}.jsonl"
            )),
            format!("{}\n", replacement.join("\n")),
        )
        .expect("write replacement rollout");
    }

    fn rendered_texts(detail: &ConversationDetail) -> Vec<String> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// A reverted thread renders the prefix its CURRENT rollout inherits, then
    /// that rollout's own continuation — not the original file (stale, and
    /// still carrying the abandoned turn), and not the new file alone (which
    /// holds no history before the cut).
    #[test]
    fn a_reverted_thread_renders_its_inherited_prefix_then_the_continuation() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread_id = "01a0c3d4-1111-7aaa-8bbb-000000000001";
        reverted_thread_fixture(
            &sessions_dir,
            thread_id,
            "01a0c3d9-2222-7ccc-8ddd-000000000002",
        );

        let parser = CodexParser::with_base_dir(sessions_dir);
        let detail = parser
            .get_conversation(thread_id)
            .expect("reverted conversation parses");

        assert_eq!(
            rendered_texts(&detail),
            vec![
                "first prompt".to_string(),
                "first answer".to_string(),
                "second prompt".to_string(),
                "complete answer".to_string(),
            ],
            "inherited turn once, the abandoned tail dropped, the continuation after it"
        );
        assert_eq!(detail.summary.id, thread_id);
    }

    /// Both rollouts of a reverted thread carry its id, but only the current
    /// one is the conversation: the list shows the thread once, counted and
    /// titled from its effective history.
    #[test]
    fn a_reverted_thread_lists_once_from_its_current_rollout() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread_id = "01a0c3d4-3333-7aaa-8bbb-000000000003";
        reverted_thread_fixture(
            &sessions_dir,
            thread_id,
            "01a0c3d9-4444-7ccc-8ddd-000000000004",
        );

        let parser = CodexParser::with_base_dir(sessions_dir);
        let summaries = parser.list_conversations().expect("list conversations");

        assert_eq!(
            summaries.iter().filter(|s| s.id == thread_id).count(),
            1,
            "the superseded rollout is not a conversation of its own"
        );
        let summary = &summaries[0];
        assert_eq!(summary.message_count, 4);
        assert_eq!(summary.title.as_deref(), Some("first prompt"));
        // The superseded rollout alone counts four and titles the same — its
        // abandoned answer stands in for the continuation's — so only where
        // the history ends tells the two apart.
        assert_eq!(
            summary.ended_at,
            Some(
                "2026-09-20T02:05:09.100Z"
                    .parse::<DateTime<Utc>>()
                    .expect("timestamp")
            ),
            "listed from the current rollout, not the superseded one"
        );
    }

    /// A prompt at `ord` — one text block once rendered.
    fn prompt_line(ord: u64, text: &str) -> String {
        event_line(
            &format!("2026-09-21T02:00:{ord:02}.000Z"),
            ord,
            serde_json::json!({"type": "user_message", "message": text}),
        )
    }

    /// `thread`'s header at `ord`, merged with `extra` (its pointers).
    fn header_line(ord: u64, thread: &str, extra: serde_json::Value) -> String {
        let mut payload = serde_json::json!({
            "id": thread,
            "session_id": thread,
            "cwd": "/tmp/work",
            "history_mode": "paginated"
        });
        let fields = payload.as_object_mut().expect("payload object");
        for (key, value) in extra.as_object().expect("extra object") {
            fields.insert(key.clone(), value.clone());
        }
        paginated_line(
            &format!("2026-09-21T02:00:{ord:02}.000Z"),
            ord,
            "session_meta",
            payload,
        )
    }

    /// A `history_base` naming `base` (the rollout `rollout_id`'s lines) up to
    /// `cut`, with the byte offset codex would record for it.
    fn history_base(rollout_id: &str, base: &[String], cut: u64) -> serde_json::Value {
        let end_byte_offset: usize = base
            .iter()
            .take_while(|line| codex_line_ordinal(line).is_some_and(|ord| ord < cut))
            .map(|line| line.len() + 1)
            .sum();
        serde_json::json!({
            "thread_id": rollout_id,
            "end_ordinal_exclusive": cut,
            "end_byte_offset": end_byte_offset
        })
    }

    fn write_rollout(sessions_dir: &Path, file_name: &str, lines: &[String]) {
        let dir = sessions_dir.join("2026").join("09").join("21");
        fs::create_dir_all(&dir).expect("create rollout dir");
        fs::write(dir.join(file_name), format!("{}\n", lines.join("\n"))).expect("write rollout");
    }

    /// Every revert adds a rollout, and a revert inside the previous revert's
    /// own turns points at THAT rollout — so a thread edited twice is three
    /// files deep, and each keeps only its part.
    #[test]
    fn a_thread_reverted_twice_keeps_each_rollouts_part() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread = "01a0e000-0000-7000-8000-000000000001";
        let first_revert = "01a0e001-0000-7000-8000-000000000002";
        let second_revert = "01a0e002-0000-7000-8000-000000000003";

        let original = vec![
            header_line(0, thread, serde_json::json!({})),
            prompt_line(1, "a1"),
            prompt_line(2, "a2"),
            prompt_line(3, "a3, dropped by the first revert"),
        ];
        let first = vec![
            header_line(
                3,
                thread,
                serde_json::json!({"history_base": history_base(thread, &original, 3)}),
            ),
            prompt_line(4, "b4"),
            prompt_line(5, "b5, dropped by the second revert"),
        ];
        let second = vec![
            header_line(
                5,
                thread,
                serde_json::json!({"history_base": history_base(first_revert, &first, 5)}),
            ),
            prompt_line(6, "c6"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-00-00-{thread}.jsonl"),
            &original,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{thread}_{first_revert}.jsonl"),
            &first,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-02-00-{thread}_{second_revert}.jsonl"),
            &second,
        );

        let parser = CodexParser::with_base_dir(sessions_dir);
        let detail = parser
            .get_conversation(thread)
            .expect("reverted thread parses");
        assert_eq!(rendered_texts(&detail), vec!["a1", "a2", "b4", "c6"]);

        let summaries = parser.list_conversations().expect("list conversations");
        assert_eq!(summaries.len(), 1, "three rollouts, one thread");
        assert_eq!(summaries[0].message_count, 4);
    }

    /// A revert further back than the previous revert's first turn points past
    /// that rollout, straight at the original: the rollout in between is
    /// discarded whole.
    #[test]
    fn a_revert_behind_an_earlier_revert_discards_that_rollout() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread = "01a0e100-0000-7000-8000-000000000001";
        let first_revert = "01a0e101-0000-7000-8000-000000000002";
        let second_revert = "01a0e102-0000-7000-8000-000000000003";

        let original = vec![
            header_line(0, thread, serde_json::json!({})),
            prompt_line(1, "a1"),
            prompt_line(2, "a2, dropped by the second revert"),
            prompt_line(3, "a3, dropped by the first revert"),
        ];
        let first = vec![
            header_line(
                3,
                thread,
                serde_json::json!({"history_base": history_base(thread, &original, 3)}),
            ),
            prompt_line(4, "b4, dropped with its whole rollout"),
        ];
        let second = vec![
            header_line(
                2,
                thread,
                serde_json::json!({"history_base": history_base(thread, &original, 2)}),
            ),
            prompt_line(3, "c3"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-00-00-{thread}.jsonl"),
            &original,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{thread}_{first_revert}.jsonl"),
            &first,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-02-00-{thread}_{second_revert}.jsonl"),
            &second,
        );

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(thread)
            .expect("reverted thread parses");
        assert_eq!(rendered_texts(&detail), vec!["a1", "c3"]);
    }

    /// A fork of a reverted thread points at the rollout the parent was using
    /// when it forked — its revert, not the original that still carries the
    /// parent's thread id in its filename and the turns the revert dropped.
    #[test]
    fn a_fork_of_a_reverted_thread_inherits_the_history_it_was_cut_from() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let parent = "01a0e200-0000-7000-8000-000000000001";
        let parent_revert = "01a0e201-0000-7000-8000-000000000002";
        let child = "01a0e202-0000-7000-8000-000000000003";

        let original = vec![
            header_line(0, parent, serde_json::json!({})),
            prompt_line(1, "p1"),
            prompt_line(2, "p2, dropped by the parent's revert"),
        ];
        let reverted = vec![
            header_line(
                2,
                parent,
                serde_json::json!({"history_base": history_base(parent, &original, 2)}),
            ),
            prompt_line(3, "p3"),
            prompt_line(4, "p4, after the fork point"),
        ];
        let forked = vec![
            header_line(
                4,
                child,
                serde_json::json!({
                    "forked_from_id": parent,
                    "forked_from_ordinal_exclusive": 4,
                    "history_base": history_base(parent_revert, &reverted, 4)
                }),
            ),
            prompt_line(5, "c5"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-00-00-{parent}.jsonl"),
            &original,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{parent}_{parent_revert}.jsonl"),
            &reverted,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-02-00-{child}.jsonl"),
            &forked,
        );

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(child)
            .expect("fork parses");
        assert_eq!(rendered_texts(&detail), vec!["p1", "p3", "c5"]);
        assert_eq!(detail.summary.id, child);
    }

    /// Reverting a fork keeps the fork's `forked_from_*` (its logical parent
    /// and cut) while `history_base` moves to the fork's own earlier rollout.
    /// Following the fork pointer instead would skip every turn the fork took
    /// before the revert.
    #[test]
    fn a_reverted_fork_keeps_its_own_turns_from_before_the_revert() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let parent = "01a0e300-0000-7000-8000-000000000001";
        let child = "01a0e301-0000-7000-8000-000000000002";
        let child_revert = "01a0e302-0000-7000-8000-000000000003";

        let parent_lines = vec![
            header_line(0, parent, serde_json::json!({})),
            prompt_line(1, "p1"),
            prompt_line(2, "p2, after the fork point"),
        ];
        let fork = |base: serde_json::Value| {
            serde_json::json!({
                "forked_from_id": parent,
                "forked_from_ordinal_exclusive": 2,
                "history_base": base
            })
        };
        let forked = vec![
            header_line(2, child, fork(history_base(parent, &parent_lines, 2))),
            prompt_line(3, "c3"),
            prompt_line(4, "c4, dropped by the revert"),
        ];
        let reverted = vec![
            header_line(4, child, fork(history_base(child, &forked, 4))),
            prompt_line(5, "c5"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-00-00-{parent}.jsonl"),
            &parent_lines,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{child}.jsonl"),
            &forked,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-02-00-{child}_{child_revert}.jsonl"),
            &reverted,
        );

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(child)
            .expect("reverted fork parses");
        assert_eq!(rendered_texts(&detail), vec!["p1", "c3", "c5"]);
    }

    /// Older forks carry `history_base` without `forked_from_ordinal_exclusive`
    /// (codex's own reader still derives the cut from `history_base` for them).
    #[test]
    fn a_fork_pointing_only_through_history_base_inherits_its_parent() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let parent = "01a0e400-0000-7000-8000-000000000001";
        let child = "01a0e401-0000-7000-8000-000000000002";

        let parent_lines = vec![
            header_line(0, parent, serde_json::json!({})),
            prompt_line(1, "p1"),
            prompt_line(2, "p2, after the fork point"),
        ];
        let forked = vec![
            header_line(
                2,
                child,
                serde_json::json!({
                    "forked_from_id": parent,
                    "history_base": history_base(parent, &parent_lines, 2)
                }),
            ),
            prompt_line(3, "c3"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-00-00-{parent}.jsonl"),
            &parent_lines,
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{child}.jsonl"),
            &forked,
        );

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(child)
            .expect("fork parses");
        assert_eq!(rendered_texts(&detail), vec!["p1", "c3"]);
    }

    /// Nothing caps the chain: a thread edited over and over is a long lineage,
    /// and dropping its root would lose the start of the conversation.
    #[test]
    fn a_long_revert_lineage_is_followed_to_its_root() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread = "01a0e500-0000-7000-8000-000000000000";
        let reverts = 12;

        let mut expected = Vec::new();
        let mut previous: Option<(String, Vec<String>)> = None;
        for step in 0..=reverts {
            let header_ord = 2 * step;
            let rollout_id = if step == 0 {
                thread.to_string()
            } else {
                format!("01a0e5{step:02}-0000-7000-8000-000000000000")
            };
            let extra = match &previous {
                Some((base_id, base)) => {
                    serde_json::json!({"history_base": history_base(base_id, base, header_ord)})
                }
                None => serde_json::json!({}),
            };
            let kept = format!("kept {step}");
            let mut lines = vec![
                header_line(header_ord, thread, extra),
                prompt_line(header_ord + 1, &kept),
            ];
            expected.push(kept);
            if step < reverts {
                lines.push(prompt_line(header_ord + 2, &format!("dropped {step}")));
            }
            let file_name = if step == 0 {
                format!("rollout-2026-09-21T10-00-00-{thread}.jsonl")
            } else {
                format!("rollout-2026-09-21T10-{step:02}-00-{thread}_{rollout_id}.jsonl")
            };
            write_rollout(&sessions_dir, &file_name, &lines);
            previous = Some((rollout_id, lines));
        }

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(thread)
            .expect("long lineage parses");
        assert_eq!(rendered_texts(&detail), expected);
    }

    /// A pointer is resolved by the rollout id the filename encodes. With the
    /// original rollout gone, a pointer to it has nothing to resolve to — a
    /// substring match would find the revert itself, which carries the same
    /// thread id in its name.
    #[test]
    fn a_pointer_never_resolves_to_a_rollout_that_merely_shares_the_thread_id() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread = "01a0e600-0000-7000-8000-000000000001";
        let revert = "01a0e601-0000-7000-8000-000000000002";

        let reverted = vec![
            header_line(
                3,
                thread,
                serde_json::json!({"history_base": {
                    "thread_id": thread, "end_ordinal_exclusive": 3, "end_byte_offset": 512
                }}),
            ),
            prompt_line(4, "own turn"),
        ];
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{thread}_{revert}.jsonl"),
            &reverted,
        );

        let parser = CodexParser::with_base_dir(sessions_dir);
        assert_eq!(parser.find_rollout_by_rollout_id(thread), None);
        let detail = parser
            .get_conversation(thread)
            .expect("a revert whose original is gone still opens");
        assert_eq!(rendered_texts(&detail), vec!["own turn"]);
    }

    /// Malformed pointers that loop back end the chain instead of spinning.
    #[test]
    fn a_history_pointer_cycle_renders_what_it_reached() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread = "01a0e700-0000-7000-8000-000000000001";
        let older = "01a0e701-0000-7000-8000-000000000002";
        let newer = "01a0e702-0000-7000-8000-000000000003";
        let pointer = |rollout_id: &str, cut: u64| {
            serde_json::json!({"history_base": {
                "thread_id": rollout_id, "end_ordinal_exclusive": cut, "end_byte_offset": 0
            }})
        };

        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-01-00-{thread}_{older}.jsonl"),
            &[
                header_line(1, thread, pointer(newer, 1)),
                prompt_line(2, "older"),
            ],
        );
        write_rollout(
            &sessions_dir,
            &format!("rollout-2026-09-21T10-02-00-{thread}_{newer}.jsonl"),
            &[
                header_line(3, thread, pointer(older, 3)),
                prompt_line(4, "newer"),
            ],
        );

        let detail = CodexParser::with_base_dir(sessions_dir)
            .get_conversation(thread)
            .expect("a cyclic lineage still opens");
        assert_eq!(rendered_texts(&detail), vec!["older", "newer"]);
    }

    /// An inherited rollout that is there but fails to open fails the read, and
    /// nothing from that failure is remembered: once the file opens again the
    /// thread lists and renders whole. Rendering what was reached instead would
    /// have the summary cache, keyed on the unchanged current rollout, keep
    /// serving the truncated summary.
    #[cfg(unix)]
    #[test]
    fn an_inherited_rollout_that_fails_to_open_is_retried_not_remembered() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let sessions_dir = temp_dir.path().join("sessions");
        let thread_id = "01a0c3d4-5555-7aaa-8bbb-000000000005";
        reverted_thread_fixture(
            &sessions_dir,
            thread_id,
            "01a0c3d9-6666-7ccc-8ddd-000000000006",
        );
        let original = sessions_dir
            .join("2026")
            .join("09")
            .join("20")
            .join(format!("rollout-2026-09-20T10-00-00-{thread_id}.jsonl"));
        let aside = temp_dir.path().join("original.jsonl");
        fs::rename(&original, &aside).expect("move the original aside");
        // Still found under its name, but opening it fails — as root too.
        std::os::unix::fs::symlink(temp_dir.path().join("nowhere.jsonl"), &original)
            .expect("leave a dangling symlink in its place");

        let parser = CodexParser::with_base_dir(sessions_dir);
        assert!(parser.get_conversation(thread_id).is_err());
        assert!(parser
            .list_conversations()
            .expect("list conversations")
            .iter()
            .all(|s| s.id != thread_id));

        fs::remove_file(&original).expect("remove the symlink");
        fs::rename(&aside, &original).expect("put the original back");

        let summaries = parser.list_conversations().expect("list conversations");
        let summary = summaries
            .iter()
            .find(|s| s.id == thread_id)
            .expect("listed once the original opens");
        assert_eq!(summary.message_count, 4, "no truncated summary was cached");
        assert_eq!(
            rendered_texts(&parser.get_conversation(thread_id).expect("opens")),
            vec![
                "first prompt",
                "first answer",
                "second prompt",
                "complete answer"
            ]
        );
    }

    #[test]
    fn rollout_file_names_carry_the_thread_and_the_rollout_id() {
        let thread = "01a0e800-0000-7000-8000-000000000001";
        let revert = "01a0e801-0000-7000-8000-000000000002";
        let parsed = |name: String| {
            let path = PathBuf::from(name);
            RolloutFileName::parse(&path).map(|n| {
                (
                    n.timestamp.to_string(),
                    n.thread_id.to_string(),
                    n.rollout_id.to_string(),
                )
            })
        };

        assert_eq!(
            parsed(format!("rollout-2026-09-21T10-00-00-{thread}.jsonl")),
            Some(("2026-09-21T10-00-00".into(), thread.into(), thread.into()))
        );
        assert_eq!(
            parsed(format!(
                "rollout-2026-09-21T10-05-00-{thread}_{revert}.jsonl"
            )),
            Some(("2026-09-21T10-05-00".into(), thread.into(), revert.into()))
        );
        for name in [
            format!("rollout-2026-09-21T10-00-00-{thread}.jsonl.zst"),
            format!("rollout-2026-13-45T10-00-00-{thread}.jsonl"),
            format!("rollout-{thread}.jsonl"),
            format!("agent-{thread}.jsonl"),
            "rollout-2026-09-21T10-00-00-.jsonl".to_string(),
        ] {
            assert_eq!(parsed(name.clone()), None, "{name}");
        }
    }

    use std::collections::{HashMap, HashSet};

    use super::extract_codex_title_candidate;
    use super::extract_context_window_used_tokens_from_token_count_info;
    use super::extract_response_item_user_image_blocks;
    use super::extract_turn_usage_from_codex_usage;
    use super::codex_line_ordinal;
    use super::codex_parent_thread_id;
    use super::completed_mcp_call;
    use super::serialize_preview;
    use super::truncate_str;
    use super::BudgetedSink;
    use super::MCP_RESULT_FALLBACK_CAP;
    use super::is_encrypted_envelope;
    use super::is_promotable_user_text;
    use super::merge_codex_context_window_stats;
    use super::native_team_wait_input;
    use super::merge_codex_total_usage_stats;
    use super::parse_codex_subagent_stats;
    use super::redact_encrypted_args;
    use super::resolve_codex_home_dir_from;
    use super::trim_subagent_replay_prefix;
    use super::RolloutFileName;
    use super::CODEX_PLAN_APPROVAL_PROMPT;
    use super::CODEX_PLAN_APPROVED_OUTPUT;
    use super::CODEX_SUBAGENT_LAUNCH_KEY;
    use super::CODEX_SUBAGENT_STATE_KEY;
    use super::COLLAB_OP_KEY;
    use super::should_skip_duplicate_user_message;
    use super::strip_blocked_resource_mentions;
    use super::AgentParser;
    use super::CodexParser;
    use super::CODEX_SCRIPT_TOOL_NAME;
    use crate::models::{
        ContentBlock, MessageRole, MessageTurn, SessionStats, TurnRole, TurnUsage, UnifiedMessage,
    };
    use crate::parsers::ConversationDetail;
    use chrono::{DateTime, Duration, Utc};
    use std::env;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn write_index_title_fixture(
        conversation_id: &str,
    ) -> (tempfile::TempDir, CodexParser, PathBuf) {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let codex_home = temp_dir.path().join(".codex");
        let sessions_dir = codex_home.join("sessions");
        let rollout_dir = sessions_dir.join("2026").join("08").join("15");
        fs::create_dir_all(&rollout_dir).expect("create rollout dir");

        let rollout_path = rollout_dir.join(format!(
            "rollout-2026-08-15T16-00-00-{conversation_id}.jsonl"
        ));
        let lines = [
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": conversation_id, "cwd": "/tmp/Temp"}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "Makefile 文件的作用"}
            })
            .to_string(),
        ];
        fs::write(&rollout_path, format!("{}\n", lines.join("\n"))).expect("write rollout");

        let index_path = codex_home.join("session_index.jsonl");
        let parser = CodexParser::with_base_dir(sessions_dir);
        (temp_dir, parser, index_path)
    }

    /// `fork_turns` copies the PARENT's history into the child's head, and that
    /// copy carries the parent's own `session_meta` — on a real machine 23 of 46
    /// sub-agent rollouts hold a second header. That header declares no parent
    /// of its own, so reading `session_meta` last-record-wins clears the child's
    /// `parent_id` and the rollout lists as an importable root again. The FIRST
    /// header decides, exactly as `parse_codex_subagent_stats` already does via
    /// its `checked_header` latch.
    #[test]
    fn replayed_parent_header_does_not_clear_the_child_parent_id() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let child = "01a0098a-7e8a-72d3-b7c0-2df130c84063";
        let parent = "01a0098a-5c58-7000-8000-000000000001";
        let lines = [
            rollout_line(
                "2026-08-16T15:47:46Z",
                "session_meta",
                serde_json::json!({
                    "id": child,
                    "cwd": "/tmp/demo",
                    "source": {"subagent": {"thread_spawn": {"parent_thread_id": parent}}}
                }),
            ),
            // The replayed parent header, verbatim as codex writes it.
            rollout_line(
                "2026-08-16T15:47:46Z",
                "session_meta",
                serde_json::json!({"id": parent, "cwd": "/tmp/demo"}),
            ),
            rollout_line(
                "2026-08-16T15:47:47Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "child task"}),
            ),
        ];
        fs::write(
            temp_dir
                .path()
                .join(format!("rollout-2026-08-16T15-47-46-{child}.jsonl")),
            format!("{}\n", lines.join("\n")),
        )
        .expect("write rollout");

        let parser = CodexParser::with_base_dir(temp_dir.path().to_path_buf());
        let summaries = parser.list_conversations().expect("list conversations");
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].parent_id.as_deref(),
            Some(parent),
            "a replayed parent header must not clear the child's parent_id"
        );

        let detail = parser
            .get_conversation(child)
            .expect("load conversation detail");
        assert_eq!(detail.summary.parent_id.as_deref(), Some(parent));
    }

    /// A by-reference fork keeps its history in the parent file, so
    /// `rollout_lines` splices the parent's lines in — including the parent's
    /// own `session_meta`. Reading identity last-record-wins then files the
    /// CHILD's summary under the PARENT's id and cwd: two rollouts claiming one
    /// id, which the conversation list dedups down to one and the fork
    /// disappears. Every identity field latches on the first header, not just
    /// `parent_id`.
    #[test]
    fn spliced_parent_header_does_not_steal_the_forked_child_identity() {
        let temp_dir = tempfile::tempdir().expect("create temp dir");
        let parent = "01a0626c-c601-78f1-a13d-2b26dd168501";
        let child = "01a0626d-1e26-7853-8f86-02e0f57818a3";

        let parent_lines = [
            rollout_line(
                "2026-09-02T14:00:00Z",
                "session_meta",
                serde_json::json!({
                    "id": parent,
                    "cwd": "/tmp/parent",
                    "git": {"branch": "parent-branch"}
                }),
            ),
            rollout_line(
                "2026-09-02T14:00:01Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "round one"}),
            ),
        ];
        fs::write(
            temp_dir
                .path()
                .join(format!("rollout-2026-09-02T14-00-00-{parent}.jsonl")),
            format!("{}\n", parent_lines.join("\n")),
        )
        .expect("write parent rollout");

        // The child holds ONLY its header — the by-reference shape.
        let child_lines = [rollout_line(
            "2026-09-02T14:01:53Z",
            "session_meta",
            serde_json::json!({
                "id": child,
                "cwd": "/tmp/child",
                "git": {"branch": "child-branch"},
                "forked_from_id": parent,
                "forked_from_ordinal_exclusive": 1
            }),
        )];
        fs::write(
            temp_dir
                .path()
                .join(format!("rollout-2026-09-02T14-01-53-{child}.jsonl")),
            format!("{}\n", child_lines.join("\n")),
        )
        .expect("write child rollout");

        let parser = CodexParser::with_base_dir(temp_dir.path().to_path_buf());
        let summaries = parser.list_conversations().expect("list conversations");
        let ids: Vec<&str> = summaries.iter().map(|s| s.id.as_str()).collect();
        assert!(
            ids.contains(&child) && ids.contains(&parent),
            "both the fork and its parent must list under their OWN ids, got {ids:?}"
        );

        let forked = summaries
            .iter()
            .find(|s| s.id == child)
            .expect("the fork is listed");
        assert_eq!(
            forked.folder_path.as_deref(),
            Some("/tmp/child"),
            "the spliced parent header must not overwrite the fork's cwd"
        );
        assert_eq!(
            forked.git_branch.as_deref(),
            Some("child-branch"),
            "the spliced parent header must not overwrite the fork's branch"
        );

        let detail = parser.get_conversation(child).expect("load fork detail");
        assert_eq!(detail.summary.id, child);
        assert_eq!(
            detail.summary.folder_path.as_deref(),
            Some("/tmp/child"),
            "the spliced parent header must not overwrite the fork's cwd in detail"
        );
    }

    /// Both on-disk sub-agent shapes must surface `parent_id`, because that is
    /// the only thing keeping these rollouts out of the importer's root list
    /// (`import_service::collect_local_summaries` drops `parent_id.is_some()`).
    /// The STRUCTURED case is the one that matters most: it is the shape every
    /// real sub-agent rollout carries, while the flat mirror only accompanies
    /// it on some versions.
    #[test]
    fn native_parent_thread_is_preserved_in_list_and_detail() {
        let parent = "019ff3f7-0000-7000-8000-000000000001";
        let temp_dir = tempfile::tempdir().expect("create temp dir");

        // Same parent id, two payload shapes, one directory — so a regression in
        // either branch shows up as a listed root session.
        let cases = [
            (
                "019ff3f7-937a-7671-b4f6-e404cb729d30",
                serde_json::json!({ "parent_thread_id": format!(" {parent} ") }),
            ),
            (
                "019ff3f7-937a-7671-b4f6-e404cb729d31",
                serde_json::json!({
                    "source": {"subagent": {"thread_spawn": {
                        "parent_thread_id": parent,
                        "depth": 1,
                        "agent_nickname": "Gibbs",
                        "agent_role": "worker"
                    }}}
                }),
            ),
        ];

        for (conversation_id, extra) in &cases {
            let mut payload = serde_json::json!({"id": conversation_id, "cwd": "/tmp/demo"});
            let map = payload.as_object_mut().expect("payload object");
            for (k, v) in extra.as_object().expect("extra object") {
                map.insert(k.clone(), v.clone());
            }
            let lines = [
                rollout_line("2026-08-28T10:00:00Z", "session_meta", payload),
                rollout_line(
                    "2026-08-28T10:00:01Z",
                    "event_msg",
                    serde_json::json!({"type": "user_message", "message": "child task"}),
                ),
            ];
            fs::write(
                temp_dir
                    .path()
                    .join(format!("rollout-2026-08-28T10-00-00-{conversation_id}.jsonl")),
                format!("{}\n", lines.join("\n")),
            )
            .expect("write rollout");
        }

        let parser = CodexParser::with_base_dir(temp_dir.path().to_path_buf());
        let summaries = parser.list_conversations().expect("list conversations");
        assert_eq!(summaries.len(), cases.len());

        for (conversation_id, _) in &cases {
            let listed = summaries
                .iter()
                .find(|s| s.id == *conversation_id)
                .unwrap_or_else(|| panic!("{conversation_id} listed"));
            assert_eq!(
                listed.parent_id.as_deref(),
                Some(parent),
                "{conversation_id} must report its parent so the importer skips it"
            );

            let detail = parser
                .get_conversation(conversation_id)
                .expect("load conversation detail");
            assert_eq!(detail.summary.parent_id, listed.parent_id);
        }
    }

    #[test]
    fn parent_thread_falls_back_to_structured_source_and_rejects_blanks() {
        let preferred = serde_json::json!({
            "parent_thread_id": " root-parent ",
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": "nested-parent"}}}
        });
        assert_eq!(
            codex_parent_thread_id(&preferred).as_deref(),
            Some("root-parent")
        );

        let fallback = serde_json::json!({
            "parent_thread_id": "  ",
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": " nested-parent "}}}
        });
        assert_eq!(
            codex_parent_thread_id(&fallback).as_deref(),
            Some("nested-parent")
        );

        let blank = serde_json::json!({
            "parent_thread_id": " ",
            "source": {"subagent": {"thread_spawn": {"parent_thread_id": "\t"}}}
        });
        assert_eq!(codex_parent_thread_id(&blank), None);
    }

    #[test]
    fn session_index_title_wins_for_list_and_detail() {
        let conversation_id = "01a00496-1418-7273-a06f-dc4fae5cfa64";
        let (_temp_dir, parser, index_path) = write_index_title_fixture(conversation_id);
        let index_lines = [
            serde_json::json!({
                "id": conversation_id,
                "thread_name": "旧标题",
                "updated_at": "2026-08-15T08:01:00Z"
            })
            .to_string(),
            "{malformed json".to_string(),
            serde_json::json!({
                "id": conversation_id,
                "thread_name": "  解释 Makefile 文件作用  ",
                "updated_at": "2026-08-15T08:02:00Z"
            })
            .to_string(),
            serde_json::json!({
                "id": conversation_id,
                "thread_name": "   ",
                "updated_at": "2026-08-15T08:03:00Z"
            })
            .to_string(),
        ];
        fs::write(&index_path, format!("{}\n", index_lines.join("\n"))).expect("write index");

        let summaries = parser.list_conversations().expect("list conversations");
        assert_eq!(summaries.len(), 1);
        assert_eq!(
            summaries[0].title.as_deref(),
            Some("解释 Makefile 文件作用")
        );

        let detail = parser
            .get_conversation(conversation_id)
            .expect("get conversation");
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("解释 Makefile 文件作用")
        );
    }

    #[test]
    fn session_index_title_wins_over_rollout_thread_name_update() {
        let conversation_id = "index-vs-rollout-title";
        let (_temp_dir, parser, index_path) = write_index_title_fixture(conversation_id);
        let rollout_path = parser
            .base_dir
            .join("2026")
            .join("08")
            .join("15")
            .join(format!(
                "rollout-2026-08-15T16-00-00-{conversation_id}.jsonl"
            ));
        let mut rollout = fs::read_to_string(&rollout_path).expect("read rollout");
        rollout.push_str(
            &serde_json::json!({
                "timestamp": "2026-08-15T08:00:02Z",
                "type": "event_msg",
                "payload": {
                    "type": "thread_name_updated",
                    "thread_name": "rollout thread title"
                }
            })
            .to_string(),
        );
        rollout.push('\n');
        fs::write(&rollout_path, rollout).expect("append rollout title");
        fs::write(
            &index_path,
            format!(
                "{}\n",
                serde_json::json!({
                    "id": conversation_id,
                    "thread_name": "session index title",
                    "updated_at": "2026-08-15T08:01:00Z"
                })
            ),
        )
        .expect("write index title");

        let summaries = parser.list_conversations().expect("list conversations");
        assert_eq!(summaries[0].title.as_deref(), Some("session index title"));
        let detail = parser
            .get_conversation(conversation_id)
            .expect("get conversation");
        assert_eq!(detail.summary.title.as_deref(), Some("session index title"));
    }

    #[test]
    fn session_index_title_refreshes_after_summary_cache_hit() {
        let conversation_id = "cache-title-session";
        let (_temp_dir, parser, index_path) = write_index_title_fixture(conversation_id);
        fs::write(
            &index_path,
            format!(
                "{}\n",
                serde_json::json!({"id": conversation_id, "thread_name": "索引标题甲"})
            ),
        )
        .expect("write first index title");

        let first = parser.list_conversations().expect("first list");
        assert_eq!(first[0].title.as_deref(), Some("索引标题甲"));

        // The rollout file is unchanged, so its summary is served from cache.
        // The independently-read index must still replace the cached title.
        fs::write(
            &index_path,
            format!(
                "{}\n",
                serde_json::json!({"id": conversation_id, "thread_name": "索引标题乙"})
            ),
        )
        .expect("update index title");
        let second = parser.list_conversations().expect("second list");
        assert_eq!(second[0].title.as_deref(), Some("索引标题乙"));
    }

    #[test]
    fn unavailable_session_index_preserves_rollout_title_fallback() {
        let conversation_id = "index-fallback-session";
        let (_temp_dir, parser, index_path) = write_index_title_fixture(conversation_id);

        let missing = parser.list_conversations().expect("list without index");
        assert_eq!(missing[0].title.as_deref(), Some("Makefile 文件的作用"));

        fs::write(
            &index_path,
            format!(
                "not json\n{}\n",
                serde_json::json!({"id": conversation_id, "thread_name": "  "})
            ),
        )
        .expect("write unusable index records");
        let malformed = parser.list_conversations().expect("list malformed index");
        assert_eq!(malformed[0].title.as_deref(), Some("Makefile 文件的作用"));

        fs::remove_file(&index_path).expect("remove index file");
        fs::create_dir(&index_path).expect("make index path unreadable as a file");
        let unreadable = parser.list_conversations().expect("list unreadable index");
        assert_eq!(unreadable[0].title.as_deref(), Some("Makefile 文件的作用"));
        let detail = parser
            .get_conversation(conversation_id)
            .expect("detail unreadable index");
        assert_eq!(detail.summary.title.as_deref(), Some("Makefile 文件的作用"));
    }

    #[test]
    fn skips_agents_instructions_title_candidate() {
        let input =
            "# AGENTS.md instructions for /tmp/demo\n\n<INSTRUCTIONS>\nhello\n</INSTRUCTIONS>";
        let got = extract_codex_title_candidate(input, true);
        assert!(got.is_none());
    }

    #[test]
    fn skips_pathless_agents_instructions_title_candidate() {
        let input = "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhello\n</INSTRUCTIONS>";
        let got = extract_codex_title_candidate(input, true);
        assert!(got.is_none());

        // Windows codex writes the same record with CRLF.
        let crlf = "# AGENTS.md instructions\r\n\r\n<INSTRUCTIONS>\r\nhello\r\n</INSTRUCTIONS>";
        assert!(extract_codex_title_candidate(crlf, true).is_none());
    }

    #[test]
    fn keeps_a_human_prompt_that_merely_opens_with_the_agents_heading() {
        // The pathless header is one newline away from an ordinary Markdown H1,
        // so the envelope's `<INSTRUCTIONS>` body is what separates codex's
        // injection from a person asking about it. Without that second signal
        // this prompt is dropped from the transcript entirely — not merely
        // passed over for the title.
        let input = "# AGENTS.md instructions\n\n为什么我的全局 AGENTS.md 没有生效？";
        assert_eq!(
            extract_codex_title_candidate(input, true).as_deref(),
            Some("# AGENTS.md instructions\n\n为什么我的全局 AGENTS.md 没有生效？")
        );
        assert!(is_promotable_user_text(input));
    }

    #[test]
    fn skips_environment_context_title_candidate() {
        let input = "<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>";
        let got = extract_codex_title_candidate(input, true);
        assert!(got.is_none());
    }

    #[test]
    fn keeps_real_user_prompt_as_title_candidate() {
        let input = "修复 codex 会话标题";
        let got = extract_codex_title_candidate(input, true);
        assert_eq!(got.as_deref(), Some("修复 codex 会话标题"));
    }

    #[test]
    fn strips_image_placeholders_from_user_text() {
        let input = "这个图片里面是什么\n</image>\n<image>\n";
        let got = strip_blocked_resource_mentions(input);
        assert_eq!(got, "这个图片里面是什么");
    }

    #[test]
    fn internal_agent_routes_never_surface_in_codex_history() {
        use crate::acp::agent_mentions::append_agent_routes;
        use crate::acp::types::PromptInputBlock;

        let conversation_id = "agent-route-history";
        let (_temp_dir, parser, _index_path) = write_index_title_fixture(conversation_id);
        let rollout_path = parser
            .base_dir
            .join("2026")
            .join("08")
            .join("15")
            .join(format!(
                "rollout-2026-08-15T16-00-00-{conversation_id}.jsonl"
            ));
        let visible = "Ask [@Antigravity](codeg://agent/antigravity) to review";
        let mut prompt = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut prompt, true);
        let routing = match &prompt[1] {
            PromptInputBlock::Text { text } => text,
            _ => unreachable!(),
        };
        let lines = [
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": conversation_id, "cwd": "/tmp/Temp"}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01Z",
                "type": "event_msg",
                "payload": {
                    "type": "user_message",
                    "message": format!("{visible}\n{routing}")
                }
            })
            .to_string(),
            // Some adapter versions can persist separate ACP text blocks as
            // separate records. A route-only record must not become a phantom
            // "Attached resources" turn.
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01.100Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": routing}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:02Z",
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "Done"}
            })
            .to_string(),
        ];
        fs::write(&rollout_path, format!("{}\n", lines.join("\n"))).unwrap();

        let summary = parser
            .list_conversations()
            .unwrap()
            .into_iter()
            .find(|item| item.id == conversation_id)
            .unwrap();
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.title.as_deref(), Some("Ask @Antigravity to review"));

        let detail = parser.get_conversation(conversation_id).unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(
            detail.turns[0].blocks.as_slice(),
            [ContentBlock::Text { text }] if text == visible
        ));
    }

    #[test]
    fn route_only_event_does_not_suppress_visible_response_item_fallback() {
        use crate::acp::agent_mentions::append_agent_routes;
        use crate::acp::types::PromptInputBlock;

        let conversation_id = "agent-route-promotion";
        let (_temp_dir, parser, _index_path) = write_index_title_fixture(conversation_id);
        let rollout_path = parser
            .base_dir
            .join("2026")
            .join("08")
            .join("15")
            .join(format!(
                "rollout-2026-08-15T16-00-00-{conversation_id}.jsonl"
            ));
        let visible = "Ask [@Codex](codeg://agent/codex) to inspect this";
        let mut prompt = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut prompt, true);
        let routing = match &prompt[1] {
            PromptInputBlock::Text { text } => text,
            _ => unreachable!(),
        };
        let lines = [
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": conversation_id, "cwd": "/tmp/Temp"}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": routing}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01.100Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": visible}]
                }
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:02Z",
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "Done"}
            })
            .to_string(),
        ];
        fs::write(&rollout_path, format!("{}\n", lines.join("\n"))).unwrap();

        let summary = parser
            .list_conversations()
            .unwrap()
            .into_iter()
            .find(|item| item.id == conversation_id)
            .unwrap();
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.title.as_deref(), Some("Ask @Codex to inspect this"));

        let detail = parser.get_conversation(conversation_id).unwrap();
        assert_eq!(detail.turns.len(), 2);
        assert!(matches!(
            detail.turns[0].blocks.as_slice(),
            [ContentBlock::Text { text }] if text == visible
        ));
    }

    #[test]
    fn user_authored_agent_route_envelope_survives_summary_and_detail() {
        let conversation_id = "user-agent-route-envelope";
        let (_temp_dir, parser, _index_path) = write_index_title_fixture(conversation_id);
        let rollout_path = parser
            .base_dir
            .join("2026")
            .join("08")
            .join("15")
            .join(format!(
                "rollout-2026-08-15T16-00-00-{conversation_id}.jsonl"
            ));
        let visible = "Explain \u{001e}<codeg_internal_agent_routes version=\"2\">user text</codeg_internal_agent_routes>\u{001e}";
        let lines = [
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:00Z",
                "type": "session_meta",
                "payload": {"id": conversation_id, "cwd": "/tmp/Temp"}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:01Z",
                "type": "event_msg",
                "payload": {"type": "user_message", "message": visible}
            })
            .to_string(),
            serde_json::json!({
                "timestamp": "2026-08-15T08:00:02Z",
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "Done"}
            })
            .to_string(),
        ];
        fs::write(&rollout_path, format!("{}\n", lines.join("\n"))).unwrap();

        let summary = parser
            .list_conversations()
            .unwrap()
            .into_iter()
            .find(|item| item.id == conversation_id)
            .unwrap();
        assert_eq!(summary.message_count, 2);
        assert!(summary
            .title
            .as_deref()
            .is_some_and(|title| title.contains("codeg_internal_agent_routes")));

        let detail = parser.get_conversation(conversation_id).unwrap();
        assert!(matches!(
            detail.turns[0].blocks.as_slice(),
            [ContentBlock::Text { text }] if text == visible
        ));
    }

    #[test]
    fn internal_routes_are_removed_from_image_response_item_text() {
        use crate::acp::agent_mentions::append_agent_routes;
        use crate::acp::types::PromptInputBlock;

        let visible = "Review this image [@Codex](codeg://agent/codex)";
        let mut prompt = vec![PromptInputBlock::Text {
            text: visible.into(),
        }];
        append_agent_routes(&mut prompt, true);
        let routing = match &prompt[1] {
            PromptInputBlock::Text { text } => text,
            _ => unreachable!(),
        };
        let payload = serde_json::json!({
            "content": [
                {"type": "input_text", "text": format!("{visible}\n{routing}")},
                {"type": "input_image", "image_url": "data:image/png;base64,QUJD"}
            ]
        });

        let blocks = extract_response_item_user_image_blocks(&payload).unwrap();
        assert!(matches!(
            blocks.as_slice(),
            [ContentBlock::Text { text }, ContentBlock::Image { .. }] if text == visible
        ));
    }

    #[test]
    fn extracts_response_item_input_image_blocks() {
        let payload = serde_json::json!({
            "content": [
                {"type": "input_text", "text": "这是什么东西"},
                {"type": "input_text", "text": "<image>"},
                {"type": "input_image", "image_url": "data:image/png;base64,QUJD"}
            ]
        });

        let blocks = extract_response_item_user_image_blocks(&payload).expect("blocks");
        assert_eq!(blocks.len(), 2);
        match &blocks[0] {
            ContentBlock::Text { text } => assert_eq!(text, "这是什么东西"),
            _ => panic!("expected text block"),
        }
        match &blocks[1] {
            ContentBlock::Image {
                data, mime_type, ..
            } => {
                assert_eq!(mime_type, "image/png");
                assert_eq!(data, "QUJD");
            }
            _ => panic!("expected image block"),
        }
    }

    #[test]
    fn skips_duplicate_user_message_within_short_window() {
        let now = Utc::now();
        let blocks = vec![
            ContentBlock::Text {
                text: "hello".to_string(),
            },
            ContentBlock::Image {
                data: "QUJD".to_string(),
                mime_type: "image/png".to_string(),
                uri: None,
            },
        ];
        let messages = vec![UnifiedMessage {
            id: "user-0".to_string(),
            role: MessageRole::User,
            content: blocks.clone(),
            timestamp: now,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: Some(now),
        agent_message_id: None,
        }];

        assert!(should_skip_duplicate_user_message(
            &messages,
            &blocks,
            now + Duration::milliseconds(1200),
        ));
        assert!(!should_skip_duplicate_user_message(
            &messages,
            &blocks,
            now + Duration::seconds(180),
        ));
    }

    /// One `response_item` user record carrying `texts` as its content items.
    fn injected_user_record(ts: &str, texts: &[&str]) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "timestamp": ts,
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": texts
                        .iter()
                        .map(|text| serde_json::json!({"type": "input_text", "text": text}))
                        .collect::<Vec<_>>(),
                }
            })
        )
    }

    #[test]
    fn summary_title_skips_injected_messages_and_uses_real_prompt() {
        // Injected/duplicate context arrives as text-only `response_item` user
        // messages; the real prompt is delivered by `event_msg.user_message` —
        // the canonical prompt channel in real codex rollouts. Both parsers must
        // title from the prompt and never from the injection, which is the whole
        // point: the injection PRECEDES the prompt, so anything that survives the
        // deny-lists outranks it in stream order and wins the title.
        //
        // All three injected shapes are real. The AGENTS.md header ships with or
        // without a path — `UserInstructions { directory: Option<String> }`
        // upstream, and a global `~/.codex/AGENTS.md` has no directory to name
        // (#789) — and always rides in the same record as `<environment_context>`
        // (1857 of 2033 such records in the local corpus). `<recommended_plugins>`
        // is `RecommendedPluginsInstructions`, injected by newer codex ahead of
        // the first prompt once the `recommended_plugins` feature is on.
        const ENV: &str = "<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>";
        for (label, injected) in [
            (
                "agents-with-path",
                vec![
                    "# AGENTS.md instructions for /tmp/demo\n\n<INSTRUCTIONS>\nhello\n</INSTRUCTIONS>",
                    ENV,
                ],
            ),
            (
                "agents-pathless",
                vec![
                    "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhello\n</INSTRUCTIONS>",
                    ENV,
                ],
            ),
            (
                "recommended-plugins",
                vec![
                    "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Figma (figma)\n</recommended_plugins>",
                ],
            ),
        ] {
            let mut content = String::from(
                "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"test-1\",\"cwd\":\"/tmp/demo\"}}\n",
            );
            content.push_str(&injected_user_record("2026-03-01T10:00:01Z", &injected));
            content.push_str("{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"真实用户标题\"}}\n");
            content.push_str("{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"好的\"}}\n");

            let summary = summary_of(&format!("injected-{label}"), &content);
            assert_eq!(
                summary.title.as_deref(),
                Some("真实用户标题"),
                "{label}: the sidebar titles from the prompt"
            );
            assert_eq!(
                summary.message_count, 2,
                "{label}: the injection is not a message"
            );

            let detail = parse_rollout(&format!("injected-{label}-detail"), &content, "test-1");
            assert_eq!(
                detail.summary.title.as_deref(),
                Some("真实用户标题"),
                "{label}: and so does the opened conversation"
            );
            assert_eq!(
                turn_texts(&detail),
                vec![
                    ("user", Some("真实用户标题".into())),
                    ("assistant", Some("好的".into())),
                ],
                "{label}: the injection never renders as a turn"
            );
        }
    }

    #[test]
    fn extracts_context_window_used_tokens_from_last_usage_total() {
        let info = serde_json::json!({
            "total_token_usage": {
                "total_tokens": 1234,
                "input_tokens": 1000,
                "cached_input_tokens": 100,
                "output_tokens": 100,
                "reasoning_output_tokens": 34
            },
            "last_token_usage": {
                "total_tokens": 321,
                "input_tokens": 300,
                "cached_input_tokens": 10,
                "output_tokens": 11
            }
        });
        assert_eq!(
            extract_context_window_used_tokens_from_token_count_info(&info),
            Some(321)
        );
    }

    #[test]
    fn extracts_context_window_used_tokens_from_last_usage_sum_when_total_missing() {
        let info = serde_json::json!({
            "total_token_usage": {
                "input_tokens": 1000,
                "cached_input_tokens": 100,
                "output_tokens": 100,
                "reasoning_output_tokens": 34
            },
            "last_token_usage": {
                "input_tokens": 200,
                "cached_input_tokens": 20,
                "output_tokens": 2
            }
        });
        assert_eq!(
            extract_context_window_used_tokens_from_token_count_info(&info),
            Some(202)
        );
    }

    #[test]
    fn falls_back_to_total_usage_when_last_usage_missing() {
        let info = serde_json::json!({
            "total_token_usage": {
                "total_tokens": 1234
            }
        });
        assert_eq!(
            extract_context_window_used_tokens_from_token_count_info(&info),
            Some(1234)
        );
    }

    #[test]
    fn extracts_turn_usage_from_codex_usage_payload() {
        let usage = serde_json::json!({
            "input_tokens": 120,
            "cached_input_tokens": 80,
            "output_tokens": 16
        });
        let parsed = extract_turn_usage_from_codex_usage(&usage).expect("usage");
        assert_eq!(parsed.input_tokens, 40);
        assert_eq!(parsed.output_tokens, 16);
        assert_eq!(parsed.cache_creation_input_tokens, 0);
        assert_eq!(parsed.cache_read_input_tokens, 80);
    }

    #[test]
    fn merge_total_usage_overrides_aggregated_usage() {
        let aggregated = SessionStats {
            total_usage: Some(TurnUsage {
                input_tokens: 1,
                output_tokens: 2,
                cache_creation_input_tokens: 0,
                cache_read_input_tokens: 3,
            }),
            total_tokens: Some(6),
            total_duration_ms: 100,
            context_window_used_tokens: None,
            context_window_max_tokens: None,
            context_window_usage_percent: None,
        };
        let total = TurnUsage {
            input_tokens: 100,
            output_tokens: 50,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 20,
        };
        let merged =
            merge_codex_total_usage_stats(Some(aggregated), Some(total.clone()), Some(170))
                .expect("stats");
        assert_eq!(
            merged.total_usage.expect("usage").input_tokens,
            total.input_tokens
        );
        assert_eq!(merged.total_tokens, Some(170));
        assert_eq!(merged.total_duration_ms, 100);
    }

    #[test]
    fn merges_context_window_stats_without_turn_usage() {
        let merged = merge_codex_context_window_stats(None, Some(1200), Some(4000))
            .expect("stats should be present");
        assert!(merged.total_usage.is_none());
        assert!(merged.total_tokens.is_none());
        assert_eq!(merged.context_window_used_tokens, Some(1200));
        assert_eq!(merged.context_window_max_tokens, Some(4000));
        let pct = merged
            .context_window_usage_percent
            .expect("context window percent present");
        assert!((pct - 30.0).abs() < f64::EPSILON);
    }

    #[test]
    fn parse_detail_sets_context_window_stats_from_token_count() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-ctx-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ctx-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\":129200,\"input_tokens\":120000,\"cached_input_tokens\":8000,\"output_tokens\":1200},\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":50,\"output_tokens\":20,\"total_tokens\":170},\"model_context_window\":258400}}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "ctx-1")
            .expect("parse detail ok");

        let stats: SessionStats = detail.session_stats.expect("session stats should exist");
        assert_eq!(stats.context_window_used_tokens, Some(170));
        assert_eq!(stats.context_window_max_tokens, Some(258400));
        let total_usage = stats.total_usage.expect("total usage should exist");
        assert_eq!(total_usage.input_tokens, 112000);
        assert_eq!(total_usage.cache_read_input_tokens, 8000);
        assert_eq!(total_usage.output_tokens, 1200);
        assert_eq!(stats.total_tokens, Some(129200));
        let pct = stats
            .context_window_usage_percent
            .expect("context window percent present");
        assert!((pct - ((170.0 / 258400.0) * 100.0)).abs() < 0.0001);

        let _ = fs::remove_file(path);
    }

    /// Sum the per-turn usage a parse produced — what the usage dashboard
    /// materializes and what the session panel adds up.
    fn turn_usage_total(detail: &crate::models::ConversationDetail) -> u64 {
        detail
            .turns
            .iter()
            .filter_map(|t| t.usage.as_ref())
            .map(|u| {
                u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
                    + u.cache_read_input_tokens
            })
            .sum()
    }

    fn parse_rollout(label: &str, content: &str, session_id: &str) -> crate::models::ConversationDetail {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-{label}-{nanos}.jsonl"));
        fs::write(&path, content).expect("write test jsonl");
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, session_id)
            .expect("parse detail ok");
        let _ = fs::remove_file(path);
        detail
    }

    #[test]
    fn every_model_round_trip_of_a_turn_is_counted() {
        // Codex emits a `token_count` after each model call, so one turn that
        // calls tools four times reports four times. Only the first was kept
        // (`if last_msg.usage.is_none()`), which lost most of a working turn's
        // spend — measured at 61 % of all Codex tokens in a real session tree.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"rounds-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"working\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":20224,\"cached_input_tokens\":0,\"output_tokens\":458},\"last_token_usage\":{\"input_tokens\":20224,\"cached_input_tokens\":0,\"output_tokens\":458}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:13Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":51186,\"cached_input_tokens\":18000,\"output_tokens\":886},\"last_token_usage\":{\"input_tokens\":30962,\"cached_input_tokens\":18000,\"output_tokens\":428}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:29Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":92652,\"cached_input_tokens\":45000,\"output_tokens\":1420},\"last_token_usage\":{\"input_tokens\":41466,\"cached_input_tokens\":27000,\"output_tokens\":534}}}}\n"
        );
        let detail = parse_rollout("rounds", content, "rounds-1");

        // The session's own cumulative counter is the ground truth, and the
        // per-turn rows now reconstruct it exactly.
        assert_eq!(turn_usage_total(&detail), 92_652 + 1_420);
        let stats = detail.session_stats.expect("session stats");
        let total = stats.total_usage.expect("total usage");
        assert_eq!(
            total.input_tokens + total.output_tokens + total.cache_read_input_tokens,
            92_652 + 1_420
        );
    }

    #[test]
    fn a_restated_token_count_is_not_counted_twice() {
        // Codex sometimes reports the same call twice (7 380 of 31 846 events
        // in a real tree). Differencing the cumulative counter makes the repeat
        // contribute nothing, where summing `last_token_usage` would inflate it.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"repeat-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"hi\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":0,\"output_tokens\":50},\"last_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":0,\"output_tokens\":50}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":0,\"output_tokens\":50},\"last_token_usage\":{\"input_tokens\":1000,\"cached_input_tokens\":0,\"output_tokens\":50}}}}\n"
        );
        let detail = parse_rollout("repeat", content, "repeat-1");
        assert_eq!(turn_usage_total(&detail), 1_050);
    }

    #[test]
    fn a_round_that_ran_before_any_assistant_message_is_not_lost() {
        // When the model opens a turn by calling a tool, its first round-trips
        // finish before it ever speaks. Those had no assistant message to
        // attach to and were dropped outright — 3 % of all recorded spend.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"early-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"go\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":800,\"cached_input_tokens\":0,\"output_tokens\":40},\"last_token_usage\":{\"input_tokens\":800,\"cached_input_tokens\":0,\"output_tokens\":40}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":1900,\"cached_input_tokens\":0,\"output_tokens\":110},\"last_token_usage\":{\"input_tokens\":1100,\"cached_input_tokens\":0,\"output_tokens\":70}}}}\n"
        );
        let detail = parse_rollout("early", content, "early-1");
        assert_eq!(turn_usage_total(&detail), 1_900 + 110);
    }

    #[test]
    fn a_transcript_without_cumulative_totals_still_counts_each_call_once() {
        // Fallback path: no `total_token_usage` to difference, so a `token_count`
        // that merely restates the previous one is recognized by its payload.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"nototal-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"hi\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":500,\"cached_input_tokens\":100,\"output_tokens\":25}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":500,\"cached_input_tokens\":100,\"output_tokens\":25}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":700,\"cached_input_tokens\":200,\"output_tokens\":30}}}}\n"
        );
        let detail = parse_rollout("nototal", content, "nototal-1");
        assert_eq!(turn_usage_total(&detail), 525 + 730);
    }

    #[test]
    fn a_transcript_that_mixes_both_shapes_counts_each_round_exactly_once() {
        // A no-total event contributes its own `last_token_usage`, so the
        // cumulative baseline has to learn about it. Otherwise the next
        // total-bearing event differences against a stale figure and bills that
        // round a second time.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"mixed-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"hi\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"output_tokens\":0},\"last_token_usage\":{\"input_tokens\":100,\"cached_input_tokens\":0,\"output_tokens\":0}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":50,\"cached_input_tokens\":0,\"output_tokens\":0}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":180,\"cached_input_tokens\":0,\"output_tokens\":0},\"last_token_usage\":{\"input_tokens\":30,\"cached_input_tokens\":0,\"output_tokens\":0}}}}\n"
        );
        let detail = parse_rollout("mixed", content, "mixed-1");
        // 100 + 50 + (180 - 150) — the session's own counter says 180 total.
        assert_eq!(turn_usage_total(&detail), 180);
    }

    #[test]
    fn a_rollout_with_no_assistant_message_still_reports_its_spend() {
        // A turn that only ran tools and was interrupted leaves `token_count`
        // events with no assistant turn to carry them, so `reconcile_turn_usage`
        // has no target. The tokens are not lost: the session-level total is
        // populated, and that is the fallback `facts_from_detail` records as a
        // single fact row (covered by `a_session_level_total_is_recorded_when_
        // no_turn_reports_usage` in commands::token_usage).
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"toolonly-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"go\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":900,\"cached_input_tokens\":100,\"output_tokens\":40},\"last_token_usage\":{\"input_tokens\":900,\"cached_input_tokens\":100,\"output_tokens\":40}}}}\n"
        );
        let detail = parse_rollout("toolonly", content, "toolonly-1");
        assert!(
            !detail.turns.iter().any(|t| matches!(t.role, TurnRole::Assistant)),
            "precondition: this rollout has no assistant turn"
        );
        let total = detail
            .session_stats
            .as_ref()
            .and_then(|s| s.total_usage.as_ref())
            .expect("session-level total must survive as the fallback fact source");
        assert_eq!(
            total.input_tokens + total.output_tokens + total.cache_read_input_tokens,
            940
        );
    }

    #[test]
    fn a_counter_that_restarts_after_compaction_does_not_wrap_to_zero() {
        // A cumulative counter that moves backwards means a fresh context, so
        // the new value is that round's own spend rather than a negative delta
        // silently clamped away.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"compact-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"hi\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":90000,\"cached_input_tokens\":0,\"output_tokens\":2000}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":5000,\"cached_input_tokens\":0,\"output_tokens\":100}}}}\n"
        );
        let detail = parse_rollout("compact", content, "compact-1");
        assert_eq!(turn_usage_total(&detail), 92_000 + 5_100);
    }

    #[test]
    fn parse_detail_durations_partition_a_multi_message_turn() {
        // Regression: durations came from `turn_context → token_count`, and
        // codex fires `token_count` once per model request — so every reply in
        // a turn restated the elapsed time SINCE THE PROMPT. The UI merges a
        // turn's replies into one card by summing their durations, so a 30s
        // turn reported 10+22+30 = 62s (on a real 4-prompt rollout: 26 minutes
        // of work shown as 109). Each reply must instead carry only its own
        // slice, and the slices must add up to the turn.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-spans-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"spans-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.100Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.200Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"go\"}}\n",
            // Reply 1 at +10s, then two more model requests inside the SAME turn.
            "{\"timestamp\":\"2026-03-01T10:00:10.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"one\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:11.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":2,\"total_tokens\":12}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:22.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"two\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:23.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":2,\"total_tokens\":12}}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:30.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"three\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:30.400Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"last_token_usage\":{\"input_tokens\":10,\"cached_input_tokens\":0,\"output_tokens\":2,\"total_tokens\":12}}}}\n",
            // A second prompt arrives 10 minutes later; that idle gap belongs
            // to nobody, so its reply must report 4s and not 10m4s.
            "{\"timestamp\":\"2026-03-01T10:10:30.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:10:30.100Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:10:30.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"again\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:10:34.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"four\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "spans-1")
            .expect("parse detail ok");

        let assistant_durations: Vec<Option<u64>> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .map(|t| t.duration_ms)
            .collect();
        assert_eq!(
            assistant_durations,
            vec![
                Some(10_000), // prompt → "one"
                Some(12_000), // "one" → "two"
                Some(8_000),  // "two" → "three"
                Some(4_000),  // second prompt → "four"
            ]
        );

        // Turn 1's replies sum to its wall clock, and the session total is the
        // two turns' work — never the idle stretch between them.
        let turn_one: u64 = assistant_durations[..3].iter().flatten().sum();
        assert_eq!(turn_one, 30_000);
        let stats = detail.session_stats.expect("session stats");
        assert_eq!(stats.total_duration_ms, 34_000);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_mid_turn_turn_context_does_not_truncate_the_reply_after_it() {
        // Newer codex re-emits `turn_context` in the MIDDLE of a turn — it
        // carries a `turn_id` and is rewritten when the turn's config changes
        // (6 of 495 records across the local rollout corpus). A start marker
        // only ever moves the boundary forward, so treating that one as a turn
        // start would charge the following reply just the time since it and
        // silently drop the rest of the span from the turn's total. Only
        // `task_started` — exactly one per turn — anchors the measurement;
        // `turn_context` is a fallback for rollouts that predate it.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-midctx-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"midctx-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.100Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.200Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:00.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"go\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:10.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"one\"}}\n",
            // Re-emitted mid-turn, 1s before the next reply. If this counted as
            // a turn start, "two" would report 1s instead of its real 20s.
            "{\"timestamp\":\"2026-03-01T10:00:29.300Z\",\"type\":\"turn_context\",\"payload\":{\"turn_id\":\"t-1\",\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:30.300Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"two\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "midctx-1")
            .expect("parse detail ok");

        let assistant_durations: Vec<Option<u64>> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .map(|t| t.duration_ms)
            .collect();
        assert_eq!(assistant_durations, vec![Some(10_000), Some(20_000)]);
        // Still tiles: 10s + 20s is the whole prompt→last-reply span.
        let total: u64 = assistant_durations.iter().flatten().sum();
        assert_eq!(total, 30_000);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_completion_time_uses_agent_message_timestamp_not_added_turn_span() {
        // Regression: `duration_ms` is a *span* and `timestamp` on the
        // assistant `UnifiedMessage` is the agent_message event time (already
        // at the end of that span, not its start), so adding the two
        // double-counts. completed_at must reflect the agent_message arrival.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-completed-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"completed-1\",\"cwd\":\"/tmp/demo\"}}\n",
            // Turn starts here.
            "{\"timestamp\":\"2026-03-01T10:00:00.522Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            // Assistant message arrives ~9.5s into the turn.
            "{\"timestamp\":\"2026-03-01T10:00:10.081Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n",
            // token_count fires shortly after, bringing duration_ms = 9.7s.
            "{\"timestamp\":\"2026-03-01T10:00:10.268Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"total_tokens\":100,\"input_tokens\":80,\"cached_input_tokens\":0,\"output_tokens\":20},\"last_token_usage\":{\"input_tokens\":80,\"cached_input_tokens\":0,\"output_tokens\":20,\"total_tokens\":100},\"model_context_window\":258400}}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "completed-1")
            .expect("parse detail ok");

        let assistant = detail
            .turns
            .iter()
            .find(|t| matches!(t.role, TurnRole::Assistant))
            .expect("assistant turn");
        let completed_at = assistant.completed_at.expect("completed_at populated");
        let expected = "2026-03-01T10:00:10.081Z".parse::<DateTime<Utc>>().unwrap();
        assert_eq!(completed_at, expected);
        // The naive `timestamp + duration_ms` would produce ~10.00:19.827Z.
        let wrong = "2026-03-01T10:00:19.827Z".parse::<DateTime<Utc>>().unwrap();
        assert_ne!(completed_at, wrong);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_reconstructs_goal_cards_and_native_title() {
        // codex-acp v1.1.0 (#263): `/goal` transitions persist to the rollout as
        // `event_msg.thread_goal_updated`. The parser must reconstruct the same
        // create_goal/update_goal tool call the live path emits (history goal
        // parity — which never existed before), normalizing the camelCase
        // `ThreadGoalStatus` to the snake_case bucket the goal card expects.
        // `thread_name_updated` must win over the first-prompt title.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-goal-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"goal-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"hi\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Refactor the auth module\",\"status\":\"active\",\"tokensUsed\":0,\"timeUsedSeconds\":0}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"working\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Refactor the auth module\",\"status\":\"budgetLimited\",\"tokensUsed\":5200,\"timeUsedSeconds\":19}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_name_updated\",\"thread_id\":\"goal-1\",\"thread_name\":\"Refactor auth module\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "goal-1")
            .expect("parse detail ok");

        // Native thread name wins over the first-prompt fallback ("hi").
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("Refactor auth module")
        );

        // Correlate synthesized goal tool_use/tool_result blocks by id.
        let mut names: HashMap<String, String> = HashMap::new();
        let mut inputs: HashMap<String, String> = HashMap::new();
        let mut outputs: HashMap<String, String> = HashMap::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                match block {
                    ContentBlock::ToolUse {
                        tool_use_id: Some(id),
                        tool_name,
                        input_preview,
                        ..
                    } => {
                        names.insert(id.clone(), tool_name.clone());
                        if let Some(i) = input_preview {
                            inputs.insert(id.clone(), i.clone());
                        }
                    }
                    ContentBlock::ToolResult {
                        tool_use_id: Some(id),
                        output_preview: Some(o),
                        ..
                    } => {
                        outputs.insert(id.clone(), o.clone());
                    }
                    _ => {}
                }
            }
        }

        let find = |target: &str| -> String {
            names
                .iter()
                .find(|(_, n)| n.as_str() == target)
                .map(|(id, _)| id.clone())
                .unwrap_or_else(|| panic!("{target} tool call present"))
        };

        // active → create_goal, objective + status carried in the tool_result.
        let create_id = find("create_goal");
        let create_out: serde_json::Value =
            serde_json::from_str(&outputs[&create_id]).unwrap();
        assert_eq!(create_out["goal"]["status"], "active");
        assert_eq!(create_out["goal"]["objective"], "Refactor the auth module");
        // Distinct goal events get distinct (occurrence-addressed) ids.
        assert_ne!(create_id, find("update_goal"));

        // budgetLimited → update_goal with the status normalized to snake_case.
        let update_id = find("update_goal");
        let update_out: serde_json::Value =
            serde_json::from_str(&outputs[&update_id]).unwrap();
        assert_eq!(update_out["goal"]["status"], "budget_limited");
        assert_eq!(update_out["goal"]["tokensUsed"], 5200);
        let update_in: serde_json::Value = serde_json::from_str(&inputs[&update_id]).unwrap();
        assert_eq!(update_in["status"], "budget_limited");
        assert_eq!(update_in["objective"], "Refactor the auth module");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_closes_goal_on_persisted_null_clear() {
        // A persisted `thread_goal_updated` with `goal: null` must close the open
        // run (create_goal → update_goal/complete inheriting the objective),
        // identical to the live path — not leave it perpetually active.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-goalnull-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gc-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Ship it\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":null}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "gc-1")
            .expect("parse detail ok");

        let mut names: HashMap<String, String> = HashMap::new();
        let mut outputs: HashMap<String, String> = HashMap::new();
        for turn in &detail.turns {
            for block in &turn.blocks {
                match block {
                    ContentBlock::ToolUse {
                        tool_use_id: Some(id),
                        tool_name,
                        ..
                    } => {
                        names.insert(id.clone(), tool_name.clone());
                    }
                    ContentBlock::ToolResult {
                        tool_use_id: Some(id),
                        output_preview: Some(o),
                        ..
                    } => {
                        outputs.insert(id.clone(), o.clone());
                    }
                    _ => {}
                }
            }
        }
        // The null clear produced a closing update_goal (not dropped).
        let close_id = names
            .iter()
            .find(|(_, n)| n.as_str() == "update_goal")
            .map(|(id, _)| id.clone())
            .expect("null clear closes the run with an update_goal");
        assert!(names.values().any(|n| n == "create_goal"));
        let close_out: serde_json::Value = serde_json::from_str(&outputs[&close_id]).unwrap();
        assert_eq!(close_out["goal"]["status"], "complete");
        assert_eq!(close_out["goal"]["objective"], "Ship it");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_synthesizes_user_message_for_pure_goal_session() {
        // Newer codex consumes `/goal <objective>` as a slash command: it persists
        // `thread_goal_updated` but NO `user_message`, so a pure-`/goal` session
        // (the user only set a goal) reloads with no user turn and no title — the
        // live view showed the typed prompt but reload lost it. The parser must
        // surface the objective as the leading user message + title so the
        // conversation isn't headless. The goal card must still render, in order.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-puregoal-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"pg-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static test page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>\\n  <cwd>/tmp/demo</cwd>\\n</environment_context>\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static test page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"On it.\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "pg-1")
            .expect("parse detail ok");

        // Title falls back to the goal objective (no thread_name in this session).
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("Build a static test page")
        );

        // Exactly one user turn, synthesized from the objective — the internal
        // `<environment_context>` message stays filtered, and the second active
        // re-emit does NOT add a second user message. The message carries the
        // `/goal ` prefix the user actually typed (the title above stays clean).
        let user_turns: Vec<&MessageTurn> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .collect();
        assert_eq!(user_turns.len(), 1, "one synthesized user turn");
        let user_text = user_turns[0].blocks.iter().find_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(user_text, Some("/goal Build a static test page"));

        // The synthesized user turn precedes the goal card.
        let first_user_idx = detail
            .turns
            .iter()
            .position(|t| matches!(t.role, TurnRole::User))
            .expect("user turn present");
        let first_goal_idx = detail
            .turns
            .iter()
            .position(|t| {
                t.blocks.iter().any(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolUse { tool_name, .. } if tool_name == "create_goal"
                    )
                })
            })
            .expect("goal card present");
        assert!(
            first_user_idx < first_goal_idx,
            "synthesized user message precedes the goal card"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_keeps_single_user_turn_when_goal_text_persisted() {
        // Older codex persisted the `/goal` text as a real `user_message`. The
        // synthesis guard must NOT add a second user turn there (no duplicate).
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-goaltext-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gt-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"/goal Analyze the README\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Analyze the README\",\"status\":\"active\"}}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "gt-1")
            .expect("parse detail ok");

        let user_turns = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .count();
        assert_eq!(user_turns, 1, "real user_message not duplicated by synthesis");
        let user_text = detail
            .turns
            .iter()
            .find(|t| matches!(t.role, TurnRole::User))
            .and_then(|t| {
                t.blocks.iter().find_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
            });
        assert_eq!(user_text.as_deref(), Some("/goal Analyze the README"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_goal_opener_and_later_same_text_user_are_both_kept() {
        // The leading `/goal` opener is synthesized AFTER parsing, so it can never
        // poison `should_skip_duplicate_user_message`. A goal objective
        // "Investigate auth" (which OPENED the session) followed by a REAL
        // `user_message` of the same text within the dup window must yield BOTH:
        // the synthetic "/goal Investigate auth" opener AND the real "Investigate
        // auth" reply (no data loss, no false dedup — the prefix also keeps them
        // textually distinct).
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-goaldup-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gd-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Investigate auth\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Investigate auth\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "gd-1")
            .expect("parse detail ok");

        let user_texts: Vec<String> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .filter_map(|t| {
                t.blocks.iter().find_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
            })
            .collect();
        assert_eq!(
            user_texts,
            vec![
                "/goal Investigate auth".to_string(),
                "Investigate auth".to_string()
            ],
            "the synthetic /goal opener leads and the real reply survives"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_detail_goal_opener_then_confirm_reply_keeps_prompt_and_titles_from_goal() {
        // The real bug repro: a `/goal` opens the session (goal first, no
        // `user_message`); the agent asks for confirmation; the user replies
        // "确认" (a REAL `user_message`). Reopening must NOT start mid-conversation
        // at "确认" — the leading "/goal <objective>" prompt is restored as the
        // opener, the "确认" reply is kept in place, and the title comes from the
        // goal objective (the opening prompt), NOT from the later "确认".
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-goalconfirm-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gc-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Please confirm the plan: reply 批准 or 换主题.\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:20Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"确认\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:21Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"收到确认。\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "gc-1")
            .expect("parse detail ok");

        // Title is the goal objective, NOT the later "确认" reply.
        assert_eq!(detail.summary.title.as_deref(), Some("Build a static page"));

        // Two user turns, in order: the synthetic "/goal …" opener then "确认".
        let user_texts: Vec<String> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .filter_map(|t| {
                t.blocks.iter().find_map(|b| match b {
                    ContentBlock::Text { text } => Some(text.clone()),
                    _ => None,
                })
            })
            .collect();
        assert_eq!(
            user_texts,
            vec!["/goal Build a static page".to_string(), "确认".to_string()],
            "leading /goal prompt restored ahead of the 确认 reply"
        );

        // The synthetic opener sorts ahead of the goal card.
        let first_user_idx = detail
            .turns
            .iter()
            .position(|t| matches!(t.role, TurnRole::User))
            .expect("user turn present");
        let first_goal_idx = detail
            .turns
            .iter()
            .position(|t| {
                t.blocks.iter().any(|b| {
                    matches!(
                        b,
                        ContentBlock::ToolUse { tool_name, .. } if tool_name == "create_goal"
                    )
                })
            })
            .expect("goal card present");
        assert!(first_user_idx < first_goal_idx);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_summary_goal_opener_then_confirm_reply_titles_from_goal_and_counts_opener() {
        // Summary parity with the detail repro above: a `/goal` opener followed by
        // a later "确认" reply must title the list entry from the goal objective
        // (not "确认") and count the synthetic opener turn.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumconfirm-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"sc-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"Please confirm.\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:20Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"确认\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:21Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"收到确认。\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");

        // Title from the goal objective, not the "确认" reply.
        assert_eq!(summary.title.as_deref(), Some("Build a static page"));
        // "确认" (+1) + two agent_messages (+2) + synthetic /goal opener (+1).
        assert_eq!(summary.message_count, 4);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_summary_titles_pure_goal_session_from_objective() {
        // The lightweight list parser must mirror the detail fallback: a
        // pure-`/goal` session (no `user_message`) gets its title from the goal
        // objective — set before the `<codex_internal_context>` re-injection so
        // that internal text never leaks into the title — and the synthesized
        // leading user turn is counted so the entry isn't reported empty.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumgoal-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"sg-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static test page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<codex_internal_context source=\\\"goal\\\">\\nContinue working toward the active thread goal.\\n</codex_internal_context>\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"On it.\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");

        // Objective wins as title; the internal-context text never leaks in.
        assert_eq!(
            summary.title.as_deref(),
            Some("Build a static test page")
        );
        // The synthesized user turn (+1) plus the agent_message (+1).
        assert_eq!(summary.message_count, 2);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_summary_prefers_native_thread_name_over_goal_objective() {
        // A native `thread_name_updated` wins over the goal-objective fallback
        // (newest non-empty), matching the detail parser.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumname-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"sn-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Build a static test page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_name_updated\",\"thread_name\":\"Static test page\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");

        assert_eq!(summary.title.as_deref(), Some("Static test page"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_summary_goal_opener_then_image_user_still_synthesizes_opener() {
        // A `/goal` that OPENED the session (goal first, no preceding user) followed
        // by an image-bearing `response_item` user is the positional case: the goal
        // objective is the opening prompt (its own turn) and the image is a later,
        // separate turn. The detail parser synthesizes the leading "/goal …" opener
        // AND keeps the image turn, titling from the objective. The summary must
        // match: title = objective, and it counts the synthetic opener.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumimg-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"si-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Do the thing\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AAAA\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"ok\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");

        // Summary: image user (+1) + agent_message (+1) + synthetic /goal opener
        // (+1); title still comes from the objective.
        assert_eq!(summary.message_count, 3);
        assert_eq!(summary.title.as_deref(), Some("Do the thing"));

        // Detail parity: title = objective, the leading "/goal …" opener precedes
        // the image turn (two user turns total).
        let detail = parser
            .parse_conversation_detail(&path, "si-1")
            .expect("parse detail ok");
        assert_eq!(detail.summary.title.as_deref(), Some("Do the thing"));
        let user_turns: Vec<&MessageTurn> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .collect();
        assert_eq!(user_turns.len(), 2, "synthetic /goal opener + image turn");
        let opener_text = user_turns[0].blocks.iter().find_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(opener_text, Some("/goal Do the thing"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn an_image_prompt_written_to_both_channels_counts_once() {
        // codex writes the same prompt through `event_msg.user_message` AND
        // `response_item`. The detail parser drops the second copy
        // (`should_skip_duplicate_user_message`); the summary must too, or the
        // sidebar count runs one ahead of the turns the conversation renders.
        // No pre-existing fixture used the event channel's `images` array, so
        // this shape was entirely untested.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumimg-bothchan-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"si-both\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"look at this\",\"images\":[\"data:image/png;base64,AAAA\"]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01.100Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"look at this\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AAAA\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"ok\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");
        let detail = parser
            .parse_conversation_detail(&path, "si-both")
            .expect("parse detail ok");

        assert_eq!(detail.turns.len(), 2, "one user turn + one agent turn");
        assert_eq!(summary.message_count, 2);
        assert_eq!(summary.message_count, detail.summary.message_count);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn image_response_item_count_matches_detail_without_canonical_user_event() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumimg-parity-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"si-parity\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"inspect this\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,AAAA\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"ok\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");
        let detail = parser
            .parse_conversation_detail(&path, "si-parity")
            .expect("parse detail ok");

        assert_eq!(summary.message_count, 2);
        assert_eq!(detail.turns.len(), 2);
        assert_eq!(summary.message_count, detail.summary.message_count);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn parse_summary_goal_null_clear_adds_no_synthetic_count() {
        // A `thread_goal_updated` with `goal: null` (or a blank objective) carries
        // no usable objective, so the detail parser never captures
        // `first_goal_objective` and never synthesizes a user. The summary must
        // likewise add no synthetic count and no title.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-sumnull-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"snl-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":null}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"   \",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"hmm\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");

        // Only the agent_message counts — no synthetic user for a null/blank goal.
        assert_eq!(summary.message_count, 1);
        assert_eq!(summary.title, None);

        let _ = fs::remove_file(path);
    }

    #[test]
    fn goal_with_text_only_response_item_titles_from_objective_in_both_paths() {
        // A text-only `response_item` user is not a real user turn in the detail
        // parser, so a `/goal` session carrying one still falls back to the goal
        // objective for BOTH title and the synthesized leading user. The summary
        // must match exactly — it must NOT title from the text-only response_item.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf =
            env::temp_dir().join(format!("codeg-codex-gtxt-{nanos}.jsonl"));
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gt2-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Do X\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hello\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"...\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();

        // Summary titles from the objective, not from the text-only "hello".
        let summary = parser
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");
        assert_eq!(summary.title.as_deref(), Some("Do X"));

        // Detail matches: title = objective (clean), and the synthesized leading
        // user carries the `/goal ` prefix (the text-only response_item never
        // becomes a turn).
        let detail = parser
            .parse_conversation_detail(&path, "gt2-1")
            .expect("parse detail ok");
        assert_eq!(detail.summary.title.as_deref(), Some("Do X"));
        let user_turns: Vec<&MessageTurn> = detail
            .turns
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .collect();
        assert_eq!(user_turns.len(), 1, "one synthesized user turn");
        let user_text = user_turns[0].blocks.iter().find_map(|b| match b {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        });
        assert_eq!(user_text, Some("/goal Do X"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn summary_ignores_non_opening_goal_for_synthesis() {
        // Only a `create_goal` (active) opening captures an objective for the
        // synthetic-user fallback — via the shared `goal_marker`, exactly like the
        // detail parser. A terminal-status goal alone must not synthesize a user
        // or title; a later active goal is what gets captured.
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();

        // (a) terminal-only goal → no capture, no synthetic count/title.
        let path_a: PathBuf =
            env::temp_dir().join(format!("codeg-codex-term-{nanos}.jsonl"));
        fs::write(
            &path_a,
            concat!(
                "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"tm-1\",\"cwd\":\"/tmp/demo\"}}\n",
                "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Terminal only\",\"status\":\"complete\"}}}\n",
                "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"done\"}}\n"
            ),
        )
        .expect("write");
        let parser = CodexParser::new();
        let summary_a = parser
            .parse_jsonl_summary(&path_a)
            .expect("ok")
            .expect("present");
        assert_eq!(summary_a.title, None, "terminal goal is not a title");
        assert_eq!(summary_a.message_count, 1, "no synthetic user for terminal goal");
        let _ = fs::remove_file(&path_a);

        // (b) terminal THEN active → the active objective is captured (not the
        // terminal one), matching the detail parser's first-create_goal capture.
        let path_b: PathBuf =
            env::temp_dir().join(format!("codeg-codex-termact-{nanos}.jsonl"));
        fs::write(
            &path_b,
            concat!(
                "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ta-1\",\"cwd\":\"/tmp/demo\"}}\n",
                "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Old terminal\",\"status\":\"complete\"}}}\n",
                "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Fresh active\",\"status\":\"active\"}}}\n"
            ),
        )
        .expect("write");
        let summary_b = parser
            .parse_jsonl_summary(&path_b)
            .expect("ok")
            .expect("present");
        assert_eq!(summary_b.title.as_deref(), Some("Fresh active"));
        let _ = fs::remove_file(&path_b);
    }

    #[test]
    fn codex_home_env_overrides_default_home() {
        let resolved = resolve_codex_home_dir_from(
            Some(std::ffi::OsString::from("/tmp/custom-codex-home")),
            Some(PathBuf::from("/Users/default")),
        );
        assert_eq!(resolved, PathBuf::from("/tmp/custom-codex-home"));
    }

    #[test]
    fn codex_home_defaults_to_home_dot_codex() {
        let resolved = resolve_codex_home_dir_from(None, Some(PathBuf::from("/Users/default")));
        assert_eq!(resolved, PathBuf::from("/Users/default/.codex"));
    }

    /// codex 0.129+ writes a generated image both as `event_msg.image_generation_end`
    /// and `response_item.image_generation_call`, sharing the same call_id/id.
    /// The parser must surface exactly one ContentBlock::ImageGeneration per id.
    #[test]
    fn image_generation_end_and_call_dedupe_by_id() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-img-dedupe-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-05-05T12:35:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ig-test\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"draw a cat\"}]}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:17Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"image_generation_end\",\"call_id\":\"ig_abc\",\"status\":\"generating\",\"revised_prompt\":\"a fluffy ginger kitten\",\"result\":\"AAAA_BASE64\",\"saved_path\":\"/tmp/cat.png\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:18Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig_abc\",\"status\":\"generating\",\"revised_prompt\":\"a fluffy ginger kitten\",\"result\":\"AAAA_BASE64\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "ig-test")
            .expect("parse ok");

        let imagegen_blocks: Vec<&ContentBlock> = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter(|b| matches!(b, ContentBlock::ImageGeneration { .. }))
            .collect();
        assert_eq!(
            imagegen_blocks.len(),
            1,
            "Same image must appear once across event_msg.image_generation_end + response_item.image_generation_call (got {} image-generation blocks)",
            imagegen_blocks.len()
        );
        // The first emit (event_msg.image_generation_end) wins, so saved_path
        // and revised_prompt are preserved.
        match imagegen_blocks[0] {
            ContentBlock::ImageGeneration {
                revised_prompt,
                image,
            } => {
                assert_eq!(revised_prompt.as_deref(), Some("a fluffy ginger kitten"));
                let image = image.as_ref().expect("image present on completed event");
                assert_eq!(image.data, "AAAA_BASE64");
                assert_eq!(image.mime_type, "image/png");
                assert_eq!(image.uri.as_deref(), Some("/tmp/cat.png"));
            }
            other => panic!("expected ContentBlock::ImageGeneration, got {other:?}"),
        }

        let _ = fs::remove_file(path);
    }

    /// `event_msg.image_generation_end` ought to honor an explicit `mime_type`
    /// field when codex writes one (defensive fallback to image/png otherwise).
    #[test]
    fn image_generation_end_honors_explicit_mime_type() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-img-mime-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-05-05T12:35:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ig-mime\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"hi\"}]}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:17Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"image_generation_end\",\"call_id\":\"ig_jpeg\",\"status\":\"generating\",\"mime_type\":\"image/jpeg\",\"result\":\"JPEGDATA\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "ig-mime")
            .expect("parse ok");

        let mime = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ImageGeneration {
                    image: Some(img), ..
                } if img.data == "JPEGDATA" => Some(img.mime_type.clone()),
                _ => None,
            })
            .expect("jpeg image should be present");
        assert_eq!(mime, "image/jpeg");

        let _ = fs::remove_file(path);
    }

    /// Manual smoke check against a real codex JSONL captured locally.
    /// `#[ignore]` so it doesn't run in CI; activate with
    /// `cargo test image_generation_smoke_real_session -- --ignored --nocapture`
    /// while iterating on the parser locally.
    #[test]
    #[ignore]
    fn image_generation_smoke_real_session() {
        let path = PathBuf::from(
            "/Users/xggz/.codex/sessions/2026/05/10/rollout-2026-05-10T06-13-43-019e0ecd-b954-7e33-8011-053d08baa62e.jsonl"
        );
        if !path.exists() {
            eprintln!("session not found at {}; skipping", path.display());
            return;
        }
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "smoke")
            .expect("parse ok");

        let mut imagegen_count = 0usize;
        let mut prompt_chars = 0usize;
        let mut total_bytes = 0usize;
        for turn in &detail.turns {
            for b in &turn.blocks {
                if let ContentBlock::ImageGeneration {
                    revised_prompt,
                    image,
                } = b
                {
                    imagegen_count += 1;
                    if let Some(p) = revised_prompt {
                        prompt_chars += p.chars().count();
                    }
                    if let Some(img) = image {
                        total_bytes += img.data.len();
                    }
                }
            }
        }
        eprintln!("image_generation_blocks={imagegen_count}");
        eprintln!("revised_prompt_total_chars={prompt_chars}");
        eprintln!("total_image_base64_bytes={total_bytes}");
        assert!(
            imagegen_count >= 1,
            "expected at least 1 ContentBlock::ImageGeneration in the smoke session"
        );
    }

    /// When `revised_prompt` is absent in the payload, the parser must emit
    /// `revised_prompt: None` (codex's `imagegen` skill does not always echo
    /// the prompt back, e.g. when status="failed").
    #[test]
    fn image_generation_end_omits_revised_prompt_when_missing() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-img-noprompt-{nanos}.jsonl"));

        let content = concat!(
            "{\"timestamp\":\"2026-05-05T12:35:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ig-noprompt\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:35:17Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"image_generation_end\",\"call_id\":\"ig_np\",\"status\":\"generating\",\"result\":\"NOPROMPT_DATA\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "ig-noprompt")
            .expect("parse ok");

        let block = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find(|b| matches!(b, ContentBlock::ImageGeneration { .. }))
            .expect("image generation block present");
        match block {
            ContentBlock::ImageGeneration {
                revised_prompt,
                image,
            } => {
                assert!(revised_prompt.is_none());
                let image = image.as_ref().expect("image present on completed event");
                assert_eq!(image.data, "NOPROMPT_DATA");
            }
            _ => unreachable!(),
        }

        let _ = fs::remove_file(path);
    }

    /// Subagents in codex run inside the parent's JSONL, but their own
    /// transcripts are written to a separate `agent-<id>.jsonl`, so parent
    /// narration (messages / reasoning) is never gated on `active_agent_count`.
    /// image_generation is the exception: a generated image carries no agent
    /// attribution, so one emitted inside a subagent window must be suppressed
    /// (`active_agent_count > 0`), otherwise the subagent's image leaks into the
    /// parent timeline as an inline ContentBlock::ImageGeneration.
    #[test]
    fn image_generation_inside_subagent_is_suppressed_in_parent() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-img-subagent-{nanos}.jsonl"));

        // Sequence:
        //   1. user msg
        //   2. parent calls spawn_agent           → active_agent_count = 1
        //   3. spawn_agent output (assigns agent_id)
        //   4. SUBAGENT generates an image (event_msg + response_item)
        //   5. parent calls close_agent
        //   6. close_agent output                  → active_agent_count = 0
        //   7. PARENT generates an image after the subagent finished
        //
        // Only step 7's image must surface; step 4 is the subagent's and
        // belongs to the subagent's own transcript, not the parent timeline.
        let content = concat!(
            "{\"timestamp\":\"2026-05-05T12:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ig-subagent\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"go\"}]}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"spawn_call_1\",\"name\":\"spawn_agent\",\"arguments\":\"{\\\"agent_type\\\":\\\"researcher\\\",\\\"message\\\":\\\"do work\\\"}\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"spawn_call_1\",\"output\":\"{\\\"agent_id\\\":\\\"agent_a\\\"}\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"image_generation_end\",\"call_id\":\"ig_subagent_x\",\"status\":\"generating\",\"revised_prompt\":\"subagent painted this\",\"result\":\"SUBAGENT_BYTES\",\"saved_path\":\"/tmp/sub.png\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:05Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"image_generation_call\",\"id\":\"ig_subagent_y\",\"status\":\"generating\",\"revised_prompt\":\"subagent painted this too\",\"result\":\"SUBAGENT_BYTES_2\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:06Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"close_call_1\",\"name\":\"close_agent\",\"arguments\":\"{\\\"target\\\":\\\"agent_a\\\"}\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:07Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"close_call_1\",\"output\":\"{}\"}}\n",
            "{\"timestamp\":\"2026-05-05T12:00:08Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"image_generation_end\",\"call_id\":\"ig_parent\",\"status\":\"generating\",\"revised_prompt\":\"parent painted this\",\"result\":\"PARENT_BYTES\",\"saved_path\":\"/tmp/parent.png\"}}\n"
        );
        fs::write(&path, content).expect("write test jsonl");

        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "ig-subagent")
            .expect("parse ok");

        let imagegen_blocks: Vec<&ContentBlock> = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter(|b| matches!(b, ContentBlock::ImageGeneration { .. }))
            .collect();

        assert_eq!(
            imagegen_blocks.len(),
            1,
            "only the parent's post-subagent image must surface ({} blocks)",
            imagegen_blocks.len()
        );
        match imagegen_blocks[0] {
            ContentBlock::ImageGeneration {
                revised_prompt,
                image,
            } => {
                assert_eq!(revised_prompt.as_deref(), Some("parent painted this"));
                let image = image.as_ref().expect("parent image present");
                assert_eq!(image.data, "PARENT_BYTES");
                assert_eq!(image.uri.as_deref(), Some("/tmp/parent.png"));
            }
            other => panic!("expected ContentBlock::ImageGeneration, got {other:?}"),
        }

        let _ = fs::remove_file(path);
    }

    /// Write JSONL lines to a unique temp file and return its path.
    fn write_temp_rollout(tag: &str, lines: &[String]) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path = env::temp_dir().join(format!("codeg-codex-{tag}-{nanos}.jsonl"));
        let mut content = lines.join("\n");
        content.push('\n');
        fs::write(&path, content).expect("write test jsonl");
        path
    }

    fn rollout_line(ts: &str, msg_type: &str, payload: serde_json::Value) -> String {
        serde_json::json!({ "timestamp": ts, "type": msg_type, "payload": payload }).to_string()
    }

    /// A directory of its own, for the tests that exercise the sibling-file
    /// lookup: `parse_codex_subagent_stats` scans the whole session directory,
    /// so it must not see other tests' rollouts (or the rest of `/tmp`).
    fn temp_session_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let dir = env::temp_dir().join(format!("codeg-codex-{tag}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp session dir");
        dir
    }

    fn thinking_texts(detail: &crate::models::ConversationDetail) -> Vec<String> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::Thinking { text } => Some(text.clone()),
                _ => None,
            })
            .collect()
    }

    /// Codex surfaces one model response's reasoning twice: as per-section
    /// `event_msg.agent_reasoning` events (one per `**Header**` section) AND as a
    /// single `response_item.reasoning` whose `summary` array groups the same
    /// sections. History must render ONE 思考 card (live parity), so the grouped
    /// summary is parsed and the split events it restates are dropped — never one
    /// card per section.
    #[test]
    fn reasoning_summary_groups_sections_into_single_thinking_block() {
        let lines = vec![
            rollout_line(
                "2026-06-29T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "继续"}),
            ),
            // Streaming per-section events (must NOT each become a card).
            rollout_line(
                "2026-06-29T08:42:33.517Z",
                "event_msg",
                serde_json::json!({
                    "type": "agent_reasoning",
                    "text": "**Creating curl command**\n\nFirst section body."
                }),
            ),
            rollout_line(
                "2026-06-29T08:42:33.529Z",
                "event_msg",
                serde_json::json!({
                    "type": "agent_reasoning",
                    "text": "**Crafting the command**\n\nSecond section body."
                }),
            ),
            // Grouped summary written at the end of the reasoning turn.
            rollout_line(
                "2026-06-29T08:42:33.530Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [
                        {"type": "summary_text", "text": "**Creating curl command**\n\nFirst section body."},
                        {"type": "summary_text", "text": "**Crafting the command**\n\nSecond section body."}
                    ]
                }),
            ),
            rollout_line(
                "2026-06-29T08:42:33.943Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "done"}),
            ),
        ];
        let path = write_temp_rollout("reasoning-group", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-group")
            .expect("parse ok");

        let thinking = thinking_texts(&detail);
        assert_eq!(
            thinking.len(),
            1,
            "consecutive reasoning sections must render as ONE thinking block, got {}",
            thinking.len()
        );
        assert_eq!(
            thinking[0],
            "**Creating curl command**\n\nFirst section body.\n\n**Crafting the command**\n\nSecond section body."
        );

        let _ = fs::remove_file(path);
    }

    /// A reasoning item with an empty (encrypted-only) summary carries no
    /// surfaced text — the common case in real rollouts — and must produce no
    /// thinking card.
    #[test]
    fn empty_reasoning_summary_emits_no_thinking_block() {
        let lines = vec![
            rollout_line(
                "2026-06-29T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "hi"}),
            ),
            rollout_line(
                "2026-06-29T08:41:00Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_empty",
                    "summary": [],
                    "encrypted_content": "gAAAredacted"
                }),
            ),
            rollout_line(
                "2026-06-29T08:41:01Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "hello"}),
            ),
        ];
        let path = write_temp_rollout("reasoning-empty", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-empty")
            .expect("parse ok");

        assert!(
            thinking_texts(&detail).is_empty(),
            "empty reasoning summary must not emit a thinking block"
        );

        let _ = fs::remove_file(path);
    }

    /// Defensive fallback: an interrupted rollout whose `agent_reasoning` events
    /// were written but that ended before the grouped `response_item.reasoning`
    /// summary must still surface the streaming reasoning — flushed at EOF as ONE
    /// joined Thinking block, not lost.
    #[test]
    fn streaming_reasoning_without_summary_flushes_as_one_block() {
        let lines = vec![
            rollout_line(
                "2026-06-29T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-06-29T08:42:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**One**\n\nbody A"}),
            ),
            rollout_line(
                "2026-06-29T08:42:01Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**Two**\n\nbody B"}),
            ),
            // No response_item/reasoning — the file ends here (interruption).
        ];
        let path = write_temp_rollout("reasoning-nosummary", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-nosummary")
            .expect("parse ok");

        let thinking = thinking_texts(&detail);
        assert_eq!(
            thinking.len(),
            1,
            "buffered streaming reasoning must flush as ONE block, got {}",
            thinking.len()
        );
        assert_eq!(thinking[0], "**One**\n\nbody A\n\n**Two**\n\nbody B");

        let _ = fs::remove_file(path);
    }

    /// Same fallback, but the reasoning is followed by more content with no
    /// grouped summary (schema drift): the flushed Thinking block must stay in
    /// order — before the assistant message that follows it, never appended last.
    #[test]
    fn streaming_reasoning_without_summary_keeps_order_before_next_message() {
        let lines = vec![
            rollout_line(
                "2026-06-29T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-06-29T08:42:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**Plan**\n\nthinking"}),
            ),
            rollout_line(
                "2026-06-29T08:42:01Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "the answer"}),
            ),
        ];
        let path = write_temp_rollout("reasoning-order", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-order")
            .expect("parse ok");

        // Flatten assistant-side blocks in document order: the buffered reasoning
        // must be flushed as a Thinking block BEFORE the agent_message answer.
        let ordered: Vec<&str> = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::Thinking { .. } => Some("thinking"),
                ContentBlock::Text { text } if text == "the answer" => Some("answer"),
                _ => None,
            })
            .collect();
        assert_eq!(
            ordered,
            vec!["thinking", "answer"],
            "buffered reasoning must flush before the following assistant message"
        );
        assert_eq!(
            thinking_texts(&detail),
            vec!["**Plan**\n\nthinking".to_string()]
        );

        let _ = fs::remove_file(path);
    }

    /// One `response_item.reasoning` covers ONE model response. A long think
    /// spans several, so codex writes several of them back to back with nothing
    /// visible in between (up to 28 in a real rollout) — and live streams that
    /// as a single growing thought. History must too: the run is one 思考 card,
    /// and only a visible record (here a tool call) starts the next one.
    #[test]
    fn consecutive_reasoning_items_merge_into_one_thinking_block() {
        let lines = vec![
            rollout_line(
                "2026-09-02T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "继续"}),
            ),
            rollout_line(
                "2026-09-02T08:42:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**A**\n\nbody A"}),
            ),
            rollout_line(
                "2026-09-02T08:42:01Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**B**\n\nbody B"}),
            ),
            rollout_line(
                "2026-09-02T08:42:02Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [
                        {"type": "summary_text", "text": "**A**\n\nbody A"},
                        {"type": "summary_text", "text": "**B**\n\nbody B"}
                    ]
                }),
            ),
            // Second model response, still nothing visible in between.
            rollout_line(
                "2026-09-02T08:42:03Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**C**\n\nbody C"}),
            ),
            rollout_line(
                "2026-09-02T08:42:04Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_2",
                    "summary": [{"type": "summary_text", "text": "**C**\n\nbody C"}]
                }),
            ),
            // A tool call closes the run — what follows is a NEW thought.
            rollout_line(
                "2026-09-02T08:42:05Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call",
                    "name": "shell",
                    "call_id": "call_1",
                    "arguments": "{\"command\":[\"ls\"]}"
                }),
            ),
            rollout_line(
                "2026-09-02T08:42:06Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call_output",
                    "call_id": "call_1",
                    "output": "a.txt"
                }),
            ),
            rollout_line(
                "2026-09-02T08:42:07Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**D**\n\nbody D"}),
            ),
            rollout_line(
                "2026-09-02T08:42:08Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_3",
                    "summary": [{"type": "summary_text", "text": "**D**\n\nbody D"}]
                }),
            ),
            rollout_line(
                "2026-09-02T08:42:09Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "done"}),
            ),
        ];
        let path = write_temp_rollout("reasoning-run", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-run")
            .expect("parse ok");

        assert_eq!(
            thinking_texts(&detail),
            vec![
                "**A**\n\nbody A\n\n**B**\n\nbody B\n\n**C**\n\nbody C".to_string(),
                "**D**\n\nbody D".to_string(),
            ],
            "a run of reasoning items is ONE card; a tool call starts the next"
        );

        let _ = fs::remove_file(path);
    }

    /// An empty (encrypted-only) summary restates nothing, so it must not let a
    /// LATER summary — which only ever covers the sections after it — take the
    /// buffered sections before it down with the ones it supersedes.
    #[test]
    fn an_empty_reasoning_summary_mid_run_keeps_the_sections_before_it() {
        let lines = vec![
            rollout_line(
                "2026-09-02T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-09-02T08:42:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**A**\n\nbody A"}),
            ),
            rollout_line(
                "2026-09-02T08:42:01Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_enc",
                    "summary": [],
                    "encrypted_content": "gAAAredacted"
                }),
            ),
            rollout_line(
                "2026-09-02T08:42:02Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**B**\n\nbody B"}),
            ),
            rollout_line(
                "2026-09-02T08:42:03Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_2",
                    "summary": [{"type": "summary_text", "text": "**B**\n\nbody B"}]
                }),
            ),
            rollout_line(
                "2026-09-02T08:42:04Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "done"}),
            ),
        ];
        let path = write_temp_rollout("reasoning-encrypted-mid", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-encrypted-mid")
            .expect("parse ok");

        assert_eq!(
            thinking_texts(&detail),
            vec!["**A**\n\nbody A\n\n**B**\n\nbody B".to_string()],
            "the section before an encrypted-only item must survive the next summary"
        );

        let _ = fs::remove_file(path);
    }

    /// A `token_count` that lands inside an open reasoning run reports what the
    /// response that produced that reasoning spent. The run's card does not
    /// exist yet, so the round must wait for it instead of being billed to the
    /// turn before — which would move real spend onto an unrelated reply.
    #[test]
    fn a_token_count_inside_a_reasoning_run_bills_the_runs_own_card() {
        let lines = vec![
            rollout_line(
                "2026-09-02T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-09-02T08:41:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_message", "message": "first"}),
            ),
            rollout_line(
                "2026-09-02T08:41:01Z",
                "event_msg",
                serde_json::json!({"type": "token_count", "info": {
                    "total_token_usage": {"input_tokens": 1000, "cached_input_tokens": 0, "output_tokens": 50}
                }}),
            ),
            rollout_line(
                "2026-09-02T08:42:00Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**A**\n\nbody A"}),
            ),
            rollout_line(
                "2026-09-02T08:42:01Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_1",
                    "summary": [{"type": "summary_text", "text": "**A**\n\nbody A"}]
                }),
            ),
            // Mid-run: the response that wrote **A** reporting its own spend.
            rollout_line(
                "2026-09-02T08:42:02Z",
                "event_msg",
                serde_json::json!({"type": "token_count", "info": {
                    "total_token_usage": {"input_tokens": 1600, "cached_input_tokens": 0, "output_tokens": 80}
                }}),
            ),
            rollout_line(
                "2026-09-02T08:42:03Z",
                "event_msg",
                serde_json::json!({"type": "agent_reasoning", "text": "**B**\n\nbody B"}),
            ),
            rollout_line(
                "2026-09-02T08:42:04Z",
                "response_item",
                serde_json::json!({
                    "type": "reasoning",
                    "id": "rs_2",
                    "summary": [{"type": "summary_text", "text": "**B**\n\nbody B"}]
                }),
            ),
        ];
        let path = write_temp_rollout("reasoning-usage", &lines);
        let parser = CodexParser::new();
        let detail = parser
            .parse_conversation_detail(&path, "reasoning-usage")
            .expect("parse ok");

        let usage_of = |wanted: &str| -> u64 {
            detail
                .turns
                .iter()
                .find(|t| {
                    t.blocks.iter().any(|b| match (b, wanted) {
                        (ContentBlock::Thinking { .. }, "thinking") => true,
                        (ContentBlock::Text { text }, "first") => text == "first",
                        _ => false,
                    })
                })
                .and_then(|t| t.usage.as_ref())
                .map(|u| {
                    u.input_tokens
                        + u.output_tokens
                        + u.cache_creation_input_tokens
                        + u.cache_read_input_tokens
                })
                .unwrap_or(0)
        };

        assert_eq!(
            usage_of("first"),
            1_050,
            "the reply before the run keeps only its own round"
        );
        assert_eq!(
            usage_of("thinking"),
            630,
            "the round spent inside the run belongs to the run's card"
        );
        assert_eq!(turn_usage_total(&detail), 1_680, "no round is lost");

        let _ = fs::remove_file(path);
    }

    /// Multi-wait, no close (the real codex polling pattern): every parent
    /// narration in the active window must survive (incl. the final answer with
    /// no close), each `wait_agent` becomes its own `collab_agent` capsule built
    /// from only the agents IT returned, and the result text moves off the spawn
    /// execution capsule into those wait capsules.
    #[test]
    fn subagent_waits_emit_independent_collab_capsules_and_keep_narration() {
        let spawn = |ts: &str, call: &str, msg: &str| {
            rollout_line(
                ts,
                "response_item",
                serde_json::json!({
                    "type": "function_call", "call_id": call, "name": "spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":msg}).to_string(),
                }),
            )
        };
        let spawn_out = |ts: &str, call: &str, agent_id: &str| {
            rollout_line(
                ts,
                "response_item",
                serde_json::json!({
                    "type": "function_call_output", "call_id": call,
                    "output": serde_json::json!({"agent_id":agent_id}).to_string(),
                }),
            )
        };
        let wait = |ts: &str, call: &str, targets: serde_json::Value| {
            rollout_line(
                ts,
                "response_item",
                serde_json::json!({
                    "type": "function_call", "call_id": call, "name": "wait_agent",
                    "arguments": serde_json::json!({"targets":targets}).to_string(),
                }),
            )
        };
        let wait_out = |ts: &str, call: &str, status: serde_json::Value| {
            rollout_line(
                ts,
                "response_item",
                serde_json::json!({
                    "type": "function_call_output", "call_id": call,
                    "output": serde_json::json!({"status":status}).to_string(),
                }),
            )
        };
        let narration = |ts: &str, text: &str| {
            rollout_line(
                ts,
                "event_msg",
                serde_json::json!({"type":"agent_message","message":text}),
            )
        };

        let lines = vec![
            rollout_line(
                "2026-06-27T10:00:00Z",
                "session_meta",
                serde_json::json!({"id":"mw","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T10:00:01Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}),
            ),
            spawn("2026-06-27T10:00:02Z", "spawn_a", "task A"),
            spawn_out("2026-06-27T10:00:03Z", "spawn_a", "agent_a"),
            spawn("2026-06-27T10:00:04Z", "spawn_b", "task B"),
            spawn_out("2026-06-27T10:00:05Z", "spawn_b", "agent_b"),
            // active_agent_count == 2 here — old code dropped these three.
            narration("2026-06-27T10:00:06Z", "NARRATION_STARTED both started"),
            wait(
                "2026-06-27T10:00:07Z",
                "wait_1",
                serde_json::json!(["agent_a", "agent_b"]),
            ),
            // wait #1 returned ONLY agent_b (agent_a still running).
            wait_out(
                "2026-06-27T10:00:08Z",
                "wait_1",
                serde_json::json!({"agent_b":{"completed":"B_RESULT_TOKEN"}}),
            ),
            narration("2026-06-27T10:00:09Z", "NARRATION_MID B back waiting A"),
            wait("2026-06-27T10:00:10Z", "wait_2", serde_json::json!(["agent_a"])),
            wait_out(
                "2026-06-27T10:00:11Z",
                "wait_2",
                serde_json::json!({"agent_a":{"completed":"A_RESULT_TOKEN"}}),
            ),
            // Final answer with NO close → active never returns to 0.
            narration("2026-06-27T10:00:12Z", "NARRATION_FINAL summary"),
        ];

        let path = write_temp_rollout("multiwait", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "mw")
            .expect("parse ok");
        let blocks: Vec<&ContentBlock> =
            detail.turns.iter().flat_map(|t| t.blocks.iter()).collect();

        // Part A: every parent narration survives the active window.
        let all_text: String = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n");
        for token in ["NARRATION_STARTED", "NARRATION_MID", "NARRATION_FINAL"] {
            assert!(all_text.contains(token), "missing narration {token}");
        }

        // Part B: exactly two wait capsules, each with its own returned agent.
        let collab_inputs: Vec<&str> = blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "collab_agent" => input_preview.as_deref(),
                _ => None,
            })
            .collect();
        assert_eq!(collab_inputs.len(), 2, "one collab_agent capsule per wait");
        let b_cap = collab_inputs
            .iter()
            .find(|s| s.contains("B_RESULT_TOKEN"))
            .expect("wait capsule carrying B's result");
        assert!(b_cap.contains("agent_b"));
        assert!(
            !b_cap.contains("A_RESULT_TOKEN") && !b_cap.contains("agent_a"),
            "wait capsules must not overlap"
        );
        let a_cap = collab_inputs
            .iter()
            .find(|s| s.contains("A_RESULT_TOKEN"))
            .expect("wait capsule carrying A's result");
        assert!(a_cap.contains("agent_a"));
        // op-aware title source is present.
        assert!(a_cap.contains("__codegCollabOp"));

        // The result text must NOT remain on the spawn execution capsules or any
        // tool result (it lives only in the wait capsules now).
        for b in &blocks {
            match b {
                ContentBlock::ToolResult {
                    output_preview: Some(o),
                    ..
                } => {
                    assert!(
                        !o.contains("A_RESULT_TOKEN") && !o.contains("B_RESULT_TOKEN"),
                        "result leaked into a tool result"
                    );
                }
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview: Some(i),
                    ..
                } if tool_name == "Agent" => {
                    assert!(
                        !i.contains("A_RESULT_TOKEN") && !i.contains("B_RESULT_TOKEN"),
                        "result leaked into the execution capsule"
                    );
                }
                _ => {}
            }
        }

        let _ = fs::remove_file(path);
    }

    /// A sub-agent closed without ever being waited on: there is no wait capsule
    /// to host the result, so the execution capsule falls back to showing the
    /// close `previous_status` result (no data loss).
    #[test]
    fn subagent_close_without_wait_falls_back_to_execution_capsule() {
        let lines = vec![
            rollout_line(
                "2026-06-27T11:00:00Z",
                "session_meta",
                serde_json::json!({"id":"cf","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T11:00:01Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}),
            ),
            rollout_line(
                "2026-06-27T11:00:02Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"spawn_c","name":"spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":"task C"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T11:00:03Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"spawn_c",
                    "output": serde_json::json!({"agent_id":"agent_c"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T11:00:04Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"close_c","name":"close_agent",
                    "arguments": serde_json::json!({"target":"agent_c"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T11:00:05Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"close_c",
                    "output": serde_json::json!({"previous_status":{"completed":"C_RESULT_TOKEN"}}).to_string(),
                }),
            ),
        ];

        let path = write_temp_rollout("closefallback", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "cf")
            .expect("parse ok");
        let blocks: Vec<&ContentBlock> =
            detail.turns.iter().flat_map(|t| t.blocks.iter()).collect();

        let collab_count = blocks
            .iter()
            .filter(|b| matches!(b, ContentBlock::ToolUse { tool_name, .. } if tool_name == "collab_agent"))
            .count();
        assert_eq!(collab_count, 0, "no wait → no collab capsule");

        let spawn_c_result = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    ..
                } if id == "spawn_c" => Some(output_preview.clone()),
                _ => None,
            })
            .expect("spawn_c result block present");
        assert_eq!(
            spawn_c_result.as_deref(),
            Some("C_RESULT_TOKEN"),
            "execution capsule must show the close fallback result"
        );

        let _ = fs::remove_file(path);
    }

    /// A sub-agent closed (no wait) with a non-`completed` terminal result must
    /// keep that result AND mark the execution capsule failed — no data loss and
    /// live/history parity for errored no-wait closes.
    #[test]
    fn subagent_errored_close_without_wait_marks_execution_error() {
        let lines = vec![
            rollout_line(
                "2026-06-27T12:00:00Z",
                "session_meta",
                serde_json::json!({"id":"ce","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T12:00:01Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}),
            ),
            rollout_line(
                "2026-06-27T12:00:02Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"spawn_e","name":"spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":"risky"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T12:00:03Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"spawn_e",
                    "output": serde_json::json!({"agent_id":"agent_e"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T12:00:04Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"close_e","name":"close_agent",
                    "arguments": serde_json::json!({"target":"agent_e"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T12:00:05Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"close_e",
                    "output": serde_json::json!({"previous_status":{"errored":"BOOM_TOKEN"}}).to_string(),
                }),
            ),
        ];

        let path = write_temp_rollout("closeerr", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "ce")
            .expect("parse ok");
        let blocks: Vec<&ContentBlock> =
            detail.turns.iter().flat_map(|t| t.blocks.iter()).collect();

        assert!(
            !blocks
                .iter()
                .any(|b| matches!(b, ContentBlock::ToolUse { tool_name, .. } if tool_name == "collab_agent")),
            "no wait → no collab capsule"
        );
        let (output, is_error) = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "spawn_e" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("spawn_e result block present");
        assert_eq!(output.as_deref(), Some("BOOM_TOKEN"), "errored result kept");
        assert!(is_error, "errored no-wait close → execution capsule failed");

        let _ = fs::remove_file(path);
    }

    /// An errored wait marks BOTH its own wait capsule and the execution capsule
    /// as failed (the result text still lives only on the wait capsule).
    #[test]
    fn subagent_errored_wait_marks_execution_error() {
        let lines = vec![
            rollout_line(
                "2026-06-27T13:00:00Z",
                "session_meta",
                serde_json::json!({"id":"we","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T13:00:01Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}),
            ),
            rollout_line(
                "2026-06-27T13:00:02Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"spawn_w","name":"spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":"risky"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T13:00:03Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"spawn_w",
                    "output": serde_json::json!({"agent_id":"agent_w"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T13:00:04Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"wait_w","name":"wait_agent",
                    "arguments": serde_json::json!({"targets":["agent_w"]}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T13:00:05Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"wait_w",
                    "output": serde_json::json!({"status":{"agent_w":{"errored":"WAIT_BOOM"}}}).to_string(),
                }),
            ),
        ];

        let path = write_temp_rollout("waiterr", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "we")
            .expect("parse ok");
        let blocks: Vec<&ContentBlock> =
            detail.turns.iter().flat_map(|t| t.blocks.iter()).collect();

        // The wait capsule exists and carries the errored result text.
        let wait_input = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "collab_agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("wait capsule present");
        assert!(wait_input.contains("WAIT_BOOM") && wait_input.contains("errored"));

        // The execution capsule (spawn) is marked failed, with no result text on it.
        let (output, is_error) = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id: Some(id),
                    output_preview,
                    is_error,
                    ..
                } if id == "spawn_w" => Some((output_preview.clone(), *is_error)),
                _ => None,
            })
            .expect("spawn_w result block present");
        assert_eq!(output, None, "result stays on the wait capsule");
        assert!(is_error, "errored wait → execution capsule failed");

        let _ = fs::remove_file(path);
    }

    /// The spawn execution capsule's input carries the sub-agent's `agent_id`
    /// (UUID), so the card can badge it uniformly with the wait capsule.
    #[test]
    fn subagent_spawn_capsule_input_carries_agent_id() {
        let lines = vec![
            rollout_line(
                "2026-06-27T14:00:00Z",
                "session_meta",
                serde_json::json!({"id":"ai","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T14:00:01Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"go"}]}),
            ),
            rollout_line(
                "2026-06-27T14:00:02Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"spawn_x","name":"spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":"do it"}).to_string(),
                }),
            ),
            rollout_line(
                "2026-06-27T14:00:03Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"spawn_x",
                    "output": serde_json::json!({"agent_id":"AGENT_UUID_X"}).to_string(),
                }),
            ),
        ];

        let path = write_temp_rollout("spawnid", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "ai")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    tool_name,
                    input_preview,
                    ..
                } if id == "spawn_x" && tool_name == "Agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("spawn Agent capsule present");
        let parsed: serde_json::Value =
            serde_json::from_str(input).expect("spawn input is JSON");
        assert_eq!(
            parsed.get("agent_id").and_then(|v| v.as_str()),
            Some("AGENT_UUID_X"),
            "spawn capsule input must carry the agent_id"
        );
        // Original fields preserved.
        assert_eq!(
            parsed.get("subagent_type").and_then(|v| v.as_str()),
            Some("worker")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn native_team_spawn_names_the_task_and_hides_the_encrypted_message() {
        // codex 0.147's team-of-agents: `agent_type` became `task_name`, the
        // hand-off `message` became an encrypted envelope, and the spawn output
        // no longer returns an id — the `sub_agent_activity` event carries it,
        // correlated by the spawn's own call_id.
        let sealed = format!("gAAAAAB{}", "qgWsi0g7gOInVU3UTzqL".repeat(30));
        let lines = vec![
            rollout_line(
                "2026-08-16T07:47:37Z",
                "session_meta",
                serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-08-16T07:47:41Z",
                "response_item",
                serde_json::json!({"type":"message","role":"user","content":[{"type":"input_text","text":"跑一下构建"}]}),
            ),
            rollout_line(
                "2026-08-16T07:47:45Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"call_y7sk","name":"spawn_agent",
                    "namespace":"collaboration",
                    "arguments": serde_json::json!({
                        "task_name":"pnpm_build","fork_turns":"all","message": sealed,
                    }).to_string(),
                }),
            ),
            rollout_line(
                "2026-08-16T07:47:46Z",
                "event_msg",
                serde_json::json!({
                    "type":"sub_agent_activity","event_id":"call_y7sk",
                    "agent_thread_id":"01a0098a-7e8a-72d3-b7c0-2df130c84063",
                    "agent_path":"/root/pnpm_build","kind":"started",
                }),
            ),
            rollout_line(
                "2026-08-16T07:47:47Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"call_y7sk",
                    "output": serde_json::json!({"task_name":"/root/pnpm_build"}).to_string(),
                }),
            ),
        ];

        let path = write_temp_rollout("nativeteam", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    tool_name,
                    input_preview,
                    ..
                } if id == "call_y7sk" && tool_name == "Agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("spawn Agent capsule present");
        let parsed: serde_json::Value = serde_json::from_str(input).expect("spawn input is JSON");
        assert_eq!(
            parsed.get("subagent_type").and_then(|v| v.as_str()),
            Some("pnpm_build"),
            "the capsule must be named after the task, not the removed agent_type"
        );
        // The envelope is unreadable, so the capsule shows no prompt at all
        // rather than a wall of base64 in its title and prompt panel.
        assert_eq!(parsed.get("prompt").and_then(|v| v.as_str()), Some(""));
        assert_eq!(parsed.get("description").and_then(|v| v.as_str()), Some(""));
        assert_eq!(
            parsed.get("agent_id").and_then(|v| v.as_str()),
            Some("01a0098a-7e8a-72d3-b7c0-2df130c84063"),
            "the sub_agent_activity event is the only source of the thread id"
        );
        // 0.147 emits no wait/close capsule, so this card stands for the LAUNCH
        // only and must say so rather than read as "the sub-agent finished".
        assert_eq!(
            parsed.get(CODEX_SUBAGENT_LAUNCH_KEY).and_then(|v| v.as_bool()),
            Some(true)
        );

        let _ = fs::remove_file(path);
    }

    /// The 0.153.4 team-of-agents wire, transcribed from a real rollout:
    /// `SubAgentActivity` moved inside `item_completed`, `spawn_agent` returns
    /// an EMPTY output, and the child reports back through an inter-agent
    /// `agent_message` in the parent's own stream.
    fn native_team_0153_lines(final_answer_type: &str, sealed: &str) -> Vec<String> {
        vec![
            rollout_line(
                "2026-09-08T06:44:00Z",
                "session_meta",
                serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-09-08T06:44:31Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"call_0sY5","name":"spawn_agent",
                    "namespace":"collaboration",
                    "arguments": serde_json::json!({
                        "task_name":"history_limits","fork_turns":"all","message": sealed,
                    }).to_string(),
                }),
            ),
            rollout_line(
                "2026-09-08T06:44:31Z",
                "event_msg",
                serde_json::json!({
                    "type":"item_completed","thread_id":"parent",
                    "item":{
                        "type":"SubAgentActivity","id":"call_0sY5","kind":"started",
                        "agent_thread_id":"01a07fc2-db62-78b3-9762-9cb2540216c2",
                        "agent_path":"/root/history_limits",
                    },
                }),
            ),
            // 0.153.4 returns nothing at all from the spawn.
            rollout_line(
                "2026-09-08T06:44:32Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"call_0sY5","output":"",
                }),
            ),
            rollout_line(
                "2026-09-08T07:10:36Z",
                "response_item",
                serde_json::json!({
                    "type":"agent_message","id":"amsg_1",
                    "author":"/root/history_limits","recipient":"/root",
                    "content":[
                        {"type":"input_text","text": format!(
                            "Message Type: {final_answer_type}\nTask name: /root\nSender: /root/history_limits\nPayload:\n历史与运行预算增强已完成。"
                        )},
                    ],
                }),
            ),
            rollout_line(
                "2026-09-08T07:10:37Z",
                "event_msg",
                serde_json::json!({
                    "type":"item_completed","thread_id":"parent",
                    "item":{
                        "type":"SubAgentActivity",
                        "id":"subagent-completed-01a07fc2-dbcd","kind":"completed",
                        "agent_thread_id":"01a07fc2-db62-78b3-9762-9cb2540216c2",
                        "agent_path":"/root/history_limits",
                    },
                }),
            ),
        ]
    }

    /// The spawn capsule's `(input JSON, result text)` for `call_0sY5`.
    fn spawn_capsule(detail: &ConversationDetail) -> (serde_json::Value, Option<String>) {
        let blocks: Vec<&ContentBlock> =
            detail.turns.iter().flat_map(|t| t.blocks.iter()).collect();
        let input = blocks
            .iter()
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id: Some(id),
                    tool_name,
                    input_preview,
                    ..
                } if id == "call_0sY5" && tool_name == "Agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("spawn Agent capsule present");
        let output = blocks.iter().find_map(|b| match b {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                output_preview,
                ..
            } if id == "call_0sY5" => Some(output_preview.clone()),
            _ => None,
        });
        (
            serde_json::from_str(input).expect("spawn input is JSON"),
            output.flatten(),
        )
    }

    #[test]
    fn native_team_0153_reads_the_nested_subagent_activity() {
        // 0.153.4 retired `event_msg.sub_agent_activity` for a `SubAgentActivity`
        // nested in `item_completed`. Reading only the flat shape left every
        // capsule of that release with no `agent_id`, so the badge the live
        // stream showed vanished on reload and nothing could resolve the
        // child's own rollout.
        let sealed = format!("gAAAAAB{}", "qgWsi0g7gOInVU3UTzqL".repeat(30));
        let path = write_temp_rollout("nativeteam0153", &native_team_0153_lines("MESSAGE", &sealed));
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let (input, result) = spawn_capsule(&detail);

        assert_eq!(
            input.get("agent_id").and_then(|v| v.as_str()),
            Some("01a07fc2-db62-78b3-9762-9cb2540216c2"),
            "the nested SubAgentActivity carries the same spawn call_id the flat event did"
        );
        // The terminal record is a `completed` of its own, under a synthetic id
        // that shares nothing with the launch but the thread id.
        assert_eq!(
            input.get(CODEX_SUBAGENT_STATE_KEY).and_then(|v| v.as_str()),
            Some("completed")
        );
        // A non-terminal inter-agent message is sealed and says nothing, so it
        // must not be mistaken for the child's report.
        assert_eq!(
            result, None,
            "only FINAL_ANSWER carries a readable payload; MESSAGE is a Fernet blob"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_resumed_subagent_drops_its_previous_outcome() {
        // codex can bring a finished child back (`resumeAgent` / `followup_task`)
        // and announces it with a fresh `started`. The capsule must stop claiming
        // the run that has since resumed.
        let sealed = format!("gAAAAAB{}", "qgWsi0g7gOInVU3UTzqL".repeat(30));
        let mut lines = native_team_0153_lines("MESSAGE", &sealed);
        lines.push(rollout_line(
            "2026-09-08T07:20:00Z",
            "event_msg",
            serde_json::json!({
                "type":"item_completed","thread_id":"parent",
                "item":{
                    "type":"SubAgentActivity","id":"call_resume","kind":"started",
                    "agent_thread_id":"01a07fc2-db62-78b3-9762-9cb2540216c2",
                    "agent_path":"/root/history_limits",
                },
            }),
        ));
        let path = write_temp_rollout("nativeteamresume", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let (input, _) = spawn_capsule(&detail);
        assert_eq!(
            input.get(CODEX_SUBAGENT_STATE_KEY),
            None,
            "a restarted child is running again, not completed"
        );
        // The launch marker and the badge survive the restart.
        assert_eq!(
            input.get("agent_id").and_then(|v| v.as_str()),
            Some("01a07fc2-db62-78b3-9762-9cb2540216c2")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn native_team_final_answer_lands_on_the_spawn_capsule() {
        // The child's report reaches the PARENT's rollout as an addressed
        // `response_item.agent_message`, with no `item_completed` twin — so it
        // never reaches ACP and the rollout is the only place it exists. It
        // belongs to the child, so it is folded into that child's capsule
        // rather than emitted as narration of the parent's own.
        let sealed = format!("gAAAAAB{}", "qgWsi0g7gOInVU3UTzqL".repeat(30));
        let path = write_temp_rollout(
            "nativeteamfinal",
            &native_team_0153_lines("FINAL_ANSWER", &sealed),
        );
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let (_, result) = spawn_capsule(&detail);
        assert_eq!(result.as_deref(), Some("历史与运行预算增强已完成。"));

        // …and not ALSO as an assistant message, which would show the report
        // twice and attribute the child's words to the parent.
        let assistant_texts: Vec<&str> = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        assert!(
            !assistant_texts
                .iter()
                .any(|t| t.contains("历史与运行预算增强已完成")),
            "the report is the capsule's, not a parent message: {assistant_texts:?}"
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn list_agents_becomes_a_collab_capsule_without_the_root_row() {
        // `list_agents` returns a roster whose finished rows carry each child's
        // ENTIRE report — with the native team there is no `close_agent` and the
        // wait carries no text, so this is one of the few readable copies. It
        // used to render as raw JSON on the generic tool card.
        let lines = vec![
            rollout_line(
                "2026-09-08T07:11:00Z",
                "session_meta",
                serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-09-08T07:11:37Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"call_h62v","name":"list_agents",
                    "namespace":"collaboration","arguments":"{}",
                }),
            ),
            rollout_line(
                "2026-09-08T07:11:38Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"call_h62v",
                    "output": serde_json::json!({"agents":[
                        {"agent_name":"/root","agent_status":"running"},
                        {"agent_name":"/root/acceptance_fixture",
                         "agent_status":{"completed":"只读分析已完成。"}},
                        {"agent_name":"/root/query_core","agent_status":"running"},
                    ]}).to_string(),
                }),
            ),
        ];
        let path = write_temp_rollout("listagents", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "collab_agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("roster renders as a collab capsule, not a generic tool card");
        let parsed: serde_json::Value = serde_json::from_str(input).expect("collab input is JSON");
        assert_eq!(parsed.get(COLLAB_OP_KEY).and_then(|v| v.as_str()), Some("list"));
        let states = parsed
            .get("agentsStates")
            .and_then(|v| v.as_object())
            .expect("agentsStates present");
        assert!(
            !states.contains_key("/root"),
            "the parent is not one of its own sub-agents: {states:?}"
        );
        assert_eq!(
            states
                .get("/root/acceptance_fixture")
                .and_then(|a| a.get("message"))
                .and_then(|v| v.as_str()),
            Some("只读分析已完成。")
        );
        assert_eq!(
            states
                .get("/root/query_core")
                .and_then(|a| a.get("status"))
                .and_then(|v| v.as_str()),
            Some("running")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn subagent_rollout_drops_the_replayed_parent_history() {
        // A sub-agent rollout opens with however much of the parent's thread the
        // spawn carried over. Those records are the PARENT's; without the cut,
        // opening the child's session shows somebody else's conversation first.
        let header = serde_json::json!({
            "timestamp":"2026-09-08T06:44:31Z","ordinal":0,"type":"session_meta",
            "payload":{
                "id":"child","session_id":"parent","forked_from_id":"parent",
                "parent_thread_id":"parent","cwd":"/tmp/demo",
                "agent_path":"/root/history_limits","thread_source":"subagent",
                "subagent_history_start_ordinal": 3,
            },
        })
        .to_string();
        let numbered = |ordinal: u64, text: &str| {
            serde_json::json!({
                "timestamp":"2026-09-08T06:44:32Z","ordinal":ordinal,"type":"response_item",
                "payload":{"type":"message","role":"assistant",
                           "content":[{"type":"output_text","text":text}]},
            })
            .to_string()
        };
        let lines = vec![
            header.clone(),
            // The parent's own header, replayed into the child's file.
            serde_json::json!({
                "timestamp":"2026-09-08T06:44:31Z","ordinal":1,"type":"session_meta",
                "payload":{"id":"parent","cwd":"/tmp/demo"},
            })
            .to_string(),
            numbered(2, "parent said this"),
            numbered(3, "child said this"),
        ];

        let kept = trim_subagent_replay_prefix(lines);
        assert_eq!(kept.len(), 2, "header + the child's own record: {kept:?}");
        assert_eq!(kept[0], header, "the header declares the lineage — keep it");
        assert!(kept[1].contains("child said this"));

        // Without codex's own marker there is no exact cut, and guessing one
        // would be worse than showing the file as it is.
        let unmarked = vec![
            serde_json::json!({
                "timestamp":"2026-07-25T11:50:01Z","ordinal":0,"type":"session_meta",
                "payload":{"id":"child","forked_from_id":"parent",
                           "parent_thread_id":"parent","history_mode":"legacy"},
            })
            .to_string(),
            numbered(2, "parent said this"),
        ];
        assert_eq!(trim_subagent_replay_prefix(unmarked.clone()), unmarked);

        // A cut of 0 seeds nothing: the file is its own from the first record,
        // and the header must not be spliced in on top of itself.
        let unseeded = vec![
            serde_json::json!({
                "timestamp":"2026-09-08T06:44:31Z","ordinal":0,"type":"session_meta",
                "payload":{"id":"child","forked_from_id":"parent",
                           "parent_thread_id":"parent",
                           "subagent_history_start_ordinal": 0},
            })
            .to_string(),
            numbered(1, "child said this"),
        ];
        assert_eq!(trim_subagent_replay_prefix(unseeded.clone()), unseeded);
    }

    #[test]
    fn legacy_collab_spawn_keeps_its_run_semantics() {
        // The pre-0.147 shape DOES get a wait/close capsule carrying the
        // result, so its capsule really does stand for the run — it must not
        // pick up the launch-only caveat.
        let lines = vec![
            rollout_line(
                "2026-06-27T14:00:00Z",
                "session_meta",
                serde_json::json!({"id":"ai","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-06-27T14:00:02Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"spawn_x","name":"spawn_agent",
                    "arguments": serde_json::json!({"agent_type":"worker","message":"do it"}).to_string(),
                }),
            ),
        ];
        let path = write_temp_rollout("legacyspawn", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "ai")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "Agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("spawn Agent capsule present");
        let parsed: serde_json::Value = serde_json::from_str(input).expect("JSON");
        assert_eq!(parsed.get("subagent_type").and_then(|v| v.as_str()), Some("worker"));
        assert_eq!(parsed.get("prompt").and_then(|v| v.as_str()), Some("do it"));
        assert!(parsed.get(CODEX_SUBAGENT_LAUNCH_KEY).is_none());

        let _ = fs::remove_file(path);
    }

    #[test]
    fn send_message_shows_a_marker_instead_of_the_sealed_payload() {
        // `send_message` has no capsule of its own — it renders on the generic
        // tool card, whose preview is the whole argument JSON. Its `message` is
        // the same sealed envelope `spawn_agent` carries.
        let sealed = format!("gAAAAAB{}", "0g7gOInVU3UTzqL".repeat(30));
        let lines = vec![
            rollout_line(
                "2026-08-16T07:47:37Z",
                "session_meta",
                serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-08-16T07:47:50Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"call_send","name":"send_message",
                    "namespace":"collaboration",
                    "arguments": serde_json::json!({
                        "target":"/root/pnpm_build","message": sealed,
                    }).to_string(),
                }),
            ),
        ];
        let path = write_temp_rollout("sendmessage", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "send_message" => input_preview.as_deref(),
                _ => None,
            })
            .expect("send_message card present");
        assert!(
            !input.contains("gAAAAAB"),
            "the sealed payload must not reach the card: {input}"
        );
        assert!(input.contains("[encrypted]"), "{input}");
        // The readable arguments survive.
        assert!(input.contains("/root/pnpm_build"), "{input}");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn redaction_leaves_ordinary_arguments_untouched() {
        let mut args = serde_json::json!({"cmd":"pnpm build","timeout_ms":3600000});
        assert!(!redact_encrypted_args(&mut args));
        assert_eq!(args, serde_json::json!({"cmd":"pnpm build","timeout_ms":3600000}));
        // Nested and array positions are reached.
        let sealed = format!("gAAAAAB{}", "0g7gOInVU3UTzqL".repeat(10));
        let mut nested = serde_json::json!({"outer":{"list":[sealed.clone(),"keep me"]}});
        assert!(redact_encrypted_args(&mut nested));
        assert_eq!(
            nested,
            serde_json::json!({"outer":{"list":["[encrypted]","keep me"]}})
        );
    }

    #[test]
    fn redaction_visits_every_sibling_not_just_the_first() {
        // Guards the reason `redact_encrypted_children` is a loop: the obvious
        // `Iterator::any` (which clippy's `unnecessary_fold` even suggests)
        // stops at the first hit, so a second sealed sibling would reach the
        // card as half a kilobyte of base64.
        let sealed = format!("gAAAAAB{}", "0g7gOInVU3UTzqL".repeat(10));
        let mut args = serde_json::json!({
            "list": [sealed.clone(), sealed.clone()],
            "first": sealed.clone(),
            "second": sealed.clone(),
        });
        assert!(redact_encrypted_args(&mut args));
        assert_eq!(
            args,
            serde_json::json!({
                "list": ["[encrypted]", "[encrypted]"],
                "first": "[encrypted]",
                "second": "[encrypted]",
            })
        );
    }

    #[test]
    fn native_team_wait_renders_the_same_bare_capsule_history_and_live() {
        // codex-acp forwards `wait_agent` (unlike the spawn), so live shows a
        // 「fetch the sub-agent's result」 pill. Reload must show it too — it is
        // the only span in the timeline covering the child's actual run.
        let lines = vec![
            rollout_line(
                "2026-08-16T09:40:59Z",
                "session_meta",
                serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
            ),
            rollout_line(
                "2026-08-16T09:41:00Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call","call_id":"call_wait","name":"wait_agent",
                    "namespace":"collaboration",
                    "arguments": serde_json::json!({"timeout_ms":3600000}).to_string(),
                }),
            ),
            rollout_line(
                "2026-08-16T09:41:20Z",
                "response_item",
                serde_json::json!({
                    "type":"function_call_output","call_id":"call_wait",
                    "output": serde_json::json!({
                        "message":"Wait completed.","timed_out":false,
                    }).to_string(),
                }),
            ),
        ];
        let path = write_temp_rollout("nativewait", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "parent")
            .expect("parse ok");
        let input = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .find_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_name,
                    input_preview,
                    ..
                } if tool_name == "collab_agent" => input_preview.as_deref(),
                _ => None,
            })
            .expect("wait capsule present");
        let parsed: serde_json::Value = serde_json::from_str(input).expect("JSON");
        assert_eq!(parsed.get(COLLAB_OP_KEY).and_then(|v| v.as_str()), Some("wait"));
        assert_eq!(parsed.get("status").and_then(|v| v.as_str()), Some("completed"));
        // No agents and no prompt — the card renders as a bare pill, exactly
        // what the live `collabAgentToolCall` produces for this output.
        assert_eq!(
            parsed.get("agentsStates"),
            Some(&serde_json::json!({}))
        );
        let errored = detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .any(|b| matches!(b, ContentBlock::ToolResult { is_error: true, .. }));
        assert!(!errored, "a completed wait is not an error");

        let _ = fs::remove_file(path);
    }

    #[test]
    fn native_team_wait_shape_gate_and_timeout() {
        // `timed_out` is the shape gate: only the native-team output has it.
        assert!(native_team_wait_input(&serde_json::json!({"message":"Wait completed."})).is_none());
        assert!(native_team_wait_input(&serde_json::json!({})).is_none());
        // A timeout is a real outcome — flag the capsule failed.
        let (input, is_error) =
            native_team_wait_input(&serde_json::json!({"message":"x","timed_out":true}))
                .expect("native shape");
        assert!(is_error);
        let parsed: serde_json::Value = serde_json::from_str(&input).expect("JSON");
        assert_eq!(parsed.get("status").and_then(|v| v.as_str()), Some("failed"));
    }

    #[test]
    fn encrypted_envelope_detection_is_narrow() {
        let sealed = format!("gAAAAAB{}", "0g7gOInVU3UTzqL".repeat(10));
        assert!(is_encrypted_envelope(&sealed));
        assert!(is_encrypted_envelope(&format!("  {sealed}  ")));
        // A prompt that merely mentions or embeds base64 still renders: the
        // prefix must lead, the blob must be long, and it must be one token.
        assert!(!is_encrypted_envelope(&format!("decode this: {sealed}")));
        assert!(!is_encrypted_envelope(&format!("{sealed} and report back")));
        assert!(!is_encrypted_envelope("gAAAAAB"));
        assert!(!is_encrypted_envelope("run pnpm build"));
        assert!(!is_encrypted_envelope(""));
    }

    #[test]
    fn forked_child_transcript_yields_no_stats() {
        // A codex 0.147 sub-agent thread opens with its own `session_meta`
        // (carrying `parent_thread_id` AND `forked_from_id`) and then replays the
        // PARENT's history, tool calls included. Counting those would credit the
        // child with the parent's work, so the whole file is refused.
        //
        // `forked_from_id` is what makes it a replay, and on disk it is never
        // absent from one: the 23 sub-agent rollouts that carry it are exactly
        // the 23 that also hold the replayed second header below.
        let child = "01a0098a-7e8a-72d3-b7c0-2df130c84063";
        let dir = temp_session_dir("forked-child");
        // The lookup matches a rollout whose stem ends with the thread id,
        // which is exactly how codex names a sub-agent's file.
        fs::write(
            dir.join(format!("rollout-2026-08-16T07-47-46-{child}.jsonl")),
            [
                rollout_line(
                    "2026-08-16T07:47:46Z",
                    "session_meta",
                    serde_json::json!({
                        "id": child, "cwd": "/tmp/demo",
                        "parent_thread_id": "parent", "forked_from_id": "parent"
                    }),
                ),
                rollout_line(
                    "2026-08-16T07:47:46Z",
                    "session_meta",
                    serde_json::json!({"id":"parent","cwd":"/tmp/demo"}),
                ),
                rollout_line(
                    "2026-08-16T07:47:47Z",
                    "response_item",
                    serde_json::json!({
                        "type":"function_call","call_id":"parents_own","name":"exec_command",
                        "arguments": serde_json::json!({"cmd":"git status"}).to_string(),
                    }),
                ),
            ]
            .join("\n"),
        )
        .expect("write forked child");
        assert!(
            parse_codex_subagent_stats(&dir, child).is_none(),
            "a forked child transcript must contribute no stats"
        );

        // The same replay as codex actually writes it: the parent id lives under
        // the structured subagent source and there is NO flat mirror. Matching
        // only the flat field counted these files, crediting the child with the
        // parent's replayed tool calls.
        let structured = "019e88cb-ada0-7611-b7cf-25a6e3535722";
        fs::write(
            dir.join(format!("rollout-2026-06-02T22-45-10-{structured}.jsonl")),
            [
                rollout_line(
                    "2026-06-02T22:45:10Z",
                    "session_meta",
                    serde_json::json!({
                        "id": structured,
                        "cwd": "/tmp/demo",
                        "forked_from_id": "parent",
                        "source": {"subagent": {"thread_spawn": {
                            "parent_thread_id": "parent", "depth": 1, "agent_role": "explorer"
                        }}}
                    }),
                ),
                rollout_line(
                    "2026-06-02T22:45:10Z",
                    "session_meta",
                    serde_json::json!({"id": "parent", "cwd": "/tmp/demo"}),
                ),
                rollout_line(
                    "2026-06-02T22:45:11Z",
                    "response_item",
                    serde_json::json!({
                        "type":"function_call","call_id":"parents_own","name":"exec_command",
                        "arguments": serde_json::json!({"cmd":"git status"}).to_string(),
                    }),
                ),
            ]
            .join("\n"),
        )
        .expect("write structured forked child");
        assert!(
            parse_codex_subagent_stats(&dir, structured).is_none(),
            "the structured subagent shape must be refused too"
        );

        // A spawned child that was NOT seeded with the parent's history: it has a
        // parent thread id but no `forked_from_id` and no replayed header, so the
        // tool calls in it are its own and MUST still be counted. Half the
        // sub-agent rollouts on disk look like this; refusing them on the parent
        // id alone blanks the capsule's tool list for real work.
        let clean = "019d9929-6a00-7543-b045-172ebb06e5eb";
        fs::write(
            dir.join(format!("rollout-2026-04-17T01-58-42-{clean}.jsonl")),
            [
                rollout_line(
                    "2026-04-17T01:58:42Z",
                    "session_meta",
                    serde_json::json!({
                        "id": clean,
                        "cwd": "/tmp/demo",
                        "source": {"subagent": {"thread_spawn": {
                            "parent_thread_id": "parent", "depth": 1, "agent_role": "worker"
                        }}}
                    }),
                ),
                rollout_line(
                    "2026-04-17T01:58:43Z",
                    "response_item",
                    serde_json::json!({
                        "type":"function_call","call_id":"its_own","name":"exec_command",
                        "arguments": serde_json::json!({"cmd":"pnpm test"}).to_string(),
                    }),
                ),
            ]
            .join("\n"),
        )
        .expect("write clean child");
        let clean_stats =
            parse_codex_subagent_stats(&dir, clean).expect("a non-replayed child keeps its stats");
        assert_eq!(clean_stats.tool_calls.len(), 1);

        // The legacy shape has no replayed prefix and still resolves.
        fs::write(
            dir.join("agent-solo.jsonl"),
            [
                rollout_line(
                    "2026-08-16T07:47:46Z",
                    "session_meta",
                    serde_json::json!({"id":"solo","cwd":"/tmp/demo"}),
                ),
                rollout_line(
                    "2026-08-16T07:47:47Z",
                    "response_item",
                    serde_json::json!({
                        "type":"function_call","call_id":"c1","name":"exec_command",
                        "arguments": serde_json::json!({"cmd":"pnpm build"}).to_string(),
                    }),
                ),
            ]
            .join("\n"),
        )
        .expect("write own thread");
        let stats = parse_codex_subagent_stats(&dir, "solo").expect("stats for an own thread");
        assert_eq!(stats.tool_calls.len(), 1);

        let _ = fs::remove_dir_all(dir);
    }

    // ── codex code mode ──────────────────────────────────────────────────
    //
    // Newer codex wraps EVERY tool call in a JS script persisted as one
    // `custom_tool_call` named `exec`. Without unwrapping, the whole history
    // renders as `const r = await tools.…` shell cards (see
    // `parsers/codex_code_mode.rs`).

    fn tool_uses(
        detail: &crate::models::ConversationDetail,
    ) -> Vec<(String, String, Option<String>)> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id,
                    tool_name,
                    input_preview,
                    ..
                } => Some((
                    tool_use_id.clone().unwrap_or_default(),
                    tool_name.clone(),
                    input_preview.clone(),
                )),
                _ => None,
            })
            .collect()
    }

    /// `(tool_use_id, status)` per ToolUse block. Separate from `tool_uses`
    /// because only the semantic MCP cards carry a status at all — codex
    /// leaves it `None` everywhere else (see `ContentBlock::ToolUse::status`).
    fn tool_use_statuses(
        detail: &crate::models::ConversationDetail,
    ) -> Vec<(String, Option<String>)> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::ToolUse {
                    tool_use_id,
                    status,
                    ..
                } => Some((tool_use_id.clone().unwrap_or_default(), status.clone())),
                _ => None,
            })
            .collect()
    }

    fn tool_results(
        detail: &crate::models::ConversationDetail,
    ) -> Vec<(String, Option<String>, bool)> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::ToolResult {
                    tool_use_id,
                    output_preview,
                    is_error,
                    ..
                } => Some((
                    tool_use_id.clone().unwrap_or_default(),
                    output_preview.clone(),
                    *is_error,
                )),
                _ => None,
            })
            .collect()
    }

    fn code_mode_rollout(script: &str, output: serde_json::Value) -> Vec<String> {
        vec![
            rollout_line(
                "2026-07-20T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-07-20T08:40:01Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "call_1",
                    "input": script,
                }),
            ),
            rollout_line(
                "2026-07-20T08:40:02Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call_output",
                    "call_id": "call_1",
                    "output": output,
                }),
            ),
        ]
    }

    #[test]
    fn code_mode_single_call_renders_as_the_inner_tool() {
        let lines = code_mode_rollout(
            "const r = await tools.exec_command({\n  cmd: \"git status --short\",\n  workdir: \"/repo\"\n});\ntext(r.output);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.5 seconds\nOutput:\n"},
                {"type": "input_text", "text": " M src/main.rs"},
            ]),
        );
        let path = write_temp_rollout("code-mode-single", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-single")
            .expect("parse ok");

        assert_eq!(
            tool_uses(&detail),
            vec![(
                "call_1".to_string(),
                "exec_command".to_string(),
                Some("git status --short".to_string())
            )]
        );
        assert_eq!(
            tool_results(&detail),
            vec![(
                "call_1".to_string(),
                Some(" M src/main.rs".to_string()),
                false
            )]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn completed_mcp_items_split_a_two_call_one_chunk_script() {
        let script = concat!(
            "const wd=\"/tmp\";const taskA=\"A\";const taskB=\"B\";",
            "const [a,b]=await Promise.all([",
            "tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",working_dir:wd,task:taskA}),",
            "tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",working_dir:wd,task:taskB})",
            "]);text(JSON.stringify({a,b}));"
        );
        assert!(
            crate::parsers::codex_code_mode::parse_code_mode_script(script)
                .calls
                .is_none(),
            "the real variable-argument shape cannot be statically evaluated"
        );
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type":"input_text","text":"Script completed\nWall time 0.2 seconds\nOutput:\n"},
                {"type":"input_text","text":"{\"a\":{},\"b\":{}}"},
            ]),
        );
        for (offset, (id, task_id, task)) in [
            ("exec-b", "task-b", "B"),
            ("exec-a", "task-a", "A"),
        ]
        .into_iter()
        .enumerate()
        {
            lines.insert(
                2 + offset,
                rollout_line(
                    "2026-07-20T08:40:01Z",
                    "event_msg",
                    serde_json::json!({
                        "type": "item_completed",
                        "item": {
                            "type": "McpToolCall",
                            "id": id,
                            "server": "codeg-mcp",
                            "tool": "delegate_to_agent",
                            "arguments": {"agent_type":"codex", "task":task},
                            "status": "completed",
                            "result": {
                                "content": [{"type":"text", "text":format!(
                                    "Delegation successful. task_id={task_id}."
                                )}],
                                "structuredContent": {"task_id":task_id, "status":"running"},
                                "isError": false
                            }
                        }
                    }),
                ),
            );
        }

        let detail = parse_lines(&lines, "code-mode-semantic-mcp");
        let uses = tool_uses(&detail);
        assert_eq!(
            uses.iter()
                .map(|(id, name, _)| (id.as_str(), name.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("exec-b", "mcp__codeg_mcp__delegate_to_agent"),
                ("exec-a", "mcp__codeg_mcp__delegate_to_agent"),
            ],
            "semantic items replace the outer script with real MCP cards"
        );
        assert_eq!(
            uses[0].2.as_deref(),
            Some(r#"{"agent_type":"codex","task":"B"}"#)
        );
        assert_eq!(
            uses[1].2.as_deref(),
            Some(r#"{"agent_type":"codex","task":"A"}"#)
        );
        assert_eq!(
            tool_results(&detail)
                .into_iter()
                .map(|(id, output, _)| (id, output))
                .collect::<Vec<_>>(),
            vec![
                ("exec-b".into(), Some("Delegation successful. task_id=task-b.".into())),
                ("exec-a".into(), Some("Delegation successful. task_id=task-a.".into())),
            ]
        );
    }

    #[test]
    fn mixed_native_collaboration_and_semantic_delegation_keep_their_identities() {
        // Keep the upstream native team wire in the same rollout as both the
        // initial MCP delegation and its continuation delegation. The records are
        // deliberately interleaved: each semantic item must stay with its
        // own code-mode script while the native spawn keeps its child session.
        let sealed = format!("gAAAAAB{}", "qgWsi0g7nV3UTzqL".repeat(30));
        let native = native_team_0153_lines("FINAL_ANSWER", &sealed);
        let initial_script =
            "const r = await tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",working_dir:\"/tmp/mcp-worker\",task:\"semantic initial\"});text(JSON.stringify(r));";
        let continuation_script =
            "const r = await tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",working_dir:\"/tmp/mcp-worker\",task:\"semantic followup\",continue_from_task_id:\"task-semantic-initial\"});text(JSON.stringify(r));";
        let initial_status = serde_json::json!({
            "task_id": "task-semantic-initial",
            "child_conversation_id": 901,
            "status": "running",
        });
        let continuation_status = serde_json::json!({
            "task_id": "task-semantic-next",
            "child_conversation_id": 901,
            "status": "running",
        });
        let lines = vec![
            native[0].clone(), // session_meta
            rollout_line(
                "2026-09-08T06:44:10Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "exec-semantic-initial",
                    "input": initial_script,
                }),
            ),
            rollout_line(
                "2026-09-08T06:44:11Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "mcp-semantic-initial",
                        "server": "codeg-mcp",
                        "tool": "delegate_to_agent",
                        "arguments": {
                            "agent_type": "codex",
                            "working_dir": "/tmp/mcp-worker",
                            "task": "semantic initial",
                        },
                        "status": "completed",
                        "result": {
                            "content": [{
                                "type": "text",
                                "text": format!(
                                    "Delegation successful. task_id={}. child_conversation_id=901.",
                                    initial_status["task_id"]
                                        .as_str()
                                        .expect("initial task id"),
                                ),
                            }],
                            "structuredContent": initial_status,
                            "isError": false,
                        },
                    },
                }),
            ),
            native[1].clone(), // native spawn_agent
            native[2].clone(), // native SubAgentActivity started
            native[3].clone(), // native spawn result
            rollout_line(
                "2026-09-08T06:44:33Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call_output",
                    "call_id": "exec-semantic-initial",
                    "output": [
                        {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                        {"type": "input_text", "text": initial_status.to_string()},
                    ],
                }),
            ),
            rollout_line(
                "2026-09-08T06:44:34Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "exec-semantic-continuation",
                    "input": continuation_script,
                }),
            ),
            rollout_line(
                "2026-09-08T06:44:35Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "mcp-semantic-continuation",
                        "server": "codeg-mcp",
                        "tool": "delegate_to_agent",
                        "arguments": {
                            "agent_type": "codex",
                            "working_dir": "/tmp/mcp-worker",
                            "task": "semantic followup",
                            "continue_from_task_id": "task-semantic-initial",
                        },
                        "status": "completed",
                        "result": {
                            "content": [{
                                "type": "text",
                                "text": format!(
                                    "Delegation successful. task_id={}. child_conversation_id=901.",
                                    continuation_status["task_id"]
                                        .as_str()
                                        .expect("continuation task id"),
                                ),
                            }],
                            "structuredContent": continuation_status,
                            "isError": false,
                        },
                    },
                }),
            ),
            native[4].clone(), // native agent_message result
            rollout_line(
                "2026-09-08T06:44:36Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call_output",
                    "call_id": "exec-semantic-continuation",
                    "output": [
                        {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                        {"type": "input_text", "text": continuation_status.to_string()},
                    ],
                }),
            ),
            native[5].clone(), // native SubAgentActivity completed
        ];

        let detail = parse_lines(&lines, "mixed-native-semantic-delegation");
        let uses = tool_uses(&detail);
        let semantic_uses: Vec<_> = uses
            .iter()
            .filter(|(id, _, _)| id.starts_with("mcp-semantic-"))
            .map(|(id, name, input)| (id.as_str(), name.as_str(), input.as_deref()))
            .collect();
        assert_eq!(
            semantic_uses,
            vec![
                (
                    "mcp-semantic-initial",
                    "mcp__codeg_mcp__delegate_to_agent",
                    Some(
                        r#"{"agent_type":"codex","working_dir":"/tmp/mcp-worker","task":"semantic initial"}"#,
                    ),
                ),
                (
                    "mcp-semantic-continuation",
                    "mcp__codeg_mcp__delegate_to_agent",
                    Some(
                        r#"{"agent_type":"codex","working_dir":"/tmp/mcp-worker","task":"semantic followup","continue_from_task_id":"task-semantic-initial"}"#,
                    ),
                ),
            ],
            "semantic MCP cards keep their own item ids, tool names, and inputs"
        );
        assert!(
            !uses
                .iter()
                .any(|(id, name, _)| id.starts_with("exec-semantic-") || name == "exec"),
            "completed semantic scripts must not remain as generic exec cards: {uses:?}"
        );

        let semantic_results: Vec<_> = tool_results(&detail)
            .into_iter()
            .filter(|(id, _, _)| id.starts_with("mcp-semantic-"))
            .collect();
        assert_eq!(
            semantic_results,
            vec![
                (
                    "mcp-semantic-initial".to_string(),
                    Some(
                        "Delegation successful. task_id=task-semantic-initial. child_conversation_id=901."
                            .to_string(),
                    ),
                    false,
                ),
                (
                    "mcp-semantic-continuation".to_string(),
                    Some(
                        "Delegation successful. task_id=task-semantic-next. child_conversation_id=901."
                            .to_string(),
                    ),
                    false,
                ),
            ],
            "each semantic result stays on its matching MCP card"
        );

        let (native_input, native_result) = spawn_capsule(&detail);
        assert_eq!(
            native_input.get("agent_id").and_then(|value| value.as_str()),
            Some("01a07fc2-db62-78b3-9762-9cb2540216c2"),
            "native activity must keep its own child session id"
        );
        assert_eq!(
            native_result.as_deref(),
            Some("历史与运行预算增强已完成。"),
            "native agent_message must stay attached to the native spawn"
        );
    }

    #[test]
    fn a_deferred_scripts_late_mcp_item_cannot_bind_to_the_next_script() {
        let script = "const r=await tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",task:\"A\"});text(JSON.stringify(r));";
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!("Script running with cell ID 34\nWall time 30.0 seconds\nOutput:\n"),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            serde_json::json!({
                "type":"custom_tool_call", "name":"exec", "call_id":"call_b",
                "input":script.replace("task:\"A\"", "task:\"B\"")
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:40:04Z",
            "event_msg",
            serde_json::json!({
                "type":"item_completed",
                "item": {
                    "type":"McpToolCall", "id":"exec-from-a", "server":"codeg-mcp",
                    "tool":"delegate_to_agent", "arguments":{"task":"A"},
                    "status":"completed", "result":{"content":[], "isError":false}
                }
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:40:05Z",
            "response_item",
            serde_json::json!({
                "type":"custom_tool_call_output", "call_id":"call_b",
                "output":"Script completed\nWall time 0.1 seconds\nOutput:\nB"
            }),
        ));

        let ids: Vec<String> = tool_uses(&parse_lines(&lines, "deferred-mcp-boundary"))
            .into_iter()
            .map(|(id, _, _)| id)
            .collect();
        assert_eq!(ids, ["call_1", "call_b"]);
    }

    /// A refused MCP call still lets the SCRIPT finish, so the wrapper's own
    /// `Script completed` says nothing about the call inside it. The card has to
    /// settle on the semantic item's outcome or it contradicts the result block
    /// written beside it. Shape taken verbatim from a real rollout: codeg-mcp
    /// refuses a `delegate_to_agent` past the delegation depth limit.
    #[test]
    fn a_failed_semantic_mcp_item_settles_its_card_as_failed() {
        let script = concat!(
            "const dir=\"/tmp/w\";",
            "const res=await tools.mcp__codeg_mcp__delegate_to_agent({agent_type:\"codex\",working_dir:dir,task:t});",
            "text(res.content[0].text);"
        );
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type":"input_text","text":"Script completed\nWall time 0.0 seconds\nOutput:\n"},
                {"type":"input_text","text":"depth limit exceeded (2 >= 2)"},
            ]),
        );
        lines.insert(
            2,
            rollout_line(
                "2026-07-20T08:40:01Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "exec-depth-limit",
                        "server": "codeg-mcp",
                        "tool": "delegate_to_agent",
                        "arguments": {"agent_type":"codex", "working_dir":"/tmp/w"},
                        "status": "failed",
                        "result": {
                            "content": [{"type":"text", "text":"depth limit exceeded (2 >= 2)"}],
                            "structuredContent": {"error_code":"depth_limit", "status":"failed"},
                            "isError": true
                        }
                    }
                }),
            ),
        );

        let detail = parse_lines(&lines, "semantic-mcp-failed");
        assert_eq!(
            tool_use_statuses(&detail),
            vec![("exec-depth-limit".to_string(), Some("failed".to_string()))],
            "the card must report the call's own outcome, not the wrapper's"
        );
        assert_eq!(
            tool_results(&detail),
            vec![(
                "exec-depth-limit".to_string(),
                Some("depth limit exceeded (2 >= 2)".to_string()),
                true,
            )]
        );
    }

    /// A tool whose SUCCESSFUL answer merely reads like a failure — it wraps a
    /// command and prints its exit code, or opens with `Error:` — must not be
    /// painted as a failed call. The record says `isError: false` outright, and
    /// an authoritative field beats the text heuristic that exists only because
    /// a script card has none.
    #[test]
    fn an_explicit_success_survives_output_text_that_reads_like_an_error() {
        let script = concat!(
            "const cmd=\"pnpm build\";",
            "const r=await tools.mcp__shell_srv__run({cmd});",
            "text(r.content[0].text);"
        );
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type":"input_text","text":"Script completed\nWall time 0.2 seconds\nOutput:\n"},
                {"type":"input_text","text":"Error: 2 problems\nexit code: 1"},
            ]),
        );
        lines.insert(
            2,
            rollout_line(
                "2026-07-20T08:40:01Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "exec-lint",
                        "server": "shell-srv",
                        "tool": "run",
                        "arguments": {"cmd":"pnpm build"},
                        "status": "completed",
                        "result": {
                            "content": [{"type":"text", "text":"Error: 2 problems\nexit code: 1"}],
                            "isError": false
                        }
                    }
                }),
            ),
        );

        let detail = parse_lines(&lines, "semantic-mcp-noisy-success");
        assert_eq!(
            tool_use_statuses(&detail),
            vec![("exec-lint".to_string(), Some("completed".to_string()))]
        );
        assert_eq!(
            tool_results(&detail),
            vec![(
                "exec-lint".to_string(),
                Some("Error: 2 problems\nexit code: 1".to_string()),
                false,
            )],
            "the record's own isError is the outcome, not what the output reads like"
        );
    }

    /// The semantic path throws the wrapper's printed output away, so a result
    /// that carries no text of its own must still be given something to say —
    /// otherwise a completed call reloads as a card with an empty body where
    /// the script card used to show the run.
    #[test]
    fn a_textless_semantic_result_still_says_something() {
        let script = "const shot=await tools.mcp__shot_srv__capture({url:target});text(\"captured\");";
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type":"input_text","text":"Script completed\nWall time 0.4 seconds\nOutput:\n"},
                {"type":"input_text","text":"captured"},
            ]),
        );
        lines.insert(
            2,
            rollout_line(
                "2026-07-20T08:40:01Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "exec-shot",
                        "server": "shot-srv",
                        "tool": "capture",
                        "arguments": {"url":"https://example.test"},
                        "status": "completed",
                        "result": {
                            "content": [{"type":"image", "data":"iVBORw0KGgo=", "mimeType":"image/png"}],
                            "isError": false
                        }
                    }
                }),
            ),
        );

        let detail = parse_lines(&lines, "semantic-mcp-textless");
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1, "one card: {results:?}");
        let (id, output, is_error) = &results[0];
        assert_eq!(id, "exec-shot");
        assert!(!is_error, "an image-only answer is not a failure");
        assert!(
            output.as_deref().is_some_and(|text| text.contains("image")),
            "a textless result must still carry its content: {output:?}"
        );
    }

    /// The guard that keeps every correlation honest: a script that mixes an
    /// MCP call with a shell call publishes only ONE semantic item, so the
    /// items cannot be zipped onto the call sites. Real shape — a status poll
    /// racing a `write_stdin` — from a rollout on disk. The script card (or its
    /// static decomposition) has to keep the turn rather than let the lone item
    /// claim a site it may not own.
    #[test]
    fn a_script_mixing_mcp_and_shell_calls_keeps_its_static_reading() {
        let lines_with_item = |item: bool| {
            let mut lines = code_mode_rollout(
                concat!(
                    "const rs = await Promise.all([\n",
                    "  tools.mcp__codeg_mcp__get_delegation_status({task_ids:[\"t1\"],wait_ms:30000}),\n",
                    "  tools.write_stdin({session_id:480,chars:\"y\\n\"}),\n",
                    "]);\ntext(JSON.stringify(rs));"
                ),
                serde_json::json!([
                    {"type":"input_text","text":"Script completed\nWall time 30.0 seconds\nOutput:\n"},
                    {"type":"input_text","text":"[{\"tasks\":[]},{}]"},
                ]),
            );
            if item {
                lines.insert(
                    2,
                    rollout_line(
                        "2026-07-20T08:40:01Z",
                        "event_msg",
                        serde_json::json!({
                            "type": "item_completed",
                            "item": {
                                "type": "McpToolCall",
                                "id": "exec-poll",
                                "server": "codeg-mcp",
                                "tool": "get_delegation_status",
                                "arguments": {"task_ids":["t1"], "wall_ms":30000},
                                "status": "completed",
                                "result": {"content":[{"type":"text","text":"{\"tasks\":[]}"}], "isError":false}
                            }
                        }),
                    ),
                );
            }
            let detail = parse_lines(
                &lines,
                if item { "mixed-with-item" } else { "mixed-baseline" },
            );
            (tool_uses(&detail), tool_results(&detail))
        };

        let with_item = lines_with_item(true);
        assert!(
            !with_item.0.iter().any(|(id, _, _)| id == "exec-poll"),
            "one item cannot cover two call sites: {with_item:?}"
        );
        assert_eq!(
            with_item,
            lines_with_item(false),
            "an uncorrelatable item must leave the script's own reading untouched"
        );
    }

    /// A script that threw keeps its own card even when its one MCP call did
    /// publish a semantic item. The wrapper's `Script error:` text is the whole
    /// story of that turn — which line threw, and after which call — and the
    /// semantic path DISCARDS it. The count gate cannot stand in for this: a
    /// script can throw after its last call answered, leaving exactly as many
    /// items as call sites.
    #[test]
    fn a_thrown_script_keeps_its_own_card_over_a_matching_semantic_item() {
        let script = concat!(
            "const r=await tools.mcp__codeg_mcp__task_progress({message:m});",
            "text(r.content[0].text.toUpperCase());"
        );
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type":"input_text","text":"Script failed\nWall time 0.1 seconds\nOutput:\n"},
                {"type":"input_text","text":"Script error:\nTypeError: Cannot read properties of undefined"},
            ]),
        );
        lines.insert(
            2,
            rollout_line(
                "2026-07-20T08:40:01Z",
                "event_msg",
                serde_json::json!({
                    "type": "item_completed",
                    "item": {
                        "type": "McpToolCall",
                        "id": "exec-progress",
                        "server": "codeg-mcp",
                        "tool": "task_progress",
                        "arguments": {"message":"halfway"},
                        "status": "completed",
                        "result": {"content":[{"type":"text","text":"recorded"}], "isError":false},
                    },
                }),
            ),
        );

        let detail = parse_lines(&lines, "semantic-mcp-thrown-script");
        assert!(
            !tool_uses(&detail)
                .iter()
                .any(|(id, _, _)| id == "exec-progress"),
            "a thrown script must not be replaced by the call that did answer"
        );
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1, "one card: {results:?}");
        assert!(results[0].2, "a thrown script still renders as an error");
        assert!(
            results[0]
                .1
                .as_deref()
                .is_some_and(|text| text.contains("TypeError")),
            "the thrown script's own error must survive: {:?}",
            results[0].1
        );
    }

    /// The sink is what makes a preview bounded: it has to STOP the writer, not
    /// grow to fit it. Without the refusal, `serde_json` would keep handing it
    /// the rest of a base64 blob.
    #[test]
    fn a_budgeted_sink_stops_at_its_budget() {
        use std::io::Write;
        let mut sink = BudgetedSink {
            buf: Vec::new(),
            budget: 8,
        };
        assert!(sink.write_all(&[b'x'; 5]).is_ok(), "room for the first write");
        assert!(
            sink.write_all(&[b'x'; 100]).is_err(),
            "a write past the budget must fail so serialization aborts"
        );
        assert_eq!(sink.buf.len(), 8, "and never buffer more than the budget");
    }

    /// Reading a value through a budget must be INDISTINGUISHABLE from
    /// serializing the whole thing and cutting it — otherwise the bound is a
    /// behavior change wearing a performance fix's clothes. The cases that can
    /// tell them apart: a value that fits, one landing exactly on the cap, one
    /// far past it, and one whose characters are multi-byte, where the byte cut
    /// lands mid-character and decoding leaves a replacement char behind.
    #[test]
    fn a_budgeted_preview_reads_exactly_like_an_unbounded_one() {
        for (name, value) in [
            ("a small object", serde_json::json!({"a": 1, "b": [true, null]})),
            ("empty", serde_json::json!({})),
            ("exactly the cap", serde_json::json!("x".repeat(3998))),
            ("one past the cap", serde_json::json!("x".repeat(3999))),
            (
                "a base64 blob",
                serde_json::json!([{"type":"image","mimeType":"image/png","data":"A".repeat(500_000)}]),
            ),
            ("multi-byte text", serde_json::json!("汉".repeat(6000))),
        ] {
            let whole = serde_json::to_string(&value).expect("serialize");
            assert_eq!(
                serialize_preview(&value, MCP_RESULT_FALLBACK_CAP),
                Some(truncate_str(&whole, MCP_RESULT_FALLBACK_CAP)),
                "{name}"
            );
        }
    }

    /// The marker search reads a block's own outcome fields and stops there.
    /// Walking on into `data` would read the PAYLOAD — the base64 the cap
    /// refuses to copy, which the text heuristic would then lowercase into a
    /// second copy of itself. This pins the VERDICT that follows from that (a
    /// payload reading like an error is still just bytes); what it cannot see
    /// is the cost, so the reasoning lives on `blocks_report_failure`.
    ///
    /// (Under the cap nothing is cut, so the ordinary preview path parses the
    /// whole thing exactly as it always has — that is not this arm's business.)
    #[test]
    fn an_oversized_block_payload_is_never_read_as_an_outcome() {
        let call = completed_mcp_call(&serde_json::json!({
            "item": {
                "type": "McpToolCall", "id": "i", "server": "s", "tool": "t",
                "result": {
                    "content": [{
                        "type": "image",
                        "mimeType": "image/png",
                        "data": format!("error: {}", "A".repeat(MCP_RESULT_FALLBACK_CAP * 2)),
                    }],
                },
            }
        }))
        .expect("well-formed item");
        assert!(
            call.output_preview
                .as_deref()
                .is_some_and(|text| text.ends_with("...")),
            "the payload is past the cap, so the preview is cut"
        );
        assert!(!call.is_error, "a payload is bytes, not a verdict");
    }

    /// The block fallback IS truncated, so its outcome must not be read back
    /// out of the cut string — the blocks themselves decide. Same failure as
    /// the structured case: parse a truncated document and you get nothing,
    /// and nothing reads as success.
    #[test]
    fn a_long_block_failure_survives_its_own_truncation() {
        let call = completed_mcp_call(&serde_json::json!({
            "item": {
                "type": "McpToolCall", "id": "i", "server": "s", "tool": "t",
                "result": {
                    "content": [{
                        "type": "resource",
                        "padding": "p".repeat(MCP_RESULT_FALLBACK_CAP * 2),
                        "status": "failed",
                    }],
                },
            }
        }))
        .expect("well-formed item");
        assert!(
            call.output_preview
                .as_deref()
                .is_some_and(|text| text.ends_with("...")),
            "the card's copy is still cut: {:?}",
            call.output_preview.as_deref().map(str::len)
        );
        assert!(
            call.is_error,
            "a failure reported inside the blocks survives the cut"
        );
    }

    /// Why the structured answer is the one preview that is NOT truncated: it
    /// is read twice. The card shows it, and the error heuristic re-parses it
    /// — a preview opening with `{` is parsed back into JSON and searched for
    /// a failed `status`. Cut that JSON and the parse fails silently, and a
    /// call that reported failure settles GREEN. The padding is what makes the
    /// record longer than any cap worth applying, and it sorts before `status`
    /// so a cut would take the status with it.
    #[test]
    fn a_long_structured_failure_is_not_cut_into_a_success() {
        let call = completed_mcp_call(&serde_json::json!({
            "item": {
                "type": "McpToolCall", "id": "i", "server": "s", "tool": "t",
                "result": {
                    "content": [],
                    "structuredContent": {
                        "padding": "p".repeat(MCP_RESULT_FALLBACK_CAP * 2),
                        "status": "failed",
                    },
                },
            }
        }))
        .expect("well-formed item");
        assert!(
            call.output_preview
                .as_deref()
                .is_some_and(|text| serde_json::from_str::<serde_json::Value>(text).is_ok()),
            "a structured answer must reach the heuristic still parseable"
        );
        assert!(
            call.is_error,
            "a record that states nothing but reports a failed structured status is a failure"
        );
    }

    /// The outcome precedence, stated once against the fields themselves rather
    /// than through four rollouts: a stated failure outranks a stated success,
    /// a stated success outranks output text that merely reads like a failure,
    /// and the text heuristic still decides a record that states nothing.
    #[test]
    fn a_semantic_records_stated_outcome_outranks_its_output_text() {
        let is_error = |status: Option<&str>, result: serde_json::Value| {
            let mut item = serde_json::json!({
                "type": "McpToolCall", "id": "i", "server": "s", "tool": "t",
            });
            if let Some(status) = status {
                item["status"] = status.into();
            }
            if !result.is_null() {
                item["result"] = result;
            }
            completed_mcp_call(&serde_json::json!({ "item": item }))
                .expect("well-formed item")
                .is_error
        };
        // Output a successful tool can legitimately return: a wrapped command's
        // own complaint. `infer_output_text_is_error` reads it as a failure.
        let noisy = serde_json::json!({
            "content": [{"type":"text", "text":"Error: 2 problems\nexit code: 1"}]
        });
        let flagged = |flag: bool| {
            let mut result = noisy.clone();
            result["isError"] = flag.into();
            result
        };

        assert!(
            is_error(None, noisy.clone()),
            "a record that states nothing leaves the text to decide"
        );
        assert!(
            !is_error(Some("completed"), noisy.clone()),
            "a stated success outranks output that merely reads like a failure"
        );
        assert!(
            !is_error(None, flagged(false)),
            "isError alone is enough to state that success"
        );
        assert!(
            is_error(Some("completed"), flagged(true)),
            "a stated failure outranks a stated success"
        );
        assert!(
            is_error(Some("failed"), flagged(false)),
            "and does so whichever field states it"
        );
        assert!(
            !is_error(
                Some("completed"),
                serde_json::json!({"content":[{"type":"text","text":"fine"}], "isError":false}),
            ),
            "quiet output with nothing wrong stays clean"
        );
        assert!(
            completed_mcp_call(&serde_json::json!({
                "item": {
                    "type":"McpToolCall", "id":"i", "server":"s", "tool":"t",
                    "status":"completed", "error":"connection refused", "result": null,
                }
            }))
            .expect("well-formed item")
            .is_error,
            "a transport error is stated too, even beside a completed status"
        );
    }

    #[test]
    fn code_mode_parallel_calls_split_output_per_card() {
        let lines = code_mode_rollout(
            "const rs = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nrs.forEach(r => text(r.output));\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "out-one"},
                {"type": "input_text", "text": "out-two"},
                {"type": "input_text", "text": "out-three"},
            ]),
        );
        let path = write_temp_rollout("code-mode-split", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-split")
            .expect("parse ok");

        assert_eq!(
            tool_uses(&detail),
            vec![
                (
                    "call_1#0".to_string(),
                    "exec_command".to_string(),
                    Some("one".to_string())
                ),
                (
                    "call_1#1".to_string(),
                    "exec_command".to_string(),
                    Some("two".to_string())
                ),
                (
                    "call_1#2".to_string(),
                    "exec_command".to_string(),
                    Some("three".to_string())
                ),
            ]
        );
        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".to_string(), Some("out-one".to_string()), false),
                ("call_1#1".to_string(), Some("out-two".to_string()), false),
                ("call_1#2".to_string(), Some("out-three".to_string()), false),
            ]
        );

        let _ = fs::remove_file(path);
    }

    const THREE_CALLS: &str = "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nfor (const x of r) { text(x.output); text(`exit_code=${x.exit_code}`); }\n";

    /// `text(x.output); text(\`exit_code=…\`)` — two chunks per call, so the 1:1
    /// count fails and the whole thing used to stay one script card.
    #[test]
    fn a_trailing_chunk_per_call_still_splits_per_call() {
        let lines = code_mode_rollout(
            THREE_CALLS,
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "out-one"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "out-two"},
                {"type": "input_text", "text": "exit_code=1"},
                {"type": "input_text", "text": "out-three"},
                {"type": "input_text", "text": "exit_code=0"},
            ]),
        );
        let path = write_temp_rollout("code-mode-stride-tail", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-stride-tail")
            .expect("parse ok");

        assert_eq!(
            tool_uses(&detail),
            vec![
                (
                    "call_1#0".to_string(),
                    "exec_command".to_string(),
                    Some("one".to_string())
                ),
                (
                    "call_1#1".to_string(),
                    "exec_command".to_string(),
                    Some("two".to_string())
                ),
                (
                    "call_1#2".to_string(),
                    "exec_command".to_string(),
                    Some("three".to_string())
                ),
            ]
        );
        assert_eq!(
            tool_results(&detail),
            vec![
                (
                    "call_1#0".to_string(),
                    Some("out-one\nexit_code=0".to_string()),
                    false
                ),
                (
                    "call_1#1".to_string(),
                    Some("out-two\nexit_code=1".to_string()),
                    false
                ),
                (
                    "call_1#2".to_string(),
                    Some("out-three\nexit_code=0".to_string()),
                    false
                ),
            ]
        );

        let _ = fs::remove_file(path);
    }

    /// The other half of the shape: a `---RESULT n---` header ahead of each
    /// output. The counter differs per call, so the repeat is only visible with
    /// digits blinded — and each chunk of the group is unwrapped on its own, so
    /// an envelope behind a header still reads as a terminal.
    #[test]
    fn a_numbered_header_per_call_still_splits_per_call() {
        let envelope = |out: &str| {
            serde_json::json!({
                "chunk_id": "abc123",
                "wall_time_seconds": 0.5,
                "exit_code": 0,
                "original_token_count": 9,
                "output": out,
            })
            .to_string()
        };
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"})\n]);\nr.forEach((x, i) => { text(`---RESULT ${i + 1}---`); text(JSON.stringify(x)); });\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "---RESULT 1---"},
                {"type": "input_text", "text": envelope("out-one")},
                {"type": "input_text", "text": "---RESULT 2---"},
                {"type": "input_text", "text": envelope("out-two")},
            ]),
        );
        let path = write_temp_rollout("code-mode-stride-head", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-stride-head")
            .expect("parse ok");

        assert_eq!(
            tool_results(&detail),
            vec![
                (
                    "call_1#0".to_string(),
                    Some("---RESULT 1---\nout-one".to_string()),
                    false
                ),
                (
                    "call_1#1".to_string(),
                    Some("---RESULT 2---\nout-two".to_string()),
                    false
                ),
            ]
        );

        let _ = fs::remove_file(path);
    }

    /// The adversarial version of the shape above: the second command's own
    /// stdout IS `exit_code=0`, so slot 1 of every assumed pair repeats and the
    /// chunk content alone stops telling the two loops apart. Only the script
    /// says which it is — two loops, so no grouping.
    #[test]
    fn a_command_whose_output_mimics_the_marker_does_not_force_a_grouping() {
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"printf one\"}),\n  tools.exec_command({cmd:\"printf 'exit_code=0'\"}),\n  tools.exec_command({cmd:\"printf three\"})\n]);\nfor (const x of r) text(x.output);\nfor (const x of r) text(`exit_code=${x.exit_code}`);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "one"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "three"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "exit_code=0"},
            ]),
        );
        let path = write_temp_rollout("code-mode-stride-mimic", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-stride-mimic")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1);
        assert!(results[0]
            .1
            .as_deref()
            .expect("script output")
            .starts_with("one\nexit_code=0\nthree"));

        let _ = fs::remove_file(path);
    }

    /// Dividing evenly is NOT the proof. This script prints every output and
    /// then every exit code — the same 6 chunks for 3 calls as the interleaved
    /// shape above, in an order where grouping them in pairs would pin call 2's
    /// output to call 1's card. Only the script says which shape it is.
    #[test]
    fn chunks_that_merely_divide_evenly_are_not_grouped() {
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nfor (const x of r) text(x.output);\nfor (const x of r) text(`exit_code=${x.exit_code}`);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "out-one"},
                {"type": "input_text", "text": "out-two"},
                {"type": "input_text", "text": "out-three"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "exit_code=0"},
                {"type": "input_text", "text": "exit_code=0"},
            ]),
        );
        let path = write_temp_rollout("code-mode-stride-interleaved", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-stride-interleaved")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);

        let _ = fs::remove_file(path);
    }

    /// What codex sends instead of the chunks when a script's `text()` stream is
    /// too long: the whole stream re-rendered as one blob, one line per `text()`,
    /// behind a banner declaring how many lines it started with.
    fn collapsed_blob(declared: usize, outputs: &[&str]) -> String {
        let lines: Vec<String> = outputs
            .iter()
            .enumerate()
            .map(|(index, out)| {
                serde_json::json!({
                    "chunk_id": format!("chunk{index}"),
                    "wall_time_seconds": 0.5,
                    "exit_code": 0,
                    "original_token_count": 9,
                    "output": out,
                })
                .to_string()
            })
            .collect();
        format!(
            "Warning: truncated output (original token count: 10644)\nTotal output lines: {declared}\n\n{}",
            lines.join("\n")
        )
    }

    #[test]
    fn a_collapsed_output_blob_splits_back_into_one_card_per_call() {
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nfor (const x of r) text(x);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": collapsed_blob(3, &["out-one", "out-two", "out-three"])},
            ]),
        );
        let path = write_temp_rollout("code-mode-collapsed", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-collapsed")
            .expect("parse ok");

        assert_eq!(
            tool_uses(&detail),
            vec![
                (
                    "call_1#0".to_string(),
                    "exec_command".to_string(),
                    Some("one".to_string())
                ),
                (
                    "call_1#1".to_string(),
                    "exec_command".to_string(),
                    Some("two".to_string())
                ),
                (
                    "call_1#2".to_string(),
                    "exec_command".to_string(),
                    Some("three".to_string())
                ),
            ]
        );
        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".to_string(), Some("out-one".to_string()), false),
                ("call_1#1".to_string(), Some("out-two".to_string()), false),
                ("call_1#2".to_string(), Some("out-three".to_string()), false),
            ]
        );

        let _ = fs::remove_file(path);
    }

    /// One call, one line, and the line is the raw result object — the shape
    /// that used to leave a card whose entire body was `{"chunk_id":…}`.
    #[test]
    fn a_collapsed_single_call_blob_still_shows_its_output() {
        let lines = code_mode_rollout(
            "const r = await tools.exec_command({cmd:\"cargo test\"});\ntext(r);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 9.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": collapsed_blob(1, &["test result: ok. 42 passed"])},
            ]),
        );
        let path = write_temp_rollout("code-mode-collapsed-single", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-collapsed-single")
            .expect("parse ok");

        assert_eq!(
            tool_results(&detail),
            vec![(
                "call_1".to_string(),
                Some("test result: ok. 42 passed".to_string()),
                false
            )]
        );

        let _ = fs::remove_file(path);
    }

    /// Past the cap codex drops whole lines — and it drops them from the middle,
    /// so a survivor's position no longer names its call. Measured: with a line
    /// missing, 13 of 57 checkable lines belong to a different command than
    /// their position claims. Splitting anyway would put a command's output
    /// under another command's title, so the script card stays.
    #[test]
    fn a_collapsed_blob_missing_a_line_keeps_the_script_card() {
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"}),\n  tools.exec_command({cmd:\"three\"})\n]);\nfor (const x of r) text(x);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": collapsed_blob(3, &["out-one", "out-three"])},
            ]),
        );
        let path = write_temp_rollout("code-mode-collapsed-lossy", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-collapsed-lossy")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1);
        assert!(results[0]
            .1
            .as_deref()
            .expect("script output")
            .starts_with("Warning: truncated output"));

        let _ = fs::remove_file(path);
    }

    /// The same banner fronts the far more common case: ONE command whose own
    /// stdout was too long. Its lines are stdout, not `text()` results, and
    /// splitting them would shred one command's output across every card.
    #[test]
    fn a_truncated_command_output_is_not_read_as_one_line_per_call() {
        let lines = code_mode_rollout(
            "const r = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"})\n]);\ntext(r[0].output);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "Warning: truncated output (original token count: 900)\nTotal output lines: 2\n\nfirst line of stdout\nsecond line of stdout"},
            ]),
        );
        let path = write_temp_rollout("code-mode-collapsed-stdout", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-collapsed-stdout")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1);
        assert!(results[0]
            .1
            .as_deref()
            .expect("script output")
            .contains("first line of stdout\nsecond line of stdout"));

        let _ = fs::remove_file(path);
    }

    /// Fewer `text()` chunks than calls means chunk *i* is NOT provably call
    /// *i*'s output — keep one script card rather than misattribute.
    #[test]
    fn code_mode_mismatched_chunks_keep_the_script_card() {
        let lines = code_mode_rollout(
            "const rs = await Promise.all([\n  tools.exec_command({cmd:\"one\"}),\n  tools.exec_command({cmd:\"two\"})\n]);\ntext(JSON.stringify(rs));\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.1 seconds\nOutput:\n"},
                {"type": "input_text", "text": "[{\"output\":\"a\"},{\"output\":\"b\"}]"},
            ]),
        );
        let path = write_temp_rollout("code-mode-mismatch", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-mismatch")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
        let card: serde_json::Value =
            serde_json::from_str(uses[0].2.as_deref().expect("script card input"))
                .expect("script card input is JSON");
        assert_eq!(card["title"], "one");
        assert_eq!(card["call_count"], 2);
        assert!(card["source"]
            .as_str()
            .expect("source")
            .contains("Promise.all"));

        let results = tool_results(&detail);
        assert_eq!(results.len(), 1);
        assert_eq!(
            results[0].1.as_deref(),
            Some("[{\"output\":\"a\"},{\"output\":\"b\"}]")
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn code_mode_apply_patch_renders_as_a_patch_card() {
        let lines = code_mode_rollout(
            "const patch = \"*** Begin Patch\\n*** Update File: a.rs\\n@@\\n-old\\n+new\\n*** End Patch\";\nconst result = await tools.apply_patch(patch);\ntext(result);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.2 seconds\nOutput:\n"},
                {"type": "input_text", "text": "Success. Updated the following files:\nM a.rs"},
            ]),
        );
        let path = write_temp_rollout("code-mode-patch", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-patch")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, "apply_patch");
        assert!(uses[0]
            .2
            .as_deref()
            .expect("patch text")
            .starts_with("*** Begin Patch"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn code_mode_script_failure_marks_the_result_as_an_error() {
        let lines = code_mode_rollout(
            "const r = await tools.exec_command({cmd: \"rm -rf /tmp/x\"});\ntext(r.output);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script failed\nWall time 0.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "Script error:\nexec_command failed for `rm -rf /tmp/x`"},
            ]),
        );
        let path = write_temp_rollout("code-mode-failed", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-failed")
            .expect("parse ok");

        let results = tool_results(&detail);
        assert_eq!(results.len(), 1);
        assert!(results[0].2, "a failed script must render as an error");

        let _ = fs::remove_file(path);
    }

    /// An interrupted turn never writes the output record; the script card must
    /// stay where it was rather than vanish or jump to the end.
    #[test]
    fn code_mode_call_without_output_keeps_its_script_card() {
        let lines = vec![
            rollout_line(
                "2026-07-20T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-07-20T08:40:01Z",
                "response_item",
                serde_json::json!({
                    "type": "custom_tool_call",
                    "name": "exec",
                    "call_id": "call_1",
                    "input": "const r = await tools.exec_command({cmd: \"sleep 60\"});",
                }),
            ),
        ];
        let path = write_temp_rollout("code-mode-dangling", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-dangling")
            .expect("parse ok");

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
        assert!(tool_results(&detail).is_empty());

        let _ = fs::remove_file(path);
    }

    /// The unified-exec `wait` tool shares code mode's array output shape; it
    /// used to render as a raw `[{"text":"Script completed…` JSON blob.
    #[test]
    fn wait_tool_output_is_joined_text_not_raw_json() {
        let lines = vec![
            rollout_line(
                "2026-07-20T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-07-20T08:40:01Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call",
                    "name": "wait",
                    "call_id": "call_w",
                    "arguments": "{\"cell_id\":\"55\",\"yield_time_ms\":30000}",
                }),
            ),
            rollout_line(
                "2026-07-20T08:40:09Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call_output",
                    "call_id": "call_w",
                    "output": [
                        {"type": "input_text", "text": "Script completed\nWall time 5.6 seconds\nOutput:\n"},
                        {"type": "input_text", "text": "test result: ok. 12 passed"},
                    ],
                }),
            ),
        ];
        let path = write_temp_rollout("code-mode-wait", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "code-mode-wait")
            .expect("parse ok");

        assert_eq!(
            tool_results(&detail),
            vec![(
                "call_w".to_string(),
                Some("test result: ok. 12 passed".to_string()),
                false
            )]
        );

        let _ = fs::remove_file(path);
    }

    /// `wait` / `write_stdin` carry a session id, never a command — which is
    /// why their cards used to be titled by the bare tool name. The command
    /// that started the session is recovered from the announcement in that
    /// command's own output.
    fn session_tool_rollout(
        exec_output: serde_json::Value,
        session_call: serde_json::Value,
    ) -> Vec<String> {
        let mut lines = background_session_head(exec_output);
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            session_call,
        ));
        lines
    }

    /// `pnpm dev`, answered with whatever it had printed when unified-exec's
    /// yield ran out.
    fn background_session_head(exec_output: serde_json::Value) -> Vec<String> {
        vec![
            rollout_line(
                "2026-07-20T08:40:00Z",
                "event_msg",
                serde_json::json!({"type": "user_message", "message": "go"}),
            ),
            rollout_line(
                "2026-07-20T08:40:01Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call",
                    "name": "exec_command",
                    "call_id": "call_e",
                    "arguments": "{\"cmd\":\"pnpm dev\",\"yield_time_ms\":1000}",
                }),
            ),
            rollout_line(
                "2026-07-20T08:40:02Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call_output",
                    "call_id": "call_e",
                    "output": exec_output,
                }),
            ),
        ]
    }

    /// One `write_stdin` collecting more of a background session's output, and
    /// the output it collected.
    fn poll_lines(call_id: &str, args: &str, output: serde_json::Value) -> Vec<String> {
        vec![
            rollout_line(
                "2026-07-20T08:40:03Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call",
                    "name": "write_stdin",
                    "call_id": call_id,
                    "arguments": args,
                }),
            ),
            rollout_line(
                "2026-07-20T08:40:04Z",
                "response_item",
                serde_json::json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": output,
                }),
            ),
        ]
    }

    fn parse_lines(lines: &[String], tag: &str) -> crate::models::ConversationDetail {
        let path = write_temp_rollout(tag, lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, tag)
            .expect("parse ok");
        let _ = fs::remove_file(path);
        detail
    }

    fn session_tool_input(lines: &[String], tag: &str) -> Option<String> {
        tool_uses(&parse_lines(lines, tag))
            .into_iter()
            .find(|(id, _, _)| id == "call_s")
            .and_then(|(_, _, input)| input)
    }

    /// A call that gets a card of its own — here a `wait` that also kills the
    /// session — is titled by the command it is acting on, not by the bare tool
    /// name. (A call that only collects output gets no card at all; see
    /// `polling_a_background_session_appends_to_the_card_of_its_command`.)
    #[test]
    fn wait_carries_the_command_whose_session_it_polls() {
        let lines = session_tool_rollout(
            serde_json::json!(
                "Chunk ID: 523e44\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\nstarting…"
            ),
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "call_s",
                "arguments": "{\"cell_id\":\"22068\",\"terminate\":true,\"yield_time_ms\":30000}",
            }),
        );

        let input: serde_json::Value =
            serde_json::from_str(&session_tool_input(&lines, "session-wait").expect("input"))
                .expect("json args");
        assert_eq!(input["session_command"], "pnpm dev");
        // The original arguments survive untouched next to it.
        assert_eq!(input["cell_id"], "22068");
        assert_eq!(input["yield_time_ms"], 30000);
    }

    #[test]
    fn write_stdin_resolves_a_numeric_session_id_from_a_code_mode_result() {
        let lines = session_tool_rollout(
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "{\"chunk_id\":\"a74f94\",\"session_id\":7106,\"output\":\"\"}"},
            ]),
            serde_json::json!({
                "type": "function_call",
                "name": "write_stdin",
                "call_id": "call_s",
                "arguments": "{\"session_id\":7106,\"chars\":\"q\\n\"}",
            }),
        );

        let input: serde_json::Value =
            serde_json::from_str(&session_tool_input(&lines, "session-stdin").expect("input"))
                .expect("json args");
        assert_eq!(input["session_command"], "pnpm dev");
    }

    /// A `wait` / `write_stdin` that only collects output is the earlier command
    /// still running — not a second command. Before this, a `cargo test` cut
    /// short by unified-exec's yield showed as two adjacent cards with the same
    /// title, the first holding a few lines of output and the second holding
    /// the rest.
    #[test]
    fn polling_a_background_session_appends_to_the_card_of_its_command() {
        let mut lines = background_session_head(serde_json::json!(
            "Chunk ID: 523e44\nWall time: 30.0 seconds\nProcess running with session ID 22068\nOutput:\n   Compiling codeg"
        ));
        // Nothing new yet, and the session says so by naming itself again.
        lines.extend(poll_lines(
            "call_p1",
            "{\"session_id\":22068,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a1\nWall time: 30.0 seconds\nProcess running with session ID 22068\nOutput:\n"
            ),
        ));
        lines.extend(poll_lines(
            "call_p2",
            "{\"session_id\":22068,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\ntest result: ok. 1 passed"
            ),
        ));

        let detail = parse_lines(&lines, "session-fold");
        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1, "polls must not add cards: {uses:?}");
        assert_eq!(uses[0].1, "exec_command");

        let results = tool_results(&detail);
        assert_eq!(results.len(), 1, "{results:?}");
        let output = results[0].1.clone().expect("output");
        assert_eq!(output, "   Compiling codeg\ntest result: ok. 1 passed");
    }

    /// The chunk envelope in its object form — what a script that prints its
    /// `exec_command` result verbatim leaves behind. Unwrapped to the output it
    /// carries, exactly like the string form's header is stripped, so a folded
    /// session does not read as JSON followed by terminal output.
    #[test]
    fn a_code_mode_exec_result_shows_its_output_not_its_envelope() {
        let mut lines = code_mode_rollout(
            "const r = await tools.exec_command({cmd:\"pnpm dev\"});\ntext(JSON.stringify(r));\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "{\"chunk_id\":\"6a10a9\",\"wall_time_seconds\":1.0,\"session_id\":75100,\"original_token_count\":0,\"output\":\"\"}"},
            ]),
        );
        lines.extend(poll_lines(
            "call_p",
            "{\"session_id\":75100,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 9.0 seconds\nProcess exited with code 0\nOutput:\n[INFO] Scanning for projects..."
            ),
        ));

        let detail = parse_lines(&lines, "session-envelope");
        let results = tool_results(&detail);
        assert_eq!(results.len(), 1, "{results:?}");
        // The envelope is gone; what the command printed took its place.
        assert_eq!(
            results[0].1.as_deref(),
            Some("[INFO] Scanning for projects...")
        );
    }

    /// Keystrokes are an action, not a poll: they earn a card, and everything
    /// the session prints afterwards belongs below that card rather than folded
    /// back above it.
    #[test]
    fn keystrokes_get_a_card_and_end_the_folding() {
        let mut lines = background_session_head(serde_json::json!(
            "Chunk ID: 523e44\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\noverwrite? [y/N]"
        ));
        lines.extend(poll_lines(
            "call_k",
            "{\"session_id\":22068,\"chars\":\"y\\n\"}",
            serde_json::json!(
                "Chunk ID: 9a1\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\nwriting"
            ),
        ));
        lines.extend(poll_lines(
            "call_p",
            "{\"session_id\":22068,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\ndone"
            ),
        ));

        let detail = parse_lines(&lines, "session-keys");
        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 3, "{uses:?}");
        assert_eq!(uses[1].0, "call_k");
        assert_eq!(uses[2].0, "call_p");

        let results = tool_results(&detail);
        let origin = results
            .iter()
            .find(|(id, _, _)| id == "call_e")
            .expect("origin result");
        assert_eq!(origin.1.as_deref(), Some("overwrite? [y/N]"));
    }

    /// A command's own JSON stdout may well carry `chunk_id` and `output`.
    /// Truncating it to the `output` field would silently drop the rest, so the
    /// whole envelope shape has to be there before anything is unwrapped.
    #[test]
    fn json_stdout_that_only_resembles_an_envelope_is_left_whole() {
        let payload =
            r#"{"chunk_id":"artifact-7","output":"ok","checksum":"abc","files":["a.rs"]}"#;
        let lines = code_mode_rollout(
            "const r = await tools.exec_command({cmd: \"node build.js\"});\ntext(r.output);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": payload},
            ]),
        );

        let detail = parse_lines(&lines, "envelope-lookalike");
        assert_eq!(
            tool_results(&detail)
                .first()
                .and_then(|(_, out, _)| out.clone())
                .as_deref(),
            Some(payload)
        );
    }

    /// One `tools.exec_command` call site driven by a loop is many commands. The
    /// first command literal in the source is then just a guess, and a session
    /// some later command started would be titled — and folded — under it.
    #[test]
    fn a_looped_call_site_attributes_no_session() {
        let mut lines = code_mode_rollout(
            "const cmds = [\"pnpm build\", \"pnpm dev\"];\nfor (const cmd of cmds) {\n  const r = await tools.exec_command({cmd});\n  text(JSON.stringify(r));\n}\n",
            // Two commands ran; the second announced session 4242.
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "{\"chunk_id\":\"a1\",\"wall_time_seconds\":1.0,\"original_token_count\":0,\"exit_code\":0,\"output\":\"built\"}"},
                {"type": "input_text", "text": "{\"chunk_id\":\"b2\",\"wall_time_seconds\":1.0,\"original_token_count\":0,\"session_id\":4242,\"output\":\"\"}"},
            ]),
        );
        lines.extend(poll_lines(
            "call_p",
            "{\"session_id\":4242,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 1.0 seconds\nProcess exited with code 0\nOutput:\nready"
            ),
        ));

        let detail = parse_lines(&lines, "looped-site");
        let poll = tool_uses(&detail)
            .into_iter()
            .find(|(id, _, _)| id == "call_p")
            .expect("the poll keeps its card");
        let input = poll.2.expect("input");
        assert!(
            !input.contains("session_command"),
            "session 4242 was started by one of two commands — attributing it to \
             either is a guess: {input}"
        );
    }

    /// The numeric session id and the hex chunk id name the same cell. Once a
    /// keystroke earns a card, a poll arriving through the *other* spelling must
    /// not still fold its output in above that card.
    #[test]
    fn an_action_ends_the_folding_for_every_alias_of_its_session() {
        let mut lines = background_session_head(serde_json::json!(
            "Chunk ID: 523e44\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\noverwrite? [y/N]"
        ));
        lines.extend(poll_lines(
            "call_k",
            "{\"session_id\":22068,\"chars\":\"y\\n\"}",
            serde_json::json!(
                "Chunk ID: 9a1\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\nwriting"
            ),
        ));
        // Same cell, addressed by the chunk id of the announcing envelope.
        lines.extend(poll_lines(
            "call_p",
            "{\"session_id\":\"523e44\",\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\ndone"
            ),
        ));

        let detail = parse_lines(&lines, "session-alias-boundary");
        let results = tool_results(&detail);
        let origin = results
            .iter()
            .find(|(id, _, _)| id == "call_e")
            .expect("origin result");
        assert_eq!(origin.1.as_deref(), Some("overwrite? [y/N]"));
        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 3, "the alias poll keeps its own card: {uses:?}");
    }

    /// codex names sessions after pids, and pids come back around. Whichever
    /// command announced an id last owns it: its polls must land on its own
    /// card, never on the card of the command that held the id before.
    #[test]
    fn a_reused_session_id_binds_to_whoever_announced_it_last() {
        let mut lines = background_session_head(serde_json::json!(
            "Chunk ID: 523e44\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\nstarting"
        ));
        lines.push(rollout_line(
            "2026-07-20T08:41:00Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "exec_command",
                "call_id": "call_e2",
                "arguments": "{\"cmd\":\"cargo watch\",\"yield_time_ms\":1000}",
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:41:01Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call_e2",
                "output": "Chunk ID: 7c11\nWall time: 1.0 seconds\nProcess running with session ID 22068\nOutput:\nwatching",
            }),
        ));
        lines.extend(poll_lines(
            "call_p",
            "{\"session_id\":22068,\"chars\":\"\"}",
            serde_json::json!(
                "Chunk ID: 9a2\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nrebuilt"
            ),
        ));

        let detail = parse_lines(&lines, "session-reused");
        let results = tool_results(&detail);
        let first = results
            .iter()
            .find(|(id, _, _)| id == "call_e")
            .expect("first result");
        let second = results
            .iter()
            .find(|(id, _, _)| id == "call_e2")
            .expect("second result");
        assert_eq!(first.1.as_deref(), Some("starting"));
        assert_eq!(second.1.as_deref(), Some("watching\nrebuilt"));
    }

    #[test]
    fn an_unannounced_session_leaves_the_arguments_alone() {
        // The command ran to completion — it never announced a session — so
        // there is nothing to attribute this wait to. Inventing a command here
        // would be worse than the bare id the card falls back to.
        let lines = session_tool_rollout(
            serde_json::json!("Chunk ID: 523e44\nWall time: 1.0 seconds\nOutput:\ndone"),
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "call_s",
                "arguments": "{\"cell_id\":\"999\",\"yield_time_ms\":30000}",
            }),
        );

        let input = session_tool_input(&lines, "session-unknown").expect("input");
        assert!(
            !input.contains("session_command"),
            "unexpected attribution: {input}"
        );
    }

    /// A code-mode script that answers `Script running with cell ID N` has not
    /// finished — the `wait` that later collects cell N carries that script's
    /// own return value. It belongs on the script's card, not on a card of its
    /// own: before this, the delegation-status card showed only "Script running
    /// with cell ID 35" while its actual `{"tasks":[…]}` sat in a separate
    /// terminal card further down the transcript.
    fn deferred_script_rollout(wait_output: serde_json::Value) -> Vec<String> {
        let mut lines = code_mode_rollout(
            "const r = await tools.mcp__codeg_mcp__get_delegation_status({task_ids:[\"t1\"],wait_ms:60000});\ntext(JSON.stringify(r));\n",
            serde_json::json!("Script running with cell ID 34\nWall time 11.0 seconds\nOutput:\n"),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "call_w",
                "arguments": "{\"cell_id\":\"34\",\"yield_time_ms\":60000}",
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:40:48Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call_w",
                "output": wait_output,
            }),
        ));
        lines
    }

    #[test]
    fn a_deferred_script_completed_mcp_item_replaces_its_wrapper_card() {
        let script = concat!(
            "const task=\"t1\";",
            "const r=await tools.mcp__codeg_mcp__get_delegation_status({task_ids:[task],wait_ms:60000});",
            "text(JSON.stringify(r));"
        );
        let mut lines = code_mode_rollout(
            script,
            serde_json::json!("Script running with cell ID 34\nWall time 11.0 seconds\nOutput:\n"),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "event_msg",
            serde_json::json!({
                "type": "item_completed",
                "item": {
                    "type": "McpToolCall",
                    "id": "mcp-deferred-status",
                    "server": "codeg-mcp",
                    "tool": "get_delegation_status",
                    "arguments": {"task_ids":["t1"], "wait_ms":60000},
                    "result": {
                        "content": [{"type":"text", "text":"status: running"}],
                        "isError": false,
                    },
                },
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:40:04Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "wait-deferred",
                "arguments": "{\"cell_id\":\"34\",\"yield_time_ms\":60000}",
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:41:04Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "wait-deferred",
                "output": "Script completed\nWall time 60.0 seconds\nOutput:\n{}",
            }),
        ));

        let detail = parse_lines(&lines, "deferred-semantic-mcp");
        assert_eq!(
            tool_uses(&detail),
            vec![ (
                "mcp-deferred-status".into(),
                "mcp__codeg_mcp__get_delegation_status".into(),
                Some(r#"{"task_ids":["t1"],"wait_ms":60000}"#.into()),
            ) ],
            "the completed semantic item replaces the parked script card"
        );
        assert_eq!(
            tool_results(&detail),
            vec![(
                "mcp-deferred-status".into(),
                Some("status: running".into()),
                false,
            )]
        );
    }

    #[test]
    fn a_deferred_scripts_result_lands_on_its_own_card() {
        let lines = deferred_script_rollout(serde_json::json!([
            {"type": "input_text", "text": "Script completed\nWall time 44.5 seconds\nOutput:\n"},
            {"type": "input_text", "text": "{\"tasks\":[{\"task_id\":\"t1\",\"child_conversation_id\":2890}]}"},
        ]));
        let path = write_temp_rollout("deferred-script", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "deferred-script")
            .expect("parse ok");

        // One card for the call, carrying the result the `wait` collected.
        assert_eq!(
            tool_uses(&detail)
                .into_iter()
                .map(|(id, name, _)| (id, name))
                .collect::<Vec<_>>(),
            vec![(
                "call_1".to_string(),
                "mcp__codeg_mcp__get_delegation_status".to_string()
            )]
        );
        assert_eq!(
            tool_results(&detail),
            vec![(
                "call_1".to_string(),
                Some(
                    "{\"tasks\":[{\"task_id\":\"t1\",\"child_conversation_id\":2890}]}".to_string()
                ),
                false
            )]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn a_script_still_running_after_a_wait_stays_collectable() {
        // The wait came back with the script STILL parked: the card keeps the
        // running note, and the next wait must still find it.
        let lines = deferred_script_rollout(serde_json::json!(
            "Script running with cell ID 34\nWall time 60.0 seconds\nOutput:\n"
        ));
        let path = write_temp_rollout("deferred-still-running", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "deferred-still-running")
            .expect("parse ok");

        assert_eq!(tool_uses(&detail).len(), 1);
        assert_eq!(
            tool_results(&detail),
            vec![(
                "call_1".to_string(),
                Some("Script running with cell ID 34".to_string()),
                false
            )]
        );

        let _ = fs::remove_file(path);
    }

    /// A `wait` answers with what the script printed SINCE it parked, not with
    /// the whole run. Rewriting the cards from that answer alone would drop
    /// whatever the script had already printed — and decompose against a chunk
    /// count missing its front, so a two-call script could end up undecomposable
    /// and leave its `call_1#i` cards without results.
    #[test]
    fn a_deferred_script_keeps_what_it_printed_before_the_wait() {
        let mut lines = code_mode_rollout(
            "const a = await tools.exec_command({cmd: \"pnpm build\"});\ntext(a.output);\nconst b = await tools.exec_command({cmd: \"pnpm test\"});\ntext(b.output);\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script running with cell ID 34\nWall time 11.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "build finished"},
            ]),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "call_w",
                "arguments": "{\"cell_id\":\"34\",\"yield_time_ms\":60000}",
            }),
        ));
        lines.push(rollout_line(
            "2026-07-20T08:40:48Z",
            "response_item",
            serde_json::json!({
                "type": "function_call_output",
                "call_id": "call_w",
                "output": [
                    {"type": "input_text", "text": "Script completed\nWall time 45.0 seconds\nOutput:\n"},
                    {"type": "input_text", "text": "1 passed"},
                ],
            }),
        ));

        let detail = parse_lines(&lines, "deferred-accumulates");
        // Two chunks across the two answers, two calls: decomposed per call.
        assert_eq!(
            tool_uses(&detail)
                .iter()
                .map(|(id, name, _)| (id.as_str(), name.as_str()))
                .collect::<Vec<_>>(),
            vec![("call_1#0", "exec_command"), ("call_1#1", "exec_command")]
        );
        assert_eq!(
            tool_results(&detail)
                .iter()
                .map(|(id, out, _)| (id.as_str(), out.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("call_1#0", Some("build finished")),
                ("call_1#1", Some("1 passed")),
            ]
        );
    }

    #[test]
    fn a_script_cell_is_never_mistaken_for_a_shell_session() {
        // `Script running with cell ID N` names the SCRIPT, not a shell inside
        // it — so the wait that collects it folds into the script's card and
        // contributes no card of its own. Nothing may leak into the shell
        // session map either: that cell is not a shell, and the long-running
        // call here is not even a command.
        let mut lines = code_mode_rollout(
            "const r = await tools.mcp__codeg_mcp__ask_user_question({questions: []});\ntext(JSON.stringify(r));\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script running with cell ID 15\nWall time 11.0 seconds\nOutput:\n"},
            ]),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                "call_id": "call_s",
                "arguments": "{\"cell_id\":\"15\"}",
            }),
        ));

        let path = write_temp_rollout("session-script-cell", &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, "session-script-cell")
            .expect("parse ok");
        let uses = tool_uses(&detail);
        assert_eq!(
            uses.iter()
                .map(|(id, name, _)| (id.as_str(), name.as_str()))
                .collect::<Vec<_>>(),
            vec![("call_1", "mcp__codeg_mcp__ask_user_question")]
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn code_mode_session_announcements_are_attributed_per_chunk() {
        // Two commands in one script, one `text()` chunk each: the second
        // command's session id must resolve to the SECOND command.
        let mut lines = code_mode_rollout(
            "const a = await tools.exec_command({cmd: \"pnpm dev\"});\ntext(JSON.stringify(a));\nconst b = await tools.exec_command({cmd: \"cargo watch\"});\ntext(JSON.stringify(b));\n",
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 1.0 seconds\nOutput:\n"},
                {"type": "input_text", "text": "{\"chunk_id\":\"a1\",\"session_id\":11,\"output\":\"\"}"},
                {"type": "input_text", "text": "{\"chunk_id\":\"b2\",\"session_id\":22,\"output\":\"\"}"},
            ]),
        );
        lines.push(rollout_line(
            "2026-07-20T08:40:03Z",
            "response_item",
            serde_json::json!({
                "type": "function_call",
                "name": "wait",
                // `terminate` keeps it a card of its own — a bare poll would be
                // folded into the command's card and have no title to check.
                "call_id": "call_s",
                "arguments": "{\"cell_id\":\"22\",\"terminate\":true}",
            }),
        ));

        let input: serde_json::Value =
            serde_json::from_str(&session_tool_input(&lines, "session-chunked").expect("input"))
                .expect("json args");
        assert_eq!(input["session_command"], "cargo watch");
    }

    // ── separator split ──────────────────────────────────────────────────

    /// The script from the reported session: a literal table of labelled
    /// commands fanned out through one `tools.exec_command({cmd, …})`.
    fn labelled_fanout(labels: &[&str]) -> String {
        let rows: Vec<String> = labels
            .iter()
            .enumerate()
            .map(|(i, label)| format!("  [\"{label}\", \"echo {i}\"],\n"))
            .collect();
        format!(
            "const cmds = [\n{}];\nconst out = await Promise.all(cmds.map(async ([k,cmd]) => [k, await tools.exec_command({{cmd, workdir:\"/repo\", yield_time_ms:10000}})]));\nfor (const [k,r] of out) text(`===== ${{k}} =====\\n${{r.output}}`);\n",
            rows.concat()
        )
    }

    /// What codex renders when a labelled fan-out's `text()` stream is too
    /// long: one blob, the separators still in it, behind a banner declaring
    /// how many lines it started with.
    fn labelled_blob(declared: usize, sections: &[(&str, &str)]) -> String {
        let body: Vec<String> = sections
            .iter()
            .map(|(label, out)| format!("===== {label} =====\n{out}"))
            .collect();
        format!(
            "Warning: truncated output (original token count: 23243)\nTotal output lines: {declared}\n\n{}",
            body.join("\n")
        )
    }

    fn code_mode_detail(script: &str, blob: String, id: &str) -> crate::models::ConversationDetail {
        let lines = code_mode_rollout(
            script,
            serde_json::json!([
                {"type": "input_text", "text": "Script completed\nWall time 0.3 seconds\nOutput:\n"},
                {"type": "input_text", "text": blob},
            ]),
        );
        let path = write_temp_rollout(id, &lines);
        let detail = CodexParser::new()
            .parse_conversation_detail(&path, id)
            .expect("parse ok");
        let _ = fs::remove_file(path);
        detail
    }

    fn tool_metas(detail: &crate::models::ConversationDetail) -> Vec<serde_json::Value> {
        detail
            .turns
            .iter()
            .flat_map(|t| t.blocks.iter())
            .filter_map(|b| match b {
                ContentBlock::ToolUse { meta, .. } => Some(
                    meta.clone()
                        .and_then(|m| m.get("codeg.codexScript").cloned())
                        .unwrap_or(serde_json::Value::Null),
                ),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn a_labelled_fanout_splits_a_collapsed_blob_per_command() {
        let detail = code_mode_detail(
            &labelled_fanout(&["query-entry", "formula-service", "factor-full"]),
            labelled_blob(6, &[
                ("query-entry", "one"),
                ("formula-service", "two"),
                ("factor-full", "three"),
            ]),
            "code-mode-labelled",
        );

        assert_eq!(
            tool_uses(&detail),
            vec![
                ("call_1#0".into(), "exec_command".into(), Some("echo 0".into())),
                ("call_1#1".into(), "exec_command".into(), Some("echo 1".into())),
                ("call_1#2".into(), "exec_command".into(), Some("echo 2".into())),
            ]
        );
        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".into(), Some("one".into()), false),
                ("call_1#1".into(), Some("two".into()), false),
                ("call_1#2".into(), Some("three".into()), false),
            ]
        );
        let metas = tool_metas(&detail);
        assert_eq!(metas[0]["label"], "query-entry");
        assert_eq!(metas[2]["label"], "factor-full");
        assert!(metas.iter().all(|m| m.get("outputMissing").is_none()));
    }

    /// The reported card: truncation ate two separators, so the span after
    /// `formula-service` holds three commands' output with no boundary. The
    /// commands it provably brackets still get their own output; the ones whose
    /// separator is gone say so instead of being handed someone else's.
    #[test]
    fn a_truncated_separator_leaves_its_command_without_output() {
        let detail = code_mode_detail(
            &labelled_fanout(&["query-entry", "formula-service", "vo", "formula-splice", "factor-full"]),
            labelled_blob(20, &[
                ("query-entry", "first"),
                ("formula-service", "second\nvo-output\nsplice-output"),
                ("factor-full", "last"),
            ]),
            "code-mode-labelled-partial",
        );

        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".into(), Some("first".into()), false),
                ("call_1#1".into(), Some("second\nvo-output\nsplice-output".into()), false),
                ("call_1#2".into(), None, false),
                ("call_1#3".into(), None, false),
                ("call_1#4".into(), Some("last".into()), false),
            ]
        );

        let metas = tool_metas(&detail);
        assert_eq!(metas[1]["sharedWith"], serde_json::json!(["vo", "formula-splice"]));
        assert_eq!(metas[2]["outputMissing"], true);
        assert_eq!(metas[3]["outputMissing"], true);
        assert!(metas[0].get("sharedWith").is_none());
        assert!(metas[4].get("sharedWith").is_none());
        assert!(metas.iter().all(|m| m["truncated"] == true));
    }

    /// A command that printed the separator itself makes the line ambiguous;
    /// the whole candidate is refused rather than cutting on the wrong one.
    #[test]
    fn a_repeated_separator_line_keeps_the_script_card() {
        let detail = code_mode_detail(
            &labelled_fanout(&["alpha", "beta"]),
            labelled_blob(8, &[
                ("alpha", "one\n===== beta ====="),
                ("beta", "two"),
            ]),
            "code-mode-labelled-dup",
        );

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
    }

    /// Only a line some separator actually predicts can make a candidate
    /// ambiguous. Two commands printing the same ordinary line is the normal
    /// case — `index_body_lines` marks it repeated, but nothing looks it up.
    #[test]
    fn a_repeated_output_line_still_splits() {
        let detail = code_mode_detail(
            &labelled_fanout(&["alpha", "beta", "gamma"]),
            labelled_blob(8, &[
                ("alpha", "shared line\none"),
                ("beta", "shared line\ntwo"),
                ("gamma", "three"),
            ]),
            "code-mode-labelled-repeat",
        );

        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".into(), Some("shared line\none".into()), false),
                ("call_1#1".into(), Some("shared line\ntwo".into()), false),
                ("call_1#2".into(), Some("three".into()), false),
            ]
        );
        // Every line the banner declared is present, so nothing went missing.
        let metas = tool_metas(&detail);
        assert!(metas.iter().all(|m| m.get("truncated").is_none()));
        assert!(metas.iter().all(|m| m.get("outputMissing").is_none()));
    }

    /// One separator divides nothing: it would hand the whole blob to the first
    /// command and leave the rest blank.
    #[test]
    fn a_single_surviving_separator_keeps_the_script_card() {
        let detail = code_mode_detail(
            &labelled_fanout(&["alpha", "beta", "gamma"]),
            labelled_blob(9, &[("beta", "two")]),
            "code-mode-labelled-one",
        );

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
    }

    /// Separators in the wrong order are not this script's separator run.
    #[test]
    fn separators_out_of_order_keep_the_script_card() {
        let detail = code_mode_detail(
            &labelled_fanout(&["alpha", "beta", "gamma"]),
            labelled_blob(9, &[("gamma", "three"), ("beta", "two"), ("alpha", "one")]),
            "code-mode-labelled-unordered",
        );

        let uses = tool_uses(&detail);
        assert_eq!(uses.len(), 1);
        assert_eq!(uses[0].1, CODEX_SCRIPT_TOOL_NAME);
    }

    /// Scripts that number their results instead of naming them split the same
    /// way — the hole is the loop index.
    #[test]
    fn numbered_separators_split_a_collapsed_blob() {
        let script = concat!(
            "const cmds = [[\"echo one\", 20000], [\"echo two\", 20000]];\n",
            "const rs = await Promise.all(cmds.map(([cmd,max]) => tools.exec_command({cmd, max_output_tokens:max})));\n",
            "rs.forEach((r,i)=>text(`---RESULT ${i+1}---\\n${r.output}`));\n",
        );
        let blob = "Warning: truncated output (original token count: 900)\nTotal output lines: 7\n\n---RESULT 1---\none\n---RESULT 2---\ntwo".to_string();
        let detail = code_mode_detail(script, blob, "code-mode-numbered");

        assert_eq!(
            tool_results(&detail),
            vec![
                ("call_1#0".into(), Some("one".into()), false),
                ("call_1#1".into(), Some("two".into()), false),
            ]
        );
        // No table label to show, so the chip has nothing to say.
        assert!(tool_metas(&detail).iter().all(|m| m.get("label").is_none()));
    }

    // ───────────────────────────────────────────────────────────────────────
    // `response_item.message` promotion — issue #452
    //
    // A rollout written by a producer that never emits the `event_msg` channel
    // (an embedder driving codex under its own `CODEX_HOME`) used to render as
    // a bare "Used N tools": the tool calls parse from `response_item`, every
    // user and assistant bubble did not. These tests pin BOTH directions — the
    // recovery, and the silence on every rollout that already has the canonical
    // channel.
    // ───────────────────────────────────────────────────────────────────────

    /// `(role, first text block)` per turn, the shape most of these assertions
    /// want. Tool-only turns come back with `None`. The role is stringified
    /// because `TurnRole` is not `PartialEq` and a production model should not
    /// grow a derive to serve a test.
    fn turn_texts(detail: &crate::models::ConversationDetail) -> Vec<(&'static str, Option<String>)> {
        detail
            .turns
            .iter()
            .map(|turn| {
                let role = match turn.role {
                    TurnRole::User => "user",
                    TurnRole::Assistant => "assistant",
                    TurnRole::System => "system",
                };
                (
                    role,
                    turn.blocks.iter().find_map(|block| match block {
                        ContentBlock::Text { text } => Some(text.clone()),
                        _ => None,
                    }),
                )
            })
            .collect()
    }

    fn summary_of(label: &str, content: &str) -> crate::models::ConversationSummary {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time ok")
            .as_nanos();
        let path: PathBuf = env::temp_dir().join(format!("codeg-codex-{label}-{nanos}.jsonl"));
        fs::write(&path, content).expect("write test jsonl");
        let summary = CodexParser::new()
            .parse_jsonl_summary(&path)
            .expect("parse summary ok")
            .expect("summary present");
        let _ = fs::remove_file(path);
        summary
    }

    /// The reported rollout shape: `session_meta` + `turn_context` + nothing but
    /// `response_item`s. Every text bubble here is the ONLY copy in the file.
    const ORCA_ONLY: &str = concat!(
        "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"orca-1\",\"cwd\":\"/tmp/demo\"}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.1-codex\"}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"developer\",\"content\":[{\"type\":\"input_text\",\"text\":\"<permissions instructions>be careful</permissions instructions>\"}]}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"<environment_context>\\n  <cwd>/tmp/demo</cwd>\\n</environment_context>\"}]}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"summarize the build script\"}]}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"call_id\":\"c1\",\"arguments\":\"{\\\"command\\\":[\\\"cat\\\",\\\"build.sh\\\"]}\"}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"c1\",\"output\":\"#!/bin/sh\\nmake\"}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:07Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[{\"type\":\"output_text\",\"text\":\"Reading it now.\"}]}}\n",
        "{\"timestamp\":\"2026-03-01T10:00:08Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"final_answer\",\"content\":[{\"type\":\"output_text\",\"text\":\"It just runs make.\"}]}}\n"
    );

    #[test]
    fn event_msg_less_rollout_recovers_user_and_assistant_text() {
        let detail = parse_rollout("orca-only", ORCA_ONLY, "orca-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("summarize the build script".into())),
                // The tool call and its output fold into one assistant turn,
                // which is what used to be the WHOLE transcript.
                ("assistant", None),
                ("assistant", Some("Reading it now.".into())),
                ("assistant", Some("It just runs make.".into())),
            ],
            "both `phase` values render as assistant text, and the tool turn \
             keeps its position between the prompt and the reply"
        );
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("summarize the build script"),
            "the promoted prompt supplies the title the event channel would have"
        );
    }

    #[test]
    fn event_msg_less_rollout_summary_matches_the_detail() {
        // Summary/detail parity is what keeps the sidebar entry, the import
        // picker row and the opened conversation telling the same story.
        let summary = summary_of("orca-only-sum", ORCA_ONLY);

        assert_eq!(summary.title.as_deref(), Some("summarize the build script"));
        assert_eq!(
            summary.message_count, 3,
            "one prompt + two assistant messages; the envelopes and the \
             developer record are not turns"
        );
    }

    #[test]
    fn canonical_channel_suppresses_the_response_item_twin() {
        // THE anti-duplication test. A normal codex rollout records every
        // message twice — `event_msg` first for the assistant, `response_item`
        // first for the user — and only one copy may render.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"twin-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.1-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"ping\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"ping\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"pong\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"pong\"}]}}\n"
        );
        let detail = parse_rollout("twin", content, "twin-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("ping".into())),
                ("assistant", Some("pong".into())),
            ]
        );
        assert_eq!(summary_of("twin-sum", content).message_count, 2);
    }

    #[test]
    fn a_resumed_mixed_rollout_keeps_both_halves_exactly_once() {
        // The reported workflow: the session is created elsewhere, then resumed
        // in codeg — which appends NATIVE `event_msg` turns to the SAME file.
        // A whole-file gate would drop the imported prefix the moment that
        // happened; the per-segment gate keeps it.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"mixed-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"imported prompt\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"imported reply\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:10Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:11Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"native prompt\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:12Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"native prompt\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:13Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"native reply\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:14Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"native reply\"}]}}\n"
        );
        let detail = parse_rollout("mixed", content, "mixed-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("imported prompt".into())),
                ("assistant", Some("imported reply".into())),
                ("user", Some("native prompt".into())),
                ("assistant", Some("native reply".into())),
            ],
            "the imported prefix survives and the native suffix is not doubled"
        );
        assert_eq!(detail.summary.title.as_deref(), Some("imported prompt"));
        assert_eq!(summary_of("mixed-sum", content).message_count, 4);
    }

    #[test]
    fn compaction_summary_is_denied_by_adjacency_not_by_segment() {
        // codex writes the pre-compaction handoff as an assistant message
        // immediately before the `compacted` record (a `token_count` may sit
        // between). Only THAT message is machine text — a segment-wide rule
        // would reject every assistant message in a marker-less imported prefix
        // and re-break #452 for any compacted session.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"comp-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"before compaction\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"real reply before\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Handoff summary:\\n\\nCurrent state: …\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"compacted\",\"payload\":{}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"real reply after\"}]}}\n"
        );
        let detail = parse_rollout("compaction", content, "comp-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("before compaction".into())),
                ("assistant", Some("real reply before".into())),
                ("assistant", Some("real reply after".into())),
            ],
            "only the handoff summary is suppressed"
        );
    }

    #[test]
    fn machine_authored_records_never_become_turns() {
        // Every class below is real: counted across the local rollout corpus,
        // or (for `developer`) present in every single session.
        let mut lines = String::from(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"deny-1\",\"cwd\":\"/tmp/demo\"}}\n",
        );
        lines.push_str(
            &serde_json::json!({
                "timestamp": "2026-03-01T10:00:01Z",
                "type": "response_item",
                "payload": {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {
                            "type": "input_text",
                            "text": "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhi\n</INSTRUCTIONS>"
                        },
                        {
                            "type": "input_text",
                            "text": "<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>"
                        }
                    ]
                }
            })
            .to_string(),
        );
        lines.push('\n');
        for (index, text) in [
            "# AGENTS.md instructions for /tmp/demo\n\n<INSTRUCTIONS>\nhi\n</INSTRUCTIONS>",
            "<environment_context>\n  <cwd>/tmp/demo</cwd>\n</environment_context>",
            "<codex_internal_context source=\"goal\">Continue working</codex_internal_context>",
            "<turn_aborted>\nThe user interrupted the previous turn on purpose.\n</turn_aborted>",
            "<subagent_notification>agent 3 finished</subagent_notification>",
            "<skill name=\"pptx\">use this</skill>",
            "<recommended_plugins>\nHere is a list of plugins that are available but not installed.\n\n- Figma (figma)\n</recommended_plugins>",
            "Warning: apply_patch was requested via exec_command. Use the apply_patch tool instead.",
        ]
        .iter()
        .enumerate()
        {
            lines.push_str(&format!(
                "{{\"timestamp\":\"2026-03-01T10:01:{:02}Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"user\",\"content\":[{{\"type\":\"input_text\",\"text\":{}}}]}}}}\n",
                index,
                serde_json::to_string(text).expect("encode")
            ));
        }
        // NB: `<proposed_plan>` is NOT in this list. It is the agent's answer,
        // not machinery, and renders through its own arm — see
        // `plan_document_renders_from_either_of_its_two_copies`.
        //
        // …and a real message, so the test can tell "filtered everything" from
        // "parsed nothing".
        lines.push_str("{\"timestamp\":\"2026-03-01T10:03:00Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"a real answer\"}]}}\n");

        let detail = parse_rollout("deny", &lines, "deny-1");
        assert_eq!(
            turn_texts(&detail),
            vec![("assistant", Some("a real answer".into()))]
        );
        assert_eq!(summary_of("deny-sum", &lines).message_count, 1);
        assert_eq!(detail.summary.title, None, "no envelope may become a title");
    }

    /// One Plan-mode turn, in the two shapes the corpus actually contains:
    /// older codex writes only the `<proposed_plan>` assistant record, newer
    /// codex announces `item_completed { item.type = "Plan" }` first and then
    /// writes the same plan again as that record.
    fn plan_turn(announce: bool, assistant_record: Option<&str>) -> String {
        let mut lines = String::from(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"plan-1\",\"cwd\":\"/tmp/demo\"}}\n",
        );
        lines.push_str("{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5-codex\",\"collaboration_mode\":{\"mode\":\"plan\"}}}\n");
        lines.push_str("{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"列个计划\"}}\n");
        if announce {
            lines.push_str("{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\",\"item\":{\"type\":\"Plan\",\"id\":\"turn-plan\",\"text\":\"# Plan\\n\\n- step one\"}}}\n");
        }
        if let Some(text) = assistant_record {
            lines.push_str(&format!(
                "{{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":{}}}]}}}}\n",
                serde_json::to_string(text).expect("encode")
            ));
        }
        lines
    }

    #[test]
    fn plan_document_renders_from_either_of_its_two_copies() {
        // The regression: a Plan turn publishes its answer as `item_completed`
        // INSTEAD of `agent_message`, so a parser that reads only the event
        // channel and denies the `<proposed_plan>` record renders the turn as
        // nothing but its reasoning — the plan card vanishes on reload.
        let tagged = "<proposed_plan>\n# Plan\n\n- step one\n</proposed_plan>";

        for (label, announce, record) in [
            ("announce-only", true, None),
            ("record-only", false, Some(tagged)),
            ("both", true, Some(tagged)),
        ] {
            let content = plan_turn(announce, record);
            let detail = parse_rollout(label, &content, "plan-1");
            assert_eq!(
                turn_texts(&detail),
                vec![
                    ("user", Some("列个计划".into())),
                    ("assistant", Some(tagged.into())),
                ],
                "{label}: the plan renders exactly once, in codex's own tags"
            );
            assert_eq!(
                summary_of(&format!("{label}-sum"), &content).message_count,
                2,
                "{label}: and counts exactly once for the sidebar"
            );
        }
    }

    #[test]
    fn plan_record_keeps_the_prose_codex_writes_around_the_block() {
        // The `item_completed` announcement carries the plan body ALONE, while
        // the assistant record carries the same body plus any follow-up prose
        // ("如果你希望调整…" is codex's habit). Rendering the announcement and
        // dropping the record would silently lose that prose, so the record
        // takes the announcement's message over rather than adding a second.
        let record = "<proposed_plan>\n# Plan\n\n- step one\n</proposed_plan>\n\n如果你希望调整，告诉我。";
        let content = plan_turn(true, Some(record));
        let detail = parse_rollout("plan-prose", &content, "plan-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("列个计划".into())),
                ("assistant", Some(record.into())),
            ],
            "one plan turn, carrying the trailing prose"
        );
    }

    /// A full approve-the-plan sequence: the plan turn, codex's flip out of
    /// Plan mode, and the follow-up prompt it writes to itself. `repeat_context`
    /// re-emits the post-flip `turn_context`, which newer codex does mid-turn.
    fn approved_plan_rollout_with(
        prompt: &str,
        flip_out_of_plan: bool,
        repeat_context: bool,
    ) -> String {
        let mut lines = plan_turn(
            true,
            Some("<proposed_plan>\n# Plan\n\n- step one\n</proposed_plan>"),
        );
        let mode = if flip_out_of_plan { "default" } else { "plan" };
        lines.push_str(&format!(
            "{{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"turn_context\",\"payload\":{{\"model\":\"gpt-5-codex\",\"collaboration_mode\":{{\"mode\":\"{mode}\"}}}}}}\n"
        ));
        if repeat_context {
            lines.push_str(&format!(
                "{{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"turn_context\",\"payload\":{{\"model\":\"gpt-5-codex\",\"collaboration_mode\":{{\"mode\":\"{mode}\"}}}}}}\n"
            ));
        }
        lines.push_str(&format!(
            "{{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"user_message\",\"message\":{}}}}}\n",
            serde_json::to_string(prompt).expect("encode")
        ));
        lines.push_str("{\"timestamp\":\"2026-03-01T10:00:07Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"开始实施。\"}}\n");
        lines
    }

    fn approved_plan_rollout(prompt: &str, flip_out_of_plan: bool) -> String {
        approved_plan_rollout_with(prompt, flip_out_of_plan, false)
    }

    #[test]
    fn approving_a_plan_settles_the_card_instead_of_faking_a_user_turn() {
        // codex writes its own post-approval prompt as an ordinary
        // `user_message`, structurally identical to typed input. Rendering it
        // splits ONE plan interaction into two, which is not what the live
        // stream shows — there the approval and the implementation share a
        // single `session/prompt`.
        let content = approved_plan_rollout(CODEX_PLAN_APPROVAL_PROMPT, true);
        let detail = parse_rollout("plan-approved", &content, "plan-1");

        assert_eq!(
            turn_texts(&detail)
                .iter()
                .filter(|(role, _)| *role == "user")
                .count(),
            1,
            "the only user turn is the one the user actually typed"
        );

        let decision: Vec<(&str, Option<&str>)> = detail
            .turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .filter_map(|block| match block {
                ContentBlock::ToolUse { tool_name, .. } => Some((tool_name.as_str(), None)),
                ContentBlock::ToolResult { output_preview, .. } => {
                    Some(("<result>", output_preview.as_deref()))
                }
                _ => None,
            })
            .collect();
        assert_eq!(
            decision,
            vec![
                ("plan_review", None),
                ("<result>", Some(CODEX_PLAN_APPROVED_OUTPUT)),
            ],
            "the decision moves onto a settled plan_review call — the same \
             shape the live permission gate produces"
        );
        assert_eq!(
            summary_of("plan-approved-sum", &content).message_count,
            3,
            "prompt + plan + reply; the synthetic approval is not a message"
        );
    }

    #[test]
    fn a_typed_approval_sentence_is_still_the_users_own_turn() {
        // The wording alone must never be enough: without the mode flip out of
        // `plan`, this is someone typing codex's sentence and it keeps its
        // bubble. (Both halves of the gate are load-bearing — the flip has no
        // per-record marker, the wording has no context.)
        let content = approved_plan_rollout(CODEX_PLAN_APPROVAL_PROMPT, false);
        let detail = parse_rollout("plan-typed", &content, "plan-1");

        assert!(
            turn_texts(&detail)
                .iter()
                .any(|(role, text)| *role == "user"
                    && text.as_deref() == Some(CODEX_PLAN_APPROVAL_PROMPT)),
            "no mode flip, so nothing marks this as codex's own prompt"
        );

        // …and the flip alone is not enough either: a different sentence in the
        // post-approval turn is a real prompt.
        let other = approved_plan_rollout("先别做，改一下第二步", true);
        let detail = parse_rollout("plan-other", &other, "plan-1");
        assert!(
            turn_texts(&detail)
                .iter()
                .any(|(role, text)| *role == "user"
                    && text.as_deref() == Some("先别做，改一下第二步")),
            "the flip only arms the filter; the wording still has to match"
        );

        // Whitespace variants are somebody typing, not codex: the sentinel is
        // written with no surrounding whitespace in every corpus occurrence, so
        // the comparison is verbatim and a padded copy keeps its bubble.
        for padded in [
            "Implement the approved plan. ",
            " Implement the approved plan.",
            "Implement the approved plan.\n",
        ] {
            let content = approved_plan_rollout(padded, true);
            let detail = parse_rollout("plan-padded", &content, "plan-1");
            assert!(
                turn_texts(&detail)
                    .iter()
                    .any(|(role, text)| *role == "user" && text.is_some()),
                "{padded:?} is user-typed text, not codex's own prompt"
            );
        }
    }

    #[test]
    fn a_repeated_post_flip_turn_context_does_not_disarm_the_filter() {
        // Newer codex re-emits `turn_context` mid-turn. If the arm were rewritten
        // on every context instead of only on a transition, a second `default`
        // context landing between the flip and codex's own prompt would disarm
        // the filter and put the approval back in the timeline as a user bubble.
        let content = approved_plan_rollout_with(CODEX_PLAN_APPROVAL_PROMPT, true, true);
        let detail = parse_rollout("plan-repeat-ctx", &content, "plan-1");

        assert_eq!(
            turn_texts(&detail)
                .iter()
                .filter(|(role, _)| *role == "user")
                .count(),
            1,
            "the repeated context must not resurrect the synthetic prompt"
        );
        assert_eq!(
            summary_of("plan-repeat-ctx-sum", &content).message_count,
            3,
            "and the summary must agree"
        );
    }

    #[test]
    fn two_plan_turns_proposing_the_same_body_stay_two_plans() {
        // The pairing slot belongs to ONE announcement→record pair. Treating it
        // as "the last plan seen" would make a legacy rollout (no
        // `item_completed` records) that re-proposes an unchanged plan collapse
        // into a single plan, and the second turn would render empty — the very
        // bug this whole change exists to fix.
        let plan = "<proposed_plan>\n# Plan\n\n- step one\n</proposed_plan>";
        let record = |ts: &str| {
            format!(
                "{{\"timestamp\":\"{ts}\",\"type\":\"response_item\",\"payload\":{{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"output_text\",\"text\":{}}}]}}}}\n",
                serde_json::to_string(plan).expect("encode")
            )
        };
        let mut content = String::from(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"twice-1\",\"cwd\":\"/tmp/demo\"}}\n",
        );
        content.push_str("{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"列个计划\"}}\n");
        content.push_str(&record("2026-03-01T10:00:02Z"));
        content.push_str("{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"再来一遍\"}}\n");
        content.push_str(&record("2026-03-01T10:00:04Z"));

        let detail = parse_rollout("plan-twice", &content, "twice-1");
        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("列个计划".into())),
                ("assistant", Some(plan.into())),
                ("user", Some("再来一遍".into())),
                ("assistant", Some(plan.into())),
            ],
            "both plan turns render"
        );
        assert_eq!(
            summary_of("plan-twice-sum", &content).message_count,
            4,
            "and both are counted"
        );
    }

    #[test]
    fn a_promoted_user_after_a_goal_leaves_the_opener_intact() {
        // The `/goal` opener is decided POSITIONALLY. A promoted user that
        // arrives after the goal is the reply to it, not the prompt that opened
        // the session, so the synthetic opener must survive.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gp-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Ship the page\",\"status\":\"active\"}}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.1-codex\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"确认\"}]}}\n"
        );
        let detail = parse_rollout("goal-after", content, "gp-1");

        let users: Vec<Option<String>> = turn_texts(&detail)
            .into_iter()
            .filter(|(role, _)| *role == "user")
            .map(|(_, text)| text)
            .collect();
        assert_eq!(
            users,
            vec![Some("/goal Ship the page".into()), Some("确认".into())]
        );
        assert_eq!(
            detail.summary.title.as_deref(),
            Some("Ship the page"),
            "the goal opened the session, so it keeps the title"
        );
        assert_eq!(summary_of("goal-after-sum", content).message_count, 2);
    }

    #[test]
    fn a_goal_covers_the_user_channel_for_its_own_turn() {
        // A typed `/goal <objective>` IS user input; newer codex records it as
        // `thread_goal_updated` INSTEAD of a `user_message` and both parsers
        // synthesize the opening turn from it. So the `response_item` twin of
        // that same prompt must not ALSO be promoted — in either order — or the
        // opener renders twice. (The goal-then-user order is pinned separately
        // by `goal_with_text_only_response_item_titles_from_objective_in_both_paths`.)
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gb-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"/goal Ship the page\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Ship the page\",\"status\":\"active\"}}}\n"
        );
        let detail = parse_rollout("goal-before", content, "gb-1");

        let users: Vec<Option<String>> = turn_texts(&detail)
            .into_iter()
            .filter(|(role, _)| *role == "user")
            .map(|(_, text)| text)
            .collect();
        assert_eq!(users, vec![Some("/goal Ship the page".into())]);
        assert_eq!(detail.summary.title.as_deref(), Some("Ship the page"));
        assert_eq!(summary_of("goal-before-sum", content).message_count, 1);
    }

    #[test]
    fn a_promoted_user_in_an_earlier_turn_cancels_the_opener_and_wins_the_title() {
        // The mixed-file shape: an imported prefix with no event channel, then a
        // native turn that opens a `/goal`. The goal did NOT open the session —
        // a real prompt precedes it — so no synthetic opener is added and the
        // earlier prompt outranks the objective for the title. This is what the
        // ordinal comparison exists for: "is there a user anywhere" would answer
        // the same for the reply-to-a-goal shape, which must keep its opener.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"gb2-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"build me a page\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"on it\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:10Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:11Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\",\"goal\":{\"objective\":\"Ship the page\",\"status\":\"active\"}}}\n"
        );
        let detail = parse_rollout("goal-later-turn", content, "gb2-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("user", Some("build me a page".into())),
                ("assistant", Some("on it".into())),
                // The goal card itself — no synthetic `/goal …` user turn.
                ("assistant", None),
            ]
        );
        assert_eq!(detail.summary.title.as_deref(), Some("build me a page"));

        let summary = summary_of("goal-later-turn-sum", content);
        assert_eq!(summary.title.as_deref(), Some("build me a page"));
        assert_eq!(summary.message_count, 2, "no synthetic opener is counted");
    }

    #[test]
    fn a_native_thread_name_outranks_a_promoted_prompt() {
        // codex's own thread name is the strongest title source and its arm
        // assigns unconditionally, so it needs a flag rather than an ordinal.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"tn-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"the raw prompt\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_name_updated\",\"thread_name\":\"Curated name\"}}\n"
        );
        let detail = parse_rollout("thread-name", content, "tn-1");

        assert_eq!(detail.summary.title.as_deref(), Some("Curated name"));
        assert_eq!(
            summary_of("thread-name-sum", content).title.as_deref(),
            Some("Curated name")
        );
    }

    #[test]
    fn consecutive_promotions_land_in_place_and_keep_their_order() {
        // Several candidates share one insertion point when nothing was pushed
        // between them. The splice walks insertion points in DESCENDING order,
        // so a same-index group has to go back as a GROUP — one at a time would
        // reverse it.
        //
        // The tool calls on either side are what give this teeth: they make the
        // insertion point interior, so appending the promotions at the end and
        // splicing them one by one BOTH produce a different transcript.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ord-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"call_id\":\"before\",\"arguments\":\"{\\\"command\\\":[\\\"echo\\\",\\\"before\\\"]}\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:02Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"before\",\"output\":\"before\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:03Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"first\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:04Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"second\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:05Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"third\"}]}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:06Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call\",\"name\":\"shell\",\"call_id\":\"after\",\"arguments\":\"{\\\"command\\\":[\\\"echo\\\",\\\"after\\\"]}\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:07Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"function_call_output\",\"call_id\":\"after\",\"output\":\"after\"}}\n"
        );
        let detail = parse_rollout("order", content, "ord-1");

        assert_eq!(
            turn_texts(&detail),
            vec![
                ("assistant", None),
                ("assistant", Some("first".into())),
                ("assistant", Some("second".into())),
                ("assistant", Some("third".into())),
                ("assistant", None),
            ],
            "the group lands between the two tool turns, in source order"
        );
    }

    #[test]
    fn an_image_bearing_user_still_takes_the_dedicated_path() {
        // Image users are pushed in-loop, unconditionally, because the canonical
        // channel never carries the image. The promotion path must not emit a
        // second, text-only copy of the same record.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"img-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"what is this\"},{\"type\":\"input_image\",\"image_url\":\"data:image/png;base64,QUJD\"}]}}\n"
        );
        let detail = parse_rollout("image", content, "img-1");

        assert_eq!(detail.turns.len(), 1);
        assert!(matches!(detail.turns[0].role, TurnRole::User));
        assert!(
            detail.turns[0]
                .blocks
                .iter()
                .any(|block| matches!(block, ContentBlock::Image { .. })),
            "the image survives"
        );
        assert_eq!(
            turn_texts(&detail)[0].1.as_deref(),
            Some("what is this"),
            "and its text is not duplicated into a second turn"
        );
    }

    #[test]
    fn promoted_assistant_text_keeps_its_whitespace() {
        // The `event_msg.agent_message` arm stores its text verbatim, while the
        // user arms run `strip_blocked_resource_mentions` (which collapses runs
        // of spaces — right for a typed prompt, ruinous for indented markdown).
        // Promotion has to match each of them, not pick one.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"ws-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"```sh\\n    indented\\n```\"}]}}\n"
        );
        let detail = parse_rollout("whitespace", content, "ws-1");

        assert_eq!(
            turn_texts(&detail)[0].1.as_deref(),
            Some("```sh\n    indented\n```")
        );
    }

    #[test]
    fn an_unknown_content_tag_is_still_read_as_text() {
        // codex's item vocabulary keeps growing upstream, and this path only
        // runs where guessing wrong costs the user the whole transcript — so the
        // extractor keys on the presence of `text`, not on the tag.
        let content = concat!(
            "{\"timestamp\":\"2026-03-01T10:00:00Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"tag-1\",\"cwd\":\"/tmp/demo\"}}\n",
            "{\"timestamp\":\"2026-03-01T10:00:01Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"some_future_tag\",\"text\":\"still readable\"},{\"type\":\"opaque\",\"blob\":1}]}}\n"
        );
        let detail = parse_rollout("future-tag", content, "tag-1");

        assert_eq!(
            turn_texts(&detail),
            vec![("assistant", Some("still readable".into()))]
        );
    }
}
