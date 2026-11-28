use std::collections::{BTreeMap, HashSet};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::acp::custom_registry::{
    self, CustomAgentDef, CustomAgentError, CustomAgentSource, CustomAgentSpec,
    CustomDistributionKind, PluginProviderDef,
};
use crate::acp::registry;
use crate::models::agent::{is_valid_custom_agent_id, BUILTIN_AGENT_TYPES};

use super::{valid_label, Catalog};

const MAX_PROVIDERS: usize = 4;
type Translations = BTreeMap<String, String>;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AcpProvider {
    id: String,
    name: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    name_translations: Translations,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    description_translations: Translations,
    distribution_kind: CustomDistributionKind,
    #[serde(deserialize_with = "deserialize_spec")]
    spec: CustomAgentSpec,
}

impl AcpProvider {
    fn definition(&self, version: &str) -> CustomAgentDef {
        CustomAgentDef {
            registry_id: self.id.clone(),
            name: self.name.clone(),
            description: self.description.clone().unwrap_or_default(),
            // Build metadata is immaterial to the cache directory label.
            version: version.split('+').next().unwrap_or(version).to_owned(),
            distribution_kind: self.distribution_kind,
            spec: self.spec.clone(),
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            // Use the manifest's reviewed package rather than querying for a
            // new upstream release behind the plugin publisher's back.
            source: CustomAgentSource::Manual,
            version_probe: None,
            supports_mcp: true,
        }
    }
}

// Check nested keys here to keep the pasted-registry and stored user-agent
// schemas backward compatible while reviewing a strict plugin launch recipe.
fn deserialize_spec<'de, D>(deserializer: D) -> Result<CustomAgentSpec, D::Error>
where
    D: Deserializer<'de>,
{
    use serde::de::Error;
    let value = Value::deserialize(deserializer)?;
    let check_object = |value: &Value, keys: &[&str]| {
        value
            .as_object()
            .is_some_and(|object| object.keys().all(|key| keys.contains(&key.as_str())))
    };
    let valid = check_object(&value, &["npx", "uvx", "binary"])
        && value.get("npx").is_none_or(|npx| {
            check_object(npx, &["package", "cmd", "args", "env", "node_required"])
        })
        && value.get("uvx").is_none_or(|uvx| {
            check_object(
                uvx,
                &["package", "cmd", "args", "env", "uv_required", "python"],
            )
        })
        && value.get("binary").is_none_or(|binary| {
            binary.as_object().is_some_and(|platforms| {
                platforms.values().all(|entry| {
                    check_object(entry, &["archive", "url", "cmd", "args", "env", "sha256"])
                })
            })
        });
    if !valid {
        return Err(D::Error::custom(
            "Unknown field or invalid object in ACP provider spec",
        ));
    }
    serde_json::from_value(value).map_err(D::Error::custom)
}

pub(super) fn validate(providers: &[AcpProvider], version: &str) -> Result<(), String> {
    if providers.len() > MAX_PROVIDERS {
        return Err("A plugin can contribute at most four ACP providers".into());
    }
    let mut ids = HashSet::new();
    for provider in providers {
        let id = &provider.id;
        if !is_valid_custom_agent_id(id)
            || id.ends_with('.')
            || BUILTIN_AGENT_TYPES.iter().any(|agent| {
                id.eq_ignore_ascii_case(&agent.as_wire())
                    || id.eq_ignore_ascii_case(registry::registry_id_for(*agent))
            })
            || !ids.insert(id.to_ascii_lowercase())
        {
            return Err(format!(
                "Invalid, reserved or duplicate ACP provider id {id:?}"
            ));
        }
        if !valid_label(&provider.name)
            || !valid_translations(&provider.name_translations)
            || provider
                .description
                .as_deref()
                .is_some_and(|value| !valid_label(value))
            || !valid_translations(&provider.description_translations)
            || (provider.description.is_none() && !provider.description_translations.is_empty())
        {
            return Err(format!(
                "ACP provider {id:?} needs valid names and description fallbacks"
            ));
        }
        if !valid_spec(&provider.spec) {
            return Err(format!("ACP provider {id:?} has an invalid launch spec"));
        }
        // Portability is checked when the provider enters a host's runtime
        // registry. A Linux-only manifest can still be reviewed on macOS.
        match custom_registry::validate(&provider.definition(version)) {
            Ok(()) | Err(CustomAgentError::UnsupportedPlatform(_)) => {}
            Err(error) => return Err(format!("ACP provider {id:?}: {error}")),
        }
    }
    Ok(())
}

fn valid_translations(values: &Translations) -> bool {
    values.len() <= 16
        && values.iter().all(|(locale, value)| {
            locale.len() <= 32
                && locale.split('-').all(|part| {
                    !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_alphanumeric())
                })
                && valid_label(value)
        })
}

fn valid_spec(spec: &CustomAgentSpec) -> bool {
    static NPM_SPEC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^(?:@[A-Za-z0-9][A-Za-z0-9._-]*/)?[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9*~^][A-Za-z0-9._+*~^-]*)?$").unwrap()
    });
    static UV_SPEC: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._-]+(?:,[A-Za-z0-9._-]+)*\])?(?:(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+_-]+(?:,(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9.*+_-]+)*)?$").unwrap()
    });
    spec.npx.as_ref().is_none_or(|npx| {
        npx.package.len() <= 256
            && NPM_SPEC.is_match(&npx.package)
            && valid_command(
                npx.cmd
                    .as_deref()
                    .unwrap_or(&custom_registry::derive_command_name(&npx.package)),
            )
            && npx.node_required.as_deref().is_none_or(valid_version_hint)
            && valid_args_and_env(&npx.args, &npx.env)
    }) && spec.uvx.as_ref().is_none_or(|uvx| {
        uvx.package.len() <= 256
            && UV_SPEC.is_match(&uvx.package)
            && valid_command(
                uvx.cmd
                    .as_deref()
                    .unwrap_or(&custom_registry::derive_command_name(&uvx.package)),
            )
            && uvx.uv_required.as_deref().is_none_or(valid_version_hint)
            && uvx.python.as_deref().is_none_or(valid_version_hint)
            && valid_args_and_env(&uvx.args, &uvx.env)
    }) && spec.binary.iter().all(|(platform, binary)| {
        matches!(
            platform.as_str(),
            "darwin-aarch64"
                | "darwin-x86_64"
                | "linux-aarch64"
                | "linux-x86_64"
                | "windows-aarch64"
                | "windows-x86_64"
        ) && binary.archive.len() <= 2048
            && !binary.archive.chars().any(char::is_control)
            && url::Url::parse(&binary.archive).is_ok_and(|url| {
                url.scheme() == "https"
                    && url.host_str().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
            })
            && binary.cmd.len() <= 512
            && !binary.cmd.trim().is_empty()
            && !binary.cmd.chars().any(char::is_control)
            && custom_registry::is_safe_archive_entry(&binary.cmd)
            && binary
                .cmd
                .trim()
                .strip_prefix("./")
                .unwrap_or(binary.cmd.trim())
                .split(['/', '\\'])
                .all(valid_command)
            && binary.sha256.as_deref().is_none_or(|digest| {
                digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
            && valid_args_and_env(&binary.args, &binary.env)
    })
}

fn valid_command(command: &str) -> bool {
    !command.is_empty()
        && command.len() <= 128
        && !command.starts_with(['.', '-'])
        && !command.ends_with('.')
        && command
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn valid_version_hint(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && !version.starts_with('-')
        && version.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'.' | b'-' | b'_' | b'+' | b'<' | b'>' | b'=' | b'~' | b'^' | b','
                )
        })
}

fn valid_args_and_env(args: &[String], env: &BTreeMap<String, String>) -> bool {
    let valid_value = |value: &str| {
        value.len() <= 4096
            && !value.chars().any(char::is_control)
            && !value.split(['/', '\\', '=']).any(|segment| segment == "..")
    };
    args.len() <= 64
        && args.iter().all(|arg| valid_value(arg))
        && env.len() <= 32
        && env.iter().all(|(key, value)| {
            key.len() <= 128
                && key
                    .bytes()
                    .next()
                    .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
                && key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
                && valid_value(value)
        })
}

pub(super) fn adds_or_changes_recipe(old: &[AcpProvider], new: &[AcpProvider]) -> bool {
    new.iter().any(|provider| {
        !old.iter().any(|previous| {
            previous.id == provider.id
                && previous.distribution_kind == provider.distribution_kind
                && previous.spec == provider.spec
        })
    })
}

pub(super) fn publish(catalog: &Catalog) {
    custom_registry::hydrate_plugin_providers(
        catalog
            .values()
            .filter(|plugin| plugin.enabled)
            .flat_map(|plugin| {
                plugin
                    .manifest
                    .contributes
                    .acp_providers
                    .iter()
                    .map(|provider| PluginProviderDef {
                        plugin_id: plugin.manifest.id.clone(),
                        definition: provider.definition(&plugin.manifest.version),
                    })
            })
            .collect(),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::host_plugins::{source::Registry, HostPlugins, Manifest, Mutation};
    use crate::models::AgentType;
    use crate::web::event_bridge::EventEmitter;
    use serde_json::json;

    const EXAMPLE: &str = include_str!("../../../examples/plugins/acp-provider/codeg-plugin.json");
    const EXAMPLE_PLUGIN: &str = "codeg.acp-provider-example";
    const EXAMPLE_ID: &str = "example-claude-adapter";

    fn recipe() -> Value {
        serde_json::from_str::<Value>(EXAMPLE).unwrap()["contributes"]["acpProviders"][0].clone()
    }

    fn with_providers(providers: Vec<Value>) -> String {
        let mut manifest: Value = serde_json::from_str(EXAMPLE).unwrap();
        manifest["contributes"]["acpProviders"] = json!(providers);
        manifest.to_string()
    }

    #[test]
    fn example_and_distribution_branches_round_trip() {
        let example = Manifest::parse(EXAMPLE).unwrap();
        let round_trip = serde_json::to_string(&example).unwrap();
        assert_eq!(Manifest::parse(&round_trip).unwrap(), example);
        assert_eq!(
            example.contributes.acp_providers[0].name_translations.len(),
            2
        );

        let mut uvx = recipe();
        uvx["id"] = json!("example-uvx");
        uvx["distributionKind"] = json!("uvx");
        uvx["spec"] = json!({"uvx": {"package": "fast-agent-acp[extra]>=0.9.24,<1", "cmd": "fast-agent", "python": "3.12", "args": ["--acp"], "env": {"EXAMPLE_VAR": "value"}}});
        let mut binary = recipe();
        binary["id"] = json!("example-binary");
        binary["distributionKind"] = json!("binary");
        binary["spec"] = json!({"binary": {"linux-x86_64": {
            "url": "https://example.com/adapter.tar.gz", "cmd": "./package/adapter", "sha256": "f".repeat(64)
        }}});
        let manifest = Manifest::parse(&with_providers(vec![recipe(), uvx, binary])).unwrap();
        let canonical = serde_json::to_string(&manifest).unwrap();
        assert_eq!(Manifest::parse(&canonical).unwrap(), manifest);
        assert!(canonical.contains(r#""archive":"https://example.com/adapter.tar.gz""#));
    }

    #[test]
    fn rejects_reserved_invalid_and_duplicate_provider_ids() {
        for id in ["", "../example", "space id", "@plugin-scope", "trailing."] {
            let mut provider = recipe();
            provider["id"] = json!(id);
            assert!(
                Manifest::parse(&with_providers(vec![provider])).is_err(),
                "{id:?}"
            );
        }
        for agent in BUILTIN_AGENT_TYPES {
            for id in [
                agent.as_wire().into_owned(),
                registry::registry_id_for(*agent).to_ascii_uppercase(),
            ] {
                let mut provider = recipe();
                provider["id"] = json!(id);
                assert!(
                    Manifest::parse(&with_providers(vec![provider])).is_err(),
                    "{id:?}"
                );
            }
        }
        let mut duplicate = recipe();
        duplicate["id"] = json!(EXAMPLE_ID.to_ascii_uppercase());
        assert!(Manifest::parse(&with_providers(vec![recipe(), duplicate])).is_err());

        let providers: Vec<_> = (0..5)
            .map(|number| {
                let mut provider = recipe();
                provider["id"] = json!(format!("provider-{number}"));
                provider
            })
            .collect();
        assert!(Manifest::parse(&with_providers(providers[..4].to_vec())).is_ok());
        assert!(Manifest::parse(&with_providers(providers)).is_err());
    }

    #[test]
    fn rejects_invalid_metadata_and_launch_recipes() {
        for (field, value) in [
            ("name", json!("\t")),
            ("nameTranslations", json!({"es": " "})),
            ("nameTranslations", json!({"/../": "name"})),
            ("description", Value::Null),
            ("unknown", json!(true)),
            ("distributionKind", json!("binary")),
            ("spec", json!({"npx": {"package": ""}})),
            ("spec", json!({"npx": {"package": "--global"}})),
            ("spec", json!({"npx": {"package": "file:../adapter"}})),
            (
                "spec",
                json!({"npx": {"package": "adapter", "cmd": "../adapter"}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter", "args": ["--path=..\\adapter"]}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter", "args": ["bad\u{0}arg"]}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter", "env": {"BAD=KEY": "value"}}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter", "env": {"VAR": "bad\nvalue"}}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter", "nodeRequired": "22"}}),
            ),
            (
                "spec",
                json!({"npx": {"package": "adapter"}, "uvx": {"package": "adapter @ file:///tmp"}}),
            ),
        ] {
            let mut provider = recipe();
            provider[field] = value;
            assert!(
                Manifest::parse(&with_providers(vec![provider.clone()])).is_err(),
                "{provider}"
            );
        }

        for entry in [
            json!({"archive": "http://example.com/adapter.tar.gz", "cmd": "adapter"}),
            json!({"archive": "https://user:pass@example.com/adapter.tar.gz", "cmd": "adapter"}),
            json!({"archive": "https://example.com/adapter.tar.gz", "cmd": "C:\\adapter.exe"}),
            json!({"archive": "https://example.com/adapter.tar.gz", "cmd": "dir\\..\\adapter"}),
            json!({"archive": "https://example.com/adapter.tar.gz", "cmd": ""}),
            json!({"archive": "https://example.com/adapter.tar.gz", "cmd": "adapter", "sha256": "xyz"}),
        ] {
            let mut provider = recipe();
            provider["distributionKind"] = json!("binary");
            provider["spec"] = json!({"binary": {"linux-x86_64": entry}});
            assert!(
                Manifest::parse(&with_providers(vec![provider.clone()])).is_err(),
                "{provider}"
            );
        }
    }

    fn toggle(host: &HostPlugins, id: &str, enabled: bool) {
        host.apply(Mutation::SetEnabled {
            id: id.into(),
            enabled,
        })
        .unwrap();
    }

    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn catalog_reload_and_db_crud_preserve_provider_identity_and_precedence() {
        let _guard = custom_registry::hydrate_test_guard();
        custom_registry::suspend_plugin_providers();
        let data = tempfile::tempdir().unwrap();
        let example = tempfile::tempdir().unwrap();
        let manifest_path = example.path().join("codeg-plugin.json");
        std::fs::write(&manifest_path, EXAMPLE).unwrap();
        let host = HostPlugins::new_with_acp_providers(data.path());
        let preview = host
            .preview_install(example.path().to_str().unwrap(), Registry::Npm, None)
            .await
            .unwrap();
        assert_eq!(preview.manifest.contributes.acp_providers.len(), 1);
        host.confirm_install(preview.ticket).unwrap();
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
        toggle(&host, EXAMPLE_PLUGIN, true);
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
        // An unreadable user definition still reserves its public alias.
        custom_registry::hydrate_users(&[], [EXAMPLE_ID]);
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
        custom_registry::hydrate(&[]);

        let agent = registry::from_registry_id(EXAMPLE_ID).unwrap();
        assert!(agent.is_plugin_provider());
        assert!(registry::all_acp_agents().contains(&agent));
        assert_eq!(AgentType::from_wire(&agent.as_wire()), Some(agent));
        assert_ne!(AgentType::custom(EXAMPLE_ID), Some(agent));
        let id = agent.custom_id().unwrap();
        assert!(crate::acp_transcript::transcript_path_in(data.path(), id, "session-1").is_some());
        let original_meta = custom_registry::get(id).unwrap();
        let host = HostPlugins::new_with_acp_providers(data.path());
        assert!(std::ptr::eq(
            original_meta,
            custom_registry::get(id).unwrap()
        ));

        let db = fresh_in_memory_db().await;
        let status = crate::commands::acp::acp_get_agent_status_core(agent, &db)
            .await
            .unwrap();
        assert!(status.available);
        assert_eq!(custom_registry::public_provider_id(agent), Some(EXAMPLE_ID));
        let guard = EventEmitter::Noop;
        let mut configured = recipe();
        configured["name"] = json!("User's own ACP agent");
        configured["spec"]["npx"]["package"] = json!("user-acp@1.0.0");
        let configured: AcpProvider = serde_json::from_value(configured).unwrap();
        let configured = configured.definition("1.0.0");
        crate::commands::custom_agents::acp_save_custom_agent_core(configured, &db, &guard)
            .await
            .unwrap();
        let user = AgentType::custom(EXAMPLE_ID).unwrap();
        assert_eq!(registry::from_registry_id(EXAMPLE_ID), Some(user));
        assert_eq!(
            custom_registry::get(EXAMPLE_ID).unwrap().name,
            "User's own ACP agent"
        );
        assert!(registry::require_agent_meta(agent).is_err());
        assert!(crate::commands::acp::verify_agent_installed(agent)
            .await
            .is_err());
        toggle(&host, EXAMPLE_PLUGIN, false);
        toggle(&host, EXAMPLE_PLUGIN, true);
        assert_eq!(registry::from_registry_id(EXAMPLE_ID), Some(user));
        assert!(
            crate::commands::custom_agents::acp_delete_custom_agent_core(
                id.into(),
                false,
                &db,
                &guard
            )
            .await
            .is_err()
        );
        crate::commands::custom_agents::acp_delete_custom_agent_core(
            EXAMPLE_ID.into(),
            false,
            &db,
            &guard,
        )
        .await
        .unwrap();
        assert_eq!(registry::from_registry_id(EXAMPLE_ID), Some(agent));
        assert!(std::ptr::eq(
            original_meta,
            custom_registry::get(id).unwrap()
        ));
        assert!(
            crate::commands::custom_agents::acp_list_custom_agents_core(&db)
                .await
                .unwrap()
                .is_empty()
        );

        let mut manifest: Value = serde_json::from_str(EXAMPLE).unwrap();
        let provider = &mut manifest["contributes"]["acpProviders"][0];
        provider["name"] = json!("Edited provider label");
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert!(
            !host
                .update(EXAMPLE_PLUGIN)
                .await
                .unwrap()
                .disabled_for_update
        );
        assert_eq!(registry::from_registry_id(EXAMPLE_ID), Some(agent));
        assert_eq!(
            custom_registry::get(id).unwrap().name,
            "Edited provider label"
        );

        manifest["contributes"]["acpProviders"][0]["spec"]["npx"]["args"] =
            json!(["--reviewed-change"]);
        std::fs::write(&manifest_path, manifest.to_string()).unwrap();
        assert!(
            host.update(EXAMPLE_PLUGIN)
                .await
                .unwrap()
                .disabled_for_update
        );
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
        assert!(registry::require_agent_meta(agent).is_err());
        toggle(&host, EXAMPLE_PLUGIN, true);
        let replacement = registry::from_registry_id(EXAMPLE_ID).unwrap();
        assert_ne!(replacement, agent);
        assert!(registry::require_agent_meta(agent).is_err());
        host.apply(Mutation::Remove {
            id: EXAMPLE_PLUGIN.into(),
        })
        .unwrap();
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
        assert!(registry::require_agent_meta(replacement).is_err());
        assert!(AgentType::from_wire(&replacement.as_wire()).is_some());
    }

    #[test]
    fn plugin_collisions_are_resolved_in_plugin_id_order() {
        let _guard = custom_registry::hydrate_test_guard();
        custom_registry::hydrate(&[]);
        let data = tempfile::tempdir().unwrap();
        let host = HostPlugins::new_with_acp_providers(data.path());
        for (plugin_id, label) in [("z.provider", "Second"), ("a.provider", "First")] {
            let mut manifest: Value = serde_json::from_str(EXAMPLE).unwrap();
            manifest["id"] = json!(plugin_id);
            manifest["contributes"]["acpProviders"][0]["name"] = json!(label);
            host.apply(Mutation::Install {
                manifest: manifest.to_string(),
            })
            .unwrap();
            toggle(&host, plugin_id, true);
        }
        let first = registry::from_registry_id(EXAMPLE_ID).unwrap();
        assert_eq!(registry::require_agent_meta(first).unwrap().name, "First");
        toggle(&host, "a.provider", false);
        let second = registry::from_registry_id(EXAMPLE_ID).unwrap();
        assert_eq!(registry::require_agent_meta(second).unwrap().name, "Second");
        assert_ne!(first, second);
        assert!(registry::require_agent_meta(first).is_err());
        host.apply(Mutation::Remove {
            id: "z.provider".into(),
        })
        .unwrap();
        assert!(registry::from_registry_id(EXAMPLE_ID).is_none());
    }
}
