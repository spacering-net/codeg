//! Official remaining-subscription reads.
//!
//! Codex publishes remaining plan quota through the documented app-server
//! JSON-RPC method `account/rateLimits/read`. This module talks to that
//! method over `codex app-server --stdio` and returns the official `result`
//! object. It never invents a remaining number.
//!
//! Claude has no `usage` CLI. The `/usage` HUD reads
//! `GET https://api.anthropic.com/api/oauth/usage` with the local Claude
//! Code OAuth token (`~/.claude/.credentials.json`).
//!
//! Grok has no usage CLI. Remaining credits come from
//! `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with
//! the Grok CLI OAuth token in `~/.grok/auth.json`.
//!
//! Cursor has no usage CLI. `status` / `about` are identity only. Remaining
//! plan usage is the same DashboardService RPC the official CLI/IDE client
//! already ships: `GetCurrentPeriodUsage` on `api2.cursor.sh`, authenticated
//! with the cursor-agent login token (`%APPDATA%\Cursor\auth.json` or
//! `CURSOR_API_KEY`).
//!
//! OpenCode Go remaining is official
//! `GET https://opencode.ai/zen/go/v1/usage` (anomalyco/opencode#16513,
//! live 2026-08-11) with the Go API key from `auth.json`. Gemini still
//! has no remaining-quota command. OpenCode `stats` is session history.

use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

use crate::app_error::{AppCommandError, AppErrorCode};

const READ_DEADLINE: Duration = Duration::from_secs(12);
const INIT_ID: u64 = 1;
const LIMITS_ID: u64 = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialQuotaSlot {
    pub label: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficialQuotaRead {
    pub family: &'static str,
    /// Official JSON from the CLI, or `null` when that CLI did not publish
    /// a remaining-quota payload. Missing CLI is not an error.
    pub payload: Option<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_slots: Vec<OfficialQuotaSlot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
}

pub fn extract_rate_limits_result(messages: &[Value]) -> Option<Value> {
    for message in messages {
        let Some(obj) = message.as_object() else {
            continue;
        };
        if obj.get("id").and_then(Value::as_u64) != Some(LIMITS_ID) {
            continue;
        }
        if obj.contains_key("error") {
            return None;
        }
        if let Some(result) = obj.get("result") {
            if result.get("rateLimits").is_some() {
                return Some(result.clone());
            }
        }
    }
    None
}

fn initialize_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": INIT_ID,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "codeg",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {}
        }
    })
}

fn rate_limits_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": LIMITS_ID,
        "method": "account/rateLimits/read",
        "params": {}
    })
}

async fn read_codex_rate_limits_from_child() -> Result<Option<Value>, AppCommandError> {
    read_codex_rate_limits_from_home(None).await
}

async fn read_codex_rate_limits_from_home(
    home: Option<&Path>,
) -> Result<Option<Value>, AppCommandError> {
    let mut cmd = crate::process::tokio_command("codex");
    cmd.args(["app-server", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(home) = home {
        cmd.env("CODEX_HOME", home);
    }
    let mut child = cmd.spawn()
        .map_err(|err| {
            AppCommandError::new(
                AppErrorCode::DependencyMissing,
                "Codex CLI is not available",
            )
            .with_detail(err.to_string())
        })?;

    let mut stdin = child.stdin.take().ok_or_else(|| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Codex stdin missing")
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Codex stdout missing")
    })?;

    let write = async {
        for request in [initialize_request(), rate_limits_request()] {
            let mut line = serde_json::to_vec(&request).map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "encode RPC")
                    .with_detail(err.to_string())
            })?;
            line.push(b'\n');
            stdin.write_all(&line).await.map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "write RPC")
                    .with_detail(err.to_string())
            })?;
        }
        stdin.flush().await.map_err(|err| {
            AppCommandError::new(AppErrorCode::ExternalCommandFailed, "flush RPC")
                .with_detail(err.to_string())
        })?;
        Ok::<(), AppCommandError>(())
    };

    let collect = async {
        let mut reader = BufReader::new(stdout);
        let mut messages = Vec::new();
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader.read_line(&mut line).await.map_err(|err| {
                AppCommandError::new(AppErrorCode::ExternalCommandFailed, "read RPC")
                    .with_detail(err.to_string())
            })?;
            if n == 0 {
                break;
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
                let got_limits = value.get("id").and_then(Value::as_u64) == Some(LIMITS_ID);
                messages.push(value);
                if got_limits {
                    break;
                }
            }
        }
        Ok::<Vec<Value>, AppCommandError>(messages)
    };

    let result = timeout(READ_DEADLINE, async {
        write.await?;
        collect.await
    })
    .await;

    let _ = child.kill().await;

    match result {
        Ok(Ok(messages)) => Ok(extract_rate_limits_result(&messages)),
        Ok(Err(err)) => Err(err),
        Err(_) => Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            "Codex app-server timed out",
        )),
    }
}

pub async fn read_codex_subscription_quota_core() -> OfficialQuotaRead {
    let mut extra_slots = Vec::new();
    for (label, home) in extra_homes_for_family("codex") {
        if let Ok(Some(payload)) = read_codex_rate_limits_from_home(Some(&home)).await {
            extra_slots.push(OfficialQuotaSlot { label, payload });
        }
    }
    match read_codex_rate_limits_from_child().await {
        Ok(Some(payload)) => OfficialQuotaRead {
            family: "codex",
            payload: Some(payload),
            extra_slots,
            unavailable_reason: None,
        },
        Ok(None) => OfficialQuotaRead {
            family: "codex",
            payload: None,
            extra_slots,
            unavailable_reason: Some("codex app-server did not return rateLimits".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "codex",
            payload: None,
            extra_slots,
            unavailable_reason: Some(err.message),
        },
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_codex() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_codex_subscription_quota_core().await)
}

pub fn claude_oauth_access_token_from_credentials(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

fn claude_credentials_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

fn read_claude_oauth_access_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    claude_oauth_access_token_from_credentials(&text)
}

async fn fetch_claude_oauth_usage(token: &str) -> Result<Value, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "HTTP client")
                .with_detail(err.to_string())
        })?;
    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "Claude usage request failed")
                .with_detail(err.to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            format!("Claude usage HTTP {status}"),
        ));
    }
    response.json::<Value>().await.map_err(|err| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Claude usage JSON")
            .with_detail(err.to_string())
    })
}

pub async fn read_claude_subscription_quota_core() -> OfficialQuotaRead {
    let extra_slots = extra_claude_slots().await;
    let Some(path) = claude_credentials_path() else {
        return OfficialQuotaRead {
            family: "claude",
            payload: None,
            extra_slots,
            unavailable_reason: Some("home directory unavailable".into()),
        };
    };
    let Some(token) = read_claude_oauth_access_token(&path) else {
        return OfficialQuotaRead {
            family: "claude",
            payload: None,
            extra_slots,
            unavailable_reason: Some("Claude Code is not signed in".into()),
        };
    };
    match fetch_claude_oauth_usage(&token).await {
        Ok(payload) if payload.get("five_hour").is_some() || payload.get("seven_day").is_some() => {
            OfficialQuotaRead {
                family: "claude",
                payload: Some(payload),
                extra_slots,
                unavailable_reason: None,
            }
        }
        Ok(_) => OfficialQuotaRead {
            family: "claude",
            payload: None,
            extra_slots,
            unavailable_reason: Some("Claude usage payload missing five_hour/seven_day".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "claude",
            payload: None,
            extra_slots,
            unavailable_reason: Some(err.message),
        },
    }
}

async fn extra_claude_slots() -> Vec<OfficialQuotaSlot> {
    let mut slots = Vec::new();
    for (label, home) in extra_homes_for_family("claude") {
        let path = home.join(".credentials.json");
        let Some(token) = read_claude_oauth_access_token(&path) else {
            continue;
        };
        if let Ok(payload) = fetch_claude_oauth_usage(&token).await {
            if payload.get("five_hour").is_some() || payload.get("seven_day").is_some() {
                slots.push(OfficialQuotaSlot { label, payload });
            }
        }
    }
    slots
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_claude() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_claude_subscription_quota_core().await)
}

pub fn grok_cli_bearer_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    let mut preferred = None;
    let mut fallback = None;
    for (key, entry) in obj {
        let Some(token) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if token.is_empty() {
            continue;
        }
        if key.starts_with("https://auth.x.ai") {
            preferred = Some(token.to_string());
        } else if fallback.is_none() {
            fallback = Some(token.to_string());
        }
    }
    preferred.or(fallback)
}

fn grok_auth_path() -> Option<std::path::PathBuf> {
    dirs::home_dir().map(|home| home.join(".grok").join("auth.json"))
}

fn read_grok_cli_bearer(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    grok_cli_bearer_from_auth_json(&text)
}

async fn fetch_grok_billing(token: &str) -> Result<Value, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "HTTP client")
                .with_detail(err.to_string())
        })?;
    let response = client
        .get("https://cli-chat-proxy.grok.com/v1/billing?format=credits")
        .header("Authorization", format!("Bearer {token}"))
        .header("x-xai-token-auth", "xai-grok-cli")
        .header("Accept", "application/json")
        .header("User-Agent", "codeg")
        .send()
        .await
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "Grok billing request failed")
                .with_detail(err.to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            format!("Grok billing HTTP {status}"),
        ));
    }
    response.json::<Value>().await.map_err(|err| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Grok billing JSON")
            .with_detail(err.to_string())
    })
}

pub async fn read_grok_subscription_quota_core() -> OfficialQuotaRead {
    let extra_slots = extra_grok_slots().await;
    let Some(path) = grok_auth_path() else {
        return OfficialQuotaRead {
            family: "grok",
            payload: None,
            extra_slots,
            unavailable_reason: Some("home directory unavailable".into()),
        };
    };
    let Some(token) = read_grok_cli_bearer(&path) else {
        return OfficialQuotaRead {
            family: "grok",
            payload: None,
            extra_slots,
            unavailable_reason: Some("Grok CLI is not signed in".into()),
        };
    };
    match fetch_grok_billing(&token).await {
        Ok(payload) if payload.get("config").and_then(|c| c.get("creditUsagePercent")).is_some() => {
            OfficialQuotaRead {
                family: "grok",
                payload: Some(payload),
                extra_slots,
                unavailable_reason: None,
            }
        }
        Ok(_) => OfficialQuotaRead {
            family: "grok",
            payload: None,
            extra_slots,
            unavailable_reason: Some("Grok billing payload missing creditUsagePercent".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "grok",
            payload: None,
            extra_slots,
            unavailable_reason: Some(err.message),
        },
    }
}

async fn extra_grok_slots() -> Vec<OfficialQuotaSlot> {
    let mut slots = Vec::new();
    for (label, home) in extra_homes_for_family("grok") {
        let path = home.join("auth.json");
        let Some(token) = read_grok_cli_bearer(&path) else {
            continue;
        };
        if let Ok(payload) = fetch_grok_billing(&token).await {
            if payload
                .get("config")
                .and_then(|c| c.get("creditUsagePercent"))
                .is_some()
            {
                slots.push(OfficialQuotaSlot { label, payload });
            }
        }
    }
    slots
}

pub fn extra_homes_for_family(family: &str) -> Vec<(String, std::path::PathBuf)> {
    extra_homes_in(
        dirs::home_dir().map(|home| home.join(".codeg-profiles")),
        family,
    )
}

pub fn extra_homes_in(
    root: Option<std::path::PathBuf>,
    family: &str,
) -> Vec<(String, std::path::PathBuf)> {
    let prefix = match family {
        "claude" => "claude-",
        "codex" => "codex-",
        "grok" => "grok-",
        "cursor" => "cursor-",
        "opencode" => "opencode-",
        _ => return Vec::new(),
    };
    let Some(root) = root else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut homes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(prefix) {
            continue;
        }
        homes.push((name, path));
    }
    homes.sort_by(|a, b| a.0.cmp(&b.0));
    homes
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_grok() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_grok_subscription_quota_core().await)
}

pub fn cursor_access_token_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("accessToken")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("apiKey")
                .and_then(Value::as_str)
                .filter(|token| !token.is_empty())
                .map(str::to_string)
        })
}

fn cursor_auth_path() -> Option<std::path::PathBuf> {
    if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join("AppData").join("Roaming")))
            .map(|appdata| appdata.join("Cursor").join("auth.json"))
    } else if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join(".cursor").join("auth.json"))
    } else {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::home_dir().map(|home| home.join(".config")));
        xdg.map(|root| root.join("cursor").join("auth.json"))
    }
}

fn read_cursor_access_token(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    cursor_access_token_from_auth_json(&text)
}

fn cursor_token_from_env_or_file() -> Option<String> {
    if let Ok(key) = std::env::var("CURSOR_API_KEY") {
        let trimmed = key.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    let path = cursor_auth_path()?;
    read_cursor_access_token(&path)
}

fn cursor_payload_has_plan_usage(payload: &Value) -> bool {
    payload
        .get("planUsage")
        .or_else(|| payload.get("plan_usage"))
        .map(|plan| {
            plan.get("remaining").is_some()
                || plan.get("limit").is_some()
                || plan.get("totalPercentUsed").is_some()
                || plan.get("total_percent_used").is_some()
        })
        .unwrap_or(false)
}

async fn fetch_cursor_period_usage(token: &str) -> Result<Value, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "HTTP client")
                .with_detail(err.to_string())
        })?;
    let response = client
        .post("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Connect-Protocol-Version", "1")
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("User-Agent", "codeg")
        .json(&json!({}))
        .send()
        .await
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "Cursor usage request failed")
                .with_detail(err.to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            format!("Cursor usage HTTP {status}"),
        ));
    }
    response.json::<Value>().await.map_err(|err| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "Cursor usage JSON")
            .with_detail(err.to_string())
    })
}

pub async fn read_cursor_subscription_quota_core() -> OfficialQuotaRead {
    let extra_slots = extra_cursor_slots().await;
    let Some(token) = cursor_token_from_env_or_file() else {
        return OfficialQuotaRead {
            family: "cursor",
            payload: None,
            extra_slots,
            unavailable_reason: Some("Cursor CLI is not signed in".into()),
        };
    };
    match fetch_cursor_period_usage(&token).await {
        Ok(payload) if cursor_payload_has_plan_usage(&payload) => OfficialQuotaRead {
            family: "cursor",
            payload: Some(payload),
            extra_slots,
            unavailable_reason: None,
        },
        Ok(_) => OfficialQuotaRead {
            family: "cursor",
            payload: None,
            extra_slots,
            unavailable_reason: Some(
                "Cursor usage payload missing planUsage remaining".into(),
            ),
        },
        Err(err) => OfficialQuotaRead {
            family: "cursor",
            payload: None,
            extra_slots,
            unavailable_reason: Some(err.message),
        },
    }
}

async fn extra_cursor_slots() -> Vec<OfficialQuotaSlot> {
    let mut slots = Vec::new();
    for (label, home) in extra_homes_for_family("cursor") {
        let path = home.join("auth.json");
        let Some(token) = read_cursor_access_token(&path) else {
            continue;
        };
        if let Ok(payload) = fetch_cursor_period_usage(&token).await {
            if cursor_payload_has_plan_usage(&payload) {
                slots.push(OfficialQuotaSlot { label, payload });
            }
        }
    }
    slots
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_cursor() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_cursor_subscription_quota_core().await)
}

pub fn opencode_go_key_from_auth_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    let obj = value.as_object()?;
    // `opencode-go` wins when present, but a plain `opencode` entry is the
    // common single-account shape, so a missing provider skips to the next one
    // instead of ending the search.
    for provider in ["opencode-go", "opencode"] {
        let Some(entry) = obj.get(provider).and_then(Value::as_object) else {
            continue;
        };
        let Some(key) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        if !key.is_empty() {
            return Some(key.to_string());
        }
    }
    None
}

fn opencode_auth_path() -> Option<std::path::PathBuf> {
    Some(crate::parsers::opencode::resolve_opencode_base_dir().join("auth.json"))
}

fn read_opencode_go_key(path: &Path) -> Option<String> {
    let text = fs::read_to_string(path).ok()?;
    opencode_go_key_from_auth_json(&text)
}

fn opencode_go_key_from_env_or_file() -> Option<String> {
    for name in ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"] {
        if let Ok(key) = std::env::var(name) {
            let trimmed = key.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    let path = opencode_auth_path()?;
    read_opencode_go_key(&path)
}

fn opencode_payload_has_usage(payload: &Value) -> bool {
    let usage = payload.get("usage").unwrap_or(payload);
    ["rolling", "weekly", "monthly"].iter().any(|window| {
        usage
            .get(*window)
            .and_then(|w| w.get("percent").or_else(|| w.get("usagePercent")))
            .is_some()
    })
}

async fn fetch_opencode_go_usage(token: &str) -> Result<Value, AppCommandError> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "HTTP client")
                .with_detail(err.to_string())
        })?;
    let response = client
        .get("https://opencode.ai/zen/go/v1/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .header("User-Agent", "codeg")
        .send()
        .await
        .map_err(|err| {
            AppCommandError::new(AppErrorCode::NetworkError, "OpenCode usage request failed")
                .with_detail(err.to_string())
        })?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppCommandError::new(
            AppErrorCode::ExternalCommandFailed,
            format!("OpenCode usage HTTP {status}"),
        ));
    }
    response.json::<Value>().await.map_err(|err| {
        AppCommandError::new(AppErrorCode::ExternalCommandFailed, "OpenCode usage JSON")
            .with_detail(err.to_string())
    })
}

pub async fn read_opencode_subscription_quota_core() -> OfficialQuotaRead {
    let extra_slots = extra_opencode_slots().await;
    let Some(token) = opencode_go_key_from_env_or_file() else {
        return OfficialQuotaRead {
            family: "opencode",
            payload: None,
            extra_slots,
            unavailable_reason: Some("OpenCode Go is not signed in".into()),
        };
    };
    match fetch_opencode_go_usage(&token).await {
        Ok(payload) if opencode_payload_has_usage(&payload) => OfficialQuotaRead {
            family: "opencode",
            payload: Some(payload),
            extra_slots,
            unavailable_reason: None,
        },
        Ok(_) => OfficialQuotaRead {
            family: "opencode",
            payload: None,
            extra_slots,
            unavailable_reason: Some("OpenCode usage payload missing windows".into()),
        },
        Err(err) => OfficialQuotaRead {
            family: "opencode",
            payload: None,
            extra_slots,
            unavailable_reason: Some(err.message),
        },
    }
}

async fn extra_opencode_slots() -> Vec<OfficialQuotaSlot> {
    let mut slots = Vec::new();
    for (label, home) in extra_homes_for_family("opencode") {
        let path = home.join("auth.json");
        let Some(token) = read_opencode_go_key(&path) else {
            continue;
        };
        if let Ok(payload) = fetch_opencode_go_usage(&token).await {
            if opencode_payload_has_usage(&payload) {
                slots.push(OfficialQuotaSlot { label, payload });
            }
        }
    }
    slots
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn subscription_quota_opencode() -> Result<OfficialQuotaRead, AppCommandError> {
    Ok(read_opencode_subscription_quota_core().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_live_account_rate_limits_read_shape() {
        let messages = vec![
            json!({"id": 1, "result": {"userAgent": "Codex Desktop"}}),
            json!({
                "id": 2,
                "result": {
                    "rateLimits": {
                        "limitId": "codex",
                        "primary": {
                            "usedPercent": 100,
                            "windowDurationMins": 10080,
                            "resetsAt": 1787196797
                        },
                        "secondary": null,
                        "credits": {
                            "hasCredits": false,
                            "unlimited": false,
                            "balance": "0"
                        },
                        "planType": "pro",
                        "rateLimitReachedType": "rate_limit_reached"
                    },
                    "rateLimitsByLimitId": {
                        "codex": {
                            "limitId": "codex",
                            "primary": { "usedPercent": 100 }
                        },
                        "codex_spark": {
                            "limitId": "codex_spark",
                            "limitName": "GPT-5.3-Codex-Spark",
                            "primary": { "usedPercent": 0 }
                        }
                    }
                }
            }),
        ];
        let result = extract_rate_limits_result(&messages).expect("result");
        assert_eq!(
            result["rateLimits"]["primary"]["usedPercent"],
            json!(100)
        );
        assert_eq!(
            result["rateLimitsByLimitId"]["codex_spark"]["primary"]["usedPercent"],
            json!(0)
        );
    }

    #[test]
    fn ignores_rpc_error_and_missing_id() {
        let messages = vec![
            json!({"id": 2, "error": {"message": "unauthorized"}}),
            json!({"method": "remoteControl/status/changed", "params": {}}),
        ];
        assert!(extract_rate_limits_result(&messages).is_none());
    }

    #[test]
    fn reads_claude_oauth_access_token_without_logging_it() {
        let text = r#"{
            "claudeAiOauth": { "accessToken": "tok_test_value", "subscriptionType": "max" }
        }"#;
        assert_eq!(
            claude_oauth_access_token_from_credentials(text).as_deref(),
            Some("tok_test_value")
        );
        assert!(claude_oauth_access_token_from_credentials("{}").is_none());
    }

    #[test]
    fn prefers_auth_xai_grok_cli_bearer() {
        let text = r#"{
            "https://accounts.x.ai/sign-in": { "key": "legacy" },
            "https://auth.x.ai::abc": { "key": "oidc-token", "auth_mode": "oidc" }
        }"#;
        assert_eq!(
            grok_cli_bearer_from_auth_json(text).as_deref(),
            Some("oidc-token")
        );
        assert!(grok_cli_bearer_from_auth_json("{}").is_none());
    }

    #[test]
    fn extra_homes_are_isolated_profile_dirs() {
        let root = std::env::temp_dir().join(format!(
            "codeg-quota-homes-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("claude-2")).unwrap();
        fs::create_dir_all(root.join("claude-3")).unwrap();
        fs::create_dir_all(root.join("codex-2")).unwrap();
        fs::create_dir_all(root.join("cursor-2")).unwrap();
        fs::create_dir_all(root.join("opencode-2")).unwrap();
        fs::write(root.join("claude-ignore"), "").unwrap();
        let claude = extra_homes_in(Some(root.clone()), "claude");
        let names: Vec<_> = claude.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["claude-2", "claude-3"]);
        let codex = extra_homes_in(Some(root.clone()), "codex");
        assert_eq!(codex.len(), 1);
        assert_eq!(codex[0].0, "codex-2");
        let cursor = extra_homes_in(Some(root.clone()), "cursor");
        assert_eq!(cursor.len(), 1);
        assert_eq!(cursor[0].0, "cursor-2");
        let opencode = extra_homes_in(Some(root.clone()), "opencode");
        assert_eq!(opencode.len(), 1);
        assert_eq!(opencode[0].0, "opencode-2");
        assert!(extra_homes_in(Some(root.clone()), "grok").is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_cursor_access_token_without_logging_it() {
        let text = r#"{
            "accessToken": "tok_cursor_value",
            "refreshToken": "ref_cursor_value",
            "apiKey": null
        }"#;
        assert_eq!(
            cursor_access_token_from_auth_json(text).as_deref(),
            Some("tok_cursor_value")
        );
        assert_eq!(
            cursor_access_token_from_auth_json(r#"{"apiKey":"key_only"}"#).as_deref(),
            Some("key_only")
        );
        assert!(cursor_access_token_from_auth_json("{}").is_none());
    }

    #[test]
    fn reads_opencode_go_key_without_logging_it() {
        let text = r#"{
            "opencode": { "type": "api", "key": "zen-key" },
            "opencode-go": { "type": "api", "key": "go-key" }
        }"#;
        assert_eq!(
            opencode_go_key_from_auth_json(text).as_deref(),
            Some("go-key")
        );
        assert_eq!(
            opencode_go_key_from_auth_json(r#"{"opencode":{"type":"api","key":"zen-only"}}"#)
                .as_deref(),
            Some("zen-only")
        );
        assert!(opencode_go_key_from_auth_json("{}").is_none());
    }
}
