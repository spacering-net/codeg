//! Work assistants come and go (4.12, 4.14, 4.15): made from a name alone —
//! its role guessed from the name, its brain the primary's, an executor
//! config made with it and its options filled in — copied, deleted, and
//! made from the executor configs there were before. A new one opens with
//! its role's line and a choice card, and its brain first wakes when the
//! owner answers or writes to it.
//!
//! The assistants make them too (`bot_create`): on the owner's word at
//! once, with a card that undoes it; on their own idea, as a card that
//! makes it when the owner says so.

use std::collections::HashSet;
use std::sync::Arc;

use serde_json::{json, Value};

use super::bot_templates::{self as templates, BLANK};
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
use crate::db::service::personal_agent_service::{ItemWrite, NewNotice, NewRow, NewWorker};
use crate::models::assistant::{AssistantAgentConfig, AssistantDraft, AssistantInfo};
use crate::models::personal_agent::{PersonalAgentChange, PersonalAgentSettings, TimelineRow};
use crate::models::personal_agent_bots::{
    BotAvatar, BotDeleteOptions, BotImpact, ImpactExecutor, ImpactWork, PickedFrom, PickedOption,
};
use crate::models::system::AppLocale;
use crate::models::AgentType;

/// The settings key, on the primary's row, recording which executor
/// configs were made into work assistants on the way up from v2.0 (4.15).
pub const MADE_KEY: &str = "workers_from_executors";
/// Days a declined suggestion to make an assistant of a name stays declined.
const SUGGEST_MUTE_DAYS: i64 = 7;
/// Longest name.
const MAX_NAME_CHARS: usize = 40;

/// Where a new work assistant's executor config comes from.
#[derive(Debug, Clone)]
pub enum ExecutorSpec {
    /// Make one, on `agent_type` (the brain's when `None`), keeping what
    /// `given` names and filling the rest in.
    Fill {
        agent_type: Option<AgentType>,
        given: Partial,
    },
    /// Make one with this complete selection (the editor's).
    Config(AssistantAgentConfig),
    /// Make a copy of this one — its selection, description, instructions
    /// and usage (copying a work assistant, 4.14).
    CopyOf(i32),
    /// Bind this one (the executor configs there were before, 4.15).
    Existing(i32),
    /// Bind this one, made for the new assistant just now (in the editor):
    /// as one codeg made.
    Adopt(i32),
}

/// A work assistant to make.
#[derive(Debug, Clone)]
pub struct BotSpec {
    pub name: String,
    pub uid: Option<String>,
    pub template: Option<String>,
    pub avatar: Option<BotAvatar>,
    /// Its brain; the primary's when `None`.
    pub brain: Option<AssistantAgentConfig>,
    /// The options picked for the brain, when codeg filled them in.
    pub brain_picked: Vec<PickedOption>,
    pub executor: ExecutorSpec,
    /// Open with its role's line and the choice card.
    pub opener: bool,
    pub locale: Option<String>,
    /// Its own settings to start from (a copy's), and its files.
    pub settings: Option<PersonalAgentSettings>,
    pub files: Option<(String, String)>,
    pub notify: bool,
}

impl BotSpec {
    pub fn named(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            uid: None,
            template: None,
            avatar: None,
            brain: None,
            brain_picked: Vec::new(),
            executor: ExecutorSpec::Fill {
                agent_type: None,
                given: Partial::default(),
            },
            opener: true,
            locale: None,
            settings: None,
            files: None,
            notify: true,
        }
    }
}

/// A work assistant made.
#[derive(Debug, Clone)]
pub struct Made {
    pub bot: agent_entity::Model,
    pub executor: AssistantInfo,
    pub executor_created: bool,
    /// What codeg picked for the owner on the executor config.
    pub picked: Vec<PickedOption>,
    pub brain_picked: Vec<PickedOption>,
    pub template: &'static str,
}

/// Why it was not made.
#[derive(Debug, Clone)]
pub enum CreateError {
    Refused(String),
    /// The agent's options could not be read: the page opens the editor,
    /// prefilled, instead.
    OptionsUnavailable {
        agent_type: AgentType,
        why: String,
        template: &'static str,
    },
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

    /// Make a work assistant: its executor config (made, copied or bound),
    /// its row with the primary's brain, its working directory with its
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
        let template: &'static str = match spec.template.as_deref() {
            Some(t) => templates::spec(t)
                .map(|s| s.id)
                .ok_or_else(|| refused(format!("no template `{t}`")))?,
            None => templates::infer(&name),
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
        let words = templates::text(locale, template);

        // Its executor config.
        let (executor, created, picked) = match spec.executor.clone() {
            ExecutorSpec::Existing(id) | ExecutorSpec::Adopt(id) => {
                let a = crate::db::service::assistant_service::get(&self.db.conn, id)
                    .await
                    .map_err(|e| refused(e.to_string()))?
                    .filter(|a| a.is_live())
                    .ok_or_else(|| refused(format!("no executor config #{id}")))?;
                (
                    a,
                    matches!(spec.executor, ExecutorSpec::Adopt(_)),
                    Vec::new(),
                )
            }
            ExecutorSpec::Config(config) => {
                let a = self
                    .make_executor(
                        &name,
                        &avatar,
                        config,
                        words.map(|w| w.description.clone()),
                        locale,
                        template,
                    )
                    .await
                    .map_err(refused)?;
                (a, true, Vec::new())
            }
            ExecutorSpec::CopyOf(id) => {
                let src = crate::db::service::assistant_service::get(&self.db.conn, id)
                    .await
                    .map_err(|e| refused(e.to_string()))?
                    .filter(|a| a.is_live())
                    .ok_or_else(|| refused(format!("no executor config #{id} to copy")))?;
                let config = AssistantAgentConfig {
                    agent_type: src.agent_type,
                    agent_options: src.agent_options.clone(),
                    label_snapshot: src.label_snapshot.clone(),
                };
                let draft = AssistantDraft {
                    name: self.free_executor_name(&name).await,
                    description: src.description.clone(),
                    avatar: avatar.as_assistant(),
                    agent_config: config,
                    instructions: src.instructions.clone(),
                    enabled: true,
                };
                let a = crate::commands::assistants::assistant_create_core(
                    &self.emitter,
                    &self.db,
                    draft,
                )
                .await
                .map_err(|e| refused(e.to_string()))?;
                // How the assistants may use it, as the original.
                let usage = self.account().await.team.usage_of(&src.uid);
                if !usage.is_default() {
                    self.patch_account(json!({ "team": { "usage": { a.uid.clone(): usage } } }))
                        .await;
                }
                (a, true, Vec::new())
            }
            ExecutorSpec::Fill { agent_type, given } => {
                let agent_type = agent_type.unwrap_or(brain.agent_type);
                let (config, picked) =
                    self.fill_options(agent_type, &given, &[])
                        .await
                        .map_err(|e| match e {
                            FillError::Unavailable(why) => CreateError::OptionsUnavailable {
                                agent_type,
                                why,
                                template,
                            },
                            FillError::Refused(e) => refused(e),
                        })?;
                let a = self
                    .make_executor(
                        &name,
                        &avatar,
                        config,
                        words.map(|w| w.description.clone()),
                        locale,
                        template,
                    )
                    .await
                    .map_err(refused)?;
                (a, true, picked)
            }
        };
        // One made in the editor for it stays if this fails: the owner's work.
        let adopted = matches!(spec.executor, ExecutorSpec::Adopt(_));
        let undo_executor = |engine: &Self, a: &AssistantInfo| {
            let emitter = engine.emitter.clone();
            let db = crate::db::AppDatabase {
                conn: engine.db.conn.clone(),
            };
            let id = a.id;
            async move {
                let _ = crate::commands::assistants::assistant_delete_core(&emitter, &db, id).await;
            }
        };

        // The row.
        let settings = spec.settings.clone().unwrap_or_default().normalized();
        let new = NewWorker {
            uid: Some(uid.clone()),
            notify: spec.notify,
            name: name.clone(),
            avatar_json: serde_json::to_string(&avatar).unwrap_or_else(|_| "{}".into()),
            agent_type: brain.agent_type.as_wire().into_owned(),
            agent_options_json: serde_json::to_string(&brain.agent_options)
                .unwrap_or_else(|_| "{}".into()),
            label_snapshot_json: serde_json::to_string(&brain.label_snapshot)
                .unwrap_or_else(|_| "{}".into()),
            settings_json: crate::models::personal_agent::merge_settings_json(
                "{}", &settings, false,
            ),
            template: Some(template.to_string()),
            executor_assistant_id: Some(executor.id),
        };
        let bot = match svc::create_worker(&self.db.conn, new).await {
            Ok(b) => b,
            Err(e) => {
                if created && !adopted {
                    undo_executor(self, &executor).await;
                }
                return Err(refused(e.to_string()));
            }
        };

        // Its working directory: its role's files.
        let dir = workdir::workdir_of_bot(&self.data_dir, &bot);
        let (soul, rules) = spec.files.clone().unwrap_or_else(|| {
            (
                templates::soul_md(locale, template),
                templates::rules_md(locale, template),
            )
        });
        if let Err(e) = workdir::ensure_role_workdir(&dir, locale, &soul, &rules).await {
            let _ = svc::delete_worker(&self.db.conn, bot.id).await;
            if created && !adopted {
                undo_executor(self, &executor).await;
            }
            return Err(refused(format!(
                "its working directory could not be made: {e}"
            )));
        }
        workdir::sync_bot_skill(&dir, brain.agent_type, settings.skill_enabled, true);

        // How its executor config is used, and the kind of work it is first
        // for — when no one is yet.
        let spec_t = templates::spec(template);
        let mut team = serde_json::Map::new();
        if created && !matches!(spec.executor, ExecutorSpec::CopyOf(_)) {
            if let Some(modes) = spec_t.and_then(|s| s.modes) {
                team.insert(
                    "usage".into(),
                    json!({ executor.uid.clone(): { "dispatch": true, "modes": modes, "projects": null } }),
                );
            }
        }
        if let Some(kind) = spec_t.and_then(|s| s.division) {
            if !self.account().await.team.division.contains_key(kind) {
                team.insert("division".into(), json!({ kind: format!("bot:{uid}") }));
            }
        }
        if !team.is_empty() {
            self.patch_account(json!({ "team": team })).await;
        }

        let made = Made {
            bot,
            executor,
            executor_created: created,
            picked,
            brain_picked: spec.brain_picked.clone(),
            template,
        };
        if spec.opener {
            if let Err(e) = self.raise_starter(&made, locale, &primary).await {
                tracing::warn!(
                    "[personal-agent] the new assistant's opening card was not written: {e}"
                );
            }
        }
        self.emit_for(made.bot.id, PersonalAgentChange::Agent);
        self.emit_for(primary.id, PersonalAgentChange::Agent);
        Ok(made)
    }

    /// Patch the account's settings (on the primary's row), and say so.
    async fn patch_account(&self, patch: Value) {
        let Ok(Some(primary)) = svc::primary_bot(&self.db.conn).await else {
            return;
        };
        if let Err(e) = svc::patch_settings(&self.db.conn, primary.id, &patch).await {
            tracing::warn!("[personal-agent] the account's settings were not written: {e}");
        }
        self.emit_for(primary.id, PersonalAgentChange::Agent);
    }

    /// An executor config's name not taken yet: `name`, or `name (2)`…
    async fn free_executor_name(&self, name: &str) -> String {
        let taken: HashSet<String> = crate::db::service::assistant_service::list_all(&self.db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter(|a| a.is_live())
            .map(|a| crate::db::service::assistant_service::name_key(&a.name))
            .collect();
        crate::db::service::assistant_service::deduplicated_name(name, &taken)
    }

    /// Make the executor config a new work assistant is bound to: its name
    /// and face, its role's description and standing instructions.
    async fn make_executor(
        &self,
        name: &str,
        avatar: &BotAvatar,
        config: AssistantAgentConfig,
        description: Option<String>,
        locale: AppLocale,
        template: &str,
    ) -> Result<AssistantInfo, String> {
        crate::db::service::assistant_service::validate_agent_config(&config)
            .map_err(|e| e.to_string())?;
        let description: String = description
            .unwrap_or_default()
            .chars()
            .take(crate::db::service::assistant_service::MAX_DESCRIPTION_CHARS)
            .collect();
        let draft = AssistantDraft {
            name: self.free_executor_name(name).await,
            description,
            avatar: avatar.as_assistant(),
            agent_config: config,
            instructions: templates::instructions(locale, template),
            enabled: true,
        };
        crate::commands::assistants::assistant_create_core(&self.emitter, &self.db, draft)
            .await
            .map_err(|e| e.to_string())
    }

    /// A complete selection for `agent_type`: what is given, then another
    /// executor config's on the same agent (the newest first), then the
    /// agent's own (10.5 "fill five").
    pub(super) async fn fill_options(
        &self,
        agent_type: AgentType,
        given: &Partial,
        extra_others: &[crate::acp::delegation::types::AgentDelegationDefaults],
    ) -> Result<(AssistantAgentConfig, Vec<PickedOption>), FillError> {
        let mut others: Vec<AssistantInfo> =
            crate::db::service::assistant_service::list_all(&self.db.conn)
                .await
                .unwrap_or_default()
                .into_iter()
                .filter(|a| a.is_live() && a.agent_type == agent_type)
                .collect();
        others.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
        let mut selections: Vec<_> = extra_others.to_vec();
        selections.extend(others.into_iter().map(|a| a.agent_options));
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

    // ── the opening card ────────────────────────────────────────────────────

    /// The new assistant's first line: its role's opener with three choices
    /// and one of the owner's own, and under it what codeg made for it.
    async fn raise_starter(
        &self,
        made: &Made,
        locale: AppLocale,
        primary: &agent_entity::Model,
    ) -> Result<(), String> {
        let data = starter_data(made, locale, primary);
        let body = data["question"].as_str().unwrap_or_default().to_string();
        let mut row = NewRow::new(TimelineKind::Notice, body);
        row.data = Some(data);
        let (_, card) = svc::create_notice_with_row(
            &self.db.conn,
            made.bot.id,
            NewNotice {
                kind: NoticeKind::Choice,
                subject_key: Some(format!("starter:{}", made.bot.id)),
                level: NoticeLevel::Normal,
                batch_id: None,
                payload: json!({ "purpose": "starter", "bot": made.bot.id }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        self.emit_for(
            made.bot.id,
            PersonalAgentChange::Timeline {
                rows: vec![svc::to_row(card)],
            },
        );
        Ok(())
    }

    /// The owner answers a choice card: the card keeps the answer, and it
    /// goes to the assistant as the owner's message — a new assistant's
    /// first, which wakes its brain (4.12).
    pub async fn answer_choice(
        &self,
        notice_id: i32,
        key: Option<&str>,
        text: Option<&str>,
        project: Option<i32>,
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
        let options = data["options"].as_array().cloned().unwrap_or_default();
        let own = text.map(str::trim).filter(|t| !t.is_empty());
        let picked = key
            .map(|k| k.trim().to_ascii_uppercase())
            .filter(|k| !k.is_empty());
        let other_key = ((b'A' + options.len() as u8) as char).to_string();
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
            .send_owner_message(message, Vec::new(), Some(row_id))
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

    /// The starter card of this assistant's, while the owner has not
    /// answered it.
    async fn open_starter(&self) -> Option<(notice_entity::Model, Value)> {
        let bot = self.bot().await;
        let n = svc::notice_of_subject(
            &self.db.conn,
            bot,
            NoticeKind::Choice,
            &format!("starter:{bot}"),
        )
        .await
        .ok()
        .flatten()?;
        let row = svc::get_row(&self.db.conn, n.timeline_id?)
            .await
            .ok()
            .flatten()?;
        let data: Value = row
            .data
            .as_deref()
            .and_then(|d| serde_json::from_str(d).ok())?;
        Some((n, data))
    }

    /// What a work assistant's first session is told: it was just made,
    /// as what, and what the owner picked on its opening card.
    pub(super) async fn new_bot_note(&self, row: &agent_entity::Model) -> Option<String> {
        let template = row.template.as_deref().unwrap_or(BLANK);
        let primary = svc::primary_bot(&self.db.conn).await.ok().flatten()?;
        let locale = self.owner_locale(&primary, None).await;
        let role = templates::text(locale, template)
            .map(|t| format!("{} — {}", t.name, t.job))
            .unwrap_or_else(|| template.to_string());
        let mut note = format!("You were just made: your role is {role}.");
        if let Some((n, data)) = self.open_starter().await {
            let question = data["question"].as_str().unwrap_or_default();
            match (n.state, data.get("answer")) {
                (NoticeState::Acted, Some(a)) => {
                    let picked = match a["text"].as_str() {
                        Some(t) => format!("wrote their own: \"{t}\""),
                        None => {
                            let mut p = format!(
                                "picked {}. {}",
                                a["key"].as_str().unwrap_or("?"),
                                a["label"].as_str().unwrap_or_default()
                            );
                            if let Some(name) = a["project"]["name"].as_str() {
                                p.push_str(&format!(" — project {name} (#{})", a["project"]["id"]));
                            }
                            p
                        }
                    };
                    note.push_str(&format!(
                        " On your opening card (\"{question}\") the owner {picked}; their message below says the same."
                    ));
                }
                _ => note.push_str(&format!(
                    " The owner wrote to you before answering your opening card (\"{question}\")."
                )),
            }
        }
        Some(note)
    }

    /// [Change role] on the opening card, before the assistant first ran:
    /// its files, its executor config's description, instructions and
    /// usage, and its place in the division follow the new role — each only
    /// where it is still the old role's as codeg wrote it.
    pub async fn set_bot_template(&self, template: &str) -> Result<TimelineRow, String> {
        let row = self.agent_row().await.ok_or("no such assistant")?;
        if row.kind != BotKind::Worker {
            return Err("only a work assistant has a role to change".into());
        }
        let new = templates::spec(template).ok_or_else(|| format!("no template `{template}`"))?;
        let old = row.template.clone().unwrap_or_else(|| BLANK.to_string());
        if old == new.id {
            return Err("it has that role already".into());
        }
        let (notice, mut data) = self
            .open_starter()
            .await
            .ok_or("its role changes on its opening card")?;
        if notice.state != NoticeState::Open
            || !svc::list_segments(&self.db.conn, row.id)
                .await
                .unwrap_or_default()
                .is_empty()
        {
            return Err(
                "it has started on its work: change its files in its settings instead".into(),
            );
        }
        let locale = data["locale"]
            .as_str()
            .map(super::templates::template_locale)
            .unwrap_or(AppLocale::En);
        let dir = self.workdir_of(&row);
        for (file, was, now) in [
            (
                workdir::SOUL_FILE,
                templates::soul_md(locale, &old),
                templates::soul_md(locale, new.id),
            ),
            (
                workdir::RULES_FILE,
                templates::rules_md(locale, &old),
                templates::rules_md(locale, new.id),
            ),
        ] {
            if workdir::read_text(&dir, file) == was {
                workdir::write_file(&dir, file, &now).map_err(|e| e.to_string())?;
            }
        }
        workdir::commit_all(&dir, "role changed on the opening card").await;
        // Its executor config, where it is still the old role's.
        if let Some(id) = row.executor_assistant_id {
            if let Ok(Some(a)) = crate::db::service::assistant_service::get(&self.db.conn, id).await
            {
                let old_words = templates::text(locale, &old);
                let new_words = templates::text(locale, new.id);
                let mut patch = crate::models::assistant::AssistantPatch::default();
                if a.instructions == templates::instructions(locale, &old) {
                    patch.instructions = Some(templates::instructions(locale, new.id));
                }
                if old_words.is_some_and(|w| w.description == a.description) {
                    patch.description = new_words.map(|w| w.description.clone());
                }
                if patch != Default::default() {
                    let _ = crate::commands::assistants::assistant_update_core(
                        &self.emitter,
                        &self.db,
                        id,
                        patch,
                    )
                    .await;
                }
                let account = self.account().await;
                let usage = account.team.usage_of(&a.uid);
                let old_modes = templates::spec(&old).and_then(|s| s.modes);
                let was_old = match old_modes {
                    Some(m) => usage.dispatch && usage.projects.is_none() && usage.modes == m,
                    None => usage.is_default(),
                };
                let mut team = serde_json::Map::new();
                if was_old {
                    team.insert(
                        "usage".into(),
                        json!({ a.uid.clone(): new.modes.map(|m| json!({ "dispatch": true, "modes": m, "projects": null })) }),
                    );
                }
                let uid = row.uid.clone().unwrap_or_default();
                let mut division = serde_json::Map::new();
                if let Some(kind) = templates::spec(&old).and_then(|s| s.division) {
                    if account.team.division.get(kind).map(String::as_str)
                        == Some(&format!("bot:{uid}"))
                    {
                        division.insert(kind.into(), Value::Null);
                    }
                }
                if let Some(kind) = new.division {
                    if !account.team.division.contains_key(kind) || division.contains_key(kind) {
                        division.insert(kind.into(), json!(format!("bot:{uid}")));
                    }
                }
                if !division.is_empty() {
                    team.insert("division".into(), Value::Object(division));
                }
                if !team.is_empty() {
                    self.patch_account(json!({ "team": team })).await;
                }
            }
        }
        svc::set_bot_template(&self.db.conn, row.id, new.id)
            .await
            .map_err(|e| e.to_string())?;
        // The card asks as the new role does.
        let words = templates::text(locale, new.id).ok_or("no such template")?;
        if let Some(map) = data.as_object_mut() {
            map.insert("template".into(), new.id.into());
            map.insert("template_name".into(), words.name.clone().into());
            map.insert("question".into(), words.opener.clone().into());
            map.insert(
                "options".into(),
                choice_options(&words.options, new.project_option),
            );
        }
        let row_id = notice.timeline_id.ok_or("the card's row is missing")?;
        svc::update_row_data(
            &self.db.conn,
            row_id,
            Some(words.opener.clone()),
            Some(data),
        )
        .await
        .map_err(|e| e.to_string())?;
        let updated = svc::get_row(&self.db.conn, row_id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the card's row is missing")?;
        let card = svc::to_row(updated);
        self.emit_rows(vec![card.clone()]);
        self.emit(PersonalAgentChange::Agent);
        Ok(card)
    }

    // ── copying one ─────────────────────────────────────────────────────────

    /// Copy work assistant `id` (4.14): its brain, role, files and own
    /// settings, a copy of its executor config; not its memory, sessions or
    /// routines.
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
        spec.template = src.template.clone();
        spec.brain = brain_of(&src);
        spec.executor = match src.executor_assistant_id {
            Some(e) => ExecutorSpec::CopyOf(e),
            None => ExecutorSpec::Fill {
                agent_type: None,
                given: Partial::default(),
            },
        };
        spec.locale = locale.map(str::to_string);
        spec.settings = Some(settings_of(&src));
        spec.files = Some((
            workdir::read_text(&dir, workdir::SOUL_FILE),
            workdir::read_text(&dir, workdir::RULES_FILE),
        ));
        spec.notify = src.notify;
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
        let executor = match row.executor_assistant_id {
            Some(e) => match crate::db::service::assistant_service::get(&self.db.conn, e).await {
                Ok(Some(a)) if a.is_live() => {
                    let shared_with = svc::list_bots(&self.db.conn)
                        .await
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|b| b.id != id && b.executor_assistant_id == Some(e))
                        .map(|b| display_name(&b))
                        .collect();
                    Some(ImpactExecutor {
                        id: a.id,
                        name: a.name,
                        shared_with,
                    })
                }
                _ => None,
            },
            None => None,
        };
        let me = format!("bot:{}", row.uid.clone().unwrap_or_default());
        let division = self
            .account()
            .await
            .team
            .division
            .into_iter()
            .filter(|(_, v)| *v == me)
            .map(|(k, _)| k)
            .collect();
        let dir = workdir::workdir_of_bot(&self.data_dir, &row);
        Ok(BotImpact {
            bot_id: id,
            name: display_name(&row),
            running,
            unanswered_messages: unanswered,
            executor,
            division,
            workdir: dir.to_string_lossy().into_owned(),
            workdir_custom: row.workdir.as_deref().is_some_and(|w| !w.trim().is_empty()),
        })
    }

    /// Delete work assistant `id` (4.14): its running work handed to the
    /// primary to follow (or stopped), the messages it has not answered sent
    /// back to their senders, its place in the division back to auto, its
    /// engine stopped; its executor config and directory kept unless asked.
    /// `worker` is its engine when one runs.
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
            .map_err(|e| e.to_string())?
            .ok_or("no primary assistant")?;
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
        if opts.hand_over {
            let ids: Vec<i32> = live.iter().map(|d| d.id).collect();
            // Their sessions' events go to the primary now (a session still
            // starting registers with it itself: `register_conn`) — one
            // route change at a time, the owner and the route together, so
            // neither overwrites the other's.
            let routes = super::dispatch::ROUTES.lock().await;
            svc::move_dispatches_to(&self.db.conn, &ids, primary.id)
                .await
                .map_err(|e| e.to_string())?;
            if let Some(w) = worker.as_ref() {
                let conns = w.take_dispatch_conns(&ids).await;
                match self.host_ref() {
                    Some(h) => h.primary().adopt_dispatch_conns(conns).await,
                    None if self.bot().await == primary.id => {
                        self.adopt_dispatch_conns(conns).await
                    }
                    None => {}
                }
            }
            drop(routes);
            if !live.is_empty() {
                let list = live
                    .iter()
                    .map(|d| format!("#{} \"{}\"", d.id, d.title))
                    .collect::<Vec<_>>()
                    .join(", ");
                let _ = svc::insert_event(
                    &self.db.conn,
                    primary.id,
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
                self.emit_for(primary.id, PersonalAgentChange::Status);
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
        // Its place in the division is back to auto.
        let me = format!("bot:{}", row.uid.clone().unwrap_or_default());
        let mut division = serde_json::Map::new();
        for (k, v) in self.account().await.team.division {
            if v == me {
                division.insert(k, Value::Null);
            }
        }
        if !division.is_empty() {
            self.patch_account(json!({ "team": { "division": division } }))
                .await;
        }
        svc::delete_worker(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?;
        if opts.delete_executor {
            if let Some(e) = row.executor_assistant_id {
                self.delete_executor_if_unbound(e).await;
            }
        }
        if opts.delete_workdir && row.workdir.as_deref().is_none_or(|w| w.trim().is_empty()) {
            let dir = workdir::default_workdir_of_bot(&self.data_dir, &row);
            if workdir::is_workdir(&dir) {
                if let Err(e) = std::fs::remove_dir_all(&dir) {
                    tracing::warn!("[personal-agent] {} was not removed: {e}", dir.display());
                }
            }
        }
        self.emit_for(id, PersonalAgentChange::Agent);
        self.emit_for(primary.id, PersonalAgentChange::Agent);
        Ok(())
    }

    /// Delete executor config `id` unless a work assistant still on the
    /// roster is bound to it.
    async fn delete_executor_if_unbound(&self, id: i32) {
        let bound = svc::list_bots(&self.db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .any(|b| b.executor_assistant_id == Some(id));
        if !bound {
            let _ = crate::commands::assistants::assistant_delete_core(&self.emitter, &self.db, id)
                .await;
        }
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

    // ── on the way up from v2.0 ─────────────────────────────────────────────

    /// Make each executor config that is on into a work assistant, once
    /// (4.15): when the primary is set up — now, or when it first is. The
    /// ones made, and the ones the owner undid, are recorded by uid, so a
    /// restart makes none again. The primary's conversation gets a card
    /// with an [Undo] for each.
    pub async fn make_workers_from_executors(&self) -> usize {
        // One run at a time in this process (startup and a save of the
        // primary both start one): the second finds the first's record.
        static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
        let _one = RUNNING.lock().await;
        let Some(primary) = svc::primary_bot(&self.db.conn).await.ok().flatten() else {
            return 0;
        };
        if brain_of(&primary).is_none() {
            return 0;
        }
        let record: Value = serde_json::from_str::<Value>(&primary.settings)
            .ok()
            .and_then(|s| s.get(MADE_KEY).cloned())
            .unwrap_or(Value::Null);
        if record["done"].as_bool() == Some(true) {
            return 0;
        }
        let mut made_uids: Vec<String> = record["uids"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let bound: HashSet<i32> = svc::list_bots(&self.db.conn)
            .await
            .unwrap_or_default()
            .into_iter()
            .filter_map(|b| b.executor_assistant_id)
            .collect();
        let mut made: Vec<Made> = Vec::new();
        for a in crate::db::service::assistant_service::list_live_enabled(&self.db.conn)
            .await
            .unwrap_or_default()
        {
            if made_uids.contains(&a.uid) || bound.contains(&a.id) {
                continue;
            }
            let mut spec = BotSpec::named(a.name.clone());
            spec.avatar = Some(a.avatar.clone().into());
            spec.executor = ExecutorSpec::Existing(a.id);
            spec.opener = false;
            match self.create_bot(spec).await {
                Ok(m) => {
                    made_uids.push(a.uid.clone());
                    self.patch_account(json!({ MADE_KEY: { "uids": made_uids } }))
                        .await;
                    made.push(m);
                }
                Err(e) => tracing::warn!(
                    "[personal-agent] {} was not made a work assistant: {}",
                    a.name,
                    e.message()
                ),
            }
        }
        self.patch_account(json!({ MADE_KEY: { "done": true, "uids": made_uids } }))
            .await;
        let n = made.len();
        if n > 0 {
            let to = self.host_ref().map(|h| h.primary());
            let target: &PersonalAgentEngine = match to.as_deref() {
                Some(p) => p,
                None => self,
            };
            if let Err(e) = target
                .raise_bots_card("made", &made, None, None, None)
                .await
            {
                tracing::warn!(
                    "[personal-agent] the card for the assistants made was not written: {e}"
                );
            }
        }
        n
    }

    // ── the card that says so ───────────────────────────────────────────────

    /// A "changed" card about work assistants: made (`asked`, `made`), or
    /// waiting to be made (`show`, `suggest`, with the call to make it).
    async fn raise_bots_card(
        &self,
        why: &str,
        made: &[Made],
        pending: Option<Value>,
        quote: Option<String>,
        reason: Option<String>,
    ) -> Result<i32, String> {
        let primary = svc::primary_bot(&self.db.conn).await.ok().flatten();
        let locale = match primary.as_ref() {
            Some(p) => self.owner_locale(p, None).await,
            None => AppLocale::En,
        };
        let bots: Vec<Value> = made.iter().map(|m| made_json(m, locale)).collect();
        let applied = why == "asked" || why == "made";
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
            "quote": quote,
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
    /// `undo:<id>` (one) deletes what it made — the executor config made
    /// with it too, one that was there before stays; `accept` makes what
    /// waits; `dismiss` lets it be.
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
                    // The executor config is deleted only by its own id —
                    // the one made with it, not whichever the assistant is
                    // bound to now — and below, once the assistant is gone.
                    let opts = BotDeleteOptions {
                        hand_over: true,
                        delete_executor: false,
                        delete_workdir: false,
                    };
                    let made_executor = (b["executor_created"].as_bool() == Some(true))
                        .then(|| b["executor_id"].as_i64().map(|e| e as i32))
                        .flatten();
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
                    if let Some(e) = made_executor {
                        self.delete_executor_if_unbound(e).await;
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
            if !undone.is_empty() && why != "made" {
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
                match self.create_from_call(&pending).await {
                    Ok(m) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acting],
                            NoticeState::Acted,
                        )
                        .await;
                        let locale = self.locale_now().await;
                        data["bots"] = json!([made_json(&m, locale)]);
                        data["state"] = "applied".into();
                        data["error"] = Value::Null;
                        let card = self.write_card(row_id, data).await?;
                        self.tell_bots(
                            notice,
                            &format!(
                                "The owner accepted card #{}: made the work assistant {} (#{}), bound \
                                 to the executor config {} (#{}).",
                                notice.id,
                                display_name(&m.bot),
                                m.bot.id,
                                m.executor.name,
                                m.executor.id
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
                        if let CreateError::OptionsUnavailable {
                            agent_type,
                            template,
                            ..
                        } = &e
                        {
                            data["editor"] =
                                json!({ "agent_type": agent_type, "template": template });
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

    async fn locale_now(&self) -> AppLocale {
        match svc::primary_bot(&self.db.conn).await.ok().flatten() {
            Some(p) => self.owner_locale(&p, None).await,
            None => AppLocale::En,
        }
    }

    async fn write_card(&self, row_id: i32, data: Value) -> Result<TimelineRow, String> {
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

    async fn tell_bots(&self, notice: &notice_entity::Model, summary: &str) {
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
        if let Some(t) = text("template") {
            if templates::spec(&t).is_none() {
                return ToolOutcome::refused(format!(
                    "no template `{t}`; the templates are: {}",
                    templates::SPECS
                        .iter()
                        .map(|s| s.id)
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
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
        let why = if suggest {
            "suggest"
        } else if self.prefs().await.chat_changes
            == crate::models::personal_agent_prefs::ChatChanges::Show
        {
            "show"
        } else {
            "asked"
        };
        let outcome = if why == "asked" {
            match self.create_from_call(&call).await {
                Ok(m) => {
                    let card = match self
                        .raise_bots_card("asked", std::slice::from_ref(&m), None, quote, None)
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
                            "Made the work assistant {} (#{}), role {}, bound to the executor config {} \
                             (#{}){}. Its brain is {}. It has an opening card in its own conversation and \
                             wakes when the owner answers it or writes to it; message it with \
                             `bot_message`. The owner sees a card saying so, and can undo it there.",
                            display_name(&m.bot),
                            m.bot.id,
                            m.template,
                            m.executor.name,
                            m.executor.id,
                            if picked.is_empty() {
                                String::new()
                            } else {
                                format!("; options codeg picked for the owner: {picked}")
                            },
                            m.bot.agent_type,
                        ),
                        json!({
                            "notice_id": card,
                            "bot_id": m.bot.id,
                            "executor_assistant_id": m.executor.id,
                            "template": m.template,
                            "picked": picked_json(&m.picked),
                        }),
                    )
                }
                Err(CreateError::OptionsUnavailable { agent_type, why, .. }) => ToolOutcome::refused(format!(
                    "codeg could not read {}'s options ({why}), so it cannot fill them in. Name every \
                     option (`executor.options`), pick another agent, or ask the owner to make it from \
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
            match self
                .raise_bots_card(why, &[], Some(call.clone()), quote, reason)
                .await
            {
                Ok(id) => ToolOutcome::ok(
                    if why == "show" {
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
    async fn create_from_call(&self, call: &Value) -> Result<Made, CreateError> {
        let refused = CreateError::Refused;
        let s = |k: &str| call.get(k).and_then(|v| v.as_str()).map(str::to_string);
        let mut spec = BotSpec::named(s("name").unwrap_or_default());
        spec.template = s("template");
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
                            FillError::Unavailable(why) => CreateError::OptionsUnavailable {
                                agent_type,
                                why,
                                template: BLANK,
                            },
                            FillError::Refused(e) => refused(e),
                        })?;
                    spec.brain = Some(config);
                    spec.brain_picked = picked;
                }
            }
        }
        if let Some(e) = call.get("executor").filter(|e| !e.is_null()) {
            if let Some(id) = e.get("assistant_id").and_then(|v| v.as_i64()) {
                spec.executor = ExecutorSpec::Existing(id as i32);
            } else {
                spec.executor = ExecutorSpec::Fill {
                    agent_type: agent(e)?,
                    given: Partial::from_json(e.get("options")).map_err(refused)?,
                };
            }
        }
        self.create_bot(spec).await
    }

    // ── dispatching ─────────────────────────────────────────────────────────

    /// The executor config a dispatch goes to when it names none: a work
    /// assistant's own (4.4).
    pub(super) async fn default_executor(&self) -> Result<i32, String> {
        let row = self.agent_row().await.ok_or("not set up")?;
        let Some(id) = row
            .executor_assistant_id
            .filter(|_| row.kind == BotKind::Worker)
        else {
            return Err("`assistant_id` is required; use assistant_list".into());
        };
        match crate::db::service::assistant_service::get(&self.db.conn, id).await {
            Ok(Some(a)) if a.is_live() => Ok(id),
            _ => Err(format!(
                "your executor config #{id} is gone (deleted); name another with `assistant_id` \
                 (assistant_list), and the owner can bind a new one in your settings → Execution"
            )),
        }
    }

    /// The "who handed this out" block an execution carries (4.4).
    pub(super) async fn dispatcher_brief(&self) -> String {
        let Some(row) = self.agent_row().await else {
            return String::new();
        };
        let role = match row.kind {
            BotKind::Primary => "the owner's primary assistant".to_string(),
            BotKind::Worker => {
                let template = row.template.as_deref().unwrap_or(BLANK);
                let name = templates::text(AppLocale::En, template)
                    .map(|t| t.name.clone())
                    .unwrap_or_else(|| template.to_string());
                format!("one of the owner's work assistants (role: {name})")
            }
        };
        workdir::dispatcher_brief(&self.workdir_of(&row), &display_name(&row), &role)
    }

    /// Work of this assistant's running in the same project that a new
    /// dispatch may belong with (4.4): a session shares the project's
    /// checkout, so its branch; a task has its own. Only a reminder — the
    /// dispatch goes out either way.
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

/// The three choices and their keys, and which asks for a project.
fn choice_options(options: &[String], project: Option<usize>) -> Value {
    Value::Array(
        options
            .iter()
            .enumerate()
            .map(|(i, label)| {
                json!({
                    "key": ((b'A' + i as u8) as char).to_string(),
                    "label": label,
                    "project": project == Some(i),
                })
            })
            .collect(),
    )
}

/// A made assistant as a card lists it.
fn made_json(m: &Made, locale: AppLocale) -> Value {
    json!({
        "bot_id": m.bot.id,
        "uid": m.bot.uid,
        "name": display_name(&m.bot),
        "face": bot_face(&m.bot),
        "template": m.template,
        "template_name": templates::text(locale, m.template).map(|t| t.name.clone()),
        "executor_id": m.executor.id,
        "executor_name": m.executor.name,
        "executor_agent": m.executor.label_snapshot.agent,
        "executor_created": m.executor_created,
        "picked": picked_json(&m.picked),
        "brain_picked": picked_json(&m.brain_picked),
        "state": "made",
    })
}

/// A new assistant's opening card.
fn starter_data(made: &Made, locale: AppLocale, primary: &agent_entity::Model) -> Value {
    let words = templates::text(locale, made.template);
    let spec = templates::spec(made.template);
    let primary_brain = brain_of(primary);
    let same = primary_brain.as_ref().is_some_and(|p| {
        p.agent_type.as_wire() == made.bot.agent_type
            && serde_json::to_string(&p.agent_options).ok().as_deref()
                == Some(made.bot.agent_options.as_str())
    });
    let brain_agent = serde_json::from_str::<crate::models::assistant::AssistantLabelSnapshot>(
        &made.bot.label_snapshot,
    )
    .map(|l| l.agent)
    .unwrap_or_else(|_| made.bot.agent_type.clone());
    json!({
        "notice": "choice",
        "purpose": "starter",
        "state": "open",
        "locale": locale_tag(locale),
        "template": made.template,
        "template_name": words.map(|w| w.name.clone()),
        "question": words.map(|w| w.opener.clone()).unwrap_or_default(),
        "options": choice_options(words.map(|w| w.options.as_slice()).unwrap_or(&[]), spec.and_then(|s| s.project_option)),
        "other": templates::other_label(locale),
        "made": {
            "brain": { "agent": brain_agent, "same_as_primary": same, "picked": picked_json(&made.brain_picked) },
            "executor": {
                "id": made.executor.id,
                "name": made.executor.name,
                "agent": made.executor.label_snapshot.agent,
                "created": made.executor_created,
                "picked": picked_json(&made.picked),
            },
        },
    })
}

fn locale_tag(l: AppLocale) -> &'static str {
    match l {
        AppLocale::En => "en",
        AppLocale::ZhCn => "zh-CN",
        AppLocale::ZhTw => "zh-TW",
        AppLocale::Ja => "ja",
        AppLocale::Ko => "ko",
        AppLocale::Es => "es",
        AppLocale::De => "de",
        AppLocale::Fr => "fr",
        AppLocale::Pt => "pt",
        AppLocale::Ar => "ar",
    }
}
