//! The team changed from the conversation (10.5, 13.3): `bot_update` changes
//! a work assistant, `assistant_update` makes or changes an executor config.
//!
//! A change goes the way every settings change does (`prefs`): what the owner
//! says is changed at once, with a "changed" card that shows each item, its
//! old and new value, and undoes it; with "show me first" on, the card comes
//! first; what the assistant only infers (`suggest`) is a suggestion card.
//! The items are keys like any other —
//!
//! - `bot.<uid>.{name, avatar, brain, executor, template, notify, muted, hidden}`
//! - `assistant.<uid>.{name, description, instructions, agent, enabled}`
//! - and the team's own `team.usage.<uid>` and `team.division.<kind>`.
//!
//! A brain or an agent changed with only some of its options named has the
//! rest filled in (10.5 "fill five"): this one's own choices on the same
//! agent first, then another executor config's, then what the agent itself
//! reports. The card lists each option and who picked it. Another work
//! assistant's brain is changed through its own engine, so its next
//! delivery starts a new session segment with a handover card.
//!
//! A new executor config is made at once (or on a card first, the same way),
//! with a card that undoes it — deleting it and putting the division back.
//! Made from a template, it takes the template's description, standing
//! instructions and usage, and the template's kind of work when that has no
//! pick yet. Only when the agent's options cannot be read is nothing made:
//! the card opens the editor, prefilled with what was asked.

use std::sync::Arc;

use serde_json::{json, Value};

use super::bot_templates as templates;
use super::bots::{CreateError, FillError};
use super::engine::{brain_of, PersonalAgentEngine};
use super::messages::{display_name, Unnamed};
use super::options::Partial;
use super::prefs::{Applied, SettingChange};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent::BotKind;
use crate::db::entities::personal_agent_action::{self as action_entity, ActionState};
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::assistant_service;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::models::assistant::{
    AssistantAgentConfig, AssistantAvatar, AssistantDraft, AssistantInfo, AssistantPatch,
};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_bots::{BotAvatar, PickedOption};
use crate::models::personal_agent_prefs::{ExecutorUsage, DIVISION};
use crate::models::AgentType;

/// A work assistant's items `bot_update` changes.
const BOT_FIELDS: &[&str] = &[
    "name", "avatar", "brain", "executor", "template", "notify", "muted", "hidden",
];
/// An executor config's items `assistant_update` changes.
const ASSISTANT_FIELDS: &[&str] = &["name", "description", "instructions", "agent", "enabled"];

/// One item as planned: what it is, what it would be, the options codeg
/// picked for it.
pub(super) type Planned = (Value, Value, Option<Vec<PickedOption>>);

fn bool_of(field: &str, v: &Value) -> Result<Value, String> {
    v.as_bool()
        .map(Value::from)
        .ok_or_else(|| format!("`{field}` takes true or false"))
}

fn text_of(field: &str, v: &Value, max: usize, empty_ok: bool) -> Result<Value, String> {
    let s = v
        .as_str()
        .ok_or_else(|| format!("`{field}` takes text"))?
        .trim();
    if s.is_empty() && !empty_ok {
        return Err(format!("`{field}` cannot be empty"));
    }
    if s.chars().count() > max {
        return Err(format!("`{field}` takes at most {max} characters"));
    }
    Ok(json!(s))
}

fn config_of(a: &AssistantInfo) -> AssistantAgentConfig {
    AssistantAgentConfig {
        agent_type: a.agent_type,
        agent_options: a.agent_options.clone(),
        label_snapshot: a.label_snapshot.clone(),
    }
}

fn picked_some(p: Vec<PickedOption>) -> Option<Vec<PickedOption>> {
    (!p.is_empty()).then_some(p)
}

impl PersonalAgentEngine {
    // ── planning one item ───────────────────────────────────────────────────

    /// `bot.<uid>.<field>`: a work assistant's item.
    pub(super) async fn plan_bot_item(&self, rest: &str, value: &Value) -> Result<Planned, String> {
        let (uid, field) = rest
            .rsplit_once('.')
            .ok_or_else(|| format!("no setting `bot.{rest}`"))?;
        if !BOT_FIELDS.contains(&field) {
            return Err(format!(
                "a work assistant's items are: {}",
                BOT_FIELDS.join(", ")
            ));
        }
        let bot = svc::list_bots(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|b| b.uid.as_deref() == Some(uid) && b.kind == BotKind::Worker)
            .ok_or_else(|| format!("no work assistant `{uid}`"))?;
        Ok(match field {
            "name" => {
                let to = text_of("name", value, 40, false)?;
                (json!(bot.name), to, None)
            }
            "avatar" => {
                let a: BotAvatar = serde_json::from_value(value.clone())
                    .map_err(|e| format!("not an avatar: {e}"))?;
                a.validate()?;
                (
                    serde_json::to_value(BotAvatar::parse(&bot.avatar)).unwrap_or(Value::Null),
                    serde_json::to_value(a).unwrap_or(Value::Null),
                    None,
                )
            }
            "brain" => {
                let from = brain_of(&bot).ok_or("its brain is not set up")?;
                let (to, picked) = self.plan_brain(&from, value).await?;
                (
                    serde_json::to_value(&from).map_err(|e| e.to_string())?,
                    serde_json::to_value(&to).map_err(|e| e.to_string())?,
                    picked_some(picked),
                )
            }
            "executor" => {
                let to = self.find_executor(value).await?;
                let from = match bot.executor_assistant_id {
                    Some(id) => assistant_service::get(&self.db.conn, id)
                        .await
                        .ok()
                        .flatten()
                        .map(|a| json!(a.uid))
                        .unwrap_or(Value::Null),
                    None => Value::Null,
                };
                (from, json!(to.uid), None)
            }
            "template" => {
                // None on record reads as the blank role.
                let id = value.as_str().map(str::trim).unwrap_or(templates::BLANK);
                let spec = templates::spec(id).ok_or_else(|| {
                    format!(
                        "no template `{id}`; the templates are: {}",
                        templates::SPECS
                            .iter()
                            .map(|s| s.id)
                            .collect::<Vec<_>>()
                            .join(", ")
                    )
                })?;
                (json!(bot.template), json!(spec.id), None)
            }
            "notify" => (json!(bot.notify), bool_of(field, value)?, None),
            "muted" => (json!(bot.muted), bool_of(field, value)?, None),
            _ => (json!(bot.hidden), bool_of(field, value)?, None),
        })
    }

    /// `assistant.<uid>.<field>`: an executor config's item.
    pub(super) async fn plan_assistant_item(
        &self,
        rest: &str,
        value: &Value,
    ) -> Result<Planned, String> {
        let (uid, field) = rest
            .rsplit_once('.')
            .ok_or_else(|| format!("no setting `assistant.{rest}`"))?;
        if !ASSISTANT_FIELDS.contains(&field) {
            return Err(format!(
                "an executor config's items are: {}",
                ASSISTANT_FIELDS.join(", ")
            ));
        }
        let a = assistant_service::list_all(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|a| a.uid == uid && a.is_live())
            .ok_or_else(|| format!("no executor config `{uid}`"))?;
        Ok(match field {
            "name" => (json!(a.name), text_of("name", value, 80, false)?, None),
            "description" => (
                json!(a.description),
                text_of(
                    "description",
                    value,
                    assistant_service::MAX_DESCRIPTION_CHARS,
                    true,
                )?,
                None,
            ),
            "instructions" => (
                json!(a.instructions),
                text_of("instructions", value, 20_000, true)?,
                None,
            ),
            "enabled" => (json!(a.enabled), bool_of(field, value)?, None),
            _ => {
                let from = config_of(&a);
                let (to, picked) = self.plan_agent(&from, value).await?;
                (
                    serde_json::to_value(&from).map_err(|e| e.to_string())?,
                    serde_json::to_value(&to).map_err(|e| e.to_string())?,
                    picked_some(picked),
                )
            }
        })
    }

    /// An executor config's agent and options as a change names them: a
    /// whole selection (an undo, a card's), or `{agent_type, options}` with
    /// the rest filled in — its own choices first on the same agent.
    async fn plan_agent(
        &self,
        current: &AssistantAgentConfig,
        value: &Value,
    ) -> Result<(AssistantAgentConfig, Vec<PickedOption>), String> {
        if value.get("label_snapshot").is_some() {
            let whole: AssistantAgentConfig = serde_json::from_value(value.clone())
                .map_err(|e| format!("not an agent selection: {e}"))?;
            whole.validate()?;
            return Ok((whole, Vec::new()));
        }
        let agent_type = match value.get("agent_type").and_then(|a| a.as_str()) {
            Some(a) => AgentType::from_wire(a).ok_or_else(|| format!("no agent `{a}`"))?,
            None => current.agent_type,
        };
        let given = Partial::from_json(value.get("options"))?;
        let extra: Vec<_> = (agent_type == current.agent_type)
            .then(|| current.agent_options.clone())
            .into_iter()
            .collect();
        self.fill_options(agent_type, &given, &extra)
            .await
            .map_err(|e| match e {
                FillError::Unavailable(why) => format!(
                    "codeg could not read the options of {} ({why}); name every option, or the owner \
                     changes it in the executor config's editor",
                    crate::acp::registry::get_agent_meta(agent_type).name
                ),
                FillError::Refused(e) => e,
            })
    }

    /// The live executor config a value names: its uid, id or name.
    async fn find_executor(&self, value: &Value) -> Result<AssistantInfo, String> {
        let all: Vec<AssistantInfo> = assistant_service::list_all(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|a| a.is_live())
            .collect();
        let found = match value {
            Value::Number(n) => n
                .as_i64()
                .and_then(|id| all.iter().find(|a| i64::from(a.id) == id)),
            Value::String(s) => {
                let s = s.trim();
                let key = assistant_service::name_key(s);
                all.iter()
                    .find(|a| a.uid == s)
                    .or_else(|| {
                        s.trim_start_matches('#')
                            .parse::<i32>()
                            .ok()
                            .and_then(|id| all.iter().find(|a| a.id == id))
                    })
                    .or_else(|| {
                        all.iter()
                            .find(|a| assistant_service::name_key(&a.name) == key)
                    })
            }
            _ => None,
        };
        found
            .cloned()
            .ok_or_else(|| "no such executor config; assistant_list gives them".to_string())
    }

    // ── writing ─────────────────────────────────────────────────────────────

    /// Write the work assistants' and executor configs' items of a plan.
    ///
    /// Boxed: another assistant's change goes through its engine, which may
    /// be started for it — and an engine's start-up can write settings.
    pub(super) fn write_team<'a>(
        &'a self,
        applied: &'a [Applied],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(self.write_team_now(applied))
    }

    async fn write_team_now(&self, applied: &[Applied]) -> Result<(), String> {
        use std::collections::BTreeMap;
        let mut bots: BTreeMap<String, Vec<&Applied>> = BTreeMap::new();
        let mut assistants: BTreeMap<String, Vec<&Applied>> = BTreeMap::new();
        for a in applied {
            if let Some(rest) = a.key.strip_prefix("bot.") {
                if let Some((uid, _)) = rest.rsplit_once('.') {
                    bots.entry(uid.to_string()).or_default().push(a);
                }
            } else if let Some(rest) = a.key.strip_prefix("assistant.") {
                if let Some((uid, _)) = rest.rsplit_once('.') {
                    assistants.entry(uid.to_string()).or_default().push(a);
                }
            }
        }
        for (uid, items) in assistants {
            let a = assistant_service::list_all(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|a| a.uid == uid && a.is_live())
                .ok_or_else(|| format!("no executor config `{uid}`"))?;
            let mut patch = AssistantPatch::default();
            for item in items {
                let field = item.key.rsplit('.').next().unwrap_or_default();
                let s = || item.to.as_str().unwrap_or_default().to_string();
                match field {
                    "name" => patch.name = Some(s()),
                    "description" => patch.description = Some(s()),
                    "instructions" => patch.instructions = Some(s()),
                    "enabled" => patch.enabled = item.to.as_bool(),
                    "agent" => {
                        patch.agent_config = Some(
                            serde_json::from_value(item.to.clone()).map_err(|e| e.to_string())?,
                        )
                    }
                    _ => {}
                }
            }
            crate::commands::assistants::assistant_update_core(
                &self.emitter,
                &self.db,
                a.id,
                patch,
            )
            .await
            .map_err(|e| e.to_string())?;
        }
        for (uid, items) in bots {
            let bot = svc::list_bots(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|b| b.uid.as_deref() == Some(uid.as_str()) && b.kind == BotKind::Worker)
                .ok_or_else(|| format!("no work assistant `{uid}`"))?;
            let mut draft = crate::models::personal_agent::PersonalAgentDraft::default();
            let mut roster = svc::RosterWrite::default();
            let mut template = None;
            for item in items {
                let field = item.key.rsplit('.').next().unwrap_or_default();
                match field {
                    "name" => draft.name = item.to.as_str().map(str::to_string),
                    "avatar" => {
                        draft.avatar = Some(
                            serde_json::from_value(item.to.clone()).map_err(|e| e.to_string())?,
                        )
                    }
                    "brain" => {
                        draft.agent_config = Some(
                            serde_json::from_value(item.to.clone()).map_err(|e| e.to_string())?,
                        )
                    }
                    "executor" => {
                        let a = self.find_executor(&item.to).await?;
                        draft.executor_assistant_id = Some(a.id);
                    }
                    "template" => template = item.to.as_str().map(str::to_string),
                    "notify" => roster.notify = item.to.as_bool(),
                    "muted" => roster.muted = item.to.as_bool(),
                    "hidden" => roster.hidden = item.to.as_bool(),
                    _ => {}
                }
            }
            let saves = draft.name.is_some()
                || draft.avatar.is_some()
                || draft.agent_config.is_some()
                || draft.executor_assistant_id.is_some();
            if saves {
                // Through its own engine: a brain switched there starts its
                // next delivery in a new segment, with a handover card.
                let engine = if bot.id == self.bot().await {
                    None
                } else {
                    match self.host_ref() {
                        Some(host) => Some(
                            host.engine_for(Some(bot.id))
                                .await
                                .ok_or_else(|| format!("{} is not running", display_name(&bot)))?,
                        ),
                        None => return Err(format!("{} is not running", display_name(&bot))),
                    }
                };
                match engine {
                    Some(e) => e.save(draft).await?,
                    None => self.save(draft).await?,
                };
            }
            if roster.notify.is_some() || roster.muted.is_some() || roster.hidden.is_some() {
                // As the roster's own menu does it, when there is one.
                match self.host_ref() {
                    Some(host) => {
                        use crate::models::personal_agent_roster::RosterAct;
                        let mut acts = Vec::new();
                        if let Some(on) = roster.notify {
                            acts.push(RosterAct::Notify { on });
                        }
                        if let Some(m) = roster.muted {
                            acts.push(if m {
                                RosterAct::Mute
                            } else {
                                RosterAct::Unmute
                            });
                        }
                        if let Some(h) = roster.hidden {
                            acts.push(if h { RosterAct::Hide } else { RosterAct::Show });
                        }
                        for act in acts {
                            host.roster_act(bot.id, act).await?;
                        }
                    }
                    None => {
                        svc::set_roster(&self.db.conn, bot.id, roster)
                            .await
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            if let Some(t) = template {
                svc::set_bot_template(&self.db.conn, bot.id, &t)
                    .await
                    .map_err(|e| e.to_string())?;
                if let Some(host) = self.host_ref() {
                    host.emit_roster();
                }
            }
            self.emit_for(bot.id, PersonalAgentChange::Agent);
        }
        Ok(())
    }

    // ── the tools ───────────────────────────────────────────────────────────

    /// The work assistant a value names: its id, uid or name.
    async fn find_bot(
        &self,
        value: Option<&Value>,
    ) -> Result<crate::db::entities::personal_agent::Model, String> {
        let value =
            value.ok_or("`bot` is required: the work assistant to change (bot_list gives them)")?;
        let all = svc::list_bots(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        let found = match value {
            Value::Number(n) => n
                .as_i64()
                .and_then(|id| all.iter().find(|b| i64::from(b.id) == id)),
            Value::String(s) => {
                let s = s.trim();
                let lower = s.to_lowercase();
                all.iter()
                    .find(|b| b.uid.as_deref() == Some(s))
                    .or_else(|| {
                        s.trim_start_matches('#')
                            .parse::<i32>()
                            .ok()
                            .and_then(|id| all.iter().find(|b| b.id == id))
                    })
                    .or_else(|| all.iter().find(|b| display_name(b).to_lowercase() == lower))
            }
            _ => None,
        }
        .cloned()
        .ok_or("no such assistant; bot_list gives them")?;
        if found.kind != BotKind::Worker {
            return Err(
                "the primary assistant is changed in its own settings, or with prefs_update (`brain`)"
                    .into(),
            );
        }
        Ok(found)
    }

    /// `bot_update`: change a work assistant.
    pub(super) async fn bot_update_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let bot = match self.find_bot(args.get("bot")).await {
            Ok(b) => b,
            Err(e) => return ToolOutcome::refused(e),
        };
        let Some(uid) = bot.uid.clone() else {
            return ToolOutcome::refused("this work assistant has no uid to change it by");
        };
        let mut changes = Vec::new();
        for field in BOT_FIELDS {
            if let Some(v) = args.get(*field).filter(|v| !v.is_null()) {
                changes.push(SettingChange {
                    key: format!("bot.{uid}.{field}"),
                    value: v.clone(),
                });
            }
        }
        // Its face: a shape and a colour, the one not named kept.
        let shape = args.get("shape").and_then(|v| v.as_str());
        let color = args.get("color").and_then(|v| v.as_str());
        if shape.is_some() || color.is_some() {
            let (was_shape, was_color) = match BotAvatar::parse(&bot.avatar) {
                BotAvatar::Face { shape, color } => (Some(shape), Some(color)),
                BotAvatar::Monogram { color } | BotAvatar::Emoji { color, .. } => {
                    (None, Some(color))
                }
                BotAvatar::Image { .. } => (None, None),
            };
            let default = BotAvatar::default_for(&uid);
            let (d_shape, d_color) = match default {
                BotAvatar::Face { shape, color } => (shape, color),
                _ => (String::new(), String::new()),
            };
            changes.push(SettingChange {
                key: format!("bot.{uid}.avatar"),
                value: json!({
                    "kind": "face",
                    "shape": shape.map(str::to_string).or(was_shape).unwrap_or(d_shape),
                    "color": color
                        .map(str::to_string)
                        .or(was_color.filter(|c| crate::models::personal_agent_bots::BOT_COLORS.contains(&c.as_str())))
                        .unwrap_or(d_color),
                }),
            });
        }
        // The kinds of work it is the first pick for (10.5).
        match roles_of(args) {
            Ok(roles) => {
                for kind in roles {
                    changes.push(SettingChange {
                        key: format!("team.division.{kind}"),
                        value: json!(format!("bot:{uid}")),
                    });
                }
            }
            Err(e) => return ToolOutcome::refused(e),
        }
        if changes.is_empty() {
            return ToolOutcome::refused(
                "name what to change: name, shape, color, template, brain, executor, notify, muted, hidden, roles",
            );
        }
        self.change_settings_call("bot_update", changes, args).await
    }

    /// `assistant_update`: change an executor config (`assistant` names
    /// it), or make one.
    pub(super) async fn assistant_update_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let Some(named) = args.get("assistant").filter(|v| !v.is_null()) else {
            return self.assistant_create_call(args).await;
        };
        let a = match self.find_executor(named).await {
            Ok(a) => a,
            Err(e) => return ToolOutcome::refused(e),
        };
        let mut changes = Vec::new();
        for field in ["name", "description", "instructions", "enabled"] {
            if let Some(v) = args.get(field).filter(|v| !v.is_null()) {
                changes.push(SettingChange {
                    key: format!("assistant.{}.{field}", a.uid),
                    value: v.clone(),
                });
            }
        }
        if args.get("agent_type").is_some() || args.get("options").is_some() {
            changes.push(SettingChange {
                key: format!("assistant.{}.agent", a.uid),
                value: json!({
                    "agent_type": args.get("agent_type"),
                    "options": args.get("options"),
                }),
            });
        }
        if let Some(u) = args.get("usage").filter(|v| v.is_object()) {
            let current = self.account().await.team.usage_of(&a.uid);
            let mut merged = serde_json::to_value(&current).unwrap_or_else(|_| json!({}));
            if let (Some(m), Some(given)) = (merged.as_object_mut(), u.as_object()) {
                for (k, v) in given {
                    m.insert(k.clone(), v.clone());
                }
            }
            changes.push(SettingChange {
                key: format!("team.usage.{}", a.uid),
                value: merged,
            });
        }
        match roles_of(args) {
            Ok(roles) => {
                for kind in roles {
                    changes.push(SettingChange {
                        key: format!("team.division.{kind}"),
                        value: json!(format!("assistant:{}", a.uid)),
                    });
                }
            }
            Err(e) => return ToolOutcome::refused(e),
        }
        if changes.is_empty() {
            return ToolOutcome::refused(
                "name what to change: name, description, instructions, enabled, agent_type/options, \
                 usage, roles",
            );
        }
        self.change_settings_call("assistant_update", changes, args)
            .await
    }

    /// `assistant_update` with no `assistant`: make one.
    async fn assistant_create_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let suggest = args
            .get("suggest")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let text = |k: &str| {
            args.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.chars().take(1_000).collect::<String>())
        };
        let quote = text("quote");
        let reason = text("reason");
        if suggest && reason.is_none() {
            return ToolOutcome::refused("a suggestion needs `reason`: why it fits the owner");
        }
        // The owner does not take suggestions now (6.7).
        if suggest {
            if let Some(no) = self.suggestions_closed().await {
                return no;
            }
        }
        if !suggest && quote.is_none() {
            return ToolOutcome::refused(
                "`quote` the owner's words this follows; one you only think would help is a \
                 suggestion (`suggest: true` with a `reason`)",
            );
        }
        if let Some(t) = text("template") {
            if templates::spec(&t).is_none() {
                return ToolOutcome::refused(format!("no template `{t}`"));
            }
        }
        if text("name").is_none() && text("template").is_none() {
            return ToolOutcome::refused("`name` is required to make an executor config");
        }
        if let Err(e) = roles_of(args) {
            return ToolOutcome::refused(e);
        }
        if let Some(named) = args.get("for").and_then(|v| v.as_str()) {
            if let Err(e) = self.input_for(Some(named), Unnamed::Nothing).await {
                return ToolOutcome::refused(e);
            }
        }
        let mut call = args.clone();
        if let Some(map) = call.as_object_mut() {
            map.remove("for");
        }
        let key = format!(
            "assistant_create|{}",
            super::engine::text_digest(&call.to_string())
        );
        let ledger = self.ledger_batch().await;
        // The turn this delivery repeats: what it did stands; one cut off
        // while making it is finished, not made twice.
        let mut earlier = None;
        if let Some((_, scope)) = &ledger {
            if let Ok(entries) = svc::ledger_entries(&self.db.conn, scope, &key).await {
                if let Some(e) = entries.into_iter().next_back() {
                    if e.state == ActionState::Committed {
                        return ToolOutcome::ok(
                            format!(
                                "Already done: the turn this delivery repeats made this same call, \
                                 and it answered: {}",
                                e.detail.unwrap_or_default()
                            ),
                            json!({ "earlier": true }),
                        );
                    }
                    earlier = Some(e);
                }
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
        let batch = ledger.as_ref().map(|(b, _)| *b);
        if why == "asked" {
            let slot = match batch {
                Some(b) => svc::LedgerSlot::in_batch(b, key.clone(), super::ledger::fresh_op_id()),
                None => svc::LedgerSlot::outside(super::ledger::fresh_op_id()),
            };
            return match self.create_executor_op(&call, slot, earlier, None).await {
                Ok((made, op_id)) => {
                    let card = self
                        .raise_assistant_card("asked", Some(&made), None, quote, reason, batch)
                        .await
                        .unwrap_or(0);
                    if card != 0 {
                        let _ = svc::op_set_notice(&self.db.conn, &op_id, card).await;
                    }
                    ToolOutcome::ok(
                        made_text(&made),
                        json!({ "notice_id": card, "assistant_id": made.assistant.id, "uid": made.assistant.uid, "picked": made.picked }),
                    )
                }
                Err(CreateError::OptionsUnavailable {
                    agent_type, why, ..
                }) => {
                    let card = self
                        .raise_assistant_card(
                            "editor",
                            None,
                            Some(prefill(&call, agent_type)),
                            quote,
                            Some(why.clone()),
                            batch,
                        )
                        .await
                        .unwrap_or(0);
                    let text = format!(
                        "Nothing made: codeg could not read {}'s options ({why}), so it cannot fill \
                         them in. The owner has card #{card} to open the editor with what you asked \
                         prefilled; or name every option and call again.",
                        crate::acp::registry::get_agent_meta(agent_type).name
                    );
                    let data = json!({ "notice_id": card, "state": "editor" });
                    self.record_assistant_answer(batch, &key, &call, &text, &data)
                        .await;
                    ToolOutcome::ok(text, data)
                }
                Err(CreateError::Refused(e)) => ToolOutcome::refused(e),
            };
        }
        let outcome = match self
            .raise_assistant_card(why, None, Some(call.clone()), quote, reason, batch)
            .await
        {
            Ok(id) => ToolOutcome::ok(
                if why == "show" {
                    format!(
                        "On card #{id} for the owner to confirm first (they asked to see such \
                         changes first): make the executor config. Nothing is made yet; you will \
                         hear how they answered."
                    )
                } else {
                    format!(
                        "Suggested on card #{id}: make the executor config. It is made only if the \
                         owner says so; you will hear how they answered."
                    )
                },
                json!({ "notice_id": id, "state": "open" }),
            ),
            Err(e) => ToolOutcome::refused(e),
        };
        if outcome.ok {
            self.record_assistant_answer(batch, &key, &call, &outcome.text, &outcome.data)
                .await;
        }
        outcome
    }

    /// A call that made nothing (a card instead): a replay answers the same.
    async fn record_assistant_answer(
        &self,
        batch: Option<i32>,
        key: &str,
        call: &Value,
        text: &str,
        data: &Value,
    ) {
        let Some(batch) = batch else {
            return;
        };
        let slot = svc::LedgerSlot::in_batch(batch, key.to_string(), super::ledger::fresh_op_id());
        let _ = svc::record_done_op(
            &self.db.conn,
            self.bot().await,
            &slot,
            "assistant_create",
            call.clone(),
            text,
            data.clone(),
        )
        .await;
    }

    /// Make an executor config under the ledger entry `slot`: the entry is
    /// written (prepared, with the name it takes) before the config is
    /// made, records the config the moment it exists, and commits with
    /// what was made. `earlier`: the entry of a turn this delivery repeats
    /// — one cut off after making it is finished, not made again.
    async fn create_executor_op(
        &self,
        call: &Value,
        slot: svc::LedgerSlot,
        earlier: Option<action_entity::Model>,
        notice_id: Option<i32>,
    ) -> Result<(MadeExecutor, String), CreateError> {
        if let Some(e) = earlier.filter(|e| e.state == ActionState::Prepared) {
            if let Some(op_id) = e.op_id.clone() {
                if self.is_live(&op_id).await {
                    return Err(CreateError::Refused("it is being made right now".into()));
                }
                if let Some(made) = self.recover_executor(&e).await {
                    return Ok((made, op_id));
                }
            }
        }
        let planned = self.plan_executor(call).await?;
        // Its uid is chosen now and written down first: the config is found
        // by it afterwards, never by its name (another making could take
        // the same one).
        let uid = uuid::Uuid::new_v4().to_string();
        let payload = json!({ "call": call, "name": planned.draft.name, "uid": uid });
        let begun = svc::begin_op(
            &self.db.conn,
            svc::NewOp {
                bot_id: self.bot().await,
                slot: slot.clone(),
                kind: "assistant_create",
                payload: payload.clone(),
                target: None,
                notice_id,
            },
        )
        .await
        .map_err(|e| CreateError::Refused(e.to_string()))?;
        if let svc::Ledgered::Earlier(e) = begun {
            // This batch's own entry, not made: made again under a new id.
            let old = e.op_id.clone().unwrap_or_default();
            let rearmed = svc::op_rearm(&self.db.conn, &old, &slot.op_id, payload, Value::Null)
                .await
                .unwrap_or(false);
            if !rearmed {
                return Err(CreateError::Refused(
                    "the same call is on record already".into(),
                ));
            }
        }
        self.set_live(&slot.op_id, true).await;
        let made = self.finish_executor(call, planned, &uid, &slot.op_id).await;
        self.set_live(&slot.op_id, false).await;
        made.map(|m| (m, slot.op_id))
    }

    /// Make the planned executor config, its usage and division, and commit
    /// entry `op_id` with them.
    async fn finish_executor(
        &self,
        call: &Value,
        planned: PlannedExecutor,
        uid: &str,
        op_id: &str,
    ) -> Result<MadeExecutor, CreateError> {
        let refused = CreateError::Refused;
        let not_made = |why: String| async move {
            let _ = svc::op_settle(
                &self.db.conn,
                op_id,
                &[ActionState::Prepared],
                ActionState::NotExecuted,
                None,
                Some(why.clone()),
                None,
            )
            .await;
            refused(why)
        };
        let made = match crate::commands::assistants::assistant_create_as_core(
            &self.emitter,
            &self.db,
            planned.draft,
            uid.to_string(),
        )
        .await
        {
            Ok(m) => m,
            Err(e) => return Err(not_made(e.to_string()).await),
        };
        let _ = svc::op_set_target(
            &self.db.conn,
            op_id,
            json!({ "assistant_id": made.id, "uid": uid }),
        )
        .await;
        // Its usage and division: planned, the plan (what each was, what it
        // becomes) written down, then applied — so an undo after a restart
        // still knows what to put back.
        let team = match self.plan_team_of_new(call, planned.template, uid).await {
            Ok(t) => t,
            Err(e) => {
                let _ = crate::commands::assistants::assistant_delete_core(
                    &self.emitter,
                    &self.db,
                    made.id,
                )
                .await;
                return Err(not_made(e).await);
            }
        };
        // Not applied unless written down: an undo must know what was.
        let recorded = svc::op_set_target(
            &self.db.conn,
            op_id,
            json!({ "assistant_id": made.id, "uid": uid, "team": team }),
        )
        .await
        .map_err(|e| e.to_string());
        if let Err(e) = match recorded {
            Ok(()) => self.apply_team(&team).await,
            Err(e) => Err(e),
        } {
            let _ = crate::commands::assistants::assistant_delete_core(
                &self.emitter,
                &self.db,
                made.id,
            )
            .await;
            return Err(not_made(e).await);
        }
        let made = MadeExecutor {
            assistant: made,
            picked: planned.picked,
            team,
            template: planned.template,
        };
        let _ = svc::op_settle(
            &self.db.conn,
            op_id,
            &[ActionState::Prepared],
            ActionState::Committed,
            Some(made.assistant.id.to_string()),
            Some(made_text(&made)),
            Some(made_json(&made)),
        )
        .await;
        Ok(made)
    }

    /// An entry cut off while making its executor config: the config made
    /// under the uid it wrote down first — its usage and division seen to
    /// as planned, and the entry committed. `None`: nothing was made.
    async fn recover_executor(&self, e: &action_entity::Model) -> Option<MadeExecutor> {
        let op_id = e.op_id.clone()?;
        let payload: Value = e
            .payload
            .as_deref()
            .and_then(|p| serde_json::from_str(p).ok())
            .unwrap_or(Value::Null);
        let target: Value = e
            .target
            .as_deref()
            .and_then(|t| serde_json::from_str(t).ok())
            .unwrap_or(Value::Null);
        let uid = payload["uid"].as_str()?;
        let found = assistant_service::list_all(&self.db.conn)
            .await
            .ok()?
            .into_iter()
            .find(|a| a.uid == uid && a.is_live())?;
        let call = payload["call"].clone();
        let template = template_of(&call, &found.name);
        let team = match serde_json::from_value::<Vec<Applied>>(target["team"].clone()) {
            // Planned before the cut: what is not applied yet is; the plan,
            // with what each item was, is what an undo puts back.
            Ok(plan) => {
                let _ = self.apply_team(&plan).await;
                plan
            }
            // Cut before its plan: nothing of it was applied. Planned now,
            // and written down before it is applied, so a second cut finds
            // it.
            Err(_) => match self.plan_team_of_new(&call, template, uid).await {
                Ok(plan) => {
                    let recorded = svc::op_set_target(
                        &self.db.conn,
                        &op_id,
                        json!({ "assistant_id": found.id, "uid": uid, "team": plan }),
                    )
                    .await
                    .is_ok();
                    if recorded {
                        let _ = self.apply_team(&plan).await;
                        plan
                    } else {
                        Vec::new()
                    }
                }
                Err(_) => Vec::new(),
            },
        };
        let made = MadeExecutor {
            assistant: found,
            picked: Vec::new(),
            team,
            template,
        };
        let _ = svc::op_settle(
            &self.db.conn,
            &op_id,
            &[ActionState::Prepared],
            ActionState::Committed,
            Some(made.assistant.id.to_string()),
            Some(made_text(&made)),
            Some(made_json(&made)),
        )
        .await;
        Some(made)
    }

    /// At start-up: an entry left prepared while making an executor config
    /// is finished or found not made; one the turn made directly gets the
    /// card it would have had.
    pub(super) async fn resolve_executor_op(
        &self,
        op: &action_entity::Model,
    ) -> super::ledger::OpOutcome {
        use super::ledger::OpOutcome;
        let Some(op_id) = op.op_id.clone() else {
            return OpOutcome::Unknown("recorded without an operation id".into());
        };
        if self.is_live(&op_id).await {
            return OpOutcome::Pending;
        }
        match self.recover_executor(op).await {
            Some(made) => {
                if op.notice_id.is_none() {
                    let payload: Value = op
                        .payload
                        .as_deref()
                        .and_then(|p| serde_json::from_str(p).ok())
                        .unwrap_or(Value::Null);
                    let text = |k: &str| payload["call"][k].as_str().map(str::to_string);
                    if let Ok(card) = self
                        .raise_assistant_card(
                            "asked",
                            Some(&made),
                            None,
                            text("quote"),
                            text("reason"),
                            None,
                        )
                        .await
                    {
                        let _ = svc::op_set_notice(&self.db.conn, &op_id, card).await;
                    }
                }
                OpOutcome::Committed
            }
            None => {
                let why = "codeg stopped before it was made".to_string();
                let _ = svc::op_settle(
                    &self.db.conn,
                    &op_id,
                    &[ActionState::Prepared],
                    ActionState::NotExecuted,
                    None,
                    Some(why.clone()),
                    None,
                )
                .await;
                OpOutcome::NotExecuted(why)
            }
        }
    }

    /// The executor config `call` asks for, what it leaves out filled in —
    /// not made yet.
    async fn plan_executor(&self, call: &Value) -> Result<PlannedExecutor, CreateError> {
        let refused = CreateError::Refused;
        let text = |k: &str| {
            call.get(k)
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        let primary = svc::primary_bot(&self.db.conn)
            .await
            .map_err(|e| refused(e.to_string()))?
            .ok_or_else(|| refused("set the primary assistant up first".into()))?;
        let locale = self.owner_locale(&primary, None).await;
        let template = template_of(call, text("name").as_deref().unwrap_or(""));
        let words = templates::text(locale, template);
        let name = text("name")
            .or_else(|| words.map(|w| w.name.clone()))
            .ok_or_else(|| refused("`name` is required".into()))?;
        // Its agent: the one named, else the newest executor config's, else
        // the primary's brain's.
        let agent_type = match text("agent_type") {
            Some(a) => {
                AgentType::from_wire(&a).ok_or_else(|| refused(format!("no agent `{a}`")))?
            }
            None => {
                let mut live: Vec<AssistantInfo> = assistant_service::list_all(&self.db.conn)
                    .await
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|a| a.is_live())
                    .collect();
                live.sort_by_key(|a| std::cmp::Reverse(a.updated_at));
                match live.first() {
                    Some(a) => a.agent_type,
                    None => brain_of(&primary)
                        .map(|b| b.agent_type)
                        .ok_or_else(|| refused("name the agent: `agent_type`".into()))?,
                }
            }
        };
        let given = Partial::from_json(call.get("options")).map_err(refused)?;
        let (config, picked) = match self.fill_options(agent_type, &given, &[]).await {
            Ok(x) => x,
            Err(FillError::Unavailable(why)) => {
                return Err(CreateError::OptionsUnavailable {
                    agent_type,
                    why,
                    template,
                })
            }
            Err(FillError::Refused(e)) => return Err(refused(e)),
        };
        let avatar = match call.get("avatar").filter(|v| !v.is_null()) {
            Some(v) => {
                let a: AssistantAvatar = serde_json::from_value(v.clone())
                    .map_err(|e| refused(format!("not an avatar: {e}")))?;
                assistant_service::validate_avatar(&a).map_err(|e| refused(e.to_string()))?;
                a
            }
            None => BotAvatar::default_for(&name).as_assistant(),
        };
        let description: String = text("description")
            .or_else(|| {
                words
                    .map(|w| w.description.clone())
                    .filter(|d| !d.is_empty())
            })
            .unwrap_or_default()
            .chars()
            .take(assistant_service::MAX_DESCRIPTION_CHARS)
            .collect();
        let instructions =
            text("instructions").unwrap_or_else(|| templates::instructions(locale, template));
        let draft = AssistantDraft {
            name: self.free_executor_name(&name).await,
            description,
            avatar,
            agent_config: config,
            instructions,
            enabled: true,
        };
        Ok(PlannedExecutor {
            draft,
            picked,
            template,
        })
    }

    /// A new executor config's usage and its place in the division: as
    /// `call` says, else its template's — a kind of work that has no first
    /// pick yet gets it. Planned, not written: each item with what it is
    /// now and what it becomes.
    async fn plan_team_of_new(
        &self,
        call: &Value,
        template: &'static str,
        uid: &str,
    ) -> Result<Vec<Applied>, String> {
        let mut team: Vec<SettingChange> = Vec::new();
        let usage = match call.get("usage").filter(|u| u.is_object()) {
            Some(u) => Some(u.clone()),
            None => templates::spec(template)
                .and_then(|s| s.modes)
                .map(|modes| json!({ "modes": modes })),
        };
        if let Some(u) = usage {
            let u = serde_json::from_value::<ExecutorUsage>(u)
                .map_err(|e| format!("not a usage: {e}"))?;
            if !u.is_default() {
                team.push(SettingChange {
                    key: format!("team.usage.{uid}"),
                    value: serde_json::to_value(u).unwrap_or(Value::Null),
                });
            }
        }
        let pick = json!(format!("assistant:{uid}"));
        let mut roles = roles_of(call)?;
        let division = self.account().await.team.division;
        if let Some(kind) = templates::spec(template).and_then(|s| s.division) {
            if !division.contains_key(kind) && !roles.iter().any(|r| r == kind) {
                roles.push(kind.to_string());
            }
        }
        for kind in roles {
            team.push(SettingChange {
                key: format!("team.division.{kind}"),
                value: pick.clone(),
            });
        }
        self.plan_settings(&team).await
    }

    /// Write a planned team change (what is already so is left).
    ///
    /// Boxed: start-up reaches this (an interrupted making), and writing
    /// settings can start another assistant's engine, whose start-up is this
    /// same future's type again.
    fn apply_team<'a>(
        &'a self,
        plan: &'a [Applied],
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), String>> + Send + 'a>> {
        Box::pin(async move {
            let changes: Vec<SettingChange> = plan
                .iter()
                .map(|a| SettingChange {
                    key: a.key.clone(),
                    value: a.to.clone(),
                })
                .collect();
            self.apply_settings(&changes).await.map(|_| ())
        })
    }

    /// A card about an executor config to make: made (`asked`), waiting
    /// for the owner (`show`, `suggest`), or the editor to open (`editor`).
    async fn raise_assistant_card(
        &self,
        why: &str,
        made: Option<&MadeExecutor>,
        pending: Option<Value>,
        quote: Option<String>,
        reason: Option<String>,
        batch: Option<i32>,
    ) -> Result<i32, String> {
        let state = match why {
            "asked" => "applied",
            "editor" => "editor",
            _ => "open",
        };
        let title = match (made, pending.as_ref()) {
            (Some(m), _) => format!("Made the executor config {}", m.assistant.name),
            (None, Some(p)) => format!(
                "Make an executor config: {}",
                p["name"]
                    .as_str()
                    .or(p["template"].as_str())
                    .unwrap_or_default()
            ),
            _ => "Make an executor config".to_string(),
        };
        let mut row = NewRow::new(TimelineKind::Notice, title);
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch;
        row.data = Some(json!({
            "notice": "changed",
            "what": "assistant",
            "state": state,
            "why": why,
            "made": made.map(made_json),
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
                    "what": "assistant",
                    "bot": self.bot().await,
                    "pending": pending,
                    "made": made.map(made_json),
                }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        if why == "asked" {
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

    /// The owner's answer on a card about an executor config: `undo`
    /// deletes the one made (its place in the division back as it was),
    /// `accept` makes the one waiting, `dismiss` lets it be.
    pub(super) async fn act_on_assistant_card(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        match action {
            "undo" => {
                // Taken first; undone only once what it undoes is.
                if !svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acted],
                    NoticeState::Acting,
                )
                .await
                .map_err(|e| e.to_string())?
                {
                    return Err("there is nothing on this card to undo".into());
                }
                let mut p = payload.clone();
                p["phase"] = json!("undoing");
                let _ = svc::set_notice_payload(&self.db.conn, notice.id, &p).await;
                self.finish_undo(notice, &payload["made"]).await
            }
            "accept" => {
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
                let mut p = payload.clone();
                p["phase"] = json!("accepting");
                let _ = svc::set_notice_payload(&self.db.conn, notice.id, &p).await;
                let attempt = svc::ops_of_notice(&self.db.conn, notice.id)
                    .await
                    .map(|ops| {
                        ops.iter()
                            .filter(|o| o.op_id.as_deref().is_some_and(super::ledger::is_card_op))
                            .count()
                    })
                    .unwrap_or(0)
                    + 1;
                let slot = svc::LedgerSlot::outside(super::ledger::card_op_id(notice.id, attempt));
                let call = payload["pending"].clone();
                match self
                    .create_executor_op(&call, slot, None, Some(notice.id))
                    .await
                {
                    Ok((made, _)) => {
                        let row = self.assistant_card_made(notice, &made).await?;
                        self.tell_assistant_card(
                            notice,
                            &format!("The owner accepted: {}", made_text(&made)),
                        )
                        .await;
                        Ok(row)
                    }
                    Err(e) => {
                        let msg = e.message();
                        self.assistant_card_back(notice, &msg).await;
                        Err(msg)
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
                self.tell_assistant_card(
                    notice,
                    "The owner declined making the executor config. Nothing was made.",
                )
                .await;
                self.assistant_card_row(notice, "dismissed", json!({}))
                    .await
            }
            _ => Err("`action` must be accept, dismiss or undo".into()),
        }
    }

    /// Put the division and usage a made executor config took back, where
    /// they still are what it made them; the keys changed since are kept.
    async fn undo_team(&self, team: &[Applied]) -> Result<Vec<String>, String> {
        let mut back = Vec::new();
        let mut kept = Vec::new();
        let account = self.account().await;
        for a in team {
            let now = if let Some(kind) = a.key.strip_prefix("team.division.") {
                account
                    .team
                    .division
                    .get(kind)
                    .cloned()
                    .map(Value::from)
                    .unwrap_or(Value::Null)
            } else if let Some(uid) = a.key.strip_prefix("team.usage.") {
                account
                    .team
                    .usage
                    .get(uid)
                    .filter(|u| !u.is_default())
                    .map(|u| serde_json::to_value(u).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null)
            } else {
                continue;
            };
            if now == a.to {
                back.push(Applied {
                    key: a.key.clone(),
                    from: a.to.clone(),
                    to: a.from.clone(),
                    picked: None,
                });
            } else {
                kept.push(a.key.clone());
            }
        }
        self.write_settings(&back).await?;
        Ok(kept)
    }

    /// Undo what a card made (its card taken already): the division back,
    /// the config deleted — then the card is undone. Cut off, the card
    /// stays taken and start-up finishes it; failed, it is back as it was.
    async fn finish_undo(
        &self,
        notice: &notice_entity::Model,
        made: &Value,
    ) -> Result<TimelineRow, String> {
        let team: Vec<Applied> = serde_json::from_value(made["team"].clone()).unwrap_or_default();
        let undone = async {
            let kept = self.undo_team(&team).await?;
            if let Some(id) = made["assistant"]["id"]
                .as_i64()
                .and_then(|i| i32::try_from(i).ok())
            {
                let live = assistant_service::get(&self.db.conn, id)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_some_and(|a| a.is_live());
                if live {
                    crate::commands::assistants::assistant_delete_core(&self.emitter, &self.db, id)
                        .await
                        .map_err(|e| e.to_string())?;
                }
            }
            Ok::<_, String>(kept)
        }
        .await;
        let mut p: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        if let Some(map) = p.as_object_mut() {
            map.remove("phase");
        }
        let _ = svc::set_notice_payload(&self.db.conn, notice.id, &p).await;
        match undone {
            Ok(kept) => {
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acting],
                    NoticeState::Undone,
                )
                .await;
                let name = made["assistant"]["name"].as_str().unwrap_or_default();
                self.tell_assistant_card(
                    notice,
                    &format!("The owner undid making the executor config {name}: it is deleted."),
                )
                .await;
                self.assistant_card_row(notice, "undone", json!({ "kept": kept, "error": null }))
                    .await
            }
            Err(e) => {
                let _ = svc::move_notice(
                    &self.db.conn,
                    notice.id,
                    &[NoticeState::Acting],
                    NoticeState::Acted,
                )
                .await;
                let _ = self
                    .assistant_card_row(notice, "applied", json!({ "error": e.clone() }))
                    .await;
                Err(e)
            }
        }
    }

    /// A card whose executor config was made: acted, holding what.
    async fn assistant_card_made(
        &self,
        notice: &notice_entity::Model,
        made: &MadeExecutor,
    ) -> Result<TimelineRow, String> {
        let mut p: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        p["made"] = made_json(made);
        if let Some(map) = p.as_object_mut() {
            map.remove("phase");
        }
        let _ = svc::set_notice_payload(&self.db.conn, notice.id, &p).await;
        let _ = svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Acting],
            NoticeState::Acted,
        )
        .await;
        self.assistant_card_row(
            notice,
            "applied",
            json!({ "made": made_json(made), "error": null }),
        )
        .await
    }

    /// A card whose making did not happen: open again, saying why.
    async fn assistant_card_back(&self, notice: &notice_entity::Model, why: &str) {
        let mut p: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        if let Some(map) = p.as_object_mut() {
            map.remove("phase");
        }
        let _ = svc::set_notice_payload(&self.db.conn, notice.id, &p).await;
        let _ = svc::move_notice(
            &self.db.conn,
            notice.id,
            &[NoticeState::Acting],
            NoticeState::Open,
        )
        .await;
        let _ = self
            .assistant_card_row(notice, "open", json!({ "error": why }))
            .await;
    }

    /// After a restart: a card about an executor config left taken
    /// finishes what it was doing — its undo, or the making its entry
    /// records.
    pub(super) async fn settle_assistant_card_at_boot(&self, card: &notice_entity::Model) {
        let payload: Value = serde_json::from_str(&card.payload).unwrap_or(Value::Null);
        if payload["phase"].as_str() == Some("undoing") {
            let _ = self.finish_undo(card, &payload["made"]).await;
            return;
        }
        let ops = svc::ops_of_notice(&self.db.conn, card.id)
            .await
            .unwrap_or_default();
        let last = ops
            .into_iter()
            .rfind(|o| o.op_id.as_deref().is_some_and(super::ledger::is_card_op));
        let made = match last {
            Some(op) if op.state == ActionState::Committed => op
                .observed
                .as_deref()
                .and_then(|o| serde_json::from_str::<Value>(o).ok()),
            Some(op) if op.state == ActionState::Prepared => {
                self.recover_executor(&op).await.map(|m| made_json(&m))
            }
            _ => None,
        };
        match made {
            Some(made) => {
                let mut p = payload.clone();
                p["made"] = made.clone();
                if let Some(map) = p.as_object_mut() {
                    map.remove("phase");
                }
                let _ = svc::set_notice_payload(&self.db.conn, card.id, &p).await;
                let _ = svc::move_notice(
                    &self.db.conn,
                    card.id,
                    &[NoticeState::Acting],
                    NoticeState::Acted,
                )
                .await;
                let _ = self
                    .assistant_card_row(card, "applied", json!({ "made": made, "error": null }))
                    .await;
            }
            None => {
                self.assistant_card_back(card, "codeg stopped before it was made; nothing was made")
                    .await
            }
        }
    }

    async fn assistant_card_row(
        &self,
        notice: &notice_entity::Model,
        state: &str,
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
        if let Some(map) = data.as_object_mut() {
            map.insert("state".into(), state.into());
            if let Value::Object(extra) = extra {
                map.extend(extra);
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

    async fn tell_assistant_card(&self, notice: &notice_entity::Model, summary: &str) {
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "changed",
            &format!(
                "notice:{}:assistant:{}",
                notice.id,
                chrono::Utc::now().timestamp_millis()
            ),
            None,
            format!("Card #{}: {summary}", notice.id),
            Some(json!({ "notice_id": notice.id })),
            false,
        )
        .await;
    }

    /// Names for the uids a plan's keys hold, for its card.
    pub(super) async fn team_names(&self, plan: &[Applied]) -> Value {
        let mut names = serde_json::Map::new();
        let bots = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        let assistants = assistant_service::list_all(&self.db.conn)
            .await
            .unwrap_or_default();
        let mut name_of = |key: String, name: String| {
            names.insert(key, json!(name));
        };
        for a in plan {
            if let Some((uid, _)) = a.key.strip_prefix("bot.").and_then(|r| r.rsplit_once('.')) {
                if let Some(b) = bots.iter().find(|b| b.uid.as_deref() == Some(uid)) {
                    name_of(format!("bot:{uid}"), display_name(b));
                }
            }
            let uid = a
                .key
                .strip_prefix("assistant.")
                .and_then(|r| r.rsplit_once('.'))
                .map(|(u, _)| u)
                .or_else(|| a.key.strip_prefix("team.usage."));
            if let Some(uid) = uid {
                if let Some(x) = assistants.iter().find(|x| x.uid == uid) {
                    name_of(format!("assistant:{uid}"), x.name.clone());
                }
            }
            for v in [&a.from, &a.to] {
                if let Some(pick) = v.as_str() {
                    if let Some(uid) = pick.strip_prefix("assistant:") {
                        if let Some(x) = assistants.iter().find(|x| x.uid == uid) {
                            name_of(pick.to_string(), x.name.clone());
                        }
                    } else if let Some(uid) = pick.strip_prefix("bot:") {
                        if let Some(b) = bots.iter().find(|b| b.uid.as_deref() == Some(uid)) {
                            name_of(pick.to_string(), display_name(b));
                        }
                    } else if a.key.ends_with(".executor") {
                        if let Some(x) = assistants.iter().find(|x| x.uid == pick) {
                            name_of(format!("assistant:{pick}"), x.name.clone());
                        }
                    }
                }
            }
        }
        Value::Object(names)
    }
}

/// An executor config to make, everything filled in.
struct PlannedExecutor {
    draft: AssistantDraft,
    picked: Vec<PickedOption>,
    template: &'static str,
}

/// The template a call makes an executor config from: the one it names,
/// else the one its name reads as.
fn template_of(call: &Value, name: &str) -> &'static str {
    call.get("template")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .and_then(templates::spec)
        .map(|s| s.id)
        .unwrap_or_else(|| {
            let n = call
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|n| !n.is_empty())
                .unwrap_or(name);
            if n.is_empty() {
                templates::BLANK
            } else {
                templates::infer(n)
            }
        })
}

/// An executor config made from the conversation.
#[derive(Debug, Clone)]
pub(super) struct MadeExecutor {
    pub assistant: AssistantInfo,
    pub picked: Vec<PickedOption>,
    pub team: Vec<Applied>,
    pub template: &'static str,
}

fn made_json(m: &MadeExecutor) -> Value {
    json!({
        "assistant": {
            "id": m.assistant.id,
            "uid": m.assistant.uid,
            "name": m.assistant.name,
            "agent": m.assistant.label_snapshot.agent,
            "agent_type": m.assistant.agent_type,
        },
        "picked": m.picked,
        "team": m.team,
        "template": m.template,
    })
}

fn made_text(m: &MadeExecutor) -> String {
    let filled: Vec<String> = m
        .picked
        .iter()
        .filter(|p| p.from != crate::models::personal_agent_bots::PickedFrom::Given)
        .map(|p| format!("{} = {}", p.name, p.value_label))
        .collect();
    let division: Vec<String> = m
        .team
        .iter()
        .filter_map(|a| a.key.strip_prefix("team.division.").map(str::to_string))
        .collect();
    format!(
        "Made the executor config {} (#{}, uid {}) on {}{}{}. The owner sees a card saying so, and can \
         undo it there.",
        m.assistant.name,
        m.assistant.id,
        m.assistant.uid,
        m.assistant.label_snapshot.agent,
        if filled.is_empty() {
            String::new()
        } else {
            format!("; options codeg picked for the owner: {}", filled.join(", "))
        },
        if division.is_empty() {
            String::new()
        } else {
            format!("; first pick for: {}", division.join(", "))
        }
    )
}

/// What the editor opens with when nothing could be made.
fn prefill(call: &Value, agent_type: AgentType) -> Value {
    json!({
        "name": call.get("name"),
        "description": call.get("description"),
        "instructions": call.get("instructions"),
        "template": call.get("template"),
        "agent_type": agent_type,
        "options": call.get("options"),
    })
}

/// The kinds of work a call names to make it the first pick for.
fn roles_of(args: &Value) -> Result<Vec<String>, String> {
    let Some(list) = args.get("roles").filter(|v| !v.is_null()) else {
        return Ok(Vec::new());
    };
    let list = list
        .as_array()
        .ok_or("`roles` is a list of kinds of work")?;
    let mut out = Vec::new();
    for r in list {
        let kind = r.as_str().map(str::trim).unwrap_or_default();
        if !DIVISION.contains(&kind) {
            return Err(format!(
                "no kind of work `{kind}`; one of: {}",
                DIVISION.join(", ")
            ));
        }
        if !out.iter().any(|k| k == kind) {
            out.push(kind.to_string());
        }
    }
    Ok(out)
}
