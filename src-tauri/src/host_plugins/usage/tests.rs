use super::*;
use crate::commands::host_plugins::usage_query_core;
use crate::host_plugins::{source, Manifest, Mutation};
use std::path::Path;

const EXAMPLE: &str = include_str!("../../../../examples/plugins/usage-demo/codeg-plugin.json");
const PLUGIN_ID: &str = "codeg.usage-demo";
const SOURCE_ID: &str = "demo-quota";

#[test]
fn validates_usage_source_manifests_and_round_trips_declarations() {
    let original: Value = serde_json::from_str(EXAMPLE).unwrap();
    let manifest = Manifest::parse(EXAMPLE).unwrap();
    let serialized = serde_json::to_value(&manifest).unwrap();
    assert_eq!(
        serialized["contributes"]["usageSources"],
        original["contributes"]["usageSources"]
    );
    assert_eq!(Manifest::parse(&serialized.to_string()).unwrap(), manifest);

    for (field, value) in [
        ("id", json!("invalid/id")),
        ("title", json!(" ")),
        ("titleTranslations", json!({ "es": "" })),
        ("provider", json!("-demo")),
        ("provider", json!("Demo")),
        ("provider", json!("a".repeat(33))),
        ("provider", json!(null)),
        ("method", json!("other-plugin.usage")),
        ("entry", json!("other.mjs")),
    ] {
        let mut rejected = original.clone();
        rejected["contributes"]["usageSources"][0][field] = value;
        assert!(Manifest::parse(&rejected.to_string()).is_err(), "{field}");
    }

    let mut no_provider = original.clone();
    no_provider["contributes"]["usageSources"][0]
        .as_object_mut()
        .unwrap()
        .remove("provider");
    let parsed = Manifest::parse(&no_provider.to_string()).unwrap();
    assert!(
        serde_json::to_value(parsed).unwrap()["contributes"]["usageSources"][0]
            .get("provider")
            .is_none()
    );

    let mut without_server = original.clone();
    without_server.as_object_mut().unwrap().remove("server");
    without_server["client"] = json!({ "entry": "client.html" });
    let error = Manifest::parse(&without_server.to_string()).unwrap_err();
    assert!(error.message.contains("server entry"));

    let source = original["contributes"]["usageSources"][0].clone();
    let mut duplicate = original.clone();
    duplicate["contributes"]["usageSources"] = json!([source, source]);
    assert!(Manifest::parse(&duplicate.to_string()).is_err());

    let mut limited = original;
    let sources = (0..MAX_CONTRIBUTIONS).map(|index| {
        let mut source = source.clone();
        source["id"] = json!(format!("source-{index}"));
        source
    });
    limited["contributes"]["usageSources"] = Value::Array(sources.collect());
    Manifest::parse(&limited.to_string()).unwrap();
    limited["contributes"]["usageSources"]
        .as_array_mut()
        .unwrap()
        .push(source);
    assert!(Manifest::parse(&limited.to_string()).is_err());

    let legacy = Manifest::parse(include_str!(
        "../../../../examples/plugins/turn-activity/codeg-plugin.json"
    ))
    .unwrap();
    let mut serialized = serde_json::to_value(&legacy).unwrap();
    assert!(serialized["contributes"].get("usageSources").is_none());
    serialized["contributes"]["usageSources"] = json!([]);
    assert_eq!(Manifest::parse(&serialized.to_string()).unwrap(), legacy);
}

fn available() -> Value {
    json!({
        "accounts": [{
            "key": "Account_1.demo",
            "label": "Demo account",
            "harness": "demo",
            "report": {
                "status": "available",
                "planLabel": "Demo",
                "windows": [{
                    "id": "five-hour",
                    "label": "Five-hour usage",
                    "usedPercent": 42.5,
                    "resetsAt": "2026-11-22T03:00:00Z",
                    "durationSeconds": 18000
                }],
                "balances": [{ "id": "credits", "label": "Credits", "amount": "250", "unit": "credits" }],
                "details": [{ "label": "Data source", "value": "Example" }]
            }
        }]
    })
}

#[test]
fn validates_all_usage_report_statuses_and_removes_control_characters() {
    let mut value = available();
    let accounts = value["accounts"].as_array_mut().unwrap();
    accounts.push(json!({
        "key": "expired",
        "report": {
            "status": "unavailable",
            "problem": { "kind": "expired", "detail": "Renew it", "expiresAt": "2026-11-21T03:00:00Z", "status": 401 }
        }
    }));
    accounts.push(json!({
        "key": "empty-plan",
        "report": { "status": "unavailable", "problem": { "kind": "no_quota" } }
    }));
    accounts.push(json!({
        "key": "rejected",
        "report": { "status": "unavailable", "problem": { "kind": "rejected" } }
    }));
    accounts.push(json!({
        "key": "error",
        "report": { "status": "error", "error": "Usage data unavailable" }
    }));
    let parsed = UsageQueryResult::parse(value.clone()).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);

    let mut with_controls = value.clone();
    with_controls["accounts"][0]["label"] = json!("Demo\u{0} account\t");
    with_controls["accounts"][0]["report"]["balances"][0]["unit"] = json!("credi\u{7f}ts");
    with_controls["accounts"][0]["report"]["details"][0]["value"] = json!("Exam\nple");
    with_controls["accounts"][1]["report"]["problem"]["detail"] = json!("Re\u{1b}new it");
    with_controls["accounts"][4]["report"]["error"] = json!("Usage data unava\u{85}ilable");
    let parsed = UsageQueryResult::parse(with_controls).unwrap();
    assert_eq!(serde_json::to_value(parsed).unwrap(), value);
}

#[test]
fn rejects_oversized_report_arrays_and_invalid_account_keys() {
    let template = available();
    let account = &template["accounts"][0];
    UsageQueryResult::parse(json!({ "accounts": vec![account; MAX_ACCOUNTS] })).unwrap();
    assert!(
        UsageQueryResult::parse(json!({ "accounts": vec![account; MAX_ACCOUNTS + 1] })).is_err()
    );
    for (field, limit) in [
        ("windows", MAX_WINDOWS),
        ("balances", MAX_BALANCES),
        ("details", MAX_DETAILS),
    ] {
        let mut value = template.clone();
        let entry = &template["accounts"][0]["report"][field][0];
        value["accounts"][0]["report"][field] = json!(vec![entry; limit]);
        UsageQueryResult::parse(value.clone()).unwrap();
        value["accounts"][0]["report"][field] = json!(vec![entry; limit + 1]);
        assert!(UsageQueryResult::parse(value).is_err(), "{field}");
    }
    for key in [
        "",
        "has whitespace",
        "has/slash",
        "non-ascii-é",
        "a\0b",
        &"k".repeat(129),
    ] {
        let mut value = template.clone();
        value["accounts"][0]["key"] = json!(key);
        assert!(UsageQueryResult::parse(value).is_err());
    }
}

#[test]
fn rejects_incorrect_percentages_text_and_unrecognized_fields() {
    let template = available();
    for percent in [json!(-0.1), json!(100.1), json!("NaN"), Value::Null] {
        let mut value = template.clone();
        value["accounts"][0]["report"]["windows"][0]["usedPercent"] = percent;
        assert!(UsageQueryResult::parse(value).is_err());
    }
    let mut window: UsageWindow =
        serde_json::from_value(template["accounts"][0]["report"]["windows"][0].clone()).unwrap();
    for percent in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        window.used_percent = percent;
        assert!(window.validate().is_err());
    }
    for percent in [0.0, 100.0] {
        window.used_percent = percent;
        window.validate().unwrap();
    }

    for (field, limit) in [
        ("label", MAX_LABEL_CHARS),
        ("harness", MAX_SHORT_TEXT_CHARS),
    ] {
        let mut value = template.clone();
        value["accounts"][0][field] = json!("字".repeat(limit));
        UsageQueryResult::parse(value.clone()).unwrap();
        value["accounts"][0][field] = json!("字".repeat(limit + 1));
        assert!(UsageQueryResult::parse(value).is_err(), "{field}");
    }

    let mut unknown = template.clone();
    unknown["accounts"][0]["token"] = json!("private-test-value");
    let error = UsageQueryResult::parse(unknown).unwrap_err();
    assert_eq!(error.message, "The plugin returned an invalid usage report");
    assert!(error.detail.is_none());

    let mut wrong_type = template;
    wrong_type["accounts"][0]["report"]["windows"][0]["resetsAt"] = Value::Null;
    assert!(UsageQueryResult::parse(wrong_type).is_err());
}

async fn install(host: &HostPlugins, directory: &Path) {
    let preview = host
        .preview_install(directory.to_str().unwrap(), source::Registry::Npm, None)
        .await
        .unwrap();
    host.confirm_install(preview.ticket).unwrap();
    host.apply(Mutation::SetEnabled {
        id: PLUGIN_ID.into(),
        enabled: true,
    })
    .unwrap();
}

#[tokio::test]
async fn queries_the_installed_example_only_when_its_source_is_enabled() {
    let data = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(data.path());
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/usage-demo");
    install(&host, &source).await;

    let output = usage_query_core(&host, PLUGIN_ID, SOURCE_ID, Some("es"))
        .await
        .unwrap();
    let output = serde_json::to_value(output).unwrap();
    assert_eq!(output["accounts"][0]["label"], "Cuenta de ejemplo");
    let report = &output["accounts"][0]["report"];
    assert_eq!(report["windows"][0]["durationSeconds"], 18_000);
    assert_eq!(report["windows"][1]["id"], "weekly");
    assert_eq!(report["balances"][0]["amount"], "250");
    assert_eq!(report["details"][0]["label"], "Data source");

    let output = usage_query_core(&host, PLUGIN_ID, SOURCE_ID, None)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(output).unwrap()["accounts"][0]["label"],
        "Demo account"
    );
    for (source, locale) in [("read-usage", None), (SOURCE_ID, Some("EN"))] {
        assert!(usage_query_core(&host, PLUGIN_ID, source, locale)
            .await
            .is_err());
    }

    host.apply(Mutation::SetEnabled {
        id: PLUGIN_ID.into(),
        enabled: false,
    })
    .unwrap();
    assert!(usage_query_core(&host, PLUGIN_ID, SOURCE_ID, None)
        .await
        .is_err());
}

#[tokio::test]
async fn usage_methods_cannot_read_saved_settings_and_nonfinite_js_values_are_rejected() {
    let data = tempfile::tempdir().unwrap();
    let directory = tempfile::tempdir().unwrap();
    let host = HostPlugins::new(data.path());
    let mut manifest: Value = serde_json::from_str(EXAMPLE).unwrap();
    manifest["settings"] = json!({
        "version": 1,
        "defaults": { "exampleSecret": "private-test-value" },
        "schema": { "type": "object" }
    });
    std::fs::write(
        directory.path().join("codeg-plugin.json"),
        manifest.to_string(),
    )
    .unwrap();
    std::fs::write(directory.path().join("usage.mjs"), r#"
        export function handle(method, input, settings) {
          if (settings !== null) throw new Error("Unexpected settings")
          if (input.locale === "en") return { accounts: [] }
          return { accounts: [{
            key: "example",
            report: { status: "available", windows: [{ id: "hour", label: "Hour", usedPercent: NaN }] }
          }] }
        }
        "#).unwrap();
    install(&host, directory.path()).await;
    assert!(usage_query_core(&host, PLUGIN_ID, SOURCE_ID, None)
        .await
        .is_ok());
    let error = usage_query_core(&host, PLUGIN_ID, SOURCE_ID, Some("es"))
        .await
        .unwrap_err();
    assert_eq!(error.message, "The plugin returned an invalid usage report");
}
