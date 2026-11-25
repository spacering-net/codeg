//! Runtime model selection shared by model discovery and explicit launch checks.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::acp::types::{
    SessionConfigKindInfo, SessionConfigOptionInfo, SessionConfigSelectOptionInfo,
};

#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub name: String,
    pub slug: String,
    /// None means the runtime did not advertise levels for this model.
    pub reasoning: Option<Vec<String>>,
    pub reasoning_option_id: Option<String>,
    /// Never infer a context window from a model's name.
    pub context_window: Option<u64>,
}

pub(crate) fn is_model(option: &SessionConfigOptionInfo) -> bool {
    match option.category.as_deref() {
        Some("model") => true,
        Some("mode") => false,
        _ => option.id == "model",
    }
}

pub(crate) fn is_reasoning(option: &SessionConfigOptionInfo) -> bool {
    if option.category.as_deref() == Some("mode") {
        return false;
    }
    matches!(
        option.category.as_deref(),
        Some("thought_level" | "reasoning_effort" | "effort")
    ) || matches!(
        option.id.as_str(),
        "thought_level" | "reasoning_effort" | "effort"
    )
}

fn choices(option: &SessionConfigOptionInfo) -> Vec<&SessionConfigSelectOptionInfo> {
    match &option.kind {
        SessionConfigKindInfo::Select(select) => select
            .options
            .iter()
            .chain(select.groups.iter().flat_map(|group| group.options.iter()))
            .collect(),
        SessionConfigKindInfo::Boolean(_) => Vec::new(),
    }
}

pub(crate) fn current_model(options: &[SessionConfigOptionInfo]) -> Option<&str> {
    match &options.iter().find(|option| is_model(option))?.kind {
        SessionConfigKindInfo::Select(select) => Some(&select.current_value),
        SessionConfigKindInfo::Boolean(_) => None,
    }
}

pub fn model_catalog(
    options: &[SessionConfigOptionInfo],
    selected_model: Option<&str>,
) -> Vec<ModelInfo> {
    let Some(model) = options.iter().find(|option| is_model(option)) else {
        return Vec::new();
    };
    let current_model = selected_model.or_else(|| current_model(options));
    let current_reasoning = options.iter().find(|option| is_reasoning(option));
    choices(model)
        .into_iter()
        .map(|choice| ModelInfo {
            name: choice.name.clone(),
            slug: choice.value.clone(),
            reasoning: choice
                .reasoning_efforts
                .as_ref()
                .map(|effort| effort.values.clone())
                .or_else(|| {
                    (Some(choice.value.as_str()) == current_model)
                        .then(|| {
                            current_reasoning.map(|option| {
                                choices(option)
                                    .iter()
                                    .map(|choice| choice.value.clone())
                                    .collect()
                            })
                        })
                        .flatten()
                }),
            reasoning_option_id: current_reasoning.map(|option| option.id.clone()),
            context_window: choice.context_window,
        })
        .collect()
}

#[derive(Debug, Serialize)]
pub struct PermissionMode {
    pub mode_id: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
pub struct AgentOptions {
    pub model_option_id: Option<String>,
    pub models: Vec<ModelInfo>,
    pub modes: Vec<PermissionMode>,
}

pub(crate) fn permission_modes(
    snapshot: &crate::acp::types::AgentOptionsSnapshot,
) -> Vec<PermissionMode> {
    if let Some(option) = snapshot.config_options.iter().find(|option| {
        option.category.as_deref() == Some("mode")
            && matches!(option.kind, SessionConfigKindInfo::Select(_))
    }) {
        return choices(option)
            .into_iter()
            .map(|choice| PermissionMode {
                mode_id: choice.value.clone(),
                name: choice.name.clone(),
            })
            .collect();
    }
    snapshot
        .modes
        .iter()
        .flat_map(|legacy| &legacy.available_modes)
        .map(|mode| PermissionMode {
            mode_id: mode.id.clone(),
            name: mode.name.clone(),
        })
        .collect()
}

pub(crate) fn validate_create_option_ids(
    options: &[SessionConfigOptionInfo],
    values: &BTreeMap<String, String>,
) -> Result<(), String> {
    let model = options.iter().find(|option| is_model(option));
    let reasoning = options.iter().find(|option| is_reasoning(option));
    match (model, reasoning) {
        (Some(model), Some(reasoning)) if model.id != reasoning.id
            && values.len() == 2 && values.contains_key(&model.id) && values.contains_key(&reasoning.id) => Ok(()),
        _ => Err(format!(
            "expected model option {:?} and reasoning option {:?}; query list_agent_options for this agent",
            model.map(|option| &option.id), reasoning.map(|option| &option.id)
        )),
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelSelection {
    pub model: Option<String>,
    pub reasoning: Option<String>,
}

impl ModelSelection {
    pub fn is_empty(&self) -> bool {
        self.model.is_none() && self.reasoning.is_none()
    }

    /// Resolve public model/reasoning arguments to the agent's actual option ids.
    /// Probe with the model first: reasoning choices can change with the model.
    pub fn resolve(
        &self,
        options: &[SessionConfigOptionInfo],
    ) -> Result<BTreeMap<String, String>, String> {
        let mut result = BTreeMap::new();
        for (name, value, predicate) in [
            (
                "model",
                &self.model,
                is_model as fn(&SessionConfigOptionInfo) -> bool,
            ),
            (
                "reasoning",
                &self.reasoning,
                is_reasoning as fn(&SessionConfigOptionInfo) -> bool,
            ),
        ] {
            let Some(value) = value else {
                continue;
            };
            let option = options
                .iter()
                .find(|option| predicate(option))
                .ok_or_else(|| {
                    format!("{name} is not supported by this agent; available options: []")
                })?;
            if !choices(option).iter().any(|choice| &choice.value == value) {
                return Err(format!(
                    "invalid {name} {value:?}; available options: {}",
                    available(option)
                ));
            }
            result.insert(option.id.clone(), value.clone());
        }
        Ok(result)
    }
}

fn available(option: &SessionConfigOptionInfo) -> String {
    match &option.kind {
        SessionConfigKindInfo::Boolean(_) => "true, false".into(),
        SessionConfigKindInfo::Select(_) => choices(option)
            .iter()
            .map(|choice| format!("{} ({})", choice.name, choice.value))
            .collect::<Vec<_>>()
            .join(", "),
    }
}

/// Shared post-start check for explicit selections. The caller must wait for
/// session readiness before validating; a rejected override must never reach a prompt.
pub fn validate_config_values(
    options: &[SessionConfigOptionInfo],
    requested: &BTreeMap<String, String>,
) -> Result<(), String> {
    let actual = crate::acp::connection::current_config_option_values(options);
    for (key, value) in requested {
        if actual.get(key) != Some(value) {
            let option = options.iter().find(|option| &option.id == key);
            return Err(format!(
                "could not apply config {key}={value:?}; actual: {:?}; available options: {}",
                actual.get(key),
                option.map(available).unwrap_or_else(|| "[]".into())
            ));
        }
    }
    Ok(())
}
