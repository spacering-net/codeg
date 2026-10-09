//! Claude Code (Anthropic) subscription quota probe.
//!
//! Claude Code's own `/usage` command reads the subscriber's rolling limits
//! from `https://api.anthropic.com/api/oauth/usage` with the OAuth access
//! token it stored at login. That token lives in the macOS Keychain under the
//! service `Claude Code-credentials` (the CLI's own item), and on other
//! platforms in `<CLAUDE_CONFIG_DIR|~/.claude>/.credentials.json`; both hold
//! the same JSON: `{"claudeAiOauth": {"accessToken", "expiresAt",
//! "subscriptionType", …}}`. The token is read only to call Anthropic — the
//! issuer — and is never persisted or forwarded anywhere else.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::{AgentQuotaInfo, QuotaWindow};

pub const CLAUDE_AGENT_TYPE: &str = "claude_code";
const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// The beta header Claude Code sends on every OAuth-authenticated request.
const OAUTH_BETA_HEADER: &str = "oauth-2025-04-20";
#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Debug, Deserialize)]
struct OauthCredentials {
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
    /// Unix milliseconds.
    #[serde(rename = "expiresAt")]
    expires_at: Option<i64>,
    #[serde(rename = "subscriptionType")]
    subscription_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CredentialsFile {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OauthCredentials>,
}

/// One rolling window as the usage endpoint reports it: `utilization` is a
/// percentage (0–100) and `resets_at` an RFC 3339 timestamp.
#[derive(Debug, Default, Deserialize)]
struct UsageWindow {
    utilization: Option<f64>,
    resets_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Default, Deserialize)]
struct UsageResponse {
    five_hour: Option<UsageWindow>,
    seven_day: Option<UsageWindow>,
    /// Present on plans with a separate Opus budget; not surfaced (the two
    /// windows above are what the badge shows), kept so the payload parses.
    #[allow(dead_code)]
    seven_day_opus: Option<UsageWindow>,
}

fn resolve_credentials_file() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !dir.trim().is_empty() {
            return Some(PathBuf::from(dir).join(".credentials.json"));
        }
    }
    dirs::home_dir().map(|h| h.join(".claude").join(".credentials.json"))
}

/// The raw credentials JSON: the Keychain item on macOS, else the file.
fn read_credentials_json() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("security")
            .args(["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"])
            .output()
            .ok()?;
        if out.status.success() {
            let text = String::from_utf8(out.stdout).ok()?;
            if !text.trim().is_empty() {
                return Some(text);
            }
        }
    }
    let path = resolve_credentials_file()?;
    std::fs::read_to_string(path).ok()
}

fn parse_credentials(json: &str) -> Option<OauthCredentials> {
    let parsed: CredentialsFile = serde_json::from_str(json.trim()).ok()?;
    let creds = parsed.claude_ai_oauth?;
    creds
        .access_token
        .as_deref()
        .filter(|t| !t.trim().is_empty())?;
    Some(creds)
}

/// Anthropic's OAuth endpoints treat unknown clients far more strictly; send
/// the same identity the installed Claude Code does.
fn claude_user_agent() -> String {
    let version = std::process::Command::new("claude")
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| s.split_whitespace().next().map(str::to_string))
        .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
        .unwrap_or_else(|| "2.0.0".to_string());
    format!("claude-cli/{version} (external, cli)")
}

fn window_from(label: &str, w: &UsageWindow, now: DateTime<Utc>) -> QuotaWindow {
    let used = w.utilization.unwrap_or(0.0).clamp(0.0, 100.0);
    let reset_in = w.resets_at.map(|at| (at - now).num_seconds().max(0));
    QuotaWindow::new(label, used, (100.0 - used).max(0.0), w.resets_at, reset_in)
}

fn plan_label(subscription_type: Option<&str>) -> Option<String> {
    let raw = subscription_type?.trim();
    if raw.is_empty() {
        return None;
    }
    let mut chars = raw.chars();
    let first = chars.next()?.to_uppercase().collect::<String>();
    Some(format!("Claude {}{}", first, chars.as_str()))
}

/// Map the usage payload (already fetched) onto the shared quota model.
pub fn parse_claude_usage_json(
    raw_json: &str,
    subscription_type: Option<&str>,
    now: DateTime<Utc>,
) -> Result<AgentQuotaInfo, String> {
    let usage: UsageResponse = serde_json::from_str(raw_json)
        .map_err(|e| format!("failed to parse Claude usage payload: {e}"))?;
    Ok(AgentQuotaInfo {
        agent_type: CLAUDE_AGENT_TYPE.to_string(),
        plan_name: plan_label(subscription_type),
        short_window: usage
            .five_hour
            .as_ref()
            .map(|w| window_from("5-Hour Window", w, now)),
        weekly_window: usage
            .seven_day
            .as_ref()
            .map(|w| window_from("Weekly Limit", w, now)),
        spend_limit: None,
        last_updated: now,
    })
}

fn not_logged_in(now: DateTime<Utc>) -> AgentQuotaInfo {
    AgentQuotaInfo {
        agent_type: CLAUDE_AGENT_TYPE.to_string(),
        plan_name: Some("Not Logged In".to_string()),
        short_window: None,
        weekly_window: None,
        spend_limit: None,
        last_updated: now,
    }
}

/// Fetch the Claude subscription's 5-hour and weekly utilization.
pub async fn fetch_claude_quota() -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();
    let creds = match read_credentials_json().and_then(|j| parse_credentials(&j)) {
        Some(c) => c,
        None => return Ok(not_logged_in(now)),
    };
    if let Some(expires_at) = creds.expires_at {
        if expires_at <= now.timestamp_millis() {
            // Refreshing needs Claude Code's own OAuth client; the next
            // `claude` launch does it. Say so instead of failing opaquely.
            return Err(
                "Claude Code login has expired; run `claude` once to refresh it".to_string(),
            );
        }
    }
    let access_token = creds.access_token.clone().unwrap_or_default();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to initialize HTTP client: {e}"))?;
    let response = client
        .get(USAGE_URL)
        .header("Authorization", format!("Bearer {access_token}"))
        .header("anthropic-beta", OAUTH_BETA_HEADER)
        .header("User-Agent", claude_user_agent())
        .send()
        .await
        .map_err(|e| format!("Claude usage API request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("Claude usage API returned HTTP {status}"));
    }
    let body = response
        .text()
        .await
        .map_err(|e| format!("failed to read Claude usage payload: {e}"))?;
    parse_claude_usage_json(&body, creds.subscription_type.as_deref(), now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_windows_and_plan() {
        let now = Utc.with_ymd_and_hms(2026, 9, 27, 12, 0, 0).unwrap();
        let raw = r#"{
            "five_hour": {"utilization": 23.0, "resets_at": "2026-09-27T15:00:00Z"},
            "seven_day": {"utilization": 61.5, "resets_at": "2026-10-01T00:00:00Z"},
            "seven_day_opus": {"utilization": 0.0, "resets_at": null}
        }"#;
        let info = parse_claude_usage_json(raw, Some("max"), now).unwrap();
        assert_eq!(info.agent_type, "claude_code");
        assert_eq!(info.plan_name.as_deref(), Some("Claude Max"));
        let short = info.short_window.unwrap();
        assert_eq!(short.label, "5-Hour Window");
        assert_eq!(short.used_percent, 23.0);
        assert_eq!(short.remaining_percent, 77.0);
        assert_eq!(short.reset_in_seconds, Some(3 * 3600));
        let weekly = info.weekly_window.unwrap();
        assert_eq!(weekly.remaining_percent, 38.5);
        assert!(info.spend_limit.is_none());
    }

    #[test]
    fn tolerates_missing_windows_and_plan() {
        let now = Utc::now();
        let info = parse_claude_usage_json("{}", None, now).unwrap();
        assert!(info.short_window.is_none());
        assert!(info.weekly_window.is_none());
        assert!(info.plan_name.is_none());
        assert!(parse_claude_usage_json("not json", None, now).is_err());
    }

    #[test]
    fn credentials_require_a_token() {
        assert!(
            parse_credentials(r#"{"claudeAiOauth":{"accessToken":"","expiresAt":1}}"#).is_none()
        );
        assert!(parse_credentials(r#"{"other":{}}"#).is_none());
        let c = parse_credentials(
            r#"{"claudeAiOauth":{"accessToken":"tok","expiresAt":1790000000000,"subscriptionType":"pro"}}"#,
        )
        .unwrap();
        assert_eq!(c.subscription_type.as_deref(), Some("pro"));
        assert_eq!(c.expires_at, Some(1_790_000_000_000));
    }
}
