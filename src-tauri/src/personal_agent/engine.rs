//! The personal agent's engine: the one place that decides when its session
//! starts, what each delivery carries, when to compact, and what lands on the
//! timeline.
//!
//! ## Turns
//!
//! The engine sends one prompt at a time and settles it from the event bus.
//! A prompt is either a **delivery** (the queued owner messages and events, as
//! one batch) or a **compaction** (the agent's compact command on its own).
//! Each is recorded as a `personal_agent_batch` row, so after a restart the
//! engine can tell an interrupted delivery (its owner messages are offered for
//! resending, its events put back once) from an interrupted compaction (its
//! batch was never sent: the messages stay queued).
//!
//! A turn's `TurnComplete` is recognized by its envelope `seq`: above the
//! connection's `event_seq` at the moment the prompt was sent, and above the
//! fence left by the last settled turn. The fence is what keeps a second
//! `TurnComplete` of the same turn (the cancel path emits its own) or one that
//! arrived after the liveness tick already settled the turn from the
//! connection's state from settling the NEXT turn.
//!
//! ## Liveness
//!
//! The bus is lossy, and a dying connection may emit no `TurnComplete` at all,
//! so a tick also checks the connection itself: gone means interrupted, and a
//! turn that is no longer in flight means its end was missed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, Notify};
use tokio::time::MissedTickBehavior;

use super::cards::{self, AssistantLine, ItemLine, OwnerLine, RecentLine};
use super::compaction::{self, PreDelivery, Streaks};
use super::dispatch::DispatchConn;
use super::workdir;
use super::{DISPATCH_OWNER_LABEL, OWNER_LABEL};
use crate::acp::manager::ConnectionManager;
use crate::acp::reply_turn::{ReplySnapshot, ReplyStep};
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope, PromptInputBlock};
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::entities::personal_agent_batch::{BatchKind, BatchStatus, BatchTrigger};
use crate::db::entities::personal_agent_item::ItemStatus;
use crate::db::entities::personal_agent_segment::{self as segment_entity, SegmentReason};
use crate::db::entities::personal_agent_timeline::{OwnerStatus, TimelineKind};
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewRow, ReadMark};
use crate::db::AppDatabase;
use crate::models::personal_agent::{
    CompactCheck, CompactInitiator, EngineHost, LiveReply, PersonalAgentChange, PersonalAgentInfo,
    PersonalAgentSettings, PersonalAgentSnapshot, PersonalAgentStatus, SegmentInfo, TimelineRow,
    TurnInfo, UsageReading,
};
use crate::models::system::{AppLocale, LanguageMode};
use crate::models::personal_agent_bots::BotAvatar;
use crate::models::{AgentType, AssistantAgentConfig, AssistantLabelSnapshot};
use crate::web::event_bridge::{emit_event, EventEmitter};
use crate::work_task::compact;

/// Channel of [`PersonalAgentChange`].
pub const PERSONAL_AGENT_CHANGED_EVENT: &str = "personal-agent://changed";

/// How often the liveness check looks at the turn in flight.
const LIVENESS_TICK: Duration = Duration::from_secs(5);
/// How often dispatched work is reconciled against its session or task.
const RECONCILE_TICK: Duration = Duration::from_secs(30);
/// How long a turn may look idle before the tick settles it: a prompt sent
/// into a connection still shaking hands sits in a channel for a moment.
const IDLE_GRACE: chrono::Duration = chrono::Duration::seconds(3);
/// Recent timeline rows a handoff card quotes.
const HANDOFF_RECENT_ROWS: u64 = 24;
/// Open matters a card lists.
const CARD_ITEMS: u64 = 40;
/// The least time between two pushes of the reply in flight.
const REPLY_PUSH_GAP: Duration = Duration::from_millis(100);
/// How often the reply in flight is written to its row while one step goes
/// on (every new step is written at once).
const REPLY_CHECKPOINT_EVERY: Duration = Duration::from_secs(2);
/// How much of a quoted row a delivery repeats.
const QUOTE_EXCERPT_CHARS: usize = 200;

/// The primary assistant's engine, when this process runs the assistants (it
/// holds the work-task engine). `None` everywhere else: the page is then
/// read-only.
pub fn engine() -> Option<Arc<PersonalAgentEngine>> {
    super::host::host().map(|h| h.primary())
}

/// The engine running the assistant `bot` (`None`: the primary) in this
/// process, when one does. A worker's engine is made the first time it is
/// asked for, when its row exists.
pub async fn engine_for(bot: Option<i32>) -> Option<Arc<PersonalAgentEngine>> {
    let host = super::host::host()?;
    host.engine_for(bot).await
}

/// What a segment owes the agent and how its compactions have gone. JSON on
/// the segment row, so a restart keeps it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SegmentState {
    /// The handoff card has not been delivered yet (a delivery carrying it was
    /// interrupted, or none was sent).
    #[serde(default)]
    pub handoff_pending: bool,
    /// The context was compacted; the next delivery carries the state card.
    #[serde(default)]
    pub needs_state_card: bool,
    /// The owner saved the persona or rules from the page.
    #[serde(default)]
    pub persona_resend: bool,
    /// The last delivery overflowed the context: compact before the next one,
    /// whatever the reading says.
    #[serde(default)]
    pub force_compact: bool,
    /// The forced compaction ran: one more overflow starts a new segment.
    #[serde(default)]
    pub overflow_compacted: bool,
    #[serde(default)]
    pub streaks: Streaks,
    #[serde(default)]
    pub handoff_trimmed: bool,
    /// For a worker: the fingerprint of the owner's profile (the primary's
    /// `USER.md`) it was last given; a change is sent at the next delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_digest: Option<String>,
    /// The owner's preferences as this segment's agent was last given them
    /// (`<codeg-prefs>`); a change is sent at the next delivery, with what
    /// changed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefs_given: Option<crate::models::personal_agent_prefs::Prefs>,
}

impl SegmentState {
    pub fn parse(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_default()
    }
}

/// A compaction in flight.
#[derive(Debug, Clone)]
struct CompactionRun {
    initiator: CompactInitiator,
    command: String,
    before: Option<UsageReading>,
    forced: bool,
}

/// Which cards a delivery carried, cleared from the segment only when it
/// completes.
#[derive(Debug, Clone, Copy, Default)]
struct Carried {
    handoff: bool,
    state_card: bool,
    persona: bool,
}

/// The prompt in flight on the personal agent's connection.
#[derive(Debug, Clone)]
struct ActiveTurn {
    batch_id: i32,
    segment_id: i32,
    kind: BatchKind,
    conn_id: String,
    /// The connection's `event_seq` when the prompt was sent: its completion
    /// is above it.
    start_seq: u64,
    started_at: DateTime<Utc>,
    owner_row_ids: Vec<i32>,
    compaction: Option<CompactionRun>,
    carried: Carried,
    /// The agent reported a full context during the turn.
    overflow: bool,
    /// The last (non-terminal) error reported during the turn.
    error: Option<String>,
    /// For a compaction: the first live reading reported after it started —
    /// the only after-value that describes the compacted session (the
    /// transcript is written behind, and would still read the old figure).
    usage_after: Option<UsageReading>,
    /// For a compaction: whether the agent's own compaction report (a
    /// `contextCompaction` tool call) said it worked, when it sent one.
    compaction_reported: Option<bool>,
    /// For a delivery: the agent compacted its own context during it, after
    /// this delivery's cards went in — what they carried may be gone again.
    agent_compacted: bool,
    /// For a delivery: its reply row, made when the turn started.
    reply_row_id: Option<i32>,
    /// For a delivery: the tag its prompt carried. The connection builds the
    /// turn's reply under it; it is how this turn's end is told from any
    /// other's.
    reply_token: Option<String>,
    /// For a delivery of one event and no message: the event's result card,
    /// which the reply quotes unless it names another row itself.
    auto_quote: Option<i32>,
    /// For a delivery: the batches whose ledger entries count as its own —
    /// itself, and those it re-delivers what they carried of.
    ledger_scope: Vec<i32>,
    /// For a delivery: the owner wrote while it ran and it carried no
    /// message of theirs, so it was told to stop and give way. When it
    /// stops, its events ride with the owner's message, not as a failure.
    preempted: bool,
}

/// How a turn ended.
#[derive(Debug, Clone)]
enum TurnEnd {
    /// The agent answered `TurnComplete` with this stop reason (or the
    /// liveness tick found the turn over, `None`).
    Completed(Option<String>),
    /// The connection went away mid-turn.
    Lost(String),
}

/// A delivery's reply as it stood when its end was decided — taken then, not
/// when it is settled: by then the next turn may have started on the
/// connection.
#[derive(Debug, Clone)]
enum ReplyCapture {
    /// The connection's own copy (every event applied, the last ones the
    /// engine had not read yet included).
    Live(Box<ReplySnapshot>),
    /// None to be had (the connection's state is gone): the last checkpoint
    /// on the reply row stands.
    Checkpoint,
}

/// What a settled reply is made of.
#[derive(Debug, Clone, Default)]
struct ReplyContent {
    text: String,
    last_text_n: Option<u32>,
    step_count: u32,
    quotes: Vec<i64>,
}

impl ReplyContent {
    fn from_snapshot(s: &ReplySnapshot) -> Self {
        Self {
            text: s.last_text.as_ref().map(|t| t.text.clone()).unwrap_or_default(),
            last_text_n: s.last_text.as_ref().map(|t| t.n),
            step_count: s.step_count,
            quotes: s.quotes.clone(),
        }
    }

    /// What a running reply row last recorded.
    fn from_checkpoint(data: Option<&str>) -> Self {
        let data = data
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_default();
        let last = data.get("last_text");
        Self {
            text: last
                .and_then(|t| t.get("text"))
                .and_then(|t| t.as_str())
                .unwrap_or_default()
                .to_string(),
            last_text_n: last
                .and_then(|t| t.get("n"))
                .and_then(|n| n.as_u64())
                .and_then(|n| u32::try_from(n).ok()),
            step_count: data
                .get("step_count")
                .and_then(|n| n.as_u64())
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0),
            quotes: data
                .get("quotes")
                .and_then(|q| q.as_array())
                .map(|q| q.iter().filter_map(|v| v.as_i64()).collect())
                .unwrap_or_default(),
        }
    }
}

/// How a reply ended, as its row records it.
#[derive(Debug, Clone)]
struct ReplyOutcome {
    /// `done` | `canceled` | `interrupted`.
    state: &'static str,
    /// Why an interrupted one did not finish: `connection`, `overflow`,
    /// `rejected`, `error`, `restart`.
    why: Option<&'static str>,
    stop_reason: Option<String>,
    error: Option<String>,
}

/// The pushes and checkpoints of the reply in flight.
#[derive(Default)]
struct ReplyPush {
    last_push: Option<tokio::time::Instant>,
    /// The row, step and moment of the last checkpoint.
    checkpoint_row: Option<i32>,
    checkpoint_n: Option<u32>,
    checkpoint_at: Option<tokio::time::Instant>,
    /// A checkpoint is due later for what the last push did not write.
    trailing: bool,
}

#[derive(Default)]
pub(super) struct EngineState {
    /// The personal agent's live connection, and the segment it belongs to.
    pub(super) connection_id: Option<String>,
    pub(super) connection_segment: Option<i32>,
    turn: Option<ActiveTurn>,
    /// `connection_id -> seq`: completions at or below are a settled turn's.
    fence: HashMap<String, u64>,
    last_check: Option<CompactCheck>,
    pub(super) last_error: Option<String>,
    /// Deliver the next batch without another compaction attempt.
    skip_compaction_once: bool,
    /// Agent compactions already recorded, by tool-call id.
    seen_compactions: HashSet<String>,
    /// Dispatched conversations, by `connection_id`.
    pub(super) dispatch_conns: HashMap<String, DispatchConn>,
    /// Ledger operations running in this process: a follow-up being sent,
    /// until the executor confirms it or its round ends (`ledger`).
    pub(super) live_ops: HashSet<String>,
    /// The input the brain named for its pending question (`for` on
    /// `ask_user_question`), by connection: one ask at a time per
    /// connection, so the next ask replaces it.
    pub(super) ask_for: HashMap<String, Option<String>>,
}

pub struct PersonalAgentEngine {
    /// The assistant this engine runs: a worker's id, or `None` for the
    /// primary — looked up, as it may not be set up yet.
    fixed_bot: Option<i32>,
    /// The host running it, and the other assistants (a message wakes its
    /// receiver). Empty for an engine of its own (tests).
    host: std::sync::Weak<super::host::EngineHost>,
    /// The primary's id once known (0 until then).
    bot_cache: AtomicI32,
    pub(super) db: AppDatabase,
    pub(super) manager: ConnectionManager,
    pub(super) emitter: EventEmitter,
    pub(super) data_dir: PathBuf,
    pub(super) state: Mutex<EngineState>,
    /// Serializes deliveries.
    pump_lock: Mutex<()>,
    /// Serializes starting queued dispatches.
    pub(super) dispatch_lock: Mutex<()>,
    /// A delivery was asked for while one ran: run again after it.
    pump_again: AtomicBool,
    wake: Notify,
    booted: AtomicBool,
    /// A push of the reply in flight is scheduled.
    reply_push_pending: AtomicBool,
    reply_push: Mutex<ReplyPush>,
}

impl PersonalAgentEngine {
    /// One assistant's runtime: a worker's (`fixed_bot`) or the primary's
    /// (`None`). Not booted: the host boots it (`boot`) and drives it
    /// (`drive`), and hands it the bus events that are its (`on_event`).
    pub(super) fn new(
        db: AppDatabase,
        manager: ConnectionManager,
        emitter: EventEmitter,
        data_dir: PathBuf,
        fixed_bot: Option<i32>,
        host: std::sync::Weak<super::host::EngineHost>,
    ) -> Arc<Self> {
        Arc::new(Self {
            fixed_bot,
            host,
            bot_cache: AtomicI32::new(0),
            db,
            manager,
            emitter,
            data_dir,
            state: Mutex::new(EngineState::default()),
            pump_lock: Mutex::new(()),
            dispatch_lock: Mutex::new(()),
            pump_again: AtomicBool::new(false),
            wake: Notify::new(),
            booted: AtomicBool::new(false),
            reply_push_pending: AtomicBool::new(false),
            reply_push: Mutex::new(ReplyPush::default()),
        })
    }

    /// An engine for tests: not published as the process global, already past
    /// boot.
    #[cfg(test)]
    pub(crate) fn new_for_test(db: AppDatabase, data_dir: PathBuf) -> Arc<Self> {
        Self::new_for_bot_test(db, data_dir, None)
    }

    /// An engine for tests running one given assistant (`None`: the primary).
    #[cfg(test)]
    pub(crate) fn new_for_bot_test(
        db: AppDatabase,
        data_dir: PathBuf,
        bot: Option<i32>,
    ) -> Arc<Self> {
        let engine = Self::new(
            db,
            ConnectionManager::new(),
            EventEmitter::Noop,
            data_dir,
            bot,
            std::sync::Weak::new(),
        );
        engine.booted.store(true, Ordering::SeqCst);
        engine
    }

    /// Run boot recovery, as `run` does first.
    #[cfg(test)]
    pub(crate) async fn boot_for_test(&self) {
        self.boot_reconcile().await;
    }

    /// Whether the turn in flight was asked to give way to the owner's
    /// message.
    #[cfg(test)]
    pub(crate) async fn preempting_for_test(&self) -> bool {
        self.state
            .lock()
            .await
            .turn
            .as_ref()
            .is_some_and(|t| t.preempted)
    }

    /// Hold the delivery lock, as a pump does while it delivers.
    #[cfg(test)]
    pub(crate) async fn hold_pump_for_test(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.pump_lock.lock().await
    }

    /// Put `rows` on the turn in flight as the owner messages it carries.
    #[cfg(test)]
    pub(crate) async fn set_turn_owner_rows_for_test(&self, rows: Vec<i32>) {
        if let Some(t) = self.state.lock().await.turn.as_mut() {
            t.owner_row_ids = rows;
        }
    }

    /// Put a turn on record on `conn`, as if its prompt had just gone out:
    /// a delivery (carrying the state card when `state_card`) or an
    /// automatic compaction (`forced` after an overflow).
    #[cfg(test)]
    pub(crate) async fn begin_turn_for_test(
        &self,
        conn: &str,
        segment_id: i32,
        batch_id: i32,
        kind: BatchKind,
        state_card: bool,
        forced: bool,
    ) {
        let mut st = self.state.lock().await;
        st.connection_id = Some(conn.to_string());
        st.connection_segment = Some(segment_id);
        st.turn = Some(ActiveTurn {
            batch_id,
            segment_id,
            kind,
            conn_id: conn.to_string(),
            start_seq: 0,
            started_at: Utc::now(),
            owner_row_ids: Vec::new(),
            compaction: (kind == BatchKind::Compaction).then(|| CompactionRun {
                initiator: CompactInitiator::Auto,
                command: "/compact".into(),
                before: None,
                forced,
            }),
            carried: Carried {
                state_card,
                ..Default::default()
            },
            overflow: false,
            error: None,
            usage_after: None,
            compaction_reported: None,
            agent_compacted: false,
            reply_row_id: None,
            reply_token: None,
            auto_quote: None,
            ledger_scope: vec![batch_id],
            preempted: false,
        });
    }

    /// Put a delivery on record on `conn` as `deliver` would after sending:
    /// its reply row made, its prompt tagged `token`.
    #[cfg(test)]
    pub(crate) async fn begin_delivery_for_test(
        &self,
        conn: &str,
        segment_id: i32,
        batch_id: i32,
        token: &str,
        start_seq: u64,
    ) -> i32 {
        let mut row = NewRow::new(TimelineKind::Reply, "");
        row.segment_id = Some(segment_id);
        row.batch_id = Some(batch_id);
        row.data = Some(serde_json::json!({ "state": "running", "started_at": Utc::now() }));
        let row = svc::insert_row(&self.db.conn, self.bot().await, row)
            .await
            .expect("reply row");
        let mut st = self.state.lock().await;
        st.connection_id = Some(conn.to_string());
        st.connection_segment = Some(segment_id);
        st.turn = Some(ActiveTurn {
            batch_id,
            segment_id,
            kind: BatchKind::Delivery,
            conn_id: conn.to_string(),
            start_seq,
            started_at: Utc::now(),
            owner_row_ids: Vec::new(),
            compaction: None,
            carried: Carried::default(),
            overflow: false,
            error: None,
            usage_after: None,
            compaction_reported: None,
            agent_compacted: false,
            reply_row_id: Some(row.id),
            reply_token: Some(token.to_string()),
            auto_quote: None,
            ledger_scope: vec![batch_id],
            preempted: false,
        });
        row.id
    }

    /// Apply a change of the brain's options as saving it would.
    #[cfg(test)]
    pub(crate) async fn apply_brain_change_for_test(
        &self,
        old: &AssistantAgentConfig,
        new: &AssistantAgentConfig,
    ) {
        self.apply_brain_change(old, new).await;
    }

    /// The batches a delivery re-delivering `direct` inherits the ledger of.
    #[cfg(test)]
    pub(crate) async fn ledger_ancestry_for_test(&self, direct: &[i32]) -> Vec<i32> {
        self.ledger_ancestry(direct).await
    }

    /// Make the turn in flight's ledger cover `scope` — a delivery that
    /// re-delivers those batches, say.
    #[cfg(test)]
    pub(crate) async fn set_ledger_scope_for_test(&self, scope: Vec<i32>) {
        if let Some(t) = self.state.lock().await.turn.as_mut() {
            t.ledger_scope = scope;
        }
    }

    /// Run one liveness check, as the tick does.
    #[cfg(test)]
    pub(crate) async fn liveness_for_test(&self) {
        self.liveness_tick().await;
    }

    /// Deliver what was read as waiting a moment ago (`events`), as a pump
    /// that read them before something changed does.
    #[cfg(test)]
    pub(crate) async fn deliver_read_earlier_for_test(
        &self,
        events: Vec<crate::db::entities::personal_agent_event::Model>,
    ) -> Result<(), String> {
        let row = self.agent_row().await.ok_or("no assistant")?;
        let session = self.ensure_session(&row).await?;
        self.deliver(&row, &session, Vec::new(), events).await
    }

    /// Whether a delivery asked to be built again.
    #[cfg(test)]
    pub(crate) fn pump_again_for_test(&self) -> bool {
        self.pump_again.load(Ordering::SeqCst)
    }

    /// Forget the turn in flight, as if it ended and was settled.
    #[cfg(test)]
    pub(crate) async fn clear_turn_for_test(&self) {
        self.state.lock().await.turn = None;
    }

    /// Whether a turn is on record.
    #[cfg(test)]
    pub(crate) async fn turn_in_flight_for_test(&self) -> bool {
        self.state.lock().await.turn.is_some()
    }

    /// Move the turn in flight's start back, past the liveness grace.
    #[cfg(test)]
    pub(crate) async fn backdate_turn_for_test(&self, secs: i64) {
        if let Some(t) = self.state.lock().await.turn.as_mut() {
            t.started_at -= chrono::Duration::seconds(secs);
        }
    }

    /// Hand one bus event to the engine, as its loop would.
    #[cfg(test)]
    pub(crate) async fn feed_for_test(self: &Arc<Self>, conn: &str, seq: u64, payload: AcpEvent) {
        self.on_event(&EventEnvelope {
            seq,
            connection_id: conn.to_string(),
            payload,
        })
        .await;
    }
}

impl PersonalAgentEngine {
    /// Boot recovery, once, before the engine is driven: a fresh process has
    /// no live connection, so whatever was running was interrupted.
    pub(super) async fn boot(&self) {
        self.boot_reconcile().await;
        self.booted.store(true, Ordering::SeqCst);
        self.nudge();
    }

    /// This engine's own loop: the wake signal and the ticks. The bus is the
    /// host's: it hands this engine the events that are its (`on_event`).
    pub(super) async fn drive(self: Arc<Self>) {
        let mut liveness = tokio::time::interval(LIVENESS_TICK);
        liveness.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut reconcile = tokio::time::interval(RECONCILE_TICK);
        reconcile.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = self.wake.notified() => {
                    let e = self.clone();
                    tokio::spawn(async move { e.pump().await });
                }
                _ = liveness.tick() => {
                    self.liveness_tick().await;
                    self.poll_task_dispatches().await;
                }
                _ = reconcile.tick() => self.reconcile_dispatches().await,
            }
        }
    }

    /// The bus dropped events: the reply is read from the connection's
    /// state, which missed nothing, and the liveness check settles a turn
    /// whose end went by.
    pub(super) async fn on_lagged(self: &Arc<Self>) {
        self.schedule_reply_push();
        self.liveness_tick().await;
    }

    /// Whether `conn_id` is this assistant's own connection or one of its
    /// dispatched conversations — the host asks before handing an event over.
    pub(super) async fn owns_connection(&self, conn_id: &str) -> bool {
        let st = self.state.lock().await;
        st.connection_id.as_deref() == Some(conn_id) || st.dispatch_conns.contains_key(conn_id)
    }

    /// The engine is retired (its assistant deleted): stop the turn in
    /// flight and end its connection. Its dispatched work is the runtime's
    /// and goes on.
    pub(super) async fn shutdown(&self) {
        let _ = self.cancel_turn().await;
        let conn = self.state.lock().await.connection_id.take();
        if let Some(c) = conn {
            let _ = self.manager.disconnect(&c).await;
        }
    }

    /// Ask for a delivery attempt. Cheap and idempotent.
    pub fn nudge(&self) {
        self.wake.notify_one();
    }

    // ── configuration ───────────────────────────────────────────────────────

    /// This engine's assistant's row, when it is set up (and not deleted).
    pub(super) async fn agent_row(&self) -> Option<agent_entity::Model> {
        let row = match self.fixed_bot {
            Some(id) => svc::get_bot(&self.db.conn, id).await,
            None => svc::primary_bot(&self.db.conn).await,
        }
        .ok()
        .flatten();
        if let (None, Some(r)) = (self.fixed_bot, row.as_ref()) {
            self.bot_cache.store(r.id, Ordering::SeqCst);
        }
        row
    }

    /// The id of this engine's assistant — what every one of its records is
    /// filed under. 0 while the primary is not set up: it has no records,
    /// and a write under 0 is refused.
    pub(super) async fn bot(&self) -> i32 {
        if let Some(id) = self.fixed_bot {
            return id;
        }
        let cached = self.bot_cache.load(Ordering::SeqCst);
        if cached > 0 {
            return cached;
        }
        self.agent_row().await.map(|r| r.id).unwrap_or(0)
    }

    /// The input the brain names for the question it is about to ask.
    pub(super) async fn note_ask_for(&self, conn_id: &str, for_input: Option<String>) {
        self.state
            .lock()
            .await
            .ask_for
            .insert(conn_id.to_string(), for_input);
    }

    /// Whether a turn is running.
    pub(super) async fn busy(&self) -> bool {
        self.state.lock().await.turn.is_some()
    }

    /// The host running this engine, when one does.
    pub(super) fn host_ref(&self) -> Option<Arc<super::host::EngineHost>> {
        self.host.upgrade()
    }

    /// Whether this engine runs the assistant `bot`.
    pub async fn serves(&self, bot: i32) -> bool {
        bot > 0 && self.bot().await == bot
    }

    pub(super) fn workdir_of(&self, row: &agent_entity::Model) -> PathBuf {
        workdir::workdir_of_bot(&self.data_dir, row)
    }

    pub(super) fn info_of(&self, row: &agent_entity::Model) -> Option<PersonalAgentInfo> {
        to_info(row, &self.workdir_of(row))
    }

    /// The id of this engine's assistant as far as it is known without
    /// asking the database: 0 before the primary is first read.
    fn bot_now(&self) -> i32 {
        self.fixed_bot
            .unwrap_or_else(|| self.bot_cache.load(Ordering::SeqCst))
    }

    /// Broadcast a change, naming the assistant it is about (`bot_id`; 0 is
    /// the primary before it is set up), so a page shows only its own.
    pub(super) fn emit(&self, change: PersonalAgentChange) {
        let bot = self.bot_now();
        emit_event(
            &self.emitter,
            PERSONAL_AGENT_CHANGED_EVENT,
            change_payload(bot, &change),
        );
        self.touch_live(bot);
    }

    /// The owner settled one of its matters from the page.
    pub fn emit_item(&self, id: i32) {
        self.emit(PersonalAgentChange::Item { id });
    }

    pub(super) fn emit_rows(&self, rows: Vec<TimelineRow>) {
        if !rows.is_empty() {
            self.emit(PersonalAgentChange::Timeline { rows });
        }
    }

    /// Write one timeline row and broadcast it.
    pub(super) async fn push_row(&self, row: NewRow) -> Option<TimelineRow> {
        match svc::insert_row(&self.db.conn, self.bot().await, row).await {
            Ok(m) => {
                let r = svc::to_row(m);
                self.emit_rows(vec![r.clone()]);
                Some(r)
            }
            Err(e) => {
                tracing::warn!("[personal_agent] timeline write failed: {e}");
                None
            }
        }
    }

    /// A marker row: segment boundaries, option changes, reconnects,
    /// compactions, turn outcomes. `marker` names it for the page; `body` is
    /// the English fallback.
    pub(super) async fn marker(
        &self,
        segment_id: Option<i32>,
        marker: &str,
        body: impl Into<String>,
        mut data: serde_json::Value,
    ) -> Option<TimelineRow> {
        if let Some(map) = data.as_object_mut() {
            map.insert("marker".into(), marker.into());
        } else {
            data = serde_json::json!({ "marker": marker });
        }
        let mut row = NewRow::new(TimelineKind::Marker, body);
        row.segment_id = segment_id;
        row.data = Some(data);
        self.push_row(row).await
    }

    // ── boot ────────────────────────────────────────────────────────────────

    /// A fresh process has no live connection, so every batch still running
    /// was interrupted. A delivery's owner messages are offered for resending
    /// and its events put back once; a compaction's batch was never sent, so
    /// nothing else changes.
    async fn boot_reconcile(&self) {
        let running = svc::running_batches(&self.db.conn, self.bot().await)
            .await
            .unwrap_or_default();
        for batch in running {
            let _ = svc::finish_batch(
                &self.db.conn,
                batch.id,
                BatchStatus::Interrupted,
                None,
                Some("interrupted by a restart".into()),
                None,
            )
            .await;
            if batch.kind == BatchKind::Delivery {
                self.interrupt_delivery(batch.id, Some(batch.segment_id), "restart")
                    .await;
            }
        }
        // The ledger first: a send that never went out puts its round back
        // before the dispatches still running are marked interrupted.
        self.boot_ledger().await;
        self.boot_dispatches().await;
    }

    /// Mark a delivery's owner messages interrupted and put its events back
    /// (unread again). Its reply row, still running when nothing settled it
    /// first (a restart), keeps what it last recorded.
    async fn interrupt_delivery(&self, batch_id: i32, segment_id: Option<i32>, why: &'static str) {
        if let Ok(Some(reply)) = svc::reply_row_of_batch(&self.db.conn, batch_id).await {
            if svc::reply_state(&reply) == Some("running") {
                let content = ReplyContent::from_checkpoint(reply.data.as_deref());
                self.settle_reply(
                    reply.id,
                    reply.created_at,
                    ReplyOutcome {
                        state: "interrupted",
                        why: Some(why),
                        stop_reason: None,
                        error: None,
                    },
                    content,
                    None,
                )
                .await;
            }
        }
        let owners = svc::owner_rows_of_batch(&self.db.conn, batch_id)
            .await
            .unwrap_or_default();
        let ids: Vec<i32> = owners.iter().map(|r| r.id).collect();
        let moved = svc::move_owner_rows(
            &self.db.conn,
            &ids,
            &[OwnerStatus::Delivered],
            OwnerStatus::Interrupted,
            None,
            None,
            ReadMark::Keep,
        )
        .await
        .unwrap_or_default();
        self.emit_rows(moved.into_iter().map(svc::to_row).collect());
        // Put back means not handled: the cards of exactly those are unread
        // again; an event already put back once is settled, and stays read.
        // A turn that gave way to the owner's message put everything back,
        // with no requeue counted: giving way is not the failure that rule
        // is about.
        let back = if why == "preempted" {
            svc::yield_batch_events(&self.db.conn, batch_id).await
        } else {
            svc::requeue_batch_events(&self.db.conn, batch_id).await
        }
        .unwrap_or_default();
        let unread = svc::set_result_rows_read(&self.db.conn, self.bot().await, &back, None)
            .await
            .unwrap_or_default();
        self.emit_rows(unread.into_iter().map(svc::to_row).collect());
        self.marker(
            segment_id,
            "turn_interrupted",
            "The turn did not finish.",
            serde_json::json!({ "batch_id": batch_id, "why": why }),
        )
        .await;
    }

    // ── events ──────────────────────────────────────────────────────────────

    pub(super) async fn on_event(self: &Arc<Self>, env: &EventEnvelope) {
        let (is_mine, dispatch_id) = {
            let st = self.state.lock().await;
            (
                st.connection_id.as_deref() == Some(env.connection_id.as_str()),
                st.dispatch_conns.get(&env.connection_id).map(|c| c.id),
            )
        };
        if is_mine {
            self.schedule_reply_push();
            self.on_own_event(env).await;
        } else if let Some(id) = dispatch_id {
            self.on_dispatch_event(id, env).await;
        }
    }

    async fn on_own_event(&self, env: &EventEnvelope) {
        match &env.payload {
            AcpEvent::TurnComplete { stop_reason, .. } => {
                let (ours, token) = {
                    let st = self.state.lock().await;
                    let fenced = st
                        .fence
                        .get(&env.connection_id)
                        .is_some_and(|mark| env.seq <= *mark);
                    let ours = matches!(&st.turn, Some(t) if t.conn_id == env.connection_id
                        && env.seq > t.start_seq)
                        && !fenced;
                    (ours, st.turn.as_ref().and_then(|t| t.reply_token.clone()))
                };
                if !ours {
                    return;
                }
                let end = TurnEnd::Completed(Some(stop_reason.clone()));
                let Some(token) = token else {
                    // A compaction: its prompt carries no tag, and the seq
                    // and the fence tell its end.
                    self.finish_turn(end, Some(env.seq), ReplyCapture::Checkpoint)
                        .await;
                    return;
                };
                // A delivery ends with ITS prompt's turn only: the reply the
                // connection built under its tag was sealed by this very
                // event. A completion the connection emitted for another turn
                // — Grok's own, closed just before this prompt started — is
                // not it, nor one of a prompt sent from elsewhere.
                let Some(state) = self.manager.get_state(&env.connection_id).await else {
                    // Gone: the liveness check settles it as lost.
                    return;
                };
                let snapshot = state.read().await.reply_turns.snapshot(&token);
                match snapshot {
                    Some(s) if s.completed_seq == Some(env.seq) => {
                        self.finish_turn(end, Some(env.seq), ReplyCapture::Live(Box::new(s)))
                            .await;
                    }
                    // Sealed by an earlier completion the bus dropped: the
                    // turn is over all the same, and its own completion
                    // said how.
                    Some(s) if s.completed_seq.is_some_and(|sealed| sealed < env.seq) => {
                        let end = TurnEnd::Completed(s.stop_reason.clone());
                        self.finish_turn(end, Some(env.seq), ReplyCapture::Live(Box::new(s)))
                            .await;
                    }
                    _ => {}
                }
            }
            AcpEvent::Error {
                message,
                code,
                terminal,
                ..
            } => {
                let overflow = compaction::looks_like_context_overflow(message, code.as_deref());
                {
                    let mut st = self.state.lock().await;
                    if let Some(turn) = st.turn.as_mut() {
                        turn.error = Some(message.clone());
                        turn.overflow |= overflow;
                    }
                    st.last_error = Some(message.clone());
                }
                if *terminal {
                    let capture = self.capture_reply(&env.connection_id).await;
                    self.finish_turn(TurnEnd::Lost(message.clone()), None, capture)
                        .await;
                    self.drop_connection(&env.connection_id).await;
                }
                self.emit(PersonalAgentChange::Status);
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected | ConnectionStatus::Error,
            } => {
                let capture = self.capture_reply(&env.connection_id).await;
                self.finish_turn(
                    TurnEnd::Lost("the connection was lost".into()),
                    None,
                    capture,
                )
                .await;
                self.drop_connection(&env.connection_id).await;
                self.emit(PersonalAgentChange::Status);
            }
            AcpEvent::UsageUpdate { used, size } => {
                let reading = compact::occupancy_percent(Some(*used), Some(*size)).map(|percent| {
                    UsageReading {
                        percent,
                        used: Some(*used),
                        size: Some(*size),
                        source: "live",
                    }
                });
                let mut st = self.state.lock().await;
                if let Some(turn) = st.turn.as_mut() {
                    if turn.kind == BatchKind::Compaction && turn.usage_after.is_none() {
                        turn.usage_after = reading;
                    }
                }
            }
            AcpEvent::ToolCall {
                tool_call_id,
                status,
                meta,
                ..
            } => {
                self.maybe_agent_compaction(tool_call_id, Some(status.as_str()), meta.as_ref())
                    .await;
            }
            AcpEvent::ToolCallUpdate {
                tool_call_id,
                status,
                meta,
                ..
            } => {
                self.maybe_agent_compaction(tool_call_id, status.as_deref(), meta.as_ref())
                    .await;
            }
            AcpEvent::PermissionRequest {
                request_id,
                tool_call,
                options,
                ..
            } => {
                self.record_permission_request(request_id, tool_call, options).await;
            }
            AcpEvent::PermissionResolved {
                request_id,
                option_id,
                origin,
            } => {
                self.record_permission_resolved(request_id, option_id.as_deref(), origin.as_ref())
                    .await;
            }
            AcpEvent::QuestionRequest {
                question_id,
                questions,
            } => {
                self.record_question_request(&env.connection_id, question_id, questions)
                    .await;
            }
            AcpEvent::QuestionResolved { question_id } => {
                self.settle_question_row(question_id, None).await;
            }
            AcpEvent::PlanApprovalRequest {
                approval_id,
                plan_markdown,
                ..
            } => {
                self.record_plan_request(approval_id, plan_markdown).await;
            }
            AcpEvent::PlanApprovalResolved { approval_id } => {
                self.settle_question_row(approval_id, None).await;
            }
            AcpEvent::SessionConfigStale { stale: true, .. } => {
                // The running process keeps its launch-time settings; a change
                // to them takes a new process, which the plan makes a new
                // segment (at the next delivery, never mid-turn).
                if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
                    if seg.pending_reason.is_none() {
                        let _ = svc::set_pending_reason(
                            &self.db.conn,
                            seg.id,
                            Some(SegmentReason::OptionRestart),
                        )
                        .await;
                        self.marker(
                            Some(seg.id),
                            "pending_switch",
                            "Launch settings changed: a new session starts with the next message.",
                            serde_json::json!({ "reason": "option_restart" }),
                        )
                        .await;
                        self.emit(PersonalAgentChange::Status);
                    }
                }
            }
            _ => {}
        }
    }

    /// The connection is gone: forget it, so the next delivery reconnects.
    async fn drop_connection(&self, conn_id: &str) {
        let mut st = self.state.lock().await;
        if st.connection_id.as_deref() == Some(conn_id) {
            st.connection_id = None;
            st.connection_segment = None;
        }
    }

    /// The agent compacted its context inside a turn: note it, and let the
    /// next delivery carry the state card. A compaction during codeg's own
    /// compaction turn is that turn's, recorded when it settles.
    async fn maybe_agent_compaction(
        &self,
        tool_call_id: &str,
        status: Option<&str>,
        meta: Option<&serde_json::Value>,
    ) {
        let Some(meta) = meta else {
            return;
        };
        let Some(info) = meta.get("contextCompaction") else {
            return;
        };
        if info.is_null() || info == &serde_json::Value::Bool(false) {
            return;
        }
        let finished = matches!(status, Some("completed") | Some("failed"));
        if !finished {
            return;
        }
        let failed = status == Some("failed") || info.get("error").is_some_and(|e| !e.is_null());
        let (segment_id, during_own) = {
            let mut st = self.state.lock().await;
            if !st.seen_compactions.insert(tool_call_id.to_string()) {
                return;
            }
            let segment_id = st.connection_segment;
            match st.turn.as_mut() {
                // codeg's own compaction: the report is that turn's outcome.
                Some(t) if t.kind == BatchKind::Compaction => {
                    t.compaction_reported = Some(!failed);
                    (segment_id, true)
                }
                // Inside a delivery: whatever its cards carried may be in
                // the summary now, so they are owed again afterwards.
                Some(t) => {
                    t.agent_compacted |= !failed;
                    (segment_id, false)
                }
                None => (segment_id, false),
            }
        };
        if during_own {
            return;
        }
        let Some(segment_id) = segment_id else {
            return;
        };
        let before = info
            .get("preTokens")
            .or_else(|| meta.get("tokensBefore"))
            .and_then(|v| v.as_u64());
        let after = info
            .get("postTokens")
            .or_else(|| meta.get("tokensAfter"))
            .and_then(|v| v.as_u64());
        if !failed {
            let _ = svc::bump_compactions(&self.db.conn, segment_id, CompactInitiator::Agent).await;
            self.update_segment_state(segment_id, |s| s.needs_state_card = true)
                .await;
        }
        self.marker(
            Some(segment_id),
            "compaction",
            if failed {
                "The agent's own compaction failed."
            } else {
                "The agent compacted its context."
            },
            serde_json::json!({
                "initiator": "agent",
                "status": if failed { "failed" } else { "ok" },
                "before_tokens": before,
                "after_tokens": after,
            }),
        )
        .await;
        self.emit(PersonalAgentChange::Status);
    }

    // ── questions and permissions ───────────────────────────────────────────

    async fn current_segment_id(&self) -> Option<i32> {
        self.state.lock().await.connection_segment
    }

    async fn record_permission_request(
        &self,
        request_id: &str,
        tool_call: &serde_json::Value,
        options: &[crate::acp::types::PermissionOptionInfo],
    ) {
        if let Ok(Some(_)) =
            svc::row_by_ref(&self.db.conn, self.bot().await, TimelineKind::Permission, request_id).await
        {
            return;
        }
        let title = tool_call
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let mut row = NewRow::new(TimelineKind::Permission, title);
        row.segment_id = self.current_segment_id().await;
        row.batch_id = self.state.lock().await.turn.as_ref().map(|t| t.batch_id);
        row.ref_id = Some(request_id.to_string());
        row.data = Some(serde_json::json!({
            "state": "pending",
            "tool_call": {
                "title": tool_call.get("title"),
                "kind": tool_call.get("kind"),
                "raw_input": tool_call.get("rawInput").or_else(|| tool_call.get("raw_input")),
            },
            "options": options,
        }));
        // The agent's own request names no input: it belongs to the turn's
        // only source, when there is one (4.11).
        if let Some(row) = self.push_row(row).await {
            let attributed = self.request_input(None).await;
            self.mirror_request(&row, attributed).await;
        }
        self.emit(PersonalAgentChange::Status);
    }

    async fn record_permission_resolved(
        &self,
        request_id: &str,
        option_id: Option<&str>,
        origin: Option<&crate::acp::types::PermissionAnswerOrigin>,
    ) {
        let Ok(Some(row)) =
            svc::row_by_ref(&self.db.conn, self.bot().await, TimelineKind::Permission, request_id).await
        else {
            return;
        };
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert(
                "state".into(),
                if option_id.is_some() { "answered" } else { "withdrawn" }.into(),
            );
            map.insert("option_id".into(), option_id.into());
            map.insert(
                "origin".into(),
                origin.map(|o| o.kind()).unwrap_or("none").into(),
            );
        }
        let _ = svc::update_row_data(&self.db.conn, row.id, None, Some(data)).await;
        if let Ok(Some(updated)) = svc::get_row(&self.db.conn, row.id).await {
            self.sync_mirrors(&updated).await;
            self.emit_rows(vec![svc::to_row(updated)]);
        }
        self.emit(PersonalAgentChange::Status);
    }

    async fn record_question_request(
        &self,
        conn_id: &str,
        question_id: &str,
        questions: &[crate::acp::question::QuestionSpec],
    ) {
        if let Ok(Some(_)) =
            svc::row_by_ref(&self.db.conn, self.bot().await, TimelineKind::Question, question_id).await
        {
            return;
        }
        let body = questions
            .first()
            .map(|q| q.question.clone())
            .unwrap_or_default();
        let mut row = NewRow::new(TimelineKind::Question, body);
        row.segment_id = self.current_segment_id().await;
        row.batch_id = self.state.lock().await.turn.as_ref().map(|t| t.batch_id);
        row.ref_id = Some(question_id.to_string());
        row.data = Some(serde_json::json!({
            "kind": "ask",
            "state": "pending",
            "questions": questions,
        }));
        // The input the brain said it asks for, when it said (4.11).
        let named = self.state.lock().await.ask_for.remove(conn_id).flatten();
        if let Some(row) = self.push_row(row).await {
            let attributed = self.request_input(named.as_deref()).await;
            self.mirror_request(&row, attributed).await;
        }
        self.emit(PersonalAgentChange::Status);
    }

    async fn record_plan_request(&self, approval_id: &str, plan_markdown: &str) {
        if let Ok(Some(_)) =
            svc::row_by_ref(&self.db.conn, self.bot().await, TimelineKind::Question, approval_id).await
        {
            return;
        }
        let mut row = NewRow::new(TimelineKind::Question, plan_markdown.to_string());
        row.segment_id = self.current_segment_id().await;
        row.batch_id = self.state.lock().await.turn.as_ref().map(|t| t.batch_id);
        row.ref_id = Some(approval_id.to_string());
        row.data = Some(serde_json::json!({ "kind": "plan_approval", "state": "pending" }));
        self.push_row(row).await;
        self.emit(PersonalAgentChange::Status);
    }

    /// Record the answer to a question or plan approval (`answer` from the
    /// page), or — `None`, from the resolved event — that it is no longer
    /// pending without codeg having seen the answer.
    async fn settle_question_row(&self, ref_id: &str, answer: Option<serde_json::Value>) {
        let Ok(Some(row)) = svc::row_by_ref(&self.db.conn, self.bot().await, TimelineKind::Question, ref_id).await
        else {
            return;
        };
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        let pending = data.get("state").and_then(|v| v.as_str()) == Some("pending");
        if let Some(map) = data.as_object_mut() {
            match answer {
                Some(a) => {
                    let skipped = a.get("declined").and_then(|v| v.as_bool()).unwrap_or(false);
                    map.insert(
                        "state".into(),
                        if skipped { "skipped" } else { "answered" }.into(),
                    );
                    map.insert("answer".into(), a);
                }
                None if pending => {
                    map.insert("state".into(), "resolved".into());
                }
                None => return,
            }
        }
        let _ = svc::update_row_data(&self.db.conn, row.id, None, Some(data)).await;
        if let Ok(Some(updated)) = svc::get_row(&self.db.conn, row.id).await {
            self.sync_mirrors(&updated).await;
            self.emit_rows(vec![svc::to_row(updated)]);
        }
        self.emit(PersonalAgentChange::Status);
    }

    /// The owner answered the agent's question on the page: record it in full,
    /// then hand it to the waiting tool call.
    pub async fn answer_question(
        &self,
        question_id: &str,
        answer: crate::acp::question::QuestionAnswer,
    ) -> Result<(), String> {
        // Asked by another assistant, shown here too: answered there.
        if let Some(source) = self.mirror_source(TimelineKind::Question, question_id).await {
            return Box::pin(source.answer_question(question_id, answer)).await;
        }
        let conn_id = self.require_connection().await?;
        let questions = match self.manager.get_state(&conn_id).await {
            Some(state) => state
                .read()
                .await
                .pending_question
                .as_ref()
                .filter(|q| q.question_id == question_id)
                .map(|q| q.questions.clone()),
            None => None,
        };
        if let Some(questions) = questions {
            let outcome = crate::acp::question::build_outcome(&questions, &answer);
            let value = serde_json::to_value(&outcome).unwrap_or_default();
            self.settle_question_row(question_id, Some(value)).await;
        }
        self.manager
            .answer_question(&conn_id, question_id, answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn answer_plan_approval(
        &self,
        approval_id: &str,
        answer: crate::acp::plan_approval::PlanApprovalAnswer,
    ) -> Result<(), String> {
        if let Some(source) = self.mirror_source(TimelineKind::Question, approval_id).await {
            return Box::pin(source.answer_plan_approval(approval_id, answer)).await;
        }
        let conn_id = self.require_connection().await?;
        let value = serde_json::to_value(&answer).unwrap_or_default();
        self.settle_question_row(approval_id, Some(value)).await;
        self.manager
            .answer_plan_approval(&conn_id, approval_id, answer)
            .await
            .map_err(|e| e.to_string())
    }

    pub async fn respond_permission(&self, request_id: &str, option_id: &str) -> Result<(), String> {
        if let Some(source) = self.mirror_source(TimelineKind::Permission, request_id).await {
            return Box::pin(source.respond_permission(request_id, option_id)).await;
        }
        let conn_id = self.require_connection().await?;
        self.manager
            .respond_permission(&conn_id, request_id, option_id)
            .await
            .map_err(|e| e.to_string())
    }

    async fn require_connection(&self) -> Result<String, String> {
        self.state
            .lock()
            .await
            .connection_id
            .clone()
            .ok_or_else(|| "the personal agent has no live session".to_string())
    }

    // ── liveness ────────────────────────────────────────────────────────────

    async fn liveness_tick(&self) {
        let turn = self.state.lock().await.turn.clone();
        let Some(turn) = turn else {
            return;
        };
        let Some(state) = self.manager.get_state(&turn.conn_id).await else {
            self.finish_turn(
                TurnEnd::Lost("the connection was lost".into()),
                None,
                ReplyCapture::Checkpoint,
            )
            .await;
            self.drop_connection(&turn.conn_id).await;
            return;
        };
        // Decided and copied under one read: the reply then is the turn's
        // whole reply, whatever starts on the connection after.
        let (in_flight, dead, seq, capture) = {
            let s = state.read().await;
            let capture = match turn.reply_token.as_deref() {
                Some(token) => s
                    .reply_turns
                    .snapshot(token)
                    .map(|r| ReplyCapture::Live(Box::new(r)))
                    .unwrap_or(ReplyCapture::Checkpoint),
                None => ReplyCapture::Checkpoint,
            };
            (
                s.turn_in_flight,
                matches!(s.status, ConnectionStatus::Disconnected | ConnectionStatus::Error),
                s.event_seq,
                capture,
            )
        };
        if dead {
            self.finish_turn(
                TurnEnd::Lost("the connection was lost".into()),
                Some(seq),
                capture,
            )
            .await;
            self.drop_connection(&turn.conn_id).await;
            return;
        }
        if !in_flight && Utc::now() - turn.started_at > IDLE_GRACE {
            // Ended without our seeing it: settle from the state, and fence
            // everything already emitted so the late event settles nothing.
            // A sealed reply knows how its turn stopped.
            let stop = match &capture {
                ReplyCapture::Live(s) => s.stop_reason.clone(),
                ReplyCapture::Checkpoint => None,
            };
            self.finish_turn(TurnEnd::Completed(stop), Some(seq), capture)
                .await;
        }
    }

    /// The reply of the delivery in flight on `conn_id`, from the connection's
    /// state while it still exists.
    async fn capture_reply(&self, conn_id: &str) -> ReplyCapture {
        let token = {
            let st = self.state.lock().await;
            match &st.turn {
                Some(t) if t.conn_id == conn_id => t.reply_token.clone(),
                _ => None,
            }
        };
        let Some(token) = token else {
            return ReplyCapture::Checkpoint;
        };
        match self.manager.get_state(conn_id).await {
            Some(state) => state
                .read()
                .await
                .reply_turns
                .snapshot(&token)
                .map(|r| ReplyCapture::Live(Box::new(r)))
                .unwrap_or(ReplyCapture::Checkpoint),
            None => ReplyCapture::Checkpoint,
        }
    }

    // ── the reply in flight ─────────────────────────────────────────────────

    /// Push the step the reply in flight is on, at most every
    /// [`REPLY_PUSH_GAP`]; the last push of a burst always goes out. Read
    /// from the connection's state when it goes, so an event the bus dropped
    /// costs nothing.
    pub(super) fn schedule_reply_push(self: &Arc<Self>) {
        if self.reply_push_pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let engine = self.clone();
        tokio::spawn(async move {
            let wait = {
                let p = engine.reply_push.lock().await;
                p.last_push
                    .map(|t| (t + REPLY_PUSH_GAP).saturating_duration_since(tokio::time::Instant::now()))
            };
            if let Some(wait) = wait.filter(|w| !w.is_zero()) {
                tokio::time::sleep(wait).await;
            }
            // Cleared before reading: an event applied from here on schedules
            // the next push, which reads it.
            engine.reply_push_pending.store(false, Ordering::SeqCst);
            engine.push_reply().await;
        });
    }

    /// The delivery in flight's reply row and tag, on its connection.
    async fn reply_in_flight(&self) -> Option<(i32, String, String)> {
        let st = self.state.lock().await;
        let t = st.turn.as_ref()?;
        Some((t.reply_row_id?, t.reply_token.clone()?, t.conn_id.clone()))
    }

    /// The reply in flight's row and the connection's copy of it now.
    async fn reply_snapshot(&self) -> Option<(i32, ReplySnapshot)> {
        let (row_id, token, conn_id) = self.reply_in_flight().await?;
        let state = self.manager.get_state(&conn_id).await?;
        let snap = state.read().await.reply_turns.snapshot(&token)?;
        Some((row_id, snap))
    }

    async fn push_reply(self: &Arc<Self>) {
        let Some((row_id, snap)) = self.reply_snapshot().await else {
            return;
        };
        let n = snap.current.as_ref().map(ReplyStep::n);
        let now = tokio::time::Instant::now();
        let checkpoint = {
            let mut p = self.reply_push.lock().await;
            p.last_push = Some(now);
            let due = p.checkpoint_row != Some(row_id)
                || p.checkpoint_n != n
                || p.checkpoint_at
                    .is_none_or(|t| now.duration_since(t) >= REPLY_CHECKPOINT_EVERY);
            if due {
                p.checkpoint_row = Some(row_id);
                p.checkpoint_n = n;
                p.checkpoint_at = Some(now);
            } else if !p.trailing {
                // What this push did not write lands with the next due
                // checkpoint, even if nothing else happens until then.
                p.trailing = true;
                let at = p.checkpoint_at.map(|t| t + REPLY_CHECKPOINT_EVERY);
                let engine = self.clone();
                tokio::spawn(async move {
                    if let Some(at) = at {
                        tokio::time::sleep_until(at).await;
                    }
                    engine.trailing_checkpoint().await;
                });
            }
            due
        };
        self.emit(PersonalAgentChange::Reply {
            row_id,
            current: snap.current.clone(),
        });
        if checkpoint {
            self.checkpoint_reply(row_id, &snap).await;
        }
    }

    /// The checkpoint a push left for later.
    async fn trailing_checkpoint(&self) {
        let Some((row_id, snap)) = self.reply_snapshot().await else {
            self.reply_push.lock().await.trailing = false;
            return;
        };
        {
            let mut p = self.reply_push.lock().await;
            p.trailing = false;
            p.checkpoint_row = Some(row_id);
            p.checkpoint_n = snap.current.as_ref().map(ReplyStep::n);
            p.checkpoint_at = Some(tokio::time::Instant::now());
        }
        self.checkpoint_reply(row_id, &snap).await;
    }

    /// Write the reply in flight's progress to its row (still `running`).
    async fn checkpoint_reply(&self, row_id: i32, snap: &ReplySnapshot) {
        let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await else {
            return;
        };
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| serde_json::json!({ "state": "running" }));
        if let Some(map) = data.as_object_mut() {
            map.insert("current".into(), serde_json::to_value(&snap.current).unwrap_or_default());
            map.insert(
                "last_text".into(),
                serde_json::to_value(&snap.last_text).unwrap_or_default(),
            );
            map.insert("step_count".into(), snap.step_count.into());
            map.insert("quotes".into(), serde_json::to_value(&snap.quotes).unwrap_or_default());
        }
        if let Ok(true) = svc::checkpoint_reply_row(&self.db.conn, row_id, data).await {
            if let Ok(Some(updated)) = svc::get_row(&self.db.conn, row_id).await {
                self.emit_rows(vec![svc::to_row(updated)]);
            }
        }
    }

    /// Settle a reply row: its last text becomes the body, its quote is
    /// resolved, and it records how the turn ended. A row settled already is
    /// left alone.
    async fn settle_reply(
        &self,
        row_id: i32,
        started_at: DateTime<Utc>,
        outcome: ReplyOutcome,
        content: ReplyContent,
        auto_quote: Option<i32>,
    ) {
        let reply_to = match self.resolve_quote(row_id, &content.quotes).await {
            Some(id) => Some(id),
            None => auto_quote,
        };
        let finished_at = Utc::now();
        let data = serde_json::json!({
            "state": outcome.state,
            "why": outcome.why,
            "stop_reason": outcome.stop_reason,
            "error": outcome.error,
            "step_count": content.step_count,
            "last_text_n": content.last_text_n,
            "started_at": started_at,
            "finished_at": finished_at,
            "duration_ms": (finished_at - started_at).num_milliseconds().max(0),
        });
        if let Ok(Some(row)) =
            svc::settle_reply_row(&self.db.conn, row_id, content.text, data, reply_to).await
        {
            self.emit_rows(vec![svc::to_row(row)]);
        }
    }

    /// The first row the reply's markers name that it may quote: one that
    /// exists, came before it, and has something to show.
    async fn resolve_quote(&self, row_id: i32, quotes: &[i64]) -> Option<i32> {
        for id in quotes.iter().filter_map(|q| i32::try_from(*q).ok()) {
            if id <= 0 || id >= row_id {
                continue;
            }
            if let Ok(Some(target)) = svc::get_row_of(&self.db.conn, self.bot().await, id).await {
                if !svc::is_unwritten_reply(&target) && target.kind != TimelineKind::Marker {
                    return Some(id);
                }
            }
        }
        None
    }

    // ── segment state ───────────────────────────────────────────────────────

    pub(super) async fn update_segment_state(&self, segment_id: i32, f: impl FnOnce(&mut SegmentState)) {
        let Ok(Some(seg)) = svc::get_segment(&self.db.conn, segment_id).await else {
            return;
        };
        let mut state = SegmentState::parse(&seg.state);
        f(&mut state);
        if let Ok(json) = serde_json::to_string(&state) {
            let _ = svc::set_segment_state(&self.db.conn, segment_id, json).await;
        }
    }

    // ── readings ────────────────────────────────────────────────────────────

    async fn live_reading(&self, conn_id: &str) -> Option<UsageReading> {
        let state = self.manager.get_state(conn_id).await?;
        let usage = state.read().await.usage.clone()?;
        let percent = compact::occupancy_percent(Some(usage.used), Some(usage.size))?;
        Some(UsageReading {
            percent,
            used: Some(usage.used),
            size: Some(usage.size),
            source: "live",
        })
    }

    /// Occupancy of the session about to be prompted: the live report first,
    /// the transcript second — and the transcript only when it describes the
    /// session the connection actually holds (see the kanban's
    /// `context_reading` for why "close enough" is never good enough).
    async fn context_reading(&self, conn_id: &str, conversation_id: Option<i32>) -> Option<UsageReading> {
        if let Some(live) = self.live_reading(conn_id).await {
            return Some(live);
        }
        let conversation_id = conversation_id?;
        let live_session = self
            .manager
            .get_state(conn_id)
            .await?
            .read()
            .await
            .external_id
            .clone()?;
        let row = crate::db::service::conversation_service::get_by_id(&self.db.conn, conversation_id)
            .await
            .ok()?;
        if !compact::transcript_describes_live_session(
            row.external_id.as_deref(),
            Some(live_session.as_str()),
        ) {
            return None;
        }
        let (detail, _) =
            crate::commands::conversations::get_folder_conversation_core(&self.db.conn, conversation_id)
                .await
                .ok()?;
        let stats = detail.session_stats?;
        let percent = stats
            .context_window_usage_percent
            .filter(|p| p.is_finite() && *p > 0.0)
            .or_else(|| {
                compact::occupancy_percent(
                    stats.context_window_used_tokens,
                    stats.context_window_max_tokens,
                )
            })?;
        Some(UsageReading {
            percent,
            used: stats.context_window_used_tokens,
            size: stats.context_window_max_tokens,
            source: "transcript",
        })
    }

    // ── delivery ────────────────────────────────────────────────────────────

    /// Deliver whatever waits, when nothing is in flight. Serialized; a call
    /// that arrives while one runs makes it run once more.
    pub(super) async fn pump(self: &Arc<Self>) {
        if !self.booted.load(Ordering::SeqCst) {
            return;
        }
        let Ok(_guard) = self.pump_lock.try_lock() else {
            self.pump_again.store(true, Ordering::SeqCst);
            return;
        };
        loop {
            self.pump_again.store(false, Ordering::SeqCst);
            if let Err(e) = self.pump_once().await {
                tracing::warn!("[personal_agent] delivery: {e}");
                self.state.lock().await.last_error = Some(e);
                self.emit(PersonalAgentChange::Status);
            }
            if !self.pump_again.load(Ordering::SeqCst) {
                break;
            }
        }
    }

    async fn pump_once(self: &Arc<Self>) -> Result<(), String> {
        if self.state.lock().await.turn.is_some() {
            return Ok(());
        }
        let Some(row) = self.agent_row().await else {
            return Ok(());
        };
        let owners = svc::queued_owner_rows(&self.db.conn, self.bot().await)
            .await
            .map_err(|e| e.to_string())?;
        let events = svc::pending_events(&self.db.conn, self.bot().await)
            .await
            .map_err(|e| e.to_string())?;
        if owners.is_empty() && !events.iter().any(|e| e.wake) {
            return Ok(());
        }
        let session = self.ensure_session(&row).await?;

        if !session.fresh {
            let seg_state = SegmentState::parse(&session.segment.state);
            let settings = settings_of(&row);
            let skip_once = std::mem::take(&mut self.state.lock().await.skip_compaction_once);
            let reading = self
                .context_reading(&session.conn_id, session.segment.conversation_id)
                .await;
            let decision = compaction::decide(
                seg_state.force_compact,
                settings.auto_compact_percent,
                session.segment.auto_compact_paused,
                skip_once,
                reading.map(|r| r.percent),
            );
            match decision {
                PreDelivery::Compact { forced } => {
                    match self
                        .start_compaction(&row, &session, CompactInitiator::Auto, reading, forced)
                        .await?
                    {
                        CompactionStart::Started => return Ok(()),
                        CompactionStart::NoCommand if forced => {
                            // An overflow no command can fix: the only way left is a
                            // new segment.
                            self.request_new_segment(SegmentReason::Overflow).await;
                            return Box::pin(self.pump_once()).await;
                        }
                        CompactionStart::NoCommand => {
                            self.note_check("no_command", reading).await;
                        }
                    }
                }
                PreDelivery::Deliver(outcome) => self.note_check(outcome, reading).await,
            }
        }
        self.deliver(&row, &session, owners, events).await
    }

    async fn note_check(&self, outcome: &'static str, reading: Option<UsageReading>) {
        self.state.lock().await.last_check = Some(CompactCheck {
            at: Utc::now(),
            outcome,
            percent: reading.map(|r| r.percent),
        });
    }

    /// Mark the open segment to be replaced at the next delivery.
    pub(super) async fn request_new_segment(&self, reason: SegmentReason) {
        if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
            let _ = svc::set_pending_reason(&self.db.conn, seg.id, Some(reason)).await;
        }
    }

    /// The open segment, with a live connection — starting a new segment when
    /// one is due, and resuming the old session after an idle sweep or a
    /// restart.
    async fn ensure_session(&self, row: &agent_entity::Model) -> Result<Session, String> {
        let config = brain_of(row).ok_or("the personal agent's agent is not readable")?;
        let workdir = self.workdir_of(row);
        workdir::ensure_bot_workdir(
            &workdir,
            self.owner_locale(row, None).await,
            row.kind == BotKind::Worker,
        )
        .await
        .map_err(|e| e.to_string())?;
        let folder_id = self.ensure_folder(row, &workdir).await?;

        let seg = svc::open_segment(&self.db.conn, self.bot().await)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(open) = seg.as_ref() {
            if let Some(reason) = open.pending_reason {
                self.end_segment(open, reason).await;
                let new = self.start_segment(&config, reason, Some(open)).await?;
                return self.connect_fresh(row, &config, new, &workdir, folder_id).await;
            }
        }
        let Some(seg) = seg else {
            let new = self.start_segment(&config, SegmentReason::First, None).await?;
            return self.connect_fresh(row, &config, new, &workdir, folder_id).await;
        };

        // The live connection of this segment, if there is one.
        let live = {
            let st = self.state.lock().await;
            match (&st.connection_id, st.connection_segment) {
                (Some(c), Some(s)) if s == seg.id => Some(c.clone()),
                _ => None,
            }
        };
        if let Some(conn_id) = live {
            if self.manager.touch(&conn_id).await {
                return Ok(Session {
                    segment: seg,
                    conn_id,
                    folder_id,
                    fresh: false,
                });
            }
            self.drop_connection(&conn_id).await;
        }
        match seg.agent_session_id.clone() {
            Some(session_id) => {
                match self
                    .resume(row, &seg, &session_id, &workdir)
                    .await
                {
                    Ok(conn_id) => {
                        self.marker(
                            Some(seg.id),
                            "reconnected",
                            "Reconnected to the same session.",
                            serde_json::json!({}),
                        )
                        .await;
                        Ok(Session {
                            segment: seg,
                            conn_id,
                            folder_id,
                            fresh: false,
                        })
                    }
                    Err(e) => {
                        tracing::info!("[personal_agent] resume failed, new segment: {e}");
                        self.end_segment(&seg, SegmentReason::Recovery).await;
                        let new = self
                            .start_segment(&config, SegmentReason::Recovery, Some(&seg))
                            .await?;
                        self.connect_fresh(row, &config, new, &workdir, folder_id).await
                    }
                }
            }
            // Never got as far as a session (its first delivery failed before
            // the agent answered): start this same segment's session afresh.
            None => self.connect_fresh(row, &config, seg, &workdir, folder_id).await,
        }
    }

    /// The hidden folder backing the working directory, created on demand.
    async fn ensure_folder(
        &self,
        row: &agent_entity::Model,
        workdir: &std::path::Path,
    ) -> Result<i32, String> {
        let path = workdir.to_string_lossy().to_string();
        let folder = crate::db::service::folder_service::ensure_personal_folder(&self.db.conn, &path)
            .await
            .map_err(|e| e.to_string())?;
        if row.folder_id != Some(folder.id) {
            let _ = svc::set_workdir(&self.db.conn, row.id, row.workdir.clone(), Some(folder.id)).await;
        }
        Ok(folder.id)
    }

    async fn end_segment(&self, seg: &segment_entity::Model, reason: SegmentReason) {
        let conn = {
            let mut st = self.state.lock().await;
            let conn = if st.connection_segment == Some(seg.id) {
                st.connection_segment = None;
                st.connection_id.take()
            } else {
                None
            };
            st.seen_compactions.clear();
            conn
        };
        let usage = match conn.as_deref() {
            Some(c) => self.live_reading(c).await,
            None => None,
        };
        if let Some(c) = conn {
            let _ = self.manager.disconnect(&c).await;
        }
        let usage_json = usage.map(|u| serde_json::json!({ "used": u.used, "size": u.size }).to_string());
        let _ = svc::end_segment(&self.db.conn, seg.id, reason, usage_json).await;
    }

    async fn start_segment(
        &self,
        config: &AssistantAgentConfig,
        reason: SegmentReason,
        previous: Option<&segment_entity::Model>,
    ) -> Result<segment_entity::Model, String> {
        let snapshot = serde_json::to_string(config).map_err(|e| e.to_string())?;
        let seg = svc::create_segment(
            &self.db.conn,
            self.bot().await,
            &config.agent_type.as_wire(),
            snapshot,
            reason,
        )
        .await
        .map_err(|e| e.to_string())?;
        let state = SegmentState {
            handoff_pending: true,
            ..Default::default()
        };
        if let Ok(json) = serde_json::to_string(&state) {
            let _ = svc::set_segment_state(&self.db.conn, seg.id, json).await;
        }
        let previous_agent = previous
            .and_then(|p| serde_json::from_str::<AssistantAgentConfig>(&p.agent_options).ok())
            .map(|c| c.label_snapshot.agent);
        self.marker(
            Some(seg.id),
            "segment_start",
            format!("Session {} started on {}.", seg.seq, config.label_snapshot.agent),
            serde_json::json!({
                "seq": seg.seq,
                "reason": reason,
                "agent_type": config.agent_type,
                "agent": config.label_snapshot.agent,
                "previous_agent": previous_agent,
                "options": config.label_snapshot.options,
            }),
        )
        .await;
        svc::get_segment(&self.db.conn, seg.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "segment vanished".to_string())
    }

    /// A new session for `seg`: spawn, and give it its conversation row.
    async fn connect_fresh(
        &self,
        row: &agent_entity::Model,
        config: &AssistantAgentConfig,
        seg: segment_entity::Model,
        workdir: &std::path::Path,
        folder_id: i32,
    ) -> Result<Session, String> {
        let agent_type = config.agent_type;
        let settings = settings_of(row);
        workdir::sync_bot_skill(
            workdir,
            agent_type,
            settings.skill_enabled,
            row.kind == BotKind::Worker,
        );
        let env = crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type,
            None,
            &self.data_dir,
        )
        .await
        .map_err(|e| e.to_string())?;
        crate::commands::acp::verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;
        let outcome = self
            .manager
            .spawn_personal_agent(
                agent_type,
                Some(workdir.to_string_lossy().to_string()),
                None,
                env,
                OWNER_LABEL.to_string(),
                self.emitter.clone(),
                config.agent_options.mode_id.clone(),
                config.agent_options.config_values.clone(),
            )
            .await
            .map_err(|e| e.to_string())?;
        let conn_id = outcome.connection_id;
        let title = format!("Personal agent · {}", seg.seq);
        let conversation = crate::db::service::conversation_service::create_personal(
            &self.db.conn,
            folder_id,
            agent_type,
            Some(title),
        )
        .await
        .map_err(|e| e.to_string())?;
        let _ =
            crate::db::service::conversation_service::lock_title(&self.db.conn, conversation.id).await;
        let _ = svc::set_segment_session(&self.db.conn, seg.id, Some(conversation.id), None).await;
        {
            let mut st = self.state.lock().await;
            st.connection_id = Some(conn_id.clone());
            st.connection_segment = Some(seg.id);
        }
        let seg = svc::get_segment(&self.db.conn, seg.id)
            .await
            .map_err(|e| e.to_string())?
            .unwrap_or(seg);
        self.emit(PersonalAgentChange::Status);
        Ok(Session {
            segment: seg,
            conn_id,
            folder_id,
            fresh: true,
        })
    }

    /// Reconnect to the segment's own session. `Err` when the agent no
    /// longer has it — including the case where it quietly started a fresh
    /// session instead, which `spawn` still reports as success.
    async fn resume(
        &self,
        row: &agent_entity::Model,
        seg: &segment_entity::Model,
        session_id: &str,
        workdir: &std::path::Path,
    ) -> Result<String, String> {
        let config = brain_of(row).ok_or("the personal agent's agent is not readable")?;
        let agent_type = AgentType::from_wire(&seg.agent_type).unwrap_or(config.agent_type);
        // The segment's own agent, with the brain's current options: a change
        // that applies within a session is meant to survive a reconnect.
        let (mode_id, values) = if agent_type == config.agent_type {
            (
                config.agent_options.mode_id.clone(),
                config.agent_options.config_values.clone(),
            )
        } else {
            let snap = serde_json::from_str::<AssistantAgentConfig>(&seg.agent_options).ok();
            (
                snap.as_ref().and_then(|s| s.agent_options.mode_id.clone()),
                snap.map(|s| s.agent_options.config_values).unwrap_or_default(),
            )
        };
        let env = crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type,
            Some(session_id),
            &self.data_dir,
        )
        .await
        .map_err(|e| e.to_string())?;
        crate::commands::acp::verify_agent_installed(agent_type)
            .await
            .map_err(|e| e.to_string())?;
        let outcome = self
            .manager
            .spawn_personal_agent(
                agent_type,
                Some(workdir.to_string_lossy().to_string()),
                Some(session_id.to_string()),
                env,
                OWNER_LABEL.to_string(),
                self.emitter.clone(),
                mode_id,
                values,
            )
            .await
            .map_err(|e| e.to_string())?;
        let conn_id = outcome.connection_id;
        let held = match self.manager.get_state(&conn_id).await {
            Some(state) => state.read().await.external_id.clone(),
            None => return Err("the session ended while resuming".into()),
        };
        if held.as_deref() != Some(session_id) {
            let _ = self.manager.disconnect(&conn_id).await;
            return Err(format!(
                "the agent did not resume session {session_id} (holds {held:?})"
            ));
        }
        let mut st = self.state.lock().await;
        st.connection_id = Some(conn_id.clone());
        st.connection_segment = Some(seg.id);
        Ok(conn_id)
    }

    /// Send the compact command, when there is one. Never fails the delivery
    /// it precedes: a compaction that cannot start says so and lets it go.
    async fn start_compaction(
        &self,
        row: &agent_entity::Model,
        session: &Session,
        initiator: CompactInitiator,
        before: Option<UsageReading>,
        forced: bool,
    ) -> Result<CompactionStart, String> {
        let config = brain_of(row).ok_or("the personal agent's agent is not readable")?;
        let agent_type = AgentType::from_wire(&session.segment.agent_type).unwrap_or(config.agent_type);
        let settings = settings_of(row);
        let advertised = match self.manager.get_state(&session.conn_id).await {
            Some(state) => state.read().await.available_commands.clone(),
            None => Vec::new(),
        };
        let Some(command) = compact::resolve_compact_command(
            settings.compact_command_for(agent_type),
            agent_type,
            &advertised,
        ) else {
            return Ok(CompactionStart::NoCommand);
        };
        let batch = svc::create_batch(
            &self.db.conn,
            self.bot().await,
            session.segment.id,
            BatchKind::Compaction,
            Some(serde_json::json!({
                "command": command,
                "initiator": initiator,
                "forced": forced,
                "before": before.map(|b| serde_json::json!({
                    "percent": b.percent, "used": b.used, "size": b.size, "source": b.source,
                })),
            })),
        )
        .await
        .map_err(|e| e.to_string())?;
        // Registered BEFORE the send: the agent can answer the instant the
        // prompt is enqueued, and a completion arriving with no turn on record
        // would be dropped as a stranger's.
        let start_seq = self.current_seq(&session.conn_id).await;
        {
            let mut st = self.state.lock().await;
            st.turn = Some(ActiveTurn {
                batch_id: batch.id,
                segment_id: session.segment.id,
                kind: BatchKind::Compaction,
                conn_id: session.conn_id.clone(),
                start_seq,
                started_at: Utc::now(),
                owner_row_ids: Vec::new(),
                compaction: Some(CompactionRun {
                    initiator,
                    command: command.clone(),
                    before,
                    forced,
                }),
                carried: Carried::default(),
                overflow: false,
                error: None,
                usage_after: None,
                compaction_reported: None,
                agent_compacted: false,
                reply_row_id: None,
                reply_token: None,
                auto_quote: None,
                ledger_scope: Vec::new(),
                preempted: false,
            });
            st.last_check = Some(CompactCheck {
                at: Utc::now(),
                outcome: "compacted",
                percent: before.map(|b| b.percent),
            });
        }
        let sent = self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &session.conn_id,
                // The bare command, nothing appended: a trailing frame turns
                // some agents' command into a command with arguments, and
                // others' into plain prose.
                vec![PromptInputBlock::Text {
                    text: command.clone(),
                }],
                Some(session.folder_id),
                session.segment.conversation_id,
                None,
                None,
            )
            .await;
        if let Err(e) = sent {
            self.clear_turn(batch.id).await;
            let _ = svc::finish_batch(
                &self.db.conn,
                batch.id,
                BatchStatus::Failed,
                None,
                Some(e.to_string()),
                None,
            )
            .await;
            self.marker(
                Some(session.segment.id),
                "compaction",
                "The compaction could not be sent.",
                serde_json::json!({
                    "initiator": initiator,
                    "status": "failed",
                    "command": command,
                    "error": e.to_string(),
                }),
            )
            .await;
            self.state.lock().await.skip_compaction_once = true;
            return Err(format!("compaction not sent: {e}"));
        }
        self.emit(PersonalAgentChange::Status);
        Ok(CompactionStart::Started)
    }

    /// Forget the turn of `batch_id` (its prompt never went out).
    async fn clear_turn(&self, batch_id: i32) {
        let mut st = self.state.lock().await;
        if st.turn.as_ref().is_some_and(|t| t.batch_id == batch_id) {
            st.turn = None;
        }
    }

    pub(super) async fn current_seq(&self, conn_id: &str) -> u64 {
        match self.manager.get_state(conn_id).await {
            Some(state) => state.read().await.event_seq,
            None => 0,
        }
    }

    /// The events block's lines. Several updates of the same dispatch since
    /// the last delivery: only the newest is news — the older ones still
    /// ride in the batch (and are settled with it), they just are not
    /// repeated. Each carries the agent's plan for when the work is done as
    /// it stands on the dispatch's entry now: the agent may have changed it
    /// since the event was written.
    pub(super) async fn event_lines(
        &self,
        events: &[crate::db::entities::personal_agent_event::Model],
    ) -> Vec<cards::EventLine> {
        let newest: HashMap<&str, i32> = events
            .iter()
            .filter_map(|e| e.coalesce_key.as_deref().map(|k| (k, e.id)))
            .fold(HashMap::new(), |mut m, (k, id)| {
                let slot = m.entry(k).or_insert(id);
                *slot = (*slot).max(id);
                m
            });
        // Each line is numbered with its result card: the agent quotes it by
        // that number, the way the owner's messages are numbered.
        let cards: HashMap<i32, i32> = svc::result_rows_of_events(
            &self.db.conn,
            &events.iter().map(|e| e.id).collect::<Vec<_>>(),
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .filter_map(|r| Some((r.event_id?, r.id)))
        .collect();
        let mut lines = Vec::new();
        for e in events.iter().filter(|e| match e.coalesce_key.as_deref() {
            Some(k) => newest.get(k) == Some(&e.id),
            None => true,
        }) {
            let payload = e
                .payload
                .as_deref()
                .and_then(|p| serde_json::from_str::<serde_json::Value>(p).ok());
            let item = match payload
                .as_ref()
                .and_then(|p| p.get("dispatch_id"))
                .and_then(|v| v.as_i64())
                .and_then(|id| i32::try_from(id).ok())
            {
                Some(id) => svc::item_of_dispatch(&self.db.conn, id).await.ok().flatten(),
                None => None,
            };
            let on_done = match item {
                Some(item) => item.on_done,
                None => payload
                    .as_ref()
                    .and_then(|p| p.get("on_done").and_then(|v| v.as_str()).map(str::to_string)),
            };
            lines.push(cards::EventLine {
                row_id: cards.get(&e.id).copied(),
                summary: e.summary.clone(),
                on_done,
            });
        }
        lines
    }

    /// The note for events an interrupted turn had already been handed: say
    /// so, and list what that turn dispatched, so it is not done twice.
    pub(super) async fn interrupted_note(
        &self,
        events: &[crate::db::entities::personal_agent_event::Model],
        resent_from: &[i32],
    ) -> Option<String> {
        // An event with a batch behind it was handed out before: that turn
        // failed (`requeues` counted) or gave way to the owner's message.
        if !events.iter().any(|e| e.requeued_from.is_some()) && resent_from.is_empty() {
            return None;
        }
        let mut batches: Vec<i32> = events
            .iter()
            .filter_map(|e| e.requeued_from)
            .chain(resent_from.iter().copied())
            .collect();
        batches.sort_unstable();
        batches.dedup();
        let mut dispatched = Vec::new();
        for b in &batches {
            for d in svc::dispatches_of_batch(&self.db.conn, *b).await.unwrap_or_default() {
                dispatched.push(format!("#{} \"{}\" ({:?}, {:?})", d.id, d.title, d.mode, d.state));
            }
        }
        Some(cards::interrupted_note(&dispatched))
    }

    /// Whether any of `events` was put back by a turn that gave way to the
    /// owner's message.
    pub(super) async fn any_yielded(&self, events: &[crate::db::entities::personal_agent_event::Model]) -> bool {
        let mut seen: Vec<i32> = Vec::new();
        for b in events.iter().filter_map(|e| e.requeued_from) {
            if seen.contains(&b) {
                continue;
            }
            seen.push(b);
            let why = svc::get_batch(&self.db.conn, b)
                .await
                .ok()
                .flatten()
                .and_then(|batch| svc::batch_why(&batch));
            if why.as_deref() == Some("preempted") {
                return true;
            }
        }
        false
    }

    /// The batches whose ledger a delivery re-delivering `direct` inherits:
    /// those, and what each of them re-delivered, all the way back.
    async fn ledger_ancestry(&self, direct: &[i32]) -> Vec<i32> {
        /// Enough for any chain of resends a person makes; a bound all the
        /// same.
        const MAX: usize = 64;
        let mut seen: Vec<i32> = Vec::new();
        let mut queue: std::collections::VecDeque<i32> = direct.iter().copied().collect();
        while let Some(b) = queue.pop_front() {
            if seen.contains(&b) {
                continue;
            }
            if seen.len() >= MAX {
                break;
            }
            seen.push(b);
            let earlier = svc::get_batch(&self.db.conn, b)
                .await
                .ok()
                .flatten()
                .and_then(|batch| batch.detail)
                .and_then(|d| serde_json::from_str::<serde_json::Value>(&d).ok())
                .and_then(|d| d.get("ledger_from").cloned())
                .and_then(|v| serde_json::from_value::<Vec<i32>>(v).ok())
                .unwrap_or_default();
            queue.extend(earlier);
        }
        seen.sort_unstable();
        seen
    }

    /// Build and send one delivery.
    async fn deliver(
        &self,
        row: &agent_entity::Model,
        session: &Session,
        owners: Vec<crate::db::entities::personal_agent_timeline::Model>,
        events: Vec<crate::db::entities::personal_agent_event::Model>,
    ) -> Result<(), String> {
        let workdir = self.workdir_of(row);
        let settings = settings_of(row);
        let config = brain_of(row).ok_or("the personal agent's agent is not readable")?;
        let seg_state = SegmentState::parse(&session.segment.state);
        let digest = workdir::persona_digest(&workdir, &row.name);
        let soul = workdir::read_text(&workdir, workdir::SOUL_FILE);
        let rules = workdir::read_text(&workdir, workdir::RULES_FILE);
        // A worker's facts about the owner: the primary's profile.
        let owner = self.owner_profile(row).await;
        let owner_digest = owner.as_deref().map(text_digest);

        let mut cards_text: Vec<String> = Vec::new();
        let mut carried = Carried::default();
        let mut owner_given = false;
        let items = self.item_lines().await;
        if seg_state.handoff_pending {
            let card = self
                .handoff_card(row, &config, &session.segment, &workdir, &items, settings.handoff_budget_chars)
                .await;
            let size = card.text.chars().count() as i32;
            let _ = svc::set_segment_handoff_size(&self.db.conn, session.segment.id, size).await;
            let trimmed = card.trimmed;
            self.update_segment_state(session.segment.id, |s| s.handoff_trimmed = trimmed)
                .await;
            cards_text.push(card.text);
            carried.handoff = true;
            owner_given = true;
        } else if seg_state.needs_state_card {
            let user = match owner.as_deref() {
                Some(o) => o.to_string(),
                None => workdir::read_text(&workdir, workdir::USER_FILE),
            };
            let memory = workdir::read_text(&workdir, workdir::MEMORY_FILE);
            let identity = cards::Identity {
                name: &row.name,
                soul: &soul,
                rules: &rules,
                user: &user,
                memory: &memory,
                worker: owner.is_some(),
            };
            cards_text.push(cards::state_card(&identity, &items));
            carried.state_card = true;
            owner_given = true;
        } else if seg_state.persona_resend || session.segment.persona_digest.as_deref() != Some(&digest)
        {
            // Changed between turns, not by the agent itself: its own edits
            // are folded into the digest at the end of each of its turns.
            if session.segment.persona_digest.is_some() || seg_state.persona_resend {
                cards_text.push(cards::persona_update(&row.name, &soul, &rules));
                carried.persona = true;
            }
        }
        // The primary changed the owner's profile since this worker last got
        // it: the new one, whole.
        if let (Some(o), false) = (owner.as_deref(), owner_given) {
            if seg_state.owner_digest.as_deref() != owner_digest.as_deref() {
                cards_text.push(cards::owner_update(o));
                owner_given = true;
            }
        }
        // The owner's preferences: whole with a handoff or a state card;
        // otherwise, when they changed since the agent was last given them,
        // what changed and the whole set anew (13.2).
        let prefs_now = self.prefs().await;
        let worker_bot = row.kind == BotKind::Worker;
        let mut prefs_handed = false;
        if carried.handoff || carried.state_card {
            cards_text.push(crate::models::personal_agent_prefs::prefs_block(&prefs_now, worker_bot));
            prefs_handed = true;
        } else if seg_state.prefs_given.as_ref() != Some(&prefs_now) {
            use crate::models::personal_agent_prefs as p;
            match &seg_state.prefs_given {
                Some(old) => {
                    let changes = p::prefs_changes(old, &prefs_now, worker_bot);
                    if !changes.is_empty() {
                        cards_text.push(p::prefs_update_card(&changes, &prefs_now, worker_bot));
                    }
                }
                // A segment from before codeg passed them on.
                None => cards_text.push(format!(
                    "<codeg-context kind=\"prefs\">\n{}\n</codeg-context>",
                    p::prefs_block(&prefs_now, worker_bot)
                )),
            }
            prefs_handed = true;
        }
        // What this delivery re-delivers: events an interrupted turn had
        // been handed, messages the owner sent again after one. Their
        // batches' ledger entries count as this one's.
        let mut resent_from_batches = Vec::new();
        for o in &owners {
            let from = o
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .and_then(|d| d.get("resent_from").and_then(|v| v.as_i64()))
                .and_then(|id| i32::try_from(id).ok());
            if let Some(from) = from {
                if let Ok(Some(old)) = svc::get_row(&self.db.conn, from).await {
                    if let Some(b) = old.batch_id {
                        resent_from_batches.push(b);
                    }
                }
            }
        }
        if let Some(note) = self.interrupted_note(&events, &resent_from_batches).await {
            cards_text.push(note);
        }
        // Inputs of more than one source: each action says which it is for.
        {
            let mut inputs = Vec::new();
            for o in &owners {
                inputs.push(self.owner_input(o.id).await);
            }
            for e in &events {
                if let Some(i) = self.event_input(e).await {
                    inputs.push(i);
                }
            }
            if let Some(note) = Self::sources_note(&inputs) {
                cards_text.push(note);
            }
        }
        // Other assistants' messages read as theirs, apart from the news of
        // dispatched work.
        let messages = self.messages_of(&events).await;
        let news: Vec<_> = events
            .iter()
            .filter(|e| e.kind != msvc::MESSAGE_EVENT)
            .cloned()
            .collect();
        // What started it — recorded only, for the status and statistics.
        let trigger = if !owners.is_empty() {
            BatchTrigger::Owner
        } else if !messages.is_empty() {
            BatchTrigger::Message
        } else {
            BatchTrigger::Event
        };
        let event_lines = self.event_lines(&news).await;
        let events_text = {
            let parts: Vec<String> = cards::events_block(&event_lines)
                .into_iter()
                .chain(cards::messages_block(&self.message_lines(&messages).await))
                .collect();
            (!parts.is_empty()).then(|| parts.join("\n\n"))
        };
        let mut owner_lines = Vec::with_capacity(owners.len());
        for o in &owners {
            owner_lines.push(OwnerLine {
                id: o.id,
                quote: match o.reply_to {
                    Some(id) => self.quote_excerpt(id).await.map(|text| (id, text)),
                    None => None,
                },
                text: o.body.clone(),
            });
        }
        // Events that gave way to the owner's message follow it: the message
        // is what cut in, the events are what it cut into.
        let owner_first = !owners.is_empty() && self.any_yielded(&events).await;
        let text = cards::delivery_text(&cards_text, events_text.as_deref(), &owner_lines, owner_first);
        // An event alone, no message: the reply answers that event.
        let auto_quote = if owners.is_empty() && messages.is_empty() && event_lines.len() == 1 {
            event_lines[0].row_id
        } else {
            None
        };

        // Attachments ride after the text, in message order.
        let mut blocks = vec![PromptInputBlock::Text { text }];
        for o in &owners {
            if let Some(extra) = o
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .and_then(|d| d.get("blocks").cloned())
            {
                if let Ok(more) = serde_json::from_value::<Vec<PromptInputBlock>>(extra) {
                    blocks.extend(more);
                }
            }
        }

        let reading = self
            .context_reading(&session.conn_id, session.segment.conversation_id)
            .await;
        let direct: Vec<i32> = events
            .iter()
            .filter_map(|e| e.requeued_from)
            .chain(resent_from_batches.iter().copied())
            .collect();
        // What those batches re-delivered in turn counts too: a message
        // resent twice must still find what its first turn made.
        let ledger_from = self.ledger_ancestry(&direct).await;
        let batch = svc::create_batch_with(
            &self.db.conn,
            self.bot().await,
            session.segment.id,
            BatchKind::Delivery,
            Some(serde_json::json!({
                "owner_rows": owners.iter().map(|o| o.id).collect::<Vec<_>>(),
                "events": events.iter().map(|e| e.id).collect::<Vec<_>>(),
                "handoff": carried.handoff,
                "state_card": carried.state_card,
                "persona": carried.persona,
                "usage_before": reading.map(|r| r.percent),
                "ledger_from": ledger_from,
            })),
            Some(trigger),
        )
        .await
        .map_err(|e| e.to_string())?;
        let mut ledger_scope = vec![batch.id];
        ledger_scope.extend(ledger_from.iter().copied());
        let owner_ids: Vec<i32> = owners.iter().map(|o| o.id).collect();
        let event_ids: Vec<i32> = events.iter().map(|e| e.id).collect();
        // The assistant starts on them now: read.
        let moved = svc::move_owner_rows(
            &self.db.conn,
            &owner_ids,
            &[OwnerStatus::Queued],
            OwnerStatus::Delivered,
            Some(batch.id),
            Some(session.segment.id),
            ReadMark::Read,
        )
        .await
        .map_err(|e| e.to_string())?;
        let taken = svc::mark_events_delivered(&self.db.conn, &event_ids, batch.id)
            .await
            .unwrap_or_default();
        // Something read for this delivery was taken back meanwhile (a
        // message its sender stopped): the text says what is no longer
        // this batch's. Nothing went out — undo, and build it again from
        // what is still waiting.
        if event_ids.iter().any(|id| !taken.contains(id)) {
            let _ = svc::move_owner_rows(
                &self.db.conn,
                &owner_ids,
                &[OwnerStatus::Delivered],
                OwnerStatus::Queued,
                None,
                None,
                ReadMark::Unread,
            )
            .await;
            let _ = svc::revert_batch_events(&self.db.conn, batch.id).await;
            let _ = svc::finish_batch(
                &self.db.conn,
                batch.id,
                BatchStatus::Canceled,
                None,
                Some("its inputs changed before it was sent".into()),
                None,
            )
            .await;
            self.pump_again.store(true, Ordering::SeqCst);
            return Ok(());
        }
        let read_cards = svc::set_result_rows_read(&self.db.conn, self.bot().await, &taken, Some(Utc::now()))
            .await
            .unwrap_or_default();
        // The reply exists from the start: it streams in place and settles
        // in place.
        let started_at = Utc::now();
        let mut reply = NewRow::new(TimelineKind::Reply, "");
        reply.segment_id = Some(session.segment.id);
        reply.batch_id = Some(batch.id);
        reply.data = Some(serde_json::json!({ "state": "running", "started_at": started_at }));
        let reply = svc::insert_row(&self.db.conn, self.bot().await, reply).await.ok();
        let token = format!("pa-{}-{}", batch.id, uuid::Uuid::new_v4().simple());
        let start_seq = self.current_seq(&session.conn_id).await;
        // Registered before the send, for the reason `start_compaction` gives.
        {
            let mut st = self.state.lock().await;
            st.turn = Some(ActiveTurn {
                batch_id: batch.id,
                segment_id: session.segment.id,
                kind: BatchKind::Delivery,
                conn_id: session.conn_id.clone(),
                start_seq,
                started_at,
                owner_row_ids: owner_ids.clone(),
                compaction: None,
                carried,
                overflow: false,
                error: None,
                usage_after: None,
                compaction_reported: None,
                agent_compacted: false,
                reply_row_id: reply.as_ref().map(|r| r.id),
                reply_token: reply.as_ref().map(|_| token.clone()),
                auto_quote,
                ledger_scope,
                preempted: false,
            });
            st.last_error = None;
        }
        let mut shown: Vec<TimelineRow> = moved.iter().cloned().map(svc::to_row).collect();
        shown.extend(read_cards.into_iter().map(svc::to_row));
        if let Some(r) = reply.as_ref() {
            shown.push(svc::to_row(r.clone()));
        }
        self.emit_rows(shown);
        let sent = self
            .manager
            .send_personal_agent_prompt(
                &self.db,
                &session.conn_id,
                blocks,
                Some(session.folder_id),
                session.segment.conversation_id,
                reply.as_ref().map(|_| token.clone()),
            )
            .await;
        if let Err(e) = sent {
            self.clear_turn(batch.id).await;
            // Nothing reached the agent: everything goes back as it was —
            // unread — and the reply that never started is void.
            let back = svc::move_owner_rows(
                &self.db.conn,
                &owner_ids,
                &[OwnerStatus::Delivered],
                OwnerStatus::Queued,
                None,
                None,
                ReadMark::Unread,
            )
            .await
            .unwrap_or_default();
            let returned = svc::revert_batch_events(&self.db.conn, batch.id)
                .await
                .unwrap_or_default();
            let unread = svc::set_result_rows_read(&self.db.conn, self.bot().await, &returned, None)
                .await
                .unwrap_or_default();
            if let Some(r) = reply.as_ref() {
                self.discard_reply(r.id).await;
            }
            self.emit_rows(unread.into_iter().map(svc::to_row).collect());
            let _ = svc::finish_batch(
                &self.db.conn,
                batch.id,
                BatchStatus::Failed,
                None,
                Some(e.to_string()),
                None,
            )
            .await;
            self.emit_rows(back.into_iter().map(svc::to_row).collect());
            if matches!(e, crate::acp::error::AcpError::ProcessExited | crate::acp::error::AcpError::ConnectionNotFound(_)) {
                self.drop_connection(&session.conn_id).await;
            }
            return Err(format!("delivery not sent: {e}"));
        }
        // The messages it carries are their receiver's now; the owner
        // speaking is progress on every exchange this assistant is in.
        self.messages_taken(&messages, batch.id).await;
        if !owners.is_empty() {
            self.owner_spoke().await;
        }
        // The persona this delivery hands over is what the agent now has.
        if carried.persona || carried.handoff || carried.state_card {
            self.update_segment_state(session.segment.id, |s| s.persona_resend = false)
                .await;
        }
        let _ = svc::set_segment_persona_digest(&self.db.conn, session.segment.id, Some(digest)).await;
        if owner_given {
            self.update_segment_state(session.segment.id, |s| s.owner_digest = owner_digest.clone())
                .await;
        }
        if prefs_handed {
            self.update_segment_state(session.segment.id, |s| s.prefs_given = Some(prefs_now.clone()))
                .await;
        }
        self.emit(PersonalAgentChange::Status);
        Ok(())
    }

    /// For a worker, the owner's profile: the primary assistant's `USER.md`,
    /// the one copy there is. `None` for the primary, which keeps its own.
    pub(super) async fn owner_profile(&self, row: &agent_entity::Model) -> Option<String> {
        if row.kind != BotKind::Worker {
            return None;
        }
        let primary = svc::primary_bot(&self.db.conn).await.ok().flatten();
        Some(match primary {
            Some(p) => workdir::read_text(&workdir::workdir_of_bot(&self.data_dir, &p), workdir::USER_FILE),
            None => String::new(),
        })
    }

    /// A reply whose prompt never reached the agent: kept, void.
    async fn discard_reply(&self, row_id: i32) {
        let data = serde_json::json!({ "state": "discarded", "finished_at": Utc::now() });
        if let Ok(Some(row)) =
            svc::settle_reply_row(&self.db.conn, row_id, String::new(), data, None).await
        {
            self.emit_rows(vec![svc::to_row(row)]);
        }
    }

    /// What a delivery repeats of a quoted row, so the agent knows what is
    /// meant even when it is no longer in its context.
    async fn quote_excerpt(&self, id: i32) -> Option<String> {
        let row = svc::get_row_of(&self.db.conn, self.bot().await, id)
            .await
            .ok()
            .flatten()?;
        if svc::is_unwritten_reply(&row) {
            return None;
        }
        let text = match row.kind {
            TimelineKind::Result => row
                .data
                .as_deref()
                .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                .and_then(|d| d.get("title").and_then(|t| t.as_str()).map(str::to_string))
                .map(|title| format!("{title}: {}", row.body))
                .unwrap_or(row.body),
            _ => row.body,
        };
        let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
        let mut excerpt: String = line.chars().take(QUOTE_EXCERPT_CHARS).collect();
        if line.chars().count() > QUOTE_EXCERPT_CHARS {
            excerpt.push('…');
        }
        Some(excerpt)
    }

    /// The open matters, as cards list them.
    pub(super) async fn item_lines(&self) -> Vec<ItemLine> {
        let items = svc::list_items(
            &self.db.conn,
            self.bot().await,
            &[ItemStatus::Open, ItemStatus::Waiting],
            CARD_ITEMS,
        )
        .await
        .unwrap_or_default();
        let mut lines = Vec::with_capacity(items.len());
        for i in items.into_iter().rev() {
            let dispatch = match i.dispatch_id {
                Some(id) => svc::get_dispatch(&self.db.conn, id).await.ok().flatten().map(|d| {
                    let name = serde_json::from_str::<crate::models::personal_agent::DispatchExecutorSnapshot>(
                        &d.executor_snapshot,
                    )
                    .map(|s| s.name)
                    .unwrap_or_default();
                    (
                        enum_str(&d.mode),
                        name,
                        enum_str(&d.state),
                    )
                }),
                None => None,
            };
            lines.push(ItemLine {
                id: i.id,
                kind: enum_str(&i.kind),
                status: enum_str(&i.status),
                waits_for: i.waits_for.as_ref().map(enum_str),
                summary: i.summary,
                dispatch,
            });
        }
        lines
    }

    async fn handoff_card(
        &self,
        row: &agent_entity::Model,
        config: &AssistantAgentConfig,
        seg: &segment_entity::Model,
        workdir: &std::path::Path,
        items: &[ItemLine],
        budget: u32,
    ) -> cards::Card {
        let recent_rows = svc::recent_rows(
            &self.db.conn,
            self.bot().await,
            &[
                TimelineKind::Owner,
                TimelineKind::Reply,
                TimelineKind::Question,
                TimelineKind::Dispatch,
                TimelineKind::Result,
            ],
            HANDOFF_RECENT_ROWS,
        )
        .await
        .unwrap_or_default();
        let recent: Vec<RecentLine> = recent_rows
            .into_iter()
            // The messages this very delivery carries are in it already.
            .filter(|r| !(r.kind == TimelineKind::Owner && r.status == Some(OwnerStatus::Queued)))
            // A reply still being written, or one that never started.
            .filter(|r| !svc::is_unwritten_reply(r))
            .map(|r| RecentLine {
                id: r.id,
                who: match r.kind {
                    TimelineKind::Owner => "Owner",
                    TimelineKind::Reply => "You",
                    _ => "codeg",
                },
                text: match r.kind {
                    TimelineKind::Question => {
                        let answer = r
                            .data
                            .as_deref()
                            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                            .and_then(|d| d.get("answer").cloned());
                        match answer {
                            Some(a) => format!("You asked: {} — answer: {}", r.body, a),
                            None => format!("You asked: {}", r.body),
                        }
                    }
                    _ => r.body,
                },
            })
            .collect();
        // The ones open to the assistants' dispatches, with how the owner
        // lets them be used.
        let team = self.account().await.team;
        let mut assistants: Vec<AssistantLine> = Vec::new();
        for a in crate::db::service::assistant_service::list_live_enabled(&self.db.conn)
            .await
            .unwrap_or_default()
        {
            let usage = team.usage_of(&a.uid);
            if !usage.dispatch {
                continue;
            }
            let description = match self.usage_note(&usage).await {
                Some(n) if a.description.trim().is_empty() => format!("[{n}]"),
                Some(n) => format!("{} [{n}]", a.description.trim()),
                None => a.description,
            };
            assistants.push(AssistantLine {
                id: a.id,
                name: a.name,
                description,
                agent: a.label_snapshot.agent,
            });
        }
        let division = self.division_text().await;
        let previous = svc::list_segments(&self.db.conn, self.bot().await)
            .await
            .unwrap_or_default()
            .into_iter()
            .rfind(|s| s.id < seg.id)
            .and_then(|s| serde_json::from_str::<AssistantAgentConfig>(&s.agent_options).ok())
            .map(|c| c.label_snapshot.agent);
        let soul = workdir::read_text(workdir, workdir::SOUL_FILE);
        let rules = workdir::read_text(workdir, workdir::RULES_FILE);
        let owner = self.owner_profile(row).await;
        let user = match owner.as_deref() {
            Some(o) => o.to_string(),
            None => workdir::read_text(workdir, workdir::USER_FILE),
        };
        let memory = workdir::read_text(workdir, workdir::MEMORY_FILE);
        let new_bot = if seg.seq == 1 && row.kind == BotKind::Worker {
            self.new_bot_note(row).await
        } else {
            None
        };
        cards::handoff_card(&cards::HandoffInput {
            segment_seq: seg.seq,
            reason: seg.start_reason,
            previous_agent: previous.as_deref(),
            current_agent: &config.label_snapshot.agent,
            identity: cards::Identity {
                name: &row.name,
                soul: &soul,
                rules: &rules,
                user: &user,
                memory: &memory,
                worker: owner.is_some(),
            },
            items,
            recent: &recent,
            assistants: &assistants,
            division: division.as_deref(),
            new_bot: new_bot.as_deref(),
            budget_chars: budget as usize,
        })
    }

    // ── a turn ends ─────────────────────────────────────────────────────────

    async fn finish_turn(&self, end: TurnEnd, seq: Option<u64>, capture: ReplyCapture) {
        let Some(expected) = self.state.lock().await.turn.as_ref().map(|t| t.batch_id) else {
            return;
        };
        // Settling is a delivery's turn too: no delivery starts while a
        // turn's messages and events are still being settled or put back
        // (a message that cut in would otherwise go out without the events
        // it cut into, which arrive a turn late). A pump finding the lock
        // taken runs again when this is done (`nudge` below) — so the lock
        // is let go of BEFORE the nudge, or a pump woken by it would find
        // the lock still taken and nobody to run it again.
        {
            let _settling = self.pump_lock.lock().await;
            let turn = {
                let mut st = self.state.lock().await;
                // Still the turn this end was decided for.
                if st.turn.as_ref().is_none_or(|t| t.batch_id != expected) {
                    return;
                }
                let Some(turn) = st.turn.take() else {
                    return;
                };
                // Fence everything up to here: a second completion of this turn
                // must not settle the next one.
                let mark = seq.unwrap_or(u64::MAX).max(turn.start_seq);
                st.fence.insert(turn.conn_id.clone(), mark);
                turn
            };
            match turn.kind {
                BatchKind::Delivery => self.finish_delivery(turn, end, capture).await,
                BatchKind::Compaction => self.finish_compaction(turn, end).await,
            }
        }
        self.emit(PersonalAgentChange::Status);
        self.nudge();
    }

    async fn finish_delivery(&self, turn: ActiveTurn, end: TurnEnd, capture: ReplyCapture) {
        let (stop, lost) = match &end {
            TurnEnd::Completed(stop) => (stop.clone(), None),
            TurnEnd::Lost(why) => (None, Some(why.clone())),
        };
        // The reply as it was when the end was decided; when that could not
        // be read, what its row last recorded (at most a checkpoint behind).
        let reply_row = match turn.reply_row_id {
            Some(id) => svc::get_row(&self.db.conn, id).await.ok().flatten(),
            None => None,
        };
        let content = match &capture {
            ReplyCapture::Live(snap) => ReplyContent::from_snapshot(snap),
            ReplyCapture::Checkpoint => {
                if turn.reply_token.is_some() {
                    tracing::info!(
                        "[personal_agent] the reply of batch {} is settled from its last checkpoint",
                        turn.batch_id
                    );
                }
                ReplyContent::from_checkpoint(reply_row.as_ref().and_then(|r| r.data.as_deref()))
            }
        };
        let has_text = !content.text.trim().is_empty();
        let canceled = matches!(stop.as_deref(), Some("cancelled" | "canceled"));
        // It was told to stop for the owner's message and did: not a
        // failure, and not the owner's own stop either — its events ride
        // with that message. A turn that ran to its end before the stop
        // landed finished as any other.
        let preempted = turn.preempted && canceled;
        let rejected = stop.as_deref() == Some("rejected");
        let interrupted = preempted || lost.is_some() || turn.overflow || rejected
            || (turn.error.is_some() && !has_text && !canceled);
        let why = if preempted {
            "preempted"
        } else if turn.overflow {
            "overflow"
        } else if lost.is_some() {
            "connection"
        } else if rejected {
            "rejected"
        } else {
            "error"
        };
        // The face says how it went for a few seconds (10.6): a stop the
        // owner asked for, or one to give way to them, is neither.
        if interrupted && !preempted {
            self.flash_face(crate::models::personal_agent_roster::FaceState::Failed).await;
        } else if !canceled {
            self.flash_face(crate::models::personal_agent_roster::FaceState::Done).await;
        }

        // The reply settles in place: the page saw it stream there. Pushed
        // once more as it stood, then the row with its body.
        if let Some(row) = reply_row {
            if let (ReplyCapture::Live(snap), Some(row_id)) = (&capture, turn.reply_row_id) {
                self.emit(PersonalAgentChange::Reply {
                    row_id,
                    current: snap.current.clone(),
                });
            }
            self.settle_reply(
                row.id,
                turn.started_at,
                ReplyOutcome {
                    state: if interrupted {
                        "interrupted"
                    } else if canceled {
                        "canceled"
                    } else {
                        "done"
                    },
                    why: interrupted.then_some(why),
                    stop_reason: stop.clone(),
                    error: turn.error.clone().or(lost.clone()),
                },
                content,
                turn.auto_quote,
            )
            .await;
        }
        if let Some(token) = turn.reply_token.as_deref() {
            if let Some(state) = self.manager.get_state(&turn.conn_id).await {
                state.write().await.reply_turns.release(token);
            }
        }

        if interrupted {
            let _ = svc::finish_batch(
                &self.db.conn,
                turn.batch_id,
                BatchStatus::Interrupted,
                stop.clone(),
                turn.error.clone().or(lost.clone()),
                None,
            )
            .await;
            if preempted {
                let _ = svc::set_batch_why(&self.db.conn, turn.batch_id, "preempted").await;
            }
            self.interrupt_delivery(turn.batch_id, Some(turn.segment_id), why).await;
            if turn.overflow {
                self.on_overflow(turn.segment_id).await;
            } else if preempted {
                // Nothing failed: the message that cut in is delivered next.
            } else if let Some(err) = turn.error.as_ref().or(lost.as_ref()) {
                self.marker(
                    Some(turn.segment_id),
                    "turn_failed",
                    format!("The turn failed: {err}"),
                    serde_json::json!({ "error": err }),
                )
                .await;
            }
        } else {
            let _ = svc::finish_batch(
                &self.db.conn,
                turn.batch_id,
                if canceled { BatchStatus::Canceled } else { BatchStatus::Completed },
                stop.clone(),
                turn.error.clone(),
                None,
            )
            .await;
            let moved = svc::move_owner_rows(
                &self.db.conn,
                &turn.owner_row_ids,
                &[OwnerStatus::Delivered],
                OwnerStatus::Answered,
                None,
                None,
                ReadMark::Keep,
            )
            .await
            .unwrap_or_default();
            self.emit_rows(moved.into_iter().map(svc::to_row).collect());
            let _ = svc::finish_batch_events(&self.db.conn, turn.batch_id).await;
            self.messages_handled(turn.batch_id).await;
            if canceled {
                self.marker(
                    Some(turn.segment_id),
                    "turn_canceled",
                    "The turn was canceled.",
                    serde_json::json!({}),
                )
                .await;
            }
            // What this delivery handed over is now the agent's — unless the
            // agent compacted it away again during the turn, which owes the
            // state card anew.
            let carried = turn.carried;
            let kept = !turn.agent_compacted;
            self.update_segment_state(turn.segment_id, |s| {
                if carried.handoff {
                    s.handoff_pending = false;
                }
                if (carried.state_card || carried.handoff) && kept {
                    s.needs_state_card = false;
                }
                // A turn that came back whole after the forced compaction:
                // the overflow is behind us.
                s.overflow_compacted = false;
            })
            .await;
        }
        self.after_turn_bookkeeping(&turn).await;
    }

    /// A delivery overflowed the context. Compact before the next one,
    /// whatever the reading says — unless that already happened once, in
    /// which case compaction cannot fix it and a new segment starts.
    async fn on_overflow(&self, segment_id: i32) {
        let Ok(Some(seg)) = svc::get_segment(&self.db.conn, segment_id).await else {
            return;
        };
        let state = SegmentState::parse(&seg.state);
        if state.overflow_compacted {
            let _ = svc::set_pending_reason(&self.db.conn, segment_id, Some(SegmentReason::Overflow)).await;
            self.marker(
                Some(segment_id),
                "overflow",
                "The context overflowed again after compacting: a new session starts.",
                serde_json::json!({ "action": "new_segment" }),
            )
            .await;
        } else {
            self.update_segment_state(segment_id, |s| s.force_compact = true).await;
            self.marker(
                Some(segment_id),
                "overflow",
                "The context overflowed: compacting before the next message.",
                serde_json::json!({ "action": "compact" }),
            )
            .await;
        }
    }

    /// After every delivery: commit the working directory, fold the agent's
    /// own edits of the persona into the digest, record the session id, and
    /// judge the last auto-compaction by this turn's reading.
    async fn after_turn_bookkeeping(&self, turn: &ActiveTurn) {
        let Some(row) = self.agent_row().await else {
            return;
        };
        let workdir = self.workdir_of(&row);
        let digest = workdir::persona_digest(&workdir, &row.name);
        let _ = svc::set_segment_persona_digest(&self.db.conn, turn.segment_id, Some(digest)).await;
        let seg = svc::get_segment(&self.db.conn, turn.segment_id).await.ok().flatten();
        if let Some(seg) = seg.as_ref() {
            if seg.agent_session_id.is_none() {
                let held = match self.manager.get_state(&turn.conn_id).await {
                    Some(state) => state.read().await.external_id.clone(),
                    None => None,
                };
                if held.is_some() {
                    let _ = svc::set_segment_session(&self.db.conn, seg.id, None, held).await;
                }
            }
            let settings = settings_of(&row);
            let reading = self.context_reading(&turn.conn_id, seg.conversation_id).await;
            let mut state = SegmentState::parse(&seg.state);
            if state.streaks.after_turn(settings.auto_compact_percent, reading.map(|r| r.percent)) {
                let _ = svc::set_segment_paused(&self.db.conn, seg.id, true).await;
                self.marker(
                    Some(seg.id),
                    "compaction_paused",
                    "Compaction did not bring the context below the threshold twice in a row: \
                     auto-compaction is paused for this session.",
                    serde_json::json!({ "why": "ineffective" }),
                )
                .await;
            }
            if let Ok(json) = serde_json::to_string(&state) {
                let _ = svc::set_segment_state(&self.db.conn, seg.id, json).await;
            }
            let message = format!("personal agent: session {} turn {}", seg.seq, turn.batch_id);
            tokio::spawn(async move {
                workdir::commit_all(&workdir, &message).await;
            });
        }
    }

    async fn finish_compaction(&self, turn: ActiveTurn, end: TurnEnd) {
        let Some(run) = turn.compaction.clone() else {
            return;
        };
        // The turn ending is not the compaction working. The agent's own
        // report decides when it sent one; without it, an error during the
        // turn or any stop but a normal end means it did not.
        let stop = match &end {
            TurnEnd::Completed(stop) => stop.as_deref(),
            TurnEnd::Lost(_) => None,
        };
        let status = match &end {
            TurnEnd::Lost(_) => "failed",
            TurnEnd::Completed(_) if matches!(stop, Some("cancelled" | "canceled")) => "canceled",
            TurnEnd::Completed(_) => match turn.compaction_reported {
                Some(true) => "ok",
                Some(false) => "failed",
                None if turn.error.is_some() => "failed",
                None if matches!(stop, None | Some("end_turn" | "")) => "ok",
                None => "failed",
            },
        };
        let ok = status == "ok";
        let error = match &end {
            TurnEnd::Lost(why) => Some(why.clone()),
            TurnEnd::Completed(_) if status == "failed" => turn.error.clone().or_else(|| {
                Some(match (turn.compaction_reported, stop) {
                    (Some(false), _) => "the agent reported the compaction failed".to_string(),
                    (_, Some(stop)) => format!("the compaction turn stopped: {stop}"),
                    _ => "the compaction did not complete".to_string(),
                })
            }),
            TurnEnd::Completed(_) => turn.error.clone(),
        };
        let after = turn.usage_after;
        let _ = svc::finish_batch(
            &self.db.conn,
            turn.batch_id,
            match status {
                "ok" => BatchStatus::Completed,
                "canceled" => BatchStatus::Canceled,
                _ => BatchStatus::Failed,
            },
            stop.map(str::to_string),
            error.clone(),
            Some(serde_json::json!({
                "command": run.command,
                "initiator": run.initiator,
                "forced": run.forced,
                "status": status,
                "before": run.before.map(|b| b.percent),
                "after": after.map(|a| a.percent),
            })),
        )
        .await;
        if ok {
            let _ = svc::bump_compactions(&self.db.conn, turn.segment_id, run.initiator).await;
        }
        let mut pause = false;
        self.update_segment_state(turn.segment_id, |s| {
            if ok {
                s.needs_state_card = true;
            }
            if run.forced {
                s.force_compact = false;
                if ok {
                    s.overflow_compacted = true;
                }
            }
            if run.initiator == CompactInitiator::Auto && !run.forced {
                pause = s.streaks.after_compaction(ok);
            }
        })
        .await;
        self.marker(
            Some(turn.segment_id),
            "compaction",
            match status {
                "ok" => "Context compacted.",
                "canceled" => "Compaction canceled.",
                _ => "Compaction failed.",
            },
            serde_json::json!({
                "initiator": run.initiator,
                "status": status,
                "command": run.command,
                "forced": run.forced,
                "before_percent": run.before.map(|b| (b.percent * 10.0).round() / 10.0),
                "before_tokens": run.before.and_then(|b| b.used),
                "after_percent": after.map(|a| (a.percent * 10.0).round() / 10.0),
                "after_tokens": after.and_then(|a| a.used),
                "error": error,
            }),
        )
        .await;
        if pause {
            let _ = svc::set_segment_paused(&self.db.conn, turn.segment_id, true).await;
            self.marker(
                Some(turn.segment_id),
                "compaction_paused",
                "Two compactions in a row did not succeed: auto-compaction is paused for this session.",
                serde_json::json!({ "why": "failures" }),
            )
            .await;
        }
        if run.forced && !ok {
            // The forced compaction did not take: a new segment is the only
            // way past the overflow.
            let _ = svc::set_pending_reason(
                &self.db.conn,
                turn.segment_id,
                Some(SegmentReason::Overflow),
            )
            .await;
        }
        // Whatever happened, the batch that was waiting goes out next.
        self.state.lock().await.skip_compaction_once = true;
    }

    // ── what the page does ──────────────────────────────────────────────────

    /// Queue one owner message, unread until a delivery carries it.
    /// `reply_to` quotes an earlier row.
    pub async fn send_owner_message(
        &self,
        text: String,
        blocks: Vec<PromptInputBlock>,
        reply_to: Option<i32>,
    ) -> Result<TimelineRow, String> {
        self.queue_owner_message(text, blocks, reply_to, None).await
    }

    /// Queue an owner message; `resent_from` is the interrupted message it
    /// sends again, whose turn's ledger the delivery inherits.
    async fn queue_owner_message(
        &self,
        text: String,
        blocks: Vec<PromptInputBlock>,
        reply_to: Option<i32>,
        resent_from: Option<i32>,
    ) -> Result<TimelineRow, String> {
        if self.agent_row().await.is_none() {
            return Err("configure the personal agent first".into());
        }
        let text = text.trim().to_string();
        if text.is_empty() && blocks.is_empty() {
            return Err("the message is empty".into());
        }
        if let Some(id) = reply_to {
            let target = svc::get_row_of(&self.db.conn, self.bot().await, id)
                .await
                .map_err(|e| e.to_string())?
                .ok_or("the quoted message does not exist")?;
            if svc::is_unwritten_reply(&target) || target.kind == TimelineKind::Marker {
                return Err("that message cannot be quoted".into());
            }
        }
        let mut row = NewRow::new(TimelineKind::Owner, text);
        row.status = Some(OwnerStatus::Queued);
        row.reply_to = reply_to;
        let mut data = serde_json::Map::new();
        if !blocks.is_empty() {
            data.insert("blocks".into(), serde_json::json!(blocks));
        }
        if let Some(from) = resent_from {
            data.insert("resent_from".into(), from.into());
        }
        if !data.is_empty() {
            row.data = Some(serde_json::Value::Object(data));
        }
        let row = self.push_row(row).await.ok_or("could not record the message")?;
        self.emit(PersonalAgentChange::Status);
        let row = self.give_way_to(row, &blocks).await;
        self.nudge();
        Ok(row)
    }

    /// The owner's message comes first. With nothing in flight it is
    /// delivered at once. A turn carrying no message of theirs (events, a
    /// routine, a due item) is told to stop: when it does, it is recorded
    /// as having given way and its events ride behind the message. A
    /// compaction is never cut into. A turn carrying their earlier message
    /// takes this one in while it runs, when the agent folds steered input
    /// into the turn in flight; otherwise the message waits its turn.
    async fn give_way_to(&self, row: TimelineRow, blocks: &[PromptInputBlock]) -> TimelineRow {
        let turn = {
            let st = self.state.lock().await;
            st.turn.as_ref().map(|t| {
                (
                    t.kind,
                    t.conn_id.clone(),
                    t.owner_row_ids.is_empty(),
                    t.preempted,
                    t.batch_id,
                    t.segment_id,
                )
            })
        };
        let Some((kind, conn_id, no_owner, preempted, batch_id, segment_id)) = turn else {
            return row;
        };
        if kind != BatchKind::Delivery {
            return row;
        }
        if no_owner {
            if preempted {
                return row;
            }
            {
                let mut st = self.state.lock().await;
                match st.turn.as_mut() {
                    Some(t) if t.batch_id == batch_id => t.preempted = true,
                    _ => return row,
                }
            }
            if let Err(e) = self.manager.cancel(&self.db.conn, &conn_id).await {
                // Gone already: the liveness check settles the turn, and
                // the message goes out after it.
                tracing::info!("[personal_agent] could not stop the turn for the owner's message: {e}");
            }
            return row;
        }
        // Claimed for the turn BEFORE it is handed over: should the turn end
        // while the hand-over is under way, its settlement finds the row
        // among its own (answered with it), and no pump finds it queued and
        // sends it a second time. A hand-over that fails gives it back.
        {
            let mut st = self.state.lock().await;
            match st.turn.as_mut() {
                Some(t) if t.batch_id == batch_id => t.owner_row_ids.push(row.id),
                _ => return row,
            }
        }
        let _ = svc::move_owner_rows(
            &self.db.conn,
            &[row.id],
            &[OwnerStatus::Queued],
            OwnerStatus::Delivered,
            Some(batch_id),
            Some(segment_id),
            ReadMark::Read,
        )
        .await;
        match self.fold_into_turn(&row, blocks, &conn_id).await {
            Ok(()) => {
                // It is the running turn's now, marked as folded in for
                // the page.
                let mut data = row.data.clone().unwrap_or_else(|| serde_json::json!({}));
                if let Some(map) = data.as_object_mut() {
                    map.insert("merged".into(), true.into());
                }
                let _ = svc::update_row_data(&self.db.conn, row.id, None, Some(data)).await;
            }
            Err(e) => {
                tracing::debug!("[personal_agent] the message waits for the turn: {e}");
                {
                    let mut st = self.state.lock().await;
                    if let Some(t) = st.turn.as_mut().filter(|t| t.batch_id == batch_id) {
                        t.owner_row_ids.retain(|id| *id != row.id);
                    }
                }
                // Back in the queue, unread — from "answered" too, when the
                // turn ended well meanwhile and settled the claim with its
                // own rows: nothing of this one reached the agent, so it
                // simply goes next. A turn that was INTERRUPTED meanwhile
                // left it "interrupted" with the turn's other messages, to
                // be sent again from the page like them: that stays — the
                // owner may already have sent it again, and a copy queued
                // here as well would reach the agent twice.
                let _ = svc::move_owner_rows(
                    &self.db.conn,
                    &[row.id],
                    &[OwnerStatus::Delivered, OwnerStatus::Answered],
                    OwnerStatus::Queued,
                    None,
                    None,
                    ReadMark::Unread,
                )
                .await;
            }
        }
        let shown = match svc::get_row(&self.db.conn, row.id).await.ok().flatten() {
            Some(m) => svc::to_row(m),
            None => return row,
        };
        self.emit_rows(vec![shown.clone()]);
        shown
    }

    /// Hand `row` to the turn in flight on `conn_id` as steered input, when
    /// the agent takes it: its connection reports native steering, and it
    /// is not a claude-agent-acp of 0.86.0 or earlier, which never answers a
    /// folded prompt.
    async fn fold_into_turn(
        &self,
        row: &TimelineRow,
        blocks: &[PromptInputBlock],
        conn_id: &str,
    ) -> Result<(), String> {
        let state = self
            .manager
            .get_state(conn_id)
            .await
            .ok_or("the connection is gone")?;
        let (native, in_flight, info) = {
            let s = state.read().await;
            (s.native_steering_available, s.turn_in_flight, s.agent_info.clone())
        };
        if !native || !in_flight {
            return Err("the agent does not fold input into a running turn".into());
        }
        if !steering_answers_folded_input(info.as_ref()) {
            return Err("this adapter never answers a folded prompt".into());
        }
        let quote = match row.reply_to {
            Some(id) => self.quote_excerpt(id).await.map(|text| (id, text)),
            None => None,
        };
        let line = OwnerLine {
            id: row.id,
            quote,
            text: row.body.clone(),
        };
        let text = cards::owner_message(&line);
        // With attachments, the blocks ARE the wire payload: the text leads
        // them, as it does in a delivery.
        let more = (!blocks.is_empty()).then(|| {
            let mut all = vec![PromptInputBlock::Text { text: text.clone() }];
            all.extend(blocks.iter().cloned());
            all
        });
        self.manager
            .submit_feedback(conn_id, text, more)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Stop the turn in flight, delivery or compaction.
    pub async fn cancel_turn(&self) -> Result<(), String> {
        let conn = self.state.lock().await.turn.as_ref().map(|t| t.conn_id.clone());
        let Some(conn) = conn else {
            return Ok(());
        };
        self.manager
            .cancel(&self.db.conn, &conn)
            .await
            .map_err(|e| e.to_string())
    }

    /// The owner's compact button: between turns only, not counted toward the
    /// pause.
    pub async fn compact_now(self: &Arc<Self>) -> Result<(), String> {
        let _guard = self.pump_lock.lock().await;
        if self.state.lock().await.turn.is_some() {
            return Err("a turn is in flight".into());
        }
        let row = self.agent_row().await.ok_or("configure the personal agent first")?;
        let session = self.ensure_session(&row).await?;
        if session.fresh {
            return Err("the session is new; there is nothing to compact".into());
        }
        let reading = self
            .context_reading(&session.conn_id, session.segment.conversation_id)
            .await;
        match self
            .start_compaction(&row, &session, CompactInitiator::Owner, reading, false)
            .await?
        {
            CompactionStart::Started => Ok(()),
            CompactionStart::NoCommand => Err("no compact command is known for this agent".into()),
        }
    }

    /// The owner's "new session": takes effect at the next delivery.
    pub async fn new_session(&self) -> Result<(), String> {
        let Some(seg) = svc::open_segment(&self.db.conn, self.bot().await).await.map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let _ = svc::set_pending_reason(&self.db.conn, seg.id, Some(SegmentReason::Manual)).await;
        self.marker(
            Some(seg.id),
            "pending_switch",
            "A new session starts with the next message.",
            serde_json::json!({ "reason": "manual" }),
        )
        .await;
        self.emit(PersonalAgentChange::Status);
        Ok(())
    }

    /// Lift a paused auto-compaction.
    pub async fn resume_auto_compact(&self) -> Result<(), String> {
        let Some(seg) = svc::open_segment(&self.db.conn, self.bot().await).await.map_err(|e| e.to_string())? else {
            return Ok(());
        };
        let _ = svc::set_segment_paused(&self.db.conn, seg.id, false).await;
        self.update_segment_state(seg.id, |s| s.streaks.reset()).await;
        self.emit(PersonalAgentChange::Status);
        Ok(())
    }

    /// Keep the session warm while the page is open: the idle sweep otherwise
    /// ends it between messages (the next one would then wait for a resume).
    pub async fn keepalive(&self) {
        let conn = self.state.lock().await.connection_id.clone();
        if let Some(conn) = conn {
            self.manager.touch(&conn).await;
        }
    }

    /// The owner has seen the page up to row `up_to`: what of it was new to
    /// them stops counting, every page hears it.
    pub async fn mark_seen(&self, up_to: i32) -> Result<(), String> {
        let marked = svc::mark_seen(&self.db.conn, self.bot().await, up_to)
            .await
            .map_err(|e| e.to_string())?;
        if !marked.is_empty() {
            self.emit_rows(marked.into_iter().map(svc::to_row).collect());
            self.emit(PersonalAgentChange::Status);
        }
        Ok(())
    }

    /// Offer an interrupted message again, as a new message at the end.
    pub async fn resend(&self, row_id: i32) -> Result<TimelineRow, String> {
        let row = svc::get_row_of(&self.db.conn, self.bot().await, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such message")?;
        if row.kind != TimelineKind::Owner || row.status != Some(OwnerStatus::Interrupted) {
            return Err("only an interrupted message can be sent again".into());
        }
        let blocks = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .and_then(|d| d.get("blocks").cloned())
            .and_then(|b| serde_json::from_value::<Vec<PromptInputBlock>>(b).ok())
            .unwrap_or_default();
        // The quote goes with it — unless what it quoted cannot be any more.
        let reply_to = match row.reply_to {
            Some(id) => match svc::get_row(&self.db.conn, id).await {
                Ok(Some(t)) if !svc::is_unwritten_reply(&t) => Some(id),
                _ => None,
            },
            None => None,
        };
        let new = self
            .queue_owner_message(row.body.clone(), blocks, reply_to, Some(row.id))
            .await?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
            .unwrap_or_else(|| serde_json::json!({}));
        if let Some(map) = data.as_object_mut() {
            map.insert("resent_as".into(), new.id.into());
        }
        let _ = svc::update_row_data(&self.db.conn, row.id, None, Some(data)).await;
        if let Ok(Some(updated)) = svc::get_row(&self.db.conn, row.id).await {
            self.emit_rows(vec![svc::to_row(updated)]);
        }
        Ok(new)
    }

    /// Save the configuration. A new agent type is a switch (a new segment at
    /// the next delivery); a change of options within the same agent applies
    /// to the running session where it can, with a marker.
    pub async fn save(&self, draft: crate::models::personal_agent::PersonalAgentDraft) -> Result<PersonalAgentInfo, String> {
        let existing = self.agent_row().await;
        let mut write = svc::AgentWrite::default();
        if let Some(name) = draft.name.as_deref() {
            let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
            write.name = Some(name);
        }
        if let Some(avatar) = draft.avatar.as_ref() {
            avatar.validate()?;
            write.avatar_json = Some(serde_json::to_string(avatar).map_err(|e| e.to_string())?);
        }
        let old_config = existing.as_ref().and_then(brain_of);
        let mut settings = existing.as_ref().map(settings_of).unwrap_or_default();
        let remembered = settings.locale;
        if let Some(s) = draft.settings.clone() {
            settings = s.normalized();
        }
        // The owner's language is no field of the dialog: the one this save
        // came from, else the one remembered.
        settings.locale = draft
            .locale
            .as_deref()
            .map(super::templates::template_locale)
            .or(remembered);
        let new_config = draft.agent_config.clone();
        let mut compact_cleared = false;
        if let Some(config) = new_config.as_ref() {
            crate::db::service::assistant_service::validate_agent_config(config)
                .map_err(|e| e.to_string())?;
            // The one requirement of a brain: its tools come from codeg-mcp,
            // so the agent must take MCP servers over the wire.
            if !crate::acp::registry::get_agent_meta(config.agent_type).supports_mcp
                || !crate::acp::connection::agent_delivers_wire_mcp(config.agent_type)
            {
                return Err(format!(
                    "{} cannot be the personal agent's brain: it does not take codeg's MCP tools",
                    config.label_snapshot.agent
                ));
            }
            write.agent_type = Some(config.agent_type.as_wire().into_owned());
            write.agent_options_json =
                Some(serde_json::to_string(&config.agent_options).map_err(|e| e.to_string())?);
            write.label_snapshot_json =
                Some(serde_json::to_string(&config.label_snapshot).map_err(|e| e.to_string())?);
            // A compact command belongs to the agent it was written for.
            if old_config.as_ref().is_some_and(|o| o.agent_type != config.agent_type)
                && draft.settings.is_none()
            {
                settings.compact_command = None;
                settings.compact_command_agent = None;
                compact_cleared = true;
            }
        } else if existing.is_none() {
            return Err("pick the agent the personal agent runs on".into());
        }
        let effective_agent = new_config
            .as_ref()
            .map(|c| c.agent_type)
            .or(old_config.as_ref().map(|c| c.agent_type));
        if settings.compact_command.is_some() {
            settings.compact_command_agent = effective_agent.map(|a| a.as_wire().into_owned());
        }
        let worker = existing.as_ref().is_some_and(|r| r.kind == BotKind::Worker);
        if let Some(id) = draft.executor_assistant_id {
            if !worker {
                return Err("only a work assistant is bound to an executor config".into());
            }
            crate::db::service::assistant_service::get(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?
                .filter(|a| a.is_live())
                .ok_or_else(|| format!("no executor config #{id}"))?;
            write.executor_assistant_id = Some(id);
        }
        if worker {
            // The owner's language is the account's, on the primary's row.
            settings.locale = None;
        }
        // Over what is stored at the moment of writing, not what was read:
        // a preference changed meanwhile stays. A save that brings no
        // settings writes only what it changes — the owner's language, a
        // compact command the switch of brain cleared — so an item another
        // window changed meanwhile is not taken back.
        if existing.is_some() {
            let full = crate::models::personal_agent::settings_patch(&settings, !worker);
            write.settings_patch = Some(if draft.settings.is_some() {
                full
            } else {
                let mut keys: Vec<&str> = vec!["locale"];
                if compact_cleared {
                    keys.extend(["compact_command", "compact_command_agent"]);
                }
                if worker {
                    keys.extend(crate::models::personal_agent::ACCOUNT_KEYS);
                }
                let mut patch = serde_json::Map::new();
                for k in keys {
                    patch.insert(k.to_string(), full.get(k).cloned().unwrap_or(serde_json::Value::Null));
                }
                serde_json::Value::Object(patch)
            });
        } else {
            write.settings_json = Some(crate::models::personal_agent::merge_settings_json(
                "{}", &settings, !worker,
            ));
        }
        let first_save = existing.is_none();
        let renamed = existing
            .as_ref()
            .zip(write.name.as_deref())
            .is_some_and(|(row, name)| row.name.trim() != name.trim());
        let saved = match (self.fixed_bot, existing.as_ref()) {
            (Some(id), _) => svc::save_bot(&self.db.conn, id, write).await,
            (None, Some(row)) => svc::save_bot(&self.db.conn, row.id, write).await,
            (None, None) => svc::save_primary(&self.db.conn, write).await,
        }
        .map_err(|e| e.to_string())?;
        if renamed {
            if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
                self.update_segment_state(seg.id, |s| s.persona_resend = true).await;
            }
        }
        // The first save sets the working directory up — a worker's row is
        // made before its engine first saves, so "first" is the directory's
        // state, not the row's.
        if first_save || !workdir::is_workdir(&self.workdir_of(&saved)) {
            let workdir = self.workdir_of(&saved);
            workdir::ensure_bot_workdir(
                &workdir,
                self.owner_locale(&saved, None).await,
                saved.kind == BotKind::Worker,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        if let (Some(old), Some(new)) = (old_config.as_ref(), new_config.as_ref()) {
            self.apply_brain_change(old, new).await;
        }
        let saved = self.agent_row().await.unwrap_or(saved);
        let workdir = self.workdir_of(&saved);
        if let Some(agent_type) = effective_agent {
            workdir::sync_bot_skill(
                &workdir,
                agent_type,
                settings.skill_enabled,
                saved.kind == BotKind::Worker,
            );
        }
        self.emit(PersonalAgentChange::Agent);
        self.emit(PersonalAgentChange::Status);
        self.info_of(&saved).ok_or_else(|| "the saved configuration is unreadable".into())
    }

    async fn apply_brain_change(&self, old: &AssistantAgentConfig, new: &AssistantAgentConfig) {
        let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await else {
            return;
        };
        if old.agent_type != new.agent_type {
            let _ = svc::set_pending_reason(&self.db.conn, seg.id, Some(SegmentReason::Switch)).await;
            self.marker(
                Some(seg.id),
                "pending_switch",
                format!(
                    "Switching to {}: a new session starts with the next message.",
                    new.label_snapshot.agent
                ),
                serde_json::json!({
                    "reason": "switch",
                    "agent_type": new.agent_type,
                    "agent": new.label_snapshot.agent,
                }),
            )
            .await;
            return;
        }
        if old.agent_options == new.agent_options {
            return;
        }
        // Same agent: options apply within the session.
        if let Ok(snapshot) = serde_json::to_string(new) {
            let _ = svc::set_segment_options(&self.db.conn, seg.id, snapshot).await;
        }
        let conn = {
            let st = self.state.lock().await;
            match (&st.connection_id, st.connection_segment) {
                (Some(c), Some(s)) if s == seg.id => Some(c.clone()),
                _ => None,
            }
        };
        if let Some(conn) = conn {
            if new.agent_options.mode_id != old.agent_options.mode_id {
                if let Some(mode) = new.agent_options.mode_id.clone() {
                    let _ = self.manager.set_mode(&conn, mode).await;
                }
            }
            for (id, value) in &new.agent_options.config_values {
                if old.agent_options.config_values.get(id) != Some(value) {
                    let _ = self
                        .manager
                        .set_config_option(&conn, id.clone(), value.clone())
                        .await;
                }
            }
        }
        let changed: Vec<serde_json::Value> = new
            .label_snapshot
            .options
            .iter()
            .filter(|o| {
                old.label_snapshot
                    .options
                    .iter()
                    .find(|p| p.id == o.id)
                    .is_none_or(|p| p.value_label != o.value_label)
            })
            .map(|o| serde_json::json!({ "name": o.name, "value": o.value_label }))
            .collect();
        let mode_changed = old.label_snapshot.mode != new.label_snapshot.mode;
        self.marker(
            Some(seg.id),
            "options_changed",
            "Options changed.",
            serde_json::json!({
                "options": changed,
                "mode": if mode_changed { new.label_snapshot.mode.clone() } else { None },
            }),
        )
        .await;
    }

    /// The language codeg writes in for the owner: the UI's when a request
    /// from it carries one, else the one the settings remember, else the UI
    /// language the owner picked in codeg's settings (in "follow the system"
    /// mode only the UI knows it), else English.
    pub(super) async fn owner_locale(&self, row: &agent_entity::Model, ui: Option<&str>) -> AppLocale {
        if let Some(tag) = ui.map(str::trim).filter(|t| !t.is_empty()) {
            return super::templates::template_locale(tag);
        }
        // The account's: on the primary's row, whichever assistant asks.
        let remembered = if row.kind == BotKind::Primary {
            settings_of(row).locale
        } else {
            match svc::primary_bot(&self.db.conn).await {
                Ok(Some(p)) => settings_of(&p).locale,
                _ => None,
            }
        };
        if let Some(locale) = remembered {
            return locale;
        }
        match crate::commands::system_settings::load_system_language_settings(&self.db.conn).await {
            Ok(s) if s.mode == LanguageMode::Manual => s.language,
            _ => AppLocale::En,
        }
    }

    /// Move the working directory. Idle only; the old directory is left as it
    /// is, and the next delivery starts a new segment there. `locale` is the
    /// UI's, for the template files of a directory made anew.
    pub async fn set_workdir(
        &self,
        path: Option<String>,
        locale: Option<&str>,
    ) -> Result<PersonalAgentInfo, String> {
        if self.state.lock().await.turn.is_some() {
            return Err("wait for the turn in flight to finish".into());
        }
        let row = self.agent_row().await.ok_or("configure the personal agent first")?;
        let target = match path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
            Some(p) => PathBuf::from(p),
            None => workdir::default_workdir_of_bot(&self.data_dir, &row),
        };
        if target == self.workdir_of(&row) {
            return self.info_of(&row).ok_or_else(|| "unreadable".into());
        }
        workdir::ensure_bot_workdir(
            &target,
            self.owner_locale(&row, locale).await,
            row.kind == BotKind::Worker,
        )
        .await
        .map_err(|e| e.to_string())?;
        let folder = crate::db::service::folder_service::ensure_personal_folder(
            &self.db.conn,
            &target.to_string_lossy(),
        )
        .await
        .map_err(|e| e.to_string())?;
        let custom = path.filter(|p| !p.trim().is_empty());
        svc::set_workdir(&self.db.conn, row.id, custom, Some(folder.id))
            .await
            .map_err(|e| e.to_string())?;
        if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
            let _ = svc::set_pending_reason(&self.db.conn, seg.id, Some(SegmentReason::Workdir)).await;
        }
        self.marker(
            self.current_segment_id().await,
            "workdir_changed",
            format!("Working directory moved to {}.", target.display()),
            serde_json::json!({ "path": target.to_string_lossy() }),
        )
        .await;
        let row = self.agent_row().await.ok_or("unreadable")?;
        self.emit(PersonalAgentChange::Agent);
        self.emit(PersonalAgentChange::Status);
        self.info_of(&row).ok_or_else(|| "unreadable".into())
    }

    /// The owner saved a persona/memory file from the page. The persona and
    /// rules are handed to the agent at the next delivery.
    pub async fn save_file(&self, name: &str, content: &str) -> Result<(), String> {
        let row = self.agent_row().await.ok_or("configure the personal agent first")?;
        if row.kind == BotKind::Worker && name == workdir::USER_FILE {
            return Err("the owner's profile is the primary assistant's: edit it there".into());
        }
        let workdir = self.workdir_of(&row);
        workdir::write_file(&workdir, name, content).map_err(|e| e.to_string())?;
        if name == workdir::SOUL_FILE || name == workdir::RULES_FILE {
            if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
                self.update_segment_state(seg.id, |s| s.persona_resend = true).await;
            }
        }
        let message = format!("owner: edit {name}");
        tokio::spawn(async move {
            workdir::commit_all(&workdir, &message).await;
        });
        Ok(())
    }

    /// Delete a memory entry the owner no longer wants kept, with its line in
    /// the index.
    pub async fn delete_file(&self, name: &str) -> Result<(), String> {
        let row = self.agent_row().await.ok_or("configure the personal agent first")?;
        let workdir = self.workdir_of(&row);
        workdir::delete_entry(&workdir, name).map_err(|e| e.to_string())?;
        let message = format!("owner: delete {name}");
        tokio::spawn(async move {
            workdir::commit_all(&workdir, &message).await;
        });
        Ok(())
    }

    /// Whether `connection_id` is the personal agent's current connection —
    /// the only one its tools answer.
    pub async fn is_current_connection(&self, connection_id: &str) -> bool {
        self.state.lock().await.connection_id.as_deref() == Some(connection_id)
    }

    /// The current delivery's batch, for dispatches made during it.
    pub(super) async fn current_batch(&self) -> Option<i32> {
        self.state
            .lock()
            .await
            .turn
            .as_ref()
            .filter(|t| t.kind == BatchKind::Delivery)
            .map(|t| t.batch_id)
    }

    /// The delivery a tool call made now belongs to, and the batches its
    /// ledger lookups cover; `None` outside a delivery (a compaction carries
    /// nobody's call, and a call that came late finds no turn).
    pub(super) async fn ledger_batch(&self) -> Option<(i32, Vec<i32>)> {
        self.state
            .lock()
            .await
            .turn
            .as_ref()
            .filter(|t| t.kind == BatchKind::Delivery)
            .map(|t| (t.batch_id, t.ledger_scope.clone()))
    }

    // ── status ──────────────────────────────────────────────────────────────

    pub async fn snapshot(&self) -> PersonalAgentSnapshot {
        let row = self.agent_row().await;
        let agent = row.as_ref().and_then(|r| self.info_of(r));
        let mut status = status_from_db(&self.db, row.as_ref(), EngineHost::Here, &self.data_dir).await;
        let (conn, turn, last_check, last_error) = {
            let st = self.state.lock().await;
            (
                st.connection_id.clone(),
                st.turn.clone(),
                st.last_check.clone(),
                st.last_error.clone(),
            )
        };
        status.connection_id = conn.clone();
        if let Some(t) = turn.as_ref() {
            if let (Some(row_id), Some(token)) = (t.reply_row_id, t.reply_token.as_deref()) {
                let current = match self.manager.get_state(&t.conn_id).await {
                    Some(state) => state
                        .read()
                        .await
                        .reply_turns
                        .snapshot(token)
                        .and_then(|s| s.current),
                    None => None,
                };
                status.live_reply = Some(LiveReply { row_id, current });
            }
        }
        status.turn = turn.as_ref().map(|t| TurnInfo {
            batch_id: t.batch_id,
            kind: t.kind,
            started_at: t.started_at,
            compaction_initiator: t.compaction.as_ref().map(|c| c.initiator),
            for_owner: !t.owner_row_ids.is_empty(),
        });
        status.last_check = last_check;
        status.last_error = last_error;
        if let Some(conn) = conn.as_deref() {
            if let Some(state) = self.manager.get_state(conn).await {
                let s = state.read().await;
                status.connected = !matches!(
                    s.status,
                    ConnectionStatus::Disconnected | ConnectionStatus::Error
                );
                status.pending_permission = s.pending_permission.is_some();
                status.pending_question =
                    s.pending_question.is_some() || s.pending_plan_approval.is_some();
            }
            status.usage = self
                .context_reading(conn, status.segment.as_ref().and_then(|s| s.conversation_id))
                .await;
            if let (Some(row), Some(seg)) = (row.as_ref(), status.segment.as_ref()) {
                let advertised = match self.manager.get_state(conn).await {
                    Some(state) => state.read().await.available_commands.clone(),
                    None => Vec::new(),
                };
                status.compact_command = compact::resolve_compact_command(
                    settings_of(row).compact_command_for(seg.agent_type),
                    seg.agent_type,
                    &advertised,
                );
            }
        }
        let account = self.account().await;
        PersonalAgentSnapshot {
            agent,
            status,
            account,
        }
    }
}

/// The turn in flight, as the live state reads it (`live`).
pub(super) struct TurnView {
    pub(super) batch_id: i32,
    pub(super) compaction: bool,
    pub(super) conn_id: String,
    /// The tag the connection builds the reply under.
    pub(super) token: Option<String>,
}

impl PersonalAgentEngine {
    pub(super) async fn turn_view(&self) -> Option<TurnView> {
        let st = self.state.lock().await;
        st.turn.as_ref().map(|t| TurnView {
            batch_id: t.batch_id,
            compaction: t.kind == BatchKind::Compaction,
            conn_id: t.conn_id.clone(),
            token: t.reply_token.clone(),
        })
    }
}

/// What `pump` works with: the open segment and its live connection.
struct Session {
    segment: segment_entity::Model,
    conn_id: String,
    folder_id: i32,
    /// The connection is a brand-new session (nothing to compact).
    fresh: bool,
}

enum CompactionStart {
    Started,
    NoCommand,
}

/// The payload of [`PERSONAL_AGENT_CHANGED_EVENT`]: the change with the
/// assistant it is about.
pub fn change_payload(bot_id: i32, change: &PersonalAgentChange) -> serde_json::Value {
    let mut v = serde_json::to_value(change).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(map) = v.as_object_mut() {
        map.insert("bot_id".into(), bot_id.into());
    }
    v
}

/// A fingerprint of a text.
pub(super) fn text_digest(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `serde`'s snake_case name of an enum value.
pub(super) fn enum_str<T: Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

pub(super) fn settings_of(row: &agent_entity::Model) -> PersonalAgentSettings {
    serde_json::from_str(&row.settings).unwrap_or_default()
}

/// The brain, as an assistant stores one.
pub(super) fn brain_of(row: &agent_entity::Model) -> Option<AssistantAgentConfig> {
    Some(AssistantAgentConfig {
        agent_type: AgentType::from_wire(&row.agent_type)?,
        agent_options: serde_json::from_str(&row.agent_options).unwrap_or_default(),
        label_snapshot: serde_json::from_str::<AssistantLabelSnapshot>(&row.label_snapshot)
            .unwrap_or_else(|_| AssistantLabelSnapshot {
                agent: row.agent_type.clone(),
                mode: None,
                options: Vec::new(),
            }),
    })
}

pub(super) fn to_info(row: &agent_entity::Model, workdir: &std::path::Path) -> Option<PersonalAgentInfo> {
    let brain = brain_of(row)?;
    Some(PersonalAgentInfo {
        id: row.id,
        name: row.name.clone(),
        avatar: serde_json::from_str::<BotAvatar>(&row.avatar).unwrap_or(BotAvatar::Emoji {
            emoji: "🧭".into(),
            color: "violet".into(),
        }),
        agent_type: brain.agent_type,
        agent_options: brain.agent_options,
        label_snapshot: brain.label_snapshot,
        settings: settings_of(row),
        workdir: workdir.to_string_lossy().to_string(),
        workdir_custom: row.workdir.as_deref().is_some_and(|w| !w.trim().is_empty()),
        folder_id: row.folder_id,
        revision: row.revision,
        created_at: row.created_at,
        updated_at: row.updated_at,
        kind: row.kind,
        uid: row.uid.clone(),
        template: row.template.clone(),
        executor_assistant_id: row.executor_assistant_id,
    })
}

pub(super) fn segment_info(seg: &segment_entity::Model) -> Option<SegmentInfo> {
    let snapshot = serde_json::from_str::<AssistantAgentConfig>(&seg.agent_options).ok();
    let state = SegmentState::parse(&seg.state);
    Some(SegmentInfo {
        id: seg.id,
        seq: seg.seq,
        agent_type: AgentType::from_wire(&seg.agent_type)?,
        label_snapshot: snapshot
            .map(|s| s.label_snapshot)
            .unwrap_or_else(|| AssistantLabelSnapshot {
                agent: seg.agent_type.clone(),
                mode: None,
                options: Vec::new(),
            }),
        conversation_id: seg.conversation_id,
        agent_session_id: seg.agent_session_id.clone(),
        start_reason: seg.start_reason,
        end_reason: seg.end_reason,
        pending_reason: seg.pending_reason,
        started_at: seg.started_at,
        ended_at: seg.ended_at,
        handoff_size: seg.handoff_size,
        handoff_trimmed: state.handoff_trimmed,
        compactions_auto: seg.compactions_auto,
        compactions_manual: seg.compactions_manual,
        compactions_agent: seg.compactions_agent,
        auto_compact_paused: seg.auto_compact_paused,
    })
}

/// The status as the database alone tells it — all a process that does not
/// run the engine can show.
pub async fn status_from_db(
    db: &AppDatabase,
    row: Option<&agent_entity::Model>,
    engine: EngineHost,
    data_dir: &std::path::Path,
) -> PersonalAgentStatus {
    // Nothing is filed under 0: an assistant not set up has no records.
    let bot = row.map(|r| r.id).unwrap_or(0);
    let segment = svc::open_segment(&db.conn, bot)
        .await
        .ok()
        .flatten()
        .and_then(|s| segment_info(&s));
    let settings = row.map(settings_of).unwrap_or_default();
    let running = svc::count_active_conversation_dispatches(&db.conn, bot)
        .await
        .unwrap_or(0) as u32;
    let queued = svc::queued_conversation_dispatches(&db.conn, bot)
        .await
        .map(|v| v.len() as u32)
        .unwrap_or(0);
    let last_compaction = match segment.as_ref() {
        Some(seg) => svc::last_compaction(&db.conn, seg.id)
            .await
            .ok()
            .flatten()
            .map(|b| {
                let detail = b
                    .detail
                    .as_deref()
                    .and_then(|d| serde_json::from_str::<serde_json::Value>(d).ok())
                    .unwrap_or_default();
                let before = detail.get("before").and_then(|v| {
                    v.as_f64()
                        .or_else(|| v.get("percent").and_then(|p| p.as_f64()))
                });
                crate::models::personal_agent::LastCompaction {
                    at: b.ended_at.unwrap_or(b.started_at),
                    initiator: detail
                        .get("initiator")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    status: match b.status {
                        BatchStatus::Running => "running".to_string(),
                        BatchStatus::Completed => "ok".to_string(),
                        BatchStatus::Canceled => "canceled".to_string(),
                        _ => "failed".to_string(),
                    },
                    before_percent: before,
                    after_percent: detail.get("after").and_then(|v| v.as_f64()),
                }
            }),
        None => None,
    };
    let workdir = row.map(|r| workdir::workdir_of_bot(data_dir, r).to_string_lossy().to_string());
    // What the next compaction would send, as far as it is known without a
    // live session: the setting, or the agent's own built-in command. A live
    // session's catalog refines it (see `snapshot`).
    let agent_type = segment
        .as_ref()
        .map(|s| s.agent_type)
        .or_else(|| row.and_then(brain_of).map(|b| b.agent_type));
    let compact_command = agent_type.and_then(|t| {
        compact::resolve_compact_command(settings.compact_command_for(t), t, &[])
    });
    PersonalAgentStatus {
        engine,
        configured: row.is_some(),
        segment,
        connection_id: None,
        connected: false,
        turn: None,
        usage: None,
        auto_compact_percent: settings.auto_compact_percent,
        compact_command,
        last_check: None,
        last_compaction,
        queued_messages: svc::count_queued_owner_rows(&db.conn, bot).await.unwrap_or(0) as u32,
        pending_events: svc::count_pending_events(&db.conn, bot).await.unwrap_or(0) as u32,
        unseen: svc::count_unseen(&db.conn, bot).await.unwrap_or(0) as u32,
        dispatch_running: running,
        dispatch_queued: queued,
        dispatch_limit: settings.dispatch_concurrency,
        pending_permission: false,
        pending_question: false,
        last_error: None,
        workdir,
        live_reply: None,
    }
}

/// Snapshot of an assistant (`None`: the primary) for any process: the
/// engine's own when one runs it here, the database's otherwise.
pub async fn snapshot_any(
    db: &AppDatabase,
    data_dir: &std::path::Path,
    bot: Option<i32>,
) -> PersonalAgentSnapshot {
    if let Some(engine) = engine_for(bot).await {
        return engine.snapshot().await;
    }
    let row = match bot {
        Some(id) => svc::get_bot(&db.conn, id).await,
        None => svc::primary_bot(&db.conn).await,
    }
    .ok()
    .flatten();
    let agent = row
        .as_ref()
        .and_then(|r| to_info(r, &workdir::workdir_of_bot(data_dir, r)));
    // An assistant no engine runs: elsewhere when there is an engine in
    // another process, idle here — a worker nothing runs yet.
    let host = if engine().is_some() {
        EngineHost::Here
    } else {
        EngineHost::Elsewhere
    };
    let status = status_from_db(db, row.as_ref(), host, data_dir).await;
    let account = match svc::primary_bot(&db.conn).await.ok().flatten() {
        Some(p) => crate::models::personal_agent_prefs::AccountView::from_settings(&p.settings),
        None => crate::models::personal_agent_prefs::AccountView::from_settings("{}"),
    };
    PersonalAgentSnapshot {
        agent,
        status,
        account,
    }
}

/// Whether a connection id belongs to a conversation the personal agent
/// dispatched (owner label check, for code that only has the state).
pub fn is_dispatch_owner(owner_window_label: &str) -> bool {
    owner_window_label == DISPATCH_OWNER_LABEL
}

/// Whether the adapter `info` names (`(name, version)` from `agentInfo`)
/// answers a prompt folded into a running turn. claude-agent-acp 0.86.0 and
/// earlier never do (measured): a message folded in would wait for ever, so
/// it queues instead. Any other adapter that reports native steering does;
/// a claude-agent-acp whose version cannot be read is held to the queue.
pub(super) fn steering_answers_folded_input(info: Option<&(String, String)>) -> bool {
    const LAST_SILENT: &str = "0.86.0";
    match info {
        Some((name, version)) if name.ends_with("claude-agent-acp") => {
            match semver::Version::parse(version.trim()) {
                Ok(v) => {
                    v.cmp_precedence(&semver::Version::parse(LAST_SILENT).expect("a version"))
                        == std::cmp::Ordering::Greater
                }
                Err(_) => false,
            }
        }
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_state_reads_old_and_partial_json() {
        assert_eq!(SegmentState::parse("{}"), SegmentState::default());
        assert_eq!(SegmentState::parse("not json"), SegmentState::default());
        let s = SegmentState::parse(r#"{"needs_state_card":true}"#);
        assert!(s.needs_state_card);
        assert!(!s.handoff_pending);
    }

    #[test]
    fn enum_names_are_the_wire_names() {
        use crate::db::entities::personal_agent_dispatch::DispatchState;
        assert_eq!(enum_str(&DispatchState::WaitingInput), "waiting_input");
        assert_eq!(enum_str(&SegmentReason::OptionRestart), "option_restart");
    }
}
