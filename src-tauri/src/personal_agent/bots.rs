//! Assistants come and go (4.12, 4.14): made from a name and, when given, a
//! persona — its brain the primary's, the agent its work runs on a copy of
//! the brain or one picked (D1: copied when it is made, its own from then
//! on) — copied and deleted. Its brain first wakes when it has something to
//! do.
//!
//! The assistants make them too (`bot_create`): on the owner's word at
//! once, with a card that undoes it; on their own idea, as a card that
//! makes it when the owner says so.

use std::sync::Arc;

use serde_json::{json, Value};

use super::engine::{brain_of, settings_of, text_digest, PersonalAgentEngine};
use super::messages::{bot_face, display_name, Unnamed};
use super::options::{self, Partial};
use super::tools::ToolOutcome;
use super::workdir;
use crate::db::entities::personal_agent::{self as agent_entity, BotKind};
use crate::db::entities::personal_agent_message::MessageState;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_message_service as msvc;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{
    AgentColumns, ItemWrite, NewNotice, NewRow, NewWorker,
};
use crate::models::assistant::AssistantAgentConfig;
use crate::models::personal_agent::{PersonalAgentChange, PersonalAgentSettings, TimelineRow};
use crate::models::personal_agent_bots::{
    BotAvatar, BotDeleteOptions, BotImpact, ImpactWork, PickedFrom, PickedOption,
};
use crate::models::system::AppLocale;
use crate::models::AgentType;

/// Days a declined suggestion to make an assistant of a name stays declined.
const SUGGEST_MUTE_DAYS: i64 = 7;
/// Longest name.
const MAX_NAME_CHARS: usize = 40;

/// What a new assistant's work runs on (D1), written into its own row: its
/// own from then on, whatever happens to its brain.
#[derive(Debug, Clone, PartialEq)]
pub enum WorkSpec {
    /// A copy of its brain: the agent and every option the same.
    SameAsBrain,
    /// This complete selection (the page's editor).
    Config(AssistantAgentConfig),
    /// On `agent_type`, keeping what `given` names and filling the rest in
    /// (the `bot_create` tool's).
    Fill { agent_type: AgentType, given: Partial },
}

/// A work assistant to make.
#[derive(Debug, Clone)]
pub struct BotSpec {
    pub name: String,
    pub uid: Option<String>,
    /// Its persona's first paragraph — who it is, what work is for it; the
    /// default sentence when `None`.
    pub persona: Option<String>,
    pub avatar: Option<BotAvatar>,
    /// Its brain; the primary's when `None`.
    pub brain: Option<AssistantAgentConfig>,
    /// The options picked for the brain, when codeg filled them in.
    pub brain_picked: Vec<PickedOption>,
    pub work: WorkSpec,
    /// Its work's standing instructions (a copy's).
    pub work_instructions: Option<String>,
    pub locale: Option<String>,
    /// Its own settings to start from (a copy's), and its files.
    pub settings: Option<PersonalAgentSettings>,
    pub files: Option<(String, String)>,
    pub notify: bool,
    /// What its introduction carries (§1.3, D7).
    pub intro: Intro,
}

/// What a new work assistant's introduction carries: the words it was made
/// on — the persona the owner wrote in the dialog, or their own words the
/// assistant that made it quoted, checked to be what they typed — and the
/// one it was copied from.
#[derive(Debug, Clone, Default)]
pub struct Intro {
    pub words: Option<String>,
    pub copied_from: Option<String>,
}

/// The event that wakes a new work assistant to introduce itself.
pub const INTRO_EVENT: &str = "intro";

/// The card after a new work assistant's introduction, by its subject: one
/// per assistant.
const INTRO_CARD_SUBJECT: &str = "intro:work";

/// The card after an introduction in the owner's language: its question,
/// and the common kinds of work it offers.
fn intro_card_words(locale: AppLocale) -> (&'static str, [&'static str; 4]) {
    match locale {
        AppLocale::En => (
            "What would you most like me to help with?",
            [
                "Writing code and changing repositories",
                "Looking things up and research",
                "Timed reminders and keeping watch",
                "Everyday chores",
            ],
        ),
        AppLocale::ZhCn => (
            "你最希望我先帮你做哪类事？",
            [
                "写代码和改仓库",
                "查资料和做调研",
                "定时提醒和监控",
                "处理日常杂事",
            ],
        ),
        AppLocale::ZhTw => (
            "你最希望我先幫你做哪類事？",
            [
                "寫程式和改倉庫",
                "查資料和做調研",
                "定時提醒和監控",
                "處理日常雜事",
            ],
        ),
        AppLocale::Ja => (
            "まず、どんなことを手伝ってほしいですか？",
            [
                "コードを書いてリポジトリを変更する",
                "調べものとリサーチ",
                "定時のリマインドと監視",
                "日々の雑務",
            ],
        ),
        AppLocale::Ko => (
            "제가 가장 먼저 도와드렸으면 하는 일은 무엇인가요?",
            [
                "코드 작성과 저장소 수정",
                "자료 조사와 리서치",
                "정기 알림과 모니터링",
                "일상적인 잡무",
            ],
        ),
        AppLocale::Es => (
            "¿En qué te gustaría que te ayudara sobre todo?",
            [
                "Escribir código y cambiar repositorios",
                "Buscar información e investigar",
                "Recordatorios programados y vigilancia",
                "Tareas del día a día",
            ],
        ),
        AppLocale::De => (
            "Wobei soll ich dir vor allem helfen?",
            [
                "Code schreiben und Repositorys ändern",
                "Recherchieren und nachschlagen",
                "Geplante Erinnerungen und Überwachung",
                "Alltägliche Aufgaben",
            ],
        ),
        AppLocale::Fr => (
            "Pour quoi aimerais-tu surtout que je t'aide ?",
            [
                "Écrire du code et modifier des dépôts",
                "Chercher des informations et faire des recherches",
                "Rappels programmés et surveillance",
                "Les tâches du quotidien",
            ],
        ),
        AppLocale::Pt => (
            "Em que você mais gostaria que eu ajudasse?",
            [
                "Escrever código e alterar repositórios",
                "Pesquisar e levantar informações",
                "Lembretes agendados e monitoramento",
                "Tarefas do dia a dia",
            ],
        ),
        AppLocale::Ar => (
            "في أي نوع من العمل تريدني أن أساعدك أولًا؟",
            [
                "كتابة الشيفرة وتعديل المستودعات",
                "البحث وجمع المعلومات",
                "التذكيرات المجدولة والمراقبة",
                "المهام اليومية",
            ],
        ),
    }
}

/// Whether an event is a new assistant's introduction.
pub(super) fn is_intro_event(e: &crate::db::entities::personal_agent_event::Model) -> bool {
    e.kind == INTRO_EVENT
}

impl BotSpec {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            uid: None,
            persona: None,
            avatar: None,
            brain: None,
            brain_picked: Vec::new(),
            work: WorkSpec::SameAsBrain,
            work_instructions: None,
            locale: None,
            settings: None,
            files: None,
            notify: true,
            intro: Intro::default(),
        }
    }
}

/// A work assistant made.
#[derive(Debug, Clone)]
pub struct Made {
    pub bot: agent_entity::Model,
    /// What its work runs on.
    pub work: AssistantAgentConfig,
    /// What codeg picked for the owner on it.
    pub picked: Vec<PickedOption>,
    pub brain_picked: Vec<PickedOption>,
}

/// Why it was not made.
#[derive(Debug, Clone)]
pub enum CreateError {
    Refused(String),
    /// The agent's options could not be read: the page opens the editor,
    /// prefilled, instead.
    OptionsUnavailable { agent_type: AgentType, why: String },
}

impl CreateError {
    pub fn message(&self) -> String {
        match self {
            CreateError::Refused(e) => e.clone(),
            CreateError::OptionsUnavailable {
                agent_type, why, ..
            } => format!(
                "codeg could not read the options of {}: {why}",
                crate::acp::registry::get_agent_meta(*agent_type).name
            ),
        }
    }
}

fn clean_name(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(MAX_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn uid_ok(uid: &str) -> bool {
    uid.len() == 32
        && uid
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// The one requirement of a brain: its tools come from codeg-mcp, so the
/// agent must take MCP servers over the wire.
pub(super) fn check_brain(config: &AssistantAgentConfig) -> Result<(), String> {
    crate::db::service::assistant_service::validate_agent_config(config)
        .map_err(|e| e.to_string())?;
    if !crate::acp::registry::get_agent_meta(config.agent_type).supports_mcp
        || !crate::acp::connection::agent_delivers_wire_mcp(config.agent_type)
    {
        return Err(format!(
            "{} cannot be an assistant's brain: it does not take codeg's MCP tools",
            config.label_snapshot.agent
        ));
    }
    Ok(())
}

fn picked_json(picked: &[PickedOption]) -> Value {
    serde_json::to_value(picked).unwrap_or(Value::Null)
}

/// "model = Sonnet, effort = High": what codeg picked, for a tool's answer.
fn picked_text(picked: &[PickedOption]) -> String {
    picked
        .iter()
        .filter(|p| p.from != PickedFrom::Given)
        .map(|p| format!("{} = {}", p.name, p.value_label))
        .collect::<Vec<_>>()
        .join(", ")
}

impl PersonalAgentEngine {
    // ── making one ──────────────────────────────────────────────────────────

    /// Make a work assistant: its row with the primary's brain (or the one
    /// given) and what its work runs on, its working directory with its
    /// role's files, and — when asked — its opening card. Its brain does
    /// not run until it has something to do.
    pub async fn create_bot(&self, spec: BotSpec) -> Result<Made, CreateError> {
        let refused = CreateError::Refused;
        let name = clean_name(&spec.name);
        if name.is_empty() {
            return Err(refused("a work assistant needs a name".into()));
        }
        let primary = svc::primary_bot(&self.db.conn)
            .await
            .map_err(|e| refused(e.to_string()))?
            .ok_or_else(|| refused("set the primary assistant up first".into()))?;
        let brain = match spec.brain.clone() {
            Some(b) => {
                check_brain(&b).map_err(refused)?;
                b
            }
            None => brain_of(&primary)
                .ok_or_else(|| refused("set the primary assistant's brain up first".into()))?,
        };
        let locale = self.owner_locale(&primary, spec.locale.as_deref()).await;
        let uid = match spec.uid.as_deref().filter(|u| uid_ok(u)) {
            Some(u) if !svc::uid_taken(&self.db.conn, u).await.unwrap_or(true) => u.to_string(),
            _ => svc::new_bot_uid(),
        };
        let avatar = match spec.avatar.clone() {
            Some(a) => {
                a.validate().map_err(refused)?;
                a
            }
            None => BotAvatar::default_for(&uid),
        };

        // What its work runs on (D1): the brain copied, every option the
        // same, or one picked — its own from now on.
        let (work, picked) = match spec.work.clone() {
            WorkSpec::SameAsBrain => (brain.clone(), Vec::new()),
            WorkSpec::Config(config) => {
                crate::db::service::assistant_service::validate_agent_config(&config)
                    .map_err(|e| refused(e.to_string()))?;
                (config, Vec::new())
            }
            WorkSpec::Fill { agent_type, given } => self
                .fill_options(agent_type, &given, &[])
                .await
                .map_err(|e| match e {
                    FillError::Unavailable(why) => {
                        CreateError::OptionsUnavailable { agent_type, why }
                    }
                    FillError::Refused(e) => refused(e),
                })?,
        };
        if let Some(text) = spec.work_instructions.as_deref() {
            if text.chars().count() > crate::models::personal_agent::MAX_WORK_INSTRUCTIONS_CHARS {
                return Err(refused(
                    "the standing instructions for its work are too long".into(),
                ));
            }
        }

        // The row.
        let settings = spec.settings.clone().unwrap_or_default().normalized();
        let mut new = NewWorker::made(
            name.clone(),
            serde_json::to_string(&avatar).unwrap_or_else(|_| "{}".into()),
            AgentColumns::of(&brain),
            AgentColumns::of(&work),
            crate::models::personal_agent::merge_settings_json("{}", &settings, false),
        );
        new.uid = Some(uid.clone());
        new.notify = spec.notify;
        new.work_instructions = spec.work_instructions.clone();
        // Its directory looked at and taken in one hold, before the row is
        // there for anything to start it: no other assistant's directory,
        // nor one inside or around it.
        let claim = workdir::WORKDIR_CLAIM.lock().await;
        let dir = self.data_dir.join(workdir::BOTS_DIR).join(&uid);
        let taken = match self.workdir_taken(0, &dir).await {
            Ok(Some(other)) => Some(format!(
                "its working directory {} is {other}'s, or inside it or around it",
                dir.display()
            )),
            Ok(None) => None,
            Err(e) => Some(e),
        };
        if let Some(why) = taken {
            drop(claim);
            return Err(refused(why));
        }
        let bot = match svc::create_worker(&self.db.conn, new).await {
            Ok(b) => b,
            Err(e) => return Err(refused(e.to_string())),
        };

        // Its working directory: its own persona and rules — a copy's as
        // the original has them, else the persona given (or the default
        // sentence, until it writes its own).
        // Each on its own: an empty or unreadable one is the default, the
        // other kept as written.
        let (given_soul, given_rules) = spec.files.clone().unwrap_or_default();
        let soul = Some(given_soul)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| super::templates::worker_soul(locale, spec.persona.as_deref()));
        let rules = Some(given_rules)
            .filter(|r| !r.trim().is_empty())
            .unwrap_or_else(|| super::templates::worker_rules(locale));
        let made = workdir::ensure_role_workdir(&dir, locale, &soul, &rules)
            .await
            .map_err(|e| format!("its working directory could not be made: {e}"));
        drop(claim);
        if let Err(e) = made {
            let _ = svc::delete_worker(&self.db.conn, bot.id).await;
            return Err(refused(e));
        }
        let cards = self.prefs().await.cards;
        // A new assistant has no process skills turned off.
        workdir::sync_bot_skill(
            &dir,
            brain.agent_type,
            settings.skill_enabled,
            true,
            cards,
            &Default::default(),
        );

        let made = Made {
            bot,
            work,
            picked,
            brain_picked: spec.brain_picked.clone(),
        };
        self.emit_for(made.bot.id, PersonalAgentChange::Agent);
        self.emit_for(primary.id, PersonalAgentChange::Agent);
        self.ask_to_introduce(&made.bot, &spec.intro).await;
        Ok(made)
    }

    /// Wake a new work assistant once to introduce itself (§1.3, D7): one
    /// event per assistant, queued as any other — the owner's messages go
    /// first in the turn that carries it.
    async fn ask_to_introduce(&self, bot: &agent_entity::Model, intro: &Intro) {
        let words = intro
            .words
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(|w| w.chars().take(2_000).collect::<String>());
        let inserted = svc::insert_event(
            &self.db.conn,
            bot.id,
            INTRO_EVENT,
            INTRO_EVENT,
            None,
            "You were just made: introduce yourself to the owner.".into(),
            Some(json!({ "words": words, "copied_from": intro.copied_from })),
            true,
        )
        .await;
        match inserted {
            Ok(true) => {
                if let Some(host) = self.host_ref() {
                    if let Some(engine) = host.engine_for(Some(bot.id)).await {
                        engine.nudge();
                    }
                }
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(
                "[personal-agent] {} was not asked to introduce itself: {e}",
                display_name(bot)
            ),
        }
    }

    /// What a new assistant's introduction hands over: what it was made on,
    /// and what to do (§1.3).
    pub(super) async fn intro_block(&self, e: &crate::db::entities::personal_agent_event::Model) -> String {
        let payload: Value = e
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or(Value::Null);
        let soul = match self.agent_row().await {
            Some(row) => workdir::read_text(&self.workdir_of(&row), workdir::SOUL_FILE),
            None => String::new(),
        };
        super::cards::intro_text(&super::cards::IntroInput {
            words: payload["words"].as_str(),
            copied_from: payload["copied_from"].as_str(),
            unwritten: super::templates::persona_unwritten(&soul),
        })
    }

    /// After a new work assistant's introduction (§1.3), when it was made
    /// on its name alone: codeg's card of what it should mostly help with —
    /// common kinds of work, or the owner's own words. A card, not the
    /// brain's `ask_user_question`, which would hold up whatever else comes
    /// for it until answered; the answer goes to it as the owner's message
    /// replying to the card. Raised once, after the reply it follows.
    pub(super) async fn raise_intro_card(&self, intro: &crate::db::entities::personal_agent_event::Model) {
        let payload: Value = intro
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or(Value::Null);
        if !super::cards::intro_card_due(payload["words"].as_str(), payload["copied_from"].as_str()) {
            return;
        }
        let (question, kinds) = intro_card_words(self.locale_now().await);
        let options: Vec<Value> = kinds
            .iter()
            .zip(['A', 'B', 'C', 'D'])
            .map(|(label, key)| json!({ "key": key.to_string(), "label": label }))
            .collect();
        let data = json!({
            "notice": "choice",
            "purpose": "intro",
            "state": "open",
            "options": options,
        });
        if let Err(e) = self
            .raise_meet_card(
                NoticeKind::Choice,
                INTRO_CARD_SUBJECT,
                question.to_string(),
                data,
                json!({ "purpose": "intro" }),
            )
            .await
        {
            tracing::warn!("[personal-agent] the card after the introduction was not written: {e}");
        }
    }

    /// A complete selection for `agent_type`: what is given, then another
    /// assistant's work on the same agent (the newest first), then the
    /// agent's own (10.5 "fill five").
    pub(super) async fn fill_options(
        &self,
        agent_type: AgentType,
        given: &Partial,
        extra_others: &[crate::acp::delegation::types::AgentDelegationDefaults],
    ) -> Result<(AssistantAgentConfig, Vec<PickedOption>), FillError> {
        let mut others: Vec<(chrono::DateTime<chrono::Utc>, AssistantAgentConfig)> =
            svc::list_bots(&self.db.conn)
                .await
                .unwrap_or_default()
                .iter()
                .filter_map(|b| super::engine::work_of_row(b).map(|w| (b.updated_at, w)))
                .filter(|(_, w)| w.agent_type == agent_type)
                .collect();
        others.sort_by_key(|(at, _)| std::cmp::Reverse(*at));
        let mut selections: Vec<_> = extra_others.to_vec();
        selections.extend(others.into_iter().map(|(_, w)| w.agent_options));
        let model = given
            .config_values
            .get(options::MODEL_ID)
            .map(|v| (options::MODEL_ID, v.as_str()));
        let snapshot = options::probe(&self.manager, &self.db, &self.data_dir, agent_type, model)
            .await
            .map_err(FillError::Unavailable)?;
        // The model first: what the other options offer can hang off it
        // (opencode's per-model effort). A model it does not start on is read
        // again with that model set, and everything else — what was given
        // included — is checked against what that model offers.
        let current =
            options::current_model(&snapshot).map(|(id, v)| (id.to_string(), v.to_string()));
        let chosen = options::resolve_model(&snapshot, given, &selections);
        let snapshot = match (chosen, current) {
            (Some((id, m)), Some((_, now))) if m != now => {
                match options::probe(
                    &self.manager,
                    &self.db,
                    &self.data_dir,
                    agent_type,
                    Some((&id, &m)),
                )
                .await
                {
                    Ok(again) if !again.unapplied_config_ids.contains(&id) => again,
                    // The agent would not take that model: what it offers as is.
                    _ => snapshot,
                }
            }
            _ => snapshot,
        };
        options::fill_selection(agent_type, &snapshot, given, &selections)
            .map_err(FillError::Refused)
    }

    // ── choice cards ────────────────────────────────────────────────────────

    /// The owner answers a choice card: the card keeps the answer, and it
    /// goes to the assistant as the owner's message — a new assistant's
    /// first, which wakes its brain (4.12).
    pub async fn answer_choice(
        &self,
        notice_id: i32,
        key: Option<&str>,
        text: Option<&str>,
        project: Option<i32>,
        answers: Option<&[super::meet::ChoicePick]>,
    ) -> Result<TimelineRow, String> {
        let notice = svc::get_notice_of(&self.db.conn, self.bot().await, notice_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no such card")?;
        if notice.kind != NoticeKind::Choice {
            return Err("this card has no choices".into());
        }
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
        // Getting to know the owner: what to call each other, answered whole
        // (5.4) — nothing goes to the brain.
        if data["purpose"] == "meet" {
            return self
                .answer_meet_name(&notice, row_id, data, answers.unwrap_or_default())
                .await;
        }
        let options = data["options"].as_array().cloned().unwrap_or_default();
        let own = text.map(str::trim).filter(|t| !t.is_empty());
        let picked = key
            .map(|k| k.trim().to_ascii_uppercase())
            .filter(|k| !k.is_empty());
        let other_key = ((b'A' + options.len() as u8) as char).to_string();
        // Their own answer is theirs as typed; a choice's words are the
        // assistant's.
        let origin = if matches!((picked.as_deref(), own), (Some(k), _) if k != other_key) {
            super::engine::Origin::Written
        } else {
            super::engine::Origin::Typed
        };
        let (answer, message) = match (picked.as_deref(), own) {
            (Some(k), _) if k != other_key => {
                let opt = options
                    .iter()
                    .find(|o| o["key"].as_str() == Some(k))
                    .ok_or_else(|| format!("no choice {k}"))?;
                let label = opt["label"].as_str().unwrap_or_default().to_string();
                let mut message = format!("{k}. {label}");
                let mut proj = Value::Null;
                if opt["project"].as_bool() == Some(true) {
                    let id = project.ok_or("this choice needs a project")?;
                    let folder =
                        crate::db::service::folder_service::get_folder_by_id(&self.db.conn, id)
                            .await
                            .map_err(|e| e.to_string())?
                            .ok_or_else(|| format!("no project #{id}"))?;
                    message = format!("{message} — {} (project #{})", folder.name, folder.id);
                    proj = json!({ "id": folder.id, "name": folder.name });
                }
                (
                    json!({ "key": k, "label": label, "project": proj }),
                    message,
                )
            }
            (_, Some(t)) => {
                let t: String = t.chars().take(4_000).collect();
                (json!({ "key": other_key, "text": t }), t)
            }
            _ => return Err("pick a choice, or write one of your own".into()),
        };
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
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), "answered".into());
            map.insert("answer".into(), answer);
        }
        svc::update_row_data(&self.db.conn, row_id, None, Some(data.clone()))
            .await
            .map_err(|e| e.to_string())?;
        if let Err(e) = self
            .queue_owner_message(message, Vec::new(), Some(row_id), origin, None, None)
            .await
        {
            // Not taken: the card stays to answer.
            let _ = svc::move_notice(
                &self.db.conn,
                notice.id,
                &[NoticeState::Acted],
                NoticeState::Open,
            )
            .await;
            if let Some(map) = data.as_object_mut() {
                map.insert("state".into(), "open".into());
                map.remove("answer");
            }
            let _ = svc::update_row_data(&self.db.conn, row_id, None, Some(data)).await;
            return Err(e);
        }
        let updated = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    // ── copying one ─────────────────────────────────────────────────────────

    /// Copy work assistant `id` (4.14): its brain, what its work runs on and
    /// its work's standing instructions, its persona, rules and own
    /// settings; not its memory, sessions or routines.
    pub async fn copy_bot(
        &self,
        id: i32,
        name: &str,
        locale: Option<&str>,
    ) -> Result<Made, CreateError> {
        let refused = CreateError::Refused;
        let src = svc::get_bot(&self.db.conn, id)
            .await
            .map_err(|e| refused(e.to_string()))?
            .filter(|b| b.kind == BotKind::Worker)
            .ok_or_else(|| refused("only a work assistant can be copied".into()))?;
        let dir = workdir::workdir_of_bot(&self.data_dir, &src);
        let mut spec = BotSpec::named(name);
        spec.brain = brain_of(&src);
        spec.work = match super::engine::work_of_row(&src) {
            Some(w) => WorkSpec::Config(w),
            None => WorkSpec::SameAsBrain,
        };
        spec.work_instructions = src.work_instructions.clone();
        spec.locale = locale.map(str::to_string);
        spec.settings = Some(settings_of(&src));
        // Its persona as it is — one not written into a directory yet
        // (converted, imported) as it came, written in the owner's language.
        let soul = if src.workdir_ready {
            workdir::read_text(&dir, workdir::SOUL_FILE)
        } else {
            spec.persona = src.seed_persona.clone();
            String::new()
        };
        spec.files = Some((soul, workdir::read_text(&dir, workdir::RULES_FILE)));
        spec.notify = src.notify;
        spec.intro.copied_from = Some(display_name(&src));
        self.create_bot(spec).await
    }

    // ── deleting one ────────────────────────────────────────────────────────

    /// What deleting work assistant `id` touches (4.14).
    pub async fn bot_impact(&self, id: i32) -> Result<BotImpact, String> {
        let row = svc::get_bot(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .filter(|b| b.kind == BotKind::Worker)
            .ok_or("only a work assistant can be deleted")?;
        let running =
            svc::list_dispatches(&self.db.conn, id, super::dispatch::LIVE_STATES, None, 200)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .map(|d| ImpactWork {
                    dispatch_id: d.id,
                    title: d.title,
                    mode: d.mode,
                    state: d.state,
                })
                .collect();
        let unanswered = msvc::messages_to(
            &self.db.conn,
            id,
            &[MessageState::Queued, MessageState::Delivered],
        )
        .await
        .map_err(|e| e.to_string())?
        .len() as u32;
        let dir = workdir::workdir_of_bot(&self.data_dir, &row);
        // Its plans stop; steps of other plans handed to it are picked
        // again by their plans' assistants (7.6).
        let plans = super::plans::impact_plans(&self.db, id).await;
        let plan_steps = super::plans::impact_steps(&self.db, id).await;
        Ok(BotImpact {
            bot_id: id,
            name: display_name(&row),
            running,
            unanswered_messages: unanswered,
            plans,
            plan_steps,
            workdir: dir.to_string_lossy().into_owned(),
            workdir_custom: row.workdir.as_deref().is_some_and(|w| !w.trim().is_empty()),
        })
    }

    /// Delete work assistant `id` (4.14): its running work handed to the
    /// primary to follow (or stopped), the messages it has not answered sent
    /// back to their senders, its engine stopped; its directory kept unless
    /// asked. With no primary yet (one converted on upgrade before it was
    /// set up, which cannot have handed work out) there is nobody to hand
    /// anything to: it is stopped. `worker` is its engine when one runs.
    pub async fn delete_bot(
        &self,
        id: i32,
        opts: &BotDeleteOptions,
        worker: Option<Arc<PersonalAgentEngine>>,
    ) -> Result<(), String> {
        let row = svc::get_bot(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .filter(|b| b.kind == BotKind::Worker)
            .ok_or("only a work assistant can be deleted")?;
        let primary = svc::primary_bot(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        let hand_to = primary.as_ref().filter(|_| opts.hand_over).map(|p| p.id);
        let name = display_name(&row);
        // Its engine first: nothing new starts while it goes.
        if let Some(h) = self.host_ref() {
            h.retire(id).await;
        } else if let Some(w) = worker.as_ref() {
            w.shutdown().await;
        }
        let live = svc::list_dispatches(&self.db.conn, id, super::dispatch::LIVE_STATES, None, 500)
            .await
            .map_err(|e| e.to_string())?;
        // The pull requests it watched (7.4): the primary follows them with
        // its work, or they are let go with it.
        {
            use crate::db::service::personal_agent_watch_service as wsvc;
            let moved = if let Some(to) = hand_to {
                wsvc::move_bot(&self.db.conn, id, to).await
            } else {
                wsvc::end_of_bot(&self.db.conn, id, "stopped").await
            };
            if let Err(e) = moved {
                tracing::warn!("[personal_agent] watches of #{id} not handed on: {e}");
            }
        }
        // Its routines go with it (4.14); the work they handed out is like
        // any other of its work.
        if let Err(e) =
            crate::db::service::personal_agent_routine_service::delete_of_bot(&self.db.conn, id).await
        {
            tracing::warn!("[personal_agent] routines of #{id} not deleted: {e}");
        }
        if let Some(primary_id) = hand_to {
            let ids: Vec<i32> = live.iter().map(|d| d.id).collect();
            // Their sessions' events go to the primary now (a session still
            // starting registers with it itself: `register_conn`) — one
            // route change at a time, the owner and the route together, so
            // neither overwrites the other's.
            let routes = super::dispatch::ROUTES.lock().await;
            svc::move_dispatches_to(&self.db.conn, &ids, primary_id)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(w) = worker.as_ref() {
                let conns = w.take_dispatch_conns(&ids).await;
                match self.host_ref() {
                    Some(h) => h.primary().adopt_dispatch_conns(conns).await,
                    None if self.bot().await == primary_id => {
                        self.adopt_dispatch_conns(conns).await
                    }
                    None => {}
                }
            }
            drop(routes);
            // Their acceptance cards are the primary's now (7.5).
            match self.host_ref() {
                Some(h) => h.primary().adopt_acceptances(&ids).await,
                None if self.bot().await == primary_id => self.adopt_acceptances(&ids).await,
                None => {}
            }
            if !live.is_empty() {
                let list = live
                    .iter()
                    .map(|d| format!("#{} \"{}\"", d.id, d.title))
                    .collect::<Vec<_>>()
                    .join(", ");
                let _ = svc::insert_event(
                    &self.db.conn,
                    primary_id,
                    "handed_over",
                    &format!("bot-deleted:{id}"),
                    None,
                    format!(
                        "The owner deleted the work assistant {name} and handed its running work to \
                         you to follow: {list}. Its events come to you from now on."
                    ),
                    Some(json!({ "bot_id": id, "dispatches": ids })),
                    true,
                )
                .await;
                if let Some(h) = self.host_ref() {
                    h.primary().nudge();
                }
                self.emit_for(primary_id, PersonalAgentChange::Status);
            }
        } else if let Some(w) = worker.as_ref() {
            for d in &live {
                w.stop_dispatch(d).await;
            }
        } else {
            for d in &live {
                self.stop_dispatch(d).await;
            }
        }
        // Its plans stop where they are: nothing new is handed out (7.6).
        super::plans::retire_plans_of(&self.db, id).await;
        // The messages it has not answered go back to their senders.
        let unanswered = msvc::messages_to(
            &self.db.conn,
            id,
            &[MessageState::Queued, MessageState::Delivered],
        )
        .await
        .map_err(|e| e.to_string())?;
        let ids: Vec<i32> = unanswered.iter().map(|m| m.id).collect();
        let _ = msvc::move_messages(
            &self.db.conn,
            &ids,
            &[MessageState::Queued, MessageState::Delivered],
            MessageState::Canceled,
        )
        .await;
        for m in &unanswered {
            self.return_to_sender(m, &name).await;
        }
        // The row read again, deleted and its directory removed in one hold
        // of the claim: the directory removed is the one it has now — not one
        // it moved off while this ran, which another assistant may have
        // taken since — and none is removed unless the row went.
        {
            // Its turn's settlement in flight done first — its commit in its
            // directory — and none after: the directory is let go only once
            // nothing of its own writes to it any more. (Taken before the
            // claim, as a move of the directory takes them.)
            let _settled = match worker.as_ref() {
                Some(w) => Some(w.settling().await),
                None => None,
            };
            let _claim = workdir::WORKDIR_CLAIM.lock().await;
            let now = svc::get_bot(&self.db.conn, id).await.map_err(|e| e.to_string())?;
            let deleted = svc::delete_worker(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?;
            if !deleted {
                return Err("this assistant was deleted already".into());
            }
            let own_default = now
                .as_ref()
                .filter(|now| now.workdir.as_deref().is_none_or(|w| w.trim().is_empty()));
            if let (true, Some(now)) = (opts.delete_workdir, own_default) {
                let dir = workdir::default_workdir_of_bot(&self.data_dir, now);
                // Never one another live assistant has (a directory shared
                // before such sharing was refused).
                // Not known to be no one else's: kept.
                let shared = self.workdir_taken(id, &dir).await;
                if let Ok(Some(other)) = &shared {
                    tracing::warn!(
                        "[personal-agent] {} kept: it is {other}'s working directory too",
                        dir.display()
                    );
                } else if let Err(e) = &shared {
                    tracing::warn!("[personal-agent] {} kept: {e}", dir.display());
                } else if workdir::is_workdir(&dir) {
                    if let Err(e) = std::fs::remove_dir_all(&dir) {
                        tracing::warn!("[personal-agent] {} was not removed: {e}", dir.display());
                    }
                }
            }
        }
        self.emit_for(id, PersonalAgentChange::Agent);
        if let Some(p) = primary.as_ref() {
            self.emit_for(p.id, PersonalAgentChange::Agent);
        }
        Ok(())
    }

    /// A message the deleted `receiver` will never answer: its sender hears
    /// so, and stops waiting for it.
    async fn return_to_sender(
        &self,
        m: &crate::db::entities::personal_agent_message::Model,
        receiver: &str,
    ) {
        for line in msvc::lines_of_message(&self.db.conn, m.id)
            .await
            .unwrap_or_default()
        {
            if line.bot_id != Some(m.from_bot_id) {
                continue;
            }
            if let Ok(Some(item)) =
                msvc::waiting_item_of_line(&self.db.conn, m.from_bot_id, line.id).await
            {
                let _ = svc::update_item(
                    &self.db.conn,
                    item.id,
                    ItemWrite {
                        status: Some(crate::db::entities::personal_agent_item::ItemStatus::Dropped),
                        waits_for: Some(None),
                        ..Default::default()
                    },
                )
                .await;
                self.emit_for(m.from_bot_id, PersonalAgentChange::Item { id: item.id });
            }
        }
        let excerpt: String = m.body.chars().take(200).collect();
        let _ = svc::insert_event(
            &self.db.conn,
            m.from_bot_id,
            "bot_gone",
            &format!("message-returned:{}", m.id),
            None,
            format!(
                "Your message m{} to {receiver} came back unanswered: the owner deleted {receiver}. \
                 It said: \"{excerpt}\"",
                m.id
            ),
            Some(json!({ "message_id": m.id })),
            true,
        )
        .await;
        if let Some(h) = self.host_ref() {
            if let Some(e) = h.engine_for(Some(m.from_bot_id)).await {
                e.nudge();
            }
        }
    }

    // ── the card that says so ───────────────────────────────────────────────

    /// A "changed" card about work assistants: made (`asked`), or
    /// waiting to be made (`show`, `suggest`, with the call to make it).
    pub(super) async fn raise_bots_card(
        &self,
        why: &str,
        made: &[Made],
        pending: Option<Value>,
        quoted: super::prefs::Quoted,
        reason: Option<String>,
    ) -> Result<i32, String> {
        let bots: Vec<Value> = made.iter().map(made_json).collect();
        let applied = why == "asked";
        let body = if applied {
            format!(
                "Made {}",
                made.iter()
                    .map(|m| display_name(&m.bot))
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        } else {
            format!(
                "Make a work assistant: {}",
                pending
                    .as_ref()
                    .and_then(|p| p["name"].as_str())
                    .unwrap_or_default()
            )
        };
        let mut row = NewRow::new(TimelineKind::Notice, body);
        row.segment_id = self.state.lock().await.connection_segment;
        let batch = self.ledger_batch().await.map(|(b, _)| b);
        row.batch_id = batch;
        row.data = Some(json!({
            "notice": "changed",
            "what": "bots",
            "state": if applied { "applied" } else { "open" },
            "why": why,
            "bots": bots,
            "pending": pending,
            "quote": quoted.quote,
            "unchecked_quote": quoted.unchecked,
            "reason": reason,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Changed,
                subject_key: None,
                level: if why == "suggest" {
                    NoticeLevel::Low
                } else {
                    NoticeLevel::Normal
                },
                batch_id: batch,
                payload: json!({
                    "why": why,
                    "what": "bots",
                    "bot": self.bot().await,
                    "pending": pending,
                }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        if applied {
            let _ = svc::move_notice(
                &self.db.conn,
                notice.id,
                &[NoticeState::Open],
                NoticeState::Acted,
            )
            .await;
        }
        self.emit_rows(vec![svc::to_row(card)]);
        self.emit(PersonalAgentChange::Status);
        Ok(notice.id)
    }

    /// The owner's answer on a card about work assistants: `undo` (all) or
    /// `undo:<id>` (one) deletes what it made; `accept` makes what waits;
    /// `dismiss` lets it be.
    pub(super) async fn act_on_bots_card(
        &self,
        notice: &notice_entity::Model,
        action: &str,
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
        let why = data["why"].as_str().unwrap_or("").to_string();
        if let Some(rest) = action.strip_prefix("undo") {
            let only: Option<i32> = match rest.strip_prefix(':') {
                Some(id) => Some(id.parse().map_err(|_| "undo takes an assistant's id")?),
                None if rest.is_empty() => None,
                None => return Err("`action` must be accept, dismiss, undo or undo:<id>".into()),
            };
            if notice.state != NoticeState::Acted {
                return Err("there is nothing on this card to undo".into());
            }
            let mut undone: Vec<String> = Vec::new();
            let mut errors: Vec<String> = Vec::new();
            if let Some(list) = data["bots"].as_array_mut() {
                for b in list.iter_mut() {
                    let id = b["bot_id"].as_i64().unwrap_or(0) as i32;
                    if only.is_some_and(|o| o != id) || b["state"].as_str() == Some("undone") {
                        continue;
                    }
                    let opts = BotDeleteOptions {
                        hand_over: true,
                        delete_workdir: false,
                    };
                    let worker = match self.host_ref() {
                        Some(h) => h.existing_worker(id).await,
                        None => None,
                    };
                    match svc::get_bot(&self.db.conn, id).await.ok().flatten() {
                        // Deleted since: nothing left to undo.
                        None => {}
                        Some(_) => {
                            if let Err(e) = self.delete_bot(id, &opts, worker).await {
                                errors.push(e);
                                continue;
                            }
                        }
                    }
                    b["state"] = "undone".into();
                    undone.push(b["name"].as_str().unwrap_or_default().to_string());
                }
            }
            if only.is_some() && undone.is_empty() && errors.is_empty() {
                return Err("that assistant is not on this card, or was undone already".into());
            }
            let all_undone = data["bots"]
                .as_array()
                .is_some_and(|l| l.iter().all(|b| b["state"].as_str() == Some("undone")));
            if all_undone {
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acted],
                    NoticeState::Undone,
                )
                .await;
                data["state"] = "undone".into();
            }
            data["error"] = errors
                .first()
                .cloned()
                .map(Value::from)
                .unwrap_or(Value::Null);
            let card = self.write_card(row_id, data).await?;
            if !undone.is_empty() {
                self.tell_bots(
                    notice,
                    &format!("The owner undid making {}: deleted.", undone.join(", ")),
                )
                .await;
            }
            if let Some(e) = errors.into_iter().next() {
                return Err(e);
            }
            return Ok(card);
        }
        match action {
            "accept" => {
                let pending = data["pending"].clone();
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Open],
                    NoticeState::Acting,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("this card was answered already".into());
                }
                // What it was made on is the card the owner accepted — its
                // persona — never words not checked to be theirs.
                match self.create_from_call(&pending, None).await {
                    Ok(m) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Acted,
                        )
                        .await;
                        data["bots"] = json!([made_json(&m)]);
                        data["state"] = "applied".into();
                        data["error"] = Value::Null;
                        let card = self.write_card(row_id, data).await?;
                        self.tell_bots(
                            notice,
                            &format!(
                                "The owner accepted card #{}: made the work assistant {} (#{}).",
                                notice.id,
                                display_name(&m.bot),
                                m.bot.id,
                            ),
                        )
                        .await;
                        Ok(card)
                    }
                    Err(e) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Open,
                        )
                        .await;
                        data["error"] = e.message().into();
                        if let CreateError::OptionsUnavailable { agent_type, .. } = &e {
                            data["editor"] = json!({ "agent_type": agent_type });
                        }
                        let _ = self.write_card(row_id, data).await;
                        Err(e.message())
                    }
                }
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
                data["state"] = "dismissed".into();
                let card = self.write_card(row_id, data.clone()).await?;
                let name = data["pending"]["name"].as_str().unwrap_or_default();
                self.tell_bots(
                    notice,
                    &if why == "suggest" {
                        format!(
                            "The owner declined your suggestion to make a work assistant \"{name}\" \
                             (card #{}); do not suggest it again for {SUGGEST_MUTE_DAYS} days.",
                            notice.id
                        )
                    } else {
                        format!("The owner declined making the work assistant \"{name}\" (card #{}).", notice.id)
                    },
                )
                .await;
                Ok(card)
            }
            _ => Err("`action` must be accept, dismiss, undo or undo:<id>".into()),
        }
    }

    pub(super) async fn locale_now(&self) -> AppLocale {
        match svc::primary_bot(&self.db.conn).await.ok().flatten() {
            Some(p) => self.owner_locale(&p, None).await,
            None => AppLocale::En,
        }
    }

    pub(super) async fn write_card(&self, row_id: i32, data: Value) -> Result<TimelineRow, String> {
        svc::update_row_data(&self.db.conn, row_id, None, Some(data))
            .await
            .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let row = svc::to_row(updated);
        self.emit_rows(vec![row.clone()]);
        self.emit(PersonalAgentChange::Status);
        Ok(row)
    }

    pub(super) async fn tell_bots(&self, notice: &notice_entity::Model, summary: &str) {
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "changed",
            &format!(
                "notice:{}:{}",
                notice.id,
                chrono::Utc::now().timestamp_millis()
            ),
            None,
            summary.to_string(),
            Some(json!({ "notice_id": notice.id })),
            false,
        )
        .await;
    }

    // ── bot_create ──────────────────────────────────────────────────────────

    /// `bot_create`: make a work assistant on the owner's word (a card
    /// undoes it), show it first when they asked to see such changes first,
    /// or suggest it. A re-delivered turn gets what the call first got.
    pub(super) async fn bot_create_call(&self, args: &Value) -> ToolOutcome {
        let text = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(1_000).collect::<String>())
        };
        let Some(name) = text("name")
            .map(|n| clean_name(&n))
            .filter(|n| !n.is_empty())
        else {
            return ToolOutcome::refused(
                "`name` is required: what the owner calls the new assistant",
            );
        };
        if text("persona").is_none() {
            return ToolOutcome::refused(
                "`persona` is required: who it is and what work is for it, concretely — the lines \
                 the assistants read to decide who does what",
            );
        }
        let suggest = args
            .get("suggest")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let quote = text("quote");
        let reason = text("reason");
        if suggest && reason.is_none() {
            return ToolOutcome::refused(
                "a suggestion needs `reason`: why a new assistant fits the owner",
            );
        }
        // The owner does not take suggestions now (6.7).
        if suggest {
            if let Some(no) = self.suggestions_closed().await {
                return no;
            }
        }
        if !suggest && quote.is_none() {
            return ToolOutcome::refused(
                "`quote` the owner's words this follows; an assistant you only think would help is a \
                 suggestion (`suggest: true` with a `reason`)",
            );
        }
        let mut call = args.clone();
        if let Some(map) = call.as_object_mut() {
            map.remove("for");
            map.insert("name".into(), name.clone().into());
        }
        let key = format!("bot_create|{}", text_digest(&call.to_string()));
        let ledger = self.ledger_batch().await;
        if let Some((_, scope)) = &ledger {
            match svc::ledger_entries(&self.db.conn, scope, &key).await {
                Ok(entries) => {
                    if let Some(e) = entries.into_iter().next() {
                        let data = e
                            .observed
                            .as_deref()
                            .and_then(|o| serde_json::from_str::<Value>(o).ok())
                            .unwrap_or(Value::Null);
                        return ToolOutcome::ok(
                            format!(
                                "Already done: the turn this delivery repeats made this same call, and \
                                 it answered: {}",
                                e.detail.unwrap_or_default()
                            ),
                            json!({ "earlier": true, "first": data }),
                        );
                    }
                }
                Err(e) => return ToolOutcome::refused(e.to_string()),
            }
        }
        if let Some(named) = args.get("for").and_then(|v| v.as_str()) {
            if let Err(e) = self.input_for(Some(named), Unnamed::Nothing).await {
                return ToolOutcome::refused(e);
            }
        }
        // The owner's words as they typed them this turn make it at once;
        // words not found there go on a card for them to confirm first.
        let unverified = match quote.as_deref() {
            Some(q) if !suggest => !self.owner_typed_it(q).await,
            _ => false,
        };
        let why = if suggest {
            "suggest"
        } else if unverified
            || self.prefs().await.chat_changes
                == crate::models::personal_agent_prefs::ChatChanges::Show
        {
            "show"
        } else {
            "asked"
        };
        let outcome = if why == "asked" {
            match self.create_from_call(&call, quote.clone()).await {
                Ok(m) => {
                    let card = match self
                        .raise_bots_card(
                            "asked",
                            std::slice::from_ref(&m),
                            None,
                            super::prefs::Quoted {
                                quote: quote.clone(),
                                unchecked: None,
                            },
                            None,
                        )
                        .await
                    {
                        Ok(id) => id,
                        Err(e) => {
                            tracing::warn!("[personal-agent] the card for {name} was not written: {e}");
                            0
                        }
                    };
                    let picked = picked_text(&m.picked);
                    ToolOutcome::ok(
                        format!(
                            "Made the work assistant {} (#{}). Its brain is {}; its work runs on {}{}. \
                             Message it with `bot_message`. The owner sees a card saying so, and can \
                             undo it there.",
                            display_name(&m.bot),
                            m.bot.id,
                            m.bot.agent_type.as_deref().unwrap_or("(none)"),
                            m.work.label_snapshot.agent,
                            if picked.is_empty() {
                                String::new()
                            } else {
                                format!(" (options codeg picked for the owner: {picked})")
                            },
                        ),
                        json!({
                            "notice_id": card,
                            "bot_id": m.bot.id,
                            "picked": picked_json(&m.picked),
                        }),
                    )
                }
                Err(CreateError::OptionsUnavailable { agent_type, why, .. }) => ToolOutcome::refused(format!(
                    "codeg could not read {}'s options ({why}), so it cannot fill them in. Name every \
                     option (`work_agent.options`), pick another agent, or ask the owner to make it from \
                     the roster's [+], where codeg opens the editor for them.",
                    crate::acp::registry::get_agent_meta(agent_type).name
                )),
                Err(CreateError::Refused(e)) => ToolOutcome::refused(e),
            }
        } else {
            if why == "suggest" {
                if let Some(refusal) = self.declined_name(&name).await {
                    return ToolOutcome::refused(refusal);
                }
            }
            // Words not found in what the owner typed — or a suggestion's,
            // never checked — are never shown as theirs: not on the card,
            // nor in the call it keeps.
            let mut pending = call.clone();
            let quoted = if unverified || suggest {
                if let Some(map) = pending.as_object_mut() {
                    map.remove("quote");
                }
                super::prefs::Quoted {
                    quote: None,
                    unchecked: quote.clone(),
                }
            } else {
                super::prefs::Quoted {
                    quote: quote.clone(),
                    unchecked: None,
                }
            };
            match self
                .raise_bots_card(why, &[], Some(pending), quoted, reason)
                .await
            {
                Ok(id) => ToolOutcome::ok(
                    if unverified {
                        format!(
                            "On a card for the owner to confirm first: make the work assistant \
                             \"{name}\". Your `quote` is not in what the owner typed this turn, so \
                             it does not make one by itself. Nothing is made yet; you will hear how \
                             they answered."
                        )
                    } else if why == "show" {
                        format!(
                            "On a card for the owner to confirm first (they asked to see such changes \
                             first): make the work assistant \"{name}\". Nothing is made yet; you will \
                             hear how they answered."
                        )
                    } else {
                        format!(
                            "Suggested on a card: make the work assistant \"{name}\". It is made only if \
                             the owner says so; you will hear how they answered."
                        )
                    },
                    json!({ "notice_id": id, "state": "open" }),
                ),
                Err(e) => ToolOutcome::refused(e),
            }
        };
        if let (true, Some((batch, _))) = (outcome.ok, &ledger) {
            let slot = svc::LedgerSlot::in_batch(*batch, key, super::ledger::fresh_op_id());
            if let Err(e) = svc::record_done_op(
                &self.db.conn,
                self.bot().await,
                &slot,
                "bot_create",
                call,
                &outcome.text,
                outcome.data.clone(),
            )
            .await
            {
                tracing::warn!("[personal-agent] bot_create was not put in the ledger: {e}");
            }
        }
        outcome
    }

    /// Why a suggestion to make `name` may not be made: the owner declined
    /// one for that name within the last week.
    async fn declined_name(&self, name: &str) -> Option<String> {
        let since = chrono::Utc::now() - chrono::Duration::days(SUGGEST_MUTE_DAYS);
        let key = name.trim().to_lowercase();
        for n in svc::notices_since(
            &self.db.conn,
            NoticeKind::Changed,
            &[NoticeState::Dismissed],
            since,
        )
        .await
        .unwrap_or_default()
        {
            let p: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if p["what"].as_str() != Some("bots") || p["why"].as_str() != Some("suggest") {
                continue;
            }
            if p["pending"]["name"]
                .as_str()
                .map(|s| s.trim().to_lowercase())
                == Some(key.clone())
            {
                return Some(format!(
                    "the owner declined making \"{name}\" on {}; do not suggest it again before {}",
                    n.updated_at.format("%Y-%m-%d"),
                    (n.updated_at + chrono::Duration::days(SUGGEST_MUTE_DAYS)).format("%Y-%m-%d")
                ));
            }
        }
        None
    }

    /// Make a work assistant from a `bot_create` call as made.
    pub(super) async fn create_from_call(
        &self,
        call: &Value,
        words: Option<String>,
    ) -> Result<Made, CreateError> {
        self.create_from_call_as(call, None, words).await
    }

    /// [`Self::create_from_call`], under a uid chosen beforehand (a team's
    /// member, found by it if a run is cut off).
    pub(super) async fn create_from_call_as(
        &self,
        call: &Value,
        uid: Option<String>,
        words: Option<String>,
    ) -> Result<Made, CreateError> {
        let refused = CreateError::Refused;
        let s = |k: &str| call.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let mut spec = BotSpec::named(s("name").unwrap_or_default());
        spec.uid = uid;
        spec.intro.words = words;
        spec.persona = s("persona");
        if let (Some(shape), Some(color)) = (s("shape"), s("color")) {
            spec.avatar = Some(BotAvatar::Face { shape, color });
        }
        let agent = |v: &Value| -> Result<Option<AgentType>, CreateError> {
            match v.get("agent_type").and_then(|a| a.as_str()) {
                None => Ok(None),
                Some(a) => AgentType::from_wire(a)
                    .map(Some)
                    .ok_or_else(|| CreateError::Refused(format!("no agent `{a}`"))),
            }
        };
        if let Some(b) = call.get("brain").filter(|b| !b.is_null()) {
            let given = Partial::from_json(b.get("options")).map_err(refused)?;
            let primary_brain = svc::primary_bot(&self.db.conn)
                .await
                .ok()
                .flatten()
                .and_then(|p| brain_of(&p));
            let agent_type = agent(b)?.or(primary_brain.as_ref().map(|p| p.agent_type));
            if let Some(agent_type) = agent_type {
                let same = primary_brain
                    .as_ref()
                    .filter(|p| p.agent_type == agent_type);
                if !(given == Partial::default() && same.is_some()) {
                    let extra: Vec<_> = same.map(|p| p.agent_options.clone()).into_iter().collect();
                    let (config, picked) = self
                        .fill_options(agent_type, &given, &extra)
                        .await
                        .map_err(|e| match e {
                            FillError::Unavailable(why) => {
                                CreateError::OptionsUnavailable { agent_type, why }
                            }
                            FillError::Refused(e) => refused(e),
                        })?;
                    spec.brain = Some(config);
                    spec.brain_picked = picked;
                }
            }
        }
        // The agent its work runs on (D1): a copy of its brain, unless
        // another agent, or options of its own, are named — then those, the
        // rest filled in.
        if let Some(e) = call.get("work_agent").filter(|e| !e.is_null()) {
            let given = Partial::from_json(e.get("options")).map_err(refused)?;
            let brain_agent = match spec.brain.as_ref() {
                Some(b) => Some(b.agent_type),
                None => svc::primary_bot(&self.db.conn)
                    .await
                    .ok()
                    .flatten()
                    .and_then(|p| brain_of(&p))
                    .map(|b| b.agent_type),
            };
            spec.work = match agent(e)?.or(brain_agent) {
                Some(a) if Some(a) == brain_agent && given == Partial::default() => {
                    WorkSpec::SameAsBrain
                }
                Some(agent_type) => WorkSpec::Fill { agent_type, given },
                None => WorkSpec::SameAsBrain,
            };
        }
        self.create_bot(spec).await
    }

    // ── dispatching ─────────────────────────────────────────────────────────

    /// The "who handed this out" block an execution carries (4.4).
    pub(super) async fn dispatcher_brief(&self) -> String {
        let Some(row) = self.agent_row().await else {
            return String::new();
        };
        let role = match row.kind {
            BotKind::Primary => "the owner's primary assistant".to_string(),
            BotKind::Worker => "one of the owner's work assistants".to_string(),
        };
        workdir::dispatcher_brief(&self.workdir_of(&row), &display_name(&row), &role)
    }

    /// Work of this assistant's running in the same project that a new
    /// dispatch may belong with (4.4): a session shares the project's
    /// checkout, so its branch; a task has its own. Only a reminder — the
    /// dispatch goes out either way.
    /// A reminder after work went out in a project where earlier work of
    /// this assistant's failed and its matter is still open (B1): if the new
    /// work retries it, that matter should not stay open beside it.
    pub(super) async fn open_failure_note(
        &self,
        made: &crate::db::entities::personal_agent_dispatch::Model,
    ) -> Option<String> {
        use crate::db::entities::personal_agent_dispatch::DispatchState;
        use crate::db::entities::personal_agent_item::ItemStatus;
        if made.replaces_id.is_some() {
            return None;
        }
        let failed = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            &[DispatchState::Failed, DispatchState::Interrupted],
            None,
            20,
        )
        .await
        .ok()?;
        let mut ids: Vec<i32> = Vec::new();
        for d in failed
            .iter()
            .filter(|d| d.id != made.id && d.folder_id == made.folder_id && d.replaced_by.is_none())
        {
            let open = svc::item_of_dispatch(&self.db.conn, d.id)
                .await
                .ok()
                .flatten()
                .is_some_and(|i| matches!(i.status, ItemStatus::Open | ItemStatus::Waiting));
            if open {
                ids.push(d.id);
            }
        }
        let first = *ids.first()?;
        let list = ids.iter().map(|i| format!("#{i}")).collect::<Vec<_>>().join(", ");
        Some(format!(
            "Your earlier work {list} in the same place failed and its matter is still open. If \
             this new work retries it, close that matter with item_update — and pass `replaces: \
             {first}` when you dispatch a retry, which hands its matter over for you."
        ))
    }

    pub(super) async fn same_line_note(
        &self,
        mode: crate::db::entities::personal_agent_dispatch::DispatchMode,
        folder_id: Option<i32>,
    ) -> Option<String> {
        use crate::db::entities::personal_agent_dispatch::DispatchMode;
        let folder_id = folder_id?;
        let live = svc::list_dispatches(
            &self.db.conn,
            self.bot().await,
            super::dispatch::LIVE_STATES,
            None,
            50,
        )
        .await
        .ok()?;
        let mut lines: Vec<String> = Vec::new();
        for d in live.iter().filter(|d| d.folder_id == Some(folder_id)) {
            match (mode, d.mode) {
                (DispatchMode::Session, DispatchMode::Session) => lines.push(format!(
                    "#{} \"{}\" is running on this project's checkout, on the same branch",
                    d.id, d.title
                )),
                (DispatchMode::Task, DispatchMode::Task) => {
                    let branch = match d.work_task_id {
                        Some(t) => crate::db::service::work_task_service::get(&self.db.conn, t)
                            .await
                            .ok()
                            .and_then(|t| t.work_branch),
                        None => None,
                    };
                    lines.push(match branch {
                        Some(b) => format!(
                            "#{} \"{}\" is running in this project on branch {b}",
                            d.id, d.title
                        ),
                        None => format!("#{} \"{}\" is running in this project", d.id, d.title),
                    });
                }
                _ => {}
            }
        }
        if lines.is_empty() {
            return None;
        }
        Some(format!(
            "Note: {}. If this is more work on that line (the same PR), send it with \
             `dispatch_followup` to that dispatch instead; one PR line, one execution.",
            lines.join("; ")
        ))
    }
}

/// Why options could not be filled in.
#[derive(Debug, Clone)]
pub(super) enum FillError {
    Unavailable(String),
    Refused(String),
}

/// A made assistant as a card lists it.
pub(super) fn made_json(m: &Made) -> Value {
    json!({
        "bot_id": m.bot.id,
        "uid": m.bot.uid,
        "name": display_name(&m.bot),
        "face": bot_face(&m.bot),
        "work_agent": m.work.label_snapshot.agent,
        "picked": picked_json(&m.picked),
        "brain_picked": picked_json(&m.brain_picked),
        "state": "made",
    })
}

