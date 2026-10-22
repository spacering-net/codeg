//! Background task that maintains the pet panel's live active-session list.
//!
//! Separate from [`crate::pet_state_mapper`] (which owns the ambient
//! `pet://state` animation): this task rebuilds the full `PetSessionsPayload`
//! — running / waiting / error counts plus the per-session rows with
//! conversation titles and any pending permission — and emits it on
//! `pet://sessions` whenever the payload changes. The sprite-window badge reads
//! the counts; the panel window renders the list and drives approve/reject.
//!
//! Desktop-only: spawned from the Tauri `setup` block. Server mode has no pet
//! window/panel, so it pays neither the subscription nor the per-event DB
//! join; the `pet_list_active_sessions` HTTP handler still answers on demand.
//!
//! Dual-source, mirroring the ambient mapper: ACP lifecycle envelopes arrive
//! on the typed [`InternalEventBus`]; conversation upsert/delete (title and
//! membership changes) arrive on the JSON [`WebEventBroadcaster`]. Status flips
//! are handled on the ACP side only, so the broadcaster arm ignores the
//! `status` kind to avoid a redundant rebuild.

use std::future::Future;
use std::sync::Arc;

use sea_orm::DatabaseConnection;
use tokio::sync::broadcast;

use crate::acp::manager::ConnectionManager;
use crate::acp::types::AcpEvent;
use crate::acp::InternalEventBus;
use crate::commands::pet::pet_list_active_sessions_core;
use crate::web::event_bridge::{
    emit_event, EventEmitter, WebEvent, WebEventBroadcaster, CONVERSATION_CHANGED_EVENT,
};

/// Channel the aggregated active-session payload is published on.
pub const PET_SESSIONS_EVENT: &str = "pet://sessions";

/// ACP events that can change the active-session set (membership, status, or a
/// pending permission). High-volume content/tool/thinking deltas are ignored
/// so the aggregator only wakes on lifecycle transitions.
fn is_sessions_relevant(payload: &AcpEvent) -> bool {
    matches!(
        payload,
        AcpEvent::StatusChanged { .. }
            | AcpEvent::Error { .. }
            | AcpEvent::PermissionRequest { .. }
            | AcpEvent::PermissionResolved { .. }
            | AcpEvent::TurnComplete { .. }
            | AcpEvent::ConversationLinked { .. }
            | AcpEvent::ConversationStatusChanged { .. }
    )
}

/// Rebuild the payload from authoritative manager + DB state and emit it on
/// `pet://sessions`, but only when the serialized payload actually changes —
/// so a burst of status flips that nets out to the same list stays quiet.
async fn rebuild_and_emit(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
    emitter: &EventEmitter,
    last_json: &mut Option<String>,
) {
    let payload = match pet_list_active_sessions_core(manager, db).await {
        Ok(p) => p,
        Err(err) => {
            tracing::error!("[Pet] failed to build active-session payload: {err}");
            return;
        }
    };
    let json = match serde_json::to_string(&payload) {
        Ok(j) => j,
        Err(err) => {
            tracing::error!("[Pet] failed to serialize active-session payload: {err}");
            return;
        }
    };
    if last_json.as_deref() == Some(json.as_str()) {
        return;
    }
    *last_json = Some(json);
    emit_event(emitter, PET_SESSIONS_EVENT, &payload);
}

/// Spawn-friendly subscriber loop. Mirrors the ambient mapper's "subscribe
/// synchronously, return future" shape so each broadcast buffer covers the gap
/// between `subscribe()` and the first `recv()`.
pub fn pet_sessions_subscriber_task(
    bus: Arc<InternalEventBus>,
    broadcaster: Arc<WebEventBroadcaster>,
    emitter: EventEmitter,
    manager: ConnectionManager,
    db: DatabaseConnection,
) -> impl Future<Output = ()> + Send + 'static {
    let mut acp_rx = bus.subscribe();
    let mut web_rx = broadcaster.subscribe();
    async move {
        let mut last_json: Option<String> = None;
        // Seed with the current snapshot so a panel that opens before the next
        // event still receives a list.
        rebuild_and_emit(&manager, &db, &emitter, &mut last_json).await;

        loop {
            tokio::select! {
                acp = acp_rx.recv() => match acp {
                    Ok(envelope) => {
                        if is_sessions_relevant(&envelope.payload) {
                            rebuild_and_emit(&manager, &db, &emitter, &mut last_json).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Missed events — the live manager state is still
                        // authoritative, so a fresh rebuild resyncs the list.
                        rebuild_and_emit(&manager, &db, &emitter, &mut last_json).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                web = web_rx.recv() => match web {
                    Ok(WebEvent { channel, payload }) => {
                        if channel == CONVERSATION_CHANGED_EVENT {
                            // Status flips are already covered by the ACP arm;
                            // only upsert (title/new) and deleted change what
                            // this aggregator would render.
                            let kind = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("");
                            if kind != "status" {
                                rebuild_and_emit(&manager, &db, &emitter, &mut last_json).await;
                            }
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // Missed conversation upsert/delete notifications could
                        // leave titles/membership stale; resync from
                        // authoritative state, mirroring the ACP arm.
                        rebuild_and_emit(&manager, &db, &emitter, &mut last_json).await;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::ConnectionStatus;

    #[test]
    fn relevant_filter_accepts_lifecycle_events() {
        let accepted = [
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Prompting,
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
                option_id: None,
                origin: None,
            },
            AcpEvent::TurnComplete {
                session_id: "s".into(),
                stop_reason: "end_turn".into(),
                agent_type: "claude_code".into(),
            },
        ];
        for ev in &accepted {
            assert!(is_sessions_relevant(ev), "expected {ev:?} to be relevant");
        }
    }

    #[test]
    fn relevant_filter_ignores_high_volume_events() {
        let ignored = [
            AcpEvent::ContentDelta { text: "x".into(), parent_tool_use_id: None },
            AcpEvent::Thinking { text: "x".into(), parent_tool_use_id: None },
            AcpEvent::UsageUpdate { used: 1, size: 1 },
        ];
        for ev in &ignored {
            assert!(!is_sessions_relevant(ev), "expected {ev:?} to be ignored");
        }
    }
}
