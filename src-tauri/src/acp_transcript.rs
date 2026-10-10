//! codeg's own **ACP-native transcript** for custom agents.
//!
//! Every built-in agent ships a dedicated parser (`crate::parsers::*`) that
//! reverse-engineers that agent's private session store to rebuild history.
//! A custom ACP agent has no such parser — and writing one per agent is
//! exactly what "add an agent by pasting registry info" is meant to avoid.
//!
//! The observation that makes this unnecessary is the same one
//! [`crate::turn_timings`] already relies on: **every session runs through
//! codeg**, so the connection layer witnesses the entire conversation. Here we
//! take it all the way — instead of recording a derived measurement, we record
//! the ACP wire itself:
//!
//! * each prompt codeg sends (`session/prompt`'s content blocks), and
//! * each `session/update` notification the agent sends back, verbatim.
//!
//! [`crate::parsers::acp_native`] reads that back and projects it into
//! `MessageTurn`s using nothing but ACP semantics — no agent-specific
//! knowledge anywhere in the loop.
//!
//! ## Why raw ACP and not codeg's own `AcpEvent`
//!
//! `AcpEvent` is an internal type that changes with every UI feature; persisting
//! it would silently corrupt old history on refactors. The ACP `SessionUpdate`
//! wire format is an external, versioned specification, so a transcript written
//! today still parses after arbitrary internal churn.
//!
//! ## File layout
//!
//! `<paths::codeg_acp_transcripts_root()>/<registry-id>/<session-id>.jsonl`
//!
//! Line 0 is a [`TranscriptHeader`]; every later line is a [`TranscriptEntry`]:
//!
//! ```jsonc
//! {"v":1,"kind":"header","agent":"custom:goose","session_id":"…","cwd":"/repo","started_at_ms":…}
//! {"t":1750000000000,"k":"prompt","p":[{"type":"text","text":"hi"}]}
//! {"t":1750000000123,"k":"update","p":{"sessionUpdate":"agent_message_chunk", …}}
//! ```
//!
//! Unknown/malformed lines are skipped by the reader, and a missing file simply
//! means "no history" — recording is best-effort by contract and must never
//! block or fail a turn.
//!
//! ## Write-behind
//!
//! Agents stream a reply as a long run of tiny chunks — measured at 32 records
//! for a turn the same agent replays as one merged chunk — and the reader joins
//! them straight back together. Writing each fragment would store an order of
//! magnitude more bytes than the conversation contains and make every later
//! read pay for it, so streamed text is buffered for at most
//! [`FLUSH_WINDOW`] and written merged (see [`compact_batch`], which also
//! argues why the reader cannot tell the difference).
//!
//! Everything else is written the moment it arrives: prompts, turn ends and
//! headers never wait, and neither does anything recorded outside a live turn.
//! A `session/load` replay is stored verbatim — it is already merged, and
//! merging it would need turn boundaries it does not have — and so is a turn
//! the agent runs on its own between prompts, which starts at its first chunk.
//!
//! Writes are pure appends: no record is ever rewritten or truncated once it
//! has landed. A crash therefore costs at most the last unflushed window of an
//! in-progress reply, and never a completed turn. A write *failure* costs
//! nothing on its own — the batch stays buffered and is retried, and its
//! `record_entry` receiver reports whether it eventually landed — except in the
//! one case where a partial write cannot be rolled back, where the batch is
//! abandoned rather than risk duplicating history that did land.

use std::io::{Seek as _, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// Schema version of the transcript file. Bump only for incompatible changes;
/// the reader skips lines whose version it does not understand.
pub const TRANSCRIPT_SCHEMA_VERSION: u32 = 1;

/// First line of a transcript file: everything about the session that is not
/// derivable from the ACP stream itself.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TranscriptHeader {
    pub v: u32,
    /// Always the literal `"header"`, so a reader can tell a header from an
    /// entry without positional assumptions (a file could in principle be
    /// concatenated across reconnects).
    pub kind: String,
    /// Wire form of the agent type, e.g. `custom:goose`.
    pub agent: String,
    pub session_id: String,
    /// Working directory the session was created in. The only source of a
    /// custom conversation's folder path when listing transcripts.
    pub cwd: String,
    pub started_at_ms: u64,
    /// Session id this transcript continues.
    ///
    /// Agents are not required to persist sessions, and many custom ones keep
    /// them in memory only — so after a restart `session/load` fails and codeg
    /// starts a fresh agent session for the SAME conversation. The turns codeg
    /// already recorded are not lost by that; they simply live under the old
    /// session id. Rather than move them (a rename could be interrupted between
    /// the file operation and the `external_id` write, stranding the history),
    /// the new transcript points back and the reader concatenates the chain.
    ///
    /// `None` for a transcript that starts its own conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continues_from: Option<String>,
}

impl TranscriptHeader {
    pub fn new(agent: &str, session_id: &str, cwd: &str, started_at_ms: u64) -> Self {
        Self {
            v: TRANSCRIPT_SCHEMA_VERSION,
            kind: "header".to_string(),
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            started_at_ms,
            continues_from: None,
        }
    }

    /// Mark this transcript as the continuation of `previous_session_id`.
    pub fn continuing(mut self, previous_session_id: &str) -> Self {
        self.continues_from = Some(previous_session_id.to_string());
        self
    }
}

/// What a transcript line records.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// A prompt codeg sent to the agent. `payload` is the ACP content-block
    /// array from `session/prompt`.
    Prompt,
    /// A `session/update` notification from the agent. `payload` is the
    /// serialized `SessionUpdate`, verbatim.
    Update,
    /// End of a prompt turn, as reported by the `session/prompt` **response**.
    /// ACP has no turn-end notification, so without this line turn boundaries
    /// could only be inferred; codeg is the party that receives the response,
    /// so it records it. Payload: `{"stopReason":…, "durationMs":…,
    /// "model":…, "usage":{…}}` (all optional but `stopReason`).
    ///
    /// Absent from transcripts hydrated by a `session/load` replay — the agent
    /// replays notifications only — where boundaries fall back to user message
    /// chunks.
    TurnEnd,
}

/// One recorded line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptEntry {
    /// Epoch milliseconds when codeg observed this.
    pub t: u64,
    pub k: EntryKind,
    pub p: serde_json::Value,
}

/// A parsed transcript: its header (when present and readable) plus every
/// well-formed entry, in file order.
#[derive(Debug, Clone, Default)]
pub struct Transcript {
    pub header: Option<TranscriptHeader>,
    pub entries: Vec<TranscriptEntry>,
}

impl Transcript {
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// Milliseconds since the Unix epoch; saturates rather than panicking on a
/// pre-1970 clock.
pub fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Whether `s` is safe as a single path component. Mirrors
/// `turn_timings::safe_component` — the registry id and the session id both
/// come from outside codeg (user input / the agent's own id generator), so
/// neither may introduce a separator, a parent ref, or a hidden-file prefix.
fn safe_component(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        && !s.starts_with('.')
}

/// `<root>/<agent_dir>/<session_id>.jsonl`, or `None` when either component is
/// unsafe as a file name.
pub fn transcript_path_in(root: &Path, agent_dir: &str, session_id: &str) -> Option<PathBuf> {
    if !safe_component(agent_dir) || !safe_component(session_id) {
        return None;
    }
    Some(root.join(agent_dir).join(format!("{session_id}.jsonl")))
}

/// Fires once a queued record is on disk, so the connection layer can
/// bound-wait at turn end (without it, a conversation reopened immediately
/// after a turn could miss its tail) and so a `session/load` hydration can
/// apply backpressure instead of overrunning the writer.
///
/// A **dropped** sender is the failure signal: it is the only one a
/// `oneshot::Sender<()>` can carry, and "did this land" is the only question
/// either caller asks.
type AckSender = tokio::sync::oneshot::Sender<()>;

/// A record waiting to be written, in the shape the file stores it.
///
/// Kept structured rather than pre-serialized because [`compact_batch`] merges
/// streamed text chunks *before* they are ever written; serialization then
/// happens once, at flush.
enum PendingRecord {
    Header(TranscriptHeader),
    Entry(TranscriptEntry),
}

impl PendingRecord {
    fn to_line(&self) -> String {
        match self {
            PendingRecord::Header(h) => serde_json::to_string(h).unwrap_or_default(),
            PendingRecord::Entry(e) => serde_json::to_string(e).unwrap_or_default(),
        }
    }

    /// Records that must not wait for a flush window.
    ///
    /// They mark the turn boundaries the reader reconstructs turns from, and —
    /// decisively — a `Prompt` is what makes [`has_entries_in`] answer true.
    /// That answer is the gate keeping a `session/load` replay from appending a
    /// second copy of history codeg already recorded.
    ///
    /// Flushing on arrival is only half of that guarantee: it bounds how long a
    /// prompt sits in the WRITER, not how long it sits in the queue ahead of
    /// it. The gate reads the file, so the recorder must also await the ack
    /// before treating the prompt as recorded — which is why
    /// `acp::connection::record_prompt` bound-waits, and why
    /// `a_queued_prompt_is_invisible_to_the_replay_gate_until_it_lands` exists.
    fn is_boundary(&self) -> bool {
        match self {
            PendingRecord::Header(_) => true,
            PendingRecord::Entry(e) => matches!(e.k, EntryKind::Prompt | EntryKind::TurnEnd),
        }
    }
}

/// Sessions with a prompt that has been queued but is not yet in the file,
/// counted per transcript path.
///
/// [`has_entries_in`] answers from the file, and the replay gate
/// ([`has_recorded_history_in`]) uses that answer to decide whether a
/// `session/load` replay may be recorded. A prompt still in the queue is
/// invisible to the file, so without this the gate could conclude "this
/// conversation has no transcript", record the replay, and then have the queued
/// prompt land on top of it — two copies of one conversation, permanently,
/// because the gate reads non-empty forever after.
///
/// Waiting for the ack (`acp::connection::record_prompt`) shrinks that window
/// but cannot close it: the wait is bounded so that a wedged disk can never
/// hang a turn. This closes it, and only needs to be in memory to do so — a
/// queued record can only ever land while this process lives, so a crash takes
/// the record and the hazard together.
static PENDING_PROMPTS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<PathBuf, usize>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

/// Holds a session's pending-prompt count up for as long as it exists.
///
/// Deliberately RAII rather than paired increment/decrement calls: a queued
/// record leaves the writer through several paths (written, abandoned after an
/// unrecoverable partial write, refused by a poisoned writer, dropped by a full
/// queue), and a count leaked on any one of them would block that session's
/// hydration for the rest of the process's life.
struct PendingPromptGuard(PathBuf);

impl PendingPromptGuard {
    fn new(path: &Path) -> Self {
        if let Ok(mut counts) = PENDING_PROMPTS.lock() {
            *counts.entry(path.to_path_buf()).or_insert(0) += 1;
        }
        Self(path.to_path_buf())
    }
}

impl Drop for PendingPromptGuard {
    fn drop(&mut self) {
        if let Ok(mut counts) = PENDING_PROMPTS.lock() {
            if let std::collections::hash_map::Entry::Occupied(mut e) = counts.entry(self.0.clone())
            {
                *e.get_mut() -= 1;
                if *e.get() == 0 {
                    e.remove();
                }
            }
        }
    }
}

fn has_pending_prompt(path: &Path) -> bool {
    PENDING_PROMPTS
        .lock()
        .map(|counts| counts.contains_key(path))
        .unwrap_or(false)
}

/// One record on its way to disk: what to write, who to tell, and — for a
/// prompt — the guard that keeps the replay gate honest until it lands.
struct Queued {
    record: PendingRecord,
    ack: AckSender,
    /// Dropped when this record leaves the writer by ANY path, which is what
    /// makes the count self-correcting. `None` for records the gate does not
    /// depend on.
    _prompt_guard: Option<PendingPromptGuard>,
}

/// One queued record. The path is resolved by the caller so the writer thread
/// deals in one identity per file — which is also the key its per-session state
/// is stored under.
struct TranscriptJob {
    path: PathBuf,
    queued: Queued,
}

/// Bound on queued records. Transcript records are far more frequent than turn
/// timings (one per streamed chunk), so this is generous; overflow drops the
/// record with a debug log rather than ever blocking the ACP read loop. The
/// writer thread only moves records into its buffer before returning to the
/// queue, so reaching this bound now means the disk is wedged, not that the
/// writer is merely behind.
const TRANSCRIPT_QUEUE_CAP: usize = 8192;

/// How long a streamed chunk may sit in memory before it is written.
///
/// This is the entire cost of a crash: everything older is on disk, and no turn
/// boundary ever waits for it. One second is long enough to merge a meaningful
/// run of chunks and short enough to bound both the loss window and the
/// in-memory batch to one second of streaming.
const FLUSH_WINDOW: std::time::Duration = std::time::Duration::from_secs(1);

static TRANSCRIPT_TX: std::sync::OnceLock<std::sync::mpsc::SyncSender<TranscriptJob>> =
    std::sync::OnceLock::new();

/// Per-file writer state. Lives on the writer thread only, so none of this
/// needs synchronization — and the header-idempotence decision that used to be
/// a racy filesystem probe on the calling thread now happens here, where it is
/// simply a local variable.
struct SessionWriter {
    path: PathBuf,
    /// Records not yet on disk, in order, each with its ack.
    ///
    /// The ack travels WITH the record rather than being resolved when the job
    /// is dequeued: a waiting caller is asking "did this land", and under
    /// write-behind that is not known until the batch flushes. Resolving on
    /// dequeue would answer "yes" to a record still in memory and would leave
    /// hydration's backpressure doing nothing at all.
    pending: Vec<Queued>,
    /// Whether records arriving now belong to a live prompt turn — the only
    /// place merging streamed chunks is sound. Set by a written `Prompt`,
    /// cleared by a written `TurnEnd`, so a `session/load` replay (which has
    /// neither) is always written verbatim, and so is whatever the agent does
    /// between a turn end and the next prompt.
    compactable: bool,
    header_written: bool,
    /// The file can no longer be safely appended to: a partial write that could
    /// not be rolled back, and whose record boundary could not be restored.
    /// Later records fail fast rather than concatenate themselves onto a torn
    /// line, which would corrupt a well-formed record instead of just losing
    /// one.
    poisoned: bool,
    /// When the oldest unflushed record arrived — the flush deadline's base.
    oldest_pending_at: Option<std::time::Instant>,
    /// Consecutive failed flushes, so a wedged disk is reported once rather
    /// than once per window.
    consecutive_failures: u32,
    /// Last time this writer did anything, for [`IDLE_EVICT`].
    last_touched: std::time::Instant,
}

/// How long a writer with nothing buffered is kept before it is forgotten.
///
/// Its state is a cache, not a source of truth — `compactable` is re-derived
/// from the next prompt and `header_written` falls back to reading the file —
/// so dropping it is always safe, and long enough that it cannot happen inside
/// a live turn. Without this, a server that runs for weeks would keep one entry
/// per session it ever wrote.
const IDLE_EVICT: std::time::Duration = std::time::Duration::from_secs(30 * 60);

impl SessionWriter {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            pending: Vec::new(),
            compactable: false,
            header_written: false,
            poisoned: false,
            oldest_pending_at: None,
            consecutive_failures: 0,
            last_touched: std::time::Instant::now(),
        }
    }

    /// Holding nothing and untouched long enough that forgetting it is free.
    fn is_idle(&self, now: std::time::Instant) -> bool {
        self.pending.is_empty() && now.saturating_duration_since(self.last_touched) >= IDLE_EVICT
    }

    /// True when this session's file already holds something. Cheap and, unlike
    /// the probe this replaces, not racy: the writer thread is the only writer.
    fn file_is_non_empty(&self) -> bool {
        std::fs::metadata(&self.path)
            .map(|m| m.len() > 0)
            .unwrap_or(false)
    }

    fn accept(&mut self, queued: Queued) {
        self.last_touched = std::time::Instant::now();
        if self.poisoned {
            return; // dropping `ack` (and the guard) reports the failure
        }
        if matches!(queued.record, PendingRecord::Header(_)) && self.header_already_stands() {
            // A reconnect to the same session id. The original header carries
            // the conversation's real start time and cwd, so it wins.
            let _ = queued.ack.send(());
            return;
        }
        let boundary = queued.record.is_boundary();
        if self.pending.is_empty() {
            self.oldest_pending_at = Some(std::time::Instant::now());
        }
        self.pending.push(queued);
        // Nothing to merge when the batch cannot be compacted (a replay, or the
        // gap between turns), so buffering would be latency for its own sake —
        // and hydration, which awaits every ack, would then advance at one
        // record per flush window instead of at disk speed.
        if boundary || !self.compactable {
            self.flush();
        }
    }

    fn header_already_stands(&mut self) -> bool {
        if self.header_written {
            return true;
        }
        let stands = self
            .pending
            .iter()
            .any(|q| matches!(q.record, PendingRecord::Header(_)))
            || self.file_is_non_empty();
        if stands {
            self.header_written = true;
        }
        stands
    }

    /// When this writer next needs attention, or `None` while it holds nothing.
    fn deadline(&self) -> Option<std::time::Instant> {
        self.oldest_pending_at.map(|at| at + FLUSH_WINDOW)
    }

    fn resolve_all(&mut self, landed: bool) {
        for queued in self.pending.drain(..) {
            if landed {
                let _ = queued.ack.send(());
            }
            // Otherwise the sender drops, and the receiver sees that as "no".
        }
        self.oldest_pending_at = None;
    }

    /// Append everything buffered, as one write.
    ///
    /// Every step that can fail leaves the file in a state the next attempt can
    /// safely resume from:
    ///
    /// * open / seek fails → not a byte written, batch and acks retained;
    /// * write fails, rollback succeeds → file is byte-identical to before the
    ///   attempt, so retrying the whole batch is idempotent; acks stay pending
    ///   because the records genuinely have not landed yet;
    /// * write fails AND rollback fails → the tail holds part of this batch and
    ///   cannot be removed. Retrying would duplicate the part that did land and
    ///   splice the rest onto a torn line, so this is where the batch is
    ///   abandoned: restore a record boundary with a newline (so later records
    ///   still start cleanly), report the failure, and give up on it.
    ///
    /// Losing records is bad; duplicating or corrupting them is worse, because
    /// a short history reads as a short history while a mangled one reads as
    /// fact.
    fn flush(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if self.poisoned {
            self.resolve_all(false);
            return;
        }

        let (lines, next_compactable) = compact_batch(&self.pending, self.compactable);
        if lines.is_empty() {
            self.compactable = next_compactable;
            self.resolve_all(true);
            return;
        }

        let mut file = match open_for_append(&self.path) {
            Ok(f) => f,
            Err(e) => return self.defer(e),
        };
        let pre_len = match file.stream_position() {
            Ok(p) => p,
            Err(e) => return self.defer(e),
        };

        match file.write_all(lines.as_bytes()) {
            Ok(()) => {
                self.compactable = next_compactable;
                self.header_written |= lines_contain_header(&self.pending);
                self.consecutive_failures = 0;
                self.resolve_all(true);
            }
            Err(e) => match file.set_len(pre_len) {
                Ok(()) => self.defer(e),
                Err(rollback) => {
                    if file.write_all(b"\n").is_err() {
                        self.poisoned = true;
                    }
                    tracing::error!(
                        "[acp-transcript] partial write to {} could not be rolled back \
                         ({e}; rollback: {rollback}); dropping {} buffered record(s) rather \
                         than risk duplicating them{}",
                        self.path.display(),
                        self.pending.len(),
                        if self.poisoned {
                            " — this session will record nothing further"
                        } else {
                            ""
                        }
                    );
                    self.resolve_all(false);
                }
            },
        }
    }

    /// Keep the batch (and its acks) for the next window after a failure that
    /// left the file untouched.
    fn defer(&mut self, e: std::io::Error) {
        // Re-base the deadline. Without this the batch stays permanently
        // overdue, and the writer thread would retry a wedged disk as fast as
        // the CPU allows instead of once a window.
        self.oldest_pending_at = Some(std::time::Instant::now());
        self.consecutive_failures += 1;
        // Reported once at the point it stops looking transient, then not again
        // until it recovers: a wedged disk would otherwise log every window for
        // as long as the app runs.
        if self.consecutive_failures == FAILURES_BEFORE_REPORTING {
            tracing::error!(
                "[acp-transcript] cannot write {} ({e}); {} record(s) buffered and retrying — \
                 history for this session is not being saved",
                self.path.display(),
                self.pending.len()
            );
        } else {
            tracing::debug!("[acp-transcript] deferring write to {}: {e}", self.path.display());
        }
    }
}

/// How many consecutive failed flushes before the problem is reported as an
/// error rather than a debug line. One is a hiccup; several seconds of them is
/// a disk the user needs to know about.
const FAILURES_BEFORE_REPORTING: u32 = 3;

fn lines_contain_header(pending: &[Queued]) -> bool {
    pending
        .iter()
        .any(|q| matches!(q.record, PendingRecord::Header(_)))
}

/// Open positioned at the end, creating the file and its directory if needed.
///
/// Deliberately NOT `append(true)`: the rollback in [`SessionWriter::flush`]
/// needs `set_len` to undo exactly the bytes this write added, and under
/// `O_APPEND` the write position is decided by the kernel rather than by the
/// offset the caller observed.
fn open_for_append(path: &Path) -> std::io::Result<std::fs::File> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    file.seek(std::io::SeekFrom::End(0))?;
    Ok(file)
}

/// The kind of agent text chunk this payload is, when it is one whose
/// neighbours it may be merged with.
///
/// Only plain `text` content qualifies. An image chunk becomes its own block on
/// read and a resource link projects to its uri, so rewriting either into a
/// text chunk would change the ACP payload this file exists to keep verbatim.
/// They stay as they are and simply end the run — the reader still joins their
/// projections into the same block, so nothing is lost by not merging them.
fn mergeable_chunk_kind(payload: &serde_json::Value) -> Option<&'static str> {
    let kind = match payload.get("sessionUpdate").and_then(|v| v.as_str())? {
        "agent_message_chunk" => "agent_message_chunk",
        "agent_thought_chunk" => "agent_thought_chunk",
        // `user_message_chunk` is deliberately excluded: its FIRST timestamp
        // fixes the user turn's own timestamp and its LAST one fixes where the
        // next assistant turn starts, and one merged record cannot carry both.
        _ => return None,
    };
    let content = payload.get("content")?;
    (content.get("type").and_then(|v| v.as_str()) == Some("text")
        && content.get("text").is_some_and(serde_json::Value::is_string))
    .then_some(kind)
}

/// Serialize a batch into the bytes to append, merging each run of consecutive
/// streamed agent text chunks into one record.
///
/// Returns the new `compactable` state alongside the bytes rather than
/// mutating it, so a retried flush produces byte-identical output.
///
/// ## Why this cannot change what the reader sees
///
/// An agent streams a reply as tens or hundreds of one-word chunks;
/// `parsers::acp_native` joins them right back into a single block with
/// `push_text`. Recording every fragment therefore stores an order of magnitude
/// more bytes than the conversation contains (measured at 32:1 against the same
/// turn replayed by `session/load`), and every later read pays for it.
///
/// Merging is invisible to the projection because:
///
/// * **Content.** `push_text` appends consecutive same-kind chunks into one
///   `ContentBlock`, so N chunks and their concatenation build the same block.
/// * **End of the turn.** `apply_update` sets `last_at_ms` from every chunk, so
///   taking the run's LAST timestamp reproduces it exactly — without relying on
///   a `TurnEnd` to overwrite it, which a turn flushed early by a mid-turn user
///   chunk never gets.
/// * **Start of the turn.** That comes from the prompt's timestamp, and prompts
///   are never merged. A turn starts from a chunk instead in a transcript with
///   no prompts at all — a replay — and in a turn the agent runs on its own
///   after a turn end; `compactable` excludes both.
/// * **Everything else** (tool calls, plans, user chunks, images, resource
///   links) is written through unchanged.
fn compact_batch(pending: &[Queued], compactable: bool) -> (String, bool) {
    let mut compactable = compactable;
    let mut out = String::new();
    // The run being merged, and which chunk kind it is. `None` between runs.
    let mut open: Option<(&'static str, TranscriptEntry)> = None;

    let close_run = |open: &mut Option<(&'static str, TranscriptEntry)>, out: &mut String| {
        if let Some((_, entry)) = open.take() {
            push_line(out, &serde_json::to_string(&entry).unwrap_or_default());
        }
    };

    for Queued { record, .. } in pending {
        let entry = match record {
            PendingRecord::Entry(e) if compactable && e.k == EntryKind::Update => e,
            other => {
                close_run(&mut open, &mut out);
                if let PendingRecord::Entry(e) = other {
                    match e.k {
                        EntryKind::Prompt => compactable = true,
                        EntryKind::TurnEnd => compactable = false,
                        EntryKind::Update => {}
                    }
                }
                push_line(&mut out, &other.to_line());
                continue;
            }
        };
        match mergeable_chunk_kind(&entry.p) {
            // `_meta` is opaque per-record extension data; merging records that
            // carry different values would silently pick one. Equal (usually
            // absent on both) is the only case where merging loses nothing.
            Some(kind)
                if open.as_ref().is_some_and(|(open_kind, open_entry)| {
                    *open_kind == kind && open_entry.p.get("_meta") == entry.p.get("_meta")
                }) =>
            {
                let (_, open_entry) = open.as_mut().expect("guard matched Some");
                append_chunk_text(open_entry, entry);
            }
            Some(kind) => {
                close_run(&mut open, &mut out);
                open = Some((kind, entry.clone()));
            }
            None => {
                close_run(&mut open, &mut out);
                push_line(&mut out, &record.to_line());
            }
        }
    }
    close_run(&mut open, &mut out);
    (out, compactable)
}

fn push_line(out: &mut String, line: &str) {
    if line.is_empty() {
        return;
    }
    out.push_str(line);
    out.push('\n');
}

/// Fold `next`'s text into the run `open` represents. The run carries the LAST
/// timestamp, which is what keeps a turn's end time exact — see
/// [`compact_batch`].
fn append_chunk_text(open: &mut TranscriptEntry, next: &TranscriptEntry) {
    let text = next
        .p
        .get("content")
        .and_then(|c| c.get("text"))
        .and_then(|t| t.as_str())
        .unwrap_or_default()
        .to_string();
    if let Some(serde_json::Value::String(existing)) =
        open.p.get_mut("content").and_then(|c| c.get_mut("text"))
    {
        existing.push_str(&text);
    }
    open.t = next.t;
}

/// Queue one record for a session's transcript, returning a receiver that
/// resolves once it has landed.
///
/// All production writes funnel through a single dedicated OS thread, so file
/// order equals enqueue order — the transcript's whole contract, since the
/// parser reconstructs turns positionally. A hung filesystem blocks only that
/// thread (never a tokio pool); the queue then fills and later records are
/// dropped, which their receivers report.
fn enqueue(path: PathBuf, record: PendingRecord) -> tokio::sync::oneshot::Receiver<()> {
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    // Taken BEFORE the record is handed to the queue, so there is no instant in
    // which the record is in flight and the replay gate cannot see it.
    let prompt_guard = matches!(
        record,
        PendingRecord::Entry(TranscriptEntry {
            k: EntryKind::Prompt,
            ..
        })
    )
    .then(|| PendingPromptGuard::new(&path));
    let tx = TRANSCRIPT_TX.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<TranscriptJob>(TRANSCRIPT_QUEUE_CAP);
        let spawned = std::thread::Builder::new()
            .name("acp-transcript-writer".into())
            .spawn(move || run_writer(rx));
        if let Err(e) = spawned {
            tracing::debug!("[acp-transcript] failed to spawn writer thread: {e}");
        }
        tx
    });
    if tx
        .try_send(TranscriptJob {
            path,
            queued: Queued {
                record,
                ack: ack_tx,
                _prompt_guard: prompt_guard,
            },
        })
        .is_err()
    {
        // The job comes back inside the error and is dropped here, which
        // releases the guard: a record that will never land must not keep
        // claiming the session has history.
        tracing::debug!("[acp-transcript] queue full or closed; record dropped");
    }
    ack_rx
}

/// The writer thread: drain the queue, and flush each session's buffer when its
/// window comes due.
///
/// Sleeps outright while nothing is buffered, and otherwise wakes exactly when
/// the earliest deadline arrives — no polling either way.
fn run_writer(rx: std::sync::mpsc::Receiver<TranscriptJob>) {
    use std::sync::mpsc::RecvTimeoutError;
    let mut writers: std::collections::HashMap<PathBuf, SessionWriter> =
        std::collections::HashMap::new();
    loop {
        let next = writers.values().filter_map(SessionWriter::deadline).min();
        let job = match next {
            Some(at) => {
                let wait = at.saturating_duration_since(std::time::Instant::now());
                match rx.recv_timeout(wait) {
                    Ok(job) => Some(job),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None => match rx.recv() {
                Ok(job) => Some(job),
                Err(_) => break,
            },
        };
        if let Some(job) = job {
            writers
                .entry(job.path.clone())
                .or_insert_with(|| SessionWriter::new(job.path))
                .accept(job.queued);
        }
        let now = std::time::Instant::now();
        for writer in writers.values_mut() {
            if writer.deadline().is_some_and(|at| at <= now) {
                writer.flush();
            }
        }
        writers.retain(|_, w| !w.is_idle(now));
    }
    // The sender lives in a `OnceLock` for the process's lifetime, so this is
    // reached only at teardown. Write out whatever is still buffered.
    for writer in writers.values_mut() {
        writer.flush();
    }
}

/// Record the session header, creating the transcript file if needed.
///
/// Idempotent per file: if the file already has content (a reconnect to the
/// same session id), nothing is written — the original header stands.
pub fn record_header(
    agent_dir: &str,
    header: &TranscriptHeader,
) -> tokio::sync::oneshot::Receiver<()> {
    record_header_in(&crate::paths::codeg_acp_transcripts_root(), agent_dir, header)
}

/// Root-injectable core of [`record_header`].
pub fn record_header_in(
    root: &Path,
    agent_dir: &str,
    header: &TranscriptHeader,
) -> tokio::sync::oneshot::Receiver<()> {
    // Idempotence is decided on the writer thread, which is the only party that
    // knows about a header still sitting in its buffer — and which, being the
    // only writer, cannot race the file it checks.
    queue_for(root, agent_dir, &header.session_id, PendingRecord::Header(header.clone()))
}

/// Record one prompt or update.
pub fn record_entry(
    agent_dir: &str,
    session_id: &str,
    kind: EntryKind,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    record_entry_in(
        &crate::paths::codeg_acp_transcripts_root(),
        agent_dir,
        session_id,
        kind,
        payload,
    )
}

/// Root-injectable core of [`record_entry`].
pub fn record_entry_in(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    kind: EntryKind,
    payload: serde_json::Value,
) -> tokio::sync::oneshot::Receiver<()> {
    let entry = TranscriptEntry {
        t: now_epoch_ms(),
        k: kind,
        p: payload,
    };
    queue_for(root, agent_dir, session_id, PendingRecord::Entry(entry))
}

/// Resolve the target file and queue `record` for it. An id that is unsafe as a
/// path component records nothing, and says so through the dropped ack.
fn queue_for(
    root: &Path,
    agent_dir: &str,
    session_id: &str,
    record: PendingRecord,
) -> tokio::sync::oneshot::Receiver<()> {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        tracing::debug!(
            "[acp-transcript] skipping record: unsafe id agent={agent_dir} session={session_id}"
        );
        let (_tx, rx) = tokio::sync::oneshot::channel();
        return rx;
    };
    enqueue(path, record)
}

/// Append one already-serialized line, synchronously.
///
/// Best-effort: every failure is logged at debug and swallowed. Production
/// writes go through [`record_entry`] and the writer thread; this is how tests
/// build fixture files, where a synchronous append is what makes the assertions
/// deterministic.
pub fn append_line_in(root: &Path, agent_dir: &str, session_id: &str, line: &str) {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        tracing::debug!(
            "[acp-transcript] skipping append: unsafe id agent={agent_dir} session={session_id}"
        );
        return;
    };
    if line.is_empty() {
        return;
    }
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        f.write_all(format!("{line}\n").as_bytes())
    };
    if let Err(e) = write() {
        tracing::debug!(
            "[acp-transcript] append failed for {}: {e}",
            path.display()
        );
    }
}

/// Read one session's transcript. Missing file → empty transcript. Malformed
/// lines are skipped so a single truncated write (e.g. a hard kill mid-append)
/// cannot poison the rest of the history.
pub fn read_transcript(agent_dir: &str, session_id: &str) -> Transcript {
    read_transcript_in(
        &crate::paths::codeg_acp_transcripts_root(),
        agent_dir,
        session_id,
    )
}

/// Root-injectable core of [`read_transcript`].
pub fn read_transcript_in(root: &Path, agent_dir: &str, session_id: &str) -> Transcript {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return Transcript::default();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Transcript::default();
    };
    // Decoded lossily rather than read as a `String`: `append_line_in` writes a
    // line with one `write_all`, so a hard kill can tear it in the middle of a
    // multi-byte character. Rejecting the file for that would throw away every
    // turn recorded before it; lossily, the torn line alone fails to parse and
    // is skipped like any other malformed line. It also keeps this in step with
    // the streaming readers below, which cannot see a later byte before
    // returning an earlier answer.
    parse_transcript(&String::from_utf8_lossy(&bytes))
}

/// Parse transcript file content. Split out so tests (and the reader) share one
/// definition of "what a valid line is".
pub fn parse_transcript(content: &str) -> Transcript {
    let mut out = Transcript::default();
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        // A header is distinguished by its `kind` field, not its position.
        if out.header.is_none() {
            if let Some(header) = parse_header_line(line) {
                out.header = Some(header);
                continue;
            }
        }
        if let Ok(entry) = serde_json::from_str::<TranscriptEntry>(line) {
            out.entries.push(entry);
        }
    }
    out
}

/// A header line, or `None` when this line is something else. The one
/// definition of "is this a header", shared by the whole-file parser and the
/// streaming readers below so the two can never disagree.
fn parse_header_line(line: &str) -> Option<TranscriptHeader> {
    let header = serde_json::from_str::<TranscriptHeader>(line).ok()?;
    (header.kind == "header" && header.v == TRANSCRIPT_SCHEMA_VERSION).then_some(header)
}

/// Walk a transcript's non-empty lines, stopping as soon as `visit` returns
/// `false`. Nothing is materialized, so a reader that only needs the head of a
/// file pays for the head of a file.
///
/// Lines are split on `\n` and decoded lossily, exactly as
/// [`read_transcript_in`] does — a stopped-early reader can never look at a
/// later byte, so the two must not disagree about anything a reader can reach.
/// (The split is safe to do before decoding: `\n` cannot occur inside a
/// multi-byte UTF-8 sequence, so per-line lossy decoding and whole-file lossy
/// decoding produce the same lines.)
fn scan_lines(path: &Path, mut visit: impl FnMut(&str) -> bool) {
    use std::io::BufRead as _;
    let Ok(file) = std::fs::File::open(path) else {
        return;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        let decoded = String::from_utf8_lossy(&buf);
        let line = decoded.trim();
        if line.is_empty() {
            continue;
        }
        if !visit(line) {
            return;
        }
    }
}

/// A transcript's header WITHOUT parsing its entries.
///
/// Same answer as `read_transcript_in(..).header`, but it stops at the header
/// line instead of deserializing every recorded chunk — which is what
/// [`superseded_session_ids_in`] needs from every file in a directory.
pub fn read_header_in(root: &Path, agent_dir: &str, session_id: &str) -> Option<TranscriptHeader> {
    let path = transcript_path_in(root, agent_dir, session_id)?;
    let mut found = None;
    scan_lines(&path, |line| {
        found = parse_header_line(line);
        // Keep looking until a header parses: the whole-file parser accepts one
        // at any position, so this must too.
        found.is_none()
    });
    found
}

/// **The replay gate.** True when this conversation already has history codeg
/// recorded — whether it has reached the file yet or is still on its way there.
///
/// A `session/load` replay may be recorded only when this is false. Answering
/// "no history" for a conversation that has some is the one dangerous mistake:
/// the replay is then appended to history codeg already had, and because the
/// gate reads non-empty from then on, the duplicate is permanent and silent.
///
/// So it is deliberately conservative in exactly one direction — a prompt that
/// has been queued but not yet written counts as history, because it is going
/// to be. The opposite bias is unrecoverable; this one costs at most a replay
/// that was redundant anyway.
pub fn has_recorded_history(agent_dir: &str, session_id: &str) -> bool {
    has_recorded_history_in(
        &crate::paths::codeg_acp_transcripts_root(),
        agent_dir,
        session_id,
    )
}

/// Root-injectable core of [`has_recorded_history`].
pub fn has_recorded_history_in(root: &Path, agent_dir: &str, session_id: &str) -> bool {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return false;
    };
    // Checked before the file, and safe in that order: a count that falls to
    // zero between the two checks does so because the record LANDED, which the
    // file scan then finds. No interleaving yields a false "no".
    if has_pending_prompt(&path) {
        return true;
    }
    has_entries_in(root, agent_dir, session_id)
}

/// True when a transcript FILE already holds at least one entry. Returns at the
/// first entry rather than parsing the file to answer a yes/no — this runs on
/// every reconnect, where the transcript is at its longest.
///
/// This is only half of [`has_recorded_history_in`], which is the gate callers
/// want: on its own it cannot see a record still in the writer, and that blind
/// spot is what would let a replay duplicate a conversation.
pub fn has_entries_in(root: &Path, agent_dir: &str, session_id: &str) -> bool {
    let Some(path) = transcript_path_in(root, agent_dir, session_id) else {
        return false;
    };
    let mut header_seen = false;
    let mut found = false;
    scan_lines(&path, |line| {
        // Mirrors the whole-file parser: the header is consumed, not counted.
        if !header_seen && parse_header_line(line).is_some() {
            header_seen = true;
            return true;
        }
        found = serde_json::from_str::<TranscriptEntry>(line).is_ok();
        !found
    });
    found
}

/// Bound on how far [`read_chain_in`] follows `continues_from`. One link is
/// added per failed `session/load`, i.e. roughly per app restart of a
/// long-lived conversation, so this is far above any real chain — it exists
/// only so a hand-edited or corrupted file cannot make a read unbounded.
pub const MAX_CONTINUATION_DEPTH: usize = 512;

/// Read a session's transcript **together with everything it continues** (see
/// [`TranscriptHeader::continues_from`]), oldest entry first.
///
/// The returned header is the OLDEST one in the chain: it carries the
/// conversation's real start time and working directory, which is what callers
/// summarize from. Cycles and over-long chains stop the walk instead of hanging.
pub fn read_chain_in(root: &Path, agent_dir: &str, session_id: &str) -> Transcript {
    let mut chain: Vec<Transcript> = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cursor = Some(session_id.to_string());

    while let Some(id) = cursor.take() {
        if !visited.insert(id.clone()) {
            tracing::debug!("[acp-transcript] continuation cycle at {id}; stopping walk");
            break;
        }
        if chain.len() >= MAX_CONTINUATION_DEPTH {
            tracing::debug!(
                "[acp-transcript] continuation chain exceeded {MAX_CONTINUATION_DEPTH}; truncating"
            );
            break;
        }
        let transcript = read_transcript_in(root, agent_dir, &id);
        cursor = transcript
            .header
            .as_ref()
            .and_then(|h| h.continues_from.clone());
        chain.push(transcript);
    }

    // `chain` is newest → oldest; replay it the other way so entry order stays
    // chronological and the oldest header wins.
    let mut merged = Transcript::default();
    for transcript in chain.iter_mut().rev() {
        if merged.header.is_none() {
            merged.header = transcript.header.take();
        }
        merged.entries.append(&mut transcript.entries);
    }
    merged
}

/// The session ids `session_id` continues, transitively — newest first.
///
/// Headers only, so this is cheap enough to call on every session bind: one
/// short read per link, and the overwhelmingly common answer is an empty vec
/// after a single read. Shares [`read_chain_in`]'s cycle and depth guards.
///
/// This is the "same conversation, new agent session" signal. When a custom
/// agent has forgotten a session, codeg opens a fresh one and links it back
/// (see [`TranscriptHeader::continues_from`]); the reader then renders the
/// whole chain as ONE conversation, and the generic parser hides the
/// superseded ids for exactly that reason. So a bind moving from an id in
/// this set to `session_id` is a continuation, NOT a conversation losing its
/// history — the earlier turns stay reachable through the new id.
pub fn continuation_ancestors_in(root: &Path, agent_dir: &str, session_id: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut visited: std::collections::HashSet<String> = std::collections::HashSet::new();
    visited.insert(session_id.to_string());
    let mut cursor = read_header_in(root, agent_dir, session_id).and_then(|h| h.continues_from);

    while let Some(id) = cursor.take() {
        if !visited.insert(id.clone()) {
            tracing::debug!("[acp-transcript] continuation cycle at {id}; stopping walk");
            break;
        }
        if out.len() >= MAX_CONTINUATION_DEPTH {
            tracing::debug!(
                "[acp-transcript] continuation chain exceeded {MAX_CONTINUATION_DEPTH}; truncating"
            );
            break;
        }
        cursor = read_header_in(root, agent_dir, &id).and_then(|h| h.continues_from);
        out.push(id);
    }
    out
}

/// [`continuation_ancestors_in`] against the real transcripts root.
pub fn continuation_ancestors(agent_dir: &str, session_id: &str) -> Vec<String> {
    continuation_ancestors_in(
        &crate::paths::codeg_acp_transcripts_root(),
        agent_dir,
        session_id,
    )
}

/// Session ids under `<root>/<agent_dir>/` that some other transcript continues.
///
/// A superseded transcript is a prefix of its successor, so listing both would
/// show one conversation twice.
///
/// Reads headers only. This runs over every file in the directory before the
/// listing then reads the surviving chains in full, so parsing entries here
/// would deserialize the agent's whole recorded history twice per listing.
pub fn superseded_session_ids_in(
    root: &Path,
    agent_dir: &str,
) -> std::collections::HashSet<String> {
    list_session_ids_in(root, agent_dir)
        .into_iter()
        .filter_map(|id| read_header_in(root, agent_dir, &id))
        .filter_map(|h| h.continues_from)
        .collect()
}

/// Every session id with a transcript under `<root>/<agent_dir>/`. Used by the
/// generic parser's `list_conversations`.
pub fn list_session_ids_in(root: &Path, agent_dir: &str) -> Vec<String> {
    if !safe_component(agent_dir) {
        return Vec::new();
    }
    let Ok(entries) = std::fs::read_dir(root.join(agent_dir)) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            name.strip_suffix(".jsonl").map(str::to_string)
        })
        .collect();
    ids.sort();
    ids
}

/// Delete a custom agent's whole transcript directory. Called when the user
/// removes the agent definition and asks for its data to go with it.
pub fn remove_agent_transcripts_in(root: &Path, agent_dir: &str) -> std::io::Result<()> {
    if !safe_component(agent_dir) {
        return Ok(());
    }
    let dir = root.join(agent_dir);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    // The write-behind tests assert against the reader, since "does merging
    // change what the user sees" is the only question that matters about it.
    use crate::models::message::{MessageTurn, TurnRole};
    use crate::parsers::acp_native::project_turns;

    fn temp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "codeg-acp-transcript-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn header_line(session: &str) -> String {
        serde_json::to_string(&TranscriptHeader::new(
            "custom:goose",
            session,
            "/repo",
            1_750_000_000_000,
        ))
        .unwrap()
    }

    fn entry_line(kind: EntryKind, payload: serde_json::Value) -> String {
        serde_json::to_string(&TranscriptEntry {
            t: 1_750_000_000_001,
            k: kind,
            p: payload,
        })
        .unwrap()
    }

    #[test]
    fn round_trips_header_and_entries() {
        let root = temp_root();
        append_line_in(&root, "goose", "s1", &header_line("s1"));
        append_line_in(
            &root,
            "goose",
            "s1",
            &entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"hi"}])),
        );
        append_line_in(
            &root,
            "goose",
            "s1",
            &entry_line(
                EntryKind::Update,
                serde_json::json!({"sessionUpdate":"agent_message_chunk"}),
            ),
        );

        let t = read_transcript_in(&root, "goose", "s1");
        assert!(!t.is_empty());
        let header = t.header.clone().expect("header parsed");
        assert_eq!(header.agent, "custom:goose");
        assert_eq!(header.cwd, "/repo");
        assert_eq!(t.entries.len(), 2);
        assert_eq!(t.entries[0].k, EntryKind::Prompt);
        assert_eq!(t.entries[1].k, EntryKind::Update);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skips_malformed_lines_without_losing_the_rest() {
        let root = temp_root();
        append_line_in(&root, "goose", "s2", &header_line("s2"));
        // A truncated write (hard kill mid-append) plus outright garbage.
        append_line_in(&root, "goose", "s2", "{\"t\":123,\"k\":\"pro");
        append_line_in(&root, "goose", "s2", "not json at all");
        append_line_in(
            &root,
            "goose",
            "s2",
            &entry_line(EntryKind::Update, serde_json::json!({"a":1})),
        );

        let t = read_transcript_in(&root, "goose", "s2");
        assert!(t.header.is_some());
        assert_eq!(t.entries.len(), 1, "only the well-formed entry survives");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_file_reads_as_empty() {
        let root = temp_root();
        let t = read_transcript_in(&root, "goose", "never-written");
        assert!(t.header.is_none());
        assert!(t.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_unsafe_path_components() {
        let root = temp_root();
        assert!(transcript_path_in(&root, "..", "s").is_none());
        assert!(transcript_path_in(&root, "a/b", "s").is_none());
        assert!(transcript_path_in(&root, "goose", "../escape").is_none());
        assert!(transcript_path_in(&root, ".hidden", "s").is_none());
        assert!(transcript_path_in(&root, "goose", "s1").is_some());
        // An unsafe component must not create anything on disk.
        append_line_in(&root, "..", "s", &header_line("s"));
        assert!(read_transcript_in(&root, "..", "s").is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn lists_and_removes_session_transcripts() {
        let root = temp_root();
        append_line_in(&root, "goose", "beta", &header_line("beta"));
        append_line_in(&root, "goose", "alpha", &header_line("alpha"));
        assert_eq!(list_session_ids_in(&root, "goose"), vec!["alpha", "beta"]);

        remove_agent_transcripts_in(&root, "goose").unwrap();
        assert!(list_session_ids_in(&root, "goose").is_empty());
        // Removing a directory that never existed is a no-op, not an error.
        remove_agent_transcripts_in(&root, "goose").unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn continuation_chain_reads_as_one_conversation() {
        let root = temp_root();
        // Two restarts: s0 → s1 → s2, each continuing the previous.
        append_line_in(&root, "goose", "s0", &header_line("s0"));
        append_line_in(
            &root,
            "goose",
            "s0",
            &entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"first"}])),
        );
        for (id, prev, text) in [("s1", "s0", "second"), ("s2", "s1", "third")] {
            let header = TranscriptHeader::new("custom:goose", id, "/elsewhere", 9_999)
                .continuing(prev);
            append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
            append_line_in(
                &root,
                "goose",
                id,
                &entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":text}])),
            );
        }

        let merged = read_chain_in(&root, "goose", "s2");
        assert_eq!(merged.entries.len(), 3, "every link contributes its entries");
        let header = merged.header.expect("oldest header survives");
        assert_eq!(header.session_id, "s0", "the root header wins");
        assert_eq!(
            header.cwd, "/repo",
            "start time and cwd come from where the conversation actually began"
        );
        assert_eq!(header.started_at_ms, 1_750_000_000_000);

        // Reading a mid-chain id yields only its own prefix.
        assert_eq!(read_chain_in(&root, "goose", "s1").entries.len(), 2);
        assert_eq!(read_chain_in(&root, "goose", "s0").entries.len(), 1);

        // The superseded links are exactly the ones another transcript continues.
        let superseded = superseded_session_ids_in(&root, "goose");
        assert_eq!(superseded.len(), 2);
        assert!(superseded.contains("s0") && superseded.contains("s1"));
        assert!(!superseded.contains("s2"), "the head is never superseded");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn continuation_ancestors_lists_what_a_session_carries_forward() {
        // The session-binding guard reads this to tell "same conversation, new
        // agent session" from "an unrelated session landed on this row". Get it
        // wrong in the first direction and every restart of a memory-only
        // custom agent clones the conversation in the sidebar; wrong in the
        // second and the history it was supposed to protect is lost.
        let root = temp_root();
        append_line_in(&root, "goose", "s0", &header_line("s0"));
        for (id, prev) in [("s1", "s0"), ("s2", "s1")] {
            let header = TranscriptHeader::new("custom:goose", id, "/elsewhere", 9_999)
                .continuing(prev);
            append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
        }

        assert_eq!(
            continuation_ancestors_in(&root, "goose", "s2"),
            vec!["s1".to_string(), "s0".to_string()],
            "the whole chain, newest first — a bind may skip a link"
        );
        assert_eq!(
            continuation_ancestors_in(&root, "goose", "s1"),
            vec!["s0".to_string()]
        );
        assert!(
            continuation_ancestors_in(&root, "goose", "s0").is_empty(),
            "the root of a chain carries nothing forward"
        );
        assert!(
            continuation_ancestors_in(&root, "goose", "never-recorded").is_empty(),
            "an unknown session carries nothing forward — the caller must then \
             treat a rebind as unrelated and preserve the old history"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn continuation_ancestors_survives_a_cycle() {
        // Same guards as `read_chain_in`: a hand-edited or corrupted pair of
        // headers must not hang the bind path.
        let root = temp_root();
        for (id, prev) in [("a", "b"), ("b", "a")] {
            let header =
                TranscriptHeader::new("custom:goose", id, "/repo", 1).continuing(prev);
            append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
        }
        assert_eq!(
            continuation_ancestors_in(&root, "goose", "a"),
            vec!["b".to_string()],
            "the walk stops when it revisits the session it started from"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn continuation_walk_survives_a_cycle_and_a_missing_link() {
        let root = temp_root();
        // A hand-edited file pointing at itself must not hang the reader.
        let looped = TranscriptHeader::new("custom:goose", "loop", "/repo", 1).continuing("loop");
        append_line_in(&root, "goose", "loop", &serde_json::to_string(&looped).unwrap());
        append_line_in(
            &root,
            "goose",
            "loop",
            &entry_line(EntryKind::Update, serde_json::json!({"a":1})),
        );
        assert_eq!(read_chain_in(&root, "goose", "loop").entries.len(), 1);

        // Pointing at a transcript the user deleted degrades to "no prefix",
        // never to an error or an empty result.
        let orphan =
            TranscriptHeader::new("custom:goose", "orphan", "/repo", 2).continuing("deleted");
        append_line_in(&root, "goose", "orphan", &serde_json::to_string(&orphan).unwrap());
        append_line_in(
            &root,
            "goose",
            "orphan",
            &entry_line(EntryKind::Update, serde_json::json!({"b":2})),
        );
        let merged = read_chain_in(&root, "goose", "orphan");
        assert_eq!(merged.entries.len(), 1);
        assert_eq!(
            merged.header.expect("own header stands in").session_id,
            "orphan"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn header_only_read_agrees_with_the_whole_file_parser() {
        let root = temp_root();
        // Normal file: header first, then entries.
        append_line_in(&root, "goose", "h1", &header_line("h1"));
        append_line_in(
            &root,
            "goose",
            "h1",
            &entry_line(EntryKind::Update, serde_json::json!({"a": 1})),
        );
        assert_eq!(
            read_header_in(&root, "goose", "h1"),
            read_transcript_in(&root, "goose", "h1").header
        );

        // A header preceded by junk is still found, exactly as the whole-file
        // parser finds it.
        append_line_in(&root, "goose", "h2", "not json at all");
        append_line_in(&root, "goose", "h2", &header_line("h2"));
        assert_eq!(
            read_header_in(&root, "goose", "h2"),
            read_transcript_in(&root, "goose", "h2").header
        );
        assert!(read_header_in(&root, "goose", "h2").is_some());

        // Headerless and missing files both yield nothing, not an error.
        append_line_in(
            &root,
            "goose",
            "h3",
            &entry_line(EntryKind::Prompt, serde_json::json!([])),
        );
        assert_eq!(read_header_in(&root, "goose", "h3"), None);
        assert_eq!(read_header_in(&root, "goose", "never-written"), None);
        // An unsafe component must not read anything.
        assert_eq!(read_header_in(&root, "..", "h1"), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn has_entries_sees_past_the_header_and_stops_at_the_first_entry() {
        let root = temp_root();
        // A session whose ACP header was written but which was closed before
        // the user sent anything: no entries.
        append_line_in(&root, "goose", "e1", &header_line("e1"));
        assert!(!has_entries_in(&root, "goose", "e1"));

        append_line_in(
            &root,
            "goose",
            "e1",
            &entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"hi"}])),
        );
        assert!(has_entries_in(&root, "goose", "e1"));

        // Garbage alone is not an entry, and a missing file is not either.
        append_line_in(&root, "goose", "e2", "not json at all");
        assert!(!has_entries_in(&root, "goose", "e2"));
        assert!(!has_entries_in(&root, "goose", "never-written"));
        assert!(!has_entries_in(&root, "..", "e1"));

        // Agrees with the whole-file parser on every file written above.
        for id in ["e1", "e2", "never-written"] {
            assert_eq!(
                has_entries_in(&root, "goose", id),
                !read_transcript_in(&root, "goose", id).is_empty(),
                "streaming and whole-file emptiness must agree for {id}"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_line_torn_mid_character_costs_only_that_line() {
        // `append_line_in` writes a line with a single `write_all`, so a hard
        // kill can cut it inside a multi-byte character — which is easy to hit
        // with CJK content. That must cost the torn line, not the whole
        // history, and every reader must agree on what survives.
        let root = temp_root();
        let path = transcript_path_in(&root, "goose", "torn").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut raw = Vec::new();
        raw.extend_from_slice(header_line("torn").as_bytes());
        raw.push(b'\n');
        raw.extend_from_slice(
            entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"你好"}]))
                .as_bytes(),
        );
        raw.push(b'\n');
        // A prompt line cut in the middle of a 3-byte character.
        let torn = entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"世界"}]));
        let cut = torn.find('世').unwrap() + 2;
        raw.extend_from_slice(&torn.as_bytes()[..cut]);
        std::fs::write(&path, &raw).unwrap();

        let transcript = read_transcript_in(&root, "goose", "torn");
        assert!(
            transcript.header.is_some(),
            "the header must survive a torn line later in the file"
        );
        assert_eq!(transcript.entries.len(), 1, "the intact prompt survives");

        // The streaming readers must reach the same conclusions, since they
        // return before ever seeing the torn bytes.
        assert_eq!(read_header_in(&root, "goose", "torn"), transcript.header);
        assert_eq!(
            has_entries_in(&root, "goose", "torn"),
            !transcript.is_empty()
        );

        // The same tear in the FIRST line: no header, and the readers still agree.
        let path2 = transcript_path_in(&root, "goose", "torn2").unwrap();
        let header = header_line("torn2");
        let cut2 = header.find("custom").unwrap() + 3;
        std::fs::write(&path2, &header.as_bytes()[..cut2]).unwrap();
        let t2 = read_transcript_in(&root, "goose", "torn2");
        assert_eq!(read_header_in(&root, "goose", "torn2"), t2.header);
        assert_eq!(has_entries_in(&root, "goose", "torn2"), !t2.is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupt_link_cannot_hide_the_conversation_it_continues() {
        // `superseded_session_ids_in` reads headers only. If it could see a
        // header that the full read does not, it would hide `old` while `new`
        // read as empty — losing both from the listing.
        let root = temp_root();
        let path = transcript_path_in(&root, "goose", "new").unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let header =
            serde_json::to_string(&TranscriptHeader::new("custom:goose", "new", "/repo", 1).continuing("old"))
                .unwrap();
        let mut raw = Vec::from(header.as_bytes());
        raw.push(b'\n');
        raw.extend_from_slice(&[0xff, 0xfe, b'\n']);
        std::fs::write(&path, &raw).unwrap();

        append_line_in(&root, "goose", "old", &header_line("old"));
        append_line_in(
            &root,
            "goose",
            "old",
            &entry_line(EntryKind::Prompt, serde_json::json!([{"type":"text","text":"hi"}])),
        );

        // `new` is readable despite the garbage line, so `old` is legitimately
        // superseded and its turns are reachable through the chain.
        assert!(superseded_session_ids_in(&root, "goose").contains("old"));
        assert_eq!(read_chain_in(&root, "goose", "new").entries.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn headers_written_before_continuation_existed_still_parse() {
        // A v1 header from before `continues_from` was added: the field is
        // absent, not null, and must not fail the parse.
        let legacy = r#"{"v":1,"kind":"header","agent":"custom:glm-acp-agent","session_id":"8e73","cwd":"/repo","started_at_ms":1785023133723}"#;
        let parsed = parse_transcript(legacy);
        let header = parsed.header.expect("legacy header parses");
        assert_eq!(header.session_id, "8e73");
        assert_eq!(header.continues_from, None);
    }

    #[tokio::test]
    async fn header_is_written_once_per_session() {
        let root = temp_root();
        let first = TranscriptHeader::new("custom:goose", "s3", "/repo", 1);
        record_header_in(&root, "goose", &first).await.unwrap();

        // A reconnect, and — the case the old filesystem probe could not see —
        // a second attempt racing one that has not been written yet.
        let second = TranscriptHeader::new("custom:goose", "s3", "/other", 2);
        let third = TranscriptHeader::new("custom:goose", "s3", "/elsewhere", 3);
        let (a, b) = (
            record_header_in(&root, "goose", &second),
            record_header_in(&root, "goose", &third),
        );
        a.await.unwrap();
        b.await.unwrap();

        let raw = std::fs::read_to_string(transcript_path_in(&root, "goose", "s3").unwrap())
            .unwrap();
        assert_eq!(
            raw.lines().filter(|l| parse_header_line(l).is_some()).count(),
            1,
            "exactly one header, no matter how many reconnects raced"
        );
        assert_eq!(
            read_transcript_in(&root, "goose", "s3").header.unwrap().cwd,
            "/repo",
            "a reconnect must not overwrite the original header"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    // ---- write-behind ----------------------------------------------------
    //
    // The invariant every one of these defends: whatever `compact_batch`
    // writes, `project_turns` must read back as though nothing had been
    // merged. Cases 1 and 3 are the two paths where an earlier design of this
    // silently shifted a turn's timing.

    /// Run a script of records through the writer's batching and return what
    /// the reader would make of the file, both ways.
    fn projected_both_ways(
        records: Vec<PendingRecord>,
        batches: &[usize],
    ) -> (Vec<MessageTurn>, Vec<MessageTurn>) {
        let verbatim: Vec<TranscriptEntry> = records
            .iter()
            .filter_map(|r| match r {
                PendingRecord::Entry(e) => Some(e.clone()),
                PendingRecord::Header(_) => None,
            })
            .collect();

        // Serialize through `compact_batch` exactly as the writer does, split
        // across flush windows at the given boundaries.
        let mut compactable = false;
        let mut written = String::new();
        let mut rest: Vec<Queued> = records.into_iter().map(queued).collect();
        let mut cuts: Vec<usize> = batches.to_vec();
        cuts.push(usize::MAX);
        for cut in cuts {
            if rest.is_empty() {
                break;
            }
            let take = cut.min(rest.len());
            let batch: Vec<Queued> = rest.drain(..take).collect();
            let (lines, next) = compact_batch(&batch, compactable);
            compactable = next;
            written.push_str(&lines);
        }
        let compacted = parse_transcript(&written).entries;
        (project_turns(&verbatim), project_turns(&compacted))
    }

    /// A record as the writer holds it. The tests exercise `compact_batch`,
    /// which never touches the ack or the gate guard, so both are inert here.
    fn queued(record: PendingRecord) -> Queued {
        Queued {
            record,
            ack: tokio::sync::oneshot::channel().0,
            _prompt_guard: None,
        }
    }

    fn chunk(t: u64, kind: &str, text: &str) -> PendingRecord {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Update,
            p: serde_json::json!({
                "sessionUpdate": kind,
                "content": { "type": "text", "text": text }
            }),
        })
    }

    fn prompt_record(t: u64, text: &str) -> PendingRecord {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Prompt,
            p: serde_json::json!([{ "type": "text", "text": text }]),
        })
    }

    fn turn_end(t: u64) -> PendingRecord {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::TurnEnd,
            p: serde_json::json!({ "stopReason": "end_turn" }),
        })
    }

    /// Compared as serialized turns rather than field by field: the claim being
    /// defended is that NOTHING the frontend receives changes, so leaving a
    /// field out of the comparison would be leaving a hole in the claim.
    fn assert_same_projection(records: Vec<PendingRecord>, batches: &[usize], what: &str) {
        let (verbatim, compacted) = projected_both_ways(records, batches);
        assert_eq!(
            serde_json::to_value(&verbatim).unwrap(),
            serde_json::to_value(&compacted).unwrap(),
            "merging changed the projection: {what}"
        );
    }

    #[test]
    fn merging_streamed_text_leaves_the_projection_identical() {
        let tool = |t: u64, id: &str, status: &str| {
            PendingRecord::Entry(TranscriptEntry {
                t,
                k: EntryKind::Update,
                p: serde_json::json!({
                    "sessionUpdate": "tool_call", "toolCallId": id,
                    "title": "Bash", "kind": "execute", "status": status
                }),
            })
        };
        let image = |t: u64| {
            PendingRecord::Entry(TranscriptEntry {
                t,
                k: EntryKind::Update,
                p: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "image", "data": "AAA", "mimeType": "image/png"}
                }),
            })
        };
        let link = |t: u64| {
            PendingRecord::Entry(TranscriptEntry {
                t,
                k: EntryKind::Update,
                p: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "resource_link", "uri": "file:///a", "name": "a"}
                }),
            })
        };

        assert_same_projection(vec![prompt_record(1, "hi"), turn_end(9)], &[], "empty turn");
        assert_same_projection(
            vec![
                prompt_record(1, "hi"),
                chunk(2, "agent_message_chunk", "he"),
                chunk(3, "agent_message_chunk", "ll"),
                chunk(4, "agent_message_chunk", "o"),
                turn_end(9),
            ],
            &[],
            "plain streamed text",
        );
        assert_same_projection(
            vec![
                prompt_record(1, "hi"),
                chunk(2, "agent_thought_chunk", "let me "),
                chunk(3, "agent_thought_chunk", "think"),
                chunk(4, "agent_message_chunk", "a"),
                tool(5, "c1", "pending"),
                chunk(6, "agent_message_chunk", "b"),
                chunk(7, "agent_message_chunk", "c"),
                turn_end(9),
            ],
            &[],
            "text and tools interleaved (a tool ends a run)",
        );
        assert_same_projection(
            vec![
                prompt_record(1, "hi"),
                chunk(2, "agent_message_chunk", "a"),
                image(3),
                chunk(4, "agent_message_chunk", "b"),
                link(5),
                chunk(6, "agent_message_chunk", "c"),
                turn_end(9),
            ],
            &[],
            "image and resource-link chunks are never folded into text",
        );
        // Split across flush windows at every boundary: a run cut in half must
        // still read back as one block with the same end time.
        for cut in 1..=6 {
            assert_same_projection(
                vec![
                    prompt_record(1, "hi"),
                    chunk(2, "agent_message_chunk", "a"),
                    chunk(3, "agent_message_chunk", "b"),
                    chunk(4, "agent_message_chunk", "c"),
                    chunk(5, "agent_message_chunk", "d"),
                    turn_end(9),
                ],
                &[cut],
                "run split across flush windows",
            );
        }
        assert_same_projection(
            vec![
                prompt_record(1, "one"),
                chunk(2, "agent_message_chunk", "a"),
                turn_end(3),
                prompt_record(4, "two"),
                chunk(5, "agent_message_chunk", "b"),
                turn_end(6),
            ],
            &[3],
            "consecutive turns",
        );
    }

    /// The path that broke an earlier design of this: a `user_message_chunk`
    /// arriving mid-turn flushes the assistant turn BEFORE any `TurnEnd`, so
    /// that turn's end time can only come from its last chunk. Taking the first
    /// chunk's timestamp instead silently compressed the reported duration.
    #[test]
    fn a_turn_flushed_by_a_mid_turn_user_chunk_keeps_its_end_time() {
        let records = vec![
            prompt_record(1_000, "hi"),
            chunk(1_100, "agent_message_chunk", "wor"),
            chunk(1_900, "agent_message_chunk", "king"),
            chunk(2_500, "user_message_chunk", "wait"),
            turn_end(3_000),
        ];
        assert_same_projection(records, &[], "mid-turn user chunk");

        // And pin the value itself, so "identical to verbatim" cannot become
        // "identically wrong".
        let (verbatim, _) = projected_both_ways(
            vec![
                prompt_record(1_000, "hi"),
                chunk(1_100, "agent_message_chunk", "wor"),
                chunk(1_900, "agent_message_chunk", "king"),
                chunk(2_500, "user_message_chunk", "wait"),
                turn_end(3_000),
            ],
            &[],
        );
        let assistant = verbatim
            .iter()
            .find(|t| matches!(t.role, TurnRole::Assistant))
            .expect("assistant turn");
        assert_eq!(assistant.duration_ms, Some(900), "1_900 - 1_000");
    }

    /// `user_message_chunk` is excluded from merging because its first and last
    /// timestamps mean different things: the first fixes the user turn's own
    /// timestamp, the last fixes where the NEXT assistant turn starts. One
    /// merged record cannot carry both.
    #[test]
    fn consecutive_user_chunks_keep_both_of_their_timestamps() {
        let records = vec![
            prompt_record(1_000, "hi"),
            chunk(1_100, "agent_message_chunk", "a"),
            chunk(2_000, "user_message_chunk", "one "),
            chunk(2_100, "user_message_chunk", "two "),
            chunk(2_200, "user_message_chunk", "three"),
            chunk(2_400, "agent_message_chunk", "b"),
            turn_end(3_000),
        ];
        assert_same_projection(records, &[], "consecutive user chunks");
    }

    /// A `session/load` replay has no prompts and no turn ends, so it is never
    /// compactable and must land byte-for-byte. (It is already merged — the
    /// replay of a 32-record turn is one record — so there is nothing to gain.)
    #[test]
    fn a_replay_is_recorded_verbatim() {
        let records = vec![
            chunk(1, "user_message_chunk", "hello"),
            chunk(2, "agent_message_chunk", "hi"),
            chunk(3, "agent_message_chunk", " there"),
            chunk(4, "user_message_chunk", "more"),
            chunk(5, "agent_message_chunk", "ok"),
        ];
        let pending: Vec<Queued> = records
            .iter()
            .map(|r| match r {
                PendingRecord::Entry(e) => queued(PendingRecord::Entry(e.clone())),
                PendingRecord::Header(_) => unreachable!(),
            })
            .collect();
        let (lines, compactable) = compact_batch(&pending, false);
        assert!(!compactable, "a replay never turns compaction on");
        assert_eq!(
            parse_transcript(&lines).entries.len(),
            5,
            "every replayed record survives"
        );
        assert_same_projection(records, &[], "replay");
    }

    /// A turn the agent runs on its own between prompts (issue #903) has no
    /// prompt to fix its start, so it starts at its FIRST chunk — and must land
    /// unmerged like a replay: a merged record carries the run's last
    /// timestamp, which would start the turn where it ended.
    #[test]
    fn a_turn_the_agent_runs_between_prompts_keeps_its_start_time() {
        let records = || {
            vec![
                prompt_record(1_000, "start the job"),
                chunk(1_100, "agent_message_chunk", "Started."),
                turn_end(1_200),
                chunk(5_000, "agent_message_chunk", "The job "),
                chunk(5_400, "agent_message_chunk", "finished."),
                prompt_record(9_000, "thanks"),
                chunk(9_100, "agent_message_chunk", "Welcome."),
                turn_end(9_200),
            ]
        };
        // All in one flush window: the batch a merge could reach.
        assert_same_projection(records(), &[], "a turn of the agent's own");

        let (verbatim, _) = projected_both_ways(records(), &[]);
        let own = &verbatim[2];
        assert!(matches!(own.role, TurnRole::Assistant));
        assert_eq!(own.timestamp.timestamp_millis(), 5_000);
        assert_eq!(own.duration_ms, Some(400));
    }

    /// Chunks carrying different `_meta` are opaque extension data; merging
    /// them would silently keep one and discard the rest.
    #[test]
    fn chunks_with_differing_meta_are_not_merged() {
        let with_meta = |t: u64, meta: serde_json::Value| {
            PendingRecord::Entry(TranscriptEntry {
                t,
                k: EntryKind::Update,
                p: serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": "x"},
                    "_meta": meta
                }),
            })
        };
        let pending: Vec<Queued> = vec![
            prompt_record(1, "hi"),
            with_meta(2, serde_json::json!({"a": 1})),
            with_meta(3, serde_json::json!({"a": 1})),
            with_meta(4, serde_json::json!({"a": 2})),
        ]
        .into_iter()
        .map(queued)
        .collect();
        let (lines, _) = compact_batch(&pending, false);
        let entries = parse_transcript(&lines).entries;
        assert_eq!(
            entries.len(),
            3,
            "prompt + the merged equal-meta pair + the differing one"
        );
        assert_eq!(entries[1].p["_meta"], serde_json::json!({"a": 1}));
        assert_eq!(entries[2].p["_meta"], serde_json::json!({"a": 2}));
    }

    /// The frontend refetches conversation detail the moment a turn completes,
    /// so everything buffered during the turn has to be on disk by the time the
    /// turn end's ack resolves — that ack is exactly what `record_turn_end`
    /// bound-waits on. This drives the real writer end to end: fire-and-forget
    /// chunks, one awaited boundary, then read it back.
    #[tokio::test]
    async fn a_completed_turn_is_whole_as_soon_as_its_turn_end_lands() {
        let root = temp_root();
        record_header_in(
            &root,
            "goose",
            &TranscriptHeader::new("custom:goose", "turn", "/repo", 1),
        )
        .await
        .unwrap();
        record_entry_in(
            &root,
            "goose",
            "turn",
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "hi" }]),
        )
        .await
        .unwrap();
        // Streamed chunks are fire-and-forget, exactly as the live path records
        // them — the read loop must never wait on the disk.
        let mut expected = String::new();
        for i in 0..50 {
            let word = format!("w{i} ");
            expected.push_str(&word);
            drop(record_entry_in(
                &root,
                "goose",
                "turn",
                EntryKind::Update,
                serde_json::json!({
                    "sessionUpdate": "agent_message_chunk",
                    "content": { "type": "text", "text": word }
                }),
            ));
        }
        record_entry_in(
            &root,
            "goose",
            "turn",
            EntryKind::TurnEnd,
            serde_json::json!({ "stopReason": "end_turn" }),
        )
        .await
        .unwrap();

        let path = transcript_path_in(&root, "goose", "turn").unwrap();
        let written = std::fs::read_to_string(&path).unwrap();
        assert!(
            written.lines().count() <= 4,
            "50 chunks should have been merged, not written one per line; got:\n{written}"
        );

        let turns = project_turns(&read_transcript_in(&root, "goose", "turn").entries);
        assert_eq!(turns.len(), 2, "one user turn and one assistant turn");
        match &turns[1].blocks[0] {
            crate::models::message::ContentBlock::Text { text } => {
                assert_eq!(*text, expected, "no chunk was lost to the merge")
            }
            other => panic!("expected text, got {other:?}"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A write that cannot even begin must cost nothing: the batch and its acks
    /// stay pending, the retry writes them in order, and no caller is told a
    /// record landed when it did not.
    #[tokio::test]
    async fn records_survive_a_failing_writer_and_land_in_order_once_it_recovers() {
        let root = temp_root();
        // Block the agent's directory with a regular file, so `create_dir_all`
        // — the first thing a flush does — fails.
        std::fs::write(root.join("goose"), b"in the way").unwrap();

        let mut acks = Vec::new();
        for i in 0..4 {
            acks.push(record_entry_in(
                &root,
                "goose",
                "wedged",
                EntryKind::Prompt,
                serde_json::json!([{ "type": "text", "text": format!("p{i}") }]),
            ));
        }
        // Nothing may be acked while the writes cannot happen.
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        for ack in &mut acks {
            assert!(
                ack.try_recv().is_err(),
                "a record still buffered must not report as landed"
            );
        }

        std::fs::remove_file(root.join("goose")).unwrap();
        for ack in acks {
            tokio::time::timeout(std::time::Duration::from_secs(10), ack)
                .await
                .expect("retry happens within a few flush windows")
                .expect("and reports success");
        }

        let entries = read_transcript_in(&root, "goose", "wedged").entries;
        assert_eq!(entries.len(), 4, "every buffered record landed exactly once");
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(
                entry.p[0]["text"], format!("p{i}"),
                "and in the order they were recorded"
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The replay gate must not depend on how fast the disk is.
    ///
    /// A prompt that is queued but not yet written is invisible to the FILE, so
    /// a gate reading only the file would decide this conversation has no
    /// transcript, record the agent's `session/load` replay, and leave two
    /// copies of the same history — permanently, since the gate reads non-empty
    /// forever after. Awaiting the ack shrinks that window but cannot close it,
    /// because the wait is bounded so a wedged disk can never hang a turn.
    ///
    /// The writer is held up here by occupying its directory with a regular
    /// file, so every flush fails at `create_dir_all`. That stands in for the
    /// real causes (a slow disk, a queue backed up behind another session) and
    /// makes a microseconds-wide window deterministic.
    #[tokio::test]
    async fn the_replay_gate_counts_a_queued_prompt_as_history() {
        let root = temp_root();
        std::fs::write(root.join("goose"), b"in the way").unwrap();

        assert!(
            !has_recorded_history_in(&root, "goose", "race"),
            "nothing recorded yet, so a replay would be this conversation's \
             only history and must be allowed"
        );

        let ack = record_entry_in(
            &root,
            "goose",
            "race",
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "hi" }]),
        );
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(
            !has_entries_in(&root, "goose", "race"),
            "the file really is still empty — this is the window the gate has \
             to survive, not a hypothetical"
        );
        assert!(
            has_recorded_history_in(&root, "goose", "race"),
            "and the gate must refuse the replay anyway: this prompt is going \
             to land, and a replay recorded now would duplicate it"
        );

        std::fs::remove_file(root.join("goose")).unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(10), ack)
            .await
            .expect("the retry lands within a few flush windows")
            .expect("and reports success");
        assert!(
            has_entries_in(&root, "goose", "race"),
            "the prompt is now in the file"
        );
        assert!(
            has_recorded_history_in(&root, "goose", "race"),
            "and the gate still says so once the guard is gone"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    /// A prompt that can never land must not block the session forever.
    ///
    /// The gate is conservative while a prompt is in flight, so a count leaked
    /// on any of the paths where a record is discarded would permanently deny
    /// that session a replay it may genuinely need. The count is held by an
    /// RAII guard precisely so every such path releases it.
    #[tokio::test]
    async fn a_discarded_prompt_stops_counting_as_history() {
        let root = temp_root();
        let path = transcript_path_in(&root, "goose", "dropped").unwrap();
        // Never enqueued anywhere: taking and dropping the guard is exactly
        // what the discard paths do.
        {
            let _guard = PendingPromptGuard::new(&path);
            assert!(has_recorded_history_in(&root, "goose", "dropped"));
        }
        assert!(
            !has_recorded_history_in(&root, "goose", "dropped"),
            "a record that will never land must release its claim"
        );

        // Nested guards for one session unwind independently.
        {
            let _a = PendingPromptGuard::new(&path);
            {
                let _b = PendingPromptGuard::new(&path);
            }
            assert!(
                has_recorded_history_in(&root, "goose", "dropped"),
                "one prompt still outstanding"
            );
        }
        assert!(!has_recorded_history_in(&root, "goose", "dropped"));
        let _ = std::fs::remove_dir_all(&root);
    }

    /// The gate that keeps a `session/load` replay from appending a second copy
    /// of history codeg already has. It reads the file, so a prompt sitting in
    /// the writer's buffer would make it answer "empty" and let the replay in.
    #[tokio::test]
    async fn a_continuation_link_is_readable_as_soon_as_its_ack_resolves() {
        // The session-binding guard reads the chain from disk to decide whether
        // a new agent session continues an existing conversation or is
        // unrelated. Headers are written by a background thread, so the
        // recovery path AWAITS this ack before emitting `SessionStarted` —
        // otherwise a subscriber can read an empty chain, call the sessions
        // unrelated, and split the conversation into a duplicate row that
        // nothing ever removes.
        //
        // This pins the half that makes that await meaningful: once the ack
        // resolves, the link IS visible to the reader.
        let root = temp_root();
        record_header_in(
            &root,
            "goose",
            &TranscriptHeader::new("custom:goose", "s0", "/repo", 1),
        )
        .await
        .unwrap();
        record_header_in(
            &root,
            "goose",
            &TranscriptHeader::new("custom:goose", "s1", "/repo", 2).continuing("s0"),
        )
        .await
        .unwrap();

        assert_eq!(
            continuation_ancestors_in(&root, "goose", "s1"),
            vec!["s0".to_string()],
            "an acked continuation header must be readable immediately"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn a_prompt_is_on_disk_before_its_ack_resolves() {
        let root = temp_root();
        record_header_in(
            &root,
            "goose",
            &TranscriptHeader::new("custom:goose", "gate", "/repo", 1),
        )
        .await
        .unwrap();
        assert!(
            !has_entries_in(&root, "goose", "gate"),
            "a header alone is not history"
        );

        record_entry_in(
            &root,
            "goose",
            "gate",
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "hi" }]),
        )
        .await
        .unwrap();
        assert!(
            has_entries_in(&root, "goose", "gate"),
            "a sent prompt must be visible to the replay gate immediately"
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
