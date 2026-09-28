pub mod agent_mentions;
pub mod agent_process;
pub mod agent_session;
pub mod antigravity_login;
pub mod background_watch;
pub mod binary_cache;
pub mod browser_tools;
pub mod chat_authoring;
pub mod codex_catalog_source;
pub mod codex_goal;
pub mod codex_model_catalog;
pub mod connection;
pub mod cursor_acp_retry_compat;
pub mod cursor_ext;
pub mod custom_registry;
pub mod delegation;
pub mod error;
pub mod event_stream;
pub mod feedback;
pub mod file_system_runtime;
pub mod fork;
pub mod host_tools_policy;
pub mod idle_sweep;
pub mod internal_bus;
pub mod lifecycle;
pub mod manager;
pub mod opencode_catalog;
pub mod opencode_plugins;
pub mod plan_approval;
pub mod preflight;
pub mod prompt_hydration;
pub mod question;
pub mod registry;
pub mod remote_registry;
pub mod scratch_dir;
pub mod session_info;
pub mod session_title;
pub mod session_state;
pub mod stderr_tail;
pub mod temp_reclaim;
pub mod terminal_runtime;
pub mod types;
pub mod work_task_tools;

pub use idle_sweep::{idle_sweep_task, idle_timeout_from_env, SWEEP_INTERVAL_SECS};
pub use internal_bus::{EventBusMetrics, EventBusMetricsSnapshot, InternalEventBus};
pub use lifecycle::lifecycle_subscriber_task;
pub use session_state::{LiveSessionSnapshot, SessionState};
// Re-export the inner types of LiveSessionSnapshot for downstream consumers; not all are
// directly named in Rust today (they ride along through the snapshot struct), so silence
// dead-import warnings rather than dropping them.
#[allow(unused_imports)]
pub use session_state::{
    LiveContentBlock, LiveMessage, PendingPermissionState, ToolCallOutput, ToolCallState,
    ToolCallStatus, ToolKind, UsageInfo,
};
pub use types::{
    user_blocks_from_prompt, AcpEvent, ConversationConnectionInfo, EventEnvelope, UserMessageBlock,
};

/// The session ids `session_id` carries forward — i.e. earlier sessions of the
/// SAME conversation, whose turns remain readable through `session_id`.
///
/// Feed this to [`crate::db::service::conversation_service::bind_external_id`]
/// so it can tell "this conversation continues under a new agent session" from
/// "an unrelated session landed on this row". The first is routine: when a
/// custom agent has forgotten a session, codeg opens a fresh one and links the
/// transcripts, and both the reader and the generic parser then treat the chain
/// as one conversation. Splitting there would clone the conversation in the
/// sidebar on every restart. The second is codeg#500, where the split is the
/// whole point.
///
/// Empty — and free — for every built-in agent: their history lives in the
/// agent's own store, codeg records no transcript, and so nothing can ever be
/// carried forward. Only custom agents can produce a non-empty answer.
pub fn continued_session_ids(agent_type: crate::models::AgentType, session_id: &str) -> Vec<String> {
    if agent_type.custom_id().is_none() {
        return Vec::new();
    }
    crate::acp_transcript::continuation_ancestors(registry::registry_id_for(agent_type), session_id)
}
