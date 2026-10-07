use std::time::Duration;

use serde::Deserialize;

use crate::acp::custom_registry::{
    CustomAgentDef, CustomAgentSource, CustomAgentSpec, CustomDistributionKind,
};
use crate::acp::registry;
use crate::app_error::AppCommandError;
use crate::models::agent::AgentType;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

#[derive(Debug, Clone)]
pub struct RegistryBinaryRelease {
    pub version: String,
    pub archive_url: String,
}

#[derive(Debug, Deserialize)]
struct RegistryPayload {
    agents: Vec<RegistryAgentItem>,
}

#[derive(Debug, Deserialize)]
struct RegistryAgentItem {
    id: String,
    name: String,
    description: String,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    website: Option<String>,
    #[serde(default)]
    repository: Option<String>,
    #[serde(default)]
    license: Option<String>,
    #[serde(default)]
    icon: Option<String>,
    /// The registry's `distribution` object. Deserialized straight into the
    /// custom-agent spec type — the two are the same document, which is what
    /// makes "paste a registry entry" work without a translation layer.
    #[serde(default)]
    distribution: CustomAgentSpec,
}

/// HTTP client for the registries agent releases are read from: this ACP
/// registry, and npm's for the newest release of an npx agent.
///
/// Built per call rather than cached, because reqwest samples the proxy
/// environment when a client is built and codeg rewrites that environment at
/// runtime when the user changes the proxy setting. The timeouts only cut off
/// a stalled connection; a slow response that is still arriving completes.
pub(crate) fn registry_http_client() -> Result<reqwest::Client, AppCommandError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(30))
        .user_agent(concat!("codeg/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| {
            AppCommandError::network(format!("failed to initialize registry HTTP client: {e}"))
        })
}

async fn fetch_registry_payload() -> Result<RegistryPayload, AppCommandError> {
    let response = registry_http_client()?
        .get(REGISTRY_URL)
        .send()
        .await
        .map_err(|e| AppCommandError::network(format!("failed to fetch ACP registry: {e}")))?;
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "failed to fetch ACP registry: HTTP {}",
            response.status()
        )));
    }

    let text = response
        .text()
        .await
        .map_err(|e| AppCommandError::network(format!("failed to read ACP registry response: {e}")))?;
    serde_json::from_str::<RegistryPayload>(&text).map_err(|e| {
        AppCommandError::configuration_invalid(format!("failed to parse ACP registry JSON: {e}"))
    })
}

/// The registry's current release of `agent_type` for `platform`: its version
/// and archive URL. `None` when the registry does not list the agent, names no
/// version, or has no archive for the platform.
pub async fn fetch_binary_release(
    agent_type: AgentType,
    platform: &str,
) -> Result<Option<RegistryBinaryRelease>, AppCommandError> {
    let payload = fetch_registry_payload().await?;
    let item = payload.agents.into_iter().find(|item| {
        registry::from_registry_id(&item.id)
            .map(|candidate| candidate == agent_type)
            .unwrap_or(false)
    });

    let Some(item) = item else {
        return Ok(None);
    };
    if item.version.as_deref().unwrap_or_default().is_empty() {
        return Ok(None);
    }
    let platform_item = item.distribution.binary.get(platform);
    let Some(platform_item) = platform_item else {
        return Ok(None);
    };
    if platform_item.archive.is_empty() {
        return Ok(None);
    }

    Ok(Some(RegistryBinaryRelease {
        version: item.version.unwrap_or_default(),
        archive_url: platform_item.archive.clone(),
    }))
}

/// One ACP-registry entry projected for the "add a custom agent" picker.
///
/// This is the catalog codeg does NOT ship built-ins for: the registry lists
/// far more agents than codeg has hand-written support for, and every one of
/// them speaks the same protocol, so they only need launch metadata.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryCatalogAgent {
    pub registry_id: String,
    pub name: String,
    pub description: String,
    pub version: Option<String>,
    pub icon_url: Option<String>,
    pub website: Option<String>,
    pub repository: Option<String>,
    pub license: Option<String>,
    /// Channels this entry publishes, in codeg's preference order.
    pub distribution_kinds: Vec<String>,
    /// codeg already ships a hand-written integration for this id.
    pub builtin: bool,
    /// The user already registered it as a custom agent.
    pub installed: bool,
    /// A binary release exists for this machine (always true for npx/uvx,
    /// which are platform-independent).
    pub supported_on_platform: bool,
    /// The registry's `distribution` object, ready to store as `spec_json`.
    pub spec: CustomAgentSpec,
}

/// Which channels a spec publishes, preferring the native binary (no runtime
/// dependency) over npx over uvx.
///
/// This is what the entry PUBLISHES, which is not the same as what this machine
/// can run — see [`kind_runs_here`].
fn distribution_kinds_of(spec: &CustomAgentSpec) -> Vec<CustomDistributionKind> {
    let mut kinds = Vec::new();
    if !spec.binary.is_empty() {
        kinds.push(CustomDistributionKind::Binary);
    }
    if spec.npx.is_some() {
        kinds.push(CustomDistributionKind::Npx);
    }
    if spec.uvx.is_some() {
        kinds.push(CustomDistributionKind::Uvx);
    }
    kinds
}

/// Whether this machine can actually launch through `kind`. npx and uvx are
/// platform-independent; a binary channel needs a release for this platform,
/// and plenty of registry entries ship binaries for only some platforms while
/// also publishing an npx package.
fn kind_runs_here(kind: CustomDistributionKind, spec: &CustomAgentSpec) -> bool {
    match kind {
        CustomDistributionKind::Binary => spec
            .binary
            .get(registry::current_platform())
            .is_some_and(|b| !b.archive.trim().is_empty()),
        CustomDistributionKind::Npx | CustomDistributionKind::Uvx => true,
    }
}

/// The channel to use when the caller expresses no preference: the most
/// preferred one that actually runs here, falling back to the most preferred
/// one overall so an unusable entry still fails with its own specific reason.
fn default_kind_for(spec: &CustomAgentSpec) -> Option<CustomDistributionKind> {
    let kinds = distribution_kinds_of(spec);
    kinds
        .iter()
        .copied()
        .find(|k| kind_runs_here(*k, spec))
        .or_else(|| kinds.first().copied())
}

/// Which channel an add of `entry` will actually use, given the caller's
/// (optional) explicit choice.
///
/// Callers that need to know the channel *before* building the definition —
/// the one-click add resolves an npm console script, which only makes sense for
/// the npx channel — must ask here rather than re-deriving it, or they can act
/// on a different channel than the one the definition ends up carrying.
pub fn effective_kind(
    entry: &RegistryCatalogAgent,
    explicit: Option<CustomDistributionKind>,
) -> Result<CustomDistributionKind, AppCommandError> {
    match explicit {
        Some(k) if distribution_kinds_of(&entry.spec).contains(&k) => Ok(k),
        Some(k) => Err(AppCommandError::configuration_invalid(format!(
            "{} does not publish a {} distribution",
            entry.registry_id,
            k.as_str()
        ))),
        None => default_kind_for(&entry.spec).ok_or_else(|| {
            AppCommandError::configuration_invalid(format!(
                "{} publishes no usable distribution",
                entry.registry_id
            ))
        }),
    }
}

/// Fetch the full ACP registry, annotated with what codeg can do with each
/// entry. Built-ins are included (flagged) so the picker can explain why they
/// are not addable rather than silently omitting them.
pub async fn fetch_catalog(
    installed_ids: &[String],
) -> Result<Vec<RegistryCatalogAgent>, AppCommandError> {
    let payload = fetch_registry_payload().await?;
    let mut out: Vec<RegistryCatalogAgent> = payload
        .agents
        .into_iter()
        .map(|item| {
            let kinds = distribution_kinds_of(&item.distribution);
            // Exactly the condition `default_kind_for` uses to pick a channel,
            // so the picker cannot advertise an entry as supported and then
            // fail to add it.
            let supported_on_platform = kinds
                .iter()
                .any(|k| kind_runs_here(*k, &item.distribution));
            RegistryCatalogAgent {
                builtin: is_builtin_registry_id(&item.id),
                installed: installed_ids.iter().any(|id| id == &item.id),
                supported_on_platform,
                distribution_kinds: kinds.iter().map(|k| k.as_str().to_string()).collect(),
                registry_id: item.id,
                name: item.name,
                description: item.description,
                version: item.version,
                icon_url: item.icon,
                website: item.website,
                repository: item.repository,
                license: item.license,
                spec: item.distribution,
            }
        })
        .collect();
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

/// Registry ids that name an agent codeg already ships, under a different id
/// than codeg's own. Without this the picker would offer a second, redundant
/// integration of an agent the user already has — verified against the live
/// registry, where Kimi is published as `kimi` while codeg's built-in registry
/// id is `kimi-code`, and Qoder as `qoder` against codeg's `qoder-cli`.
///
/// Missing an alias is not merely redundant, it is a DEAD entry: the picker
/// lists the agent as addable, and the add then fails validation because the
/// id collides with a built-in wire name (`is_valid_custom_agent_id`).
const BUILTIN_REGISTRY_ALIASES: &[&str] = &["kimi", "qoder"];

/// Whether an id is one of codeg's hand-written built-in agents. Deliberately
/// does NOT consult the custom registry (unlike `registry::from_registry_id`,
/// which resolves registered custom ids too) — the picker needs "codeg ships
/// this natively", not "codeg can currently launch this".
fn is_builtin_registry_id(id: &str) -> bool {
    BUILTIN_REGISTRY_ALIASES.contains(&id)
        || registry::builtin_acp_agents()
            .into_iter()
            .any(|agent| registry::registry_id_for(agent) == id)
}

/// Turn a catalog entry into a storable definition.
///
/// `kind` picks the channel when the entry publishes more than one; `None`
/// takes the first in preference order. `cmd_override` supplies the npx/uvx
/// console-script name, which the registry does not carry.
pub fn catalog_entry_to_def(
    entry: &RegistryCatalogAgent,
    kind: Option<CustomDistributionKind>,
    cmd_override: Option<String>,
) -> Result<CustomAgentDef, AppCommandError> {
    // The picker adds with one click and passes no channel, so the unspecified
    // case is the normal path — see [`effective_kind`], which is also what the
    // caller consults before resolving a console-script name.
    let kind = effective_kind(entry, kind)?;

    let mut spec = entry.spec.clone();
    if let Some(cmd) = cmd_override.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        match kind {
            CustomDistributionKind::Npx => {
                if let Some(npx) = spec.npx.as_mut() {
                    npx.cmd = Some(cmd);
                }
            }
            CustomDistributionKind::Uvx => {
                if let Some(uvx) = spec.uvx.as_mut() {
                    uvx.cmd = Some(cmd);
                }
            }
            // A binary entry already carries its in-archive launch path.
            CustomDistributionKind::Binary => {}
        }
    }

    Ok(CustomAgentDef {
        registry_id: entry.registry_id.clone(),
        name: entry.name.clone(),
        description: entry.description.clone(),
        version: entry.version.clone().unwrap_or_default(),
        distribution_kind: kind,
        spec,
        icon_url: entry.icon_url.clone(),
        // The ACP registry catalog does not describe skill directories; the
        // user opts in from the edit form after adding.
        skills_shared_store: false,
        skills_dir: None,
        source: CustomAgentSource::Registry,
        // No probe declared by the registry; the system-install version probe
        // falls back to running the command with `--version`.
        version_probe: None,
        // The catalog says nothing about MCP either. Start forwarding it —
        // almost every agent accepts it, and an agent that does not announces
        // itself loudly by failing to connect, which is what the settings
        // toggle is there to fix.
        supports_mcp: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec_from(json: &str) -> CustomAgentSpec {
        serde_json::from_str(json).expect("registry distribution parses")
    }

    #[test]
    fn distribution_preference_puts_binary_first() {
        let spec = spec_from(
            r#"{"npx":{"package":"kilo@7.4.16"},"binary":{"linux-x86_64":{"archive":"https://e/k.tgz","cmd":"./kilo"}}}"#,
        );
        assert_eq!(
            distribution_kinds_of(&spec),
            vec![CustomDistributionKind::Binary, CustomDistributionKind::Npx]
        );
        let uvx_only = spec_from(r#"{"uvx":{"package":"fast-agent-acp==0.9.24"}}"#);
        assert_eq!(
            distribution_kinds_of(&uvx_only),
            vec![CustomDistributionKind::Uvx]
        );
        assert!(distribution_kinds_of(&CustomAgentSpec::default()).is_empty());
    }

    #[test]
    fn a_binary_for_other_platforms_falls_back_to_npx_rather_than_failing() {
        // Plenty of registry entries ship binaries for some platforms and an
        // npx package for the rest. The picker adds with one click and passes
        // no channel, so preferring the (unavailable) binary would make the add
        // fail with "no binary release" on exactly those platforms.
        let elsewhere = if registry::current_platform().starts_with("windows") {
            "linux-x86_64"
        } else {
            "windows-x86_64"
        };
        let spec = spec_from(&format!(
            r#"{{"npx":{{"package":"kilo@7.4.16"}},"binary":{{"{elsewhere}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#
        ));
        // Preference order still lists the binary first...
        assert_eq!(
            distribution_kinds_of(&spec)[0],
            CustomDistributionKind::Binary
        );
        // ...but only npx runs here, so that is what an unspecified add picks,
        // and the entry is (correctly) advertised as supported.
        assert!(!kind_runs_here(CustomDistributionKind::Binary, &spec));
        assert_eq!(default_kind_for(&spec), Some(CustomDistributionKind::Npx));

        let entry = catalog_entry("kilo", spec);
        let def = catalog_entry_to_def(&entry, None, None).expect("addable");
        assert_eq!(def.distribution_kind, CustomDistributionKind::Npx);
        // And the definition it produces is actually launchable here.
        assert!(crate::acp::custom_registry::validate(&def).is_ok());
    }

    #[test]
    fn a_binary_available_here_still_wins() {
        let spec = spec_from(&format!(
            r#"{{"npx":{{"package":"kilo@7.4.16"}},"binary":{{"{}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#,
            registry::current_platform()
        ));
        assert_eq!(default_kind_for(&spec), Some(CustomDistributionKind::Binary));
        // An explicit choice is still honoured over the default.
        let entry = catalog_entry("kilo", spec);
        let def = catalog_entry_to_def(&entry, Some(CustomDistributionKind::Npx), None)
            .expect("explicit npx");
        assert_eq!(def.distribution_kind, CustomDistributionKind::Npx);
    }

    #[test]
    fn the_kind_a_caller_resolves_is_the_kind_the_definition_carries() {
        // The one-click add asks `effective_kind` first (to decide whether to
        // look up an npm console script) and builds the definition after. If
        // the two could disagree, the definition would carry a command name
        // derived for a channel it does not use — and fail to launch.
        let elsewhere = if registry::current_platform().starts_with("windows") {
            "linux-x86_64"
        } else {
            "windows-x86_64"
        };
        let here = registry::current_platform();
        let specs = [
            spec_from(&format!(
                r#"{{"npx":{{"package":"kilo@1"}},"binary":{{"{elsewhere}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#
            )),
            spec_from(&format!(
                r#"{{"npx":{{"package":"kilo@1"}},"binary":{{"{here}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#
            )),
            spec_from(r#"{"npx":{"package":"kilo@1"}}"#),
            spec_from(r#"{"uvx":{"package":"kilo==1"}}"#),
            spec_from(&format!(
                r#"{{"binary":{{"{elsewhere}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#
            )),
        ];
        for spec in specs {
            let entry = catalog_entry("kilo", spec);
            let resolved = effective_kind(&entry, None).expect("resolves a channel");
            assert_eq!(
                catalog_entry_to_def(&entry, None, None)
                    .expect("converts")
                    .distribution_kind,
                resolved,
                "resolved channel and built definition must match"
            );
        }
    }

    #[test]
    fn an_entry_with_no_usable_channel_reports_its_own_reason() {
        // Binary-only, published for another platform: there is nothing usable
        // here, so the add must still fail — but with the specific
        // "no binary release for this platform" reason, not a generic one.
        let elsewhere = if registry::current_platform().starts_with("windows") {
            "linux-x86_64"
        } else {
            "windows-x86_64"
        };
        let spec = spec_from(&format!(
            r#"{{"binary":{{"{elsewhere}":{{"archive":"https://e/k.tgz","cmd":"./kilo"}}}}}}"#
        ));
        assert_eq!(default_kind_for(&spec), Some(CustomDistributionKind::Binary));
        let entry = catalog_entry("kilo", spec);
        let def = catalog_entry_to_def(&entry, None, None).expect("converts");
        assert!(matches!(
            crate::acp::custom_registry::validate(&def),
            Err(crate::acp::custom_registry::CustomAgentError::UnsupportedPlatform(_))
        ));
    }

    #[test]
    fn builtin_ids_are_recognized_without_the_custom_registry() {
        assert!(is_builtin_registry_id("codex-acp"));
        assert!(is_builtin_registry_id("claude-acp"));
        assert!(is_builtin_registry_id("cursor"));
        // Published under a different id than codeg's own (`kimi-code`), so
        // only the alias table catches it.
        assert!(is_builtin_registry_id("kimi"));
        assert!(is_builtin_registry_id("kimi-code"));
        // Same story for Qoder (`qoder` upstream, `qoder-cli` here). Every
        // alias must ALSO be an id the custom registry would refuse, which is
        // exactly why offering it in the picker is a dead end rather than a
        // duplicate — see the assertion below.
        assert!(is_builtin_registry_id("qoder"));
        assert!(is_builtin_registry_id("qoder-cli"));
        // Antigravity needs NO alias: codeg's registry id is byte-identical
        // to the one the ACP registry publishes, so the picker resolves it
        // through the built-in table and never offers a duplicate entry.
        assert!(is_builtin_registry_id("antigravity-acp"));
        assert!(!is_builtin_registry_id("goose"));
        assert!(!is_builtin_registry_id("qwen-code"));
    }

    // Why a missing alias is a BUG and not just noise. The two entries in the
    // table fail differently, and Qoder is the worse of the two:
    //
    // * `kimi` IS a legal custom-agent id (codeg's wire name is `kimi_code`),
    //   so without the alias the picker would let the user add a SECOND,
    //   redundant Kimi alongside the built-in.
    // * `qoder` is NOT (it is codeg's wire name, blocked outright), so without
    //   the alias the picker lists an entry whose "Add" button can only ever
    //   error — a dead end with no way for the user to understand it.
    #[test]
    fn aliases_that_are_addable_would_duplicate_and_the_rest_would_dead_end() {
        assert!(crate::models::agent::is_valid_custom_agent_id("kimi"));
        assert!(!crate::models::agent::is_valid_custom_agent_id("qoder"));
        for alias in BUILTIN_REGISTRY_ALIASES {
            assert!(
                is_builtin_registry_id(alias),
                "alias `{alias}` must read as built-in"
            );
        }
    }

    fn catalog_entry(id: &str, spec: CustomAgentSpec) -> RegistryCatalogAgent {
        RegistryCatalogAgent {
            registry_id: id.into(),
            name: "Goose".into(),
            description: "d".into(),
            version: Some("1.44.0".into()),
            icon_url: Some("https://e/i.svg".into()),
            website: None,
            repository: None,
            license: Some("Apache-2.0".into()),
            distribution_kinds: distribution_kinds_of(&spec)
                .iter()
                .map(|k| k.as_str().to_string())
                .collect(),
            builtin: false,
            installed: false,
            supported_on_platform: true,
            spec,
        }
    }

    #[test]
    fn catalog_entry_converts_to_a_storable_definition() {
        let entry = catalog_entry(
            "goose",
            spec_from(
                r#"{"binary":{"darwin-aarch64":{"archive":"https://e/g.tar.bz2","cmd":"./goose","args":["acp"],"sha256":"ab"}}}"#,
            ),
        );
        let def = catalog_entry_to_def(&entry, None, None).expect("converts");
        assert_eq!(def.registry_id, "goose");
        assert_eq!(def.version, "1.44.0");
        assert_eq!(def.distribution_kind, CustomDistributionKind::Binary);
        assert_eq!(def.icon_url.as_deref(), Some("https://e/i.svg"));
        assert_eq!(
            def.spec.binary["darwin-aarch64"].sha256.as_deref(),
            Some("ab")
        );
    }

    #[test]
    fn cmd_override_lands_on_the_chosen_channel() {
        let entry = catalog_entry(
            "qwen-code",
            spec_from(r#"{"npx":{"package":"@qwen-code/qwen-code@0.21.0","args":["--acp"]}}"#),
        );
        let def = catalog_entry_to_def(&entry, Some(CustomDistributionKind::Npx), Some("qwen".into()))
            .expect("converts");
        assert_eq!(def.spec.npx.unwrap().cmd.as_deref(), Some("qwen"));
    }

    #[test]
    fn choosing_a_channel_the_entry_does_not_publish_is_rejected() {
        let entry = catalog_entry(
            "qwen-code",
            spec_from(r#"{"npx":{"package":"@qwen-code/qwen-code@0.21.0"}}"#),
        );
        assert!(catalog_entry_to_def(&entry, Some(CustomDistributionKind::Binary), None).is_err());
        let empty = catalog_entry("nothing", CustomAgentSpec::default());
        assert!(catalog_entry_to_def(&empty, None, None).is_err());
    }
}
