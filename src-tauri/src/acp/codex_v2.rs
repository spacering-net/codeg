//! Codex's ACP v2 wire, presented to the existing event consumer as v1.
//!
//! This is a connection-local codec, not an alternate session manager. In v2 a
//! prompt response only acknowledges insertion. We keep the host request open
//! until an idle state AND every concurrent steer have settled. A steer that
//! starts another runtime turn stays owned by that same host request.

use std::collections::{HashMap, HashSet};

use base64::Engine;
use futures::{Sink, SinkExt, Stream, StreamExt};
use serde_json::{json, Value};

pub const LIFECYCLE_META: &str = "codeg.codexV2Lifecycle";

#[derive(Default)]
struct Session {
    prompt: Option<Value>,
    accepted: bool,
    prompt_error: Option<Value>,
    generation: u64,
    running: bool,
    required_generation: u64,
    fallback_generations: Vec<u64>,
    idle: Option<Value>,
    cancelled: bool,
    steers: HashSet<String>,
    tools: HashSet<String>,
    terminals: HashMap<String, Value>,
    echoes: Vec<Value>,
}

struct Request {
    method: String,
    session: String,
    generation: u64,
}

#[derive(Default)]
pub(crate) struct Codec {
    v2: bool,
    requests: HashMap<String, Request>,
    sessions: HashMap<String, Session>,
}

#[derive(Default, Debug)]
pub(crate) struct Frames {
    pub host: Vec<Value>,
    pub agent: Vec<Value>,
}

fn key(id: &Value) -> String {
    id.to_string()
}

fn response(id: Value, result: Value) -> Value {
    json!({"jsonrpc":"2.0", "id":id, "result":result})
}

fn notification(session: &str, update: Value) -> Value {
    json!({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":session,"update":update}})
}

fn rename(value: &mut Value, from: &str, to: &str) {
    if let Some(map) = value.as_object_mut() {
        if let Some(v) = map.remove(from) {
            map.insert(to.into(), v);
        }
    }
}

fn config_options(value: &mut Value) {
    if let Some(options) = value.get_mut("configOptions").and_then(Value::as_array_mut) {
        for option in options {
            rename(option, "configId", "id");
            if let Some(groups) = option.get_mut("options").and_then(Value::as_array_mut) {
                for group in groups {
                    rename(group, "groupId", "group");
                }
            }
        }
    }
}

fn tool_content(tool: &mut Value) {
    let Some(content) = tool.get_mut("content").and_then(Value::as_array_mut) else {
        return;
    };
    let mut normalized = Vec::new();
    for item in content.drain(..) {
        if item["type"] != "diff" {
            normalized.push(item);
            continue;
        }
        // v2 carries exact patches, not full before/after file snapshots. Feed
        // the existing AIR patch reader; the empty strings are placeholders.
        if let Some(changes) = item["changes"].as_array() {
            for change in changes {
                let mut meta = item.get("_meta").cloned().unwrap_or_else(|| json!({}));
                meta["jetbrains"]["air"]["diffPatch"] = json!({
                    "version":1, "format":item["patch"]["format"], "text":item["patch"]["text"]
                });
                meta["kind"] = json!(match change["operation"].as_str() {
                    Some("add") => "add",
                    Some("delete") => "delete",
                    _ => "update",
                });
                normalized.push(json!({"type":"diff","path":change["path"],"oldText":null,"newText":"","_meta":meta}));
            }
        }
    }
    *content = normalized;
}

impl Codec {
    pub(crate) fn outgoing(&mut self, mut message: Value) -> Frames {
        let mut frames = Frames::default();
        let method = message["method"].as_str().unwrap_or("").to_owned();
        let session_id = message["params"]["sessionId"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        let id = message.get("id").cloned();
        // Permission and host-tool responses have no method/params. They are
        // already valid on both wires; do not synthesize request fields.
        if method.is_empty() {
            frames.agent.push(message);
            return frames;
        }
        if method == "initialize" {
            // Keep the v1 fields too: old/custom executables can negotiate v1
            // without losing client identity or their existing capabilities.
            let params = &mut message["params"];
            params["protocolVersion"] = json!(2);
            // The v1 SDK can omit clientInfo entirely. V2 requires an info
            // object even for that default initialization path.
            params["info"] = params
                .get("clientInfo")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({"name":"codeg","version":env!("CARGO_PKG_VERSION")}));
            let mut capabilities = params
                .get("clientCapabilities")
                .filter(|value| value.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            if capabilities["auth"]["terminal"] == true {
                capabilities["auth"]["terminal"] = json!({});
            }
            params["capabilities"] = capabilities;
        }
        if self.v2 {
            let session = self.sessions.entry(session_id.clone()).or_default();
            match method.as_str() {
                "authenticate" => message["method"] = json!("auth/login"),
                "logout" => message["method"] = json!("auth/logout"),
                "session/load" => {
                    message["method"] = json!("session/resume");
                    message["params"]["replayFrom"] = json!({"type":"start"});
                    session.tools.clear();
                    session.terminals.clear();
                }
                "session/set_mode" => {
                    message["method"] = json!("session/set_config_option");
                    message["params"]["configId"] = json!("mode");
                    message["params"]["value"] = message["params"]["modeId"].take();
                    message["params"]["type"] = json!("id");
                    message["params"].as_object_mut().unwrap().remove("modeId");
                }
                "session/set_config_option" => {
                    message["params"]["type"] = json!(if message["params"]["value"].is_boolean() {
                        "boolean"
                    } else {
                        "id"
                    });
                }
                "session/prompt" => {
                    if session.prompt.is_some() {
                        frames.host.push(json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"A Codex turn is still owned by this session"}}));
                        return frames;
                    }
                    session.prompt = id.clone();
                    session.accepted = false;
                    session.prompt_error = None;
                    session.idle = None;
                    session.cancelled = false;
                    session.required_generation = session.generation;
                    session.fallback_generations.clear();
                    session.echoes = message["params"]["prompt"]
                        .as_array()
                        .cloned()
                        .unwrap_or_default();
                }
                "_session/steering" => {
                    // No owning host turn means a normal queued prompt is the
                    // only safe path. Do not let the adapter consume it first.
                    if session.prompt.is_none() || session.cancelled {
                        frames.host.push(response(
                            id.unwrap_or(Value::Null),
                            json!({"outcome":"promptRequired"}),
                        ));
                        return frames;
                    }
                    if let Some(id) = &id {
                        session.steers.insert(key(id));
                    }
                    session.echoes.extend(
                        message["params"]["prompt"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .cloned(),
                    );
                }
                "session/cancel" => session.cancelled = true,
                _ => {}
            }
            if let Some(servers) = message["params"]
                .get_mut("mcpServers")
                .and_then(Value::as_array_mut)
            {
                for server in servers {
                    if server.get("type").is_none() {
                        server["type"] = json!("stdio");
                    }
                }
            }
        }
        if !method.is_empty() {
            if let Some(id) = id {
                let generation = self.sessions.get(&session_id).map_or(0, |s| s.generation);
                self.requests.insert(
                    key(&id),
                    Request {
                        method,
                        session: session_id,
                        generation,
                    },
                );
            }
        }
        frames.agent.push(message);
        frames
    }

    pub(crate) fn incoming(&mut self, mut message: Value) -> Frames {
        let mut frames = Frames::default();
        if message.get("method").is_none() {
            let request = message
                .get("id")
                .and_then(|id| self.requests.remove(&key(id)));
            if let Some(request) = request {
                if request.method == "initialize" {
                    self.v2 = message["result"]["protocolVersion"] == 2;
                    // Only this codec can vouch for lifecycle ownership. Never
                    // trust a marker supplied by a legacy/custom adapter.
                    if let Some(meta) = message
                        .get_mut("result")
                        .and_then(|r| r.get_mut("_meta"))
                        .and_then(Value::as_object_mut)
                    {
                        meta.remove(LIFECYCLE_META);
                    }
                    if self.v2 {
                        normalize_initialize(&mut message["result"]);
                    }
                } else if self.v2 {
                    let session = self.sessions.entry(request.session.clone()).or_default();
                    match request.method.as_str() {
                        "session/prompt" => {
                            session.accepted = true;
                            if message.get("error").is_some() {
                                session.prompt_error = message.get("error").cloned();
                                // A rejected insertion can still have started a
                                // runtime turn. Keep cancellation and pending
                                // steers attached until its idle notification.
                                if session.generation == request.generation
                                    && session.idle.is_none()
                                {
                                    session.idle = Some(json!({"state":"idle"}));
                                }
                            }
                            finish(session, &mut frames);
                            return frames;
                        }
                        "_session/steering" => {
                            session.steers.remove(&key(&message["id"]));
                            if message["result"]["outcome"] == "startedNewTurn" {
                                // Each fallback consumes a separate reservation. Multiple
                                // requests can have observed the SAME old generation, and
                                // their replies can arrive out of order. Match them to
                                // distinct later generations instead of taking only max.
                                session.fallback_generations.push(request.generation);
                                session.fallback_generations.sort_unstable();
                                session.required_generation = session
                                    .fallback_generations
                                    .iter()
                                    .fold(0, |generation, requested| {
                                        (generation + 1).max(requested + 1)
                                    });
                                // The payload is already consumed. The v2
                                // states keep its subsequent work owned, so
                                // the manager records it exactly like injection.
                                message["result"]["outcome"] = json!("injected");
                            }
                            frames.host.push(message);
                            finish(session, &mut frames);
                            return frames;
                        }
                        "session/new"
                        | "session/load"
                        | "session/resume"
                        | "session/fork"
                        | "session/set_config_option"
                        | "session/set_mode" => {
                            let Some(result) = message.get_mut("result") else {
                                frames.host.push(message);
                                return frames;
                            };
                            config_options(result);
                            if let Some(commands) = result.get("availableCommands") {
                                let sid = result["sessionId"].as_str().unwrap_or(&request.session);
                                frames.host.push(notification(sid, json!({"sessionUpdate":"available_commands_update","availableCommands":commands})));
                            }
                            // v1 consumers still have a modes selector. Its
                            // source of truth remains the v2 mode config option.
                            if let Some(mode) = result["configOptions"]
                                .as_array()
                                .and_then(|o| o.iter().find(|o| o["id"] == "mode"))
                                .cloned()
                            {
                                let modes: Vec<Value> = mode["options"]
                                    .as_array()
                                    .into_iter()
                                    .flatten()
                                    .map(|o| {
                                        let mut o = o.clone();
                                        rename(&mut o, "value", "id");
                                        o
                                    })
                                    .collect();
                                result["modes"] = json!({"currentModeId":mode["currentValue"],"availableModes":modes});
                            }
                        }
                        _ => {}
                    }
                }
            }
            frames.host.push(message);
            return frames;
        }
        if !self.v2 {
            frames.host.push(message);
            return frames;
        }
        match message["method"].as_str().unwrap_or("") {
            "session/request_permission" => {
                let params = &mut message["params"];
                let cancelled = params["sessionId"]
                    .as_str()
                    .and_then(|sid| self.sessions.get(sid))
                    .is_some_and(|s| s.cancelled && s.prompt.is_some());
                if cancelled || params["subject"]["type"] != "tool_call" {
                    frames.agent.push(response(
                        message["id"].clone(),
                        json!({"outcome":{"outcome":"cancelled"}}),
                    ));
                    return frames;
                }
                params["toolCall"] = params["subject"]["toolCall"].clone();
                if params["toolCall"].get("title").is_none() {
                    params["toolCall"]["title"] = params["title"].clone();
                }
                tool_content(&mut params["toolCall"]);
                params["_meta"]["permission_prompt"] =
                    json!({"title":params["title"],"description":params["description"]});
                params.as_object_mut().unwrap().remove("subject");
                frames.host.push(message);
            }
            "session/update" => {
                let sid = message["params"]["sessionId"]
                    .as_str()
                    .unwrap_or("")
                    .to_owned();
                let session = self.sessions.entry(sid.clone()).or_default();
                let update = &mut message["params"]["update"];
                match update["sessionUpdate"].as_str().unwrap_or("") {
                    "state_update" => {
                        match update["state"].as_str() {
                            Some("running") => {
                                // Returning from an approval is the same work,
                                // not proof that a fallback turn has started.
                                if !session.running {
                                    session.generation += 1;
                                }
                                session.running = true;
                                session.idle = None;
                                if session.cancelled && session.prompt.is_some() {
                                    // Cancellation can precede a late steer
                                    // fallback's turn/start. Cancel that owned
                                    // work too; never leave it detached.
                                    frames.agent.push(json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":sid}}));
                                }
                            }
                            Some("idle") => {
                                session.running = false;
                                session.idle = Some(update.clone());
                                finish(session, &mut frames);
                            }
                            _ => {} // requires_action is still a running host turn.
                        }
                    }
                    "user_message" | "agent_message" | "agent_thought" => {
                        // v2 replay starts with an empty whole-message reset.
                        // The host rebuilds history on attach, so only content
                        // blocks need v1 chunks; the empty reset is not a turn.
                        if let Some(blocks) = update["content"].as_array() {
                            for block in blocks {
                                let mut chunk = update.clone();
                                chunk["sessionUpdate"] = json!(format!(
                                    "{}_chunk",
                                    update["sessionUpdate"].as_str().unwrap()
                                ));
                                chunk["content"] = block.clone();
                                frames.host.push(notification(&sid, chunk));
                            }
                        }
                    }
                    "user_message_chunk" if session.prompt.is_some() => {
                        // Only suppress matching submitted blocks. Synthetic
                        // plan/goal prompts belong in the live transcript too.
                        if let Some(index) =
                            session.echoes.iter().position(|b| b == &update["content"])
                        {
                            session.echoes.remove(index);
                        } else {
                            frames.host.push(message);
                        }
                    }
                    "terminal_update" | "terminal_output_chunk" => {
                        let terminal = update["terminalId"].as_str().unwrap_or("").to_owned();
                        let mut meta = json!({});
                        if update.get("command").is_some() || update.get("cwd").is_some() {
                            meta["terminal_info"] =
                                json!({"terminal_id":terminal,"cwd":update["cwd"]});
                        }
                        let data = update
                            .get("data")
                            .or_else(|| update["output"].get("data"))
                            .and_then(Value::as_str);
                        if let Some(data) = data {
                            if let Ok(bytes) =
                                base64::engine::general_purpose::STANDARD.decode(data)
                            {
                                meta["terminal_output_delta"] = json!({"terminal_id":terminal,"data":String::from_utf8_lossy(&bytes)});
                            }
                        }
                        if let Some(exit) = update.get("exitStatus") {
                            meta["terminal_exit"] = json!({"terminal_id":terminal,"exit_code":exit["exitCode"],"signal":exit["signal"]});
                        }
                        if session.tools.contains(&terminal) {
                            frames.host.push(notification(&sid,json!({"sessionUpdate":"tool_call_update","toolCallId":terminal,"_meta":meta})));
                        } else {
                            let pending = session
                                .terminals
                                .entry(terminal)
                                .or_insert_with(|| json!({}));
                            merge_meta(pending, meta);
                        }
                    }
                    "tool_call_update" => {
                        let id = update["toolCallId"].as_str().unwrap_or("").to_owned();
                        tool_content(update);
                        if session.tools.insert(id.clone()) {
                            update["sessionUpdate"] = json!("tool_call");
                            if update.get("title").is_none() {
                                update["title"] = json!("Tool");
                            }
                            if let Some(meta) = session.terminals.remove(&id) {
                                if !update["_meta"].is_object() {
                                    update["_meta"] = json!({});
                                }
                                merge_meta(&mut update["_meta"], meta);
                            }
                        }
                        frames.host.push(message);
                    }
                    "config_option_update" => {
                        config_options(update);
                        frames.host.push(message);
                    }
                    "plan_update" if update["plan"]["type"] == "items" => {
                        update["sessionUpdate"] = json!("plan");
                        update["entries"] = update["plan"]["entries"].clone();
                        update.as_object_mut().unwrap().remove("plan");
                        frames.host.push(message);
                    }
                    "_subagent_update" => {
                        update["sessionUpdate"] = json!(if update.get("state").is_some() {
                            "subagent_state_update"
                        } else {
                            "subagent_spawned"
                        });
                        frames.host.push(message);
                    }
                    "_async_task_spawned" => {
                        update["sessionUpdate"] = json!("async_task_spawned");
                        frames.host.push(message);
                    }
                    "_async_task_state_update" => {
                        update["sessionUpdate"] = json!("async_task_state_update");
                        frames.host.push(message);
                    }
                    _ => frames.host.push(message),
                }
            }
            _ => frames.host.push(message),
        }
        frames
    }
}

fn merge_meta(target: &mut Value, source: Value) {
    if let (Some(target), Some(source)) = (target.as_object_mut(), source.as_object()) {
        for (k, v) in source {
            if k == "terminal_output_delta" {
                if let Some(previous) = target.get_mut(k) {
                    let text = format!(
                        "{}{}",
                        previous["data"].as_str().unwrap_or(""),
                        v["data"].as_str().unwrap_or("")
                    );
                    previous["data"] = json!(text);
                    continue;
                }
            }
            target.insert(k.clone(), v.clone());
        }
    }
}

fn finish(session: &mut Session, frames: &mut Frames) {
    if !session.accepted
        || !session.steers.is_empty()
        || session.generation < session.required_generation
    {
        return;
    }
    let (Some(id), Some(idle)) = (&session.prompt, &session.idle) else {
        return;
    };
    if let Some(error) = &session.prompt_error {
        frames
            .host
            .push(json!({"jsonrpc":"2.0","id":id,"error":error}));
    } else if idle.get("error").is_some_and(Value::is_object) {
        frames
            .host
            .push(json!({"jsonrpc":"2.0","id":id,"error":idle["error"]}));
    } else {
        let mut result =
            json!({"stopReason":idle.get("stopReason").cloned().unwrap_or(json!("end_turn"))});
        for name in ["usage", "_meta"] {
            if let Some(value) = idle.get(name) {
                result[name] = value.clone();
            }
        }
        frames.host.push(response(id.clone(), result));
    }
    session.prompt = None;
    session.accepted = false;
    session.prompt_error = None;
    session.idle = None;
    session.echoes.clear();
    session.fallback_generations.clear();
}

#[cfg(test)]
#[path = "codex_v2_tests.rs"]
mod tests;

fn normalize_initialize(result: &mut Value) {
    rename(result, "info", "agentInfo");
    let capabilities = result["capabilities"].clone();
    let prompt = &capabilities["session"]["prompt"];
    result["agentCapabilities"] = json!({
        "loadSession":true,
        "promptCapabilities":{"image":prompt.get("image").is_some(),"audio":prompt.get("audio").is_some(),"embeddedContext":prompt.get("embeddedContext").is_some()},
        "mcpCapabilities":{"http":capabilities["session"]["mcp"].get("http").is_some(),"sse":false},
        "sessionCapabilities":{"resume":{},"close":{}}
    });
    if capabilities["session"].get("fork").is_some() {
        result["agentCapabilities"]["sessionCapabilities"]["fork"] = json!({});
    }
    if let Some(auth) = capabilities.get("auth") {
        result["agentCapabilities"]["auth"] = auth.clone();
    }
    if let Some(methods) = result["authMethods"].as_array_mut() {
        for method in methods {
            rename(method, "methodId", "id");
        }
    }
    let official = result["agentInfo"]["name"] == "@agentclientprotocol/codex-acp";
    let tested = result["agentInfo"]["version"]
        .as_str()
        .and_then(|v| semver::Version::parse(v).ok())
        .is_some_and(|v| v >= semver::Version::new(2, 3, 0));
    result["_meta"][LIFECYCLE_META] = json!(official && tested);
    // The host schema is v1; only the wire speaks v2.
    result["protocolVersion"] = json!(1);
}

/// Run together with the protocol driver and process monitor. No detached
/// task survives connection teardown; EOF fails all outstanding host requests.
pub(crate) async fn bridge<S, R>(
    mut agent_out: S,
    mut agent_in: R,
    mut host_out: futures::channel::mpsc::UnboundedReceiver<String>,
    host_in: futures::channel::mpsc::UnboundedSender<std::io::Result<String>>,
) -> std::io::Result<()>
where
    S: Sink<String, Error = std::io::Error> + Unpin,
    R: Stream<Item = std::io::Result<String>> + Unpin,
{
    let mut codec = Codec::default();
    loop {
        let frames = tokio::select! {
            line = host_out.next() => {
                let Some(line) = line else { return Ok(()) };
                codec.outgoing(serde_json::from_str(&line).map_err(std::io::Error::other)?)
            }
            line = agent_in.next() => {
                let Some(line) = line else { return Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof,"Codex ACP connection closed")) };
                codec.incoming(serde_json::from_str(&line?).map_err(std::io::Error::other)?)
            }
        };
        for message in frames.agent {
            agent_out.send(message.to_string()).await?;
        }
        for message in frames.host {
            host_in
                .unbounded_send(Ok(message.to_string()))
                .map_err(std::io::Error::other)?;
        }
    }
}
