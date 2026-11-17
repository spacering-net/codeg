//! What the engine knows about each agent: where its MCP servers live, what
//! the file is, which transports it can hold, how they reach a session, and
//! how the agent itself turns a server off.
//!
//! **Paths** follow the environment codeg launches the agent with
//! ([`AgentEnv`]: the agent settings' `env_json` laid over codeg's own), so a
//! `CODEX_HOME`, `CLAUDE_CONFIG_DIR` or `GROK_HOME` set there moves the file
//! codeg reads and writes along with the one the agent uses. Each rule is the
//! agent's own, through the same resolvers the history parsers use.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::commands::mcp::McpAppType;
use crate::models::agent::AgentType;
use crate::parsers::{AgentEnv, AgentEnvs};

use super::model::{McpConfigFormat, McpDelivery, McpTransport};

const ALL_TRANSPORTS: &[McpTransport] =
    &[McpTransport::Stdio, McpTransport::Http, McpTransport::Sse];
const NO_SSE: &[McpTransport] = &[McpTransport::Stdio, McpTransport::Http];
const STDIO_ONLY: &[McpTransport] = &[McpTransport::Stdio];

/// A boolean on the entry that turns it off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct EntryFlag {
    pub key: &'static str,
    /// The value that means "off": `true` for `disabled`, `false` for
    /// `enabled`.
    pub off: bool,
}

/// How an agent turns one of its servers off without deleting it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(crate) struct DisableFlag {
    pub entry: Option<EntryFlag>,
    /// A list of server names at the root of the document that are off.
    pub root_list: Option<&'static str>,
}

impl DisableFlag {
    const NONE: Self = Self {
        entry: None,
        root_list: None,
    };

    const fn disabled_true() -> Self {
        Self {
            entry: Some(EntryFlag {
                key: "disabled",
                off: true,
            }),
            root_list: None,
        }
    }

    const fn enabled_false() -> Self {
        Self {
            entry: Some(EntryFlag {
                key: "enabled",
                off: false,
            }),
            root_list: None,
        }
    }

    pub fn is_supported(&self) -> bool {
        self.entry.is_some() || self.root_list.is_some()
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AgentSpec {
    pub app: McpAppType,
    pub transports: &'static [McpTransport],
    pub delivery: McpDelivery,
    pub disable: DisableFlag,
    /// The agent manages the file itself: codeg lists it and writes nothing.
    pub scan_only: bool,
}

impl AgentSpec {
    pub fn supports(&self, transport: McpTransport) -> bool {
        self.transports.contains(&transport)
    }
}

/// Every agent the engine knows, in the order the inventory lists them.
pub(crate) fn all_apps() -> &'static [McpAppType] {
    &crate::commands::mcp::ALL_MCP_APPS
}

pub(crate) fn spec(app: McpAppType) -> AgentSpec {
    use McpDelivery::{AgentFile, CodegSession};
    let (transports, delivery, disable, scan_only) = match app {
        // No flag on a user-scope entry: Claude Code keeps its switches per
        // project.
        McpAppType::ClaudeCode => (ALL_TRANSPORTS, CodegSession, DisableFlag::NONE, false),
        // `enabled = false`; no SSE transport in config.toml.
        McpAppType::Codex => (NO_SSE, CodegSession, DisableFlag::enabled_false(), false),
        // Its switches live in a file of their own
        // (`mcp-server-enablement.json`), and an entry takes no key the
        // settings schema does not list.
        McpAppType::Gemini => (ALL_TRANSPORTS, CodegSession, DisableFlag::NONE, false),
        McpAppType::OpenClaw => (ALL_TRANSPORTS, AgentFile, DisableFlag::NONE, true),
        // `disabled: true`; OpenCode 2 has no SSE client.
        McpAppType::OpenCode => (NO_SSE, AgentFile, DisableFlag::disabled_true(), false),
        McpAppType::Cline => (
            ALL_TRANSPORTS,
            AgentFile,
            DisableFlag::disabled_true(),
            false,
        ),
        McpAppType::Hermes => (
            ALL_TRANSPORTS,
            AgentFile,
            DisableFlag::enabled_false(),
            false,
        ),
        // A list of names beside `mcpServers`, not a key on the entry.
        McpAppType::CodeBuddy => (
            ALL_TRANSPORTS,
            CodegSession,
            DisableFlag {
                entry: None,
                root_list: Some("disabledMcpServers"),
            },
            false,
        ),
        McpAppType::KimiCode => (
            ALL_TRANSPORTS,
            AgentFile,
            DisableFlag::enabled_false(),
            false,
        ),
        // Both: `grok mcp disable` writes the entry's `enabled` and the
        // root `disabled_mcp_servers`, and either one turns the server off.
        McpAppType::Grok => (
            ALL_TRANSPORTS,
            AgentFile,
            DisableFlag {
                entry: Some(EntryFlag {
                    key: "enabled",
                    off: false,
                }),
                root_list: Some("disabled_mcp_servers"),
            },
            false,
        ),
        McpAppType::Cursor => (ALL_TRANSPORTS, AgentFile, DisableFlag::NONE, false),
        // codeg's own record of what to send: the flag is codeg's to define.
        // The bridge rejects SSE outright.
        McpAppType::DeepSeek => (NO_SSE, CodegSession, DisableFlag::disabled_true(), false),
        McpAppType::Qoder => (
            ALL_TRANSPORTS,
            AgentFile,
            DisableFlag::disabled_true(),
            false,
        ),
        McpAppType::Antigravity => (ALL_TRANSPORTS, AgentFile, DisableFlag::NONE, false),
        McpAppType::Kiro => (NO_SSE, AgentFile, DisableFlag::disabled_true(), false),
        // A third-party pi extension reads this file; pi itself has no MCP.
        McpAppType::Pi => (ALL_TRANSPORTS, AgentFile, DisableFlag::NONE, true),
        McpAppType::ZCode => (
            STDIO_ONLY,
            CodegSession,
            DisableFlag::disabled_true(),
            false,
        ),
        McpAppType::Trae => (NO_SSE, AgentFile, DisableFlag::enabled_false(), false),
        McpAppType::CommandCode => (NO_SSE, AgentFile, DisableFlag::enabled_false(), false),
        McpAppType::MiniMaxCode => (
            ALL_TRANSPORTS,
            CodegSession,
            DisableFlag::disabled_true(),
            false,
        ),
    };
    AgentSpec {
        app,
        transports,
        delivery,
        disable,
        scan_only,
    }
}

pub(crate) fn agent_type_of(app: McpAppType) -> AgentType {
    match app {
        McpAppType::ClaudeCode => AgentType::ClaudeCode,
        McpAppType::Codex => AgentType::Codex,
        McpAppType::Gemini => AgentType::Gemini,
        McpAppType::OpenClaw => AgentType::OpenClaw,
        McpAppType::OpenCode => AgentType::OpenCode,
        McpAppType::Cline => AgentType::Cline,
        McpAppType::Hermes => AgentType::Hermes,
        McpAppType::CodeBuddy => AgentType::CodeBuddy,
        McpAppType::KimiCode => AgentType::KimiCode,
        McpAppType::Grok => AgentType::Grok,
        McpAppType::Cursor => AgentType::Cursor,
        McpAppType::DeepSeek => AgentType::DeepSeek,
        McpAppType::Qoder => AgentType::Qoder,
        McpAppType::Antigravity => AgentType::Antigravity,
        McpAppType::Kiro => AgentType::Kiro,
        McpAppType::Pi => AgentType::Pi,
        McpAppType::ZCode => AgentType::ZCode,
        McpAppType::Trae => AgentType::Trae,
        McpAppType::CommandCode => AgentType::CommandCode,
        McpAppType::MiniMaxCode => AgentType::MiniMaxCode,
    }
}

/// The MCP app of a built-in agent; `None` for a custom agent, whose config
/// files codeg knows nothing about.
pub(crate) fn app_of(agent_type: AgentType) -> Option<McpAppType> {
    all_apps()
        .iter()
        .copied()
        .find(|app| agent_type_of(*app) == agent_type)
}

/// The agent's name on the wire and on disk (`claude_code`, `codex`, …).
pub(crate) fn wire_name(app: McpAppType) -> String {
    agent_type_of(app).as_wire().into_owned()
}

/// The files of one agent the engine reads and writes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct AgentPaths {
    /// The file the agent's servers are in.
    pub servers: PathBuf,
    /// Claude Code's and CodeBuddy's `settings.json`, whose `enabledPlugins`
    /// holds `<name>@local` for every user server codeg wrote.
    pub plugin_gate: Option<PathBuf>,
}

fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

/// `~/.codeg` under the real user home — not `CODEG_HOME` or the data
/// directory. The MCP write lock and the pre-write copies are per user, shared
/// by every codeg that user runs (see [`super::lock`]).
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn real_codeg_dir() -> PathBuf {
    home_dir().join(".codeg")
}

/// Claude Code's global config (`getGlobalClaudeFile` in its bundle, checked
/// against 2.1.185): `<config dir>/.config.json` when that legacy file exists,
/// else `.claude.json` under `CLAUDE_CONFIG_DIR`, or under the home directory
/// when the variable is unset.
fn claude_servers_path(env: &AgentEnv) -> PathBuf {
    let config_dir = crate::parsers::claude::resolve_claude_config_dir_for_env(env);
    let legacy = config_dir.join(".config.json");
    if legacy.exists() {
        return legacy;
    }
    env.var_os("CLAUDE_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(home_dir)
        .join(".claude.json")
}

/// CodeBuddy's user-scope MCP file (`PathUtils.getMcpCandidatePaths` in its
/// bundle, checked against 2.155.0): the first that exists of
/// `<home>/.mcp.json`, `<home>/mcp.json` and `<base>/.codebuddy.json`, where
/// `<home>` is `CODEBUDDY_CONFIG_DIR` or `~/.codebuddy` and `<base>` is
/// `CODEBUDDY_CONFIG_DIR` or `~`. With none there, codeg writes the last one:
/// every CodeBuddy release reads it.
fn codebuddy_servers_path(env: &AgentEnv) -> PathBuf {
    let home = crate::parsers::codebuddy::resolve_codebuddy_config_dir_for_env(env);
    let base = env
        .var_os("CODEBUDDY_CONFIG_DIR")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(home_dir);
    let candidates = [
        home.join(".mcp.json"),
        home.join("mcp.json"),
        base.join(".codebuddy.json"),
    ];
    let fallback = candidates[2].clone();
    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or(fallback)
}

/// Cline's MCP settings (`cline` 3.0.62): `CLINE_MCP_SETTINGS_PATH`, else
/// `<data dir>/settings/cline_mcp_settings.json`.
fn cline_servers_path(env: &AgentEnv) -> PathBuf {
    if let Some(explicit) = env
        .var("CLINE_MCP_SETTINGS_PATH")
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        return PathBuf::from(explicit);
    }
    crate::parsers::cline::cline_data_dir_for_env(env)
        .join("settings")
        .join("cline_mcp_settings.json")
}

fn opencode_servers_path(env: &AgentEnv) -> PathBuf {
    use crate::acp::opencode_config;
    match opencode_config::config_dir_for_env(env) {
        Some(dir) => opencode_config::config_file_in(&dir),
        None => home_dir()
            .join(".config")
            .join("opencode")
            .join(opencode_config::CONFIG_FILE_NAMES[0]),
    }
}

/// codeg's own MCP stores for the agents that take servers only from the
/// session: beside the ACP transcripts, under the data directory.
fn codeg_store(file: &str) -> PathBuf {
    crate::paths::codeg_acp_transcripts_root()
        .with_file_name("mcp")
        .join(file)
}

/// Where `app`'s servers are for an agent launched with `env`.
pub(crate) fn resolve_paths(app: McpAppType, env: &AgentEnv) -> AgentPaths {
    let mut plugin_gate = None;
    let servers = match app {
        McpAppType::ClaudeCode => {
            plugin_gate = Some(
                crate::parsers::claude::resolve_claude_config_dir_for_env(env)
                    .join("settings.json"),
            );
            claude_servers_path(env)
        }
        McpAppType::CodeBuddy => {
            plugin_gate = Some(
                crate::parsers::codebuddy::resolve_codebuddy_config_dir_for_env(env)
                    .join("settings.json"),
            );
            codebuddy_servers_path(env)
        }
        McpAppType::Codex => {
            crate::parsers::codex::resolve_codex_home_dir_for_env(env).join("config.toml")
        }
        McpAppType::Gemini => {
            crate::parsers::gemini::resolve_gemini_base_dir_for_env(env).join("settings.json")
        }
        // No override followed: the history parser reads a fixed
        // `~/.openclaw` too.
        McpAppType::OpenClaw => home_dir().join(".openclaw").join("openclaw.json"),
        McpAppType::OpenCode => opencode_servers_path(env),
        McpAppType::Cline => cline_servers_path(env),
        McpAppType::Hermes => {
            crate::parsers::hermes::resolve_hermes_home_dir_for_env(env).join("config.yaml")
        }
        McpAppType::KimiCode => {
            crate::parsers::kimi_code::resolve_kimi_code_home_dir_for_env(env).join("mcp.json")
        }
        McpAppType::Grok => {
            crate::parsers::grok::resolve_grok_home_dir_for_env(env).join("config.toml")
        }
        // The CLI reads its user-level MCP config from a hardcoded
        // `~/.cursor/mcp.json`, wherever `CURSOR_CONFIG_DIR` puts the rest.
        McpAppType::Cursor => home_dir().join(".cursor").join("mcp.json"),
        McpAppType::DeepSeek => {
            crate::parsers::deepseek::resolve_dsh_home_dir_for_env(env).join("mcp.json")
        }
        McpAppType::Qoder => {
            crate::parsers::qoder::resolve_qoder_config_dir_for_env(env).join("settings.json")
        }
        McpAppType::Antigravity => crate::parsers::antigravity::resolve_gemini_home_for_env(env)
            .join("config")
            .join("mcp_config.json"),
        McpAppType::Kiro => crate::parsers::kiro::resolve_kiro_home_dir_for_env(env)
            .join("settings")
            .join("mcp.json"),
        McpAppType::Pi => crate::parsers::pi::resolve_pi_agent_dir_for_env(env).join("mcp.json"),
        McpAppType::ZCode => codeg_store("zcode.json"),
        McpAppType::Trae => {
            crate::acp::trae::resolve_trae_home_dir_for_env(env).join("traecli.toml")
        }
        McpAppType::CommandCode => crate::acp::command_code::command_code_mcp_json_path(),
        McpAppType::MiniMaxCode => crate::acp::minimax_code::mcp_json_path(),
    };
    AgentPaths {
        servers,
        plugin_gate,
    }
}

/// The format of `app`'s servers file at `path`.
pub(crate) fn format_of(app: McpAppType, path: &std::path::Path) -> McpConfigFormat {
    match app {
        McpAppType::Codex | McpAppType::Trae | McpAppType::Grok => McpConfigFormat::Toml,
        McpAppType::Hermes => McpConfigFormat::Yaml,
        McpAppType::OpenCode
            if path
                .extension()
                .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonc")) =>
        {
            McpConfigFormat::Jsonc
        }
        _ => McpConfigFormat::Json,
    }
}

/// Everything a run of the engine needs to know about its surroundings, so a
/// test can point all of it at a temp directory.
#[derive(Debug, Clone)]
pub(crate) struct EngineCtx {
    pub paths: BTreeMap<McpAppType, AgentPaths>,
    /// The MCP write lock file.
    pub lock_path: PathBuf,
    /// `<backup_root>/<agent>/` holds the copies taken before each write.
    pub backup_root: PathBuf,
    /// How long a save waits for the MCP write lock.
    pub lock_wait: std::time::Duration,
}

/// `~/.codeg/mcp/backups` under the real user home. Out of codeg's own backup
/// on purpose (`commands::backup::sections`): the copies hold tokens.
pub(crate) fn default_backup_root() -> PathBuf {
    #[cfg(test)]
    {
        std::env::temp_dir().join(format!("codeg-test-mcp-backups-{}", std::process::id()))
    }
    #[cfg(not(test))]
    {
        real_codeg_dir().join("mcp").join("backups")
    }
}

impl EngineCtx {
    /// The engine as it runs for real: every agent's file where its launch
    /// environment puts it.
    pub fn from_envs(envs: &AgentEnvs) -> Self {
        let paths = all_apps()
            .iter()
            .map(|app| (*app, resolve_paths(*app, &envs.get(agent_type_of(*app)))))
            .collect();
        Self {
            paths,
            lock_path: super::lock::default_lock_path(),
            backup_root: default_backup_root(),
            lock_wait: super::lock::LOCK_WAIT,
        }
    }

    pub fn paths_of(&self, app: McpAppType) -> Option<&AgentPaths> {
        self.paths.get(&app)
    }

    pub fn backup_dir(&self, app: McpAppType) -> PathBuf {
        self.backup_root.join(wire_name(app))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> AgentEnv {
        AgentEnv::with_overrides(pairs)
    }

    #[test]
    fn every_app_names_its_agent_type() {
        for app in all_apps() {
            assert_eq!(app_of(agent_type_of(*app)), Some(*app));
            assert_eq!(
                serde_json::to_value(app).unwrap(),
                serde_json::Value::String(wire_name(*app)),
                "the app's serialized name is its agent's wire name"
            );
        }
        assert_eq!(app_of(AgentType::Custom("something")), None);
    }

    /// A relocation set in the agent's own settings moves the file codeg
    /// reads and writes with it.
    #[test]
    fn paths_follow_the_environment_the_agent_is_launched_with() {
        let cases: &[(McpAppType, &str, &str, &str)] = &[
            (
                McpAppType::Codex,
                "CODEX_HOME",
                "/srv/codex",
                "/srv/codex/config.toml",
            ),
            (
                McpAppType::Grok,
                "GROK_HOME",
                "/srv/grok",
                "/srv/grok/config.toml",
            ),
            (
                McpAppType::Hermes,
                "HERMES_HOME",
                "/srv/hermes",
                "/srv/hermes/config.yaml",
            ),
            (
                McpAppType::KimiCode,
                "KIMI_CODE_HOME",
                "/srv/kimi",
                "/srv/kimi/mcp.json",
            ),
            (
                McpAppType::Kiro,
                "KIRO_HOME",
                "/srv/kiro",
                "/srv/kiro/settings/mcp.json",
            ),
            (
                McpAppType::Trae,
                "TRAE_HOME",
                "/srv/trae",
                "/srv/trae/traecli.toml",
            ),
            (
                McpAppType::Qoder,
                "QODER_CONFIG_DIR",
                "/srv/qoder",
                "/srv/qoder/settings.json",
            ),
            (
                McpAppType::Gemini,
                "GEMINI_CLI_HOME",
                "/srv/gemini",
                "/srv/gemini/.gemini/settings.json",
            ),
            (
                McpAppType::Antigravity,
                "GEMINI_HOME",
                "/srv/agy",
                "/srv/agy/config/mcp_config.json",
            ),
            (
                McpAppType::DeepSeek,
                "DSH_HOME",
                "/srv/dsh",
                "/srv/dsh/mcp.json",
            ),
            (
                McpAppType::Pi,
                "PI_CODING_AGENT_DIR",
                "/srv/pi",
                "/srv/pi/mcp.json",
            ),
            (
                McpAppType::OpenCode,
                "OPENCODE_CONFIG_DIR",
                "/srv/opencode",
                "/srv/opencode/opencode.json",
            ),
            (
                McpAppType::Cline,
                "CLINE_DIR",
                "/srv/cline",
                "/srv/cline/data/settings/cline_mcp_settings.json",
            ),
            (
                McpAppType::Cline,
                "CLINE_MCP_SETTINGS_PATH",
                "/srv/cline-mcp.json",
                "/srv/cline-mcp.json",
            ),
        ];
        for (app, key, value, expected) in cases {
            let paths = resolve_paths(*app, &env(&[(key, value)]));
            assert_eq!(paths.servers, PathBuf::from(expected), "{app:?} with {key}");
        }
    }

    #[test]
    fn claude_follows_claude_config_dir_and_the_legacy_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let config_dir = dir.path().join("claude");
        std::fs::create_dir_all(&config_dir).unwrap();
        let env = env(&[("CLAUDE_CONFIG_DIR", config_dir.to_str().unwrap())]);

        let paths = resolve_paths(McpAppType::ClaudeCode, &env);
        assert_eq!(paths.servers, config_dir.join(".claude.json"));
        assert_eq!(paths.plugin_gate, Some(config_dir.join("settings.json")));

        // Claude Code reads the legacy file instead for as long as it exists.
        std::fs::write(config_dir.join(".config.json"), "{}").unwrap();
        let paths = resolve_paths(McpAppType::ClaudeCode, &env);
        assert_eq!(paths.servers, config_dir.join(".config.json"));
    }

    #[test]
    fn codebuddy_reads_the_first_of_its_candidate_files_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codebuddy");
        std::fs::create_dir_all(&home).unwrap();
        let env = env(&[("CODEBUDDY_CONFIG_DIR", home.to_str().unwrap())]);

        assert_eq!(
            resolve_paths(McpAppType::CodeBuddy, &env).servers,
            home.join(".codebuddy.json"),
            "none exists: the one every release reads"
        );
        std::fs::write(home.join("mcp.json"), "{}").unwrap();
        assert_eq!(
            resolve_paths(McpAppType::CodeBuddy, &env).servers,
            home.join("mcp.json")
        );
        std::fs::write(home.join(".mcp.json"), "{}").unwrap();
        let paths = resolve_paths(McpAppType::CodeBuddy, &env);
        assert_eq!(paths.servers, home.join(".mcp.json"));
        assert_eq!(paths.plugin_gate, Some(home.join("settings.json")));
    }

    #[test]
    fn the_format_follows_the_agent_and_opencodes_file_name() {
        use std::path::Path;
        assert_eq!(
            format_of(McpAppType::Codex, Path::new("/x/config.toml")),
            McpConfigFormat::Toml
        );
        assert_eq!(
            format_of(McpAppType::Hermes, Path::new("/x/config.yaml")),
            McpConfigFormat::Yaml
        );
        assert_eq!(
            format_of(McpAppType::OpenCode, Path::new("/x/opencode.jsonc")),
            McpConfigFormat::Jsonc
        );
        assert_eq!(
            format_of(McpAppType::OpenCode, Path::new("/x/opencode.json")),
            McpConfigFormat::Json
        );
        assert_eq!(
            format_of(McpAppType::ClaudeCode, Path::new("/x/.claude.json")),
            McpConfigFormat::Json
        );
    }

    /// Which agents load their own file is decided in two places — here, for
    /// the page, and in `acp::connection`, for the session. They must agree,
    /// or the page would promise a delivery the session does not make.
    #[test]
    fn delivery_agrees_with_what_the_session_forwards() {
        for app in all_apps() {
            let agent_type = agent_type_of(*app);
            let spec = spec(*app);
            if crate::acp::connection::agent_reads_own_mcp_config(agent_type) {
                assert_eq!(spec.delivery, McpDelivery::AgentFile, "{app:?}");
            }
            if spec.delivery == McpDelivery::CodegSession {
                assert!(
                    !crate::acp::connection::agent_reads_own_mcp_config(agent_type),
                    "{app:?}"
                );
                assert!(
                    crate::acp::registry::get_agent_meta(agent_type).supports_mcp,
                    "{app:?} is sent servers, so it must take them"
                );
            }
        }
        // The two listed-only agents get nothing from codeg either way.
        assert!(spec(McpAppType::OpenClaw).scan_only);
        assert!(spec(McpAppType::Pi).scan_only);
        assert!(!crate::acp::registry::get_agent_meta(AgentType::OpenClaw).supports_mcp);
    }
}
