//! `mcp_parse_snippet`: make servers out of what people paste.
//!
//! READMEs hand out MCP configuration in a handful of shapes, and this reads
//! the common ones: `{"mcpServers": {…}}` (and its relatives — VS Code's
//! `servers`, OpenCode's `mcp`), one server's object on its own, and Codex's
//! `[mcp_servers.<name>]` tables. Reading is deliberately loose — any agent's
//! spelling of a transport, a command given as one array, `httpUrl`,
//! `http_headers` — because the text could be meant for any of them. Nothing
//! is written: the page shows what was recognised, the user confirms each
//! server, and `mcp_apply` does the writing.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::acp::opencode_config;

use super::dialect::{normalize_type, read_string_list, read_string_map};
use super::model::{
    codes, is_valid_new_key, McpDefinition, McpIssue, McpSnippet, McpSnippetFormat,
    McpSnippetServer, McpTransport, RESERVED_KEY,
};

const URL_KEYS: [&str; 3] = ["url", "httpUrl", "serverUrl"];
const DISCRIMINATORS: [&str; 3] = ["type", "transport", "transportType"];
const HEADER_KEYS: [&str; 2] = ["headers", "http_headers"];
const ENV_KEYS: [&str; 2] = ["env", "environment"];

fn non_blank<'a>(obj: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    obj.get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

/// Whether an object reads as one server rather than a map of them.
fn looks_like_server(value: &Value) -> bool {
    value.as_object().is_some_and(|obj| {
        obj.contains_key("command") || URL_KEYS.iter().any(|key| obj.contains_key(*key))
    })
}

/// One pasted entry, whichever agent it was written for.
fn read_loose(key: Option<&str>, value: &Value) -> McpSnippetServer {
    let mut problems = Vec::new();
    if let Some(key) = key {
        if key == RESERVED_KEY {
            problems.push(McpIssue::new(codes::KEY_RESERVED).field("key"));
        } else if !is_valid_new_key(key) {
            problems.push(McpIssue::new(codes::KEY_INVALID).field("key"));
        }
    }
    let server = |definition, extra, problems| McpSnippetServer {
        key: key.map(str::to_string),
        definition,
        extra,
        problems,
    };
    let Some(obj) = value.as_object() else {
        problems.push(McpIssue::new(codes::ENTRY_NOT_AN_OBJECT));
        return server(None, Map::new(), problems);
    };

    let declared = DISCRIMINATORS
        .iter()
        .find_map(|key| non_blank(obj, key).map(|raw| (*key, raw.trim())));
    let url_key = URL_KEYS.iter().find(|key| non_blank(obj, key).is_some());
    let transport = match declared {
        // OpenCode's words.
        Some((_, "local")) => Some(McpTransport::Stdio),
        Some((_, "remote")) => Some(McpTransport::Http),
        Some((field, raw)) => {
            let transport = normalize_type(raw);
            if transport.is_none() {
                problems.push(
                    McpIssue::new(codes::UNSUPPORTED_TYPE)
                        .field(field)
                        .detail(raw.to_string()),
                );
            }
            transport
        }
        None if obj.contains_key("command") => Some(McpTransport::Stdio),
        None if url_key.is_some() => Some(McpTransport::Http),
        None => {
            problems.push(McpIssue::new(codes::MISSING_COMMAND_OR_URL));
            None
        }
    };

    let mut used: Vec<&str> = DISCRIMINATORS.to_vec();
    let definition = transport.and_then(|transport| match transport {
        McpTransport::Stdio => {
            used.extend(["command", "args"]);
            // A string, or one array of the executable and its arguments.
            let (command, mut args) = match obj.get("command") {
                Some(Value::String(command)) if !command.trim().is_empty() => {
                    (Some(command.trim().to_string()), Vec::new())
                }
                Some(Value::Array(parts))
                    if !parts.is_empty() && parts.iter().all(Value::is_string) =>
                {
                    let mut parts = parts.iter().filter_map(Value::as_str).map(str::to_string);
                    (parts.next(), parts.collect())
                }
                _ => (None, Vec::new()),
            };
            let Some(command) = command.filter(|command| !command.trim().is_empty()) else {
                problems.push(McpIssue::new(codes::INVALID_COMMAND).field("command"));
                return None;
            };
            args.extend(read_string_list(
                obj.get("args"),
                "args",
                codes::INVALID_ARGS,
                &mut problems,
            ));
            let env_key = ENV_KEYS
                .iter()
                .find(|key| obj.contains_key(**key))
                .copied()
                .unwrap_or("env");
            used.extend(ENV_KEYS);
            let env = read_string_map(obj.get(env_key), env_key, codes::INVALID_ENV, &mut problems);
            Some(McpDefinition::Stdio { command, args, env })
        }
        McpTransport::Http | McpTransport::Sse => {
            used.extend(URL_KEYS);
            used.extend(HEADER_KEYS);
            let Some(url_key) = url_key else {
                problems.push(McpIssue::new(codes::INVALID_URL).field("url"));
                return None;
            };
            let url = non_blank(obj, url_key)?.trim().to_string();
            let headers_key = HEADER_KEYS
                .iter()
                .find(|key| obj.contains_key(**key))
                .copied()
                .unwrap_or("headers");
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
    let extra = obj
        .iter()
        .filter(|(key, _)| !used.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    server(definition, extra, problems)
}

fn servers_of(map: &Map<String, Value>) -> Vec<McpSnippetServer> {
    map.iter()
        .map(|(key, value)| read_loose(Some(key), value))
        .collect()
}

fn recognised(format: McpSnippetFormat, servers: Vec<McpSnippetServer>) -> McpSnippet {
    McpSnippet {
        format,
        servers,
        problems: Vec::new(),
    }
}

/// The map of servers a JSON document holds, under any of the keys agents
/// and editors use for it.
fn json_container(root: &Map<String, Value>) -> Option<&Map<String, Value>> {
    for key in ["mcpServers", "mcp_servers", "servers"] {
        if let Some(Value::Object(servers)) = root.get(key) {
            return Some(servers);
        }
    }
    let mcp = root.get("mcp")?.as_object()?;
    match mcp.get("servers") {
        Some(Value::Object(servers)) if !looks_like_server(&Value::Object(servers.clone())) => {
            Some(servers)
        }
        // OpenCode 1.x: the servers are `mcp`'s own keys.
        _ => mcp.values().any(looks_like_server).then_some(mcp),
    }
}

fn from_json(root: &Map<String, Value>) -> Option<McpSnippet> {
    if let Some(servers) = json_container(root) {
        return Some(recognised(
            McpSnippetFormat::JsonServers,
            servers_of(servers),
        ));
    }
    let whole = Value::Object(root.clone());
    if looks_like_server(&whole) {
        return Some(recognised(
            McpSnippetFormat::JsonServer,
            vec![read_loose(None, &whole)],
        ));
    }
    // `{"name": {…}, "other": {…}}` with no wrapper at all.
    if !root.is_empty() && root.values().all(looks_like_server) {
        return Some(recognised(McpSnippetFormat::JsonServers, servers_of(root)));
    }
    None
}

fn toml_to_json(value: &toml::Value) -> Value {
    match value {
        toml::Value::String(text) => Value::String(text.clone()),
        toml::Value::Integer(number) => Value::Number((*number).into()),
        toml::Value::Float(number) => serde_json::Number::from_f64(*number)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        toml::Value::Boolean(flag) => Value::Bool(*flag),
        toml::Value::Datetime(when) => Value::String(when.to_string()),
        toml::Value::Array(items) => Value::Array(items.iter().map(toml_to_json).collect()),
        toml::Value::Table(table) => Value::Object(
            table
                .iter()
                .map(|(key, value)| (key.clone(), toml_to_json(value)))
                .collect(),
        ),
    }
}

fn from_toml(root: &toml::Table) -> Option<McpSnippet> {
    let Value::Object(root) = toml_to_json(&toml::Value::Table(root.clone())) else {
        return None;
    };
    if let Some(Value::Object(servers)) = root.get("mcp_servers") {
        return Some(recognised(
            McpSnippetFormat::TomlServers,
            servers_of(servers),
        ));
    }
    let whole = Value::Object(root.clone());
    if looks_like_server(&whole) {
        return Some(recognised(
            McpSnippetFormat::TomlServer,
            vec![read_loose(None, &whole)],
        ));
    }
    if !root.is_empty() && root.values().all(looks_like_server) {
        return Some(recognised(McpSnippetFormat::TomlServers, servers_of(&root)));
    }
    None
}

/// Read pasted text. See the module docs.
pub(crate) fn parse_snippet(text: &str) -> McpSnippet {
    let text = text.strip_prefix('\u{feff}').unwrap_or(text).trim();
    let unknown = |code: &str, detail: Option<String>| McpSnippet {
        format: McpSnippetFormat::Unknown,
        servers: Vec::new(),
        problems: vec![McpIssue {
            code: code.to_string(),
            field: None,
            detail,
        }],
    };
    if text.is_empty() {
        return unknown(codes::SNIPPET_EMPTY, None);
    }
    let mut errors: BTreeMap<&str, String> = BTreeMap::new();

    // JSON, comments and trailing commas allowed — as pasted, or a fragment
    // of an object (`"mcpServers": {…}`, `"name": {…},`) with the braces put
    // back around it.
    let fragment = format!("{{{}}}", text.trim_end_matches(','));
    let candidates: [&str; 2] = [text, &fragment];
    let json_like = text.starts_with('{') || text.starts_with('"');
    for candidate in candidates.iter().filter(|_| json_like) {
        match opencode_config::parse(candidate) {
            Ok(Value::Object(root)) => {
                if let Some(snippet) = from_json(&root) {
                    return snippet;
                }
            }
            Ok(_) => {}
            Err(error) => {
                errors.entry("json").or_insert(error);
            }
        }
    }

    match text.parse::<toml::Table>() {
        Ok(root) => {
            if let Some(snippet) = from_toml(&root) {
                return snippet;
            }
        }
        Err(error) => {
            errors.insert("toml", error.to_string());
        }
    }

    let detail = if json_like {
        errors.remove("json")
    } else {
        errors.remove("toml")
    };
    unknown(codes::SNIPPET_UNRECOGNIZED, detail)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    fn keys(snippet: &McpSnippet) -> Vec<Option<&str>> {
        snippet
            .servers
            .iter()
            .map(|server| server.key.as_deref())
            .collect()
    }

    #[test]
    fn an_mcp_servers_document_gives_every_server_in_it() {
        let snippet = parse_snippet(
            r#"{
  // from a README
  "mcpServers": {
    "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] },
    "linear": { "type": "sse", "url": "https://mcp.linear.app/sse" },
    "github": {
      "type": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": { "Authorization": "Bearer ${TOKEN}" },
      "autoApprove": ["list_issues"],
    },
  }
}"#,
        );
        assert_eq!(snippet.format, McpSnippetFormat::JsonServers);
        assert_eq!(
            keys(&snippet),
            [Some("playwright"), Some("linear"), Some("github")]
        );
        assert_eq!(
            snippet.servers[0].definition,
            Some(stdio("npx", &["-y", "@playwright/mcp@latest"], &[]))
        );
        assert_eq!(
            snippet.servers[1].definition,
            Some(McpDefinition::Sse {
                url: "https://mcp.linear.app/sse".into(),
                headers: BTreeMap::new()
            })
        );
        assert_eq!(
            snippet.servers[2].definition,
            Some(http(
                "https://api.githubcopilot.com/mcp/",
                &[("Authorization", "Bearer ${TOKEN}")]
            ))
        );
        assert_eq!(
            Value::Object(snippet.servers[2].extra.clone()),
            json!({"autoApprove": ["list_issues"]})
        );
        assert!(snippet
            .servers
            .iter()
            .all(|server| server.problems.is_empty()));
    }

    #[test]
    fn other_wrappers_and_fragments_are_recognised() {
        // VS Code.
        let vscode = parse_snippet(r#"{"servers": {"a": {"type": "stdio", "command": "a"}}}"#);
        assert_eq!(keys(&vscode), [Some("a")]);
        // OpenCode 2 and 1.x.
        let opencode = parse_snippet(
            r#"{"mcp": {"servers": {"a": {"type": "local", "command": ["npx", "-y", "a"], "environment": {"K": "v"}}}}}"#,
        );
        assert_eq!(
            opencode.servers[0].definition,
            Some(stdio("npx", &["-y", "a"], &[("K", "v")]))
        );
        let opencode_1 =
            parse_snippet(r#"{"mcp": {"a": {"type": "remote", "url": "https://a.test"}}}"#);
        assert_eq!(
            opencode_1.servers[0].definition,
            Some(http("https://a.test", &[]))
        );
        // A fragment, the way READMEs print it.
        let fragment = parse_snippet(r#""mcpServers": { "a": { "command": "a" } }"#);
        assert_eq!(fragment.format, McpSnippetFormat::JsonServers);
        assert_eq!(keys(&fragment), [Some("a")]);
        let entry = parse_snippet(r#""a": { "command": "a" },"#);
        assert_eq!(keys(&entry), [Some("a")]);
        // A bare map of servers.
        let bare = parse_snippet(r#"{"a": {"command": "a"}, "b": {"url": "https://b.test"}}"#);
        assert_eq!(keys(&bare), [Some("a"), Some("b")]);
    }

    #[test]
    fn one_servers_object_has_no_name() {
        let snippet = parse_snippet(
            r#"{ "command": "uvx", "args": ["mcp-server-git"], "env": {"GIT_DIR": "/r"}, "cwd": "/w" }"#,
        );
        assert_eq!(snippet.format, McpSnippetFormat::JsonServer);
        assert_eq!(keys(&snippet), [None]);
        assert_eq!(
            snippet.servers[0].definition,
            Some(stdio("uvx", &["mcp-server-git"], &[("GIT_DIR", "/r")]))
        );
        assert_eq!(
            Value::Object(snippet.servers[0].extra.clone()),
            json!({"cwd": "/w"})
        );
        // Gemini's and Windsurf's names for the endpoint.
        for key in ["httpUrl", "serverUrl"] {
            let remote = parse_snippet(&format!(r#"{{"{key}": "https://x.test/mcp"}}"#));
            assert_eq!(
                remote.servers[0].definition,
                Some(http("https://x.test/mcp", &[])),
                "{key}"
            );
        }
    }

    #[test]
    fn codex_tables_are_recognised() {
        let snippet = parse_snippet(
            r#"
[mcp_servers.context7]
command = "npx"
args = ["-y", "@upstash/context7-mcp"]
startup_timeout_sec = 20

[mcp_servers.context7.env]
KEY = "value"

[mcp_servers.figma]
url = "https://mcp.figma.com/mcp"
bearer_token_env_var = "FIGMA_TOKEN"
http_headers = { "X-Region" = "us" }
"#,
        );
        assert_eq!(snippet.format, McpSnippetFormat::TomlServers);
        assert_eq!(keys(&snippet), [Some("context7"), Some("figma")]);
        assert_eq!(
            snippet.servers[0].definition,
            Some(stdio(
                "npx",
                &["-y", "@upstash/context7-mcp"],
                &[("KEY", "value")]
            ))
        );
        assert_eq!(
            Value::Object(snippet.servers[0].extra.clone()),
            json!({"startup_timeout_sec": 20})
        );
        assert_eq!(
            snippet.servers[1].definition,
            Some(http("https://mcp.figma.com/mcp", &[("X-Region", "us")]))
        );

        let single = parse_snippet("command = \"npx\"\nargs = [\"-y\", \"x\"]\n");
        assert_eq!(single.format, McpSnippetFormat::TomlServer);
        assert_eq!(keys(&single), [None]);
        assert_eq!(
            single.servers[0].definition,
            Some(stdio("npx", &["-y", "x"], &[]))
        );
    }

    #[test]
    fn what_cannot_be_used_is_said_not_dropped() {
        let snippet = parse_snippet(
            r#"{"mcpServers": {
                "codeg-mcp": {"command": "x"},
                "bad name": {"command": "x"},
                "odd": {"type": "websocket", "url": "wss://x.test"},
                "empty": {},
                "text": "npx x"
            }}"#,
        );
        let problems: Vec<Vec<&str>> = snippet
            .servers
            .iter()
            .map(|server| server.problems.iter().map(|p| p.code.as_str()).collect())
            .collect();
        assert_eq!(
            problems,
            [
                vec![codes::KEY_RESERVED],
                vec![codes::KEY_INVALID],
                vec![codes::UNSUPPORTED_TYPE],
                vec![codes::MISSING_COMMAND_OR_URL],
                vec![codes::ENTRY_NOT_AN_OBJECT],
            ]
        );
        assert!(snippet.servers[0].definition.is_some());
        assert!(snippet.servers[2].definition.is_none());
    }

    #[test]
    fn text_that_is_no_configuration_is_unknown() {
        let empty = parse_snippet("  \n");
        assert_eq!(empty.format, McpSnippetFormat::Unknown);
        assert_eq!(empty.problems[0].code, codes::SNIPPET_EMPTY);

        for text in [
            "npx -y @playwright/mcp",
            "{\"mcpServers\": ",
            "{\"name\": \"x\", \"version\": 1}",
            "[package]\nname = \"x\"\n",
        ] {
            let snippet = parse_snippet(text);
            assert_eq!(snippet.format, McpSnippetFormat::Unknown, "{text}");
            assert!(snippet.servers.is_empty(), "{text}");
            assert_eq!(
                snippet.problems[0].code,
                codes::SNIPPET_UNRECOGNIZED,
                "{text}"
            );
        }
    }
}
