//! Each agent's way of writing a server down, to and from the one
//! definition every agent shares.
//!
//! Reading takes an entry as the agent itself would: its own discriminator
//! (`type`, `transport`, none at all), its own spellings (`http_headers`,
//! `environment`, `httpUrl`), its own on/off flag. What is not part of the
//! definition is the agent's own (`extra`) and is only ever carried back to
//! the same entry.
//!
//! Writing changes the definition's fields and nothing else. On an entry
//! that exists, a field whose meaning did not change is not touched at all —
//! so its formatting, and a value codeg would spell differently, stay as the
//! user wrote them — and the entry's other fields stay where they are. The
//! one exception is a change of transport, which takes the other transport's
//! fields with it where the agent would refuse them.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::commands::mcp::McpAppType;

use super::agents::EntryFlag;
use super::model::{codes, McpDefinition, McpIssue, McpTransport};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Family {
    /// `type` + `command`/`args`/`env` | `url`/`headers`, the type inferred
    /// when absent: Claude Code and everything shaped after it.
    Generic,
    /// The same, plus `httpUrl` for streamable HTTP (Gemini CLI, Qoder).
    Gemini,
    /// `type` is `stdio` | `sse` | `streamableHttp`; a url with no type is
    /// SSE.
    Cline,
    /// A union of a stdio and a remote shape; `type` only says `sse`.
    Cursor,
    /// No `type` written; `registry` entries are not servers.
    Kiro,
    /// Discriminated on `transport`; `type` is ignored.
    Kimi,
    /// Discriminated on `transport` (or `type`); stdio and http only.
    CommandCode,
    /// `type` is `local` | `remote`; the command and its arguments are one
    /// array; `environment`.
    OpenCode,
    /// TOML, no discriminator, `http_headers` (Codex, TRAE CLI).
    Codex,
    /// TOML, `type` only for SSE.
    Grok,
    /// YAML, `transport: sse` for SSE.
    Hermes,
}

fn family(app: McpAppType) -> Family {
    match app {
        McpAppType::ClaudeCode
        | McpAppType::CodeBuddy
        | McpAppType::OpenClaw
        | McpAppType::Pi
        | McpAppType::DeepSeek
        | McpAppType::ZCode
        | McpAppType::MiniMaxCode
        | McpAppType::Antigravity => Family::Generic,
        McpAppType::Gemini | McpAppType::Qoder => Family::Gemini,
        McpAppType::Cline => Family::Cline,
        McpAppType::Cursor => Family::Cursor,
        McpAppType::Kiro => Family::Kiro,
        McpAppType::KimiCode => Family::Kimi,
        McpAppType::CommandCode => Family::CommandCode,
        McpAppType::OpenCode => Family::OpenCode,
        McpAppType::Codex | McpAppType::Trae => Family::Codex,
        McpAppType::Grok => Family::Grok,
        McpAppType::Hermes => Family::Hermes,
    }
}

/// A transport name as people and agents write it: `stdio`, `http`, `sse`,
/// and the spellings of streamable HTTP (`streamable-http`, `streamableHttp`,
/// `streamable_http`, …).
pub(crate) fn normalize_type(raw: &str) -> Option<McpTransport> {
    let lower = raw.trim().to_ascii_lowercase();
    match lower.as_str() {
        "stdio" => Some(McpTransport::Stdio),
        "http" => Some(McpTransport::Http),
        "sse" => Some(McpTransport::Sse),
        _ => {
            let collapsed: String = lower.chars().filter(char::is_ascii_alphanumeric).collect();
            (collapsed == "streamablehttp").then_some(McpTransport::Http)
        }
    }
}

fn non_blank<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn scalar_text(value: &Value) -> Option<String> {
    match value {
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

/// A list of strings. A number or a boolean in it is shown as text and
/// remarked on; anything else is left out and remarked on.
pub(crate) fn read_string_list(
    value: Option<&Value>,
    field: &str,
    code: &str,
    problems: &mut Vec<McpIssue>,
) -> Vec<String> {
    let mut remark = false;
    let out = match value {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(text) => Some(text.clone()),
                other => {
                    remark = true;
                    scalar_text(other)
                }
            })
            .collect(),
        Some(_) => {
            remark = true;
            Vec::new()
        }
    };
    if remark {
        problems.push(McpIssue::new(code).field(field));
    }
    out
}

/// A map of strings, read like [`read_string_list`].
pub(crate) fn read_string_map(
    value: Option<&Value>,
    field: &str,
    code: &str,
    problems: &mut Vec<McpIssue>,
) -> BTreeMap<String, String> {
    let mut remark = false;
    let out = match value {
        None | Some(Value::Null) => BTreeMap::new(),
        Some(Value::Object(map)) => map
            .iter()
            .filter_map(|(key, item)| match item {
                Value::String(text) => Some((key.clone(), text.clone())),
                other => {
                    remark = true;
                    scalar_text(other).map(|text| (key.clone(), text))
                }
            })
            .collect(),
        Some(_) => {
            remark = true;
            BTreeMap::new()
        }
    };
    if remark {
        problems.push(McpIssue::new(code).field(field));
    }
    out
}

/// An entry as the engine understands it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ReadEntry {
    pub definition: Option<McpDefinition>,
    pub extra: Map<String, Value>,
    /// By the flag on the entry itself; a list of names at the document's
    /// root is the caller's to apply.
    pub enabled: bool,
    pub problems: Vec<McpIssue>,
}

fn unsupported_type(raw: &str) -> McpIssue {
    McpIssue::new(codes::UNSUPPORTED_TYPE)
        .field("type")
        .detail(raw.to_string())
}

fn infer_from_shape(obj: &Map<String, Value>) -> Result<McpTransport, McpIssue> {
    if obj.contains_key("command") {
        Ok(McpTransport::Stdio)
    } else if obj.contains_key("url") {
        Ok(McpTransport::Http)
    } else {
        Err(McpIssue::new(codes::MISSING_COMMAND_OR_URL))
    }
}

fn declared_type(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

/// The transport `obj` names, the way `app` itself decides it. Remarks that
/// do not stop the entry from being a server go to `problems`.
fn classify(
    app: McpAppType,
    obj: &Map<String, Value>,
    problems: &mut Vec<McpIssue>,
) -> Result<McpTransport, McpIssue> {
    let by_type_then_shape = |obj: &Map<String, Value>| match declared_type(obj, "type") {
        Some(raw) => normalize_type(&raw).ok_or_else(|| unsupported_type(&raw)),
        None => infer_from_shape(obj),
    };
    match family(app) {
        Family::Generic | Family::Kiro => by_type_then_shape(obj),
        Family::Gemini => {
            // `httpUrl` is looked at first, whatever else the entry says.
            if non_blank(obj, "httpUrl").is_some() {
                return Ok(McpTransport::Http);
            }
            by_type_then_shape(obj)
        }
        Family::Cline => match declared_type(obj, "type") {
            Some(raw) => {
                let transport = normalize_type(&raw).ok_or_else(|| unsupported_type(&raw))?;
                // Cline takes exactly these three literals, and one entry it
                // refuses costs the user every server in the file.
                if !matches!(raw.as_str(), "stdio" | "sse" | "streamableHttp") {
                    problems.push(
                        McpIssue::new(codes::REJECTED_BY_AGENT)
                            .field("type")
                            .detail(raw),
                    );
                }
                Ok(transport)
            }
            None if obj.contains_key("command") => Ok(McpTransport::Stdio),
            None if obj.contains_key("url") => {
                // `type ?? transportType ?? "sse"`: a bare url is SSE.
                match declared_type(obj, "transportType").as_deref() {
                    Some(legacy) => match normalize_type(legacy) {
                        Some(transport) => Ok(transport),
                        None => Err(McpIssue::new(codes::UNSUPPORTED_TYPE)
                            .field("transportType")
                            .detail(legacy.to_string())),
                    },
                    None => Ok(McpTransport::Sse),
                }
            }
            None => Err(McpIssue::new(codes::MISSING_COMMAND_OR_URL)),
        },
        Family::Cursor => {
            if crate::commands::mcp::fits_cursor_stdio(obj) {
                Ok(McpTransport::Stdio)
            } else if crate::commands::mcp::fits_cursor_remote(obj) {
                Ok(match obj.get("type").and_then(Value::as_str) {
                    Some("sse") => McpTransport::Sse,
                    _ => McpTransport::Http,
                })
            } else {
                // Cursor refuses an entry that fits neither shape — and with
                // it the whole file. Still say what the entry is trying to be.
                let shape = infer_from_shape(obj)?;
                problems.push(McpIssue::new(codes::REJECTED_BY_AGENT));
                Ok(shape)
            }
        }
        Family::Kimi => {
            if obj.contains_key("transport") {
                match obj.get("transport").and_then(Value::as_str) {
                    Some("stdio") => Ok(McpTransport::Stdio),
                    Some("http") => Ok(McpTransport::Http),
                    Some("sse") => Ok(McpTransport::Sse),
                    other => Err(McpIssue::new(codes::UNSUPPORTED_TYPE)
                        .field("transport")
                        .detail(other.unwrap_or("<not a string>").to_string())),
                }
            } else {
                infer_from_shape(obj)
            }
        }
        Family::CommandCode => {
            let declared = ["transport", "type"]
                .into_iter()
                .find(|key| obj.contains_key(*key));
            match declared {
                Some(key) => match obj.get(key).and_then(Value::as_str) {
                    Some("stdio") => Ok(McpTransport::Stdio),
                    Some("http") => Ok(McpTransport::Http),
                    other => Err(McpIssue::new(codes::UNSUPPORTED_TYPE)
                        .field(key)
                        .detail(other.unwrap_or("<not a string>").to_string())),
                },
                None => infer_from_shape(obj),
            }
        }
        Family::OpenCode => match obj.get("type").and_then(Value::as_str) {
            Some("local") => Ok(McpTransport::Stdio),
            Some("remote") => Ok(McpTransport::Http),
            other => Err(unsupported_type(other.unwrap_or("<missing>"))),
        },
        Family::Codex => {
            // Codex refuses an entry that carries both transports.
            if obj.contains_key("command") && obj.contains_key("url") {
                return Err(McpIssue::new(codes::COMMAND_AND_URL));
            }
            match declared_type(obj, "type") {
                // Not a Codex key, but older codeg releases wrote it.
                Some(raw) => normalize_type(&raw).ok_or_else(|| unsupported_type(&raw)),
                None if non_blank(obj, "url").is_some() && non_blank(obj, "command").is_none() => {
                    Ok(McpTransport::Http)
                }
                None => Ok(McpTransport::Stdio),
            }
        }
        Family::Grok => match declared_type(obj, "type") {
            Some(raw) => match raw.as_str() {
                "stdio" => Ok(McpTransport::Stdio),
                "http" => Ok(McpTransport::Http),
                "sse" => Ok(McpTransport::Sse),
                _ => Err(unsupported_type(&raw)),
            },
            None if non_blank(obj, "url").is_some() => Ok(McpTransport::Http),
            None => Ok(McpTransport::Stdio),
        },
        Family::Hermes => match declared_type(obj, "type") {
            Some(raw) => normalize_type(&raw).ok_or_else(|| unsupported_type(&raw)),
            None if obj.contains_key("url") => {
                let sse = obj
                    .get("transport")
                    .and_then(Value::as_str)
                    .is_some_and(|transport| transport.trim().eq_ignore_ascii_case("sse"));
                Ok(if sse {
                    McpTransport::Sse
                } else {
                    McpTransport::Http
                })
            }
            None if obj.contains_key("command") => Ok(McpTransport::Stdio),
            None => Err(McpIssue::new(codes::MISSING_COMMAND_OR_URL)),
        },
    }
}

/// The keys of an entry that spell the definition for `app`, whichever
/// transport: everything else on the entry is the agent's own.
fn definition_keys(app: McpAppType) -> &'static [&'static str] {
    match family(app) {
        Family::Generic | Family::Cursor | Family::Kiro | Family::Grok => {
            &["type", "command", "args", "env", "url", "headers"]
        }
        Family::Gemini => &[
            "type", "command", "args", "env", "url", "httpUrl", "headers",
        ],
        Family::Cline => &[
            "type",
            "transportType",
            "command",
            "args",
            "env",
            "url",
            "headers",
        ],
        Family::Kimi | Family::CommandCode | Family::Hermes => &[
            "type",
            "transport",
            "command",
            "args",
            "env",
            "url",
            "headers",
        ],
        Family::OpenCode => &["type", "command", "environment", "url", "headers"],
        Family::Codex => &[
            "type",
            "command",
            "args",
            "env",
            "url",
            "http_headers",
            "headers",
        ],
    }
}

fn headers_key(app: McpAppType, obj: &Map<String, Value>) -> &'static str {
    match family(app) {
        // `headers` is not Codex's key; older codeg releases wrote it.
        Family::Codex if !obj.contains_key("http_headers") && obj.contains_key("headers") => {
            "headers"
        }
        Family::Codex => "http_headers",
        _ => "headers",
    }
}

fn url_key(app: McpAppType, obj: &Map<String, Value>) -> &'static str {
    if family(app) == Family::Gemini && non_blank(obj, "httpUrl").is_some() {
        "httpUrl"
    } else {
        "url"
    }
}

/// Whether the flag on the entry leaves it on.
fn flag_says_enabled(
    app: McpAppType,
    flag: EntryFlag,
    obj: &Map<String, Value>,
    problems: &mut Vec<McpIssue>,
) -> bool {
    match obj.get(flag.key) {
        None | Some(Value::Null) => true,
        Some(Value::Bool(value)) => *value != flag.off,
        // Hermes reads its flag loosely: these words too, anything else on.
        Some(Value::String(text)) if app == McpAppType::Hermes => {
            let word = text.trim().to_ascii_lowercase();
            let off = matches!(word.as_str(), "false" | "0" | "no" | "off");
            off == flag.off
        }
        Some(_) => {
            problems.push(McpIssue::new(codes::INVALID_ENABLED_FLAG).field(flag.key));
            true
        }
    }
}

/// Read one entry of `app`'s servers. `flag` is the on/off key the entry may
/// carry (an older OpenCode entry carries another one than a current one).
pub(crate) fn read_entry(app: McpAppType, value: &Value, flag: Option<EntryFlag>) -> ReadEntry {
    let Some(obj) = value.as_object() else {
        return ReadEntry {
            definition: None,
            extra: Map::new(),
            enabled: true,
            problems: vec![McpIssue::new(codes::ENTRY_NOT_AN_OBJECT)],
        };
    };
    let mut problems = Vec::new();
    let transport = match classify(app, obj, &mut problems) {
        Ok(transport) => Some(transport),
        Err(problem) => {
            problems.push(problem);
            None
        }
    };
    let definition = transport.and_then(|transport| match transport {
        McpTransport::Stdio => {
            let (command, args) = if family(app) == Family::OpenCode {
                // One array: the executable, then its arguments.
                let parts = obj.get("command").and_then(Value::as_array);
                let valid = parts
                    .is_some_and(|parts| !parts.is_empty() && parts.iter().all(Value::is_string));
                let mut parts = parts
                    .filter(|_| valid)
                    .map(|parts| {
                        parts
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default()
                    .into_iter();
                (
                    parts.next().filter(|command| !command.trim().is_empty()),
                    parts.collect(),
                )
            } else {
                (
                    non_blank(obj, "command").map(str::to_string),
                    read_string_list(obj.get("args"), "args", codes::INVALID_ARGS, &mut problems),
                )
            };
            let Some(command) = command else {
                problems.push(McpIssue::new(codes::INVALID_COMMAND).field("command"));
                return None;
            };
            let env_key = if family(app) == Family::OpenCode {
                "environment"
            } else {
                "env"
            };
            let env = read_string_map(obj.get(env_key), env_key, codes::INVALID_ENV, &mut problems);
            Some(McpDefinition::Stdio { command, args, env })
        }
        McpTransport::Http | McpTransport::Sse => {
            let url_key = url_key(app, obj);
            let Some(url) = non_blank(obj, url_key).map(str::to_string) else {
                problems.push(McpIssue::new(codes::INVALID_URL).field(url_key));
                return None;
            };
            let headers_key = headers_key(app, obj);
            let headers = read_string_map(
                obj.get(headers_key),
                headers_key,
                codes::INVALID_HEADERS,
                &mut problems,
            );
            Some(if transport == McpTransport::Sse {
                McpDefinition::Sse { url, headers }
            } else {
                McpDefinition::Http { url, headers }
            })
        }
    });
    let enabled = flag.is_none_or(|flag| flag_says_enabled(app, flag, obj, &mut problems));
    let consumed = definition_keys(app);
    let extra = obj
        .iter()
        .filter(|(key, _)| {
            !consumed.contains(&key.as_str()) && flag.is_none_or(|flag| flag.key != key.as_str())
        })
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    ReadEntry {
        definition,
        extra,
        enabled,
        problems,
    }
}

// ─── Writing ────────────────────────────────────────────────────────────

/// One change to one field of an entry.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum FieldOp {
    Set(String, Value),
    /// Make the map of strings under this key equal to this one, key by key:
    /// values that are already right are left alone.
    SyncMap(String, BTreeMap<String, String>),
    Remove(String),
}

/// The changes that turn an existing entry into one that says a definition.
#[derive(Debug, Clone, PartialEq, Default)]
pub(crate) struct Patch {
    pub ops: Vec<FieldOp>,
    /// Fields of the transport the entry no longer has that went with it.
    pub dropped: Vec<String>,
}

fn string_list(items: &[String]) -> Value {
    Value::Array(items.iter().cloned().map(Value::String).collect())
}

fn string_map(map: &BTreeMap<String, String>) -> Value {
    Value::Object(
        map.iter()
            .map(|(key, value)| (key.clone(), Value::String(value.clone())))
            .collect(),
    )
}

/// The word `app` writes for a transport in `type`.
fn type_word(app: McpAppType, transport: McpTransport) -> &'static str {
    match (family(app), transport) {
        (Family::Cline, McpTransport::Http) => "streamableHttp",
        (Family::OpenCode, McpTransport::Stdio) => "local",
        (Family::OpenCode, _) => "remote",
        (_, transport) => transport.as_str(),
    }
}

/// A new entry for `definition`, in `app`'s own shape: the fields in the
/// order they are written.
pub(crate) fn fresh_fields(app: McpAppType, definition: &McpDefinition) -> Vec<(String, Value)> {
    let transport = definition.transport();
    let family = family(app);
    let mut fields: Vec<(String, Value)> = Vec::new();
    let mut push = |key: &str, value: Value| fields.push((key.to_string(), value));
    let word = || Value::String(type_word(app, transport).to_string());

    // The discriminator, where the agent has one for this transport.
    match family {
        Family::Generic | Family::Gemini | Family::Cline | Family::OpenCode => push("type", word()),
        Family::Kimi if transport.is_remote() => push("transport", word()),
        Family::CommandCode => push("transport", word()),
        Family::Cursor | Family::Grok if transport == McpTransport::Sse => push("type", word()),
        _ => {}
    }
    match definition {
        McpDefinition::Stdio { command, args, env } => {
            if family == Family::OpenCode {
                let mut parts = vec![command.clone()];
                parts.extend(args.iter().cloned());
                push("command", string_list(&parts));
                if !env.is_empty() {
                    push("environment", string_map(env));
                }
            } else {
                push("command", Value::String(command.clone()));
                if !args.is_empty() {
                    push("args", string_list(args));
                }
                if !env.is_empty() {
                    push("env", string_map(env));
                }
            }
        }
        McpDefinition::Http { url, headers } | McpDefinition::Sse { url, headers } => {
            push("url", Value::String(url.clone()));
            if family == Family::Hermes && transport == McpTransport::Sse {
                push("transport", Value::String("sse".to_string()));
            }
            if !headers.is_empty() {
                let key = if family == Family::Codex {
                    "http_headers"
                } else {
                    "headers"
                };
                push(key, string_map(headers));
            }
        }
    }
    fields
}

/// Fields that belong to a stdio entry only, beyond the definition's own:
/// they go when the entry becomes a remote one. Listed where the agent is
/// known to refuse the entry — Codex throws on a stdio field next to a url —
/// or where earlier codeg releases already kept them off the other shape.
fn stdio_only_extras(app: McpAppType) -> &'static [&'static str] {
    match family(app) {
        Family::Codex => &["cwd", "env_vars"],
        Family::Cursor => &["envFile", "startupTimeoutSec"],
        Family::Kimi => &["runtime_id", "environment_id", "executor"],
        Family::OpenCode => &["cwd"],
        _ => &[],
    }
}

/// The remote counterpart of [`stdio_only_extras`].
fn remote_only_extras(app: McpAppType) -> &'static [&'static str] {
    match family(app) {
        Family::Codex => &["bearer_token_env_var", "env_http_headers"],
        Family::Cursor => &["auth", "tls", "placement"],
        Family::Kimi => &["auth", "bearerTokenEnvVar"],
        Family::Kiro => &["oauth", "oauthScopes"],
        Family::CommandCode | Family::OpenCode => &["oauth"],
        _ => &[],
    }
}

struct Patcher<'a> {
    existing: &'a Map<String, Value>,
    patch: Patch,
}

impl Patcher<'_> {
    fn has(&self, key: &str) -> bool {
        self.existing.contains_key(key)
    }

    fn set(&mut self, key: &str, value: Value) {
        if self.existing.get(key) != Some(&value) {
            self.patch.ops.push(FieldOp::Set(key.to_string(), value));
        }
    }

    fn text(&mut self, key: &str, value: &str) {
        self.set(key, Value::String(value.to_string()));
    }

    /// Bring `key` in line when the entry has it; leave it out otherwise.
    fn text_if_present(&mut self, key: &str, value: &str) {
        if self.has(key) {
            self.text(key, value);
        }
    }

    fn remove(&mut self, key: &str) {
        if self.has(key) {
            self.patch.ops.push(FieldOp::Remove(key.to_string()));
        }
    }

    fn drop_extra(&mut self, key: &str) {
        if self.has(key) {
            self.patch.ops.push(FieldOp::Remove(key.to_string()));
            self.patch.dropped.push(key.to_string());
        }
    }

    fn list(&mut self, key: &str, wanted: &[String]) {
        let mut ignored = Vec::new();
        let current = read_string_list(self.existing.get(key), key, "", &mut ignored);
        if current == wanted && (self.has(key) || wanted.is_empty()) {
            return;
        }
        if wanted.is_empty() {
            self.remove(key);
        } else {
            self.patch
                .ops
                .push(FieldOp::Set(key.to_string(), string_list(wanted)));
        }
    }

    fn map(&mut self, key: &str, wanted: &BTreeMap<String, String>) {
        let mut ignored = Vec::new();
        let current = read_string_map(self.existing.get(key), key, "", &mut ignored);
        if &current == wanted && (self.has(key) || wanted.is_empty()) {
            return;
        }
        if wanted.is_empty() {
            self.remove(key);
        } else {
            self.patch
                .ops
                .push(FieldOp::SyncMap(key.to_string(), wanted.clone()));
        }
    }
}

/// The changes that make the existing entry `existing` of `app` — whose
/// definition is `current`, when it has one — say `wanted` instead.
pub(crate) fn patch_for(
    app: McpAppType,
    existing: &Map<String, Value>,
    current: Option<&McpDefinition>,
    wanted: &McpDefinition,
) -> Patch {
    let family = family(app);
    let transport = wanted.transport();
    let was = current.map(McpDefinition::transport);
    let mut p = Patcher {
        existing,
        patch: Patch::default(),
    };
    // A Gemini-style entry that names its endpoint `httpUrl` keeps doing so.
    let keeps_http_url = family == Family::Gemini
        && transport == McpTransport::Http
        && non_blank(existing, "httpUrl").is_some()
        && !existing.contains_key("url");

    // 1. The discriminator.
    let word = type_word(app, transport);
    match family {
        Family::Generic | Family::Gemini => {
            if !keeps_http_url {
                let says_so = existing
                    .get("type")
                    .and_then(Value::as_str)
                    .and_then(normalize_type)
                    == Some(transport);
                // With no `type` the agent infers one, which holds for as
                // long as the transport does not change; SSE always has to be
                // said.
                let inferred =
                    !p.has("type") && was == Some(transport) && transport != McpTransport::Sse;
                if !says_so && !inferred {
                    p.text("type", word);
                }
            }
        }
        Family::Cline => {
            if transport.is_remote() {
                p.text("type", word);
                p.remove("transportType");
            } else {
                p.text_if_present("type", word);
            }
        }
        Family::Cursor => match transport {
            McpTransport::Sse => p.text("type", word),
            McpTransport::Http => {
                if existing.get("type").and_then(Value::as_str) != Some("http") {
                    p.remove("type");
                }
            }
            McpTransport::Stdio => p.text_if_present("type", word),
        },
        Family::Kiro => p.text_if_present("type", word),
        Family::Kimi => {
            if transport.is_remote() {
                p.text("transport", word);
            } else {
                p.text_if_present("transport", word);
            }
            // Kimi ignores `type`; keep a leftover one from saying otherwise.
            p.text_if_present("type", word);
        }
        Family::CommandCode => {
            p.text("transport", word);
            p.text_if_present("type", word);
        }
        Family::OpenCode => p.text("type", word),
        // Not a Codex key at all (and fatal under `--strict-config`).
        Family::Codex => p.remove("type"),
        Family::Grok => {
            if transport == McpTransport::Sse {
                p.text("type", word);
            } else if existing.get("type").and_then(Value::as_str) != Some(word) {
                p.remove("type");
            }
        }
        Family::Hermes => {
            p.remove("type");
            if transport == McpTransport::Sse {
                let says_sse = existing
                    .get("transport")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value.trim().eq_ignore_ascii_case("sse"));
                if !says_sse {
                    p.text("transport", "sse");
                }
            } else {
                p.remove("transport");
            }
        }
    }

    // 2. The definition's fields, and the other transport's out of the way.
    match wanted {
        McpDefinition::Stdio { command, args, env } => {
            if family == Family::OpenCode {
                let same = matches!(
                    current,
                    Some(McpDefinition::Stdio { command: c, args: a, .. }) if c == command && a == args
                );
                if !same {
                    let mut parts = vec![command.clone()];
                    parts.extend(args.iter().cloned());
                    p.set("command", string_list(&parts));
                }
                p.map("environment", env);
            } else {
                p.text("command", command);
                p.list("args", args);
                p.map("env", env);
            }
            p.remove("url");
            p.remove("headers");
            match family {
                Family::Gemini => p.remove("httpUrl"),
                Family::Codex => p.remove("http_headers"),
                _ => {}
            }
        }
        McpDefinition::Http { url, headers } | McpDefinition::Sse { url, headers } => {
            if keeps_http_url {
                p.text("httpUrl", url);
            } else {
                p.text("url", url);
                if family == Family::Gemini {
                    p.remove("httpUrl");
                }
            }
            if family == Family::Codex {
                p.map("http_headers", headers);
                p.remove("headers");
            } else {
                p.map("headers", headers);
            }
            p.remove("command");
            if family == Family::OpenCode {
                p.remove("environment");
            } else {
                p.remove("args");
                p.remove("env");
            }
        }
    }

    // 3. A change between stdio and remote takes the fields that only the
    //    old shape may carry.
    let was_remote = was.map(McpTransport::is_remote);
    if was_remote != Some(transport.is_remote()) {
        let gone = if transport.is_remote() {
            stdio_only_extras(app)
        } else {
            remote_only_extras(app)
        };
        for key in gone {
            p.drop_extra(key);
        }
    }
    p.patch
}

/// The change that turns an entry on or off with the flag it carries.
pub(crate) fn enable_ops(
    flag: EntryFlag,
    existing: &Map<String, Value>,
    enabled: bool,
) -> Vec<FieldOp> {
    let wanted = Value::Bool(if enabled { !flag.off } else { flag.off });
    match existing.get(flag.key) {
        Some(current) if *current == wanted => Vec::new(),
        // Absent means on: turning on an entry without the flag adds nothing.
        None if enabled => Vec::new(),
        _ => vec![FieldOp::Set(flag.key.to_string(), wanted)],
    }
}

/// Apply field changes to an entry held as a JSON object — what the YAML
/// editor works on, and what a replaced entry is built from.
pub(crate) fn apply_ops_to_map(entry: &mut Map<String, Value>, ops: &[FieldOp]) {
    for op in ops {
        match op {
            FieldOp::Set(key, value) => {
                entry.insert(key.clone(), value.clone());
            }
            FieldOp::SyncMap(key, wanted) => {
                match entry.get_mut(key).and_then(Value::as_object_mut) {
                    Some(current) => {
                        current.retain(|name, _| wanted.contains_key(name));
                        for (name, value) in wanted {
                            let value = Value::String(value.clone());
                            // A value that already reads as this text stays as
                            // it is written.
                            let reads_same = current.get(name).is_some_and(|existing| {
                                *existing == value
                                    || scalar_text(existing).as_deref() == value.as_str()
                            });
                            if !reads_same {
                                current.insert(name.clone(), value);
                            }
                        }
                    }
                    None => {
                        entry.insert(key.clone(), string_map(wanted));
                    }
                }
            }
            FieldOp::Remove(key) => {
                entry.remove(key);
            }
        }
    }
}

/// What `mcp_apply` refuses in a definition it is handed, as
/// `(code, field)`.
pub(crate) fn definition_problems(definition: &McpDefinition) -> Vec<(&'static str, &'static str)> {
    let mut out = Vec::new();
    match definition {
        McpDefinition::Stdio { command, env, .. } => {
            if command.trim().is_empty() {
                out.push((codes::COMMAND_REQUIRED, "command"));
            }
            if env.keys().any(|name| name.trim().is_empty()) {
                out.push((codes::ENV_NAME_REQUIRED, "env"));
            }
        }
        McpDefinition::Http { url, headers } | McpDefinition::Sse { url, headers } => {
            if url.trim().is_empty() {
                out.push((codes::URL_REQUIRED, "url"));
            }
            if headers.keys().any(|name| name.trim().is_empty()) {
                out.push((codes::HEADER_NAME_REQUIRED, "headers"));
            }
        }
    }
    out
}

/// A definition as it is written: the command and the url without the
/// whitespace around them.
pub(crate) fn tidy_definition(definition: &McpDefinition) -> McpDefinition {
    match definition {
        McpDefinition::Stdio { command, args, env } => McpDefinition::Stdio {
            command: command.trim().to_string(),
            args: args.clone(),
            env: env.clone(),
        },
        McpDefinition::Http { url, headers } => McpDefinition::Http {
            url: url.trim().to_string(),
            headers: headers.clone(),
        },
        McpDefinition::Sse { url, headers } => McpDefinition::Sse {
            url: url.trim().to_string(),
            headers: headers.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::mcp_engine::agents::spec;
    use serde_json::json;

    fn read(app: McpAppType, value: Value) -> ReadEntry {
        read_entry(app, &value, spec(app).disable.entry)
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

    fn codes_of(entry: &ReadEntry) -> Vec<&str> {
        entry
            .problems
            .iter()
            .map(|problem| problem.code.as_str())
            .collect()
    }

    /// Every agent reads back what codeg writes for it, for every transport
    /// it can hold — and nothing lands in `extra`.
    #[test]
    fn what_is_written_for_an_agent_reads_back_as_the_same_definition() {
        let definitions = [
            stdio("npx", &["-y", "server"], &[("TOKEN", "abc")]),
            stdio("server", &[], &[]),
            http("https://example.test/mcp", &[("Authorization", "Bearer x")]),
            http("https://example.test/mcp", &[]),
            sse("https://example.test/sse"),
        ];
        for app in crate::commands::mcp_engine::agents::all_apps() {
            let spec = spec(*app);
            for definition in &definitions {
                if !spec.supports(definition.transport()) {
                    continue;
                }
                let fields: Map<String, Value> =
                    fresh_fields(*app, definition).into_iter().collect();
                let back = read(*app, Value::Object(fields.clone()));
                assert_eq!(
                    back.definition.as_ref(),
                    Some(definition),
                    "{app:?}: {fields:?}"
                );
                assert!(back.extra.is_empty(), "{app:?}: {:?}", back.extra);
                assert!(back.enabled);
                assert!(back.problems.is_empty(), "{app:?}: {:?}", back.problems);
                // And saying the same thing again changes nothing.
                let patch = patch_for(*app, &fields, back.definition.as_ref(), definition);
                assert_eq!(patch, Patch::default(), "{app:?}: {fields:?}");
            }
        }
    }

    #[test]
    fn each_agent_gets_its_own_spelling() {
        let remote = http("https://example.test/mcp", &[("X-Key", "v")]);
        let fields = |app, definition: &McpDefinition| -> Value {
            Value::Object(fresh_fields(app, definition).into_iter().collect())
        };
        assert_eq!(
            fields(McpAppType::Codex, &remote),
            json!({"url": "https://example.test/mcp", "http_headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::Cline, &remote),
            json!({"type": "streamableHttp", "url": "https://example.test/mcp", "headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::KimiCode, &remote),
            json!({"transport": "http", "url": "https://example.test/mcp", "headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::KimiCode, &stdio("npx", &["x"], &[])),
            json!({"command": "npx", "args": ["x"]})
        );
        assert_eq!(
            fields(McpAppType::CommandCode, &stdio("npx", &[], &[])),
            json!({"transport": "stdio", "command": "npx"})
        );
        assert_eq!(
            fields(
                McpAppType::OpenCode,
                &stdio("npx", &["-y", "x"], &[("K", "v")])
            ),
            json!({"type": "local", "command": ["npx", "-y", "x"], "environment": {"K": "v"}})
        );
        assert_eq!(
            fields(McpAppType::OpenCode, &remote),
            json!({"type": "remote", "url": "https://example.test/mcp", "headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::Hermes, &sse("https://example.test/sse")),
            json!({"url": "https://example.test/sse", "transport": "sse"})
        );
        assert_eq!(
            fields(McpAppType::Grok, &sse("https://example.test/sse")),
            json!({"type": "sse", "url": "https://example.test/sse"})
        );
        assert_eq!(
            fields(McpAppType::Grok, &remote),
            json!({"url": "https://example.test/mcp", "headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::Cursor, &remote),
            json!({"url": "https://example.test/mcp", "headers": {"X-Key": "v"}})
        );
        assert_eq!(
            fields(McpAppType::ClaudeCode, &sse("https://example.test/sse")),
            json!({"type": "sse", "url": "https://example.test/sse"})
        );
    }

    #[test]
    fn an_entry_is_classified_the_way_its_agent_does() {
        // Cline: a bare url is SSE, and `http` is not one of its literals.
        let bare = read(McpAppType::Cline, json!({"url": "https://x.test"}));
        assert_eq!(bare.definition, Some(sse("https://x.test")));
        let legacy = read(
            McpAppType::Cline,
            json!({"url": "https://x.test", "transportType": "http"}),
        );
        assert_eq!(legacy.definition, Some(http("https://x.test", &[])));
        let refused = read(
            McpAppType::Cline,
            json!({"type": "http", "url": "https://x.test"}),
        );
        assert_eq!(refused.definition, Some(http("https://x.test", &[])));
        assert_eq!(codes_of(&refused), [codes::REJECTED_BY_AGENT]);

        // Gemini: `httpUrl` is streamable HTTP and wins.
        let gemini = read(
            McpAppType::Gemini,
            json!({"httpUrl": "https://x.test/mcp", "trust": true}),
        );
        assert_eq!(gemini.definition, Some(http("https://x.test/mcp", &[])));
        assert_eq!(Value::Object(gemini.extra), json!({"trust": true}));

        // Kimi: `transport` decides, `type` is ignored.
        let kimi = read(
            McpAppType::KimiCode,
            json!({"type": "sse", "url": "https://x.test", "transport": "http"}),
        );
        assert_eq!(kimi.definition, Some(http("https://x.test", &[])));
        let kimi_bad = read(
            McpAppType::KimiCode,
            json!({"url": "https://x.test", "transport": "streamable-http"}),
        );
        assert_eq!(kimi_bad.definition, None);
        assert_eq!(codes_of(&kimi_bad), [codes::UNSUPPORTED_TYPE]);

        // Codex: no type; both transports at once is refused.
        let codex = read(
            McpAppType::Codex,
            json!({"url": "https://x.test", "http_headers": {"A": "b"}, "bearer_token_env_var": "T"}),
        );
        assert_eq!(
            codex.definition,
            Some(http("https://x.test", &[("A", "b")]))
        );
        assert_eq!(
            Value::Object(codex.extra),
            json!({"bearer_token_env_var": "T"})
        );
        let both = read(
            McpAppType::Codex,
            json!({"command": "x", "url": "https://x.test"}),
        );
        assert_eq!(codes_of(&both), [codes::COMMAND_AND_URL]);

        // Hermes: `transport: sse`.
        let hermes = read(
            McpAppType::Hermes,
            json!({"url": "https://x.test", "transport": "SSE"}),
        );
        assert_eq!(hermes.definition, Some(sse("https://x.test")));

        // OpenCode: one command array, `environment`.
        let opencode = read(
            McpAppType::OpenCode,
            json!({"type": "local", "command": ["npx", "-y", "x"], "environment": {"K": "v"}, "timeout": 5}),
        );
        assert_eq!(
            opencode.definition,
            Some(stdio("npx", &["-y", "x"], &[("K", "v")]))
        );
        assert_eq!(Value::Object(opencode.extra), json!({"timeout": 5}));
        let opencode_bad = read(
            McpAppType::OpenCode,
            json!({"type": "local", "command": "npx"}),
        );
        assert_eq!(codes_of(&opencode_bad), [codes::INVALID_COMMAND]);

        // Command Code: no SSE, and no other word for http.
        let cc = read(
            McpAppType::CommandCode,
            json!({"transport": "sse", "url": "https://x.test"}),
        );
        assert_eq!(codes_of(&cc), [codes::UNSUPPORTED_TYPE]);

        // Kiro: a registry reference is not a server.
        let kiro = read(McpAppType::Kiro, json!({"type": "registry", "name": "x"}));
        assert_eq!(kiro.definition, None);
        assert_eq!(codes_of(&kiro), [codes::UNSUPPORTED_TYPE]);

        // Anything: not an object, or neither a command nor a url.
        assert_eq!(
            codes_of(&read(McpAppType::ClaudeCode, json!("npx server"))),
            [codes::ENTRY_NOT_AN_OBJECT]
        );
        assert_eq!(
            codes_of(&read(McpAppType::ClaudeCode, json!({"args": ["x"]}))),
            [codes::MISSING_COMMAND_OR_URL]
        );
        assert_eq!(
            codes_of(&read(McpAppType::ClaudeCode, json!({"command": "  "}))),
            [codes::INVALID_COMMAND]
        );
    }

    #[test]
    fn values_that_are_not_strings_are_shown_and_remarked_on() {
        let entry = read(
            McpAppType::ClaudeCode,
            json!({"command": "x", "args": ["a", 1, true, null], "env": {"A": "b", "N": 2, "O": {}}}),
        );
        assert_eq!(
            entry.definition,
            Some(stdio("x", &["a", "1", "true"], &[("A", "b"), ("N", "2")]))
        );
        assert_eq!(codes_of(&entry), [codes::INVALID_ARGS, codes::INVALID_ENV]);
    }

    #[test]
    fn the_on_off_flag_is_each_agents_own() {
        let on = |app, value: Value| read(app, value).enabled;
        assert!(!on(
            McpAppType::Cline,
            json!({"command": "x", "disabled": true})
        ));
        assert!(on(
            McpAppType::Cline,
            json!({"command": "x", "disabled": false})
        ));
        assert!(!on(
            McpAppType::Codex,
            json!({"command": "x", "enabled": false})
        ));
        assert!(on(McpAppType::Codex, json!({"command": "x"})));
        assert!(!on(
            McpAppType::Hermes,
            json!({"command": "x", "enabled": "off"})
        ));
        assert!(on(
            McpAppType::Hermes,
            json!({"command": "x", "enabled": "maybe"})
        ));
        // Not this agent's flag: it is one of the entry's other fields.
        let claude = read(
            McpAppType::ClaudeCode,
            json!({"command": "x", "disabled": true}),
        );
        assert!(claude.enabled);
        assert_eq!(Value::Object(claude.extra), json!({"disabled": true}));
        // The flag itself is never listed among the other fields.
        let cline = read(
            McpAppType::Cline,
            json!({"command": "x", "disabled": true, "autoApprove": ["a"]}),
        );
        assert_eq!(Value::Object(cline.extra), json!({"autoApprove": ["a"]}));
        let odd = read(McpAppType::Kiro, json!({"command": "x", "disabled": "yes"}));
        assert!(odd.enabled);
        assert_eq!(codes_of(&odd), [codes::INVALID_ENABLED_FLAG]);

        let flag = spec(McpAppType::Cline).disable.entry.unwrap();
        let entry = json!({"command": "x"});
        let entry = entry.as_object().unwrap();
        assert_eq!(enable_ops(flag, entry, true), []);
        assert_eq!(
            enable_ops(flag, entry, false),
            [FieldOp::Set("disabled".into(), json!(true))]
        );
        let flag = spec(McpAppType::Codex).disable.entry.unwrap();
        let off = json!({"command": "x", "enabled": false});
        assert_eq!(
            enable_ops(flag, off.as_object().unwrap(), true),
            [FieldOp::Set("enabled".into(), json!(true))]
        );
        assert_eq!(enable_ops(flag, off.as_object().unwrap(), false), []);
    }

    fn patched(app: McpAppType, existing: Value, wanted: &McpDefinition) -> (Value, Patch) {
        let mut entry = existing.as_object().unwrap().clone();
        let current = read(app, existing.clone()).definition;
        let patch = patch_for(app, &entry, current.as_ref(), wanted);
        apply_ops_to_map(&mut entry, &patch.ops);
        (Value::Object(entry), patch)
    }

    #[test]
    fn a_patch_touches_only_what_the_definition_changes() {
        // Only the url changes: nothing else is even mentioned.
        let existing = json!({
            "type": "sse", "url": "https://old.test/sse",
            "headers": {"Authorization": "Bearer t"}, "timeout": 30
        });
        let wanted = McpDefinition::Sse {
            url: "https://new.test/sse".into(),
            headers: BTreeMap::from([("Authorization".to_string(), "Bearer t".to_string())]),
        };
        let (_, patch) = patched(McpAppType::ClaudeCode, existing, &wanted);
        assert_eq!(
            patch.ops,
            [FieldOp::Set("url".into(), json!("https://new.test/sse"))]
        );

        // An entry with no `type` that stays what it was gets none.
        let (after, _) = patched(
            McpAppType::Gemini,
            json!({"command": "old", "trust": true}),
            &stdio("new", &["a"], &[]),
        );
        assert_eq!(
            after,
            json!({"command": "new", "trust": true, "args": ["a"]})
        );

        // `httpUrl` stays the spelling of an entry that uses it.
        let (after, _) = patched(
            McpAppType::Gemini,
            json!({"httpUrl": "https://old.test", "trust": true}),
            &http("https://new.test", &[]),
        );
        assert_eq!(after, json!({"httpUrl": "https://new.test", "trust": true}));

        // A value codeg would write as text is left as the user wrote it.
        let (after, patch) = patched(
            McpAppType::ClaudeCode,
            json!({"command": "x", "env": {"PORT": 8080, "A": "b"}}),
            &stdio("x", &[], &[("PORT", "8080"), ("A", "b")]),
        );
        assert_eq!(patch, Patch::default());
        assert_eq!(
            after,
            json!({"command": "x", "env": {"PORT": 8080, "A": "b"}})
        );
    }

    #[test]
    fn a_change_of_transport_takes_the_other_transports_fields() {
        // Codex throws on a stdio field next to a url.
        let (after, patch) = patched(
            McpAppType::Codex,
            json!({
                "command": "npx", "args": ["x"], "env": {"A": "b"}, "cwd": "/w",
                "startup_timeout_sec": 20, "enabled": false
            }),
            &http("https://x.test/mcp", &[("K", "v")]),
        );
        assert_eq!(
            after,
            json!({
                "startup_timeout_sec": 20, "enabled": false,
                "url": "https://x.test/mcp", "http_headers": {"K": "v"}
            })
        );
        assert_eq!(patch.dropped, ["cwd"]);

        // Claude: stdio to SSE says so in `type`.
        let (after, patch) = patched(
            McpAppType::ClaudeCode,
            json!({"command": "npx", "args": ["x"]}),
            &sse("https://x.test/sse"),
        );
        assert_eq!(after, json!({"type": "sse", "url": "https://x.test/sse"}));
        assert!(patch.dropped.is_empty());

        // Kimi: the discriminator follows, and the stdio-only field goes.
        let (after, patch) = patched(
            McpAppType::KimiCode,
            json!({"command": "npx", "environment_id": "e1", "deferred": true}),
            &http("https://x.test/mcp", &[]),
        );
        assert_eq!(
            after,
            json!({"deferred": true, "transport": "http", "url": "https://x.test/mcp"})
        );
        assert_eq!(patch.dropped, ["environment_id"]);

        // Hermes: SSE back to HTTP drops the `transport` that said SSE.
        let (after, _) = patched(
            McpAppType::Hermes,
            json!({"url": "https://x.test/sse", "transport": "sse", "client_cert": "/c"}),
            &http("https://x.test/mcp", &[]),
        );
        assert_eq!(
            after,
            json!({"url": "https://x.test/mcp", "client_cert": "/c"})
        );

        // A legacy `type` in a Codex entry goes the first time it is saved.
        let (after, _) = patched(
            McpAppType::Codex,
            json!({"type": "stdio", "command": "a"}),
            &stdio("b", &[], &[]),
        );
        assert_eq!(after, json!({"command": "b"}));
    }

    #[test]
    fn a_definition_handed_in_is_checked() {
        assert_eq!(
            definition_problems(&stdio("  ", &[], &[("", "x")])),
            [
                (codes::COMMAND_REQUIRED, "command"),
                (codes::ENV_NAME_REQUIRED, "env")
            ]
        );
        assert_eq!(
            definition_problems(&http("", &[(" ", "x")])),
            [
                (codes::URL_REQUIRED, "url"),
                (codes::HEADER_NAME_REQUIRED, "headers")
            ]
        );
        assert!(definition_problems(&stdio("npx", &[], &[])).is_empty());
        assert_eq!(
            tidy_definition(&stdio(" npx ", &[" a "], &[])),
            stdio("npx", &[" a "], &[])
        );
    }

    #[test]
    fn transport_names_are_normalized() {
        for alias in [
            "http",
            "streamable-http",
            "streamableHttp",
            "Streamable_HTTP",
        ] {
            assert_eq!(normalize_type(alias), Some(McpTransport::Http), "{alias}");
        }
        assert_eq!(normalize_type(" stdio "), Some(McpTransport::Stdio));
        assert_eq!(normalize_type("SSE"), Some(McpTransport::Sse));
        assert_eq!(normalize_type("local"), None);
        assert_eq!(normalize_type(""), None);
    }
}
