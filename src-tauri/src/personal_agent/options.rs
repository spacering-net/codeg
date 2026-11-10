//! Fill an agent's selection in for the owner (10.5 "fill five"): a work
//! assistant made from a name alone, an executor config made with it, a
//! brain switched to another agent in the conversation. What the owner said
//! is kept; the rest is taken from another executor config on the same
//! agent, else from what the agent reports as its current value. Every value
//! codeg picked is listed, so the card can say which.
//!
//! The option list comes from the agent itself, the way the editor reads it
//! (`acp_describe_agent_options_core`): a transient connection. When it
//! cannot be had (the agent is not installed, does not start), the caller
//! falls back to the editor, prefilled.

use std::collections::BTreeMap;

use crate::acp::delegation::types::AgentDelegationDefaults;
use crate::acp::types::{AgentOptionsSnapshot, SessionConfigKindInfo, SessionConfigOptionInfo};
use crate::models::assistant::{
    AssistantAgentConfig, AssistantLabelSnapshot, AssistantOptionKind, AssistantOptionLabel,
};
use crate::models::personal_agent_bots::{PickedFrom, PickedOption};
use crate::models::AgentType;

/// The id a mode is listed under among the picked options.
pub const MODE_ID: &str = "mode";
/// The model option's id.
pub const MODEL_ID: &str = "model";

/// The model selector and the model the agent reports as its current one.
pub fn current_model(snapshot: &AgentOptionsSnapshot) -> Option<(&str, &str)> {
    snapshot
        .config_options
        .iter()
        .find(|o| is_model(o))
        .and_then(|o| match &o.kind {
            SessionConfigKindInfo::Select(s) => Some((o.id.as_str(), s.current_value.as_str())),
            SessionConfigKindInfo::Boolean(_) => None,
        })
}

/// What was said of a selection: any part of it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Partial {
    pub mode_id: Option<String>,
    pub config_values: BTreeMap<String, String>,
}

impl Partial {
    /// Read `{"mode_id": …, "config_values": {…}}` or a flat `{id: value}`
    /// map, as an assistant writes it.
    pub fn from_json(v: Option<&serde_json::Value>) -> Result<Self, String> {
        let Some(v) = v.filter(|v| !v.is_null()) else {
            return Ok(Self::default());
        };
        let obj = v
            .as_object()
            .ok_or("`options` is an object: {option id: value}")?;
        let mut out = Self::default();
        let values = match obj.get("config_values") {
            Some(cv) => {
                out.mode_id = obj
                    .get("mode_id")
                    .and_then(|m| m.as_str())
                    .map(str::to_string);
                cv.as_object()
                    .ok_or("`config_values` is an object: {option id: value}")?
                    .clone()
            }
            None => obj.clone(),
        };
        for (k, val) in values {
            let s = match val {
                serde_json::Value::String(s) => s,
                serde_json::Value::Bool(b) => b.to_string(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => return Err(format!("option `{k}` takes a string value")),
            };
            if k == MODE_ID && out.mode_id.is_none() {
                out.mode_id = Some(s);
            } else {
                out.config_values.insert(k, s);
            }
        }
        Ok(out)
    }
}

/// The values a select option offers, flat (grouped selects list them flat
/// too).
fn select_values(option: &SessionConfigOptionInfo) -> Vec<(String, String)> {
    let SessionConfigKindInfo::Select(sel) = &option.kind else {
        return Vec::new();
    };
    let mut out: Vec<(String, String)> = Vec::new();
    for o in sel
        .options
        .iter()
        .chain(sel.groups.iter().flat_map(|g| g.options.iter()))
    {
        if !out.iter().any(|(v, _)| v == &o.value) {
            out.push((o.value.clone(), o.name.clone()));
        }
    }
    out
}

fn is_model(option: &SessionConfigOptionInfo) -> bool {
    option.id == "model" || option.category.as_deref() == Some("model")
}

/// A complete selection for `agent_type` from `snapshot` — the editor's
/// rows: the mode only for an agent with modes and no options; a select
/// that offers nothing is left out — keeping what `given` names, taking the
/// rest from `others` (other selections on the same agent, the first that
/// offers a value wins), else the agent's current value. A given value the
/// agent does not offer is refused, with what it does.
pub fn fill_selection(
    agent_type: AgentType,
    snapshot: &AgentOptionsSnapshot,
    given: &Partial,
    others: &[AgentDelegationDefaults],
) -> Result<(AssistantAgentConfig, Vec<PickedOption>), String> {
    let meta = crate::acp::registry::get_agent_meta(agent_type);
    let mut picked: Vec<PickedOption> = Vec::new();
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    let mut labels: Vec<AssistantOptionLabel> = Vec::new();
    let mut mode_id = None;
    let mut mode_label = None;

    let modes = snapshot
        .modes
        .as_ref()
        .map(|m| m.available_modes.as_slice())
        .unwrap_or(&[]);
    if !modes.is_empty() && snapshot.config_options.is_empty() {
        let offered = |id: &str| modes.iter().find(|m| m.id == id);
        let (value, from) = if let Some(want) = given.mode_id.as_deref() {
            if offered(want).is_none() {
                return Err(format!(
                    "{} has no mode `{want}`; its modes: {}",
                    meta.name,
                    modes
                        .iter()
                        .map(|m| m.id.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            (want.to_string(), PickedFrom::Given)
        } else if let Some(o) = others
            .iter()
            .filter_map(|o| o.mode_id.as_deref())
            .find(|m| offered(m).is_some())
        {
            (o.to_string(), PickedFrom::OtherConfig)
        } else {
            let current = snapshot
                .modes
                .as_ref()
                .map(|m| m.current_mode_id.clone())
                .filter(|c| offered(c).is_some())
                .unwrap_or_else(|| modes[0].id.clone());
            (current, PickedFrom::Agent)
        };
        let name = offered(&value)
            .map(|m| m.name.clone())
            .unwrap_or_else(|| value.clone());
        picked.push(PickedOption {
            id: MODE_ID.into(),
            name: "Mode".into(),
            value: value.clone(),
            value_label: name.clone(),
            from,
        });
        mode_id = Some(value);
        mode_label = Some(name);
    } else if let Some(want) = given.mode_id.as_deref() {
        return Err(format!(
            "{} takes no mode here (`{want}`); pick its options instead",
            meta.name
        ));
    }

    // The model first: what the others offer can hang off it.
    let mut options: Vec<&SessionConfigOptionInfo> = snapshot.config_options.iter().collect();
    options.sort_by_key(|o| !is_model(o));
    for option in options {
        let (kind, offered): (AssistantOptionKind, Vec<(String, String)>) = match &option.kind {
            SessionConfigKindInfo::Boolean(_) => (
                AssistantOptionKind::Boolean,
                vec![("true".into(), "On".into()), ("false".into(), "Off".into())],
            ),
            SessionConfigKindInfo::Select(_) => {
                let v = select_values(option);
                if v.is_empty() {
                    continue;
                }
                (AssistantOptionKind::Select, v)
            }
        };
        let label_of = |v: &str| offered.iter().find(|(x, _)| x == v).map(|(_, n)| n.clone());
        let (value, from) = if let Some(want) = given.config_values.get(&option.id) {
            if label_of(want).is_none() {
                return Err(format!(
                    "{}'s `{}` has no value `{want}`; it offers: {}",
                    meta.name,
                    option.id,
                    offered
                        .iter()
                        .map(|(v, _)| v.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                ));
            }
            (want.clone(), PickedFrom::Given)
        } else if let Some(o) = others
            .iter()
            .filter_map(|o| o.config_values.get(&option.id))
            .find(|v| label_of(v).is_some())
        {
            (o.clone(), PickedFrom::OtherConfig)
        } else {
            let current = match &option.kind {
                SessionConfigKindInfo::Boolean(b) => b.current_value.to_string(),
                SessionConfigKindInfo::Select(s) => s.current_value.clone(),
            };
            let value = if label_of(&current).is_some() {
                current
            } else {
                offered[0].0.clone()
            };
            (value, PickedFrom::Agent)
        };
        let value_label = label_of(&value).unwrap_or_else(|| value.clone());
        values.insert(option.id.clone(), value.clone());
        labels.push(AssistantOptionLabel {
            id: option.id.clone(),
            kind,
            name: option.name.clone(),
            value_label: value_label.clone(),
        });
        picked.push(PickedOption {
            id: option.id.clone(),
            name: option.name.clone(),
            value,
            value_label,
            from,
        });
    }
    if let Some(extra) = given
        .config_values
        .keys()
        .find(|k| !values.contains_key(k.as_str()))
    {
        return Err(format!(
            "{} has no option `{extra}`; its options: {}",
            meta.name,
            values.keys().cloned().collect::<Vec<_>>().join(", ")
        ));
    }
    let config = AssistantAgentConfig {
        agent_type,
        agent_options: AgentDelegationDefaults {
            mode_id,
            config_values: values,
        },
        label_snapshot: AssistantLabelSnapshot {
            agent: meta.name.to_string(),
            mode: mode_label,
            options: labels,
        },
    };
    config.validate()?;
    Ok((config, picked))
}

/// The model a selection will run on: the one `given` names when the agent
/// offers it, else another selection's that it offers, else its current
/// one — resolved before anything else, since what the other options offer
/// can hang off it. `None` for an agent with no model selector.
pub fn resolve_model(
    snapshot: &AgentOptionsSnapshot,
    given: &Partial,
    others: &[AgentDelegationDefaults],
) -> Option<(String, String)> {
    let option = snapshot.config_options.iter().find(|o| is_model(o))?;
    let SessionConfigKindInfo::Select(sel) = &option.kind else {
        return None;
    };
    let offered = select_values(option);
    let offers = |v: &str| offered.iter().any(|(x, _)| x == v);
    let value = given
        .config_values
        .get(&option.id)
        .cloned()
        .or_else(|| {
            others
                .iter()
                .filter_map(|o| o.config_values.get(&option.id))
                .find(|v| offers(v))
                .cloned()
        })
        .unwrap_or_else(|| sel.current_value.clone());
    Some((option.id.clone(), value))
}

#[cfg(test)]
thread_local! {
    /// What a test's agents report, in place of starting them; by model
    /// when one is set for the read.
    pub static TEST_SNAPSHOTS: std::cell::RefCell<
        std::collections::HashMap<(AgentType, Option<String>), AgentOptionsSnapshot>,
    > = std::cell::RefCell::new(std::collections::HashMap::new());
}

/// What `agent_type` offers, read the way the editor reads it. `Err` when
/// it cannot be read (not installed, does not start): the caller opens the
/// editor instead.
pub async fn probe(
    manager: &crate::acp::manager::ConnectionManager,
    db: &crate::db::AppDatabase,
    data_dir: &std::path::Path,
    agent_type: AgentType,
    model: Option<(&str, &str)>,
) -> Result<AgentOptionsSnapshot, String> {
    #[cfg(test)]
    let snapshot = {
        let _ = (manager, db, data_dir);
        TEST_SNAPSHOTS
            .with(|m| {
                let m = m.borrow();
                model
                    .and_then(|(_, v)| m.get(&(agent_type, Some(v.to_string()))))
                    .or_else(|| m.get(&(agent_type, None)))
                    .cloned()
            })
            .ok_or_else(|| format!("{agent_type:?} is not installed"))
    };
    #[cfg(not(test))]
    let snapshot = {
        let mut preferred = BTreeMap::new();
        if let Some((id, v)) = model {
            preferred.insert(id.to_string(), v.to_string());
        }
        crate::commands::acp::acp_describe_agent_options_core(
            manager, db, data_dir, agent_type, None, preferred,
        )
        .await
        .map_err(|e| e.to_string())
    };
    snapshot
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::*;
    use crate::acp::types::{
        SessionConfigBooleanInfo, SessionConfigSelectInfo, SessionConfigSelectOptionInfo,
    };

    fn select(id: &str, name: &str, current: &str, values: &[&str]) -> SessionConfigOptionInfo {
        SessionConfigOptionInfo {
            id: id.into(),
            name: name.into(),
            description: None,
            category: (id == "model").then(|| "model".to_string()),
            kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                current_value: current.into(),
                options: values
                    .iter()
                    .map(|v| SessionConfigSelectOptionInfo {
                        value: v.to_string(),
                        name: v.to_uppercase(),
                        description: None,
                    })
                    .collect(),
                groups: Vec::new(),
            }),
            recommended_value: None,
        }
    }

    /// An agent with a model, an effort and a switch.
    pub fn snapshot() -> AgentOptionsSnapshot {
        AgentOptionsSnapshot {
            modes: None,
            config_options: vec![
                select("effort", "Effort", "medium", &["low", "medium", "high"]),
                select("model", "Model", "sonnet", &["sonnet", "opus"]),
                SessionConfigOptionInfo {
                    id: "auto".into(),
                    name: "Auto-approve".into(),
                    description: None,
                    category: None,
                    kind: SessionConfigKindInfo::Boolean(SessionConfigBooleanInfo {
                        current_value: false,
                    }),
                    recommended_value: None,
                },
            ],
            available_commands: Vec::new(),
            prompt_capabilities: None,
            unapplied_config_ids: Vec::new(),
        }
    }

    /// Let `agent_type` report `snapshot()` in this test.
    pub fn install(agent_type: AgentType) {
        TEST_SNAPSHOTS.with(|m| {
            m.borrow_mut().insert((agent_type, None), snapshot());
        });
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::snapshot;
    use super::*;

    #[test]
    fn what_is_said_is_kept_and_the_rest_is_filled_in() {
        let given = Partial {
            mode_id: None,
            config_values: BTreeMap::from([("model".to_string(), "opus".to_string())]),
        };
        let other = AgentDelegationDefaults {
            mode_id: None,
            config_values: BTreeMap::from([("effort".to_string(), "high".to_string())]),
        };
        let (config, picked) =
            fill_selection(AgentType::ClaudeCode, &snapshot(), &given, &[other]).unwrap();
        assert_eq!(config.agent_options.config_values["model"], "opus");
        assert_eq!(config.agent_options.config_values["effort"], "high");
        assert_eq!(config.agent_options.config_values["auto"], "false");
        // The model comes first, as in the editor.
        assert_eq!(config.label_snapshot.options[0].id, "model");
        let from: Vec<(&str, PickedFrom)> =
            picked.iter().map(|p| (p.id.as_str(), p.from)).collect();
        assert_eq!(
            from,
            vec![
                ("model", PickedFrom::Given),
                ("effort", PickedFrom::OtherConfig),
                ("auto", PickedFrom::Agent),
            ]
        );
        assert!(config.validate().is_ok());
    }

    #[test]
    fn a_value_the_agent_does_not_offer_is_refused_with_what_it_does() {
        let given = Partial {
            mode_id: None,
            config_values: BTreeMap::from([("model".to_string(), "gpt-9".to_string())]),
        };
        let err = fill_selection(AgentType::ClaudeCode, &snapshot(), &given, &[]).unwrap_err();
        assert!(err.contains("sonnet, opus"), "{err}");
        let given = Partial {
            mode_id: None,
            config_values: BTreeMap::from([("colour".to_string(), "red".to_string())]),
        };
        assert!(
            fill_selection(AgentType::ClaudeCode, &snapshot(), &given, &[])
                .unwrap_err()
                .contains("no option `colour`")
        );
    }

    #[test]
    fn options_are_read_flat_or_as_a_selection() {
        let flat = serde_json::json!({ "model": "opus", "auto": true });
        let p = Partial::from_json(Some(&flat)).unwrap();
        assert_eq!(p.config_values["auto"], "true");
        let full = serde_json::json!({ "mode_id": "plan", "config_values": { "model": "opus" } });
        let p = Partial::from_json(Some(&full)).unwrap();
        assert_eq!(p.mode_id.as_deref(), Some("plan"));
        assert!(Partial::from_json(Some(&serde_json::json!([1]))).is_err());
    }
}
