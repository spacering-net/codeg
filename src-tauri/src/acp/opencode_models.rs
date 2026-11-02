use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::Value;

use crate::parsers::AgentEnv;

use super::opencode_config::{self, CONFIG_FILE_NAMES};

#[derive(Default)]
struct ProviderFilter {
    disabled: BTreeMap<String, bool>,
}

#[derive(Default)]
struct ModelFilters {
    providers: BTreeMap<String, ProviderFilter>,
}

impl ModelFilters {
    fn apply(&mut self, config: &Value) {
        let native = config.get("providers").and_then(Value::as_object);
        for key in ["provider", "providers"] {
            let Some(blocks) = config.get(key).and_then(Value::as_object) else {
                continue;
            };
            for (id, block) in blocks {
                if !block.is_object()
                    || (key == "provider"
                        && native
                            .and_then(|blocks| blocks.get(id))
                            .is_some_and(Value::is_object))
                {
                    continue;
                }
                let filter = self.providers.entry(id.clone()).or_default();
                if let Some(models) = block.get("models").and_then(Value::as_object) {
                    for (model_id, model) in models {
                        if let Some(disabled) = model.get("disabled").and_then(Value::as_bool) {
                            filter.disabled.insert(model_id.clone(), disabled);
                        }
                    }
                }
            }
        }
    }

    fn read_file(&mut self, path: &Path) {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(config) = opencode_config::parse(&text) {
                self.apply(&config);
            }
        }
    }

    fn read_dir(&mut self, dir: &Path) {
        for name in CONFIG_FILE_NAMES {
            self.read_file(&dir.join(name));
        }
    }

    fn hidden_models(self) -> HashSet<String> {
        let mut hidden = HashSet::new();
        for (provider_id, filter) in self.providers {
            hidden.extend(
                filter
                    .disabled
                    .iter()
                    .filter_map(|(id, disabled)| disabled.then_some(id))
                    .map(|id| format!("{provider_id}/{id}")),
            );
        }
        hidden
    }
}

/// Read only model visibility rules, in OpenCode's global → direct project →
/// .opencode project → system order. No credential substitution is needed.
pub(crate) fn hidden_models_for_env(
    runtime_env: &BTreeMap<String, String>,
    working_dir: &Path,
) -> HashSet<String> {
    let env = AgentEnv::from_overrides(runtime_env.clone());
    let global = opencode_config::config_dir_for_env(&env);
    let system = if cfg!(target_os = "macos") {
        Some(std::path::PathBuf::from(
            "/Library/Application Support/opencode",
        ))
    } else if cfg!(windows) {
        env.var_os("ProgramData")
            .map(std::path::PathBuf::from)
            .map(|dir| dir.join("opencode"))
    } else {
        Some(std::path::PathBuf::from("/etc/opencode"))
    };
    let mut filters = ModelFilters::default();
    if let Some(dir) = &global {
        filters.read_dir(dir);
    }
    let ancestors: Vec<_> =
        if global.as_deref() == Some(working_dir) || system.as_deref() == Some(working_dir) {
            Vec::new()
        } else {
            working_dir.ancestors().collect()
        };
    for dir in ancestors.iter().rev() {
        if global.as_deref() != Some(*dir) && system.as_deref() != Some(*dir) {
            filters.read_dir(dir);
        }
    }
    for dir in ancestors.iter().rev() {
        let dir = dir.join(".opencode");
        if global.as_ref() != Some(&dir) && system.as_ref() != Some(&dir) {
            filters.read_dir(&dir);
        }
    }
    if let Some(dir) = &system {
        filters.read_dir(dir);
    }
    filters.hidden_models()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_models_are_provider_scoped_and_ignore_blacklist() {
        let mut filters = ModelFilters::default();
        filters.apply(&serde_json::json!({
            "providers": { "relay": {
                "blacklist": ["old", "vendor/hidden"],
                "models": {
                    "disabled": {"disabled": true},
                    "enabled": {"disabled": false},
                    "alias": {"modelID": "old"}
                }
            }}
        }));
        assert_eq!(
            filters.hidden_models(),
            HashSet::from(["relay/disabled".into()])
        );
    }

    #[test]
    fn native_blocks_win_and_later_layers_can_reenable_a_model() {
        let mut filters = ModelFilters::default();
        filters.apply(&serde_json::json!({
            "provider": {"relay": {"blacklist": ["legacy"]}},
            "providers": {"relay": {
                "blacklist": ["native"],
                "models": {"old": {"disabled": true}, "hidden": {"disabled": true}}
            }}
        }));
        filters.apply(&serde_json::json!({"providers": {"relay": {
            "blacklist": [], "models": {"old": {"disabled": false}}
        }}}));
        assert_eq!(
            filters.hidden_models(),
            HashSet::from(["relay/hidden".into()])
        );
    }

    #[test]
    fn jsonc_layers_merge_visibility_without_losing_unmentioned_models() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("opencode.json"),
            r#"{"providers":{"relay":{"blacklist":["old"],"models":{
                "disabled":{"disabled":true},"enabled":{"disabled":true}
            }}}}"#,
        )
        .unwrap();
        std::fs::write(
            dir.path().join("opencode.jsonc"),
            r#"{ // later file overrides individual fields
                "providers":{"relay":{"blacklist":["new"],"models":{
                    "enabled":{"disabled":false},
                }}}
            }"#,
        )
        .unwrap();
        let mut filters = ModelFilters::default();
        filters.read_dir(dir.path());
        assert_eq!(
            filters.hidden_models(),
            HashSet::from(["relay/disabled".into()])
        );
    }

    #[test]
    fn blacklist_in_later_layers_does_not_change_disabled_models() {
        let mut filters = ModelFilters::default();
        filters.apply(&serde_json::json!({"providers": {"relay": {
            "blacklist": ["old"], "models": {"disabled": {"disabled": true}}
        }}}));
        filters.apply(&serde_json::json!({"provider": {"relay": {
            "blacklist": ["new"]
        }}}));
        assert_eq!(
            filters.hidden_models(),
            HashSet::from(["relay/disabled".into()])
        );
    }
}
