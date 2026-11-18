//! ACP bridge for Huawei Cloud CodeArts (码道) CLI.
//!
//! The vendor CLI has no ACP server: `codearts acp` answers "The 'acp' command
//! is not supported." (verified on 26.10.9). codeg therefore launches THIS
//! binary as `codeg --codearts-bridge` and speaks JSON-RPC over stdio with it.
//! The bridge maps each `session/prompt` onto one `codearts run --format json`
//! invocation and replays the CLI's NDJSON event stream as ACP
//! `session/update` chunks — the "pseudo-streaming" MVP. A future backend can
//! talk to `codearts serve` (a full OpenCode HTTP server) for real tool calls,
//! permission requests and session resume without changing anything here.
//!
//! Everything written to stdout is a JSON-RPC frame; diagnostics go to stderr
//! only. That contract is why `main.rs` installs a stderr-only log subscriber
//! before calling [`run_stdio_bridge`].

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::acp::codearts_models::{codearts_command, default_effort_level, ModelCatalog};

/// Launch args for the self-invocation, consumed by `connection::build_agent`.
pub const BRIDGE_ARGS: &[&str] = &["--codearts-bridge"];

const AK_ENV: &str = "CODEARTS_CLI_AK";
const SK_ENV: &str = "CODEARTS_CLI_SK";
const MODEL_OPTION_ID: &str = "model";
const EFFORT_OPTION_ID: &str = "reasoning_effort";
const DEFAULT_MODEL: &str = "huaweicloud-maas/GLM-5.2";

/// Synchronous entry point from `main.rs`: owns a small current-thread runtime
/// for the subprocess/timeouts, while stdio stays a plain line protocol.
pub fn run_stdio_bridge() {
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            eprintln!("[CodeArts] failed to start bridge runtime: {err}");
            std::process::exit(1);
        }
    };
    runtime.block_on(async move {
        let (bridge, rx) = Bridge::new();
        if let Err(err) = bridge.run(rx).await {
            eprintln!("[CodeArts] bridge stopped: {err}");
            std::process::exit(1);
        }
    });
}

#[derive(Clone)]
struct SessionState {
    cwd: String,
    model: String,
    effort: Option<String>,
}

struct Bridge {
    catalog: Arc<Mutex<ModelCatalog>>,
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    /// sessionId → cancel sender for the turn currently in flight.
    running: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
    out: mpsc::UnboundedSender<String>,
}

impl Bridge {
    fn new() -> (Self, mpsc::UnboundedReceiver<String>) {
        let (out, rx) = mpsc::unbounded_channel();
        (
            Self {
                catalog: Arc::new(Mutex::new(ModelCatalog::new())),
                sessions: Arc::new(Mutex::new(HashMap::new())),
                running: Arc::new(Mutex::new(HashMap::new())),
                out,
            },
            rx,
        )
    }

    async fn run(self, mut rx: mpsc::UnboundedReceiver<String>) -> std::io::Result<()> {
        // A single writer keeps stdout frames ordered even while a prompt task
        // streams chunks and the main loop answers other requests.
        let writer = tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(frame) = rx.recv().await {
                if stdout.write_all(frame.as_bytes()).await.is_err() {
                    break;
                }
                if stdout.write_all(b"\n").await.is_err() {
                    break;
                }
                let _ = stdout.flush().await;
            }
        });

        // Warm the model list without blocking the handshake: a slow or absent
        // CLI still lets `session/new` answer from the bundled fallback.
        let warm_catalog = Arc::clone(&self.catalog);
        tokio::spawn(async move {
            let mut catalog = warm_catalog.lock().await;
            catalog.refresh(true).await;
        });

        let stdin = tokio::io::stdin();
        let mut lines = BufReader::new(stdin).lines();
        while let Some(line) = lines.next_line().await? {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let message: Value = match serde_json::from_str(trimmed) {
                Ok(value) => value,
                Err(_) => continue,
            };
            self.handle(message).await;
        }
        writer.abort();
        Ok(())
    }

    fn send(&self, frame: Value) {
        if let Ok(text) = serde_json::to_string(&frame) {
            let _ = self.out.send(text);
        }
    }

    fn reply(&self, id: Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn fail(&self, id: Value, code: i64, message: impl Into<String>) {
        self.send(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": code, "message": message.into() }
        }));
    }

    async fn handle(&self, message: Value) {
        let method = message
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let id = message.get("id").cloned().unwrap_or(Value::Null);
        let params = message
            .get("params")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let is_request = !id.is_null();

        match method.as_str() {
            "initialize" => {
                self.reply(
                    id,
                    json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": false,
                            "promptCapabilities": { "image": false, "embeddedContext": false }
                        },
                        "authMethods": []
                    }),
                );
            }
            "authenticate" => self.reply(id, json!({})),
            "session/new" => self.handle_new_session(id, &params).await,
            // One-shot transport: the client falls back to session/new.
            "session/load" => {
                if is_request {
                    self.fail(id, -32601, "CodeArts bridge cannot resume sessions");
                }
            }
            "session/prompt" => self.handle_prompt(id, &params).await,
            "session/cancel" => self.handle_cancel(&params).await,
            "session/close" => {
                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                    self.cancel_turn(sid).await;
                    self.sessions.lock().await.remove(sid);
                }
                if is_request {
                    self.reply(id, json!({}));
                }
            }
            "session/set_config_option" => {
                self.handle_set_option(id, &params).await;
            }
            "session/set_model" => {
                self.handle_set_model(id, &params).await;
            }
            _ => {
                if is_request {
                    self.fail(id, -32601, format!("Method not found: {method}"));
                }
            }
        }
    }

    /// Build the two generic config options codeg's composer renders: the model
    /// picker (with its credit multiplier in each label) and, only for models
    /// that advertise thinking support, the reasoning-effort picker.
    async fn config_options(&self, session: &SessionState) -> Vec<Value> {
        let catalog = self.catalog.lock().await;
        let models = catalog.models();
        let current = models
            .iter()
            .find(|m| m.id == session.model)
            .or_else(|| models.first());
        let model_options: Vec<Value> = models
            .iter()
            .map(|m| {
                json!({
                    "value": m.id,
                    "name": m.label(),
                    "description": m.description()
                })
            })
            .collect();
        let active_model = current.map(|m| m.id.as_str()).unwrap_or(DEFAULT_MODEL);
        let mut options = vec![json!({
            "id": MODEL_OPTION_ID,
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": active_model,
            "options": model_options
        })];
        if let Some(model) = current {
            // Hide the selector entirely for models the CLI does not declare
            // reasoning-capable, so nothing implies a setting it would reject.
            if model.reasoning_capable && !model.effort_levels.is_empty() {
                let levels: Vec<Value> = model
                    .effort_levels
                    .iter()
                    .map(|level| json!({ "value": level, "name": level }))
                    .collect();
                options.push(json!({
                    "id": EFFORT_OPTION_ID,
                    "name": "Reasoning effort",
                    "category": "thought_level",
                    "type": "select",
                    "currentValue": session
                        .effort
                        .clone()
                        .or_else(|| default_effort_level(&model.effort_levels))
                        .unwrap_or_default(),
                    "options": levels
                }));
            }
        }
        options
    }

    async fn handle_new_session(&self, id: Value, params: &Value) {
        let session_id = format!("codearts-{}", uuid_like());
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(".")
            .to_string();
        let session = SessionState {
            cwd,
            model: DEFAULT_MODEL.to_string(),
            effort: None,
        };
        let options = self.config_options(&session).await;
        self.sessions
            .lock()
            .await
            .insert(session_id.clone(), session);
        self.reply(
            id,
            json!({ "sessionId": session_id, "configOptions": options }),
        );
    }

    async fn handle_set_option(&self, id: Value, params: &Value) {
        let sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let config_id = params
            .get("configId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let value = params
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated = {
            let mut sessions = self.sessions.lock().await;
            let Some(session) = sessions.get_mut(&sid) else {
                self.fail(id, -32602, "Unknown session");
                return;
            };
            match config_id {
                MODEL_OPTION_ID => {
                    session.model = value.clone();
                    // A different model may not support reasoning any more.
                    session.effort = None;
                }
                EFFORT_OPTION_ID => session.effort = Some(value.clone()),
                _ => {}
            }
            session.clone()
        };
        // ACP's `SetSessionConfigOptionResponse` REQUIRES `configOptions`.
        // Returning `{}` makes codeg fail with "missing field `configOptions`"
        // and surface "could not apply that setting". codeg reads this response
        // to refresh BOTH selectors, so a model switch is also what reveals
        // that model's reasoning levels — no separate notification needed (the
        // SDK has no `config_option_update` update variant).
        let options = self.config_options(&updated).await;
        self.reply(id, json!({ "configOptions": options }));
    }

    async fn handle_set_model(&self, id: Value, params: &Value) {
        let sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let model_id = params
            .get("modelId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let updated = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get_mut(&sid) {
                Some(session) => {
                    session.model = model_id;
                    session.effort = None;
                    Some(session.clone())
                }
                None => None,
            }
        };
        // Some clients drive model changes through the legacy `session/set_model`
        // extension; acknowledge with the same full option set so the effort
        // selector follows the new model there too.
        let options = match updated {
            Some(session) => self.config_options(&session).await,
            None => Vec::new(),
        };
        self.reply(id, json!({ "configOptions": options }));
    }

    async fn handle_cancel(&self, params: &Value) {
        if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
            self.cancel_turn(sid).await;
        }
    }

    async fn cancel_turn(&self, sid: &str) {
        if let Some(tx) = self.running.lock().await.remove(sid) {
            let _ = tx.send(());
        }
    }

    async fn handle_prompt(&self, id: Value, params: &Value) {
        let sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session = self.sessions.lock().await.get(&sid).cloned();
        let Some(session) = session else {
            self.fail(id, -32602, "Unknown session");
            return;
        };
        let prompt = prompt_text(params);
        if prompt.trim().is_empty() {
            self.fail(id, -32602, "Empty prompt");
            return;
        }
        if self.running.lock().await.contains_key(&sid) {
            self.fail(id, -32000, "A turn is already running for this session");
            return;
        }

        let (cancel_tx, cancel_rx) = oneshot::channel();
        self.running.lock().await.insert(sid.clone(), cancel_tx);

        let catalog = Arc::clone(&self.catalog);
        let running = Arc::clone(&self.running);
        let out = self.out.clone();
        let task_sid = sid.clone();
        tokio::spawn(async move {
            // Refresh opportunistically; a timeout keeps the cached list.
            {
                let mut c = catalog.lock().await;
                c.refresh(false).await;
            }
            let (model, effort) = {
                let c = catalog.lock().await;
                let model = c
                    .models()
                    .iter()
                    .find(|m| m.id == session.model)
                    .cloned();
                match model {
                    Some(m) => {
                        // The default level follows the same rule the picker
                        // shows. Only models the CLI declares reasoning-capable
                        // actually receive `--variant`; CodeArts rejects it for
                        // models without `variants` ("only models that support
                        // thinking intensity can use this command").
                        let effort = session
                            .effort
                            .clone()
                            .or_else(|| default_effort_level(&m.effort_levels))
                            .filter(|e| m.effort_levels.contains(e))
                            .filter(|_| m.reasoning_capable);
                        (m, effort)
                    }
                    None => (crate::acp::codearts_models::fallback_models()[0].clone(), None),
                }
            };

            let outcome = run_turn(
                &task_sid,
                &session.cwd,
                &model.id,
                effort.as_deref(),
                &prompt,
                &out,
                cancel_rx,
            )
            .await;
            running.lock().await.remove(&task_sid);
            let frame = match outcome {
                TurnOutcome::End => json!({ "stopReason": "end_turn" }),
                TurnOutcome::Cancelled => json!({ "stopReason": "cancelled" }),
                TurnOutcome::Failed(message) => {
                    send_chunk(&out, &task_sid, &message);
                    json!({ "stopReason": "end_turn" })
                }
            };
            let _ = out.send(
                serde_json::to_string(&json!({ "jsonrpc": "2.0", "id": id, "result": frame }))
                    .unwrap_or_default(),
            );
        });
    }
}

/// A short opaque session id; no external crate needed for this.
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn prompt_text(params: &Value) -> String {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| {
                    if block.get("type").and_then(Value::as_str) == Some("text") {
                        block.get("text").and_then(Value::as_str)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn send_chunk(out: &mpsc::UnboundedSender<String>, session_id: &str, text: &str) {
    if text.is_empty() {
        return;
    }
    let frame = json!({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {
            "sessionId": session_id,
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text }
            }
        }
    });
    if let Ok(s) = serde_json::to_string(&frame) {
        let _ = out.send(s);
    }
}

enum TurnOutcome {
    End,
    Cancelled,
    Failed(String),
}

/// Run one `codearts run --format json` and replay its NDJSON events. The event
/// schema is only partially documented, so text extraction is defensive: any
/// `text`-bearing object counts, and a turn that produced no chunk still ends
/// with whatever text was accumulated.
async fn run_turn(
    session_id: &str,
    cwd: &str,
    model: &str,
    effort: Option<&str>,
    prompt: &str,
    out: &mpsc::UnboundedSender<String>,
    cancel_rx: oneshot::Receiver<()>,
) -> TurnOutcome {
    let Some(credentials) = resolve_credentials() else {
        return TurnOutcome::Failed(missing_credentials_message());
    };

    let mut args = vec![
        "run".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        model.to_string(),
    ];
    if let Some(level) = effort {
        args.push("--variant".to_string());
        args.push(level.to_string());
    }
    args.push("--".to_string());
    args.push(prompt.to_string());
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();

    let mut child = match codearts_command(&arg_refs)
        .current_dir(cwd)
        .env(AK_ENV, &credentials.0)
        .env(SK_ENV, &credentials.1)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            return TurnOutcome::Failed(format!(
                "Could not start the CodeArts CLI: {err}. Install it, or check Agent Settings."
            ))
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => return TurnOutcome::Failed("CodeArts CLI produced no output".into()),
    };

    let mut cancel = cancel_rx;
    let mut lines = BufReader::new(stdout).lines();
    let mut sent = String::new();
    let mut error: Option<String> = None;
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(TURN_TIMEOUT_SECS));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            _ = &mut deadline => {
                let _ = child.kill().await;
                return TurnOutcome::Failed(
                    "The CodeArts turn ran past its time limit and was stopped.".into()
                );
            }
            _ = &mut cancel => {
                let _ = child.kill().await;
                return TurnOutcome::Cancelled;
            }
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let Ok(event) = serde_json::from_str::<Value>(line.trim()) else { continue };
                        if let Some(message) = event_error(&event) {
                            error = Some(message);
                        }
                        if let Some(text) = event_text(&event) {
                            if text != sent && text.len() > sent.len() {
                                if let Some(delta) = text.strip_prefix(&sent) {
                                    send_chunk(out, session_id, delta);
                                } else {
                                    send_chunk(out, session_id, &text);
                                }
                                sent = text;
                            }
                        }
                        if event.get("type").and_then(Value::as_str) == Some("session.idle") {
                            break;
                        }
                    }
                    Ok(None) => break,
                    Err(err) => {
                        tracing::warn!("[CodeArts] event stream read failed: {err}");
                        break;
                    }
                }
            }
        }
    }
    let _ = child.wait().await;

    if let Some(message) = error {
        if sent.is_empty() {
            return TurnOutcome::Failed(friendly_error(&message));
        }
    }
    TurnOutcome::End
}

/// Pull a human-readable message out of the CLI's `{"type":"error"}` envelope.
fn event_error(event: &Value) -> Option<String> {
    if event.get("type").and_then(Value::as_str) != Some("error") {
        return None;
    }
    event
        .get("error")
        .and_then(|e| e.get("data"))
        .and_then(|d| d.get("message"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| {
            event
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

/// Defensive text extraction across the OpenCode event shapes we know about:
/// `message.part.updated` carries `properties.part.text`, other events may put
/// a `text` block at the top level.
fn event_text(event: &Value) -> Option<String> {
    for pointer in [
        "/properties/part/text",
        "/part/text",
        "/properties/text",
        "/text",
    ] {
        if let Some(text) = event.pointer(pointer).and_then(Value::as_str) {
            return Some(text.to_string());
        }
    }
    None
}

fn friendly_error(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("access key") || lower.contains("ak/sk") || lower.contains("unauthorized") {
        return format!(
            "{raw}\n\nCodeArts rejected the AK/SK. Set CODEARTS_CLI_AK and CODEARTS_CLI_SK in the CodeArts agent settings."
        );
    }
    format!("CodeArts could not answer this turn: {raw}")
}

/// Q1: page settings win, then the OS-level environment for the current
/// platform, then a clear prompt. The page values arrive as ordinary process
/// env vars because codeg merges the agent's env into the child (see
/// `connection::merge_agent_env`), so the first lookup already covers them.
fn resolve_credentials() -> Option<(String, String)> {
    let ak = std::env::var(AK_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| os_env_var(AK_ENV))?;
    let sk = std::env::var(SK_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| os_env_var(SK_ENV))?;
    Some((ak, sk))
}

/// Read a variable from the OS-level store a GUI app may not inherit.
/// Windows keeps user/machine variables in the registry; Unix GUI sessions
/// commonly miss the shell rc files that export them.
#[cfg(windows)]
fn os_env_var(name: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    for hive in [
        "HKCU\\Environment",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
    ] {
        let output = std::process::Command::new("reg")
            .args(["query", hive, "/v", name])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        if !output.status.success() {
            continue;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            if line.contains(name) {
                if let Some(value) = line.split_whitespace().last() {
                    if !value.is_empty() && value != name {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn os_env_var(name: &str) -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    for file in [
        ".config/environment",
        ".pam_environment",
        ".profile",
        ".bashrc",
        ".zshrc",
    ] {
        let path = std::path::Path::new(&home).join(file);
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        for line in text.lines() {
            let line = line.trim();
            let stripped = line
                .strip_prefix("export ")
                .unwrap_or(line)
                .trim_start();
            if let Some((key, value)) = stripped.split_once('=') {
                if key.trim() == name {
                    let value = value.trim().trim_matches(['"', '\'']);
                    if !value.is_empty() {
                        return Some(value.to_string());
                    }
                }
            }
        }
    }
    None
}

fn missing_credentials_message() -> String {
    "CodeArts needs an AK/SK pair before it can run. Set CODEARTS_CLI_AK and CODEARTS_CLI_SK in this agent's settings (or in the operating system's environment variables), then send the message again.".to_string()
}

/// The CLI is allowed a long turn but must not hang forever; the heartbeats of
/// the reference bridge are unnecessary because NDJSON events arrive as they
/// happen, but a hard ceiling keeps a black-holed process from pinning a turn.
const TURN_TIMEOUT_SECS: u64 = 900;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_text_joins_text_blocks() {
        let params = json!({
            "prompt": [
                { "type": "text", "text": "first" },
                { "type": "image", "data": "ignored" },
                { "type": "text", "text": "second" }
            ]
        });
        assert_eq!(prompt_text(&params), "first\nsecond");
    }

    #[test]
    fn error_envelope_is_extracted() {
        let event = json!({
            "type": "error",
            "error": { "name": "APIError", "data": { "message": "access key inactive" } }
        });
        assert_eq!(event_error(&event).as_deref(), Some("access key inactive"));
        assert!(friendly_error("access key inactive").contains("AK/SK"));
    }

    #[test]
    fn text_is_extracted_from_part_events() {
        let event = json!({
            "type": "message.part.updated",
            "properties": { "part": { "type": "text", "text": "hello" } }
        });
        assert_eq!(event_text(&event).as_deref(), Some("hello"));
        assert!(event_error(&event).is_none());
    }

    #[test]
    fn unknown_events_are_ignored() {
        let event = json!({ "type": "session.updated", "properties": {} });
        assert!(event_text(&event).is_none());
        assert!(event_error(&event).is_none());
    }

    #[test]
    fn missing_credentials_are_explained() {
        assert!(missing_credentials_message().contains("CODEARTS_CLI_AK"));
    }
}
