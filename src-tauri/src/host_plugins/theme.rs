use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::{valid_id, valid_label, valid_translations, Translations, MAX_CONTRIBUTIONS};

type Palette = BTreeMap<String, String>;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Theme {
    id: String,
    title: String,
    #[serde(default, skip_serializing_if = "Translations::is_empty")]
    title_translations: Translations,
    #[serde(default, skip_serializing_if = "Palette::is_empty")]
    light: Palette,
    #[serde(default, skip_serializing_if = "Palette::is_empty")]
    dark: Palette,
}

pub(super) fn validate(themes: &[Theme]) -> Result<(), String> {
    if themes.len() > MAX_CONTRIBUTIONS {
        return Err("Provide up to 16 plugin themes".into());
    }
    let mut ids = BTreeSet::new();
    for theme in themes {
        if !valid_id(&theme.id)
            || !valid_label(&theme.title)
            || !valid_translations(&theme.title_translations, valid_label)
            || !ids.insert(&theme.id)
        {
            return Err("Plugin themes need unique IDs and valid titles".into());
        }
        if theme.light.is_empty() && theme.dark.is_empty() {
            return Err(format!(
                "Plugin theme {} needs a light or dark palette",
                theme.id
            ));
        }
        for (token, value) in theme.light.iter().chain(&theme.dark) {
            if !valid_token(token) || !valid_color(value) {
                return Err(format!(
                    "Plugin theme {} must use a Codeg color token and a #RRGGBB value",
                    theme.id
                ));
            }
        }
    }
    Ok(())
}

// Align the color keys with CUSTOM_THEME_TOKENS in src/lib/custom-style.ts.
fn valid_token(token: &str) -> bool {
    matches!(
        token,
        "background"
            | "foreground"
            | "primary"
            | "primary-foreground"
            | "accent"
            | "accent-foreground"
            | "border"
            | "card"
            | "card-foreground"
            | "popover"
            | "popover-foreground"
            | "secondary"
            | "secondary-foreground"
            | "muted"
            | "muted-foreground"
            | "destructive"
            | "input"
            | "ring"
            | "chart-1"
            | "chart-2"
            | "chart-3"
            | "chart-4"
            | "chart-5"
            | "sidebar"
            | "sidebar-foreground"
            | "sidebar-primary"
            | "sidebar-primary-foreground"
            | "sidebar-accent"
            | "sidebar-accent-foreground"
            | "sidebar-border"
            | "sidebar-ring"
    )
}

fn valid_color(value: &str) -> bool {
    value
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.as_bytes().iter().all(u8::is_ascii_hexdigit))
}

#[cfg(test)]
mod tests {
    use crate::host_plugins::{HostPlugins, Manifest, Mutation};
    use serde_json::{json, Value};

    const SAMPLE: &str = include_str!("../../../examples/plugins/juniper-theme/codeg-plugin.json");

    #[test]
    fn installs_and_reopens_a_declarative_theme_only_catalog_entry() {
        let directory = tempfile::tempdir().unwrap();
        let host = HostPlugins::new(directory.path());
        host.apply(Mutation::Install {
            manifest: SAMPLE.to_owned(),
        })
        .unwrap();
        let reopened = HostPlugins::new(directory.path()).list().unwrap();
        let installed = serde_json::to_value(&reopened[0]).unwrap();
        let source: Value = serde_json::from_str(SAMPLE).unwrap();
        assert_eq!(
            installed["manifest"]["contributes"]["themes"],
            source["contributes"]["themes"]
        );
        assert_eq!(installed["enabled"], false);
    }

    #[test]
    fn rejects_unknown_tokens_invalid_colors_and_duplicate_or_empty_themes() {
        let valid: Value = serde_json::from_str(SAMPLE).unwrap();
        let original = &valid["contributes"]["themes"][0];
        for themes in [
            json!([{"id": "empty", "title": "Empty"}]),
            json!([{"id": "token", "title": "Unknown token", "light": {"radius": "#ffffff"}}]),
            json!([{"id": "color", "title": "Invalid color", "dark": {"foreground": "url(theme.svg)"}}]),
            json!([original, original]),
        ] {
            let mut manifest = valid.clone();
            manifest["contributes"]["themes"] = themes;
            assert!(Manifest::parse(&manifest.to_string()).is_err());
        }
    }
}
