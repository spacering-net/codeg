//! Antigravity quota parsing and safe zero-network probe helper module.
//!
//! Zero-Risk Architectural Decision:
//! Active probing via simulated HTTP requests to Google's internal CCPA endpoints
//! (`daily-cloudcode-pa.googleapis.com`) with spoofed User-Agent headers is
//! strictly prohibited to eliminate account ban / risk-control triggers.
//!
//! Antigravity quota display operates in a zero-network passive mode:
//! 1. Parses session turn usage / status events sent natively by the running
//!    `agy_acp_server` process over the ACP channel.
//! 2. If no native turn quota data is available, returns a safe fallback without
//!    initiating any unsolicited background network requests.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::{AgentQuotaInfo, QuotaWindow, SpendLimit};
use crate::parsers::AgentEnv;

/// Helper to parse an Antigravity quota window with percentage and reset time.
pub fn parse_antigravity_window(
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

/// Helper to parse an Antigravity quota window from raw usage and limit counters.
pub fn parse_antigravity_usage_window(
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
struct RawAntigravityQuotaPayload {
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    short_window: Option<RawWindowPayload>,
    #[serde(default)]
    weekly_window: Option<RawWindowPayload>,
    #[serde(default)]
    spend_limit: Option<RawSpendPayload>,
}

/// Parse a raw JSON payload from Antigravity/Gemini into `AgentQuotaInfo`.
pub fn parse_antigravity_quota_json(
    raw_json: &str,
    now: Option<DateTime<Utc>>,
) -> Result<AgentQuotaInfo, String> {
    let payload: RawAntigravityQuotaPayload = serde_json::from_str(raw_json)
        .map_err(|e| format!("failed to parse antigravity quota JSON: {e}"))?;

    let short_window = payload.short_window.map(|w| {
        let label = w.label.unwrap_or_else(|| "Short-Term Quota".to_string());
        if let (Some(used), Some(limit)) = (w.used, w.limit) {
            parse_antigravity_usage_window(label, used, limit, w.resets_at, now)
        } else {
            let used_pct = w.used_percent.unwrap_or(0.0);
            parse_antigravity_window(label, used_pct, w.resets_at, now)
        }
    });

    let weekly_window = payload.weekly_window.map(|w| {
        let label = w.label.unwrap_or_else(|| "Weekly Quota".to_string());
        if let (Some(used), Some(limit)) = (w.used, w.limit) {
            parse_antigravity_usage_window(label, used, limit, w.resets_at, now)
        } else {
            let used_pct = w.used_percent.unwrap_or(0.0);
            parse_antigravity_window(label, used_pct, w.resets_at, now)
        }
    });

    let spend_limit = payload
        .spend_limit
        .map(|s| SpendLimit::new(s.used_usd, s.limit_usd));

    let last_updated = now.unwrap_or_else(Utc::now);

    Ok(AgentQuotaInfo {
        agent_type: "antigravity".to_string(),
        plan_name: payload.plan,
        short_window,
        weekly_window,
        spend_limit,
        last_updated,
    })
}

// ---------------------------------------------------------------------------
// Zero-Network Local Authentication & Multi-Instance Resolution
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GoogleOAuthToken {
    #[allow(dead_code)]
    access_token: Option<String>,
    #[allow(dead_code)]
    expires_at: Option<String>,
}

/// Resolves the Antigravity `acp_token.json` or `oauth_token.json` path on disk.
/// Respects `GEMINI_HOME` so custom multi-instance agents (e.g. `custom:antigravity-b`)
/// find their own isolated tokens.
pub fn resolve_antigravity_token_path_for_env(env: &AgentEnv) -> Option<PathBuf> {
    if let Some(custom_gemini_home) = env.var("GEMINI_HOME") {
        let trimmed = custom_gemini_home.trim();
        if !trimmed.is_empty() {
            let base = Path::new(trimmed);
            let candidate1 = base.join("antigravity-acp").join("acp_token.json");
            if candidate1.exists() {
                return Some(candidate1);
            }
            let candidate2 = base
                .join("antigravity-engine")
                .join("oauth_token.json");
            if candidate2.exists() {
                return Some(candidate2);
            }
            let candidate3 = base.join("acp_token.json");
            if candidate3.exists() {
                return Some(candidate3);
            }
            return Some(candidate1);
        }
    }

    let home_dir = dirs::home_dir()?;
    let candidate1 = home_dir
        .join(".gemini")
        .join("antigravity-acp")
        .join("acp_token.json");
    if candidate1.exists() {
        return Some(candidate1);
    }

    let candidate2 = home_dir
        .join(".gemini")
        .join("antigravity-engine")
        .join("oauth_token.json");
    if candidate2.exists() {
        return Some(candidate2);
    }

    Some(candidate1)
}

/// Checks whether an Antigravity agent is configured for official subscription mode
/// (OAuth personal or business) as opposed to a custom Gemini API Key or 3rd-party Model Provider.
pub fn is_antigravity_official_subscription(env: &AgentEnv, model_provider_id: Option<i32>) -> bool {
    if model_provider_id.is_some() {
        return false;
    }

    if let Some(method) = env.var("AGY_AUTH_METHOD") {
        let trimmed = method.trim();
        if trimmed == "gemini-api-key" || trimmed == "agent-platform" {
            return false;
        }
        if trimmed == "oauth-personal" || trimmed == "oauth-business" {
            return true;
        }
    }

    if env
        .var("AGY_GEMINI_API_KEY")
        .is_some_and(|v| !v.trim().is_empty())
    {
        return false;
    }

    if env.var("GEMINI_API_KEY").is_some_and(|v| !v.trim().is_empty()) {
        return false;
    }

    true
}

/// Fetches quota status for Google Antigravity in safe zero-network mode.
///
/// To completely eliminate any account ban / risk-control hazard, Codeg never
/// initiates spoofed HTTP requests to Google's internal CCPA endpoints.
/// Quota information is derived strictly from local credentials or native ACP session turns.
pub async fn fetch_antigravity_quota() -> Result<AgentQuotaInfo, String> {
    fetch_antigravity_quota_for_env("antigravity", &AgentEnv::inherited()).await
}

pub async fn fetch_antigravity_quota_for_env(
    agent_type_label: &str,
    env: &AgentEnv,
) -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();

    let Some(token_path) = resolve_antigravity_token_path_for_env(env) else {
        return Ok(AgentQuotaInfo {
            agent_type: agent_type_label.to_string(),
            plan_name: Some("Not Logged In".to_string()),
            short_window: None,
            weekly_window: None,
            spend_limit: None,
            last_updated: now,
        });
    };

    // If local token file exists and parses, mark the account as logged in via official OAuth.
    // Zero external HTTP requests are performed.
    let is_logged_in = if token_path.exists() {
        std::fs::read_to_string(&token_path)
            .ok()
            .and_then(|c| serde_json::from_str::<GoogleOAuthToken>(&c).ok())
            .is_some()
    } else {
        false
    };

    let plan_name = if is_logged_in {
        Some("Google AI (OAuth)".to_string())
    } else {
        Some("Not Logged In".to_string())
    };

    Ok(AgentQuotaInfo {
        agent_type: agent_type_label.to_string(),
        plan_name,
        short_window: None,
        weekly_window: None,
        spend_limit: None,
        last_updated: now,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_antigravity_window() {
        let now = Utc::now();
        let resets_at = now + chrono::Duration::hours(2);
        let win = parse_antigravity_window("Gemini 5-Hour", 35.0, Some(resets_at), Some(now));

        assert_eq!(win.label, "Gemini 5-Hour");
        assert_eq!(win.used_percent, 35.0);
        assert_eq!(win.remaining_percent, 65.0);
        assert!(win.reset_in_seconds.unwrap() > 7100);
    }

    #[test]
    fn test_parse_antigravity_usage_window() {
        let now = Utc::now();
        let resets_at = now + chrono::Duration::days(1);
        let win = parse_antigravity_usage_window("Tokens", 250.0, 1000.0, Some(resets_at), Some(now));

        assert_eq!(win.used_percent, 25.0);
        assert_eq!(win.remaining_percent, 75.0);
    }

    #[test]
    fn test_parse_antigravity_quota_json() {
        let json = r#"{
            "plan": "Google AI Ultra",
            "short_window": {
                "label": "5-Hour Window",
                "used_percent": 15.5
            },
            "weekly_window": {
                "label": "Weekly Window",
                "used": 40.0,
                "limit": 100.0
            },
            "spend_limit": {
                "used_usd": 12.50,
                "limit_usd": 50.00
            }
        }"#;

        let quota = parse_antigravity_quota_json(json, None).expect("parse antigravity json");
        assert_eq!(quota.agent_type, "antigravity");
        assert_eq!(quota.plan_name, Some("Google AI Ultra".to_string()));

        let short = quota.short_window.unwrap();
        assert_eq!(short.used_percent, 15.5);
        assert_eq!(short.remaining_percent, 84.5);

        let weekly = quota.weekly_window.unwrap();
        assert_eq!(weekly.used_percent, 40.0);
        assert_eq!(weekly.remaining_percent, 60.0);

        let spend = quota.spend_limit.unwrap();
        assert_eq!(spend.used_usd, 12.50);
        assert_eq!(spend.limit_usd, 50.00);
    }

    #[test]
    fn test_is_antigravity_official_subscription() {
        let empty_env = AgentEnv::inherited();
        assert!(is_antigravity_official_subscription(&empty_env, None));
        assert!(!is_antigravity_official_subscription(&empty_env, Some(1)));

        let oauth_env =
            AgentEnv::from_env_json(Some(r#"{"AGY_AUTH_METHOD":"oauth-personal"}"#));
        assert!(is_antigravity_official_subscription(&oauth_env, None));

        let apikey_env =
            AgentEnv::from_env_json(Some(r#"{"AGY_AUTH_METHOD":"gemini-api-key"}"#));
        assert!(!is_antigravity_official_subscription(&apikey_env, None));
    }

    #[test]
    fn test_resolve_antigravity_token_path_respects_gemini_home() {
        let custom_dir = std::env::temp_dir().join("test_gemini_home_quota");
        let token_dir = custom_dir.join("antigravity-acp");
        std::fs::create_dir_all(&token_dir).ok();
        let token_file = token_dir.join("acp_token.json");
        std::fs::write(&token_file, "{}").ok();

        let env = AgentEnv::from_env_json(Some(&format!(
            r#"{{"GEMINI_HOME":{}}}"#,
            serde_json::to_string(&custom_dir.to_string_lossy()).unwrap()
        )));

        let resolved = resolve_antigravity_token_path_for_env(&env);
        assert_eq!(resolved, Some(token_file));

        std::fs::remove_dir_all(&custom_dir).ok();
    }
}
