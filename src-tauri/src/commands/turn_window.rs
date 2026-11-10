//! Turn-window slicing for conversation detail responses.
//!
//! The parsers always parse a session transcript in full (local parsing is
//! fast); what hurts web / remote-workspace mode is *transferring* every turn
//! of a long conversation on each detail fetch. These helpers slice the fully
//! parsed + fully post-processed turn list down to a requested window right
//! before serialization, plus compute the window metadata the frontend's
//! consistency protocol needs (offset/total, assistant count before the
//! window, a structural prefix fingerprint, and the max timestamp of the
//! uncovered prefix).
//!
//! Invariant shared with `get_folder_conversation_core`: every existing
//! post-processing pass (delegation-meta injection, auto-title, in-flight id
//! stamping) runs on the FULL turn list first; slicing is strictly a
//! serialization concern, so a windowed response is byte-identical to the
//! corresponding region of the full response.
//!
//! The message navigator needs one thing a window can't give it: an index of
//! EVERY user message, including the ones above the loaded window. Its
//! outline ([`nav_outline_turns`]) is a projection of that unloaded history,
//! cut down to what the navigator reads.

use std::collections::HashSet;

use chrono::{DateTime, Utc};

use crate::models::{ContentBlock, MessageTurn, TurnRole};

/// Server-side clamp for `tailTurns` / page `limit`.
pub const MAX_WINDOW_TURNS: usize = 500;

/// Upper bound on how far a window start walks backward looking for a
/// user-round boundary. Keeps a single degenerate round (one prompt followed
/// by hundreds of assistant/tool turns) from silently re-expanding a window
/// into a full-transcript transfer; when the cap is hit the boundary may fall
/// mid-round and the frontend renders a partial round.
pub const ROUND_ALIGN_CAP: usize = 200;

/// FNV-1a 64-bit offset basis / prime (public-domain constants).
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Requested window for a conversation-detail fetch. Mutually exclusive
/// selectors; validation lives in the command layer so both transports report
/// the same error.
#[derive(Debug, Clone, Copy)]
pub enum TurnWindowReq {
    /// Last `n` turns, start aligned backward to a user-round boundary.
    Tail(usize),
    /// Exact slice `turns[min(from, total)..]` — NEVER round-aligned, so the
    /// response offset matches the coordinate the client refreshed against
    /// (its prefix fingerprint would be incomparable otherwise).
    FromIndex(usize),
}

/// Window metadata attached to a sliced response.
#[derive(Debug, Clone)]
pub struct WindowMeta {
    pub offset: usize,
    pub total: usize,
    pub assistant_before: usize,
    /// User turns in `turns[0..offset)` — the messages above the window the
    /// navigator counts without having loaded them.
    pub user_before: usize,
    /// Fingerprint of `turns[0..offset)` as a fixed-width 16-hex string.
    /// Serialized as a string because a raw u64 JSON number is rounded by
    /// JS `response.json()` past 2^53-1, which would systematically break
    /// the client's chained-seed comparison.
    pub prefix_hash: String,
    /// Max `timestamp` across `turns[0..offset)`; `None` when the window
    /// covers the whole list. Drives the frontend's overlay-retirement
    /// coverage check (strictly-greater comparison).
    pub uncovered_prefix_max_ts: Option<DateTime<Utc>>,
}

fn role_tag(role: &TurnRole) -> u8 {
    match role {
        TurnRole::User => 0,
        TurnRole::Assistant => 1,
        TurnRole::System => 2,
    }
}

fn fnv1a_extend(mut hash: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Chained structural fingerprint over `(role_tag, timestamp_millis)` per
/// turn. Deliberately id-free: parser turn ids are index-derived (`turn-N`),
/// so they cannot witness a prefix rewrite anyway, and the in-flight user
/// turn's id is legitimately rewritten to the broadcast id while a turn is
/// running — an id-bearing fingerprint would make every mid-stream viewer
/// batch look like a prefix rewrite once the turn completes and the parser id
/// returns. `(role, millis)` is invariant under both id rewrites and in-place
/// content backfills (background-task ack previews), while insertions,
/// deletions and shifts — the actual shapes of a compact/rewrite — still
/// change the chain.
///
/// Mirrored bit-for-bit by the TypeScript implementation (BigInt); a shared
/// test vector pins the two.
pub fn prefix_fingerprint(turns: &[MessageTurn]) -> String {
    let mut hash = FNV_OFFSET;
    for turn in turns {
        hash = fnv1a_extend(hash, &[role_tag(&turn.role)]);
        hash = fnv1a_extend(hash, &turn.timestamp.timestamp_millis().to_le_bytes());
    }
    format!("{hash:016x}")
}

/// Walk `start` backward until the window begins at a `User` turn (or index
/// 0), bounded by [`ROUND_ALIGN_CAP`]. Alignment only ever ADDS earlier turns.
fn round_align_backward(turns: &[MessageTurn], mut start: usize) -> usize {
    let mut steps = 0;
    while start > 0
        && steps < ROUND_ALIGN_CAP
        && !matches!(turns[start].role, TurnRole::User)
    {
        start -= 1;
        steps += 1;
    }
    start
}

/// Resolve a window request against the full turn list, returning the slice
/// start (`offset`). `Tail` clamps to `1..=MAX_WINDOW_TURNS` then aligns
/// backward; `FromIndex` is exact (clamped to `total` only).
pub fn resolve_window_offset(turns: &[MessageTurn], req: TurnWindowReq) -> usize {
    match req {
        TurnWindowReq::Tail(n) => {
            let n = n.clamp(1, MAX_WINDOW_TURNS);
            round_align_backward(turns, turns.len().saturating_sub(n))
        }
        TurnWindowReq::FromIndex(from) => from.min(turns.len()),
    }
}

/// Resolve a history-page request: returns `(start, end)` for
/// `turns[start..end)` where `end = min(before_index, total)` and `start`
/// walks back `limit` turns then aligns to a user-round boundary.
pub fn resolve_page_bounds(
    turns: &[MessageTurn],
    before_index: usize,
    limit: usize,
) -> (usize, usize) {
    let end = before_index.min(turns.len());
    let limit = limit.clamp(1, MAX_WINDOW_TURNS);
    let start = round_align_backward(turns, end.saturating_sub(limit));
    (start.min(end), end)
}

/// Compute the response metadata for a window starting at `offset`.
pub fn window_meta(turns: &[MessageTurn], offset: usize) -> WindowMeta {
    let prefix = &turns[..offset.min(turns.len())];
    WindowMeta {
        offset,
        total: turns.len(),
        assistant_before: prefix
            .iter()
            .filter(|t| matches!(t.role, TurnRole::Assistant))
            .count(),
        user_before: prefix
            .iter()
            .filter(|t| matches!(t.role, TurnRole::User))
            .count(),
        prefix_hash: prefix_fingerprint(prefix),
        uncovered_prefix_max_ts: prefix.iter().map(|t| t.timestamp).max(),
    }
}

/// Reduce `turns` to what the frontend message navigator reads — the outline
/// of the history above the loaded window.
///
/// The navigator indexes a conversation with `extractSessionFilesGrouped`
/// (`src/lib/session-files.ts`): one entry per user turn, labelled from the
/// turn's first non-empty text block, with per-file line stats and diffs from
/// the edit/write/apply_patch tool calls of the assistant turns in its round.
/// The projection keeps exactly what that function reads and drops the rest —
/// tool outputs, prose, thinking and images, i.e. nearly all of a transcript's
/// weight — so the outline indexes the same as the full turns would:
///
/// - every turn survives with its id, role and timestamp, so `outline[i]` is
///   global turn `i` and any prefix of the outline fingerprints the same as
///   the transcript it came from; usage, duration, model, completion time and
///   agent message id are dropped;
/// - a user turn keeps its first text block whose text is non-empty, the one
///   the label is read from;
/// - an assistant turn keeps every tool call — which of them edit files is
///   decided by the tool-name normalization, and that lives in the frontend —
///   and of the tool results only the one `findToolResultOutput` picks for a
///   call (its first result that is not an error and has a non-empty output),
///   and only when that output has a line starting with `@@ `: the one case
///   `buildDiffChunk` uses it (a diff the agent produced, with line numbers);
/// - a system turn keeps nothing.
///
/// Reading more of a turn in `extractSessionFilesGrouped` means keeping more
/// of it here. `tests/fixtures/nav_outline_vector.json` holds both sides to
/// that: the Rust test checks this produces the vector's outline, the TS test
/// that the outline indexes exactly like the full turns.
pub fn nav_outline_turns(turns: &[MessageTurn]) -> Vec<MessageTurn> {
    turns.iter().map(nav_outline_turn).collect()
}

fn nav_outline_turn(turn: &MessageTurn) -> MessageTurn {
    let blocks = match turn.role {
        TurnRole::User => turn
            .blocks
            .iter()
            .find(|block| matches!(block, ContentBlock::Text { text } if !text.is_empty()))
            .cloned()
            .into_iter()
            .collect(),
        TurnRole::Assistant => nav_outline_assistant_blocks(&turn.blocks),
        TurnRole::System => Vec::new(),
    };
    MessageTurn {
        id: turn.id.clone(),
        role: turn.role.clone(),
        blocks,
        timestamp: turn.timestamp,
        usage: None,
        duration_ms: None,
        model: None,
        completed_at: None,
        agent_message_id: None,
    }
}

fn nav_outline_assistant_blocks(blocks: &[ContentBlock]) -> Vec<ContentBlock> {
    // `findToolResultOutput` scans the turn's blocks in order and returns the
    // first result for the call id that is not an error and has an output;
    // later results for that id are never read, whatever they hold.
    // `answered` records every call whose result has been read, kept or not;
    // the guard inserts before it checks the output, so only a call's first
    // readable result can be kept.
    let mut answered: HashSet<&str> = HashSet::new();
    let mut kept = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::ToolUse { .. } => kept.push(block.clone()),
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                output_preview: Some(output),
                is_error: false,
                ..
            } if !output.is_empty()
                && answered.insert(id.as_str())
                && has_hunk_header_line(output) =>
            {
                kept.push(ContentBlock::ToolResult {
                    tool_use_id: Some(id.clone()),
                    output_preview: Some(output.clone()),
                    is_error: false,
                    agent_stats: None,
                    images: Vec::new(),
                    exit_code: None,
                });
            }
            _ => {}
        }
    }
    kept
}

/// `/^@@ /m.test(text)` — `^` in a multiline JS regex matches at the start of
/// the text and right after each of its four line terminators.
fn has_hunk_header_line(text: &str) -> bool {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
        .any(|line| line.starts_with("@@ "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn turn(role: TurnRole, secs: i64) -> MessageTurn {
        MessageTurn {
            id: format!("turn-{secs}"),
            role,
            blocks: vec![],
            timestamp: Utc.timestamp_opt(secs, 0).unwrap(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
        agent_message_id: None,
        }
    }

    fn sample(roles: &[TurnRole]) -> Vec<MessageTurn> {
        roles
            .iter()
            .enumerate()
            .map(|(i, r)| turn(r.clone(), 1_700_000_000 + i as i64))
            .collect()
    }

    use TurnRole::{Assistant as A, User as U};

    #[test]
    fn tail_window_aligns_back_to_user_turn() {
        let turns = sample(&[U, A, A, U, A, A]);
        // tail 2 → raw start 4 (Assistant) → aligned back to index 3 (User)
        assert_eq!(resolve_window_offset(&turns, TurnWindowReq::Tail(2)), 3);
        // tail covering everything → 0
        assert_eq!(resolve_window_offset(&turns, TurnWindowReq::Tail(500)), 0);
    }

    #[test]
    fn tail_alignment_respects_cap() {
        let mut roles = vec![U];
        roles.extend(std::iter::repeat_n(A, ROUND_ALIGN_CAP + 50));
        let turns = sample(&roles);
        let offset = resolve_window_offset(&turns, TurnWindowReq::Tail(1));
        // Walked ROUND_ALIGN_CAP steps back from the raw start without
        // reaching the user turn: boundary falls mid-round, never index 0.
        assert_eq!(offset, turns.len() - 1 - ROUND_ALIGN_CAP);
        assert!(offset > 0);
    }

    #[test]
    fn from_index_is_exact_and_clamped() {
        let turns = sample(&[U, A, A, U, A]);
        // Index 4 is an Assistant turn — NO round alignment happens.
        assert_eq!(
            resolve_window_offset(&turns, TurnWindowReq::FromIndex(4)),
            4
        );
        assert_eq!(
            resolve_window_offset(&turns, TurnWindowReq::FromIndex(99)),
            5
        );
        assert_eq!(
            resolve_window_offset(&turns, TurnWindowReq::FromIndex(0)),
            0
        );
    }

    #[test]
    fn page_bounds_clamp_and_align() {
        let turns = sample(&[U, A, U, A, A, U, A]);
        // before=5, limit=2 → raw start 3 (Assistant) → aligned to 2 (User)
        assert_eq!(resolve_page_bounds(&turns, 5, 2), (2, 5));
        // before beyond total clamps to total
        assert_eq!(resolve_page_bounds(&turns, 99, 2), (5, 7));
        // before=0 → empty page
        assert_eq!(resolve_page_bounds(&turns, 0, 2), (0, 0));
    }

    #[test]
    fn window_meta_counts_and_bounds() {
        let turns = sample(&[U, A, A, U, A]);
        let meta = window_meta(&turns, 3);
        assert_eq!(meta.offset, 3);
        assert_eq!(meta.total, 5);
        assert_eq!(meta.assistant_before, 2);
        assert_eq!(meta.user_before, 1);
        assert_eq!(
            meta.uncovered_prefix_max_ts,
            Some(turns[2].timestamp)
        );

        let full = window_meta(&turns, 0);
        assert_eq!(full.assistant_before, 0);
        assert_eq!(full.user_before, 0);
        assert_eq!(full.uncovered_prefix_max_ts, None);

        let past_end = window_meta(&turns, 99);
        assert_eq!(past_end.user_before, 2, "clamped to the whole list");
        assert_eq!(full.prefix_hash, format!("{FNV_OFFSET:016x}"));
    }

    #[test]
    fn fingerprint_is_id_free_and_order_sensitive() {
        let turns = sample(&[U, A, A]);
        let mut renamed = turns.clone();
        renamed[0].id = "totally-different-id".to_string();
        assert_eq!(
            prefix_fingerprint(&turns),
            prefix_fingerprint(&renamed),
            "id rewrites must not change the fingerprint"
        );

        let mut shifted = turns.clone();
        shifted.remove(0);
        assert_ne!(
            prefix_fingerprint(&turns),
            prefix_fingerprint(&shifted),
            "removals/shifts must change the fingerprint"
        );
    }

    /// Shared Rust/TS test vector — the TypeScript implementation must
    /// produce these exact strings (see `src/lib/turn-window.test.ts`).
    #[test]
    fn fingerprint_shared_test_vector() {
        assert_eq!(prefix_fingerprint(&[]), "cbf29ce484222325");
        let turns = vec![
            turn(U, 1_700_000_001),
            turn(A, 1_700_000_002),
            turn(TurnRole::System, 1_700_000_003),
        ];
        assert_eq!(prefix_fingerprint(&turns[..1]), "7060d8542023feb2");
        assert_eq!(prefix_fingerprint(&turns), "f171a62320fc10d3");
    }

    /// The vector `src/lib/session-files.test.ts` also reads: there, the
    /// outline is checked to index exactly like the full turns; here, that
    /// the projection produces that outline.
    const NAV_OUTLINE_VECTOR: &str = include_str!("../../tests/fixtures/nav_outline_vector.json");

    fn nav_outline_vector() -> (Vec<MessageTurn>, serde_json::Value) {
        let vector: serde_json::Value =
            serde_json::from_str(NAV_OUTLINE_VECTOR).expect("vector parses");
        let full: Vec<MessageTurn> =
            serde_json::from_value(vector["full"].clone()).expect("full turns deserialize");
        (full, vector["outline"].clone())
    }

    #[test]
    fn nav_outline_matches_the_shared_vector() {
        let (full, expected) = nav_outline_vector();
        let outline = serde_json::to_value(nav_outline_turns(&full)).expect("outline serializes");
        assert_eq!(outline, expected);
    }

    #[test]
    fn nav_outline_keeps_every_turn_and_the_fingerprint() {
        let (full, _) = nav_outline_vector();
        let outline = nav_outline_turns(&full);
        assert_eq!(outline.len(), full.len());
        for (kept, original) in outline.iter().zip(&full) {
            assert_eq!(kept.id, original.id);
            assert_eq!(kept.timestamp, original.timestamp);
        }
        for end in 0..=full.len() {
            assert_eq!(
                prefix_fingerprint(&outline[..end]),
                prefix_fingerprint(&full[..end]),
                "an outline prefix must fingerprint like the transcript it came from"
            );
        }
    }

    #[test]
    fn hunk_header_lines_follow_js_multiline_anchors() {
        assert!(has_hunk_header_line("@@ -1 +1 @@"));
        assert!(has_hunk_header_line("updated\n@@ -1 +1 @@"));
        assert!(has_hunk_header_line("updated\r\n@@ -1 +1 @@"));
        assert!(has_hunk_header_line("updated\r@@ -1 +1 @@"));
        assert!(has_hunk_header_line("updated\u{2028}@@ -1 +1 @@"));
        assert!(has_hunk_header_line("updated\u{2029}@@ -1 +1 @@"));
        assert!(!has_hunk_header_line(" @@ -1 +1 @@"));
        assert!(!has_hunk_header_line("@@-1 +1 @@"));
        assert!(!has_hunk_header_line("updated @@ -1 +1 @@"));
        assert!(!has_hunk_header_line(""));
    }
}
