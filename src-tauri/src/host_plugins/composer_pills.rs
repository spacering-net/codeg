use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use super::{valid_id, valid_label, valid_translations, Manifest, Translations, MAX_CONTRIBUTIONS};

const MAX_INPUT_ACTIVITIES: usize = 8;
const MAX_INSERT_BYTES: usize = 16 * 1024;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", try_from = "String")]
enum ContributionScope {
    Draft,
    Session,
    #[default]
    All,
}

impl TryFrom<String> for ContributionScope {
    type Error = &'static str;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        match value.as_str() {
            "draft" => Ok(Self::Draft),
            "session" => Ok(Self::Session),
            "all" => Ok(Self::All),
            _ => Err("scope must be draft, session or all"),
        }
    }
}

impl ContributionScope {
    fn session() -> Self {
        Self::Session
    }

    fn is_session(&self) -> bool {
        *self == Self::Session
    }

    fn is_all(&self) -> bool {
        *self == Self::All
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ComposerPill {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    label: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    label_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
    #[serde(default, skip_serializing_if = "ContributionScope::is_all")]
    scope: ContributionScope,
    action: PillAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct SessionAction {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    description_translations: Translations,
    #[serde(
        default = "ContributionScope::session",
        skip_serializing_if = "ContributionScope::is_session"
    )]
    scope: ContributionScope,
    action: LeafAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct InputActivity {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    method: String,
    #[serde(default, skip_serializing_if = "ContributionScope::is_all")]
    scope: ContributionScope,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(untagged)]
enum PillAction {
    Menu(MenuAction),
    Leaf(LeafAction),
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum MenuAction {
    Menu { items: Vec<MenuItem> },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MenuItem {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    action: LeafAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum LeafAction {
    OpenWorkspacePanel {
        panel_id: String,
    },
    OpenClientSurface {
        surface_id: String,
    },
    OpenScreen {
        screen_id: String,
    },
    CallMethod {
        method: String,
    },
    InsertText {
        text: String,
        #[serde(default, skip_serializing_if = "Translations::is_empty")]
        text_translations: Translations,
    },
}

fn valid_insert_text(text: &str) -> bool {
    // A CRLF pair loses one byte. A bare CR becomes a one-byte LF.
    let normalized_len = text.len() - text.matches("\r\n").count();
    normalized_len > 0 && normalized_len <= MAX_INSERT_BYTES && !text.contains('\0')
}

fn valid_optional_label(value: Option<&str>, translations: &Translations) -> bool {
    match value {
        Some(value) => valid_label(value) && valid_translations(translations, valid_label),
        None => translations.is_empty(),
    }
}

fn validate_item<'a>(
    ids: &mut BTreeSet<&'a str>,
    id: &'a str,
    title: &str,
    translations: &Translations,
) -> Result<(), &'static str> {
    if !valid_id(id)
        || !ids.insert(id)
        || !valid_label(title)
        || !valid_translations(translations, valid_label)
    {
        return Err("invalid or duplicate ID, title or title translations");
    }
    Ok(())
}

fn validate_method(manifest: &Manifest, method: &str) -> Result<(), &'static str> {
    if manifest
        .server
        .as_ref()
        .is_some_and(|server| server.methods.iter().any(|declared| declared == method))
    {
        Ok(())
    } else {
        Err("method must be declared in this plugin's server.methods")
    }
}

impl LeafAction {
    fn validate(&self, manifest: &Manifest) -> Result<(), &'static str> {
        let contributes = &manifest.contributes;
        match self {
            Self::OpenWorkspacePanel { panel_id } => {
                if !contributes
                    .workspace_panels
                    .iter()
                    .any(|panel| panel.id == *panel_id)
                {
                    return Err("panelId must name a workspace panel in this plugin");
                }
            }
            Self::OpenClientSurface { surface_id } => {
                if !contributes
                    .client_surfaces
                    .iter()
                    .any(|surface| surface.id == *surface_id)
                {
                    return Err("surfaceId must name a client surface in this plugin");
                }
            }
            Self::OpenScreen { screen_id } => {
                if !contributes
                    .screens
                    .iter()
                    .any(|screen| screen.id == *screen_id)
                {
                    return Err("screenId must name a screen in this plugin");
                }
            }
            Self::CallMethod { method } => validate_method(manifest, method)?,
            Self::InsertText {
                text,
                text_translations,
            } => {
                if !valid_insert_text(text)
                    || !valid_translations(text_translations, valid_insert_text)
                {
                    return Err("insertText requires nonempty NUL-free text of up to 16 KiB after line ending normalization");
                }
            }
        }
        Ok(())
    }
}

impl PillAction {
    fn validate(&self, manifest: &Manifest) -> Result<(), String> {
        match self {
            Self::Leaf(leaf) => leaf.validate(manifest).map_err(str::to_owned),
            Self::Menu(MenuAction::Menu { items }) => {
                if items.is_empty() || items.len() > MAX_CONTRIBUTIONS {
                    return Err("menu requires 1 to 16 items".to_owned());
                }
                let mut ids = BTreeSet::new();
                for item in items {
                    validate_item(&mut ids, &item.id, &item.title, &item.title_translations)
                        .and_then(|()| item.action.validate(manifest))
                        .map_err(|error| format!("menu item {:?}: {error}", item.id))?;
                }
                Ok(())
            }
        }
    }
}

pub(super) fn validate(manifest: &Manifest) -> Result<(), String> {
    let contributes = &manifest.contributes;
    if contributes.composer_pills.len() > MAX_CONTRIBUTIONS
        || contributes.session_actions.len() > MAX_CONTRIBUTIONS
        || contributes.input_activities.len() > MAX_INPUT_ACTIVITIES
    {
        return Err(
            "Provide up to 16 composer pills, 16 session actions and 8 input activities".to_owned(),
        );
    }

    let mut ids = BTreeSet::new();
    for pill in &contributes.composer_pills {
        let error = |error: &str| format!("Composer pill {:?}: {error}", pill.id);
        validate_item(&mut ids, &pill.id, &pill.title, &pill.title_translations).map_err(error)?;
        if !valid_optional_label(pill.label.as_deref(), &pill.label_translations)
            || !valid_optional_label(pill.description.as_deref(), &pill.description_translations)
        {
            return Err(error(
                "invalid label or description, or missing translation fallback",
            ));
        }
        pill.action
            .validate(manifest)
            .map_err(|message| error(&message))?;
    }

    let mut ids = BTreeSet::new();
    for action in &contributes.session_actions {
        let error = |error: &str| format!("Session action {:?}: {error}", action.id);
        validate_item(
            &mut ids,
            &action.id,
            &action.title,
            &action.title_translations,
        )
        .map_err(error)?;
        if !valid_optional_label(
            action.description.as_deref(),
            &action.description_translations,
        ) {
            return Err(error("invalid description or missing translation fallback"));
        }
        action.action.validate(manifest).map_err(error)?;
    }

    let mut ids = BTreeSet::new();
    for activity in &contributes.input_activities {
        validate_item(
            &mut ids,
            &activity.id,
            &activity.title,
            &activity.title_translations,
        )
        .and_then(|()| validate_method(manifest, &activity.method))
        .map_err(|error| format!("Input activity {:?}: {error}", activity.id))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use serde_json::{json, Value};

    use super::MAX_INSERT_BYTES;
    use crate::app_error::AppErrorCode;
    use crate::commands::host_plugins::apply_core;
    use crate::host_plugins::{source::Registry, HostPlugins, Manifest, Mutation, CATALOG_CHANGED};
    use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};

    fn bundled_manifest() -> Value {
        json!({
            "apiVersion": 2,
            "id": "sample.composer",
            "name": "Sample Composer",
            "version": "1.0.0",
            "server": {"entry": "sample.mjs", "methods": ["describe"]},
            "client": {"entry": "sample.html"},
            "contributes": {
                "workspacePanels": [{"id": "notes", "title": "Notes", "view": "text", "text": "Sample notes"}],
                "clientSurfaces": [{"id": "tools", "title": "Tools", "slot": "composer"}],
                "screens": [{"id": "overview", "title": "Overview"}]
            }
        })
    }

    fn item(id: &str, action: Value) -> Value {
        json!({"id": id, "title": "Sample item", "action": action})
    }

    fn insert(text: impl AsRef<str>) -> Value {
        json!({"kind": "insertText", "text": text.as_ref()})
    }

    fn activity(id: &str) -> Value {
        json!({"id": id, "title": "Sample activity", "method": "describe"})
    }

    fn check_contribution(key: &str, items: Value, valid: bool) {
        let mut manifest = bundled_manifest();
        manifest["contributes"][key] = items;
        assert_eq!(
            Manifest::parse(&manifest.to_string()).is_ok(),
            valid,
            "{key}"
        );
    }

    #[test]
    fn leaf_actions_and_menus_round_trip_with_localization_and_scope_defaults() {
        let mut manifest = bundled_manifest();
        let menu = json!({
            "kind": "menu",
            "items": [
                item("panel", json!({"kind": "openWorkspacePanel", "panelId": "notes"})),
                item("surface", json!({"kind": "openClientSurface", "surfaceId": "tools"})),
                item("screen", json!({"kind": "openScreen", "screenId": "overview"})),
                item("describe", json!({"kind": "callMethod", "method": "describe"})),
                {
                    "id": "insert",
                    "title": "Insert",
                    "titleTranslations": {"es": "Insertar"},
                    "action": {"kind": "insertText", "text": "Review\r\n", "textTranslations": {"zh-CN": "审查"}}
                }
            ]
        });
        manifest["contributes"]["composerPills"] = json!([{
            "id": "review",
            "title": "Review tools",
            "titleTranslations": {"zh-CN": "审查工具"},
            "label": "Review",
            "labelTranslations": {"es": "Revisar"},
            "description": "Review the draft",
            "descriptionTranslations": {"zh-CN": "审查草稿"},
            "scope": "all",
            "action": menu
        }]);
        manifest["contributes"]["sessionActions"] = json!([
            {"id": "review", "title": "Review", "scope": "session", "action": insert("Review")},
            {"id": "draft", "title": "Review draft", "scope": "draft", "action": insert("Review")}
        ]);
        manifest["contributes"]["inputActivities"] = json!([
            {"id": "review", "title": "Review", "scope": "all", "method": "describe"},
            {"id": "session", "title": "Session", "scope": "session", "method": "describe"}
        ]);
        let parsed = Manifest::parse(&manifest.to_string()).unwrap();
        let result = serde_json::to_value(&parsed).unwrap();
        for key in ["composerPills", "sessionActions", "inputActivities"] {
            manifest["contributes"][key][0]
                .as_object_mut()
                .unwrap()
                .remove("scope");
            assert_eq!(
                result["contributes"][key], manifest["contributes"][key],
                "{key}"
            );
        }
        assert_eq!(Manifest::parse(&result.to_string()).unwrap(), parsed);
    }

    #[test]
    fn legacy_manifest_round_trips_without_empty_arrays() {
        let source = include_str!("../../../examples/plugins/turn-activity/codeg-plugin.json");
        let legacy = Manifest::parse(source).unwrap();
        let mut value: Value = serde_json::from_str(source).unwrap();
        let output = serde_json::to_value(&legacy).unwrap();
        assert_eq!(output, value);
        for key in ["composerPills", "sessionActions", "inputActivities"] {
            value["contributes"][key] = json!([]);
        }
        assert_eq!(Manifest::parse(&value.to_string()).unwrap(), legacy);
    }

    #[test]
    fn static_pills_and_actions_install_as_api_v1_but_methods_need_a_server() {
        let mut value = json!({
            "apiVersion": 1,
            "id": "sample.static",
            "name": "Static Composer",
            "version": "1.0.0",
            "contributes": {
                "composerPills": [item("insert", insert("Review"))],
                "sessionActions": [item("review", insert("Review this session"))]
            }
        });
        let data = tempfile::tempdir().unwrap();
        let plugins = HostPlugins::new(data.path());
        assert!(plugins
            .apply(Mutation::Install {
                manifest: value.to_string()
            })
            .is_ok());
        value["contributes"]["workspacePanels"] = json!([
            {"id": "notes", "title": "Notes", "view": "text", "text": "Sample notes"}
        ]);
        value["contributes"]["composerPills"][0]["action"] =
            json!({"kind": "openWorkspacePanel", "panelId": "notes"});
        assert!(Manifest::parse(&value.to_string()).is_ok());
        value["contributes"]["inputActivities"] = json!([activity("review")]);
        assert!(Manifest::parse(&value.to_string()).is_err());
        value["contributes"]["inputActivities"] = json!([]);
        value["contributes"]["composerPills"][0]["action"] =
            json!({"kind": "callMethod", "method": "describe"});
        assert!(Manifest::parse(&value.to_string()).is_err());
    }

    #[test]
    fn enforces_registration_limits_and_unique_ids() {
        for (key, count) in [
            ("composerPills", 16),
            ("sessionActions", 16),
            ("inputActivities", 8),
        ] {
            let entries: Vec<_> = (0..=count)
                .map(|index| {
                    let id = format!("entry-{index}");
                    if key == "inputActivities" {
                        activity(&id)
                    } else {
                        item(&id, insert("Review"))
                    }
                })
                .collect();
            check_contribution(key, json!(entries[..count]), true);
            check_contribution(key, json!([entries[0], entries[0]]), false);
            check_contribution(key, json!(entries), false);
        }
    }

    #[test]
    fn rejects_nested_oversized_and_malformed_menus() {
        let entries: Vec<_> = (0..17)
            .map(|index| item(&format!("entry-{index}"), insert("Review")))
            .collect();
        let check = |items, valid| {
            check_contribution(
                "composerPills",
                json!([item("menu", json!({"kind": "menu", "items": items}))]),
                valid,
            );
        };
        check(json!(entries[..16]), true);
        check(json!(entries), false);
        check(json!([]), false);
        check(json!([entries[0], entries[0]]), false);
        check(json!([item("Invalid id", insert("Review"))]), false);
        check(
            json!([{"id": "entry", "title": " ", "action": insert("Review")}]),
            false,
        );
        check(
            json!([{"id": "entry", "title": "Entry", "extra": true, "action": insert("Review")}]),
            false,
        );
        let menu = json!({"kind": "menu", "items": [entries[0]]});
        check(json!([item("nested", menu.clone())]), false);
        check_contribution("sessionActions", json!([item("menu", menu)]), false);
        check_contribution(
            "composerPills",
            json!([item(
                "menu",
                json!({"kind": "menu", "items": [entries[0]], "extra": true})
            )]),
            false,
        );
        check_contribution(
            "composerPills",
            json!([item(
                "menu",
                json!({"kind": {"menu": null}, "items": [entries[0]]})
            )]),
            false,
        );
    }

    #[test]
    fn rejects_unknown_fields_bad_localization_and_invalid_scopes() {
        for (key, value) in [
            ("id", json!("Bad id")),
            ("title", json!("")),
            ("titleTranslations", json!({"zh_CN": "翻译"})),
            ("descriptionTranslations", json!({"es": "Descripción"})),
            ("labelTranslations", json!({"es": "Etiqueta"})),
            ("description", json!(" ")),
            ("label", json!("\t")),
            ("scope", json!("workspace")),
            ("scope", json!({"all": null})),
            ("extra", json!(true)),
            ("action", json!({"kind": "launch"})),
            (
                "action",
                json!({"kind": "insertText", "text": "Review", "extra": false}),
            ),
        ] {
            let mut pill = item("sample", insert("Review"));
            pill[key] = value;
            check_contribution("composerPills", json!([pill]), false);
        }
        let mut action = item("sample", insert("Review"));
        action["descriptionTranslations"] = json!({"es": "Descripción"});
        check_contribution("sessionActions", json!([action]), false);
        let mut input = activity("sample");
        input["titleTranslations"] = json!({"es": ""});
        check_contribution("inputActivities", json!([input]), false);
    }

    #[test]
    fn navigation_targets_and_methods_must_belong_to_the_plugin() {
        let mut other = bundled_manifest();
        other["id"] = json!("other.plugin");
        other["server"]["methods"] = json!(["external"]);
        other["contributes"]["workspacePanels"][0]["id"] = json!("external");
        other["contributes"]["clientSurfaces"][0]["id"] = json!("external");
        other["contributes"]["screens"][0]["id"] = json!("external");
        assert!(Manifest::parse(&other.to_string()).is_ok());

        for action in [
            json!({"kind": "openWorkspacePanel", "panelId": "external"}),
            json!({"kind": "openClientSurface", "surfaceId": "external"}),
            json!({"kind": "openScreen", "screenId": "external"}),
            json!({"kind": "callMethod", "method": "external"}),
            json!({"kind": "callMethod", "method": ""}),
        ] {
            check_contribution(
                "composerPills",
                json!([item("sample", action.clone())]),
                false,
            );
            check_contribution("sessionActions", json!([item("sample", action)]), false);
        }
        let mut input = activity("sample");
        input["method"] = json!("external");
        check_contribution("inputActivities", json!([input]), false);
    }

    #[test]
    fn insertion_limits_apply_to_translations_and_normalized_utf8() {
        let exact = format!("{}a\r\n", "é".repeat((MAX_INSERT_BYTES - 2) / 2));
        let check = |action, valid| {
            check_contribution("sessionActions", json!([item("sample", action)]), valid);
        };
        check(insert(&exact), true);
        check(insert(format!("{exact}a")), false);
        check(insert(""), false);
        check(insert("prefix\0suffix"), false);
        check(insert("\r"), true);
        for text in [String::new(), "示例\0".to_owned(), format!("{exact}a")] {
            check(
                json!({"kind": "insertText", "text": "Review", "textTranslations": {"zh-CN": text}}),
                false,
            );
        }
        check(
            json!({"kind": "insertText", "textTranslations": {"zh-CN": "审查"}}),
            false,
        );
    }

    #[tokio::test]
    async fn example_calls_and_catalog_withdrawal_use_the_shared_host() {
        let data = tempfile::tempdir().unwrap();
        let host = Arc::new(HostPlugins::new(data.path()));
        let example =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../examples/plugins/composer-pills");
        let id = "codeg.composer-pills";
        let preview = host
            .preview_install(example.to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        let reviewed = serde_json::to_value(&preview.manifest).unwrap();
        let source: Value = serde_json::from_str(include_str!(
            "../../../examples/plugins/composer-pills/codeg-plugin.json"
        ))
        .unwrap();
        for key in ["composerPills", "sessionActions", "inputActivities"] {
            assert_eq!(
                reviewed["contributes"][key], source["contributes"][key],
                "{key}"
            );
        }
        assert!(!host.confirm_install(preview.ticket).unwrap()[0].enabled);

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster);
        let enabled = |enabled| Mutation::SetEnabled {
            id: id.into(),
            enabled,
        };
        let catalog = apply_core(&host, &emitter, enabled(true)).await.unwrap();
        assert!(catalog[0].enabled);
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);

        // The desktop command and server route both delegate to HostPlugins::call.
        let call = |method: &str, input| host.call(id, method.to_owned(), input);
        let pill = json!({
            "source": "composerPill", "itemId": "review-menu", "menuItemId": "checklist",
            "scope": "draft", "folderId": 12, "conversationId": null, "locale": "es"
        });
        assert_eq!(
            call("review-checklist", pill.clone()).await.unwrap(),
            json!({"insertText": "- [ ] Revisar los cambios\n- [ ] Ejecutar las pruebas pertinentes"})
        );
        let session = json!({
            "source": "sessionAction", "itemId": "review-session", "scope": "session",
            "folderId": 12, "conversationId": 34, "locale": "zh-CN"
        });
        assert_eq!(
            call("review-checklist", session.clone()).await.unwrap(),
            json!({"insertText": "- [ ] 审查改动\n- [ ] 运行相关测试", "notice": "已将审查清单插入草稿。"})
        );
        let activity = json!({
            "activityId": "review-available", "scope": "session",
            "folderId": 12, "conversationId": 34, "locale": "en"
        });
        assert_eq!(
            call("review-status", activity.clone()).await.unwrap(),
            json!({"visible": true, "tone": "muted", "title": "Review checklist available", "detail": "Use Review tools to add it to your draft."})
        );
        let mut unavailable_activity = activity.clone();
        unavailable_activity["folderId"] = Value::Null;
        assert_eq!(
            call("review-status", unavailable_activity).await.unwrap(),
            Value::Null
        );
        let mut invalid_activity = activity.clone();
        invalid_activity["scope"] = json!("all");
        assert!(matches!(
            call("review-status", invalid_activity)
                .await
                .unwrap_err()
                .code,
            AppErrorCode::InvalidInput
        ));

        let catalog = apply_core(&host, &emitter, enabled(false)).await.unwrap();
        assert!(!catalog[0].enabled);
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);
        for (method, input) in [
            ("review-checklist", pill),
            ("review-checklist", session),
            ("review-status", activity),
        ] {
            assert!(matches!(
                call(method, input).await.unwrap_err().code,
                AppErrorCode::NotFound
            ));
        }
        let catalog = apply_core(&host, &emitter, Mutation::Remove { id: id.into() })
            .await
            .unwrap();
        assert!(catalog.is_empty());
        assert_eq!(events.try_recv().unwrap().channel, CATALOG_CHANGED);
    }
}
