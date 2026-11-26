//! A bounded, read-only MCP handshake. It never invokes a tool.

mod remote;
#[cfg(test)]
mod tests;

use std::collections::BTreeSet;
use std::process::Stdio;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::commands::mcp::McpAppType;
use crate::db::{service::agent_setting_service, AppDatabase};
use crate::parsers::AgentEnv;

use super::agents::{agent_type_of, EngineCtx};
use super::model::{McpDefinition, McpFileStatus, RESERVED_KEY};

const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
const MAX_TOOLS: usize = 200;
const MAX_TOOL_PAGES: usize = 64;
const STDERR_RETAIN_BYTES: usize = 8 * 1024;
const PROTOCOL_VERSION: &str = "2025-03-26";

#[derive(Deserialize)]
pub struct McpProbeRequest {
    pub agent: Option<McpAppType>,
    pub key: Option<String>,
    pub definition: Option<McpDefinition>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum McpProbeStatus {
    Ok,
    AuthRequired,
    Forbidden,
    SessionIdMismatch,
    SpawnFailed,
    Timeout,
    ProtocolError,
    NetworkError,
    ConfigError,
}

#[derive(Debug, Serialize)]
pub struct McpProbeServerInfo {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpProbeTool {
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct McpProbeAuthHint {
    #[serde(skip_serializing_if = "Option::is_none")]
    scheme: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource_metadata: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct McpProbeResult {
    pub status: McpProbeStatus,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_info: Option<McpProbeServerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    pub tools: Vec<McpProbeTool>,
    pub tools_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_hint: Option<McpProbeAuthHint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<String>,
    pub checked_at: chrono::DateTime<chrono::Utc>,
}

type ProbeResult<T> = Result<T, ProbeError>;

#[derive(Debug)]
struct ProbeError {
    status: McpProbeStatus,
    detail: &'static str,
    http_status: Option<u16>,
    auth_hint: Option<McpProbeAuthHint>,
}

impl ProbeError {
    fn new(status: McpProbeStatus, detail: &'static str) -> Self {
        Self {
            status,
            detail,
            http_status: None,
            auth_hint: None,
        }
    }

    fn protocol(detail: &'static str) -> Self {
        Self::new(McpProbeStatus::ProtocolError, detail)
    }

    fn config(detail: &'static str) -> Self {
        Self::new(McpProbeStatus::ConfigError, detail)
    }
}

pub async fn mcp_probe_core(db: &AppDatabase, request: McpProbeRequest) -> McpProbeResult {
    let start = Instant::now();
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(8_000).clamp(1_000, 15_000));
    let mut report = empty_report();
    let mut diagnostics = Diagnostics::default();
    let result = tokio::time::timeout(timeout, async {
        let envs = agent_setting_service::load_agent_envs(&db.conn).await;
        let env = request
            .agent
            .map(|app| envs.get(agent_type_of(app)))
            .unwrap_or_default();
        let definition = match (request.definition, request.agent, request.key) {
            (Some(definition), _, None) => definition,
            (None, Some(app), Some(key)) => {
                let ctx = EngineCtx::from_envs(&envs);
                let entry_env = env.clone();
                tokio::task::spawn_blocking(move || stored_definition(&ctx, app, &key, &entry_env))
                    .await
                    .map_err(|_| ProbeError::config("Could not read the MCP configuration"))??
            }
            _ => {
                return Err(ProbeError::config(
                    "Supply a definition or an agent and key",
                ))
            }
        };
        probe(&definition, &env, &mut report, &mut diagnostics).await
    })
    .await;
    finish(report, result, &diagnostics, start)
}

fn stored_definition(
    ctx: &EngineCtx,
    app: McpAppType,
    key: &str,
    env: &AgentEnv,
) -> ProbeResult<McpDefinition> {
    if key == RESERVED_KEY {
        return Err(ProbeError::config("The Codeg companion cannot be probed"));
    }
    let paths = ctx
        .paths_of(app)
        .ok_or_else(|| ProbeError::config("Unknown MCP config location"))?;
    let (config, entries) = super::inventory::read_agent_config(ctx, app, paths);
    if config.status == McpFileStatus::Unreadable {
        return Err(ProbeError::config(
            "The agent's MCP configuration could not be read",
        ));
    }
    let entry = entries
        .into_iter()
        .find(|entry| entry.key == key)
        .ok_or_else(|| ProbeError::config("The MCP entry does not exist"))?;
    let mut definition = entry
        .definition
        .ok_or_else(|| ProbeError::config("The MCP entry has no usable definition"))?;
    // Codex keeps credential references outside the canonical definition.
    // Resolve them on the host with the same overrides as its launch.
    if let (McpAppType::Codex, McpDefinition::Http { headers, .. }) = (app, &mut definition) {
        if let Some(name) = entry
            .extra
            .get("bearer_token_env_var")
            .and_then(Value::as_str)
        {
            let token = env.var(name).ok_or_else(|| {
                ProbeError::config("MCP bearer token environment variable is unset")
            })?;
            headers.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
            headers.insert("Authorization".to_string(), format!("Bearer {token}"));
        }
        if let Some(env_headers) = entry
            .extra
            .get("env_http_headers")
            .and_then(Value::as_object)
        {
            for (header, env_name) in env_headers {
                let value = env_name
                    .as_str()
                    .and_then(|name| env.var(name))
                    .ok_or_else(|| {
                        ProbeError::config("MCP header environment variable is unset")
                    })?;
                headers.retain(|name, _| !name.eq_ignore_ascii_case(header));
                headers.insert(header.clone(), value);
            }
        }
    }
    Ok(definition)
}

fn empty_report() -> McpProbeResult {
    McpProbeResult {
        status: McpProbeStatus::Ok,
        latency_ms: 0,
        server_info: None,
        protocol_version: None,
        tools: Vec::new(),
        tools_count: 0,
        http_status: None,
        auth_hint: None,
        detail: None,
        stderr_tail: None,
        checked_at: chrono::Utc::now(),
    }
}

#[derive(Default)]
struct Diagnostics {
    redact: Redact,
    stderr: Vec<u8>,
}

fn finish(
    mut report: McpProbeResult,
    result: Result<ProbeResult<()>, tokio::time::error::Elapsed>,
    diagnostics: &Diagnostics,
    start: Instant,
) -> McpProbeResult {
    if let Err(error) = result.unwrap_or_else(|_| {
        Err(ProbeError::new(
            McpProbeStatus::Timeout,
            "MCP probe timed out",
        ))
    }) {
        report.status = error.status;
        report.http_status = error.http_status.or(report.http_status);
        report.auth_hint = error.auth_hint;
        report.detail = Some(error.detail.to_owned());
        report.tools.clear();
        report.tools_count = 0;
    }
    if !diagnostics.stderr.is_empty() {
        let cleaned = diagnostics
            .redact
            .clean(&String::from_utf8_lossy(&diagnostics.stderr));
        let start = cleaned
            .char_indices()
            .rev()
            .nth(1023)
            .map_or(0, |(index, _)| index);
        if !cleaned.is_empty() {
            report.stderr_tail = Some(cleaned[start..].to_owned());
        }
    }
    report.latency_ms = start.elapsed().as_millis() as u64;
    report.checked_at = chrono::Utc::now();
    report
}

async fn probe(
    definition: &McpDefinition,
    env: &AgentEnv,
    report: &mut McpProbeResult,
    diagnostics: &mut Diagnostics,
) -> ProbeResult<()> {
    let definition = super::dialect::tidy_definition(definition);
    if !super::dialect::definition_problems(&definition).is_empty() {
        return Err(ProbeError::config("Invalid MCP definition"));
    }
    diagnostics.redact = Redact::new(&definition, env);
    let redact = &diagnostics.redact;
    match &definition {
        McpDefinition::Stdio {
            command,
            args,
            env: extra,
        } => {
            let mut command = tokio::process::Command::new(command);
            command.args(args);
            for (key, value) in env.overrides() {
                if value.is_empty() {
                    command.env_remove(key);
                } else {
                    command.env(key, value);
                }
            }
            command.envs(extra);
            stdio_probe(command, report, &mut diagnostics.stderr, redact).await
        }
        McpDefinition::Http { url, headers } => {
            remote::Remote::new(url, headers)?
                .probe_http(report, redact)
                .await
        }
        McpDefinition::Sse { url, headers } => {
            remote::Remote::new(url, headers)?
                .probe_sse(report, redact)
                .await
        }
    }
}

#[derive(Default)]
struct Redact(Vec<String>);

impl Redact {
    fn new(definition: &McpDefinition, env: &AgentEnv) -> Self {
        let mut values: Vec<&str> = env.overrides().values().map(String::as_str).collect();
        let inherited: Vec<String> = std::env::vars_os()
            .filter_map(|(key, value)| {
                let key = key.to_string_lossy().to_ascii_uppercase();
                [
                    "TOKEN",
                    "SECRET",
                    "PASSWORD",
                    "KEY",
                    "AUTH",
                    "COOKIE",
                    "CREDENTIAL",
                ]
                .iter()
                .any(|part| key.contains(part))
                .then(|| value.into_string().ok())
                .flatten()
            })
            .collect();
        values.extend(inherited.iter().map(String::as_str));
        match definition {
            McpDefinition::Stdio { env, .. } => values.extend(env.values().map(String::as_str)),
            McpDefinition::Http { headers, .. } | McpDefinition::Sse { headers, .. } => {
                for (key, value) in headers {
                    values.push(value);
                    if key.eq_ignore_ascii_case("authorization")
                        || key.eq_ignore_ascii_case("proxy-authorization")
                    {
                        if let Some((_, token)) = value.trim().split_once(char::is_whitespace) {
                            values.push(token.trim());
                        }
                    }
                    if key.eq_ignore_ascii_case("cookie") {
                        values.extend(value.split(';').filter_map(|cookie| {
                            let (_, value) = cookie.trim().split_once('=')?;
                            Some(value.trim().trim_matches('"'))
                        }));
                    }
                }
            }
        }
        let mut values: Vec<_> = values
            .into_iter()
            .map(|value| {
                value
                    .chars()
                    .filter(|c| !c.is_control())
                    .collect::<String>()
            })
            .filter(|value| !value.is_empty())
            .collect();
        values.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
        values.dedup();
        Self(values)
    }

    fn clean(&self, text: &str) -> String {
        let mut text: String = text.chars().filter(|c| !c.is_control()).collect();
        for value in &self.0 {
            // A sentinel keeps text either side of a removed credential separate.
            text = text.replace(value, "\0");
        }
        text.replace('\0', "�")
    }

    fn bounded(&self, text: &str, limit: usize) -> String {
        self.clean(text).chars().take(limit).collect()
    }
}

fn rpc_request(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

fn initialize() -> Value {
    rpc_request(
        1,
        "initialize",
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "codeg-probe", "version": env!("CARGO_PKG_VERSION")}
        }),
    )
}

fn initialized() -> Value {
    json!({"jsonrpc": "2.0", "method": "notifications/initialized"})
}

fn tools_list(page: usize, cursor: Option<&str>) -> Value {
    let params = cursor.map_or_else(|| json!({}), |cursor| json!({"cursor": cursor}));
    rpc_request(2 + page as u64, "tools/list", params)
}

fn decode_message(bytes: &[u8]) -> ProbeResult<Value> {
    serde_json::from_slice(bytes).map_err(|_| ProbeError::protocol("Invalid MCP JSON response"))
}

fn rpc_result(message: Value, id: u64) -> ProbeResult<Option<Value>> {
    if message.get("id").and_then(Value::as_u64) != Some(id) {
        return Ok(None);
    }
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0")
        || message.get("error").is_some()
    {
        return Err(ProbeError::protocol(
            "MCP server rejected a handshake request",
        ));
    }
    match message {
        Value::Object(mut object) => object
            .remove("result")
            .map(Some)
            .ok_or_else(|| ProbeError::protocol("MCP response is missing its result")),
        _ => Err(ProbeError::protocol("Invalid MCP response")),
    }
}

impl McpProbeResult {
    fn record_server(&mut self, result: &Value, redact: &Redact) -> ProbeResult<String> {
        let protocol = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .filter(|version| !version.is_empty() && version.len() <= 128)
            .ok_or_else(|| ProbeError::protocol("Missing or invalid MCP protocol version"))?;
        let server = &result["serverInfo"];
        let name = server
            .get("name")
            .and_then(Value::as_str)
            .filter(|name| !name.trim().is_empty())
            .ok_or_else(|| ProbeError::protocol("Missing MCP server name"))?;
        self.server_info = Some(McpProbeServerInfo {
            name: redact.bounded(name, 256),
            version: server
                .get("version")
                .and_then(Value::as_str)
                .map(|v| redact.bounded(v, 256)),
        });
        self.protocol_version = Some(redact.bounded(protocol, 128));
        Ok(protocol.to_owned())
    }

    fn record_tools(&mut self, result: &Value, redact: &Redact) -> ProbeResult<Option<String>> {
        let tools = result
            .get("tools")
            .and_then(Value::as_array)
            .ok_or_else(|| ProbeError::protocol("Missing MCP tools list"))?;
        self.tools_count += tools.len();
        for tool in tools {
            let name = tool
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or_else(|| ProbeError::protocol("Missing MCP tool name"))?;
            if self.tools.len() < MAX_TOOLS {
                self.tools.push(McpProbeTool {
                    name: redact.bounded(name, 256),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .map(|description| redact.bounded(description, 256)),
                });
            }
        }
        match result.get("nextCursor") {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(cursor)) if !cursor.is_empty() && cursor.len() <= 4096 => {
                Ok(Some(cursor.clone()))
            }
            _ => Err(ProbeError::protocol("Invalid MCP tools cursor")),
        }
    }
}

struct ToolPages {
    index: usize,
    cursor: Option<String>,
    seen: BTreeSet<String>,
}

impl ToolPages {
    fn new() -> Self {
        Self {
            index: 0,
            cursor: None,
            seen: BTreeSet::new(),
        }
    }

    fn request(&self) -> (u64, Value) {
        (
            2 + self.index as u64,
            tools_list(self.index, self.cursor.as_deref()),
        )
    }

    fn advance(&mut self, cursor: Option<String>) -> ProbeResult<bool> {
        let Some(cursor) = cursor else {
            return Ok(false);
        };
        self.index += 1;
        if self.index >= MAX_TOOL_PAGES || !self.seen.insert(cursor.clone()) {
            return Err(ProbeError::protocol(
                "MCP tools pagination exceeded its limit or repeated a cursor",
            ));
        }
        self.cursor = Some(cursor);
        Ok(true)
    }
}

/// Share the budget across all frames and cap even an unterminated line.
async fn read_line<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    line: &mut Vec<u8>,
    remaining: &mut usize,
    read_error: fn() -> ProbeError,
) -> ProbeResult<bool> {
    line.clear();
    let limit = *remaining as u64 + 1;
    let read = reader
        .take(limit)
        .read_until(b'\n', line)
        .await
        .map_err(|_| read_error())?;
    *remaining = remaining
        .checked_sub(read)
        .ok_or_else(|| ProbeError::protocol("MCP response exceeded 2 MiB"))?;
    Ok(read != 0)
}

async fn write_stdio(stdin: &mut tokio::process::ChildStdin, message: &Value) -> ProbeResult<()> {
    let mut bytes = message.to_string().into_bytes();
    bytes.push(b'\n');
    stdin
        .write_all(&bytes)
        .await
        .map_err(|_| ProbeError::protocol("MCP process closed its input"))
}

async fn read_stdio<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    remaining: &mut usize,
    id: u64,
) -> ProbeResult<Value> {
    let mut line = Vec::new();
    while read_line(reader, &mut line, remaining, || {
        ProbeError::protocol("Could not read MCP process output")
    })
    .await?
    {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if let Some(result) = rpc_result(decode_message(&line)?, id)? {
            return Ok(result);
        }
    }
    Err(ProbeError::protocol(
        "MCP process closed its output before responding",
    ))
}

/// Also clean up wrapper processes such as `npx` and their server on drop.
struct ProbeChild(tokio::process::Child);

impl Drop for ProbeChild {
    fn drop(&mut self) {
        if let Some(pid) = self.0.id() {
            #[cfg(unix)]
            if let Ok(group) = libc::pid_t::try_from(pid) {
                // SAFETY: this child leads the process group and has not been reaped.
                unsafe {
                    libc::killpg(group, libc::SIGKILL);
                }
            }
            #[cfg(not(unix))]
            let _ = kill_tree::blocking::kill_tree(pid);
        }
    }
}

async fn stdio_probe(
    mut command: tokio::process::Command,
    report: &mut McpProbeResult,
    stderr_tail: &mut Vec<u8>,
    redact: &Redact,
) -> ProbeResult<()> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = ProbeChild(command.spawn().map_err(|_| {
        ProbeError::new(
            McpProbeStatus::SpawnFailed,
            "Could not start the MCP process",
        )
    })?);
    let mut stdin = child.0.stdin.take().expect("piped stdin");
    let mut stdout = BufReader::new(child.0.stdout.take().expect("piped stdout"));
    let mut stderr = child.0.stderr.take().expect("piped stderr");
    let exchange = async {
        let mut remaining = MAX_READ_BYTES;
        write_stdio(&mut stdin, &initialize()).await?;
        let response = read_stdio(&mut stdout, &mut remaining, 1).await?;
        report.record_server(&response, redact)?;
        write_stdio(&mut stdin, &initialized()).await?;
        let mut pages = ToolPages::new();
        loop {
            let (id, request) = pages.request();
            write_stdio(&mut stdin, &request).await?;
            let response = read_stdio(&mut stdout, &mut remaining, id).await?;
            if !pages.advance(report.record_tools(&response, redact)?)? {
                return Ok(());
            }
        }
    };
    let drain = async {
        let mut read = 0;
        let keep = STDERR_RETAIN_BYTES.saturating_add(redact.0.first().map_or(0, String::len));
        let mut chunk = [0; 4096];
        loop {
            let len = stderr
                .read(&mut chunk)
                .await
                .map_err(|_| ProbeError::protocol("Could not read MCP process diagnostics"))?;
            if len == 0 {
                return Ok(());
            }
            read += len;
            if read > MAX_READ_BYTES {
                return Err(ProbeError::protocol("MCP diagnostic output exceeded 2 MiB"));
            }
            stderr_tail.extend_from_slice(&chunk[..len]);
            if stderr_tail.len() > keep {
                stderr_tail.drain(..stderr_tail.len() - keep);
            }
        }
    };
    tokio::pin!(exchange);
    tokio::select! {
        biased;
        drained = drain => { drained?; exchange.await }
        result = &mut exchange => result,
    }
}
