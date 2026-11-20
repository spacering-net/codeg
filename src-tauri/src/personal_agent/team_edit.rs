//! The team changed from the conversation (10.5, 13.3): `bot_update`
//! changes a work assistant.
//!
//! A change goes the way every settings change does (`prefs`): what the owner
//! says is changed at once, with a "changed" card that shows each item, its
//! old and new value, and undoes it; with "show me first" on, the card comes
//! first; what the assistant only infers (`suggest`) is a suggestion card.
//! The items are keys like any other —
//!
//! - `bot.<uid>.{name, avatar, brain, notify, muted, hidden}`.
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
use crate::db::entities::personal_agent::BotKind;
use crate::db::service::personal_agent_service as svc;
use crate::models::personal_agent::PersonalAgentChange;
use crate::models::personal_agent_bots::{BotAvatar, PickedOption};

/// A work assistant's items `bot_update` changes.
const BOT_FIELDS: &[&str] = &["name", "avatar", "brain", "notify", "muted", "hidden"];
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
            "notify" => (json!(bot.notify), bool_of(field, value)?, None),
            "muted" => (json!(bot.muted), bool_of(field, value)?, None),
            _ => (json!(bot.hidden), bool_of(field, value)?, None),
        })
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
                .find(|b| b.uid.as_deref() == Some(uid.as_str()) && b.kind == BotKind::Worker)
                .ok_or_else(|| format!("no work assistant `{uid}`"))?;
            let mut draft = crate::models::personal_agent::PersonalAgentDraft::default();
            let mut roster = svc::RosterWrite::default();
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
                    "notify" => roster.notify = item.to.as_bool(),
                    "muted" => roster.muted = item.to.as_bool(),
                    "hidden" => roster.hidden = item.to.as_bool(),
                    _ => {}
                }
            }
            let saves =
                draft.name.is_some() || draft.avatar.is_some() || draft.agent_config.is_some();
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
        if changes.is_empty() {
            return ToolOutcome::refused(
                "name what to change: name, shape, color, brain, notify, muted, hidden",
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

