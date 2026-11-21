use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::{
    catalog_error, invalid, plugin_not_found, valid_id, valid_label, HostPlugins, Invocation,
    ServerModule, MAX_CONTRIBUTIONS,
};
use crate::app_error::AppCommandError;

pub(crate) const NAME_PREFIX: &str = "codeg_plugin_";

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Declaration {
    id: String,
    description: String,
    method: String,
}

pub(super) fn validate(tools: &[Declaration], server: Option<&ServerModule>) -> Result<(), String> {
    if tools.is_empty() {
        return Ok(());
    }
    let server = server.ok_or("Model tools need a plugin server module")?;
    let mut ids = BTreeSet::new();
    if tools.len() > MAX_CONTRIBUTIONS
        || tools.iter().any(|tool| {
            tool.id.len() > 32
                || !valid_id(&tool.id)
                || tool.id.contains('.')
                || !ids.insert(&tool.id)
                || !valid_label(&tool.description)
                || !server.rpc.get(&tool.method).is_some_and(|contract| {
                    contract.input_schema().get("type").and_then(Value::as_str) == Some("object")
                })
        })
    {
        return Err("Provide up to 16 model tools with unique IDs, valid descriptions and declared RPC methods with object input schemas".into());
    }
    Ok(())
}

fn tool_name(plugin_id: &str, tool_id: &str) -> String {
    let digest = format!("{:x}", Sha256::digest(plugin_id.as_bytes()));
    let suffix = &digest[..16];
    format!("{NAME_PREFIX}{tool_id}_{suffix}")
}

#[derive(Clone)]
struct ModelTool {
    plugin_id: String,
    method: String,
    activation: Arc<()>,
    schema: Value,
}

/// Tool offers belonging to one companion launch. Each offer remains bound to
/// the activation that was available when the agent started.
pub(crate) struct ModelToolOffers {
    host: Arc<HostPlugins>,
    tools: BTreeMap<String, ModelTool>,
}

impl ModelToolOffers {
    pub(crate) fn new(host: &Arc<HostPlugins>) -> Option<Self> {
        let guard = host.state.lock().expect("host plugin state lock");
        let state = guard.as_ref().ok()?;
        let mut tools = BTreeMap::new();
        for (plugin_id, plugin) in &state.catalog {
            if !plugin.enabled {
                continue;
            }
            let Some(server) = &plugin.manifest.server else {
                continue;
            };
            for tool in &plugin.manifest.contributes.model_tools {
                let Some(contract) = server.rpc.get(&tool.method) else {
                    continue;
                };
                let name = tool_name(plugin_id, &tool.id);
                tools.entry(name.clone()).or_insert_with(|| ModelTool {
                    plugin_id: plugin_id.clone(),
                    method: tool.method.clone(),
                    activation: plugin.activation.clone(),
                    schema: json!({
                        "name": name,
                        "description": tool.description,
                        "inputSchema": contract.input_schema(),
                    }),
                });
            }
        }
        (!tools.is_empty()).then(|| Self {
            host: host.clone(),
            tools,
        })
    }

    pub(crate) fn list(&self) -> Vec<Value> {
        let guard = self.host.state.lock().expect("host plugin state lock");
        let Ok(state) = guard.as_ref() else {
            return Vec::new();
        };
        self.tools
            .values()
            .filter(|tool| {
                state.catalog.get(&tool.plugin_id).is_some_and(|plugin| {
                    plugin.enabled && Arc::ptr_eq(&tool.activation, &plugin.activation)
                })
            })
            .map(|tool| tool.schema.clone())
            .collect()
    }

    pub(crate) async fn call(&self, name: &str, input: Value) -> Result<Value, AppCommandError> {
        if !input.is_object() {
            return Err(invalid("Plugin tool arguments must be a JSON object"));
        }
        let invocation = {
            let tool = self.tools.get(name).ok_or_else(plugin_not_found)?;
            let guard = self.host.state.lock().expect("host plugin state lock");
            let state = guard.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = state
                .catalog
                .get(&tool.plugin_id)
                .filter(|plugin| {
                    plugin.enabled && Arc::ptr_eq(&tool.activation, &plugin.activation)
                })
                .ok_or_else(plugin_not_found)?;
            Invocation::new(&tool.plugin_id, plugin, tool.method.clone())
                .ok_or_else(plugin_not_found)?
        };
        self.host.invoke(invocation, input).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host_plugins::Manifest;

    #[test]
    fn validates_model_tools_with_object_rpc_contracts() {
        let source = include_str!("../../../examples/plugins/model-greeting/codeg-plugin.json");
        let manifest: Value = serde_json::from_str(source).unwrap();
        let parsed = Manifest::parse(source).unwrap();
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["contributes"]["modelTools"],
            manifest["contributes"]["modelTools"]
        );
        for (field, value) in [
            ("id", json!("other.greet")),
            ("id", json!("x".repeat(33))),
            ("description", json!("")),
            ("method", json!("not-declared")),
        ] {
            let mut invalid = manifest.clone();
            invalid["contributes"]["modelTools"][0][field] = value;
            assert!(Manifest::parse(&invalid.to_string()).is_err(), "{field}");
        }
        let mut duplicate = manifest.clone();
        let tool = duplicate["contributes"]["modelTools"][0].clone();
        duplicate["contributes"]["modelTools"]
            .as_array_mut()
            .unwrap()
            .push(tool);
        assert!(Manifest::parse(&duplicate.to_string()).is_err());

        let mut without_contract = manifest.clone();
        without_contract["server"]
            .as_object_mut()
            .unwrap()
            .remove("rpc");
        assert!(Manifest::parse(&without_contract.to_string()).is_err());

        let mut string_input = manifest;
        string_input["server"]["rpc"]["greet"]["input"] = json!({ "type": "string" });
        assert!(Manifest::parse(&string_input.to_string()).is_err());
        assert_ne!(
            tool_name("test.one", "greet"),
            tool_name("test.two", "greet")
        );
    }
}
