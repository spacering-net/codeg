use std::collections::VecDeque;
use std::sync::Arc;

use tokio::sync::broadcast;

use crate::acp::types::{AcpEvent, EventEnvelope, ToolCallImageInfo, UserMessageBlock};

/// Capacity of the per-connection broadcast channel. Sized to absorb a brief
/// burst when a slow subscriber lags; broadcast::channel drops oldest events
/// past capacity (RecvError::Lagged), which the subscriber surfaces as a
/// `replay_lagged` cue and the client converts to a re-attach.
const BROADCAST_CAPACITY: usize = 4096;

/// Maximum byte total retained in the recent-events ring buffer. Sized so
/// even an active streaming session with several tool-call updates fits
/// comfortably; oversized images push past this bound and force a snapshot
/// fallback on the next attach (see `RecentEventsBuffer::push`).
pub const RECENT_BUFFER_MAX_BYTES: usize = 128 * 1024;

/// Hard cap on event count regardless of byte total. Defends against a
/// pathological flood of tiny events filling the buffer past the byte limit
/// (each event has a small overhead — connection_id, seq — that doesn't
/// contribute meaningfully to byte_total but does to memory).
pub const RECENT_BUFFER_MAX_COUNT: usize = 128;

/// Single-event size threshold above which we refuse to store the event.
/// Stored events would be replayed on reconnect; an oversized event blows
/// past WS frame budgets. The next attach for such a connection will fall
/// through to a snapshot, which is the right thing for large state.
const RECENT_EVENT_MAX_BYTES: usize = 64 * 1024;

/// Per-connection event broadcaster + recent-events ring buffer.
///
/// Lives on `SessionState` (one per active ACP connection). All event
/// emission for a connection goes through `emit_with_state`, which holds
/// the SessionState write lock while:
///   1. applying the event
///   2. incrementing event_seq
///   3. pushing the resulting envelope into `recent_events`
///
/// then releases the lock and broadcasts via `sender`.
///
/// New WS subscribers (`attach`) hold the SessionState **read** lock while:
///   1. snapshotting the state and event_seq
///   2. (optionally) reading recent_events for replay
///   3. calling `subscribe()` on this stream
///
/// then release the lock.
///
/// Holding the read lock across subscribe() guarantees no event broadcast
/// races between the snapshot read and receiver registration: the only
/// path that produces broadcasts is `emit_with_state`, which needs the
/// write lock and therefore waits.
#[derive(Debug)]
pub struct ConnectionEventStream {
    sender: broadcast::Sender<Arc<EventEnvelope>>,
}

impl Default for ConnectionEventStream {
    fn default() -> Self {
        Self::new()
    }
}

impl ConnectionEventStream {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(BROADCAST_CAPACITY);
        Self { sender }
    }

    /// Register a new subscriber. Must be called while holding at least a
    /// read lock on the owning `SessionState`, otherwise events emitted
    /// after the snapshot read but before subscribe can be missed.
    pub fn subscribe(&self) -> broadcast::Receiver<Arc<EventEnvelope>> {
        self.sender.subscribe()
    }

    /// Broadcast an envelope. Failure (no subscribers) is ignored — the
    /// event is already recorded in `SessionState.recent_events` for the
    /// next attach to pick up via replay.
    pub fn send(&self, envelope: Arc<EventEnvelope>) {
        let _ = self.sender.send(envelope);
    }
}

/// Bounded ring buffer of recent events, used to replay short reconnect
/// gaps without forcing a full snapshot. Two limits are enforced together:
/// `MAX_BYTES` (network/memory) and `MAX_COUNT` (defense-in-depth against
/// many tiny events).
#[derive(Debug)]
pub struct RecentEventsBuffer {
    events: VecDeque<RecentEntry>,
    byte_total: usize,
}

#[derive(Debug)]
struct RecentEntry {
    seq: u64,
    size: usize,
    envelope: Arc<EventEnvelope>,
}

impl Default for RecentEventsBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl RecentEventsBuffer {
    pub fn new() -> Self {
        Self {
            events: VecDeque::with_capacity(32),
            byte_total: 0,
        }
    }

    /// Push an envelope. If estimated size exceeds the per-event limit, the
    /// envelope is silently skipped — an attach with a cursor pointing at
    /// or before this seq will detect the gap and fall back to a snapshot.
    ///
    /// Returns the number of events evicted by this push (FIFO eviction
    /// triggered by either count cap or byte cap, plus the wholesale clear
    /// for oversized events). Callers wire this into `EventBusMetrics::
    /// ring_buffer_evict_count` so operators can detect ring-buffer pressure.
    #[must_use = "evicted count feeds the ring_buffer_evict_count metric"]
    pub fn push(&mut self, envelope: Arc<EventEnvelope>) -> usize {
        let size = estimate_envelope_size(&envelope);
        if size > RECENT_EVENT_MAX_BYTES {
            // Mark the gap implicitly: the next event will appear non-contiguous
            // relative to its predecessor, and `range_after` returns None.
            // Drop the entire buffer so a subsequent attach with an old cursor
            // takes the snapshot path rather than returning a misleading
            // partial replay.
            let evicted = self.events.len();
            self.events.clear();
            self.byte_total = 0;
            return evicted;
        }
        let seq = envelope.seq;
        self.events.push_back(RecentEntry {
            seq,
            size,
            envelope,
        });
        self.byte_total = self.byte_total.saturating_add(size);
        let mut evicted = 0;
        while self.events.len() > RECENT_BUFFER_MAX_COUNT
            || self.byte_total > RECENT_BUFFER_MAX_BYTES
        {
            match self.events.pop_front() {
                Some(old) => {
                    self.byte_total = self.byte_total.saturating_sub(old.size);
                    evicted += 1;
                }
                None => break,
            }
        }
        evicted
    }

    /// Returns events with seq strictly greater than `since_seq`, in order.
    /// `None` indicates the cursor is older than the oldest buffered seq —
    /// caller must fall back to a snapshot rather than send partial replay.
    pub fn range_after(&self, since_seq: u64) -> Option<Vec<Arc<EventEnvelope>>> {
        let oldest = self.events.front()?.seq;
        // since_seq + 1 is the first seq we'd want; if our oldest is past
        // that, there's a gap we can't fill.
        if oldest > since_seq.saturating_add(1) {
            return None;
        }
        Some(
            self.events
                .iter()
                .filter(|e| e.seq > since_seq)
                .map(|e| e.envelope.clone())
                .collect(),
        )
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.events.len()
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    #[cfg(test)]
    pub fn byte_total(&self) -> usize {
        self.byte_total
    }
}

/// Serialized-JSON length of a string: its UTF-8 byte length plus the extra
/// bytes JSON escaping adds (the two surrounding quotes, `\"`, `\\`, and
/// control-char escapes), computed WITHOUT allocating. Escape-awareness matters
/// because this feeds the per-event size cap: an escape-heavy payload (tool
/// output full of quotes/newlines, say) serializes much larger than its raw byte
/// length and must still be recognized as oversized.
///
/// Shared with `SessionState::snapshot_tool_calls`, which spends a byte budget
/// over the same payloads and has to size them the same way.
pub(super) fn json_str_len(s: &str) -> usize {
    let mut extra = 0usize;
    for b in s.bytes() {
        match b {
            // `"`, `\`, and the short control escapes (\b \t \n \f \r) each
            // serialize to two bytes → one extra byte over the raw byte.
            b'"' | b'\\' | 0x08 | 0x09 | 0x0A | 0x0C | 0x0D => extra += 1,
            // Any other control char serializes as `\u00XX` (six bytes) → +5.
            c if c < 0x20 => extra += 5,
            _ => {}
        }
    }
    // + 2 for the surrounding quotes.
    2 + s.len() + extra
}

/// Decimal digit count of `n` (0 → 1), without allocating.
fn decimal_len(n: u64) -> usize {
    if n == 0 {
        1
    } else {
        (n.ilog10() as usize) + 1
    }
}

/// Serialized length of a JSON number, without allocating. Integers are sized by
/// exact digit count (plus a sign byte); non-integers (f64) fall back to a
/// conservative upper bound — serde_json prints an f64 to at most ~24 bytes — so
/// a number-dense payload is never undercounted.
fn number_size(n: &serde_json::Number) -> usize {
    if let Some(u) = n.as_u64() {
        decimal_len(u)
    } else if let Some(i) = n.as_i64() {
        1 + decimal_len(i.unsigned_abs())
    } else {
        24
    }
}

/// Cheap byte estimate for a JSON value's footprint — sums (escape-aware) string
/// and key lengths, numbers, and the structural punctuation JSON serialization
/// adds: brackets/braces, the `:` after each key, and the `,` BETWEEN elements.
/// Computed without serializing and never undercounting, so it stays a safe
/// proxy for the per-event size cap even for dense arrays/objects.
pub(super) fn json_value_size(value: &serde_json::Value) -> usize {
    match value {
        serde_json::Value::Null => 4,
        serde_json::Value::Bool(b) => {
            if *b {
                4
            } else {
                5
            }
        }
        serde_json::Value::Number(n) => number_size(n),
        serde_json::Value::String(s) => json_str_len(s),
        serde_json::Value::Array(items) => {
            // `[` + elements + `,` between them + `]`.
            2 + items.len().saturating_sub(1)
                + items.iter().map(json_value_size).sum::<usize>()
        }
        serde_json::Value::Object(map) => {
            // `{` + `"key":value` pairs + `,` between them + `}`.
            2 + map.len().saturating_sub(1)
                + map
                    .iter()
                    .map(|(k, v)| json_str_len(k) + 1 + json_value_size(v))
                    .sum::<usize>()
        }
    }
}

pub(super) fn opt_str_size(s: &Option<String>) -> usize {
    s.as_ref().map_or(0, |v| json_str_len(v))
}

pub(super) fn opt_json_size(v: &Option<serde_json::Value>) -> usize {
    v.as_ref().map_or(0, json_value_size)
}

/// Sum the payload of any attached images: the `[` `]` brackets, each image's
/// `{"data":"..","mime_type":".."[,"uri":".."]}` object structure, and its
/// fields. `data` (the base64 image, the dominant term) is sized escape-aware
/// like every other string — for valid base64 that is just its byte length plus
/// the two quotes, but `data` is a plain `String`, so sizing it defensively
/// rather than by raw `len()` keeps the `estimate >= serialized` invariant true
/// even if a producer put JSON-escapable bytes in the field (else an oversized
/// image could slip under the per-event cap). This does scan `data`, but with no
/// allocation — far cheaper than the full-envelope `serde_json::to_vec` this
/// replaced — and image events are infrequent (not on the per-token path).
fn images_size(images: &Option<Vec<ToolCallImageInfo>>) -> usize {
    images
        .as_ref()
        .map_or(0, |imgs| images_slice_size(imgs.as_slice()))
}

/// [`images_size`] over a plain slice. Split out so
/// `SessionState::snapshot_tool_calls`, whose `ToolCallState.images` is a bare
/// `Vec`, sizes an image list exactly the way the per-event cap does.
pub(super) fn images_slice_size(images: &[ToolCallImageInfo]) -> usize {
    // `PER_IMAGE_STRUCT` conservatively bounds each object's keys/braces and
    // the trailing comma; `+ 2` is the array brackets.
    const PER_IMAGE_STRUCT: usize = 48;
    2 + images
        .iter()
        .map(|img| {
            PER_IMAGE_STRUCT
                + json_str_len(&img.data)
                + json_str_len(&img.mime_type)
                + opt_str_size(&img.uri)
        })
        .sum::<usize>()
}

/// Byte size of a single user-message block, including its `{"type":..,..}`
/// object structure (keys/braces) as a small conservative constant on top of the
/// escape-aware value bytes (image `data` sized like `images_size`).
fn user_block_size(block: &UserMessageBlock) -> usize {
    match block {
        // `{"type":"text","text":<v>}`
        UserMessageBlock::Text { text } => 24 + json_str_len(text),
        // `{"type":"image","data":"<d>","mime_type":<v>}`
        UserMessageBlock::Image { data, mime_type } => {
            48 + json_str_len(data) + json_str_len(mime_type)
        }
    }
}

/// Best-effort byte estimate for an event envelope's footprint in the recent-
/// events ring buffer. Feeds BOTH the running byte cap and the per-event
/// `RECENT_EVENT_MAX_BYTES` threshold, so it must track the serialized size
/// closely enough that oversized events (large tool output, base64 images) still
/// trip the per-event cap and force a snapshot fallback — hence the escape-aware
/// string sizing (see `json_str_len`).
///
/// `emit_with_state` calls this on every event while holding the `SessionState`
/// write lock. The hot, high-frequency, and potentially-large variants —
/// streaming text/thinking deltas, tool calls and updates and user messages
/// (which can carry multi-MB base64 images), and forwarded Claude SDK messages —
/// are therefore estimated STRUCTURALLY from their string/JSON fields, with no
/// serialization: serializing a per-token delta or a multi-MB image on that
/// locked hot path only to measure and discard the bytes was the cost this
/// replaced. Every other variant is small and infrequent, so it falls back to an
/// exact serialized length — cheap here, faithful to the prior sizing, and
/// needing no upkeep as variants are added.
fn estimate_envelope_size(envelope: &EventEnvelope) -> usize {
    // Conservative fixed overhead: the envelope skeleton (`{"seq":N,...}`), the
    // `type` tag, and every structural variant's field KEYS/colons plus the
    // `null`s that its non-skipped `Option::None` fields serialize to. It must
    // exceed the largest structural variant's fixed serialized overhead
    // (ToolCall / ToolCallUpdate: ~190 B with a 20-digit seq and several `null`
    // fields) so `base + payload` NEVER undercounts the serialized envelope — the
    // invariant the per-event cap relies on to reject oversized events, asserted
    // for every structural branch by `estimate_never_undercounts_serialized_*`.
    // Over-counting small events is harmless: streaming deltas hit the count cap
    // long before this matters, and it is negligible against a large payload.
    const ENVELOPE_OVERHEAD: usize = 256;
    // `connection_id` is sized escape-aware like every other string so the
    // `estimate >= serialized` invariant holds for ANY id, not just the
    // UUID-shaped ones production emits. (`ENVELOPE_OVERHEAD` covers its key.)
    let base = ENVELOPE_OVERHEAD + json_str_len(&envelope.connection_id);
    let payload = match &envelope.payload {
        AcpEvent::ContentDelta {
            text,
            parent_tool_use_id,
        }
        | AcpEvent::Thinking {
            text,
            parent_tool_use_id,
        } => json_str_len(text) + opt_str_size(parent_tool_use_id),
        AcpEvent::ClaudeSdkMessage {
            session_id,
            message,
        } => json_str_len(session_id) + json_value_size(message),
        AcpEvent::ToolCall {
            tool_call_id,
            title,
            kind,
            status,
            content,
            raw_input,
            raw_output,
            locations,
            meta,
            images,
        } => {
            json_str_len(tool_call_id)
                + json_str_len(title)
                + json_str_len(kind)
                + json_str_len(status)
                + opt_str_size(content)
                + opt_str_size(raw_input)
                + opt_str_size(raw_output)
                + opt_json_size(locations)
                + opt_json_size(meta)
                + images_size(images)
        }
        AcpEvent::ToolCallUpdate {
            tool_call_id,
            title,
            status,
            content,
            raw_input,
            raw_output,
            locations,
            meta,
            images,
            // Spelled out (not `..`) so a newly-added large field forces this
            // estimator to be revisited rather than silently under-counted.
            raw_output_append: _,
        } => {
            json_str_len(tool_call_id)
                + opt_str_size(title)
                + opt_str_size(status)
                + opt_str_size(content)
                + opt_str_size(raw_input)
                + opt_str_size(raw_output)
                + opt_json_size(locations)
                + opt_json_size(meta)
                + images_size(images)
        }
        // Can carry a base64 `UserMessageBlock::Image` from a pasted prompt
        // image, so it is sized structurally too — otherwise a multi-MB user
        // image would be fully serialized under the write lock via the fallback.
        AcpEvent::UserMessage { message_id, blocks } => {
            // `"blocks":[` + block objects + `,` between them + `]` (the
            // `message_id`/`blocks` keys themselves are covered by the base).
            json_str_len(message_id)
                + 2
                + blocks.len().saturating_sub(1)
                + blocks.iter().map(user_block_size).sum::<usize>()
        }
        // Carries whole parsed transcript turns (tool outputs, rebuilt diffs —
        // potentially large), so it is sized structurally like the other large
        // variants: letting it hit the serialize-fallback would re-introduce
        // exactly the locked-hot-path serialization this estimator replaced.
        AcpEvent::BackgroundActivity {
            session_id,
            turns,
            outstanding: _,
            settled,
            watermark: _,
        } => {
            json_str_len(session_id)
                + turns.len().saturating_sub(1)
                + turns.iter().map(message_turn_size).sum::<usize>()
                + settled
                    .iter()
                    .map(|s| {
                        // Keys + braces + commas for every field (task_id,
                        // status, summary, tool_use_id, result) plus the
                        // element comma — generously fixed so `estimate >=
                        // serialized` holds for every present/absent optional
                        // combination.
                        128 + json_str_len(&s.task_id)
                            + json_str_len(&s.status)
                            + opt_str_size(&s.summary)
                            + opt_str_size(&s.tool_use_id)
                            + opt_str_size(&s.result)
                    })
                    .sum::<usize>()
        }
        // Small, infrequent variants: an exact serialized length is cheap here
        // and preserves the prior threshold behavior; the 256 fallback only
        // guards the (practically impossible) serialization failure.
        other => serde_json::to_vec(other).map_or(256, |v| v.len()),
    };
    base + payload
}

/// Structural size for one parsed-transcript turn carried on
/// [`AcpEvent::BackgroundActivity`]. Mirrors `user_block_size`'s approach:
/// escape-aware strings plus deliberately generous fixed overheads per
/// object, so `estimate >= serialized` holds for every field combination
/// (asserted by `estimate_never_undercounts_serialized_for_background_activity`).
fn message_turn_size(turn: &crate::models::message::MessageTurn) -> usize {
    // Keys + role tag + two RFC3339 timestamps (~46 B each with keys) + the
    // full `usage` object (4 u64 fields, ≤ ~130 B) + `duration_ms`.
    384 + json_str_len(&turn.id)
        + opt_str_size(&turn.model)
        + turn.blocks.len().saturating_sub(1)
        + turn.blocks.iter().map(content_block_size).sum::<usize>()
}

/// Structural size for one `ContentBlock` inside a transcript turn.
fn content_block_size(block: &crate::models::message::ContentBlock) -> usize {
    use crate::models::message::ContentBlock as CB;
    match block {
        // `{"type":"text","text":…}` / `{"type":"thinking","text":…}`
        CB::Text { text } | CB::Thinking { text } => 32 + json_str_len(text),
        CB::Image {
            data,
            mime_type,
            uri,
        } => 64 + json_str_len(data) + json_str_len(mime_type) + opt_str_size(uri),
        CB::ImageGeneration {
            revised_prompt,
            image,
        } => {
            64 + opt_str_size(revised_prompt)
                + image.as_ref().map_or(0, |img| {
                    64 + json_str_len(&img.data)
                        + json_str_len(&img.mime_type)
                        + opt_str_size(&img.uri)
                })
        }
        CB::ToolUse {
            tool_use_id,
            tool_name,
            input_preview,
            status,
            meta,
        } => {
            96 + opt_str_size(tool_use_id)
                + json_str_len(tool_name)
                + opt_str_size(input_preview)
                + opt_str_size(status)
                + opt_json_size(meta)
        }
        CB::ToolResult {
            tool_use_id,
            output_preview,
            is_error: _,
            agent_stats,
            images,
        } => {
            128 + opt_str_size(tool_use_id)
                + opt_str_size(output_preview)
                + agent_stats.as_ref().map_or(0, agent_stats_size)
                + images
                    .iter()
                    .map(|img| {
                        64 + json_str_len(&img.data)
                            + json_str_len(&img.mime_type)
                            + opt_str_size(&img.uri)
                    })
                    .sum::<usize>()
        }
    }
}

/// Structural size for a `ToolResult`'s `agent_stats` object: a dozen optional
/// numeric scalars (each ≤ ~40 B serialized with its key) plus the nested
/// `tool_calls` array — 640 generously covers skeleton + every scalar.
fn agent_stats_size(stats: &crate::models::message::AgentExecutionStats) -> usize {
    640 + opt_str_size(&stats.agent_type)
        + opt_str_size(&stats.status)
        + stats
            .tool_calls
            .iter()
            .map(|c| {
                96 + json_str_len(&c.tool_name)
                    + opt_str_size(&c.input_preview)
                    + opt_str_size(&c.output_preview)
            })
            .sum::<usize>()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_envelope(seq: u64, text: &str) -> Arc<EventEnvelope> {
        Arc::new(EventEnvelope {
            seq,
            connection_id: "c".into(),
            payload: AcpEvent::ContentDelta { text: text.into(), parent_tool_use_id: None },
        })
    }

    fn tool_update_with_image(seq: u64, base64: String) -> Arc<EventEnvelope> {
        Arc::new(EventEnvelope {
            seq,
            connection_id: "c".into(),
            payload: AcpEvent::ToolCallUpdate {
                tool_call_id: "t1".into(),
                title: None,
                status: None,
                content: None,
                raw_input: None,
                raw_output: None,
                raw_output_append: None,
                locations: None,
                meta: None,
                images: Some(vec![ToolCallImageInfo {
                    data: base64,
                    mime_type: "image/png".into(),
                    uri: None,
                }]),
            },
        })
    }

    fn user_message_with_image(seq: u64, base64: String) -> Arc<EventEnvelope> {
        Arc::new(EventEnvelope {
            seq,
            connection_id: "c".into(),
            payload: AcpEvent::UserMessage {
                message_id: "u1".into(),
                blocks: vec![UserMessageBlock::Image {
                    data: base64,
                    mime_type: "image/png".into(),
                }],
            },
        })
    }

    #[test]
    fn push_and_range_after_returns_strictly_greater_seq() {
        let mut buf = RecentEventsBuffer::new();
        assert_eq!(buf.push(make_envelope(1, "a")), 0);
        assert_eq!(buf.push(make_envelope(2, "b")), 0);
        assert_eq!(buf.push(make_envelope(3, "c")), 0);

        let after_1 = buf.range_after(1).expect("cursor in range");
        assert_eq!(after_1.len(), 2);
        assert_eq!(after_1[0].seq, 2);
        assert_eq!(after_1[1].seq, 3);

        let after_3 = buf.range_after(3).expect("cursor at head");
        assert!(after_3.is_empty(), "no events past head");
    }

    #[test]
    fn range_after_returns_none_when_cursor_older_than_oldest() {
        let mut buf = RecentEventsBuffer::new();
        // Force eviction so seq=1 is gone.
        for s in 1..=(RECENT_BUFFER_MAX_COUNT as u64 + 5) {
            let _ = buf.push(make_envelope(s, "x"));
        }
        // Ask for events past a seq the buffer no longer holds.
        assert!(buf.range_after(1).is_none());
        // But a recent seq should still work.
        assert!(buf
            .range_after(buf.events.back().unwrap().seq - 1)
            .is_some());
    }

    #[test]
    fn count_cap_evicts_oldest_and_reports_eviction_count() {
        let mut buf = RecentEventsBuffer::new();
        let mut total_evicted = 0usize;
        for s in 1..=(RECENT_BUFFER_MAX_COUNT as u64 + 10) {
            total_evicted += buf.push(make_envelope(s, "x"));
        }
        assert_eq!(buf.len(), RECENT_BUFFER_MAX_COUNT);
        assert_eq!(
            total_evicted, 10,
            "10 events should have been evicted to keep buffer at cap"
        );
        // Oldest should be (total pushed - cap + 1).
        let pushed = RECENT_BUFFER_MAX_COUNT + 10;
        let expected_oldest_seq = (pushed - RECENT_BUFFER_MAX_COUNT) as u64 + 1;
        assert_eq!(buf.events.front().unwrap().seq, expected_oldest_seq);
    }

    #[test]
    fn byte_cap_evicts_to_stay_under_limit() {
        let mut buf = RecentEventsBuffer::new();
        // Each event ~1KB of text. Push enough to exceed MAX_BYTES.
        let chunk = "x".repeat(1024);
        let n = (RECENT_BUFFER_MAX_BYTES / 1024) as u64 + 10;
        for s in 1..=n {
            let _ = buf.push(make_envelope(s, &chunk));
        }
        assert!(
            buf.byte_total() <= RECENT_BUFFER_MAX_BYTES,
            "byte_total {} exceeded limit {}",
            buf.byte_total(),
            RECENT_BUFFER_MAX_BYTES
        );
    }

    #[test]
    fn oversized_event_drops_entire_buffer_and_reports_eviction() {
        let mut buf = RecentEventsBuffer::new();
        assert_eq!(buf.push(make_envelope(1, "a")), 0);
        assert_eq!(buf.push(make_envelope(2, "b")), 0);
        // Push an event larger than the per-event limit.
        let huge = "z".repeat(RECENT_EVENT_MAX_BYTES + 1);
        let evicted = buf.push(make_envelope(3, &huge));
        assert_eq!(
            evicted, 2,
            "wholesale clear must report the count of cleared entries"
        );
        // The previous events are gone; the next attach must take the
        // snapshot path because `range_after(0)` returns None.
        assert!(buf.range_after(0).is_none());
        assert!(buf.range_after(2).is_none());
    }

    #[test]
    fn estimate_counts_tool_call_image_base64_bytes() {
        // The structural estimate must still include the base64 image payload
        // (no serialization), so an image-bearing tool update sizes the same
        // ballpark as the old serialize-based estimate and trips the per-event
        // cap → snapshot fallback, rather than being under-counted and replayed.
        let big = "A".repeat(100_000);
        let size = estimate_envelope_size(&tool_update_with_image(1, big.clone()));
        assert!(
            size >= big.len(),
            "estimate {size} must include the {}-byte image payload",
            big.len()
        );
        assert!(size > RECENT_EVENT_MAX_BYTES);
    }

    #[test]
    fn image_bearing_tool_update_trips_per_event_cap() {
        let mut buf = RecentEventsBuffer::new();
        assert_eq!(buf.push(make_envelope(1, "a")), 0);
        // A large base64 image (counted structurally) exceeds the per-event cap
        // and clears the buffer, exactly like an oversized text event.
        let huge_image = "A".repeat(RECENT_EVENT_MAX_BYTES + 1);
        let evicted = buf.push(tool_update_with_image(2, huge_image));
        assert_eq!(evicted, 1, "oversized image event clears the buffer");
        assert!(buf.range_after(0).is_none());
    }

    #[test]
    fn small_content_delta_estimate_is_cheap_and_stored() {
        let mut buf = RecentEventsBuffer::new();
        assert_eq!(buf.push(make_envelope(1, "hello")), 0);
        assert_eq!(buf.len(), 1);
        // A per-token delta estimates as its text length plus bounded overhead —
        // far under the per-event cap, so it is retained for replay.
        let size = estimate_envelope_size(&make_envelope(2, "hello"));
        assert!(size >= "hello".len());
        // Bounded fixed overhead — far under the per-event cap.
        assert!(size < RECENT_EVENT_MAX_BYTES);
    }

    #[test]
    fn estimate_counts_user_message_image_base64_bytes() {
        // A pasted prompt image rides in UserMessage; it must be sized
        // structurally (not via the serialize fallback) so its base64 is not
        // serialized under the write lock, yet is still counted toward the cap.
        let big = "A".repeat(100_000);
        let size = estimate_envelope_size(&user_message_with_image(1, big.clone()));
        assert!(
            size >= big.len(),
            "estimate {size} must include the {}-byte image payload",
            big.len()
        );
        assert!(size > RECENT_EVENT_MAX_BYTES);
    }

    #[test]
    fn image_bearing_user_message_trips_per_event_cap() {
        let mut buf = RecentEventsBuffer::new();
        assert_eq!(buf.push(make_envelope(1, "a")), 0);
        let huge_image = "A".repeat(RECENT_EVENT_MAX_BYTES + 1);
        let evicted = buf.push(user_message_with_image(2, huge_image));
        assert_eq!(evicted, 1, "oversized user-image event clears the buffer");
        assert!(buf.range_after(0).is_none());
    }

    #[test]
    fn escape_heavy_text_estimate_tracks_serialized_size() {
        // 40 KiB of quotes: the RAW length is under the per-event cap, but each
        // `"` serializes to `\"`, so the JSON is ~80 KiB and the old exact sizing
        // rejected it. A raw-`len()` estimate would wrongly retain it; the
        // escape-aware estimate must likewise exceed the cap and never undercount
        // the true serialized length.
        let text = "\"".repeat(40 * 1024);
        let env = make_envelope(1, &text);
        let est = estimate_envelope_size(&env);
        let serialized = serde_json::to_vec(&*env).expect("serialize").len();
        assert!(
            text.len() < RECENT_EVENT_MAX_BYTES,
            "raw text must be under the cap for this test to be meaningful"
        );
        assert!(serialized > RECENT_EVENT_MAX_BYTES);
        assert!(
            est > RECENT_EVENT_MAX_BYTES,
            "escape-aware estimate {est} must trip the cap like serialized {serialized}"
        );
        // Never undercount the serialized envelope (the per-event cap invariant).
        assert!(est >= serialized, "estimate {est} < serialized {serialized}");
    }

    #[test]
    fn json_value_size_accounts_for_structural_commas_over_the_cap() {
        // 30k empty strings inside a ClaudeSdkMessage: the element bytes alone
        // (~60 KiB) are UNDER the per-event cap, but the 29,999 commas push the
        // serialized JSON (~90 KiB) over it. A walker that ignores commas would
        // undercount and wrongly retain an oversized replay event.
        let arr: Vec<serde_json::Value> = (0..30_000)
            .map(|_| serde_json::Value::String(String::new()))
            .collect();
        let env = Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::ClaudeSdkMessage {
                session_id: "s".into(),
                message: serde_json::Value::Array(arr),
            },
        });
        let est = estimate_envelope_size(&env);
        let serialized = serde_json::to_vec(&*env).expect("serialize").len();
        assert!(serialized > RECENT_EVENT_MAX_BYTES);
        assert!(
            est > RECENT_EVENT_MAX_BYTES,
            "comma-aware estimate {est} must trip the cap like serialized {serialized}"
        );
        assert!(est >= serialized, "estimate {est} < serialized {serialized}");
    }

    #[test]
    fn json_value_size_never_undercounts_numbers_and_structure() {
        // Mixed structure with integers, a nested array, a negative number, and
        // a bool: the estimate must be >= the true serialized length (it may
        // over-count slightly, never under).
        let v = serde_json::json!({
            "a": 12345,
            "b": [1, 2, 3],
            "c": -9_999_999_999i64,
            "d": true,
        });
        let est = json_value_size(&v);
        let serialized = serde_json::to_vec(&v).expect("serialize").len();
        assert!(
            est >= serialized,
            "estimate {est} must be >= serialized {serialized}"
        );
    }

    fn assert_ge_serialized(env: &Arc<EventEnvelope>) {
        let est = estimate_envelope_size(env);
        let serialized = serde_json::to_vec(&**env).expect("serialize").len();
        assert!(
            est >= serialized,
            "estimate {est} < serialized {serialized} for {:?}",
            env.payload
        );
    }

    #[test]
    fn estimate_never_undercounts_serialized_for_structural_variants() {
        // The per-event cap rejects events whose SERIALIZED size exceeds it, so
        // the structural estimate must never fall below the serialized length for
        // any structural branch — else an oversized event would be wrongly
        // retained and replayed. Covers plain/escape-heavy text, thinking, nested
        // Claude SDK JSON, a fully-populated ToolCall, an all-`null`-but-near-cap
        // ToolCallUpdate, and user messages with many blocks / an image.
        let cases: Vec<Arc<EventEnvelope>> = vec![
            make_envelope(1, "plain"),
            make_envelope(2, &"\"\\\n\t".repeat(500)),
            Arc::new(EventEnvelope {
                seq: 3,
                connection_id: "conn-xyz".into(),
                payload: AcpEvent::Thinking {
                    text: "reason\"ing\n".into(),
                    parent_tool_use_id: None,
                },
            }),
            // Parented (subagent-attributed) chunks: the optional id is a
            // sized string field, including an escape-heavy id.
            Arc::new(EventEnvelope {
                seq: 31,
                connection_id: "conn-xyz".into(),
                payload: AcpEvent::ContentDelta {
                    text: "sub text".into(),
                    parent_tool_use_id: Some("toolu_01ABC".into()),
                },
            }),
            Arc::new(EventEnvelope {
                seq: 32,
                connection_id: "conn-xyz".into(),
                payload: AcpEvent::Thinking {
                    text: "sub think".into(),
                    parent_tool_use_id: Some("id\"with\\escapes\n".into()),
                },
            }),
            Arc::new(EventEnvelope {
                seq: 4,
                connection_id: "c".into(),
                payload: AcpEvent::ClaudeSdkMessage {
                    session_id: "s".into(),
                    message: serde_json::json!({
                        "a": [1, 2, 3],
                        "b": "x\"y",
                        "c": true,
                        "d": null,
                        "e": 1.5,
                        "f": {"g": -7},
                    }),
                },
            }),
            Arc::new(EventEnvelope {
                seq: 5,
                connection_id: "cc".into(),
                payload: AcpEvent::ToolCall {
                    tool_call_id: "call_1".into(),
                    title: "Ti\"tle".into(),
                    kind: "edit".into(),
                    status: "in_progress".into(),
                    content: Some("co\nnt".into()),
                    raw_input: Some("{\"x\":1}".into()),
                    raw_output: Some("out\tput".into()),
                    locations: Some(serde_json::json!([{"path": "a.rs", "line": 3}])),
                    meta: Some(serde_json::json!({"k": "v"})),
                    images: Some(vec![ToolCallImageInfo {
                        data: "AAAA".into(),
                        mime_type: "image/png".into(),
                        uri: Some("u".into()),
                    }]),
                },
            }),
            Arc::new(EventEnvelope {
                seq: 6,
                connection_id: "c".into(),
                payload: AcpEvent::ToolCallUpdate {
                    tool_call_id: "t".into(),
                    title: None,
                    status: None,
                    content: None,
                    raw_input: None,
                    raw_output: Some("z".repeat(65_450)),
                    raw_output_append: None,
                    locations: None,
                    meta: None,
                    images: None,
                },
            }),
            Arc::new(EventEnvelope {
                seq: 7,
                connection_id: "c".into(),
                payload: AcpEvent::UserMessage {
                    message_id: "u".into(),
                    blocks: (0..2000)
                        .map(|_| UserMessageBlock::Text {
                            text: String::new(),
                        })
                        .collect(),
                },
            }),
            user_message_with_image(8, "A".repeat(1000)),
            tool_update_with_image(9, "A".repeat(1000)),
        ];
        for env in &cases {
            assert_ge_serialized(env);
        }
    }

    #[test]
    fn estimate_never_undercounts_serialized_for_background_activity() {
        // BackgroundActivity carries whole parsed transcript turns, so it is
        // sized structurally. Build the densest shape — every optional field
        // present, every block variant, escape-heavy strings, agent stats with
        // nested tool calls, result images, plus settled entries — and assert
        // the structural estimate still covers the exact serialized length.
        use crate::models::message::{
            AgentExecutionStats, AgentToolCall, ContentBlock, ImageData, MessageTurn, TurnRole,
            TurnUsage,
        };

        let image = ImageData {
            data: "QUJD".repeat(64),
            mime_type: "image/png".into(),
            uri: Some("file:///tmp/图 \"quoted\".png".into()),
        };
        let turn = MessageTurn {
            id: "bg-123456-0".into(),
            role: TurnRole::Assistant,
            blocks: vec![
                ContentBlock::Text {
                    text: "\"\\\n\t".repeat(300),
                },
                ContentBlock::Thinking {
                    text: "思考\n".repeat(100),
                },
                ContentBlock::Image {
                    data: "AAAA".repeat(32),
                    mime_type: "image/jpeg".into(),
                    uri: None,
                },
                ContentBlock::ImageGeneration {
                    revised_prompt: Some("prompt \"revised\"".into()),
                    image: Some(image.clone()),
                },
                ContentBlock::ToolUse {
                    tool_use_id: Some("toolu_01ABC".into()),
                    tool_name: "Bash".into(),
                    input_preview: Some("{\"command\":\"pnpm build\"}".into()),
                    status: None,
                    meta: Some(serde_json::json!({"codeg.delegation": {"status": "running"}})),
                },
                ContentBlock::ToolResult {
                    tool_use_id: Some("toolu_01ABC".into()),
                    output_preview: Some("output\nwith\tescapes\"".repeat(50)),
                    is_error: true,
                    agent_stats: Some(AgentExecutionStats {
                        agent_type: Some("Explore".into()),
                        status: Some("completed".into()),
                        total_duration_ms: Some(u64::MAX),
                        total_tokens: Some(u64::MAX),
                        total_tool_use_count: Some(u32::MAX),
                        read_count: Some(u32::MAX),
                        search_count: Some(u32::MAX),
                        bash_count: Some(u32::MAX),
                        edit_file_count: Some(u32::MAX),
                        lines_added: Some(u32::MAX),
                        lines_removed: Some(u32::MAX),
                        other_tool_count: Some(u32::MAX),
                        tool_calls: vec![AgentToolCall {
                            tool_name: "Read".into(),
                            input_preview: Some("{\"file_path\":\"/a/b\"}".into()),
                            output_preview: Some("line\n".repeat(40)),
                            is_error: false,
                        }],
                        child_session_id: Some("019fe6bf-0bcb-70c2-a02d-e5c006dfc32a".into()),
                    }),
                    images: vec![image],
                },
            ],
            timestamp: chrono::Utc::now(),
            usage: Some(TurnUsage {
                input_tokens: u64::MAX,
                output_tokens: u64::MAX,
                cache_creation_input_tokens: u64::MAX,
                cache_read_input_tokens: u64::MAX,
            }),
            duration_ms: Some(u64::MAX),
            model: Some("claude-sonnet-5[1m]".into()),
            completed_at: Some(chrono::Utc::now()),
        agent_message_id: None,
        };
        let env = Arc::new(EventEnvelope {
            seq: u64::MAX,
            connection_id: "conn-背景-\"escaped\"".into(),
            payload: AcpEvent::BackgroundActivity {
                session_id: "1f8b332f-128a-4603-a5f4-f44d5a0bf932".into(),
                turns: vec![turn.clone(), turn],
                outstanding: u32::MAX,
                settled: vec![
                    crate::acp::types::BackgroundSettledInfo {
                        task_id: "ae6bd822f7a0e23a8".into(),
                        status: "completed".into(),
                        summary: Some("Agent \"Run pnpm build\" finished".into()),
                        tool_use_id: Some("toolu_01P782zHv8AMMpXYqaz39ijf".into()),
                        // Escape-heavy + large, to exercise the estimate's
                        // coverage of the (previously omitted) `result` field.
                        result: Some("Build \"log\"\n\t".repeat(2048)),
                    },
                    crate::acp::types::BackgroundSettledInfo {
                        task_id: "bipkee1pw".into(),
                        status: "failed".into(),
                        summary: None,
                        tool_use_id: None,
                        result: None,
                    },
                ],
                watermark: u64::MAX,
            },
        });
        assert_ge_serialized(&env);

        // Empty-payload shape (accounting-only event) must hold too.
        let env = Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::BackgroundActivity {
                session_id: "s".into(),
                turns: vec![],
                outstanding: 0,
                settled: vec![],
                watermark: 0,
            },
        });
        assert_ge_serialized(&env);
    }

    #[test]
    fn tool_update_near_cap_trips_via_field_key_overhead() {
        // raw_output alone is just under 64 KiB, but the other fields' keys and
        // `null`s push the serialized envelope over it. A values-only estimate
        // would wrongly retain it; the estimate must also trip the cap.
        let env = Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::ToolCallUpdate {
                tool_call_id: "t".into(),
                title: None,
                status: None,
                content: None,
                raw_input: None,
                raw_output: Some("z".repeat(65_450)),
                raw_output_append: None,
                locations: None,
                meta: None,
                images: None,
            },
        });
        let serialized = serde_json::to_vec(&*env).expect("serialize").len();
        assert!(serialized > RECENT_EVENT_MAX_BYTES, "serialized {serialized}");
        assert!(
            estimate_envelope_size(&env) > RECENT_EVENT_MAX_BYTES,
            "estimate must trip the cap like serialized {serialized}"
        );
    }

    #[test]
    fn user_message_many_small_blocks_trips_per_event_cap() {
        // Thousands of empty text blocks: payload strings are ~0 bytes, but the
        // per-block `{"type":"text","text":""}` wrappers + commas serialize well
        // over 64 KiB. The estimate must count that structure and trip the cap.
        let blocks: Vec<UserMessageBlock> = (0..4000)
            .map(|_| UserMessageBlock::Text {
                text: String::new(),
            })
            .collect();
        let env = Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c".into(),
            payload: AcpEvent::UserMessage {
                message_id: "u".into(),
                blocks,
            },
        });
        let serialized = serde_json::to_vec(&*env).expect("serialize").len();
        assert!(serialized > RECENT_EVENT_MAX_BYTES, "serialized {serialized}");
        assert!(estimate_envelope_size(&env) > RECENT_EVENT_MAX_BYTES);
    }

    #[test]
    fn escape_heavy_image_data_trips_per_event_cap() {
        // `data` is a plain String, not validated base64 here. A producer that
        // put escapable bytes in it (65,200 quotes ≈ 65 KiB raw, UNDER the cap)
        // serializes to ~130 KiB (each `"` → `\"`). Escape-aware `data` sizing
        // must count that expansion so the event still trips the cap, in BOTH the
        // UserMessage and ToolCall image paths — a raw-`len()` estimate would put
        // it under the cap and wrongly retain a >64 KiB replay event.
        let evil = "\"".repeat(65_200);
        for env in [
            user_message_with_image(1, evil.clone()),
            tool_update_with_image(1, evil.clone()),
        ] {
            let serialized = serde_json::to_vec(&*env).expect("serialize").len();
            assert!(serialized > RECENT_EVENT_MAX_BYTES, "serialized {serialized}");
            assert!(
                estimate_envelope_size(&env) > RECENT_EVENT_MAX_BYTES,
                "escape-aware image sizing must trip the cap (serialized {serialized})"
            );
            assert_ge_serialized(&env);
        }
    }

    #[test]
    fn escape_heavy_connection_id_trips_per_event_cap() {
        // connection_id lives on the envelope, not the payload; it must be sized
        // escape-aware too. A quote-filled id (raw ~65 KiB, under the cap) that
        // serializes to ~130 KiB would otherwise be wrongly retained.
        let env = Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "\"".repeat(65_200),
            payload: AcpEvent::ContentDelta {
                text: String::new(),
                parent_tool_use_id: None,
            },
        });
        let serialized = serde_json::to_vec(&*env).expect("serialize").len();
        assert!(serialized > RECENT_EVENT_MAX_BYTES, "serialized {serialized}");
        assert!(estimate_envelope_size(&env) > RECENT_EVENT_MAX_BYTES);
        assert_ge_serialized(&env);
    }

    #[test]
    fn broadcast_send_is_lossless_under_capacity() {
        let stream = ConnectionEventStream::new();
        let mut rx = stream.subscribe();
        for s in 1..=10 {
            stream.send(make_envelope(s, "x"));
        }
        for s in 1..=10 {
            let env = rx.try_recv().expect("event delivered");
            assert_eq!(env.seq, s);
        }
    }
}
