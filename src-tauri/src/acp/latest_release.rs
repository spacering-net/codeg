//! The newest upstream release of an agent, offered in Agent Settings' Version
//! Status as "Upgrade to unreviewed latest".
//!
//! codeg installs the version it has reviewed and pinned in the registry. This
//! answers a narrower question, asked once each time the user opens an agent:
//! has the publisher released something newer than that pin, which Custom
//! install can fetch?
//!
//! Sources, by distribution:
//! - npx: the package's `latest` dist-tag on the official npm registry, the
//!   same registry every codeg npm install is pointed at. The ACP registry
//!   cannot stand in for it: it misses several of codeg's npx agents, lags on
//!   others, and has listed an npm `alpha` as an agent's newest version.
//! - binary: the ACP registry's archive URL for this platform. The version is
//!   read out of that URL by matching it against codeg's pinned URL, not taken
//!   from the registry's `version` field, because the two can differ (Cursor's
//!   field drops the build hash that its URLs, and codeg's pins, carry). A URL
//!   that no longer fits the pinned template (upstream renamed its archives)
//!   offers nothing, rather than an install that would 404.
//! - uvx: nothing, since Custom install does not support it.
//!
//! An offered version is always one Custom install accepts, and installing it
//! goes through exactly that path.

use serde::Serialize;

use crate::acp::custom_registry::{self, CustomAgentSource};
use crate::acp::registry::{self, AcpAgentMeta, AgentDistribution};
use crate::acp::remote_registry::{self, RegistryBinaryRelease};
use crate::app_error::AppCommandError;
use crate::commands::acp::{
    apply_custom_version_to_url, package_name_from_spec, sanitize_custom_version,
    NPM_OFFICIAL_REGISTRY,
};
use crate::models::agent::AgentType;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentLatestRelease {
    /// The exact version to install, in the form Custom install accepts.
    pub version: String,
}

/// What to ask upstream about an agent, decided before any request is made.
#[derive(Debug, PartialEq, Eq)]
enum Lookup {
    Npm {
        package_name: String,
        pin: &'static str,
    },
    AcpRegistry {
        pin: &'static str,
        pinned_url: &'static str,
    },
}

/// The newest release of `agent_type` that is newer than codeg's pin, or
/// `None` when there is none or the agent has nothing to look up. A failed
/// request is an error; a package or registry entry that does not exist is
/// `None`.
pub async fn resolve(agent_type: AgentType) -> Result<Option<AgentLatestRelease>, AppCommandError> {
    let meta = registry::get_agent_meta(agent_type);
    let custom_source = agent_type.custom_id().and_then(custom_registry::source_of);
    let Some(lookup) = lookup_for(&meta, custom_source) else {
        return Ok(None);
    };
    match lookup {
        Lookup::Npm { package_name, pin } => Ok(fetch_npm_latest(&package_name)
            .await?
            .and_then(|latest| npx_offer(pin, &latest))),
        Lookup::AcpRegistry { pin, pinned_url } => Ok(remote_registry::fetch_binary_release(
            agent_type,
            registry::current_platform(),
        )
        .await?
        .and_then(|release| binary_offer(pin, pinned_url, &release))),
    }
}

/// `custom_source` is the definition's origin for a registered custom agent,
/// and `None` for a built-in or an unregistered custom id.
fn lookup_for(meta: &AcpAgentMeta, custom_source: Option<CustomAgentSource>) -> Option<Lookup> {
    // A manual definition's version is whatever the user typed, so there is
    // no pin to be newer than; an unregistered id has no package at all.
    if meta.agent_type.custom_id().is_some() && custom_source != Some(CustomAgentSource::Registry) {
        return None;
    }
    // Also rules out uvx, and a binary whose download URL does not carry its
    // version: Custom install could not fetch another version of either.
    if !meta.supports_custom_version() {
        return None;
    }
    // A registry entry may name no version, leaving nothing to be newer than.
    let pin = meta
        .registry_version()
        .filter(|pin| !pin.trim().is_empty())?;
    match &meta.distribution {
        AgentDistribution::Npx { package, .. } => {
            let package_name = package_name_from_spec(package);
            (!package_name.is_empty()).then_some(Lookup::Npm { package_name, pin })
        }
        AgentDistribution::Binary { platforms, .. } => platforms
            .iter()
            .find(|p| p.platform == registry::current_platform())
            .map(|p| Lookup::AcpRegistry {
                pin,
                pinned_url: p.url,
            }),
        AgentDistribution::Uvx { .. } => None,
    }
}

fn dist_tags_url(package_name: &str) -> String {
    // A scoped name's `/` must be escaped, or the registry reads `@scope/name`
    // as two path segments.
    format!(
        "{NPM_OFFICIAL_REGISTRY}/-/package/{}/dist-tags",
        package_name.replace('/', "%2F")
    )
}

async fn fetch_npm_latest(package_name: &str) -> Result<Option<String>, AppCommandError> {
    let response = remote_registry::registry_http_client()?
        .get(dist_tags_url(package_name))
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network(format!(
                "failed to fetch npm dist-tags for {package_name}: {e}"
            ))
        })?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        // Not on the public registry under this name (a custom agent can name
        // a package that only lives on a private one).
        tracing::warn!("[acp] npm has no dist-tags for {package_name}");
        return Ok(None);
    }
    if !response.status().is_success() {
        return Err(AppCommandError::network(format!(
            "failed to fetch npm dist-tags for {package_name}: HTTP {}",
            response.status()
        )));
    }
    let text = response.text().await.map_err(|e| {
        AppCommandError::network(format!(
            "failed to read npm dist-tags for {package_name}: {e}"
        ))
    })?;
    let tags: serde_json::Value = serde_json::from_str(&text).map_err(|e| {
        AppCommandError::configuration_invalid(format!(
            "failed to parse npm dist-tags for {package_name}: {e}"
        ))
    })?;
    Ok(tags
        .get("latest")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string))
}

/// The `latest` dist-tag's version, when it is newer than the pin.
fn npx_offer(pin: &str, latest: &str) -> Option<AgentLatestRelease> {
    let version = sanitize_custom_version(latest)?;
    is_strictly_newer(&version, pin).then_some(AgentLatestRelease { version })
}

/// The version of the registry's current archive, when it is newer than the
/// pin and Custom install would download exactly that archive.
fn binary_offer(
    pin: &str,
    pinned_url: &str,
    release: &RegistryBinaryRelease,
) -> Option<AgentLatestRelease> {
    let version = version_in_templated_url(pinned_url, pin, &release.archive_url)?;
    // Custom install has to accept it, and it has to name the release the
    // registry publishes, give or take a build suffix (Cursor's registry
    // `2026.09.26` is `2026.09.26-dd393fe` in its URL). Together these also
    // keep out a `v` that Custom install would strip, which would make it
    // download a different URL than the registry's.
    sanitize_custom_version(&version)?;
    let published = release.version.trim().trim_start_matches(['v', 'V']);
    let names_the_release = version == published
        || version
            .strip_prefix(published)
            .is_some_and(|rest| rest.starts_with(['-', '+']));
    if published.is_empty() || !names_the_release {
        return None;
    }
    is_strictly_newer(&version, pin).then_some(AgentLatestRelease { version })
}

/// The version `candidate_url` carries where `template_url` carries
/// `template_version`: the one token that, substituted the way Custom install
/// substitutes a version into the pinned URL, turns `template_url` into
/// `candidate_url` byte for byte. `None` when no single token does.
fn version_in_templated_url(
    template_url: &str,
    template_version: &str,
    candidate_url: &str,
) -> Option<String> {
    if template_version.is_empty() {
        return None;
    }
    let parts: Vec<&str> = template_url.split(template_version).collect();
    let slots = parts.len() - 1;
    if slots == 0 {
        return None;
    }
    // Every slot holds the same token, so its length is fixed by how much
    // longer the candidate is than the template's literal text.
    let literal_len: usize = parts.iter().map(|part| part.len()).sum();
    let token_total = candidate_url.len().checked_sub(literal_len)?;
    if token_total == 0 || token_total % slots != 0 {
        return None;
    }
    let start = parts[0].len();
    let token = candidate_url.get(start..start + token_total / slots)?;
    (apply_custom_version_to_url(template_url, template_version, token) == candidate_url)
        .then(|| token.to_string())
}

/// Whether `candidate` is a newer release than `pin`. Semver precedence when
/// both parse as semver (so a prerelease sorts below its release); otherwise
/// the leading digits of each dot-separated segment, compared in order, where
/// equal digits throughout is NOT newer even if a suffix differs (Cursor's
/// same-day builds differ only by hash). The settings page orders versions by
/// the same rules (`compareReleaseVersion`).
fn is_strictly_newer(candidate: &str, pin: &str) -> bool {
    let candidate = candidate.trim().trim_start_matches(['v', 'V']);
    let pin = pin.trim().trim_start_matches(['v', 'V']);
    if let (Ok(candidate), Ok(pin)) = (
        semver::Version::parse(candidate),
        semver::Version::parse(pin),
    ) {
        return candidate.cmp_precedence(&pin).is_gt();
    }
    let segments = |version: &str| -> Vec<u64> {
        version
            .split('.')
            .map(|segment| {
                let digits = segment
                    .find(|c: char| !c.is_ascii_digit())
                    .map_or(segment, |end| &segment[..end]);
                digits.parse().unwrap_or(0)
            })
            .collect()
    };
    let (candidate, pin) = (segments(candidate), segments(pin));
    for index in 0..candidate.len().max(pin.len()) {
        let ours = candidate.get(index).copied().unwrap_or(0);
        let theirs = pin.get(index).copied().unwrap_or(0);
        if ours != theirs {
            return ours > theirs;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::registry::PlatformBinary;

    const OPENCODE_PIN: &str =
        "https://github.com/anomalyco/opencode/releases/download/v1.18.33/opencode-darwin-arm64.zip";
    const CURSOR_PIN: &str =
        "https://downloads.cursor.com/lab/2026.09.26-dd393fe/darwin/arm64/agent-cli-package.tar.gz";
    const ANTIGRAVITY_PIN: &str =
        "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip";
    // codex-acp's old binary URLs carried the version twice.
    const CODEX_PIN: &str = "https://github.com/zed-industries/codex-acp/releases/download/v0.15.0/codex-acp-0.15.0-aarch64-apple-darwin.tar.gz";

    fn release(version: &str, archive_url: &str) -> RegistryBinaryRelease {
        RegistryBinaryRelease {
            version: version.to_string(),
            archive_url: archive_url.to_string(),
        }
    }

    fn offer(version: &str) -> Option<AgentLatestRelease> {
        Some(AgentLatestRelease {
            version: version.to_string(),
        })
    }

    #[test]
    fn reads_the_version_out_of_a_url_shaped_like_the_pin() {
        assert_eq!(
            version_in_templated_url(
                OPENCODE_PIN,
                "1.18.33",
                "https://github.com/anomalyco/opencode/releases/download/v1.19.0/opencode-darwin-arm64.zip"
            )
            .as_deref(),
            Some("1.19.0")
        );
        assert_eq!(
            version_in_templated_url(
                CURSOR_PIN,
                "2026.09.26-dd393fe",
                "https://downloads.cursor.com/lab/2026.10.03-abcdef1/darwin/arm64/agent-cli-package.tar.gz"
            )
            .as_deref(),
            Some("2026.10.03-abcdef1")
        );
        assert_eq!(
            version_in_templated_url(
                ANTIGRAVITY_PIN,
                "1.2.1",
                "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.3.0-darwin-arm64.zip"
            )
            .as_deref(),
            Some("1.3.0")
        );
        // Every slot must hold the same token.
        assert_eq!(
            version_in_templated_url(
                CODEX_PIN,
                "0.15.0",
                "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.0-aarch64-apple-darwin.tar.gz"
            )
            .as_deref(),
            Some("0.16.0")
        );
        assert_eq!(
            version_in_templated_url(
                CODEX_PIN,
                "0.15.0",
                "https://github.com/zed-industries/codex-acp/releases/download/v0.16.0/codex-acp-0.16.1-aarch64-apple-darwin.tar.gz"
            ),
            None
        );
        // The pin itself reads back as the pin.
        assert_eq!(
            version_in_templated_url(OPENCODE_PIN, "1.18.33", OPENCODE_PIN).as_deref(),
            Some("1.18.33")
        );
    }

    #[test]
    fn a_url_that_does_not_fit_the_template_carries_no_version() {
        // A renamed archive, a different host, a different platform.
        for candidate in [
            "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-darwin-arm64-1.3.0.zip",
            "https://mirror.example/anomalyco/opencode/releases/download/v1.19.0/opencode-darwin-arm64.zip",
            "https://github.com/anomalyco/opencode/releases/download/v1.19.0/opencode-linux-x64.zip",
            "",
        ] {
            let token = version_in_templated_url(ANTIGRAVITY_PIN, "1.2.1", candidate)
                .or_else(|| version_in_templated_url(OPENCODE_PIN, "1.18.33", candidate));
            assert_eq!(token, None, "{candidate}");
        }
        // A template without the version has no slot to read.
        assert_eq!(
            version_in_templated_url("https://e/agent.zip", "1.0.0", "https://e/agent.zip"),
            None
        );
    }

    #[test]
    fn newer_means_strictly_newer() {
        assert!(is_strictly_newer("1.0.44", "1.0.41"));
        assert!(is_strictly_newer("0.61.0", "0.60.0"));
        assert!(is_strictly_newer("2.0.0", "1.99.99"));
        assert!(!is_strictly_newer("1.0.41", "1.0.41"));
        assert!(!is_strictly_newer("1.0.40", "1.0.41"));
        // Prereleases sort below their release, above the one before.
        assert!(!is_strictly_newer("0.85.0-rc.1", "0.85.0"));
        assert!(is_strictly_newer("0.85.0", "0.85.0-rc.1"));
        assert!(is_strictly_newer("0.85.0-rc.1", "0.84.0"));
        assert!(is_strictly_newer("0.85.0-rc.2", "0.85.0-rc.1"));
        // Build metadata carries no precedence.
        assert!(!is_strictly_newer("1.0.0+build.2", "1.0.0+build.1"));
        // A leading `v` on either side.
        assert!(is_strictly_newer("v1.19.0", "1.18.33"));
        assert!(!is_strictly_newer("1.18.33", "v1.18.33"));
    }

    #[test]
    fn calendar_versions_compare_by_their_numbers() {
        // Leading zeros are not semver, so these take the numeric path.
        assert!(is_strictly_newer(
            "2026.10.03-abcdef1",
            "2026.09.26-dd393fe"
        ));
        assert!(!is_strictly_newer(
            "2026.09.26-dd393fe",
            "2026.10.03-abcdef1"
        ));
        // Same numbers, different hash: not newer.
        assert!(!is_strictly_newer(
            "2026.09.26-aaaaaaa",
            "2026.09.26-dd393fe"
        ));
        assert!(is_strictly_newer("2026.9.7", "2026.9.6"));
        assert!(is_strictly_newer("1.2.1.1", "1.2.1"));
        assert!(!is_strictly_newer("1.2.1", "1.2.1.0"));
    }

    #[test]
    fn npm_latest_is_offered_only_when_newer_than_the_pin() {
        assert_eq!(npx_offer("1.0.41", "1.0.44"), offer("1.0.44"));
        assert_eq!(npx_offer("1.0.41", "v1.0.44"), offer("1.0.44"));
        assert_eq!(npx_offer("1.0.41", "1.0.41"), None);
        assert_eq!(npx_offer("1.0.41", "1.0.40"), None);
        // Nothing Custom install would refuse.
        for latest in ["latest", "1", "", " ", "1.0.44 || 2", "../1.0.44"] {
            assert_eq!(npx_offer("1.0.41", latest), None, "{latest:?}");
        }
    }

    #[test]
    fn a_binary_is_offered_at_the_version_its_url_carries() {
        let next = "https://github.com/anomalyco/opencode/releases/download/v1.19.0/opencode-darwin-arm64.zip";
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("1.19.0", next)),
            offer("1.19.0")
        );
        // Cursor's registry version drops the hash; the URL's version wins.
        let cursor_next = "https://downloads.cursor.com/lab/2026.10.03-abcdef1/darwin/arm64/agent-cli-package.tar.gz";
        assert_eq!(
            binary_offer(
                "2026.09.26-dd393fe",
                CURSOR_PIN,
                &release("2026.10.03", cursor_next)
            ),
            offer("2026.10.03-abcdef1")
        );
        // The registry at the pin offers nothing.
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("1.18.33", OPENCODE_PIN)),
            None
        );
        assert_eq!(
            binary_offer(
                "2026.09.26-dd393fe",
                CURSOR_PIN,
                &release("2026.09.26", CURSOR_PIN)
            ),
            None
        );
    }

    #[test]
    fn a_binary_url_that_disagrees_with_its_release_is_not_offered() {
        // Renamed archives: the leftover text is not a version.
        let renamed = "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-new-1.3.0-darwin-arm64.zip";
        assert_eq!(
            binary_offer("1.2.1", ANTIGRAVITY_PIN, &release("1.3.0", renamed)),
            None
        );
        // The URL names a different release than the registry says.
        let next = "https://github.com/anomalyco/opencode/releases/download/v1.19.0/opencode-darwin-arm64.zip";
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("1.20.0", next)),
            None
        );
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("1.19", next)),
            None
        );
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("", next)),
            None
        );
        // A build suffix Custom install would refuse.
        let odd = "https://github.com/anomalyco/opencode/releases/download/v1.19.0-a/b/opencode-darwin-arm64.zip";
        assert_eq!(
            binary_offer("1.18.33", OPENCODE_PIN, &release("1.19.0", odd)),
            None
        );
    }

    #[test]
    fn scoped_package_names_are_escaped_in_the_dist_tags_url() {
        assert_eq!(
            dist_tags_url("@google/gemini-cli"),
            "https://registry.npmjs.org/-/package/@google%2Fgemini-cli/dist-tags"
        );
        assert_eq!(
            dist_tags_url("hermes-agent"),
            "https://registry.npmjs.org/-/package/hermes-agent/dist-tags"
        );
    }

    fn meta(agent_type: AgentType, distribution: AgentDistribution) -> AcpAgentMeta {
        AcpAgentMeta {
            agent_type,
            supports_mcp: true,
            name: "Test agent",
            description: "",
            distribution,
        }
    }

    fn npx(package: &'static str, version: &'static str) -> AgentDistribution {
        AgentDistribution::Npx {
            version,
            package,
            cmd: "test-agent",
            args: &[],
            env: &[],
            node_required: None,
        }
    }

    fn binary(version: &'static str, url: &'static str) -> AgentDistribution {
        let platforms: &'static [PlatformBinary] = Box::leak(Box::new([PlatformBinary {
            platform: registry::current_platform(),
            url,
            sha256: None,
        }]));
        AgentDistribution::Binary {
            version,
            cmd: "test-agent",
            args: &[],
            env: &[],
            platforms,
            dir_entry: None,
        }
    }

    #[test]
    fn looks_up_npm_for_npx_and_the_acp_registry_for_binaries() {
        assert_eq!(
            lookup_for(
                &meta(
                    AgentType::Gemini,
                    npx("@google/gemini-cli@0.60.0", "0.60.0")
                ),
                None
            ),
            Some(Lookup::Npm {
                package_name: "@google/gemini-cli".to_string(),
                pin: "0.60.0",
            })
        );
        assert_eq!(
            lookup_for(
                &meta(AgentType::OpenCode, binary("1.18.33", OPENCODE_PIN)),
                None
            ),
            Some(Lookup::AcpRegistry {
                pin: "1.18.33",
                pinned_url: OPENCODE_PIN,
            })
        );
        // A registry-added custom agent is looked up like a built-in.
        assert_eq!(
            lookup_for(
                &meta(
                    AgentType::Custom("qwen-code"),
                    npx("@qwen-code/qwen-code@0.21.0", "0.21.0")
                ),
                Some(CustomAgentSource::Registry)
            ),
            Some(Lookup::Npm {
                package_name: "@qwen-code/qwen-code".to_string(),
                pin: "0.21.0",
            })
        );
    }

    #[test]
    fn nothing_is_looked_up_where_custom_install_could_not_follow() {
        let manual = meta(AgentType::Custom("goose"), npx("goose-acp@1.0.0", "1.0.0"));
        assert_eq!(lookup_for(&manual, Some(CustomAgentSource::Manual)), None);
        // A registry entry that named no version has no pin to be newer than.
        let unpinned = meta(AgentType::Custom("goose"), npx("goose-acp", ""));
        assert_eq!(
            lookup_for(&unpinned, Some(CustomAgentSource::Registry)),
            None
        );
        // Unregistered: no definition behind the id.
        let unregistered = custom_registry::unregistered_meta("gone-agent");
        assert_eq!(lookup_for(&unregistered, None), None);
        let uvx = meta(
            AgentType::Custom("fast-agent"),
            AgentDistribution::Uvx {
                version: "0.9.24",
                package: "fast-agent-acp==0.9.24",
                cmd: "fast-agent-acp",
                args: &[],
                env: &[],
                uv_required: None,
                python: None,
                system_cmd: None,
            },
        );
        assert_eq!(lookup_for(&uvx, Some(CustomAgentSource::Registry)), None);
        // A binary whose URL does not carry its version cannot be templated.
        let opaque = meta(
            AgentType::Antigravity,
            binary(
                "1.2.1",
                "https://example.invalid/agent_20260818_01_RC01-darwin-arm64.zip",
            ),
        );
        assert_eq!(lookup_for(&opaque, None), None);
    }
}
