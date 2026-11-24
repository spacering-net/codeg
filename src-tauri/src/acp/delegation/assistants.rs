//! Assistants as the delegation layer sees them: resolving the one a
//! `delegate_to_agent` call names, and the roster the companion lists in the
//! tool's schema.
//!
//! Resolved per call, never frozen at launch: an assistant created or renamed
//! while a session is open is usable from that session at once. The roster in
//! the tool description is only a hint for the delegating agent; a call by id
//! does not depend on it.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::acp::delegation::types::DelegationAssistant;
use crate::db::service::assistant_service;
use crate::db::AppDatabase;
use crate::models::{AgentType, AssistantInfo};

/// The broker's view of the assistants table. A trait so the broker and the
/// listener can be tested without a database.
#[async_trait]
pub trait AssistantLookup: Send + Sync {
    /// The assistant `id` names, if a delegation may run as it right now:
    /// it exists, is not deleted, and is enabled.
    async fn delegatable(&self, id: i32) -> Option<AssistantInfo>;

    /// Every assistant a delegation may run as right now, in display order.
    async fn roster(&self) -> Vec<AssistantInfo>;
}

/// No assistants at all — the default for brokers built without a database.
#[derive(Default, Clone)]
pub struct NoAssistants;

#[async_trait]
impl AssistantLookup for NoAssistants {
    async fn delegatable(&self, _id: i32) -> Option<AssistantInfo> {
        None
    }

    async fn roster(&self) -> Vec<AssistantInfo> {
        Vec::new()
    }
}

/// [`AssistantLookup`] over the live database.
pub struct DbAssistantLookup {
    pub db: Arc<AppDatabase>,
}

#[async_trait]
impl AssistantLookup for DbAssistantLookup {
    async fn delegatable(&self, id: i32) -> Option<AssistantInfo> {
        match assistant_service::get_live_enabled(&self.db.conn, id).await {
            Ok(found) => found,
            Err(e) => {
                tracing::warn!("[delegation] assistant {id} lookup failed: {e}");
                None
            }
        }
    }

    async fn roster(&self) -> Vec<AssistantInfo> {
        match assistant_service::list_live_enabled(&self.db.conn).await {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("[delegation] assistant roster lookup failed: {e}");
                Vec::new()
            }
        }
    }
}

impl From<AssistantInfo> for DelegationAssistant {
    fn from(a: AssistantInfo) -> Self {
        DelegationAssistant {
            id: a.id,
            name: a.name,
            agent_options: a.agent_options,
            instructions: a.instructions,
        }
    }
}

/// One roster line as it crosses the companion socket (`ListAssistants`).
/// Carries what the delegating agent needs to pick an assistant — nothing of
/// its options or instructions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRosterEntry {
    pub id: i32,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub agent_type: AgentType,
}

impl From<&AssistantInfo> for AssistantRosterEntry {
    fn from(a: &AssistantInfo) -> Self {
        AssistantRosterEntry {
            id: a.id,
            name: a.name.clone(),
            description: a.description.clone(),
            agent_type: a.agent_type,
        }
    }
}

/// Longest description quoted per roster line in the tool schema, in
/// characters: the list rides every session's tool description.
pub const ROSTER_DESCRIPTION_CAP: usize = 160;

fn capped(text: &str, cap: usize) -> String {
    let mut out: String = text.chars().take(cap).collect();
    if text.chars().count() > cap {
        out.push('…');
    }
    out
}

/// `3: Reviewer [Codex CLI] — reviews diffs` — one roster line, as both the
/// schema roster and the not-found refusal quote it.
fn roster_line(entry: &AssistantRosterEntry, with_description: bool) -> String {
    let mut line = format!("{}: {} [{}]", entry.id, entry.name, entry.agent_type);
    let description = entry.description.trim();
    if with_description && !description.is_empty() {
        line.push_str(" — ");
        line.push_str(&capped(description, ROSTER_DESCRIPTION_CAP));
    }
    line
}

/// The sentence appended to `assistant_id`'s schema description: who could be
/// delegated to when the session started. A hint only — see the module docs.
pub fn roster_for_schema(roster: &[AssistantRosterEntry]) -> String {
    if roster.is_empty() {
        return " No assistants were configured when this session started; use this only \
                with an id taken from a `codeg://assistant/<number>` link in the user's message."
            .to_string();
    }
    let lines: Vec<String> = roster.iter().map(|e| roster_line(e, true)).collect();
    format!(
        " Assistants configured when this session started (id: name [agent] — when to use): {}. \
         An assistant created later can still be used by its id.",
        lines.join("; ")
    )
}

/// The refusal a call naming an unusable assistant gets. It names the
/// assistants that ARE usable and tells the agent not to fall back to an agent
/// of its choosing: that would drop the assistant's options and instructions
/// without the user ever knowing.
pub fn assistant_not_found_message(asked: &str, roster: &[AssistantRosterEntry]) -> String {
    let available = if roster.is_empty() {
        "There are no usable assistants right now.".to_string()
    } else {
        let lines: Vec<String> = roster.iter().map(|e| roster_line(e, false)).collect();
        format!("Usable assistants: {}.", lines.join("; "))
    };
    format!(
        "No usable assistant {asked}: it does not exist, was deleted, or is disabled. \
         {available} Do not delegate this to another agent instead — tell the user."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i32, name: &str, description: &str) -> AssistantRosterEntry {
        AssistantRosterEntry {
            id,
            name: name.to_string(),
            description: description.to_string(),
            agent_type: AgentType::Codex,
        }
    }

    #[test]
    fn the_schema_roster_lists_each_assistant_with_a_capped_description() {
        let long = "x".repeat(ROSTER_DESCRIPTION_CAP + 20);
        let text = roster_for_schema(&[
            entry(3, "Reviewer", "Reviews diffs"),
            entry(5, "Writer", &long),
        ]);
        assert!(text.contains("3: Reviewer [Codex CLI] — Reviews diffs; 5: Writer [Codex CLI] — "));
        assert!(text.contains(&format!("{}…", "x".repeat(ROSTER_DESCRIPTION_CAP))));
        assert!(!text.contains(&"x".repeat(ROSTER_DESCRIPTION_CAP + 1)));
        assert!(text.ends_with("An assistant created later can still be used by its id."));

        let empty = roster_for_schema(&[]);
        assert!(empty.contains("No assistants were configured"));
    }

    #[test]
    fn the_refusal_names_the_usable_assistants_and_forbids_a_fallback() {
        let text = assistant_not_found_message("9", &[entry(3, "Reviewer", "ignored here")]);
        assert!(text.starts_with("No usable assistant 9:"));
        assert!(text.contains("Usable assistants: 3: Reviewer [Codex CLI]."));
        assert!(!text.contains("ignored here"));
        assert!(text.contains("Do not delegate this to another agent instead"));
        assert!(assistant_not_found_message("9", &[]).contains("no usable assistants"));
    }
}
