use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{json, Value};

use super::EVENT_CHANNEL;
use crate::app_error::AppErrorCode;
use crate::commands::host_plugins::{apply_core, call_core};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::host_plugins::{source::Registry, HostPlugins, Manifest, Mutation, CATALOG_CHANGED};
use crate::models::agent::AgentType;
use crate::web::event_bridge::{EventEmitter, WebEvent, WebEventBroadcaster};

const PROVIDER: &str = "codeg.metrics-provider";
const CONSUMER: &str = "codeg.metrics-consumer";
const PROVIDER_JSON: &str =
    include_str!("../../../../examples/plugins/service-provider/codeg-plugin.json");
const CONSUMER_JSON: &str =
    include_str!("../../../../examples/plugins/service-consumer/codeg-plugin.json");
const RUN: &str = "export const handle = () => 'ok'";

fn example(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../examples/plugins")
        .join(name)
}

fn manifest(id: &str) -> Value {
    json!({
        "apiVersion": 2, "id": id, "name": "Fixture", "version": "1.0.0",
        "server": {"entry": "fixture.mjs", "methods": ["run", "private"]},
        "contributes": {}
    })
}

fn fixture(id: &str, service: &str, requires: Value) -> Value {
    let mut manifest = manifest(id);
    manifest["services"] = json!({
        "provides": [{"name": service, "version": 1, "methods": ["run"]}],
        "requires": requires
    });
    manifest
}

fn bundle(dir: &Path, manifest: &Value, code: &str) -> PathBuf {
    let source = dir.join(manifest["id"].as_str().unwrap());
    std::fs::create_dir_all(&source).unwrap();
    std::fs::write(source.join("codeg-plugin.json"), manifest.to_string()).unwrap();
    std::fs::write(source.join("fixture.mjs"), code).unwrap();
    source
}

async fn install(host: &HostPlugins, source: &Path) {
    let preview = host
        .preview_install(source.to_str().unwrap(), Registry::Npm, None)
        .await
        .unwrap();
    host.confirm_install(preview.ticket).unwrap();
}

fn enable(id: &str, enabled: bool) -> Mutation {
    Mutation::SetEnabled {
        id: id.into(),
        enabled,
    }
}

fn set_enabled(host: &HostPlugins, id: &str, enabled: bool) {
    host.apply(enable(id, enabled)).unwrap();
}

fn broadcaster() -> (EventEmitter, tokio::sync::broadcast::Receiver<WebEvent>) {
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let rx = broadcaster.subscribe();
    (EventEmitter::test_web_only(broadcaster), rx)
}

#[test]
fn declarations_round_trip_and_default_fields_stay_optional() {
    for sample in [PROVIDER_JSON, CONSUMER_JSON] {
        let manifest = Manifest::parse(sample).unwrap();
        let actual = serde_json::to_value(&manifest).unwrap();
        let declared: Value = serde_json::from_str(sample).unwrap();
        assert_eq!(actual["services"], declared["services"]);
        assert_eq!(actual["events"], declared["events"]);
        assert_eq!(Manifest::parse(&actual.to_string()).unwrap(), manifest);
    }
    let old = include_str!("../../../../examples/plugins/turn-activity/codeg-plugin.json");
    assert_eq!(
        serde_json::to_value(Manifest::parse(old).unwrap()).unwrap(),
        serde_json::from_str::<Value>(old).unwrap()
    );
    let mut manifest = manifest("test.defaults");
    manifest["services"] =
        json!({"requires": [{"service":"test.dep", "minVersion":1, "optional":false}]});
    manifest["events"] = json!({"publishes": [{"name":"test.ready", "scope":"host"}]});
    let actual = serde_json::to_value(Manifest::parse(&manifest.to_string()).unwrap()).unwrap();
    assert_eq!(
        actual["services"]["requires"],
        json!([{"service":"test.dep"}])
    );
    assert_eq!(
        actual["events"]["publishes"],
        json!([{"name":"test.ready"}])
    );
}

#[test]
fn rejects_invalid_contracts_and_self_dependencies() {
    let provider = json!({"name":"test.metrics", "version":1, "methods":["run"]});
    for (key, invalid) in [
        ("name", json!("not valid")),
        ("version", json!(0)),
        ("methods", json!([])),
        ("methods", json!(["run", "run"])),
        ("methods", json!(["foreign"])),
        ("descriptionTranslations", json!({"es": "Descripción"})),
        ("unknown", json!(true)),
    ] {
        let mut input = manifest("test.invalid");
        let mut invalid_provider = provider.clone();
        invalid_provider[key] = invalid;
        input["services"] = json!({"provides":[invalid_provider]});
        assert!(Manifest::parse(&input.to_string()).is_err(), "{key}");
    }
    let event = json!({"name":"test.ready"});
    let mut input = manifest("test.invalid");
    for services in [
        json!({"provides":[provider, provider]}),
        json!({"provides": (0..9).map(|i| json!({"name":format!("svc-{i}"),"version":1,"methods":["run"]})).collect::<Vec<_>>()}),
        json!({"provides":[provider], "requires":[{"service":"test.metrics", "optional":true}]}),
        json!({"requires":[{"service":"test.other", "minVersion":0}]}),
        json!({"requires":[{"service":"test.other"}, {"service":"test.other"}]}),
        json!({"requires":(0..9).map(|i| json!({"service":format!("svc-{i}")})).collect::<Vec<_>>()}),
        json!({"unknown":false}),
        Value::Null,
    ] {
        input["services"] = services;
        assert!(
            Manifest::parse(&input.to_string()).is_err(),
            "{}",
            input["services"]
        );
    }
    input.as_object_mut().unwrap().remove("services");
    for events in [
        json!({"publishes":[event, event]}),
        json!({"publishes":[{"name":"test.ready","scope":"folder"}]}),
        json!({"publishes":[{"name":"test.ready","payloadSchema":null}]}),
        json!({"publishes":[{"name":"test.ready","payloadSchema":{"type":"made-up"}}]}),
        json!({"publishes":[{"name":"test.ready","unknown":true}]}),
        json!({"publishes":(0..17).map(|i| json!({"name":format!("event-{i}")})).collect::<Vec<_>>()}),
    ] {
        input["events"] = events;
        assert!(
            Manifest::parse(&input.to_string()).is_err(),
            "{}",
            input["events"]
        );
    }
    input["events"] = json!({"publishes":[event]});
    input.as_object_mut().unwrap().remove("server");
    input["client"] = json!({"entry":"fixture.html"});
    assert!(Manifest::parse(&input.to_string()).is_err());
}

#[tokio::test]
async fn real_examples_validate_provider_and_publish_scoped_metrics() {
    let data = tempfile::tempdir().unwrap();
    let db = fresh_in_memory_db().await;
    let folder_id = seed_folder(&db, data.path().to_str().unwrap()).await;
    let host = Arc::new(HostPlugins::with_database(data.path(), &db));
    install(&host, &example("service-consumer")).await;
    let missing = host.apply(enable(CONSUMER, true)).unwrap_err();
    assert!(matches!(missing.code, AppErrorCode::DependencyMissing));
    assert_eq!(
        missing.i18n_params.unwrap()["missingServices"],
        "workspace.metrics"
    );
    install(&host, &example("service-provider")).await;
    set_enabled(&host, PROVIDER, true);
    set_enabled(&host, CONSUMER, true);

    let settings = host.settings(PROVIDER).unwrap();
    host.save_settings(PROVIDER, settings.revision, json!({"weight":3}))
        .unwrap();
    let (emitter, mut rx) = broadcaster();
    let result = call_core(
        &host,
        &emitter,
        CONSUMER,
        "refresh".into(),
        json!({
            "folderId": folder_id, "fileCount": 7
        }),
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"fileCount":7, "score":21}));
    let event = rx.try_recv().unwrap();
    assert_eq!(event.channel, EVENT_CHANNEL);
    assert_eq!(event.payload["pluginId"], CONSUMER);
    assert_eq!(event.payload["event"], "metrics.summary");
    assert_eq!(event.payload["scope"], "workspace");
    assert_eq!(event.payload["folderId"], folder_id);
    assert_eq!(event.payload["conversationId"], Value::Null);
    assert_eq!(event.payload["payload"], result);
    assert!(
        chrono::DateTime::parse_from_rfc3339(event.payload["emittedAt"].as_str().unwrap()).is_ok()
    );

    let catalog = apply_core(&host, &emitter, enable(PROVIDER, false))
        .await
        .unwrap();
    assert!(catalog.iter().all(|plugin| !plugin.enabled));
    assert_eq!(rx.try_recv().unwrap().channel, CATALOG_CHANGED);
    assert!(rx.try_recv().is_err());
    assert!(HostPlugins::new(data.path())
        .list()
        .unwrap()
        .iter()
        .all(|plugin| !plugin.enabled));
}

#[tokio::test]
async fn activation_conflicts_versions_and_transitive_withdrawal() {
    let data = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(data.path());
    for (id, name, dependencies) in [
        ("test.provider", "test.upstream", json!([])),
        ("test.conflict", "test.upstream", json!([])),
        (
            "test.middle",
            "test.middle",
            json!([{"service":"test.upstream"}]),
        ),
        ("test.leaf", "test.leaf", json!([{"service":"test.middle"}])),
        (
            "test.optional",
            "test.optional",
            json!([{"service":"test.upstream","optional":true}]),
        ),
        (
            "test.version",
            "test.version",
            json!([{"service":"test.upstream","minVersion":2}]),
        ),
    ] {
        install(
            &host,
            &bundle(src.path(), &fixture(id, name, dependencies), RUN),
        )
        .await;
    }
    set_enabled(&host, "test.provider", true);
    let conflict = host.apply(enable("test.conflict", true)).unwrap_err();
    assert!(matches!(conflict.code, AppErrorCode::AlreadyExists));
    assert_eq!(conflict.i18n_params.unwrap()["providerId"], "test.provider");
    let version = host.apply(enable("test.version", true)).unwrap_err();
    assert!(matches!(version.code, AppErrorCode::DependencyMissing));
    assert_eq!(
        version.i18n_params.unwrap()["incompatibleServices"],
        "test.upstream"
    );

    for id in ["test.middle", "test.leaf", "test.optional"] {
        set_enabled(&host, id, true);
    }
    let installed = host
        .apply(Mutation::Remove {
            id: "test.provider".into(),
        })
        .unwrap();
    let enabled: Vec<_> = installed
        .iter()
        .filter(|plugin| plugin.enabled)
        .map(|plugin| plugin.manifest.id.as_str())
        .collect();
    assert_eq!(enabled, ["test.optional"]);
    set_enabled(&host, "test.conflict", true);
    assert!(
        !host
            .list()
            .unwrap()
            .iter()
            .find(|plugin| plugin.manifest.id == "test.middle")
            .unwrap()
            .enabled
    );
}

#[tokio::test]
async fn service_methods_require_declarations_and_share_depth_call_and_byte_limits() {
    let data = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(data.path());
    for (id, requires, code) in [
        (
            "test.d",
            json!([]),
            "export function handle() { return arguments.length }",
        ),
        (
            "test.c",
            json!([{"service":"test.d"}]),
            r#"
            export function handle(_method, input, _settings, ctx) {
              if (input === "depth") {
                try { return ctx.services.call("test.d", "run", null) }
                catch (error) { return error.message }
              }
              return "two hops"
            }
        "#,
        ),
        (
            "test.b",
            json!([{"service":"test.c"},{"service":"test.a","optional":true}]),
            r#"
            export function handle(_method, input, _settings, ctx) {
              if (input === "large") return "x".repeat(40000)
              if (input === "tiny") return true
              if (input === "cycle") {
                try { return ctx.services.call("test.a", "run", null) }
                catch (error) { return error.message }
              }
              return ctx.services.call("test.c", "run", input)
            }
        "#,
        ),
        (
            "test.a",
            json!([{"service":"test.b"}]),
            r#"
            export function handle(_method, input, _settings, ctx) {
              try {
                switch (input) {
                  case "unknown": return ctx.services.call("test.d", "run", null)
                  case "private": return ctx.services.call("test.b", "private", null)
                  case "count":
                    for (let i = 0; i < 9; i++) ctx.services.call("test.b", "run", "tiny")
                    return "missed call cap"
                  case "bytes":
                    ctx.services.call("test.b", "run", "large")
                    return ctx.services.call("test.b", "run", "large")
                  default: return ctx.services.call("test.b", "run", input)
                }
              } catch (error) { return error.message }
            }
        "#,
        ),
    ] {
        install(&host, &bundle(src.path(), &fixture(id, id, requires), code)).await;
        set_enabled(&host, id, true);
    }
    assert_eq!(
        host.call("test.d", "run".into(), Value::Null)
            .await
            .unwrap(),
        3
    );
    for (input, expected) in [
        ("normal", "two hops"),
        ("unknown", "not a declared dependency"),
        ("private", "not exposed"),
        ("depth", "depth exceeds 2"),
        ("cycle", "revisit an active plugin"),
        ("count", "at most 8 service calls"),
        ("bytes", "shared 64 KiB message budget"),
    ] {
        let result = host
            .call("test.a", "run".into(), json!(input))
            .await
            .unwrap();
        assert!(
            result.as_str().unwrap().contains(expected),
            "{input}: {result}"
        );
    }
}

#[tokio::test]
async fn event_batch_validates_scope_schema_limits_targets_and_handler_success() {
    let data = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, data.path().to_str().unwrap()).await;
    let other = seed_folder(&db, src.path().to_str().unwrap()).await;
    let conversation = seed_conversation(&db, folder, AgentType::Codex).await;
    let host = HostPlugins::with_database(data.path(), &db);
    let mut manifest = manifest("test.publisher");
    manifest["events"] = json!({"publishes": [
        {"name":"test.host", "payloadSchema":{"type":"string"}},
        {"name":"test.workspace", "scope":"workspace"},
        {"name":"test.session", "scope":"session"}
    ]});
    manifest["server"]["rpc"] = json!({"run":{"input":{"type":"object"},"output":{"const":"ok"}}});
    let module = r#"
        export function handle(_method, input, _settings, {events}) {
          const {kind, folderId, conversationId} = input
          events.emit("test.host", "ready")
          switch (kind) {
            case "good":
              events.emit("test.workspace", {count:2}, {folderId})
              events.emit("test.session", {count:3}, {folderId, conversationId})
              break
            case "implicit-folder": events.emit("test.session", null, {conversationId}); break
            case "host-with-target": events.emit("test.host", "bad", {folderId}); break
            case "workspace-without-id": events.emit("test.workspace", null, {}); break
            case "workspace-with-session": events.emit("test.workspace", null, {folderId, conversationId}); break
            case "bad-workspace": events.emit("test.workspace", null, {folderId}); break
            case "bad-session": events.emit("test.session", null, {folderId, conversationId}); break
            case "invalid-id": events.emit("test.session", null, {conversationId:0}); break
            case "schema": events.emit("test.host", {invalid:true}); break
            case "undeclared": events.emit("test.missing", null); break
            case "big": events.emit("test.host", "x".repeat(16383)); break
            case "count":
              for (let i = 0; i < 16; i++) events.emit("test.host", "extra")
              break
            case "failed": throw new Error("private handler error")
            case "rpc-output": return false
            case "slow":
              const deadline = Date.now() + 250
              while (Date.now() < deadline) {}
              break
          }
          return "ok"
        }
    "#;
    install(&host, &bundle(src.path(), &manifest, module)).await;
    set_enabled(&host, "test.publisher", true);
    let (emitter, mut rx) = broadcaster();
    let invoke = |kind: &str, folder_id, conversation_id| {
        call_core(
            &host,
            &emitter,
            "test.publisher",
            "run".into(),
            json!({
                "kind":kind,"folderId":folder_id,"conversationId":conversation_id
            }),
        )
    };
    assert_eq!(invoke("good", folder, conversation).await.unwrap(), "ok");
    for (name, folder_id, conversation_id) in [
        ("test.host", Value::Null, Value::Null),
        ("test.workspace", json!(folder), Value::Null),
        ("test.session", json!(folder), json!(conversation)),
    ] {
        let event = rx.try_recv().unwrap();
        assert_eq!(event.channel, EVENT_CHANNEL);
        assert_eq!(event.payload["event"], name);
        assert_eq!(event.payload["folderId"], folder_id);
        assert_eq!(event.payload["conversationId"], conversation_id);
    }
    invoke("implicit-folder", folder, conversation)
        .await
        .unwrap();
    assert_eq!(rx.try_recv().unwrap().payload["scope"], "host");
    let session = rx.try_recv().unwrap();
    assert_eq!(session.payload["scope"], "session");
    assert_eq!(session.payload["folderId"], Value::Null);
    for (kind, folder_id, conversation_id) in [
        ("host-with-target", folder, conversation),
        ("workspace-without-id", folder, conversation),
        ("workspace-with-session", folder, conversation),
        ("invalid-id", folder, conversation),
        ("bad-session", other, conversation),
        ("bad-session", folder, conversation + 1),
        ("bad-workspace", other + 1, conversation),
        ("schema", folder, conversation),
        ("undeclared", folder, conversation),
        ("big", folder, conversation),
        ("count", folder, conversation),
        ("failed", folder, conversation),
        ("rpc-output", folder, conversation),
    ] {
        assert!(
            invoke(kind, folder_id, conversation_id).await.is_err(),
            "{kind}"
        );
        assert!(rx.try_recv().is_err(), "{kind} published a staged event");
    }

    let mut pending = std::pin::pin!(invoke("slow", folder, conversation));
    assert!(futures_util::poll!(&mut pending).is_pending());
    set_enabled(&host, "test.publisher", false);
    set_enabled(&host, "test.publisher", true);
    assert!(matches!(
        pending.await.unwrap_err().code,
        AppErrorCode::NotFound
    ));
    assert!(rx.try_recv().is_err());
}

#[tokio::test]
async fn failed_nested_rpc_discards_provider_events_even_when_caught() {
    let data = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(data.path());
    let mut provider = fixture("test.emitter", "test.emitter", json!([]));
    provider["events"] = json!({"publishes":[{"name":"test.emitted"}]});
    provider["server"]["rpc"] = json!({"run":{
        "input":{"type":"string"}, "output":{"const":"ok"}
    }});
    install(
        &host,
        &bundle(
            src.path(),
            &provider,
            r#"
        export function handle(_method, input, _settings, {events}) {
          events.emit("test.emitted", input)
          return input === "invalid-output" ? false : "ok"
        }
    "#,
        ),
    )
    .await;
    set_enabled(&host, "test.emitter", true);
    let mut consumer = fixture(
        "test.consumer",
        "test.consumer",
        json!([{"service":"test.emitter","optional":true}]),
    );
    consumer["events"] = json!({"publishes":[{"name":"test.result"}]});
    install(
        &host,
        &bundle(
            src.path(),
            &consumer,
            r#"
        export function handle(_method, input, _settings, ctx) {
          let status = "ok"
          try { ctx.services.call("test.emitter", "run", input) }
          catch { status = "caught" }
          ctx.events.emit("test.result", status)
          return status
        }
    "#,
        ),
    )
    .await;
    set_enabled(&host, "test.consumer", true);
    let (emitter, mut rx) = broadcaster();
    let call = |input| call_core(&host, &emitter, "test.consumer", "run".into(), input);
    assert_eq!(call(json!("valid")).await.unwrap(), "ok");
    assert_eq!(rx.try_recv().unwrap().payload["pluginId"], "test.emitter");
    assert_eq!(rx.try_recv().unwrap().payload["pluginId"], "test.consumer");
    for input in [json!(false), json!("invalid-output")] {
        assert_eq!(call(input).await.unwrap(), "caught");
        assert_eq!(rx.try_recv().unwrap().payload["pluginId"], "test.consumer");
        assert!(rx.try_recv().is_err());
    }
    set_enabled(&host, "test.emitter", false);
    assert_eq!(call(json!("valid")).await.unwrap(), "caught");
    assert_eq!(rx.try_recv().unwrap().payload["pluginId"], "test.consumer");
    assert!(rx.try_recv().is_err());
}
