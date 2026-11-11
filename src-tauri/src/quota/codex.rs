//! Codex quota parsing and probe helper module.
//!
//! Primary path (Zero Network / Zero Risk):
//! Codex CLI writes a `token_count` event into its local session rollout JSONL
//! (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-*.jsonl`) after every turn, which
//! carries `payload.rate_limits` (`primary`, `secondary`, `plan_type`,
//! `individual_limit`, etc.) directly from the model response headers.
//!
//! Fallback path (On-Demand Official Wham Endpoint):
//! Used only when no local rollout with `rate_limits` exists yet.

use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use walkdir::WalkDir;

use crate::models::{AgentQuotaInfo, QuotaWindow, SpendLimit};
use crate::parsers::AgentEnv;

/// Helper to parse a quota window with percentage and reset time.
pub fn parse_codex_window(
    label: impl Into<String>,
    used_percent: f64,
    resets_at: Option<DateTime<Utc>>,
    now: Option<DateTime<Utc>>,
) -> QuotaWindow {
    let used_clamped = used_percent.clamp(0.0, 100.0);
    let remaining = (100.0 - used_clamped).max(0.0);
    let reset_in_seconds = resets_at.map(|reset_time| {
        let current = now.unwrap_or_else(Utc::now);
        (reset_time - current).num_seconds().max(0)
    });

    QuotaWindow::new(
        label,
        used_clamped,
        remaining,
        resets_at,
        reset_in_seconds,
    )
}

/// Helper to parse a quota window from raw usage and limit counters.
pub fn parse_codex_usage_window(
    label: impl Into<String>,
    used: f64,
    limit: f64,
    resets_at: Option<DateTime<Utc>>,
    now: Option<DateTime<Utc>>,
) -> QuotaWindow {
    QuotaWindow::from_usage(label, used, limit, resets_at, now)
}

#[derive(Debug, Deserialize)]
struct RawWindowPayload {
    #[serde(default)]
    label: Option<String>,
    #[serde(default)]
    used: Option<f64>,
    #[serde(default)]
    limit: Option<f64>,
    #[serde(default)]
    used_percent: Option<f64>,
    #[serde(default)]
    resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
struct RawSpendPayload {
    used_usd: f64,
    limit_usd: f64,
}

#[derive(Debug, Deserialize)]
struct RawCodexQuotaPayload {
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    short_window: Option<RawWindowPayload>,
    #[serde(default)]
    weekly_window: Option<RawWindowPayload>,
    #[serde(default)]
    spend_limit: Option<RawSpendPayload>,
}

/// Parse a raw JSON payload from Codex CLI or API into `AgentQuotaInfo`.
pub fn parse_codex_quota_json(
    raw_json: &str,
    now: Option<DateTime<Utc>>,
) -> Result<AgentQuotaInfo, String> {
    let payload: RawCodexQuotaPayload = serde_json::from_str(raw_json)
        .map_err(|e| format!("failed to parse codex quota JSON: {e}"))?;

    let short_window = payload.short_window.map(|w| {
        let label = w.label.unwrap_or_else(|| "5-Hour Window".to_string());
        if let (Some(used), Some(limit)) = (w.used, w.limit) {
            parse_codex_usage_window(label, used, limit, w.resets_at, now)
        } else {
            let used_pct = w.used_percent.unwrap_or(0.0);
            parse_codex_window(label, used_pct, w.resets_at, now)
        }
    });

    let weekly_window = payload.weekly_window.map(|w| {
        let label = w.label.unwrap_or_else(|| "Weekly Limit".to_string());
        if let (Some(used), Some(limit)) = (w.used, w.limit) {
            parse_codex_usage_window(label, used, limit, w.resets_at, now)
        } else {
            let used_pct = w.used_percent.unwrap_or(0.0);
            parse_codex_window(label, used_pct, w.resets_at, now)
        }
    });

    let spend_limit = payload
        .spend_limit
        .map(|s| SpendLimit::new(s.used_usd, s.limit_usd));

    let last_updated = now.unwrap_or_else(Utc::now);

    Ok(AgentQuotaInfo {
        agent_type: "codex".to_string(),
        plan_name: payload.plan,
        short_window,
        weekly_window,
        spend_limit,
        last_updated,
    })
}

// ---------------------------------------------------------------------------
// Zero-Network Rollout JSONL `token_count.rate_limits` Reader
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct RolloutRateLimitWindow {
    used_percent: Option<f64>,
    #[allow(dead_code)]
    window_minutes: Option<i64>,
    resets_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct RolloutRateLimits {
    primary: Option<RolloutRateLimitWindow>,
    secondary: Option<RolloutRateLimitWindow>,
    plan_type: Option<String>,
}

fn format_plan_label(raw_plan: &str) -> String {
    let trimmed = raw_plan.trim();
    let mut chars = trimmed.chars();
    match chars.next() {
        None => String::new(),
        Some(f) => f.to_uppercase().collect::<String>() + chars.as_str() + " Plan",
    }
}

/// Parse a `rate_limits` JSON value from a Codex rollout `token_count` event.
pub fn parse_codex_rollout_rate_limits(
    rate_limits_val: &serde_json::Value,
    event_ts: Option<DateTime<Utc>>,
    now: Option<DateTime<Utc>>,
) -> Option<AgentQuotaInfo> {
    let rl: RolloutRateLimits = serde_json::from_value(rate_limits_val.clone()).ok()?;
    if rl.primary.is_none() && rl.secondary.is_none() && rl.plan_type.is_none() {
        return None;
    }

    let current_now = now.unwrap_or_else(Utc::now);

    let short_window = rl.primary.map(|pw| {
        let used_pct = pw.used_percent.unwrap_or(0.0);
        let resets_at = pw.resets_at.and_then(|ts| Utc.timestamp_opt(ts, 0).single());
        parse_codex_window("5-Hour Window", used_pct, resets_at, Some(current_now))
    });

    let weekly_window = rl.secondary.map(|sw| {
        let used_pct = sw.used_percent.unwrap_or(0.0);
        let resets_at = sw.resets_at.and_then(|ts| Utc.timestamp_opt(ts, 0).single());
        parse_codex_window("Weekly Limit", used_pct, resets_at, Some(current_now))
    });

    let plan_name = rl
        .plan_type
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(format_plan_label);

    Some(AgentQuotaInfo {
        agent_type: "codex".to_string(),
        plan_name,
        short_window,
        weekly_window,
        spend_limit: None,
        last_updated: event_ts.unwrap_or(current_now),
    })
}

/// Extract the latest `token_count.rate_limits` from a single rollout JSONL file.
/// Reads from the tail chunk first (last 256 KB) for speed on multi-megabyte rollouts.
pub fn read_latest_rate_limits_from_rollout_file(
    path: &Path,
    now: Option<DateTime<Utc>>,
) -> Option<AgentQuotaInfo> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    const TAIL_BYTES: u64 = 256 * 1024;

    let lines: Vec<String> = if len > TAIL_BYTES {
        file.seek(SeekFrom::Start(len - TAIL_BYTES)).ok()?;
        let mut reader = BufReader::new(file);
        let mut discard = String::new();
        let _ = reader.read_line(&mut discard);
        reader.lines().map_while(Result::ok).collect()
    } else {
        BufReader::new(file).lines().map_while(Result::ok).collect()
    };

    for line in lines.iter().rev() {
        if !line.contains("\"rate_limits\"") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if val.get("type").and_then(|v| v.as_str()) != Some("event_msg") {
            continue;
        }
        let Some(payload) = val.get("payload") else {
            continue;
        };
        if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
            continue;
        }
        let Some(rate_limits) = payload.get("rate_limits") else {
            continue;
        };
        if rate_limits.is_null() {
            continue;
        }
        let event_ts = val
            .get("timestamp")
            .and_then(|v| v.as_str())
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.with_timezone(&Utc));
        if let Some(info) = parse_codex_rollout_rate_limits(rate_limits, event_ts, now) {
            return Some(info);
        }
    }

    if len > TAIL_BYTES {
        let mut full_file = File::open(path).ok()?;
        let mut text = String::new();
        full_file.read_to_string(&mut text).ok()?;
        for line in text.lines().rev() {
            if !line.contains("\"rate_limits\"") {
                continue;
            }
            let Ok(val) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(payload) = val.get("payload") else {
                continue;
            };
            if payload.get("type").and_then(|v| v.as_str()) != Some("token_count") {
                continue;
            }
            let Some(rate_limits) = payload.get("rate_limits") else {
                continue;
            };
            if rate_limits.is_null() {
                continue;
            }
            let event_ts = val
                .get("timestamp")
                .and_then(|v| v.as_str())
                .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&Utc));
            if let Some(info) = parse_codex_rollout_rate_limits(rate_limits, event_ts, now) {
                return Some(info);
            }
        }
    }

    None
}

/// Scans the most recently modified rollout files under `<codex_home>/sessions`
/// to extract the newest `rate_limits` snapshot with zero network I/O.
pub fn read_latest_codex_quota_from_sessions_dir(
    sessions_dir: &Path,
    now: Option<DateTime<Utc>>,
) -> Option<AgentQuotaInfo> {
    if !sessions_dir.exists() {
        return None;
    }

    let mut rollout_files: Vec<(std::time::SystemTime, PathBuf)> = WalkDir::new(sessions_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            let path = entry.path();
            path.extension().and_then(|e| e.to_str()) == Some("jsonl")
                && path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .starts_with("rollout-")
        })
        .filter_map(|entry| {
            let mtime = entry.metadata().ok()?.modified().ok()?;
            Some((mtime, entry.into_path()))
        })
        .collect();

    rollout_files.sort_by_key(|a| std::cmp::Reverse(a.0));

    for (_, path) in rollout_files.into_iter().take(8) {
        if let Some(info) = read_latest_rate_limits_from_rollout_file(&path, now) {
            return Some(info);
        }
    }

    None
}

// ---------------------------------------------------------------------------
// Production OpenAI / ChatGPT Wham API Structures (Cold-Start Fallback)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct WhamWindow {
    used_percent: Option<f64>,
    #[allow(dead_code)]
    limit_window_seconds: Option<i64>,
    reset_after_seconds: Option<i64>,
    reset_at: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct WhamRateLimit {
    #[allow(dead_code)]
    allowed: Option<bool>,
    primary_window: Option<WhamWindow>,
    secondary_window: Option<WhamWindow>,
}

#[derive(Debug, Deserialize)]
struct WhamSpendControl {
    #[allow(dead_code)]
    reached: Option<bool>,
    #[allow(dead_code)]
    individual_limit: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct WhamUsageResponse {
    plan_type: Option<String>,
    rate_limit: Option<WhamRateLimit>,
    #[allow(dead_code)]
    spend_control: Option<WhamSpendControl>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthTokens {
    access_token: Option<String>,
    account_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CodexAuthJson {
    #[serde(default)]
    auth_mode: Option<String>,
    #[serde(rename = "OPENAI_API_KEY", default)]
    openai_api_key: Option<String>,
    tokens: Option<CodexAuthTokens>,
}

/// Resolves the `<CODEX_HOME>/auth.json` path for the given `AgentEnv`.
pub(crate) fn resolve_codex_auth_path_for_env(env: &AgentEnv) -> PathBuf {
    crate::parsers::codex::resolve_codex_home_dir_for_env(env).join("auth.json")
}

/// Checks whether Codex is currently configured for official ChatGPT subscription
/// login rather than a 3rd-party API key or custom model provider.
pub fn is_codex_official_subscription(
    env: &AgentEnv,
    model_provider_id: Option<i32>,
) -> bool {
    if model_provider_id.is_some() {
        return false;
    }
    if env
        .var("OPENAI_API_KEY")
        .is_some_and(|v| !v.trim().is_empty())
        || env
            .var("OPENAI_BASE_URL")
            .is_some_and(|v| !v.trim().is_empty())
    {
        return false;
    }

    let auth_path = resolve_codex_auth_path_for_env(env);
    let Ok(content) = std::fs::read_to_string(&auth_path) else {
        return true;
    };
    let Ok(parsed) = serde_json::from_str::<CodexAuthJson>(&content) else {
        return true;
    };

    if parsed.auth_mode.as_deref() == Some("chatgpt") {
        return true;
    }
    if let Some(ref key) = parsed.openai_api_key {
        if !key.trim().is_empty() {
            return false;
        }
    }
    true
}

/// Reads local `auth.json` and extracts credentials.
fn read_codex_credentials_for_env(env: &AgentEnv) -> Option<(String, Option<String>)> {
    let auth_path = resolve_codex_auth_path_for_env(env);
    if !auth_path.exists() {
        return None;
    }
    let content = std::fs::read_to_string(&auth_path).ok()?;
    let parsed: CodexAuthJson = serde_json::from_str(&content).ok()?;
    let tokens = parsed.tokens?;
    let access_token = tokens.access_token.filter(|s| !s.trim().is_empty())?;
    let account_id = tokens.account_id.filter(|s| !s.trim().is_empty());
    Some((access_token, account_id))
}

/// Fetches quota status for Codex.
///
/// 1. First checks local `<CODEX_HOME>/sessions` rollout JSONL files for the
///    latest `token_count.rate_limits` record (100% zero network, zero risk).
/// 2. Only if no local rollout record exists yet, falls back to a single
///    on-demand request to `wham/usage`.
pub async fn fetch_codex_quota() -> Result<AgentQuotaInfo, String> {
    fetch_codex_quota_for_env(&AgentEnv::inherited()).await
}

pub async fn fetch_codex_quota_for_env(env: &AgentEnv) -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();
    let codex_home = crate::parsers::codex::resolve_codex_home_dir_for_env(env);
    let sessions_dir = codex_home.join("sessions");

    if let Some(local_quota) = read_latest_codex_quota_from_sessions_dir(&sessions_dir, Some(now)) {
        return Ok(local_quota);
    }

    let (access_token, account_id) = match read_codex_credentials_for_env(env) {
        Some(creds) => creds,
        None => {
            return Ok(AgentQuotaInfo {
                agent_type: "codex".to_string(),
                plan_name: Some("Not Logged In".to_string()),
                short_window: None,
                weekly_window: None,
                spend_limit: None,
                last_updated: now,
            });
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to initialize HTTP client: {e}"))?;

    let mut req = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("User-Agent", "codex-cli/0.156.0");

    if let Some(ref acc_id) = account_id {
        req = req.header("ChatGPT-Account-Id", acc_id);
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("Codex usage API request failed: {e}"))?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("Codex usage API returned HTTP {status}"));
    }

    let wham: WhamUsageResponse = response
        .json()
        .await
        .map_err(|e| format!("failed to deserialize Codex usage payload: {e}"))?;

    let plan_name = wham.plan_type.as_deref().map(format_plan_label);

    let mut short_window = None;
    let mut weekly_window = None;

    if let Some(rate_limit) = wham.rate_limit {
        if let Some(pw) = rate_limit.primary_window {
            let used_pct = pw.used_percent.unwrap_or(0.0);
            let resets_at = pw.reset_at.and_then(|ts| Utc.timestamp_opt(ts, 0).single());
            let mut win = parse_codex_window("5-Hour Window", used_pct, resets_at, Some(now));
            if win.reset_in_seconds.is_none() {
                win.reset_in_seconds = pw.reset_after_seconds;
            }
            short_window = Some(win);
        }

        if let Some(sw) = rate_limit.secondary_window {
            let used_pct = sw.used_percent.unwrap_or(0.0);
            let resets_at = sw.reset_at.and_then(|ts| Utc.timestamp_opt(ts, 0).single());
            let mut win = parse_codex_window("Weekly Limit", used_pct, resets_at, Some(now));
            if win.reset_in_seconds.is_none() {
                win.reset_in_seconds = sw.reset_after_seconds;
            }
            weekly_window = Some(win);
        }
    }

    Ok(AgentQuotaInfo {
        agent_type: "codex".to_string(),
        plan_name,
        short_window,
        weekly_window,
        spend_limit: None,
        last_updated: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_codex_window_percentage() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let reset = Utc.with_ymd_and_hms(2026, 9, 26, 14, 0, 0).unwrap();

        let window = parse_codex_window("5-Hour Window", 42.0, Some(reset), Some(now));
        assert_eq!(window.label, "5-Hour Window");
        assert_eq!(window.used_percent, 42.0);
        assert_eq!(window.remaining_percent, 58.0);
        assert_eq!(window.resets_at, Some(reset));
        assert_eq!(window.reset_in_seconds, Some(7200));
    }

    #[test]
    fn test_parse_codex_usage_window_counters() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let reset = Utc.with_ymd_and_hms(2026, 9, 27, 12, 0, 0).unwrap();

        let window = parse_codex_usage_window("Weekly Limit", 30.0, 150.0, Some(reset), Some(now));
        assert_eq!(window.used_percent, 20.0);
        assert_eq!(window.remaining_percent, 80.0);
        assert_eq!(window.reset_in_seconds, Some(86400));
    }

    #[test]
    fn test_parse_codex_quota_json() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let raw = r#"{
            "plan": "ChatGPT Pro",
            "short_window": {
                "label": "5-Hour Window",
                "used": 15.0,
                "limit": 100.0,
                "resets_at": "2026-09-26T15:00:00Z"
            },
            "weekly_window": {
                "label": "Weekly Limit",
                "used_percent": 60.0,
                "resets_at": "2026-09-30T00:00:00Z"
            },
            "spend_limit": {
                "used_usd": 18.5,
                "limit_usd": 100.0
            }
        }"#;

        let info = parse_codex_quota_json(raw, Some(now)).expect("parse codex json");
        assert_eq!(info.agent_type, "codex");
        assert_eq!(info.plan_name.as_deref(), Some("ChatGPT Pro"));

        let short = info.short_window.expect("short_window");
        assert_eq!(short.used_percent, 15.0);
        assert_eq!(short.remaining_percent, 85.0);
        assert_eq!(short.reset_in_seconds, Some(3 * 3600));

        let weekly = info.weekly_window.expect("weekly_window");
        assert_eq!(weekly.used_percent, 60.0);
        assert_eq!(weekly.remaining_percent, 40.0);

        let spend = info.spend_limit.expect("spend_limit");
        assert_eq!(spend.used_usd, 18.5);
        assert_eq!(spend.limit_usd, 100.0);
    }

    #[test]
    fn test_parse_codex_rollout_rate_limits() {
        let now = Utc.with_ymd_and_hms(2026, 11, 10, 12, 0, 0).unwrap();
        let sample = serde_json::json!({
            "limit_id": "codex",
            "primary": {
                "used_percent": 2.0,
                "window_minutes": 300,
                "resets_at": 1794319200
            },
            "secondary": {
                "used_percent": 98.0,
                "window_minutes": 10080,
                "resets_at": 1794388800
            },
            "plan_type": "team"
        });

        let info = parse_codex_rollout_rate_limits(&sample, Some(now), Some(now))
            .expect("should parse rollout rate limits");
        assert_eq!(info.agent_type, "codex");
        assert_eq!(info.plan_name.as_deref(), Some("Team Plan"));
        assert_eq!(info.short_window.unwrap().remaining_percent, 98.0);
        assert_eq!(info.weekly_window.unwrap().remaining_percent, 2.0);
    }

    #[test]
    fn test_read_latest_codex_quota_from_sessions_dir() {
        let dir = tempfile::tempdir().unwrap();
        let day_dir = dir.path().join("2026").join("11").join("10");
        std::fs::create_dir_all(&day_dir).unwrap();
        let rollout_path = day_dir.join("rollout-2026-11-10T10-00-00-01a19a0a.jsonl");
        let line = r#"{"timestamp":"2026-11-10T10:05:00Z","type":"event_msg","payload":{"type":"token_count","info":{},"rate_limits":{"primary":{"used_percent":12.0,"window_minutes":300,"resets_at":1794319200},"secondary":{"used_percent":45.0,"window_minutes":10080,"resets_at":1794388800},"plan_type":"plus"}}}"#;
        std::fs::write(&rollout_path, format!("{line}\n")).unwrap();

        let info = read_latest_codex_quota_from_sessions_dir(dir.path(), None)
            .expect("should find rollout quota");
        assert_eq!(info.plan_name.as_deref(), Some("Plus Plan"));
        assert_eq!(info.short_window.unwrap().remaining_percent, 88.0);
        assert_eq!(info.weekly_window.unwrap().remaining_percent, 55.0);
    }
}
