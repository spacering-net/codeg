//! The rows codeg adds to Claude Code's `/model` picker.
//!
//! Claude Code's picker holds its built-in lineup, the one row of
//! `ANTHROPIC_CUSTOM_MODEL_OPTION`, and the rows of a `modelPicker` setting.
//! For a gateway that serves several models, codeg adds the ids the user
//! picked from the provider's list as `modelPicker` rows — only for the CLI
//! codeg launches, through the `--settings` tier
//! (`_meta.claudeCode.options.settings`), so a Claude run from a terminal never
//! shows them.
//!
//! That tier wins over the user's own `settings.json` outright: Claude takes
//! the highest-precedence tier that defines `modelPicker` and merges nothing
//! across tiers. So the user's own rows are carried over into what codeg
//! sends, ahead of codeg's. A managed (policy) `modelPicker` still wins over
//! both, as it should.
//!
//! An id this CLI does not know is offered as it is, without `behavesAs`:
//! Claude then assumes a conservative context window for it and says how to
//! set the real one, where borrowing a known model's handling could promise a
//! window the gateway's model does not have.
//!
//! The ids ride the launch's runtime env under [`LAUNCH_KEY`], so an edit to
//! them makes running sessions stale like any other launch setting; the key
//! never reaches the agent's process (`connection::merge_agent_env`).

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::{json, Map, Value};

/// The runtime-env key carrying the ids into a launch; see the module notes.
pub const LAUNCH_KEY: &str = "CODEG_LAUNCH_CLAUDE_MODEL_PICKER";

/// Where the ids live for a Claude agent with no model provider bound
/// (`app_metadata`). A bound provider keeps its own in its model JSON
/// ([`PROVIDER_FIELD`]).
pub const METADATA_KEY: &str = "claude_code.model_picker";

/// The key of a Claude provider's model JSON holding its picker ids.
pub const PROVIDER_FIELD: &str = "pickerModels";

/// The most ids kept, and the longest id.
pub const MAX_MODELS: usize = 1024;
pub const MAX_ID_LEN: usize = 256;

/// Trimmed, without blanks or repeats, in the given order.
pub fn normalize<'a>(ids: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    let mut seen = HashSet::new();
    ids.into_iter()
        .map(str::trim)
        .filter(|id| !id.is_empty() && seen.insert(id.to_string()))
        .map(str::to_string)
        .collect()
}

/// Why a list of ids cannot be stored, if it cannot.
pub fn invalid(ids: &[String]) -> Option<String> {
    if ids.len() > MAX_MODELS {
        return Some(format!("at most {MAX_MODELS} picker models"));
    }
    ids.iter()
        .find(|id| id.chars().count() > MAX_ID_LEN)
        .map(|id| format!("a picker model id is longer than {MAX_ID_LEN} characters: {id}"))
}

/// The ids as stored (a JSON array), or `None` for none.
pub fn encode(ids: &[String]) -> Option<String> {
    (!ids.is_empty()).then(|| Value::from(ids.to_vec()).to_string())
}

/// The ids of a stored value; anything unreadable counts as none.
pub fn decode(raw: &str) -> Vec<String> {
    match serde_json::from_str::<Value>(raw) {
        Ok(Value::Array(items)) => normalize(items.iter().filter_map(Value::as_str)),
        _ => Vec::new(),
    }
}

/// The picker ids of a Claude provider's model JSON.
pub fn provider_ids(model_json: Option<&str>) -> Vec<String> {
    model_json
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.get(PROVIDER_FIELD).cloned())
        .map(|ids| decode(&ids.to_string()))
        .unwrap_or_default()
}

/// The `--settings` object for a launch with `runtime_env`, when codeg has
/// rows to add: `{"modelPicker": …}`, the user's own rows (from the
/// `settings.json` of the Claude this env launches) first.
pub fn launch_settings(runtime_env: &BTreeMap<String, String>) -> Option<Value> {
    let ids = decode(runtime_env.get(LAUNCH_KEY)?);
    if ids.is_empty() {
        return None;
    }
    let config_dir = crate::parsers::claude::resolve_claude_config_dir_for_env(
        &crate::parsers::AgentEnv::from_overrides(runtime_env.clone()),
    );
    Some(settings_for(&ids, user_picker(&config_dir).as_ref()))
}

/// The user's own `modelPicker`, from `<config dir>/settings.json`.
fn user_picker(config_dir: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(config_dir.join("settings.json")).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("modelPicker").filter(|p| p.is_object()).cloned()
}

/// The settings carrying `ids` after the rows of `user` (a `modelPicker`
/// object), whose `replaceBuiltInOptions` is kept.
pub fn settings_for(ids: &[String], user: Option<&Value>) -> Value {
    let mut options: Vec<Value> = user
        .and_then(|p| p.get("options"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter(|row| row.get("model").and_then(Value::as_str).is_some())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    let mut present: HashSet<String> = options
        .iter()
        .filter_map(|row| row.get("model").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    for id in ids {
        if present.insert(id.clone()) {
            options.push(json!({ "model": id }));
        }
    }
    let mut picker = Map::new();
    picker.insert("options".to_string(), Value::Array(options));
    if let Some(replace) = user
        .and_then(|p| p.get("replaceBuiltInOptions"))
        .and_then(Value::as_bool)
    {
        picker.insert("replaceBuiltInOptions".to_string(), Value::Bool(replace));
    }
    json!({ "modelPicker": picker })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn ids_are_stored_trimmed_once_each() {
        assert_eq!(
            normalize([" glm-5.2 ", "", "kimi-k3", "glm-5.2"]),
            ids(&["glm-5.2", "kimi-k3"])
        );
        let stored = encode(&ids(&["glm-5.2", "kimi-k3"])).unwrap();
        assert_eq!(decode(&stored), ids(&["glm-5.2", "kimi-k3"]));
        assert_eq!(encode(&[]), None);
        assert!(decode("not json").is_empty());
        assert!(decode(r#"{"a":1}"#).is_empty());
        assert_eq!(
            provider_ids(Some(
                r#"{"main":"glm-5.2","pickerModels":["glm-5.2"," qwen-4 "]}"#
            )),
            ids(&["glm-5.2", "qwen-4"])
        );
        assert!(provider_ids(Some(r#"{"main":"m"}"#)).is_empty());
        assert!(provider_ids(None).is_empty());
        assert!(invalid(&ids(&["ok"])).is_none());
        assert!(invalid(&["x".repeat(MAX_ID_LEN + 1)]).is_some());
    }

    #[test]
    fn the_users_own_rows_come_first_and_keep_their_say_on_the_lineup() {
        let user = json!({
            "options": [{"model": "kimi-k3", "label": "Kimi"}, {"label": "no model"}],
            "replaceBuiltInOptions": true
        });
        let settings = settings_for(&ids(&["glm-5.2", "kimi-k3"]), Some(&user));
        assert_eq!(
            settings,
            json!({"modelPicker": {
                "options": [{"model": "kimi-k3", "label": "Kimi"}, {"model": "glm-5.2"}],
                "replaceBuiltInOptions": true
            }})
        );
        // No user picker: codeg's rows join the built-in lineup.
        assert_eq!(
            settings_for(&ids(&["glm-5.2"]), None),
            json!({"modelPicker": {"options": [{"model": "glm-5.2"}]}})
        );
    }

    #[test]
    fn a_launch_reads_the_settings_of_the_claude_it_starts() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"modelPicker":{"options":[{"model":"mine"}]}}"#,
        )
        .unwrap();
        let mut env = BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".to_string(),
            dir.path().to_string_lossy().into_owned(),
        );
        assert_eq!(
            launch_settings(&env),
            None,
            "no rows of codeg's: nothing sent"
        );
        env.insert(LAUNCH_KEY.to_string(), encode(&ids(&["glm-5.2"])).unwrap());
        assert_eq!(
            launch_settings(&env),
            Some(json!({"modelPicker": {"options": [{"model": "mine"}, {"model": "glm-5.2"}]}}))
        );
    }
}
