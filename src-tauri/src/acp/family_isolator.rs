//! Isolated extra-account homes for built-in agent families.
//!
//! Codeg has one built-in agent per family (`claude_code`, `codex`, …) whose
//! MCP/auth files live in the default home (`~/.claude`, `~/.codex`, …). Extra
//! subscriptions are registered as custom ACP agents whose launch `spec.env`
//! sets that family's official isolator (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, …).
//!
//! Settings → MCP still targets the family row. This module is how writers
//! discover the extra homes so they stay in lock-step without extra checkboxes
//! and without copying `auth.json` / `.credentials.json`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::acp::custom_registry::{CustomAgentDef, CustomAgentSource};
use crate::acp::registry::AgentDistribution;

/// Families whose official CLI honors a home-override env var.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum IsolatorFamily {
    Claude,
    Codex,
    Grok,
    Gemini,
    OpenCode,
}

impl IsolatorFamily {
    pub fn isolator_key(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
            Self::Grok => "GROK_HOME",
            Self::Gemini => "GEMINI_CLI_HOME",
            Self::OpenCode => "OPENCODE_CONFIG_DIR",
        }
    }

    pub fn default_home(self) -> PathBuf {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        match self {
            Self::Claude => home.join(".claude"),
            Self::Codex => home.join(".codex"),
            Self::Grok => home.join(".grok"),
            Self::Gemini => home.join(".gemini"),
            // OpenCode 2's own global directory: `$OPENCODE_CONFIG_DIR`, which
            // replaces the default, else `$XDG_CONFIG_HOME/opencode`.
            Self::OpenCode => crate::acp::opencode_config::config_dir()
                .unwrap_or_else(|| home.join(".config").join("opencode")),
        }
    }
}

/// Only the user-configured launch channel can identify an extra account.
fn manual_launch_env(def: &CustomAgentDef) -> Option<&BTreeMap<String, String>> {
    use crate::acp::custom_registry::CustomDistributionKind;
    if def.source != CustomAgentSource::Manual {
        return None;
    }
    match def.distribution_kind {
        CustomDistributionKind::Npx => Some(&def.spec.npx.as_ref()?.env),
        CustomDistributionKind::Uvx => Some(&def.spec.uvx.as_ref()?.env),
        CustomDistributionKind::Binary => Some(
            &def.spec
                .binary
                .get(crate::acp::registry::current_platform())?
                .env,
        ),
    }
}

/// Detect the isolated family home from a launch env map.
///
/// Gemini uses `GEMINI_CLI_HOME`, the parent of `.gemini`.
/// Blank values are ignored. Auth-file paths are never returned.
pub fn isolator_from_env(env: &BTreeMap<String, String>) -> Option<(IsolatorFamily, PathBuf)> {
    isolator_from_env_filtered(env, None)
}

fn isolator_from_env_filtered(
    env: &BTreeMap<String, String>,
    only: Option<IsolatorFamily>,
) -> Option<(IsolatorFamily, PathBuf)> {
    // GEMINI_CLI_HOME is the parent of the settings directory.
    let candidates: &[(IsolatorFamily, &str, bool)] = &[
        (IsolatorFamily::Claude, "CLAUDE_CONFIG_DIR", false),
        (IsolatorFamily::Codex, "CODEX_HOME", false),
        (IsolatorFamily::Grok, "GROK_HOME", false),
        (IsolatorFamily::Gemini, "GEMINI_CLI_HOME", true),
        (IsolatorFamily::OpenCode, "OPENCODE_CONFIG_DIR", false),
    ];
    for (family, key, join_gemini) in candidates {
        if let Some(only) = only {
            if only != *family {
                continue;
            }
        }
        let Some(raw) = env.get(*key).map(|s| s.trim()).filter(|s| !s.is_empty()) else {
            continue;
        };
        let mut path = PathBuf::from(raw);
        if *join_gemini {
            path.push(".gemini");
        }
        return Some((*family, path));
    }
    None
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn is_default_home(family: IsolatorFamily, home: &Path) -> bool {
    paths_equivalent(home, &family.default_home())
}

/// Extra homes for one family, from already-loaded custom-agent defs. No DB.
pub fn extra_homes_for_family(family: IsolatorFamily, defs: &[CustomAgentDef]) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for def in defs {
        let Some(env) = manual_launch_env(def) else {
            continue;
        };
        if let Some((_, home)) = isolator_from_env_filtered(env, Some(family)) {
            if home.is_absolute() && !is_default_home(family, &home) {
                homes.push(home);
            }
        }
    }
    homes.sort();
    homes.dedup();
    homes
}

fn distribution_env(dist: &AgentDistribution) -> BTreeMap<String, String> {
    let pairs = match dist {
        AgentDistribution::Npx { env, .. }
        | AgentDistribution::Binary { env, .. }
        | AgentDistribution::System { env, .. }
        | AgentDistribution::Uvx { env, .. } => *env,
    };
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

/// Extra homes published in the in-memory custom-agent registry (hydrated
/// from `custom_agent` at boot and after every save). Sync, no DB.
pub fn extra_homes_from_live_registry(family: IsolatorFamily) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for meta in crate::acp::custom_registry::manual_account_candidates() {
        let env = distribution_env(&meta.distribution);
        if let Some((_, home)) = isolator_from_env_filtered(&env, Some(family)) {
            if home.is_absolute() && !is_default_home(family, &home) {
                homes.push(home);
            }
        }
    }
    homes.sort();
    homes.dedup();
    homes
}

#[cfg(test)]
mod tests {
    use super::*;

    /// OpenCode 2's default directory follows `OPENCODE_CONFIG_DIR`: a slot
    /// pointed there shares Default's config, while the fixed path it
    /// replaced is an account of its own.
    #[test]
    fn opencode_default_home_follows_opencode_config_dir() {
        let dir = tempfile::tempdir().unwrap();
        let own = dir.path().join("own-opencode");
        temp_env::with_var("OPENCODE_CONFIG_DIR", Some(&own), || {
            assert!(is_default_home(IsolatorFamily::OpenCode, &own));
            let fixed = dirs::home_dir().unwrap().join(".config").join("opencode");
            assert!(!is_default_home(IsolatorFamily::OpenCode, &fixed));
        });
    }
    use crate::acp::custom_registry::{CustomAgentSpec, CustomDistributionKind, NpxSpec};

    fn def_with_env(id: &str, env: BTreeMap<String, String>) -> CustomAgentDef {
        CustomAgentDef {
            registry_id: id.to_string(),
            name: id.to_string(),
            description: String::new(),
            version: "1.0.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "example@1.0.0".into(),
                    args: Vec::new(),
                    env,
                    cmd: None,
                    node_required: None,
                }),
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: CustomAgentSource::Manual,
            version_probe: None,
            supports_mcp: true,
        }
    }

    #[test]
    fn isolator_from_env_reads_family_keys() {
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".into(), "/tmp/a".into());
        let (family, home) = isolator_from_env(&env).expect("claude");
        assert_eq!(family, IsolatorFamily::Claude);
        assert_eq!(home, PathBuf::from("/tmp/a"));

        let mut env = BTreeMap::new();
        env.insert("GEMINI_CLI_HOME".into(), "/tmp/h".into());
        let (family, home) = isolator_from_env(&env).expect("gemini parent");
        assert_eq!(family, IsolatorFamily::Gemini);
        assert_eq!(home, PathBuf::from("/tmp/h").join(".gemini"));

        let mut env = BTreeMap::new();
        env.insert("GEMINI_CONFIG_DIR".into(), "/tmp/g".into());
        env.insert("GEMINI_CLI_HOME".into(), "/tmp/h".into());
        let (family, home) = isolator_from_env(&env).expect("official home wins");
        assert_eq!(family, IsolatorFamily::Gemini);
        assert_eq!(home, PathBuf::from("/tmp/h").join(".gemini"));
        env.remove("GEMINI_CLI_HOME");
        assert!(isolator_from_env(&env).is_none());

        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".into(), "   ".into());
        assert!(isolator_from_env(&env).is_none());
        assert!(isolator_from_env(&BTreeMap::new()).is_none());
    }

    #[test]
    fn extra_homes_for_family_filters_and_skips_default() {
        let temp = tempfile::tempdir().unwrap();
        let codex_home = temp.path().join("codex-2");
        let grok_home = temp.path().join("grok-2");
        let mut defs = vec![
            def_with_env(
                "codex-2",
                BTreeMap::from([(
                    "CODEX_HOME".into(),
                    codex_home.to_string_lossy().into_owned(),
                )]),
            ),
            def_with_env(
                "grok-2",
                BTreeMap::from([("GROK_HOME".into(), grok_home.to_string_lossy().into_owned())]),
            ),
            def_with_env(
                "codex-default",
                BTreeMap::from([(
                    "CODEX_HOME".into(),
                    IsolatorFamily::Codex
                        .default_home()
                        .to_string_lossy()
                        .into(),
                )]),
            ),
        ];
        let mut from_registry = def_with_env(
            "registry-agent",
            BTreeMap::from([(
                "CODEX_HOME".into(),
                temp.path().join("unrelated").to_string_lossy().into_owned(),
            )]),
        );
        from_registry.source = CustomAgentSource::Registry;
        defs.push(from_registry);
        let homes = extra_homes_for_family(IsolatorFamily::Codex, &defs);
        assert_eq!(homes, vec![codex_home]);
        let grok = extra_homes_for_family(IsolatorFamily::Grok, &defs);
        assert_eq!(grok, vec![grok_home]);
    }

    #[test]
    fn isolator_never_returns_an_auth_file_path() {
        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".into(), "/profiles/claude-2".into());
        env.insert(
            "ANTHROPIC_AUTH_TOKEN".into(),
            "/profiles/other/auth.json".into(),
        );
        let (_, home) = isolator_from_env(&env).expect("home");
        assert_eq!(home, PathBuf::from("/profiles/claude-2"));
        assert!(!home.ends_with("auth.json"));
    }
}
