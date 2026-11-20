//! The team changed from the conversation (10.5, 13.3): `bot_update`
//! changes a work assistant.
//!
//! A change goes the way every settings change does (`prefs`): what the owner
//! says is changed at once, with a "changed" card that shows each item, its
//! old and new value, and undoes it; with "show me first" on, the card comes
//! first; what the assistant only infers (`suggest`) is a suggestion card.
//! The items are keys like any other —
//!
//! - `bot.<uid>.{name, avatar, brain, notify, muted, hidden, persona,
//!   work_agent}` — the primary's own `persona` and `work_agent` too.
//!
//! `persona` is the first paragraph of its persona (under the heading of
//! its SOUL.md): replaced in the file as it is when the change is made, the
//! rest left to the assistant. `work_agent` is the agent its work runs on:
//! the executor config it is bound to changed in place when no other
//! assistant is bound to it, else one made for it with the new agent (D2).
//!
//! A brain changed with only some of its options named has the rest filled
//! in (10.5 "fill five"): this one's own choices on the same agent first,
//! then another executor config's, then what the agent itself reports. The
//! card lists each option and who picked it. Another work assistant's brain
//! is changed through its own engine, so its next delivery starts a new
//! session segment with a handover card.

use std::sync::Arc;

use serde_json::{json, Value};

use super::engine::{brain_of, PersonalAgentEngine};
use super::messages::display_name;
use super::prefs::{Applied, SettingChange};
use super::tools::ToolOutcome;
use super::workdir;
use crate::db::entities::personal_agent::BotKind;
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent::PersonalAgentChange;
use crate::models::personal_agent_bots::{BotAvatar, PickedOption};

/// A work assistant's items `bot_update` changes.
const BOT_FIELDS: &[&str] = &[
    "name",
    "avatar",
    "brain",
    "notify",
    "muted",
    "hidden",
    "persona",
    "work_agent",
];
/// The primary's: the rest are its own settings' (`prefs_update`).
const PRIMARY_FIELDS: &[&str] = &["persona", "work_agent"];
/// Longest persona paragraph `bot_update` writes.
const MAX_PERSONA_CHARS: usize = 1_000;
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
            .find(|b| b.uid.as_deref() == Some(uid))
            .ok_or_else(|| format!("no assistant `{uid}`"))?;
        if bot.kind == BotKind::Primary && !PRIMARY_FIELDS.contains(&field) {
            return Err(format!(
                "the primary assistant's {field} is changed in its own settings, or with \
                 prefs_update; bot_update changes its {}",
                PRIMARY_FIELDS.join(" and ")
            ));
        }
        Ok(match field {
            // What the tool asks for is checked there (`persona_given`): an
            // undo puts back whatever was there, empty or long.
            "persona" => {
                let to = super::team::persona_lines(
                    value.as_str().ok_or("`persona` takes text")?,
                );
                if to.lines().any(|l| l.starts_with('#')) {
                    return Err("`persona` is plain lines, without a heading".into());
                }
                let soul = workdir::read_text(&self.workdir_of(&bot), workdir::SOUL_FILE);
                (json!(super::team::persona_paragraph(&soul)), json!(to), None)
            }
            "work_agent" => {
                let from = self.work_agent_of(&bot).await;
                let from_json = from
                    .as_ref()
                    .map(|f| serde_json::to_value(f).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null);
                // None to work with (an undo of one given to an assistant
                // that had none): none again.
                if value.is_null() {
                    (from_json, Value::Null, None)
                } else {
                    let (to, picked) = self.plan_work_agent(&bot, from.as_ref(), value).await?;
                    (
                        from_json,
                        serde_json::to_value(&to).map_err(|e| e.to_string())?,
                        picked_some(picked),
                    )
                }
            }
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
            "notify" => (json!(bot.notify), bool_of(field, value)?, None),
            "muted" => (json!(bot.muted), bool_of(field, value)?, None),
            _ => (json!(bot.hidden), bool_of(field, value)?, None),
        })
    }

    /// The executor config the assistant of `uid` is bound to, when it is
    /// there to work with.
    pub(super) async fn bound_executor_of_uid(&self, uid: &str) -> Option<i32> {
        let bot = svc::list_bots(&self.db.conn)
            .await
            .ok()?
            .into_iter()
            .find(|b| b.uid.as_deref() == Some(uid))?;
        let id = bot.executor_assistant_id?;
        crate::db::service::assistant_service::get(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .filter(|a| a.is_live())
            .map(|a| a.id)
    }

    /// The agent and options `bot`'s work runs on: its executor config's,
    /// when it has one to work with.
    async fn work_agent_of(
        &self,
        bot: &crate::db::entities::personal_agent::Model,
    ) -> Option<crate::models::AssistantAgentConfig> {
        let id = bot.executor_assistant_id?;
        crate::db::service::assistant_service::get(&self.db.conn, id)
            .await
            .ok()
            .flatten()
            .filter(|a| a.is_live())
            .map(|a| crate::models::AssistantAgentConfig {
                agent_type: a.agent_type,
                agent_options: a.agent_options,
                label_snapshot: a.label_snapshot,
            })
    }

    /// What a change of the agent `bot`'s work runs on comes to: a whole
    /// selection as given (an undo, a card's), or `{agent_type, options}`
    /// with the rest filled in as a new assistant's are — its own choices
    /// first when it stays on the same agent. No agent named: the one it
    /// works with now, else its brain's.
    async fn plan_work_agent(
        &self,
        bot: &crate::db::entities::personal_agent::Model,
        current: Option<&crate::models::AssistantAgentConfig>,
        value: &Value,
    ) -> Result<(crate::models::AssistantAgentConfig, Vec<PickedOption>), String> {
        if value.get("label_snapshot").is_some() {
            let whole: crate::models::AssistantAgentConfig = serde_json::from_value(value.clone())
                .map_err(|e| format!("not an agent and its options: {e}"))?;
            crate::db::service::assistant_service::validate_agent_config(&whole)
                .map_err(|e| e.to_string())?;
            return Ok((whole, Vec::new()));
        }
        let agent_type = match value.get("agent_type").and_then(|a| a.as_str()) {
            Some(a) => crate::models::AgentType::from_wire(a)
                .ok_or_else(|| format!("no agent `{a}`"))?,
            None => current
                .map(|c| c.agent_type)
                .or_else(|| brain_of(bot).map(|b| b.agent_type))
                .ok_or("name the agent: `work_agent.agent_type`")?,
        };
        let given = super::options::Partial::from_json(value.get("options"))?;
        let extra: Vec<_> = current
            .filter(|c| c.agent_type == agent_type)
            .map(|c| c.agent_options.clone())
            .into_iter()
            .collect();
        let (config, picked) = self
            .fill_options(agent_type, &given, &extra)
            .await
            .map_err(|e| match e {
                super::bots::FillError::Unavailable(why) => format!(
                    "codeg could not read the options of {} ({why}); name every option, or the \
                     owner can pick it in this assistant's settings",
                    crate::acp::registry::get_agent_meta(agent_type).name
                ),
                super::bots::FillError::Refused(e) => e,
            })?;
        crate::db::service::assistant_service::validate_agent_config(&config)
            .map_err(|e| e.to_string())?;
        Ok((config, picked))
    }

    /// Point `bot`'s work at `config`: its executor config changed in
    /// place when it is the only assistant bound to it; else (shared, or
    /// none to work with) one made for it now, through `save`.
    async fn write_work_agent(
        &self,
        bot: &crate::db::entities::personal_agent::Model,
        config: crate::models::AssistantAgentConfig,
        draft: &mut crate::models::personal_agent::PersonalAgentDraft,
    ) -> Result<(), String> {
        // Whether another assistant is bound to it, and the change in place,
        // in one hold with every binding of an existing executor config to
        // a new assistant (made, copied): none comes between.
        let _claim = workdir::WORKDIR_CLAIM.lock().await;
        let bot = svc::get_bot(&self.db.conn, bot.id)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("the assistant is gone")?;
        let live = match bot.executor_assistant_id {
            Some(id) => crate::db::service::assistant_service::get(&self.db.conn, id)
                .await
                .map_err(|e| e.to_string())?
                .filter(|a| a.is_live()),
            None => None,
        };
        if let Some(a) = live {
            let shared = svc::list_bots(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .iter()
                .any(|b| b.id != bot.id && b.executor_assistant_id == Some(a.id));
            if !shared {
                crate::commands::assistants::assistant_update_core(
                    &self.emitter,
                    &self.db,
                    a.id,
                    crate::models::assistant::AssistantPatch {
                        agent_config: Some(config),
                        ..Default::default()
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
                return Ok(());
            }
        }
        draft.executor_config = Some(config);
        Ok(())
    }

    /// Bind `bot` back onto executor config `id` if it is still there and
    /// still runs `config` — looked at and bound in the one hold every
    /// change of who is bound to what, and every change in place, is made
    /// in. Whether it was.
    async fn bind_back(
        &self,
        bot: &crate::db::entities::personal_agent::Model,
        id: i32,
        config: &Value,
    ) -> Result<bool, String> {
        if config.is_null() {
            return Ok(false);
        }
        let _claim = workdir::WORKDIR_CLAIM.lock().await;
        let same = crate::db::service::assistant_service::get(&self.db.conn, id)
            .await
            .map_err(|e| e.to_string())?
            .filter(|a| a.is_live())
            .is_some_and(|a| {
                serde_json::to_value(crate::models::AssistantAgentConfig {
                    agent_type: a.agent_type,
                    agent_options: a.agent_options,
                    label_snapshot: a.label_snapshot,
                })
                .ok()
                .as_ref()
                    == Some(config)
            });
        if same {
            svc::set_executor_binding(&self.db.conn, bot.id, Some(id))
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(same)
    }

    // ── writing ─────────────────────────────────────────────────────────────

    /// Write the work assistants' items of a plan.
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
        for a in applied {
            if let Some(rest) = a.key.strip_prefix("bot.") {
                if let Some((uid, _)) = rest.rsplit_once('.') {
                    bots.entry(uid.to_string()).or_default().push(a);
                }
            }
        }
        for (uid, items) in bots {
            let bot = svc::list_bots(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .into_iter()
                .find(|b| b.uid.as_deref() == Some(uid.as_str()))
                .ok_or_else(|| format!("no assistant `{uid}`"))?;
            let mut draft = crate::models::personal_agent::PersonalAgentDraft::default();
            let mut roster = svc::RosterWrite::default();
            for item in items {
                let field = item.key.rsplit('.').next().unwrap_or_default();
                match field {
                    "persona" => {
                        let paragraph = item.to.as_str().unwrap_or_default().to_string();
                        let update = move |now: Option<&str>| {
                            Some(super::team::with_persona_paragraph(
                                now.unwrap_or_default(),
                                &paragraph,
                            ))
                        };
                        workdir::write_for_owner(
                            &self.workdir_of(&bot),
                            &[(workdir::SOUL_FILE, &update)],
                            &format!("owner: persona of {}", display_name(&bot)),
                        )
                        .await
                        .map_err(|e| format!("{}'s persona was not written: {e}", display_name(&bot)))?;
                        // Its next delivery hands the persona over, even when
                        // the turn running now settles with it.
                        if let Ok(Some(seg)) = svc::open_segment(&self.db.conn, bot.id).await {
                            self.update_segment_state(seg.id, |s| s.persona_resend = true)
                                .await;
                        }
                    }
                    "work_agent" => {
                        // An undo: back onto the executor config it was bound
                        // to — when that is another, still there, and still
                        // runs what the undo puts back.
                        let back = match item
                            .executor_before
                            .filter(|b| item.undo && Some(*b) != bot.executor_assistant_id)
                        {
                            Some(b) => self.bind_back(&bot, b, &item.to).await?,
                            None => false,
                        };
                        if item.to.is_null() {
                            svc::set_executor_binding(&self.db.conn, bot.id, None)
                                .await
                                .map_err(|e| e.to_string())?;
                        } else if !back {
                            let config = serde_json::from_value(item.to.clone())
                                .map_err(|e| e.to_string())?;
                            self.write_work_agent(&bot, config, &mut draft).await?;
                        }
                    }
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
                    "notify" => roster.notify = item.to.as_bool(),
                    "muted" => roster.muted = item.to.as_bool(),
                    "hidden" => roster.hidden = item.to.as_bool(),
                    _ => {}
                }
            }
            let saves = draft.name.is_some()
                || draft.avatar.is_some()
                || draft.agent_config.is_some()
                || draft.executor_config.is_some();
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
        if let Some(p) = args.get("persona").filter(|v| !v.is_null()) {
            if let Err(e) = text_of("persona", p, MAX_PERSONA_CHARS, false) {
                return ToolOutcome::refused(e);
            }
        }
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
        if changes.is_empty() {
            return ToolOutcome::refused(
                "name what to change: name, shape, color, brain, notify, muted, hidden, persona, \
                 work_agent",
            );
        }
        self.change_settings_call("bot_update", changes, args).await
    }

    /// Names for the uids a plan's keys hold, for its card.
    pub(super) async fn team_names(&self, plan: &[Applied]) -> Value {
        let mut names = serde_json::Map::new();
        let bots = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        for a in plan {
            if let Some((uid, _)) = a.key.strip_prefix("bot.").and_then(|r| r.rsplit_once('.')) {
                if let Some(b) = bots.iter().find(|b| b.uid.as_deref() == Some(uid)) {
                    names.insert(format!("bot:{uid}"), json!(display_name(b)));
                }
            }
        }
        Value::Object(names)
    }
}

