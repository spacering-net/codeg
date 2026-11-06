//! The personal agent: one long-lived assistant per data dir that the owner
//! talks to on its own page.
//!
//! - It runs on an agent the owner configures ("the brain"), in a fixed
//!   working directory holding its persona, rules and memory.
//! - Underneath, it is a sequence of agent sessions ("segments") strung on one
//!   timeline. A new segment starts only when the owner switches the brain,
//!   moves the working directory or asks for a new session, when a session
//!   cannot be resumed, or — as an error fallback — when the context
//!   overflowed and compaction could not bring it back. Context that merely
//!   fills up is compacted in place: before a delivery, at or above the
//!   configured threshold, codeg sends the agent's compact command, the way
//!   the kanban does before a resumed task round.
//! - It hands work only to the role assistants of 协作 → 助手, as a kanban
//!   task, a chat conversation, or a work conversation in a project's
//!   checkout. That work is owned by the runtime, not by its session, so a
//!   segment switch never touches it; progress comes back as events.
//! - codeg keeps only the interaction (owner messages, reply text, questions
//!   and answers, permission choices, dispatch and result cards), the states,
//!   and pointers to the underlying sessions and tasks.
//!
//! The engine runs in the process that holds the work-task engine, next to
//! it; any other process on the same data dir sees the page read-only.

pub mod cards;
pub mod compaction;
pub mod dispatch;
pub mod engine;
pub mod templates;
pub mod tools;
pub mod workdir;

#[cfg(test)]
mod tests;

pub use engine::{engine, PersonalAgentEngine};

/// Owner label of the personal agent's own connection.
pub const OWNER_LABEL: &str = "personal_agent";
/// Owner label of the conversations it dispatches.
pub const DISPATCH_OWNER_LABEL: &str = "personal_agent_dispatch";

/// Whether a connection with this owner label is driven by the personal
/// agent's engine (its own, or one it dispatched).
pub fn is_personal_agent_owner(owner_window_label: &str) -> bool {
    owner_window_label == OWNER_LABEL || owner_window_label == DISPATCH_OWNER_LABEL
}

/// The owner sent a prompt from a codeg window (desktop or web) on this
/// connection or conversation. When it is one the personal agent dispatched,
/// the dispatch is handed over: the agent stops writing into it. Called from
/// the UI's send entry points only — never from the engines', which also send
/// "from no delegation" — so text, image-only and steering input all count,
/// and nothing else does.
pub fn note_owner_prompt(connection_id: &str, conversation_id: Option<i32>) {
    let Some(engine) = engine() else {
        return;
    };
    let connection_id = connection_id.to_string();
    tokio::spawn(async move {
        engine.handover(&connection_id, conversation_id).await;
    });
}
