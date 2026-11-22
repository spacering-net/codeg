//! A private `codearts serve` instance for one CodeArts ACP bridge process.
//!
//! CodeArts (码道) ships OpenCode 1's HTTP server but refuses to start its ACP
//! server (`codearts acp` → "The 'acp' command is not supported."). Its local
//! TUI server, `codearts serve`, is fully usable: this module spawns one per
//! bridge, bound to a random loopback port with a random basic-auth pair only
//! the bridge knows, waits until it answers, and exposes a small REST client
//! plus a parsed `/global/event` SSE stream. Prompts go through `prompt_async`
//! so the HTTP request is never held open for the whole turn — that is what
//! removes the old 15-minute ceiling and lets tool/thought progress stream.

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use reqwest::Client;
use serde_json::Value;
use tokio::sync::mpsc;

use crate::acp::codearts_models::CODEARTS_CLI_ENV;

const READY_TIMEOUT: Duration = Duration::from_secs(90);
const READY_INTERVAL: Duration = Duration::from_millis(400);
const API_TIMEOUT: Duration = Duration::from_secs(30);

/// Where the installed vendor executable lives (the `.cmd` launcher's sibling).
fn find_codearts_exe() -> Option<PathBuf> {
    let configured = std::env::var(CODEARTS_CLI_ENV).ok().map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = configured {
        candidates.push(path);
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            candidates.push(dir.join("codearts.cmd"));
            candidates.push(dir.join("codearts.exe"));
            candidates.push(dir.join("codearts"));
        }
    }
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        candidates.push(
            PathBuf::from(home)
                .join(".codeartsdoer")
                .join("installers")
                .join("bin")
                .join("codearts.exe"),
        );
    }
    for candidate in candidates {
        let lower = candidate.to_string_lossy().to_ascii_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let sibling = candidate
                .parent()
                .map(|p| p.join("bin").join("codearts.exe"))
                .unwrap_or(candidate.clone());
            if sibling.is_file() {
                return Some(sibling);
            }
        }
        if candidate.is_file()
            && !lower.ends_with(".cmd")
            && !lower.ends_with(".bat")
            && !lower.ends_with(".ps1")
        {
            return Some(candidate);
        }
    }
    None
}

/// A free loopback port: bind to 0, read the assigned port, release the socket.
fn free_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    listener.local_addr().map(|addr| addr.port())
}

fn random_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}{:x}", nanos, std::process::id())
}

/// Replicate the launcher environment `codearts.cmd` sets before invoking its
/// executable. Keeping it here means we can spawn the real executable directly
/// (a batch shim cannot be `Command`-spawned on Windows, and killing the shim
/// would leave the server running). Deliberately omits
/// `NODE_TLS_REJECT_UNAUTHORIZED=0`, which the shim also sets and which would
/// disable certificate verification for everything the CLI fetches.
fn launcher_env() -> std::collections::BTreeMap<String, String> {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".to_string());
    let config = format!("{home}/.codeartsdoer");
    let mut env = std::collections::BTreeMap::new();
    env.insert("package_tag".into(), "undefined".into());
    env.insert("CODEAGENT_USE_MESSAGE_FEEDBACK".into(), "false".into());
    env.insert("OMO_SEND_ANONYMOUS_TELEMETRY".into(), "0".into());
    env.insert("SCENARIO".into(), "codeartsdoer".into());
    env.insert("KERNEL_DATA_DIR".into(), format!("{config}/cli-data"));
    env.insert(
        "KERNEL_STATE_DIR".into(),
        std::env::var("KERNEL_STATE_DIR").unwrap_or_else(|_| format!("{config}/state")),
    );
    env.insert("KERNEL_CONFIG_DIR".into(), config.clone());
    env.insert("OPENCODE_CHANNEL".into(), "latest".into());
    env.insert("OPENCODE_CONFIG".into(), format!("{config}/codearts_cli.json"));
    env.insert(
        "OPENCODE_CONFIG_FILE".into(),
        "codearts_cli.json,codearts_cli.jsonc".into(),
    );
    env.insert("OPENCODE_MODE".into(), "tui".into());
    env.insert("PLUGIN_ENV".into(), "hc".into());
    env.insert("OPENCODE_DISABLE_MODELS_FETCH".into(), "1".into());
    env.insert("OPENCODE_DISABLE_AUTOUPDATE".into(), "true".into());
    env.insert("OPENCODE_ALWAYS_NOTIFY_UPDATE".into(), "false".into());
    env.insert("CODEARTS_DISABLE_AUTO_UPDATE".into(), "true".into());
    env
}

/// A running `codearts serve` and the HTTP client that talks to it.
pub struct CodeArtsServe {
    child: tokio::process::Child,
    client: Client,
    base: String,
    username: String,
    password: String,
    cwd: String,
}

impl CodeArtsServe {
    /// Spawn a fresh server in `cwd`, or return a readable error if the CLI is
    /// missing or never becomes ready (e.g. no AK/SK was provided).
    pub async fn start(
        cwd: &str,
        ak: &str,
        sk: &str,
    ) -> Result<Self, String> {
        let executable = find_codearts_exe().ok_or_else(|| {
            "CodeArts CLI not found; install it or check Agent Settings.".to_string()
        })?;
        let port = free_port().map_err(|e| format!("No local port for CodeArts: {e}"))?;
        let username = format!("codeg-{}", random_token());
        let password = random_token();
        let base = format!("http://127.0.0.1:{port}");

        let mut cmd = tokio::process::Command::new(&executable);
        cmd.current_dir(cwd)
            .args(["serve", "--port", &port.to_string(), "--hostname", "127.0.0.1"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        for (key, value) in launcher_env() {
            cmd.env(key, value);
        }
        cmd.env("CODEARTS_CLI_AK", ak)
            .env("CODEARTS_CLI_SK", sk)
            .env("OPENCODE_SERVER_USERNAME", &username)
            .env("OPENCODE_SERVER_PASSWORD", &password);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.as_std_mut().creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = cmd
            .spawn()
            .map_err(|e| format!("Could not start codearts serve: {e}"))?;

        let client = Client::builder()
            .timeout(API_TIMEOUT)
            .build()
            .map_err(|e| format!("HTTP client: {e}"))?;
        let mut serve = Self {
            child,
            client,
            base,
            username,
            password,
            cwd: cwd.to_string(),
        };

        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            if let Ok(response) = serve.client
                .get(format!("{}/config/providers", serve.base))
                .basic_auth(&serve.username, Some(&serve.password))
                .send()
                .await
            {
                if response.status().is_success() {
                    return Ok(serve);
                }
            }
            if Instant::now() >= deadline {
                let _ = serve.child.kill().await;
                return Err(
                    "codearts serve did not become ready. Check the AK/SK in Agent Settings."
                        .to_string(),
                );
            }
            tokio::time::sleep(READY_INTERVAL).await;
        }
    }

    fn url(&self, path: &str) -> String {
        // OpenCode scopes each request to a directory via this query parameter.
        format!(
            "{}{}{}directory={}",
            self.base,
            path,
            if path.contains('?') { "&" } else { "?" },
            urlencode(&self.cwd)
        )
    }

    /// One REST call. `prompt_async` answers 204 immediately; the turn's result
    /// arrives on the event stream and a later `/message` read.
    pub async fn api(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .request(method, self.url(path))
            .basic_auth(&self.username, Some(&self.password));
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await.map_err(|e| format!("CodeArts API: {e}"))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|e| format!("CodeArts API response: {e}"))?;
        if !status.is_success() {
            return Err(format!("CodeArts API {} {path}: {}", status.as_u16(), truncate(&text, 300)));
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| format!("CodeArts API JSON {path}: {e}"))
    }

    /// Subscribe to `/global/event` and forward each SSE `data:` frame as JSON.
    /// The task ends when the server or the bridge goes away.
    pub fn events(&self, out: mpsc::UnboundedSender<Value>) {
        let client = self.client.clone();
        let url = self.url("/global/event");
        let username = self.username.clone();
        let password = self.password.clone();
        tokio::spawn(async move {
            let response = match client
                .get(&url)
                .basic_auth(&username, Some(&password))
                .send()
                .await
            {
                Ok(r) => r,
                Err(err) => {
                    tracing::warn!("[CodeArts] event stream failed: {err}");
                    return;
                }
            };
            let mut stream = response.bytes_stream();
            let mut buffer = String::new();
            while let Some(chunk) = stream.next().await {
                let Ok(chunk) = chunk else { break };
                buffer.push_str(&String::from_utf8_lossy(&chunk));
                while let Some(index) = buffer.find("\n\n") {
                    let frame: String = buffer.drain(..index + 2).collect();
                    for line in frame.lines() {
                        let Some(data) = line.strip_prefix("data:") else { continue };
                        let data = data.trim();
                        if data.is_empty() {
                            continue;
                        }
                        match serde_json::from_str::<Value>(data) {
                            Ok(value) => {
                                if out.send(value).is_err() {
                                    return;
                                }
                            }
                            Err(err) => tracing::warn!("[CodeArts] bad SSE frame: {err}"),
                        }
                    }
                }
                // A runaway buffer with no frame separator is not an event stream.
                if buffer.len() > 1024 * 1024 {
                    buffer.clear();
                }
            }
        });
    }

    pub async fn shutdown(&mut self) {
        let _ = self.child.kill().await;
    }

    pub async fn alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }
}

fn truncate(text: &str, max: usize) -> &str {
    if text.len() <= max {
        text
    } else {
        &text[..max]
    }
}

/// Minimal percent-encoding for the `directory` query parameter.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' | b':'
            | b'\\' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urlencode_keeps_paths_readable_and_escapes_spaces() {
        assert_eq!(urlencode("D:/my work/proj"), "D:/my%20work/proj");
        assert_eq!(urlencode("C:\\Users\\me"), "C:\\Users\\me");
    }

    #[test]
    fn token_is_nonempty_hex() {
        let token = random_token();
        assert!(!token.is_empty());
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }
}
