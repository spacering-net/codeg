//! Assistants as the delegation layer sees them: resolving the one a
//! `delegate_to_agent` call names, and the roster the companion lists in the
//! tool's schema. They are the owner's personal assistants: a call names one
//! by its uid (`bot`), or — from an old `codeg://assistant/<id>` link — by
//! the collaboration settings' assistant it was converted from
//! (`assistant_id`). A child runs on the agent the assistant's work runs on,
//! with its options, and its work's standing instructions as its brief.
//!
//! Resolved per call, never frozen at launch: an assistant created or renamed
//! while a session is open is usable from that session at once. The roster in
//! the tool description is only a hint for the delegating agent; a call by uid
//! does not depend on it. Hidden assistants, and ones whose work agent is
//! turned off, are not delegated to.

use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::acp::delegation::types::{AgentDelegationDefaults, DelegationAssistant};
use crate::db::AppDatabase;
use crate::models::personal_agent_bots::BotAvatar;
use crate::models::AgentType;

/// One of the owner's assistants as a delegation may run as it now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegatableAssistant {
    /// Its row (`personal_agent.id`).
    pub id: i32,
    pub uid: String,
    pub name: String,
    /// The head of its persona: what it is for, for the delegating agent.
    pub persona: String,
    /// The agent its work runs on, with every option picked.
    pub agent_type: AgentType,
    pub agent_options: AgentDelegationDefaults,
    /// Its work's standing instructions.
    pub instructions: String,
    pub avatar: BotAvatar,
    /// The collaboration settings' assistant it was converted from: what a
    /// companion from before uids, or an old `codeg://assistant/<id>` link,
    /// names it by.
    pub legacy_id: Option<i32>,
}

/// The broker's view of the owner's assistants. A trait so the broker and
/// the listener can be tested without a database.
#[async_trait]
pub trait AssistantLookup: Send + Sync {
    /// The assistant `uid` names, if a delegation may run as it right now:
    /// it exists, is not deleted or hidden, and its work agent is on.
    async fn by_uid(&self, uid: &str) -> Option<DelegatableAssistant>;

    /// The assistant converted from the collaboration settings' assistant
    /// `legacy_id` (an old link), on the same terms.
    async fn by_legacy_id(&self, legacy_id: i32) -> Option<DelegatableAssistant>;

    /// Every assistant a delegation may run as right now, in the roster's
    /// order (the primary first).
    async fn roster(&self) -> Vec<DelegatableAssistant>;

    /// A delegation that ran as assistant `uid` came to an end: a line in
    /// its own log — who @-mentioned it, on what, how it ended — for its
    /// nightly tidy-up to learn from. Not in its conversation, and no wake
    /// of its brain (D4).
    async fn record_delegation(
        &self,
        _uid: &str,
        _child_conversation_id: i32,
        _result: &crate::acp::types::DelegationResultSummary,
    ) {
    }
}

/// No assistants at all — the default for brokers built without a database.
#[derive(Default, Clone)]
pub struct NoAssistants;

#[async_trait]
impl AssistantLookup for NoAssistants {
    async fn by_uid(&self, _uid: &str) -> Option<DelegatableAssistant> {
        None
    }

    async fn by_legacy_id(&self, _legacy_id: i32) -> Option<DelegatableAssistant> {
        None
    }

    async fn roster(&self) -> Vec<DelegatableAssistant> {
        Vec::new()
    }
}

/// [`AssistantLookup`] over the live database (and the data dir, where
/// their personas are).
pub struct DbAssistantLookup {
    pub db: Arc<AppDatabase>,
    pub data_dir: PathBuf,
}

impl DbAssistantLookup {
    async fn delegatable(
        &self,
        row: crate::db::entities::personal_agent::Model,
    ) -> Option<DelegatableAssistant> {
        if row.deleted_at.is_some() || row.hidden {
            return None;
        }
        let work = crate::personal_agent::dispatch::usable_work(&self.db, &row).await?;
        let soul = crate::personal_agent::workdir::soul_text(&self.data_dir, &row);
        Some(DelegatableAssistant {
            id: row.id,
            uid: row.uid.clone()?,
            name: crate::personal_agent::messages::display_name(&row),
            persona: crate::personal_agent::team::persona_head(
                &soul,
                ROSTER_DESCRIPTION_CAP,
            ),
            agent_type: work.agent_type,
            agent_options: work.agent_options,
            instructions: row.work_instructions.clone().unwrap_or_default(),
            avatar: BotAvatar::parse(&row.avatar),
            legacy_id: row.legacy_assistant_id,
        })
    }

    async fn rows(&self) -> Vec<crate::db::entities::personal_agent::Model> {
        match crate::db::service::personal_agent_service::list_bots(&self.db.conn).await {
            Ok(list) => list,
            Err(e) => {
                tracing::warn!("[delegation] assistants lookup failed: {e}");
                Vec::new()
            }
        }
    }
}

#[async_trait]
impl AssistantLookup for DbAssistantLookup {
    async fn by_uid(&self, uid: &str) -> Option<DelegatableAssistant> {
        let row = self
            .rows()
            .await
            .into_iter()
            .find(|b| b.uid.as_deref() == Some(uid))?;
        self.delegatable(row).await
    }

    async fn by_legacy_id(&self, legacy_id: i32) -> Option<DelegatableAssistant> {
        let row = self
            .rows()
            .await
            .into_iter()
            .find(|b| b.legacy_assistant_id == Some(legacy_id))?;
        self.delegatable(row).await
    }

    async fn roster(&self) -> Vec<DelegatableAssistant> {
        let mut out = Vec::new();
        for row in self.rows().await {
            if let Some(a) = self.delegatable(row).await {
                out.push(a);
            }
        }
        out
    }

    async fn record_delegation(
        &self,
        uid: &str,
        child_conversation_id: i32,
        result: &crate::acp::types::DelegationResultSummary,
    ) {
        use crate::db::service::conversation_service;
        use crate::db::service::personal_agent_service as pa;
        use crate::personal_agent::workdir;
        let Some(row) = self
            .rows()
            .await
            .into_iter()
            .find(|b| b.uid.as_deref() == Some(uid))
        else {
            return;
        };
        // Its directory made first; one that cannot be gets no line now.
        if let Err(e) =
            crate::personal_agent::ready::ensure_worker_ready(&self.db, &self.data_dir, row.id).await
        {
            tracing::warn!("[delegation] {uid}: no log line, its directory is not made: {e}");
            return;
        }
        let child = conversation_service::get_by_id(&self.db.conn, child_conversation_id)
            .await
            .ok();
        let parent = match child.as_ref().and_then(|c| c.parent_id) {
            Some(p) => conversation_service::get_by_id(&self.db.conn, p).await.ok(),
            None => None,
        };
        let one_line = |t: &str| -> String {
            let line: String = t.split_whitespace().collect::<Vec<_>>().join(" ");
            let mut out: String = line.chars().take(200).collect();
            if line.chars().count() > 200 {
                out.push('…');
            }
            out
        };
        let outcome = match result {
            crate::acp::types::DelegationResultSummary::Ok { text_preview, .. } => {
                match text_preview.as_deref().map(one_line).filter(|t| !t.is_empty()) {
                    Some(t) => format!("done: {t}"),
                    None => "done".to_string(),
                }
            }
            crate::acp::types::DelegationResultSummary::Err { error_code } => {
                format!("ended: {error_code}")
            }
        };
        let from = match &parent {
            Some(p) => format!(
                "conversation #{} \"{}\"",
                p.id,
                one_line(p.title.as_deref().unwrap_or(""))
            ),
            None => "a conversation".to_string(),
        };
        let what = child
            .as_ref()
            .and_then(|c| c.title.as_deref())
            .map(one_line)
            .unwrap_or_default();
        // On the owner's clock, in the day the hours count it to — the log
        // a tidy-up reads for that day (`presence::hours_day`).
        let tz = crate::personal_agent::clock::zone_of(
            &crate::personal_agent::history::prefs_of(&self.db).await.time_zone,
        );
        let now = chrono::Utc::now();
        let day = crate::personal_agent::tidy::day_word(
            crate::personal_agent::presence::hours_day(now, tz),
        );
        let line = format!(
            "- {} @-mentioned in {from}: {what} — {outcome} (its session #{child_conversation_id})",
            now.with_timezone(&tz).format("%H:%M"),
        );
        // The row read again and the line written in one hold of the claim:
        // a delete removes the directory under it, so one deleted (or moved)
        // meanwhile is not written to, nor made again.
        let _claim = workdir::WORKDIR_CLAIM.lock().await;
        let Ok(Some(row)) = pa::get_bot(&self.db.conn, row.id).await else {
            return;
        };
        let dir = workdir::workdir_of_bot(&self.data_dir, &row);
        if !workdir::is_workdir(&dir) {
            tracing::warn!("[delegation] {uid}: no log line, {} is not its directory", dir.display());
            return;
        }
        if let Err(e) = workdir::append_log_line(&dir, &day, &line).await {
            tracing::warn!("[delegation] {uid}: log line not written: {e}");
        }
    }
}

impl From<DelegatableAssistant> for DelegationAssistant {
    fn from(a: DelegatableAssistant) -> Self {
        DelegationAssistant {
            id: a.id,
            bot_uid: Some(a.uid),
            name: a.name,
            agent_options: a.agent_options,
            instructions: a.instructions,
            avatar: Some(a.avatar),
        }
    }
}

/// One roster line as it crosses the companion socket (`ListAssistants`).
/// Carries what the delegating agent needs to pick an assistant — nothing of
/// its options or instructions.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRosterEntry {
    /// What a companion from before uids names it by — `assistant_id`, which
    /// resolves through `legacy_assistant_id`: the collaboration settings'
    /// assistant it was converted from; 0 for one that was none (such a
    /// companion is not sent it, see [`roster_for_companion`]). Never its
    /// row: that would name another assistant there.
    pub id: i32,
    /// What a call names it by (`bot`).
    #[serde(default)]
    pub uid: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub agent_type: AgentType,
}

impl From<&DelegatableAssistant> for AssistantRosterEntry {
    fn from(a: &DelegatableAssistant) -> Self {
        AssistantRosterEntry {
            id: a.legacy_id.unwrap_or(0),
            uid: a.uid.clone(),
            name: a.name.clone(),
            description: a.persona.clone(),
            agent_type: a.agent_type,
        }
    }
}

/// The roster as a companion is sent it: whole to one that names
/// assistants by uid (`bots`); to one from before uids, only those it can
/// name — the ones converted from the collaboration settings, by that id.
pub fn roster_for_companion(
    roster: Vec<AssistantRosterEntry>,
    bots: bool,
) -> Vec<AssistantRosterEntry> {
    if bots {
        return roster;
    }
    roster.into_iter().filter(|e| e.id > 0).collect()
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

/// `9f2c…: Reviewer [Codex CLI] — reviews diffs` — one roster line (by its
/// uid), as both the schema roster and the not-found refusal quote it.
fn roster_line(entry: &AssistantRosterEntry, with_description: bool) -> String {
    let key = if entry.uid.is_empty() {
        entry.id.to_string()
    } else {
        entry.uid.clone()
    };
    let mut line = format!("{key}: {} [{}]", entry.name, entry.agent_type);
    let description = entry.description.trim();
    if with_description && !description.is_empty() {
        line.push_str(" — ");
        line.push_str(&capped(description, ROSTER_DESCRIPTION_CAP));
    }
    line
}

/// The sentence appended to `bot`'s schema description: who could be
/// delegated to when the session started. A hint only — see the module docs.
pub fn roster_for_schema(roster: &[AssistantRosterEntry]) -> String {
    if roster.is_empty() {
        return " No assistants could be delegated to when this session started; use this \
                only with a uid taken from a `codeg://bot/<uid>` link in the user's message."
            .to_string();
    }
    let lines: Vec<String> = roster.iter().map(|e| roster_line(e, true)).collect();
    format!(
        " Assistants when this session started (uid: name [agent] — what it is for): {}. \
         An assistant made later can still be used by its uid.",
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
        "No usable assistant {asked}: it does not exist, was deleted or hidden, or the agent \
         its work runs on is turned off. {available} Do not delegate this to another agent \
         instead — tell the user."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: i32, name: &str, description: &str) -> AssistantRosterEntry {
        AssistantRosterEntry {
            id,
            uid: format!("u{id}"),
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
        assert!(text.contains("u3: Reviewer [Codex CLI] — Reviews diffs; u5: Writer [Codex CLI] — "));
        assert!(text.contains(&format!("{}…", "x".repeat(ROSTER_DESCRIPTION_CAP))));
        assert!(!text.contains(&"x".repeat(ROSTER_DESCRIPTION_CAP + 1)));
        assert!(text.ends_with("An assistant made later can still be used by its uid."));

        let empty = roster_for_schema(&[]);
        assert!(empty.contains("No assistants could be delegated to"));
    }

    #[test]
    fn the_refusal_names_the_usable_assistants_and_forbids_a_fallback() {
        let text = assistant_not_found_message("9", &[entry(3, "Reviewer", "ignored here")]);
        assert!(text.starts_with("No usable assistant 9:"));
        assert!(text.contains("Usable assistants: u3: Reviewer [Codex CLI]."));
        assert!(!text.contains("ignored here"));
        assert!(text.contains("Do not delegate this to another agent instead"));
        assert!(assistant_not_found_message("9", &[]).contains("no usable assistants"));
    }

    /// A companion from before uids names an assistant by `assistant_id`,
    /// which resolves through the collaboration settings' id it came from:
    /// it is sent only those, by that id — never a row id, which would name
    /// another assistant there.
    #[test]
    fn a_companion_from_before_uids_is_sent_only_the_assistants_it_can_name() {
        let made = |id: i32, legacy_id: Option<i32>| DelegatableAssistant {
            id,
            uid: format!("u{id}"),
            name: format!("A{id}"),
            persona: String::new(),
            agent_type: AgentType::Codex,
            agent_options: Default::default(),
            instructions: String::new(),
            avatar: BotAvatar::default_for("x"),
            legacy_id,
        };
        let roster: Vec<AssistantRosterEntry> = [made(2, None), made(7, Some(2))]
            .iter()
            .map(AssistantRosterEntry::from)
            .collect();
        assert_eq!(roster[0].id, 0, "a row id is never sent as an id");
        assert_eq!(roster[1].id, 2, "its legacy id");
        let old = roster_for_companion(roster.clone(), false);
        assert_eq!(old.len(), 1);
        assert_eq!((old[0].id, old[0].uid.as_str()), (2, "u7"));
        assert_eq!(roster_for_companion(roster, true).len(), 2);
    }

}
