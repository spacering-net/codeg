//! What an assistant remembers, as the owner sees it (7.7).
//!
//! - **The memory card.** Each turn's working directory is committed when the
//!   turn ends; when that commit changed the assistant's memory — the owner's
//!   profile, the index, an entry — or its persona and rules, a low card in
//!   its own conversation says what changed, shows the diff, and takes it
//!   back: [Undo] reverts those files of that commit, and commits that.
//! - **The memory a reply used**: the entries the turn read, under the reply
//!   (`workdir::used_entries`, settled with it).
//! - **Notes before compacting** run in the engine, ahead of a compaction
//!   (`engine::start_flush`).

use std::path::Path;
use std::sync::Arc;

use serde_json::{json, Value};

use super::engine::PersonalAgentEngine;
use super::workdir::{self, MemoryFile};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service::{self as svc, NewNotice, NewRow};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_prefs::Level;

/// The news kind of a memory card (its level is `level_memory`).
pub const MEMORY_NEWS: &str = "memory";
/// The event telling an assistant the owner took a memory change back.
pub const MEMORY_EVENT: &str = "memory";

/// How many entries a change added, updated and removed, and which of the
/// other files it touched.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tally {
    pub added: Vec<String>,
    pub updated: Vec<String>,
    pub removed: Vec<String>,
    pub soul: bool,
    pub rules: bool,
    pub user: bool,
    /// The index alone changed (no entry with it).
    pub index_only: bool,
}

impl Tally {
    pub fn of(files: &[MemoryFile]) -> Self {
        let mut t = Self::default();
        for f in files {
            match f.kind.as_str() {
                "entry" => match f.status.as_str() {
                    "added" => t.added.push(f.title.clone()),
                    "deleted" => t.removed.push(f.title.clone()),
                    _ => t.updated.push(f.title.clone()),
                },
                "soul" => t.soul = true,
                "rules" => t.rules = true,
                "user" => t.user = true,
                _ => {}
            }
        }
        t.index_only = files.iter().any(|f| f.kind == "index")
            && t.added.is_empty()
            && t.updated.is_empty()
            && t.removed.is_empty();
        t
    }

    /// The card's text (and its record in any text view): "Memory updated —
    /// new: Release days · updated: Hours · persona".
    pub fn line(&self) -> String {
        let mut parts: Vec<String> = Vec::new();
        for (label, list) in [
            ("new", &self.added),
            ("updated", &self.updated),
            ("removed", &self.removed),
        ] {
            if !list.is_empty() {
                parts.push(format!("{label}: {}", list.join(", ")));
            }
        }
        if self.user {
            parts.push("the owner's profile".into());
        }
        if self.soul {
            parts.push("persona".into());
        }
        if self.rules {
            parts.push("rules".into());
        }
        if self.index_only {
            parts.push("the memory index".into());
        }
        format!("Memory updated — {}", parts.join(" · "))
    }

    /// What a change came to, counted: "1 new, 2 removed · persona".
    pub fn short(&self) -> String {
        let counts: Vec<String> = [
            ("new", &self.added),
            ("updated", &self.updated),
            ("removed", &self.removed),
        ]
        .into_iter()
        .filter(|(_, list)| !list.is_empty())
        .map(|(word, list)| format!("{} {word}", list.len()))
        .collect();
        let mut parts = Vec::new();
        if !counts.is_empty() {
            parts.push(counts.join(", "));
        }
        for (on, word) in [
            (self.user, "the owner's profile"),
            (self.soul, "persona"),
            (self.rules, "rules"),
        ] {
            if on {
                parts.push(word.to_string());
            }
        }
        if parts.is_empty() {
            parts.push("the memory index".into());
        }
        parts.join(" · ")
    }

    /// The titles a notification names: the entries, by title.
    pub fn titles(&self) -> Vec<String> {
        self.added
            .iter()
            .chain(&self.updated)
            .chain(&self.removed)
            .cloned()
            .collect()
    }
}

pub(super) fn notice_level(l: Level) -> NoticeLevel {
    match l {
        Level::Urgent => NoticeLevel::Urgent,
        Level::Normal => NoticeLevel::Normal,
        Level::Low => NoticeLevel::Low,
    }
}

/// What a memory card's payload names.
fn files_of(payload: &Value) -> Vec<MemoryFile> {
    payload
        .get("files")
        .and_then(|f| serde_json::from_value(f.clone()).ok())
        .unwrap_or_default()
}

impl PersonalAgentEngine {
    /// The memory card for the commit a turn ended with (`rev`), when that
    /// commit changed the assistant's memory, persona or rules. Its own
    /// conversation, low: the owner sees it there, in "Today" and the brief.
    pub(super) async fn memory_card(
        &self,
        dir: &Path,
        rev: &str,
        batch_id: i32,
        segment_id: i32,
    ) -> Option<i32> {
        let files = workdir::memory_changes(dir, rev).await;
        if files.is_empty() {
            return None;
        }
        let (diff, cut) = workdir::memory_diff(dir, rev, &files).await;
        let tally = Tally::of(&files);
        let prefs = self.prefs().await;
        let level = prefs.level_of(MEMORY_NEWS);
        let mut row = NewRow::new(TimelineKind::Notice, tally.line());
        row.segment_id = Some(segment_id);
        row.batch_id = Some(batch_id);
        row.data = Some(json!({
            "notice": "memory",
            "state": "acted",
            "commit": rev,
            "files": files,
            "diff": diff,
            "diff_cut": cut,
        }));
        let bot = self.bot().await;
        let made = svc::create_notice_with_row(
            &self.db.conn,
            bot,
            NewNotice {
                kind: NoticeKind::Memory,
                subject_key: Some(format!("memory:{rev}")),
                level: notice_level(level),
                batch_id: Some(batch_id),
                payload: json!({ "commit": rev, "files": files }),
            },
            row,
        )
        .await;
        let (notice, card) = match made {
            Ok(m) => m,
            Err(e) => {
                tracing::warn!("[personal_agent] the memory card was not written: {e}");
                return None;
            }
        };
        // Nothing to answer: done, and can be taken back.
        let _ = svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Acted,
        )
        .await;
        let card_id = card.id;
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        if let Some(host) = self.host_ref() {
            host.tell(super::reach::News {
                key: format!("memory:{}", notice.id),
                bot_id: bot,
                kind: MEMORY_NEWS,
                what: super::reach::What::Memory {
                    titles: tally
                        .added
                        .iter()
                        .chain(&tally.updated)
                        .chain(&tally.removed)
                        .cloned()
                        .collect(),
                    soul: tally.soul,
                    rules: tally.rules,
                    user: tally.user,
                },
                link: Some(super::reach::NotifyLink::Bot {
                    bot_id: bot,
                    row_id: Some(card_id),
                }),
                need: None,
            })
            .await;
        }
        Some(notice.id)
    }

    /// The owner answers a memory card: [Undo] takes the change back.
    pub(super) async fn act_on_memory(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        if action != "undo" {
            return Err("`action` must be undo".into());
        }
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        let rev = payload["commit"].as_str().unwrap_or_default().to_string();
        let files = files_of(&payload);
        if rev.is_empty() || files.is_empty() {
            return Err("this card names no change".into());
        }
        if !svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Acted],
            NoticeState::Undone,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err("there is nothing on this card to undo".into());
        }
        let back_out = |e: String| async move {
            let _ = svc::move_notice(
                &self.db.conn,
                notice.id,
                &[NoticeState::Undone],
                NoticeState::Acted,
            )
            .await;
            Err::<TimelineRow, String>(e)
        };
        let Some(row) = self.agent_row().await else {
            return back_out("configure the personal agent first".into()).await;
        };
        let dir = self.workdir_of(&row);
        let short: String = rev.chars().take(7).collect();
        let undo = match workdir::undo_memory(
            &dir,
            &rev,
            &files,
            &format!("owner: undo memory change {short}"),
        )
        .await
        {
            Ok(u) => u,
            Err(e) => return back_out(e).await,
        };
        if undo.back.is_empty() {
            return back_out(
                "every file of this change was changed again since: nothing was undone".into(),
            )
            .await;
        }
        // The persona and rules taken back: the assistant has them again
        // with its next delivery.
        if undo
            .back
            .iter()
            .any(|p| p == workdir::SOUL_FILE || p == workdir::RULES_FILE)
        {
            if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, self.bot().await).await {
                self.update_segment_state(seg.id, |s| s.persona_resend = true)
                    .await;
            }
        }
        let card = self
            .memory_row(
                notice,
                json!({
                    "state": "undone",
                    "kept": undo.kept,
                    "undo_commit": undo.commit,
                    "undone_at": chrono::Utc::now(),
                }),
            )
            .await?;
        self.tell_memory_undone(notice, &files, &undo).await;
        Ok(card)
    }

    /// Write `extra` onto a memory card's row (a tidy-up's and a skill's
    /// too).
    pub(super) async fn memory_row(
        &self,
        notice: &notice_entity::Model,
        extra: Value,
    ) -> Result<TimelineRow, String> {
        let id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str::<Value>(d).ok())
            .unwrap_or_else(|| json!({}));
        if let (Some(map), Value::Object(extra)) = (data.as_object_mut(), extra) {
            for (k, v) in extra {
                map.insert(k, v);
            }
        }
        svc::update_row_data(&self.db.conn, id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    /// Let the assistant know, with its next delivery, which of its memory
    /// the owner took back — so it does not write it again on its own.
    async fn tell_memory_undone(
        &self,
        notice: &notice_entity::Model,
        files: &[MemoryFile],
        undo: &workdir::MemoryUndo,
    ) {
        let name = |p: &str| {
            files
                .iter()
                .find(|f| f.path == p)
                .map(|f| {
                    if f.kind == "entry" {
                        format!("{} ({})", f.title, f.path)
                    } else {
                        f.path.clone()
                    }
                })
                .unwrap_or_else(|| p.to_string())
        };
        let back: Vec<String> = undo.back.iter().map(|p| name(p)).collect();
        let mut summary = format!(
            "The owner undid your memory change on card #{}: {} — back as they were before it. \
             Do not write it again unless they ask.",
            notice.id,
            back.join(", ")
        );
        if !undo.kept.is_empty() {
            let kept: Vec<String> = undo.kept.iter().map(|p| name(p)).collect();
            summary.push_str(&format!(
                " Left as they are now (changed again since): {}.",
                kept.join(", ")
            ));
        }
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            MEMORY_EVENT,
            &format!("notice:{}:undid", notice.id),
            None,
            summary,
            Some(json!({ "notice_id": notice.id, "verdict": "undid" })),
            false,
        )
        .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, status: &str, kind: &str, title: &str) -> MemoryFile {
        MemoryFile {
            path: path.into(),
            status: status.into(),
            kind: kind.into(),
            title: title.into(),
        }
    }

    #[test]
    fn a_change_is_told_by_what_it_did_to_each_kind_of_file() {
        let t = Tally::of(&[
            f("MEMORY.md", "modified", "index", "MEMORY.md"),
            f("memory/release.md", "added", "entry", "Release days"),
            f("memory/hours.md", "modified", "entry", "Hours"),
            f("memory/old.md", "deleted", "entry", "Old"),
            f("SOUL.md", "modified", "soul", "SOUL.md"),
        ]);
        assert_eq!(t.added, vec!["Release days"]);
        assert_eq!(t.updated, vec!["Hours"]);
        assert_eq!(t.removed, vec!["Old"]);
        assert!(t.soul && !t.rules && !t.user && !t.index_only);
        assert_eq!(
            t.line(),
            "Memory updated — new: Release days · updated: Hours · removed: Old · persona"
        );
        // The index alone is said as such.
        let only = Tally::of(&[f("MEMORY.md", "modified", "index", "MEMORY.md")]);
        assert!(only.index_only);
        assert_eq!(only.line(), "Memory updated — the memory index");
    }
}
