//! Result **delivery** ("push") for delegated tasks.
//!
//! A delegation child that finishes should not have to be *polled* for. This
//! module owns the push side channel: when a task reaches a terminal state
//! through the child's own lifecycle, the parent is told about it as a
//! notification turn — immediately when the parent is idle, or at the end of
//! the parent's current turn when it is busy. The pull channels
//! (`get_delegation_status` / `cancel_delegation`) remain the fallback and win
//! when they get there first: a result handed to the parent by a pull is
//! *consumed* and never pushed.
//!
//! ## Shape
//!
//! * [`DelegationResultSink`] is the trait the broker calls. The broker stays
//!   transport-free, mirroring `DelegationMetaWriter` / `DelegationEventEmitter`.
//! * [`DeliverySink`] is the production implementation: a per-parent queue plus
//!   a short-lived watcher task per parent that flushes when the parent goes
//!   idle. Merging happens at flush time — every result still queued for that
//!   parent rides one notification turn, so a fan-out cannot wake the parent
//!   once per child.
//! * [`DeliveryTransport`] is the thin adapter to the live world (resolve the
//!   parent's connection, find its folder, send the prompt). Production wires
//!   [`ManagerDeliveryTransport`]; tests inject a recording mock, which is what
//!   keeps the queue/watcher logic testable without a ConnectionManager.
//!
//! ## Why a queue at all (and not just send immediately)
//!
//! `send_prompt_linked` rejects a prompt while a turn is in flight
//! (`AcpError::TurnInProgress`) — codeg's own send path never silently queues.
//! Delivering while the parent works therefore *requires* holding the result
//! somewhere until the turn ends. The queue is that somewhere, and it doubles
//! as the merge buffer and the retry buffer (connection gone → retry when the
//! conversation reconnects; send failed → retry with backoff).
//!
//! ## Dedup and ordering
//!
//! * Only terminal transitions notify (the broker calls `task_terminal` from
//!   `complete_call`, the child-lifecycle path). Parent-initiated cancels and
//!   teardown drains never notify — those callers already know the outcome.
//! * `task_consumed` stands the push down for a result a pull already
//!   returned. The consumed set is kept briefly because the two calls can
//!   interleave: a status poll can classify the freshly-completed task before
//!   `task_terminal` (both run after the broker's pending lock is released).
//! * Entries expire after [`DEFAULT_TTL`] so a parent that never comes back
//!   cannot grow the queue forever; the result itself stays in the broker's
//!   completed cache (and the DB) for the pull channels. Pruning is lazy —
//!   each `enqueue` drops expired entries across every parent, so no timer or
//!   watcher task is needed.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use tokio::sync::Mutex;

use crate::acp::delegation::types::TaskStatus;
use crate::models::AgentType;

/// Prefix of the synthetic client-message id the delivery sink mints for a
/// notice turn (`codeg-delegation-notice:<task_id>`). The manager derives two
/// things from it in `send_prompt_linked_with_message_id`: the notice is never
/// broadcast as a user message, and its transcript prompt is recorded with
/// [`crate::acp_transcript::SOURCE_DELEGATION_RESULT`] so the UI renders the
/// turn split without the message (see `parsers::acp_native`).
pub const NOTICE_MESSAGE_ID_PREFIX: &str = "codeg-delegation-notice:";

/// Inline cap for a result body inside the notification message. The full text
/// stays reachable through `get_delegation_status` / the child conversation;
/// the inline copy only has to be useful without dragging a 256 KiB result
/// into every notification.
pub const RESULT_INLINE_CAP: usize = 8_000;

/// How long an undeliverable notification stays queued before it is dropped
/// (the result itself is not lost — only the push attempt is).
pub const DEFAULT_TTL: Duration = Duration::from_secs(30 * 60);

/// Bound on the consumed-task memo, so a long-lived process cannot accumulate
/// one entry per delegation forever.
const CONSUMED_CAP: usize = 1024;

/// One terminal result on its way to the parent.
#[derive(Debug, Clone)]
pub struct TerminalNotification {
    pub task_id: String,
    /// The parent connection the delegation was dispatched from. Used as the
    /// queue key and the preferred delivery target (the sink falls back to
    /// whichever connection currently serves the conversation).
    pub parent_connection_id: String,
    pub parent_conversation_id: i32,
    pub child_conversation_id: i32,
    pub agent_type: AgentType,
    /// `Completed` / `Failed` / `Canceled` — never `Running`.
    pub status: TaskStatus,
    /// Completed result text (already capped by the broker's cache cap).
    pub text: Option<String>,
    pub error_code: Option<String>,
    pub message: Option<String>,
    pub duration_ms: u64,
}

/// The broker-facing side of the delivery channel. Fire-and-forget by
/// construction: implementations must not block the broker's terminal path on
/// the network/database work of an actual delivery.
#[async_trait]
pub trait DelegationResultSink: Send + Sync {
    /// A task reached a terminal state through the child's own lifecycle.
    async fn task_terminal(&self, notification: TerminalNotification);

    /// The result was handed to the parent by a pull (`get_delegation_status`
    /// / `cancel_delegation`); the push must stand down.
    async fn task_consumed(&self, parent_connection_id: &str, task_id: &str);
}

/// No-op sink for tests and for wiring that predates the push channel.
#[derive(Default, Clone)]
pub struct NoopResultSink;

#[async_trait]
impl DelegationResultSink for NoopResultSink {
    async fn task_terminal(&self, _notification: TerminalNotification) {}
    async fn task_consumed(&self, _parent_connection_id: &str, _task_id: &str) {}
}

/// Whether the parent's current turn is in flight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParentBusy {
    Idle,
    Busy,
}

/// A live delivery target resolved for a parent conversation.
#[derive(Debug, Clone)]
pub struct DeliveryTarget {
    pub connection_id: String,
    pub busy: ParentBusy,
    /// The connection's adapter proved native `_session/steering` support, so
    /// a busy parent can take the notice mid-turn instead of waiting for the
    /// turn to end.
    pub steer: bool,
}

/// Why a notification prompt could not be admitted.
#[derive(Debug)]
pub enum DeliverySendError {
    /// A turn is already in flight (raced our idle check). Retry after it.
    Busy,
    /// The connection vanished. Retry when the conversation reconnects.
    Gone,
    /// Anything else — retried with backoff; kept as text for the log.
    Other(String),
}

/// The live-world adapter. Kept intentionally tiny so [`DeliverySink`]'s
/// queue/watcher logic is testable with a recording mock.
#[async_trait]
pub trait DeliveryTransport: Send + Sync {
    /// Resolve a live connection for the parent conversation. `preferred` (the
    /// connection id the delegation was dispatched from) wins when it is still
    /// bound to the conversation; otherwise any connection bound to it.
    /// `None` = no live connection right now.
    async fn resolve(
        &self,
        preferred: &str,
        conversation_id: i32,
    ) -> Option<DeliveryTarget>;

    /// Folder id of the conversation row; `None` when the row is gone.
    async fn folder_of(&self, conversation_id: i32) -> Option<i32>;

    /// Send one merged notification prompt. `notice_id` is the synthetic
    /// client message id for the broadcast (kept stable per notification so
    /// viewers can tell the message apart from user speech). `notice_id` is
    /// not broadcast for notices — it is the manager's signal that this prompt
    /// is system content (see [`NOTICE_MESSAGE_ID_PREFIX`]).
    async fn send(
        &self,
        target: &DeliveryTarget,
        folder_id: i32,
        conversation_id: i32,
        text: String,
        notice_id: String,
    ) -> Result<(), DeliverySendError>;

    /// Deliver one merged notification into the parent's RUNNING turn over
    /// native `_session/steering`. Only called when `target.steer` is set and
    /// the parent is busy; a failure is the queue's fallback.
    async fn steer(&self, target: &DeliveryTarget, text: String)
        -> Result<(), DeliverySendError>;
}

/// A queued notification plus its arrival stamp (for [`DEFAULT_TTL`]).
#[derive(Debug, Clone)]
struct QueuedNotification {
    notification: TerminalNotification,
    queued_at: Instant,
}

#[derive(Default)]
struct DeliveryInner {
    /// parent connection id → queued notifications, arrival order.
    queues: HashMap<String, Vec<QueuedNotification>>,
    /// `(parent_connection_id, task_id)` pairs already settled on the push
    /// side: a pull returned the result (`mark_consumed`), or the sink
    /// delivered it. Bounds both the pull-vs-terminal ordering race and a
    /// duplicated terminal announcement.
    resolved: HashSet<(String, String)>,
    resolved_order: VecDeque<(String, String)>,
    /// One gate per parent. Several triggers can reach the same parent at once
    /// (its immediate attempt races a turn end, a turn end races a reconnect);
    /// a gate serializes them so the same batch is never delivered twice, and —
    /// unlike a "drop the loser" flag — the second caller still runs its own
    /// pass afterwards, so an event that raced a delivery attempt is never
    /// silently swallowed. Gates are kept forever on purpose: removing one
    /// while another caller holds its `Arc` would let a later caller mint a
    /// SECOND gate for the same parent and deliver concurrently again. One
    /// `Arc` per connection ever seen is nothing next to the connection's own
    /// state.
    flush_gates: HashMap<String, Arc<Mutex<()>>>,
}

/// Outcome of one flush pass over a parent's queue.
enum Flush {
    /// The pass completed (delivered, dropped, or the queue was already
    /// empty).
    Settled,
    /// Not deliverable right now (busy parent / no connection / send failed);
    /// the entry waits for the parent's next event.
    Retry,
}

/// Production push channel: per-parent queues + watchers over a
/// [`DeliveryTransport`].
pub struct DeliverySink {
    inner: Arc<Mutex<DeliveryInner>>,
    transport: Arc<dyn DeliveryTransport>,
    ttl: Duration,
    /// In-process ACP event fan-out: the delivery triggers are all events —
    /// a task reaching terminal (enqueue's immediate attempt), the parent's
    /// turn ending (`TurnComplete`), and the parent (re)connecting
    /// (`SessionStarted`). `None` in unit tests, which drive
    /// [`DeliverySink::flush_parent`] by hand.
    bus: Option<Arc<crate::acp::internal_bus::InternalEventBus>>,
    /// One-shot latch for the bus-hook subscriber task.
    bus_hook_started: Arc<AtomicBool>,
}

impl DeliverySink {
    pub fn new(transport: Arc<dyn DeliveryTransport>) -> Self {
        Self::with_tuning(transport, DEFAULT_TTL)
    }

    /// Tuning of the entry TTL (tests shrink it).
    pub fn with_tuning(transport: Arc<dyn DeliveryTransport>, ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(DeliveryInner::default())),
            transport,
            ttl,
            bus: None,
            bus_hook_started: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Wire the in-process ACP event bus (production). See `ensure_bus_hook`.
    pub fn with_event_bus(
        mut self,
        bus: Arc<crate::acp::internal_bus::InternalEventBus>,
    ) -> Self {
        self.bus = Some(bus);
        self
    }

    /// Queue a terminal notification, then make one immediate delivery
    /// attempt: an idle parent is served right here (the broker's terminal
    /// transition IS the event for that), and the attempt doubles as the
    /// safety net for a turn that ended between the broker's resolve and this
    /// enqueue. A busy or away parent is served by the event hook — its turn
    /// ending (`TurnComplete`) or its conversation reconnecting
    /// (`SessionStarted`) — never by polling.
    ///
    /// The attempt runs in a SPAWNED task: this is the broker's terminal path
    /// (see the sink trait's fire-and-forget contract), and it must not ride
    /// on a database write, a prompt enqueue or a steering round-trip.
    ///
    /// Expired entries are pruned here too (lazy TTL): a parent that never
    /// comes back leaves its entry behind, and the next terminal of any
    /// conversation collects it.
    pub async fn enqueue(&self, notification: TerminalNotification) {
        self.ensure_bus_hook();
        let parent = notification.parent_connection_id.clone();
        {
            let mut inner = self.inner.lock().await;
            let now = Instant::now();
            for queue in inner.queues.values_mut() {
                queue.retain(|q| now.duration_since(q.queued_at) < self.ttl);
            }
            inner.queues.retain(|_, queue| !queue.is_empty());
            let key = (parent.clone(), notification.task_id.clone());
            if inner.resolved.contains(&key) {
                // The pull got there first (or an earlier terminal already
                // queued this exact task) — nothing to push.
                return;
            }
            let queue = inner.queues.entry(parent.clone()).or_default();
            if queue
                .iter()
                .any(|q| q.notification.task_id == notification.task_id)
            {
                return; // idempotent: one queued notification per task
            }
            queue.push(QueuedNotification {
                notification,
                queued_at: now,
            });
        }
        let inner = self.inner.clone();
        let transport = self.transport.clone();
        let ttl = self.ttl;
        tokio::spawn(async move {
            let _ = flush(&parent, &inner, &transport, ttl).await;
        });
    }

    /// Start the delivery event hook, once. The two events that advance a
    /// queued notice are both here — the same event-driven retry the chat
    /// channel's session bridge applies to a deferred kickoff:
    ///
    /// * `TurnComplete` — the parent was busy and its turn just ended; this is
    ///   the main exit for a queued batch.
    /// * `SessionStarted` — the parent's conversation (re)connected, e.g. the
    ///   user reopened it after the child finished. A new connection id serves
    ///   the same conversation, which is why the flush re-resolves the target
    ///   by conversation.
    ///
    /// Lazy-spawned from `enqueue` (the first async touch) because the sink is
    /// constructed outside any tokio context.
    fn ensure_bus_hook(&self) {
        let Some(bus) = self.bus.clone() else {
            return;
        };
        if self.bus_hook_started.swap(true, Ordering::SeqCst) {
            return;
        }
        // Subscribe SYNCHRONOUSLY here: the bus drops envelopes while it has
        // no receivers, and the first delivery attempt (this enqueue) races
        // the parent's next turn end.
        let mut rx = bus.subscribe();
        let inner = self.inner.clone();
        let transport = self.transport.clone();
        let ttl = self.ttl;
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(envelope) => {
                        if matches!(
                            envelope.payload,
                            crate::acp::types::AcpEvent::TurnComplete { .. }
                                | crate::acp::types::AcpEvent::SessionStarted { .. }
                        ) {
                            // Best-effort: a Retry outcome leaves the entry
                            // queued for the next event.
                            let _ = flush(&envelope.connection_id, &inner, &transport, ttl).await;
                        }
                    }
                    // Slow subscriber: the gap dropped envelopes for every
                    // consumer; the entry waits for the next turn end.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        });
    }

    /// A pull returned this result to the parent — stand the push down.
    pub async fn mark_consumed(&self, parent_connection_id: &str, task_id: &str) {
        let mut inner = self.inner.lock().await;
        mark_resolved_locked(&mut inner, parent_connection_id, task_id);
        let mut empty = false;
        if let Some(queue) = inner.queues.get_mut(parent_connection_id) {
            queue.retain(|q| q.notification.task_id != task_id);
            empty = queue.is_empty();
        }
        if empty {
            inner.queues.remove(parent_connection_id);
        }
    }

    /// One flush pass for a parent — public so tests can drive it directly
    /// instead of waiting on watcher timers.
    pub async fn flush_parent(&self, parent: &str) -> FlushOutcome {
        match flush(parent, &self.inner, &self.transport, self.ttl).await {
            Flush::Settled => FlushOutcome::Settled,
            Flush::Retry => FlushOutcome::Retry,
        }
    }

    /// Snapshot of the queue length for one parent (tests / diagnostics).
    pub async fn queued_len(&self, parent: &str) -> usize {
        self.inner
            .lock()
            .await
            .queues
            .get(parent)
            .map_or(0, Vec::len)
    }
}

/// Coarse result of a flush pass, mirrored for tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlushOutcome {
    Settled,
    Retry,
}

#[async_trait]
impl DelegationResultSink for DeliverySink {
    async fn task_terminal(&self, notification: TerminalNotification) {
        self.enqueue(notification).await;
    }

    async fn task_consumed(&self, parent_connection_id: &str, task_id: &str) {
        self.mark_consumed(parent_connection_id, task_id).await;
    }
}

/// Memoize one `(parent, task)` pair on the push side, evicting oldest first.
fn mark_resolved_locked(inner: &mut DeliveryInner, parent_connection_id: &str, task_id: &str) {
    let key = (parent_connection_id.to_string(), task_id.to_string());
    if inner.resolved.insert(key.clone()) {
        inner.resolved_order.push_back(key);
        while inner.resolved_order.len() > CONSUMED_CAP {
            if let Some(old) = inner.resolved_order.pop_front() {
                inner.resolved.remove(&old);
            }
        }
    }
}

/// One flush pass, serialized per parent through that parent's gate: two
/// concurrent sends would deliver the same batch twice. Callers queue up
/// rather than one being dropped — a trigger that raced a delivery attempt
/// still gets its own pass on the freshly-updated queue.
async fn flush(
    parent: &str,
    inner: &Arc<Mutex<DeliveryInner>>,
    transport: &Arc<dyn DeliveryTransport>,
    ttl: Duration,
) -> Flush {
    let gate = {
        let mut guard = inner.lock().await;
        guard.flush_gates.entry(parent.to_string()).or_default().clone()
    };
    let _gate = gate.lock().await;
    flush_inner(parent, inner, transport, ttl).await
}

/// One flush pass. Never holds the queue lock across a transport await.
async fn flush_inner(
    parent: &str,
    inner: &Arc<Mutex<DeliveryInner>>,
    transport: &Arc<dyn DeliveryTransport>,
    ttl: Duration,
) -> Flush {
    // 1. Snapshot the batch (and prune TTL-expired entries).
    let batch = {
        let mut guard = inner.lock().await;
        let Some(queue) = guard.queues.get_mut(parent) else {
            return Flush::Settled;
        };
        let now = Instant::now();
        let before = queue.len();
        queue.retain(|q| now.duration_since(q.queued_at) < ttl);
        let expired = before - queue.len();
        if expired > 0 {
            tracing::info!(
                parent_connection_id = parent,
                expired,
                "[delegation][delivery] dropped expired result notification(s); \
                 results stay available via get_delegation_status"
            );
        }
        if queue.is_empty() {
            guard.queues.remove(parent);
            return Flush::Settled;
        }
        queue.clone()
    };

    let conversation_id = batch[0].notification.parent_conversation_id;

    // 2. Resolve the parent's live connection (outside the lock).
    let Some(target) = transport.resolve(parent, conversation_id).await else {
        return Flush::Retry; // parent is away; retry when it reconnects
    };
    if target.busy == ParentBusy::Busy {
        // A capable adapter takes the notice mid-turn (native steering); one
        // that cannot or whose steer races the turn's end waits for the turn
        // to settle — the next pass re-resolves and sends a turn instead.
        if !target.steer {
            return Flush::Retry;
        }
        let text = build_notification_text(&batch_notifications(&batch));
        return match transport.steer(&target, text).await {
            Ok(()) => {
                remove_batch(inner, parent, &batch).await;
                tracing::info!(
                    parent_connection_id = parent,
                    connection_id = target.connection_id,
                    tasks = batch.len(),
                    "[delegation][delivery] steered result notification"
                );
                Flush::Settled
            }
            Err(err) => {
                tracing::debug!(
                    parent_connection_id = parent,
                    ?err,
                    "[delegation][delivery] steer not admitted; will retry"
                );
                Flush::Retry
            }
        };
    }

    // 3. The conversation row must still exist to file the turn.
    let Some(folder_id) = transport.folder_of(conversation_id).await else {
        // Row deleted — nothing to deliver into. Drop the batch; the broker's
        // cache still answers pulls for a while.
        remove_batch(inner, parent, &batch).await;
        return Flush::Settled;
    };

    let text = build_notification_text(&batch_notifications(&batch));
    let notice_id = format!(
        "codeg-delegation-notice:{}",
        batch[0].notification.task_id
    );

    // 4. Send. The connection refuses a prompt while a turn is in flight
    //    (`TurnInProgress`) — that race lands here as `Busy` and retries.
    match transport
        .send(&target, folder_id, conversation_id, text, notice_id)
        .await
    {
        Ok(()) => {
            remove_batch(inner, parent, &batch).await;
            tracing::info!(
                parent_connection_id = parent,
                connection_id = target.connection_id,
                tasks = batch.len(),
                "[delegation][delivery] pushed result notification"
            );
            Flush::Settled
        }
        Err(err) => {
            tracing::debug!(
                parent_connection_id = parent,
                ?err,
                "[delegation][delivery] send not admitted; will retry"
            );
            Flush::Retry
        }
    }
}

/// The payloads of one flush batch, cloned out of their queue entries.
fn batch_notifications(batch: &[QueuedNotification]) -> Vec<TerminalNotification> {
    batch
        .iter()
        .map(|queued| queued.notification.clone())
        .collect()
}

/// Remove exactly the delivered batch's entries (entries queued while the
/// send was in flight stay for the next pass).
async fn remove_batch(
    inner: &Arc<Mutex<DeliveryInner>>,
    parent: &str,
    batch: &[QueuedNotification],
) {
    let ids: HashSet<&str> = batch
        .iter()
        .map(|q| q.notification.task_id.as_str())
        .collect();
    let mut guard = inner.lock().await;
    // Delivered = settled: a repeated terminal announcement for the same task
    // (which the broker's one-shot transition should prevent anyway) is
    // dropped instead of waking the parent twice.
    for queued in batch {
        mark_resolved_locked(&mut guard, parent, &queued.notification.task_id);
    }
    let mut empty = false;
    if let Some(queue) = guard.queues.get_mut(parent) {
        queue.retain(|q| !ids.contains(q.notification.task_id.as_str()));
        empty = queue.is_empty();
    }
    if empty {
        guard.queues.remove(parent);
    }
}

/// Build the notification prompt for one flush batch.
///
/// Deliberately minimal (design v1.1): a self-owned envelope tag anchors "this
/// is system content" for the model; every field is natural language. The
/// message is a plain prompt — nothing downstream parses it (the system
/// semantics live on the event side), so no schema is warranted.
pub fn build_notification_text(batch: &[TerminalNotification]) -> String {
    let count = batch.len();
    let mut out = String::new();
    if count == 1 {
        out.push_str("Delegation result: 1 task finished.\n\n");
    } else {
        out.push_str(&format!("Delegation results: {count} tasks finished.\n\n"));
    }
    out.push_str("<codeg-delegation-result>\n");
    for (index, n) in batch.iter().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let agent = agent_slug(n.agent_type);
        match n.status {
            TaskStatus::Completed => {
                out.push_str(&format!("task {} (completed, {agent}):\n", n.task_id));
                let body = n.text.as_deref().unwrap_or("");
                if body.trim().is_empty() {
                    out.push_str("(empty result)\n");
                } else {
                    out.push_str(&truncate_chars(body, RESULT_INLINE_CAP));
                    out.push('\n');
                }
            }
            TaskStatus::Failed => {
                let code = n.error_code.as_deref().unwrap_or("failed");
                let message = n.message.as_deref().unwrap_or("");
                out.push_str(&format!(
                    "task {} (failed: {code} — {message})\n",
                    n.task_id
                ));
            }
            TaskStatus::Canceled => {
                let message = n.message.as_deref().unwrap_or("canceled");
                out.push_str(&format!("task {} (canceled — {message})\n", n.task_id));
            }
            // `complete_call` never reports a running task; degrade safely.
            TaskStatus::Running | TaskStatus::Unknown => {
                out.push_str(&format!("task {} (status unknown)\n", n.task_id));
            }
        }
    }
    out.push_str("</codeg-delegation-result>\n\n");
    let ids = batch
        .iter()
        .map(|n| format!("\"{}\"", n.task_id))
        .collect::<Vec<_>>()
        .join(", ");
    out.push_str(&format!("Full result: get_delegation_status([{ids}])"));
    if count == 1 && batch[0].child_conversation_id > 0 {
        out.push_str(&format!(
            " — or open child conversation #{}.",
            batch[0].child_conversation_id
        ));
    } else {
        out.push('.');
    }
    out.push_str("\nThis is a system notification from codeg; no reply needed.");
    out
}

fn agent_slug(agent_type: AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{agent_type:?}"))
}

/// Production [`DeliveryTransport`]: resolves the parent's live connection
/// through the `ConnectionManager` and sends the notification prompt through
/// the same `send_prompt_linked` path user prompts use.
///
/// The connection is resolved by CONVERSATION, not just by the captured
/// connection id: a conversation reopened after a codeg restart gets a fresh
/// connection, and the queued result should still reach it.
pub struct ManagerDeliveryTransport {
    manager: crate::acp::manager::ConnectionManager,
    db: Arc<crate::db::AppDatabase>,
}

impl ManagerDeliveryTransport {
    pub fn new(
        manager: crate::acp::manager::ConnectionManager,
        db: Arc<crate::db::AppDatabase>,
    ) -> Self {
        Self { manager, db }
    }
}

fn busy_of(state: &crate::acp::SessionState) -> ParentBusy {
    if matches!(
        state.status,
        crate::acp::types::ConnectionStatus::Prompting
    ) {
        ParentBusy::Busy
    } else {
        ParentBusy::Idle
    }
}

#[async_trait]
impl DeliveryTransport for ManagerDeliveryTransport {
    async fn resolve(
        &self,
        preferred: &str,
        conversation_id: i32,
    ) -> Option<DeliveryTarget> {
        // Preferred: the connection the delegation was dispatched from, when
        // it is still bound to the same conversation.
        if let Some(state) = self.manager.get_state(preferred).await {
            let guard = state.read().await;
            if guard.conversation_id == Some(conversation_id) {
                return Some(DeliveryTarget {
                    connection_id: preferred.to_string(),
                    busy: busy_of(&guard),
                    steer: guard.native_steering_available,
                });
            }
        }
        // Fallback: whichever connection currently serves the conversation
        // (e.g. the user reopened it after a restart).
        let conn_id = self
            .manager
            .find_connection_by_conversation_id(conversation_id)
            .await?;
        let state = self.manager.get_state(&conn_id).await?;
        let guard = state.read().await;
        Some(DeliveryTarget {
            busy: busy_of(&guard),
            steer: guard.native_steering_available,
            connection_id: conn_id,
        })
    }

    async fn folder_of(&self, conversation_id: i32) -> Option<i32> {
        crate::db::service::conversation_service::get_by_id(&self.db.conn, conversation_id)
            .await
            .ok()
            .map(|row| row.folder_id)
    }

    async fn send(
        &self,
        target: &DeliveryTarget,
        folder_id: i32,
        conversation_id: i32,
        text: String,
        notice_id: String,
    ) -> Result<(), DeliverySendError> {
        let blocks = vec![crate::acp::types::PromptInputBlock::Text { text }];
        match self
            .manager
            .send_prompt_linked_with_message_id(
                &self.db,
                &target.connection_id,
                blocks,
                Some(folder_id),
                Some(conversation_id),
                None,
                Some(notice_id),
            )
            .await
        {
            Ok(_) => Ok(()),
            Err(crate::acp::error::AcpError::TurnInProgress) => {
                Err(DeliverySendError::Busy)
            }
            Err(crate::acp::error::AcpError::ConnectionNotFound(_)) => {
                Err(DeliverySendError::Gone)
            }
            Err(e) => Err(DeliverySendError::Other(e.to_string())),
        }
    }

    async fn steer(
        &self,
        target: &DeliveryTarget,
        text: String,
    ) -> Result<(), DeliverySendError> {
        match self
            .manager
            .steer_notice(
                &target.connection_id,
                vec![crate::acp::types::PromptInputBlock::Text { text }],
            )
            .await
        {
            Ok(()) => Ok(()),
            // The turn settled first (or the adapter downgraded): the queue's
            // next pass re-resolves and sends a turn instead.
            Err(crate::acp::error::AcpError::NoActiveTurn) => Err(DeliverySendError::Busy),
            Err(crate::acp::error::AcpError::ConnectionNotFound(_)) => {
                Err(DeliverySendError::Gone)
            }
            Err(e) => Err(DeliverySendError::Other(e.to_string())),
        }
    }
}

/// Truncate on a char boundary, appending a marker when anything was dropped.
fn truncate_chars(text: &str, cap: usize) -> String {
    if text.chars().count() <= cap {
        return text.to_string();
    }
    let mut out: String = text.chars().take(cap).collect();
    out.push_str("\n… (truncated; full result via get_delegation_status)");
    out
}

#[cfg(any(test, feature = "test-utils"))]
pub mod mock {
    use super::*;
    use tokio::sync::Mutex;

    /// Records every sink call so broker tests can assert the push channel was
    /// driven correctly. The delivery queue itself is unit-tested in
    /// `delivery::tests`; here the broker is the unit under test.
    #[derive(Default)]
    pub struct MockResultSink {
        pub terminals: Mutex<Vec<TerminalNotification>>,
        pub consumed: Mutex<Vec<(String, String)>>,
    }

    impl MockResultSink {
        pub fn new() -> Self {
            Self::default()
        }
        pub async fn terminals(&self) -> Vec<TerminalNotification> {
            self.terminals.lock().await.clone()
        }
        pub async fn consumed(&self) -> Vec<(String, String)> {
            self.consumed.lock().await.clone()
        }
    }

    #[async_trait]
    impl DelegationResultSink for MockResultSink {
        async fn task_terminal(&self, notification: TerminalNotification) {
            self.terminals.lock().await.push(notification);
        }
        async fn task_consumed(&self, parent_connection_id: &str, task_id: &str) {
            self.consumed
                .lock()
                .await
                .push((parent_connection_id.to_string(), task_id.to_string()));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct MockInner {
        resolve: Option<DeliveryTarget>,
        folder: Option<i32>,
        /// `None` = send succeeds; `Some("busy" | "gone" | other)` = fail.
        send_error: Option<String>,
        /// Same script for [`DeliveryTransport::steer`].
        steer_error: Option<String>,
        /// When set, `send` parks on it before recording — lets a test hold a
        /// delivery in flight (the terminal path must not wait on it).
        send_hold: Option<Arc<tokio::sync::Semaphore>>,
        sends: Vec<(String, i32, i32, String, String)>,
        steers: Vec<(String, String)>,
    }

    struct MockTransport {
        inner: StdMutex<MockInner>,
    }

    impl MockTransport {
        fn new(resolve: Option<DeliveryTarget>, folder: Option<i32>) -> Self {
            Self {
                inner: StdMutex::new(MockInner {
                    resolve,
                    folder,
                    ..Default::default()
                }),
            }
        }
        fn set_resolve(&self, target: Option<DeliveryTarget>) {
            self.inner.lock().unwrap().resolve = target;
        }
        fn set_folder(&self, folder: Option<i32>) {
            self.inner.lock().unwrap().folder = folder;
        }
        fn set_send_error(&self, error: Option<&str>) {
            self.inner.lock().unwrap().send_error = error.map(str::to_string);
        }
        fn set_steer_error(&self, error: Option<&str>) {
            self.inner.lock().unwrap().steer_error = error.map(str::to_string);
        }
        fn set_send_hold(&self, hold: Option<Arc<tokio::sync::Semaphore>>) {
            self.inner.lock().unwrap().send_hold = hold;
        }
        fn steers(&self) -> Vec<(String, String)> {
            self.inner.lock().unwrap().steers.clone()
        }
        fn sends(&self) -> Vec<(String, i32, i32, String, String)> {
            self.inner.lock().unwrap().sends.clone()
        }
    }

    #[async_trait]
    impl DeliveryTransport for MockTransport {
        async fn resolve(
            &self,
            _preferred: &str,
            _conversation_id: i32,
        ) -> Option<DeliveryTarget> {
            self.inner.lock().unwrap().resolve.clone()
        }
        async fn folder_of(&self, _conversation_id: i32) -> Option<i32> {
            self.inner.lock().unwrap().folder
        }
        async fn send(
            &self,
            target: &DeliveryTarget,
            folder_id: i32,
            conversation_id: i32,
            text: String,
            notice_id: String,
        ) -> Result<(), DeliverySendError> {
            // Park, if the test is holding deliveries. Read the hold and drop
            // the std lock BEFORE awaiting.
            let hold = { self.inner.lock().unwrap().send_hold.clone() };
            if let Some(hold) = hold {
                let _ = hold.acquire().await;
            }
            let mut guard = self.inner.lock().unwrap();
            if let Some(error) = guard.send_error.clone() {
                return Err(match error.as_str() {
                    "busy" => DeliverySendError::Busy,
                    "gone" => DeliverySendError::Gone,
                    other => DeliverySendError::Other(other.to_string()),
                });
            }
            guard.sends.push((
                target.connection_id.clone(),
                folder_id,
                conversation_id,
                text,
                notice_id,
            ));
            Ok(())
        }

        async fn steer(
            &self,
            target: &DeliveryTarget,
            text: String,
        ) -> Result<(), DeliverySendError> {
            let mut guard = self.inner.lock().unwrap();
            if let Some(error) = guard.steer_error.clone() {
                return Err(match error.as_str() {
                    "busy" => DeliverySendError::Busy,
                    "gone" => DeliverySendError::Gone,
                    other => DeliverySendError::Other(other.to_string()),
                });
            }
            guard.steers.push((target.connection_id.clone(), text));
            Ok(())
        }
    }

    fn idle_target() -> DeliveryTarget {
        DeliveryTarget {
            connection_id: "c1".into(),
            busy: ParentBusy::Idle,
            steer: false,
        }
    }

    fn busy_target(steer: bool) -> DeliveryTarget {
        DeliveryTarget {
            connection_id: "c1".into(),
            busy: ParentBusy::Busy,
            steer,
        }
    }

    fn note(task_id: &str, status: TaskStatus, text: Option<&str>) -> TerminalNotification {
        TerminalNotification {
            task_id: task_id.into(),
            parent_connection_id: "p1".into(),
            parent_conversation_id: 42,
            child_conversation_id: 7,
            agent_type: AgentType::Codex,
            status,
            text: text.map(str::to_string),
            error_code: None,
            message: None,
            duration_ms: 1234,
        }
    }

    /// Yield until `check` holds (bounded), for assertions that follow a
    /// spawned delivery attempt.
    async fn until(check: impl Fn() -> bool) {
        for _ in 0..2000 {
            if check() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("condition never became true");
    }

    fn fixture(ttl: Duration) -> (DeliverySink, Arc<MockTransport>) {
        let mock = Arc::new(MockTransport::new(Some(idle_target()), Some(7)));
        let sink = DeliverySink::with_tuning(mock.clone(), ttl);
        (sink, mock)
    }

    #[tokio::test]
    async fn idle_parent_is_served_on_enqueue_without_a_flush_call() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        sink.enqueue(note("t1", TaskStatus::Completed, Some("the result")))
            .await;
        until(|| !mock.sends().is_empty()).await;

        let sends = mock.sends();
        assert_eq!(sends.len(), 1, "an idle parent is served immediately");
        let (conn, folder, conv, text, notice) = &sends[0];
        assert_eq!(conn, "c1");
        assert_eq!(*folder, 7);
        assert_eq!(*conv, 42);
        assert!(text.contains("t1") && text.contains("the result"));
        assert!(text.contains("1 task finished"));
        assert!(notice.starts_with("codeg-delegation-notice:"));
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn enqueue_never_waits_for_the_delivery_attempt() {
        // `enqueue` is the broker's terminal path (see the sink trait's
        // fire-and-forget contract): it must return while the actual delivery
        // — a DB write, a prompt enqueue, a steering round-trip — is still in
        // flight.
        let (sink, mock) = fixture(DEFAULT_TTL);
        let hold = Arc::new(tokio::sync::Semaphore::new(0));
        mock.set_send_hold(Some(hold.clone()));

        tokio::time::timeout(
            // Generous: the send is parked indefinitely, so any bound proves
            // the point; a tight one would only flake under load.
            std::time::Duration::from_secs(2),
            sink.enqueue(note("t1", TaskStatus::Completed, Some("done"))),
        )
        .await
        .expect("enqueue must not ride on the delivery attempt");
        assert!(mock.sends().is_empty(), "the send is still parked");

        hold.add_permits(1);
        until(|| !mock.sends().is_empty()).await;
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn concurrent_flush_triggers_never_double_deliver() {
        // The immediate attempt and a turn end can race; the per-parent gate
        // serializes them (and the loser still runs its own pass, so nothing
        // is swallowed).
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(false)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.queued_len("p1").await, 1);
        mock.set_resolve(Some(idle_target()));
        let hold = Arc::new(tokio::sync::Semaphore::new(0));
        mock.set_send_hold(Some(hold.clone()));

        let releaser = {
            let hold = hold.clone();
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                hold.add_permits(4);
            })
        };
        let (a, b) = tokio::join!(sink.flush_parent("p1"), sink.flush_parent("p1"));
        releaser.await.unwrap();

        assert_eq!(a, FlushOutcome::Settled);
        assert_eq!(b, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 1, "one batch, one delivery");
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn busy_parents_pile_up_into_one_merged_turn() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(false)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("first result")))
            .await;
        sink.enqueue(note("t2", TaskStatus::Completed, Some("second result")))
            .await;
        assert_eq!(sink.queued_len("p1").await, 2);
        assert!(mock.sends().is_empty());

        mock.set_resolve(Some(idle_target()));
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);

        let sends = mock.sends();
        assert_eq!(sends.len(), 1, "a fan-out must merge into ONE turn");
        let text = &sends[0].3;
        assert!(text.contains("t1") && text.contains("t2"));
        assert!(text.contains("first result") && text.contains("second result"));
        assert!(text.contains("2 tasks finished"));
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn busy_parent_waits_for_its_next_event() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(false)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;

        // The enqueue's attempt was refused (busy): queued, nothing sent.
        assert_eq!(mock.sends().len(), 0);
        assert_eq!(sink.queued_len("p1").await, 1);

        // The parent's turn ends (in production: the TurnComplete event).
        mock.set_resolve(Some(idle_target()));
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 1);
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn consumed_result_is_not_pushed() {
        // The pull can only win while the notice is waiting, i.e. the parent
        // was busy when the child finished and polled before its turn ended.
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(false)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        sink.mark_consumed("p1", "t1").await;

        assert_eq!(sink.queued_len("p1").await, 0);
        mock.set_resolve(Some(idle_target()));
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 0);
        assert!(mock.steers().is_empty());
    }

    #[tokio::test]
    async fn terminal_after_consumed_is_dropped() {
        // The pull can win the race: it classifies the freshly-completed task
        // before the broker's terminal hook reaches the sink.
        let (sink, mock) = fixture(DEFAULT_TTL);
        sink.mark_consumed("p1", "t1").await;
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;

        assert_eq!(sink.queued_len("p1").await, 0);
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 0);
    }

    #[tokio::test]
    async fn duplicate_terminal_is_idempotent_across_delivery() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        until(|| !mock.sends().is_empty()).await;
        assert_eq!(mock.sends().len(), 1);

        // A repeated announcement for the same task never wakes the parent a
        // second time, even though the queue no longer holds it.
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        assert_eq!(mock.sends().len(), 1);
    }

    #[tokio::test]
    async fn missing_connection_keeps_queue_until_reconnect() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(None);
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Retry);
        assert_eq!(sink.queued_len("p1").await, 1);

        mock.set_resolve(Some(idle_target()));
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 1);
    }

    #[tokio::test]
    async fn expired_entries_are_dropped_without_sending() {
        let (sink, mock) = fixture(Duration::ZERO);
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        // The spawned attempt is what drops the expired entry; let it run.
        for _ in 0..40 {
            tokio::task::yield_now().await;
        }
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 0);
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn busy_steer_capable_parent_takes_the_notice_mid_turn() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(true)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        until(|| !mock.steers().is_empty()).await;

        let steers = mock.steers();
        assert_eq!(steers.len(), 1, "a capable parent is steered right away");
        let (conn, text) = &steers[0];
        assert_eq!(conn, "c1");
        assert!(text.contains("t1") && text.contains("done"));
        assert!(text.contains("<codeg-delegation-result>"));
        // Delivered mid-turn — nothing is left queued and no turn was opened.
        assert_eq!(sink.queued_len("p1").await, 0);
        assert!(mock.sends().is_empty());
    }

    #[tokio::test]
    async fn busy_without_steering_waits_even_when_the_steer_helper_exists() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(false)));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;

        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Retry);
        assert!(mock.steers().is_empty());
        assert_eq!(sink.queued_len("p1").await, 1);
    }

    #[tokio::test]
    async fn failed_steer_falls_back_to_the_queue_and_later_turns() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_resolve(Some(busy_target(true)));
        mock.set_steer_error(Some("busy")); // the turn settled mid-steer
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;

        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Retry);
        assert_eq!(sink.queued_len("p1").await, 1);

        // The turn is over: the next pass sends an ordinary notice turn.
        mock.set_resolve(Some(idle_target()));
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 1);
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    #[tokio::test]
    async fn send_failure_keeps_queue_for_retry() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_send_error(Some("boom"));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Retry);
        assert_eq!(sink.queued_len("p1").await, 1);

        mock.set_send_error(None);
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 1);
    }

    #[tokio::test]
    async fn busy_send_race_keeps_queue() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_send_error(Some("busy"));
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Retry);
        assert_eq!(sink.queued_len("p1").await, 1);
    }

    #[tokio::test]
    async fn missing_conversation_row_drops_batch() {
        let (sink, mock) = fixture(DEFAULT_TTL);
        mock.set_folder(None);
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.flush_parent("p1").await, FlushOutcome::Settled);
        assert_eq!(mock.sends().len(), 0);
        assert_eq!(sink.queued_len("p1").await, 0);
    }

    /// The event hook's two triggers, exercised through a real bus: a queued
    /// notice is delivered when the parent's turn ends, and when the parent's
    /// conversation (re)connects.
    #[tokio::test]
    async fn queued_notice_waits_for_the_parents_next_event() {
        let bus = Arc::new(crate::acp::internal_bus::InternalEventBus::new(Arc::new(
            crate::acp::EventBusMetrics::default(),
        )));
        let mock = Arc::new(MockTransport::new(Some(busy_target(false)), Some(7)));
        let sink = DeliverySink::new(mock.clone()).with_event_bus(bus.clone());

        // Busy parent: queued, nothing sent, nothing steered (no capability).
        sink.enqueue(note("t1", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.queued_len("p1").await, 1);
        assert!(mock.sends().is_empty());

        // The turn ends: the flush runs off the event, no polling.
        mock.set_resolve(Some(idle_target()));
        bus.send(Arc::new(crate::acp::types::EventEnvelope {
            seq: 1,
            connection_id: "p1".into(),
            payload: crate::acp::types::AcpEvent::TurnComplete {
                session_id: "s1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "custom:test".into(),
            },
        }));
        let mut delivered = false;
        for _ in 0..50 {
            tokio::task::yield_now().await;
            if !mock.sends().is_empty() {
                delivered = true;
                break;
            }
        }
        assert!(delivered, "TurnComplete must flush the queue");
        assert_eq!(sink.queued_len("p1").await, 0);

        // A parent that was away when its child finished gets the notice on
        // the reconnect event, even though it never had a turn end.
        mock.set_resolve(None);
        sink.enqueue(note("t2", TaskStatus::Completed, Some("done")))
            .await;
        assert_eq!(sink.queued_len("p1").await, 1);
        mock.set_resolve(Some(idle_target()));
        bus.send(Arc::new(crate::acp::types::EventEnvelope {
            seq: 2,
            connection_id: "p1".into(),
            payload: crate::acp::types::AcpEvent::SessionStarted {
                session_id: "s1".into(),
            },
        }));
        let mut delivered = false;
        for _ in 0..50 {
            tokio::task::yield_now().await;
            if mock.sends().len() == 2 {
                delivered = true;
                break;
            }
        }
        assert!(delivered, "SessionStarted must flush the queue");
    }

    #[test]
    fn notification_text_single_completed() {
        let text = build_notification_text(&[note(
            "f426ae9c",
            TaskStatus::Completed,
            Some("all green"),
        )]);
        assert!(text.contains("Delegation result: 1 task finished."));
        assert!(text.contains("<codeg-delegation-result>"));
        assert!(text.contains("</codeg-delegation-result>"));
        assert!(text.contains("task f426ae9c (completed, codex):"));
        assert!(text.contains("all green"));
        assert!(text.contains("get_delegation_status([\"f426ae9c\"])"));
        assert!(text.contains("open child conversation #7"));
        assert!(text.contains("no reply needed"));
    }

    #[test]
    fn notification_text_multi_and_failures() {
        let mut failed = note("t2", TaskStatus::Failed, None);
        failed.error_code = Some("child_auth_required".into());
        failed.message = Some("needs login".into());
        let canceled = note("t3", TaskStatus::Canceled, None);
        let text = build_notification_text(&[
            note("t1", TaskStatus::Completed, Some("ok")),
            failed,
            canceled,
        ]);
        assert!(text.contains("3 tasks finished"));
        assert!(text.contains("task t2 (failed: child_auth_required — needs login)"));
        assert!(text.contains("task t3 (canceled — canceled)"));
        assert!(text.contains("get_delegation_status([\"t1\", \"t2\", \"t3\"])"));
    }

    #[test]
    fn notification_text_truncates_long_results() {
        let long = "x".repeat(RESULT_INLINE_CAP + 50);
        let text = build_notification_text(&[note(
            "t1",
            TaskStatus::Completed,
            Some(&long),
        )]);
        assert!(text.contains("truncated; full result via get_delegation_status"));
        assert!(text.chars().count() < RESULT_INLINE_CAP + 400);
    }

    #[test]
    fn notification_text_custom_agent_slug() {
        let mut n = note("t1", TaskStatus::Completed, Some("ok"));
        n.agent_type = AgentType::Custom("zcode");
        let text = build_notification_text(&[n]);
        assert!(text.contains("custom:zcode"), "got: {text}");
    }
}
