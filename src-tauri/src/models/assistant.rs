//! Assistants as the UI and the delegation broker see them.
//!
//! An assistant is a delegation preset the composer can @-mention: who it is
//! (name, avatar, description), what runs it (an agent, with every option that
//! agent advertises picked explicitly), and standing instructions handed to
//! the child alongside its task.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::agent::AgentType;
use crate::acp::delegation::types::AgentDelegationDefaults;

/// The palette an avatar's colour is picked from. Keys, not colours: the
/// frontend maps each to its own light and dark treatment.
pub const ASSISTANT_AVATAR_COLORS: &[&str] = &[
    "slate", "red", "orange", "amber", "green", "teal", "sky", "blue", "violet", "pink",
];

/// Longest option id, option value, mode id or display name kept in an agent
/// selection, in bytes. Agents' ids are short slugs; this only stops a
/// hand-crafted request from storing a blob.
pub const MAX_AGENT_OPTION_FIELD_BYTES: usize = 512;

/// Largest serialized [`AssistantLabelSnapshot`], in bytes.
pub const MAX_LABEL_SNAPSHOT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssistantAvatar {
    /// The name's first grapheme on a coloured disc. The default.
    Monogram {
        color: String,
    },
    Emoji {
        emoji: String,
        color: String,
    },
    /// A `data:image/(png|jpeg|webp);base64,…` URL, already cropped square and
    /// scaled down by the client.
    Image {
        data_url: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AssistantOptionKind {
    Select,
    /// Stored as `"true"` / `"false"`, the encoding launch replay sends.
    Boolean,
}

/// One option of the saved selection, with the names the editor showed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantOptionLabel {
    /// The config option id; the ids are exactly the keys of
    /// `agent_options.config_values`.
    pub id: String,
    pub kind: AssistantOptionKind,
    /// The option's display name ("Reasoning effort").
    pub name: String,
    /// The picked value's display name ("High"). A boolean's is rendered from
    /// its value instead, in the reader's language.
    pub value_label: String,
}

/// The option list as it stood when the selection was saved. It lets the
/// settings list name every pick without probing the agent, and it is what
/// the backend checks the selection against for completeness.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantLabelSnapshot {
    /// The agent's display name.
    pub agent: String,
    /// The picked mode's display name; present exactly when
    /// `agent_options.mode_id` is.
    #[serde(default)]
    pub mode: Option<String>,
    /// In the editor's display order. Empty for an agent with nothing to pick.
    #[serde(default)]
    pub options: Vec<AssistantOptionLabel>,
}

/// The agent an assistant runs on, its full selection, and the option list
/// that selection was made against. Only ever submitted whole: changing the
/// agent alone would keep the previous agent's options, and changing the
/// options alone would leave the list describing a different selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantAgentConfig {
    pub agent_type: AgentType,
    #[serde(default)]
    pub agent_options: AgentDelegationDefaults,
    pub label_snapshot: AssistantLabelSnapshot,
}

impl AssistantAgentConfig {
    /// Whether the selection is complete against its own option list: every
    /// listed option has exactly one non-empty value, nothing outside the list
    /// has one, and a mode is picked exactly when the list names one.
    ///
    /// Shared by create, update and config-sync import. It cannot check that
    /// the values are ones the agent still offers — that takes launching it.
    /// The editor re-probes when it opens, and launch replay skips a value the
    /// agent no longer advertises.
    pub fn validate(&self) -> Result<(), String> {
        let snapshot = &self.label_snapshot;
        let values = &self.agent_options.config_values;

        check_field_len("agent name", &snapshot.agent)?;
        match (&self.agent_options.mode_id, &snapshot.mode) {
            (Some(mode_id), Some(label)) => {
                check_value("mode", mode_id)?;
                check_field_len("mode name", label)?;
            }
            (None, None) => {}
            (Some(_), None) => return Err("a mode is picked but not listed".to_string()),
            (None, Some(_)) => return Err("a mode is listed but not picked".to_string()),
        }

        let mut seen: HashSet<&str> = HashSet::with_capacity(snapshot.options.len());
        for option in &snapshot.options {
            check_value("option id", &option.id)?;
            if !seen.insert(option.id.as_str()) {
                return Err(format!("option \"{}\" is listed twice", option.id));
            }
            check_field_len("option name", &option.name)?;
            check_field_len("option value name", &option.value_label)?;
            let value = values
                .get(&option.id)
                .ok_or_else(|| format!("option \"{}\" has no value", option.id))?;
            check_value("option value", value)?;
            if option.kind == AssistantOptionKind::Boolean && value != "true" && value != "false" {
                return Err(format!(
                    "option \"{}\" is a switch, so its value must be \"true\" or \"false\"",
                    option.id
                ));
            }
        }
        if let Some(extra) = values.keys().find(|id| !seen.contains(id.as_str())) {
            return Err(format!("option \"{extra}\" has a value but is not listed"));
        }

        let size = serde_json::to_vec(snapshot)
            .map_err(|e| format!("option list does not serialize: {e}"))?
            .len();
        if size > MAX_LABEL_SNAPSHOT_BYTES {
            return Err(format!(
                "option list is {size} bytes (limit {MAX_LABEL_SNAPSHOT_BYTES})"
            ));
        }
        Ok(())
    }
}

fn check_field_len(what: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_AGENT_OPTION_FIELD_BYTES {
        return Err(format!(
            "{what} is {} bytes (limit {MAX_AGENT_OPTION_FIELD_BYTES})",
            value.len()
        ));
    }
    Ok(())
}

fn check_value(what: &str, value: &str) -> Result<(), String> {
    if value.is_empty() {
        return Err(format!("{what} is empty"));
    }
    check_field_len(what, value)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AssistantInfo {
    pub id: i32,
    pub uid: String,
    pub name: String,
    pub description: String,
    pub avatar: AssistantAvatar,
    pub agent_type: AgentType,
    pub agent_options: AgentDelegationDefaults,
    pub label_snapshot: AssistantLabelSnapshot,
    pub instructions: String,
    pub enabled: bool,
    pub sort_order: i32,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Always on the wire, `null` while the assistant is live: clients keep
    /// tombstones so historical cards can still draw a deleted assistant.
    pub deleted_at: Option<DateTime<Utc>>,
}

impl AssistantInfo {
    pub fn is_live(&self) -> bool {
        self.deleted_at.is_none()
    }
}

fn default_true() -> bool {
    true
}

/// A new assistant, as the editor submits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantDraft {
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub avatar: AssistantAvatar,
    pub agent_config: AssistantAgentConfig,
    #[serde(default)]
    pub instructions: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// An edit: only the fields present change.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub avatar: Option<AssistantAvatar>,
    #[serde(default)]
    pub agent_config: Option<AssistantAgentConfig>,
    #[serde(default)]
    pub instructions: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

impl AssistantPatch {
    pub fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.description.is_none()
            && self.avatar.is_none()
            && self.agent_config.is_none()
            && self.instructions.is_none()
            && self.enabled.is_none()
    }
}

/// What a delegation child keeps of the assistant it ran as
/// (`conversation.assistant_snapshot`), frozen when the delegation started.
/// The agent is not in it: that is the child row's own `agent_type`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AssistantRunSnapshot {
    pub name: String,
    #[serde(default)]
    pub agent_options: AgentDelegationDefaults,
    #[serde(default)]
    pub instructions: String,
}

impl AssistantRunSnapshot {
    /// Just the name out of a stored snapshot, for summaries: they are built
    /// per row on every list, and need nothing else from it.
    pub fn name_from_json(raw: &str) -> Option<String> {
        #[derive(Deserialize)]
        struct NameOnly {
            name: String,
        }
        serde_json::from_str::<NameOnly>(raw)
            .ok()
            .map(|s| s.name)
            .filter(|name| !name.is_empty())
    }
}

/// Convenience for building a selection in tests and fixtures.
#[cfg(test)]
pub fn selection(mode_id: Option<&str>, values: &[(&str, &str)]) -> AgentDelegationDefaults {
    AgentDelegationDefaults {
        mode_id: mode_id.map(str::to_string),
        config_values: values
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect::<std::collections::BTreeMap<_, _>>(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn label(id: &str, kind: AssistantOptionKind) -> AssistantOptionLabel {
        AssistantOptionLabel {
            id: id.to_string(),
            kind,
            name: format!("{id} name"),
            value_label: format!("{id} value"),
        }
    }

    fn config(
        mode: Option<(&str, &str)>,
        values: &[(&str, &str)],
        listed: Vec<AssistantOptionLabel>,
    ) -> AssistantAgentConfig {
        AssistantAgentConfig {
            agent_type: AgentType::Codex,
            agent_options: selection(mode.map(|(id, _)| id), values),
            label_snapshot: AssistantLabelSnapshot {
                agent: "Codex CLI".to_string(),
                mode: mode.map(|(_, name)| name.to_string()),
                options: listed,
            },
        }
    }

    #[test]
    fn a_complete_selection_is_accepted() {
        let cfg = config(
            Some(("auto", "Auto")),
            &[("model", "gpt-5.5"), ("fast", "false")],
            vec![
                label("model", AssistantOptionKind::Select),
                label("fast", AssistantOptionKind::Boolean),
            ],
        );
        assert_eq!(cfg.validate(), Ok(()));
    }

    #[test]
    fn an_agent_with_nothing_to_pick_is_accepted() {
        assert_eq!(config(None, &[], vec![]).validate(), Ok(()));
    }

    #[test]
    fn a_listed_option_without_a_value_is_refused() {
        let cfg = config(
            None,
            &[("model", "gpt-5.5")],
            vec![
                label("model", AssistantOptionKind::Select),
                label("effort", AssistantOptionKind::Select),
            ],
        );
        assert!(cfg
            .validate()
            .unwrap_err()
            .contains("\"effort\" has no value"));
    }

    #[test]
    fn a_value_outside_the_list_is_refused() {
        let cfg = config(
            None,
            &[("model", "gpt-5.5"), ("effort", "high")],
            vec![label("model", AssistantOptionKind::Select)],
        );
        assert!(cfg
            .validate()
            .unwrap_err()
            .contains("\"effort\" has a value"));
    }

    #[test]
    fn an_option_listed_twice_is_refused() {
        let cfg = config(
            None,
            &[("model", "gpt-5.5")],
            vec![
                label("model", AssistantOptionKind::Select),
                label("model", AssistantOptionKind::Select),
            ],
        );
        assert!(cfg.validate().unwrap_err().contains("listed twice"));
    }

    #[test]
    fn mode_and_its_name_must_come_together() {
        let mut picked_not_listed = config(Some(("auto", "Auto")), &[], vec![]);
        picked_not_listed.label_snapshot.mode = None;
        assert!(picked_not_listed.validate().is_err());

        let mut listed_not_picked = config(Some(("auto", "Auto")), &[], vec![]);
        listed_not_picked.agent_options.mode_id = None;
        assert!(listed_not_picked.validate().is_err());
    }

    #[test]
    fn empty_values_and_ids_are_refused() {
        let empty_value = config(
            None,
            &[("model", "")],
            vec![label("model", AssistantOptionKind::Select)],
        );
        assert!(empty_value.validate().is_err());

        let empty_id = config(
            None,
            &[("", "x")],
            vec![label("", AssistantOptionKind::Select)],
        );
        assert!(empty_id.validate().is_err());

        let empty_mode = config(Some(("", "Auto")), &[], vec![]);
        assert!(empty_mode.validate().is_err());
    }

    #[test]
    fn a_switch_only_takes_true_or_false() {
        let cfg = config(
            None,
            &[("fast", "yes")],
            vec![label("fast", AssistantOptionKind::Boolean)],
        );
        assert!(cfg.validate().unwrap_err().contains("switch"));
    }

    #[test]
    fn oversized_fields_and_lists_are_refused() {
        let long = "x".repeat(MAX_AGENT_OPTION_FIELD_BYTES + 1);
        let long_value = config(
            None,
            &[("model", long.as_str())],
            vec![label("model", AssistantOptionKind::Select)],
        );
        assert!(long_value.validate().is_err());

        let mut long_name = config(
            None,
            &[("model", "m")],
            vec![label("model", AssistantOptionKind::Select)],
        );
        long_name.label_snapshot.options[0].name = long.clone();
        assert!(long_name.validate().is_err());

        // Many options that each fit, together past the list's own limit.
        let ids: Vec<String> = (0..200).map(|i| format!("option-{i}")).collect();
        let values: Vec<(&str, &str)> = ids.iter().map(|id| (id.as_str(), "v")).collect();
        let listed = ids
            .iter()
            .map(|id| AssistantOptionLabel {
                id: id.clone(),
                kind: AssistantOptionKind::Select,
                name: "n".repeat(400),
                value_label: "v".to_string(),
            })
            .collect();
        assert!(config(None, &values, listed)
            .validate()
            .unwrap_err()
            .contains("option list is"));
    }

    /// The field names the frontend mirror reads (`src/lib/types.ts`). A rename
    /// here without one there would leave the UI reading a field the backend
    /// never sends.
    #[test]
    fn info_serializes_with_the_mirrored_field_names() {
        let at = DateTime::parse_from_rfc3339("2026-10-16T08:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let info = AssistantInfo {
            id: 3,
            uid: "4a0b".to_string(),
            name: "Reviewer".to_string(),
            description: "Reviews diffs".to_string(),
            avatar: AssistantAvatar::Emoji {
                emoji: "🦉".to_string(),
                color: "amber".to_string(),
            },
            agent_type: AgentType::Codex,
            agent_options: selection(Some("read-only"), &[("model", "gpt-5.5")]),
            label_snapshot: AssistantLabelSnapshot {
                agent: "Codex CLI".to_string(),
                mode: Some("Read only".to_string()),
                options: vec![AssistantOptionLabel {
                    id: "model".to_string(),
                    kind: AssistantOptionKind::Select,
                    name: "Model".to_string(),
                    value_label: "GPT-5.5".to_string(),
                }],
            },
            instructions: "Be terse.".to_string(),
            enabled: true,
            sort_order: 1,
            revision: 4,
            created_at: at,
            updated_at: at,
            deleted_at: None,
        };
        assert_eq!(
            serde_json::to_value(&info).unwrap(),
            json!({
                "id": 3,
                "uid": "4a0b",
                "name": "Reviewer",
                "description": "Reviews diffs",
                "avatar": {"kind": "emoji", "emoji": "🦉", "color": "amber"},
                "agent_type": "codex",
                "agent_options": {"mode_id": "read-only", "config_values": {"model": "gpt-5.5"}},
                "label_snapshot": {
                    "agent": "Codex CLI",
                    "mode": "Read only",
                    "options": [
                        {"id": "model", "kind": "select", "name": "Model", "value_label": "GPT-5.5"}
                    ]
                },
                "instructions": "Be terse.",
                "enabled": true,
                "sort_order": 1,
                "revision": 4,
                "created_at": "2026-10-16T08:00:00Z",
                "updated_at": "2026-10-16T08:00:00Z",
                "deleted_at": null
            })
        );
    }

    #[test]
    fn avatars_round_trip_by_kind() {
        for avatar in [
            json!({"kind": "monogram", "color": "violet"}),
            json!({"kind": "emoji", "emoji": "🦉", "color": "amber"}),
            json!({"kind": "image", "data_url": "data:image/png;base64,AAAA"}),
        ] {
            let parsed: AssistantAvatar = serde_json::from_value(avatar.clone()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), avatar);
        }
    }

    #[test]
    fn a_patch_reads_absent_fields_as_unchanged() {
        let patch: AssistantPatch = serde_json::from_value(json!({"name": "New"})).unwrap();
        assert_eq!(patch.name.as_deref(), Some("New"));
        assert!(patch.agent_config.is_none() && patch.enabled.is_none());
        assert!(!patch.is_empty());
        assert!(serde_json::from_value::<AssistantPatch>(json!({}))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn the_run_snapshot_name_reads_without_the_rest() {
        let raw = serde_json::to_string(&AssistantRunSnapshot {
            name: "Reviewer".to_string(),
            agent_options: selection(None, &[("model", "m")]),
            instructions: "x".repeat(10_000),
        })
        .unwrap();
        assert_eq!(
            AssistantRunSnapshot::name_from_json(&raw).as_deref(),
            Some("Reviewer")
        );
        assert_eq!(AssistantRunSnapshot::name_from_json("not json"), None);
        assert_eq!(AssistantRunSnapshot::name_from_json(r#"{"name":""}"#), None);
    }
}
