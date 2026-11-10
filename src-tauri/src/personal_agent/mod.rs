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
//! - It hands work only to the executor configs (the assistants page →
//!   Settings → Team), as a kanban task, a chat conversation, or a work
//!   conversation in a project's checkout. That work is owned by the runtime, not by its session, so a
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
pub mod host;
pub mod ledger;
pub mod messages;
pub mod notices;
pub mod prefs;
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
    let Some(host) = host::host() else {
        return;
    };
    let connection_id = connection_id.to_string();
    tokio::spawn(async move {
        // Whichever assistant dispatched it hands it over; the others find
        // nothing of theirs.
        for engine in host.engines().await {
            engine.handover(&connection_id, conversation_id).await;
        }
    });
}

/// The brain on `connection_id` is about to ask the owner something and
/// named the input it asks for (`for` on `ask_user_question`, 4.11). Kept
/// until its question is recorded; every ask replaces it, named or not.
/// Nothing for a connection that is no assistant's.
pub async fn note_ask_for(connection_id: &str, for_input: Option<String>) {
    let Some(host) = host::host() else {
        return;
    };
    if let Some(engine) = host.engine_by_connection(connection_id).await {
        engine.note_ask_for(connection_id, for_input).await;
    }
}
