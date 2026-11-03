//! Built-in accounts select storage, never a different AgentType. Keeping the
//! native type preserves protocol capabilities, steering and transcript parsing.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::models::agent::{AgentType, BUILTIN_AGENT_TYPES};

pub const ACCOUNT_ENV: &str = "CODEG_AGENT_ACCOUNT_ID";
pub const ACCOUNT_HOME_ENV: &str = "CODEG_AGENT_ACCOUNT_HOME";

/// Authentication selectors must not carry Default into a named account.
/// Model preferences are handled separately, so family-wide model discovery
/// still works when it was not installed by a Model Provider binding.
pub(crate) const CLAUDE_AUTH_ENV_KEYS: &[&str] = &[
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_CONFIG_DIR",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "AWS_BEARER_TOKEN_BEDROCK",
];

#[derive(Clone, Copy)]
pub struct AccountLayout {
    pub env_key: &'static str,
    pub config_suffix: &'static str,
    pub transcript_suffix: &'static str,
    pub login: &'static [&'static str],
}

/// Directory layouts come from the native resolvers in `parsers`. Home
/// overrides are applied to the child only; the host process is never changed.
pub fn layout(agent: AgentType) -> Option<AccountLayout> {
    let (env_key, config_suffix, transcript_suffix, login): (_, _, _, &[&str]) = match agent {
        AgentType::ClaudeCode => (
            "CLAUDE_CONFIG_DIR",
            "",
            "projects",
            &["claude", "auth", "login"],
        ),
        AgentType::Codex => ("CODEX_HOME", "", "sessions", &["codex", "login"]),
        AgentType::Grok => ("GROK_HOME", "", "sessions", &["grok", "login"]),
        AgentType::Gemini => ("GEMINI_CLI_HOME", ".gemini", ".gemini", &["gemini"]),
        // OpenCode's config override alone does not isolate auth or history.
        AgentType::OpenCode => (
            "XDG_DATA_HOME",
            "config/opencode",
            "data/opencode",
            &["opencode", "auth", "login"],
        ),
        AgentType::Hermes => ("HERMES_HOME", "", "", &["hermes", "setup"]),
        AgentType::CodeBuddy => ("CODEBUDDY_CONFIG_DIR", "", "projects", &["codebuddy"]),
        AgentType::Cline => ("CLINE_DIR", "", "", &["cline", "auth"]),
        AgentType::KimiCode => ("KIMI_CODE_HOME", "", "sessions", &["kimi", "login"]),
        AgentType::Pi => ("PI_CODING_AGENT_DIR", "", "sessions", &["pi"]),
        AgentType::DeepSeek => ("DSH_HOME", "", "sessions", &["deepseek-acp", "--setup"]),
        AgentType::Qoder => ("QODER_CONFIG_DIR", "", "projects", &["qoder", "login"]),
        AgentType::Antigravity => (
            "GEMINI_HOME",
            "antigravity-acp",
            "antigravity-acp/conversations",
            &[],
        ),
        AgentType::Cursor => (
            "CURSOR_CONFIG_DIR",
            ".cursor",
            ".cursor/chats",
            &["cursor-agent", "login"],
        ),
        AgentType::OpenClaw
        | AgentType::Kiro
        | AgentType::ZCode
        | AgentType::Trae
        | AgentType::CommandCode
        | AgentType::MiniMaxCode
        | AgentType::Custom(_) => return None,
    };
    Some(AccountLayout {
        env_key,
        config_suffix,
        transcript_suffix,
        login,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCapability {
    pub agent_type: AgentType,
    pub supported: bool,
    pub reason: Option<&'static str>,
    pub login_kind: Option<&'static str>,
    pub config_subdir: Option<&'static str>,
    pub can_switch_conversation: bool,
    pub isolates_tool_settings: bool,
    pub auth_methods: Vec<crate::acp::account_auth::AccountAuthMethod>,
    pub can_check_auth: bool,
}

/// Keep storage layouts available for reading older conversations even when
/// this platform cannot safely launch a new named-account session.
pub fn unsupported_reason(agent: AgentType) -> Option<&'static str> {
    match agent {
        AgentType::OpenClaw => Some("Sessions use the configured OpenClaw gateway's account."),
        AgentType::Cursor if cfg!(target_os = "macos") => Some(
            "Named Cursor accounts are not supported on macOS. Use the default Cursor account.",
        ),
        _ if layout(agent).is_none() => {
            Some("Named accounts are not yet supported for this agent.")
        }
        _ => None,
    }
}

pub fn capabilities() -> Vec<AccountCapability> {
    BUILTIN_AGENT_TYPES
        .iter()
        .map(|&agent_type| AccountCapability {
            agent_type,
            auth_methods: if unsupported_reason(agent_type).is_none() {
                crate::acp::account_auth::methods(agent_type).to_vec()
            } else {
                Vec::new()
            },
            can_check_auth: matches!(agent_type, AgentType::ClaudeCode | AgentType::Codex),
            can_switch_conversation: agent_type == AgentType::ClaudeCode,
            isolates_tool_settings: matches!(agent_type, AgentType::OpenCode | AgentType::Cursor),
            supported: unsupported_reason(agent_type).is_none(),
            config_subdir: layout(agent_type)
                .and_then(|spec| (!spec.config_suffix.is_empty()).then_some(spec.config_suffix)),
            login_kind: layout(agent_type)
                .filter(|_| unsupported_reason(agent_type).is_none())
                .map(|spec| {
                    if spec.login.is_empty() {
                        "browser"
                    } else {
                        "terminal"
                    }
                }),
            reason: unsupported_reason(agent_type),
        })
        .collect()
}

pub fn credential_env_keys(agent: AgentType) -> Vec<&'static str> {
    let extra: &[&str] = match agent {
        AgentType::ClaudeCode => CLAUDE_AUTH_ENV_KEYS,
        AgentType::Codex => &["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_CONFIG"],
        AgentType::Grok => &["XAI_API_KEY", "XAI_BASE_URL", "GROK_API_KEY"],
        AgentType::Gemini => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
        ],
        AgentType::Antigravity => &[
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "AGY_AUTH_METHOD",
        ],
        AgentType::CodeBuddy => &["CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN"],
        AgentType::Cline => &[
            "CLINE_API_KEY",
            "CLINE_BASE_URL",
            "CLINE_PROVIDER",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
        ],
        AgentType::KimiCode => &["KIMI_API_KEY", "KIMI_CODE_API_KEY"],
        AgentType::Qoder => &["QODER_PERSONAL_ACCESS_TOKEN"],
        AgentType::DeepSeek => &["DEEPSEEK_API_KEY"],
        AgentType::Cursor => &["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_API_BASE_URL"],
        AgentType::OpenCode | AgentType::Pi | AgentType::Hermes => &[
            "OPENCODE_API_KEY",
            "OPENCODE_GO_API_KEY",
            "ANTHROPIC_API_KEY",
            "OPENAI_API_KEY",
            "OPENROUTER_API_KEY",
            "GEMINI_API_KEY",
            "GOOGLE_API_KEY",
            "XAI_API_KEY",
        ],
        _ => &[],
    };
    let (base_url, credential, model) = crate::commands::acp::agent_env_keys(agent);
    let account_overrides: &[&str] = if agent == AgentType::OpenCode {
        &["OPENCODE_AUTH_CONTENT", "OPENCODE_DB"]
    } else {
        &[]
    };
    // Follow the same provider keys as the settings writer, including less
    // obvious names such as KIMI_MODEL_API_KEY. The native account may restore
    // its own values after this inherited/default-account scrub.
    extra
        .iter()
        .chain(account_overrides.iter())
        .copied()
        .chain([base_url, credential, model])
        .collect()
}

impl AccountLayout {
    pub fn config_dir(self, home: &Path) -> PathBuf {
        home.join(self.config_suffix)
    }
    pub fn transcript_dir(self, home: &Path) -> PathBuf {
        home.join(self.transcript_suffix)
    }
}

pub fn isolation_env(agent: AgentType, home: &Path) -> Result<BTreeMap<String, String>, String> {
    isolation_env_with_base(agent, home, &BTreeMap::new())
}

pub fn isolation_env_with_base(
    agent: AgentType,
    home: &Path,
    base: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    if let Some(reason) = unsupported_reason(agent) {
        return Err(reason.into());
    }
    let layout =
        layout(agent).ok_or_else(|| format!("{agent} does not support isolated accounts"))?;
    if !home.is_absolute() {
        return Err("Choose an absolute account folder".into());
    }
    let mut env = BTreeMap::from([(
        layout.env_key.to_owned(),
        home.to_string_lossy().into_owned(),
    )]);
    if agent == AgentType::ClaudeCode {
        // Anthropic profiles live outside CLAUDE_CONFIG_DIR unless this is
        // explicit. An ambient active federation profile can outrank /login.
        env.insert(
            "ANTHROPIC_CONFIG_DIR".into(),
            home.join("anthropic").to_string_lossy().into_owned(),
        );
    }
    if agent == AgentType::OpenCode {
        for (key, suffix) in [
            ("XDG_CONFIG_HOME", "config"),
            ("XDG_DATA_HOME", "data"),
            ("XDG_STATE_HOME", "state"),
            ("XDG_CACHE_HOME", "cache"),
            ("OPENCODE_CONFIG_DIR", "config/opencode"),
        ] {
            env.insert(key.into(), home.join(suffix).to_string_lossy().into_owned());
        }
        // XDG roots isolate OpenCode's auth, state and config. Keep the user's
        // home for shell tools such as git, cargo and npm launched by the agent.
        env.insert("OPENCODE_CONFIG".into(), String::new());
        env.insert("OPENCODE_CONFIG_CONTENT".into(), String::new());
        env.insert("OPENCODE_MODELS_PATH".into(), String::new());
        // A blank launch value removes the inherited variable at spawn.
        env.insert("OPENCODE_AUTH_CONTENT".into(), String::new());
        env.insert("OPENCODE_DB".into(), String::new());
    }
    if agent == AgentType::Cline {
        env.insert(
            "CLINE_PROVIDER_SETTINGS_PATH".into(),
            home.join("settings/providers.json")
                .to_string_lossy()
                .into_owned(),
        );
    }
    if agent == AgentType::Pi {
        env.insert(
            "PI_CODING_AGENT_SESSION_DIR".into(),
            layout.transcript_dir(home).to_string_lossy().into_owned(),
        );
    }
    if agent == AgentType::DeepSeek {
        env.insert(
            "DEEPSEEK_ACP_SESSIONS_ROOT".into(),
            layout.transcript_dir(home).to_string_lossy().into_owned(),
        );
    }
    if agent == AgentType::Antigravity {
        env.insert("AGY_ACP_FORCE_FILE_STORAGE".into(), "1".into());
    }
    if agent == AgentType::Cursor {
        // CURSOR_CONFIG_DIR moves chats/config, but not credentials. Cursor's
        // file credential store uses APPDATA on Windows and XDG_CONFIG_HOME
        // on Linux. macOS requires replacing HOME, so named-account launches
        // are refused above; changing HOME would also redirect terminal tools.
        env.insert(
            "CURSOR_CONFIG_DIR".into(),
            home.join(".cursor").to_string_lossy().into_owned(),
        );
        env.insert("AGENT_CLI_CREDENTIAL_STORE".into(), "file".into());
        if cfg!(windows) {
            env.insert(
                "APPDATA".into(),
                home.join("appdata").to_string_lossy().into_owned(),
            );
        } else {
            env.insert(
                "XDG_CONFIG_HOME".into(),
                home.join(".config").to_string_lossy().into_owned(),
            );
        }
    }
    if matches!(agent, AgentType::OpenCode | AgentType::Cursor) {
        // gh follows XDG_CONFIG_HOME before APPDATA/HOME. Pin the folder it
        // would have used before changing the agent's roots, honoring both
        // saved launch settings and an explicit GH_CONFIG_DIR. No files move.
        if let Some(path) = github_config_dir(base) {
            env.insert("GH_CONFIG_DIR".into(), path.to_string_lossy().into_owned());
        }
    }
    Ok(env)
}

fn github_config_dir(env: &BTreeMap<String, String>) -> Option<PathBuf> {
    env_path(env, "GH_CONFIG_DIR")
        .or_else(|| env_path(env, "XDG_CONFIG_HOME").map(|path| path.join("gh")))
        .or_else(|| {
            cfg!(windows)
                .then(|| env_path(env, "APPDATA").map(|path| path.join("GitHub CLI")))
                .flatten()
        })
        .or_else(|| {
            crate::acp::file_system_runtime::child_home_dir(env)
                .map(|home| home.join(".config/gh"))
        })
}

/// Native choices in this account outrank the family's default launch choices.
pub fn apply_native_account_env(agent: AgentType, home: &Path, env: &mut BTreeMap<String, String>) {
    if agent != AgentType::Antigravity {
        return;
    }
    let path = home.join("antigravity-acp/settings.json");
    let Some(value) = std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
    else {
        return;
    };
    for (pointer, key) in [
        ("/auth/type", "AGY_AUTH_METHOD"),
        ("/gcp/project", "GOOGLE_CLOUD_PROJECT"),
        ("/gcp/location", "GOOGLE_CLOUD_LOCATION"),
    ] {
        if let Some(value) = value.pointer(pointer).and_then(serde_json::Value::as_str) {
            env.insert(key.into(), value.into());
        }
    }
}

fn env_path(env: &BTreeMap<String, String>, key: &str) -> Option<PathBuf> {
    match env.get(key) {
        Some(value) => (!value.is_empty()).then(|| PathBuf::from(value)),
        None => std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    crate::parsers::path_eq_for_matching(&a.to_string_lossy(), &b.to_string_lossy())
        || matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

fn storage_roots(agent: AgentType, env: &BTreeMap<String, String>) -> Vec<PathBuf> {
    let mut roots = crate::acp::file_system_runtime::agent_data_roots(agent, env);
    let child_home = crate::acp::file_system_runtime::child_home_dir(env).unwrap_or_default();
    if agent == AgentType::OpenCode {
        roots.push(env_path(env, "OPENCODE_CONFIG_DIR").unwrap_or_else(|| {
            env_path(env, "XDG_CONFIG_HOME")
                .unwrap_or_else(|| child_home.join(".config"))
                .join("opencode")
        }));
    }
    if agent == AgentType::Cursor {
        roots.push(if cfg!(windows) {
            env_path(env, "APPDATA")
                .unwrap_or_else(|| child_home.join("AppData/Roaming"))
                .join("Cursor")
        } else if cfg!(target_os = "macos") {
            child_home.join(".cursor")
        } else {
            env_path(env, "XDG_CONFIG_HOME")
                .unwrap_or_else(|| child_home.join(".config"))
                .join("cursor")
        });
    }
    roots
}

pub fn aliases_default_account(
    agent: AgentType,
    home: &Path,
    default_env: &BTreeMap<String, String>,
) -> bool {
    if home.parent().is_none() || dirs::home_dir().is_some_and(|default| same_path(home, &default))
    {
        return true;
    }
    let Ok(account_env) = isolation_env(agent, home) else {
        return true;
    };
    let defaults = storage_roots(agent, default_env);
    storage_roots(agent, &account_env)
        .iter()
        .any(|root| defaults.iter().any(|default| same_path(root, default)))
}

/// A storage identity also covers the old custom-account wrappers. It is used
/// only to prevent two processes writing one native session, never to grant a
/// custom agent native capabilities or to rebind an existing conversation.
pub fn storage_identity(
    agent: AgentType,
    env: &BTreeMap<String, String>,
) -> Option<(AgentType, PathBuf)> {
    if let AgentType::Custom(id) = agent {
        use crate::acp::family_isolator::{self, IsolatorFamily};
        let meta = crate::acp::custom_registry::get(id)?;
        let mut values = family_isolator::distribution_env(&meta.distribution);
        values.extend(env.clone());
        let (family, _) = family_isolator::isolator_from_env(&values)?;
        let native = match family {
            IsolatorFamily::Claude => AgentType::ClaudeCode,
            IsolatorFamily::Codex => AgentType::Codex,
            IsolatorFamily::Grok => AgentType::Grok,
            IsolatorFamily::Gemini => AgentType::Gemini,
            IsolatorFamily::OpenCode => AgentType::OpenCode,
        };
        return storage_identity(native, &values);
    }
    layout(agent)?;
    let roots = crate::acp::file_system_runtime::agent_data_roots(agent, env);
    let mut root = if matches!(agent, AgentType::Pi | AgentType::DeepSeek) {
        roots.last()?.clone()
    } else {
        roots.first()?.clone()
    };
    if agent == AgentType::Antigravity {
        root.push("antigravity-acp");
    }
    Some((agent, root))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_builtin_has_an_explicit_account_capability() {
        let rows = capabilities();
        assert_eq!(rows.len(), BUILTIN_AGENT_TYPES.len());
        for row in rows {
            assert_eq!(row.supported, row.reason.is_none());
        }
    }

    #[test]
    fn accounts_keep_the_native_type_and_separate_homes() {
        let dir = tempfile::tempdir().unwrap();
        for &agent in BUILTIN_AGENT_TYPES {
            if unsupported_reason(agent).is_some() {
                continue;
            }
            let Some(layout) = layout(agent) else {
                continue;
            };
            let a = dir.path().join("a");
            let b = dir.path().join("b");
            let env_a = isolation_env(agent, &a).unwrap();
            let env_b = isolation_env(agent, &b).unwrap();
            assert_ne!(env_a, env_b, "{agent}");
            assert!(layout.transcript_dir(&a).starts_with(&a));
            assert!(layout.config_dir(&b).starts_with(&b));
            assert!(!agent.is_custom());
        }
    }

    #[test]
    fn opencode_isolates_credentials_as_well_as_configuration() {
        let dir = tempfile::tempdir().unwrap();
        let env = isolation_env(AgentType::OpenCode, dir.path()).unwrap();
        assert!(!env.contains_key("HOME"));
        assert!(!env.contains_key("USERPROFILE"));
        assert_eq!(env.get("OPENCODE_AUTH_CONTENT").map(String::as_str), Some(""));
        assert_eq!(env.get("OPENCODE_DB").map(String::as_str), Some(""));
        assert_eq!(
            PathBuf::from(&env["XDG_DATA_HOME"]),
            dir.path().join("data")
        );
        assert_eq!(
            PathBuf::from(&env["OPENCODE_CONFIG_DIR"]),
            dir.path().join("config/opencode")
        );
    }

    #[test]
    fn account_isolation_keeps_the_original_github_cli_config() {
        let dir = tempfile::tempdir().unwrap();
        let inherited = dir.path().join("original-xdg");
        let explicit = dir.path().join("explicit-gh");
        let mut base = BTreeMap::from([
            ("GH_CONFIG_DIR".into(), String::new()),
            ("XDG_CONFIG_HOME".into(), inherited.to_string_lossy().into_owned()),
        ]);
        for agent in [AgentType::OpenCode, AgentType::Cursor] {
            if unsupported_reason(agent).is_some() { continue; }
            let isolated = isolation_env_with_base(agent, &dir.path().join("account"), &base).unwrap();
            assert_eq!(PathBuf::from(&isolated["GH_CONFIG_DIR"]), inherited.join("gh"));
        }
        base.insert("GH_CONFIG_DIR".into(), explicit.to_string_lossy().into_owned());
        let isolated = isolation_env_with_base(AgentType::OpenCode, dir.path(), &base).unwrap();
        assert_eq!(PathBuf::from(&isolated["GH_CONFIG_DIR"]), explicit);
    }

    #[test]
    fn cursor_relocates_its_credential_store_not_only_its_config() {
        let dir = tempfile::tempdir().unwrap();
        if cfg!(target_os = "macos") {
            let error = isolation_env(AgentType::Cursor, dir.path()).unwrap_err();
            assert!(error.contains("default Cursor account"));
            let capability = capabilities()
                .into_iter()
                .find(|row| row.agent_type == AgentType::Cursor)
                .unwrap();
            assert!(!capability.supported);
            assert!(capability.login_kind.is_none());
            // Existing account transcripts remain readable on every platform.
            assert!(layout(AgentType::Cursor).is_some());
            return;
        }
        let env = isolation_env(AgentType::Cursor, dir.path()).unwrap();
        assert!(!env.contains_key("HOME"));
        assert!(!env.contains_key("USERPROFILE"));
        assert_eq!(env["AGENT_CLI_CREDENTIAL_STORE"], "file");
        assert_eq!(
            PathBuf::from(&env["CURSOR_CONFIG_DIR"]),
            dir.path().join(".cursor")
        );
        let key = if cfg!(windows) {
            "APPDATA"
        } else {
            "XDG_CONFIG_HOME"
        };
        assert!(PathBuf::from(&env[key]).starts_with(dir.path()));
    }

    #[test]
    fn configured_default_home_cannot_be_added_as_an_extra_account() {
        let dir = tempfile::tempdir().unwrap();
        let main = dir.path().join("main");
        let work = dir.path().join("work");
        std::fs::create_dir_all(&main).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        let env = BTreeMap::from([("CODEX_HOME".into(), main.display().to_string())]);
        assert!(aliases_default_account(AgentType::Codex, &main, &env));
        assert!(!aliases_default_account(AgentType::Codex, &work, &env));
    }

    #[test]
    fn native_account_launch_permissions_follow_the_selected_home() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first");
        let second = dir.path().join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        std::fs::write(
            first.join("config.toml"),
            "sandbox_mode = 'read-only'\n[ui]\npermission_mode = 'plan'\n",
        )
        .unwrap();
        std::fs::write(second.join("config.toml"), "sandbox_mode = 'danger-full-access'\napproval_policy = 'never'\n[ui]\npermission_mode = 'acceptEdits'\n").unwrap();
        assert_eq!(
            crate::commands::acp::codex_launch_initial_agent_mode(
                &isolation_env(AgentType::Codex, &first).unwrap()
            )
            .as_deref(),
            Some("read-only")
        );
        assert_eq!(
            crate::commands::acp::codex_launch_initial_agent_mode(
                &isolation_env(AgentType::Codex, &second).unwrap()
            )
            .as_deref(),
            Some("agent-full-access")
        );
        assert_eq!(
            crate::commands::acp::grok_launch_permission_mode(
                &isolation_env(AgentType::Grok, &first).unwrap()
            )
            .as_deref(),
            Some("plan")
        );
        assert_eq!(
            crate::commands::acp::grok_launch_permission_mode(
                &isolation_env(AgentType::Grok, &second).unwrap()
            )
            .as_deref(),
            Some("acceptEdits")
        );
    }

    #[test]
    fn native_history_and_titles_stay_in_the_selected_account() {
        use serde_json::json;
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let empty = dir.path().join("default");
        std::fs::create_dir_all(&empty).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        for (home, text) in [(&a, "alpha account"), (&b, "beta account")] {
            std::fs::create_dir_all(home.join("projects/work")).unwrap();
            std::fs::create_dir_all(home.join("sessions/2026/10/11")).unwrap();
            let claude = json!({"type":"user", "timestamp":"2026-10-11T00:00:00Z", "uuid":"u1", "cwd":"/project", "message":{"role":"user","content":text}});
            std::fs::write(
                home.join("projects/work").join(format!("{session}.jsonl")),
                format!("{claude}\n"),
            )
            .unwrap();
            let header = json!({"type":"session_meta", "timestamp":"2026-10-11T00:00:00Z", "payload":{"id":session,"cwd":"/project"}});
            let prompt = json!({"type":"event_msg", "timestamp":"2026-10-11T00:00:01Z", "payload":{"type":"user_message","message":text}});
            std::fs::write(
                home.join("sessions/2026/10/11")
                    .join(format!("rollout-2026-10-11T00-00-00-{session}.jsonl")),
                format!("{header}\n{prompt}\n"),
            )
            .unwrap();
            std::fs::write(
                home.join("session_index.jsonl"),
                format!("{}\n", json!({"id":session,"thread_name":text})),
            )
            .unwrap();
        }
        {
            for agent in [AgentType::ClaudeCode, AgentType::Codex] {
                for (home, wanted, other) in [
                    (&a, "alpha account", "beta account"),
                    (&b, "beta account", "alpha account"),
                ] {
                    let detail = crate::parsers::build_account_parser(agent, Some(home), &crate::parsers::AgentEnv::inherited())
                        .unwrap()
                        .get_conversation(&session)
                        .unwrap();
                    let text = serde_json::to_string(&detail).unwrap();
                    assert!(text.contains(wanted), "{agent}");
                    assert!(!text.contains(other), "{agent}");
                }
                assert!(crate::parsers::build_account_parser(agent, Some(&empty), &crate::parsers::AgentEnv::inherited())
                    .unwrap()
                    .get_conversation(&session)
                    .is_err());
            }
        }
    }

    #[test]
    fn antigravity_database_reader_uses_the_account_store() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("a");
        let other = dir.path().join("b");
        let store = home.join("antigravity-acp/conversations");
        std::fs::create_dir_all(&store).unwrap();
        std::fs::write(
            store.join("agy-fixture-001.db"),
            include_bytes!("../../tests/fixtures/antigravity/agy-fixture-001.db"),
        )
        .unwrap();
        std::fs::write(
            store.join("agy-fixture-001.meta"),
            include_bytes!("../../tests/fixtures/antigravity/agy-fixture-001.meta"),
        )
        .unwrap();
        assert!(
            !crate::parsers::build_account_parser(AgentType::Antigravity, Some(&home), &crate::parsers::AgentEnv::inherited())
                .unwrap()
                .list_conversations()
                .unwrap()
                .is_empty()
        );
        assert!(
            crate::parsers::build_account_parser(AgentType::Antigravity, Some(&other), &crate::parsers::AgentEnv::inherited())
                .unwrap()
                .list_conversations()
                .unwrap()
                .is_empty()
        );
    }
}
