//! Getting to know the owner (5.4, 1.15). Once the primary's brain is first
//! picked, its conversation shows, one after the other, native cards — no
//! model is asked:
//!
//! 1. **What to call each other**: a choice card of two questions — what to
//!    call the owner (their system user name, or their own words) and what
//!    to call the assistant (its name, or a new one). The first goes into
//!    `USER.md`, the second is its name.
//! 2. **One thing right away?** A question, nothing to pick: the
//!    assistants keep an eye on the owner's projects (every one, unless the
//!    owner picked some in the settings — `prefs.projects`); shall it look
//!    for one thing it can help with now? [Find one] or [Not now].
//! 3. **One thing at once** (`starter.rs`): the first thing an assistant can
//!    take off their hands in the projects watched — [Hand it to me] sends it as
//!    the owner's message, [Another one], [Not now]. With nothing to offer it
//!    says it keeps an eye on them.
//! 4. **What the assistants do on their own**: how much they may disturb
//!    the owner and the switches of what they do unasked, with the
//!    preferences and the desktop companion. A helper of their own is the
//!    primary's to make when they ask it for one.
//!
//! The record lives on the primary's settings, under `meet`: how it began.
//! Each card is raised once (by its subject).

use std::collections::HashSet;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use super::engine::{brain_of, PersonalAgentEngine};
use super::starter::{self, LiveForge, Project};
use super::workdir;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::models::personal_agent::{PersonalAgentChange, PersonalAgentDraft, TimelineRow};
use crate::models::system::AppLocale;

/// The record, on the primary's settings.
pub const MEET_KEY: &str = "meet";
const NAME_SUBJECT: &str = "meet:name";
const CONNECT_SUBJECT: &str = "meet:connect";
const STARTER_SUBJECT: &str = "meet:starter";
const PROMISES_SUBJECT: &str = "meet:promises";
/// The longest a name for the owner may be.
const CALL_MAX: usize = 60;
/// One at a time in this process: a card raised once, a starter moved once.
static MEET: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// The looks on their way, by engine, card and look.
static LOOKING: std::sync::LazyLock<std::sync::Mutex<HashSet<(usize, i32, i64)>>> =
    std::sync::LazyLock::new(Default::default);

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

    /// Raise a card of getting to know the owner, once: `None` when it was
    /// raised already.
    pub(super) async fn raise_meet_card(
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

    /// At start: a card of one thing at once still looking where it left
    /// off.
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
            let line = words(locale).call_line;
            // Read and written under the directory's lock, with every
            // other write of it.
            let written = workdir::write_for_owner(
                &dir,
                &[(workdir::USER_FILE, &|now| {
                    Some(with_call(now.unwrap_or_default(), line, c))
                })],
                "owner: what to call them",
            )
            .await;
            if let Err(e) = written {
                tracing::warn!("[personal-agent] USER.md was not written: {e}");
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
            tracing::warn!("[personal-agent] the card asking to find one thing was not written: {e}");
        }
        Ok(row)
    }

    // ── 2. one thing right away? ────────────────────────────────────────────

    async fn raise_connect(&self) -> Result<Option<TimelineRow>, String> {
        self.raise_meet_card(
            NoticeKind::Onboarding,
            CONNECT_SUBJECT,
            "Shall I find one thing I can help with right away?".into(),
            json!({ "notice": "onboarding", "purpose": "connect", "state": "open" }),
            json!({ "purpose": "connect" }),
        )
        .await
    }

    /// The owner said [Find one]: one thing at once in the projects watched,
    /// and what the assistants do on their own.
    pub async fn meet_go(self: &Arc<Self>, notice_id: i32) -> Result<TimelineRow, String> {
        let notice = svc::get_notice_of(&self.db.conn, self.bot().await, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        if notice.kind != NoticeKind::Onboarding || payload_of(&notice)["purpose"] != "connect" {
            return Err("this is not the card asking to find one thing".into());
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
        let projects: Vec<Project> =
            super::projects::watched_projects(&self.db, &self.prefs().await)
                .await
                .iter()
                .map(|f| Project {
                    id: f.id,
                    name: super::projects::project_name(f),
                })
                .collect();
        let row = self
            .set_card_data(&notice, |d| d["state"] = "connected".into())
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

    /// Of the projects a first-thing card looks in, the ones still watched.
    async fn still_watched(&self, projects: Vec<Project>) -> Vec<Project> {
        let watched: HashSet<i32> =
            super::projects::watched_projects(&self.db, &self.prefs().await)
                .await
                .iter()
                .map(|f| f.id)
                .collect();
        projects
            .into_iter()
            .filter(|p| watched.contains(&p.id))
            .collect()
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
    /// card asking to find one thing; `done` on what the assistants do.
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
            ("connect", _) => Err("`action` must be skip".into()),
            ("promises", _) => Err("`action` must be done".into()),
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
        let projects = self.still_watched(projects).await;
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
                self.queue_owner_message(text, Vec::new(), Some(row_id), super::engine::Origin::Written, None, Some(handed))
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
                let projects = self.still_watched(projects).await;
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
