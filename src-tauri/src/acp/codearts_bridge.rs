//! ACP bridge for Huawei Cloud CodeArts (码道) CLI.
//!
//! The vendor CLI has no ACP server: `codearts acp` answers "The 'acp' command
//! is not supported." (verified on 26.10.9). Its local TUI server,
//! `codearts serve`, is fully usable, so codeg launches THIS binary as
//! `codeg --codearts-bridge` and the bridge speaks ACP over stdio on one side
//! and the serve REST API plus its `/global/event` event stream on the other.
//!
//! Prompts go out as `prompt_async` — the HTTP request returns immediately and
//! the turn's progress (text, reasoning, tool calls, plan, usage) and completion
//! arrive on the event stream. Nothing holds a request open for the whole turn,
//! so there is no 15-minute ceiling any more. Completion is the session going
//! idle; the turn's final message is then read back from `/session/{id}/message`.
//!
//! Everything written to stdout is a JSON-RPC frame; diagnostics go to stderr
//! only. That contract is why `main.rs` installs a stderr-only log subscriber
//! before calling [`run_stdio_bridge`].

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use reqwest::Method;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::acp::codearts_agents::AgentCatalog;
use crate::acp::codearts_models::{default_effort_level, fallback_models, ModelCatalog};
use crate::acp::codearts_serve::CodeArtsServe;

/// Launch args for the self-invocation, consumed by `connection::build_agent`.
pub const BRIDGE_ARGS: &[&str] = &["--codearts-bridge"];

const AK_ENV: &str = "CODEARTS_CLI_AK";
const SK_ENV: &str = "CODEARTS_CLI_SK";
const MODEL_OPTION_ID: &str = "model";
const MODE_OPTION_ID: &str = "mode";
const EFFORT_OPTION_ID: &str = "reasoning_effort";
const DEFAULT_MODEL: &str = "huaweicloud-maas/GLM-5.2";

/// Synchronous entry point from `main.rs`: owns a small current-thread runtime
/// for the HTTP client and subprocess, while stdio stays a line protocol.
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
        if let Err(err) = Bridge::new().run().await {
            eprintln!("[CodeArts] bridge stopped: {err}");
            std::process::exit(1);
        }
    });
}

/// A shareable idle signal: `None` after it has fired. Wrapping the sender in
/// an Arc<Mutex> keeps `SessionState: Clone` while allowing the event task to
/// fire it through a cloned state.
type IdleSignal = Arc<Mutex<Option<oneshot::Sender<()>>>>;

#[derive(Clone)]
struct SessionState {
    cwd: String,
    model: String,
    /// Selected CodeArts primary agent (sent as the `agent` field on prompts).
    mode: String,
    effort: Option<String>,
    /// The CodeArts serve session id. It IS the ACP session id codeg sees.
    codearts_id: String,
    busy: bool,
    cancelled: bool,
    error: Option<String>,
    idle: Option<IdleSignal>,
}

/// How a session is being opened, mirroring the ACP session methods.
#[derive(Clone, Copy)]
enum OpenHow {
    New,
    Load,
    Fork,
}

#[derive(Clone)]
struct PartMeta {
    kind: String,
    role: Option<String>,
    hidden: bool,
}

/// State shared by the ACP stdin loop and the event-stream task.
#[derive(Clone)]
struct Shared {
    sessions: Arc<Mutex<HashMap<String, SessionState>>>,
    parts: Arc<Mutex<HashMap<String, PartMeta>>>,
    roles: Arc<Mutex<HashMap<String, String>>>,
    /// Subagent session id → the root session codeg opened.
    roots: Arc<Mutex<HashMap<String, String>>>,
    /// Outbound `session/request_permission` id → answer from codeg.
    pending_permissions: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    /// Tool call ids already announced to codeg (avoids duplicate tool_call frames).
    announced: Arc<Mutex<HashSet<String>>>,
    /// One serve per bridge process, started lazily on the first `session/new`.
    serve: Arc<Mutex<Option<Arc<Mutex<CodeArtsServe>>>>>,
    out: mpsc::UnboundedSender<String>,
}

struct Bridge {
    shared: Shared,
    catalog: Arc<Mutex<ModelCatalog>>,
    agents: Arc<Mutex<AgentCatalog>>,
    /// Frames read from the serve `/global/event` SSE stream.
    events: mpsc::UnboundedReceiver<Value>,
    event_tx: mpsc::UnboundedSender<Value>,
}

impl Bridge {
    fn new() -> Self {
        let (out, _rx) = mpsc::unbounded_channel();
        let (event_tx, events) = mpsc::unbounded_channel();
        Self {
            shared: Shared {
                sessions: Arc::new(Mutex::new(HashMap::new())),
                parts: Arc::new(Mutex::new(HashMap::new())),
                roles: Arc::new(Mutex::new(HashMap::new())),
                roots: Arc::new(Mutex::new(HashMap::new())),
                pending_permissions: Arc::new(Mutex::new(HashMap::new())),
                announced: Arc::new(Mutex::new(HashSet::new())),
                serve: Arc::new(Mutex::new(None)),
                out,
            },
            catalog: Arc::new(Mutex::new(ModelCatalog::new())),
            agents: Arc::new(Mutex::new(AgentCatalog::new())),
            events,
            event_tx,
        }
    }

    async fn run(mut self) -> std::io::Result<()> {
        let (out, mut out_rx) = mpsc::unbounded_channel();
        self.shared.out = out;

        // One writer keeps stdout frames ordered while a prompt streams chunks.
        let writer = tokio::spawn(async move {
            let mut stdout = tokio::io::stdout();
            while let Some(frame) = out_rx.recv().await {
                if stdout.write_all(frame.as_bytes()).await.is_err()
                    || stdout.write_all(b"\n").await.is_err()
                {
                    break;
                }
                let _ = stdout.flush().await;
            }
        });

        let shared = Arc::new(self.shared.clone());
        // Take the receiver without partially moving `self` (it is borrowed later).
        let mut events = std::mem::replace(&mut self.events, mpsc::unbounded_channel().1);
        let event_task = tokio::spawn(async move {
            while let Some(event) = events.recv().await {
                shared.clone().handle_event(event).await;
            }
        });

        // Warm the model and agent catalogues without blocking the handshake.
        let warm = Arc::clone(&self.catalog);
        tokio::spawn(async move {
            warm.lock().await.refresh(true).await;
        });
        let warm_agents = Arc::clone(&self.agents);
        tokio::spawn(async move {
            warm_agents.lock().await.refresh(true).await;
        });

        let stdin = tokio::io::stdin();
        let mut lines = BufReader::new(stdin).lines();
        while let Some(line) = lines.next_line().await? {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(message) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            self.handle(message).await;
        }

        let mut serve = self.shared.serve.lock().await;
        if let Some(serve) = serve.take() {
            serve.lock().await.shutdown().await;
        }
        writer.abort();
        event_task.abort();
        Ok(())
    }

    fn send(&self, frame: Value) {
        if let Ok(text) = serde_json::to_string(&frame) {
            let _ = self.shared.out.send(text);
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

        // A reply with no method is an answer to a request WE sent (currently
        // only `session/request_permission`). Notifications have a method and
        // no id and are not ours to answer, so ignore them here.
        if method.is_empty() {
            let key = id
                .as_str()
                .map(str::to_string)
                .or_else(|| id.as_u64().map(|n| n.to_string()));
            if let Some(key) = key {
                if let Some(waiter) = self.shared.pending_permissions.lock().await.remove(&key) {
                    let _ = waiter.send(params.get("outcome").cloned().unwrap_or(Value::Null));
                }
            }
            return;
        }
        if !is_request {
            return;
        }

        match method.as_str() {
            "initialize" => {
                self.reply(
                    id,
                    json!({
                        "protocolVersion": 1,
                        "agentCapabilities": {
                            "loadSession": true,
                            "promptCapabilities": { "image": true, "embeddedContext": false }
                        },
                        "authMethods": []
                    }),
                );
            }
            "authenticate" => self.reply(id, json!({})),
            "session/new" => self.handle_open_session(id, &params, OpenHow::New).await,
            "session/load" => self.handle_open_session(id, &params, OpenHow::Load).await,
            "session/fork" => self.handle_open_session(id, &params, OpenHow::Fork).await,
            "session/prompt" => self.handle_prompt(id, &params).await,
            "session/cancel" => {
                self.shared.handle_cancel(&params).await;
                self.reply(id, json!({}));
            }
            "session/close" => {
                if let Some(sid) = params.get("sessionId").and_then(Value::as_str) {
                    self.shared.sessions.lock().await.remove(sid);
                }
                self.reply(id, json!({}));
            }
            "session/set_config_option" => self.handle_set_option(id, &params).await,
            "session/set_model" => self.handle_set_model(id, &params).await,
            _ => self.fail(id, -32601, format!("Method not found: {method}")),
        }
    }

    /// Ensure the single serve process exists, starting it in `cwd` with the
    /// AK/SK resolved from the page setting first, then the OS environment.
    async fn ensure_serve(&self, cwd: &str) -> Result<Arc<Mutex<CodeArtsServe>>, String> {
        let existing = self.shared.serve.lock().await.clone();
        if let Some(serve) = existing {
            return Ok(serve);
        }
        let (ak, sk) = resolve_credentials().ok_or_else(missing_credentials_message)?;
        let serve = CodeArtsServe::start(cwd, &ak, &sk).await?;
        let handle = Arc::new(Mutex::new(serve));
        handle.lock().await.events(self.event_tx.clone());
        *self.shared.serve.lock().await = Some(Arc::clone(&handle));
        Ok(handle)
    }

    /// Generic config options: model (with the credit multiplier in the label),
    /// mode (CodeArts primary agent), and — only for models that declare
    /// variants — the reasoning effort.
    async fn config_options(&self, session: &SessionState) -> Vec<Value> {
        // Scope the model catalog lock so the agent lock below is never nested
        // across an await.
        let (model_options, active_model, effort_levels, reasoning_capable) = {
            let catalog = self.catalog.lock().await;
            let models = catalog.models();
            let current = models
                .iter()
                .find(|m| m.id == session.model)
                .or_else(|| models.first());
            let options: Vec<Value> = models
                .iter()
                .map(|m| {
                    json!({
                        "value": m.id,
                        "name": m.label(),
                        "description": m.description()
                    })
                })
                .collect();
            let active = current.map(|m| m.id.as_str()).unwrap_or(DEFAULT_MODEL).to_string();
            let levels = current
                .filter(|m| m.reasoning_capable && !m.effort_levels.is_empty())
                .map(|m| m.effort_levels.clone());
            let capable = levels.is_some();
            (options, active, levels, capable)
        };
        let mut options = vec![json!({
            "id": MODEL_OPTION_ID,
            "name": "Model",
            "category": "model",
            "type": "select",
            "currentValue": active_model,
            "options": model_options
        })];

        // Agent / mode comes from `codearts agent list` primary headers.
        let agents = self.agents.lock().await;
        if !agents.agents().is_empty() {
            let mode_options: Vec<Value> = agents
                .agents()
                .iter()
                .map(|name| json!({ "value": name, "name": name }))
                .collect();
            let current_mode = if agents.agents().iter().any(|a| a == &session.mode) {
                session.mode.clone()
            } else {
                agents.agents()[0].clone()
            };
            options.push(json!({
                "id": MODE_OPTION_ID,
                "name": "Session Mode",
                "category": "mode",
                "type": "select",
                "currentValue": current_mode,
                "options": mode_options
            }));
        }
        drop(agents);

        if reasoning_capable {
            if let Some(levels) = effort_levels {
                let level_options: Vec<Value> = levels
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
                        .or_else(|| default_effort_level(&levels))
                        .unwrap_or_default(),
                    "options": level_options
                }));
            }
        }
        options
    }

    /// Open a CodeArts session as `new`, `load` or `fork`. Load reads the
    /// session back and replays its history as ACP chunks; fork uses the
    /// service's fork endpoint (latest turn only) instead of replaying.
    async fn handle_open_session(&self, id: Value, params: &Value, how: OpenHow) {
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .unwrap_or(".")
            .to_string();
        let serve = match self.ensure_serve(&cwd).await {
            Ok(serve) => serve,
            Err(message) => {
                let fallback = SessionState {
                    cwd: cwd.clone(),
                    model: DEFAULT_MODEL.to_string(),
                    mode: String::new(),
                    effort: None,
                    codearts_id: format!("codearts-{}", uuid_like()),
                    busy: false,
                    cancelled: false,
                    error: Some(message),
                    idle: None,
                };
                let options = self.config_options(&fallback).await;
                let sid = fallback.codearts_id.clone();
                self.shared.sessions.lock().await.insert(sid.clone(), fallback);
                self.reply(id, json!({ "sessionId": sid, "configOptions": options }));
                return;
            }
        };
        let (codearts_id, history) = match how {
            OpenHow::New => {
                let created = match serve
                    .lock()
                    .await
                    .api(Method::POST, "/session", Some(&json!({})))
                    .await
                {
                    Ok(value) => value,
                    Err(message) => { self.fail(id, -32603, message); return; }
                };
                let Some(sid) = created.get("id").and_then(Value::as_str) else {
                    self.fail(id, -32603, "CodeArts serve did not return a session id");
                    return;
                };
                (sid.to_string(), None)
            }
            OpenHow::Load => {
                let Some(requested) = params.get("sessionId").and_then(Value::as_str) else {
                    self.fail(id, -32602, "sessionId is required to load");
                    return;
                };
                let loaded = match serve
                    .lock()
                    .await
                    .api(Method::GET, &format!("/session/{requested}"), None)
                    .await
                {
                    Ok(value) => value,
                    Err(message) => { self.fail(id, -32603, message); return; }
                };
                let Some(sid) = loaded.get("id").and_then(Value::as_str) else {
                    self.fail(id, -32603, "CodeArts serve did not return a session id");
                    return;
                };
                let history = serve
                    .lock()
                    .await
                    .api(Method::GET, &format!("/session/{sid}/message"), None)
                    .await
                    .ok()
                    .and_then(|v| v.as_array().cloned());
                (sid.to_string(), history)
            }
            OpenHow::Fork => {
                let Some(requested) = params.get("sessionId").and_then(Value::as_str) else {
                    self.fail(id, -32602, "sessionId is required to fork");
                    return;
                };
                let forked = match serve
                    .lock()
                    .await
                    .api(Method::POST, &format!("/session/{requested}/fork"), Some(&json!({})))
                    .await
                {
                    Ok(value) => value,
                    Err(message) => { self.fail(id, -32603, message); return; }
                };
                let Some(sid) = forked.get("id").and_then(Value::as_str) else {
                    self.fail(id, -32603, "CodeArts serve did not return a forked session id");
                    return;
                };
                (sid.to_string(), None)
            }
        };
        let session = SessionState {
            cwd,
            model: DEFAULT_MODEL.to_string(),
            mode: String::new(),
            effort: None,
            codearts_id: codearts_id.clone(),
            busy: false,
            cancelled: false,
            error: None,
            idle: None,
        };
        let options = self.config_options(&session).await;
        self.shared.sessions.lock().await.insert(codearts_id.clone(), session);
        // ACP load/fork send no new sessionId; replay history into the
        // conversation so the user sees it without re-sending a prompt.
        if let Some(messages) = history {
            self.shared.replay(&codearts_id, &messages);
        }
        let reply = match how {
            OpenHow::New => json!({ "sessionId": codearts_id, "configOptions": options }),
            _ => json!({ "configOptions": options }),
        };
        self.reply(id, reply);
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
            let mut sessions = self.shared.sessions.lock().await;
            let Some(session) = sessions.get_mut(&sid) else {
                self.fail(id, -32602, "Unknown session");
                return;
            };
            match config_id {
                MODEL_OPTION_ID => {
                    session.model = value;
                    session.effort = None;
                }
                MODE_OPTION_ID => session.mode = value,
                EFFORT_OPTION_ID => session.effort = Some(value),
                _ => {}
            }
            session.clone()
        };
        // ACP's SetSessionConfigOptionResponse requires `configOptions`.
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
            let mut sessions = self.shared.sessions.lock().await;
            match sessions.get_mut(&sid) {
                Some(session) => {
                    session.model = model_id;
                    session.effort = None;
                    Some(session.clone())
                }
                None => None,
            }
        };
        let options = match updated {
            Some(session) => self.config_options(&session).await,
            None => Vec::new(),
        };
        self.reply(id, json!({ "configOptions": options }));
    }

    async fn handle_prompt(&self, id: Value, params: &Value) {
        let sid = params
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let session = self.shared.sessions.lock().await.get(&sid).cloned();
        let Some(session) = session else {
            self.fail(id, -32602, "Unknown session");
            return;
        };
        if session.busy {
            self.fail(id, -32000, "A turn is already running for this session");
            return;
        }
        let parts = prompt_parts(params);
        if parts.is_empty() {
            self.fail(id, -32602, "Empty prompt");
            return;
        }
        if let Some(message) = session.error.clone() {
            self.shared.send_chunk(&sid, &message);
            self.reply(id, json!({ "stopReason": "end_turn" }));
            return;
        }

        let serve = match self.ensure_serve(&session.cwd).await {
            Ok(serve) => serve,
            Err(message) => {
                self.shared.send_chunk(&sid, &message);
                self.reply(id, json!({ "stopReason": "end_turn" }));
                return;
            }
        };

        // Resolve the model and effort the same way the picker displays them.
        let (model, effort) = {
            let catalog = self.catalog.lock().await;
            let found = catalog
                .models()
                .iter()
                .find(|m| m.id == session.model)
                .cloned()
                .or_else(|| fallback_models().first().cloned());
            match found {
                Some(m) => {
                    let effort = session
                        .effort
                        .clone()
                        .or_else(|| default_effort_level(&m.effort_levels))
                        .filter(|e| m.effort_levels.contains(e))
                        .filter(|_| m.reasoning_capable);
                    (m, effort)
                }
                None => (fallback_models()[0].clone(), None),
            }
        };

        // Register the idle waiter BEFORE posting, so a fast turn cannot be missed.
        let (idle_tx, idle_rx) = oneshot::channel();
        {
            let mut sessions = self.shared.sessions.lock().await;
            if let Some(state) = sessions.get_mut(&sid) {
                state.busy = true;
                state.cancelled = false;
                state.error = None;
                state.idle = Some(Arc::new(Mutex::new(Some(idle_tx))));
            }
        }

        let (provider_id, model_id) = match model.id.split_once('/') {
            Some((provider, model)) => (provider.to_string(), model.to_string()),
            None => ("huaweicloud-maas".to_string(), model.id.clone()),
        };
        let mut body = json!({
            "parts": parts,
            "model": { "providerID": provider_id, "modelID": model_id }
        });
        if let Some(variant) = effort.as_deref() {
            body["variant"] = json!(variant);
        }
        if !session.mode.trim().is_empty() {
            body["agent"] = json!(session.mode.trim());
        }
        if let Err(message) = serve
            .lock()
            .await
            .api(
                Method::POST,
                &format!("/session/{}/prompt_async", session.codearts_id),
                Some(&body),
            )
            .await
        {
            let mut sessions = self.shared.sessions.lock().await;
            if let Some(state) = sessions.get_mut(&sid) {
                state.busy = false;
                state.idle = None;
            }
            self.shared.send_chunk(&sid, &friendly_error(&message));
            self.reply(id, json!({ "stopReason": "end_turn" }));
            return;
        }

        let shared = self.shared.clone();
        let reply_id = id;
        let reply_sid = sid.clone();
        tokio::spawn(async move {
            // No 15-minute ceiling: the serve event stream says when the turn is
            // idle, however long the model takes.
            let _ = idle_rx.await;
            let state = shared.sessions.lock().await.get(&reply_sid).cloned();
            let (cancelled, error, codearts_id) = match state {
                Some(s) => (s.cancelled, s.error.clone(), s.codearts_id.clone()),
                None => (false, None, reply_sid.clone()),
            };
            let messages = serve
                .lock()
                .await
                .api(Method::GET, &format!("/session/{codearts_id}/message"), None)
                .await
                .ok()
                .and_then(|value| value.as_array().cloned())
                .unwrap_or_default();
            let last_assistant = messages.iter().rev().find(|message| {
                message
                    .get("info")
                    .and_then(|i| i.get("role"))
                    .and_then(Value::as_str)
                    == Some("assistant")
            });
            if let Some(info) = last_assistant.and_then(|m| m.get("info")) {
                if let Some(usage) = usage_update(&codearts_id, info) {
                    shared.send_update(&reply_sid, usage);
                }
            }
            let api_error = last_assistant
                .and_then(|m| m.get("info"))
                .and_then(|i| i.get("error"))
                .and_then(|e| e.get("data"))
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .map(str::to_string);
            let failure = error.or(api_error);

            {
                let mut sessions = shared.sessions.lock().await;
                if let Some(state) = sessions.get_mut(&reply_sid) {
                    state.busy = false;
                    state.idle = None;
                }
            }
            let result = if cancelled {
                json!({ "stopReason": "cancelled" })
            } else if let Some(message) = failure {
                shared.send_chunk(&reply_sid, &friendly_error(&message));
                json!({ "stopReason": "end_turn" })
            } else {
                json!({ "stopReason": "end_turn" })
            };
            shared.reply(reply_id, result);
        });
    }
}

impl Shared {
    fn send(&self, frame: Value) {
        if let Ok(text) = serde_json::to_string(&frame) {
            let _ = self.out.send(text);
        }
    }

    fn reply(&self, id: Value, result: Value) {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    }

    fn update(&self, session_id: &str, update: Value) {
        self.send(json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": { "sessionId": session_id, "update": update }
        }));
    }

    fn send_update(&self, session_id: &str, update: Value) {
        self.update(session_id, update);
    }

    fn send_chunk(&self, session_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        self.update(
            session_id,
            json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": text }
            }),
        );
    }

    /// Replay a loaded session's stored messages as ACP updates. Text and
    /// reasoning become chunks, tools become completed tool calls; synthetic
    /// / ignored parts are skipped. This is display-only — the user does not
    /// re-send these as a prompt.
    fn replay(&self, session_id: &str, messages: &[Value]) {
        for message in messages {
            let info = match message.get("info") {
                Some(info) => info,
                None => continue,
            };
            let role = info.get("role").and_then(Value::as_str).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let message_id = info.get("id").and_then(Value::as_str).unwrap_or("");
            let Some(parts) = message.get("parts").and_then(Value::as_array) else {
                continue;
            };
            for part in parts {
                let hidden = part.get("synthetic").and_then(Value::as_bool).unwrap_or(false)
                    || part.get("ignored").and_then(Value::as_bool).unwrap_or(false);
                if hidden {
                    continue;
                }
                match part.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if text.is_empty() {
                                continue;
                            }
                            let update = if role == "user" {
                                "user_message_chunk"
                            } else {
                                "agent_message_chunk"
                            };
                            self.update(
                                session_id,
                                json!({
                                    "sessionUpdate": update,
                                    "messageId": message_id,
                                    "content": { "type": "text", "text": text }
                                }),
                            );
                        }
                    }
                    "reasoning" if role == "assistant" => {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                self.update(
                                    session_id,
                                    json!({
                                        "sessionUpdate": "agent_thought_chunk",
                                        "messageId": message_id,
                                        "content": { "type": "text", "text": text }
                                    }),
                                );
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    async fn handle_cancel(&self, params: &Value) {
        let Some(sid) = params.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let session = self.sessions.lock().await.get(sid).cloned();
        if let Some(session) = session {
            if let Some(serve) = self.serve.lock().await.clone() {
                let _ = serve
                    .lock()
                    .await
                    .api(
                        Method::POST,
                        &format!("/session/{}/abort", session.codearts_id),
                        None,
                    )
                    .await;
            }
            let mut sessions = self.sessions.lock().await;
            if let Some(state) = sessions.get_mut(sid) {
                state.cancelled = true;
                if let Some(signal) = state.idle.take() {
                    if let Some(waiter) = signal.lock().await.take() {
                        let _ = waiter.send(());
                    }
                }
            }
        }
    }

    /// Map one `/global/event` frame to ACP updates.
    async fn handle_event(self: Arc<Self>, frame: Value) {
        let envelope = match frame.get("payload") {
            Some(payload) => payload,
            None => return,
        };
        let event_type = match envelope.get("type").and_then(Value::as_str) {
            Some(kind) => kind,
            None => return,
        };
        let properties = envelope.get("properties").cloned().unwrap_or(json!({}));
        let directory = frame
            .get("directory")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();

        match event_type {
            "session.created" | "session.updated" => {
                let Some(info) = properties.get("info") else { return };
                let Some(id) = info.get("id").and_then(Value::as_str) else { return };
                if let Some(parent) = info.get("parentID").and_then(Value::as_str) {
                    let root = if self.sessions.lock().await.contains_key(parent) {
                        parent.to_string()
                    } else {
                        self.roots
                            .lock()
                            .await
                            .get(parent)
                            .cloned()
                            .unwrap_or_default()
                    };
                    self.roots.lock().await.insert(id.to_string(), root);
                }
            }
            "message.updated" => {
                let Some(info) = properties.get("info") else { return };
                if let (Some(id), Some(role)) = (
                    info.get("id").and_then(Value::as_str),
                    info.get("role").and_then(Value::as_str),
                ) {
                    self.roles
                        .lock()
                        .await
                        .insert(id.to_string(), role.to_string());
                }
            }
            "message.part.updated" => {
                let Some(part) = properties.get("part") else { return };
                let Some(id) = part.get("id").and_then(Value::as_str) else { return };
                let kind = part
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let message_id = part.get("messageID").and_then(Value::as_str);
                let role = match message_id {
                    Some(mid) => self.roles.lock().await.get(mid).cloned(),
                    None => None,
                };
                let hidden = part.get("synthetic").and_then(Value::as_bool).unwrap_or(false)
                    || part.get("ignored").and_then(Value::as_bool).unwrap_or(false);
                self.parts.lock().await.insert(
                    id.to_string(),
                    PartMeta {
                        kind: kind.clone(),
                        role: role.clone(),
                        hidden,
                    },
                );
                if kind == "tool" {
                    if let Some(session_id) = part.get("sessionID").and_then(Value::as_str) {
                        if let Some(owner) = self.owner(session_id, &directory).await {
                            self.tool_update(&owner, part, true).await;
                        }
                    }
                }
            }
            "message.part.delta" => {
                if properties.get("field").and_then(Value::as_str) != Some("text") {
                    return;
                }
                let Some(delta) = properties.get("delta").and_then(Value::as_str) else {
                    return;
                };
                let Some(session_id) = properties.get("sessionID").and_then(Value::as_str) else {
                    return;
                };
                let Some(owner) = self.owner(session_id, &directory).await else {
                    return;
                };
                let part_id = properties.get("partID").and_then(Value::as_str).unwrap_or("");
                let meta = self.parts.lock().await.get(part_id).cloned();
                let message_id = properties.get("messageID").and_then(Value::as_str);
                let message_role = match message_id {
                    Some(mid) => self.roles.lock().await.get(mid).cloned(),
                    None => None,
                };
                let role = meta
                    .as_ref()
                    .and_then(|m| m.role.clone())
                    .or(message_role)
                    .unwrap_or_else(|| "assistant".to_string());
                if role != "assistant" || meta.as_ref().is_some_and(|m| m.hidden) {
                    return;
                }
                let session_update = if meta.as_ref().is_some_and(|m| m.kind == "reasoning") {
                    "agent_thought_chunk"
                } else {
                    "agent_message_chunk"
                };
                self.update(
                    &owner,
                    json!({
                        "sessionUpdate": session_update,
                        "content": { "type": "text", "text": delta }
                    }),
                );
            }
            "session.idle" | "session.status" => {
                let idle = event_type == "session.idle"
                    || properties
                        .get("status")
                        .and_then(|s| s.get("type"))
                        .and_then(Value::as_str)
                        == Some("idle");
                if !idle {
                    return;
                }
                if let Some(session_id) = properties.get("sessionID").and_then(Value::as_str) {
                    if let Some(owner) = self.owner(session_id, &directory).await {
                        let signal = {
                            let mut sessions = self.sessions.lock().await;
                            sessions.get_mut(&owner).and_then(|s| s.idle.take())
                        };
                        if let Some(signal) = signal {
                            if let Some(waiter) = signal.lock().await.take() {
                                let _ = waiter.send(());
                            }
                        }
                    }
                }
            }
            "session.error" => {
                let Some(session_id) = properties.get("sessionID").and_then(Value::as_str) else {
                    return;
                };
                if properties
                    .get("error")
                    .and_then(|e| e.get("name"))
                    .and_then(Value::as_str)
                    == Some("MessageAbortedError")
                {
                    return;
                }
                let message = properties
                    .get("error")
                    .and_then(|e| e.get("data"))
                    .and_then(|d| d.get("message"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| {
                        properties
                            .get("error")
                            .and_then(|e| e.get("name"))
                            .and_then(Value::as_str)
                            .map(str::to_string)
                    })
                    .unwrap_or_else(|| "CodeArts error".to_string());
                if let Some(owner) = self.owner(session_id, &directory).await {
                    if let Some(state) = self.sessions.lock().await.get_mut(&owner) {
                        state.error = Some(message);
                    }
                }
            }
            "permission.asked" => {
                let Some(session_id) = properties.get("sessionID").and_then(Value::as_str) else {
                    return;
                };
                let Some(owner) = self.owner(session_id, &directory).await else {
                    return;
                };
                self.ask_permission(&owner, &properties).await;
            }
            "question.asked" => {
                // codeg's ACP driver has no question tool here; reject so the
                // turn does not hang (mirrors the reference bridge).
                if let Some(id) = properties.get("id").and_then(Value::as_str) {
                    if let Some(serve) = self.serve.lock().await.clone() {
                        let _ = serve
                            .lock()
                            .await
                            .api(
                                Method::POST,
                                &format!("/question/{id}/reject"),
                                None,
                            )
                            .await;
                    }
                }
            }
            _ => {}
        }
    }

    /// Resolve a (possibly subagent) CodeArts session id to the root session
    /// codeg opened, asking serve once when the parent is not known yet.
    async fn owner(&self, session_id: &str, _directory: &str) -> Option<String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return Some(session_id.to_string());
        }
        if let Some(root) = self.roots.lock().await.get(session_id) {
            return (!root.is_empty()).then(|| root.clone());
        }
        self.roots.lock().await.insert(session_id.to_string(), String::new());
        let serve = self.serve.lock().await.clone()?;
        let info = serve
            .lock()
            .await
            .api(Method::GET, &format!("/session/{session_id}"), None)
            .await
            .ok()?;
        let parent = info.get("parentID").and_then(Value::as_str)?;
        let root = if self.sessions.lock().await.contains_key(parent) {
            parent.to_string()
        } else {
            self.roots.lock().await.get(parent).cloned().unwrap_or_default()
        };
        self.roots.lock().await.insert(session_id.to_string(), root.clone());
        (!root.is_empty()).then_some(root)
    }

    /// Emit (or update) an ACP tool call from a CodeArts tool part.
    async fn tool_update(&self, session_id: &str, part: &Value, live: bool) {
        let Some(state) = part.get("state") else { return };
        let status = state.get("status").and_then(Value::as_str).unwrap_or("");
        let name = part
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        // CodeArts records the underlying MCP tool separately; skip the wrapper.
        if name == "tool_call" {
            return;
        }
        let call_id = part
            .get("callID")
            .and_then(Value::as_str)
            .or_else(|| part.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .to_string();
        let kind = tool_kind(&name);
        let raw_input = state.get("input").cloned().unwrap_or(json!({}));

        let fresh = self.announced.lock().await.insert(call_id.clone());
        if !fresh {
            return;
        }
        let acp_status = match status {
            "running" => "in_progress",
            "completed" => "completed",
            "error" => "failed",
            _ => "pending",
        };
        let mut update = json!({
            "sessionUpdate": if acp_status == "pending" { "tool_call" } else { "tool_call_update" },
            "toolCallId": call_id,
            "kind": kind,
            "title": state.get("title").and_then(Value::as_str).unwrap_or(&name),
            "status": acp_status,
            "rawInput": raw_input
        });
        if status == "completed" || status == "error" {
            let output = state
                .get("output")
                .and_then(|o| o.as_str())
                .unwrap_or("")
                .to_string();
            update["content"] = json!([{
                "type": "content",
                "content": { "type": "text", "text": output }
            }]);
            // `todowrite` is CodeArts' plan tool. Mirror its list as an ACP
            // plan so the composer shows progress, not an opaque tool result.
            if name.eq_ignore_ascii_case("todowrite") {
                if let Some(plan) = plan_from_todowrite(&output) {
                    self.update(session_id, plan);
                }
            }
            if live {
                self.announced.lock().await.remove(&call_id);
            }
        }
        self.update(session_id, update);
    }

    /// Ask codeg to approve a CodeArts permission request, then relay the answer.
    async fn ask_permission(&self, session_id: &str, request: &Value) {
        let request_id = uuid_like();
        let (answer_tx, answer_rx) = oneshot::channel();
        self.pending_permissions
            .lock()
            .await
            .insert(request_id.clone(), answer_tx);
        self.send(json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {
                    "toolCallId": request
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    "status": "pending",
                    "title": request
                        .get("permission")
                        .and_then(Value::as_str)
                        .unwrap_or("permission"),
                    "rawInput": request.get("metadata").cloned().unwrap_or(json!({})),
                    "kind": "other",
                    "locations": []
                },
                "options": [
                    { "optionId": "once", "kind": "allow_once", "name": "Allow once" },
                    { "optionId": "always", "kind": "allow_always", "name": "Always allow" },
                    { "optionId": "reject", "kind": "reject_once", "name": "Reject" }
                ]
            }
        }));
        let outcome = answer_rx.await.unwrap_or(Value::Null);
        let selected = outcome
            .get("optionId")
            .and_then(Value::as_str)
            .unwrap_or("reject");
        let reply = if selected == "once" || selected == "always" {
            selected
        } else {
            "reject"
        };
        if let Some(id) = request.get("id").and_then(Value::as_str) {
            if let Some(serve) = self.serve.lock().await.clone() {
                let _ = serve
                    .lock()
                    .await
                    .api(
                        Method::POST,
                        &format!("/permission/{id}/reply"),
                        Some(&json!({ "reply": reply })),
                    )
                    .await;
            }
        }
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

fn prompt_parts(params: &Value) -> Vec<Value> {
    params
        .get("prompt")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter_map(|block| match block.get("type").and_then(Value::as_str) {
                    Some("text") => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(|text| json!({ "type": "text", "text": text })),
                    Some("image") => block
                        .get("data")
                        .and_then(Value::as_str)
                        .map(|data| {
                            let mime = block
                                .get("mimeType")
                                .and_then(Value::as_str)
                                .unwrap_or("image/png");
                            json!({
                                "type": "file",
                                "url": format!("data:{mime};base64,{data}"),
                                "filename": "image",
                                "mime": mime
                            })
                        }),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn tool_kind(name: &str) -> &'static str {
    match name.to_ascii_lowercase().as_str() {
        "bash" => "execute",
        "webfetch" => "fetch",
        "edit" | "patch" | "apply_patch" | "write" | "deletefile" => "edit",
        "grep" | "glob" => "search",
        "list" | "read" => "read",
        _ => "other",
    }
}

/// Parse a `todowrite` tool's output into an ACP `plan` update. CodeArts writes
/// a JSON array of `{ content, status, priority? }`; cancelled todos are shown
/// as completed instead of vanishing. A non-JSON output yields no plan.
fn plan_from_todowrite(output: &str) -> Option<Value> {
    let todos = serde_json::from_str::<Value>(output.trim()).ok()?;
    let items = todos.as_array()?;
    let entries: Vec<Value> = items
        .iter()
        .filter_map(|todo| {
            let content = todo.get("content")?.as_str()?;
            let raw = todo
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("pending");
            let status = match raw {
                "completed" | "cancelled" => "completed",
                "in_progress" | "running" => "in_progress",
                _ => "pending",
            };
            Some(json!({
                "content": content,
                "status": status,
                "priority": todo.get("priority").and_then(Value::as_str).unwrap_or("medium")
            }))
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    Some(json!({ "sessionUpdate": "plan", "entries": entries }))
}

fn usage_update(_session_id: &str, info: &Value) -> Option<Value> {
    let tokens = info.get("tokens")?;
    let input = tokens.get("input")?.as_u64()?;
    let _output = tokens.get("output")?.as_u64()?;
    Some(json!({
        "sessionUpdate": "usage_update",
        "used": input,
        "size": tokens.get("cache").and_then(|c| c.get("read")).and_then(Value::as_u64).unwrap_or(0) + input,
        "cost": {
            "amount": info.get("cost").and_then(Value::as_f64).unwrap_or(0.0),
            "currency": "USD"
        }
    }))
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
            let stripped = line.strip_prefix("export ").unwrap_or(line).trim_start();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_parts_joins_text_and_images() {
        let params = json!({
            "prompt": [
                { "type": "text", "text": "first" },
                { "type": "image", "data": "AAA", "mimeType": "image/png" }
            ]
        });
        let parts = prompt_parts(&params);
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0]["text"], "first");
        assert_eq!(parts[1]["mime"], "image/png");
    }

    #[test]
    fn tool_kinds_match_acp_vocabulary() {
        assert_eq!(tool_kind("Bash"), "execute");
        assert_eq!(tool_kind("Edit"), "edit");
        assert_eq!(tool_kind("WebFetch"), "fetch");
        assert_eq!(tool_kind("unknown"), "other");
    }

    #[test]
    fn friendly_error_mentions_ak_sk() {
        assert!(friendly_error("access key inactive").contains("AK/SK"));
    }

    #[test]
    fn missing_credentials_are_explained() {
        assert!(missing_credentials_message().contains("CODEARTS_CLI_AK"));
    }

    #[test]
    fn plan_from_todowrite_maps_status_and_cancelled() {
        let output = r#"[{"content":"one","status":"completed"},{"content":"two","status":"in_progress"},{"content":"three","status":"cancelled"},{"content":"four","status":"pending","priority":"high"}]"#;
        let plan = plan_from_todowrite(output).unwrap();
        assert_eq!(plan["sessionUpdate"], "plan");
        let entries = plan["entries"].as_array().unwrap();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[0]["status"], "completed");
        assert_eq!(entries[1]["status"], "in_progress");
        assert_eq!(entries[2]["status"], "completed");
        assert_eq!(entries[3]["status"], "pending");
        assert_eq!(entries[3]["priority"], "high");
        assert!(plan_from_todowrite("not json").is_none());
    }

    #[test]
    fn usage_update_builds_an_acp_frame() {
        let info = json!({
            "tokens": { "input": 100, "output": 20, "cache": { "read": 30 } },
            "cost": 0.5
        });
        let update = usage_update("ses_1", &info).unwrap();
        assert_eq!(update["sessionUpdate"], "usage_update");
        assert_eq!(update["used"], 100);
        assert_eq!(update["cost"]["amount"], 0.5);
    }
}
