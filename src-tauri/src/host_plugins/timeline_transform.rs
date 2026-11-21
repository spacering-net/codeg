use std::collections::BTreeSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};

use super::{catalog_error, invalid, plugin_not_found, runtime, timeline, valid_id};
use super::{HostPlugins, Invocation, Manifest, MAX_CONTRIBUTIONS};
use crate::app_error::{AppCommandError, AppErrorCode};

const MAX_TOOL_NAMES: usize = 16;
const MAX_TOOL_NAME_BYTES: usize = 128;
const MAX_REPLACEMENTS: usize = 4;
const MAX_ITEM_BYTES: usize = 64 * 1024;
// The runtime budget also needs room for the host-generated RPC envelope.
pub(super) const MAX_INPUT_BYTES: usize = MAX_ITEM_BYTES + 1024;
pub(super) const MAX_OUTPUT_BYTES: usize = MAX_REPLACEMENTS * timeline::MAX_APPEND_BYTES + 128;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case", try_from = "String")]
enum ItemType {
    ToolCall,
    AssistantMessage,
}

impl TryFrom<String> for ItemType {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "tool_call" => Ok(Self::ToolCall),
            "assistant_message" => Ok(Self::AssistantMessage),
            _ => Err("expected tool_call or assistant_message"),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
enum Phase {
    Streaming,
    Complete,
}

impl TryFrom<String> for Phase {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "streaming" => Ok(Self::Streaming),
            "complete" => Ok(Self::Complete),
            _ => Err("expected streaming or complete"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Transformer {
    id: String,
    item_type: ItemType,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    tool_names: Option<Vec<String>>,
    renderer_kind: String,
    renderer_version: u32,
    method: String,
}

fn present<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

pub(super) fn validate(manifest: &Manifest, renderers: &timeline::Renderers) -> Result<(), String> {
    let transformers = &manifest.contributes.timeline_transformers;
    if transformers.is_empty() {
        return Ok(());
    }
    let Some(server) = manifest
        .server
        .as_ref()
        .filter(|_| manifest.client.is_some())
    else {
        return Err("Timeline transformers need both a server and a client entry".into());
    };
    if transformers.len() > MAX_CONTRIBUTIONS {
        return Err("Provide up to 16 timeline transformers".into());
    }
    let mut ids = BTreeSet::new();
    for transformer in transformers {
        let error = |reason| format!("Timeline transformer {:?}: {reason}", transformer.id);
        if !valid_id(&transformer.id) || !ids.insert(&transformer.id) {
            return Err(error("invalid or duplicate ID"));
        }
        if let Some(names) = &transformer.tool_names {
            let mut unique = BTreeSet::new();
            if transformer.item_type != ItemType::ToolCall
                || names.is_empty()
                || names.len() > MAX_TOOL_NAMES
                || names.iter().any(|name| {
                    !valid_plain_text(name, MAX_TOOL_NAME_BYTES) || !unique.insert(name)
                })
            {
                return Err(error(
                    "toolNames requires 1 to 16 distinct tool names on a tool_call transformer",
                ));
            }
        }
        if !renderers.contains_key(&(
            transformer.renderer_kind.clone(),
            transformer.renderer_version,
        )) {
            return Err(error(
                "rendererKind and rendererVersion must match a renderer in this plugin",
            ));
        }
        if !server.methods.contains(&transformer.method) {
            return Err(error(
                "method must be declared in this plugin's server.methods",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransformRequest {
    plugin_id: String,
    transformer_id: String,
    item_type: ItemType,
    phase: Phase,
    pub(crate) conversation_id: Option<i32>,
    #[serde(default, deserialize_with = "present")]
    locale: Option<String>,
    item: NativeItem,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeItem {
    id: String,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    tool_name: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    status: Option<String>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    raw_input: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    raw_output: Option<Value>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    text: Option<String>,
}

fn valid_plain_text(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max_bytes && !value.chars().any(char::is_control)
}

impl TransformRequest {
    pub(crate) fn validate(&self) -> Result<(), AppCommandError> {
        if !valid_id(&self.plugin_id) || !valid_id(&self.transformer_id) {
            return Err(invalid("Invalid plugin or timeline transformer ID"));
        }
        if self.conversation_id.is_some_and(|id| id < 0) {
            return Err(invalid("A nonnegative conversation ID is required"));
        }
        if !valid_plain_text(&self.item.id, MAX_ITEM_BYTES) {
            return Err(invalid("Invalid source timeline item ID"));
        }
        if self
            .locale
            .as_deref()
            .is_some_and(|locale| !valid_plain_text(locale, 128))
        {
            return Err(invalid("Invalid timeline transform locale"));
        }
        if !serde_json::to_vec(&self.item).is_ok_and(|bytes| bytes.len() <= MAX_ITEM_BYTES) {
            return Err(invalid("Timeline transform item exceeds 64 KiB"));
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum TransformResult {
    Keep {},
    Omit {},
    Replace { items: Vec<Replacement> },
}

#[derive(Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Replacement {
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    id: Option<String>,
    kind: String,
    version: u32,
    data: Value,
}

impl TransformResult {
    fn validate(
        value: Value,
        renderer: &(String, u32),
        schema: Option<&super::schema::Schema>,
    ) -> Result<Self, AppCommandError> {
        if value.is_null() {
            return Ok(Self::Keep {});
        }
        if !value.is_object()
            || value
                .get("items")
                .and_then(Value::as_array)
                .is_some_and(|items| items.iter().any(|item| !item.is_object()))
        {
            return Err(failed());
        }
        let result: Self = serde_json::from_value(value).map_err(|_| failed())?;
        if let Self::Replace { items } = &result {
            let mut ids = BTreeSet::new();
            if items.is_empty() || items.len() > MAX_REPLACEMENTS {
                return Err(failed());
            }
            for item in items {
                if item.kind != renderer.0
                    || item.version != renderer.1
                    || item
                        .id
                        .as_ref()
                        .is_some_and(|id| !timeline::valid_item_id(id) || !ids.insert(id))
                    || !timeline::valid_data_size(&item.data)
                    || schema.is_some_and(|schema| !schema.matches(&item.data))
                {
                    return Err(failed());
                }
            }
        }
        Ok(result)
    }
}

fn failed() -> AppCommandError {
    AppCommandError::new(
        AppErrorCode::TaskExecutionFailed,
        "Timeline transform failed",
    )
}

impl HostPlugins {
    pub(crate) async fn timeline_transform(
        &self,
        request: TransformRequest,
    ) -> Result<TransformResult, AppCommandError> {
        let TransformRequest {
            plugin_id,
            transformer_id,
            item_type,
            phase,
            conversation_id,
            locale,
            item,
        } = request;
        let (invocation, renderer, schema) = {
            let guard = self.state.lock().expect("host plugin state lock");
            let state = guard.as_ref().map_err(|error| catalog_error(error))?;
            let plugin = state
                .catalog
                .get(&plugin_id)
                .filter(|plugin| plugin.enabled)
                .ok_or_else(plugin_not_found)?;
            let transformer = plugin
                .manifest
                .contributes
                .timeline_transformers
                .iter()
                .find(|transformer| transformer.id == transformer_id)
                .ok_or_else(|| {
                    AppCommandError::not_found("Timeline transformer is not registered")
                })?;
            if transformer.item_type != item_type
                || transformer.tool_names.as_ref().is_some_and(|names| {
                    !item
                        .tool_name
                        .as_ref()
                        .is_some_and(|name| names.contains(name))
                })
            {
                return Ok(TransformResult::Keep {});
            }
            let renderer = (
                transformer.renderer_kind.clone(),
                transformer.renderer_version,
            );
            let schema = plugin
                .timeline_renderers
                .get(&renderer)
                .ok_or_else(plugin_not_found)?
                .clone();
            let invocation = Invocation::new(&plugin_id, plugin, transformer.method.clone())
                .ok_or_else(plugin_not_found)?;
            (invocation, renderer, schema)
        };
        let activation = invocation.activation.clone();
        let result = self
            .run_plugin_task(move || {
                let input = json!({
                    "transformerId": transformer_id,
                    "itemType": item_type,
                    "phase": phase,
                    "conversationId": conversation_id,
                    "locale": locale.as_deref().unwrap_or("en"),
                    "item": item,
                });
                let output = runtime::invoke(
                    &invocation.entry,
                    &invocation.code,
                    &invocation.method,
                    &input,
                    invocation.settings.as_ref().map(|settings| &settings.value),
                    invocation.contract.as_deref(),
                    runtime::InvocationMode::TimelineTransform,
                )
                .map_err(|_| failed())?;
                TransformResult::validate(output.value, &renderer, schema.as_deref())
            })
            .await?;
        let guard = self.state.lock().expect("host plugin state lock");
        let state = guard.as_ref().map_err(|error| catalog_error(error))?;
        state.active_plugin(&plugin_id, &activation)?;
        result
    }
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use axum_test::TestServer;

    use super::*;
    use crate::app_state::AppState;
    use crate::commands::host_plugins::timeline_transform_core;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::db::AppDatabase;
    use crate::host_plugins::{source::Registry, Mutation};
    use crate::models::agent::AgentType;
    use crate::web::{router::build_router, shutdown::ShutdownSignal};

    const PLUGIN: &str = "codeg.tool-output-card";
    const EXAMPLE: &str =
        include_str!("../../../examples/plugins/tool-output-card/codeg-plugin.json");
    const ROUTE: &str = "/api/host_plugins_timeline_transform";

    fn request() -> Value {
        json!({
            "pluginId": PLUGIN,
            "transformerId": "test-output",
            "itemType": "tool_call",
            "phase": "complete",
            "item": {"id": "tool:1", "toolName": "bash", "rawOutput": {"kind": "test-summary", "passed": 4, "failed": 1}}
        })
    }

    fn manifest() -> Value {
        serde_json::from_str(EXAMPLE).unwrap()
    }

    fn set_enabled(host: &HostPlugins, enabled: bool) {
        host.apply(Mutation::SetEnabled {
            id: PLUGIN.into(),
            enabled,
        })
        .unwrap();
    }

    async fn install(host: &HostPlugins, source: &Path) {
        let preview = host
            .preview_install(source.to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        assert!(!host.confirm_install(preview.ticket).unwrap()[0].enabled);
        set_enabled(host, true);
    }

    fn example_path() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/tool-output-card")
    }

    async fn transform(
        host: &HostPlugins,
        db: &AppDatabase,
        value: Value,
    ) -> Result<Value, AppCommandError> {
        let request = serde_json::from_value(value).unwrap();
        let result = timeline_transform_core(host, db, request).await?;
        Ok(serde_json::to_value(result).unwrap())
    }

    #[test]
    fn manifest_round_trip_and_legacy_omission() {
        let parsed = Manifest::parse(EXAMPLE).unwrap();
        let actual = serde_json::to_value(parsed).unwrap();
        let mut expected = manifest();
        assert_eq!(
            actual["contributes"]["timelineTransformers"],
            expected["contributes"]["timelineTransformers"]
        );
        expected["contributes"]["timelineTransformers"] = json!([]);
        let empty = Manifest::parse(&expected.to_string()).unwrap();
        assert!(serde_json::to_value(empty).unwrap()["contributes"]
            .get("timelineTransformers")
            .is_none());
        assert!(serde_json::to_value(
            Manifest::parse(include_str!(
                "../../../examples/plugins/timeline-review/codeg-plugin.json"
            ))
            .unwrap()
        )
        .unwrap()["contributes"]
            .get("timelineTransformers")
            .is_none());

        expected["contributes"]["timelineTransformers"] = json!([{
            "id": "assistant", "itemType": "assistant_message",
            "rendererKind": "test-result", "rendererVersion": 1, "method": "transform-tests"
        }]);
        assert!(Manifest::parse(&expected.to_string()).is_ok());
    }

    #[test]
    fn manifest_rejects_invalid_selector_ids_and_foreign_targets() {
        let mut value = manifest();
        let item = value["contributes"]["timelineTransformers"][0].clone();
        for (key, invalid) in [
            ("id", json!("Invalid")),
            ("itemType", json!("reasoning")),
            ("itemType", json!("assistant_message")),
            ("toolNames", json!([])),
            ("toolNames", json!(null)),
            ("toolNames", json!(["bash", "bash"])),
            ("toolNames", json!([" "])),
            ("toolNames", json!(["bash\n"])),
            ("toolNames", json!(["é".repeat(65)])),
            (
                "toolNames",
                json!((0..17)
                    .map(|index| format!("tool-{index}"))
                    .collect::<Vec<_>>()),
            ),
            ("rendererKind", json!("review-result")),
            ("rendererVersion", json!(2)),
            ("rendererVersion", json!(0)),
            ("method", json!("record-review")),
            ("extra", json!(true)),
        ] {
            let mut transformer = item.clone();
            transformer[key] = invalid;
            value["contributes"]["timelineTransformers"] = json!([transformer]);
            assert!(Manifest::parse(&value.to_string()).is_err(), "{key}");
        }
        value["contributes"]["timelineTransformers"] = json!([item, item]);
        assert!(Manifest::parse(&value.to_string()).is_err());
        let entries: Vec<_> = (0..17)
            .map(|index| {
                let mut transformer = item.clone();
                transformer["id"] = json!(format!("transform-{index}"));
                transformer
            })
            .collect();
        value["contributes"]["timelineTransformers"] = json!(entries[..16]);
        assert!(Manifest::parse(&value.to_string()).is_ok());
        value["contributes"]["timelineTransformers"] = json!(entries);
        assert!(Manifest::parse(&value.to_string()).is_err());
        for module in ["client", "server"] {
            let mut missing = manifest();
            missing.as_object_mut().unwrap().remove(module);
            assert!(Manifest::parse(&missing.to_string()).is_err());
        }
    }

    #[test]
    fn strict_output_validation_preserves_native_fallback_on_error() {
        let key = ("test-result".into(), 1);
        let schema = super::super::schema::Schema::compile(&json!({"type": "string"})).unwrap();
        let replacement = json!({"kind": "test-result", "version": 1, "data": "ok"});
        for value in [
            json!(["keep"]),
            json!({"action": "keep", "items": []}),
            json!({"action": "omit", "extra": true}),
            json!({"action": "replace", "items": []}),
            json!({"action": "replace", "items": vec![replacement.clone(); 5]}),
            json!({"action": "replace", "items": [[null, "test-result", 1, "ok"]]}),
        ] {
            assert!(TransformResult::validate(value, &key, Some(&schema)).is_err());
        }
        for (field, value) in [
            ("id", json!("Bad-id")),
            ("id", json!("a".repeat(65))),
            ("id", Value::Null),
            ("kind", json!("review-result")),
            ("version", json!(2)),
            ("data", json!({"unexpected": true})),
            ("data", json!("a".repeat(timeline::MAX_DATA_BYTES - 1))),
            ("pluginId", json!("another")),
        ] {
            let mut item = replacement.clone();
            item[field] = value;
            assert!(
                TransformResult::validate(
                    json!({"action": "replace", "items": [item]}),
                    &key,
                    Some(&schema)
                )
                .is_err(),
                "{field}"
            );
        }
        let mut named = replacement;
        named["id"] = json!("summary");
        assert!(TransformResult::validate(
            json!({"action": "replace", "items": [named, named]}),
            &key,
            None
        )
        .is_err());
    }

    #[tokio::test]
    async fn actual_example_keeps_omits_replaces_and_respects_host_settings() {
        let dir = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(dir.path());
        let db = fresh_in_memory_db().await;
        install(&host, &example_path()).await;
        let mut input = request();
        let expected = json!({
            "action":"replace",
            "items":[{"id":"summary", "kind":"test-result", "version":1,
                "data":{"phase":"complete", "status":"failed", "passed":4, "failed":1}}]
        });
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            expected
        );
        input["item"]["toolName"] = json!("exec_command");
        input["item"]["rawOutput"] = json!({
            "formatted_output": "test result: FAILED. 4 passed; 1 failed; 0 ignored"
        });
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            expected
        );
        input["item"]["toolName"] = json!("other");
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            json!({"action":"keep"})
        );
        input["item"]["toolName"] = json!("bash");
        input["itemType"] = json!("assistant_message");
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            json!({"action":"keep"})
        );

        input = request();
        input["item"]["rawOutput"] = json!("shell output");
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            json!({"action":"keep"})
        );
        input["item"]["rawOutput"] = json!({"kind":"test-summary", "passed":0, "failed":0});
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            json!({"action":"omit"})
        );
        let settings = host.settings(PLUGIN).unwrap();
        host.save_settings(PLUGIN, settings.revision, json!({"showEmptySuites":true}))
            .unwrap();
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap()["action"],
            "replace"
        );
        input["phase"] = json!("streaming");
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap()["items"][0]["data"]["phase"],
            "streaming"
        );

        set_enabled(&host, false);
        assert!(matches!(
            transform(&host, &db, input.clone()).await.unwrap_err().code,
            AppErrorCode::NotFound
        ));
        host.apply(Mutation::Remove { id: PLUGIN.into() }).unwrap();
        assert!(matches!(
            transform(&host, &db, input).await.unwrap_err().code,
            AppErrorCode::NotFound
        ));
    }

    #[tokio::test]
    async fn runtime_bounds_support_four_full_items_and_sanitize_invalid_plugin_output() {
        let data = tempfile::tempdir().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let mut manifest = manifest();
        manifest["contributes"]["timelineRenderers"][0]
            .as_object_mut()
            .unwrap()
            .remove("dataSchema");
        manifest["server"]["rpc"] = json!({"transform-tests": {
            "input": {"type": "object", "properties": {"locale": {"const": "en"}}},
            "output": {"type": ["object", "null"]}
        }});
        std::fs::write(dir.path().join("codeg-plugin.json"), manifest.to_string()).unwrap();
        std::fs::write(dir.path().join("card.html"), "<p>Test</p>").unwrap();
        std::fs::write(
            dir.path().join("transform.mjs"),
            r#"
          export function handle(_method, { item }) {
            if (item.status === "throw") throw new Error("private detail")
            if (item.status === "null") return null
            if (item.status === "function") return () => null
            if (item.status === "slow") {
              const ready = Date.now() + 250
              while (Date.now() < ready) {}
              return { action: "keep" }
            }
            const size = item.status === "oversized" ? 65535 : 65534
            return { action: "replace", items: Array.from({ length: 4 }, () =>
              ({ kind: "test-result", version: 1, data: "x".repeat(size) })) }
          }
        "#,
        )
        .unwrap();
        let host = HostPlugins::new(data.path());
        let db = fresh_in_memory_db().await;
        install(&host, dir.path()).await;

        let mut input = request();
        input["item"]["text"] = json!("");
        let overhead = serde_json::to_vec(&input["item"]).unwrap().len();
        input["item"]["text"] = json!("x".repeat(MAX_ITEM_BYTES - overhead));
        let output = transform(&host, &db, input.clone()).await.unwrap();
        let items = output["items"].as_array().unwrap();
        assert_eq!(items.len(), MAX_REPLACEMENTS);
        assert_eq!(
            serde_json::to_vec(&items[0]["data"]).unwrap().len(),
            timeline::MAX_DATA_BYTES
        );

        input["item"]["text"] = json!("x".repeat(MAX_ITEM_BYTES - overhead + 1));
        assert!(matches!(
            transform(&host, &db, input.clone()).await.unwrap_err().code,
            AppErrorCode::InvalidInput
        ));
        input = request();
        input["item"]["status"] = json!("null");
        assert_eq!(
            transform(&host, &db, input.clone()).await.unwrap(),
            json!({"action":"keep"})
        );
        for status in ["throw", "function", "oversized"] {
            input["item"]["status"] = json!(status);
            let error = transform(&host, &db, input.clone()).await.unwrap_err();
            assert_eq!(error.message, "Timeline transform failed");
            assert!(error.detail.is_none());
        }
        // A nonmatching selector bypasses the runtime even with a throwing item.
        input["item"]["status"] = json!("throw");
        input["item"]["toolName"] = json!("other");
        assert_eq!(
            transform(&host, &db, input).await.unwrap(),
            json!({"action":"keep"})
        );

        let mut input = request();
        input["locale"] = json!("es");
        assert_eq!(
            transform(&host, &db, input).await.unwrap_err().message,
            "Timeline transform failed"
        );

        let mut input = request();
        input["item"]["status"] = json!("slow");
        let mut pending = std::pin::pin!(transform(&host, &db, input));
        assert!(futures_util::poll!(&mut pending).is_pending());
        set_enabled(&host, false);
        set_enabled(&host, true);
        assert!(matches!(
            pending.await.unwrap_err().code,
            AppErrorCode::NotFound
        ));
    }

    #[tokio::test]
    async fn timeline_transform_route_uses_local_conversation_and_strict_request() {
        let data = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, data.path().to_str().unwrap()).await;
        let conversation_id = seed_conversation(&db, folder, AgentType::Codex).await;
        let state = Arc::new(AppState::new_for_test(db, data.path().to_path_buf()));
        install(&state.host_plugins, &example_path()).await;
        let token = "timeline-transform-test";
        let router = build_router(
            state,
            token.into(),
            data.path().to_path_buf(),
            Arc::new(ShutdownSignal::new()),
        );
        let server = TestServer::new(router).unwrap();

        let mut input = request();
        assert_eq!(server.post(ROUTE).json(&input).await.status_code(), 401);
        input["conversationId"] = json!(conversation_id);
        let response = server
            .post(ROUTE)
            .add_header("authorization", format!("Bearer {token}"))
            .json(&input)
            .await;
        assert_eq!(response.status_code(), 200);
        assert_eq!(response.json::<Value>()["action"], "replace");

        for (id, status) in [(-1, 400), (conversation_id + 1, 404)] {
            input["conversationId"] = json!(id);
            let response = server
                .post(ROUTE)
                .add_header("authorization", format!("Bearer {token}"))
                .json(&input)
                .await;
            assert_eq!(response.status_code(), status);
        }
        input["conversationId"] = json!(null);
        input["item"]["pluginId"] = json!("other.plugin");
        let response = server
            .post(ROUTE)
            .add_header("authorization", format!("Bearer {token}"))
            .json(&input)
            .await;
        assert_eq!(response.status_code(), 422);
    }
}
