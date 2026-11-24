//! Token usage enrichment for TRAE CLI sessions.
//!
//! TRAE's ACP `usage_update` is context occupancy, not billable usage. Its
//! prompt response does carry the turn's counters (`usage`, and
//! `_meta._trae/tokenUsage`), but codeg does not record them, and they cover
//! only the session's own model requests: what the sub-agents it launched
//! spent is not in them (verified against `traecli 0.209.1`).
//!
//! The complete per-request counters live in the CLI's native rollouts as
//! `token_usage_record` rows. ACP session ids and rollout thread ids are the
//! same, so this module can enrich codeg's ACP-projected turns without parsing
//! TRAE's private message/history format.
//!
//! ## Sub-agents
//!
//! A sub-agent runs on a thread of its own and writes its own rollout, named
//! by that thread's id. Its rows carry the child thread as `thread_id`, the
//! root session as `session_id` and the root turn that launched it as
//! `root_turn_id` — at every depth. The parent's rollout names each child in a
//! spawn event (`SubAgentActivity`, `CollabAgentToolCall`), so the reader
//! follows those events to the child rollouts, and from there to their own
//! children.
//!
//! ## Copied history
//!
//! A forked session's rollout opens with a copy of its parent's history: the
//! parent's `token_usage_record` rows and spawn events, still stamped with the
//! parent's thread id. That spend belongs to the parent's conversation, so a
//! row counts only when its thread is one this conversation runs on and its
//! root session is one of this conversation's, and a spawn is followed only
//! when it happened on one of this conversation's threads.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use walkdir::WalkDir;

use crate::models::{MessageTurn, TurnRole, TurnUsage};

#[derive(Debug)]
struct UsageRecord {
    /// The ROOT turn that spent this: the session's own turn for its own
    /// requests, and the turn that launched a sub-agent for the sub-agent's.
    root_turn_id: Option<String>,
    response_id: String,
    occurred_at: Option<DateTime<Utc>>,
    usage: TurnUsage,
}

/// Substrings a rollout line must contain to be worth parsing: a usage row or
/// a spawn event. Everything else in a rollout — history mutations, world
/// state, tool output — is skipped unparsed, so reading the counters costs one
/// scan of the file rather than a JSON parse of every line of it.
const SCANNED_LINE_MARKERS: [&str; 4] = [
    "token_usage_record",
    "SubAgentActivity",
    "CollabAgentToolCall",
    "sub_agent_activity",
];

/// Read every usage record belonging to `session_ids`, attach each native turn
/// to the closest ACP assistant turn, and return the native session total.
///
/// The returned total remains useful when a failed/empty turn produced usage
/// but no assistant turn for the ACP projection to carry.
pub(crate) fn enrich_turns(
    sessions_dir: &Path,
    session_ids: &[String],
    turns: &mut [MessageTurn],
) -> Option<TurnUsage> {
    let records = read_usage_records(sessions_dir, session_ids);
    if records.is_empty() {
        return None;
    }

    let total = records.iter().fold(TurnUsage::default(), |sum, record| {
        add_usage(&sum, &record.usage)
    });
    let assistant_indices: Vec<usize> = turns
        .iter()
        .enumerate()
        .filter_map(|(index, turn)| matches!(turn.role, TurnRole::Assistant).then_some(index))
        .collect();
    if assistant_indices.is_empty() {
        return Some(total);
    }

    // One TRAE turn may make several model requests around tool calls, and the
    // sub-agents it launches make their own. Keep all of them together under
    // the root turn before choosing an ACP turn, then write their sum once so
    // the conversation footer and dashboard cannot double-count them — and a
    // sub-agent that finishes after its turn ended still bills that turn.
    let mut groups: Vec<(String, Vec<&UsageRecord>)> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for record in &records {
        let key = record
            .root_turn_id
            .clone()
            .unwrap_or_else(|| format!("response:{}", record.response_id));
        let index = match group_index.get(&key).copied() {
            Some(index) => index,
            None => {
                let index = groups.len();
                group_index.insert(key.clone(), index);
                groups.push((key, Vec::new()));
                index
            }
        };
        groups[index].1.push(record);
    }

    let mut assigned: HashMap<usize, TurnUsage> = HashMap::new();
    for (sequence, (_, group)) in groups.into_iter().enumerate() {
        let occurred_at = group.iter().find_map(|record| record.occurred_at);
        let target = occurred_at
            .map(|at| closest_assistant_turn(turns, &assistant_indices, at))
            .unwrap_or_else(|| assistant_indices[sequence.min(assistant_indices.len() - 1)]);
        let group_usage = group.iter().fold(TurnUsage::default(), |sum, record| {
            add_usage(&sum, &record.usage)
        });
        assigned
            .entry(target)
            .and_modify(|usage| *usage = add_usage(usage, &group_usage))
            .or_insert(group_usage);
    }

    // Native rollout counters are authoritative for the turns they cover. Were
    // codeg to record the prompt response's own counters at turn end, an
    // overwrite here keeps the two copies from being added together.
    for (index, usage) in assigned {
        turns[index].usage = Some(usage);
    }
    Some(total)
}

fn read_usage_records(sessions_dir: &Path, session_ids: &[String]) -> Vec<UsageRecord> {
    if session_ids.is_empty() || !sessions_dir.exists() {
        return Vec::new();
    }
    // The conversation's own root sessions: its session and the ones it
    // continues. Every row it may count carries one of them as `session_id`.
    let roots: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let rollouts = rollout_files(sessions_dir);
    // The threads it runs on: the roots, then every sub-agent thread a spawn
    // event on one of them names. Grows while the rollouts are read.
    let mut threads: HashSet<String> = session_ids.iter().cloned().collect();
    let mut pending: VecDeque<String> = session_ids.iter().cloned().collect();
    let mut scanned: HashSet<&Path> = HashSet::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut records = Vec::new();

    while let Some(thread) = pending.pop_front() {
        let own_file = format!("-{thread}.jsonl");
        let reverted_file = format!("-{thread}_");
        for (path, name) in &rollouts {
            if !(name.ends_with(&own_file) || name.contains(&reverted_file)) {
                continue;
            }
            if !scanned.insert(path.as_path()) {
                continue;
            }
            scan_rollout(
                path,
                &roots,
                &mut threads,
                &mut pending,
                &mut seen,
                &mut records,
            );
        }
    }

    records.sort_by_key(|record| record.occurred_at);
    records
}

/// Collect one rollout's usage rows into `records`, and queue every sub-agent
/// thread its spawn events name that is not known yet.
fn scan_rollout(
    path: &Path,
    roots: &HashSet<&str>,
    threads: &mut HashSet<String>,
    pending: &mut VecDeque<String>,
    seen: &mut HashSet<(String, String)>,
    records: &mut Vec<UsageRecord>,
) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let mut reader = BufReader::new(file);
    let mut bytes = Vec::new();
    let mut line_no = 0usize;
    loop {
        bytes.clear();
        let read = match reader.read_until(b'\n', &mut bytes) {
            Ok(read) => read,
            Err(_) => break,
        };
        if read == 0 {
            break;
        }
        line_no += 1;
        let line = String::from_utf8_lossy(&bytes);
        if !SCANNED_LINE_MARKERS
            .iter()
            .any(|marker| line.contains(marker))
        {
            continue;
        }
        let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(payload) = row.get("payload") else {
            continue;
        };
        match row.get("type").and_then(serde_json::Value::as_str) {
            Some("token_usage_record") => {}
            Some("event_msg") => {
                // A spawn counts only where it happened: copied history keeps
                // the thread it was recorded on, which is not one of ours.
                let on_our_thread = string_id(payload.get("thread_id"))
                    .is_none_or(|thread| threads.contains(&thread));
                if on_our_thread {
                    for child in spawned_threads(payload) {
                        if threads.insert(child.clone()) {
                            pending.push_back(child);
                        }
                    }
                }
                continue;
            }
            _ => continue,
        }
        let Some(thread_id) = string_id(payload.get("thread_id"))
            .or_else(|| string_id(payload.get("session_id")))
        else {
            continue;
        };
        if !threads.contains(&thread_id) {
            continue;
        }
        // A sub-agent's row names the root session it ran under; one naming
        // another session's root is that session's spend, whatever led here.
        if !roots.contains(thread_id.as_str())
            && string_id(payload.get("session_id"))
                .is_some_and(|root| !roots.contains(root.as_str()))
        {
            continue;
        }
        let Some(usage) = payload.get("usage").and_then(usage_from_value) else {
            continue;
        };
        let response_id = string_id(payload.get("response_id"))
            .unwrap_or_else(|| format!("{}:{line_no}", path.to_string_lossy()));
        if !seen.insert((thread_id, response_id.clone())) {
            continue;
        }
        records.push(UsageRecord {
            root_turn_id: string_id(payload.get("root_turn_id"))
                .or_else(|| string_id(payload.get("turn_id"))),
            response_id,
            occurred_at: row
                .get("timestamp")
                .and_then(serde_json::Value::as_str)
                .and_then(parse_timestamp),
            usage,
        });
    }
}

/// The sub-agent threads an `event_msg` names, in either shape TRAE inherits
/// from Codex: a `SubAgentActivity` item (nested under `item_completed`, or the
/// older flat `sub_agent_activity` event), and the spawn's own
/// `CollabAgentToolCall` item with its `receiver_thread_ids`.
fn spawned_threads(payload: &serde_json::Value) -> Vec<String> {
    let event = payload.get("type").and_then(serde_json::Value::as_str);
    let source = match event {
        Some("sub_agent_activity") => payload,
        Some("item_completed") => match payload.get("item") {
            Some(item) => item,
            None => return Vec::new(),
        },
        _ => return Vec::new(),
    };
    let kind = (event == Some("sub_agent_activity"))
        .then_some("SubAgentActivity")
        .or_else(|| source.get("type").and_then(serde_json::Value::as_str));
    match kind {
        Some("SubAgentActivity") => string_id(source.get("agent_thread_id"))
            .into_iter()
            .collect(),
        Some("CollabAgentToolCall") => source
            .get("receiver_thread_ids")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|id| string_id(Some(id)))
            .collect(),
        _ => Vec::new(),
    }
}

/// Every rollout file under `sessions_dir`, with its file name. Walked once per
/// read; the per-rollout `.artifacts` directories (background task output) are
/// not descended into.
fn rollout_files(sessions_dir: &Path) -> Vec<(PathBuf, String)> {
    WalkDir::new(sessions_dir)
        .into_iter()
        .filter_entry(|entry| {
            !(entry.file_type().is_dir()
                && entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.ends_with(".artifacts")))
        })
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let name = entry.file_name().to_str()?.to_string();
            (name.starts_with("rollout-") && name.ends_with(".jsonl"))
                .then(|| (entry.into_path(), name))
        })
        .collect()
}

fn string_id(value: Option<&serde_json::Value>) -> Option<String> {
    let value = value?;
    if let Some(value) = value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    (value.is_number() || value.is_boolean()).then(|| value.to_string())
}

fn parse_timestamp(raw: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|value| value.with_timezone(&Utc))
}

/// TRAE follows Codex semantics: `input_tokens` is the whole prompt and both
/// cache counters are subsets of it. Codeg stores disjoint counters, so split
/// the cache portions out. `reasoning_output_tokens` is already included in
/// TRAE's `output_tokens` (and consequently in `total_tokens`), so it must not
/// be added again.
fn usage_from_value(value: &serde_json::Value) -> Option<TurnUsage> {
    let field = |name: &str| {
        value
            .get(name)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0)
    };
    let input = field("input_tokens");
    let cache_read = field("cached_input_tokens");
    let cache_write = field("cache_creation_input_tokens").min(input.saturating_sub(cache_read));
    let usage = TurnUsage {
        input_tokens: input.saturating_sub(cache_read).saturating_sub(cache_write),
        output_tokens: field("output_tokens"),
        cache_creation_input_tokens: cache_write,
        cache_read_input_tokens: cache_read,
    };
    (usage.input_tokens > 0
        || usage.output_tokens > 0
        || usage.cache_creation_input_tokens > 0
        || usage.cache_read_input_tokens > 0)
        .then_some(usage)
}

fn add_usage(left: &TurnUsage, right: &TurnUsage) -> TurnUsage {
    TurnUsage {
        input_tokens: left.input_tokens.saturating_add(right.input_tokens),
        output_tokens: left.output_tokens.saturating_add(right.output_tokens),
        cache_creation_input_tokens: left
            .cache_creation_input_tokens
            .saturating_add(right.cache_creation_input_tokens),
        cache_read_input_tokens: left
            .cache_read_input_tokens
            .saturating_add(right.cache_read_input_tokens),
    }
}

fn closest_assistant_turn(
    turns: &[MessageTurn],
    assistant_indices: &[usize],
    occurred_at: DateTime<Utc>,
) -> usize {
    assistant_indices
        .iter()
        .copied()
        .min_by_key(|index| {
            let turn = &turns[*index];
            let end = turn.completed_at.unwrap_or(turn.timestamp);
            if occurred_at >= turn.timestamp && occurred_at <= end {
                0
            } else if occurred_at < turn.timestamp {
                (turn.timestamp - occurred_at)
                    .num_milliseconds()
                    .unsigned_abs()
            } else {
                (occurred_at - end).num_milliseconds().unsigned_abs()
            }
        })
        .unwrap_or(assistant_indices[0])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{ContentBlock, MessageTurn};
    use tempfile::TempDir;

    fn at(raw: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(raw)
            .unwrap()
            .with_timezone(&Utc)
    }

    fn assistant(start: &str, end: &str) -> MessageTurn {
        MessageTurn {
            id: start.to_string(),
            role: TurnRole::Assistant,
            blocks: vec![ContentBlock::Text {
                text: "answer".to_string(),
            }],
            timestamp: at(start),
            usage: None,
            duration_ms: None,
            model: Some("gpt-5.6-sol".to_string()),
            completed_at: Some(at(end)),
            agent_message_id: None,
        }
    }

    fn write_rollout(root: &Path, session_id: &str, lines: &[serde_json::Value]) {
        let dir = root.join("2026/10/13");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("rollout-2026-10-13T10-00-00-{session_id}.jsonl"));
        let content = lines
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(path, format!("{content}\n")).unwrap();
    }

    #[test]
    fn trae_usage_splits_cached_input_without_double_counting_reasoning() {
        let usage = usage_from_value(&serde_json::json!({
            "input_tokens": 20_454,
            "cache_creation_input_tokens": 128,
            "cached_input_tokens": 19_968,
            "output_tokens": 130,
            "reasoning_output_tokens": 24,
            "total_tokens": 20_584
        }))
        .unwrap();
        assert_eq!(usage.input_tokens, 358);
        assert_eq!(usage.cache_creation_input_tokens, 128);
        assert_eq!(usage.cache_read_input_tokens, 19_968);
        assert_eq!(usage.output_tokens, 130);
        assert_eq!(
            usage.input_tokens
                + usage.cache_creation_input_tokens
                + usage.cache_read_input_tokens
                + usage.output_tokens,
            20_584
        );
    }

    #[test]
    fn records_are_deduped_and_grouped_onto_their_acp_turns() {
        let dir = TempDir::new().unwrap();
        let session_id = "01a13673-cfd5-7c23-bc00-ce5be75fd42b";
        let record = |timestamp: &str,
                      turn_id: &str,
                      response_id: &str,
                      input: u64,
                      cached: u64,
                      output: u64| {
            serde_json::json!({
                "timestamp": timestamp,
                "type": "token_usage_record",
                "payload": {
                    "thread_id": session_id,
                    "session_id": session_id,
                    "turn_id": turn_id,
                    "response_id": response_id,
                    "usage": {
                        "input_tokens": input,
                        "cache_creation_input_tokens": 0,
                        "cached_input_tokens": cached,
                        "output_tokens": output,
                        "reasoning_output_tokens": 1,
                        "total_tokens": input + output
                    }
                }
            })
        };
        write_rollout(
            dir.path(),
            session_id,
            &[
                record("2026-10-13T10:00:02Z", "turn-1", "resp-1", 100, 80, 5),
                // Same request repeated by a replay/pagination boundary.
                record("2026-10-13T10:00:02Z", "turn-1", "resp-1", 100, 80, 5),
                record("2026-10-13T10:00:03Z", "turn-1", "resp-2", 120, 90, 7),
                record("2026-10-13T10:01:02Z", "turn-2", "resp-3", 200, 150, 9),
            ],
        );

        let mut turns = vec![
            assistant("2026-10-13T10:00:00Z", "2026-10-13T10:00:10Z"),
            assistant("2026-10-13T10:01:00Z", "2026-10-13T10:01:10Z"),
        ];
        let total = enrich_turns(dir.path(), &[session_id.to_string()], &mut turns).unwrap();

        let first = turns[0].usage.as_ref().unwrap();
        assert_eq!(first.input_tokens, 50);
        assert_eq!(first.cache_read_input_tokens, 170);
        assert_eq!(first.output_tokens, 12);
        let second = turns[1].usage.as_ref().unwrap();
        assert_eq!(second.input_tokens, 50);
        assert_eq!(second.cache_read_input_tokens, 150);
        assert_eq!(second.output_tokens, 9);
        assert_eq!(total.input_tokens, 100);
        assert_eq!(total.cache_read_input_tokens, 320);
        assert_eq!(total.output_tokens, 21);
    }

    /// Write `lines` as the rollout `file_name` under one day directory.
    fn write_named_rollout(root: &Path, file_name: &str, lines: &[serde_json::Value]) {
        let dir = root.join("2026/10/26");
        std::fs::create_dir_all(&dir).unwrap();
        let content = lines
            .iter()
            .map(serde_json::Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(dir.join(file_name), format!("{content}\n")).unwrap();
    }

    /// A `token_usage_record` row in the shape `traecli 0.209.1` writes:
    /// `thread_id` is the thread that made the request, `session_id` its root
    /// session, `root_turn_id` the root turn it was made for.
    #[allow(clippy::too_many_arguments)]
    fn usage_row(
        at: &str,
        thread: &str,
        session: &str,
        root_turn: &str,
        response: &str,
        input: u64,
        cached: u64,
        output: u64,
    ) -> serde_json::Value {
        serde_json::json!({
            "timestamp": at,
            "type": "token_usage_record",
            "payload": {
                "thread_id": thread,
                "turn_id": format!("{thread}:{root_turn}"),
                "session_id": session,
                "root_turn_id": root_turn,
                "response_id": response,
                "usage": {
                    "input_tokens": input,
                    "cache_creation_input_tokens": 0,
                    "cached_input_tokens": cached,
                    "output_tokens": output,
                    "reasoning_output_tokens": 0,
                    "total_tokens": input + output
                }
            }
        })
    }

    /// The `SubAgentActivity` event a thread records when it spawns `child`.
    fn spawn_activity(at: &str, thread: &str, child: &str) -> serde_json::Value {
        serde_json::json!({
            "timestamp": at,
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "thread_id": thread,
                "item": {
                    "type": "SubAgentActivity",
                    "id": "subagent-activity:call_1",
                    "kind": "started",
                    "agent_thread_id": child
                }
            }
        })
    }

    /// The spawn's own `CollabAgentToolCall` item, naming its receivers.
    fn spawn_call(at: &str, thread: &str, children: &[&str]) -> serde_json::Value {
        serde_json::json!({
            "timestamp": at,
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "thread_id": thread,
                "item": {
                    "type": "CollabAgentToolCall",
                    "id": "call_2",
                    "tool": "spawn_agent",
                    "sender_thread_id": thread,
                    "receiver_thread_ids": children
                }
            }
        })
    }

    fn summed(usage: &TurnUsage) -> u64 {
        usage.input_tokens
            + usage.output_tokens
            + usage.cache_creation_input_tokens
            + usage.cache_read_input_tokens
    }

    #[test]
    fn sub_agent_spend_lands_on_the_turn_that_launched_it() {
        let dir = TempDir::new().unwrap();
        let root = "01a17899-f92f-7a10-8a25-10e504be3950";
        let child = "01a17899-f9a9-75f0-893b-81de0432dcef";
        let grandchild = "01a17899-f9ff-7cf0-b812-55fecc2c3a97";
        let reverted = "01a17899-ffff-7000-8000-000000000001";
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-00-{root}.jsonl"),
            &[
                usage_row("2026-10-26T10:00:01Z", root, root, "turn-1", "resp_1", 2000, 0, 20),
                spawn_activity("2026-10-26T10:00:01Z", root, child),
                usage_row("2026-10-26T10:00:05Z", root, root, "turn-1", "resp_5", 1234, 1000, 56),
            ],
        );
        // The child spawns a grandchild of its own, which the root's stream
        // never mentions; and it reports once more after the root turn ended.
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-01-{child}.jsonl"),
            &[
                usage_row("2026-10-26T10:00:02Z", child, root, "turn-1", "resp_2", 2000, 0, 20),
                spawn_call("2026-10-26T10:00:02Z", child, &[grandchild]),
                usage_row("2026-10-26T10:00:04Z", child, root, "turn-1", "resp_4", 1234, 1000, 56),
                usage_row("2026-10-26T10:00:40Z", child, root, "turn-1", "resp_7", 300, 0, 10),
            ],
        );
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-02-{grandchild}.jsonl"),
            &[usage_row("2026-10-26T10:00:03Z", grandchild, root, "turn-1", "resp_3", 777, 0, 33)],
        );
        // A later turn the thread recorded after moving onto a new rollout.
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-01-00-{root}_{reverted}.jsonl"),
            &[usage_row("2026-10-26T10:01:02Z", root, root, "turn-2", "resp_6", 500, 400, 5)],
        );

        let mut turns = vec![
            assistant("2026-10-26T10:00:00Z", "2026-10-26T10:00:10Z"),
            assistant("2026-10-26T10:01:00Z", "2026-10-26T10:01:10Z"),
        ];
        let total = enrich_turns(dir.path(), &[root.to_string()], &mut turns).unwrap();

        // Root 2020 + 1290, child 2020 + 1290 + 310, grandchild 810.
        let first = turns[0].usage.as_ref().unwrap();
        assert_eq!(summed(first), 7740);
        assert_eq!(first.cache_read_input_tokens, 2000);
        assert_eq!(first.output_tokens, 20 + 56 + 20 + 56 + 10 + 33);
        let second = turns[1].usage.as_ref().unwrap();
        assert_eq!(summed(second), 505);
        assert_eq!(summed(&total), 7740 + 505);
    }

    #[test]
    fn a_fork_counts_only_its_own_spend() {
        let dir = TempDir::new().unwrap();
        let parent = "01a178a3-5646-7e53-af99-5c0063df738b";
        let parent_child = "01a178a3-56de-7f72-8abc-6d309f5fbf25";
        let fork = "01a178a3-5f1d-7aa2-b4cb-daf7491a84f6";
        let fork_child = "01a178a3-5f77-71a0-9554-d2998025e6bb";
        let parent_rows = [
            usage_row("2026-10-26T10:00:01Z", parent, parent, "p-turn", "resp_12", 2000, 0, 20),
            spawn_activity("2026-10-26T10:00:01Z", parent, parent_child),
            spawn_call("2026-10-26T10:00:01Z", parent, &[parent_child]),
            usage_row("2026-10-26T10:00:03Z", parent, parent, "p-turn", "resp_14", 1234, 1000, 56),
        ];
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-00-{parent}.jsonl"),
            &parent_rows,
        );
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-01-{parent_child}.jsonl"),
            &[usage_row(
                "2026-10-26T10:00:02Z",
                parent_child,
                parent,
                "p-turn",
                "resp_13",
                777,
                0,
                33,
            )],
        );
        // The fork's rollout opens with a copy of the parent's history — its
        // rows and its spawns, still stamped with the parent's thread.
        let mut fork_rows = parent_rows.to_vec();
        fork_rows.extend([
            usage_row("2026-10-26T10:05:01Z", fork, fork, "f-turn", "resp_15", 2000, 0, 20),
            spawn_activity("2026-10-26T10:05:01Z", fork, fork_child),
            usage_row("2026-10-26T10:05:03Z", fork, fork, "f-turn", "resp_17", 1234, 1000, 56),
        ]);
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-05-00-{fork}.jsonl"),
            &fork_rows,
        );
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-05-01-{fork_child}.jsonl"),
            &[usage_row(
                "2026-10-26T10:05:02Z",
                fork_child,
                fork,
                "f-turn",
                "resp_16",
                777,
                0,
                33,
            )],
        );

        let mut fork_turns = vec![assistant("2026-10-26T10:05:00Z", "2026-10-26T10:05:10Z")];
        let fork_total = enrich_turns(dir.path(), &[fork.to_string()], &mut fork_turns).unwrap();
        assert_eq!(summed(&fork_total), 2020 + 1290 + 810);
        assert_eq!(summed(fork_turns[0].usage.as_ref().unwrap()), 2020 + 1290 + 810);

        let mut parent_turns = vec![assistant("2026-10-26T10:00:00Z", "2026-10-26T10:00:10Z")];
        let parent_total =
            enrich_turns(dir.path(), &[parent.to_string()], &mut parent_turns).unwrap();
        assert_eq!(summed(&parent_total), 2020 + 1290 + 810);
    }

    #[test]
    fn a_spawned_thread_of_another_session_is_never_counted() {
        let dir = TempDir::new().unwrap();
        let ours = "01a17899-0000-7000-8000-00000000000a";
        let stranger = "01a17899-0000-7000-8000-00000000000b";
        let theirs = "01a17899-0000-7000-8000-00000000000c";
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-00-{ours}.jsonl"),
            &[
                usage_row("2026-10-26T10:00:01Z", ours, ours, "turn-1", "resp_1", 100, 0, 10),
                spawn_activity("2026-10-26T10:00:01Z", ours, stranger),
            ],
        );
        // A thread running under another root session.
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-01-{stranger}.jsonl"),
            &[usage_row("2026-10-26T10:00:02Z", stranger, theirs, "turn-x", "resp_2", 900, 0, 90)],
        );

        let mut turns = vec![assistant("2026-10-26T10:00:00Z", "2026-10-26T10:00:10Z")];
        let total = enrich_turns(dir.path(), &[ours.to_string()], &mut turns).unwrap();
        assert_eq!(summed(&total), 110);
    }

    #[test]
    fn only_usage_rows_and_spawn_events_are_parsed() {
        // Everything else is skipped before it is parsed; a line that merely
        // mentions a marker inside some other record is parsed and dropped.
        let dir = TempDir::new().unwrap();
        let session = "01a17899-0000-7000-8000-0000000000aa";
        let noise = serde_json::json!({
            "timestamp": "2026-10-26T10:00:01Z",
            "type": "history_mutation",
            "payload": {"items": [{"type": "message", "content": "token_usage_record"}]}
        });
        write_named_rollout(
            dir.path(),
            &format!("rollout-2026-10-26T10-00-00-{session}.jsonl"),
            &[
                noise,
                usage_row("2026-10-26T10:00:02Z", session, session, "turn-1", "resp_1", 40, 0, 2),
            ],
        );
        let mut turns = vec![assistant("2026-10-26T10:00:00Z", "2026-10-26T10:00:10Z")];
        let total = enrich_turns(dir.path(), &[session.to_string()], &mut turns).unwrap();
        assert_eq!(summed(&total), 42);
    }
}
