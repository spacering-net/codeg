//! The engine end to end, in a sandbox: every agent's config file under one
//! temp directory, the lock and the pre-write copies beside them. Nothing
//! here reads or writes a file under the real home.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::agents::{all_apps, wire_name, AgentPaths, EngineCtx};
use super::apply::{self, hooks, CodexAccess};
use super::model::*;
use super::{apply_in, fsio, inventory};
use crate::commands::mcp::McpAppType;
use crate::models::agent::AgentType;
use crate::parsers::AgentEnv;

struct Sandbox {
    dir: tempfile::TempDir,
    ctx: EngineCtx,
}

fn file_name(app: McpAppType) -> &'static str {
    match app {
        McpAppType::Codex | McpAppType::Grok => "config.toml",
        McpAppType::Trae => "traecli.toml",
        McpAppType::Hermes => "config.yaml",
        McpAppType::OpenCode => "opencode.jsonc",
        McpAppType::ClaudeCode => ".claude.json",
        _ => "mcp.json",
    }
}

impl Sandbox {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let paths = all_apps()
            .iter()
            .map(|app| {
                let home = dir.path().join("agents").join(wire_name(*app));
                let plugin_gate = matches!(app, McpAppType::ClaudeCode | McpAppType::CodeBuddy)
                    .then(|| home.join("settings.json"));
                (
                    *app,
                    AgentPaths {
                        servers: home.join(file_name(*app)),
                        plugin_gate,
                    },
                )
            })
            .collect();
        let ctx = EngineCtx {
            paths,
            lock_path: dir.path().join("locks").join("mcp.lock"),
            backup_root: dir.path().join("backups"),
            lock_wait: super::lock::LOCK_WAIT,
        };
        Self { dir, ctx }
    }

    fn path(&self, app: McpAppType) -> PathBuf {
        self.ctx.paths_of(app).unwrap().servers.clone()
    }

    fn gate(&self, app: McpAppType) -> PathBuf {
        self.ctx.paths_of(app).unwrap().plugin_gate.clone().unwrap()
    }

    fn write(&self, app: McpAppType, text: &str) {
        write(&self.path(app), text);
    }

    fn read(&self, app: McpAppType) -> Option<String> {
        std::fs::read_to_string(self.path(app)).ok()
    }

    fn basis(&self, app: McpAppType) -> String {
        fsio::basis_of(fsio::read_bytes(&self.path(app)).unwrap().as_deref())
    }

    fn agent(&self, app: McpAppType) -> McpAgentInventory {
        inventory::inventory(&self.ctx, &BTreeMap::new())
            .agents
            .into_iter()
            .find(|agent| agent.agent == app)
            .unwrap()
    }

    fn entry(&self, app: McpAppType, key: &str) -> McpEntry {
        self.agent(app)
            .entries
            .into_iter()
            .find(|entry| entry.key == key)
            .unwrap_or_else(|| panic!("{app:?} has no entry `{key}`"))
    }

    /// The request for `ops`, with the basis of every agent they name as it
    /// is on disk right now.
    fn request(&self, ops: Vec<McpOp>) -> McpApplyRequest {
        let basis = ops
            .iter()
            .map(|op| (op.agent, self.basis(op.agent)))
            .collect();
        McpApplyRequest {
            basis,
            ops,
            preflight: false,
        }
    }

    async fn apply(&self, ops: Vec<McpOp>) -> McpApplyResult {
        apply_in(&self.ctx, &self.request(ops)).await
    }

    fn backups(&self, app: McpAppType) -> Vec<PathBuf> {
        let mut found: Vec<PathBuf> = std::fs::read_dir(self.ctx.backup_dir(app))
            .map(|entries| entries.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default();
        found.sort();
        found
    }
}

fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
}

fn stdio(command: &str, args: &[&str], env: &[(&str, &str)]) -> McpDefinition {
    McpDefinition::Stdio {
        command: command.to_string(),
        args: args.iter().map(|arg| arg.to_string()).collect(),
        env: env
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    }
}

fn http(url: &str, headers: &[(&str, &str)]) -> McpDefinition {
    McpDefinition::Http {
        url: url.to_string(),
        headers: headers
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect(),
    }
}

fn sse(url: &str) -> McpDefinition {
    McpDefinition::Sse {
        url: url.to_string(),
        headers: BTreeMap::new(),
    }
}

fn set(agent: McpAppType, key: &str, definition: McpDefinition) -> McpOp {
    McpOp {
        agent,
        key: key.to_string(),
        action: McpOpAction::Set { definition },
    }
}

fn remove(agent: McpAppType, key: &str) -> McpOp {
    McpOp {
        agent,
        key: key.to_string(),
        action: McpOpAction::Remove,
    }
}

fn enable(agent: McpAppType, key: &str, enabled: bool) -> McpOp {
    McpOp {
        agent,
        key: key.to_string(),
        action: McpOpAction::SetEnabled { enabled },
    }
}

fn rename(agent: McpAppType, key: &str, new_key: &str) -> McpOp {
    McpOp {
        agent,
        key: key.to_string(),
        action: McpOpAction::Rename {
            new_key: new_key.to_string(),
        },
    }
}

fn result_of(result: &McpApplyResult, app: McpAppType) -> &McpAgentResult {
    result
        .agents
        .iter()
        .find(|agent| agent.agent == app)
        .unwrap_or_else(|| panic!("no result for {app:?}"))
}

fn issue_codes(agent: &McpAgentResult) -> Vec<&str> {
    agent
        .issues
        .iter()
        .map(|issue| issue.code.as_str())
        .collect()
}

fn problem_codes(entry: &McpEntry) -> Vec<&str> {
    entry
        .problems
        .iter()
        .map(|problem| problem.code.as_str())
        .collect()
}

fn parse_json(text: &str) -> Value {
    crate::acp::opencode_config::parse(text).unwrap()
}

/// Clears the injected failures when a test ends, however it ends.
struct HooksGuard;

impl Drop for HooksGuard {
    fn drop(&mut self) {
        hooks::fail_write_of(None);
        hooks::after_write(None);
    }
}

// ─── The inventory ──────────────────────────────────────────────────────

const CLAUDE: &str = r#"{
  "numStartups": 12,
  "mcpServers": {
    "linear": {
      "type": "sse",
      "url": "https://mcp.linear.app/sse"
    },
    "files": {
      "command": "npx",
      "args": ["-y", "server-files"],
      "env": { "ROOT": "/tmp" }
    }
  },
  "projects": { "/w": { "history": [] } }
}
"#;

const CODEX: &str = r#"# my codex config
model = "gpt-5.5" # the default

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp" # streamable
bearer_token_env_var = "LINEAR_TOKEN"
startup_timeout_sec = 20

[mcp_servers.files]
command = "npx"
args = ["-y", "server-files"]
enabled = false

[profiles.fast]
model = "gpt-5.5-mini"
"#;

#[test]
fn the_same_name_in_two_agents_is_two_entries() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    sandbox.write(McpAppType::Codex, CODEX);

    let claude = sandbox.entry(McpAppType::ClaudeCode, "linear");
    let codex = sandbox.entry(McpAppType::Codex, "linear");
    assert_eq!(claude.definition, Some(sse("https://mcp.linear.app/sse")));
    assert_eq!(
        codex.definition,
        Some(http("https://mcp.linear.app/mcp", &[]))
    );
    assert_ne!(claude.fingerprint, codex.fingerprint);
    // What only Codex keeps on the entry is Codex's, and shown as such.
    assert_eq!(
        Value::Object(codex.extra),
        json!({"bearer_token_env_var": "LINEAR_TOKEN", "startup_timeout_sec": 20})
    );
    assert!(claude.extra.is_empty());

    // The same definition has the same fingerprint, wherever it is written.
    let claude_files = sandbox.entry(McpAppType::ClaudeCode, "files");
    let codex_files = sandbox.entry(McpAppType::Codex, "files");
    assert_eq!(
        codex_files.definition,
        Some(stdio("npx", &["-y", "server-files"], &[]))
    );
    assert_ne!(
        claude_files.fingerprint, codex_files.fingerprint,
        "env differs"
    );
    assert!(claude_files.enabled);
    assert!(!codex_files.enabled, "enabled = false");

    // Entries come in file order.
    let keys: Vec<String> = sandbox
        .agent(McpAppType::ClaudeCode)
        .entries
        .into_iter()
        .map(|entry| entry.key)
        .collect();
    assert_eq!(keys, ["linear", "files"]);
}

#[test]
fn every_agent_is_listed_with_its_file_and_its_ways() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    let listed = inventory::inventory(
        &sandbox.ctx,
        &BTreeMap::from([(McpAppType::ClaudeCode, true), (McpAppType::Codex, false)]),
    );
    assert_eq!(listed.agents.len(), all_apps().len());
    assert_eq!(listed.reserved_keys, ["codeg-mcp"]);
    assert_eq!(listed.key_pattern, KEY_PATTERN);

    let claude = sandbox.agent(McpAppType::ClaudeCode);
    assert_eq!(claude.config.status, McpFileStatus::Ok);
    assert_eq!(claude.config.format, McpConfigFormat::Json);
    assert_eq!(
        claude.config.path,
        sandbox.path(McpAppType::ClaudeCode).display().to_string()
    );
    assert_eq!(
        claude.config.basis.as_deref(),
        Some(fsio::sha256_hex(CLAUDE.as_bytes()).as_str())
    );
    assert_eq!(claude.config.related.len(), 1);
    assert_eq!(claude.config.related[0].role, "plugin_gate");
    assert!(claude.writable);
    assert_eq!(claude.delivery, McpDelivery::CodegSession);
    assert!(!claude.can_disable);
    assert!(claude.codeg_mcp);
    assert_eq!(
        claude.transports,
        [McpTransport::Stdio, McpTransport::Http, McpTransport::Sse]
    );
    let installed = |app| {
        listed
            .agents
            .iter()
            .find(|agent| agent.agent == app)
            .unwrap()
            .installed
    };
    assert_eq!(installed(McpAppType::ClaudeCode), Some(true));
    assert_eq!(installed(McpAppType::Codex), Some(false));
    assert_eq!(installed(McpAppType::Gemini), None, "codeg could not tell");

    // A file that is not there: nothing to list, and writable.
    let codex = sandbox.agent(McpAppType::Codex);
    assert_eq!(codex.config.status, McpFileStatus::Missing);
    assert_eq!(codex.config.basis.as_deref(), Some(BASIS_MISSING));
    assert_eq!(codex.config.format, McpConfigFormat::Toml);
    assert!(codex.writable && codex.can_disable);
    assert_eq!(codex.transports, [McpTransport::Stdio, McpTransport::Http]);
    assert!(codex.entries.is_empty());

    // Agents that load their own file, and what cannot be sent to at all.
    let cline = sandbox.agent(McpAppType::Cline);
    assert_eq!(cline.delivery, McpDelivery::AgentFile);
    assert!(!cline.codeg_mcp, "Cline drops what it is sent");
    assert_eq!(cline.session_capabilities, None);
    assert_eq!(
        sandbox.agent(McpAppType::OpenCode).config.format,
        McpConfigFormat::Jsonc
    );
    assert_eq!(
        sandbox.agent(McpAppType::Hermes).config.format,
        McpConfigFormat::Yaml
    );
    assert_eq!(
        sandbox.agent(McpAppType::ZCode).transports,
        [McpTransport::Stdio]
    );
}

#[test]
fn a_file_codeg_cannot_read_takes_out_only_its_own_agent() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    sandbox.write(McpAppType::Gemini, "{ \"mcpServers\": ");
    sandbox.write(McpAppType::Codex, "model = ");
    sandbox.write(McpAppType::Hermes, "mcp_servers: [1\n");
    sandbox.write(McpAppType::Cursor, r#"{"mcpServers": "nope"}"#);
    std::fs::create_dir_all(sandbox.path(McpAppType::Kiro)).unwrap();

    let reason = |app| {
        let config = sandbox.agent(app).config;
        (config.status, config.reason.map(|reason| reason.code))
    };
    assert_eq!(
        reason(McpAppType::Gemini),
        (McpFileStatus::Unreadable, Some(codes::INVALID_JSON.into()))
    );
    assert_eq!(
        reason(McpAppType::Codex),
        (McpFileStatus::Unreadable, Some(codes::INVALID_TOML.into()))
    );
    assert_eq!(
        reason(McpAppType::Hermes),
        (McpFileStatus::Unreadable, Some(codes::INVALID_YAML.into()))
    );
    assert_eq!(
        reason(McpAppType::Cursor),
        (
            McpFileStatus::ReadOnly,
            Some(codes::CONTAINER_INVALID.into())
        )
    );
    // A directory where the file should be: an I/O failure, not "no file".
    let (status, code) = reason(McpAppType::Kiro);
    assert_eq!(status, McpFileStatus::Unreadable);
    assert!(
        matches!(
            code.as_deref(),
            Some(codes::IO_ERROR | codes::IO_PERMISSION_DENIED)
        ),
        "{code:?}"
    );
    for app in [
        McpAppType::Gemini,
        McpAppType::Codex,
        McpAppType::Hermes,
        McpAppType::Cursor,
        McpAppType::Kiro,
    ] {
        assert!(!sandbox.agent(app).writable, "{app:?}");
    }
    // The others are listed and editable as ever.
    let claude = sandbox.agent(McpAppType::ClaudeCode);
    assert!(claude.writable);
    assert_eq!(claude.entries.len(), 2);
}

#[test]
fn an_entry_that_is_no_server_is_listed_with_the_reason() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::ClaudeCode,
        r#"{"mcpServers": {
            "ok": {"command": "x"},
            "text": "npx x",
            "empty": {},
            "odd": {"type": "websocket", "url": "wss://x.test"},
            "blank": {"command": ""},
            "codeg-mcp": {"command": "mine"}
        }}"#,
    );
    sandbox.write(
        McpAppType::Codex,
        "[mcp_servers.sse]\ntype = \"sse\"\nurl = \"https://x.test/sse\"\n\n[mcp_servers.both]\ncommand = \"x\"\nurl = \"https://x.test\"\n",
    );
    let problems = |app, key| {
        problem_codes(&sandbox.entry(app, key))
            .into_iter()
            .map(str::to_string)
            .collect::<Vec<_>>()
    };
    assert!(problems(McpAppType::ClaudeCode, "ok").is_empty());
    assert_eq!(
        problems(McpAppType::ClaudeCode, "text"),
        [codes::ENTRY_NOT_AN_OBJECT]
    );
    assert_eq!(
        problems(McpAppType::ClaudeCode, "empty"),
        [codes::MISSING_COMMAND_OR_URL]
    );
    assert_eq!(
        problems(McpAppType::ClaudeCode, "odd"),
        [codes::UNSUPPORTED_TYPE]
    );
    assert_eq!(
        problems(McpAppType::ClaudeCode, "blank"),
        [codes::INVALID_COMMAND]
    );
    assert!(sandbox
        .entry(McpAppType::ClaudeCode, "odd")
        .definition
        .is_none());
    // The built-in's name: listed, not editable.
    let reserved = sandbox.entry(McpAppType::ClaudeCode, "codeg-mcp");
    assert!(reserved.reserved && reserved.read_only);
    assert_eq!(problem_codes(&reserved), [codes::RESERVED_KEY]);
    // A transport the agent cannot run, and an entry it refuses.
    assert_eq!(
        problems(McpAppType::Codex, "sse"),
        [codes::UNSUPPORTED_TRANSPORT]
    );
    assert_eq!(
        problems(McpAppType::Codex, "both"),
        [codes::COMMAND_AND_URL]
    );
    assert_eq!(sandbox.agent(McpAppType::ClaudeCode).entries.len(), 6);
}

#[test]
fn listed_only_agents_are_read_and_never_written() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::OpenClaw,
        r#"{"mcp": {"servers": {"a": {"command": "a", "auth": "oauth"}}}}"#,
    );
    sandbox.write(
        McpAppType::Pi,
        r#"{"mcpServers": {"p": {"url": "https://p.test"}}}"#,
    );
    for (app, key) in [(McpAppType::OpenClaw, "a"), (McpAppType::Pi, "p")] {
        let agent = sandbox.agent(app);
        assert!(!agent.writable, "{app:?}");
        assert_eq!(agent.config.status, McpFileStatus::ReadOnly);
        assert_eq!(
            agent.config.reason.map(|reason| reason.code).as_deref(),
            Some(codes::MANAGED_BY_AGENT)
        );
        assert_eq!(agent.delivery, McpDelivery::AgentFile);
        assert!(!agent.codeg_mcp);
        let entry = sandbox.entry(app, key);
        assert!(entry.read_only && entry.definition.is_some());
    }
}

#[tokio::test]
async fn an_operation_on_a_listed_only_agent_is_refused() {
    let sandbox = Sandbox::new();
    let before = r#"{"mcpServers": {"p": {"url": "https://p.test"}}}"#;
    sandbox.write(McpAppType::Pi, before);
    let result = sandbox.apply(vec![remove(McpAppType::Pi, "p")]).await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    let pi = result_of(&result, McpAppType::Pi);
    assert_eq!(pi.status, McpAgentStatus::ReadOnly);
    assert_eq!(issue_codes(pi), [codes::AGENT_READ_ONLY]);
    assert_eq!(sandbox.read(McpAppType::Pi).as_deref(), Some(before));
}

// ─── Editing ────────────────────────────────────────────────────────────

/// Claude has it as SSE, Codex as HTTP: changing one leaves the other file
/// byte for byte as it was.
#[tokio::test]
async fn editing_one_agents_entry_leaves_every_other_file_alone() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    sandbox.write(McpAppType::Codex, CODEX);
    sandbox.write(McpAppType::Gemini, "{}");

    let result = sandbox
        .apply(vec![set(
            McpAppType::ClaudeCode,
            "linear",
            sse("https://mcp.linear.app/v2/sse"),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied);
    assert!(result.ok);
    assert_eq!(result.agents.len(), 1);
    let claude = result_of(&result, McpAppType::ClaudeCode);
    assert_eq!(claude.status, McpAgentStatus::Written);
    assert_eq!(claude.ops[0].effect, McpOpEffect::Updated);
    assert_eq!(
        claude.basis.as_deref(),
        Some(sandbox.basis(McpAppType::ClaudeCode).as_str()),
        "the basis handed back is the file's as it is now"
    );

    // Claude's file differs in that one value and nothing else.
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).unwrap(),
        CLAUDE.replace(
            "https://mcp.linear.app/sse",
            "https://mcp.linear.app/v2/sse"
        )
    );
    assert_eq!(sandbox.read(McpAppType::Codex).as_deref(), Some(CODEX));
    assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));
    assert_eq!(
        sandbox.entry(McpAppType::Codex, "linear").definition,
        Some(http("https://mcp.linear.app/mcp", &[]))
    );
}

#[tokio::test]
async fn codexs_config_keeps_its_comments_its_order_and_its_other_tables() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Codex, CODEX);
    let result = sandbox
        .apply(vec![
            set(
                McpAppType::Codex,
                "linear",
                http("https://mcp.linear.app/v2", &[("X-Team", "core")]),
            ),
            set(
                McpAppType::Codex,
                "fresh",
                stdio("uvx", &["server"], &[("TOKEN", "t")]),
            ),
            enable(McpAppType::Codex, "files", true),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    let effects: Vec<McpOpEffect> = result_of(&result, McpAppType::Codex)
        .ops
        .iter()
        .map(|op| op.effect)
        .collect();
    assert_eq!(
        effects,
        [
            McpOpEffect::Updated,
            McpOpEffect::Created,
            McpOpEffect::Enabled
        ]
    );
    let expected = r#"# my codex config
model = "gpt-5.5" # the default

[mcp_servers.linear]
url = "https://mcp.linear.app/v2" # streamable
bearer_token_env_var = "LINEAR_TOKEN"
startup_timeout_sec = 20

[mcp_servers.linear.http_headers]
X-Team = "core"

[mcp_servers.files]
command = "npx"
args = ["-y", "server-files"]
enabled = true

[mcp_servers.fresh]
command = "uvx"
args = ["server"]

[mcp_servers.fresh.env]
TOKEN = "t"

[profiles.fast]
model = "gpt-5.5-mini"
"#;
    assert_eq!(sandbox.read(McpAppType::Codex).unwrap(), expected);
}

/// Gemini's `trust`, Cline's `autoApprove` and `disabled`, Codex's
/// `bearer_token_env_var` and timeouts: still there after an edit, and in no
/// other agent's file.
#[tokio::test]
async fn each_agents_own_fields_stay_where_they_are() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::Gemini,
        r#"{"mcpServers": {"x": {"command": "old", "trust": true, "timeout": 5000}}}"#,
    );
    sandbox.write(
        McpAppType::Cline,
        r#"{"mcpServers": {"x": {"command": "old", "autoApprove": ["read"], "disabled": true, "timeout": 60}}}"#,
    );
    sandbox.write(
        McpAppType::Codex,
        "[mcp_servers.x]\ncommand = \"old\"\nstartup_timeout_sec = 20\ntool_timeout_sec = 90\nenabled_tools = [\"a\"]\n",
    );
    let wanted = stdio("new", &["--flag"], &[("K", "v")]);
    let result = sandbox
        .apply(vec![
            set(McpAppType::Gemini, "x", wanted.clone()),
            set(McpAppType::Cline, "x", wanted.clone()),
            set(McpAppType::Codex, "x", wanted.clone()),
            // And a fourth agent that never had it gets the definition alone.
            set(McpAppType::Kiro, "x", wanted.clone()),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");

    assert_eq!(
        parse_json(&sandbox.read(McpAppType::Gemini).unwrap())["mcpServers"]["x"],
        json!({"command": "new", "trust": true, "timeout": 5000, "args": ["--flag"], "env": {"K": "v"}})
    );
    assert_eq!(
        parse_json(&sandbox.read(McpAppType::Cline).unwrap())["mcpServers"]["x"],
        json!({"command": "new", "autoApprove": ["read"], "disabled": true, "timeout": 60, "args": ["--flag"], "env": {"K": "v"}})
    );
    let codex: toml::Table = sandbox.read(McpAppType::Codex).unwrap().parse().unwrap();
    let entry = &codex["mcp_servers"]["x"];
    assert_eq!(entry["command"].as_str(), Some("new"));
    assert_eq!(entry["startup_timeout_sec"].as_integer(), Some(20));
    assert_eq!(entry["tool_timeout_sec"].as_integer(), Some(90));
    assert_eq!(entry["enabled_tools"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        parse_json(&sandbox.read(McpAppType::Kiro).unwrap()),
        json!({"mcpServers": {"x": {"command": "new", "args": ["--flag"], "env": {"K": "v"}}}})
    );

    // Every agent now says the same thing, each keeping its own extras.
    let fingerprints: Vec<Option<String>> = [
        McpAppType::Gemini,
        McpAppType::Cline,
        McpAppType::Codex,
        McpAppType::Kiro,
    ]
    .into_iter()
    .map(|app| sandbox.entry(app, "x").fingerprint)
    .collect();
    assert!(fingerprints
        .iter()
        .all(|f| *f == Some(wanted.fingerprint())));
    assert!(!sandbox.entry(McpAppType::Cline, "x").enabled, "still off");
    assert_eq!(
        Value::Object(sandbox.entry(McpAppType::Gemini, "x").extra),
        json!({"trust": true, "timeout": 5000})
    );
}

#[tokio::test]
async fn comments_and_layout_of_a_json_file_survive_a_save() {
    let sandbox = Sandbox::new();
    let before = r#"{
  // the theme
  "theme": "dark",
  "mcpServers": {
    // docs lookup
    "docs": { "command": "npx", "args": ["-y", "docs"] }, // one line
    "gone": { "url": "https://gone.test" },
  },
  /* trailing */
  "telemetry": false,
}
"#;
    sandbox.write(McpAppType::Qoder, before);
    let result = sandbox
        .apply(vec![
            set(McpAppType::Qoder, "added", http("https://a.test/mcp", &[])),
            remove(McpAppType::Qoder, "gone"),
            enable(McpAppType::Qoder, "docs", false),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    let after = sandbox.read(McpAppType::Qoder).unwrap();
    for kept in [
        "// the theme",
        "\"theme\": \"dark\",",
        "// docs lookup",
        "// one line",
        "/* trailing */",
        "\"telemetry\": false,",
    ] {
        assert!(after.contains(kept), "`{kept}` is gone:\n{after}");
    }
    assert_eq!(
        parse_json(&after),
        json!({
            "theme": "dark",
            "mcpServers": {
                "docs": {"command": "npx", "args": ["-y", "docs"], "disabled": true},
                "added": {"type": "http", "url": "https://a.test/mcp"}
            },
            "telemetry": false
        })
    );
    assert!(!sandbox.entry(McpAppType::Qoder, "docs").enabled);
}

#[tokio::test]
async fn hermes_yaml_with_comments_is_flagged_before_and_at_the_save() {
    let sandbox = Sandbox::new();
    let before = "# my hermes\nmodel:\n  provider: anthropic\nmcp_servers:\n  a:\n    command: a\n    enabled: false\n";
    sandbox.write(McpAppType::Hermes, before);
    assert!(
        sandbox
            .agent(McpAppType::Hermes)
            .config
            .comments_lost_on_write
    );
    assert!(!sandbox.entry(McpAppType::Hermes, "a").enabled);

    let mut request = sandbox.request(vec![set(
        McpAppType::Hermes,
        "b",
        sse("https://b.test/sse"),
    )]);
    request.preflight = true;
    let preflight = apply_in(&sandbox.ctx, &request).await;
    let hermes = result_of(&preflight, McpAppType::Hermes);
    assert_eq!(hermes.status, McpAgentStatus::Ready);
    assert_eq!(
        hermes
            .warnings
            .iter()
            .map(|warning| warning.code.as_str())
            .collect::<Vec<_>>(),
        [codes::YAML_COMMENTS_LOST]
    );
    assert_eq!(sandbox.read(McpAppType::Hermes).as_deref(), Some(before));

    request.preflight = false;
    let result = apply_in(&sandbox.ctx, &request).await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    let after = sandbox.read(McpAppType::Hermes).unwrap();
    assert!(!after.contains("# my hermes"));
    let value: Value =
        serde_json::to_value(serde_yaml::from_str::<serde_yaml::Value>(&after).unwrap()).unwrap();
    assert_eq!(
        value,
        json!({
            "model": {"provider": "anthropic"},
            "mcp_servers": {
                "a": {"command": "a", "enabled": false},
                "b": {"url": "https://b.test/sse", "transport": "sse"}
            }
        })
    );
    // No comments left: nothing more to warn about.
    assert!(
        !sandbox
            .agent(McpAppType::Hermes)
            .config
            .comments_lost_on_write
    );
}

#[tokio::test]
async fn an_entry_is_turned_off_with_the_agents_own_flag_and_kept() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::OpenCode,
        "{\n  // mine\n  \"mcp\": { \"servers\": { \"x\": { \"type\": \"local\", \"command\": [\"x\"] } } }\n}\n",
    );
    sandbox.write(
        McpAppType::Cline,
        r#"{"mcpServers": {"x": {"command": "x"}}}"#,
    );
    sandbox.write(
        McpAppType::Kiro,
        r#"{"mcpServers": {"x": {"command": "x"}}}"#,
    );
    sandbox.write(McpAppType::Codex, "[mcp_servers.x]\ncommand = \"x\"\n");
    sandbox.write(
        McpAppType::CodeBuddy,
        r#"{"mcpServers": {"x": {"command": "x"}}}"#,
    );
    sandbox.write(
        McpAppType::Grok,
        "disabled_mcp_servers = [\"x\"]\n\n[mcp_servers.x]\ncommand = \"x\"\n",
    );
    let with_flag = [
        McpAppType::OpenCode,
        McpAppType::Cline,
        McpAppType::Kiro,
        McpAppType::Codex,
        McpAppType::CodeBuddy,
    ];

    let off = sandbox
        .apply(
            with_flag
                .iter()
                .map(|app| enable(*app, "x", false))
                .collect(),
        )
        .await;
    assert_eq!(off.outcome, McpApplyOutcome::Applied, "{off:?}");
    for app in with_flag {
        let entry = sandbox.entry(app, "x");
        assert!(!entry.enabled, "{app:?}");
        assert!(entry.definition.is_some(), "{app:?} keeps the definition");
        assert_eq!(
            result_of(&off, app).ops[0].effect,
            McpOpEffect::Disabled,
            "{app:?}"
        );
    }
    assert!(sandbox
        .read(McpAppType::OpenCode)
        .unwrap()
        .contains("// mine"));
    assert!(sandbox
        .read(McpAppType::Codex)
        .unwrap()
        .contains("enabled = false"));
    assert_eq!(
        parse_json(&sandbox.read(McpAppType::CodeBuddy).unwrap())["disabledMcpServers"],
        json!(["x"])
    );
    // CodeBuddy's switch is the list alone: no plugin gate is touched.
    assert!(!sandbox.gate(McpAppType::CodeBuddy).exists());

    // Grok: off by its list of names; turning it on takes the name out.
    assert!(!sandbox.entry(McpAppType::Grok, "x").enabled);
    let mut on_ops: Vec<McpOp> = with_flag
        .iter()
        .map(|app| enable(*app, "x", true))
        .collect();
    on_ops.push(enable(McpAppType::Grok, "x", true));
    let on = sandbox.apply(on_ops).await;
    assert_eq!(on.outcome, McpApplyOutcome::Applied, "{on:?}");
    for app in with_flag.into_iter().chain([McpAppType::Grok]) {
        assert!(sandbox.entry(app, "x").enabled, "{app:?}");
    }
    // Already on: nothing to write.
    let again = sandbox
        .apply(vec![enable(McpAppType::Cline, "x", true)])
        .await;
    assert_eq!(
        result_of(&again, McpAppType::Cline).status,
        McpAgentStatus::Unchanged
    );

    // An agent with no flag of its own says so, and nothing is written.
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    let refused = sandbox
        .apply(vec![
            enable(McpAppType::ClaudeCode, "linear", false),
            enable(McpAppType::Cline, "x", false),
        ])
        .await;
    assert_eq!(refused.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        issue_codes(result_of(&refused, McpAppType::ClaudeCode)),
        [codes::DISABLE_UNSUPPORTED]
    );
    assert_eq!(
        result_of(&refused, McpAppType::Cline).status,
        McpAgentStatus::NotWritten
    );
    assert!(sandbox.entry(McpAppType::Cline, "x").enabled);
}

#[tokio::test]
async fn an_entry_is_renamed_in_place() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    write(
        &sandbox.gate(McpAppType::ClaudeCode),
        r#"{"enabledPlugins": {"linear@local": true}}"#,
    );
    let result = sandbox
        .apply(vec![rename(McpAppType::ClaudeCode, "linear", "linear-app")])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).unwrap(),
        CLAUDE.replace("\"linear\"", "\"linear-app\"")
    );
    assert_eq!(
        parse_json(&std::fs::read_to_string(sandbox.gate(McpAppType::ClaudeCode)).unwrap()),
        json!({"enabledPlugins": {"linear-app@local": true}})
    );

    let refused = sandbox
        .apply(vec![
            rename(McpAppType::ClaudeCode, "linear-app", "files"),
            rename(McpAppType::ClaudeCode, "linear-app", "bad name"),
            rename(McpAppType::ClaudeCode, "linear-app", "codeg-mcp"),
            rename(McpAppType::ClaudeCode, "absent", "anything"),
        ])
        .await;
    assert_eq!(refused.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        issue_codes(result_of(&refused, McpAppType::ClaudeCode)),
        [
            codes::KEY_EXISTS,
            codes::KEY_INVALID,
            codes::KEY_RESERVED,
            codes::ENTRY_NOT_FOUND
        ]
    );
}

#[tokio::test]
async fn names_are_checked_for_new_entries_only() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::Gemini,
        r#"{"mcpServers": {"io.github/x y": {"command": "old"}}}"#,
    );
    // A name already on disk is edited as it is.
    let edited = sandbox
        .apply(vec![set(
            McpAppType::Gemini,
            "io.github/x y",
            stdio("new", &[], &[]),
        )])
        .await;
    assert_eq!(edited.outcome, McpApplyOutcome::Applied, "{edited:?}");
    assert_eq!(
        sandbox
            .entry(McpAppType::Gemini, "io.github/x y")
            .definition,
        Some(stdio("new", &[], &[]))
    );

    let before = sandbox.read(McpAppType::Gemini);
    let long = "a".repeat(65);
    let refused = sandbox
        .apply(vec![
            set(McpAppType::Gemini, "has space", stdio("x", &[], &[])),
            set(McpAppType::Gemini, "dot.name", stdio("x", &[], &[])),
            set(McpAppType::Gemini, &long, stdio("x", &[], &[])),
            set(McpAppType::Gemini, "", stdio("x", &[], &[])),
            set(McpAppType::Gemini, "codeg-mcp", stdio("x", &[], &[])),
            set(McpAppType::Gemini, "fine_Name-1", stdio(" ", &[], &[])),
            set(McpAppType::Gemini, "fine_Name-2", http("", &[])),
        ])
        .await;
    assert_eq!(refused.outcome, McpApplyOutcome::Invalid);
    assert!(!refused.ok);
    let gemini = result_of(&refused, McpAppType::Gemini);
    assert_eq!(gemini.status, McpAgentStatus::Invalid);
    assert_eq!(
        issue_codes(gemini),
        [
            codes::KEY_INVALID,
            codes::KEY_INVALID,
            codes::KEY_INVALID,
            codes::KEY_INVALID,
            codes::KEY_RESERVED,
            codes::COMMAND_REQUIRED,
            codes::URL_REQUIRED,
        ]
    );
    assert_eq!(
        gemini
            .issues
            .iter()
            .map(|issue| issue.op_index)
            .collect::<Vec<_>>(),
        (0..7).map(Some).collect::<Vec<_>>(),
        "every refusal names its operation"
    );
    assert_eq!(sandbox.read(McpAppType::Gemini), before);
}

/// One agent that cannot take the transport stops the whole save, for the
/// agents that can as well.
#[tokio::test]
async fn one_operation_that_cannot_be_done_stops_all_of_them() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    sandbox.write(McpAppType::Codex, CODEX);
    let remote = sse("https://new.test/sse");
    let result = sandbox
        .apply(vec![
            set(McpAppType::ClaudeCode, "new", remote.clone()),
            set(McpAppType::Codex, "new", remote.clone()),
            set(McpAppType::ZCode, "new", http("https://new.test/mcp", &[])),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        result_of(&result, McpAppType::ClaudeCode).status,
        McpAgentStatus::NotWritten
    );
    for app in [McpAppType::Codex, McpAppType::ZCode] {
        let agent = result_of(&result, app);
        assert_eq!(agent.status, McpAgentStatus::Invalid, "{app:?}");
        assert_eq!(
            issue_codes(agent),
            [codes::TRANSPORT_UNSUPPORTED],
            "{app:?}"
        );
    }
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).as_deref(),
        Some(CLAUDE)
    );
    assert_eq!(sandbox.read(McpAppType::Codex).as_deref(), Some(CODEX));
    assert!(sandbox.read(McpAppType::ZCode).is_none());
    assert!(sandbox.backups(McpAppType::ClaudeCode).is_empty());
}

#[tokio::test]
async fn claudes_and_codebuddys_plugin_gate_follows_the_servers() {
    let sandbox = Sandbox::new();
    for app in [McpAppType::ClaudeCode, McpAppType::CodeBuddy] {
        let gate = sandbox.gate(app);
        write(
            &gate,
            "{\n  // keep\n  \"model\": \"opus\",\n  \"enabledPlugins\": { \"other@market\": true, \"old@local\": true }\n}\n",
        );
        sandbox.write(app, r#"{"mcpServers": {"old": {"command": "old"}}}"#);
        let result = sandbox
            .apply(vec![
                set(app, "new", stdio("new", &[], &[])),
                remove(app, "old"),
            ])
            .await;
        assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
        let agent = result_of(&result, app);
        assert_eq!(
            agent
                .writes
                .iter()
                .map(|write| write.role.as_str())
                .collect::<Vec<_>>(),
            ["servers", "plugin_gate"]
        );
        assert_eq!(agent.backup_paths.len(), 2);
        let settings = std::fs::read_to_string(&gate).unwrap();
        assert!(settings.contains("// keep"), "{settings}");
        assert_eq!(
            parse_json(&settings),
            json!({"model": "opus", "enabledPlugins": {"other@market": true, "new@local": true}})
        );
    }

    // A settings file codeg cannot edit stops the agent before anything is
    // written.
    let gate = sandbox.gate(McpAppType::ClaudeCode);
    write(&gate, "{ broken");
    let before = sandbox.read(McpAppType::ClaudeCode);
    let result = sandbox
        .apply(vec![set(
            McpAppType::ClaudeCode,
            "third",
            stdio("x", &[], &[]),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        issue_codes(result_of(&result, McpAppType::ClaudeCode)),
        [codes::RELATED_FILE_UNREADABLE]
    );
    assert_eq!(sandbox.read(McpAppType::ClaudeCode), before);
}

#[tokio::test]
async fn older_locations_are_listed_and_move_when_edited() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::OpenCode,
        r#"{"mcp": {"old": {"type": "local", "command": ["old"], "enabled": false}}}"#,
    );
    sandbox.write(
        McpAppType::Codex,
        "[mcp.servers.old]\ncommand = \"old\"\ntool_timeout_sec = 9\n",
    );
    for app in [McpAppType::OpenCode, McpAppType::Codex] {
        let entry = sandbox.entry(app, "old");
        assert!(entry.legacy, "{app:?}");
        assert_eq!(problem_codes(&entry), [codes::LEGACY_LOCATION], "{app:?}");
    }
    assert!(!sandbox.entry(McpAppType::OpenCode, "old").enabled);

    let result = sandbox
        .apply(vec![
            enable(McpAppType::OpenCode, "old", true),
            set(McpAppType::Codex, "old", stdio("new", &[], &[])),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        parse_json(&sandbox.read(McpAppType::OpenCode).unwrap()),
        json!({"mcp": {"servers": {"old": {"type": "local", "command": ["old"], "disabled": false}}}})
    );
    let codex: toml::Table = sandbox.read(McpAppType::Codex).unwrap().parse().unwrap();
    assert!(codex.get("mcp").is_none());
    assert_eq!(codex["mcp_servers"]["old"]["command"].as_str(), Some("new"));
    assert_eq!(
        codex["mcp_servers"]["old"]["tool_timeout_sec"].as_integer(),
        Some(9)
    );
    for app in [McpAppType::OpenCode, McpAppType::Codex] {
        assert!(!sandbox.entry(app, "old").legacy, "{app:?}");
    }
}

// ─── A key that is there twice ──────────────────────────────────────────
//
// JSON allows it. The agent reads the last occurrence; an edit through the
// CST would reach the first, be reported done, and change nothing the agent
// sees. So what is there twice is listed as the agent has it, and not edited.

/// What a refusal leaves behind: nothing written, nothing copied.
fn assert_untouched(sandbox: &Sandbox, files: &[(McpAppType, &str)]) {
    for (app, text) in files {
        assert_eq!(
            sandbox.read(*app).as_deref(),
            Some(*text),
            "{app:?} was written"
        );
        assert!(sandbox.backups(*app).is_empty(), "{app:?} was copied");
    }
}

/// The outcome of a request one of whose agents is refused.
fn refused_outcome(preflight: bool) -> McpApplyOutcome {
    if preflight {
        McpApplyOutcome::Preflight
    } else {
        McpApplyOutcome::Invalid
    }
}

/// The same server name twice in one file. Removing it used to delete the
/// first, report success, and leave the server the agent runs in place.
#[tokio::test]
async fn a_server_name_that_is_there_twice_is_listed_and_not_edited() {
    let sandbox = Sandbox::new();
    let claude = r#"{"mcpServers": {"x": {"command": "old"}, "y": {"command": "y"}, "x": {"command": "active"}}}"#;
    sandbox.write(McpAppType::ClaudeCode, claude);
    sandbox.write(McpAppType::Gemini, "{}");

    // Listed once, as the agent has it, with the reason no edit is offered.
    let agent = sandbox.agent(McpAppType::ClaudeCode);
    assert_eq!(agent.config.status, McpFileStatus::Ok);
    assert!(agent.writable, "the rest of the file can be edited");
    assert_eq!(agent.entries.len(), 2);
    let x = sandbox.entry(McpAppType::ClaudeCode, "x");
    assert_eq!(x.definition, Some(stdio("active", &[], &[])));
    assert!(x.read_only);
    assert_eq!(problem_codes(&x), [codes::DUPLICATE_KEY]);
    assert_eq!(x.problems[0].field, None, "the name itself");
    let y = sandbox.entry(McpAppType::ClaudeCode, "y");
    assert!(!y.read_only && y.problems.is_empty());

    // Every operation on it is refused, and the whole request with it.
    for op in [
        remove(McpAppType::ClaudeCode, "x"),
        set(McpAppType::ClaudeCode, "x", stdio("new", &[], &[])),
        rename(McpAppType::ClaudeCode, "x", "z"),
    ] {
        for preflight in [true, false] {
            let mut request = sandbox.request(vec![
                set(McpAppType::Gemini, "g", stdio("g", &[], &[])),
                op.clone(),
            ]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{op:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{op:?}");
            let refused = result_of(&result, McpAppType::ClaudeCode);
            assert_eq!(refused.status, McpAgentStatus::Invalid, "{op:?}");
            assert_eq!(issue_codes(refused), [codes::DUPLICATE_KEY], "{op:?}");
            assert_eq!(refused.issues[0].op_index, Some(1));
            assert_eq!(refused.issues[0].key.as_deref(), Some("x"));
            assert_eq!(refused.issues[0].field, None);
            assert!(refused.ops.is_empty(), "nothing is reported done: {op:?}");
            assert_eq!(
                result_of(&result, McpAppType::Gemini).status,
                if preflight {
                    McpAgentStatus::Ready
                } else {
                    McpAgentStatus::NotWritten
                }
            );
            assert_untouched(
                &sandbox,
                &[(McpAppType::ClaudeCode, claude), (McpAppType::Gemini, "{}")],
            );
        }
    }
    // Renaming another entry onto it: a name that exists.
    let result = sandbox
        .apply(vec![rename(McpAppType::ClaudeCode, "y", "x")])
        .await;
    assert_eq!(
        issue_codes(result_of(&result, McpAppType::ClaudeCode)),
        [codes::KEY_EXISTS]
    );

    // An entry that is there once is edited as ever, and both `x` stay.
    let result = sandbox
        .apply(vec![set(
            McpAppType::ClaudeCode,
            "y",
            stdio("y2", &[], &[]),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).unwrap(),
        claude.replace(r#""y": {"command": "y"}"#, r#""y": {"command": "y2"}"#)
    );
}

/// A field that is there twice inside an entry — two `disabled`, one name
/// twice in `env`. The agent goes by the last; so does the listing; no edit
/// of the entry is taken.
#[tokio::test]
async fn a_field_that_is_there_twice_makes_its_entry_one_that_is_not_edited() {
    let sandbox = Sandbox::new();
    let cline = r#"{"mcpServers": {
  "off": {"command": "x", "disabled": true, "disabled": false},
  "env": {"command": "x", "env": {"K": "first", "K": "last"}},
  "fine": {"command": "x", "disabled": true}
}}"#;
    let kiro = r#"{"mcpServers": {"k": {"command": "k"}}}"#;
    sandbox.write(McpAppType::Cline, cline);
    sandbox.write(McpAppType::Kiro, kiro);

    let off = sandbox.entry(McpAppType::Cline, "off");
    assert!(off.enabled, "the last `disabled` is the one Cline goes by");
    assert!(off.read_only);
    assert_eq!(problem_codes(&off), [codes::DUPLICATE_KEY]);
    assert_eq!(off.problems[0].field.as_deref(), Some("disabled"));
    let env = sandbox.entry(McpAppType::Cline, "env");
    assert_eq!(env.definition, Some(stdio("x", &[], &[("K", "last")])));
    assert!(env.read_only);
    assert_eq!(env.problems[0].field.as_deref(), Some("env.K"));
    assert!(!sandbox.entry(McpAppType::Cline, "fine").read_only);
    assert!(sandbox.agent(McpAppType::Cline).writable);

    let refused = [
        (enable(McpAppType::Cline, "off", false), "disabled"),
        (
            set(McpAppType::Cline, "off", stdio("y", &[], &[])),
            "disabled",
        ),
        (
            set(McpAppType::Cline, "env", stdio("x", &[], &[("K", "new")])),
            "env.K",
        ),
        (remove(McpAppType::Cline, "env"), "env.K"),
        (rename(McpAppType::Cline, "off", "on"), "disabled"),
    ];
    for (op, field) in refused {
        for preflight in [true, false] {
            let mut request =
                sandbox.request(vec![enable(McpAppType::Kiro, "k", false), op.clone()]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{op:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{op:?}");
            let agent = result_of(&result, McpAppType::Cline);
            assert_eq!(agent.status, McpAgentStatus::Invalid, "{op:?}");
            assert_eq!(issue_codes(agent), [codes::DUPLICATE_KEY], "{op:?}");
            assert_eq!(agent.issues[0].field.as_deref(), Some(field), "{op:?}");
            assert!(agent.ops.is_empty(), "nothing is reported done: {op:?}");
            assert_untouched(
                &sandbox,
                &[(McpAppType::Cline, cline), (McpAppType::Kiro, kiro)],
            );
        }
    }

    // The entry beside them is switched on as ever.
    let result = sandbox
        .apply(vec![enable(McpAppType::Cline, "fine", true)])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert!(sandbox.entry(McpAppType::Cline, "fine").enabled);
    assert_eq!(
        problem_codes(&sandbox.entry(McpAppType::Cline, "off")),
        [codes::DUPLICATE_KEY]
    );
}

/// The servers' container itself twice in the file — or the list of names
/// that turns servers off. What is listed is the last one, and nothing in
/// the file is edited, a new server included.
#[tokio::test]
async fn a_container_that_is_there_twice_makes_the_file_one_that_is_not_edited() {
    let sandbox = Sandbox::new();
    let gemini = r#"{"mcpServers": {"first": {"command": "first"}}, "mcpServers": {"last": {"command": "last"}}}"#;
    let opencode = r#"{"mcp": {"servers": {"a": {"type": "local", "command": ["a"]}}, "servers": {"b": {"type": "local", "command": ["b"]}}}}"#;
    let codebuddy = r#"{"mcpServers": {"x": {"command": "x"}}, "disabledMcpServers": ["x"], "disabledMcpServers": []}"#;
    sandbox.write(McpAppType::Gemini, gemini);
    sandbox.write(McpAppType::OpenCode, opencode);
    sandbox.write(McpAppType::CodeBuddy, codebuddy);
    sandbox.write(McpAppType::Cursor, "{}");

    let cases = [
        (
            McpAppType::Gemini,
            gemini,
            "mcpServers",
            set(McpAppType::Gemini, "new", stdio("n", &[], &[])),
        ),
        (
            McpAppType::OpenCode,
            opencode,
            "mcp.servers",
            remove(McpAppType::OpenCode, "b"),
        ),
        (
            McpAppType::CodeBuddy,
            codebuddy,
            "disabledMcpServers",
            enable(McpAppType::CodeBuddy, "x", false),
        ),
    ];
    for (app, text, container, op) in cases {
        let agent = sandbox.agent(app);
        assert_eq!(agent.config.status, McpFileStatus::ReadOnly, "{app:?}");
        let reason = agent.config.reason.clone().expect("a reason");
        assert_eq!(reason.code, codes::DUPLICATE_KEY, "{app:?}");
        assert_eq!(reason.detail.as_deref(), Some(container), "{app:?}");
        assert!(!agent.writable, "{app:?}");

        for preflight in [true, false] {
            let mut request = sandbox.request(vec![
                set(McpAppType::Cursor, "c", stdio("c", &[], &[])),
                op.clone(),
            ]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{app:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{app:?}");
            let refused = result_of(&result, app);
            assert_eq!(refused.status, McpAgentStatus::ReadOnly, "{app:?}");
            assert_eq!(issue_codes(refused), [codes::DUPLICATE_KEY], "{app:?}");
            assert_eq!(refused.issues[0].detail.as_deref(), Some(container));
            assert!(refused.ops.is_empty(), "{app:?}");
            assert_untouched(&sandbox, &[(app, text), (McpAppType::Cursor, "{}")]);
        }
    }

    // Listed as a reader of the file has it: the last container, the last
    // list.
    let keys = |app| -> Vec<String> {
        sandbox
            .agent(app)
            .entries
            .into_iter()
            .map(|entry| entry.key)
            .collect()
    };
    assert_eq!(keys(McpAppType::Gemini), ["last"]);
    assert_eq!(keys(McpAppType::OpenCode), ["b"]);
    assert!(
        sandbox.entry(McpAppType::CodeBuddy, "x").enabled,
        "the last list is empty"
    );
}

/// `enabledPlugins` — the map Claude Code's servers are switched on through,
/// in its `settings.json` — twice in that file, or a server's key twice in
/// the map. The listing says so, and a save that would have to pick is
/// refused whole.
#[tokio::test]
async fn a_plugin_gate_key_that_is_there_twice_stops_the_save() {
    let sandbox = Sandbox::new();
    let claude = r#"{"mcpServers": {"x": {"command": "x"}}}"#;
    sandbox.write(McpAppType::ClaudeCode, claude);
    sandbox.write(McpAppType::Gemini, "{}");
    let gate = sandbox.gate(McpAppType::ClaudeCode);
    let gate_path = gate.display().to_string();
    let related = || sandbox.agent(McpAppType::ClaudeCode).config.related[0].clone();

    // Not there yet: nothing to say about it.
    assert_eq!(related().reason, None);
    assert_eq!(
        serde_json::to_value(related()).unwrap(),
        json!({"role": "plugin_gate", "path": gate_path})
    );

    // The map itself twice.
    let twice = r#"{"enabledPlugins": {"x@local": true}, "enabledPlugins": {}}"#;
    write(&gate, twice);
    assert_eq!(
        serde_json::to_value(related()).unwrap(),
        json!({
            "role": "plugin_gate",
            "path": gate_path,
            "reason": {"code": "duplicate_key", "detail": "enabledPlugins"}
        })
    );
    for op in [
        set(McpAppType::ClaudeCode, "new", stdio("n", &[], &[])),
        remove(McpAppType::ClaudeCode, "x"),
        rename(McpAppType::ClaudeCode, "x", "y"),
    ] {
        for preflight in [true, false] {
            let mut request = sandbox.request(vec![
                set(McpAppType::Gemini, "g", stdio("g", &[], &[])),
                op.clone(),
            ]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{op:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{op:?}");
            let agent = result_of(&result, McpAppType::ClaudeCode);
            assert_eq!(agent.status, McpAgentStatus::ReadOnly, "{op:?}");
            assert_eq!(issue_codes(agent), [codes::DUPLICATE_KEY], "{op:?}");
            assert_eq!(agent.issues[0].field.as_deref(), Some(gate_path.as_str()));
            assert_eq!(agent.issues[0].detail.as_deref(), Some("enabledPlugins"));
            assert_untouched(
                &sandbox,
                &[(McpAppType::ClaudeCode, claude), (McpAppType::Gemini, "{}")],
            );
            assert_eq!(std::fs::read_to_string(&gate).unwrap(), twice);
        }
    }

    // One server's key twice in the map: that server's operations are
    // refused, another server's go through.
    let key_twice = r#"{"enabledPlugins": {"x@local": true, "x@local": false}}"#;
    write(&gate, key_twice);
    assert_eq!(related().reason, None, "the file as a whole can be edited");
    let result = sandbox
        .apply(vec![remove(McpAppType::ClaudeCode, "x")])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    let agent = result_of(&result, McpAppType::ClaudeCode);
    assert_eq!(issue_codes(agent), [codes::DUPLICATE_KEY]);
    assert_eq!(
        agent.issues[0].detail.as_deref(),
        Some("enabledPlugins.x@local")
    );
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).as_deref(),
        Some(claude)
    );
    assert_eq!(std::fs::read_to_string(&gate).unwrap(), key_twice);
    let result = sandbox
        .apply(vec![set(
            McpAppType::ClaudeCode,
            "other",
            stdio("o", &[], &[]),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        parse_json(&std::fs::read_to_string(&gate).unwrap())["enabledPlugins"]["other@local"],
        json!(true)
    );

    // A settings file that is there and cannot be edited at all is said in
    // the listing as well.
    write(&gate, "{ broken");
    assert_eq!(
        related().reason.map(|reason| reason.code).as_deref(),
        Some(codes::INVALID_JSON)
    );
}

/// Every operation on `key` of `app`, beside an edit of another agent's file,
/// is refused as a whole with `duplicate_key` — in a preflight and for real —
/// and nothing is written or copied.
async fn assert_every_op_is_refused(
    sandbox: &Sandbox,
    app: McpAppType,
    key: &str,
    field: Option<&str>,
    files: &[(McpAppType, &str)],
) {
    let other = files
        .iter()
        .map(|(other, _)| *other)
        .find(|other| *other != app)
        .expect("another agent");
    for op in [
        remove(app, key),
        set(app, key, stdio("new", &[], &[])),
        enable(app, key, false),
        rename(app, key, "renamed"),
    ] {
        for preflight in [true, false] {
            let mut request =
                sandbox.request(vec![set(other, "other", stdio("o", &[], &[])), op.clone()]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{op:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{op:?}");
            let refused = result_of(&result, app);
            assert_eq!(refused.status, McpAgentStatus::Invalid, "{op:?}");
            assert_eq!(issue_codes(refused), [codes::DUPLICATE_KEY], "{op:?}");
            assert_eq!(refused.issues[0].op_index, Some(1), "{op:?}");
            assert_eq!(refused.issues[0].key.as_deref(), Some(key), "{op:?}");
            assert_eq!(refused.issues[0].field.as_deref(), field, "{op:?}");
            assert!(refused.ops.is_empty(), "nothing is reported done: {op:?}");
            assert_eq!(
                result_of(&result, other).status,
                if preflight {
                    McpAgentStatus::Ready
                } else {
                    McpAgentStatus::NotWritten
                },
                "{op:?}"
            );
            assert_untouched(sandbox, files);
        }
    }
}

/// OpenCode keeps a server in `mcp.servers.<name>` and, for 1.x, in
/// `mcp.<name>`, and an operation reaches both. A name twice in the older
/// location — or a field twice inside the entry there — is caught whether or
/// not the current location has the name. The review's case: a remove that
/// took the current entry and the first older one, reported `removed`, and
/// left the second older one in force.
#[tokio::test]
async fn opencodes_older_location_is_guarded_as_well_as_the_current_one() {
    let sandbox = Sandbox::new();
    let kiro = r#"{"mcpServers": {"k": {"command": "k"}}}"#;
    sandbox.write(McpAppType::Kiro, kiro);
    let cases: [(&str, &str, Option<&str>, bool); 3] = [
        (
            // The current entry once, the older one twice.
            r#"{
  "mcp": {
    "servers": { "x": { "type": "local", "command": ["active"] } },
    "x": { "type": "local", "command": ["old1"] },
    "x": { "type": "local", "command": ["old2"] }
  }
}"#,
            "active",
            None,
            false,
        ),
        (
            // The older one twice, and no current one.
            r#"{"mcp": {"x": {"type": "local", "command": ["old1"]}, "x": {"type": "local", "command": ["old2"]}}}"#,
            "old2",
            None,
            true,
        ),
        (
            // A field twice inside the older one, shadowed by a current one.
            r#"{"mcp": {"servers": {"x": {"type": "local", "command": ["active"]}}, "x": {"type": "local", "command": ["old"], "enabled": true, "enabled": false}}}"#,
            "active",
            Some("enabled"),
            false,
        ),
    ];
    for (opencode, command, field, legacy) in cases {
        sandbox.write(McpAppType::OpenCode, opencode);

        // Listed once, as OpenCode has it, and with the reason no edit is
        // offered.
        let listed = sandbox.agent(McpAppType::OpenCode);
        assert!(listed.writable, "{opencode}");
        assert_eq!(listed.entries.len(), 1, "{opencode}");
        let x = sandbox.entry(McpAppType::OpenCode, "x");
        assert_eq!(x.definition, Some(stdio(command, &[], &[])), "{opencode}");
        assert_eq!(x.legacy, legacy, "{opencode}");
        assert!(x.read_only, "{opencode}");
        let duplicate: Vec<&McpIssue> = x
            .problems
            .iter()
            .filter(|problem| problem.code == codes::DUPLICATE_KEY)
            .collect();
        assert_eq!(duplicate.len(), 1, "{opencode}");
        assert_eq!(duplicate[0].field.as_deref(), field, "{opencode}");

        assert_every_op_is_refused(
            &sandbox,
            McpAppType::OpenCode,
            "x",
            field,
            &[(McpAppType::OpenCode, opencode), (McpAppType::Kiro, kiro)],
        )
        .await;
    }

    // A server beside them is edited as ever, and both older `x` stay.
    let opencode = cases[0].0;
    sandbox.write(McpAppType::OpenCode, opencode);
    let result = sandbox
        .apply(vec![set(
            McpAppType::OpenCode,
            "fresh",
            stdio("f", &[], &[]),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    let after = sandbox.read(McpAppType::OpenCode).unwrap();
    assert!(after.contains("old1") && after.contains("old2"), "{after}");
    assert!(sandbox
        .entry(McpAppType::OpenCode, "fresh")
        .problems
        .is_empty());
}

/// YAML takes `1` and `"1"` for two keys; codeg names a server by the text,
/// for which they are one. Both are listed, neither is edited.
#[tokio::test]
async fn hermes_keys_that_read_as_one_name_are_listed_and_not_edited() {
    let sandbox = Sandbox::new();
    let hermes = "mcp_servers:\n  1:\n    command: number\n  \"1\":\n    command: string\n  env:\n    command: x\n    env:\n      2: a\n      \"2\": b\n  ok:\n    command: ok\n";
    let cline = r#"{"mcpServers": {}}"#;
    sandbox.write(McpAppType::Hermes, hermes);
    sandbox.write(McpAppType::Cline, cline);

    let listed = sandbox.agent(McpAppType::Hermes);
    assert!(listed.writable);
    let rows: Vec<(String, bool, Vec<String>)> = listed
        .entries
        .iter()
        .map(|entry| {
            (
                entry.key.clone(),
                entry.read_only,
                entry
                    .problems
                    .iter()
                    .map(|problem| {
                        format!(
                            "{}{}",
                            problem.code,
                            problem
                                .field
                                .as_deref()
                                .map(|field| format!(":{field}"))
                                .unwrap_or_default()
                        )
                    })
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        rows,
        [
            ("1".to_string(), true, vec!["duplicate_key".to_string()]),
            ("1".to_string(), true, vec!["duplicate_key".to_string()]),
            (
                "env".to_string(),
                true,
                vec!["duplicate_key:env.2".to_string()]
            ),
            ("ok".to_string(), false, Vec::new()),
        ]
    );

    let files = [(McpAppType::Hermes, hermes), (McpAppType::Cline, cline)];
    assert_every_op_is_refused(&sandbox, McpAppType::Hermes, "1", None, &files).await;
    assert_every_op_is_refused(&sandbox, McpAppType::Hermes, "env", Some("env.2"), &files).await;

    // The entry beside them is edited as ever.
    let result = sandbox
        .apply(vec![enable(McpAppType::Hermes, "ok", false)])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert!(!sandbox.entry(McpAppType::Hermes, "ok").enabled);
}

/// A rename of a current entry whose name an older copy also has (shadowed
/// by it until now) takes the older copy with it. Left behind, it would be
/// read as a server of the old name — loaded by OpenCode, sent to Codex's
/// sessions — and the rename would bring back what it renamed.
#[tokio::test]
async fn a_rename_takes_the_older_copy_under_the_old_name_with_it() {
    use crate::commands::mcp_engine::session::servers_for_session;
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::OpenCode,
        r#"{"mcp": {"servers": {"x": {"type": "local", "command": ["current"]}}, "x": {"type": "local", "command": ["older"]}}}"#,
    );
    sandbox.write(
        McpAppType::Codex,
        "[mcp_servers.x]\ncommand = \"current\"\n\n[mcp.servers.x]\ncommand = \"older\"\n",
    );
    let keys = |app| -> Vec<String> {
        sandbox
            .agent(app)
            .entries
            .into_iter()
            .map(|entry| entry.key)
            .collect()
    };
    for app in [McpAppType::OpenCode, McpAppType::Codex] {
        assert_eq!(keys(app), ["x"], "the older copy is shadowed: {app:?}");
    }

    let result = sandbox
        .apply(vec![
            rename(McpAppType::OpenCode, "x", "y"),
            rename(McpAppType::Codex, "x", "y"),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    for app in [McpAppType::OpenCode, McpAppType::Codex] {
        assert_eq!(result_of(&result, app).ops[0].effect, McpOpEffect::Renamed);
        assert_eq!(keys(app), ["y"], "{app:?}");
        assert_eq!(
            sandbox.entry(app, "y").definition,
            Some(stdio("current", &[], &[]))
        );
    }
    let opencode = parse_json(&sandbox.read(McpAppType::OpenCode).unwrap());
    assert_eq!(
        opencode,
        json!({"mcp": {"servers": {"y": {"type": "local", "command": ["current"]}}}})
    );
    let codex: toml::Table = sandbox.read(McpAppType::Codex).unwrap().parse().unwrap();
    assert!(codex.get("mcp").is_none(), "{codex:?}");
    // What a Codex session is sent: the renamed server alone.
    let codex_home = sandbox
        .path(McpAppType::Codex)
        .parent()
        .unwrap()
        .to_path_buf();
    let sent = servers_for_session(
        AgentType::Codex,
        &AgentEnv::with_overrides(&[("CODEX_HOME", codex_home.to_str().unwrap())]),
    )
    .unwrap();
    assert_eq!(sent.keys().collect::<Vec<_>>(), ["y"]);
}

// ─── A name that is the document's own ──────────────────────────────────

/// Antigravity takes a root `mcpServers` for the server map, and the root
/// itself only while that key is absent. In a bare map a server named
/// `mcpServers` — created, or renamed to — would become the map, and every
/// server beside it would stop being one.
#[tokio::test]
async fn antigravitys_bare_map_takes_no_server_named_like_its_container() {
    let sandbox = Sandbox::new();
    let bare = r#"{"keep": {"command": "keep"}}"#;
    sandbox.write(McpAppType::Antigravity, bare);
    sandbox.write(McpAppType::Gemini, "{}");
    let definition = stdio("npx", &["-y", "x"], &[]);
    let keys = || -> Vec<String> {
        sandbox
            .agent(McpAppType::Antigravity)
            .entries
            .into_iter()
            .map(|entry| entry.key)
            .collect()
    };

    let refused = [
        (
            set(McpAppType::Antigravity, "mcpServers", definition.clone()),
            None,
        ),
        (
            rename(McpAppType::Antigravity, "keep", "mcpServers"),
            Some("new_key"),
        ),
    ];
    for (op, field) in refused {
        for preflight in [true, false] {
            let mut request = sandbox.request(vec![
                set(McpAppType::Gemini, "g", definition.clone()),
                op.clone(),
            ]);
            request.preflight = preflight;
            let result = apply_in(&sandbox.ctx, &request).await;
            assert!(!result.ok, "{op:?}");
            assert_eq!(result.outcome, refused_outcome(preflight), "{op:?}");
            let agent = result_of(&result, McpAppType::Antigravity);
            assert_eq!(agent.status, McpAgentStatus::Invalid, "{op:?}");
            assert_eq!(issue_codes(agent), [codes::KEY_STRUCTURAL], "{op:?}");
            assert_eq!(agent.issues[0].field.as_deref(), field, "{op:?}");
            assert_eq!(agent.issues[0].op_index, Some(1));
            assert!(agent.ops.is_empty(), "nothing is reported done: {op:?}");
            assert_untouched(
                &sandbox,
                &[(McpAppType::Antigravity, bare), (McpAppType::Gemini, "{}")],
            );
        }
    }
    assert_eq!(keys(), ["keep"], "still the server Antigravity has");

    // Any other name goes into the bare map beside it.
    let result = sandbox
        .apply(vec![set(
            McpAppType::Antigravity,
            "other",
            definition.clone(),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(keys(), ["keep", "other"]);
    assert!(parse_json(&sandbox.read(McpAppType::Antigravity).unwrap())
        .get("mcpServers")
        .is_none());

    // Where the servers are in the wrapper, the name is a server's like any
    // other: it goes inside, and the one beside it stays a server.
    sandbox.write(
        McpAppType::Antigravity,
        r#"{"mcpServers": {"keep": {"command": "keep"}}}"#,
    );
    let result = sandbox
        .apply(vec![set(
            McpAppType::Antigravity,
            "mcpServers",
            definition.clone(),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(keys(), ["keep", "mcpServers"]);

    // And so it is in a file with nothing in it, which gets the wrapper.
    sandbox.write(McpAppType::Antigravity, "{}");
    let result = sandbox
        .apply(vec![set(
            McpAppType::Antigravity,
            "mcpServers",
            definition.clone(),
        )])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    assert_eq!(
        parse_json(&sandbox.read(McpAppType::Antigravity).unwrap()),
        json!({"mcpServers": {"mcpServers": {
            "type": "stdio", "command": "npx", "args": ["-y", "x"]
        }}})
    );
    assert_eq!(keys(), ["mcpServers"]);
}

// ─── The basis ──────────────────────────────────────────────────────────

#[tokio::test]
async fn a_file_changed_since_it_was_seen_stops_the_whole_save() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    sandbox.write(McpAppType::Gemini, "{}");
    let request = sandbox.request(vec![
        set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
        remove(McpAppType::ClaudeCode, "files"),
    ]);
    // Claude Code rewrites its file while the dialog is open.
    let theirs = CLAUDE.replace("12", "13");
    sandbox.write(McpAppType::ClaudeCode, &theirs);

    let result = apply_in(&sandbox.ctx, &request).await;
    assert_eq!(result.outcome, McpApplyOutcome::ChangedElsewhere);
    assert!(!result.ok);
    let claude = result_of(&result, McpAppType::ClaudeCode);
    assert_eq!(claude.status, McpAgentStatus::ChangedElsewhere);
    assert_eq!(issue_codes(claude), [codes::BASIS_MISMATCH]);
    assert_eq!(
        claude.basis.as_deref(),
        Some(sandbox.basis(McpAppType::ClaudeCode).as_str()),
        "the result carries the basis to retry with"
    );
    assert_eq!(
        result_of(&result, McpAppType::Gemini).status,
        McpAgentStatus::NotWritten
    );
    assert_eq!(sandbox.read(McpAppType::ClaudeCode).unwrap(), theirs);
    assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));

    // A file that appeared, or went away, since it was seen counts too.
    let mut request = sandbox.request(vec![set(McpAppType::Kiro, "x", stdio("x", &[], &[]))]);
    assert_eq!(request.basis[&McpAppType::Kiro], BASIS_MISSING);
    sandbox.write(McpAppType::Kiro, "{}");
    assert_eq!(
        apply_in(&sandbox.ctx, &request).await.outcome,
        McpApplyOutcome::ChangedElsewhere
    );

    // And a save that names no basis at all is refused outright.
    request.basis.clear();
    let result = apply_in(&sandbox.ctx, &request).await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        issue_codes(result_of(&result, McpAppType::Kiro)),
        [codes::BASIS_REQUIRED]
    );
    assert_eq!(sandbox.read(McpAppType::Kiro).as_deref(), Some("{}"));
}

/// The Harness install: a preflight for the result and the basis, then the
/// commit with that basis.
#[tokio::test]
async fn a_preflight_writes_nothing_and_hands_back_the_basis_to_commit_with() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    let ops = vec![
        set(
            McpAppType::ClaudeCode,
            "new",
            stdio("npx", &["-y", "new"], &[]),
        ),
        set(McpAppType::Cursor, "new", stdio("npx", &["-y", "new"], &[])),
        set(
            McpAppType::ClaudeCode,
            "files",
            stdio("npx", &["-y", "server-files"], &[("ROOT", "/tmp")]),
        ),
    ];
    let preflight = apply_in(
        &sandbox.ctx,
        &McpApplyRequest {
            basis: BTreeMap::new(),
            ops: ops.clone(),
            preflight: true,
        },
    )
    .await;
    assert_eq!(preflight.outcome, McpApplyOutcome::Preflight);
    assert!(preflight.ok);
    let claude = result_of(&preflight, McpAppType::ClaudeCode);
    assert_eq!(claude.status, McpAgentStatus::Ready);
    assert_eq!(
        claude.ops.iter().map(|op| op.effect).collect::<Vec<_>>(),
        [McpOpEffect::Created, McpOpEffect::Unchanged]
    );
    assert_eq!(
        claude
            .writes
            .iter()
            .map(|write| (write.role.as_str(), write.creates))
            .collect::<Vec<_>>(),
        [("servers", false), ("plugin_gate", true)]
    );
    let cursor = result_of(&preflight, McpAppType::Cursor);
    assert_eq!(cursor.basis.as_deref(), Some(BASIS_MISSING));
    assert_eq!(cursor.writes.len(), 1);
    assert!(cursor.writes[0].creates);
    // Nothing was written, locked or copied.
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).as_deref(),
        Some(CLAUDE)
    );
    assert!(sandbox.read(McpAppType::Cursor).is_none());
    assert!(!sandbox.gate(McpAppType::ClaudeCode).exists());
    assert!(!sandbox.ctx.lock_path.exists());
    assert!(!sandbox.ctx.backup_root.exists());

    let basis = preflight
        .agents
        .iter()
        .map(|agent| (agent.agent, agent.basis.clone().unwrap()))
        .collect();
    let committed = apply_in(
        &sandbox.ctx,
        &McpApplyRequest {
            basis,
            ops,
            preflight: false,
        },
    )
    .await;
    assert_eq!(committed.outcome, McpApplyOutcome::Applied, "{committed:?}");
    assert!(sandbox
        .entry(McpAppType::Cursor, "new")
        .definition
        .is_some());
    assert!(sandbox
        .entry(McpAppType::ClaudeCode, "new")
        .definition
        .is_some());

    // A preflight of something that cannot be done says so, per agent.
    let refused = apply_in(
        &sandbox.ctx,
        &McpApplyRequest {
            basis: BTreeMap::new(),
            ops: vec![
                set(McpAppType::Codex, "x", sse("https://x.test/sse")),
                set(McpAppType::Gemini, "x", sse("https://x.test/sse")),
            ],
            preflight: true,
        },
    )
    .await;
    assert_eq!(refused.outcome, McpApplyOutcome::Preflight);
    assert!(!refused.ok);
    assert_eq!(
        result_of(&refused, McpAppType::Codex).status,
        McpAgentStatus::Invalid
    );
    assert_eq!(
        result_of(&refused, McpAppType::Gemini).status,
        McpAgentStatus::Ready
    );
}

// ─── Writing ────────────────────────────────────────────────────────────

#[tokio::test]
async fn every_write_is_copied_first_and_only_the_newest_copies_stay() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Gemini, "{}");
    let mut versions = vec!["{}".to_string()];
    for round in 0..(fsio::BACKUPS_KEPT + 2) {
        let result = sandbox
            .apply(vec![set(
                McpAppType::Gemini,
                &format!("server-{round}"),
                stdio("x", &[], &[]),
            )])
            .await;
        assert_eq!(result.outcome, McpApplyOutcome::Applied);
        let gemini = result_of(&result, McpAppType::Gemini);
        assert_eq!(gemini.backup_paths.len(), 1);
        // The copy is the file as it was before this write.
        assert_eq!(
            std::fs::read_to_string(&gemini.backup_paths[0]).unwrap(),
            *versions.last().unwrap()
        );
        versions.push(sandbox.read(McpAppType::Gemini).unwrap());
    }
    let copies = sandbox.backups(McpAppType::Gemini);
    assert_eq!(copies.len(), fsio::BACKUPS_KEPT);
    assert!(copies
        .iter()
        .all(|path| path.starts_with(sandbox.dir.path().join("backups").join("gemini"))));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for copy in &copies {
            let mode = std::fs::metadata(copy).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{}", copy.display());
        }
    }
    // A file that did not exist has nothing to copy.
    let created = sandbox
        .apply(vec![set(McpAppType::Kiro, "x", stdio("x", &[], &[]))])
        .await;
    assert!(result_of(&created, McpAppType::Kiro)
        .backup_paths
        .is_empty());
    assert!(sandbox.backups(McpAppType::Kiro).is_empty());
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_config_keeps_its_link_and_a_file_keeps_its_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = Sandbox::new();
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;

    // Claude's config is a link into a dotfiles checkout.
    let real = sandbox.dir.path().join("dotfiles").join("claude.json");
    write(&real, CLAUDE);
    std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o640)).unwrap();
    let link = sandbox.path(McpAppType::ClaudeCode);
    std::fs::create_dir_all(link.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(sandbox.agent(McpAppType::ClaudeCode).config.symlink);

    // Gemini's is an ordinary file the user made group-readable.
    sandbox.write(McpAppType::Gemini, "{}");
    std::fs::set_permissions(
        sandbox.path(McpAppType::Gemini),
        std::fs::Permissions::from_mode(0o644),
    )
    .unwrap();

    let result = sandbox
        .apply(vec![
            remove(McpAppType::ClaudeCode, "files"),
            set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            set(McpAppType::Kiro, "x", stdio("x", &[], &[])),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");

    assert!(fsio::is_symlink(&link), "the link is still a link");
    assert!(!std::fs::read_to_string(&real)
        .unwrap()
        .contains("server-files"));
    assert_eq!(mode(&real), 0o640);
    assert_eq!(mode(&sandbox.path(McpAppType::Gemini)), 0o644);
    // A file codeg creates is the owner's alone, and so is Claude's new
    // settings file.
    assert_eq!(mode(&sandbox.path(McpAppType::Kiro)), 0o600);
    // No temp file is left next to any of them.
    for dir in [
        real.parent().unwrap(),
        link.parent().unwrap(),
        sandbox.path(McpAppType::Gemini).parent().unwrap(),
    ] {
        let stray: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(stray.is_empty(), "{stray:?}");
    }
}

#[cfg(unix)]
#[tokio::test]
async fn a_file_made_read_only_is_left_alone() {
    use std::os::unix::fs::PermissionsExt;
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Gemini, "{}");
    let path = sandbox.path(McpAppType::Gemini);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();

    let agent = sandbox.agent(McpAppType::Gemini);
    assert_eq!(agent.config.status, McpFileStatus::ReadOnly);
    assert_eq!(
        agent.config.reason.map(|reason| reason.code).as_deref(),
        Some(codes::FILE_NOT_WRITABLE)
    );
    assert!(!agent.writable);
    let result = sandbox
        .apply(vec![set(McpAppType::Gemini, "x", stdio("x", &[], &[]))])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::Invalid);
    assert_eq!(
        issue_codes(result_of(&result, McpAppType::Gemini)),
        [codes::FILE_READ_ONLY]
    );
    assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));
}

/// The third file's write fails: the two already written are put back as
/// they were, and each agent says what happened to it.
#[tokio::test]
async fn a_write_that_fails_part_way_puts_back_what_was_written() {
    let _hooks = HooksGuard;
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    let gemini_before = r#"{"mcpServers": {"keep": {"command": "keep"}}}"#;
    sandbox.write(McpAppType::Gemini, gemini_before);
    sandbox.write(McpAppType::Cursor, "{}");

    hooks::fail_write_of(Some(sandbox.path(McpAppType::Cursor)));
    let definition = stdio("x", &[], &[]);
    let result = sandbox
        .apply(vec![
            set(McpAppType::ClaudeCode, "x", definition.clone()),
            // A file codeg creates on the way: gone again afterwards.
            set(McpAppType::Kiro, "x", definition.clone()),
            set(McpAppType::Gemini, "x", definition.clone()),
            set(McpAppType::Cursor, "x", definition.clone()),
            set(McpAppType::Cline, "x", definition.clone()),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::WriteFailed);
    assert!(!result.ok);
    let status = |app| result_of(&result, app).status;
    assert_eq!(status(McpAppType::ClaudeCode), McpAgentStatus::Restored);
    assert_eq!(status(McpAppType::Kiro), McpAgentStatus::Restored);
    assert_eq!(status(McpAppType::Gemini), McpAgentStatus::Restored);
    assert_eq!(status(McpAppType::Cursor), McpAgentStatus::WriteFailed);
    assert_eq!(status(McpAppType::Cline), McpAgentStatus::NotWritten);
    assert_eq!(
        issue_codes(result_of(&result, McpAppType::Cursor)),
        [codes::WRITE_FAILED]
    );

    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).as_deref(),
        Some(CLAUDE)
    );
    assert!(
        !sandbox.gate(McpAppType::ClaudeCode).exists(),
        "the settings file codeg made is gone again"
    );
    assert!(sandbox.read(McpAppType::Kiro).is_none());
    assert_eq!(
        sandbox.read(McpAppType::Gemini).as_deref(),
        Some(gemini_before)
    );
    assert_eq!(sandbox.read(McpAppType::Cursor).as_deref(), Some("{}"));
    assert!(sandbox.read(McpAppType::Cline).is_none());
    // The basis handed back is each file's as it is now: the original's.
    assert_eq!(
        result_of(&result, McpAppType::ClaudeCode).basis.as_deref(),
        Some(fsio::sha256_hex(CLAUDE.as_bytes()).as_str())
    );
    // The copies taken before the writes are still there.
    assert_eq!(
        result_of(&result, McpAppType::ClaudeCode)
            .backup_paths
            .len(),
        1
    );
    assert_eq!(
        std::fs::read_to_string(&result_of(&result, McpAppType::Gemini).backup_paths[0]).unwrap(),
        gemini_before
    );
    assert!(super::apply::changed_agents(&result).is_empty());
}

/// Something else changes a file between codeg's write and the undo: that
/// file is left as it is, and the result points at the copy from before.
#[tokio::test]
async fn a_file_changed_again_before_the_undo_is_left_as_it_is() {
    let _hooks = HooksGuard;
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::ClaudeCode, CLAUDE);
    let gemini_before = r#"{"mcpServers": {"keep": {"command": "keep"}}}"#;
    sandbox.write(McpAppType::Gemini, gemini_before);
    sandbox.write(McpAppType::Cursor, "{}");

    let claude_path = sandbox.path(McpAppType::ClaudeCode);
    let theirs = r#"{"mcpServers": {}, "written": "by claude itself"}"#;
    hooks::after_write(Some(Box::new({
        let claude_path = claude_path.clone();
        move |path: &Path| {
            if path == claude_path {
                std::fs::write(&claude_path, theirs).unwrap();
            }
        }
    })));
    hooks::fail_write_of(Some(sandbox.path(McpAppType::Cursor)));

    let definition = stdio("x", &[], &[]);
    let result = sandbox
        .apply(vec![
            set(McpAppType::ClaudeCode, "x", definition.clone()),
            set(McpAppType::Gemini, "x", definition.clone()),
            set(McpAppType::Cursor, "x", definition.clone()),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::WriteFailed);
    let claude = result_of(&result, McpAppType::ClaudeCode);
    assert_eq!(claude.status, McpAgentStatus::RestoreSkipped);
    assert_eq!(issue_codes(claude), [codes::CHANGED_AFTER_WRITE]);
    assert_eq!(
        claude.issues[0].field.as_deref(),
        Some(claude_path.display().to_string().as_str())
    );
    // What Claude wrote stays; what codeg had before is in the copy.
    assert_eq!(
        sandbox.read(McpAppType::ClaudeCode).as_deref(),
        Some(theirs)
    );
    assert_eq!(
        std::fs::read_to_string(&claude.backup_paths[0]).unwrap(),
        CLAUDE
    );
    // The settings file nobody else touched is put back (it did not exist).
    assert!(!sandbox.gate(McpAppType::ClaudeCode).exists());
    // The others are undone as usual.
    assert_eq!(
        result_of(&result, McpAppType::Gemini).status,
        McpAgentStatus::Restored
    );
    assert_eq!(
        sandbox.read(McpAppType::Gemini).as_deref(),
        Some(gemini_before)
    );
    assert_eq!(
        super::apply::changed_agents(&result),
        [McpAppType::ClaudeCode],
        "the one file that is not what it was"
    );
}

/// An agent rewrites its file after the basis check and before codeg's
/// write: caught at the write, and nothing of codeg's lands on top of it.
#[tokio::test]
async fn a_file_changed_between_the_check_and_the_write_is_not_overwritten() {
    let _hooks = HooksGuard;
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Gemini, "{}");
    sandbox.write(McpAppType::Cursor, "{}");
    let cursor_path = sandbox.path(McpAppType::Cursor);
    let theirs = r#"{"mcpServers": {"theirs": {"command": "t"}}}"#;
    hooks::after_write(Some(Box::new({
        let cursor_path = cursor_path.clone();
        let gemini_path = sandbox.path(McpAppType::Gemini);
        move |path: &Path| {
            // While codeg is busy with Gemini's file, Cursor saves its own.
            if path == gemini_path {
                std::fs::write(&cursor_path, theirs).unwrap();
            }
        }
    })));
    let result = sandbox
        .apply(vec![
            set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            set(McpAppType::Cursor, "x", stdio("x", &[], &[])),
        ])
        .await;
    assert_eq!(result.outcome, McpApplyOutcome::WriteFailed);
    let cursor = result_of(&result, McpAppType::Cursor);
    assert_eq!(cursor.status, McpAgentStatus::WriteFailed);
    assert_eq!(issue_codes(cursor), [codes::BASIS_MISMATCH]);
    assert_eq!(sandbox.read(McpAppType::Cursor).as_deref(), Some(theirs));
    assert_eq!(
        result_of(&result, McpAppType::Gemini).status,
        McpAgentStatus::Restored
    );
    assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));
}

#[tokio::test]
async fn a_save_waits_for_the_mcp_write_lock_and_gives_up_as_busy() {
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Gemini, "{}");
    let request = sandbox.request(vec![set(McpAppType::Gemini, "x", stdio("x", &[], &[]))]);

    // Another writer — the Grok panel, say — holds the lock.
    let held = super::lock::acquire_at(&sandbox.ctx.lock_path, super::lock::LOCK_WAIT)
        .await
        .unwrap();
    let ctx = sandbox.ctx.clone();
    let waiting = tokio::spawn({
        let request = request.clone();
        async move { apply_in(&ctx, &request).await }
    });
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert_eq!(
        sandbox.read(McpAppType::Gemini).as_deref(),
        Some("{}"),
        "nothing is written while the lock is someone else's"
    );
    drop(held);
    let result = waiting.await.unwrap();
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");

    // Held for the whole wait: the save gives up, says so, and writes
    // nothing.
    let before = sandbox.read(McpAppType::Gemini);
    let held = super::lock::acquire_at(&sandbox.ctx.lock_path, super::lock::LOCK_WAIT)
        .await
        .unwrap();
    let mut impatient = sandbox.ctx.clone();
    impatient.lock_wait = std::time::Duration::from_millis(120);
    let request = sandbox.request(vec![set(McpAppType::Gemini, "y", stdio("y", &[], &[]))]);
    let busy = apply_in(&impatient, &request).await;
    drop(held);
    assert_eq!(busy.outcome, McpApplyOutcome::Busy);
    assert!(!busy.ok);
    let gemini = result_of(&busy, McpAppType::Gemini);
    assert_eq!(gemini.status, McpAgentStatus::NotWritten);
    assert_eq!(issue_codes(gemini), [codes::LOCK_BUSY]);
    assert_eq!(sandbox.read(McpAppType::Gemini), before);
}

/// A caller's own step after the save — the record the Harness page keeps of
/// what it installed — runs before the MCP write lock is let go, and only
/// when there was a save for it to follow.
#[tokio::test]
async fn a_callers_step_after_a_save_runs_while_the_lock_is_still_held() {
    use super::lock::{acquire_at, acquire_blocking_at, McpLockError, LOCK_WAIT};
    let sandbox = Sandbox::new();
    sandbox.write(McpAppType::Gemini, "{}");
    let request = sandbox.request(vec![set(McpAppType::Gemini, "x", stdio("x", &[], &[]))]);
    let lock_path = sandbox.ctx.lock_path.clone();
    let brief = std::time::Duration::from_millis(80);

    let (result, seen) = super::apply_in_then(&sandbox.ctx, &request, |result| {
        // The file is written, and nobody else can come for the lock yet.
        (
            result.outcome,
            sandbox.read(McpAppType::Gemini),
            acquire_blocking_at(&lock_path, brief).err(),
        )
    })
    .await;
    assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
    let (outcome, on_disk, taken) = seen.expect("the step ran");
    assert_eq!(outcome, McpApplyOutcome::Applied);
    assert!(on_disk.unwrap().contains("\"x\""));
    assert_eq!(taken, Some(McpLockError::Busy));
    // Let go once the step is done.
    assert!(acquire_at(&lock_path, LOCK_WAIT).await.is_ok());

    // A save that wrote nothing still has its step run, with the result that
    // says so: the file is no longer the one this request saw.
    let (stale, seen) = super::apply_in_then(&sandbox.ctx, &request, |result| result.outcome).await;
    assert_eq!(stale.outcome, McpApplyOutcome::ChangedElsewhere);
    assert_eq!(seen, Some(McpApplyOutcome::ChangedElsewhere));

    // A preflight takes no lock and has nothing to follow.
    let mut next = sandbox.request(vec![set(McpAppType::Gemini, "y", stdio("y", &[], &[]))]);
    next.preflight = true;
    let (checked, seen) = super::apply_in_then(&sandbox.ctx, &next, |_| ()).await;
    assert_eq!(checked.outcome, McpApplyOutcome::Preflight);
    assert_eq!(seen, None);

    // Nor does a save that never got the lock.
    next.preflight = false;
    let held = acquire_at(&lock_path, LOCK_WAIT).await.unwrap();
    let mut impatient = sandbox.ctx.clone();
    impatient.lock_wait = brief;
    let (busy, seen) = super::apply_in_then(&impatient, &next, |_| ()).await;
    drop(held);
    assert_eq!(busy.outcome, McpApplyOutcome::Busy);
    assert_eq!(seen, None);
    assert!(!sandbox.read(McpAppType::Gemini).unwrap().contains("\"y\""));
}

// ─── The retired commands ───────────────────────────────────────────────

mod retired {
    use super::*;
    use crate::commands::mcp::mcp_remove_server_core;
    use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};
    use std::sync::Arc;

    /// `mcp_remove_server`, the way an older client of this server still
    /// calls it: it waits its turn at the MCP write lock, reaches Codex's
    /// config.toml through the commit — so the rest of the file stays as it
    /// is — and says which agent changed, and nothing else.
    #[tokio::test]
    async fn a_retired_command_takes_the_lock_and_says_which_agent_changed() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex-home");
        let config = home.join("config.toml");
        let before = "# mine\nmodel = \"gpt-5.5\" # the default\n\n[mcp_servers.gone]\ncommand = \"gone\"\n\n[mcp_servers.kept]\ncommand = \"kept\" # as is\n";
        write(&config, before);
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut events = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let remove_from_codex = |emitter: EventEmitter| async move {
            mcp_remove_server_core(&emitter, "gone".to_string(), Some(vec![McpAppType::Codex]))
                .await
        };

        temp_env::async_with_vars([("CODEX_HOME", Some(home.as_os_str()))], async {
            // Another writer holds the lock: the command writes nothing yet.
            let held = crate::commands::mcp_engine::lock::acquire().await.unwrap();
            let removing = tokio::spawn(remove_from_codex(emitter.clone()));
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            assert_eq!(std::fs::read_to_string(&config).unwrap(), before);
            assert!(events.try_recv().is_err(), "nothing changed yet");
            drop(held);
            assert!(removing.await.unwrap().unwrap(), "the server was removed");

            let after = std::fs::read_to_string(&config).unwrap();
            assert!(after.contains("# mine"), "{after}");
            assert!(
                after.contains("model = \"gpt-5.5\" # the default"),
                "{after}"
            );
            assert!(after.contains("command = \"kept\" # as is"), "{after}");
            let parsed: toml::Table = after.parse().unwrap();
            assert!(parsed["mcp_servers"].get("gone").is_none(), "{after}");
            assert!(parsed["mcp_servers"].get("kept").is_some(), "{after}");

            let event = events.try_recv().expect("the change is announced");
            assert_eq!(event.channel, MCP_CHANGED_EVENT);
            assert_eq!(*event.payload, json!({"agents": ["codex"]}));

            // Nothing left to remove: nothing written, nothing announced.
            assert!(!remove_from_codex(emitter.clone()).await.unwrap());
            assert_eq!(std::fs::read_to_string(&config).unwrap(), after);
            assert!(events.try_recv().is_err());
        })
        .await;
    }
}

// ─── Codex ──────────────────────────────────────────────────────────────

mod codex {
    use super::*;
    use crate::acp::codex_catalog_commit::tests::Env;
    use crate::acp::codex_catalog_commit::{
        compose_toml, lock_home, prepare, AuthInput, Binding, CurrentIntent, FetchPolicy,
        LockedHome, Origin, PrepareInput, Prepared, ReleaseModel, TomlInput, CONFIG_REL,
    };

    const INTENT: &str = r#"{"customs":[{"slug":"gw/x","base":"gpt-6.1-sol"}],"default":"gw/x"}"#;
    const CONFIG: &str = "# mine\nmodel = \"gpt-5.5\" # the default\n\n[mcp_servers.keep]\ncommand = \"keep\" # as is\n";

    /// A sandbox whose Codex is the model-catalog tests' home, so one
    /// config.toml takes both kinds of commit.
    fn sandbox_in(env: &Env) -> Sandbox {
        let mut sandbox = Sandbox::new();
        sandbox.ctx.paths.insert(
            McpAppType::Codex,
            AgentPaths {
                servers: env.home().join(CONFIG_REL),
                plugin_gate: None,
            },
        );
        sandbox
    }

    /// The part of a model-catalog save that runs outside the lock.
    async fn prepare_catalog(env: &Env) -> Prepared {
        let published = env.published();
        let config = compose_toml(&TomlInput::disk(), published.config_text()).unwrap();
        prepare(PrepareInput {
            origin: Origin::User,
            binding: Binding::Panel,
            intent_raw: Some(INTENT.to_string()),
            toml_text: &config,
            auth_text: published.auth_text(),
            published: &published,
            fetch: FetchPolicy::IfNeeded,
            cache: &env.cache,
        })
        .await
        .unwrap()
    }

    /// The part that runs under it.
    async fn commit_catalog(locked: &LockedHome, prepared: &Prepared) {
        locked
            .commit(
                prepared,
                &CurrentIntent {
                    binding: Binding::Panel,
                    intent_raw: Some(INTENT.to_string()),
                },
                &TomlInput::disk(),
                &AuthInput::Keep,
                &ReleaseModel::Keep,
            )
            .await
            .unwrap();
    }

    fn assert_both_landed(config: &str) {
        assert!(config.contains("# mine"), "{config}");
        assert!(config.contains("command = \"keep\" # as is"), "{config}");
        let parsed: toml::Table = config.parse().unwrap();
        // The model catalog's keys …
        assert_eq!(parsed["model"].as_str(), Some("gw/x"));
        assert_eq!(
            parsed["model_catalog_json"].as_str(),
            Some("codeg-model-catalog.json")
        );
        // … and the MCP server.
        assert_eq!(
            parsed["mcp_servers"]["added"]["command"].as_str(),
            Some("npx")
        );
        assert_eq!(
            parsed["mcp_servers"]["keep"]["command"].as_str(),
            Some("keep")
        );
    }

    /// The MCP save lands while a model-catalog save is between its
    /// preparation and its commit: the commit starts from the file as the
    /// MCP save left it.
    #[tokio::test]
    async fn an_mcp_save_before_a_model_catalog_commit_survives_it() {
        let env = Env::new();
        env.write(CONFIG_REL, CONFIG);
        let sandbox = sandbox_in(&env);

        let prepared = prepare_catalog(&env).await;
        let result = sandbox
            .apply(vec![set(
                McpAppType::Codex,
                "added",
                stdio("npx", &["-y", "added"], &[]),
            )])
            .await;
        assert_eq!(result.outcome, McpApplyOutcome::Applied, "{result:?}");
        let locked = lock_home(&env.home()).await.unwrap();
        commit_catalog(&locked, &prepared).await;
        drop(locked);

        assert_both_landed(&env.read(CONFIG_REL).unwrap());
    }

    /// The MCP save arrives while a model-catalog commit holds Codex's lock:
    /// it waits, finds the file is no longer the one the user saw, and writes
    /// nothing; saved again on the new file, both changes are there.
    #[tokio::test]
    async fn an_mcp_save_during_a_model_catalog_commit_waits_and_does_not_clobber_it() {
        let env = Env::new();
        env.write(CONFIG_REL, CONFIG);
        let sandbox = sandbox_in(&env);
        let ops = vec![set(
            McpAppType::Codex,
            "added",
            stdio("npx", &["-y", "added"], &[]),
        )];
        let request = sandbox.request(ops.clone());

        let prepared = prepare_catalog(&env).await;
        let locked = lock_home(&env.home()).await.unwrap();
        let waiting = tokio::spawn({
            let ctx = sandbox.ctx.clone();
            async move { apply_in(&ctx, &request).await }
        });
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert_eq!(
            env.read(CONFIG_REL).as_deref(),
            Some(CONFIG),
            "the MCP save is waiting for Codex's lock"
        );
        commit_catalog(&locked, &prepared).await;
        let after_catalog = env.read(CONFIG_REL).unwrap();
        drop(locked);

        let result = waiting.await.unwrap();
        assert_eq!(result.outcome, McpApplyOutcome::ChangedElsewhere);
        assert_eq!(
            env.read(CONFIG_REL).unwrap(),
            after_catalog,
            "nothing written over the model catalog's commit"
        );

        // The page scans again and the user confirms on the file as it is.
        let again = sandbox.apply(ops).await;
        assert_eq!(again.outcome, McpApplyOutcome::Applied, "{again:?}");
        assert_both_landed(&env.read(CONFIG_REL).unwrap());
    }

    /// Codex's file is never written without its lock: when the lock cannot
    /// be had, the save says so and writes nothing — not even the other
    /// agents' files.
    #[tokio::test]
    async fn without_codexs_lock_nothing_is_written() {
        let sandbox = Sandbox::new();
        sandbox.write(McpAppType::Codex, CODEX);
        sandbox.write(McpAppType::Gemini, "{}");
        let request = sandbox.request(vec![
            set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            set(McpAppType::Codex, "x", stdio("x", &[], &[])),
        ]);
        let failed = CodexAccess::Failed(McpOpIssue::new(codes::CODEX_LOCK_BUSY));
        let result = apply::apply_locked(&sandbox.ctx, &request, &failed);
        assert_eq!(result.outcome, McpApplyOutcome::Busy);
        assert_eq!(
            issue_codes(result_of(&result, McpAppType::Codex)),
            [codes::CODEX_LOCK_BUSY]
        );
        assert_eq!(
            result_of(&result, McpAppType::Gemini).status,
            McpAgentStatus::NotWritten
        );
        assert_eq!(sandbox.read(McpAppType::Codex).as_deref(), Some(CODEX));
        assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));

        // And a commit that reached this far without the lock refuses too.
        let result = apply::apply_locked(&sandbox.ctx, &request, &CodexAccess::Unlocked);
        assert_eq!(result.outcome, McpApplyOutcome::WriteFailed);
        assert_eq!(sandbox.read(McpAppType::Codex).as_deref(), Some(CODEX));
        assert_eq!(
            sandbox.read(McpAppType::Gemini).as_deref(),
            Some("{}"),
            "the file written before Codex's is put back"
        );
    }

    /// A model-catalog commit that keeps Codex's lock for longer than a save
    /// waits: the save does not wait for ever. It gives up as busy, writes
    /// nothing — not the other agents' files either — and lets go of the MCP
    /// write lock, so the next save goes through.
    #[tokio::test]
    async fn an_mcp_save_gives_up_when_codexs_lock_stays_taken() {
        use crate::acp::codex_catalog_commit::LOCK_WAIT;
        let env = Env::new();
        env.write(CONFIG_REL, CONFIG);
        let sandbox = sandbox_in(&env);
        sandbox.write(McpAppType::Gemini, "{}");
        let ops = vec![
            set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            set(
                McpAppType::Codex,
                "added",
                stdio("npx", &["-y", "added"], &[]),
            ),
        ];
        let request = sandbox.request(ops.clone());

        let locked = lock_home(&env.home()).await.unwrap();
        let started = std::time::Instant::now();
        let result = apply_in(&sandbox.ctx, &request).await;
        let waited = started.elapsed();
        assert!(
            waited >= LOCK_WAIT - std::time::Duration::from_millis(500),
            "the save waited for Codex's lock: {waited:?}"
        );
        assert!(
            waited < LOCK_WAIT * 3,
            "and no longer than the two locks allow: {waited:?}"
        );
        assert_eq!(result.outcome, McpApplyOutcome::Busy, "{result:?}");
        assert!(!result.ok);
        let codex = result_of(&result, McpAppType::Codex);
        assert_eq!(codex.status, McpAgentStatus::NotWritten);
        assert_eq!(issue_codes(codex), [codes::CODEX_LOCK_BUSY]);
        assert_eq!(
            result_of(&result, McpAppType::Gemini).status,
            McpAgentStatus::NotWritten
        );
        assert_eq!(env.read(CONFIG_REL).as_deref(), Some(CONFIG));
        assert_eq!(sandbox.read(McpAppType::Gemini).as_deref(), Some("{}"));
        assert!(super::super::apply::changed_agents(&result).is_empty());

        // The model catalog is done: the same save, confirmed again, lands.
        drop(locked);
        let again = sandbox.apply(ops).await;
        assert_eq!(again.outcome, McpApplyOutcome::Applied, "{again:?}");
        assert!(env
            .read(CONFIG_REL)
            .unwrap()
            .contains("[mcp_servers.added]"));
        assert!(sandbox.read(McpAppType::Gemini).unwrap().contains("\"x\""));
    }

    /// Undoing a write of Codex's file goes through its commit as well.
    #[tokio::test]
    async fn a_failed_save_puts_codexs_file_back_through_its_commit() {
        let _hooks = HooksGuard;
        let sandbox = Sandbox::new();
        sandbox.write(McpAppType::Codex, CODEX);
        sandbox.write(McpAppType::Gemini, "{}");
        hooks::fail_write_of(Some(sandbox.path(McpAppType::Gemini)));
        let result = sandbox
            .apply(vec![
                set(McpAppType::Codex, "x", stdio("x", &[], &[])),
                set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            ])
            .await;
        assert_eq!(result.outcome, McpApplyOutcome::WriteFailed);
        assert_eq!(
            result_of(&result, McpAppType::Codex).status,
            McpAgentStatus::Restored
        );
        assert_eq!(sandbox.read(McpAppType::Codex).as_deref(), Some(CODEX));

        // A config.toml the save itself created is taken away again.
        std::fs::remove_file(sandbox.path(McpAppType::Codex)).unwrap();
        let result = sandbox
            .apply(vec![
                set(McpAppType::Codex, "x", stdio("x", &[], &[])),
                set(McpAppType::Gemini, "x", stdio("x", &[], &[])),
            ])
            .await;
        assert_eq!(
            result_of(&result, McpAppType::Codex).status,
            McpAgentStatus::Restored
        );
        assert!(sandbox.read(McpAppType::Codex).is_none());
    }
}

// ─── What a session gets ────────────────────────────────────────────────

mod session {
    use super::*;
    use crate::commands::mcp_engine::session::servers_for_session;

    fn env(pairs: &[(&str, &str)]) -> AgentEnv {
        AgentEnv::with_overrides(pairs)
    }

    /// With `CODEX_HOME` set in the agent's settings, the servers are read
    /// from that directory — and one switched off there is not sent.
    #[test]
    fn the_servers_come_from_where_the_agent_is_launched_and_disabled_ones_stay_home() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("codex-home");
        write(
            &home.join("config.toml"),
            r#"
[mcp_servers.on]
command = "npx"
args = ["-y", "on"]
cwd = "/work"
startup_timeout_sec = 20

[mcp_servers.on.env]
TOKEN = "t"

[mcp_servers.off]
command = "off"
enabled = false

[mcp_servers.remote]
url = "https://r.test/mcp"
http_headers = { "X-Key" = "k" }

[mcp_servers.codeg-mcp]
command = "not-the-built-in"

[mcp_servers.broken]
args = ["no command"]
"#,
        );
        let sent = servers_for_session(
            AgentType::Codex,
            &env(&[("CODEX_HOME", home.to_str().unwrap())]),
        )
        .unwrap();
        assert_eq!(
            Value::Object(sent.into_iter().collect()),
            json!({
                "on": {"type": "stdio", "command": "npx", "args": ["-y", "on"], "env": {"TOKEN": "t"}},
                "remote": {"type": "http", "url": "https://r.test/mcp", "headers": {"X-Key": "k"}}
            })
        );

        // Another home: other servers. Nothing is read from the first.
        let empty = dir.path().join("empty-home");
        assert!(servers_for_session(
            AgentType::Codex,
            &env(&[("CODEX_HOME", empty.to_str().unwrap())])
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn each_agents_own_switch_keeps_a_server_out_of_its_sessions() {
        let dir = tempfile::tempdir().unwrap();
        // CodeBuddy: a list of names beside the servers.
        let codebuddy = dir.path().join("codebuddy");
        write(
            &codebuddy.join(".codebuddy.json"),
            r#"{"mcpServers": {"on": {"command": "on"}, "off": {"command": "off"}}, "disabledMcpServers": ["off"]}"#,
        );
        let sent = servers_for_session(
            AgentType::CodeBuddy,
            &env(&[("CODEBUDDY_CONFIG_DIR", codebuddy.to_str().unwrap())]),
        )
        .unwrap();
        assert_eq!(sent.keys().collect::<Vec<_>>(), ["on"]);

        // DeepSeek: codeg's own store, codeg's own flag; SSE would fail the
        // whole session and is not sent.
        let dsh = dir.path().join("dsh");
        write(
            &dsh.join("mcp.json"),
            r#"{"mcpServers": {
                "on": {"type": "http", "url": "https://on.test/mcp"},
                "off": {"type": "stdio", "command": "off", "disabled": true},
                "sse": {"type": "sse", "url": "https://sse.test"}
            }}"#,
        );
        let sent = servers_for_session(
            AgentType::DeepSeek,
            &env(&[("DSH_HOME", dsh.to_str().unwrap())]),
        )
        .unwrap();
        assert_eq!(sent.keys().collect::<Vec<_>>(), ["on"]);
        assert_eq!(
            sent["on"],
            json!({"type": "http", "url": "https://on.test/mcp"})
        );
    }

    /// A name that is there twice in the file: the session is sent what the
    /// agent itself reads — the last one, the one the listing shows.
    #[test]
    fn a_session_is_sent_the_occurrence_the_agent_reads() {
        let dir = tempfile::tempdir().unwrap();
        let gemini_home = dir.path().join("gemini-home");
        write(
            &gemini_home.join(".gemini").join("settings.json"),
            r#"{"mcpServers": {"x": {"command": "old"}, "x": {"command": "active"}}}"#,
        );
        let sent = servers_for_session(
            AgentType::Gemini,
            &env(&[("GEMINI_CLI_HOME", gemini_home.to_str().unwrap())]),
        )
        .unwrap();
        assert_eq!(
            Value::Object(sent.into_iter().collect()),
            json!({"x": {"type": "stdio", "command": "active"}})
        );
    }

    #[test]
    fn pi_and_custom_agents_are_sent_nothing_and_a_broken_file_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let pi = dir.path().join("pi");
        write(
            &pi.join("mcp.json"),
            r#"{"mcpServers": {"p": {"command": "p"}}}"#,
        );
        assert!(servers_for_session(
            AgentType::Pi,
            &env(&[("PI_CODING_AGENT_DIR", pi.to_str().unwrap())])
        )
        .unwrap()
        .is_empty());
        assert!(
            servers_for_session(AgentType::Custom("some-agent"), &AgentEnv::inherited())
                .unwrap()
                .is_empty()
        );

        let gemini_home = dir.path().join("gemini-home");
        write(
            &gemini_home.join(".gemini").join("settings.json"),
            "{ \"mcpServers\": ",
        );
        let error = servers_for_session(
            AgentType::Gemini,
            &env(&[("GEMINI_CLI_HOME", gemini_home.to_str().unwrap())]),
        )
        .unwrap_err();
        assert!(error.message.contains("invalid_json"), "{}", error.message);
        assert!(
            error.message.contains("settings.json"),
            "names the file: {}",
            error.message
        );
    }
}

// ─── The command surface ────────────────────────────────────────────────

/// With `CODEX_HOME` set in codeg's settings for Codex, the engine's Codex
/// file is the one in that directory.
#[tokio::test]
async fn the_engine_reads_each_agents_environment_from_its_settings() {
    use crate::db::service::agent_setting_service::{
        ensure_defaults, update, AgentDefaultInput, AgentSettingsUpdate,
    };
    let db = crate::db::test_helpers::fresh_in_memory_db().await;
    ensure_defaults(
        &db.conn,
        &[AgentDefaultInput {
            agent_type: AgentType::Codex,
            registry_id: "codex".to_string(),
            default_sort_order: 0,
        }],
    )
    .await
    .unwrap();
    update(
        &db.conn,
        AgentType::Codex,
        AgentSettingsUpdate {
            enabled: true,
            env_json: Some(r#"{"CODEX_HOME":"/srv/team-codex"}"#.to_string()),
            model_provider_id: None,
        },
    )
    .await
    .unwrap();
    // What `mcp_inventory` and `mcp_apply` build their paths from.
    let envs = crate::db::service::agent_setting_service::load_agent_envs(&db.conn).await;
    assert_eq!(
        super::agents::resolve_paths(McpAppType::Codex, &envs.get(AgentType::Codex)).servers,
        PathBuf::from("/srv/team-codex/config.toml")
    );
    // An agent with no settings of its own is launched with codeg's
    // environment, and found there.
    assert_eq!(envs.get(AgentType::Grok), AgentEnv::inherited());
    // The lock and the copies of a test run are nowhere near the real home.
    assert!(super::lock::default_lock_path().starts_with(std::env::temp_dir()));
    assert!(super::agents::default_backup_root().starts_with(std::env::temp_dir()));
}

#[test]
fn the_event_says_which_agents_changed_and_nothing_else() {
    use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};
    use std::sync::Arc;
    let broadcaster = Arc::new(WebEventBroadcaster::new());
    let mut events = broadcaster.subscribe();
    let emitter = EventEmitter::test_web_only(broadcaster.clone());

    super::announce_changed(&emitter, &[]);
    assert!(events.try_recv().is_err(), "nothing changed, nothing said");

    super::announce_changed(
        &emitter,
        &[McpAppType::Codex, McpAppType::ClaudeCode, McpAppType::Codex],
    );
    let event = events.try_recv().unwrap();
    assert_eq!(event.channel, MCP_CHANGED_EVENT);
    assert_eq!(*event.payload, json!({"agents": ["claude_code", "codex"]}));
}

#[test]
fn a_request_reads_as_the_page_sends_it() {
    let text = r#"{
        "basis": {"claude_code": "abc", "codex": "missing"},
        "ops": [
            {"agent": "claude_code", "key": "a", "action": "set",
             "definition": {"type": "stdio", "command": "npx", "args": ["-y", "a"], "env": {"K": "v"}}},
            {"agent": "codex", "key": "a", "action": "set",
             "definition": {"type": "http", "url": "https://a.test/mcp", "headers": {"X": "y"}}},
            {"agent": "gemini", "key": "a", "action": "set", "definition": {"type": "sse", "url": "https://a.test/sse"}},
            {"agent": "cline", "key": "b", "action": "remove"},
            {"agent": "kiro", "key": "c", "action": "set_enabled", "enabled": false},
            {"agent": "minimax_code", "key": "d", "action": "rename", "new_key": "e"}
        ],
        "preflight": true
    }"#;
    let expected = McpApplyRequest {
        basis: BTreeMap::from([
            (McpAppType::ClaudeCode, "abc".to_string()),
            (McpAppType::Codex, "missing".to_string()),
        ]),
        ops: vec![
            set(
                McpAppType::ClaudeCode,
                "a",
                stdio("npx", &["-y", "a"], &[("K", "v")]),
            ),
            set(
                McpAppType::Codex,
                "a",
                http("https://a.test/mcp", &[("X", "y")]),
            ),
            set(McpAppType::Gemini, "a", sse("https://a.test/sse")),
            remove(McpAppType::Cline, "b"),
            enable(McpAppType::Kiro, "c", false),
            rename(McpAppType::MiniMaxCode, "d", "e"),
        ],
        preflight: true,
    };
    // From text (the web handler) and from a value (the desktop command).
    assert_eq!(
        serde_json::from_str::<McpApplyRequest>(text).unwrap(),
        expected
    );
    let value: Value = serde_json::from_str(text).unwrap();
    assert_eq!(
        serde_json::from_value::<McpApplyRequest>(value).unwrap(),
        expected
    );
    // `basis` and `preflight` may be left out.
    let bare: McpApplyRequest = serde_json::from_str(r#"{"ops": []}"#).unwrap();
    assert!(bare.basis.is_empty() && !bare.preflight);
    // An unknown action or agent is refused rather than guessed at.
    assert!(
        serde_json::from_str::<McpOp>(r#"{"agent": "codex", "key": "a", "action": "purge"}"#)
            .is_err()
    );
    assert!(
        serde_json::from_str::<McpOp>(r#"{"agent": "vim", "key": "a", "action": "remove"}"#)
            .is_err()
    );
}

#[tokio::test]
async fn results_and_the_inventory_are_shaped_for_the_page() {
    let sandbox = Sandbox::new();
    sandbox.write(
        McpAppType::Cline,
        r#"{"mcpServers": {"x": {"command": "x", "disabled": true, "autoApprove": ["a"]}}}"#,
    );
    let listed = serde_json::to_value(sandbox.agent(McpAppType::Cline)).unwrap();
    let path = sandbox.path(McpAppType::Cline).display().to_string();
    assert_eq!(
        listed,
        json!({
            "agent": "cline",
            "installed": null,
            "config": {
                "path": path,
                "format": "json",
                "status": "ok",
                "basis": sandbox.basis(McpAppType::Cline),
                "symlink": false,
                "comments_lost_on_write": false,
                "related": []
            },
            "writable": true,
            "transports": ["stdio", "http", "sse"],
            "delivery": "agent_file",
            "can_disable": true,
            "codeg_mcp": false,
            "session_capabilities": null,
            "entries": [{
                "key": "x",
                "definition": {"type": "stdio", "command": "x"},
                "extra": {"autoApprove": ["a"]},
                "enabled": false,
                "fingerprint": stdio("x", &[], &[]).fingerprint(),
                "read_only": false,
                "reserved": false,
                "legacy": false,
                "problems": []
            }]
        })
    );

    let result = sandbox
        .apply(vec![
            enable(McpAppType::Cline, "x", true),
            remove(McpAppType::Cline, "absent"),
        ])
        .await;
    let value = serde_json::to_value(&result).unwrap();
    let backup = result_of(&result, McpAppType::Cline).backup_paths[0].clone();
    assert_eq!(
        value,
        json!({
            "outcome": "applied",
            "ok": true,
            "agents": [{
                "agent": "cline",
                "path": path,
                "status": "written",
                "basis": sandbox.basis(McpAppType::Cline),
                "issues": [],
                "warnings": [{"code": "entry_not_found", "op_index": 1, "key": "absent"}],
                "ops": [
                    {"index": 0, "key": "x", "effect": "enabled"},
                    {"index": 1, "key": "absent", "effect": "unchanged"}
                ],
                "writes": [{"path": path, "role": "servers", "creates": false}],
                "backup_paths": [backup]
            }]
        })
    );
}
