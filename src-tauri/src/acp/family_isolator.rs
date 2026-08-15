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

use crate::acp::custom_registry::{CustomAgentDef, CustomAgentSpec};
use crate::acp::registry::AgentDistribution;
use crate::models::agent::AgentType;

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
            Self::Gemini => "GEMINI_CONFIG_DIR",
            Self::OpenCode => "OPENCODE_CONFIG_DIR",
        }
    }

    /// Official login argv for this family. Used by extra-slot Sign in.
    pub fn login_args(self) -> &'static [&'static str] {
        match self {
            Self::Claude => &["claude", "login"],
            Self::Codex => &["codex", "login"],
            Self::Grok => &["grok", "login"],
            Self::Gemini => &["gemini", "auth"],
            Self::OpenCode => &["opencode", "auth", "login"],
        }
    }

    pub fn default_home(self) -> PathBuf {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        match self {
            Self::Claude => home.join(".claude"),
            Self::Codex => home.join(".codex"),
            Self::Grok => home.join(".grok"),
            Self::Gemini => home.join(".gemini"),
            Self::OpenCode => home.join(".config").join("opencode"),
        }
    }
}

/// Merge every channel env map on a custom-agent spec. Extra slots created
/// through the ACP save path put isolators on `npx.env` (or uvx/binary).
pub fn spec_env_map(spec: &CustomAgentSpec) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    if let Some(npx) = &spec.npx {
        out.extend(npx.env.clone());
    }
    if let Some(uvx) = &spec.uvx {
        out.extend(uvx.env.clone());
    }
    for bin in spec.binary.values() {
        out.extend(bin.env.clone());
    }
    out
}

/// Detect the isolated family home from a launch env map.
///
/// Gemini accepts two official keys: `GEMINI_CONFIG_DIR` is the `.gemini`
/// directory itself; `GEMINI_CLI_HOME` is the parent (we join `.gemini`).
/// Blank values are ignored. Auth-file paths are never returned.
pub fn isolator_from_env(env: &BTreeMap<String, String>) -> Option<(IsolatorFamily, PathBuf)> {
    isolator_from_env_filtered(env, None)
}

fn isolator_from_env_filtered(
    env: &BTreeMap<String, String>,
    only: Option<IsolatorFamily>,
) -> Option<(IsolatorFamily, PathBuf)> {
    // Prefer the explicit config-dir keys. `GEMINI_CLI_HOME` is the parent of
    // the settings directory, so it is consulted after `GEMINI_CONFIG_DIR`.
    let candidates: &[(IsolatorFamily, &str, bool)] = &[
        (IsolatorFamily::Claude, "CLAUDE_CONFIG_DIR", false),
        (IsolatorFamily::Codex, "CODEX_HOME", false),
        (IsolatorFamily::Grok, "GROK_HOME", false),
        (IsolatorFamily::Gemini, "GEMINI_CONFIG_DIR", false),
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
pub fn extra_homes_for_family(
    family: IsolatorFamily,
    defs: &[CustomAgentDef],
) -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for def in defs {
        let env = spec_env_map(&def.spec);
        if let Some((_, home)) = isolator_from_env_filtered(&env, Some(family)) {
            if !is_default_home(family, &home) {
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
    for agent in crate::acp::custom_registry::all() {
        let AgentType::Custom(id) = agent else {
            continue;
        };
        let Some(meta) = crate::acp::custom_registry::get(id) else {
            continue;
        };
        let env = distribution_env(&meta.distribution);
        if let Some((_, home)) = isolator_from_env_filtered(&env, Some(family)) {
            if !is_default_home(family, &home) {
                homes.push(home);
            }
        }
    }
    homes.sort();
    homes.dedup();
    homes
}

/// Official login plan for an extra slot. Never copies tokens.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtraSlotLogin {
    pub family: IsolatorFamily,
    pub isolator_key: &'static str,
    pub home: PathBuf,
    pub args: &'static [&'static str],
}

pub fn login_plan_from_env(env: &BTreeMap<String, String>) -> Option<ExtraSlotLogin> {
    let (family, home) = isolator_from_env(env)?;
    Some(ExtraSlotLogin {
        family,
        isolator_key: family.isolator_key(),
        home,
        args: family.login_args(),
    })
}

pub fn login_plan_from_def(def: &CustomAgentDef) -> Option<ExtraSlotLogin> {
    login_plan_from_env(&spec_env_map(&def.spec))
}

/// Build the command line `open_external_terminal_impl` will run.
/// Rejects newlines in the home path (same rule as the terminal opener).
pub fn shell_export_and_login(plan: &ExtraSlotLogin) -> Result<String, String> {
    let home = plan.home.to_string_lossy();
    if home.contains(['\n', '\r']) || plan.isolator_key.contains(['\n', '\r']) {
        return Err("isolator home must not contain newlines".into());
    }
    let command = plan.args.join(" ");
    if cfg!(windows) {
        Ok(format!(
            "set \"{}={}\"&& {}",
            plan.isolator_key, home, command
        ))
    } else {
        Ok(format!(
            "export {}={} && {}",
            plan.isolator_key,
            shell_single_quote(&home),
            command
        ))
    }
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::custom_registry::{CustomDistributionKind, NpxSpec};

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
            source: Default::default(),
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
        let (family, home) = isolator_from_env(&env).expect("config dir wins");
        assert_eq!(family, IsolatorFamily::Gemini);
        assert_eq!(home, PathBuf::from("/tmp/g"));

        let mut env = BTreeMap::new();
        env.insert("CLAUDE_CONFIG_DIR".into(), "   ".into());
        assert!(isolator_from_env(&env).is_none());
        assert!(isolator_from_env(&BTreeMap::new()).is_none());
    }

    #[test]
    fn extra_homes_for_family_filters_and_skips_default() {
        let defs = vec![
            def_with_env(
                "codex-2",
                BTreeMap::from([("CODEX_HOME".into(), "/p/codex-2".into())]),
            ),
            def_with_env(
                "grok-2",
                BTreeMap::from([("GROK_HOME".into(), "/p/grok-2".into())]),
            ),
            def_with_env(
                "codex-default",
                BTreeMap::from([(
                    "CODEX_HOME".into(),
                    IsolatorFamily::Codex.default_home().to_string_lossy().into(),
                )]),
            ),
        ];
        let homes = extra_homes_for_family(IsolatorFamily::Codex, &defs);
        assert_eq!(homes, vec![PathBuf::from("/p/codex-2")]);
        let grok = extra_homes_for_family(IsolatorFamily::Grok, &defs);
        assert_eq!(grok, vec![PathBuf::from("/p/grok-2")]);
    }

    #[test]
    fn login_plan_sets_isolator_and_official_args() {
        let def = def_with_env(
            "codex-2",
            BTreeMap::from([("CODEX_HOME".into(), "/tmp/c2".into())]),
        );
        let plan = login_plan_from_def(&def).expect("plan");
        assert_eq!(plan.family, IsolatorFamily::Codex);
        assert_eq!(plan.isolator_key, "CODEX_HOME");
        assert_eq!(plan.home, PathBuf::from("/tmp/c2"));
        assert_eq!(plan.args, &["codex", "login"]);
        let cmd = shell_export_and_login(&plan).expect("cmd");
        assert!(cmd.contains("CODEX_HOME"));
        assert!(cmd.contains("codex login"));
        assert!(!cmd.contains('\n'));
    }

    #[test]
    fn shell_export_rejects_newlines_in_home() {
        let plan = ExtraSlotLogin {
            family: IsolatorFamily::Claude,
            isolator_key: "CLAUDE_CONFIG_DIR",
            home: PathBuf::from("/tmp/bad\nhome"),
            args: IsolatorFamily::Claude.login_args(),
        };
        assert!(shell_export_and_login(&plan).is_err());
    }

    #[test]
    fn isolator_never_returns_an_auth_file_path() {
        let mut env = BTreeMap::new();
        env.insert(
            "CLAUDE_CONFIG_DIR".into(),
            "/profiles/claude-2".into(),
        );
        env.insert(
            "ANTHROPIC_AUTH_TOKEN".into(),
            "/profiles/other/auth.json".into(),
        );
        let (_, home) = isolator_from_env(&env).expect("home");
        assert_eq!(home, PathBuf::from("/profiles/claude-2"));
        assert!(!home.ends_with("auth.json"));
    }
}
