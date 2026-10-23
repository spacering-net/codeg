//! Background subscriber that watches the in-process `InternalEventBus` for
//! ACP events that need cross-connection DB persistence (e.g. binding the
//! agent's external session id onto a conversation row when SessionStarted
//! fires). Decoupled from `emit_with_state` so the emit hot path stays
//! lock-tight.
//!
//! Phase 5: migrated from `WebEventBroadcaster` (JSON-shape) to
//! `InternalEventBus` (typed `Arc<EventEnvelope>`). Eliminates the
//! per-event `serde_json::from_value` reparse and lets us drop the
//! `acp://event` channel from the global firehose entirely.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::DatabaseConnection;
use tokio::sync::{broadcast, mpsc};

use crate::acp::delegation::broker::{DelegationBroker, DelegationMatchKey};
use crate::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationSuccess};
use crate::acp::internal_bus::InternalEventBus;
use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::{SessionState, TurnStatusWriter};
use crate::acp::types::{AcpEvent, ConnectionStatus, EventEnvelope};
use crate::db::entities::conversation::ConversationStatus;
use crate::db::error::DbError;
use crate::db::service::conversation_service;
use crate::logging::throttle::{LagLogThrottle, LAG_LOG_WINDOW};
use crate::web::event_bridge::{emit_with_state, EventEmitter};
use tokio::sync::RwLock;

/// Per-connection worker queue depth. Sized for the **filtered** event set
/// only (see `is_lifecycle_relevant`) — high-frequency events (ContentDelta,
/// ToolCall*, PermissionRequest) are dropped at the dispatcher and never
/// enter the queue. The remaining 7 event types arrive at most a handful
/// of times per turn, so 64 slots is comfortable headroom for a sustained
/// SQLite stall without forcing the dispatcher to block on `send`.
/// (SessionStarted, TurnComplete, ConversationLinked, NativeSessionTitle,
/// TranscriptRolledOver, Disconnected, Error.)
const WORKER_QUEUE_CAPACITY: usize = 64;

/// Whether an event needs to reach the per-connection worker. Mirrors the
/// match arms in `connection_worker_loop` — keep in sync so the dispatcher
/// doesn't filter out an event a future worker arm starts caring about.
///
/// Filtering at the dispatcher (rather than letting the worker no-op on
/// uninteresting events) means ContentDelta floods can't crowd out a
/// TurnComplete in the worker mailbox: only events that may write the DB
/// or update the per-connection cache enter the queue.
///
/// `ToolCall`/`ToolCallUpdate` are deliberately NOT in the accept list.
/// Delegation correlation (capturing `delegate_to_agent` tool_call_ids for
/// the broker's pending queue) used to ride the worker's `ToolCall` arm, but
/// that coupled a latency-critical, lossless registration to the DB-stalling
/// worker AND fed every `ToolCall` (including each parallel child's tool
/// stream) into worker mailboxes — pressure that could block the dispatcher
/// and lag the bus into dropping a parent's second delegation `tool_call`.
/// Registration now happens synchronously in the dispatcher loop via
/// `register_delegation_tool_call_from_event`, so these high-frequency events
/// never need to reach a worker.
fn is_lifecycle_relevant(event: &AcpEvent) -> bool {
    matches!(
        event,
        AcpEvent::SessionStarted { .. }
            | AcpEvent::TurnComplete { .. }
            | AcpEvent::ConversationLinked { .. }
            | AcpEvent::NativeSessionTitle { .. }
            | AcpEvent::TranscriptRolledOver { .. }
            | AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected
            }
            | AcpEvent::Error { .. }
    )
}

/// Whether this event starts or ends a prompt that BLOCKS the agent until a
/// human answers. Deliberately not folded into [`is_lifecycle_relevant`]: these
/// never reach a worker, they only wake the delegation broker's parked status
/// long-polls (see the dispatcher loop). Both edges matter — the raise so a
/// waiting parent learns it is blocked, the resolve so a subsequent poll finds
/// the child working again.
fn is_blocking_prompt_event(event: &AcpEvent) -> bool {
    matches!(
        event,
        AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
            | AcpEvent::QuestionRequest { .. }
            | AcpEvent::QuestionResolved { .. }
            | AcpEvent::PlanApprovalRequest { .. }
            | AcpEvent::PlanApprovalResolved { .. }
    )
}

/// Whether the dispatcher should tear down (drop the sender for) the per-
/// connection worker after forwarding this event. Two cases:
///
///   - `Disconnected` — the normal teardown signal, always emitted by
///     `connection.rs` after `run_connection` returns.
///   - `Error { terminal: true }` — defense-in-depth for the case where
///     the bus drops the trailing `Disconnected` (`Lagged`) or the
///     `run_connection` task aborts between emit sites. The worker
///     dispatches terminal work on whichever lands first (P1); without
///     also dropping the sender here, a missed `Disconnected` would leak
///     the worker task + its `CachedConn` for the lifetime of the process.
///
/// Non-terminal `Error` is NOT terminal at the dispatcher level — it also
/// fires mid-turn from `turn_failure_error_event` while the child connection
/// stays alive, and the worker must survive to process the trailing
/// `TurnComplete`. (P2 follow-up in the v0.14.3 post-mortem review.)
fn is_dispatcher_terminal(event: &AcpEvent) -> bool {
    matches!(
        event,
        AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected
        } | AcpEvent::Error { terminal: true, .. }
    )
}

/// Per-connection state that survives `ConnectionCleanupGuard::drop` so
/// `Disconnected` / `Error` handlers can still emit a derived
/// `ConversationStatusChanged` after the manager entry has been removed.
///
/// Captured on `ConversationLinked` (the earliest point a connection is bound
/// to a conversation row) and consulted on terminal status events. Without
/// this cache, `manager.get_state_and_emitter(connection_id)` races the
/// cleanup guard: `emit_with_state(StatusChanged{Disconnected})` writes to the
/// broadcaster *before* the guard drops, but the subscriber's async receive
/// can wake up after the entry is already gone.
struct CachedConn {
    conversation_id: i32,
    state: Arc<RwLock<SessionState>>,
    emitter: EventEmitter,
}

/// Backoff schedule for `handle_event` DB writes. Most transient
/// SQLite contention clears within the first retry; the third gives a
/// final chance before we fall back to "log loudly and move on".
const HANDLE_EVENT_RETRY_BACKOFFS: &[Duration] =
    &[Duration::from_millis(100), Duration::from_millis(500)];

/// Wrap `handle_event` with a small backoff retry. Most failures here
/// are transient SQLite "database is locked" errors that clear within a
/// few hundred milliseconds; without a retry the conversation row would
/// silently miss its `pending_review` write and the sidebar would stay
/// stuck on `in_progress` until the next prompt's `in_progress` write.
///
/// Final failure is logged at ERROR — this is the only signal the
/// subscriber is dropping correctness on the floor, so it must be noisy.
async fn handle_event_with_retry(
    db_conn: &DatabaseConnection,
    manager: &ConnectionManager,
    envelope: &EventEnvelope,
    broker: Option<&Arc<DelegationBroker>>,
) {
    match handle_event(db_conn, manager, envelope, broker).await {
        Ok(()) => return,
        Err(e) => {
            tracing::warn!(
                "[lifecycle][WARN] handle_event failed (attempt 1, will retry) for {:?}: {e}",
                envelope.payload
            );
        }
    }
    for (attempt, backoff) in HANDLE_EVENT_RETRY_BACKOFFS.iter().enumerate() {
        tokio::time::sleep(*backoff).await;
        match handle_event(db_conn, manager, envelope, broker).await {
            Ok(()) => return,
            Err(e) => {
                let attempt_num = attempt + 2;
                let is_last = attempt + 1 == HANDLE_EVENT_RETRY_BACKOFFS.len();
                let level = if is_last { "ERROR" } else { "WARN" };
                tracing::warn!(
                    "[lifecycle][{level}] handle_event failed (attempt {attempt_num}{}) \
                     for {:?}: {e}",
                    if is_last {
                        ", giving up"
                    } else {
                        ", will retry"
                    },
                    envelope.payload
                );
            }
        }
    }
    // Given up. A turn's status write is released, so a CLI run's fallback —
    // the one other writer — may still make it.
    if matches!(envelope.payload, AcpEvent::TurnComplete { .. }) {
        if let Some(state) = manager.get_state(&envelope.connection_id).await {
            state
                .write()
                .await
                .release_turn_status(envelope.seq, TurnStatusWriter::Lifecycle);
        }
    }
}

/// The conversation status a `TurnComplete` with `stop_reason` leaves the row
/// in. `end_turn` is the only success case and goes to `PendingReview`.
/// `refusal`, `max_tokens`, `max_turn_requests`, `unknown`, `empty`,
/// `auth_required` and `rejected` indicate the turn failed (often a
/// backend/gateway error masquerading as `Refusal` per the ACP spec gap, or —
/// common with OpenCode — a silent EndTurn that produced no output), so they go
/// to `Cancelled`, paired with an `AcpEvent::Error` toast emitted upstream by
/// `connection.rs`. `auth_required` and `rejected` are the ones whose
/// CONNECTION survives (the agent rejected the prompt — with ACP's -32000 when
/// it wants the user to sign in, with anything else when it simply would not
/// run this one), but their turn is just as dead as the others — leaving those
/// rows out would strand them at InProgress for good. `cancelled` is already
/// written by `manager.cancel()` (eager CAS InProgress → Cancelled at the
/// user-cancel entry point), so it — and any future reason — writes nothing.
pub(crate) fn turn_complete_status(stop_reason: &str) -> Option<ConversationStatus> {
    match stop_reason {
        "end_turn" => Some(ConversationStatus::PendingReview),
        "refusal" | "max_tokens" | "max_turn_requests" | "unknown" | "empty" | "auth_required"
        | "rejected" => Some(ConversationStatus::Cancelled),
        _ => None,
    }
}

/// The conversation-status write a `TurnComplete` makes: the row first, then
/// `ConversationStatusChanged`, so any subscriber that observes the event can
/// assume the row is already at the target status. Shared by the lifecycle
/// worker and a CLI run's fallback for a turn the worker never got; whichever
/// claimed the turn (`SessionState::claim_turn_status`) is the one that calls
/// it.
pub(crate) async fn write_turn_status(
    db_conn: &DatabaseConnection,
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    conversation_id: i32,
    stop_reason: &str,
) -> Result<(), DbError> {
    let Some(status) = turn_complete_status(stop_reason) else {
        return Ok(());
    };
    conversation_service::update_status(db_conn, conversation_id, status.clone()).await?;
    emit_with_state(
        state,
        emitter,
        AcpEvent::ConversationStatusChanged {
            conversation_id,
            status,
        },
    )
    .await;
    Ok(())
}

pub(crate) async fn handle_event(
    db_conn: &DatabaseConnection,
    manager: &ConnectionManager,
    envelope: &EventEnvelope,
    broker: Option<&Arc<DelegationBroker>>,
) -> Result<(), DbError> {
    match &envelope.payload {
        // NOTE: parent-side `delegate_to_agent` tool_call_id capture used to
        // live here (a `ToolCall` arm). It now runs in the dispatcher loop via
        // `register_delegation_tool_call_from_event`, off the DB-coupled worker
        // and across both `ToolCall` and `ToolCallUpdate`, so `ToolCall` no
        // longer reaches this worker at all (see `is_lifecycle_relevant`).
        AcpEvent::SessionStarted { session_id } => {
            // Look up conversation_id (and the emitter) from the live state.
            let Some((state_arc, emitter)) =
                manager.get_state_and_emitter(&envelope.connection_id).await
            else {
                return Ok(());
            };
            let (conversation_id, agent_type) = {
                let snap = state_arc.read().await;
                (snap.conversation_id, snap.agent_type)
            };
            if let Some(cid) = conversation_id {
                // Guarded bind: the row may already be bound to a DIFFERENT
                // session. That is legitimate for a fork (which has already
                // inserted the sibling holding the outgoing id, so this is a
                // plain re-point) and for a custom agent continuing its
                // conversation under a new session (`continues`), and
                // destructive otherwise — a session re-minted under a live
                // binding would otherwise overwrite the id the row's whole
                // history hangs off. See codeg#500.
                let continues = crate::acp::continued_session_ids(agent_type, session_id);
                let preserved =
                    conversation_service::bind_external_id(db_conn, cid, session_id, &continues)
                        .await?;
                // The external_id just landed on the row. The create-time
                // sidebar upsert carried `external_id: null` (no session yet),
                // so re-broadcast the full summary on `conversation://changed`
                // to converge every client. Root-only (the helper skips
                // delegation children). Best-effort, after the DB write.
                crate::commands::conversations::emit_conversation_upsert(&emitter, db_conn, cid)
                    .await;
                crate::commands::conversations::emit_preserved_conversation(
                    &emitter, db_conn, preserved,
                )
                .await;
            }
            Ok(())
        }
        AcpEvent::TurnComplete { stop_reason, .. } => {
            // Centralized status transition: when the agent reports the turn
            // is done, flip the conversation row and re-broadcast the change
            // as `ConversationStatusChanged`. This lives in the lifecycle
            // subscriber (rather than at the original emit site in
            // `acp/connection.rs`) so the write is decoupled from the
            // protocol-event hot path AND survives a frontend refresh
            // mid-turn — the row gets the correct status even if no
            // browser is connected to react to TurnComplete itself.
            //
            // The target status depends on the stop reason: `end_turn` is the
            // only success case and goes to `PendingReview`. `refusal`,
            // `max_tokens`, `max_turn_requests`, `unknown`, `empty`,
            // `auth_required` and `rejected` indicate the turn failed (often a
            // backend/gateway error masquerading as `Refusal` per the ACP spec
            // gap, or — common with OpenCode — a silent EndTurn that produced no
            // output), so we flip to `Cancelled` and pair the transition with an
            // `AcpEvent::Error` toast emitted upstream by `connection.rs`.
            // `auth_required` and `rejected` are the ones whose CONNECTION
            // survives (the agent rejected the prompt — with ACP's -32000 when
            // it wants the user to sign in, with anything else when it simply
            // would not run this one), but their turn is just as dead as the
            // others — leaving those rows out of this arm would strand them at
            // InProgress for good.
            // `cancelled` is already written by `manager.cancel()` (eager
            // CAS InProgress → Cancelled at the user-cancel entry point), so
            // we leave it alone here. `completed` transitions remain
            // frontend-driven.
            let Some((state_arc, emitter)) =
                manager.get_state_and_emitter(&envelope.connection_id).await
            else {
                return Ok(());
            };
            let (conversation_id, last_text, claimed) = {
                let mut snap = state_arc.write().await;
                // Re-entrant for this worker: a retry of this same envelope
                // claims again and goes on. Only a CLI run's fallback that
                // already wrote this turn's status makes it skip.
                let claimed = snap.claim_turn_status(envelope.seq, TurnStatusWriter::Lifecycle);
                (
                    snap.conversation_id,
                    snap.last_assistant_text.clone(),
                    claimed,
                )
            };
            // No conversation row bound (defensive — should never happen in
            // practice since `send_prompt_linked` runs before TurnComplete can
            // fire). Nothing to update.
            let Some(cid) = conversation_id else {
                return Ok(());
            };
            if claimed {
                write_turn_status(db_conn, &state_arc, &emitter, cid, stop_reason).await?;
            }

            // If this conversation was spawned by a delegation, resolve the
            // pending broker call. The broker maps the outcome onto the
            // parent's `tool_use_id` via the registered `call_id`.
            if let Some(b) = broker {
                forward_turn_complete_to_broker(
                    db_conn,
                    b.as_ref(),
                    cid,
                    stop_reason.as_str(),
                    last_text,
                )
                .await;
            }
            Ok(())
        }
        AcpEvent::NativeSessionTitle { title } => {
            // Live ACP session title: write it onto the bound row the moment
            // the agent publishes it. `refresh_auto_title` is a no-op when the
            // user renamed the chat, when the value is unchanged, or when the
            // string is empty — so repeating the same title across goal
            // snapshots does not churn the sidebar.
            let Some((state_arc, emitter)) =
                manager.get_state_and_emitter(&envelope.connection_id).await
            else {
                return Ok(());
            };
            let conversation_id = { state_arc.read().await.conversation_id };
            // Title published before the first prompt binds the row: drop it.
            // `emit_conversation_update` never caches an unbound title, so a
            // later resend is still accepted. Failing that, the next detail
            // load recovers it only where the agent's own transcript carries
            // the name — see the note at that emit site.
            let Some(cid) = conversation_id else {
                return Ok(());
            };
            // Unlocked on purpose: a later ACP title or a session-file parse
            // can still replace this. Identical repeats are filtered at emit
            // time so CodeBuddy's per-turn fallback cannot ping-pong the
            // sidebar. Soft-deleted rows are skipped by the UPDATE predicate.
            if conversation_service::refresh_auto_title(db_conn, cid, title.clone()).await? {
                crate::commands::conversations::emit_conversation_upsert(&emitter, db_conn, cid)
                    .await;
                if let Some(ccm) = manager.chat_channel() {
                    crate::commands::conversations::spawn_sync_conversation_title_until_current(
                        db_conn.clone(),
                        ccm,
                        cid,
                    );
                }
            }
            Ok(())
        }
        AcpEvent::TranscriptRolledOver { transcript_id } => {
            // Claude `/clear` wrote a new transcript uuid. The ACP session id
            // on SessionState is unchanged and must stay that way (prompts
            // still use it). Re-point the conversation row in place — the
            // outgoing id is this conversation's previous transcript, so it
            // is passed as `continues` to avoid a sidebar split.
            let Some((state_arc, emitter)) =
                manager.get_state_and_emitter(&envelope.connection_id).await
            else {
                return Ok(());
            };
            let conversation_id = { state_arc.read().await.conversation_id };
            if let Some(cid) = conversation_id {
                // Continues is the row's current pointer (the file we are
                // leaving), not SessionState.external_id — after the first
                // `/clear` those diverge, and using the ACP id would split
                // on a second rollover.
                let Ok(current) = conversation_service::get_by_id(db_conn, cid).await else {
                    return Ok(());
                };
                let continues: Vec<String> = current.external_id.into_iter().collect();
                let preserved = conversation_service::bind_external_id(
                    db_conn,
                    cid,
                    transcript_id,
                    &continues,
                )
                .await?;
                crate::commands::conversations::emit_conversation_upsert(&emitter, db_conn, cid)
                    .await;
                crate::commands::conversations::emit_preserved_conversation(
                    &emitter, db_conn, preserved,
                )
                .await;
            }
            Ok(())
        }
        // Other events don't need cross-connection DB persistence today; extend
        // this dispatcher with new arms as the lifecycle scope grows.
        _ => Ok(()),
    }
}

/// On TurnComplete for a delegation child, resolve the pending broker call
/// and let the broker drive the rest of the lifecycle (meta write, the
/// `AcpEvent::DelegationCompleted` emit against the parent stream, child
/// disconnect, tx.send). Keeping the emit responsibility inside
/// `broker.complete_call` is what guarantees the broker's other terminal
/// paths (`timeout` / `cancel_by_child_connection` / `cancel_by_parent`)
/// also surface the event — see
/// `.docs/issues/2026-05-24-delegation-termination-cascade.md`.
async fn forward_turn_complete_to_broker(
    db_conn: &DatabaseConnection,
    broker: &DelegationBroker,
    conversation_id: i32,
    stop_reason: &str,
    last_text: Option<String>,
) {
    let row = match conversation_service::get_by_id(db_conn, conversation_id).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!(
                "[delegation][lifecycle] couldn't fetch child conversation \
                 {conversation_id} for outcome routing: {e}"
            );
            return;
        }
    };
    let call_id = match row.delegation_call_id.clone() {
        Some(id) => id,
        None => return, // not a delegation child; nothing to do.
    };
    if row.parent_tool_use_id.is_none() {
        tracing::info!(
            "[delegation][lifecycle] conversation {conversation_id} has \
             delegation_call_id but no parent_tool_use_id; dropping"
        );
        return;
    }
    let agent_type = row.agent_type;
    let outcome = match stop_reason {
        "end_turn" => DelegationOutcome::Ok(DelegationSuccess {
            text: last_text.unwrap_or_default(),
            child_conversation_id: conversation_id,
            child_agent_type: agent_type,
            turn_count: 1,
            duration_ms: 0,
            token_usage: None,
        }),
        "cancelled" => DelegationOutcome::from_err(
            DelegationError::Canceled {
                reason: "child session was cancelled".into(),
            },
            Some(conversation_id),
        ),
        // Each child turn-failure reason gets a distinct wire code so the
        // parent UI can show a more useful error label than a generic
        // "subagent error". Mirrors the parent's own
        // `turn_failure_error_event` mapping in `connection.rs`.
        "refusal" => {
            DelegationOutcome::from_err(DelegationError::ChildRefusal, Some(conversation_id))
        }
        "max_tokens" => {
            DelegationOutcome::from_err(DelegationError::ChildMaxTokens, Some(conversation_id))
        }
        "max_turn_requests" => DelegationOutcome::from_err(
            DelegationError::ChildMaxTurnRequests,
            Some(conversation_id),
        ),
        "empty" => DelegationOutcome::from_err(DelegationError::ChildEmpty, Some(conversation_id)),
        "auth_required" => {
            DelegationOutcome::from_err(DelegationError::ChildAuthRequired, Some(conversation_id))
        }
        "rejected" => {
            DelegationOutcome::from_err(DelegationError::ChildRejected, Some(conversation_id))
        }
        other => DelegationOutcome::from_err(
            DelegationError::ChildUnknown(other.to_string()),
            Some(conversation_id),
        ),
    };
    broker.complete_call(&call_id, outcome).await;
}

/// Snapshot the connection's `(state, emitter)` into the lifecycle cache when
/// `ConversationLinked` arrives. Idempotent on repeat calls (re-link on the
/// already-bound path is a no-op so we don't churn the cached refs).
async fn try_cache_link(
    cache: &mut HashMap<String, CachedConn>,
    manager: &ConnectionManager,
    connection_id: &str,
    conversation_id: i32,
) {
    if cache.contains_key(connection_id) {
        return;
    }
    // The connection is necessarily still in the manager at this point —
    // `ConversationLinked` is emitted by `send_prompt_linked` from the
    // connection's own send path, well before any disconnect.
    let Some((state, emitter)) = manager.get_state_and_emitter(connection_id).await else {
        tracing::warn!(
            "[lifecycle][WARN] ConversationLinked for unknown connection {connection_id}; \
             skipping cache (terminal-status hand-off will no-op)"
        );
        return;
    };
    cache.insert(
        connection_id.to_string(),
        CachedConn {
            conversation_id,
            state,
            emitter,
        },
    );
}

/// Handle `StatusChanged{Disconnected}` / `Error` for a cached connection:
/// CAS the row from `InProgress` → `Cancelled` (preserves any prior
/// `PendingReview` from `TurnComplete` and any user-driven `Completed`),
/// re-emit `ConversationStatusChanged` if the write took effect.
///
/// Removing the cache entry on first terminal event handles the
/// `Error` → `Disconnected` sequence that `connection.rs` emits on the error
/// path: the second event finds an empty cache and is a clean no-op, so we
/// don't pay a redundant DB read.
async fn handle_terminal_event(
    db_conn: &DatabaseConnection,
    cache: &mut HashMap<String, CachedConn>,
    connection_id: &str,
) -> Result<(), DbError> {
    let Some(entry) = cache.remove(connection_id) else {
        return Ok(());
    };
    let cid = entry.conversation_id;
    let changed = conversation_service::update_status_if(
        db_conn,
        cid,
        ConversationStatus::InProgress,
        ConversationStatus::Cancelled,
    )
    .await?;
    if !changed {
        return Ok(());
    }
    emit_with_state(
        &entry.state,
        &entry.emitter,
        AcpEvent::ConversationStatusChanged {
            conversation_id: cid,
            status: ConversationStatus::Cancelled,
        },
    )
    .await;
    Ok(())
}

/// On a non-TurnComplete terminal event (Disconnected / Error) for a
/// delegation child, surface a `canceled` outcome to the broker. The
/// child's DB row may already be marked `Cancelled` by `handle_terminal_event`
/// above; this separately wakes the parent's pending `delegate_to_agent`
/// tool_use_id. Match-by-`child_connection_id` is O(pending), bounded by
/// active delegations.
///
/// `terminal_error` is the formatted `AcpEvent::Error` detail (when the
/// caller arrived via `Error` rather than a bare `Disconnected`). It gets
/// stitched into the broker's canceled reason so the parent's
/// `delegate_to_agent` tool-call result surfaces the real failure cause.
async fn forward_disconnect_to_broker(
    broker: &DelegationBroker,
    connection_id: &str,
    terminal_error: Option<&str>,
) {
    broker
        .cancel_by_child_connection(connection_id, terminal_error)
        .await;
}

/// Build a single-line detail string from an `AcpEvent::Error` payload,
/// preferring the form `"[code] message"` when a stable code is present
/// (so the parent agent sees both the machine-readable bucket and the
/// human-readable text). Trims trailing whitespace; returns `message`
/// verbatim when no code is provided.
fn format_terminal_error(message: &str, code: Option<&str>) -> String {
    let trimmed = message.trim();
    match code {
        Some(c) if !c.trim().is_empty() => format!("[{c}] {trimmed}"),
        _ => trimmed.to_string(),
    }
}

/// Wrapper keys hosts use to nest the real tool arguments. JSON-RPC servers
/// and MCP relays pack the call as `{name, arguments}` or `{params: {...}}`;
/// some agents stash the args under a generic `input`/`payload` next to
/// `_meta`; Cursor's MCP tool calls surface as
/// `{providerIdentifier, toolName, args: {...}}`. Mirrors the frontend
/// `ARGS_WRAPPER_KEYS` in `delegation-card.ts` so the two sides peel exactly
/// the same shapes.
pub(crate) const ARGS_WRAPPER_KEYS: [&str; 6] =
    ["arguments", "input", "params", "payload", "_meta", "args"];

/// Walk wrapper layers — and one level of double-encoded JSON-of-JSON — down to
/// the object that actually carries the `delegate_to_agent` arguments, and
/// return a clone of it. A node qualifies the moment it exposes any of
/// `task`/`agent_type`/`working_dir` as a string; otherwise we descend into the
/// known wrapper keys (depth-capped so pathological nesting can't loop).
///
/// Direct port of the frontend `findDelegationArgs` (`delegated-sub-thread.tsx`):
/// same wrapper keys, same depth-4 cap, same "first object with a delegation
/// field wins" rule. Keeping the walkers symmetric means a `raw_input` the card
/// can render into a task line is the same `raw_input` the broker can build a
/// correlation key from — so a host that wraps its ACP tool-call args (e.g.
/// Codex packs them under `params.input`; some relays double-encode the blob)
/// still gets a *keyed* pending entry instead of silently degrading to
/// FIFO/synthetic correlation, which is the exact failure the keyed-retention
/// fix exists to prevent.
fn find_delegation_args(
    value: &serde_json::Value,
    depth: u8,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    if depth > 4 {
        return None;
    }
    // Double-encoded: some hosts ship `raw_input` as a JSON string whose
    // contents are themselves the arg blob. Parse one inner layer and recurse.
    if let Some(s) = value.as_str() {
        let inner: serde_json::Value = serde_json::from_str(s).ok()?;
        return find_delegation_args(&inner, depth + 1);
    }
    let obj = value.as_object()?;
    // Direct hit: this object declares a delegation field at its top level.
    // `assistant_id` counts whether a host sent it as a number or a string.
    if obj.get("task").and_then(|v| v.as_str()).is_some()
        || obj.get("agent_type").and_then(|v| v.as_str()).is_some()
        || obj.get("working_dir").and_then(|v| v.as_str()).is_some()
        || obj
            .get("assistant_id")
            .is_some_and(|v| v.is_number() || v.is_string())
    {
        return Some(obj.clone());
    }
    // Otherwise peel a known wrapper layer.
    for key in ARGS_WRAPPER_KEYS {
        if let Some(child) = obj.get(key) {
            if let Some(found) = find_delegation_args(child, depth + 1) {
                return Some(found);
            }
        }
    }
    None
}

/// The exact title Cursor's ACP layer sends for an MCP tool call announced
/// before its `McpArgs` exist: `` `${providerIdentifier ?? "MCP"}: ${toolName
/// ?? "tool"}` `` with both absent. Used to register identity-less candidates
/// (see the comment in [`register_delegation_tool_call_from_event`]) and by
/// `acp::connection` to mark such calls eligible for the completion-time
/// result sniff.
pub(crate) const CURSOR_IDENTITYLESS_MCP_TITLE: &str = "MCP: tool";

/// True when the ACP `tool_call` smells like an invocation of the
/// `delegate_to_agent` MCP tool. Defensive on both inputs because the host
/// agent gets to decide both fields:
///
/// * `title` is a free-form human-readable string the host composes. Some
///   hosts copy the MCP method verbatim (`mcp__codeg-mcp__delegate_to_agent`),
///   some prefix it with a verb (`Run mcp__…__delegate_to_agent`), some
///   rephrase it (`Delegate to codex`). We match by substring so any
///   form containing `delegate_to_agent` is captured.
/// * `raw_input` is the JSON arg blob the agent sent to the MCP server. The
///   `delegate_to_agent` schema requires `task` plus a target — `agent_type`,
///   or `assistant_id` for an assistant; `task` with either — after peeling
///   any wrapper layers via [`find_delegation_args`] — is a near-zero
///   false-positive shape check that catches any host that mangles the title
///   beyond recognition, including ones that wrap their tool-call args.
///
/// This is also the replay-side gate: `commands::conversations::inject_delegation_meta`
/// reuses it so a persisted tool block whose title/args (or opencode `code`)
/// shape would have been registered live gets historical meta on reload —
/// live and cold-start recognition stay identical by construction.
pub(crate) fn is_delegation_invocation(title: &str, raw_input: Option<&str>) -> bool {
    let normalized_title = title.to_ascii_lowercase().replace([' ', '-'], "_");
    if normalized_title.contains("delegate_to_agent") {
        return true;
    }
    if let Some(raw) = raw_input {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            if let Some(args) = find_delegation_args(&v, 0) {
                let has_task = args.get("task").and_then(|t| t.as_str()).is_some();
                let has_agent_type = args.get("agent_type").and_then(|a| a.as_str()).is_some();
                let has_assistant_id = args
                    .get("assistant_id")
                    .is_some_and(|v| v.is_number() || v.is_string());
                if has_task && (has_agent_type || has_assistant_id) {
                    return true;
                }
            }
        }
    }
    if let Some(raw) = raw_input {
        if code_mode_delegation_code(raw) {
            return true;
        }
    }
    false
}

/// Build the broker's `(agent_type, task, working_dir)` correlation key from
/// a `delegate_to_agent` tool_call's `raw_input` JSON. All three are values
/// the LLM passed identically to the ACP tool call and the MCP `tools/call`,
/// so the triple uniquely identifies the call even when several
/// `delegate_to_agent` invocations are in flight at once (and, unlike `task`
/// alone, doesn't collide when two parallel calls target different agents —
/// or different directories — with the same task text). `working_dir` is the
/// LLM's explicit value (`None` when omitted), matching the broker's
/// `DelegationRequest::requested_working_dir`.
///
/// Two shapes are understood, in order:
///
/// * a JSON arg blob the LLM sent to the MCP server (located via
///   [`find_delegation_args`], so hosts that wrap or double-encode `raw_input`
///   are keyed identically to hosts that send the fields at the top level) —
///   see [`extract_args_match_key`];
/// * opencode's code-mode `execute` payload, whose `code` string wraps the
///   real call — see [`extract_code_mode_match_key`].
///
/// Returns `None` when neither shape yields a fully parseable
/// `(target, task, working_dir)` — the broker then falls back to FIFO
/// ordering. A missing key is strictly better than a wrong one: keyed entries
/// are retained indefinitely and claimable ONLY by exact match, so a
/// mismatched key would deadlock the correlation until teardown.
fn extract_delegation_match_key(raw_input: Option<&str>) -> Option<DelegationMatchKey> {
    if let Some(key) = extract_args_match_key(raw_input) {
        return Some(key);
    }
    extract_code_mode_match_key(raw_input)
}

fn extract_args_match_key(raw_input: Option<&str>) -> Option<DelegationMatchKey> {
    let raw = raw_input?;
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let args = find_delegation_args(&parsed, 0)?;
    let task = args.get("task").and_then(|v| v.as_str())?.to_string();
    let working_dir = args
        .get("working_dir")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let args = serde_json::Value::Object(args);
    // The same parser the MCP listener dispatches the call with, so the
    // target here equals `DelegationRequest::target()` for the same arguments.
    let target = crate::acp::delegation::types::delegation_target_from_args(&args).ok()?;
    Some(DelegationMatchKey {
        target,
        task,
        working_dir,
    })
}

/// ── opencode 2.x "code-mode" delegation recognition ────────────────────────
///
/// opencode ≥2.x routes every MCP tool call through its built-in `execute`
/// tool: the model writes JavaScript
/// `await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `…` })`
/// and the ACP announcement is `{title: "execute", raw_input: {"code": "<js>"}}`.
/// Neither earlier branch of [`is_delegation_invocation`] matches — the title
/// carries no `delegate_to_agent`, and the args live inside a JS string
/// invisible to [`find_delegation_args`] — so the call never registered, the
/// round-trip fell back to a synthetic `delegation-<uuid>`, and the child's
/// status/result had no parent card to bind to.
///
/// The recognizers below parse the `code` string with a small structural JS
/// scanner rather than regexes, and are STRICT about what counts as a call:
/// `tools` must be a standalone identifier reaching `delegate_to_agent(`
/// through a real accessor (`tools["codeg-mcp"].…` or `tools.<ns>.…`), and
/// the scan skips strings, template literals, and comments, so a task text
/// *quoting* such a call (or a comment mentioning one) cannot register a
/// phantom delegation.
///
/// Extraction is conservative in the same direction: any ambiguity
/// (interpolation, an unknown escape, an ESCAPED quoted `task`, a value that
/// continues past its literal (`"a" + b`, `` `a`.trim() ``), a present but
/// unreadable `working_dir`, an `assistant_id` in any spelling (quoted,
/// computed, spread-in), spread or computed-key syntax, unbalanced syntax)
/// degrades to NO key — the pre-existing unkeyed path (post-budget FIFO
/// claim) — rather than a WRONG keyed one. Template values are read as the
/// runtime would cook them (escapes decoded, bare CR/CRLF TV-normalized
/// to LF, U+2028/U+2029 preserved verbatim), so the key matches what the
/// MCP listener receives.
/// An escape-free quoted `task` is accepted: with no backslash present, the
/// evaluated value is exactly the source text (reviewed deviation from plan
/// v2's blanket "quoted task → no key").
/// `(open, close)` byte offsets of the `(` … `)` wrapping the arguments of
/// the first `delegate_to_agent(` call reached via a `tools` accessor in real
/// (non-string, non-comment) JS. `None` when the code exceeds the scan cap,
/// is structurally unbalanced, or names no such call.
fn code_mode_call_span(code: &str) -> Option<(usize, usize)> {
    // A heuristic scan cap, measured in UTF-8 bytes; the TS mirror caps
    // UTF-16 code units. The unit mismatch only shows on megabyte-scale
    // non-ASCII payloads (backend declines, frontend may still classify) —
    // recorded as a known boundary, not worth a TextEncoder pass per call.
    const MAX_CODE_BYTES: usize = 1 << 20;
    if code.len() > MAX_CODE_BYTES {
        return None;
    }
    let b = code.as_bytes();
    let mut i = 0usize;
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' => i = skip_js_string(code, i)?,
            b'`' => i = skip_js_template(code, i)?,
            b'/' => match b.get(i + 1) {
                Some(b'/') | Some(b'*') => i = skip_js_ws_and_comments(code, i),
                _ => i += 1,
            },
            _ if is_js_word_at(b, i, b"tools") => {
                if let Some(open) = code_mode_tools_call_open(code, i) {
                    let close = matching_paren(code, open)?;
                    return Some((open, close));
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

/// Byte offset of the `(` that opens the argument list of the
/// `delegate_to_agent` call whose `tools` token sits at `tools_at`. Two
/// accepted accessor shapes (opencode emits the first; the second covers a
/// namespaced client): `tools["codeg-mcp"].delegate_to_agent(` and
/// `tools.codeg_mcp.delegate_to_agent(`.
fn code_mode_tools_call_open(code: &str, tools_at: usize) -> Option<usize> {
    let b = code.as_bytes();
    let mut i = tools_at + b"tools".len();
    i = skip_js_ws_and_comments(code, i);
    match b.get(i) {
        Some(b'[') => {
            i += 1;
            i = skip_js_ws_and_comments(code, i);
            let quote = *b.get(i)?;
            if quote != b'\'' && quote != b'"' {
                return None;
            }
            let end = skip_js_string(code, i)?;
            // A non-empty member name: `tools[""].delegate…` is no call site.
            if end == i + 2 {
                return None;
            }
            i = skip_js_ws_and_comments(code, end);
            if b.get(i) != Some(&b']') {
                return None;
            }
            i = skip_js_ws_and_comments(code, i + 1);
            if b.get(i) != Some(&b'.') {
                return None;
            }
            i = skip_js_ws_and_comments(code, i + 1);
        }
        Some(b'.') => {
            i += 1;
            i = skip_js_ws_and_comments(code, i);
            let end = js_ident_end(b, i);
            if end == i {
                return None;
            }
            i = skip_js_ws_and_comments(code, end);
            if b.get(i) != Some(&b'.') {
                return None;
            }
            i = skip_js_ws_and_comments(code, i + 1);
        }
        _ => return None,
    }
    if !is_js_word_at(b, i, b"delegate_to_agent") {
        return None;
    }
    i = skip_js_ws_and_comments(code, i + b"delegate_to_agent".len());
    if b.get(i) == Some(&b'(') {
        Some(i)
    } else {
        None
    }
}

/// Byte offset of the `)` matching the `(` at `open`, skipping strings,
/// templates, and comments so a `)` inside them can't close the call early.
/// `None` on unbalanced input.
fn matching_paren(code: &str, open: usize) -> Option<usize> {
    let b = code.as_bytes();
    let mut depth: i32 = 0;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'\'' | b'"' => i = skip_js_string(code, i)?,
            b'`' => i = skip_js_template(code, i)?,
            b'/' => match b.get(i + 1) {
                Some(b'/') | Some(b'*') => i = skip_js_ws_and_comments(code, i),
                _ => i += 1,
            },
            b'(' => {
                depth += 1;
                i += 1;
            }
            b')' => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    None
}

/// Byte offset just past the closing quote of the `'…'`/`"…"` string opening
/// at `open`. Byte-wise: multi-byte UTF-8 continuation bytes never equal an
/// ASCII quote, so `i` only ever lands on boundaries. `None` when the string
/// never closes.
fn skip_js_string(code: &str, open: usize) -> Option<usize> {
    let b = code.as_bytes();
    let quote = b[open];
    let mut i = open + 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            c if c == quote => return Some(i + 1),
            _ => i += 1,
        }
    }
    None
}

/// Byte offset just past the closing backtick of the template literal opening
/// at `open`, tracking `${ … }` interpolation nesting (with strings, nested
/// templates, and comments inside interpolations). Frame-depth-capped;
/// `None` on unbalanced input.
fn skip_js_template(code: &str, open: usize) -> Option<usize> {
    const MAX_FRAMES: usize = 16;
    enum Frame {
        Content,
        Interp { brace_depth: i32 },
    }
    let b = code.as_bytes();
    let mut stack: Vec<Frame> = vec![Frame::Content];
    let mut i = open + 1;
    while !stack.is_empty() {
        if stack.len() > MAX_FRAMES {
            return None;
        }
        let c = *b.get(i)?;
        match (stack.last_mut()?, c) {
            (Frame::Content, b'`') => {
                stack.pop();
                i += 1;
                if stack.is_empty() {
                    return Some(i);
                }
            }
            (Frame::Content, b'\\') => i += 2,
            (Frame::Content, b'$') if b.get(i + 1) == Some(&b'{') => {
                stack.push(Frame::Interp { brace_depth: 0 });
                i += 2;
            }
            (Frame::Interp { brace_depth }, b'{') => {
                *brace_depth += 1;
                i += 1;
            }
            (Frame::Interp { brace_depth }, b'}') => {
                if *brace_depth == 0 {
                    stack.pop();
                } else {
                    *brace_depth -= 1;
                }
                i += 1;
            }
            (Frame::Interp { .. }, b'\'' | b'"') => i = skip_js_string(code, i)?,
            (Frame::Interp { .. }, b'`') => {
                stack.push(Frame::Content);
                i += 1;
            }
            (Frame::Interp { .. }, b'/') if b.get(i + 1) == Some(&b'/') => {
                while i < b.len() && !is_line_terminator_start(b, i) {
                    i += 1;
                }
            }
            (Frame::Interp { .. }, b'/') if b.get(i + 1) == Some(&b'*') => {
                i = code[i + 2..].find("*/").map(|p| i + 2 + p + 2)?;
            }
            _ => i += 1,
        }
    }
    None
}

/// Advance past whitespace and both comment forms. Stops at the first
/// non-ws/non-comment byte (or end of input).
fn skip_js_ws_and_comments(code: &str, mut i: usize) -> usize {
    let b = code.as_bytes();
    loop {
        match b.get(i) {
            Some(c) if c.is_ascii_whitespace() => i += 1,
            Some(b'/') if b.get(i + 1) == Some(&b'/') => {
                i += 2;
                while i < b.len() && !is_line_terminator_start(b, i) {
                    i += 1;
                }
            }
            Some(b'/') if b.get(i + 1) == Some(&b'*') => match code[i + 2..].find("*/") {
                Some(p) => i = i + 2 + p + 2,
                None => return b.len(),
            },
            _ => return i,
        }
    }
}

/// True when the byte at `i` begins a JS LineTerminator: LF, CR, U+2028 (LS),
/// or U+2029 (PS). ECMA-262 line comments end at ANY of these — a scanner
/// stopping only at LF would swallow the real code that follows an LS/PS/CR.
fn is_line_terminator_start(b: &[u8], i: usize) -> bool {
    match b.get(i) {
        Some(b'\n' | b'\r') => true,
        Some(0xE2) => {
            b.get(i + 1) == Some(&0x80) && matches!(b.get(i + 2), Some(0xA8 | 0xA9))
        }
        _ => false,
    }
}

/// True when `word` sits at `at` as a standalone JS identifier: the
/// surrounding bytes are not identifier characters (ASCII ident chars, `$`,
/// or any non-ASCII byte — JS identifiers allow Unicode, and treating every
/// non-ASCII byte as an ident char is the safe over-approximation).
fn is_js_word_at(b: &[u8], at: usize, word: &[u8]) -> bool {
    if b.len() < at + word.len() || &b[at..at + word.len()] != word {
        return false;
    }
    let after = at + word.len();
    (at == 0 || !is_js_ident_byte(b[at - 1])) && (after >= b.len() || !is_js_ident_byte(b[after]))
}

fn is_js_ident_byte(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_' || c == b'$' || c >= 0x80
}

fn js_ident_end(b: &[u8], at: usize) -> usize {
    let mut end = at;
    while end < b.len() && is_js_ident_byte(b[end]) {
        end += 1;
    }
    end
}

/// True when `raw_input` is an opencode code-mode `execute` payload whose
/// `code` string announces a `delegate_to_agent` call reachable via a `tools`
/// accessor. False for anything else — including other `execute` calls and
/// code that only *mentions* the method inside a string or comment.
fn code_mode_delegation_code(raw_input: &str) -> bool {
    // Cheap pre-gate: any JSON payload carrying a `code` key contains the
    // literal `"code"` bytes, so skipping the parse for payloads that don't
    // keeps this branch free for every non-code-mode tool call.
    if !raw_input.contains("\"code\"") {
        return false;
    }
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(raw_input) else {
        return false;
    };
    parsed
        .get("code")
        .and_then(|v| v.as_str())
        .is_some_and(|code| code_mode_call_span(code).is_some())
}

/// Build the broker key from a code-mode `execute` payload: locate the
/// `delegate_to_agent(` call span, then read `agent_type`/`working_dir`/`task`
/// out of its argument region. Every ambiguity returns `None` — see the
/// module doc — so the extraction can only produce a key byte-identical to
/// what the MCP listener receives, or no key at all.
fn extract_code_mode_match_key(raw_input: Option<&str>) -> Option<DelegationMatchKey> {
    let raw = raw_input?;
    // Same cheap pre-gate as [`code_mode_delegation_code`]: this runs after
    // the args-shape extractor already parsed the payload once.
    if !raw.contains("\"code\"") {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let code = parsed.get("code")?.as_str()?;
    let (open, close) = code_mode_call_span(code)?;
    let region = (open + 1, close);
    // Syntax whose contribution the scanner cannot evaluate (spread, computed
    // keys, escaped quoted keys) could hide an `assistant_id` or change any
    // value — the whole extraction degrades to unkeyed, see
    // [`code_mode_args_transparent`].
    if !code_mode_args_transparent(code, region) {
        return None;
    }
    // Mixed-shape guard: a present `assistant_id` resolves to Assistant(id)
    // on the MCP side and wins over `agent_type`; guessing Agent(…) from the
    // code text would mint a keyed entry no round-trip can ever claim.
    // Quoted spellings (`"assistant_id": 3`) are keys too — see
    // [`code_mode_find_key`].
    if code_mode_find_key(code, region, b"assistant_id").is_some() {
        return None;
    }
    let agent_type_at = code_mode_find_key(code, region, b"agent_type")?;
    let agent_type = object_string_value(code, agent_type_at)?;
    // `working_dir` is OPTIONAL in the key: ABSENT yields `working_dir:
    // None`, but present-and-unreadable (backslash path, template, variable,
    // concatenation) must bail the WHOLE key — the MCP side sees Some(…),
    // so a None-keyed entry could never match.
    let working_dir = match code_mode_find_key(code, region, b"working_dir") {
        Some(at) => Some(object_string_value(code, at)?),
        None => None,
    };
    let task_at = code_mode_find_key(code, region, b"task")?;
    let task = object_task_value(code, task_at)?;
    let args = serde_json::json!({ "agent_type": agent_type });
    // The same parser the MCP listener dispatches the call with, so this
    // target equals `DelegationRequest::target()` for the same call.
    let target = crate::acp::delegation::types::delegation_target_from_args(&args).ok()?;
    Some(DelegationMatchKey {
        target,
        task,
        working_dir,
    })
}

/// Conservative pre-pass over the argument region: `false` when the region
/// contains syntax whose effect the scanner cannot evaluate. Spread
/// (`...base`) may carry an `assistant_id`; a `[` covers computed keys
/// (`["assistant_id"]: 3`) and array values; a quoted KEY containing a
/// backslash evaluates to an unknowable spelling (it could BE the key being
/// searched for); a `(`/`)` or a non-comment `/` is a call/parenthesized/
/// division/regex expression the scanner cannot evaluate (and a regex body
/// could feed quotes or braces to the string/template arms); a bare
/// `working_dir` / `assistant_id` identifier is a SHORTHAND property whose
/// value is the variable's runtime value. Each degrades to the unkeyed path.
fn code_mode_args_transparent(code: &str, region: (usize, usize)) -> bool {
    let b = code.as_bytes();
    let (start, end) = region;
    let mut i = start;
    while i < end {
        match b[i] {
            b'\'' | b'"' => {
                let Some(str_end) = skip_js_string(code, i) else {
                    return false;
                };
                let after = skip_js_ws_and_comments(code, str_end);
                if b.get(after) == Some(&b':') && code[i + 1..str_end - 1].contains('\\') {
                    return false;
                }
                i = str_end;
            }
            b'`' => {
                let Some(t) = skip_js_template(code, i) else {
                    return false;
                };
                i = t;
            }
            b'/' if b.get(i + 1) == Some(&b'/') || b.get(i + 1) == Some(&b'*') => {
                i = skip_js_ws_and_comments(code, i);
            }
            b'/' => return false,
            b'(' | b')' => return false,
            b'[' => return false,
            b'.' if b.get(i + 1) == Some(&b'.') && b.get(i + 2) == Some(&b'.') => return false,
            _ if is_js_word_at(b, i, b"working_dir") => {
                let after = skip_js_ws_and_comments(code, i + b"working_dir".len());
                if b.get(after) != Some(&b':') {
                    return false;
                }
                i += b"working_dir".len();
            }
            _ if is_js_word_at(b, i, b"assistant_id") => {
                let after = skip_js_ws_and_comments(code, i + b"assistant_id".len());
                if b.get(after) != Some(&b':') {
                    return false;
                }
                i += b"assistant_id".len();
            }
            _ => i += 1,
        }
    }
    true
}

/// Byte offset of the VALUE of a top-level `key:` inside the `(start, end)`
/// byte region, skipping strings, templates, and comments so only real-code
/// occurrences count. Both spellings of a key match — bare `agent_type:` and
/// quoted `"agent_type":` / `'agent_type':` — but only escape-free quoted
/// keys (an escaped quoted key evaluates to an unknowable spelling, and
/// guessing could match a key that is really something else) and only at
/// brace depth 1, i.e. directly inside the call's argument object: the MCP
/// listener reads FLAT args, so a same-named key nested in a sub-object is
/// invisible to it too; scanning STOPS when that object closes (depth 1→0),
/// so a second argument object can never override the first's keys.
/// Duplicate keys take the LAST occurrence — the spelling
/// the JS runtime (and the serde JSON path) actually uses. Missing a key
/// degrades to unkeyed; seeing a wrong one could mint a key nothing can
/// claim. `None` when the key is absent or not followed by `:`.
fn code_mode_find_key(code: &str, region: (usize, usize), key: &[u8]) -> Option<usize> {
    let b = code.as_bytes();
    let (start, end) = region;
    let mut i = start;
    let mut depth: usize = 0;
    let mut found: Option<usize> = None;
    while i < end {
        match b[i] {
            b'\'' | b'"' => {
                let str_end = skip_js_string(code, i)?;
                if depth == 1 && str_end >= i + 2 {
                    let inner = &code[i + 1..str_end - 1];
                    let after = skip_js_ws_and_comments(code, str_end);
                    if b.get(after) == Some(&b':')
                        && !inner.contains('\\')
                        && inner.as_bytes() == key
                    {
                        found = Some(skip_js_ws_and_comments(code, after + 1));
                    }
                }
                i = str_end;
            }
            b'`' => i = skip_js_template(code, i)?,
            b'/' if b.get(i + 1) == Some(&b'/') || b.get(i + 1) == Some(&b'*') => {
                i = skip_js_ws_and_comments(code, i);
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                if depth <= 1 {
                    // This closes the call's argument object (or is a stray
                    // close): everything after lies outside the flat args the
                    // MCP listener reads, so a second object must not
                    // contribute keys — last-wins applies within ONE object.
                    break;
                }
                depth -= 1;
                i += 1;
            }
            _ if depth == 1 && is_js_word_at(b, i, key) => {
                let after = skip_js_ws_and_comments(code, i + key.len());
                if b.get(after) == Some(&b':') {
                    found = Some(skip_js_ws_and_comments(code, after + 1));
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    found
}

/// True when the value's last consumed byte is followed (past whitespace and
/// comments) by `,` or `}` — i.e. the literal ends exactly where its object
/// property ends. A literal followed by an operator (`"a" + b`, `` `a`.trim()
/// ``) evaluates to something else at runtime, so the value must not be read
/// as the property's contribution.
fn value_ends_object_property(code: &str, end: usize) -> bool {
    let after = skip_js_ws_and_comments(code, end);
    matches!(code.as_bytes().get(after), Some(b',') | Some(b'}'))
}

/// The contents of the plain `'…'`/`"…"` string starting at `at`, plus the
/// byte offset just past its closing quote. `None` for anything containing a
/// backslash: the key must match what the MCP listener receives
/// byte-for-byte, and these argument values are simple slugs/paths in
/// practice — an escaped one is not worth guessing.
fn plain_string_value_end(code: &str, at: usize) -> Option<(String, usize)> {
    let b = code.as_bytes();
    let quote = *b.get(at)?;
    if quote != b'\'' && quote != b'"' {
        return None;
    }
    let end = skip_js_string(code, at)?;
    let inner = &code[at + 1..end - 1];
    if inner.contains('\\') {
        return None;
    }
    Some((inner.to_string(), end))
}

/// The evaluated `agent_type` / `working_dir` VALUE starting at `at`: an
/// escape-free plain string that ends where its property ends. Anything else
/// (template, variable, concatenation, number) yields `None`.
fn object_string_value(code: &str, at: usize) -> Option<String> {
    let (value, end) = plain_string_value_end(code, at)?;
    if !value_ends_object_property(code, end) {
        return None;
    }
    Some(value)
}

/// The evaluated `task` VALUE starting at `at`. Template literals go through
/// [`template_literal_text_end`]; plain `'…'`/`"…"` strings are accepted only
/// when escape-free (a value with a backslash could decode differently than
/// the source suggests — bail to the unkeyed path instead). Anything else
/// (numbers, shorthand, interpolation) yields `None`.
fn object_task_value(code: &str, at: usize) -> Option<String> {
    let (value, end) = match code.as_bytes().get(at) {
        Some(b'`') => template_literal_text_end(code, at)?,
        Some(b'\'') | Some(b'"') => plain_string_value_end(code, at)?,
        _ => return None,
    };
    if !value_ends_object_property(code, end) {
        return None;
    }
    Some(value)
}

/// The evaluated text of the template literal starting at `at`, plus the byte
/// offset just past its closing backtick — the exact string the JS runtime
/// passes to the MCP listener. That means the template's cooked text, not its
/// source: `\n \t \r \b \f \v \0 \\ \` \' \" \$ \u{…} \uXXXX \xXX` decode,
/// line continuations (`\` + CR/CRLF/LF) contribute nothing, and a BARE CR
/// or CRLF is TV-normalized to a single LF — ECMA-262's normalization
/// rewrites only those two, so U+2028/U+2029 pass through verbatim.
/// `None` for `${…}` interpolations (the evaluated value
/// differs from the source text), for any escape outside the minimal set,
/// and for legacy octal — all degrade to the pre-existing unkeyed path.
fn template_literal_text_end(code: &str, at: usize) -> Option<(String, usize)> {
    let b = code.as_bytes();
    let mut out = String::new();
    let mut i = at + 1;
    while i < b.len() {
        match b[i] {
            b'`' => return Some((out, i + 1)),
            b'\\' => {
                i += 1;
                let e = *b.get(i)?;
                i += 1;
                match e {
                    b'n' => out.push('\n'),
                    b't' => out.push('\t'),
                    b'r' => out.push('\r'),
                    b'b' => out.push('\u{0008}'),
                    b'f' => out.push('\u{000C}'),
                    b'v' => out.push('\u{000B}'),
                    b'0' => {
                        if b.get(i).is_some_and(|c| c.is_ascii_digit()) {
                            // Legacy octal (`\01` ≠ `\0` + `1`); not supported.
                            return None;
                        }
                        out.push('\0');
                    }
                    b'\\' => out.push('\\'),
                    b'`' => out.push('`'),
                    b'$' => out.push('$'),
                    b'\'' => out.push('\''),
                    b'"' => out.push('"'),
                    b'u' => {
                        if b.get(i) == Some(&b'{') {
                            let close = b[i..].iter().position(|&c| c == b'}')?;
                            let digits = &b[i + 1..i + close];
                            if digits.is_empty() || digits.len() > 6 {
                                return None;
                            }
                            let mut v: u32 = 0;
                            for &d in digits {
                                v = v * 16 + (d as char).to_digit(16)?;
                            }
                            out.push(char::from_u32(v)?);
                            i += close + 1;
                        } else {
                            let (v, next) = read_hex_digits(b, i, 4)?;
                            out.push(char::from_u32(v)?);
                            i = next;
                        }
                    }
                    b'x' => {
                        let (v, next) = read_hex_digits(b, i, 2)?;
                        out.push(char::from_u32(v)?);
                        i = next;
                    }
                    // Line continuations contribute nothing to the cooked text.
                    b'\r' => {
                        if b.get(i) == Some(&b'\n') {
                            i += 1;
                        }
                    }
                    b'\n' => {}
                    _ => return None,
                }
            }
            b'$' if b.get(i + 1) == Some(&b'{') => return None,
            // A bare CR (or the CR of a CRLF) is TV-normalized to a single LF.
            b'\r' => {
                out.push('\n');
                i += 1;
                if b.get(i) == Some(&b'\n') {
                    i += 1;
                }
            }
            _ => {
                // U+2028/U+2029 are JS line terminators but NOT TV-normalized
                // (only CR and CRLF are); folding them to LF here would mint a
                // key the MCP side never receives.
                let ch = code[i..].chars().next()?;
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    None
}

fn read_hex_digits(b: &[u8], at: usize, count: usize) -> Option<(u32, usize)> {
    if at + count > b.len() {
        return None;
    }
    let mut v: u32 = 0;
    for k in 0..count {
        v = v * 16 + (b[at + k] as char).to_digit(16)?;
    }
    Some((v, at + count))
}

/// True when an ACP `ToolCallUpdate.status` string is terminal for delegation
/// correlation. The live value is `format!("{:?}", ToolCallStatus).to_lowercase()`
/// over the `agent-client-protocol-schema` enum (variants `Pending`,
/// `InProgress`, `Completed`, `Failed`), so terminal == `completed` | `failed`.
/// Cancellation never arrives via this field — it flows through the turn-cancel
/// / teardown path, which already drains pending entries on the broker. The
/// enum is `#[non_exhaustive]`; if a `Cancelled` variant is added upstream,
/// extend this set alongside `acp::connection`'s status mapping.
fn is_terminal_tool_call_status(status: Option<&str>) -> bool {
    matches!(status, Some("completed" | "failed"))
}

/// Synchronously register a parent-side `delegate_to_agent` tool_call_id with
/// the broker, straight off the in-process bus — i.e. NOT via the
/// per-connection worker.
///
/// Called from the dispatcher loop for BOTH `ToolCall` and `ToolCallUpdate`
/// so correlation is robust against the two failure modes that orphaned the
/// second of two parallel delegations to a synthetic id (dead "view session"
/// + stuck "sub-agent running…"):
///
/// 1. **Args arriving late.** Some hosts emit an arg-less initial `ToolCall`
///    (a model-generated `title` that doesn't contain `delegate_to_agent`,
///    `raw_input` still empty) and only ship the `agent_type`/`task` arguments
///    on a following `ToolCallUpdate`. The old code registered solely from the
///    initial `ToolCall` and filtered `ToolCallUpdate` out entirely, so such a
///    call was never registered and its MCP round-trip fell back to a
///    synthetic `delegation-<uuid>`. Handling both variants here registers (or
///    backfills the key onto) the id whenever the args first appear.
/// 2. **Bus lag / worker stall.** Registration used to run inside the
///    DB-coupled per-connection worker. Under the load two parallel children
///    create (each streaming many `ToolCall`s), a worker stalling on a SQLite
///    retry could fill its mailbox, block the dispatcher's `send().await`, and
///    let the broadcast bus lag — dropping the parent's *second* `tool_call`
///    before it was ever registered. Registering here, before the
///    `is_lifecycle_relevant` filter and any worker send, removes that
///    dependency; and because `ToolCall` is no longer forwarded to workers at
///    all, the very mailbox pressure that caused the lag is gone too.
///
/// Cheap on the hot path: the discriminant match plus `is_delegation_invocation`
/// (a substring test on `title`, and a JSON parse only when `raw_input` is
/// present) fast-rejects the high-frequency non-delegation `ToolCallUpdate`
/// flood — those carry streaming `raw_output`, not `raw_input`. The broker's
/// own two-tier dedupe absorbs the repeated registrations a multi-update
/// delegation call produces.
///
/// A TERMINAL tool-call event (status `completed`/`failed`, via EITHER
/// `ToolCall` or `ToolCallUpdate` — some hosts ship status flips on the
/// non-update variant, see `register_pending_tool_call`'s dedupe doc) is handled
/// the opposite way: instead of registering, it tombstones any still-pending
/// entry for that `tool_call_id` via
/// [`DelegationBroker::tombstone_pending_tool_call`], so a `delegate_to_agent`
/// that went terminal without its MCP round-trip ever arriving can't leave a
/// stale keyed entry for a later same-key delegation to mis-claim.
async fn register_delegation_tool_call_from_event(
    broker: &DelegationBroker,
    envelope: &EventEnvelope,
) {
    // Terminal tool-call event (completed/failed) → tombstone by id, don't
    // register. Read BOTH variants, symmetric with the registration path below:
    // some hosts ship status flips on the non-update `ToolCall` variant, not
    // only `ToolCallUpdate` (`register_pending_tool_call`'s dedupe doc). Keyed on
    // `tool_call_id` membership rather than `is_delegation_invocation`: a bare
    // terminal update may carry `title: None` / `raw_input: None`, leaving no
    // derivable key, so we let the broker no-op when the id isn't a pending
    // delegation. This removes a STALE keyed entry (the call failed / the turn
    // was interrupted / its round-trip never reached the broker) so a later
    // identical (agent_type, task, working_dir) call can't claim its dead id and
    // bind to the wrong card.
    let terminal: Option<(&String, &str)> = match &envelope.payload {
        AcpEvent::ToolCall {
            tool_call_id,
            status,
            ..
        } if is_terminal_tool_call_status(Some(status)) => Some((tool_call_id, status.as_str())),
        AcpEvent::ToolCallUpdate {
            tool_call_id,
            status,
            ..
        } if is_terminal_tool_call_status(status.as_deref()) => {
            Some((tool_call_id, status.as_deref().unwrap_or("")))
        }
        _ => None,
    };
    if let Some((tool_call_id, status)) = terminal {
        let removed = broker
            .tombstone_pending_tool_call(&envelope.connection_id, tool_call_id)
            .await;
        if removed {
            tracing::info!(
                "[delegation] tombstoned stale parent tool_call_id={tool_call_id} on conn={} (terminal status={status})",
                envelope.connection_id
            );
        }
        return;
    }

    let (tool_call_id, title, raw_input): (&String, &str, Option<&str>) = match &envelope.payload {
        AcpEvent::ToolCall {
            tool_call_id,
            title,
            raw_input,
            ..
        } => (tool_call_id, title.as_str(), raw_input.as_deref()),
        AcpEvent::ToolCallUpdate {
            tool_call_id,
            title,
            raw_input,
            ..
        } => (
            tool_call_id,
            title.as_deref().unwrap_or(""),
            raw_input.as_deref(),
        ),
        _ => return,
    };
    // Cursor's ACP layer announces every MCP tool call from the FIRST streaming
    // partial — before the `McpArgs` (provider/tool identity + arguments) have
    // materialized — so the announcement is the literal fallback title
    // "MCP: tool" with an empty `raw_input`, and its `tool_call_update`s never
    // carry `title`/`raw_input` again (bundle-verified: `sendToolCallUpdate`
    // forwards only status/content/rawOutput/locations). No later event can
    // upgrade the identity, so register the id as an UNKEYED candidate on this
    // exact title: if the call turns out to be `delegate_to_agent`, its MCP
    // round-trip claims the id via the post-budget FIFO last resort and the
    // child binds to the REAL ACP id — which is what the live
    // `meta["codeg.delegation"]` write and the historical
    // `inject_delegation_meta` match both key on. A non-delegation MCP call's
    // candidate is harmless: it's tombstoned when the call goes terminal and
    // GC'd by the unkeyed TTL otherwise; the FIFO only pays out when a
    // delegate round-trip actually arrives in-window.
    //
    // The empty-`raw_input` requirement narrows the shape to exactly what
    // Cursor emits (`{}` — undefined McpArgs fields dropped by JSON): a
    // hypothetical other host reusing this title but shipping real args
    // registers through `is_delegation_invocation`'s arg-shape check or not
    // at all. Deliberately NOT gated on the connection's agent type — that
    // lookup would thread the manager through this hot-path fn (and every
    // test call site) to defend against a title no other known host emits.
    let is_cursor_identityless_mcp = title == CURSOR_IDENTITYLESS_MCP_TITLE
        && raw_input.is_none_or(|raw| matches!(raw.trim(), "" | "{}"));
    if !is_delegation_invocation(title, raw_input) && !is_cursor_identityless_mcp {
        return;
    }
    let match_key = extract_delegation_match_key(raw_input);
    tracing::info!(
        "[delegation] registering parent tool_call_id={tool_call_id} on conn={} (keyed={}, cursor_mcp_candidate={})",
        envelope.connection_id,
        match_key.is_some(),
        is_cursor_identityless_mcp
    );
    if is_cursor_identityless_mcp {
        // Identity-less candidate: additionally claimable by the broker's
        // status/cancel call-time rename, and a delegate claim landing on it
        // triggers the identity write. `is_delegation_invocation` matching
        // takes precedence above — a call that DID look like a delegation
        // registers through the ordinary (keyable) path even if its title
        // were ever the generic one.
        broker
            .register_identityless_tool_call(&envelope.connection_id, tool_call_id.clone())
            .await;
    } else {
        broker
            .register_pending_tool_call_with_key(
                &envelope.connection_id,
                tool_call_id.clone(),
                match_key,
            )
            .await;
    }
}

#[cfg(test)]
mod delegation_title_tests {
    use super::{extract_delegation_match_key, is_delegation_invocation};
    use crate::acp::delegation::broker::DelegationMatchKey;
    use crate::models::AgentType;

    #[test]
    fn extract_match_key_pulls_agent_task_and_dir() {
        let raw = r#"{"agent_type":"codex","task":"smoke test","working_dir":"/tmp"}"#;
        let key = extract_delegation_match_key(Some(raw)).expect("key parses");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
        assert_eq!(key.task, "smoke test");
        assert_eq!(key.working_dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn an_assistant_call_is_keyed_by_its_assistant_never_its_agent_type() {
        use crate::acp::delegation::types::DelegationTarget;
        // The host may fill `agent_type` with anything when it names an
        // assistant: the broker keys the call by the assistant, so must we.
        for raw in [
            r#"{"assistant_id":3,"task":"review"}"#,
            r#"{"assistant_id":"3","agent_type":"codex","task":"review"}"#,
            r#"{"params":{"input":{"assistant_id":3,"agent_type":"garbage","task":"review"}}}"#,
        ] {
            let key = extract_delegation_match_key(Some(raw)).expect("assistant key parses");
            assert_eq!(key.target, DelegationTarget::Assistant(3), "{raw}");
            assert_eq!(key.task, "review");
        }
        // An invalid id is no key at all (the listener refuses the call).
        assert!(
            extract_delegation_match_key(Some(r#"{"assistant_id":0,"task":"x"}"#)).is_none()
        );
    }

    #[test]
    fn an_assistant_call_is_recognized_by_its_shape() {
        assert!(is_delegation_invocation(
            "some host title",
            Some(r#"{"assistant_id":3,"task":"review"}"#)
        ));
        assert!(is_delegation_invocation(
            "some host title",
            Some(r#"{"arguments":{"assistant_id":"3","task":"review"}}"#)
        ));
        assert!(!is_delegation_invocation(
            "some host title",
            Some(r#"{"assistant_id":3}"#)
        ));
    }

    #[test]
    fn extract_match_key_working_dir_none_when_omitted() {
        // The common case: the LLM omits working_dir, so the key's working_dir
        // is None — symmetric with the MCP side, where the listener records
        // `requested_working_dir = None` before defaulting it for the spawn.
        let raw = r#"{"agent_type":"codex","task":"smoke test"}"#;
        let key = extract_delegation_match_key(Some(raw)).expect("key parses");
        assert!(key.working_dir.is_none());
    }

    #[test]
    fn extract_match_key_none_when_field_missing_or_unparseable() {
        // Missing task.
        assert!(extract_delegation_match_key(Some(r#"{"agent_type":"codex"}"#)).is_none());
        // Missing agent_type.
        assert!(extract_delegation_match_key(Some(r#"{"task":"x"}"#)).is_none());
        // Unknown agent_type doesn't deserialize to AgentType.
        assert!(
            extract_delegation_match_key(Some(r#"{"agent_type":"garbage","task":"x"}"#)).is_none()
        );
        // Not JSON / absent.
        assert!(extract_delegation_match_key(Some("not json")).is_none());
        assert!(extract_delegation_match_key(None).is_none());
    }

    #[test]
    fn extract_match_key_peels_wrapper_layers() {
        // Codex-style: args nested under `params.input` (mirrors the
        // `findDelegationArgs` walker in delegated-sub-thread.tsx).
        let nested = r#"{"params":{"input":{"agent_type":"codex","task":"t","working_dir":"/w"}}}"#;
        let key = extract_delegation_match_key(Some(nested)).expect("nested key parses");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
        assert_eq!(key.task, "t");
        assert_eq!(key.working_dir.as_deref(), Some("/w"));

        // JSON-RPC `{name, arguments}` envelope.
        let wrapped =
            r#"{"name":"delegate_to_agent","arguments":{"agent_type":"codex","task":"t2"}}"#;
        let key = extract_delegation_match_key(Some(wrapped)).expect("wrapped key parses");
        assert_eq!(key.task, "t2");
        assert!(key.working_dir.is_none());

        // Top-level args alongside a sibling `_meta` block (claude-agent-acp):
        // the direct hit fires at the top level, so `_meta` is never descended.
        let with_meta = r#"{"_meta":{"trace":"abc"},"agent_type":"codex","task":"t3"}"#;
        let key = extract_delegation_match_key(Some(with_meta)).expect("meta key parses");
        assert_eq!(key.task, "t3");
    }

    #[test]
    fn extract_match_key_peels_double_encoded_json() {
        // Some relays ship `raw_input` as a JSON string whose contents are the
        // arg blob (JSON-of-JSON). The walker parses one inner layer.
        let inner = r#"{"agent_type":"codex","task":"double"}"#;
        let double = serde_json::Value::String(inner.to_string()).to_string();
        let key = extract_delegation_match_key(Some(&double)).expect("double-encoded parses");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
        assert_eq!(key.task, "double");
    }

    #[test]
    fn extract_match_key_none_when_nesting_exceeds_cap() {
        // Wrapping deeper than the depth cap degrades to None (FIFO fallback)
        // rather than panicking or looping. Five `params` layers push the args
        // to depth 5, one past the cap.
        let deep = r#"{"params":{"params":{"params":{"params":{"params":{"agent_type":"codex","task":"deep"}}}}}}"#;
        assert!(extract_delegation_match_key(Some(deep)).is_none());
    }

    #[test]
    fn matches_bare_method_in_title() {
        assert!(is_delegation_invocation("delegate_to_agent", None));
        assert!(is_delegation_invocation("Delegate To Agent", None));
        assert!(is_delegation_invocation("delegate-to-agent", None));
    }

    #[test]
    fn matches_mcp_prefixed_method_in_title() {
        assert!(is_delegation_invocation(
            "mcp__codeg-mcp__delegate_to_agent",
            None
        ));
        assert!(is_delegation_invocation(
            "Run mcp__codeg__delegate_to_agent",
            None
        ));
    }

    #[test]
    fn matches_via_raw_input_shape_when_title_is_unrecognized() {
        let raw = r#"{"agent_type":"codex","task":"smoke test"}"#;
        assert!(is_delegation_invocation("Delegate to codex", Some(raw)));
        assert!(is_delegation_invocation("anything", Some(raw)));
    }

    #[test]
    fn matches_via_wrapped_raw_input_shape() {
        // A host that BOTH mangles the title AND wraps the args is still
        // recognized via the wrapper-aware shape check (otherwise it would be
        // missed entirely, not just left unkeyed).
        let wrapped = r#"{"params":{"input":{"agent_type":"codex","task":"t"}}}"#;
        assert!(is_delegation_invocation("some custom verb", Some(wrapped)));
        // Double-encoded args are recognized too.
        let inner = r#"{"agent_type":"codex","task":"t"}"#;
        let double = serde_json::Value::String(inner.to_string()).to_string();
        assert!(is_delegation_invocation("custom", Some(&double)));
    }

    #[test]
    fn rejects_unrelated_tools() {
        assert!(!is_delegation_invocation("write", None));
        assert!(!is_delegation_invocation("agent", None));
        assert!(!is_delegation_invocation("delegate_other_thing", None));
        assert!(!is_delegation_invocation(
            "write",
            Some(r#"{"path":"/tmp/x","content":"y"}"#)
        ));
    }

    #[test]
    fn terminal_status_set_is_completed_and_failed_only() {
        use super::is_terminal_tool_call_status as is_terminal;
        assert!(is_terminal(Some("completed")));
        assert!(is_terminal(Some("failed")));
        assert!(!is_terminal(Some("pending")));
        assert!(!is_terminal(Some("in_progress")));
        assert!(!is_terminal(None));
        // Cancellation never arrives via this field (it flows through the
        // turn-cancel path), so it must not be treated as terminal here.
        assert!(!is_terminal(Some("canceled")));
        assert!(!is_terminal(Some("cancelled")));
    }

    // ── opencode 2.x code-mode (`execute` tool) recognition ────────────────

    #[test]
    fn recognizes_opencode_code_mode_execute_call() {
        // opencode 2.x wraps MCP calls in its built-in `execute` tool: the
        // title is "execute" and the real call lives in a JS string under
        // `code`.
        let raw = r#"{"code":"const res = await tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `smoke test` })"}"#;
        assert!(is_delegation_invocation("execute", Some(raw)));
        // Namespaced accessor form.
        let raw2 = r#"{"code":"await tools.codeg_mcp.delegate_to_agent({agent_type:\"codex\",task:`t`})"}"#;
        assert!(is_delegation_invocation("execute", Some(raw2)));
        // Loose whitespace is still the same call site.
        let raw3 = r#"{"code":"tools [ \"codeg-mcp\" ] . delegate_to_agent ( { agent_type: \"codex\", task: `t` } )"}"#;
        assert!(is_delegation_invocation("execute", Some(raw3)));
    }

    #[test]
    fn rejects_code_mode_shapes_that_are_not_calls() {
        // Searching FOR the method is not calling it.
        assert!(!is_delegation_invocation(
            "execute",
            Some(r#"{"code":"const q = tools.search({ query: \"delegate_to_agent\" })"}"#)
        ));
        // A comment mentioning the call shape registers nothing.
        assert!(!is_delegation_invocation(
            "execute",
            Some(r#"{"code":"// tools[\"codeg-mcp\"].delegate_to_agent({agent_type:\"codex\",task:`t`})\nconst x = 1"}"#)
        ));
        // The call shape inside a string literal is data, not code.
        assert!(!is_delegation_invocation(
            "execute",
            Some(r#"{"code":"const s = 'tools[\"codeg-mcp\"].delegate_to_agent({task:`t`})'"}"#)
        ));
        // No `code` field, not JSON, and other tools of the same host.
        assert!(!is_delegation_invocation(
            "execute",
            Some(r#"{"input":"tools[\"codeg-mcp\"].delegate_to_agent({})"}"#)
        ));
        assert!(!is_delegation_invocation("execute", Some("not json")));
        assert!(!is_delegation_invocation(
            "execute",
            Some(r#"{"code":"await tools[\"codeg-mcp\"].get_delegation_status({ handle: \"h\" })"}"#)
        ));
    }

    #[test]
    fn extracts_code_mode_key_from_template_task() {
        let code = "const res = await tools[\"codeg-mcp\"].delegate_to_agent({\n  agent_type: \"codex\",\n  task: `帮我 review\n第二行`,\n  working_dir: \"/tmp/w\",\n})";
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("code-mode key parses");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
        assert_eq!(key.task, "帮我 review\n第二行");
        assert_eq!(key.working_dir.as_deref(), Some("/tmp/w"));
    }

    #[test]
    fn code_mode_key_unescapes_minimal_js_escapes() {
        // `\n` in the template SOURCE is a real newline after JS evaluation —
        // the key must match what the MCP listener receives, not the source.
        let code = r#"tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `line1\nline2\tend` })"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("escaped key parses");
        assert_eq!(key.task, "line1\nline2\tend");
    }

    #[test]
    fn code_mode_key_accepts_escape_free_quoted_task() {
        // A quoted string with no backslashes evaluates byte-identically, so
        // it keys like a template would.
        let code = r#"tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: "plain task" })"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("quoted key parses");
        assert_eq!(key.task, "plain task");
        // …but an escaped quoted string bails (unkeyed) instead of guessing.
        let escaped = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: \"a\\nb\" })"}"#;
        assert!(extract_delegation_match_key(Some(escaped)).is_none());
    }

    #[test]
    fn code_mode_key_bails_on_ambiguity() {
        // Interpolation evaluates differently from the source text.
        let interp = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `sum ${1 + 1}` })"}"#;
        assert!(extract_delegation_match_key(Some(interp)).is_none());
        // Unknown escape → bail rather than guess. (`\\q` in the JSON string
        // is the JS source's `\q`.)
        let unknown_escape = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `a\\qb` })"}"#;
        assert!(extract_delegation_match_key(Some(unknown_escape)).is_none());
        // Mixed shape: `assistant_id` wins on the MCP side; guessing
        // Agent(…) here would mint an unclaimable keyed entry.
        let mixed = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ assistant_id: 3, agent_type: \"codex\", task: `t` })"}"#;
        assert!(extract_delegation_match_key(Some(mixed)).is_none());
        // No target / unknown target → no key.
        let no_target = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ task: `t` })"}"#;
        assert!(extract_delegation_match_key(Some(no_target)).is_none());
        let bad_target = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"garbage\", task: `t` })"}"#;
        assert!(extract_delegation_match_key(Some(bad_target)).is_none());
        // The invocation is still RECOGNIZED in every ambiguous shape, so the
        // id registers as an unkeyed candidate (post-budget FIFO claim).
        assert!(is_delegation_invocation("execute", Some(interp)));
        assert!(is_delegation_invocation("execute", Some(unknown_escape)));
        assert!(is_delegation_invocation("execute", Some(mixed)));
        assert!(is_delegation_invocation("execute", Some(no_target)));
    }

    #[test]
    fn code_mode_region_scan_does_not_bleed_across_calls() {
        // A second tool call AFTER the delegate call carries its own `task:`
        // field; keys must be read only within the delegate call's parens.
        let code = "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `t1` }); tools[\"codeg-mcp\"].get_delegation_status({ task: `other`, handle: \"h\" })";
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("key parses");
        assert_eq!(key.task, "t1");
    }

    #[test]
    fn code_mode_key_matches_the_mcp_side_for_the_same_call() {
        // 对拍: the same logical delegation expressed twice — once as the
        // evaluated MCP `tools/call` args (how `handle_request` builds the
        // request key), once as opencode's code-mode ACP payload — must
        // produce byte-identical keys.
        use crate::acp::delegation::types::delegation_target_from_args;

        let task = "review 对拍\nsecond\tline ✓";
        let working_dir = "/tmp/对拍";
        let mcp_args = serde_json::json!({
            "agent_type": "codex",
            "task": task,
            "working_dir": working_dir,
        });
        let request_key = DelegationMatchKey {
            target: delegation_target_from_args(&mcp_args).unwrap(),
            task: task.to_string(),
            working_dir: Some(working_dir.to_string()),
        };
        let code = r#"await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", working_dir: "/tmp/对拍", task: `review 对拍\nsecond\tline ✓` })"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        let acp_key = extract_delegation_match_key(Some(&raw)).expect("acp key parses");
        assert_eq!(acp_key, request_key);

        // U+2028/U+2029 pass through BOTH sides verbatim (ECMA-262
        // TV-normalizes only CR/CRLF), so the keys still match byte-for-byte.
        let task_ls = "seg\u{2028}a\u{2029}b";
        let mcp_args = serde_json::json!({ "agent_type": "codex", "task": task_ls });
        let request_key = DelegationMatchKey {
            target: delegation_target_from_args(&mcp_args).unwrap(),
            task: task_ls.to_string(),
            working_dir: None,
        };
        let code_ls = "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `seg\u{2028}a\u{2029}b` })";
        let raw = serde_json::json!({ "code": code_ls }).to_string();
        let acp_key = extract_delegation_match_key(Some(&raw)).expect("ls acp key parses");
        assert_eq!(acp_key, request_key);
    }

    #[test]
    fn code_mode_key_bails_when_working_dir_present_but_unreadable() {
        // Present-and-unreadable must bail the WHOLE key: the MCP side sees
        // Some(dir), so a None-keyed entry could never be claimed. Absent
        // `working_dir` stays keyed with working_dir None.
        let cases = [
            // JS source `working_dir: "C:\\proj"` — an escaped (unreadable) value.
            r#"{ agent_type: "codex", working_dir: "C:\\proj", task: `t` }"#,
            r#"{ agent_type: "codex", working_dir: `${cwd}/proj`, task: `t` }"#,
            r#"{ agent_type: "codex", working_dir: projectDir, task: `t` }"#,
            r#"{ agent_type: "codex", working_dir: "/tmp" + "/w", task: `t` }"#,
        ];
        for code in cases {
            let raw =
                serde_json::json!({ "code": format!("tools[\"codeg-mcp\"].delegate_to_agent({code})") })
                    .to_string();
            assert!(
                extract_delegation_match_key(Some(&raw)).is_none(),
                "expected unkeyed for {code}"
            );
            assert!(is_delegation_invocation("execute", Some(&raw)));
        }
        let absent = r#"tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` })"#;
        let raw = serde_json::json!({ "code": absent }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("absent working_dir keys");
        assert_eq!(key.working_dir, None);
        assert_eq!(key.task, "t");
    }

    #[test]
    fn code_mode_key_bails_when_value_continues_past_literal() {
        // A literal followed by an operator evaluates to something else at
        // runtime; reading the literal alone would mint a wrong key.
        let cases = [
            r#"{ agent_type: "codex", task: "a" + b }"#,
            r#"{ agent_type: "codex", task: `a`.trim() }"#,
            r#"{ agent_type: "co" + "dex", task: `t` }"#,
            r#"{ agent_type: "codex", working_dir: "/a" + suffix, task: `t` }"#,
        ];
        for code in cases {
            let raw =
                serde_json::json!({ "code": format!("tools[\"codeg-mcp\"].delegate_to_agent({code})") })
                    .to_string();
            assert!(
                extract_delegation_match_key(Some(&raw)).is_none(),
                "expected unkeyed for {code}"
            );
            assert!(is_delegation_invocation("execute", Some(&raw)));
        }
    }

    #[test]
    fn code_mode_key_bails_when_args_syntax_is_unreadable() {
        // A shorthand property evaluates to the variable's runtime value
        // (keyed-with-None could never be claimed by THIS call's round-trip
        // and would poison the FIFO pool); a nested call/parenthesized
        // expression and a regex literal are expressions the scanner cannot
        // evaluate — and a regex body could feed quotes/braces to the
        // string/template arms.
        let cases = [
            r#"{ agent_type: "codex", task: `t`, working_dir }"#,
            r#"{ agent_type: "codex", task: `t`, assistant_id }"#,
            r#"{ agent_type: pick("codex"), task: `t` }"#,
            r#"{ agent_type: "codex", task: `t`, flag: /}/ }"#,
        ];
        for code in cases {
            let raw =
                serde_json::json!({ "code": format!("tools[\"codeg-mcp\"].delegate_to_agent({code})") })
                    .to_string();
            assert!(
                extract_delegation_match_key(Some(&raw)).is_none(),
                "expected unkeyed for {code}"
            );
            assert!(is_delegation_invocation("execute", Some(&raw)));
        }
    }

    #[test]
    fn code_mode_key_stops_at_the_argument_object_close() {
        // A second object after the first's closing brace is a different
        // argument, not part of the flat args; its keys must not win
        // (last-wins applies within ONE object only).
        let code = r#"tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `t` }, { agent_type: "goose", task: `u` })"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("first object keys");
        assert_eq!(key.task, "t");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
    }

    #[test]
    fn code_mode_line_comments_end_at_every_js_line_terminator() {
        // ECMA-262 line comments end at CR, LF, U+2028 and U+2029; a scanner
        // stopping only at LF would swallow the real code after the others.
        let cr = "tools[\"codeg-mcp\"].delegate_to_agent({ // pick\r agent_type: \"codex\", task: `t` })";
        let raw = serde_json::json!({ "code": cr }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("CR comment ends");
        assert_eq!(key.task, "t");

        let ls = "tools[\"codeg-mcp\"].delegate_to_agent({ // pick\u{2028} agent_type: \"codex\", task: `t` })";
        let raw = serde_json::json!({ "code": ls }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("LS comment ends");
        assert_eq!(key.task, "t");
    }

    #[test]
    fn code_mode_key_accepts_comments_around_values() {
        // Comments between a value and its property terminator (or between
        // properties) are whitespace; they must not break a readable call.
        let code = r#"tools["codeg-mcp"].delegate_to_agent({
  // choose the agent
  agent_type: "codex", /* trailing */ task: `t` /* last */, // done
})"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("commented form parses");
        assert_eq!(key.task, "t");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
    }

    #[test]
    fn code_mode_assistant_id_guard_covers_every_spelling() {
        // Bare numeric, quoted-key, and quoted-key+quoted-value spellings all
        // resolve to Assistant(…) on the MCP side; no Agent(…) guess may key.
        let bare = r#"tools["codeg-mcp"].delegate_to_agent({ assistant_id: 3, task: `t` })"#;
        let quoted = r#"tools["codeg-mcp"].delegate_to_agent({ "assistant_id": 3, task: `t` })"#;
        let quoted_value = r#"tools["codeg-mcp"].delegate_to_agent({ "assistant_id": "3", task: `t` })"#;
        for code in [bare, quoted, quoted_value] {
            let raw = serde_json::json!({ "code": code }).to_string();
            assert!(
                extract_delegation_match_key(Some(&raw)).is_none(),
                "expected unkeyed for {code}"
            );
            assert!(is_delegation_invocation("execute", Some(&raw)));
        }
        // Computed key and spread are unknowable syntax: the transparency
        // pre-pass degrades the whole region.
        let computed =
            r#"tools["codeg-mcp"].delegate_to_agent({ ["assistant_id"]: 3, agent_type: "codex", task: `t` })"#;
        let spread = r#"tools["codeg-mcp"].delegate_to_agent({ ...base, task: `t` })"#;
        for code in [computed, spread] {
            let raw = serde_json::json!({ "code": code }).to_string();
            assert!(
                extract_delegation_match_key(Some(&raw)).is_none(),
                "expected unkeyed for {code}"
            );
            assert!(is_delegation_invocation("execute", Some(&raw)));
        }
    }

    #[test]
    fn code_mode_key_reads_quoted_keys_and_ignores_nested_ones() {
        // Quoted property keys are real keys too.
        let quoted =
            r#"tools["codeg-mcp"].delegate_to_agent({ "agent_type": "codex", 'task': "plain" })"#;
        let raw = serde_json::json!({ "code": quoted }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("quoted-key form parses");
        assert_eq!(key.task, "plain");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );

        // A same-named key nested in a sub-object is invisible to the MCP
        // listener (it reads flat args), so it must not be read here either —
        // in either source order.
        let nested = r#"tools["codeg-mcp"].delegate_to_agent({
  meta: { agent_type: "zzz", task: `decoy` },
  agent_type: "codex",
  task: `real`,
})"#;
        let raw = serde_json::json!({ "code": nested }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("nested form parses");
        assert_eq!(key.task, "real");
        assert_eq!(
            key.target,
            crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex)
        );
        let nested_rev = r#"tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `real`, meta: { task: `decoy`, agent_type: "zzz" } })"#;
        let raw = serde_json::json!({ "code": nested_rev }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("nested-rev form parses");
        assert_eq!(key.task, "real");
    }

    #[test]
    fn code_mode_template_task_normalizes_line_terminators() {
        // The JS runtime TV-normalizes bare line terminators in template
        // literals to a single LF (CRLF and CR included); the key must be
        // built from the COOKED text the MCP listener receives.
        let code = "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `a\r\nb\rc` })";
        let raw = serde_json::json!({ "code": code }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("crlf key parses");
        assert_eq!(key.task, "a\nb\nc");

        // U+2028/U+2029 are JS line terminators but NOT TV-normalized
        // (ECMA-262 rewrites only CR and CRLF); they pass through verbatim.
        let ls = "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `a\u{2028}b` })";
        let raw = serde_json::json!({ "code": ls }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("LS key parses");
        assert_eq!(key.task, "a\u{2028}b");

        let ps = "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `a\u{2029}b` })";
        let raw = serde_json::json!({ "code": ps }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("PS key parses");
        assert_eq!(key.task, "a\u{2029}b");

        // A backslash line continuation contributes nothing to the cooked text.
        let cont =
            "tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `a\\\r\nb` })";
        let raw = serde_json::json!({ "code": cont }).to_string();
        let key = extract_delegation_match_key(Some(&raw)).expect("continuation key parses");
        assert_eq!(key.task, "ab");
    }
}

#[cfg(test)]
mod delegation_registration_tests {
    //! Covers `register_delegation_tool_call_from_event` — the dispatcher-side
    //! correlation capture that replaced the worker's `ToolCall` arm. These
    //! exercise the two cases that orphaned a parallel delegation to a
    //! synthetic id before the move: args arriving on a `ToolCallUpdate`, and
    //! a key backfilled by a later update.

    use super::register_delegation_tool_call_from_event;
    use crate::acp::delegation::broker::{
        ConversationDepthLookup, DelegationBroker, DelegationMatchKey,
    };
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::DelegationError;
    use crate::acp::types::{AcpEvent, EventEnvelope};
    use crate::models::AgentType;
    use async_trait::async_trait;
    use std::sync::Arc;

    struct RootDepth;
    #[async_trait]
    impl ConversationDepthLookup for RootDepth {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    fn broker() -> DelegationBroker {
        DelegationBroker::new(
            Arc::new(MockSpawner::new()) as Arc<dyn ConnectionSpawner>,
            Arc::new(RootDepth) as Arc<dyn ConversationDepthLookup>,
        )
    }

    fn tool_call_event(tool_call_id: &str, title: &str, raw_input: Option<&str>) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: "parent-conn".into(),
            payload: AcpEvent::ToolCall {
                tool_call_id: tool_call_id.into(),
                title: title.into(),
                kind: "other".into(),
                status: "pending".into(),
                content: None,
                raw_input: raw_input.map(|s| s.to_string()),
                raw_output: None,
                locations: None,
                meta: None,
                images: None,
            },
        }
    }

    fn tool_call_update_event(
        tool_call_id: &str,
        title: Option<&str>,
        raw_input: Option<&str>,
    ) -> EventEnvelope {
        EventEnvelope {
            seq: 2,
            connection_id: "parent-conn".into(),
            payload: AcpEvent::ToolCallUpdate {
                tool_call_id: tool_call_id.into(),
                title: title.map(|s| s.to_string()),
                status: None,
                content: None,
                raw_input: raw_input.map(|s| s.to_string()),
                raw_output: None,
                raw_output_append: None,
                locations: None,
                meta: None,
                images: None,
            },
        }
    }

    fn codex_key(task: &str) -> DelegationMatchKey {
        DelegationMatchKey {
            target: crate::acp::delegation::types::DelegationTarget::Agent(AgentType::Codex),
            task: task.to_string(),
            working_dir: None,
        }
    }

    /// `tool_call_update_event` with an explicit `status` (the base helper
    /// hardcodes `None`). Used to drive the terminal-tombstone branch.
    fn tool_call_update_event_with_status(
        tool_call_id: &str,
        status: Option<&str>,
        raw_input: Option<&str>,
    ) -> EventEnvelope {
        EventEnvelope {
            seq: 2,
            connection_id: "parent-conn".into(),
            payload: AcpEvent::ToolCallUpdate {
                tool_call_id: tool_call_id.into(),
                title: None,
                status: status.map(|s| s.to_string()),
                content: None,
                raw_input: raw_input.map(|s| s.to_string()),
                raw_output: None,
                raw_output_append: None,
                locations: None,
                meta: None,
                images: None,
            },
        }
    }

    /// `tool_call_event` with an explicit `status` (the base helper hardcodes
    /// `"pending"`). Some hosts ship terminal status flips on the non-update
    /// `ToolCall` variant, so the tombstone branch must read it too.
    fn tool_call_event_with_status(
        tool_call_id: &str,
        title: &str,
        status: &str,
        raw_input: Option<&str>,
    ) -> EventEnvelope {
        EventEnvelope {
            seq: 1,
            connection_id: "parent-conn".into(),
            payload: AcpEvent::ToolCall {
                tool_call_id: tool_call_id.into(),
                title: title.into(),
                kind: "other".into(),
                status: status.into(),
                content: None,
                raw_input: raw_input.map(|s| s.to_string()),
                raw_output: None,
                locations: None,
                meta: None,
                images: None,
            },
        }
    }

    /// A terminal `ToolCallUpdate` (completed) for a registered delegation
    /// tombstones its keyed entry, so a `delegate_to_agent` that went terminal
    /// without its round-trip ever arriving leaves nothing for a later same-key
    /// delegation to mis-claim.
    #[tokio::test]
    async fn terminal_update_tombstones_registered_delegation() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-1",
                "delegate_to_agent",
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event_with_status("tc-1", Some("completed"), None),
        )
        .await;
        assert!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .is_none(),
            "a terminal ToolCallUpdate must tombstone the stale keyed entry"
        );
    }

    /// A NON-terminal update must NOT tombstone: this is the serialized
    /// round-trip case (Claude Code runs parallel `delegate_to_agent` calls
    /// one-at-a-time, so the 2nd entry waits `in_progress` for up to ~77s before
    /// its round-trip fires). Evicting it here would reintroduce the dead-card
    /// bug the keyed-retention rule was added to fix.
    #[tokio::test]
    async fn non_terminal_update_does_not_tombstone() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-late",
                "delegate_to_agent",
                Some(r#"{"agent_type":"codex","task":"slow"}"#),
            ),
        )
        .await;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event_with_status("tc-late", Some("in_progress"), None),
        )
        .await;
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("slow"))
                .await
                .as_deref(),
            Some("tc-late"),
            "a non-terminal update must leave the waiting entry claimable"
        );
    }

    /// A terminal update for an unrelated (non-delegation) tool call no-ops and
    /// leaves a registered delegation intact — the tombstone runs for every
    /// terminal update but only removes a matching pending delegation id.
    #[tokio::test]
    async fn terminal_update_for_unrelated_tool_is_harmless() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-deleg",
                "delegate_to_agent",
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event_with_status("tc-bash-42", Some("completed"), None),
        )
        .await;
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .as_deref(),
            Some("tc-deleg"),
            "a terminal update for an unrelated tool must leave the delegation intact"
        );
    }

    /// A terminal status shipped via the non-update `ToolCall` variant (some
    /// hosts use it for status flips — see `register_pending_tool_call`'s dedupe
    /// doc) tombstones too, symmetric with the `ToolCallUpdate` path. Without
    /// this, a terminal `ToolCall` still carrying the delegation shape would
    /// RE-REGISTER the stale entry instead of removing it. Uses `failed` to also
    /// drive that terminal value through the dispatcher.
    #[tokio::test]
    async fn terminal_tool_call_variant_tombstones_registered_delegation() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-1",
                "delegate_to_agent",
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event_with_status(
                "tc-1",
                "delegate_to_agent",
                "failed",
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        assert!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .is_none(),
            "a terminal ToolCall (status flip via the non-update variant) must tombstone"
        );
    }

    /// A terminal `ToolCall` for an id with no pending entry must NOT register a
    /// fresh one — it short-circuits at the terminal branch before the register
    /// path, so it can't itself create the stale entry it exists to prevent.
    #[tokio::test]
    async fn terminal_tool_call_does_not_register_fresh_entry() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event_with_status(
                "tc-1",
                "delegate_to_agent",
                "completed",
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        assert!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .is_none(),
            "a terminal ToolCall with no prior registration must not create an entry"
        );
    }

    /// The headline regression: a delegation whose `agent_type`/`task` arrive
    /// on a `ToolCallUpdate` (the initial `ToolCall` had a model-generated
    /// title and no `raw_input`) is still registered, keyed, and claimable by
    /// its MCP round-trip. The old `ToolCall`-only path never saw the args, so
    /// this call fell back to a synthetic id → dead "view session".
    #[tokio::test]
    async fn registers_delegation_from_tool_call_update() {
        let b = broker();
        // Arg-less initial ToolCall with a descriptive title → not yet a
        // recognizable delegation, nothing registered.
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-1", "Delegating research to codex", None),
        )
        .await;
        assert!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .is_none(),
            "arg-less descriptive ToolCall must not register"
        );
        // Args land on the following update → now registered with its key.
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event(
                "tc-1",
                Some("Delegating research to codex"),
                Some(r#"{"agent_type":"codex","task":"research"}"#),
            ),
        )
        .await;
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("research"))
                .await
                .as_deref(),
            Some("tc-1"),
            "delegation args arriving via ToolCallUpdate must register the id"
        );
    }

    /// An initial `ToolCall` whose title names the tool but carries no args
    /// registers UNKEYED; a later `ToolCallUpdate` with the args must backfill
    /// the key. The in-loop claim binds ONLY by exact key match (unkeyed entries
    /// are never claimed there), so `tc-2` becomes claimable purely because the
    /// backfill landed its key — shown here alongside a parallel keyed sibling
    /// it must not be mixed up with.
    #[tokio::test]
    async fn update_backfills_key_onto_unkeyed_tool_call() {
        let b = broker();
        // tc-2 registers unkeyed (tool-name title, no raw_input yet).
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-2", "mcp__codeg-mcp__delegate_to_agent", None),
        )
        .await;
        // A parallel keyed sibling sharing the queue (must not be mixed up).
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-sibling",
                "mcp__codeg-mcp__delegate_to_agent",
                Some(r#"{"agent_type":"codex","task":"sibling"}"#),
            ),
        )
        .await;
        // tc-2's args arrive on an update → backfills its key.
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event(
                "tc-2",
                None,
                Some(r#"{"agent_type":"codex","task":"build"}"#),
            ),
        )
        .await;
        // In-loop claims are exact-match-only, so tc-2 is claimable purely
        // because the backfill landed its key (never via arrival-order FIFO).
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("build"))
                .await
                .as_deref(),
            Some("tc-2"),
            "ToolCallUpdate must backfill the key onto the unkeyed entry"
        );
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("sibling"))
                .await
                .as_deref(),
            Some("tc-sibling")
        );
    }

    /// The high-frequency non-delegation tool stream (bash/read/write and
    /// their `raw_output` update floods) must never register anything — that's
    /// what keeps the dispatcher-side check cheap and the pending queue clean.
    #[tokio::test]
    async fn ignores_non_delegation_tool_events() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-3", "bash", Some(r#"{"command":"ls"}"#)),
        )
        .await;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_update_event("tc-3", Some("bash"), None),
        )
        .await;
        assert!(
            b.take_pending_tool_call("parent-conn").await.is_none(),
            "non-delegation tool events must not register"
        );
    }

    /// Cursor announces every MCP call as the literal "MCP: tool" (identity
    /// streams in after the announcement and never reaches the wire again).
    /// Such an event must register an UNKEYED candidate that the post-budget
    /// FIFO claim can pay out to a `delegate_to_agent` round-trip.
    #[tokio::test]
    async fn cursor_identityless_mcp_title_registers_unkeyed_candidate() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("call-cursor-1\nfc_abc_0", "MCP: tool", Some("{}")),
        )
        .await;
        assert_eq!(
            b.take_pending_tool_call("parent-conn").await.as_deref(),
            Some("call-cursor-1\nfc_abc_0"),
            "the identity-less Cursor MCP announcement must be claimable unkeyed"
        );
    }

    /// The candidate branch is scoped to the EXACT fallback title — other
    /// generic titles (including near-misses) must not enqueue junk ids —
    /// AND to the empty raw_input Cursor actually ships; a same-titled call
    /// carrying real args is not the identity-less shape.
    #[tokio::test]
    async fn near_miss_generic_titles_do_not_register() {
        let b = broker();
        for title in ["MCP: weather", "MCP:tool", "mcp: tool", "Tool"] {
            register_delegation_tool_call_from_event(
                &b,
                &tool_call_event("tc-x", title, Some("{}")),
            )
            .await;
        }
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-y", "MCP: tool", Some(r#"{"providerIdentifier":"x"}"#)),
        )
        .await;
        assert!(
            b.take_pending_tool_call("parent-conn").await.is_none(),
            "only the literal \"MCP: tool\" fallback with an empty input registers"
        );
    }

    /// Cursor's full-form MCP `raw_input` nests the delegation arguments under
    /// `args` (`{providerIdentifier, toolName, args: {...}}`). The wrapper
    /// walker must peel it so the registration is KEYED (exact-match claim, no
    /// FIFO ambiguity).
    #[tokio::test]
    async fn cursor_args_wrapper_yields_keyed_registration() {
        let b = broker();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event(
                "tc-keyed",
                "codeg-mcp: delegate_to_agent",
                Some(
                    r#"{"providerIdentifier":"codeg-mcp","toolName":"delegate_to_agent","args":{"agent_type":"codex","task":"build it"}}"#,
                ),
            ),
        )
        .await;
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("build it"))
                .await
                .as_deref(),
            Some("tc-keyed"),
            "args-wrapped delegation input must produce a keyed entry"
        );
    }

    /// opencode 2.x code-mode: the `execute` announcement (title "execute",
    /// the real call inside a JS string under `code`) must register KEYED, and
    /// the exact key the MCP round-trip presents must claim that id — the
    /// full loop that used to end in a synthetic `delegation-<uuid>`.
    #[tokio::test]
    async fn opencode_code_mode_execute_yields_keyed_registration() {
        let b = broker();
        let code = r#"const res = await tools["codeg-mcp"].delegate_to_agent({ agent_type: "codex", task: `research code-mode` })"#;
        let raw = serde_json::json!({ "code": code }).to_string();
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-codemode", "execute", Some(&raw)),
        )
        .await;
        assert_eq!(
            b.take_matching_tool_call("parent-conn", &codex_key("research code-mode"))
                .await
                .as_deref(),
            Some("tc-codemode"),
            "code-mode execute payload must produce a keyed entry the MCP-side key claims"
        );
    }

    /// An ambiguous code-mode payload (interpolated task) still registers the
    /// id UNKEYED, so the post-budget FIFO path can bind it instead of
    /// orphaning the call to a synthetic id.
    #[tokio::test]
    async fn ambiguous_code_mode_execute_still_registers_unkeyed() {
        let b = broker();
        let raw = r#"{"code":"tools[\"codeg-mcp\"].delegate_to_agent({ agent_type: \"codex\", task: `sum ${1 + 1}` })"}"#;
        register_delegation_tool_call_from_event(
            &b,
            &tool_call_event("tc-ambiguous", "execute", Some(raw)),
        )
        .await;
        // Keyed claim must NOT match (no key was minted); the unkeyed FIFO
        // fallback is what picks the id up.
        assert!(
            b.take_matching_tool_call("parent-conn", &codex_key("sum 2"))
                .await
                .is_none(),
            "an ambiguous payload must not mint a keyed entry"
        );
        assert_eq!(
            b.take_pending_tool_call("parent-conn").await.as_deref(),
            Some("tc-ambiguous"),
            "the id must remain claimable via the unkeyed FIFO path"
        );
    }

    /// The synthetic-fallback diagnostic: keyed pending entries still waiting
    /// on this parent surface as `id=… target=… task=… dir=…` summaries, so a
    /// "pending key vs request key" mismatch is visible in the WARN.
    #[tokio::test]
    async fn unmatched_pending_key_summaries_reports_keyed_entries() {
        let b = broker();
        assert!(
            b.unmatched_pending_key_summaries("parent-conn")
                .await
                .is_empty(),
            "no entries → no summaries"
        );
        b.register_pending_tool_call_with_key(
            "parent-conn",
            "call-keyed".into(),
            Some(codex_key("review 对拍")),
        )
        .await;
        b.register_pending_tool_call_with_key("parent-conn", "call-unkeyed".into(), None)
            .await;
        let summaries = b.unmatched_pending_key_summaries("parent-conn").await;
        assert_eq!(summaries.len(), 1, "unkeyed entries are not summarized");
        assert!(summaries[0].contains("call-keyed"), "{}", summaries[0]);
        assert!(summaries[0].contains("review 对拍"), "{}", summaries[0]);
        // Claiming the entry empties the summary again.
        b.take_matching_tool_call("parent-conn", &codex_key("review 对拍"))
            .await;
        assert!(
            b.unmatched_pending_key_summaries("parent-conn")
                .await
                .is_empty()
        );
    }
}

/// Per-connection worker that owns the cache for one connection and
/// serializes its DB writes. Multiple connections run in parallel; within a
/// connection, ordering is preserved by the mpsc FIFO. Decouples the bus
/// receiver from DB-write latency — a slow SQLite write on connection A no
/// longer blocks events for connection B from being drained off the
/// broadcast buffer (the prior failure mode that pushed `lagged_count`).
async fn connection_worker_loop(
    connection_id: String,
    db: DatabaseConnection,
    manager: ConnectionManager,
    broker: Option<Arc<DelegationBroker>>,
    mut rx: mpsc::Receiver<Arc<EventEnvelope>>,
) {
    // 1-entry HashMap so we can reuse `handle_terminal_event` (also keeps the
    // existing test surface intact — tests still drive a `&mut HashMap`).
    let mut cache: HashMap<String, CachedConn> = HashMap::new();
    // True once we've already invoked `handle_terminal_event` +
    // `forward_disconnect_to_broker` for this connection. Terminal `Error`
    // and `Disconnected` ARE both expected on the genuine teardown path
    // (`connection.rs:493` → `run_connection` unwind → `Disconnected`), and
    // either one alone is also valid: a `Disconnected` without preceding
    // Error fires for clean transport close, and a terminal Error in
    // theory could be the last event if the bus drops the trailing
    // Disconnected (broadcast `Lagged`). Whichever lands first dispatches
    // the terminal work; the second one is a no-op so the broker / DB
    // aren't double-touched.
    let mut terminal_dispatched = false;
    while let Some(envelope_arc) = rx.recv().await {
        let envelope: &EventEnvelope = envelope_arc.as_ref();
        match &envelope.payload {
            AcpEvent::ConversationLinked {
                conversation_id, ..
            } => {
                try_cache_link(&mut cache, &manager, &connection_id, *conversation_id).await;
            }
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            } => {
                if terminal_dispatched {
                    continue;
                }
                if let Err(e) = handle_terminal_event(&db, &mut cache, &connection_id).await {
                    tracing::error!("[lifecycle][ERROR] terminal event for {connection_id}: {e}");
                }
                if let Some(b) = broker.as_ref() {
                    forward_disconnect_to_broker(b.as_ref(), &connection_id, None).await;
                }
                terminal_dispatched = true;
            }
            AcpEvent::Error {
                message,
                code,
                terminal,
                ..
            } => {
                // Non-terminal Errors (`turn_failure_error_event`,
                // `session/load` fallback, empty-prompt rejection, SetMode
                // / SetConfigOption failures) leave the connection alive:
                // - flipping the row InProgress → Cancelled would briefly
                //   show "Cancelled" in the UI before the next TurnComplete
                //   corrects it (cosmetic but jumpy).
                // - draining the broker would race-cancel a pending
                //   delegation that the upcoming `TurnComplete` →
                //   `complete_call` would have mapped to a proper child-side
                //   error code (`ChildRefusal` / `ChildMaxTokens` / …).
                //
                // F2 in the v0.14.3 sub-agent delegation post-mortem.
                if !*terminal {
                    continue;
                }
                if terminal_dispatched {
                    continue;
                }
                // Genuinely terminal (the `run_connection` failure path at
                // `connection.rs:493`). Drain the broker NOW with the error
                // detail instead of waiting for the trailing `Disconnected`.
                // If `Disconnected` never arrives (bus `Lagged`, task
                // abort, a future emit site that forgets to follow up) the
                // parent's `delegate_to_agent` would otherwise block on
                // `rx.await` forever. The drain itself is idempotent
                // (`cancel_by_child_connection` no-ops on empty pending),
                // so the subsequent Disconnected will short-circuit on
                // `terminal_dispatched`.
                if let Err(e) = handle_terminal_event(&db, &mut cache, &connection_id).await {
                    tracing::error!("[lifecycle][ERROR] terminal event for {connection_id}: {e}");
                }
                if let Some(b) = broker.as_ref() {
                    let detail = format_terminal_error(message, code.as_deref());
                    forward_disconnect_to_broker(b.as_ref(), &connection_id, Some(&detail)).await;
                }
                terminal_dispatched = true;
            }
            _ => {
                handle_event_with_retry(&db, &manager, envelope, broker.as_ref()).await;
            }
        }
    }
}

/// Subscribe to the in-process bus synchronously and return the dispatcher
/// loop future. Filters out events the lifecycle worker doesn't care about
/// (high-frequency ContentDelta / ToolCall / PermissionRequest etc.) and
/// fans the rest out to per-connection worker tasks. Within a single
/// connection, ordering is preserved by the per-worker mpsc; across
/// connections, workers run independently so a slow SQLite write on one
/// connection doesn't backpressure the others.
///
/// All forwarded events (the 7 types in `is_lifecycle_relevant`) use
/// blocking `send().await` to guarantee delivery even when the worker
/// mailbox is full — `SessionStarted` (writes external_id) and
/// `TurnComplete` (writes terminal status) are correctness-critical and
/// silently dropping either leaves the conversation row in a permanently
/// wrong state. Filtering keeps the queue from filling on noise traffic
/// so the blocking path is rarely exercised.
///
/// The `subscribe()` call happens here, before the future is returned, so any
/// events emitted between this call and the first poll are buffered by the
/// broadcast channel rather than dropped.
pub fn lifecycle_subscriber_task(
    db_conn: DatabaseConnection,
    manager: ConnectionManager,
    bus: Arc<InternalEventBus>,
    broker: Option<Arc<DelegationBroker>>,
) -> impl Future<Output = ()> + Send + 'static {
    let mut rx = bus.subscribe();
    let metrics = Arc::clone(bus.metrics());
    async move {
        // connection_id → worker mailbox. Workers are spawned lazily on the
        // connection's first relevant event and torn down after a terminal
        // event by dropping the sender (worker drains its queue and exits).
        let mut workers: HashMap<String, mpsc::Sender<Arc<EventEnvelope>>> = HashMap::new();
        let mut lag_throttle = LagLogThrottle::new(LAG_LOG_WINDOW);
        loop {
            match rx.recv().await {
                Ok(envelope_arc) => {
                    // Off-worker delegation correlation. Register parent-side
                    // `delegate_to_agent` tool_call_ids the instant they come
                    // off the bus — before the `is_lifecycle_relevant` filter
                    // and before any worker `send().await` that could block and
                    // back-pressure the bus into dropping a later event. This is
                    // why `ToolCall`/`ToolCallUpdate` no longer need to reach a
                    // worker at all. See `register_delegation_tool_call_from_event`.
                    if let Some(b) = broker.as_ref() {
                        register_delegation_tool_call_from_event(b.as_ref(), &envelope_arc).await;
                        // Same placement rationale: a blocking prompt raised on
                        // a delegation child must reach the broker's parked
                        // status long-polls immediately, so the parent LLM can
                        // report "waiting on you" instead of hanging until the
                        // user happens to notice (#447). Ahead of the
                        // `is_lifecycle_relevant` filter, which drops all six.
                        if is_blocking_prompt_event(&envelope_arc.payload) {
                            b.note_blocking_changed();
                        }
                    }

                    // Fast-path filter: skip events the worker would no-op.
                    // Avoids spawning a worker for connections that only emit
                    // high-frequency noise and avoids crowding existing
                    // workers' mailboxes.
                    if !is_lifecycle_relevant(&envelope_arc.payload) {
                        continue;
                    }

                    let conn_id = envelope_arc.connection_id.clone();
                    let is_terminal = is_dispatcher_terminal(&envelope_arc.payload);

                    let tx = workers.entry(conn_id.clone()).or_insert_with(|| {
                        let (tx, worker_rx) =
                            mpsc::channel::<Arc<EventEnvelope>>(WORKER_QUEUE_CAPACITY);
                        let db_clone = db_conn.clone();
                        let mgr_clone = manager.clone_ref();
                        let broker_clone = broker.clone();
                        let id_clone = conn_id.clone();
                        tokio::spawn(connection_worker_loop(
                            id_clone,
                            db_clone,
                            mgr_clone,
                            broker_clone,
                            worker_rx,
                        ));
                        tx
                    });

                    // Two-phase send: try non-blocking first (the common
                    // case), only `await` when the mailbox is actually full.
                    // Counts queue-full as back-pressure observation rather
                    // than a drop event — nothing is dropped, the dispatcher
                    // just waits for the worker to make room.
                    let send_result = match tx.try_send(envelope_arc) {
                        Ok(()) => Ok(()),
                        Err(mpsc::error::TrySendError::Full(env)) => {
                            metrics
                                .worker_queue_full_count
                                .fetch_add(1, Ordering::Relaxed);
                            tracing::warn!(
                                "[lifecycle][WARN] worker queue full for \
                                 {conn_id}, awaiting drain (back-pressure)"
                            );
                            tx.send(env).await.map_err(|_| ())
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => Err(()),
                    };

                    if send_result.is_err() {
                        // Worker exited unexpectedly (panic). Clean up the
                        // stale entry so the next relevant event respawns.
                        workers.remove(&conn_id);
                        continue;
                    }

                    if is_terminal {
                        // Drop the sender; worker drains the queue then
                        // exits. Releases the per-connection `CachedConn`
                        // (state Arc + emitter) the worker was holding.
                        workers.remove(&conn_id);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(skipped)) => {
                    // Lagged at the bus level. Now that the dispatcher
                    // filters and only blocks on the rare relevant events,
                    // this should only fire under genuine emit-rate spikes
                    // exceeding the 4096 broadcast capacity. The metric is the
                    // authoritative loss record (unthrottled); the log line is
                    // throttled to at most one per window.
                    metrics.lagged_count.fetch_add(skipped, Ordering::Relaxed);
                    // A dropped batch may have contained a blocking prompt, and
                    // a child parked on one emits nothing further — so no later
                    // event is guaranteed to wake the broker's parked status
                    // long-polls, and a `wait_ms: 0` caller would hang for good.
                    // Wake them unconditionally: they re-probe live
                    // `SessionState`, which is written directly and therefore
                    // survives any bus loss. Same "resync from authoritative
                    // state" recovery the pet aggregator does on lag.
                    if let Some(b) = broker.as_ref() {
                        b.note_blocking_changed();
                    }
                    if let Some(s) = lag_throttle.record(skipped) {
                        tracing::warn!(
                            "[lifecycle][WARN] internal bus lagged: dropped {} events across \
                             {} occurrence(s) in the last {}s (emit rate exceeded broadcast capacity)",
                            s.dropped,
                            s.occurrences,
                            LAG_LOG_WINDOW.as_secs()
                        );
                    }
                }
                Err(broadcast::error::RecvError::Closed) => {
                    tracing::info!("[lifecycle] internal bus closed; dispatcher exiting");
                    // Drop all worker senders; workers drain & exit on their own.
                    drop(workers);
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::session_state::SessionState;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::EventEmitter;
    use std::sync::Arc;
    use tokio::sync::{mpsc, RwLock};

    fn fake_connection_with_state(
        id: &str,
        conv_id: Option<i32>,
    ) -> crate::acp::connection::AgentConnection {
        let (tx, _rx) = mpsc::channel(1);
        let mut state = SessionState::new(
            id.to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = conv_id;
        crate::acp::connection::AgentConnection {
            id: id.to_string(),
            agent_type: AgentType::ClaudeCode,
            status: crate::acp::types::ConnectionStatus::Connected,
            owner_window_label: "test-window".to_string(),
            cmd_tx: tx,
            handshake: tokio_util::sync::CancellationToken::new(),
            state: Arc::new(RwLock::new(state)),
            emitter: EventEmitter::Noop,
            prompt_lock: Arc::new(tokio::sync::Mutex::new(())),
            config_fingerprint: String::new(),
            last_observed_fingerprint: String::new(),
            child_pid: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        }
    }

    #[tokio::test]
    async fn handle_event_writes_external_id_when_conversation_bound() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "ext-99".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();
        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.external_id.as_deref(), Some("ext-99"));
    }

    #[tokio::test]
    async fn handle_event_clear_rollover_repoints_external_id_in_place() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-clear-rollover").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        conversation_service::bind_external_id(&db.conn, conv.id, "old-sess", &[])
            .await
            .unwrap();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            let conn = fake_connection_with_state("c1", Some(conv.id));
            conn.state.write().await.external_id = Some("old-sess".into());
            map.insert("c1".to_string(), conn);
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TranscriptRolledOver {
                transcript_id: "new-sess".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();
        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.external_id.as_deref(), Some("new-sess"));

        // A second rollover must also stay in place (ACP id still old-sess).
        let env2 = EventEnvelope {
            seq: 2,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TranscriptRolledOver {
                transcript_id: "newer-sess".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env2, None).await.unwrap();
        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.external_id.as_deref(), Some("newer-sess"));
    }

    #[tokio::test]
    async fn handle_event_session_started_broadcasts_conversation_upsert() {
        // SessionStarted persists external_id; it must ALSO re-broadcast the
        // full summary on `conversation://changed` so every client's sidebar
        // converges (the create-time upsert carried external_id: null).
        use crate::web::event_bridge::{WebEventBroadcaster, CONVERSATION_CHANGED_EVENT};
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-sess-upsert").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            let mut conn = fake_connection_with_state("c1", Some(conv.id));
            conn.emitter = EventEmitter::test_web_only(broadcaster.clone());
            map.insert("c1".to_string(), conn);
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "ext-99".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();

        // external_id persisted on the row...
        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.external_id.as_deref(), Some("ext-99"));

        // ...and a `conversation://changed` upsert carrying it was broadcast.
        let evt = rx
            .try_recv()
            .expect("SessionStarted should broadcast a conversation upsert");
        assert_eq!(evt.channel, CONVERSATION_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["summary"]["id"], conv.id);
        assert_eq!(p["summary"]["external_id"], "ext-99");
    }

    #[tokio::test]
    async fn handle_event_native_session_title_writes_and_upserts() {
        use crate::web::event_bridge::{WebEventBroadcaster, CONVERSATION_CHANGED_EVENT};
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-native-title").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            let mut conn = fake_connection_with_state("c1", Some(conv.id));
            conn.emitter = EventEmitter::test_web_only(broadcaster.clone());
            map.insert("c1".to_string(), conn);
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::NativeSessionTitle {
                title: "  Fix login flow  ".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();

        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.title.as_deref(), Some("Fix login flow"));
        assert!(!reloaded.title_locked);

        let evt = rx
            .try_recv()
            .expect("a written native title should broadcast a conversation upsert");
        assert_eq!(evt.channel, CONVERSATION_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["summary"]["title"], "Fix login flow");
    }

    #[tokio::test]
    async fn handle_event_native_session_title_skips_locked_and_unbound() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-native-title-skip").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        conversation_service::update_title(&db.conn, conv.id, "User pick".into())
            .await
            .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "locked".to_string(),
                fake_connection_with_state("locked", Some(conv.id)),
            );
            map.insert(
                "unbound".to_string(),
                fake_connection_with_state("unbound", None),
            );
        }
        let locked_env = EventEnvelope {
            seq: 1,
            connection_id: "locked".to_string(),
            payload: AcpEvent::NativeSessionTitle {
                title: "agent title".into(),
            },
        };
        handle_event(&db.conn, &mgr, &locked_env, None)
            .await
            .unwrap();
        let unbound_env = EventEnvelope {
            seq: 2,
            connection_id: "unbound".to_string(),
            payload: AcpEvent::NativeSessionTitle {
                title: "should not land anywhere".into(),
            },
        };
        handle_event(&db.conn, &mgr, &unbound_env, None)
            .await
            .unwrap();

        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert_eq!(reloaded.title.as_deref(), Some("User pick"));
        assert!(reloaded.title_locked);
    }

    #[tokio::test]
    async fn handle_event_session_started_skips_soft_deleted_conversation() {
        // A fork emits `SessionStarted{S2}`. If the bound conversation was
        // soft-deleted while its ACP connection stayed live (delete only
        // soft-marks the row; it never disconnects the agent), this late write
        // must be a total no-op: `bind_external_id` is guarded on
        // `deleted_at IS NULL`, so the deleted row keeps its S1 session id and
        // its `updated_at`, and `emit_conversation_upsert` (which re-fetches via
        // `get_by_id`, itself deleted-filtered) broadcasts nothing. This locks
        // the actual residual path end-to-end, not just the shared helper.
        use crate::db::entities::conversation;
        use crate::web::event_bridge::WebEventBroadcaster;
        use sea_orm::EntityTrait;

        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-sess-deleted").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        conversation_service::bind_external_id(&db.conn, conv.id, "session-S1", &[])
            .await
            .unwrap();
        conversation_service::soft_delete(&db.conn, conv.id)
            .await
            .unwrap();
        // Snapshot the row AFTER the delete so we can prove the stale event
        // changes nothing (external_id AND updated_at must be untouched).
        let before = conversation::Entity::find_by_id(conv.id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("soft-deleted row still exists");

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            let mut conn = fake_connection_with_state("c1", Some(conv.id));
            conn.emitter = EventEmitter::test_web_only(broadcaster.clone());
            map.insert("c1".to_string(), conn);
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "session-S2".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();

        // The deleted row is untouched: still deleted, still S1, same updated_at.
        let after = conversation::Entity::find_by_id(conv.id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("row still present");
        assert!(after.deleted_at.is_some(), "row must remain soft-deleted");
        assert_eq!(
            after.external_id.as_deref(),
            Some("session-S1"),
            "a stale SessionStarted must not re-point a soft-deleted row S1 → S2"
        );
        assert_eq!(
            after.updated_at, before.updated_at,
            "a no-op SessionStarted must not bump updated_at on a deleted row"
        );

        // And NO conversation upsert may be broadcast for a deleted row.
        assert!(
            rx.try_recv().is_err(),
            "no conversation upsert should be broadcast when the bound row is deleted"
        );
    }

    #[tokio::test]
    async fn handle_event_is_noop_when_no_conversation_bound() {
        let db = test_helpers::fresh_in_memory_db().await;
        // Seed a sentinel conversation row that should remain untouched.
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-noop").await;
        let sentinel =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c1".to_string(), fake_connection_with_state("c1", None));
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "should-not-write".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();

        // Sentinel row must still have no external_id — dispatcher correctly
        // skipped the write because the connection had no conversation_id.
        let reloaded = conversation_service::get_by_id(&db.conn, sentinel.id)
            .await
            .unwrap();
        assert!(
            reloaded.external_id.is_none(),
            "sentinel row should be untouched"
        );
    }

    /// Helper: read the raw `status` column off the conversation entity
    /// (the `conversation_service::get_by_id` summary type stringifies status,
    /// which loses round-trip parity with the `ConversationStatus` enum).
    async fn read_row_status(
        db: &crate::db::AppDatabase,
        conversation_id: i32,
    ) -> ConversationStatus {
        use crate::db::entities::conversation;
        use sea_orm::EntityTrait;
        conversation::Entity::find_by_id(conversation_id)
            .one(&db.conn)
            .await
            .unwrap()
            .expect("conversation row exists")
            .status
    }

    #[tokio::test]
    async fn handle_event_writes_pending_review_on_turn_complete() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/turn-complete").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        // Sanity precondition: row was created in InProgress (the
        // conversation_service::create default).
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress
        );

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::PendingReview
        );
    }

    /// A turn whose status a CLI run's fallback already wrote is skipped
    /// whole — a late lifecycle write must not overwrite what the user did to
    /// the row after the fallback — while the worker's own retries of the same
    /// envelope keep their claim.
    #[tokio::test]
    async fn handle_event_skips_a_turn_the_cli_fallback_claimed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/turn-claimed").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let mgr = ConnectionManager::new();
        let conn = fake_connection_with_state("c1", Some(conv.id));
        let state = conn.state.clone();
        mgr.connections.lock().await.insert("c1".to_string(), conn);
        let turn = |seq| EventEnvelope {
            seq,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };

        assert!(state
            .write()
            .await
            .claim_turn_status(7, TurnStatusWriter::CliFallback));
        // The fallback wrote, then the user marked the conversation done.
        conversation_service::update_status(&db.conn, conv.id, ConversationStatus::Completed)
            .await
            .unwrap();
        handle_event(&db.conn, &mgr, &turn(7), None).await.unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::Completed,
            "the late lifecycle write was skipped"
        );

        // The next turn is the worker's again, retries included.
        handle_event(&db.conn, &mgr, &turn(9), None).await.unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::PendingReview
        );
        conversation_service::update_status(&db.conn, conv.id, ConversationStatus::InProgress)
            .await
            .unwrap();
        handle_event(&db.conn, &mgr, &turn(9), None).await.unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::PendingReview,
            "a retry of its own envelope still writes"
        );
        assert!(!state
            .write()
            .await
            .claim_turn_status(9, TurnStatusWriter::CliFallback));
    }

    #[tokio::test]
    async fn a_turn_status_the_worker_gives_up_on_is_left_to_the_fallback() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/turn-given-up").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        let mgr = ConnectionManager::new();
        let conn = fake_connection_with_state("c1", Some(conv.id));
        let state = conn.state.clone();
        mgr.connections.lock().await.insert("c1".to_string(), conn);
        let turn = EventEnvelope {
            seq: 4,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };
        // Every attempt fails.
        db.conn.clone().close().await.unwrap();

        handle_event_with_retry(&db.conn, &mgr, &turn, None).await;

        assert!(
            state
                .write()
                .await
                .claim_turn_status(4, TurnStatusWriter::CliFallback),
            "the worker let go of the turn it could not write"
        );
    }

    #[test]
    fn only_the_holder_of_a_turn_can_let_it_go() {
        let mut s = SessionState::new("c".into(), AgentType::ClaudeCode, None, "w".into(), None);
        assert!(s.claim_turn_status(3, TurnStatusWriter::Lifecycle));
        s.release_turn_status(3, TurnStatusWriter::CliFallback);
        s.release_turn_status(2, TurnStatusWriter::Lifecycle);
        assert!(
            !s.claim_turn_status(3, TurnStatusWriter::CliFallback),
            "still held"
        );
        s.release_turn_status(3, TurnStatusWriter::Lifecycle);
        assert!(s.claim_turn_status(3, TurnStatusWriter::CliFallback));
    }

    #[tokio::test]
    async fn handle_event_writes_cancelled_on_turn_failure_stop_reasons() {
        // OpenCode (and similar agents) maps backend errors to `Refusal`.
        // The lifecycle subscriber must flip the conversation to Cancelled
        // for refusal/max_tokens/max_turn_requests/unknown so the user sees
        // a terminal state instead of a misleading PendingReview ("待审查").
        // `auth_required` is synthesized by `run_conversation_loop` when the
        // agent rejects the prompt with ACP's -32000: the CONNECTION survives
        // that one, but the turn did not, so the row must still leave
        // InProgress — nothing else would ever move it.
        let cases = [
            "refusal",
            "max_tokens",
            "max_turn_requests",
            "unknown",
            "empty",
            "auth_required",
        ];
        for stop_reason in cases {
            let db = test_helpers::fresh_in_memory_db().await;
            let folder_id =
                test_helpers::seed_folder(&db, &format!("/tmp/turn-fail-{stop_reason}")).await;
            let conv =
                conversation_service::create(&db.conn, folder_id, AgentType::OpenCode, None, None)
                    .await
                    .unwrap();

            let mgr = ConnectionManager::new();
            {
                let mut map = mgr.connections.lock().await;
                map.insert(
                    "c1".to_string(),
                    fake_connection_with_state("c1", Some(conv.id)),
                );
            }
            let env = EventEnvelope {
                seq: 1,
                connection_id: "c1".to_string(),
                payload: AcpEvent::TurnComplete {
                    session_id: "ext-1".into(),
                    stop_reason: stop_reason.into(),
                    agent_type: "open_code".into(),
                },
            };
            handle_event(&db.conn, &mgr, &env, None).await.unwrap();
            assert_eq!(
                read_row_status(&db, conv.id).await,
                ConversationStatus::Cancelled,
                "stop_reason={stop_reason} must flip the row to Cancelled"
            );
        }
    }

    #[tokio::test]
    async fn handle_event_skips_write_on_cancelled_stop_reason() {
        // `cancelled` is already written by `manager.cancel()` (eager CAS
        // InProgress → Cancelled at the user-cancel entry point), so the
        // TurnComplete arm must not double-write.
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/turn-cancelled").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-1".into(),
                stop_reason: "cancelled".into(),
                agent_type: "claude_code".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress,
            "TurnComplete{{cancelled}} must not overwrite the row — user-cancel path owns it"
        );
    }

    #[tokio::test]
    async fn handle_event_pending_review_is_noop_when_no_conversation_bound() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/no-conv").await;
        // Sentinel row: must remain in its initial status (InProgress) since
        // the connection is unbound and the dispatcher should skip the write.
        let sentinel =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        assert_eq!(sentinel.status, ConversationStatus::InProgress);

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert("c1".to_string(), fake_connection_with_state("c1", None));
        }
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-1".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();
        assert_eq!(
            read_row_status(&db, sentinel.id).await,
            ConversationStatus::InProgress,
            "row must be untouched when no conversation_id is bound to the connection"
        );
    }

    /// Helper: install one cache entry seeded from a manager-registered
    /// connection. Mirrors the runtime path where `try_cache_link` populates
    /// the cache on `ConversationLinked`.
    async fn seed_cache(
        cache: &mut HashMap<String, CachedConn>,
        manager: &ConnectionManager,
        connection_id: &str,
        conversation_id: i32,
    ) {
        try_cache_link(cache, manager, connection_id, conversation_id).await;
    }

    #[tokio::test]
    async fn handle_terminal_event_writes_cancelled_when_in_progress() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/term-cancel").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        // Default-creates as InProgress.
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress
        );

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let mut cache: HashMap<String, CachedConn> = HashMap::new();
        seed_cache(&mut cache, &mgr, "c1", conv.id).await;
        assert!(
            cache.contains_key("c1"),
            "ConversationLinked should populate cache"
        );

        handle_terminal_event(&db.conn, &mut cache, "c1")
            .await
            .unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::Cancelled,
            "in_progress row must be flipped to cancelled"
        );
        assert!(
            !cache.contains_key("c1"),
            "cache entry must be drained after first terminal event"
        );
    }

    #[tokio::test]
    async fn handle_terminal_event_preserves_pending_review() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/term-pr").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        // Simulate a TurnComplete-driven row already at PendingReview.
        conversation_service::update_status(&db.conn, conv.id, ConversationStatus::PendingReview)
            .await
            .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let mut cache: HashMap<String, CachedConn> = HashMap::new();
        seed_cache(&mut cache, &mgr, "c1", conv.id).await;

        handle_terminal_event(&db.conn, &mut cache, "c1")
            .await
            .unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::PendingReview,
            "CAS must not overwrite PendingReview when subscriber sees terminal event \
             after TurnComplete"
        );
    }

    #[tokio::test]
    async fn handle_terminal_event_preserves_user_completed() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/term-completed").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        // User manually marked the conversation completed before the
        // disconnect arrived.
        conversation_service::update_status(&db.conn, conv.id, ConversationStatus::Completed)
            .await
            .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let mut cache: HashMap<String, CachedConn> = HashMap::new();
        seed_cache(&mut cache, &mgr, "c1", conv.id).await;

        handle_terminal_event(&db.conn, &mut cache, "c1")
            .await
            .unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::Completed,
            "user-driven completed must survive the lifecycle terminal-event handler"
        );
    }

    #[test]
    fn format_terminal_error_with_code_prefixes_bracketed_label() {
        // The lifecycle worker stitches `[code] message` together so the
        // parent agent's tool-call result reads with both a stable
        // machine-readable bucket and the human-readable detail.
        assert_eq!(
            format_terminal_error("Authentication required", Some("auth_required")),
            "[auth_required] Authentication required"
        );
    }

    #[test]
    fn format_terminal_error_without_code_returns_trimmed_message() {
        assert_eq!(
            format_terminal_error("  transport closed\n", None),
            "transport closed"
        );
    }

    #[test]
    fn format_terminal_error_treats_blank_code_as_absent() {
        // Defensive: a whitespace-only code shouldn't produce a stray `[]` prefix.
        assert_eq!(
            format_terminal_error("agent crashed", Some("   ")),
            "agent crashed"
        );
    }

    #[tokio::test]
    async fn handle_terminal_event_drains_cache_on_error_then_disconnected() {
        // connection.rs emits `Error` → `Disconnected` on failure. The first
        // event drains the cache so the second is a clean no-op (no extra DB
        // read, no second CAS attempt).
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/term-pair").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        let mut cache: HashMap<String, CachedConn> = HashMap::new();
        seed_cache(&mut cache, &mgr, "c1", conv.id).await;

        // First terminal event: cancels, drains.
        handle_terminal_event(&db.conn, &mut cache, "c1")
            .await
            .unwrap();
        assert!(!cache.contains_key("c1"));
        // Second terminal event: empty cache, returns Ok with no DB writes.
        handle_terminal_event(&db.conn, &mut cache, "c1")
            .await
            .unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::Cancelled
        );
    }

    #[tokio::test]
    async fn handle_terminal_event_noop_when_connection_unknown() {
        // Defensive: a terminal event for a connection that never linked a
        // conversation (cache miss) must not error out or touch any row.
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/term-unknown").await;
        let sentinel =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        assert_eq!(sentinel.status, ConversationStatus::InProgress);

        let mut cache: HashMap<String, CachedConn> = HashMap::new();
        handle_terminal_event(&db.conn, &mut cache, "ghost-connection")
            .await
            .unwrap();
        assert_eq!(
            read_row_status(&db, sentinel.id).await,
            ConversationStatus::InProgress,
            "no conversation should have been touched"
        );
    }

    #[tokio::test]
    async fn handle_event_is_noop_for_unrelated_events() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/test-unrelated").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }
        // ContentDelta should be a no-op even though the connection IS bound.
        let env = EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::ContentDelta { text: "hi".into(), parent_tool_use_id: None },
        };
        handle_event(&db.conn, &mgr, &env, None).await.unwrap();

        let reloaded = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert!(
            reloaded.external_id.is_none(),
            "non-SessionStarted events must not write external_id"
        );
    }

    // ── Dispatcher-level regression coverage ─────────────────────────────
    //
    // These exercise the full `lifecycle_subscriber_task` (bus → filter →
    // dispatcher → per-conn worker → DB) so the integration between the
    // filter predicate and the worker's match arms cannot silently drift.

    use crate::acp::internal_bus::{EventBusMetrics, InternalEventBus};
    use std::time::Duration;

    /// Predicate must accept exactly the event types the worker handles.
    /// If a future worker arm starts caring about a new event type without
    /// updating `is_lifecycle_relevant`, this test catches the drift.
    #[test]
    fn is_lifecycle_relevant_matches_worker_arms() {
        // Accepted (worker has dedicated handling):
        assert!(is_lifecycle_relevant(&AcpEvent::SessionStarted {
            session_id: "s".into(),
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::TurnComplete {
            session_id: "s".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::ConversationLinked {
            conversation_id: 1,
            folder_id: 1,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::NativeSessionTitle {
            title: "Fix login".into(),
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::TranscriptRolledOver {
            transcript_id: "new-sess".into(),
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected,
        }));
        assert!(is_lifecycle_relevant(&AcpEvent::Error {
            message: "boom".into(),
            agent_type: "claude_code".into(),
            code: None,
            details: None,
            terminal: true,
        }));

        // Rejected (worker no-ops on these — must not enter the queue):
        assert!(!is_lifecycle_relevant(&AcpEvent::ContentDelta {
            text: "x".into(),
            parent_tool_use_id: None,
        }));
        assert!(!is_lifecycle_relevant(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Connected,
        }));
        assert!(!is_lifecycle_relevant(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        }));
        // ToolCall / ToolCallUpdate are NO LONGER worker-relevant: delegation
        // tool_call_id capture moved to the dispatcher loop
        // (`register_delegation_tool_call_from_event`), so neither variant
        // needs to enter a worker mailbox. Keeping them out is what relieves
        // the bus-lag pressure that dropped a parallel delegation's tool_call.
        assert!(!is_lifecycle_relevant(&AcpEvent::ToolCall {
            tool_call_id: "tc-1".into(),
            title: "delegate_to_agent".into(),
            kind: "other".into(),
            status: "pending".into(),
            content: None,
            raw_input: None,
            raw_output: None,
            locations: None,
            meta: None,
            images: None,
        }));
        assert!(!is_lifecycle_relevant(&AcpEvent::ToolCallUpdate {
            tool_call_id: "tc-1".into(),
            title: Some("delegate_to_agent".into()),
            status: None,
            content: None,
            raw_input: None,
            raw_output: None,
            raw_output_append: None,
            locations: None,
            meta: None,
            images: None,
        }));
    }

    /// Dispatcher must drop the per-connection worker sender on either
    /// `Disconnected` or a `terminal: true` Error. Non-terminal Errors and
    /// other ConnectionStatus values must NOT trigger teardown — the
    /// worker is still expected to receive a trailing TurnComplete /
    /// Disconnected. (P2 regression in v0.14.3 post-mortem review:
    /// without the `Error { terminal: true }` arm, the worker that
    /// dispatched terminal work in lifecycle_subscriber_task would leak
    /// when the bus drops the trailing Disconnected.)
    #[test]
    fn is_dispatcher_terminal_drops_worker_on_disconnected_and_terminal_error() {
        assert!(is_dispatcher_terminal(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected,
        }));
        assert!(is_dispatcher_terminal(&AcpEvent::Error {
            message: "transport closed".into(),
            agent_type: "claude_code".into(),
            code: None,
            details: None,
            terminal: true,
        }));

        // Non-terminal Error: worker must survive.
        assert!(!is_dispatcher_terminal(&AcpEvent::Error {
            message: "turn refusal".into(),
            agent_type: "claude_code".into(),
            code: Some("turn_failed_refusal".into()),
            details: None,
            terminal: false,
        }));

        // Other StatusChanged values: worker must survive.
        assert!(!is_dispatcher_terminal(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Connected,
        }));
        assert!(!is_dispatcher_terminal(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Prompting,
        }));
        assert!(!is_dispatcher_terminal(&AcpEvent::StatusChanged {
            status: ConnectionStatus::Error,
        }));

        // Other event arms must never trigger teardown.
        assert!(!is_dispatcher_terminal(&AcpEvent::TurnComplete {
            session_id: "s".into(),
            stop_reason: "end_turn".into(),
            agent_type: "claude_code".into(),
        }));
    }

    /// Poll the conversation row's status until it matches `expected` or
    /// the timeout elapses. Used because the dispatcher exits as soon as
    /// the bus closes, but its workers may still be draining queued events
    /// when `dispatcher.await` returns.
    async fn poll_status(
        db: &crate::db::AppDatabase,
        conversation_id: i32,
        expected: ConversationStatus,
        timeout: Duration,
    ) -> ConversationStatus {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let observed = read_row_status(db, conversation_id).await;
            if observed == expected || std::time::Instant::now() >= deadline {
                return observed;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn poll_external_id(
        db: &crate::db::AppDatabase,
        conversation_id: i32,
        expected: &str,
        timeout: Duration,
    ) -> Option<String> {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let observed = conversation_service::get_by_id(&db.conn, conversation_id)
                .await
                .unwrap()
                .external_id;
            if observed.as_deref() == Some(expected) || std::time::Instant::now() >= deadline {
                return observed;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Filter must keep high-frequency events from spawning a worker or
    /// reaching `handle_event_with_retry`. Verified by emitting only
    /// ContentDelta and asserting the conversation row stays untouched.
    #[tokio::test]
    async fn dispatcher_filter_drops_high_frequency_events_at_source() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/disp-filter").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics.clone()));

        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            None,
        ));

        // Subscribe AFTER spawn would race; the bus's broadcast channel
        // requires a receiver to count. The dispatcher subscribes
        // synchronously inside `lifecycle_subscriber_task`, so by the time
        // `tokio::spawn` returns, the receiver IS registered.
        for i in 0..50 {
            bus.send(Arc::new(EventEnvelope {
                seq: i,
                connection_id: "c1".to_string(),
                payload: AcpEvent::ContentDelta {
                    text: format!("delta {i}"),
                    parent_tool_use_id: None,
                },
            }));
        }

        // Close the bus to drain the dispatcher.
        drop(bus);
        let _ = dispatcher.await;
        // Brief settle for any worker that might have spawned.
        tokio::time::sleep(Duration::from_millis(20)).await;

        let row = conversation_service::get_by_id(&db.conn, conv.id)
            .await
            .unwrap();
        assert!(
            row.external_id.is_none(),
            "filter must keep ContentDelta from triggering DB writes"
        );
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress,
            "row must be untouched"
        );
    }

    /// Happy-path through the full dispatcher → worker → DB chain.
    /// SessionStarted writes external_id; TurnComplete{end_turn} flips the
    /// row to PendingReview. Both must land.
    #[tokio::test]
    async fn dispatcher_delivers_session_started_and_turn_complete_to_db() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/disp-happy").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            None,
        ));

        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c1".to_string(),
            payload: AcpEvent::SessionStarted {
                session_id: "ext-final".into(),
            },
        }));
        bus.send(Arc::new(EventEnvelope {
            seq: 2,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-final".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        }));

        let observed_external =
            poll_external_id(&db, conv.id, "ext-final", Duration::from_millis(500)).await;
        let observed_status = poll_status(
            &db,
            conv.id,
            ConversationStatus::PendingReview,
            Duration::from_millis(500),
        )
        .await;

        drop(bus);
        let _ = dispatcher.await;

        assert_eq!(observed_external.as_deref(), Some("ext-final"));
        assert_eq!(observed_status, ConversationStatus::PendingReview);
    }

    /// Burst: emit a long sequence of relevant events followed by a
    /// `TurnComplete{end_turn}`. With the prior `try_send` + drop logic,
    /// any sufficiently-long burst could push the TurnComplete off the
    /// worker mailbox, leaving the row at InProgress. With the blocking
    /// `send().await` fallback the dispatcher waits for the worker to
    /// drain — so the TurnComplete MUST land regardless of burst size.
    ///
    /// The N=200 burst exceeds `WORKER_QUEUE_CAPACITY` (64) so the
    /// dispatcher exercises the `try_send → send.await` fallback path.
    /// Even if SQLite serves writes quickly enough to keep the queue
    /// shallow most of the time, exceeding capacity at any instant
    /// triggers the back-pressure code path that we're regressing on.
    #[tokio::test]
    async fn dispatcher_delivers_turn_complete_after_relevant_event_burst() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/disp-burst").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c1".to_string(),
                fake_connection_with_state("c1", Some(conv.id)),
            );
        }

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            None,
        ));

        // Burst of 200 SessionStarted events (each writes external_id).
        // 200 > WORKER_QUEUE_CAPACITY (64) ensures the back-pressure path
        // is exercised.
        for i in 1..=200u64 {
            bus.send(Arc::new(EventEnvelope {
                seq: i,
                connection_id: "c1".to_string(),
                payload: AcpEvent::SessionStarted {
                    session_id: format!("ext-{i:03}"),
                },
            }));
        }

        // The critical event: TurnComplete that MUST flip the row.
        bus.send(Arc::new(EventEnvelope {
            seq: 201,
            connection_id: "c1".to_string(),
            payload: AcpEvent::TurnComplete {
                session_id: "ext-200".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        }));

        // Wait for the worker to fully drain. The TurnComplete is at the
        // tail of the queue, so observing PendingReview proves nothing
        // before it was dropped.
        //
        // The budget was 2s when each SessionStarted was a single UPDATE. Every
        // id in the burst above is distinct, so under the session-binding guard
        // each one is a re-point away from a live session and costs a
        // transaction plus a preserving INSERT — ~200 of them here. That is
        // pathological by construction: a real connection emits SessionStarted
        // once (plus once per fork, which the guard short-circuits), so this
        // cost never appears in production. The budget is widened rather than
        // the burst weakened, because what this test exists to prove is
        // DELIVERY of the tail event, not the speed of the arms ahead of it.
        let observed = poll_status(
            &db,
            conv.id,
            ConversationStatus::PendingReview,
            Duration::from_secs(30),
        )
        .await;

        drop(bus);
        let _ = dispatcher.await;

        assert_eq!(
            observed,
            ConversationStatus::PendingReview,
            "TurnComplete at the tail of a 200-event burst MUST be delivered \
             (regression test for `try_send` drop bug)"
        );
    }

    // ── Broker-cancel routing regression ─────────────────────────────────
    //
    // The lifecycle worker MUST gate `broker.cancel_by_child_connection`
    // on `terminal == true`. `AcpEvent::Error` also fires mid-turn from
    // `turn_failure_error_event` (refusal / max_tokens / empty / unknown)
    // immediately before `TurnComplete`, while the child connection stays
    // alive. Cancelling at Error there would race-drain the pending
    // broker entry before `complete_call` could map the real stop reason
    // — surfacing "canceled" to the parent agent instead of
    // `ChildRefusal` / `ChildMaxTokens` / …. (See F1 in the v0.14.3
    // sub-agent delegation post-mortem.)
    //
    // On the truly terminal path (`connection.rs:493`) the worker drains
    // the broker on Error directly with the detail, then dedupes the
    // trailing Disconnected. This avoids the "Error reaches us but the
    // bus drops Disconnected" hang where `handle_request`'s `rx.await`
    // would block forever.
    //
    // These tests drive `lifecycle_subscriber_task` end-to-end with a real
    // `DelegationBroker` + `MockSpawner` so the dispatcher → worker →
    // broker chain is exercised the same way it runs in production.

    use crate::acp::delegation::broker::{ConversationDepthLookup, DelegationBroker};
    use crate::acp::delegation::spawner::{mock::MockSpawner, ConnectionSpawner};
    use crate::acp::delegation::types::{DelegationError, DelegationOutcome, DelegationRequest};
    use async_trait::async_trait;

    struct NoopDepthLookup;

    #[async_trait]
    impl ConversationDepthLookup for NoopDepthLookup {
        async fn parent_of(&self, _id: i32) -> Result<Option<i32>, DelegationError> {
            Ok(None)
        }
    }

    fn delegation_request(child_conn_id: &str) -> DelegationRequest {
        DelegationRequest {
            parent_connection_id: format!("parent-of-{child_conn_id}"),
            parent_conversation_id: 1,
            parent_tool_use_id: format!("tu-{child_conn_id}"),
            agent_type: AgentType::ClaudeCode,
            task: "do x".into(),
            working_dir: None,
            requested_working_dir: None,
            external_handle: None,
            assistant: None,
        }
    }

    /// Stage a broker with one pending entry whose `child_connection_id`
    /// matches the test connection. The returned join handle resolves
    /// once the broker drains the entry (via cancel or complete).
    async fn stage_pending_delegation(
        child_conn_id: &str,
        child_conv_id: i32,
    ) -> (
        Arc<DelegationBroker>,
        tokio::task::JoinHandle<DelegationOutcome>,
    ) {
        let mock = Arc::new(MockSpawner::new());
        mock.queue_spawn(Ok(child_conn_id.to_string())).await;
        mock.queue_send(Ok(child_conv_id)).await;
        let broker = Arc::new(DelegationBroker::new(
            mock as Arc<dyn ConnectionSpawner>,
            Arc::new(NoopDepthLookup) as Arc<dyn ConversationDepthLookup>,
        ));
        // Production default is `enabled: false`; lifecycle tests need
        // delegation active so `handle_request` parks the pending entry
        // they're about to assert against.
        broker
            .set_config(crate::acp::delegation::broker::DelegationConfig {
                enabled: true,
                ..crate::acp::delegation::broker::DelegationConfig::default()
            })
            .await;
        let driver = {
            let broker = broker.clone();
            let id = child_conn_id.to_string();
            tokio::spawn(async move { broker.handle_request(delegation_request(&id)).await })
        };
        // Spin until the broker has registered the pending entry so the
        // test doesn't race the spawn/send awaits.
        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while broker.pending_count().await == 0 {
            if std::time::Instant::now() >= deadline {
                panic!("broker never registered pending entry");
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        (broker, driver)
    }

    /// `Error` alone must NOT drain the broker. The pending entry stays
    /// in-flight so an upcoming `TurnComplete` can resolve it via
    /// `complete_call` with the correct child-side error mapping.
    #[tokio::test]
    async fn dispatcher_error_alone_does_not_drain_broker_pending_entry() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broker, driver) = stage_pending_delegation("c-no-drain", 41).await;

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            Some(broker.clone()),
        ));

        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-no-drain".to_string(),
            payload: AcpEvent::Error {
                message: "Gemini refused the prompt.".into(),
                agent_type: "gemini".into(),
                code: Some("turn_failed_refusal".into()),
                details: None,
                // turn-failure Error: non-terminal. Worker MUST no-op (the
                // upcoming TurnComplete maps the outcome via complete_call).
                terminal: false,
            },
        }));

        // Give the worker time to process Error. Without the fix it would
        // call `cancel_by_child_connection` and the pending entry would
        // drop to 0 here.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            broker.pending_count().await,
            1,
            "Error-only event must NOT drain the pending delegation — TurnComplete still needs to map it"
        );

        // Cleanup: send Disconnected so the driver resolves, dispatcher exits.
        bus.send(Arc::new(EventEnvelope {
            seq: 2,
            connection_id: "c-no-drain".to_string(),
            payload: AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        }));
        drop(bus);
        let _ = driver.await;
        let _ = dispatcher.await;
    }

    /// Defense-in-depth: a terminal `Error` alone (no trailing
    /// `Disconnected`) must still drain the broker. In production
    /// `Disconnected` always follows, but the in-process bus is a
    /// `broadcast` channel — a `Lagged` event or a task abort between
    /// emit sites would otherwise leave the broker's `rx.await` blocked
    /// forever and hang the parent's `delegate_to_agent` call. (See P1
    /// in the v0.14.3 post-mortem follow-up review.)
    #[tokio::test]
    async fn dispatcher_terminal_error_alone_drains_broker_with_detail() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broker, driver) = stage_pending_delegation("c-error-alone", 51).await;

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            Some(broker.clone()),
        ));

        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-error-alone".to_string(),
            payload: AcpEvent::Error {
                message: "transport closed".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: true,
            },
        }));
        // Deliberately no Disconnected — simulates the bus dropping it
        // (Lagged) or the run_connection task aborting after Error.

        let outcome = tokio::time::timeout(Duration::from_secs(2), driver)
            .await
            .expect("terminal Error alone must drain the broker (no hang)")
            .unwrap();
        match &outcome {
            DelegationOutcome::Err { code, message, .. } => {
                assert_eq!(code, "canceled");
                assert_eq!(
                    message, "canceled: child session ended without TurnComplete: transport closed",
                    "terminal Error detail must reach the broker without waiting for Disconnected"
                );
            }
            other => panic!("expected Err{{canceled}}, got {other:?}"),
        }

        drop(bus);
        let _ = dispatcher.await;
    }

    /// `Error` → `Disconnected` (the genuinely terminal path emitted by
    /// `connection.rs:488` → 514) must drain the broker AND thread the
    /// Error detail into the canceled reason, so the parent agent's
    /// `delegate_to_agent` tool result reads with the real failure cause
    /// instead of the opaque default. The drain happens on Error; the
    /// trailing Disconnected is a no-op (verified by the absence of a
    /// double-emit elsewhere — `cancel_by_child_connection` is
    /// idempotent).
    #[tokio::test]
    async fn dispatcher_error_then_disconnected_threads_buffered_detail_to_broker() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broker, driver) = stage_pending_delegation("c-auth-fail", 42).await;

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            Some(broker.clone()),
        ));

        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-auth-fail".to_string(),
            payload: AcpEvent::Error {
                message: "Authentication required".into(),
                agent_type: "gemini".into(),
                code: Some("auth_required".into()),
                details: None,
                // Genuinely terminal: matches `connection.rs:493`, the only
                // emit site where the run_connection task is unwinding.
                terminal: true,
            },
        }));
        bus.send(Arc::new(EventEnvelope {
            seq: 2,
            connection_id: "c-auth-fail".to_string(),
            payload: AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        }));

        let outcome = driver.await.unwrap();
        match &outcome {
            DelegationOutcome::Err { code, message, .. } => {
                assert_eq!(code, "canceled");
                assert_eq!(
                    message,
                    "canceled: child session ended without TurnComplete: \
                     [auth_required] Authentication required",
                    "the buffered Error detail must be stitched into the canceled reason"
                );
            }
            other => panic!("expected Err{{canceled}}, got {other:?}"),
        }

        drop(bus);
        let _ = dispatcher.await;
    }

    /// Bare `Disconnected` (no preceding Error — e.g. clean transport close
    /// with a delegation still in flight) must still drain the broker,
    /// but with the default fallback reason since there's nothing buffered.
    #[tokio::test]
    async fn dispatcher_disconnected_alone_drains_broker_with_default_reason() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broker, driver) = stage_pending_delegation("c-bare-disco", 43).await;

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            Some(broker.clone()),
        ));

        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-bare-disco".to_string(),
            payload: AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        }));

        let outcome = driver.await.unwrap();
        match &outcome {
            DelegationOutcome::Err { code, message, .. } => {
                assert_eq!(code, "canceled");
                assert_eq!(
                    message,
                    "canceled: child session ended without TurnComplete"
                );
            }
            other => panic!("expected Err{{canceled}}, got {other:?}"),
        }

        drop(bus);
        let _ = dispatcher.await;
    }

    /// F2 regression: a non-terminal `Error` (e.g. `session/load` fallback,
    /// `turn_failure_error_event`, idle SetMode failure) must NOT pollute
    /// `last_error`. If it did, an unrelated future `Disconnected` would
    /// stitch a stale detail into the broker's canceled reason. The fix
    /// gates the buffer on `terminal == true` — only the run_connection
    /// failure path qualifies. (Without this fix, the assertion below sees
    /// `…: [session_load_failed] Failed to load session…` instead of the
    /// default.)
    #[tokio::test]
    async fn dispatcher_non_terminal_error_does_not_pollute_disconnected_drain_reason() {
        let db = test_helpers::fresh_in_memory_db().await;
        let mgr = ConnectionManager::new();
        let (broker, driver) = stage_pending_delegation("c-nonterm", 44).await;

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            Some(broker.clone()),
        ));

        // A non-terminal Error fires first (e.g. recoverable session/load
        // fallback during child setup). The worker MUST ignore it.
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-nonterm".to_string(),
            payload: AcpEvent::Error {
                message: "Failed to load session, starting new: stale id".into(),
                agent_type: "gemini".into(),
                code: None,
                details: None,
                terminal: false,
            },
        }));
        // Then a later, unrelated Disconnected (e.g. the parent disconnects).
        bus.send(Arc::new(EventEnvelope {
            seq: 2,
            connection_id: "c-nonterm".to_string(),
            payload: AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        }));

        let outcome = driver.await.unwrap();
        match &outcome {
            DelegationOutcome::Err { code, message, .. } => {
                assert_eq!(code, "canceled");
                assert_eq!(
                    message, "canceled: child session ended without TurnComplete",
                    "non-terminal Error must NOT be buffered into the broker's cancel reason"
                );
            }
            other => panic!("expected Err{{canceled}}, got {other:?}"),
        }

        drop(bus);
        let _ = dispatcher.await;
    }

    /// F2 row-state regression: a non-terminal `Error` while the
    /// conversation is mid-prompt (status = InProgress) must NOT flip the
    /// row to Cancelled — that would briefly flash "Cancelled" in the
    /// sidebar before the next TurnComplete corrects it. The worker only
    /// runs `handle_terminal_event` when `terminal == true`.
    #[tokio::test]
    async fn dispatcher_non_terminal_error_does_not_flip_conversation_row() {
        let db = test_helpers::fresh_in_memory_db().await;
        let folder_id = test_helpers::seed_folder(&db, "/tmp/f2-row-noflip").await;
        let conv =
            conversation_service::create(&db.conn, folder_id, AgentType::ClaudeCode, None, None)
                .await
                .unwrap();
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress
        );

        let mgr = ConnectionManager::new();
        {
            let mut map = mgr.connections.lock().await;
            map.insert(
                "c-row".to_string(),
                fake_connection_with_state("c-row", Some(conv.id)),
            );
        }

        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        let dispatcher = tokio::spawn(lifecycle_subscriber_task(
            db.conn.clone(),
            mgr.clone_ref(),
            bus.clone(),
            None,
        ));

        // ConversationLinked first so the cache binds (matches production:
        // try_cache_link runs before any terminal event).
        bus.send(Arc::new(EventEnvelope {
            seq: 1,
            connection_id: "c-row".to_string(),
            payload: AcpEvent::ConversationLinked {
                conversation_id: conv.id,
                folder_id,
                parent_conversation_id: None,
                parent_tool_use_id: None,
            },
        }));
        bus.send(Arc::new(EventEnvelope {
            seq: 2,
            connection_id: "c-row".to_string(),
            payload: AcpEvent::Error {
                message: "Failed to set mode: bad id".into(),
                agent_type: "claude_code".into(),
                code: None,
                details: None,
                terminal: false,
            },
        }));

        // Give the worker time to (NOT) process the row flip.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            read_row_status(&db, conv.id).await,
            ConversationStatus::InProgress,
            "non-terminal Error must leave the row's InProgress status intact"
        );

        drop(bus);
        let _ = dispatcher.await;
    }
}
