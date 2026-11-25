//! The branches a rewind leaves behind in a Claude Code transcript.
//!
//! Claude Code never deletes a record. Editing an earlier prompt — double-Esc
//! in the terminal, or claude-agent-acp's `_session/rewind` (0.112.0) — resumes
//! the session at the entry before that prompt and appends the new prompt with
//! `parentUuid` naming that entry. The old prompt and everything that grew from
//! it stay in the file as an abandoned branch. Claude Code itself reads a
//! session by walking back from its newest leaf, so it never sees them; codeg's
//! parser reads the file front to back, and without this pass it showed both
//! branches one after the other.
//!
//! Two signals name a dropped prompt:
//!
//! * **A later prompt beside it.** When a typed prompt hangs off an entry that
//!   already has an earlier branch holding a typed prompt, that branch was
//!   edited away. The earlier branch need not START with the prompt: Claude
//!   Code often writes an attachment (`prompt_snapshot` and the like) between
//!   a reply and the next prompt, and a rewind resumes at the reply itself, so
//!   the replacement hangs off the reply while the dropped prompt hangs off
//!   the attachment below it (t605 live capture). Only a typed prompt starts
//!   the check: tool results, attachments and progress records also branch
//!   off an assistant record in ordinary transcripts, and none of them is a
//!   rewind.
//! * **`<session dir>/rewind.json`** (`{resumeSessionAt, droppedPromptUuid}`),
//!   which claude-agent-acp writes for its own rewinds and removes only once a
//!   later resume shows the cut in Claude Code's own history. It is the one
//!   signal for a rewind with no new prompt yet: the dropped prompt is then
//!   still the newest branch, with nothing beside it.
//!
//! A dropped prompt takes its whole subtree with it — every record descending
//! from it through `parentUuid`, or through `logicalParentUuid` across a
//! compaction (the adapter's `withoutRewoundBranch` uses the same two edges).
//! Records without a uuid (`last-prompt`, `queue-operation`, cost and mode
//! bookkeeping) are kept: none of them is conversation.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::path::Path;

use serde::de::{self, Deserializer, IgnoredAny, SeqAccess, Visitor};
use serde::Deserialize;

/// The fields of one transcript record the branch pass reads. Everything else
/// — a tool result's whole output included — is skipped without being built.
#[derive(Deserialize)]
struct BranchRecord<'a> {
    #[serde(borrow, default)]
    uuid: Option<Cow<'a, str>>,
    #[serde(rename = "parentUuid", borrow, default)]
    parent_uuid: Option<Cow<'a, str>>,
    #[serde(rename = "logicalParentUuid", borrow, default)]
    logical_parent_uuid: Option<Cow<'a, str>>,
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(rename = "isSidechain", default)]
    is_sidechain: Option<bool>,
    #[serde(rename = "isMeta", default)]
    is_meta: Option<bool>,
    #[serde(rename = "isCompactSummary", default)]
    is_compact_summary: Option<bool>,
    #[serde(default)]
    message: Option<BranchMessage>,
}

#[derive(Deserialize)]
struct BranchMessage {
    #[serde(default)]
    content: Option<PromptShape>,
}

/// Whether a user record's `content` is something a person typed: a non-empty
/// string, or blocks of which at least one is not a tool result.
struct PromptShape(bool);

impl<'de> Deserialize<'de> for PromptShape {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ShapeVisitor;

        #[derive(Deserialize)]
        struct BlockKind<'a> {
            #[serde(rename = "type", borrow, default)]
            kind: Option<Cow<'a, str>>,
        }

        impl<'de> Visitor<'de> for ShapeVisitor {
            type Value = PromptShape;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("message content")
            }

            fn visit_str<E: de::Error>(self, v: &str) -> Result<Self::Value, E> {
                Ok(PromptShape(!v.trim().is_empty()))
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let mut typed = false;
                while let Some(block) = seq.next_element::<Option<BlockKind<'de>>>()? {
                    if block.is_some_and(|b| b.kind.as_deref() != Some("tool_result")) {
                        typed = true;
                    }
                }
                Ok(PromptShape(typed))
            }

            fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> {
                Ok(PromptShape(false))
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
                while map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                Ok(PromptShape(false))
            }
        }

        deserializer.deserialize_any(ShapeVisitor)
    }
}

struct Node<'a> {
    uuid: Cow<'a, str>,
    parent: Option<Cow<'a, str>>,
    logical_parent: Option<Cow<'a, str>>,
    is_prompt: bool,
}

/// The prompt `rewind.json` says was dropped, for the transcript at `path`
/// (`<project dir>/<session id>.jsonl`; the file lives in `<project dir>/<session
/// id>/`, beside the session's `subagents/`). `None` when there is no file or
/// it does not parse — which is also how claude-agent-acp treats a point it
/// cannot use for reading, bar the load it then fails.
pub(crate) fn pending_rewind_drop(path: &Path) -> Option<String> {
    let marker = path.with_extension("").join("rewind.json");
    let raw = std::fs::read(marker).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&raw).ok()?;
    value
        .get("droppedPromptUuid")?
        .as_str()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// Which of `lines` belong to a rewound branch. `None` when nothing does —
/// the overwhelmingly common case, which then costs one light scan.
pub(crate) fn rewound_lines(lines: &[&str], pending_drop: Option<&str>) -> Option<Vec<bool>> {
    let mut nodes: Vec<Option<Node<'_>>> = Vec::with_capacity(lines.len());
    for line in lines {
        nodes.push(parse_node(line));
    }

    // Children in file order, by the edge that defines siblings (`parentUuid`)
    // and by both edges for the subtree walk.
    let mut siblings: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut descendants: HashMap<&str, Vec<usize>> = HashMap::new();
    for (idx, node) in nodes.iter().enumerate() {
        let Some(node) = node else { continue };
        if let Some(parent) = node.parent.as_deref() {
            siblings.entry(parent).or_default().push(idx);
            descendants.entry(parent).or_default().push(idx);
        }
        if let Some(parent) = node.logical_parent.as_deref() {
            if node.parent.as_deref() != Some(parent) {
                descendants.entry(parent).or_default().push(idx);
            }
        }
    }

    let subtree = |root: usize| -> Vec<usize> {
        let mut seen = HashSet::from([root]);
        let mut stack = vec![root];
        while let Some(idx) = stack.pop() {
            let Some(node) = &nodes[idx] else { continue };
            for &child in descendants.get(node.uuid.as_ref()).into_iter().flatten() {
                if seen.insert(child) {
                    stack.push(child);
                }
            }
        }
        seen.into_iter().collect()
    };

    let mut dropped: HashSet<usize> = HashSet::new();
    if let Some(drop) = pending_drop {
        if let Some(root) = nodes
            .iter()
            .position(|n| n.as_ref().is_some_and(|n| n.uuid == drop))
        {
            dropped.extend(subtree(root));
        }
    }

    let is_prompt = |idx: usize| nodes[idx].as_ref().is_some_and(|n| n.is_prompt);
    for children in siblings.values() {
        for (pos, &later) in children.iter().enumerate().skip(1) {
            if !is_prompt(later) {
                continue;
            }
            for &earlier in &children[..pos] {
                if dropped.contains(&earlier) {
                    continue;
                }
                let branch = subtree(earlier);
                // A branch with no prompt in it is the reply's own bookkeeping
                // (a tool result, an attachment), not an edited exchange. And an
                // abandoned branch stopped growing before the prompt that
                // replaced it: one that kept going after it is two lines of
                // work interleaved in one file, not a rewind — leave both.
                if branch.iter().any(|&idx| is_prompt(idx)) && branch.iter().all(|&idx| idx < later)
                {
                    dropped.extend(branch);
                }
            }
        }
    }

    if dropped.is_empty() {
        return None;
    }
    let mut mask = vec![false; lines.len()];
    for idx in dropped {
        mask[idx] = true;
    }
    Some(mask)
}

fn parse_node(line: &str) -> Option<Node<'_>> {
    // Every record a branch is made of carries a uuid; bookkeeping lines do
    // not, and are by far the cheapest to rule out.
    if !line.contains("\"uuid\"") {
        return None;
    }
    let record: BranchRecord<'_> = serde_json::from_str(line).ok()?;
    let uuid = record.uuid.filter(|u| !u.is_empty())?;
    let is_prompt = record.kind.as_deref() == Some("user")
        && record.is_sidechain != Some(true)
        && record.is_meta != Some(true)
        && record.is_compact_summary != Some(true)
        && record
            .message
            .and_then(|m| m.content)
            .is_some_and(|shape| shape.0);
    Some(Node {
        uuid,
        parent: record.parent_uuid.filter(|p| !p.is_empty()),
        logical_parent: record.logical_parent_uuid.filter(|p| !p.is_empty()),
        is_prompt,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn user(uuid: &str, parent: Option<&str>, text: &str) -> String {
        json!({"type": "user", "uuid": uuid, "parentUuid": parent,
               "message": {"role": "user", "content": text}})
        .to_string()
    }

    fn assistant(uuid: &str, parent: &str) -> String {
        json!({"type": "assistant", "uuid": uuid, "parentUuid": parent,
               "message": {"role": "assistant", "content": [{"type": "text", "text": "ok"}]}})
        .to_string()
    }

    fn tool_result(uuid: &str, parent: &str) -> String {
        json!({"type": "user", "uuid": uuid, "parentUuid": parent,
               "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t", "content": "x"}]}})
        .to_string()
    }

    fn dropped(lines: &[String], pending: Option<&str>) -> Vec<usize> {
        let refs: Vec<&str> = lines.iter().map(String::as_str).collect();
        rewound_lines(&refs, pending)
            .map(|mask| {
                mask.iter()
                    .enumerate()
                    .filter_map(|(i, d)| d.then_some(i))
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn a_linear_transcript_has_nothing_to_drop() {
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "second"),
            assistant("a2", "u2"),
        ];
        assert!(dropped(&lines, None).is_empty());
    }

    /// The shape claude-agent-acp 0.112.0 left after rewinding the last of
    /// three turns and sending an edited prompt (t605 live capture, trimmed).
    #[test]
    fn an_edited_last_prompt_drops_the_old_one_and_its_reply() {
        let lines = vec![
            user("u1", None, "first question"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "second question"),
            assistant("a2", "u2"),
            user("u3", Some("a2"), "third question"),
            assistant("a3", "u3"),
            json!({"type": "last-prompt", "lastPrompt": "third question", "leafUuid": "a3"})
                .to_string(),
            user("u4", Some("a2"), "edited question"),
            assistant("a4", "u4"),
        ];
        assert_eq!(dropped(&lines, None), vec![4, 5]);
    }

    #[test]
    fn an_edited_middle_prompt_drops_every_later_turn_of_the_old_branch() {
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "second"),
            assistant("a2", "u2"),
            user("u3", Some("a2"), "third"),
            assistant("a3", "u3"),
            user("u4", Some("a1"), "edited second"),
            assistant("a4", "u4"),
        ];
        assert_eq!(dropped(&lines, None), vec![2, 3, 4, 5]);
    }

    fn attachment(uuid: &str, parent: &str) -> String {
        json!({"type": "attachment", "uuid": uuid, "parentUuid": parent,
               "attachment": {"type": "prompt_snapshot"}})
        .to_string()
    }

    /// A rewind resumes at the reply; the dropped prompt hangs off the
    /// attachment Claude Code wrote below that reply (t605 live capture of a
    /// middle-turn rewind, trimmed).
    #[test]
    fn a_dropped_prompt_below_an_attachment_goes_with_the_attachment() {
        let lines = vec![
            user("u1", None, "first question"),
            assistant("a1", "u1"),
            attachment("at1", "a1"),
            user("u2", Some("at1"), "second question"),
            assistant("a2", "u2"),
            user("u3", Some("a2"), "third question"),
            assistant("a3", "u3"),
            user("u4", Some("a1"), "edited question"),
            assistant("a4", "u4"),
        ];
        assert_eq!(dropped(&lines, None), vec![2, 3, 4, 5, 6]);
    }

    #[test]
    fn a_tool_result_branch_beside_a_prompt_is_kept() {
        // The earlier branch holds no prompt: bookkeeping, not an edit.
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            attachment("at1", "a1"),
            tool_result("r1", "at1"),
            user("u2", Some("a1"), "next"),
        ];
        assert!(dropped(&lines, None).is_empty());
    }

    #[test]
    fn a_pending_rewind_drops_its_prompt_before_any_new_one_arrives() {
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "second"),
            assistant("a2", "u2"),
        ];
        assert_eq!(dropped(&lines, Some("u2")), vec![2, 3]);
        // A point naming a record the file does not have changes nothing.
        assert!(dropped(&lines, Some("gone")).is_empty());
    }

    #[test]
    fn parallel_tool_results_beside_a_prompt_are_not_a_rewind() {
        // Tool results (and attachments, progress records) branch off an
        // assistant record in ordinary transcripts. Only two typed prompts
        // under one parent mean an edit.
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            tool_result("r1", "a1"),
            tool_result("r2", "a1"),
            user("u2", Some("a1"), "steered while the tools ran"),
            assistant("a2", "u2"),
        ];
        assert!(dropped(&lines, None).is_empty());
    }

    #[test]
    fn a_branch_that_keeps_growing_after_its_sibling_is_left_alone() {
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "one"),
            user("u3", Some("a1"), "two"),
            assistant("a2", "u2"),
        ];
        assert!(dropped(&lines, None).is_empty());
    }

    #[test]
    fn a_compaction_inside_the_dropped_branch_goes_with_it() {
        let lines = vec![
            user("u1", None, "first"),
            assistant("a1", "u1"),
            user("u2", Some("a1"), "second"),
            assistant("a2", "u2"),
            json!({"type": "system", "subtype": "compact_boundary", "uuid": "cb", "parentUuid": null, "logicalParentUuid": "a2"})
                .to_string(),
            json!({"type": "user", "uuid": "cs", "parentUuid": "cb", "isCompactSummary": true,
                   "message": {"role": "user", "content": "summary"}})
            .to_string(),
            user("u3", Some("a1"), "edited second"),
        ];
        assert_eq!(dropped(&lines, None), vec![2, 3, 4, 5]);
    }

    #[test]
    fn rewind_json_is_read_from_the_session_directory() {
        let dir = tempfile::tempdir().unwrap();
        let transcript = dir.path().join("sess-1.jsonl");
        std::fs::write(&transcript, "").unwrap();
        assert_eq!(pending_rewind_drop(&transcript), None);
        std::fs::create_dir_all(dir.path().join("sess-1")).unwrap();
        std::fs::write(
            dir.path().join("sess-1").join("rewind.json"),
            r#"{"resumeSessionAt":"a1","droppedPromptUuid":"u2"}"#,
        )
        .unwrap();
        assert_eq!(pending_rewind_drop(&transcript).as_deref(), Some("u2"));
    }
}
