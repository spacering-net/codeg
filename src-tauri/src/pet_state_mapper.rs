//! Background task that aggregates broadcaster events into two pet streams:
//!
//! * `pet://state` — the *ambient* `PetState` derived from cross-connection
//!   ACP signals (idle/waiting/running/failed). De-duplicated; only emitted
//!   when the computed state changes.
//! * `pet://oneshot` — *transient* feedback animations triggered by discrete
//!   events (PendingReview, failed turn_complete stop reasons, git
//!   commit/push, merge abort, agent install, manual `pet_celebrate` calls).
//!   Always emitted; the renderer plays a few loops and falls back to the
//!   current ambient state.
//!
//! Phase 5: ACP events are now consumed from `InternalEventBus`
//! (`Arc<EventEnvelope>`, no JSON parse), while folder/app non-ACP channels
//! continue to flow through `WebEventBroadcaster`. The subscriber selects
//! over both receivers in the same `tokio::select!` loop.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::acp::internal_bus::InternalEventBus;
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope};
use crate::db::entities::conversation::ConversationStatus;
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::models::pet::PetState;
use crate::web::event_bridge::{emit_event, EventEmitter, WebEvent, WebEventBroadcaster};

/// Shared latest-known `PetState`, written by the subscriber task and read
/// by the `pet_get_current_state` command. Lets a freshly opened pet window
/// pick up the *current* ambient state instead of waiting for the next
/// state transition — the subscriber only emits on changes, so without this
/// the frontend would otherwise sit on its default `Idle` indefinitely if
/// the agent was already running when the window opened.
pub type PetStateHandle = Arc<RwLock<PetState>>;

pub fn new_pet_state_handle() -> PetStateHandle {
    Arc::new(RwLock::new(PetState::Idle))
}

/// Read the current ambient state. Falls back to `Idle` if the lock is
/// poisoned — a poisoned lock means the writer panicked, in which case
/// the snapshot is stale and `Idle` is the safe default.
pub fn read_pet_state(handle: &PetStateHandle) -> PetState {
    handle.read().map(|guard| *guard).unwrap_or(PetState::Idle)
}

fn write_pet_state(handle: &PetStateHandle, value: PetState) {
    match handle.write() {
        Ok(mut guard) => *guard = value,
        Err(err) => {
            // A poisoned lock means a previous writer panicked. The handle
            // is now permanently stale, which would silently degrade the
            // open-pet-mid-conversation experience to "always Idle" with no
            // other symptom. Surface it so it shows up in operator logs.
            tracing::info!("[Pet] pet_state handle poisoned, dropping write: {err}");
        }
    }
}

/// How long the ambient `Failed` state stays visible before automatically
/// fading back to whatever the rest of the snapshot would compute. Restarts
/// each time a fresh error event arrives.
const PET_FAILED_RECOVERY_MS: u64 = 4_000;

/// Aggregate snapshot of cross-connection ACP signals, derived from the
/// stream of `AcpEvent`s. Pure data — `compute_pet_state` is the sole
/// source of truth for translating it into a `PetState`.
#[derive(Debug, Clone, Default)]
pub struct PetGlobalState {
    /// Connections currently in `Prompting` (an in-flight prompt is streaming).
    prompting: HashSet<String>,
    /// Connections in a terminal `Error` state. We treat any error event as
    /// authoritative even if a later `StatusChanged` clears it — Codex's
    /// `failed` row should briefly play, then the next event will reset it.
    erroring: HashSet<String>,
    /// Outstanding permission requests (request_id → connection_id). The
    /// presence of *any* outstanding permission keeps ambient state at
    /// `Waiting` until the user resolves it.
    pending_permissions: HashMap<String, String>,
    /// Connection ids of in-flight delegation sub-agents. Their status events
    /// ride the parent's emitter onto this bus, but a sub-agent is not a
    /// user-facing session — it's surfaced inline in its parent's transcript
    /// and excluded from the pet badge/panel. We track child ids here and
    /// ignore their ambient signals so the pet's busy state stays consistent
    /// with the session list (otherwise the pet looks "running" while the
    /// panel shows nothing). Populated by `DelegationStarted`, cleared by
    /// `DelegationCompleted`.
    delegation_children: HashSet<String>,
}

impl PetGlobalState {
    pub fn apply(&mut self, env: &EventEnvelope) {
        let conn = &env.connection_id;
        match &env.payload {
            // A delegation sub-agent is not a user-facing session. Remember its
            // connection id so its own ambient signals are ignored, and scrub
            // anything those signals may have recorded already — the child's
            // `StatusChanged{Prompting}` can reach the bus just before this
            // event does. (These two events carry the *parent's* connection id
            // in the envelope; the child id is in the payload.)
            //
            // `pending_permissions` is deliberately NOT scrubbed here. The
            // broker starts the child's turn BEFORE it emits this event
            // (`send_prompt_linked_for_delegation` precedes `emit_started_if_real`),
            // so a child that hits a permission immediately raises it first —
            // and that is precisely the state the sprite must keep showing.
            // Scrubbing it would leave the sprite Idle/Running while the panel
            // and badge (which read live `SessionState`, not this event stream)
            // both say waiting.
            AcpEvent::DelegationStarted {
                child_connection_id,
                ..
            } => {
                self.delegation_children.insert(child_connection_id.clone());
                self.prompting.remove(child_connection_id);
                self.erroring.remove(child_connection_id);
            }
            AcpEvent::DelegationCompleted {
                child_connection_id,
                ..
            } => {
                self.delegation_children.remove(child_connection_id);
                self.prompting.remove(child_connection_id);
                self.erroring.remove(child_connection_id);
                self.pending_permissions
                    .retain(|_, cid| cid != child_connection_id);
            }
            // A known sub-agent's WORK never drives ambient state: it must not
            // land in `prompting` / `erroring`, because the panel (which the
            // badge shares a payload with) excludes working sub-agents and the
            // pet would look busy over a list showing nothing.
            //
            // Its pending PERMISSION does, though — the child is blocked until
            // the user clicks, the panel keeps exactly those rows, and no other
            // ambient surface reports it (#447). So this arm is a filter, not a
            // blanket drop: permission bookkeeping passes through, everything
            // else is swallowed.
            _ if self.delegation_children.contains(conn) => match &env.payload {
                AcpEvent::PermissionRequest { request_id, .. } => {
                    self.pending_permissions
                        .insert(request_id.clone(), conn.clone());
                }
                AcpEvent::PermissionResolved { request_id } => {
                    self.pending_permissions.remove(request_id);
                }
                // Same bound as the root-session arms below: a permission can't
                // outlive the turn that raised it, and a dead connection can't
                // be answered. Without these a child torn down mid-prompt would
                // pin the sprite on `Waiting` forever.
                AcpEvent::TurnComplete { .. } => {
                    self.pending_permissions.retain(|_, cid| cid != conn);
                }
                // Disconnect also forgets the child so dead ids don't pile up —
                // this is what cleans up a `DelegationCompleted` dropped on a
                // bus overrun (the child id is otherwise preserved across the
                // reset).
                AcpEvent::StatusChanged {
                    status: ConnectionStatus::Disconnected,
                } => {
                    self.delegation_children.remove(conn);
                    self.pending_permissions.retain(|_, cid| cid != conn);
                }
                _ => {}
            },
            AcpEvent::StatusChanged { status } => match status {
                ConnectionStatus::Prompting => {
                    self.prompting.insert(conn.clone());
                    self.erroring.remove(conn);
                }
                ConnectionStatus::Connected | ConnectionStatus::Connecting => {
                    self.prompting.remove(conn);
                    self.erroring.remove(conn);
                }
                ConnectionStatus::Error => {
                    self.erroring.insert(conn.clone());
                    self.prompting.remove(conn);
                }
                ConnectionStatus::Disconnected => {
                    self.prompting.remove(conn);
                    self.erroring.remove(conn);
                    self.pending_permissions.retain(|_, cid| cid != conn);
                }
            },
            AcpEvent::Error { .. } => {
                self.erroring.insert(conn.clone());
            }
            AcpEvent::PermissionRequest { request_id, .. } => {
                self.pending_permissions
                    .insert(request_id.clone(), conn.clone());
            }
            AcpEvent::PermissionResolved { request_id } => {
                // User answered (allow/reject) or chat-channel auto-approve
                // ran. responder.respond() is RPC-only with no follow-up
                // event of its own, so the connection emits this synthetic
                // event right after sending the response. Without it the
                // entry lives on until TurnComplete, which for Plan
                // approvals (ExitPlanMode) is the entire post-approval
                // implementation window — pinning the pet on Waiting
                // throughout.
                self.pending_permissions.remove(request_id);
            }
            AcpEvent::TurnComplete { .. } => {
                self.prompting.remove(conn);
                // A permission request is bounded by the turn that raised it:
                // by the time TurnComplete arrives the user has either
                // approved (agent reached end_turn / refusal / max_tokens)
                // or the turn was cancelled. There is no separate event
                // when the user clicks allow/deny — the response goes
                // straight back to the agent through `responder.respond()`
                // — so this is the only deterministic place to drop the
                // entry. Without this, a single past permission would mask
                // Running across the entire app until the connection drops.
                self.pending_permissions.retain(|_, cid| cid != conn);
            }
            _ => {}
        }
    }

    /// Reset the volatile signal sets after a bus overrun. We can't reconstruct
    /// `prompting` / `erroring` / `pending_permissions` from dropped events, so
    /// we clear them and let the next `StatusChanged` batch reseed. Crucially
    /// `delegation_children` is PRESERVED: an in-flight sub-agent won't
    /// re-announce itself with another `DelegationStarted`, so dropping its
    /// classification here would let its later events be mistaken for a real
    /// session — the pet would look "running" while the badge/panel still
    /// exclude it. A child whose `DelegationCompleted` was also dropped is
    /// cleaned up when its connection disconnects (and is otherwise harmless —
    /// connection ids are never reused).
    fn reset_after_overrun(&mut self) {
        self.prompting.clear();
        self.erroring.clear();
        self.pending_permissions.clear();
    }
}

/// Pure function: aggregate → state. Order of checks defines priority.
///
/// Priority rationale, top-down:
///
/// * `Failed` — most urgent, brief auto-recovery handles the linger.
/// * `Waiting` from `pending_permissions` — blocking: the agent literally
///   cannot proceed without the user clicking allow/deny, so it outranks
///   any concurrent prompt elsewhere. Renders as `Waiting` (not a separate
///   highlight) so the cue blends with the regular idle-but-reachable
///   state; the actual permission dialog is what demands the user's
///   attention, the pet just stops looking busy. This is the ONE signal a
///   delegation sub-agent can contribute (see `apply`'s sub-agent arm and
///   `pet_list_active_sessions_core`, which keeps exactly those rows).
/// * `Running` from `prompting` — active work elsewhere.
/// * `Idle` — nothing blocking or running.
///
/// `ConversationStatus::PendingReview` no longer feeds ambient state: it
/// fires a one-shot `pet://oneshot = "review"` cue at the moment the
/// review becomes pending, then the pet returns to whichever ambient
/// state the snapshot computes. See the subscriber loop for the trigger.
pub fn compute_pet_state(snapshot: &PetGlobalState) -> PetState {
    if !snapshot.erroring.is_empty() {
        return PetState::Failed;
    }
    if !snapshot.pending_permissions.is_empty() {
        return PetState::Waiting;
    }
    if !snapshot.prompting.is_empty() {
        return PetState::Running;
    }
    PetState::Idle
}

/// Pet only reacts to a small subset of ACP event types. Filtering at the
/// dispatcher level avoids cloning / matching downstream when the bus
/// fires for high-volume content / tool / thinking deltas.
fn is_acp_event_relevant(payload: &AcpEvent) -> bool {
    matches!(
        payload,
        AcpEvent::StatusChanged { .. }
            | AcpEvent::Error { .. }
            | AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
            | AcpEvent::TurnComplete { .. }
            | AcpEvent::ConversationStatusChanged { .. }
            // Tracked so a sub-agent's connection can be filtered out of
            // ambient state (it must not make the pet look "running" when the
            // panel — which excludes sub-agents — shows nothing).
            | AcpEvent::DelegationStarted { .. }
            | AcpEvent::DelegationCompleted { .. }
    )
}

/// Map a `TurnComplete.stop_reason` to a oneshot animation, if any. Successful
/// turns are represented by the subsequent `PendingReview` transition so the
/// renderer receives exactly one completion cue.
fn classify_turn_complete(stop_reason: &str) -> Option<PetState> {
    match stop_reason {
        "refusal" | "max_tokens" | "max_turn_requests" | "unknown" | "empty" | "auth_required"
        | "rejected" => Some(PetState::Failed),
        // `end_turn` is covered by PendingReview; `cancelled` and future reasons stay silent.
        _ => None,
    }
}

/// Map an `app://agent-install` event payload to a oneshot animation.
/// `started` / `log` are noisy progress signals; only the terminal kinds
/// `completed` / `failed` produce a reaction.
fn classify_agent_install(payload: &serde_json::Value) -> Option<PetState> {
    let kind = payload.get("kind").and_then(|v| v.as_str())?;
    match kind {
        "completed" => Some(PetState::Jumping),
        "failed" => Some(PetState::Failed),
        _ => None,
    }
}

fn emit_oneshot(emitter: &EventEmitter, kind: PetState) {
    emit_event(emitter, "pet://oneshot", kind);
}

/// Schedule (or restart) the auto-recovery timer that will clear the
/// `erroring` set after `PET_FAILED_RECOVERY_MS`. Aborts any in-flight
/// timer first so successive errors keep the failed animation visible
/// for the full window after the *latest* error.
fn schedule_failed_recovery(clear_task: &mut Option<JoinHandle<()>>, clear_tx: &mpsc::Sender<()>) {
    cancel_failed_recovery(clear_task);
    let tx = clear_tx.clone();
    *clear_task = Some(tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(PET_FAILED_RECOVERY_MS)).await;
        // `try_send` instead of awaiting: the channel is sized for the
        // worst case (8 messages) and the main loop is the only consumer,
        // so the only way send would block is a stuck consumer — in which
        // case adding more messages can't help. A drop here just means
        // the failed animation lingers slightly longer than the window,
        // which is benign.
        let _ = tx.try_send(());
    }));
}

fn cancel_failed_recovery(clear_task: &mut Option<JoinHandle<()>>) {
    if let Some(t) = clear_task.take() {
        t.abort();
    }
}

/// Spawn-friendly subscriber loop. Mirrors `lifecycle_subscriber_task`'s
/// "subscribe synchronously, return future" shape so each broadcast/bus
/// buffer covers the gap between `subscribe()` and the first `recv()`.
///
/// Dual-source design: ACP envelopes (typed) flow in through `bus`, while
/// folder/app side-channel notifications stay on `broadcaster`. The two
/// receivers are select!'d over a shared `select!` arm; every other arm
/// (recovery timer, channel close) is unchanged from the single-source
/// version. Splitting buses lets ACP consumers skip the JSON reparse and
/// — crucially — lets us drop the `acp://event` channel from the global
/// firehose entirely (eliminating the WS receiver-side dedup hack).
pub fn pet_state_subscriber_task(
    bus: Arc<InternalEventBus>,
    broadcaster: Arc<WebEventBroadcaster>,
    emitter: EventEmitter,
    handle: PetStateHandle,
) -> impl Future<Output = ()> + Send + 'static {
    let mut acp_rx = bus.subscribe();
    let mut web_rx = broadcaster.subscribe();
    let metrics = Arc::clone(bus.metrics());
    let (clear_tx, mut clear_rx) = mpsc::channel::<()>(8);
    async move {
        let mut snapshot = PetGlobalState::default();
        let mut last_state = PetState::Idle;
        let mut clear_task: Option<JoinHandle<()>> = None;
        // Push an initial "idle" snapshot so the renderer doesn't start blank.
        write_pet_state(&handle, last_state);
        emit_event(&emitter, "pet://state", last_state);

        // Separate throttles for the two lag signals: the internal ACP bus and
        // the web side-channel broadcaster overflow independently, so a burst on
        // one must not suppress the other's first line.
        let mut acp_lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);
        let mut web_lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);

        loop {
            tokio::select! {
                acp_event = acp_rx.recv() => {
                    match acp_event {
                        Ok(envelope_arc) => {
                            let envelope = envelope_arc.as_ref();
                            if !is_acp_event_relevant(&envelope.payload) {
                                continue;
                            }

                            // Fire the turn_complete oneshot *before*
                            // applying — the apply step removes the
                            // connection from `prompting`, but the
                            // celebration should reference the turn
                            // that just ended either way.
                            if let AcpEvent::TurnComplete { stop_reason, .. } =
                                &envelope.payload
                            {
                                if let Some(kind) = classify_turn_complete(stop_reason) {
                                    emit_oneshot(&emitter, kind);
                                }
                            }

                            // PendingReview fires a one-shot cue rather than
                            // ambient state, so a single un-acked review can't
                            // pin the pet on `review` for the rest of the
                            // session.
                            if let AcpEvent::ConversationStatusChanged {
                                status: ConversationStatus::PendingReview,
                                ..
                            } = &envelope.payload
                            {
                                emit_oneshot(&emitter, PetState::Review);
                            }

                            let was_erroring = !snapshot.erroring.is_empty();
                            snapshot.apply(envelope);
                            let now_erroring = !snapshot.erroring.is_empty();

                            let triggered_error = matches!(
                                envelope.payload,
                                AcpEvent::Error { .. }
                                    | AcpEvent::StatusChanged {
                                        status: ConnectionStatus::Error,
                                    }
                            );
                            if triggered_error && now_erroring {
                                schedule_failed_recovery(&mut clear_task, &clear_tx);
                            } else if was_erroring && !now_erroring {
                                // erroring went empty without us firing the
                                // recovery timer — e.g. Connected/Disconnected
                                // events that pruned the last erroring conn —
                                // so cancel the pending sleep to avoid a
                                // phantom recompute later.
                                cancel_failed_recovery(&mut clear_task);
                            }
                            // ACP is the only path that mutates `snapshot`,
                            // so ambient recompute is gated to this arm.
                            let next = compute_pet_state(&snapshot);
                            if next != last_state {
                                last_state = next;
                                write_pet_state(&handle, next);
                                emit_event(&emitter, "pet://state", next);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            // Bus overrun — we can't reliably reconstruct
                            // state from the missed events, so reset to Idle
                            // and rely on the next batch of
                            // StatusChanged/Connected events to reseed the
                            // snapshot. A persistent lag without follow-up
                            // events would leave the pet stuck on idle even
                            // if connections are still active; surface it on
                            // the metric so operators can spot it. The metric is
                            // the authoritative loss record, so it's bumped
                            // unconditionally; only the log line is throttled.
                            metrics.lagged_count.fetch_add(skipped, Ordering::Relaxed);
                            if let Some(s) = acp_lag_throttle.record(skipped) {
                                tracing::warn!(
                                    "[Pet] internal bus lagged: dropped {} events across \
                                     {} occurrence(s) in the last {}s; resetting to idle",
                                    s.dropped,
                                    s.occurrences,
                                    LAG_LOG_WINDOW.as_secs()
                                );
                            }
                            // Clear the volatile signals (reseeded from the next
                            // StatusChanged batch) but KEEP the delegation-child
                            // classification — a running sub-agent won't re-fire
                            // DelegationStarted, so forgetting it here would let
                            // its events drive ambient state again (the bug this
                            // exclusion fixes), under the overrun recovery path.
                            snapshot.reset_after_overrun();
                            cancel_failed_recovery(&mut clear_task);
                            if last_state != PetState::Idle {
                                last_state = PetState::Idle;
                                write_pet_state(&handle, last_state);
                                emit_event(&emitter, "pet://state", last_state);
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            cancel_failed_recovery(&mut clear_task);
                            break;
                        }
                    }
                }
                web_event = web_rx.recv() => {
                    match web_event {
                        Ok(WebEvent { channel, payload }) => {
                            // Folder/app side-channels stay on the JSON
                            // broadcaster: they aren't ACP envelopes, and the
                            // emitters (folder commands, agent installer)
                            // don't go through `emit_with_state`.
                            match channel.as_str() {
                                "folder://git-commit-succeeded"
                                | "folder://git-push-succeeded" => {
                                    emit_oneshot(&emitter, PetState::Jumping);
                                }
                                "folder://merge-aborted" => {
                                    emit_oneshot(&emitter, PetState::Failed);
                                }
                                "app://agent-install" => {
                                    if let Some(kind) = classify_agent_install(payload.as_ref()) {
                                        emit_oneshot(&emitter, kind);
                                    }
                                }
                                _ => continue,
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(skipped)) => {
                            // Web broadcaster lag is a different signal:
                            // these are fire-and-forget side-channel events
                            // (a lost git-commit ping is benign), so just
                            // log and keep going. No snapshot reset.
                            if let Some(s) = web_lag_throttle.record(skipped) {
                                tracing::warn!(
                                    "[Pet] web broadcaster lagged: dropped {} non-ACP events \
                                     across {} occurrence(s) in the last {}s",
                                    s.dropped,
                                    s.occurrences,
                                    LAG_LOG_WINDOW.as_secs()
                                );
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            cancel_failed_recovery(&mut clear_task);
                            break;
                        }
                    }
                }
                Some(_) = clear_rx.recv() => {
                    // Recovery timer fired — drop the failed-state lock and
                    // recompute the ambient state from whatever else is
                    // currently active.
                    snapshot.erroring.clear();
                    clear_task = None;
                    let next = compute_pet_state(&snapshot);
                    if next != last_state {
                        last_state = next;
                        write_pet_state(&handle, next);
                        emit_event(&emitter, "pet://state", next);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(id: &str, payload: AcpEvent) -> EventEnvelope {
        EventEnvelope {
            seq: 0,
            connection_id: id.to_string(),
            payload,
        }
    }

    #[test]
    fn idle_when_empty() {
        let s = PetGlobalState::default();
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn idle_when_connected_but_not_prompting() {
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn prompting_yields_running() {
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);
    }

    #[test]
    fn permission_pending_yields_waiting() {
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);
    }

    #[test]
    fn error_dominates_everything() {
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::Error {
                message: "boom".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Failed);
    }

    #[test]
    fn concurrent_prompts_stay_running_through_partial_completion() {
        // Two connections prompting at the same time. When one finishes,
        // the pet should keep showing Running because the other is still
        // actively prompting; once both are connected, ambient drops to
        // Idle (PendingReview no longer feeds ambient state).
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c2",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);

        s.apply(&env(
            "c1",
            AcpEvent::TurnComplete {
                session_id: "s1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);

        s.apply(&env(
            "c2",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn pending_review_does_not_change_ambient_state() {
        // Regression: a stale PendingReview used to pin ambient to Review
        // for the rest of the session. It must now be a no-op for ambient
        // (the subscriber loop fires a one-shot instead).
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::ConversationStatusChanged {
                conversation_id: 1,
                status: ConversationStatus::PendingReview,
            },
        ));
        assert_eq!(
            compute_pet_state(&s),
            PetState::Idle,
            "PendingReview must not promote ambient state above Idle"
        );
    }

    #[test]
    fn turn_complete_clears_permission_for_that_connection() {
        // The user responds to a permission via `RespondPermission` which
        // bypasses the broadcaster — there is no AcpEvent fired on
        // resolution. TurnComplete is the only deterministic close of the
        // permission lifecycle, so leaving entries here past TurnComplete
        // would keep ambient pinned at Waiting (and outranking Running)
        // across every conversation indefinitely.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);

        s.apply(&env(
            "c1",
            AcpEvent::TurnComplete {
                session_id: "s1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));

        assert!(
            s.pending_permissions.is_empty(),
            "permission entry must not survive TurnComplete"
        );
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn turn_complete_only_clears_permissions_for_finishing_connection() {
        // Concurrent turns: c1 finishes while c2 still has an outstanding
        // permission. c2's entry must survive — only the connection that
        // emitted TurnComplete is scrubbed.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c2",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        s.apply(&env(
            "c2",
            AcpEvent::PermissionRequest {
                request_id: "r2".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        assert_eq!(s.pending_permissions.len(), 2);

        s.apply(&env(
            "c1",
            AcpEvent::TurnComplete {
                session_id: "s1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        ));

        assert_eq!(s.pending_permissions.len(), 1);
        assert!(s.pending_permissions.contains_key("r2"));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);
    }

    #[test]
    fn permission_resolved_clears_matching_entry() {
        // The user answering allow/reject must drop the pet out of Waiting
        // immediately — without waiting for the eventual TurnComplete. This
        // is the post-Plan-approval case: the agent then runs for minutes
        // doing implementation work, and the pet would otherwise sit on
        // Waiting through all of it.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);

        s.apply(&env(
            "c1",
            AcpEvent::PermissionResolved {
                request_id: "r1".into(),
            },
        ));
        assert!(s.pending_permissions.is_empty());
        assert_eq!(
            compute_pet_state(&s),
            PetState::Running,
            "after resolving the permission, the still-prompting connection should surface as Running"
        );
    }

    #[test]
    fn permission_resolved_for_unknown_id_is_noop() {
        // Late / duplicate resolution events must not disturb other
        // outstanding permissions.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::PermissionResolved {
                request_id: "r-stale".into(),
            },
        ));
        assert_eq!(s.pending_permissions.len(), 1);
        assert_eq!(compute_pet_state(&s), PetState::Waiting);
    }

    #[test]
    fn permission_request_outranks_active_prompting() {
        // An outstanding permission is blocking — the agent literally can't
        // proceed without user input — so it must outrank Running even
        // when a different connection is mid-prompt. It surfaces as
        // Waiting (the actual permission dialog is what demands attention,
        // the pet just stops looking busy).
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&env(
            "c2",
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);
    }

    #[test]
    fn disconnect_clears_state() {
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        s.apply(&env(
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    fn delegation_started(parent: &str, child: &str) -> EventEnvelope {
        env(
            parent,
            AcpEvent::DelegationStarted {
                parent_connection_id: parent.into(),
                parent_tool_use_id: "tu-1".into(),
                child_connection_id: child.into(),
                child_conversation_id: 1,
                agent_type: crate::models::agent::AgentType::Codex,
                task_preview: "run the tests".into(),
                task_id: "task-pet-1".into(),
            },
        )
    }

    fn delegation_completed(parent: &str, child: &str) -> EventEnvelope {
        env(
            parent,
            AcpEvent::DelegationCompleted {
                parent_connection_id: parent.into(),
                parent_tool_use_id: "tu-1".into(),
                child_connection_id: child.into(),
                child_conversation_id: 1,
                agent_type: crate::models::agent::AgentType::Codex,
                result: crate::acp::types::DelegationResultSummary::Ok {
                    duration_ms: 0,
                    text_preview: None,
                },
            },
        )
    }

    #[test]
    fn delegation_child_prompting_does_not_make_pet_running() {
        // A sub-agent's prompt must not drive the ambient state — it isn't a
        // user-facing session (it's excluded from the badge/panel), so the pet
        // would otherwise look busy while the panel shows nothing.
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn delegation_child_prompting_before_started_is_scrubbed() {
        // The child's StatusChanged can race ahead of DelegationStarted (they
        // travel the same bus from different connections). Until we learn it's
        // a child it counts; once DelegationStarted lands it's scrubbed.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);

        s.apply(&delegation_started("parent", "child"));
        assert_eq!(
            compute_pet_state(&s),
            PetState::Idle,
            "child must be scrubbed from prompting once known to be a sub-agent"
        );
    }

    #[test]
    fn delegation_child_error_does_not_fail_the_pet() {
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        s.apply(&env(
            "child",
            AcpEvent::Error {
                message: "boom".into(),
                agent_type: "codex".into(),
                code: None,
                details: None,
                terminal: true,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn parent_stays_running_through_its_childs_lifecycle() {
        // The parent waiting on its delegation is a real running session and
        // must keep the pet Running while the child is ignored throughout.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "parent",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&delegation_started("parent", "child"));
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);

        s.apply(&delegation_completed("parent", "child"));
        assert_eq!(
            compute_pet_state(&s),
            PetState::Running,
            "the parent is still prompting after its child finishes"
        );

        s.apply(&env(
            "parent",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn overrun_reset_preserves_delegation_child_classification() {
        // Regression: a bus overrun clears the volatile signals but must NOT
        // forget which connections are sub-agents — otherwise the child's
        // later events drive ambient state again while the panel excludes it.
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        s.apply(&env(
            "parent",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);

        // Simulate the overrun recovery.
        s.reset_after_overrun();
        assert_eq!(compute_pet_state(&s), PetState::Idle);

        // The child keeps prompting after the reset — still ignored.
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(
            compute_pet_state(&s),
            PetState::Idle,
            "sub-agent must stay excluded across an overrun reset"
        );

        // The parent reseeds normally from its next event.
        s.apply(&env(
            "parent",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Running);
    }

    #[test]
    fn delegation_child_forgotten_on_disconnect() {
        // A child id is dropped when its connection disconnects, so the set
        // can't accumulate dead ids (and a missed DelegationCompleted during
        // an overrun is still cleaned up).
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        assert!(s.delegation_children.contains("child"));
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        ));
        assert!(
            !s.delegation_children.contains("child"),
            "a disconnected sub-agent must be removed from the tracked set"
        );
    }

    /// A permission request on a delegation child (`child`), matching the
    /// helpers above.
    fn child_permission(request_id: &str) -> EventEnvelope {
        env(
            "child",
            AcpEvent::PermissionRequest {
                request_id: request_id.into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
        )
    }

    #[test]
    fn delegation_child_permission_makes_pet_wait() {
        // #447: a sub-agent blocked on a permission has no other ambient
        // surface — it's hidden from every tab/picker and the parent's own row
        // says "running". The sprite is the signal, so this one child event is
        // deliberately NOT swallowed by the sub-agent filter.
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        s.apply(&child_permission("r1"));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);
    }

    #[test]
    fn a_child_permission_racing_ahead_of_delegation_started_survives() {
        // The broker starts the child's turn before announcing the delegation,
        // so a child that blocks immediately raises its permission FIRST. If
        // `DelegationStarted` scrubbed it, the sprite would drop back to Idle
        // while the panel and badge — which read live SessionState, not this
        // event stream — both still say waiting.
        let mut s = PetGlobalState::default();
        s.apply(&child_permission("r1"));
        s.apply(&delegation_started("parent", "child"));
        assert_eq!(compute_pet_state(&s), PetState::Waiting);

        // Still bounded: resolving it clears the sprite as usual.
        s.apply(&env(
            "child",
            AcpEvent::PermissionResolved {
                request_id: "r1".into(),
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn delegation_started_still_scrubs_a_childs_prompting() {
        // The other half of the same race is unchanged: a child's WORK must
        // never make the pet look busy, since the panel excludes working
        // sub-agents and the two must agree.
        let mut s = PetGlobalState::default();
        s.apply(&env(
            "child",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        ));
        s.apply(&delegation_started("parent", "child"));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn delegation_child_permission_clears_on_resolve() {
        let mut s = PetGlobalState::default();
        s.apply(&delegation_started("parent", "child"));
        s.apply(&child_permission("r1"));
        s.apply(&env(
            "child",
            AcpEvent::PermissionResolved {
                request_id: "r1".into(),
            },
        ));
        assert_eq!(compute_pet_state(&s), PetState::Idle);
    }

    #[test]
    fn delegation_child_permission_cannot_outlive_its_child() {
        // Both bounds that keep a child from pinning the sprite on Waiting: the
        // turn that raised the permission ending, and the connection dying
        // without ever resolving it.
        for terminal in [
            AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "cancelled".into(),
                agent_type: "codex".into(),
            },
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        ] {
            let mut s = PetGlobalState::default();
            s.apply(&delegation_started("parent", "child"));
            s.apply(&child_permission("r1"));
            assert_eq!(compute_pet_state(&s), PetState::Waiting);
            s.apply(&env("child", terminal.clone()));
            assert_eq!(
                compute_pet_state(&s),
                PetState::Idle,
                "an unanswered child permission must not survive {terminal:?}"
            );
        }
    }

    #[test]
    fn event_filter_accepts_only_pet_relevant_events() {
        // Pet-relevant variants — must pass the filter.
        let accepted: Vec<AcpEvent> = vec![
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
            AcpEvent::Error {
                message: "x".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
            AcpEvent::PermissionRequest {
                request_id: "r1".into(),
                tool_call: serde_json::json!({}),
                options: vec![],
                queued: 0,
            },
            AcpEvent::PermissionResolved {
                request_id: "r1".into(),
            },
            AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
            AcpEvent::ConversationStatusChanged {
                conversation_id: 1,
                status: ConversationStatus::PendingReview,
            },
        ];
        for ev in &accepted {
            assert!(
                is_acp_event_relevant(ev),
                "expected {ev:?} to be pet-relevant"
            );
        }

        // High-volume / streaming variants — must NOT trigger the filter.
        let ignored: Vec<AcpEvent> = vec![
            AcpEvent::ContentDelta { text: "x".into(), parent_tool_use_id: None },
            AcpEvent::Thinking { text: "x".into(), parent_tool_use_id: None },
            AcpEvent::UsageUpdate { used: 1, size: 1 },
            AcpEvent::SessionStarted {
                session_id: "ext".into(),
            },
        ];
        for ev in &ignored {
            assert!(!is_acp_event_relevant(ev), "expected {ev:?} to be ignored");
        }
    }

    /// Build a fresh `(bus, broadcaster, rx, emitter)` quad and spawn the
    /// subscriber against it. Most tests need exactly this setup; the
    /// helper keeps the noise out of the assertion bodies.
    fn spawn_test_subscriber(
        handle: PetStateHandle,
    ) -> (
        Arc<InternalEventBus>,
        Arc<WebEventBroadcaster>,
        broadcast::Receiver<WebEvent>,
    ) {
        let metrics = Arc::new(crate::acp::EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        // The emitter's `bus` is unused in these tests (we don't call
        // `emit_with_state`); only its broadcaster is — `pet://state` /
        // `pet://oneshot` go through `emit_event` → broadcaster.
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let rx = broadcaster.subscribe();
        tokio::spawn(pet_state_subscriber_task(
            bus.clone(),
            broadcaster.clone(),
            emitter,
            handle,
        ));
        (bus, broadcaster, rx)
    }

    #[test]
    fn classify_turn_complete_maps_known_reasons() {
        assert_eq!(classify_turn_complete("end_turn"), None);
        assert_eq!(classify_turn_complete("refusal"), Some(PetState::Failed));
        assert_eq!(classify_turn_complete("max_tokens"), Some(PetState::Failed));
        assert_eq!(
            classify_turn_complete("max_turn_requests"),
            Some(PetState::Failed)
        );
        assert_eq!(classify_turn_complete("unknown"), Some(PetState::Failed));
        assert_eq!(classify_turn_complete("empty"), Some(PetState::Failed));
        assert_eq!(
            classify_turn_complete("auth_required"),
            Some(PetState::Failed)
        );
        assert_eq!(classify_turn_complete("cancelled"), None);
        assert_eq!(classify_turn_complete("future_reason"), None);
    }

    #[test]
    fn classify_agent_install_terminal_kinds_only() {
        assert_eq!(
            classify_agent_install(&serde_json::json!({ "kind": "completed" })),
            Some(PetState::Jumping)
        );
        assert_eq!(
            classify_agent_install(&serde_json::json!({ "kind": "failed" })),
            Some(PetState::Failed)
        );
        assert_eq!(
            classify_agent_install(&serde_json::json!({ "kind": "started" })),
            None
        );
        assert_eq!(
            classify_agent_install(&serde_json::json!({ "kind": "log" })),
            None
        );
        assert_eq!(classify_agent_install(&serde_json::json!({})), None);
    }

    /// Helper for tests that drive ACP events: build the typed envelope
    /// then push through `bus.send`. Mirrors what `emit_with_state` does
    /// in production (without the SessionState / `event_seq` plumbing).
    fn send_acp(bus: &Arc<InternalEventBus>, seq: u64, conn: &str, payload: AcpEvent) {
        bus.send(Arc::new(EventEnvelope {
            seq,
            connection_id: conn.into(),
            payload,
        }));
    }

    #[tokio::test]
    async fn subscriber_emits_oneshot_for_git_commit_succeeded() {
        let (_bus, broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());

        // Drain the initial `pet://state = idle` emit.
        let _ = rx.recv().await;

        broadcaster.send(
            "folder://git-commit-succeeded",
            &serde_json::json!({ "folder_id": 1, "committed_files": 3 }),
        );

        // Skip our own re-broadcast of the input event by reading until oneshot.
        let evt = read_until_oneshot(&mut rx).await;
        assert_eq!(evt.channel, "pet://oneshot");
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("jumping"));
    }

    #[tokio::test]
    async fn subscriber_emits_oneshot_for_merge_aborted() {
        let (_bus, broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        let _ = rx.recv().await; // initial idle

        broadcaster.send(
            "folder://merge-aborted",
            &serde_json::json!({ "folder_id": 7 }),
        );

        let evt = read_until_oneshot(&mut rx).await;
        assert_eq!(evt.channel, "pet://oneshot");
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("failed"));
    }

    #[tokio::test]
    async fn subscriber_emits_oneshot_for_agent_install_completed() {
        let (_bus, broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        let _ = rx.recv().await;

        broadcaster.send(
            "app://agent-install",
            &serde_json::json!({
                "task_id": "t1",
                "kind": "completed",
                "payload": "",
            }),
        );

        let evt = read_until_oneshot(&mut rx).await;
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("jumping"));
    }

    #[tokio::test]
    async fn subscriber_emits_oneshot_for_pending_review() {
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        let _ = rx.recv().await; // initial idle

        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::ConversationStatusChanged {
                conversation_id: 7,
                status: ConversationStatus::PendingReview,
            },
        );

        let evt = read_until_oneshot(&mut rx).await;
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("review"));
    }

    #[tokio::test]
    async fn subscriber_does_not_promote_ambient_state_for_pending_review() {
        // Beyond firing the one-shot, the PendingReview event must not
        // bump ambient state above whatever the snapshot would compute.
        // Without an active connection in the snapshot, ambient stays
        // Idle even after a PendingReview lands.
        let handle = new_pet_state_handle();
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(handle.clone());
        let _ = rx.recv().await; // initial idle

        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::ConversationStatusChanged {
                conversation_id: 7,
                status: ConversationStatus::PendingReview,
            },
        );

        // Read the one-shot first.
        let oneshot = read_until_oneshot(&mut rx).await;
        assert_eq!(oneshot.payload.as_ref(), &serde_json::json!("review"));
        // Handle (snapshot read by freshly-opened windows) must remain on
        // the previous ambient state, not be promoted to Review.
        assert_eq!(read_pet_state(&handle), PetState::Idle);
    }

    #[tokio::test]
    async fn subscriber_does_not_emit_oneshot_for_turn_complete_end_turn() {
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        let _ = rx.recv().await;

        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        );

        assert!(
            tokio::time::timeout(Duration::from_millis(50), read_until_oneshot(&mut rx))
                .await
                .is_err(),
            "end_turn completion cue is emitted by the following PendingReview transition"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn failed_state_recovers_after_timeout() {
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        // initial idle
        let initial = rx.recv().await.unwrap();
        assert_eq!(initial.channel, "pet://state");
        assert_eq!(initial.payload.as_ref(), &serde_json::json!("idle"));

        // Drive the snapshot into Failed.
        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::Error {
                message: "boom".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        );
        let failed = read_state_event(&mut rx).await;
        assert_eq!(failed.payload.as_ref(), &serde_json::json!("failed"));

        // Advance past the recovery window.
        tokio::time::advance(Duration::from_millis(PET_FAILED_RECOVERY_MS + 100)).await;

        let recovered = read_state_event(&mut rx).await;
        assert_eq!(recovered.payload.as_ref(), &serde_json::json!("idle"));
    }

    async fn read_until_oneshot(rx: &mut broadcast::Receiver<WebEvent>) -> WebEvent {
        loop {
            let evt = tokio::time::timeout(Duration::from_secs(1), rx.recv())
                .await
                .expect("oneshot should fire within 1s")
                .expect("recv");
            if evt.channel == "pet://oneshot" {
                return evt;
            }
        }
    }

    async fn read_state_event(rx: &mut broadcast::Receiver<WebEvent>) -> WebEvent {
        loop {
            let evt = tokio::time::timeout(Duration::from_secs(10), rx.recv())
                .await
                .expect("state event should fire")
                .expect("recv");
            if evt.channel == "pet://state" {
                return evt;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn second_error_extends_recovery_window() {
        // Two errors arriving 3 s apart — the second should reset the
        // recovery clock so `failed` stays visible for ~4 s after the
        // *latest* error, not 4 s from the first.
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(new_pet_state_handle());
        let _ = rx.recv().await; // initial idle

        let send_error = |conn: &str| {
            send_acp(
                &bus,
                1,
                conn,
                AcpEvent::Error {
                    message: "boom".into(),
                    agent_type: "claude_code".into(),
                    code: None,
                    details: None,
                    terminal: true,
                },
            );
        };

        send_error("c1");
        let failed = read_state_event(&mut rx).await;
        assert_eq!(failed.payload.as_ref(), &serde_json::json!("failed"));

        // Halfway through the window, fire a second error. If the timer
        // were not restarted, recovery would happen at +4 s relative to
        // the first error.
        tokio::time::advance(Duration::from_millis(PET_FAILED_RECOVERY_MS / 2)).await;
        send_error("c2");

        // Advance to the *original* deadline; nothing should fire because
        // the timer was reset.
        tokio::time::advance(Duration::from_millis(PET_FAILED_RECOVERY_MS / 2 + 50)).await;
        // Drain any inbound events; we shouldn't see a state event yet.
        let mut saw_recovery = false;
        for _ in 0..5 {
            match tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
                Ok(Ok(evt))
                    if evt.channel == "pet://state"
                        && evt.payload.as_ref() == &serde_json::json!("idle") =>
                {
                    saw_recovery = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(
            !saw_recovery,
            "second error should have extended the recovery window"
        );

        // Advance past the *second* deadline.
        tokio::time::advance(Duration::from_millis(PET_FAILED_RECOVERY_MS / 2 + 100)).await;
        let recovered = read_state_event(&mut rx).await;
        assert_eq!(recovered.payload.as_ref(), &serde_json::json!("idle"));
    }

    #[tokio::test]
    async fn pet_celebrate_core_emits_oneshot() {
        use crate::commands::pet::pet_celebrate_core;
        use crate::models::pet::PetCelebrationKind;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let mut rx = broadcaster.subscribe();

        pet_celebrate_core(&emitter, PetCelebrationKind::Jumping);

        let evt = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("oneshot should fire within 1s")
            .expect("recv");
        assert_eq!(evt.channel, "pet://oneshot");
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("jumping"));

        pet_celebrate_core(&emitter, PetCelebrationKind::Failed);
        let evt = tokio::time::timeout(Duration::from_secs(1), rx.recv())
            .await
            .expect("oneshot should fire within 1s")
            .expect("recv");
        assert_eq!(evt.payload.as_ref(), &serde_json::json!("failed"));
    }

    #[tokio::test(start_paused = true)]
    async fn handle_resets_to_idle_on_failed_recovery_timeout() {
        // The `clear_rx` arm of the subscriber's select! also writes the
        // handle. Without it, after a brief Failed flash recovers to Idle,
        // a freshly-opened pet window would see a stale `failed` snapshot
        // for the rest of the session.
        let handle = new_pet_state_handle();
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(handle.clone());
        let _ = rx.recv().await; // initial idle

        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::Error {
                message: "boom".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        );
        let failed = read_state_event(&mut rx).await;
        assert_eq!(failed.payload.as_ref(), &serde_json::json!("failed"));
        assert_eq!(read_pet_state(&handle), PetState::Failed);

        tokio::time::advance(Duration::from_millis(PET_FAILED_RECOVERY_MS + 100)).await;
        let recovered = read_state_event(&mut rx).await;
        assert_eq!(recovered.payload.as_ref(), &serde_json::json!("idle"));
        assert_eq!(
            read_pet_state(&handle),
            PetState::Idle,
            "handle must follow the auto-recovery transition, not stay stuck on failed"
        );
    }

    #[tokio::test]
    async fn handle_tracks_last_emitted_ambient_state() {
        // Regression for the open-pet-mid-conversation case: the subscriber
        // de-duplicates emissions on `pet://state`, so a window opening
        // *after* the state has already settled into Running won't see any
        // event. The handle is the snapshot the freshly-mounted frontend
        // reads to fill in the gap, so it must always reflect the most
        // recent emitted ambient state.
        let handle = new_pet_state_handle();
        let (bus, _broadcaster, mut rx) = spawn_test_subscriber(handle.clone());

        // Drain initial idle emit; handle is set in lockstep.
        let initial = read_state_event(&mut rx).await;
        assert_eq!(initial.payload.as_ref(), &serde_json::json!("idle"));
        assert_eq!(read_pet_state(&handle), PetState::Idle);

        send_acp(
            &bus,
            1,
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
            },
        );
        let running = read_state_event(&mut rx).await;
        assert_eq!(running.payload.as_ref(), &serde_json::json!("running"));
        assert_eq!(read_pet_state(&handle), PetState::Running);

        send_acp(
            &bus,
            2,
            "c1",
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Connected,
            },
        );
        let idle = read_state_event(&mut rx).await;
        assert_eq!(idle.payload.as_ref(), &serde_json::json!("idle"));
        assert_eq!(read_pet_state(&handle), PetState::Idle);
    }

    #[test]
    fn pet_celebration_kind_serializes_to_snake_case() {
        use crate::models::pet::PetCelebrationKind;
        assert_eq!(
            serde_json::to_value(PetCelebrationKind::Jumping).unwrap(),
            serde_json::json!("jumping")
        );
        assert_eq!(
            serde_json::from_value::<PetCelebrationKind>(serde_json::json!("waving")).unwrap(),
            PetCelebrationKind::Waving
        );
        assert!(
            serde_json::from_value::<PetCelebrationKind>(serde_json::json!("running")).is_err(),
            "ambient state must not deserialize as a celebration kind"
        );
    }
}
