use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};

use super::{
    valid_id, valid_label, valid_translations, ServerModule, Translations, MAX_CONTRIBUTIONS,
};

const MAX_OPTIONS: usize = 32;
const MAX_REF_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 1024;
const MAX_METADATA_KEYS: usize = 16;
const MAX_METADATA_VALUE_BYTES: usize = 512;
const MAX_METADATA_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct NewWorkspaceItem {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
    #[serde(default, skip_serializing_if = "NewWorkspaceTarget::is_all")]
    target: NewWorkspaceTarget,
    control: NewWorkspaceControl,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
enum NewWorkspaceTarget {
    Workspace,
    Worktree,
    #[default]
    All,
}

impl NewWorkspaceTarget {
    fn is_all(&self) -> bool {
        *self == Self::All
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum NewWorkspaceControl {
    Combobox {
        search_method: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Translations::is_empty")]
        placeholder_translations: Translations,
    },
    Select {
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        options: Option<Vec<NewWorkspaceOption>>,
        #[serde(
            default,
            deserialize_with = "present",
            skip_serializing_if = "Option::is_none"
        )]
        options_method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        placeholder: Option<String>,
        #[serde(default, skip_serializing_if = "Translations::is_empty")]
        placeholder_translations: Translations,
    },
    Toggle {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        default_value: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        on_change_method: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        enabled_patch: Option<NewWorkspacePatch>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        disabled_patch: Option<NewWorkspacePatch>,
    },
    Action {
        method: String,
    },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewWorkspaceOption {
    id: String,
    label: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    label_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    patch: Option<NewWorkspacePatch>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum MetadataValue {
    String(String),
    Number(serde_json::Number),
    Boolean(bool),
    Null,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewWorkspacePatch {
    // Outer None retains the draft field. Some(None) explicitly clears it.
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    branch: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    base_ref: Option<Option<String>>,
    #[serde(
        default,
        deserialize_with = "present",
        skip_serializing_if = "Option::is_none"
    )]
    root_path: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    metadata: BTreeMap<String, MetadataValue>,
}

fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl NewWorkspacePatch {
    fn is_empty(&self) -> bool {
        self.branch.is_none()
            && self.base_ref.is_none()
            && self.root_path.is_none()
            && self.metadata.is_empty()
    }

    fn validate(&self) -> Result<(), &'static str> {
        if self
            .branch
            .as_ref()
            .and_then(Option::as_deref)
            .is_some_and(|branch| !valid_ref(branch))
        {
            return Err("invalid branch suggestion");
        }
        if self
            .base_ref
            .as_ref()
            .and_then(Option::as_deref)
            .is_some_and(|base| !valid_ref(base))
        {
            return Err("invalid base ref suggestion");
        }
        if self
            .root_path
            .as_ref()
            .and_then(Option::as_deref)
            .is_some_and(|path| !valid_line(path, MAX_PATH_BYTES))
        {
            return Err("invalid root path suggestion");
        }
        if self.metadata.len() > MAX_METADATA_KEYS
            || self
                .metadata
                .iter()
                .any(|(key, value)| !valid_metadata_entry(key, value))
            || serde_json::to_vec(&self.metadata)
                .map_or(true, |bytes| bytes.len() > MAX_METADATA_BYTES)
        {
            return Err("invalid or oversized metadata patch");
        }
        Ok(())
    }
}

fn valid_metadata_entry(key: &str, value: &MetadataValue) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && match value {
            MetadataValue::String(text) => {
                text.len() <= MAX_METADATA_VALUE_BYTES && !text.chars().any(char::is_control)
            }
            _ => true,
        }
}

fn valid_line(value: &str, max_bytes: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= max_bytes
        && !value.chars().any(|character| {
            char::is_control(character) || matches!(character, '\u{2028}' | '\u{2029}')
        })
}

fn valid_ref(value: &str) -> bool {
    valid_line(value, MAX_REF_BYTES)
        && !value.starts_with('-')
        && !value.ends_with('.')
        && value != "@"
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains([' ', '~', '^', ':', '?', '*', '[', '\\'])
        && value
            .split('/')
            .all(|part| !part.is_empty() && !part.starts_with('.') && !part.ends_with(".lock"))
}

fn valid_optional_label(label: Option<&str>, translations: &Translations) -> bool {
    match label {
        Some(label) => valid_label(label) && valid_translations(translations, valid_label),
        None => translations.is_empty(),
    }
}

fn validate_options(options: &[NewWorkspaceOption]) -> Result<(), &'static str> {
    let mut ids = BTreeSet::new();
    if options.is_empty() || options.len() > MAX_OPTIONS {
        return Err("provide 1 to 32 static options");
    }
    for option in options {
        if !valid_id(&option.id)
            || !ids.insert(&option.id)
            || !valid_label(&option.label)
            || !valid_translations(&option.label_translations, valid_label)
            || !valid_optional_label(
                option.description.as_deref(),
                &option.description_translations,
            )
        {
            return Err("invalid or duplicate static option");
        }
        if let Some(patch) = &option.patch {
            patch.validate()?;
        }
    }
    Ok(())
}

impl NewWorkspaceControl {
    fn validate(&self, server: Option<&ServerModule>) -> Result<(), &'static str> {
        let require_method = |method: &String| {
            if server.is_some_and(|server| server.methods.contains(method)) {
                Ok(())
            } else {
                Err("method must be declared in this plugin's server.methods")
            }
        };
        let check_placeholder = |placeholder: &Option<String>, translations: &Translations| {
            if valid_optional_label(placeholder.as_deref(), translations) {
                Ok(())
            } else {
                Err("invalid placeholder or missing translation fallback")
            }
        };
        match self {
            Self::Combobox {
                search_method,
                placeholder,
                placeholder_translations,
            } => {
                check_placeholder(placeholder, placeholder_translations)?;
                require_method(search_method)
            }
            Self::Select {
                options,
                options_method,
                placeholder,
                placeholder_translations,
            } => {
                check_placeholder(placeholder, placeholder_translations)?;
                match (options, options_method) {
                    (Some(options), None) => validate_options(options),
                    (None, Some(method)) => require_method(method),
                    _ => Err("select requires exactly one of options and optionsMethod"),
                }
            }
            Self::Toggle {
                on_change_method,
                enabled_patch,
                disabled_patch,
                ..
            } => {
                let patches = enabled_patch.iter().chain(disabled_patch);
                if on_change_method.is_none() && !patches.clone().any(|patch| !patch.is_empty()) {
                    return Err("toggle requires a method or a nonempty patch");
                }
                if let Some(method) = on_change_method {
                    require_method(method)?;
                }
                for patch in patches {
                    patch.validate()?;
                }
                Ok(())
            }
            Self::Action { method } => require_method(method),
        }
    }
}

pub(super) fn validate(
    items: &[NewWorkspaceItem],
    server: Option<&ServerModule>,
) -> Result<(), String> {
    if items.len() > MAX_CONTRIBUTIONS {
        return Err("A plugin can contribute at most 16 new workspace items".into());
    }
    let mut ids = BTreeSet::new();
    for item in items {
        if !valid_id(&item.id)
            || !ids.insert(&item.id)
            || !valid_label(&item.title)
            || !valid_translations(&item.title_translations, valid_label)
            || !valid_optional_label(item.description.as_deref(), &item.description_translations)
        {
            return Err(format!(
                "Invalid or duplicate new workspace item {:?}",
                item.id
            ));
        }
        item.control
            .validate(server)
            .map_err(|error| format!("New workspace item {:?}: {error}", item.id))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use serde_json::{json, Value};

    use crate::app_error::AppErrorCode;
    use crate::commands::host_plugins::apply_core;
    use crate::host_plugins::{source::Registry, HostPlugins, Manifest, Mutation, CATALOG_CHANGED};
    use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

    fn manifest(items: Value) -> Value {
        json!({
            "apiVersion": 2,
            "id": "sample.plugin",
            "name": "Sample Plugin",
            "version": "1.0.0",
            "server": {"entry": "plugin.mjs", "methods": ["options", "search", "change", "action"]},
            "contributes": {"newWorkspaceItems": items}
        })
    }

    fn item(id: &str, control: Value) -> Value {
        json!({"id": id, "title": "Sample item", "control": control})
    }

    fn check_control(control: Value, valid: bool) {
        let manifest = manifest(json!([item("sample", control.clone())]));
        assert_eq!(
            Manifest::parse(&manifest.to_string()).is_ok(),
            valid,
            "{control}"
        );
    }

    #[test]
    fn all_controls_round_trip_with_optional_targets_and_null_patch_fields() {
        let items = json!([
            {
                "id": "lookup",
                "title": "Find an issue",
                "titleTranslations": {"es": "Busca una incidencia"},
                "description": "Use this issue for the workspace",
                "descriptionTranslations": {"zh-CN": "为此工作区选择工单"},
                "control": {
                    "kind": "combobox",
                    "searchMethod": "search",
                    "placeholder": "Find an issue",
                    "placeholderTranslations": {"zh-CN": "查找工单"}
                }
            },
            {
                "id": "mode",
                "title": "Mode",
                "target": "workspace",
                "control": {
                    "kind": "select",
                    "options": [
                        {
                            "id": "issue",
                            "label": "An issue",
                            "labelTranslations": {"es": "Una incidencia"},
                            "description": "Attach an issue",
                            "descriptionTranslations": {"es": "Adjunta una incidencia"},
                            "patch": {
                                "branch": "issue/demo-12",
                                "baseRef": "origin/main",
                                "rootPath": "/tmp/my workspace",
                                "metadata": {"issues.id": "DEMO-12", "rank": 1, "cost": 1.5, "draft": true}
                            }
                        },
                        {"id": "none", "label": "None", "patch": {"branch": null, "metadata": {"issues.id": null}}}
                    ]
                }
            },
            {
                "id": "dynamic-mode",
                "title": "Dynamic mode",
                "target": "worktree",
                "control": {"kind": "select", "optionsMethod": "options"}
            },
            {
                "id": "draft",
                "title": "Draft",
                "control": {
                    "kind": "toggle",
                    "defaultValue": true,
                    "onChangeMethod": "change",
                    "enabledPatch": {"metadata": {"draft": true}},
                    "disabledPatch": {"baseRef": null, "rootPath": null}
                }
            },
            item("apply", json!({"kind": "action", "method": "action"}))
        ]);
        let mut input = manifest(items.clone());
        input["contributes"]["newWorkspaceItems"][0]["target"] = json!("all");
        let parsed = Manifest::parse(&input.to_string()).unwrap();
        let output = serde_json::to_value(&parsed).unwrap();
        assert_eq!(output["contributes"]["newWorkspaceItems"], items);
        assert_eq!(Manifest::parse(&output.to_string()).unwrap(), parsed);
    }

    #[test]
    fn absent_and_empty_contributions_serialize_the_same() {
        let mut input = manifest(json!([]));
        let empty = Manifest::parse(&input.to_string()).unwrap();
        input["contributes"]
            .as_object_mut()
            .unwrap()
            .remove("newWorkspaceItems");
        assert_eq!(Manifest::parse(&input.to_string()).unwrap(), empty);
        assert!(serde_json::to_value(empty).unwrap()["contributes"]
            .get("newWorkspaceItems")
            .is_none());
    }

    #[test]
    fn validates_contribution_count_ids_and_titles() {
        let items: Vec<_> = (0..17)
            .map(|index| {
                item(
                    &format!("item-{index}"),
                    json!({"kind": "action", "method": "action"}),
                )
            })
            .collect();
        assert!(Manifest::parse(&manifest(json!(items[..16])).to_string()).is_ok());
        assert!(Manifest::parse(&manifest(json!(items)).to_string()).is_err());
        assert!(Manifest::parse(&manifest(json!([items[0], items[0]])).to_string()).is_err());
        for (key, value) in [
            ("id", json!("Invalid id")),
            ("title", json!("   ")),
            ("titleTranslations", json!({"es": ""})),
            ("titleTranslations", json!({"zh_CN": "翻译"})),
            ("descriptionTranslations", json!({"es": "Descripción"})),
            ("description", json!("")),
            ("target", json!("session")),
            ("extra", json!(true)),
        ] {
            let mut invalid = items[0].clone();
            invalid[key] = value;
            assert!(
                Manifest::parse(&manifest(json!([invalid])).to_string()).is_err(),
                "accepted {key}"
            );
        }
    }

    #[test]
    fn static_items_work_without_a_server_and_dynamic_methods_require_the_local_server() {
        let mut input = manifest(json!([item(
            "draft",
            json!({"kind": "toggle", "disabledPatch": {"branch": null}}),
        )]));
        input["apiVersion"] = json!(1);
        input.as_object_mut().unwrap().remove("server");
        assert!(Manifest::parse(&input.to_string()).is_ok());

        for control in [
            json!({"kind": "combobox", "searchMethod": "external"}),
            json!({"kind": "select", "optionsMethod": "external"}),
            json!({"kind": "toggle", "onChangeMethod": "external", "enabledPatch": {"branch": "draft"}}),
            json!({"kind": "action", "method": "external"}),
            json!({"kind": "action", "method": ""}),
        ] {
            check_control(control.clone(), false);
            input["contributes"]["newWorkspaceItems"][0]["control"] = control;
            assert!(Manifest::parse(&input.to_string()).is_err());
        }
        let mut other_plugin = manifest(json!([item(
            "apply",
            json!({"kind": "action", "method": "external"}),
        )]));
        other_plugin["id"] = json!("other.plugin");
        other_plugin["server"]["methods"] = json!(["external"]);
        assert!(Manifest::parse(&other_plugin.to_string()).is_ok());
    }

    #[test]
    fn rejects_ambiguous_empty_or_invalid_controls_and_options() {
        let option = json!({"id": "one", "label": "One"});
        let options: Vec<_> = (0..33)
            .map(|index| json!({"id": format!("option-{index}"), "label": "Option"}))
            .collect();
        check_control(json!({"kind": "select", "options": options[..32]}), true);
        for control in [
            json!({"kind": "select", "optionsMethod": "options", "options": [option]}),
            json!({"kind": "select", "optionsMethod": "options", "options": null}),
            json!({"kind": "select", "options": [option], "optionsMethod": null}),
            json!({"kind": "select"}),
            json!({"kind": "select", "options": []}),
            json!({"kind": "select", "options": options}),
            json!({"kind": "select", "options": [option, option]}),
            json!({"kind": "select", "options": [{"id": "One", "label": "One"}]}),
            json!({"kind": "select", "options": [{"id": "one", "label": " ", "labelTranslations": {"es": "Uno"}}]}),
            json!({"kind": "select", "options": [{"id": "one", "label": "One", "descriptionTranslations": {"es": "Uno"}}]}),
            json!({"kind": "select", "options": [{"id": "one", "label": "One", "extra": false}]}),
            json!({"kind": "select", "optionsMethod": "options", "placeholderTranslations": {"es": "Elige"}}),
            json!({"kind": "combobox", "searchMethod": "search", "placeholder": ""}),
            json!({"kind": "toggle", "defaultValue": true}),
            json!({"kind": "toggle", "enabledPatch": {"metadata": {}}, "disabledPatch": {}}),
            json!({"kind": "toggle", "defaultValue": "true", "onChangeMethod": "change"}),
            json!({"kind": "action", "method": "action", "searchMethod": "search"}),
            json!({"kind": "checkbox"}),
        ] {
            check_control(control, false);
        }
    }

    #[test]
    fn checks_patch_shape_ref_and_path_byte_limits() {
        let check = |patch, valid| {
            check_control(json!({"kind": "toggle", "enabledPatch": patch}), valid);
        };
        check(
            json!({"branch": "é".repeat(128), "baseRef": "HEAD", "rootPath": "é".repeat(512)}),
            true,
        );
        for patch in [
            json!({"branch": "é".repeat(129)}),
            json!({"branch": " "}),
            json!({"branch": "a\nb"}),
            json!({"branch": "a..b"}),
            json!({"branch": "-option"}),
            json!({"branch": "feature//demo"}),
            json!({"branch": "feature/.demo"}),
            json!({"branch": "feature/demo.lock"}),
            json!({"branch": "HEAD@{1}"}),
            json!({"baseRef": "é".repeat(129)}),
            json!({"baseRef": "upstream\0main"}),
            json!({"baseRef": "../main"}),
            json!({"rootPath": "é".repeat(513)}),
            json!({"rootPath": " "}),
            json!({"rootPath": "/tmp/one\u{2028}two"}),
            json!({"rootPath": "/tmp/one\ttwo"}),
            json!({"rootPath": false}),
            json!({"folderPath": "/tmp/demo"}),
        ] {
            check(patch, false);
        }
        check_control(
            json!({"kind": "select", "options": [{"id": "bad", "label": "Bad", "patch": {"branch": ".."}}]}),
            false,
        );
    }

    #[test]
    fn checks_metadata_types_keys_and_json_size() {
        let check = |metadata, valid| {
            check_control(
                json!({"kind": "toggle", "disabledPatch": {"metadata": metadata}}),
                valid,
            );
        };
        check(json!({"Issues.demo-12_id": "é".repeat(256)}), true);
        let entries = |count, size| {
            (0..count)
                .map(|index| (format!("key-{index}"), json!("a".repeat(size))))
                .collect::<serde_json::Map<_, _>>()
        };
        check(json!(entries(16, 1)), true);
        check(json!(entries(17, 1)), false);
        check(json!(entries(8, 512)), false);
        for metadata in [
            json!({"id": "é".repeat(257)}),
            json!({"id": "demo\u{007f}"}),
            json!({"id": {}}),
            json!({"id": []}),
            json!({"": 1}),
            json!({"encoded/key": 1}),
            json!({"工单": 1}),
            json!({"x".repeat(65): 1}),
            json!(null),
        ] {
            check(metadata, false);
        }
    }

    #[tokio::test]
    async fn example_search_uses_host_settings_and_is_withdrawn_on_disable_and_remove() {
        let data = tempfile::tempdir().unwrap();
        let host = Arc::new(HostPlugins::new(data.path()));
        let example =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/new-workspace-issues");
        let id = "codeg.new-workspace-issues";
        let preview = host
            .preview_install(example.to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        let manifest = serde_json::to_value(&preview.manifest).unwrap();
        let source: Value = serde_json::from_str(include_str!(
            "../../../examples/plugins/new-workspace-issues/codeg-plugin.json"
        ))
        .unwrap();
        assert_eq!(
            manifest["contributes"]["newWorkspaceItems"],
            source["contributes"]["newWorkspaceItems"]
        );
        assert!(!host.confirm_install(preview.ticket).unwrap()[0].enabled);
        let set_enabled = |enabled| Mutation::SetEnabled {
            id: id.into(),
            enabled,
        };
        let request = json!({
            "itemId": "issue",
            "target": "worktree",
            "query": "demo-12",
            "locale": "zh-CN"
        });
        // Both host_plugins_call transports delegate to this method.
        let search = |input| host.call(id, "search-issues".into(), input);
        assert!(matches!(
            search(request.clone()).await.unwrap_err().code,
            AppErrorCode::NotFound
        ));

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let catalog = apply_core(&host, &emitter, set_enabled(true))
            .await
            .unwrap();
        assert!(catalog[0].enabled);
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);
        assert_eq!(
            search(request.clone()).await.unwrap(),
            json!({"items": [{
                "id": "demo-12",
                "label": "DEMO-12 · 改进工作区搜索",
                "patch": {
                    "branch": "issue/demo-12-workspace-search",
                    "metadata": {"issues.id": "DEMO-12"}
                }
            }]})
        );
        let settings = host.settings(id).unwrap();
        host.save_settings(id, settings.revision, json!({"branchPrefix": "work"}))
            .unwrap();
        assert_eq!(
            search(request.clone()).await.unwrap()["items"][0]["patch"]["branch"],
            "work/demo-12-workspace-search"
        );
        let mut invalid_request = request.clone();
        invalid_request["target"] = json!("all");
        assert!(search(invalid_request).await.is_err());

        let catalog = apply_core(&host, &emitter, set_enabled(false))
            .await
            .unwrap();
        assert!(!catalog[0].enabled);
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);
        assert!(matches!(
            search(request.clone()).await.unwrap_err().code,
            AppErrorCode::NotFound
        ));
        let catalog = apply_core(&host, &emitter, Mutation::Remove { id: id.into() })
            .await
            .unwrap();
        assert!(catalog.is_empty());
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);
        assert!(matches!(
            search(request).await.unwrap_err().code,
            AppErrorCode::NotFound
        ));
    }
}
