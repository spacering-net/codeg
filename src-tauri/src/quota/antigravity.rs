//! Antigravity quota parsing and probe helper module.

use std::path::PathBuf;
use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::{AgentQuotaInfo, QuotaWindow, SpendLimit};

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
    let payload: RawAntigravityQuotaPayload =
        serde_json::from_str(raw_json).map_err(|e| format!("failed to parse antigravity quota JSON: {e}"))?;

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
// Production Google Cloud Code Private API (CCPA) Quota Structures
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct QuotaSummaryBucket {
    #[allow(dead_code)]
    #[serde(rename = "bucketId")]
    bucket_id: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    window: Option<String>,
    #[serde(rename = "resetTime")]
    reset_time: Option<String>,
    #[allow(dead_code)]
    description: Option<String>,
    #[serde(rename = "remainingFraction")]
    remaining_fraction: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct QuotaSummaryGroup {
    #[allow(dead_code)]
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    buckets: Option<Vec<QuotaSummaryBucket>>,
}

#[derive(Debug, Deserialize)]
struct QuotaSummaryResponse {
    groups: Option<Vec<QuotaSummaryGroup>>,
}

#[derive(Debug, Deserialize)]
struct TierInfo {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct LoadCodeAssistResponse {
    #[serde(rename = "paidTier")]
    paid_tier: Option<TierInfo>,
    #[serde(rename = "currentTier")]
    current_tier: Option<TierInfo>,
}

#[derive(Debug, Deserialize)]
struct GoogleOAuthToken {
    access_token: Option<String>,
    refresh_token: Option<String>,
    token_uri: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
}

#[derive(Debug, Deserialize)]
struct GoogleTokenRefreshResponse {
    access_token: Option<String>,
}

/// Resolves candidates for Antigravity OAuth tokens file (`acp_token.json`).
fn resolve_antigravity_token_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    let candidates = [
        home.join(".gemini").join("antigravity-acp").join("acp_token.json"),
        home.join(".gemini").join("antigravity").join("acp_token.json"),
        home.join(".gemini").join("antigravity-cli").join("acp_token.json"),
    ];

    for path in candidates {
        if path.exists() {
            return Some(path);
        }
    }
    None
}

/// Obtains a valid Google OAuth access token, refreshing if necessary.
async fn get_valid_google_access_token(
    client: &reqwest::Client,
) -> Result<String, String> {
    let token_path = resolve_antigravity_token_path()
        .ok_or_else(|| "Antigravity OAuth token file not found".to_string())?;

    let content = std::fs::read_to_string(&token_path)
        .map_err(|e| format!("failed to read token file: {e}"))?;

    let token_info: GoogleOAuthToken = serde_json::from_str(&content)
        .map_err(|e| format!("failed to parse token file: {e}"))?;

    // If refresh token exists, refresh to guarantee a fresh, non-expired token
    if let (Some(ref r_token), Some(ref c_id), Some(ref c_secret)) = (
        &token_info.refresh_token,
        &token_info.client_id,
        &token_info.client_secret,
    ) {
        let uri = token_info
            .token_uri
            .as_deref()
            .unwrap_or("https://oauth2.googleapis.com/token");

        let params = [
            ("client_id", c_id.as_str()),
            ("client_secret", c_secret.as_str()),
            ("refresh_token", r_token.as_str()),
            ("grant_type", "refresh_token"),
        ];

        let refresh_resp = client
            .post(uri)
            .form(&params)
            .send()
            .await
            .map_err(|e| format!("failed to execute OAuth refresh: {e}"))?;

        if refresh_resp.status().is_success() {
            let refresh_data: GoogleTokenRefreshResponse = refresh_resp
                .json()
                .await
                .map_err(|e| format!("failed to parse refresh JSON: {e}"))?;

            if let Some(fresh_token) = refresh_data.access_token {
                return Ok(fresh_token);
            }
        }
    }

    token_info
        .access_token
        .filter(|t| !t.trim().is_empty())
        .ok_or_else(|| "No valid access token or refresh token available".to_string())
}

/// Fetches real-time quota status for Google Antigravity via CCPA Daily Endpoint.
pub async fn fetch_antigravity_quota() -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to create reqwest client: {e}"))?;

    // 1. Get Google OAuth access token
    let access_token = match get_valid_google_access_token(&client).await {
        Ok(t) => t,
        Err(_) => {
            // Graceful degradation when not logged in
            return Ok(AgentQuotaInfo {
                agent_type: "antigravity".to_string(),
                plan_name: Some("Not Logged In".to_string()),
                short_window: None,
                weekly_window: None,
                spend_limit: None,
                last_updated: now,
            });
        }
    };

    // 2. Fetch Plan Name via loadCodeAssist (Consumer Daily endpoint)
    let plan_name_future = {
        let client_clone = client.clone();
        let token = access_token.clone();
        async move {
            let resp = client_clone
                .post("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist")
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .header("User-Agent", "antigravity/1.2.1 windows/amd64")
                .json(&serde_json::json!({
                    "metadata": { "ideType": "ANTIGRAVITY" }
                }))
                .send()
                .await;

            if let Ok(r) = resp {
                if r.status().is_success() {
                    if let Ok(data) = r.json::<LoadCodeAssistResponse>().await {
                        return data
                            .paid_tier
                            .and_then(|t| t.name)
                            .or_else(|| data.current_tier.and_then(|t| t.name));
                    }
                }
            }
            None
        }
    };

    // 3. Fetch Quota Summary via retrieveUserQuotaSummary
    let quota_resp = client
        .post("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary")
        .header("Authorization", format!("Bearer {access_token}"))
        .header("Content-Type", "application/json")
        .header("User-Agent", "antigravity/1.2.1 windows/amd64")
        .json(&serde_json::json!({
            "project": "aicode-consumers"
        }))
        .send()
        .await
        .map_err(|e| format!("retrieveUserQuotaSummary request failed: {e}"))?;

    if !quota_resp.status().is_success() {
        return Err(format!("retrieveUserQuotaSummary returned HTTP {}", quota_resp.status()));
    }

    let summary: QuotaSummaryResponse = quota_resp
        .json()
        .await
        .map_err(|e| format!("failed to parse QuotaSummaryResponse: {e}"))?;

    let resolved_plan = plan_name_future.await.or_else(|| Some("Google AI Pro".to_string()));

    let mut short_window = None;
    let mut weekly_window = None;

    if let Some(groups) = summary.groups {
        // Look for Gemini Models group first, or fallback to first available group
        let target_group = groups
            .iter()
            .find(|g| g.display_name.as_deref().unwrap_or("").contains("Gemini"))
            .or_else(|| groups.first());

        if let Some(group) = target_group {
            if let Some(ref buckets) = group.buckets {
                for bucket in buckets {
                    let fraction = bucket.remaining_fraction.unwrap_or(1.0);
                    let remaining_percent = (fraction * 100.0).clamp(0.0, 100.0);
                    let used_percent = (100.0 - remaining_percent).clamp(0.0, 100.0);

                    let resets_at = bucket.reset_time.as_deref().and_then(|rt| {
                        DateTime::parse_from_rfc3339(rt)
                            .map(|dt| dt.with_timezone(&Utc))
                            .ok()
                    });

                    let label = bucket
                        .display_name
                        .as_deref()
                        .unwrap_or_else(|| match bucket.window.as_deref() {
                            Some("5h") => "Gemini 5-Hour Window",
                            Some("weekly") => "Gemini Weekly Limit",
                            _ => "Quota Window",
                        });

                    if bucket.window.as_deref() == Some("5h") && short_window.is_none() {
                        short_window = Some(parse_antigravity_window(
                            label,
                            used_percent,
                            resets_at,
                            Some(now),
                        ));
                    } else if bucket.window.as_deref() == Some("weekly") && weekly_window.is_none() {
                        weekly_window = Some(parse_antigravity_window(
                            label,
                            used_percent,
                            resets_at,
                            Some(now),
                        ));
                    }
                }
            }
        }
    }

    Ok(AgentQuotaInfo {
        agent_type: "antigravity".to_string(),
        plan_name: resolved_plan,
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
    fn test_parse_antigravity_window() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let reset = Utc.with_ymd_and_hms(2026, 9, 26, 17, 0, 0).unwrap();

        let window = parse_antigravity_window("Gemini 2.5 Window", 30.0, Some(reset), Some(now));
        assert_eq!(window.label, "Gemini 2.5 Window");
        assert_eq!(window.used_percent, 30.0);
        assert_eq!(window.remaining_percent, 70.0);
        assert_eq!(window.resets_at, Some(reset));
        assert_eq!(window.reset_in_seconds, Some(5 * 3600));
    }

    #[test]
    fn test_parse_antigravity_usage_window() {
        let window = parse_antigravity_usage_window("Requests", 40.0, 100.0, None, None);
        assert_eq!(window.used_percent, 40.0);
        assert_eq!(window.remaining_percent, 60.0);
    }

    #[test]
    fn test_parse_antigravity_quota_json() {
        let raw = r#"{
            "plan": "Google Antigravity Enterprise",
            "short_window": {
                "label": "Short-Term Quota",
                "used_percent": 15.0
            },
            "weekly_window": {
                "label": "Weekly Quota",
                "used_percent": 45.0
            },
            "spend_limit": {
                "used_usd": 0.0,
                "limit_usd": 0.0
            }
        }"#;

        let info = parse_antigravity_quota_json(raw, None).unwrap();
        assert_eq!(info.agent_type, "antigravity");
        assert_eq!(info.plan_name.as_deref(), Some("Google Antigravity Enterprise"));
        assert_eq!(info.short_window.unwrap().remaining_percent, 85.0);
        assert_eq!(info.weekly_window.unwrap().remaining_percent, 55.0);
    }
}
