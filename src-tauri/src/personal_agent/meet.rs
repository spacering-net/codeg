//! Getting to know the owner (5.4, 1.15). Once the primary's brain is first
//! picked, its conversation shows, one after the other, native cards — no
//! model is asked:
//!
//! 1. **What to call each other**: a choice card of two questions — what to
//!    call the owner (their system user name, or their own words) and what
//!    to call the assistant (its name, or a new one). The first goes into
//!    `USER.md`, the second is its name.
//! 2. **The projects to connect**, under two lines about what it does: the
//!    owner ticks the projects codeg has (opening another, connecting a
//!    forge account), or skips it — everything works without.
//! 3. **One thing at once** (`starter.rs`): the first thing an assistant can
//!    take off their hands in those projects — [Hand it to me] sends it as
//!    the owner's message, [Another one], [Not now]. With nothing to offer it
//!    says it keeps an eye on them.
//! 4. **What the assistants do on their own**: how much they may disturb
//!    the owner and the switches of what they do unasked, with [Build a
//!    team] (a suggestion of three work assistants), the preferences, and
//!    the desktop companion.
//!
//! An owner coming up from v2.0 (a primary set up before it, with no record
//! of this) is not asked what to call anyone: they get 4, and 3 for the
//! projects whose forge has an account.
//!
//! The record lives on the primary's settings, under `meet`: how it began
//! (`new` or `upgrade`) and the projects connected. Each card is raised once
//! (by its subject).

use std::collections::HashSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::bot_templates as templates;
use super::engine::{brain_of, PersonalAgentEngine};
use super::starter::{self, LiveForge, Project};
use super::workdir;
use crate::db::entities::folder::{self, FolderKind};
use crate::db::entities::personal_agent::BotKind;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::db::AppDatabase;
use crate::forge::ForgeProvider;
use crate::models::personal_agent::{PersonalAgentChange, PersonalAgentDraft, TimelineRow};
use crate::models::system::AppLocale;

/// The record, on the primary's settings.
pub const MEET_KEY: &str = "meet";
const NAME_SUBJECT: &str = "meet:name";
const CONNECT_SUBJECT: &str = "meet:connect";
const STARTER_SUBJECT: &str = "meet:starter";
const PROMISES_SUBJECT: &str = "meet:promises";
/// Projects the connect card lists, and how many may be connected.
const LIST_MAX: usize = 30;
const CONNECT_MAX: usize = 10;
/// Projects looked in on the way up from v2.0: the most recent ones whose
/// forge has an account.
const UPGRADE_PROJECTS: usize = 5;
/// The longest a name for the owner may be.
const CALL_MAX: usize = 60;
/// The work assistants [Build a team] suggests (4.12), by template.
const TEAM: [&str; 3] = ["dev", "review", "ci"];

/// One at a time in this process: a card raised once, a starter moved once,
/// a team made once.
static MEET: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The looks on their way, by engine, card and look.
static LOOKING: std::sync::LazyLock<std::sync::Mutex<HashSet<(usize, i32, i64)>>> =
    std::sync::LazyLock::new(Default::default);

/// Held while a team card is answered (`bots.rs` dismisses under it too).
pub(super) async fn team_guard() -> tokio::sync::MutexGuard<'static, ()> {
    MEET.lock().await
}

/// A project the connect card lists: where its remote is, and whether an
/// account serves that forge.
#[derive(Debug, Clone, Serialize)]
pub struct MeetProject {
    pub id: i32,
    pub name: String,
    pub path: String,
    /// The forge of its `origin`, when it is one codeg speaks.
    pub provider: Option<ForgeProvider>,
    pub host: Option<String>,
    /// A forge account serves it.
    pub account: bool,
}

/// One answer on the name card: a choice's letter, or the owner's words.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChoicePick {
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

/// The words codeg writes itself in the owner's language: the name card's
/// questions (its row is what "needs you" shows) and the line `USER.md`
/// gets.
struct Words {
    call: &'static str,
    name: &'static str,
    /// `USER.md`'s line, before the name.
    call_line: &'static str,
}

fn words(locale: AppLocale) -> Words {
    let (call, name, call_line) = match locale {
        AppLocale::En => (
            "What should I call you?",
            "Want to give me a name?",
            "- Call them: ",
        ),
        AppLocale::ZhCn => ("我该怎么称呼你？", "给我起个名字？", "- 称呼："),
        AppLocale::ZhTw => ("我該怎麼稱呼你？", "給我取個名字？", "- 稱呼："),
        AppLocale::Ja => (
            "何とお呼びすればいいですか？",
            "私に名前をつけますか？",
            "- 呼び方：",
        ),
        AppLocale::Ko => (
            "어떻게 불러 드릴까요?",
            "제 이름을 지어 주실래요?",
            "- 호칭: ",
        ),
        AppLocale::Es => ("¿Cómo te llamo?", "¿Me pones un nombre?", "- Llamarle: "),
        AppLocale::De => (
            "Wie soll ich dich nennen?",
            "Gibst du mir einen Namen?",
            "- Anrede: ",
        ),
        AppLocale::Fr => (
            "Comment dois-je t'appeler ?",
            "Tu me donnes un nom ?",
            "- L'appeler : ",
        ),
        AppLocale::Pt => (
            "Como devo te chamar?",
            "Quer me dar um nome?",
            "- Chamar de: ",
        ),
        AppLocale::Ar => ("بماذا أناديك؟", "هل تختار لي اسمًا؟", "- يُنادى: "),
    };
    Words {
        call,
        name,
        call_line,
    }
}

/// The owner's user name on this machine, as the name card offers it.
fn system_user() -> Option<String> {
    ["USER", "USERNAME", "LOGNAME"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .map(|v| v.trim().to_string())
        .find(|v| !v.is_empty())
        .or_else(|| {
            dirs::home_dir()
                .and_then(|h| h.file_name().map(|n| n.to_string_lossy().into_owned()))
                .filter(|n| !n.is_empty())
        })
}

/// `USER.md` with what to call the owner: the line replaced where it is,
/// added at the end otherwise.
pub(super) fn with_call(text: &str, line: &str, call: &str) -> String {
    let prefix = line.trim_end();
    let new_line = format!("{line}{call}");
    let mut found = false;
    let mut lines: Vec<String> = text
        .lines()
        .map(|l| {
            if !found && l.trim_start().starts_with(prefix) {
                found = true;
                new_line.clone()
            } else {
                l.to_string()
            }
        })
        .collect();
    if !found {
        while lines.last().is_some_and(|l| l.trim().is_empty()) {
            lines.pop();
        }
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(new_line);
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// The projects codeg has open, most recent first: every open top-level
/// folder of the owner's.
async fn open_projects(db: &AppDatabase) -> Vec<folder::Model> {
    use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
    folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::IsOpen.eq(true))
        .filter(folder::Column::ParentId.is_null())
        .filter(folder::Column::Kind.eq(FolderKind::Regular))
        .order_by_desc(folder::Column::LastOpenedAt)
        .all(&db.conn)
        .await
        .unwrap_or_default()
}

/// A folder not deleted, by id.
async fn folder_model(db: &AppDatabase, id: i32) -> Option<folder::Model> {
    use sea_orm::EntityTrait;
    folder::Entity::find_by_id(id)
        .one(&db.conn)
        .await
        .ok()
        .flatten()
        .filter(|f| f.deleted_at.is_none())
}

fn project_name(f: &folder::Model) -> String {
    f.alias.clone().unwrap_or_else(|| f.name.clone())
}

/// The connect card's list: each open project, its forge and whether an
/// account serves it. Nothing is asked of the forge.
pub async fn meet_projects(db: &AppDatabase) -> Vec<MeetProject> {
    let mut out = Vec::new();
    for f in open_projects(db).await.into_iter().take(LIST_MAX) {
        let remote = crate::commands::forge::forge_remote_at(&db.conn, &f.path)
            .await
            .ok()
            .flatten()
            .filter(|r| r.supported);
        let account = match remote.as_ref() {
            Some(r) => crate::forge::auth::has_account(&db.conn, r.provider, &r.server_host).await,
            None => false,
        };
        out.push(MeetProject {
            id: f.id,
            name: project_name(&f),
            path: f.path.clone(),
            provider: remote.as_ref().map(|r| r.provider),
            host: remote.map(|r| r.server_host),
            account,
        });
    }
    out
}

fn payload_of(n: &notice_entity::Model) -> Value {
    serde_json::from_str(&n.payload).unwrap_or(Value::Null)
}

impl PersonalAgentEngine {
    /// The record of getting to know the owner, on the primary's settings.
    async fn meet_record(&self) -> Option<Value> {
        let primary = svc::primary_bot(&self.db.conn).await.ok().flatten()?;
        serde_json::from_str::<Value>(&primary.settings)
            .ok()
            .and_then(|s| s.get(MEET_KEY).cloned())
            .filter(|m| m.is_object())
    }

    async fn patch_meet(&self, patch: Value) {
        let Ok(Some(primary)) = svc::primary_bot(&self.db.conn).await else {
            return;
        };
        if let Err(e) =
            svc::patch_settings(&self.db.conn, primary.id, &json!({ MEET_KEY: patch })).await
        {
            tracing::warn!("[personal-agent] the record of meeting the owner was not written: {e}");
        }
    }

    /// Raise a card of getting to know the owner, once: `None` when it was
    /// raised already.
    async fn raise_meet_card(
        &self,
        kind: NoticeKind,
        subject: &str,
        body: String,
        data: Value,
        payload: Value,
    ) -> Result<Option<TimelineRow>, String> {
        let bot = self.bot().await;
        if svc::notice_of_subject(&self.db.conn, bot, kind, subject)
            .await
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Ok(None);
        }
        let mut row = NewRow::new(TimelineKind::Notice, body);
        row.segment_id = self.state.lock().await.connection_segment;
        row.data = Some(data);
        let (_, card) = svc::create_notice_with_row(
            &self.db.conn,
            bot,
            NewNotice {
                kind,
                subject_key: Some(subject.to_string()),
                level: NoticeLevel::Normal,
                batch_id: None,
                payload,
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        let row = svc::to_row(card);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(Some(row))
    }

    /// After the page saved the primary: a primary just set up gets the card
    /// asking what to call each other.
    pub async fn meet_after_save(&self) {
        let _one = MEET.lock().await;
        let Some(primary) = svc::primary_bot(&self.db.conn).await.ok().flatten() else {
            return;
        };
        if self.bot().await != primary.id || brain_of(&primary).is_none() {
            return;
        }
        if self
            .meet_record()
            .await
            .and_then(|m| m["from"].as_str().map(str::to_string))
            != Some("new".into())
        {
            return;
        }
        let locale = self.owner_locale(&primary, None).await;
        let w = words(locale);
        let data = json!({
            "notice": "choice",
            "purpose": "meet",
            "state": "open",
            "owner": system_user(),
            "name": primary.name.trim(),
        });
        if let Err(e) = self
            .raise_meet_card(
                NoticeKind::Choice,
                NAME_SUBJECT,
                format!("{} {}", w.call, w.name),
                data,
                json!({ "purpose": "meet" }),
            )
            .await
        {
            tracing::warn!(
                "[personal-agent] the card asking what to call each other was not written: {e}"
            );
        }
    }

    /// At start: a primary set up before this version, with no record of
    /// getting to know the owner, gets what the assistants do on their own,
    /// and one thing at once in its projects whose forge has an account.
    pub async fn meet_on_start(self: &Arc<Self>) {
        let one = MEET.lock().await;
        let Some(primary) = svc::primary_bot(&self.db.conn).await.ok().flatten() else {
            return;
        };
        if self.bot().await != primary.id || brain_of(&primary).is_none() {
            return;
        }
        if self.meet_record().await.is_some() {
            drop(one);
            self.resume_starter().await;
            return;
        }
        self.patch_meet(json!({ "from": "upgrade" })).await;
        let mut projects: Vec<Project> = Vec::new();
        for p in meet_projects(&self.db).await {
            if projects.len() >= UPGRADE_PROJECTS {
                break;
            }
            if p.account {
                projects.push(Project {
                    id: p.id,
                    name: p.name,
                });
            }
        }
        if !projects.is_empty() {
            self.patch_meet(
                json!({ "projects": projects.iter().map(|p| p.id).collect::<Vec<_>>() }),
            )
            .await;
            if let Err(e) = self.raise_first_thing(projects).await {
                tracing::warn!("[personal-agent] the first-thing card was not written: {e}");
            }
        }
        if let Err(e) = self.raise_promises().await {
            tracing::warn!(
                "[personal-agent] the card of what the assistants do was not written: {e}"
            );
        }
    }

    // ── 1. what to call each other ──────────────────────────────────────────

    /// The owner answered the name card: what to call them into `USER.md`,
    /// a new name for the assistant, and the projects card next. No answers
    /// is skipping it.
    pub(super) async fn answer_meet_name(
        &self,
        notice: &notice_entity::Model,
        row_id: i32,
        mut data: Value,
        answers: &[ChoicePick],
    ) -> Result<TimelineRow, String> {
        let pick =
            |i: usize, offered: Option<&str>, max: usize| -> Result<Option<String>, String> {
                let Some(a) = answers.get(i) else {
                    return Ok(None);
                };
                let own = a
                    .text
                    .as_deref()
                    .map(|t| {
                        t.trim()
                            .chars()
                            .filter(|c| !c.is_control())
                            .take(max)
                            .collect::<String>()
                    })
                    .filter(|t| !t.is_empty());
                match (a.key.as_deref().map(|k| k.trim().to_ascii_uppercase()), own) {
                    (_, Some(t)) => Ok(Some(t)),
                    (Some(k), None) if k == "A" => Ok(offered.map(str::to_string)),
                    _ => Err("pick a choice, or write one of your own".into()),
                }
            };
        if !answers.is_empty() && answers.len() != 2 {
            return Err("the card asks two questions".into());
        }
        let offered_call = data["owner"].as_str().map(str::to_string);
        let offered_name = data["name"].as_str().map(str::to_string);
        let call = pick(0, offered_call.as_deref(), CALL_MAX)?;
        let name = pick(1, offered_name.as_deref(), 40)?;
        if !svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Acted,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        let primary = self
            .agent_row()
            .await
            .ok_or("configure the personal agent first")?;
        let renamed = name
            .as_deref()
            .filter(|n| n.trim() != primary.name.trim() && Some(*n) != offered_name.as_deref());
        if let Some(n) = renamed {
            if let Err(e) = self
                .save(PersonalAgentDraft {
                    name: Some(n.to_string()),
                    ..Default::default()
                })
                .await
            {
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acted],
                    NoticeState::Open,
                )
                .await;
                return Err(e);
            }
        }
        if let Some(c) = call.as_deref() {
            let locale = self.owner_locale(&primary, None).await;
            let dir = self.workdir_of(&primary);
            let text = workdir::read_text(&dir, workdir::USER_FILE);
            let updated = with_call(&text, words(locale).call_line, c);
            match workdir::write_file(&dir, workdir::USER_FILE, &updated) {
                Ok(()) => {
                    tokio::spawn(async move {
                        workdir::commit_all(&dir, "owner: what to call them").await;
                    });
                }
                Err(e) => tracing::warn!("[personal-agent] USER.md was not written: {e}"),
            }
        }
        if let Some(map) = data.as_object_mut() {
            if answers.is_empty() {
                map.insert("state".into(), "skipped".into());
            } else {
                map.insert("state".into(), "answered".into());
                map.insert(
                    "answer".into(),
                    json!({
                        "call": call,
                        "call_key": if answers[0].text.as_deref().is_some_and(|t| !t.trim().is_empty()) { "B" } else { "A" },
                        "name": name,
                        "name_key": if answers[1].text.as_deref().is_some_and(|t| !t.trim().is_empty()) { "B" } else { "A" },
                    }),
                );
            }
        }
        svc::update_row_data(&self.db.conn, row_id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        // It learns it with its next delivery; nothing wakes it.
        if !answers.is_empty() {
            let mut said: Vec<String> = Vec::new();
            if let Some(c) = call.as_deref() {
                said.push(format!(
                    "The owner wants to be called \"{c}\" (written to USER.md)."
                ));
            }
            if let Some(n) = renamed {
                said.push(format!("The owner named you \"{n}\"."));
            }
            if !said.is_empty() {
                let _ = svc::insert_event(
                    &self.db.conn,
                    self.bot().await,
                    "changed",
                    &format!("meet:name:{}", notice.id),
                    None,
                    said.join(" "),
                    Some(json!({ "notice_id": notice.id })),
                    false,
                )
                .await;
            }
        }
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(row);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        let _one = MEET.lock().await;
        if let Err(e) = self.raise_connect().await {
            tracing::warn!("[personal-agent] the projects card was not written: {e}");
        }
        Ok(row)
    }

    // ── 2. the projects ─────────────────────────────────────────────────────

    async fn raise_connect(&self) -> Result<Option<TimelineRow>, String> {
        self.raise_meet_card(
            NoticeKind::Onboarding,
            CONNECT_SUBJECT,
            "Connect your projects, and I will find one thing I can help with right away.".into(),
            json!({ "notice": "onboarding", "purpose": "connect", "state": "open" }),
            json!({ "purpose": "connect" }),
        )
        .await
    }

    /// The owner connected these projects on the projects card: one thing
    /// at once in them, and what the assistants do on their own.
    pub async fn meet_connect(
        self: &Arc<Self>,
        notice_id: i32,
        folders: &[i32],
    ) -> Result<TimelineRow, String> {
        let notice = svc::get_notice_of(&self.db.conn, self.bot().await, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        if notice.kind != NoticeKind::Onboarding || payload_of(&notice)["purpose"] != "connect" {
            return Err("this is not the projects card".into());
        }
        let mut ids: Vec<i32> = Vec::new();
        for id in folders {
            if !ids.contains(id) {
                ids.push(*id);
            }
        }
        if ids.is_empty() {
            return Err("pick a project, or skip this".into());
        }
        if ids.len() > CONNECT_MAX {
            return Err(format!("connect at most {CONNECT_MAX} projects at once"));
        }
        let mut projects: Vec<Project> = Vec::new();
        for id in &ids {
            let f = folder_model(&self.db, *id)
                .await
                .ok_or_else(|| format!("no project #{id}"))?;
            if f.parent_id.is_some() || f.kind != FolderKind::Regular {
                return Err(format!("#{id} is not a project"));
            }
            projects.push(Project {
                id: f.id,
                name: project_name(&f),
            });
        }
        let _one = MEET.lock().await;
        if !svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Acted,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        self.patch_meet(json!({ "projects": ids })).await;
        let row = self
            .set_card_data(&notice, |d| {
                d["state"] = "connected".into();
                d["projects"] = json!(projects
                    .iter()
                    .map(|p| json!({ "id": p.id, "name": p.name }))
                    .collect::<Vec<_>>());
            })
            .await?;
        if let Err(e) = self.raise_first_thing(projects).await {
            tracing::warn!("[personal-agent] the first-thing card was not written: {e}");
        }
        if let Err(e) = self.raise_promises().await {
            tracing::warn!(
                "[personal-agent] the card of what the assistants do was not written: {e}"
            );
        }
        Ok(row)
    }

    /// Change a card's row data, and tell the page.
    async fn set_card_data(
        &self,
        notice: &notice_entity::Model,
        change: impl FnOnce(&mut Value),
    ) -> Result<TimelineRow, String> {
        let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data: Value = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str(d).ok())
            .unwrap_or_else(|| json!({}));
        change(&mut data);
        svc::update_row_data(&self.db.conn, row_id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(row);
        self.emit_rows(vec![row.clone()]);
        Ok(row)
    }

    /// The owner's answer on a card of getting to know them: `skip` on the
    /// projects card; `done` and `team` on what the assistants do.
    pub(super) async fn act_on_onboarding(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let purpose = payload_of(notice)["purpose"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let _one = MEET.lock().await;
        match (purpose.as_str(), action) {
            ("connect", "skip") => {
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Dismissed,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                let row = self
                    .set_card_data(notice, |d| d["state"] = "skipped".into())
                    .await?;
                if let Err(e) = self.raise_promises().await {
                    tracing::warn!(
                        "[personal-agent] the card of what the assistants do was not written: {e}"
                    );
                }
                Ok(row)
            }
            ("promises", "done") => {
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acted,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                self.set_card_data(notice, |d| d["state"] = "done".into())
                    .await
            }
            ("promises", "team") => {
                let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
                let row = svc::get_row(&self.db.conn, row_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("the card's row is missing")?;
                let data: Value = row
                    .data
                    .as_deref()
                    .and_then(|d| serde_json::from_str(d).ok())
                    .unwrap_or_default();
                if data["team"].is_number() {
                    return Err("the team was suggested already".into());
                }
                let card = self.suggest_team().await?;
                self.set_card_data(notice, |d| d["team"] = card.into())
                    .await
            }
            ("connect", _) => Err("`action` must be skip".into()),
            ("promises", _) => Err("`action` must be done or team".into()),
            _ => Err("this card has no such answer".into()),
        }
    }

    // ── 3. one thing at once ────────────────────────────────────────────────

    /// The first-thing card, looking — and the look, in the background.
    async fn raise_first_thing(self: &Arc<Self>, projects: Vec<Project>) -> Result<(), String> {
        let list: Vec<Value> = projects
            .iter()
            .map(|p| json!({ "id": p.id, "name": p.name }))
            .collect();
        let raised = self
            .raise_meet_card(
                NoticeKind::Starter,
                STARTER_SUBJECT,
                "Looking for one thing I can help with right away.".into(),
                json!({
                    "notice": "starter",
                    "state": "looking",
                    "projects": list,
                    "seen": [],
                    "gen": 0,
                }),
                json!({ "purpose": "meet" }),
            )
            .await?;
        if let Some(row) = raised {
            let notice_id = row
                .ref_id
                .as_deref()
                .and_then(|r| r.parse::<i32>().ok())
                .ok_or("the card's id is missing")?;
            self.look_for_starter(notice_id, 0, projects, HashSet::new());
        }
        Ok(())
    }

    /// A first-thing card still looking when codeg stopped looks again.
    async fn resume_starter(self: &Arc<Self>) {
        let Ok(Some(n)) = svc::notice_of_subject(
            &self.db.conn,
            self.bot().await,
            NoticeKind::Starter,
            STARTER_SUBJECT,
        )
        .await
        else {
            return;
        };
        if n.state != NoticeState::Open {
            return;
        }
        let Some(data) = self.card_data(&n).await else {
            return;
        };
        if data["state"] != "looking" {
            return;
        }
        let (projects, seen) = starter_inputs(&data);
        self.look_for_starter(n.id, data["gen"].as_i64().unwrap_or(0), projects, seen);
    }

    async fn card_data(&self, n: &notice_entity::Model) -> Option<Value> {
        let row = svc::get_row(&self.db.conn, n.timeline_id?)
            .await
            .ok()
            .flatten()?;
        serde_json::from_str(row.data.as_deref()?).ok()
    }

    /// Look, in the background, for look `gen` of the card — once: a look
    /// already on its way for it is not started again.
    fn look_for_starter(
        self: &Arc<Self>,
        notice_id: i32,
        gen: i64,
        projects: Vec<Project>,
        seen: HashSet<String>,
    ) {
        if !LOOKING
            .lock()
            .map(|mut l| l.insert((Arc::as_ptr(self) as usize, notice_id, gen)))
            .unwrap_or(false)
        {
            return;
        }
        let this = self.clone();
        tokio::spawn(async move {
            let found = tokio::time::timeout(
                starter::FIND_TIMEOUT,
                starter::find(
                    &this.db,
                    &LiveForge { db: &this.db },
                    &projects,
                    &seen,
                    chrono::Utc::now(),
                ),
            )
            .await
            .ok()
            .flatten();
            this.settle_starter(notice_id, gen, found).await;
            if let Ok(mut l) = LOOKING.lock() {
                l.remove(&(Arc::as_ptr(&this) as usize, notice_id, gen));
            }
        });
    }

    /// What look `gen` found, onto the card: the lead, or nothing (the card
    /// then just says it keeps an eye on them). Only onto the card still
    /// looking for that look — a later [Another one] made it another.
    pub(super) async fn settle_starter(&self, notice_id: i32, gen: i64, found: Option<Value>) {
        let _one = MEET.lock().await;
        let Ok(Some(n)) = svc::get_notice(&self.db.conn, notice_id).await else {
            return;
        };
        if n.state != NoticeState::Open {
            return;
        }
        let Some(row_id) = n.timeline_id else {
            return;
        };
        let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await else {
            return;
        };
        let mut data: Value = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str(d).ok())
            .unwrap_or_default();
        if data["state"] != "looking" || data["gen"].as_i64().unwrap_or(0) != gen {
            return;
        }
        let body = match found.as_ref() {
            Some(lead) => format!("I can help with this first: {}", lead_line(lead)),
            None => "Nothing needs fixing right now; I'll keep an eye on it.".into(),
        };
        let none = found.is_none();
        match found {
            Some(lead) => {
                data["state"] = "found".into();
                data["lead"] = lead;
            }
            None => {
                data["state"] = "none".into();
                data["lead"] = Value::Null;
            }
        }
        if svc::update_row_data(&self.db.conn, row_id, Some(body), Some(data))
            .await
            .is_err()
        {
            return;
        }
        // Nothing to offer: nothing left to answer.
        if none {
            let _ = svc::move_notice(
                &self.db.conn,
                n.id,
                &[NoticeState::Open],
                NoticeState::Acted,
            )
            .await;
        }
        if let Ok(Some(row)) = svc::get_row(&self.db.conn, row_id).await {
            self.emit_rows(vec![svc::to_row(row)]);
        }
    }

    /// The owner's answer on the first-thing card: `hand` (with the words of
    /// the message to send), `next`, `dismiss`.
    pub(super) async fn act_on_starter(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
        text: Option<String>,
    ) -> Result<TimelineRow, String> {
        let _one = MEET.lock().await;
        let notice = svc::get_notice(&self.db.conn, notice.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
        let data = self
            .card_data(&notice)
            .await
            .ok_or("the card's row is missing")?;
        if notice.state != NoticeState::Open || data["state"] != "found" {
            return Err(match data["state"].as_str() {
                Some("looking") => "still looking".into(),
                _ => "this card was answered already".into(),
            });
        }
        match action {
            "hand" => {
                let lead = &data["lead"];
                let text = text
                    .map(|t| t.trim().chars().take(2_000).collect::<String>())
                    .filter(|t| !t.is_empty())
                    .unwrap_or_else(|| hand_text(lead));
                let mut handed = data.clone();
                handed["state"] = "handed".into();
                // The message and the card's "handed" are written together.
                self.queue_owner_message(text, Vec::new(), Some(row_id), None, None, Some(handed))
                    .await?;
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acted,
                )
                .await;
                let row = svc::get_row(&self.db.conn, row_id)
                    .await
                    .map_err(|e| e.to_string())?
                    .ok_or("the card's row is missing")?;
                Ok(svc::to_row(row))
            }
            "next" => {
                let (projects, mut seen) = starter_inputs(&data);
                if let Some(k) = data["lead"]["key"].as_str() {
                    seen.insert(k.to_string());
                }
                let mut seen_list: Vec<&String> = seen.iter().collect();
                seen_list.sort();
                let seen_json = json!(seen_list);
                let gen = data["gen"].as_i64().unwrap_or(0) + 1;
                let row = self
                    .set_card_data(&notice, |d| {
                        d["state"] = "looking".into();
                        d["seen"] = seen_json;
                        d["gen"] = gen.into();
                    })
                    .await?;
                self.look_for_starter(notice.id, gen, projects, seen);
                Ok(row)
            }
            "dismiss" => {
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Dismissed,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                self.set_card_data(&notice, |d| d["state"] = "dismissed".into())
                    .await
            }
            _ => Err("`action` must be hand, next or dismiss".into()),
        }
    }

    // ── 4. what the assistants do on their own ──────────────────────────────

    async fn raise_promises(&self) -> Result<Option<TimelineRow>, String> {
        self.raise_meet_card(
            NoticeKind::Onboarding,
            PROMISES_SUBJECT,
            "What I'll do on my own".into(),
            json!({ "notice": "onboarding", "purpose": "promises", "state": "open" }),
            json!({ "purpose": "promises" }),
        )
        .await
    }

    /// [Build a team]: a suggestion card of the three work assistants a
    /// coder starts with — development, review, fixing CI — for the projects
    /// connected; the owner ticks which to make (4.12).
    async fn suggest_team(&self) -> Result<i32, String> {
        let primary = self
            .agent_row()
            .await
            .ok_or("configure the personal agent first")?;
        if primary.kind != BotKind::Primary {
            return Err("only the primary assistant suggests a team".into());
        }
        let locale = self.owner_locale(&primary, None).await;
        let projects: Vec<String> = {
            let ids: Vec<i64> = self
                .meet_record()
                .await
                .and_then(|m| m["projects"].as_array().cloned())
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_i64)
                .collect();
            let mut names = Vec::new();
            for id in ids {
                if let Some(f) = folder_model(&self.db, id as i32).await {
                    names.push(project_name(&f));
                }
            }
            names
        };
        let team: Vec<Value> = TEAM
            .iter()
            .map(|id| {
                json!({
                    "name": templates::text(locale, id).map(|t| t.name.clone()).unwrap_or_else(|| (*id).to_string()),
                    "template": id,
                })
            })
            .collect();
        self.raise_bots_card(
            "suggest",
            &[],
            Some(json!({ "team": team, "projects": projects })),
            None,
            None,
        )
        .await
    }
}

impl PersonalAgentEngine {
    /// The owner made the team suggested: `accept` all of it, `accept:dev,ci`
    /// the ones ticked. The card stays open while they are made and records
    /// each as it is made — and the one being made — so a run cut off is
    /// finished by answering again, without making any twice; then each
    /// has its [Undo]. One that could not be made says why.
    pub(super) async fn accept_team(
        &self,
        notice_id: i32,
        row_id: i32,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let _one = MEET.lock().await;
        let notice = svc::get_notice(&self.db.conn, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        if notice.state != NoticeState::Open {
            return Err("this card was answered already".into());
        }
        let row = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let mut data: Value = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str(d).ok())
            .unwrap_or_else(|| json!({}));
        let team: Vec<Value> = data["pending"]["team"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let picked: Vec<Value> = match action.strip_prefix("accept:") {
            None => team,
            Some(list) => {
                let want: Vec<&str> = list
                    .split(',')
                    .map(str::trim)
                    .filter(|k| !k.is_empty())
                    .collect();
                for k in &want {
                    if !team.iter().any(|m| m["template"].as_str() == Some(*k)) {
                        return Err(format!("the team has no `{k}`"));
                    }
                }
                team.into_iter()
                    .filter(|m| m["template"].as_str().is_some_and(|t| want.contains(&t)))
                    .collect()
            }
        };
        if picked.is_empty() {
            return Err("tick at least one to make".into());
        }
        let locale = self.locale_now().await;
        let mut bots: Vec<Value> = data["bots"].as_array().cloned().unwrap_or_default();
        let has = |bots: &[Value], template: &str| {
            bots.iter()
                .any(|b| b["template"].as_str() == Some(template))
        };
        // The one being made when codeg stopped: the assistant made under
        // the uid it was given, if it got that far.
        if let Some(uid) = data["making"]["uid"].as_str().map(str::to_string) {
            let known = bots.iter().any(|b| b["uid"].as_str() == Some(uid.as_str()));
            if !known {
                if let Some(found) = self.made_as(&uid, locale).await {
                    bots.push(found);
                }
            }
            data["making"] = Value::Null;
        }
        let mut errors: Vec<String> = Vec::new();
        for member in &picked {
            let template = member["template"].as_str().unwrap_or_default().to_string();
            if has(&bots, &template) {
                continue;
            }
            let uid = svc::new_bot_uid();
            data["bots"] = json!(bots);
            data["making"] = json!({ "template": template, "uid": uid });
            svc::update_row_data(&self.db.conn, row_id, None, Some(data.clone()))
                .await
                .map_err(|e| e.to_string())?;
            match self.create_from_call_as(member, Some(uid)).await {
                Ok(m) => bots.push(super::bots::made_json(&m, locale)),
                Err(e) => errors.push(format!(
                    "{}: {}",
                    member["name"].as_str().unwrap_or_default(),
                    e.message()
                )),
            }
            data["bots"] = json!(bots);
            data["making"] = Value::Null;
            svc::update_row_data(&self.db.conn, row_id, None, Some(data.clone()))
                .await
                .map_err(|e| e.to_string())?;
        }
        if bots.is_empty() {
            data["error"] = errors
                .first()
                .cloned()
                .map(Value::from)
                .unwrap_or(Value::Null);
            let _ = self.write_card(row_id, data).await;
            return Err(errors.join("; "));
        }
        data["state"] = "applied".into();
        data["error"] = errors
            .first()
            .cloned()
            .map(Value::from)
            .unwrap_or(Value::Null);
        // Answered and recorded together: a stop between the two would leave
        // a card that can neither be answered again nor undone.
        if !svc::move_notice_with_data(
            &self.db.conn,
            notice.id,
            &[NoticeState::Open],
            NoticeState::Acted,
            row_id,
            &data,
        )
        .await
        .map_err(|e| e.to_string())?
        {
            return Err("this card was answered already".into());
        }
        let card = self.write_card(row_id, data).await?;
        self.tell_bots(
            &notice,
            &format!(
                "The owner made the work assistants {} from the team suggested on card #{}.",
                bots.iter()
                    .map(|b| format!(
                        "{} (#{})",
                        b["name"].as_str().unwrap_or_default(),
                        b["bot_id"]
                    ))
                    .collect::<Vec<_>>()
                    .join(", "),
                notice.id
            ),
        )
        .await;
        Ok(card)
    }

    /// The work assistant made under `uid` — one a run cut off made — as
    /// the card lists it. Its executor config was made with it (a team
    /// member's always is) when it has one.
    async fn made_as(&self, uid: &str, locale: AppLocale) -> Option<Value> {
        let bot = svc::list_bots(&self.db.conn)
            .await
            .ok()?
            .into_iter()
            .find(|b| b.kind == BotKind::Worker && b.uid.as_deref() == Some(uid))?;
        let template = bot.template.clone().unwrap_or_default();
        let template = template.as_str();
        let executor = match bot.executor_assistant_id {
            Some(id) => crate::db::service::assistant_service::get(&self.db.conn, id)
                .await
                .ok()
                .flatten(),
            None => None,
        };
        Some(json!({
            "bot_id": bot.id,
            "uid": bot.uid,
            "name": super::messages::display_name(&bot),
            "face": super::messages::bot_face(&bot),
            "template": template,
            "template_name": templates::text(locale, template).map(|t| t.name.clone()),
            "executor_id": executor.as_ref().map(|e| e.id),
            "executor_name": executor.as_ref().map(|e| e.name.clone()),
            "executor_agent": executor.as_ref().map(|e| e.label_snapshot.agent.clone()),
            // A team member's executor config is made with it.
            "executor_created": executor.is_some(),
            "picked": [],
            "brain_picked": [],
            "state": "made",
        }))
    }
}

/// The projects a first-thing card looks in, and what it showed already.
fn starter_inputs(data: &Value) -> (Vec<Project>, HashSet<String>) {
    let projects = data["projects"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    Some(Project {
                        id: i32::try_from(p["id"].as_i64()?).ok()?,
                        name: p["name"].as_str().unwrap_or_default().to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let seen = data["seen"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|k| k.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    (projects, seen)
}

/// A lead in a line, for the card's row (what the brain reads of it).
fn lead_line(lead: &Value) -> String {
    let project = lead["project"]["name"].as_str().unwrap_or_default();
    let n = lead["number"].as_i64().unwrap_or_default();
    let title = lead["title"].as_str().unwrap_or_default();
    match lead["kind"].as_str() {
        Some("pr_ci") => {
            let checks: Vec<&str> = lead["checks"]
                .as_array()
                .map(|a| a.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            format!(
                "{project} PR #{n}'s CI is red ({}) — {title}",
                checks.join(", ")
            )
        }
        Some("review") => format!("{project} PR #{n} waits on your review — {title}"),
        Some("issue") => format!("{project} issue #{n} is assigned to you — {title}"),
        Some("task") => format!("the board task \"{title}\" failed and no one is on it"),
        Some("worktree") => format!(
            "the worktree {title} has changes not committed for over a day ({})",
            lead["path"].as_str().unwrap_or_default()
        ),
        _ => title.to_string(),
    }
}

/// What [Hand it to me] says when the page did not word it.
fn hand_text(lead: &Value) -> String {
    let project = lead["project"]["name"].as_str().unwrap_or_default();
    let n = lead["number"].as_i64().unwrap_or_default();
    let url = lead["url"].as_str().unwrap_or_default();
    match lead["kind"].as_str() {
        Some("pr_ci") => format!("Fix the CI of {project} PR #{n}: {url}"),
        Some("review") => format!("Review {project} PR #{n}: {url}"),
        Some("issue") => format!("Handle {project} issue #{n}: {url}"),
        Some("task") => format!(
            "Handle the failed board task \"{}\" (#{})",
            lead["title"].as_str().unwrap_or_default(),
            lead["task_id"]
        ),
        Some("worktree") => format!(
            "Look at the uncommitted changes in the worktree {}",
            lead["path"].as_str().unwrap_or_default()
        ),
        _ => lead_line(lead),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_to_call_the_owner_replaces_its_line_or_comes_last() {
        let line = "- Call them: ";
        let fresh = "# The owner\n\n(What you learn about the owner.)\n";
        assert_eq!(
            with_call(fresh, line, "Sam"),
            "# The owner\n\n(What you learn about the owner.)\n\n- Call them: Sam\n"
        );
        let again = with_call(&with_call(fresh, line, "Sam"), line, "Sammy");
        assert_eq!(again.matches("- Call them:").count(), 1);
        assert!(again.ends_with("- Call them: Sammy\n"));
        assert_eq!(with_call("", line, "Sam"), "- Call them: Sam\n");
    }

    #[test]
    fn a_lead_reads_in_a_line_and_hands_over_with_its_link() {
        let lead = json!({
            "kind": "pr_ci",
            "project": { "id": 1, "name": "app" },
            "number": 231,
            "title": "Speed up",
            "url": "https://github.com/a/app/pull/231",
            "checks": ["lint"],
        });
        assert_eq!(
            lead_line(&lead),
            "app PR #231's CI is red (lint) — Speed up"
        );
        assert_eq!(
            hand_text(&lead),
            "Fix the CI of app PR #231: https://github.com/a/app/pull/231"
        );
    }
}
