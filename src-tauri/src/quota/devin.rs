//! Devin CLI (Cognition) plan quota probe.
//!
//! Devin CLI authenticates against the Windsurf/Codeium seat-management
//! service: `~/.local/share/devin/credentials.toml` (`XDG_DATA_HOME` aware)
//! holds `windsurf_api_key` plus `api_server_url` (normally
//! `https://server.codeium.com`). The CLI's own status call is the Connect
//! RPC `exa.seat_management_pb.SeatManagementService/GetUserStatus`, whose
//! `PlanStatus` carries the daily / weekly quota remaining percentages, their
//! reset times, the ACU counters and the plan name. The key is only ever sent
//! to that configured server and is not stored by codeg.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::Deserialize;

use crate::models::{AgentQuotaInfo, QuotaWindow};

/// The built-in (import-only) agent id, and the wire id of the custom ACP
/// agent a user registers to run Devin live — both mean the same account.
pub const DEVIN_AGENT_TYPES: &[&str] = &["devin", "custom:devin"];
const DEFAULT_API_SERVER: &str = "https://server.codeium.com";
/// `(ide_name, extension_name)` pairs tried in order; the first is what Devin
/// CLI itself sends.
const CLIENT_IDENTITIES: &[(&str, &str)] = &[
    ("devin_cli", "chisel"),
    ("chisel", "chisel"),
    ("windsurf", "windsurf"),
];
const FALLBACK_CLI_VERSION: &str = "3000.0.0";
const GET_USER_STATUS_PATH: &str = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";

#[derive(Debug, Deserialize)]
struct DevinCredentials {
    windsurf_api_key: Option<String>,
    api_server_url: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInfo {
    #[serde(alias = "plan_name")]
    plan_name: Option<String>,
}

/// protojson writes 64-bit integers as strings; accept either form.
fn de_opt_num<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: std::str::FromStr + serde::Deserialize<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum NumOrStr<T> {
        Num(T),
        Str(String),
    }
    Ok(match Option::<NumOrStr<T>>::deserialize(d)? {
        Some(NumOrStr::Num(n)) => Some(n),
        Some(NumOrStr::Str(s)) => s.trim().parse().ok(),
        None => None,
    })
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStatus {
    #[serde(alias = "plan_info")]
    plan_info: Option<PlanInfo>,
    #[serde(alias = "daily_quota_remaining_percent", default, deserialize_with = "de_opt_num")]
    daily_quota_remaining_percent: Option<f64>,
    #[serde(alias = "weekly_quota_remaining_percent", default, deserialize_with = "de_opt_num")]
    weekly_quota_remaining_percent: Option<f64>,
    #[serde(alias = "daily_quota_reset_at_unix", default, deserialize_with = "de_opt_num")]
    daily_quota_reset_at_unix: Option<i64>,
    #[serde(alias = "weekly_quota_reset_at_unix", default, deserialize_with = "de_opt_num")]
    weekly_quota_reset_at_unix: Option<i64>,
    #[serde(alias = "acu_consumed", default, deserialize_with = "de_opt_num")]
    acu_consumed: Option<f64>,
    #[serde(alias = "acu_limit", default, deserialize_with = "de_opt_num")]
    acu_limit: Option<f64>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserStatus {
    #[serde(alias = "plan_status")]
    plan_status: Option<PlanStatus>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetUserStatusResponse {
    #[serde(alias = "user_status")]
    user_status: Option<UserStatus>,
}

fn resolve_credentials_path() -> Option<PathBuf> {
    let base = std::env::var("XDG_DATA_HOME")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))?;
    Some(base.join("devin").join("credentials.toml"))
}

fn devin_data_dir() -> Option<PathBuf> {
    resolve_credentials_path().and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// The newest Devin CLI version installed under `<data>/cli/_versions/`.
fn installed_cli_version() -> String {
    devin_data_dir()
        .and_then(|d| std::fs::read_dir(d.join("cli").join("_versions")).ok())
        .map(|entries| {
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .filter(|n| n.chars().next().is_some_and(|c| c.is_ascii_digit()))
                .max_by(|a, b| compare_versions(a, b))
        })
        .flatten()
        .unwrap_or_else(|| FALLBACK_CLI_VERSION.to_string())
}

fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |s: &str| -> Vec<u64> { s.split('.').map(|p| p.parse().unwrap_or(0)).collect() };
    parse(a).cmp(&parse(b))
}

fn parse_credentials(toml_text: &str) -> Option<(String, String)> {
    let creds: DevinCredentials = toml::from_str(toml_text).ok()?;
    let key = creds.windsurf_api_key.filter(|k| !k.trim().is_empty())?;
    let server = creds
        .api_server_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_API_SERVER.to_string());
    Some((key, server.trim_end_matches('/').to_string()))
}

fn read_credentials() -> Option<(String, String)> {
    let path = resolve_credentials_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    parse_credentials(&text)
}

/// Remaining-percent + unix reset → the shared window shape.
fn window_from_remaining(
    label: &str,
    remaining_percent: f64,
    reset_at_unix: Option<i64>,
    now: DateTime<Utc>,
) -> QuotaWindow {
    let remaining = remaining_percent.clamp(0.0, 100.0);
    let resets_at = reset_at_unix
        .filter(|ts| *ts > 0)
        .and_then(|ts| DateTime::from_timestamp(ts, 0));
    let reset_in = resets_at.map(|at| (at - now).num_seconds().max(0));
    QuotaWindow::new(label, 100.0 - remaining, remaining, resets_at, reset_in)
}

/// Map a `GetUserStatus` payload onto the shared quota model.
pub fn parse_devin_status_json(
    raw_json: &str,
    agent_type: &str,
    now: DateTime<Utc>,
) -> Result<AgentQuotaInfo, String> {
    let parsed: GetUserStatusResponse = serde_json::from_str(raw_json)
        .map_err(|e| format!("failed to parse Devin status payload: {e}"))?;
    let plan = parsed
        .user_status
        .and_then(|u| u.plan_status)
        .unwrap_or_default();

    let mut plan_name = plan
        .plan_info
        .as_ref()
        .and_then(|p| p.plan_name.clone())
        .filter(|n| !n.trim().is_empty());
    if let (Some(used), Some(limit)) = (plan.acu_consumed, plan.acu_limit) {
        if limit > 0.0 {
            let acu = format!("{used:.1} / {limit:.0} ACU");
            plan_name = Some(match plan_name {
                Some(name) => format!("{name} · {acu}"),
                None => acu,
            });
        }
    }

    Ok(AgentQuotaInfo {
        agent_type: agent_type.to_string(),
        plan_name,
        short_window: plan.daily_quota_remaining_percent.map(|pct| {
            window_from_remaining("Daily Quota", pct, plan.daily_quota_reset_at_unix, now)
        }),
        weekly_window: plan.weekly_quota_remaining_percent.map(|pct| {
            window_from_remaining("Weekly Quota", pct, plan.weekly_quota_reset_at_unix, now)
        }),
        spend_limit: None,
        last_updated: now,
    })
}

/// Fetch the Devin plan's daily / weekly quota. `agent_type` is echoed back
/// so the badge's cache key matches whichever id asked.
pub async fn fetch_devin_quota(agent_type: &str) -> Result<AgentQuotaInfo, String> {
    let now = Utc::now();
    let (api_key, server) = match read_credentials() {
        Some(c) => c,
        None => {
            return Ok(AgentQuotaInfo {
                agent_type: agent_type.to_string(),
                plan_name: Some("Not Logged In".to_string()),
                short_window: None,
                weekly_window: None,
                spend_limit: None,
                last_updated: now,
            })
        }
    };

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("failed to initialize HTTP client: {e}"))?;
    // The seat-management server validates the client identity in the
    // request metadata and answers 500 for one it does not recognise. Devin
    // CLI identifies as extension "chisel" at its own installed version, so
    // send that; a couple of known-good identities follow as fallbacks in
    // case the server's expectations move.
    let version = installed_cli_version();
    let mut last_error = String::new();
    let mut text = None;
    for (ide_name, extension_name) in CLIENT_IDENTITIES {
        let body = serde_json::json!({
            "metadata": {
                "api_key": api_key,
                "ide_name": ide_name,
                "ide_version": version,
                "extension_name": extension_name,
                "extension_version": version,
                "locale": "en",
            }
        });
        let response = client
            .post(format!("{server}{GET_USER_STATUS_PATH}"))
            .header("Content-Type", "application/json")
            .header("Connect-Protocol-Version", "1")
            .header("User-Agent", format!("{extension_name}/{version}"))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Devin status API request failed: {e}"))?;
        let status = response.status();
        let payload = response
            .text()
            .await
            .map_err(|e| format!("failed to read Devin status payload: {e}"))?;
        if status.is_success() {
            text = Some(payload);
            break;
        }
        // Connect errors carry `{"code","message"}` — safe to surface, and
        // far more useful than a bare status line.
        let detail: String = payload.chars().take(200).collect();
        last_error = format!("Devin status API returned HTTP {status}: {detail}");
        if status.as_u16() == 401 || status.as_u16() == 403 {
            break;
        }
    }
    let Some(text) = text else {
        return Err(last_error);
    };
    parse_devin_status_json(&text, agent_type, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn parses_camel_case_plan_status() {
        let now = Utc.with_ymd_and_hms(2026, 9, 27, 12, 0, 0).unwrap();
        let reset = now.timestamp() + 7200;
        let raw = format!(
            r#"{{"userStatus":{{"planStatus":{{"planInfo":{{"planName":"Devin Pro"}},
                "dailyQuotaRemainingPercent":42.5,"weeklyQuotaRemainingPercent":80,
                "dailyQuotaResetAtUnix":{reset},"weeklyQuotaResetAtUnix":0,
                "acuConsumed":12.25,"acuLimit":150}}}}}}"#
        );
        let info = parse_devin_status_json(&raw, "custom:devin", now).unwrap();
        assert_eq!(info.agent_type, "custom:devin");
        assert_eq!(
            info.plan_name.as_deref(),
            Some("Devin Pro · 12.2 / 150 ACU")
        );
        let daily = info.short_window.unwrap();
        assert_eq!(daily.label, "Daily Quota");
        assert_eq!(daily.remaining_percent, 42.5);
        assert_eq!(daily.used_percent, 57.5);
        assert_eq!(daily.reset_in_seconds, Some(7200));
        let weekly = info.weekly_window.unwrap();
        assert_eq!(weekly.remaining_percent, 80.0);
        assert!(
            weekly.resets_at.is_none(),
            "a zero reset timestamp means unknown"
        );
    }

    #[test]
    fn accepts_snake_case_and_missing_fields() {
        let now = Utc::now();
        let raw = r#"{"user_status":{"plan_status":{"weekly_quota_remaining_percent":5}}}"#;
        let info = parse_devin_status_json(raw, "devin", now).unwrap();
        assert!(info.short_window.is_none());
        assert_eq!(info.weekly_window.unwrap().remaining_percent, 5.0);
        assert!(info.plan_name.is_none());
        let empty = parse_devin_status_json("{}", "devin", now).unwrap();
        assert!(empty.short_window.is_none() && empty.weekly_window.is_none());
    }

    #[test]
    fn accepts_int64_as_string() {
        let now = Utc.with_ymd_and_hms(2026, 9, 27, 12, 0, 0).unwrap();
        let raw = r#"{"userStatus":{"planStatus":{"dailyQuotaRemainingPercent":50,
            "dailyQuotaResetAtUnix":"1790755200","acuConsumed":"3.5","acuLimit":"100"}}}"#;
        let info = parse_devin_status_json(raw, "devin", now).unwrap();
        let daily = info.short_window.unwrap();
        assert_eq!(daily.resets_at.unwrap().timestamp(), 1_790_755_200);
        assert_eq!(info.plan_name.as_deref(), Some("3.5 / 100 ACU"));
    }

    #[test]
    fn versions_compare_numerically() {
        use std::cmp::Ordering;
        assert_eq!(
            compare_versions("3000.11.3", "3000.9.12"),
            Ordering::Greater
        );
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Less);
    }

    #[test]
    fn credentials_need_a_key_and_default_the_server() {
        assert!(parse_credentials("api_server_url = \"https://x\"\n").is_none());
        let (key, server) = parse_credentials("windsurf_api_key = \"k\"\n").unwrap();
        assert_eq!((key.as_str(), server.as_str()), ("k", DEFAULT_API_SERVER));
        let (_, server) = parse_credentials(
            "windsurf_api_key = \"k\"\napi_server_url = \"https://s.example/\"\n",
        )
        .unwrap();
        assert_eq!(server, "https://s.example");
    }
}
