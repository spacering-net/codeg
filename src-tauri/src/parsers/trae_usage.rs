//! Token usage enrichment for TRAE CLI sessions.
//!
//! TRAE's ACP `usage_update` is context occupancy, not billable usage. The
//! precise per-request counters live in the CLI's native rollout as
//! `token_usage_record` rows. ACP session ids and rollout thread ids are the
//! same, so this module can enrich codeg's ACP-projected turns without parsing
//! TRAE's private message/history format.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use walkdir::WalkDir;

use crate::models::{MessageTurn, TurnRole, TurnUsage};

#[derive(Debug)]
struct UsageRecord {
    turn_id: Option<String>,
    response_id: String,
    occurred_at: Option<DateTime<Utc>>,
    usage: TurnUsage,
}

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

    // One TRAE turn may make several model requests around tool calls. Keep
    // those requests together before choosing an ACP turn, then write their sum
    // once so the conversation footer and dashboard cannot double-count them.
    let mut groups: Vec<(String, Vec<&UsageRecord>)> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    for record in &records {
        let key = record
            .turn_id
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

    // Native rollout counters are authoritative for the turns they cover. A
    // future TRAE ACP release may also report those counters at turn end; an
    // overwrite here prevents the two copies from being added together.
    for (index, usage) in assigned {
        turns[index].usage = Some(usage);
    }
    Some(total)
}

fn read_usage_records(sessions_dir: &Path, session_ids: &[String]) -> Vec<UsageRecord> {
    if session_ids.is_empty() || !sessions_dir.exists() {
        return Vec::new();
    }
    let wanted: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut records = Vec::new();

    for path in rollout_paths(sessions_dir, &wanted) {
        let Ok(file) = File::open(&path) else {
            continue;
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
            let Ok(row) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if row.get("type").and_then(serde_json::Value::as_str) != Some("token_usage_record") {
                continue;
            }
            let Some(payload) = row.get("payload") else {
                continue;
            };
            let Some(thread_id) = string_id(payload.get("thread_id"))
                .or_else(|| string_id(payload.get("session_id")))
            else {
                continue;
            };
            if !wanted.contains(thread_id.as_str()) {
                continue;
            }
            let response_id = string_id(payload.get("response_id"))
                .unwrap_or_else(|| format!("{}:{line_no}", path.to_string_lossy()));
            if !seen.insert((thread_id, response_id.clone())) {
                continue;
            }
            let Some(usage) = payload.get("usage").and_then(usage_from_value) else {
                continue;
            };
            records.push(UsageRecord {
                turn_id: string_id(payload.get("turn_id"))
                    .or_else(|| string_id(payload.get("root_turn_id"))),
                response_id,
                occurred_at: row
                    .get("timestamp")
                    .and_then(serde_json::Value::as_str)
                    .and_then(parse_timestamp),
                usage,
            });
        }
    }

    records.sort_by_key(|record| record.occurred_at);
    records
}

fn rollout_paths(sessions_dir: &Path, session_ids: &HashSet<&str>) -> Vec<PathBuf> {
    WalkDir::new(sessions_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .map(walkdir::DirEntry::into_path)
        .filter(|path| {
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                return false;
            };
            if !name.starts_with("rollout-") || !name.ends_with(".jsonl") {
                return false;
            }
            session_ids.iter().any(|id| {
                name.ends_with(&format!("-{id}.jsonl")) || name.contains(&format!("-{id}_"))
            })
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
}
