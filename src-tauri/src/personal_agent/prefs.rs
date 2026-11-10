//! The settings as the engine reads and changes them, and the changes the
//! owner makes from the conversation (13.3).
//!
//! One way in for every change — the settings view's per-item saves, the
//! assistant's `prefs_update`, a card's [Undo]: a list of items, checked,
//! written as a JSON merge patch in one statement per row. The account's
//! items (the preferences, the team) go onto the primary's row, an
//! assistant's own onto its row. Two windows changing different items both
//! keep theirs.
//!
//! From the conversation:
//! - **what the owner says**, changed at once: a "changed" card names each
//!   item, its old and new value and the owner's words, and undoes it. With
//!   "show me first" on, the card comes first and nothing changes until they
//!   say so.
//! - **what the assistant infers** (`suggest`) is a suggestion card: only the
//!   owner's [Change it] changes it. An item the owner said no to is not
//!   suggested again for seven days.
//!
//! There is no item that cannot be changed this way.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::engine::{settings_of, text_digest, PersonalAgentEngine};
use super::messages::{bot_face, display_name, Unnamed};
use super::tools::ToolOutcome;
use crate::db::entities::personal_agent::BotKind;
use crate::db::entities::personal_agent_notice::{
    self as notice_entity, NoticeKind, NoticeLevel, NoticeState,
};
use crate::db::entities::personal_agent_timeline::TimelineKind;
use crate::db::service::personal_agent_service as svc;
use crate::db::service::personal_agent_service::{NewNotice, NewRow};
use crate::models::personal_agent::{PersonalAgentChange, TimelineRow};
use crate::models::personal_agent_prefs::{
    self as prefs, check_division, check_pref, AccountView, ExecutorUsage, Prefs,
};

/// How long an item the owner said no to is not suggested again.
const SUGGEST_MUTE_DAYS: i64 = 7;

/// An assistant's own settings that can be changed item by item, and the
/// range each takes.
const OWN_ITEMS: &[&str] = &[
    "auto_compact_percent",
    "compact_command",
    "handoff_budget_chars",
    "dispatch_concurrency",
    "skill_enabled",
];

/// One item to change: `prefs.<item>` (or `prefs.automation_level`, which
/// sets several), `own.<item>`, `team.division.<kind of work>`,
/// `team.usage.<executor config uid>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingChange {
    pub key: String,
    #[serde(default)]
    pub value: Value,
}

/// One item as a change left it: what it was, what it is. `auto`, a
/// default usage and an unset command are `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Applied {
    pub key: String,
    pub from: Value,
    pub to: Value,
}

/// Whether a key is the account's (on the primary's row).
fn is_account(key: &str) -> bool {
    key.starts_with("prefs.") || key.starts_with("team.")
}

/// An own item's value, checked.
fn check_own(item: &str, value: &Value) -> Result<Value, String> {
    let int = |min: i64, max: i64| -> Result<Value, String> {
        let n = value
            .as_i64()
            .or_else(|| value.as_str().and_then(|s| s.trim().parse().ok()))
            .ok_or_else(|| format!("`{item}` takes a whole number, {min} to {max}"))?;
        if n < min || n > max {
            return Err(format!("`{item}` takes a whole number, {min} to {max}"));
        }
        Ok(json!(n))
    };
    match item {
        "auto_compact_percent" => int(0, 100),
        "handoff_budget_chars" => int(4_000, 200_000),
        "dispatch_concurrency" => int(0, 64),
        "skill_enabled" => value
            .as_bool()
            .map(Value::from)
            .ok_or_else(|| "`skill_enabled` takes true or false".to_string()),
        "compact_command" => match value {
            Value::Null => Ok(Value::Null),
            Value::String(s) if s.trim().is_empty() => Ok(Value::Null),
            Value::String(s) => Ok(json!(s.trim())),
            _ => Err("`compact_command` takes a command, or null for the default".into()),
        },
        other => Err(format!("no setting `{other}`")),
    }
}

/// The keys the assistant's tool names, as the store knows them: a
/// preference by its name, an own setting by its name.
fn tool_key(raw: &str) -> Option<String> {
    let k = raw.trim();
    let k = k.strip_prefix("prefs.").unwrap_or(k);
    if prefs::spec(k).is_some() || k == prefs::AUTOMATION_KEY {
        return Some(format!("prefs.{k}"));
    }
    let k = k.strip_prefix("own.").unwrap_or(k);
    (OWN_ITEMS.contains(&k) || k == BRAIN_ITEM).then(|| format!("own.{k}"))
}

/// The assistant's brain, as a setting: its agent and options (13.3).
const BRAIN_ITEM: &str = "brain";

/// Every key the tool takes, for a refusal.
fn tool_keys() -> String {
    let mut keys: Vec<&str> = prefs::PREFS.iter().map(|s| s.key).collect();
    keys.push(prefs::AUTOMATION_KEY);
    keys.extend(OWN_ITEMS);
    keys.push(BRAIN_ITEM);
    keys.join(", ")
}

/// Merge `value` into `patch` at the dotted `path`.
fn put(patch: &mut Map<String, Value>, path: &[&str], value: Value) {
    match path {
        [] => {}
        [last] => {
            patch.insert((*last).to_string(), value);
        }
        [head, rest @ ..] => {
            let entry = patch
                .entry((*head).to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if !entry.is_object() {
                *entry = Value::Object(Map::new());
            }
            if let Value::Object(inner) = entry {
                put(inner, rest, value);
            }
        }
    }
}

/// The changes, one line each, as the brain reads them.
fn changes_text(changes: &[Applied]) -> String {
    changes
        .iter()
        .map(|c| {
            let show = |v: &Value| match v {
                Value::Null => "default".to_string(),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            format!("{} {} → {}", c.key, show(&c.from), show(&c.to))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Who changed it and why, as a card shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Why {
    /// The owner said so: changed at once.
    Asked,
    /// The owner said so, and asked to see such changes first.
    Show,
    /// The assistant inferred it.
    Suggest,
}

impl Why {
    fn as_str(self) -> &'static str {
        match self {
            Why::Asked => "asked",
            Why::Show => "show",
            Why::Suggest => "suggest",
        }
    }
}

impl PersonalAgentEngine {
    /// The account's preferences and team, from the primary's row.
    pub async fn account(&self) -> AccountView {
        match svc::primary_bot(&self.db.conn).await.ok().flatten() {
            Some(p) => AccountView::from_settings(&p.settings),
            None => AccountView {
                automation_level: Prefs::default().automation_level().to_string(),
                ..AccountView::default()
            },
        }
    }

    pub async fn prefs(&self) -> Prefs {
        self.account().await.prefs
    }

    /// Check `changes` against what is stored: each item, what it is and
    /// what it would be. Items already at the value are left out.
    pub(super) async fn plan_settings(
        &self,
        changes: &[SettingChange],
    ) -> Result<Vec<Applied>, String> {
        let account = self.account().await;
        let own = self.agent_row().await;
        let stored_prefs = account.prefs.to_map();
        let own_settings = own.as_ref().map(settings_of).unwrap_or_default();
        let own_map = match serde_json::to_value(&own_settings) {
            Ok(Value::Object(m)) => m,
            _ => Map::new(),
        };
        // `automation_level` stands for the items it sets.
        let mut expanded: Vec<SettingChange> = Vec::new();
        for c in changes {
            if c.key == format!("prefs.{}", prefs::AUTOMATION_KEY) {
                let level = c.value.as_str().unwrap_or_default();
                let preset = prefs::automation_preset(level)
                    .ok_or("`automation_level` takes standard or ask_more")?;
                for (k, v) in preset {
                    expanded.push(SettingChange {
                        key: format!("prefs.{k}"),
                        value: v,
                    });
                }
            } else {
                expanded.push(c.clone());
            }
        }
        let mut out: Vec<Applied> = Vec::new();
        let mut seen = BTreeSet::new();
        for c in expanded {
            let (from, to) = if let Some(item) = c.key.strip_prefix("prefs.") {
                let to = check_pref(item, &c.value)?;
                (stored_prefs.get(item).cloned().unwrap_or(Value::Null), to)
            } else if c.key == format!("own.{BRAIN_ITEM}") {
                let row = own.as_ref().ok_or("set the assistant up first")?;
                let from = super::engine::brain_of(row).ok_or("set the assistant up first")?;
                let to = self.plan_brain(&from, &c.value).await?;
                (
                    serde_json::to_value(&from).map_err(|e| e.to_string())?,
                    serde_json::to_value(&to).map_err(|e| e.to_string())?,
                )
            } else if let Some(item) = c.key.strip_prefix("own.") {
                if !OWN_ITEMS.contains(&item) {
                    return Err(format!("no setting `{item}`"));
                }
                if own.is_none() {
                    return Err("set the assistant up first".into());
                }
                let to = check_own(item, &c.value)?;
                (own_map.get(item).cloned().unwrap_or(Value::Null), to)
            } else if let Some(kind) = c.key.strip_prefix("team.division.") {
                let to = check_division(kind, &c.value)?;
                if let Some(pick) = &to {
                    self.check_pick(pick).await?;
                }
                (
                    account
                        .team
                        .division
                        .get(kind)
                        .cloned()
                        .map(Value::from)
                        .unwrap_or(Value::Null),
                    to.map(Value::from).unwrap_or(Value::Null),
                )
            } else if let Some(uid) = c.key.strip_prefix("team.usage.") {
                let live = crate::db::service::assistant_service::list_all(&self.db.conn)
                    .await
                    .map_err(|e| e.to_string())?
                    .into_iter()
                    .any(|a| a.uid == uid && a.is_live());
                if !live {
                    return Err(format!("no executor config `{uid}`"));
                }
                let to = match &c.value {
                    Value::Null => None,
                    v => Some(
                        serde_json::from_value::<ExecutorUsage>(v.clone())
                            .map_err(|e| format!("not a usage: {e}"))?
                            .checked()?,
                    ),
                };
                let to = to
                    .filter(|u| !u.is_default())
                    .map(|u| serde_json::to_value(u).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null);
                let from = account
                    .team
                    .usage
                    .get(uid)
                    .filter(|u| !u.is_default())
                    .map(|u| serde_json::to_value(u).unwrap_or(Value::Null))
                    .unwrap_or(Value::Null);
                (from, to)
            } else {
                return Err(format!("no setting `{}`", c.key));
            };
            if from == to || !seen.insert(c.key.clone()) {
                continue;
            }
            out.push(Applied {
                key: c.key,
                from,
                to,
            });
        }
        if out.iter().any(|a| is_account(&a.key))
            && svc::primary_bot(&self.db.conn)
                .await
                .ok()
                .flatten()
                .is_none()
        {
            return Err("set the primary assistant up first".into());
        }
        Ok(out)
    }

    /// What a change of the brain comes to: a whole selection as given (an
    /// undo, a card's), or `{agent_type, options}` with the rest filled in
    /// as a new assistant's are (10.5 "fill five") — this brain's own
    /// choices first when it stays on the same agent.
    async fn plan_brain(
        &self,
        current: &crate::models::AssistantAgentConfig,
        value: &Value,
    ) -> Result<crate::models::AssistantAgentConfig, String> {
        if value.get("label_snapshot").is_some() {
            let whole: crate::models::AssistantAgentConfig =
                serde_json::from_value(value.clone()).map_err(|e| format!("not a brain: {e}"))?;
            super::bots::check_brain(&whole)?;
            return Ok(whole);
        }
        let agent_type = match value.get("agent_type").and_then(|a| a.as_str()) {
            Some(a) => crate::models::AgentType::from_wire(a).ok_or_else(|| format!("no agent `{a}`"))?,
            None => current.agent_type,
        };
        let given = super::options::Partial::from_json(value.get("options"))?;
        let extra: Vec<_> = (agent_type == current.agent_type)
            .then(|| current.agent_options.clone())
            .into_iter()
            .collect();
        let (config, _) = self
            .fill_options(agent_type, &given, &extra)
            .await
            .map_err(|e| match e {
                super::bots::FillError::Unavailable(why) => format!(
                    "codeg could not read the options of {} ({why}); the owner can switch the brain \
                     in this assistant's settings",
                    crate::acp::registry::get_agent_meta(agent_type).name
                ),
                super::bots::FillError::Refused(e) => e,
            })?;
        super::bots::check_brain(&config)?;
        Ok(config)
    }

    /// A division pick names someone who is there.
    async fn check_pick(&self, pick: &str) -> Result<(), String> {
        let Some((kind, uid)) = pick.split_once(':') else {
            return Err("a division pick is auto, bot:<uid> or assistant:<uid>".into());
        };
        let found = match kind {
            "bot" => svc::list_bots(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .iter()
                .any(|b| b.uid.as_deref() == Some(uid) && b.kind == BotKind::Worker),
            _ => crate::db::service::assistant_service::list_all(&self.db.conn)
                .await
                .map_err(|e| e.to_string())?
                .iter()
                .any(|a| a.uid == uid && a.is_live()),
        };
        if found {
            Ok(())
        } else {
            Err(format!(
                "no {} `{uid}`",
                if kind == "bot" {
                    "work assistant"
                } else {
                    "executor config"
                }
            ))
        }
    }

    /// Write what a plan says each item is to be, and tell the pages.
    pub(super) async fn write_settings(&self, applied: &[Applied]) -> Result<(), String> {
        if applied.is_empty() {
            return Ok(());
        }
        let answers_changed = applied
            .iter()
            .any(|a| a.key == "prefs.exec_questions" || a.key == "prefs.exec_plans");
        self.write_settings_now(applied).await?;
        // Who answers the executors' questions changed: every running
        // session's windows are told anew (7.3.1).
        if answers_changed {
            match self.host_ref() {
                Some(host) => {
                    for engine in host.engines().await {
                        engine.refresh_ask_delegates().await;
                    }
                }
                None => self.refresh_ask_delegates().await,
            }
        }
        Ok(())
    }

    pub(super) async fn write_settings_now(&self, applied: &[Applied]) -> Result<(), String> {
        let mut account = Map::new();
        let mut own = Map::new();
        // The brain is the row's own columns, written as the identity page
        // writes them: a switch of agent starts a new session.
        let brain_key = format!("own.{BRAIN_ITEM}");
        if let Some(b) = applied.iter().find(|a| a.key == brain_key) {
            let config: crate::models::AssistantAgentConfig =
                serde_json::from_value(b.to.clone()).map_err(|e| e.to_string())?;
            self.save(crate::models::personal_agent::PersonalAgentDraft {
                agent_config: Some(config),
                ..Default::default()
            })
            .await?;
        }
        for a in applied.iter().filter(|a| a.key != brain_key) {
            let path: Vec<&str> = if let Some(rest) = a.key.strip_prefix("team.usage.") {
                vec!["team", "usage", rest]
            } else {
                a.key.splitn(3, '.').collect()
            };
            match path.as_slice() {
                ["own", item] => {
                    own.insert((*item).to_string(), a.to.clone());
                    // A command belongs to the agent it was written for.
                    if *item == "compact_command" {
                        let agent = self
                            .agent_row()
                            .await
                            .map(|r| Value::from(r.agent_type))
                            .unwrap_or(Value::Null);
                        own.insert(
                            "compact_command_agent".into(),
                            if a.to.is_null() { Value::Null } else { agent },
                        );
                    }
                }
                [_, ..] => put(&mut account, &path, a.to.clone()),
                [] => {}
            }
        }
        let me = self.agent_row().await;
        let primary = svc::primary_bot(&self.db.conn)
            .await
            .map_err(|e| e.to_string())?;
        // Onto the primary's row: the account's items, and its own when it
        // is the one changing.
        let mut writes: Vec<(i32, Map<String, Value>)> = Vec::new();
        match (&me, &primary) {
            (Some(m), Some(p)) if m.id == p.id => {
                let mut both = account;
                both.extend(own);
                writes.push((p.id, both));
            }
            _ => {
                if !account.is_empty() {
                    let p = primary
                        .as_ref()
                        .ok_or("set the primary assistant up first")?;
                    writes.push((p.id, account));
                }
                if !own.is_empty() {
                    let m = me.as_ref().ok_or("set the assistant up first")?;
                    writes.push((m.id, own));
                }
            }
        }
        for (id, patch) in &writes {
            svc::patch_settings(&self.db.conn, *id, &Value::Object(patch.clone()))
                .await
                .map_err(|e| e.to_string())?
                .ok_or("the assistant is gone")?;
        }
        // Every assistant reads the account's; its own reads its own.
        if applied.iter().any(|a| is_account(&a.key)) {
            for b in svc::list_bots(&self.db.conn).await.unwrap_or_default() {
                self.emit_for(b.id, PersonalAgentChange::Agent);
            }
        } else {
            self.emit(PersonalAgentChange::Agent);
        }
        Ok(())
    }

    /// Check and write `changes`: the settings view's per-item save.
    pub async fn apply_settings(&self, changes: &[SettingChange]) -> Result<Vec<Applied>, String> {
        let plan = self.plan_settings(changes).await?;
        self.write_settings(&plan).await?;
        Ok(plan)
    }

    /// Take `applied` back: each item that still is what the change made it
    /// goes back to what it was; one changed again since stays (its key is
    /// returned among the second list).
    async fn undo_settings(
        &self,
        applied: &[Applied],
    ) -> Result<(Vec<Applied>, Vec<String>), String> {
        let current = self
            .plan_settings(
                &applied
                    .iter()
                    .map(|a| SettingChange {
                        key: a.key.clone(),
                        value: a.from.clone(),
                    })
                    .collect::<Vec<_>>(),
            )
            .await?;
        let mut back = Vec::new();
        let mut kept = Vec::new();
        for a in applied {
            match current.iter().find(|c| c.key == a.key) {
                // Still what the change made it: back it goes.
                Some(c) if c.from == a.to => back.push(c.clone()),
                // Already back where it was: nothing to do.
                None => {}
                Some(_) => kept.push(a.key.clone()),
            }
        }
        self.write_settings(&back).await?;
        Ok((back, kept))
    }

    // ── from the conversation ───────────────────────────────────────────────

    /// `prefs_update`: the owner's words change it (at once, or on a card
    /// first when they asked to see such changes first); the assistant's
    /// own inference (`suggest`) only suggests it.
    pub(super) async fn prefs_update_call(self: &Arc<Self>, args: &Value) -> ToolOutcome {
        let mut raw: Vec<SettingChange> = Vec::new();
        if let Some(list) = args.get("changes").and_then(|v| v.as_array()) {
            for c in list {
                let Some(key) = c.get("key").and_then(|k| k.as_str()) else {
                    return ToolOutcome::refused("each change needs `key` and `value`");
                };
                raw.push(SettingChange {
                    key: key.to_string(),
                    value: c.get("value").cloned().unwrap_or(Value::Null),
                });
            }
        } else if let Some(key) = args.get("key").and_then(|k| k.as_str()) {
            raw.push(SettingChange {
                key: key.to_string(),
                value: args.get("value").cloned().unwrap_or(Value::Null),
            });
        }
        if raw.is_empty() {
            return ToolOutcome::refused(format!(
                "name what to change: `changes`: [{{key, value}}]; keys: {}",
                tool_keys()
            ));
        }
        let mut changes = Vec::new();
        for c in raw {
            let Some(key) = tool_key(&c.key) else {
                return ToolOutcome::refused(format!(
                    "no setting `{}`; the keys are: {}",
                    c.key,
                    tool_keys()
                ));
            };
            changes.push(SettingChange {
                key,
                value: c.value,
            });
        }
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
            return ToolOutcome::refused(
                "a suggestion needs `reason`: why you think it fits the owner",
            );
        }
        if !suggest && quote.is_none() {
            return ToolOutcome::refused(
                "`quote` the owner's words this follows; a change you only infer is a suggestion \
                 (`suggest: true` with a `reason`)",
            );
        }
        // A re-delivered turn asks again: what the first call answered is
        // the answer, whatever the settings are now. Its identity is the
        // call as made — never what it came to, which later edits change.
        let key = format!(
            "prefs|{}",
            text_digest(
                &json!({ "changes": changes, "suggest": suggest, "quote": quote }).to_string()
            )
        );
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
                                "Already done: the turn this delivery repeats made this same \
                                 call, and it answered: {}",
                                e.detail.unwrap_or_default()
                            ),
                            json!({ "earlier": true, "first": data }),
                        );
                    }
                }
                Err(e) => return ToolOutcome::refused(e.to_string()),
            }
        }
        let outcome = self
            .prefs_update_run(
                &changes,
                suggest,
                quote,
                reason,
                args,
                ledger.as_ref().map(|(b, _)| *b),
                &key,
            )
            .await;
        // Whatever it came to — changed, on a card, nothing to change — is
        // what a replay answers. A refusal changed nothing: a replay may try
        // again.
        if let (true, Some((batch, _))) = (outcome.ok, &ledger) {
            let slot = svc::LedgerSlot::in_batch(*batch, key, super::ledger::fresh_op_id());
            if let Err(e) = svc::record_done_op(
                &self.db.conn,
                self.bot().await,
                &slot,
                "prefs",
                json!({ "changes": changes, "suggest": suggest }),
                &outcome.text,
                outcome.data.clone(),
            )
            .await
            {
                tracing::warn!("[personal-agent] prefs_update was not put in the ledger: {e}");
            }
        }
        outcome
    }

    /// `prefs_update` past its checks: plan it, and change it, show it or
    /// suggest it.
    #[allow(clippy::too_many_arguments)]
    async fn prefs_update_run(
        &self,
        changes: &[SettingChange],
        suggest: bool,
        quote: Option<String>,
        reason: Option<String>,
        args: &Value,
        batch: Option<i32>,
        key: &str,
    ) -> ToolOutcome {
        let plan = match self.plan_settings(changes).await {
            Ok(p) => p,
            Err(e) => return ToolOutcome::refused(e),
        };
        if plan.is_empty() {
            return ToolOutcome::ok(
                "Nothing to change: every item already is what you asked for.",
                json!({ "changes": [] }),
            );
        }
        // The owner's message it follows, for the card to quote.
        let for_row = match self
            .input_for(args.get("for").and_then(|v| v.as_str()), Unnamed::Nothing)
            .await
        {
            Ok(Some(i)) if i.logical.starts_with("owner:") => {
                i.reference.trim_start_matches('#').parse::<i32>().ok()
            }
            Ok(_) => None,
            Err(e) => return ToolOutcome::refused(e),
        };
        let why = if suggest {
            Why::Suggest
        } else if self.prefs().await.chat_changes == prefs::ChatChanges::Show {
            Why::Show
        } else {
            Why::Asked
        };
        if why == Why::Suggest {
            if let Some(refusal) = self.muted_suggestion(&plan).await {
                return ToolOutcome::refused(refusal);
            }
        }
        if why == Why::Asked {
            if let Err(e) = self.write_settings(&plan).await {
                return ToolOutcome::refused(e);
            }
        }
        let card = match self
            .raise_changed(
                why,
                &plan,
                quote,
                reason,
                for_row,
                Some(key.to_string()),
                batch,
            )
            .await
        {
            Ok(id) => id,
            Err(e) if why == Why::Asked => {
                tracing::warn!("[personal-agent] the changed card was not written: {e}");
                0
            }
            Err(e) => return ToolOutcome::refused(e),
        };
        if why == Why::Asked {
            self.record_for_primary(&plan).await;
        }
        let list = changes_text(&plan);
        let text = match why {
            Why::Asked => {
                format!("Changed: {list}. The owner sees a card saying so, and can undo it there.")
            }
            Why::Show => format!(
                "On a card for the owner to confirm first (they asked to see such changes \
                 first): {list}. Nothing is changed yet; you will hear how they answered."
            ),
            Why::Suggest => format!(
                "Suggested on a card: {list}. It changes only if the owner says so; you will \
                 hear how they answered."
            ),
        };
        ToolOutcome::ok(
            text,
            json!({
                "notice_id": card,
                "state": if why == Why::Asked { "applied" } else { "open" },
                "changes": plan,
            }),
        )
    }

    /// Why a suggestion may not be made: the owner said no to one of its
    /// items within the last seven days.
    async fn muted_suggestion(&self, plan: &[Applied]) -> Option<String> {
        let since = chrono::Utc::now() - chrono::Duration::days(SUGGEST_MUTE_DAYS);
        let me = self.bot().await;
        let declined = svc::notices_since(
            &self.db.conn,
            NoticeKind::Changed,
            &[NoticeState::Dismissed],
            since,
        )
        .await
        .unwrap_or_default();
        for n in declined {
            let payload: Value = serde_json::from_str(&n.payload).unwrap_or(Value::Null);
            if payload.get("why").and_then(|w| w.as_str()) != Some(Why::Suggest.as_str()) {
                continue;
            }
            let keys: Vec<String> = payload
                .get("changes")
                .and_then(|c| serde_json::from_value::<Vec<Applied>>(c.clone()).ok())
                .unwrap_or_default()
                .into_iter()
                .map(|a| a.key)
                .collect();
            for a in plan {
                // An own item is that assistant's: another's no is not this one's.
                let same_scope = is_account(&a.key) || n.bot_id == Some(me);
                if same_scope && keys.contains(&a.key) {
                    let until = n.updated_at + chrono::Duration::days(SUGGEST_MUTE_DAYS);
                    return Some(format!(
                        "the owner turned down changing `{}` on {}; do not suggest it again before {}",
                        a.key,
                        n.updated_at.format("%Y-%m-%d"),
                        until.format("%Y-%m-%d")
                    ));
                }
            }
        }
        None
    }

    /// Write a "changed" card: applied already (`Asked`), or waiting for the
    /// owner.
    #[allow(clippy::too_many_arguments)]
    async fn raise_changed(
        &self,
        why: Why,
        plan: &[Applied],
        quote: Option<String>,
        reason: Option<String>,
        for_row: Option<i32>,
        subject: Option<String>,
        batch_id: Option<i32>,
    ) -> Result<i32, String> {
        let state = if why == Why::Asked { "applied" } else { "open" };
        let mut row = NewRow::new(TimelineKind::Notice, changes_text(plan));
        row.segment_id = self.state.lock().await.connection_segment;
        row.batch_id = batch_id;
        row.data = Some(json!({
            "notice": "changed",
            "state": state,
            "why": why.as_str(),
            "changes": plan,
            "quote": quote,
            "reason": reason,
            "for_row": for_row,
        }));
        let (notice, card) = svc::create_notice_with_row(
            &self.db.conn,
            self.bot().await,
            NewNotice {
                kind: NoticeKind::Changed,
                subject_key: subject,
                level: if why == Why::Suggest {
                    NoticeLevel::Low
                } else {
                    NoticeLevel::Normal
                },
                batch_id,
                payload: json!({
                    "why": why.as_str(),
                    "changes": plan,
                    "bot": self.bot().await,
                }),
            },
            row,
        )
        .await
        .map_err(|e| e.to_string())?;
        if why == Why::Asked {
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

    /// A work assistant changed the account's items: the primary's
    /// conversation records it too, one line (13.3).
    async fn record_for_primary(&self, plan: &[Applied]) {
        let account: Vec<Applied> = plan
            .iter()
            .filter(|a| is_account(&a.key))
            .cloned()
            .collect();
        if account.is_empty() {
            return;
        }
        let Some(me) = self.agent_row().await else {
            return;
        };
        if me.kind != BotKind::Worker {
            return;
        }
        let Ok(Some(primary)) = svc::primary_bot(&self.db.conn).await else {
            return;
        };
        let mut row = NewRow::new(
            TimelineKind::Notice,
            format!("{} changed: {}", display_name(&me), changes_text(&account)),
        );
        row.data = Some(json!({
            "notice": "changed",
            "state": "applied",
            "why": "line",
            "changes": account,
            "from_bot": bot_face(&me),
        }));
        match svc::create_notice_with_row(
            &self.db.conn,
            primary.id,
            NewNotice {
                kind: NoticeKind::Changed,
                subject_key: None,
                level: NoticeLevel::Low,
                batch_id: None,
                payload: json!({ "why": "line", "changes": account, "bot": me.id }),
            },
            row,
        )
        .await
        {
            Ok((n, card)) => {
                let _ = svc::move_notice(
                    &self.db.conn,
                    n.id,
                    &[NoticeState::Open],
                    NoticeState::Acted,
                )
                .await;
                self.emit_for(
                    primary.id,
                    PersonalAgentChange::Timeline {
                        rows: vec![svc::to_row(card)],
                    },
                );
            }
            Err(e) => {
                tracing::warn!("[personal-agent] the primary's record of a change failed: {e}")
            }
        }
    }

    /// The owner's answer on a "changed" card: `accept` makes a change that
    /// waits for them, `dismiss` drops it, `undo` takes an applied one back.
    pub(super) async fn act_on_changed(
        self: &Arc<Self>,
        notice: &notice_entity::Model,
        action: &str,
    ) -> Result<TimelineRow, String> {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        // Work assistants made, or to make (4.12, 4.15).
        if payload.get("what").and_then(|w| w.as_str()) == Some("bots") {
            return self.act_on_bots_card(notice, action).await;
        }
        let why = payload.get("why").and_then(|w| w.as_str()).unwrap_or("");
        if why == "line" {
            return Err(
                "this is a record; the card to act on is in the conversation where it was changed"
                    .into(),
            );
        }
        let plan: Vec<Applied> = payload
            .get("changes")
            .and_then(|c| serde_json::from_value(c.clone()).ok())
            .unwrap_or_default();
        match action {
            "accept" => {
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
                let changes: Vec<SettingChange> = plan
                    .iter()
                    .map(|a| SettingChange {
                        key: a.key.clone(),
                        value: a.to.clone(),
                    })
                    .collect();
                match self.apply_settings(&changes).await {
                    Ok(made) => {
                        self.record_for_primary(&made).await;
                        let row = self
                            .changed_row(
                                notice,
                                "applied",
                                json!({ "changes": made, "error": null }),
                            )
                            .await?;
                        self.tell_changed(notice, "accepted", &made).await;
                        Ok(row)
                    }
                    Err(e) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Acted],
                            NoticeState::Open,
                        )
                        .await;
                        let _ = self
                            .changed_row(notice, "open", json!({ "error": e.clone() }))
                            .await;
                        Err(e)
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
                let row = self.changed_row(notice, "dismissed", json!({})).await?;
                self.tell_changed(notice, "declined", &plan).await;
                Ok(row)
            }
            "undo" => {
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
                // What it applied: the row knows it after an accept.
                let applied: Vec<Applied> = match notice.timeline_id {
                    Some(id) => svc::get_row(&self.db.conn, id)
                        .await
                        .ok()
                        .flatten()
                        .and_then(|r| r.data)
                        .and_then(|d| serde_json::from_str::<Value>(&d).ok())
                        .and_then(|d| d.get("changes").cloned())
                        .and_then(|c| serde_json::from_value(c).ok())
                        .unwrap_or_else(|| plan.clone()),
                    None => plan.clone(),
                };
                match self.undo_settings(&applied).await {
                    Ok((back, kept)) => {
                        let row = self
                            .changed_row(notice, "undone", json!({ "kept": kept, "error": null }))
                            .await?;
                        if !back.is_empty() {
                            self.tell_changed(notice, "undid", &back).await;
                        }
                        Ok(row)
                    }
                    Err(e) => {
                        let _ = svc::move_notice(
                            &self.db.conn,
                            notice.id,
                            &[NoticeState::Undone],
                            NoticeState::Acted,
                        )
                        .await;
                        let _ = self
                            .changed_row(notice, "applied", json!({ "error": e.clone() }))
                            .await;
                        Err(e)
                    }
                }
            }
            _ => Err("`action` must be accept, dismiss or undo".into()),
        }
    }

    /// Write a "changed" card's state, and what goes with it, onto its row.
    async fn changed_row(
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
                for (k, v) in extra {
                    map.insert(k, v);
                }
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

    /// Let the assistant know how the owner answered, with its next
    /// delivery.
    async fn tell_changed(
        &self,
        notice: &notice_entity::Model,
        verdict: &str,
        changes: &[Applied],
    ) {
        let payload: Value = serde_json::from_str(&notice.payload).unwrap_or(Value::Null);
        let suggested = payload.get("why").and_then(|w| w.as_str()) == Some(Why::Suggest.as_str());
        let list = changes_text(changes);
        let summary = match verdict {
            "accepted" => format!(
                "The owner accepted the settings change on card #{}: {list}. It is in effect.",
                notice.id
            ),
            "declined" if suggested => format!(
                "The owner declined your suggested settings change (card #{}): {list}. Nothing \
                 changed; do not suggest it again for {SUGGEST_MUTE_DAYS} days.",
                notice.id
            ),
            "declined" => format!(
                "The owner declined the settings change on card #{}: {list}. Nothing changed.",
                notice.id
            ),
            _ => format!(
                "The owner undid the settings change on card #{}: {list}.",
                notice.id
            ),
        };
        let _ = svc::insert_event(
            &self.db.conn,
            self.bot().await,
            "changed",
            &format!(
                "notice:{}:{verdict}:{}",
                notice.id,
                chrono::Utc::now().timestamp_millis()
            ),
            None,
            summary,
            Some(json!({ "notice_id": notice.id, "verdict": verdict })),
            false,
        )
        .await;
    }
}

// ── the team, as the brain reads it ──────────────────────────────────────────

/// The modes, as the brain reads them.
fn modes_text(modes: &[crate::db::entities::personal_agent_dispatch::DispatchMode]) -> String {
    use crate::db::entities::personal_agent_dispatch::DispatchMode;
    modes
        .iter()
        .map(|m| match m {
            DispatchMode::Task => "task",
            DispatchMode::Chat => "chat",
            DispatchMode::Session => "session",
        })
        .collect::<Vec<_>>()
        .join(", ")
}

impl PersonalAgentEngine {
    /// The project names, for a refusal or a note.
    async fn project_names(&self, ids: &[i32]) -> String {
        let mut names = Vec::new();
        for id in ids {
            let name = crate::db::service::folder_service::get_folder_by_id(&self.db.conn, *id)
                .await
                .ok()
                .flatten()
                .map(|f| f.alias.clone().unwrap_or(f.name.clone()))
                .unwrap_or_else(|| "(gone)".into());
            names.push(format!("#{id} {name}"));
        }
        names.join(", ")
    }

    /// How the owner lets the assistants use an executor config, one line:
    /// `None` when they set nothing.
    pub(super) async fn usage_note(&self, usage: &ExecutorUsage) -> Option<String> {
        if usage.is_default() {
            return None;
        }
        if !usage.dispatch {
            return Some(
                "not for your dispatches (the owner keeps it for @ in conversations)".into(),
            );
        }
        let mut parts = Vec::new();
        if usage.modes.len() < 3 {
            parts.push(format!("takes only {}", modes_text(&usage.modes)));
        }
        if let Some(p) = &usage.projects {
            parts.push(format!("only on projects {}", self.project_names(p).await));
        }
        Some(parts.join("; "))
    }

    /// Whether a dispatch fits how the owner lets the assistants use its
    /// executor config (10.5, 补齐三): the reason when it does not.
    pub(super) async fn check_usage(
        &self,
        assistant: &crate::models::assistant::AssistantInfo,
        mode: crate::db::entities::personal_agent_dispatch::DispatchMode,
        project: Option<i32>,
    ) -> Result<(), String> {
        let usage = self.account().await.team.usage_of(&assistant.uid);
        if !usage.dispatch {
            return Err(format!(
                "the owner does not let the assistants dispatch to {} (they keep it for @ in \
                 conversations); pick another with assistant_list",
                assistant.name
            ));
        }
        if !usage.modes.contains(&mode) {
            return Err(format!(
                "{} takes only {} dispatches; use one of those modes, or another executor config",
                assistant.name,
                modes_text(&usage.modes)
            ));
        }
        if let (Some(allowed), Some(id)) = (&usage.projects, project) {
            if !allowed.contains(&id) {
                return Err(format!(
                    "{} works only on projects {}; pick another executor config for this one",
                    assistant.name,
                    self.project_names(allowed).await
                ));
            }
        }
        Ok(())
    }

    /// The owner's division of work, as the brain reads it: one line per
    /// kind of work that has a first pick. `None` when every kind is auto.
    pub(super) async fn division_text(&self) -> Option<String> {
        let team = self.account().await.team;
        if team.division.is_empty() {
            return None;
        }
        let bots = svc::list_bots(&self.db.conn).await.unwrap_or_default();
        let assistants = crate::db::service::assistant_service::list_all(&self.db.conn)
            .await
            .unwrap_or_default();
        let mut lines = Vec::new();
        for kind in prefs::DIVISION {
            let Some(pick) = team.division.get(*kind) else {
                continue;
            };
            let Some((what, uid)) = pick.split_once(':') else {
                continue;
            };
            let who = match what {
                "bot" => bots
                    .iter()
                    .find(|b| b.uid.as_deref() == Some(uid))
                    .map(|b| {
                        format!(
                            "{} (work assistant {}: write to it with bot_message)",
                            display_name(b),
                            b.id
                        )
                    }),
                _ => assistants
                    .iter()
                    .find(|a| a.uid == uid && a.is_live())
                    .map(|a| format!("{} (executor config #{}: dispatch to it)", a.name, a.id)),
            };
            if let Some(who) = who {
                lines.push(format!("- {} → {who}", prefs::division_label(kind)));
            }
        }
        if lines.is_empty() {
            return None;
        }
        Some(format!(
            "The owner's division of work — give each kind of work to its first pick, unless the \
             owner names someone else or the pick cannot take it now (then choose as you see \
             fit); kinds not listed are yours to place:\n{}",
            lines.join("\n")
        ))
    }
}

/// An executor config was deleted: the kinds of work that named it first
/// are back to auto, and how the assistants used it is forgotten (10.5,
/// 补齐六). The work it is running keeps running — it runs on its snapshot.
pub async fn forget_executor(
    db: &crate::db::AppDatabase,
    emitter: &crate::web::event_bridge::EventEmitter,
    uid: &str,
) {
    let Ok(Some(primary)) = svc::primary_bot(&db.conn).await else {
        return;
    };
    let team = AccountView::from_settings(&primary.settings).team;
    let pick = format!("assistant:{uid}");
    let mut division = Map::new();
    for (kind, p) in &team.division {
        if *p == pick {
            division.insert(kind.clone(), Value::Null);
        }
    }
    if division.is_empty() && !team.usage.contains_key(uid) {
        return;
    }
    let mut usage = Map::new();
    usage.insert(uid.to_string(), Value::Null);
    let patch = json!({ "team": { "division": division, "usage": usage } });
    match svc::patch_settings(&db.conn, primary.id, &patch).await {
        Ok(_) => {
            for b in svc::list_bots(&db.conn).await.unwrap_or_default() {
                crate::web::event_bridge::emit_event(
                    emitter,
                    super::engine::PERSONAL_AGENT_CHANGED_EVENT,
                    super::engine::change_payload(b.id, &PersonalAgentChange::Agent),
                );
            }
        }
        Err(e) => tracing::warn!("[personal-agent] forgetting executor config {uid} failed: {e}"),
    }
}
