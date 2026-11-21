use super::*;
use crate::acp::{EventBusMetrics, InternalEventBus};
use crate::commands::host_plugins::{call_core, timeline_list_core};
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::host_plugins::{source, HostPlugins, Manifest, Mutation};
use crate::models::agent::AgentType;
use crate::web::event_bridge::WebEventBroadcaster;
use serde_json::json;

const EXAMPLE: &str =
    include_str!("../../../../examples/plugins/timeline-review/codeg-plugin.json");
const EXAMPLE_ID: &str = "codeg.timeline-review";
const HTML: &str = include_str!("../../../../examples/plugins/timeline-review/review.html");
const METHOD: &str = "record-review";

#[test]
fn validates_timeline_renderer_manifests_and_round_trips_declarations() {
    let original: Value = serde_json::from_str(EXAMPLE).unwrap();
    let manifest = Manifest::parse(EXAMPLE).unwrap();
    let serialized = serde_json::to_value(&manifest).unwrap();
    assert_eq!(
        serialized["contributes"]["timelineRenderers"],
        original["contributes"]["timelineRenderers"],
    );
    assert_eq!(Manifest::parse(&serialized.to_string()).unwrap(), manifest);

    for (field, value) in [
        ("kind", json!("review.result")),
        ("kind", json!("a".repeat(33))),
        ("version", json!(0)),
        ("title", json!(" ")),
        ("titleTranslations", json!({ "es": "" })),
        ("dataSchema", json!(null)),
        ("dataSchema", json!({ "type": "invalid-type" })),
        (
            "dataSchema",
            json!({ "$ref": "https://example.com/schema.json" }),
        ),
        ("renderer", json!("other.html")),
    ] {
        let mut rejected = original.clone();
        rejected["contributes"]["timelineRenderers"][0][field] = value;
        assert!(Manifest::parse(&rejected.to_string()).is_err(), "{field}");
    }

    let mut without_client = original.clone();
    without_client.as_object_mut().unwrap().remove("client");
    assert!(Manifest::parse(&without_client.to_string()).is_err());

    let renderer = &original["contributes"]["timelineRenderers"][0];
    let mut duplicate = original.clone();
    duplicate["contributes"]["timelineRenderers"] = json!([renderer, renderer]);
    assert!(Manifest::parse(&duplicate.to_string()).is_err());
    duplicate["contributes"]["timelineRenderers"][1]["version"] = json!(2);
    Manifest::parse(&duplicate.to_string()).unwrap();

    let mut limited = original;
    let renderers = (1..=MAX_CONTRIBUTIONS).map(|version| {
        let mut renderer = limited["contributes"]["timelineRenderers"][0].clone();
        renderer["version"] = json!(version);
        renderer
    });
    limited["contributes"]["timelineRenderers"] = Value::Array(renderers.collect());
    Manifest::parse(&limited.to_string()).unwrap();
    let renderers = limited["contributes"]["timelineRenderers"]
        .as_array_mut()
        .unwrap();
    let mut additional = renderers[0].clone();
    additional["version"] = json!(MAX_CONTRIBUTIONS + 1);
    renderers.push(additional);
    assert!(Manifest::parse(&limited.to_string()).is_err());

    let legacy: Value = serde_json::to_value(
        Manifest::parse(include_str!(
            "../../../../examples/plugins/turn-activity/codeg-plugin.json"
        ))
        .unwrap(),
    )
    .unwrap();
    assert!(legacy["contributes"].get("timelineRenderers").is_none());
}

async fn install(host: &HostPlugins, source: &Path, id: &str) {
    let preview = host
        .preview_install(source.to_str().unwrap(), source::Registry::Npm, None)
        .await
        .unwrap();
    host.confirm_install(preview.ticket).unwrap();
    host.apply(Mutation::SetEnabled {
        id: id.into(),
        enabled: true,
    })
    .unwrap();
}

async fn install_fixture(host: &HostPlugins, id: &str, code: &str) {
    let dir = tempfile::tempdir().unwrap();
    let mut manifest: Value = serde_json::from_str(EXAMPLE).unwrap();
    manifest["id"] = json!(id);
    manifest["contributes"]["timelineRenderers"][0]["dataSchema"] = json!(true);
    std::fs::write(dir.path().join("codeg-plugin.json"), manifest.to_string()).unwrap();
    std::fs::write(dir.path().join("review.mjs"), code).unwrap();
    std::fs::write(dir.path().join("review.html"), HTML).unwrap();
    install(host, dir.path(), id).await;
}

async fn call(
    host: &HostPlugins,
    id: &str,
    conversation_id: i32,
    input: Value,
) -> Result<Value, AppCommandError> {
    host.call_with_timeline(
        id,
        METHOD.into(),
        input,
        Some((conversation_id, &EventEmitter::Noop)),
    )
    .await
}

#[tokio::test]
async fn enforces_size_capacity_and_atomic_append_batches() {
    const ID: &str = "test.timeline-bounds";
    let dir = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(dir.path());
    install_fixture(
        &host,
        ID,
        r#"
        export function handle(method, input, settings, host) {
          for (let i = 0; i < input.count; i++) {
            host.timeline.append({
              id: input.id ?? `item-${i}`, kind: "review-result", version: 1,
              data: "x".repeat(input.size ?? 0)
            })
          }
          if (input.fail) throw new Error("failed")
          return true
        }
        "#,
    )
    .await;
    let conversation_id = 4;
    let error = call(
        &host,
        ID,
        conversation_id,
        json!({ "count": 1, "size": MAX_DATA_BYTES - 1 }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("exceeds 64 KiB"));
    assert!(host.timeline_list(conversation_id).unwrap().is_empty());

    call(
        &host,
        ID,
        conversation_id,
        json!({ "count": 1, "size": MAX_DATA_BYTES - 2 }),
    )
    .await
    .unwrap();
    assert_eq!(
        host.timeline_list(conversation_id).unwrap()[0]
            .data
            .as_str()
            .unwrap()
            .len(),
        MAX_DATA_BYTES - 2
    );
    assert!(call(
        &host,
        ID,
        conversation_id,
        json!({ "count": 1, "id": "abort", "fail": true })
    )
    .await
    .is_err());
    assert_eq!(host.timeline_list(conversation_id).unwrap().len(), 1);
    assert!(call(
        &host,
        ID,
        conversation_id,
        json!({ "count": MAX_ITEMS + 1 })
    )
    .await
    .is_err());

    call(&host, ID, conversation_id, json!({ "count": MAX_ITEMS }))
        .await
        .unwrap();
    let error = call(
        &host,
        ID,
        conversation_id,
        json!({ "count": 1, "id": "overflow" }),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("up to 64 items"));
    assert_eq!(
        host.timeline_list(conversation_id).unwrap().len(),
        MAX_ITEMS
    );
}

#[tokio::test]
async fn append_cannot_impersonate_a_plugin_or_escape_the_conversation() {
    const FIRST: &str = "test.timeline-first";
    const SECOND: &str = "test.timeline-second";
    const CODE: &str = r#"
        export function handle(method, input, settings, host) {
          host.timeline.append({ id: "same", kind: "review-result", version: 1, data: input.data, ...input.extra })
          return true
        }
        "#;
    let dir = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(dir.path());
    install_fixture(&host, FIRST, CODE).await;
    install_fixture(&host, SECOND, CODE).await;
    call(&host, FIRST, 6, json!({ "data": "first" }))
        .await
        .unwrap();
    call(&host, SECOND, 6, json!({ "data": "second" }))
        .await
        .unwrap();
    for extra in [
        json!({ "pluginId": FIRST }),
        json!({ "conversationId": 7 }),
        json!({ "kind": "unregistered" }),
        json!({ "id": "a".repeat(65) }),
        json!({ "version": 2 }),
    ] {
        assert!(call(
            &host,
            SECOND,
            6,
            json!({ "data": "invalid", "extra": extra })
        )
        .await
        .is_err());
    }
    let items = host.timeline_list(6).unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(
        items
            .iter()
            .find(|item| item.plugin_id == FIRST)
            .unwrap()
            .data,
        "first"
    );
    assert_eq!(
        items
            .iter()
            .find(|item| item.plugin_id == SECOND)
            .unwrap()
            .data,
        "second"
    );
    assert!(host.timeline_list(7).unwrap().is_empty());
}

#[tokio::test]
async fn example_upserts_broadcasts_and_survives_restart_until_removed() {
    let data = tempfile::tempdir().unwrap();
    let host = Arc::new(HostPlugins::new(data.path()));
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/timeline-review");
    install(&host, &source, EXAMPLE_ID).await;
    assert_eq!(host.client_html(EXAMPLE_ID).unwrap().as_ref(), HTML);

    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, data.path().to_str().unwrap()).await;
    let conversation_id = seed_conversation(&db, folder, AgentType::Codex).await;
    let other = seed_conversation(&db, folder, AgentType::Codex).await;
    let web = Arc::new(WebEventBroadcaster::new());
    let mut events = web.subscribe();
    let emitter = EventEmitter::web_only(
        web,
        Arc::new(InternalEventBus::new(Arc::new(EventBusMetrics::default()))),
        None,
    );
    let call =
        |data, scope| call_core(&host, &db, &emitter, EXAMPLE_ID, METHOD.into(), data, scope);
    let revision = json!({ "summary": "Review the change.", "status": "needs-changes" });
    assert!(call(revision.clone(), Some(other + 1)).await.is_err());
    assert!(call(revision.clone(), None).await.is_err());
    assert!(timeline_list_core(&host, &db, other + 1).await.is_err());
    assert_eq!(
        call(revision, Some(conversation_id)).await.unwrap(),
        json!({ "saved": true })
    );
    let message = events.try_recv().unwrap();
    assert_eq!(message.channel, EVENT_CHANNEL);
    assert_eq!(message.payload["conversationId"], conversation_id);
    assert_eq!(message.payload["pluginId"], EXAMPLE_ID);
    assert_eq!(message.payload["item"]["data"]["status"], "needs-changes");

    let passed = json!({ "summary": "Ready to merge.", "status": "passed" });
    call(passed.clone(), Some(conversation_id)).await.unwrap();
    let error = call(
        json!({ "summary": 7, "status": "passed" }),
        Some(conversation_id),
    )
    .await
    .unwrap_err();
    assert!(error.message.contains("JSON Schema"));
    let items = timeline_list_core(&host, &db, conversation_id)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].data, passed);
    assert_eq!(
        events.try_recv().unwrap().payload["item"],
        serde_json::to_value(&items[0]).unwrap()
    );
    assert!(events.try_recv().is_err());
    assert!(timeline_list_core(&host, &db, other)
        .await
        .unwrap()
        .is_empty());

    let host = HostPlugins::new(data.path());
    assert_eq!(host.timeline_list(conversation_id).unwrap(), items);
    host.apply_with_events(
        Mutation::SetEnabled {
            id: EXAMPLE_ID.into(),
            enabled: false,
        },
        &emitter,
    )
    .unwrap();
    assert!(host.timeline_list(conversation_id).unwrap().is_empty());
    assert_eq!(
        events.try_recv().unwrap().payload.as_ref(),
        &json!({ "conversationId": null, "pluginId": EXAMPLE_ID, "item": null }),
    );
    host.apply(Mutation::SetEnabled {
        id: EXAMPLE_ID.into(),
        enabled: true,
    })
    .unwrap();
    assert_eq!(host.timeline_list(conversation_id).unwrap(), items);
    host.apply_with_events(
        Mutation::Remove {
            id: EXAMPLE_ID.into(),
        },
        &emitter,
    )
    .unwrap();
    assert_eq!(events.try_recv().unwrap().payload["item"], Value::Null);
    assert!(host.timeline_list(conversation_id).unwrap().is_empty());
    assert_eq!(
        std::fs::read_dir(data.path().join("host-plugin-timeline"))
            .unwrap()
            .count(),
        0
    );

    install(&host, &source, EXAMPLE_ID).await;
    assert!(host.timeline_list(conversation_id).unwrap().is_empty());
}
