//! Codex quota parsing and probe helper module.

use std::path::PathBuf;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::{AgentQuotaInfo, QuotaWindow, SpendLimit};

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
    let payload: RawCodexQuotaPayload =
        serde_json::from_str(raw_json).map_err(|e| format!("failed to parse codex quota JSON: {e}"))?;

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
// Production OpenAI / ChatGPT Wham API Structures
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
    tokens: Option<CodexAuthTokens>,
}

/// Resolves the default `~/.codex/auth.json` path.
fn resolve_codex_auth_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".codex").join("auth.json"))
}

/// Reads local `auth.json` and extracts credentials.
fn read_codex_credentials() -> Option<(String, Option<String>)> {
    let auth_path = resolve_codex_auth_path()?;
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

/// Fetches real-time quota status for Codex via ChatGPT Backend Wham API.
pub async fn fetch_codex_quota() -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();

    // 1. Attempt to read credentials from ~/.codex/auth.json
    let (access_token, account_id) = match read_codex_credentials() {
        Some(creds) => creds,
        None => {
            // Fallback: If not logged in, return graceful indicator
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

    // 2. Query the official ChatGPT usage API used by codex-cli
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

    // 3. Map Wham structure to QuotaWindow
    let plan_name = wham.plan_type.map(|p| {
        let mut chars = p.chars();
        match chars.next() {
            None => String::new(),
            Some(f) => f.to_uppercase().collect::<String>() + chars.as_str() + " Plan",
        }
    });

    let mut short_window = None;
    let mut weekly_window = None;

    if let Some(rate_limit) = wham.rate_limit {
        if let Some(pw) = rate_limit.primary_window {
            let used_pct = pw.used_percent.unwrap_or(0.0);
            let resets_at = pw.reset_at.and_then(|ts| DateTime::from_timestamp(ts, 0));
            let mut window = parse_codex_window("5-Hour Window", used_pct, resets_at, Some(now));
            if let Some(sec) = pw.reset_after_seconds {
                window.reset_in_seconds = Some(sec.max(0));
            }
            short_window = Some(window);
        }

        if let Some(sw) = rate_limit.secondary_window {
            let used_pct = sw.used_percent.unwrap_or(0.0);
            let resets_at = sw.reset_at.and_then(|ts| DateTime::from_timestamp(ts, 0));
            let mut window = parse_codex_window("Weekly Limit", used_pct, resets_at, Some(now));
            if let Some(sec) = sw.reset_after_seconds {
                window.reset_in_seconds = Some(sec.max(0));
            }
            weekly_window = Some(window);
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
    use chrono::TimeZone;

    #[test]
    fn test_parse_codex_window() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let reset = Utc.with_ymd_and_hms(2026, 9, 26, 17, 0, 0).unwrap();

        let window = parse_codex_window("5-Hour Window", 40.0, Some(reset), Some(now));
        assert_eq!(window.label, "5-Hour Window");
        assert_eq!(window.used_percent, 40.0);
        assert_eq!(window.remaining_percent, 60.0);
        assert_eq!(window.resets_at, Some(reset));
        assert_eq!(window.reset_in_seconds, Some(5 * 3600));
    }

    #[test]
    fn test_parse_codex_usage_window() {
        let window = parse_codex_usage_window("Requests", 25.0, 100.0, None, None);
        assert_eq!(window.used_percent, 25.0);
        assert_eq!(window.remaining_percent, 75.0);
    }

    #[test]
    fn test_parse_codex_quota_json() {
        let raw = r#"{
            "plan": "Codex Pro",
            "short_window": {
                "label": "5-Hour Window",
                "used_percent": 20.0
            },
            "weekly_window": {
                "label": "Weekly Limit",
                "used_percent": 50.0
            },
            "spend_limit": {
                "used_usd": 12.5,
                "limit_usd": 50.0
            }
        }"#;

        let info = parse_codex_quota_json(raw, None).unwrap();
        assert_eq!(info.agent_type, "codex");
        assert_eq!(info.plan_name.as_deref(), Some("Codex Pro"));
        assert_eq!(info.short_window.unwrap().remaining_percent, 80.0);
        assert_eq!(info.weekly_window.unwrap().remaining_percent, 50.0);
        let spend = info.spend_limit.unwrap();
        assert_eq!(spend.used_usd, 12.5);
        assert_eq!(spend.limit_usd, 50.0);
    }
}
