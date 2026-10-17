//! `DelegationEventEmitter` — broker capability for surfacing
//! `AcpEvent::DelegationStarted` / `DelegationCompleted` to the parent's
//! event stream.
//!
//! Parallel to [`crate::acp::delegation::meta_writer::DelegationMetaWriter`]:
//! both abstract over the broker's access to the parent connection's
//! `(state, emitter)` pair so the broker can be unit-tested without spinning
//! up a `ConnectionManager`. Together they form the broker's two-output
//! capability surface — meta writes patch the persisted `ToolCallState`,
//! event emits drive the live frontend `DelegationContext`.
//!
//! The broker calls `emit_started` once from the start path — right after the
//! child is spawned and its first prompt is in flight — and `emit_completed`
//! from every terminal path:
//!
//! 1. `complete_call` — happy path (kind=ok) and error completions
//!    (kind=err) propagated by the listener/lifecycle.
//! 2. `cancel_by_external_handle` — MCP `notifications/cancelled`
//!    routed from the companion drains the pending entry; emits
//!    `Err{error_code: "canceled"}`.
//! 3. `handle_request` completion-channel-dropped — emits `Err{error_code: "canceled"}`.
//! 4. `cancel_by_child_connection` — emits `Err{error_code: "canceled"}` for
//!    every drained pending entry whose child matches.
//! 5. `cancel_by_parent` — emits `Err{error_code: "canceled"}` for every
//!    drained pending entry whose parent matches.
//!
//! Emits are skipped when the broker is operating on a synthetic
//! `parent_tool_use_id` (the `"delegation-*"` UUID fallback) because no
//! `tool_call_id`-keyed UI exists to receive them — same guard as the meta
//! writer. The frontend's snapshot path will still recover state from the
//! broker's meta write.

use async_trait::async_trait;
use std::sync::Arc;

use crate::acp::delegation::types::AssistantRef;
use crate::acp::manager::ConnectionManager;
use crate::acp::types::{AcpEvent, DelegationResultSummary};
use crate::models::AgentType;
use crate::web::event_bridge::emit_with_state;

/// Capability the broker uses to publish `AcpEvent::DelegationCompleted`
/// against the parent connection's event stream.
///
/// Errors are swallowed at the impl boundary — same rationale as
/// `DelegationMetaWriter`. The broker must finish its pending-table
/// cleanup regardless of whether the parent connection is still around to
/// observe the event.
#[async_trait]
pub trait DelegationEventEmitter: Send + Sync {
    /// Publish `AcpEvent::DelegationStarted` on the parent's stream once the
    /// child is spawned and its prompt is in flight. Mirrors `emit_completed`
    /// so both lifecycle ends ride the same parent-stream fanout — the frontend
    /// `DelegationContext` then receives both via the parent's per-connection
    /// attach stream in web/server mode, not only via the desktop firehose.
    /// `task_preview` / `task_id` ride the event so the frontend binding can
    /// label the card (task text + correlation id) even when the parent tool
    /// call's `raw_input` never carries the arguments (Cursor's identity-less
    /// MCP announcements).
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        task_preview: &str,
        task_id: &str,
    );

    #[allow(clippy::too_many_arguments)]
    async fn emit_completed(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        result: DelegationResultSummary,
    );
}

/// Default emitter used when the broker is constructed via the short-form
/// `DelegationBroker::new`. Silently drops every emit — most broker tests
/// observe behavior via outcomes + pending accounting + meta writes, not
/// event fanout. Tests that DO assert on the event lifecycle wire
/// `MockEventEmitter` via `with_writers`.
#[derive(Default, Clone)]
pub struct NoopEventEmitter;

#[async_trait]
impl DelegationEventEmitter for NoopEventEmitter {
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        _parent_connection_id: &str,
        _parent_tool_use_id: &str,
        _child_connection_id: &str,
        _child_conversation_id: i32,
        _agent_type: AgentType,
        _assistant: Option<&AssistantRef>,
        _task_preview: &str,
        _task_id: &str,
    ) {
    }

    async fn emit_completed(
        &self,
        _parent_connection_id: &str,
        _parent_tool_use_id: &str,
        _child_connection_id: &str,
        _child_conversation_id: i32,
        _agent_type: AgentType,
        _assistant: Option<&AssistantRef>,
        _result: DelegationResultSummary,
    ) {
    }
}

/// Production impl backed by `ConnectionManager`. Resolves the parent
/// connection's `(state, emitter)` and routes the `DelegationCompleted`
/// event through `emit_with_state` so it lands on the same fanout path
/// as every other ACP event from that connection.
///
/// A missing parent connection (user disconnected mid-delegation, parent
/// already torn down by another path) becomes a silent no-op — the broker
/// still needs to drain its pending table even when no one is listening.
#[derive(Clone)]
pub struct ConnectionManagerEventEmitter {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait]
impl DelegationEventEmitter for ConnectionManagerEventEmitter {
    #[allow(clippy::too_many_arguments)]
    async fn emit_started(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        task_preview: &str,
        task_id: &str,
    ) {
        let Some((state_arc, emitter)) = self
            .manager
            .get_state_and_emitter(parent_connection_id)
            .await
        else {
            return;
        };
        emit_with_state(
            &state_arc,
            &emitter,
            AcpEvent::DelegationStarted {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                task_preview: task_preview.to_string(),
                task_id: task_id.to_string(),
                assistant_id: assistant.map(|a| a.id),
                assistant_name: assistant.map(|a| a.name.clone()),
            },
        )
        .await;
    }

    async fn emit_completed(
        &self,
        parent_connection_id: &str,
        parent_tool_use_id: &str,
        child_connection_id: &str,
        child_conversation_id: i32,
        agent_type: AgentType,
        assistant: Option<&AssistantRef>,
        result: DelegationResultSummary,
    ) {
        let Some((state_arc, emitter)) = self
            .manager
            .get_state_and_emitter(parent_connection_id)
            .await
        else {
            return;
        };
        emit_with_state(
            &state_arc,
            &emitter,
            AcpEvent::DelegationCompleted {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                result,
                assistant_id: assistant.map(|a| a.id),
                assistant_name: assistant.map(|a| a.name.clone()),
            },
        )
        .await;
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub mod mock {
    use super::*;
    use tokio::sync::Mutex;

    /// Records every emit so broker tests can assert the event lifecycle
    /// (one emit per drained pending entry, never doubled, correct
    /// `result_summary` per terminal path). No-op on the publishing side —
    /// the broker is the unit under test, not the event fanout.
    #[derive(Default)]
    pub struct MockEventEmitter {
        pub calls: Mutex<Vec<EmitCall>>,
        pub started_calls: Mutex<Vec<EmitStartedCall>>,
    }

    #[derive(Debug, Clone)]
    pub struct EmitCall {
        pub parent_connection_id: String,
        pub parent_tool_use_id: String,
        pub child_connection_id: String,
        pub child_conversation_id: i32,
        pub agent_type: AgentType,
        pub assistant: Option<AssistantRef>,
        pub result: DelegationResultSummary,
    }

    #[derive(Debug, Clone)]
    pub struct EmitStartedCall {
        pub parent_connection_id: String,
        pub parent_tool_use_id: String,
        pub child_connection_id: String,
        pub child_conversation_id: i32,
        pub agent_type: AgentType,
        pub assistant: Option<AssistantRef>,
        pub task_preview: String,
        pub task_id: String,
    }

    impl MockEventEmitter {
        pub fn new() -> Self {
            Self::default()
        }

        pub async fn snapshot(&self) -> Vec<EmitCall> {
            self.calls.lock().await.clone()
        }

        pub async fn count(&self) -> usize {
            self.calls.lock().await.len()
        }

        pub async fn started_snapshot(&self) -> Vec<EmitStartedCall> {
            self.started_calls.lock().await.clone()
        }

        pub async fn started_count(&self) -> usize {
            self.started_calls.lock().await.len()
        }
    }

    #[async_trait]
    impl DelegationEventEmitter for MockEventEmitter {
        #[allow(clippy::too_many_arguments)]
        async fn emit_started(
            &self,
            parent_connection_id: &str,
            parent_tool_use_id: &str,
            child_connection_id: &str,
            child_conversation_id: i32,
            agent_type: AgentType,
            assistant: Option<&AssistantRef>,
            task_preview: &str,
            task_id: &str,
        ) {
            self.started_calls.lock().await.push(EmitStartedCall {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                assistant: assistant.cloned(),
                task_preview: task_preview.to_string(),
                task_id: task_id.to_string(),
            });
        }

        async fn emit_completed(
            &self,
            parent_connection_id: &str,
            parent_tool_use_id: &str,
            child_connection_id: &str,
            child_conversation_id: i32,
            agent_type: AgentType,
            assistant: Option<&AssistantRef>,
            result: DelegationResultSummary,
        ) {
            self.calls.lock().await.push(EmitCall {
                parent_connection_id: parent_connection_id.to_string(),
                parent_tool_use_id: parent_tool_use_id.to_string(),
                child_connection_id: child_connection_id.to_string(),
                child_conversation_id,
                agent_type,
                assistant: assistant.cloned(),
                result,
            });
        }
    }
}
