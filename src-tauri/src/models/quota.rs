//! Agent quota and rate limit data models.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// One time-window quota metric (e.g. 5-hour rolling window or weekly quota).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuotaWindow {
    pub label: String,
    pub used_percent: f64,
    pub remaining_percent: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<DateTime<Utc>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reset_in_seconds: Option<i64>,
}

impl QuotaWindow {
    pub fn new(
        label: impl Into<String>,
        used_percent: f64,
        remaining_percent: f64,
        resets_at: Option<DateTime<Utc>>,
        reset_in_seconds: Option<i64>,
    ) -> Self {
        Self {
            label: label.into(),
            used_percent,
            remaining_percent,
            resets_at,
            reset_in_seconds,
        }
    }

    /// Calculate quota percentages and reset countdown from usage and limit counters.
    pub fn from_usage(
        label: impl Into<String>,
        used: f64,
        limit: f64,
        resets_at: Option<DateTime<Utc>>,
        now: Option<DateTime<Utc>>,
    ) -> Self {
        let (used_percent, remaining_percent) = if limit > 0.0 {
            let used_pct = (used / limit * 100.0).clamp(0.0, 100.0);
            (used_pct, 100.0 - used_pct)
        } else {
            (0.0, 100.0)
        };

        let reset_in_seconds = resets_at.map(|reset_time| {
            let current = now.unwrap_or_else(Utc::now);
            (reset_time - current).num_seconds().max(0)
        });

        Self {
            label: label.into(),
            used_percent,
            remaining_percent,
            resets_at,
            reset_in_seconds,
        }
    }
}

/// Spending limit information in USD.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendLimit {
    pub used_usd: f64,
    pub limit_usd: f64,
}

impl SpendLimit {
    pub fn new(used_usd: f64, limit_usd: f64) -> Self {
        Self {
            used_usd,
            limit_usd,
        }
    }
}

/// Consolidated quota and rate limit status for an agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuotaInfo {
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub short_window: Option<QuotaWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_window: Option<QuotaWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spend_limit: Option<SpendLimit>,
    pub last_updated: DateTime<Utc>,
}

impl AgentQuotaInfo {
    pub fn new(agent_type: impl Into<String>, last_updated: DateTime<Utc>) -> Self {
        Self {
            agent_type: agent_type.into(),
            plan_name: None,
            short_window: None,
            weekly_window: None,
            spend_limit: None,
            last_updated,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn test_quota_window_serialization_camel_case() {
        let resets_at = Utc.with_ymd_and_hms(2026, 9, 26, 20, 0, 0).unwrap();
        let window = QuotaWindow {
            label: "5-Hour Window".to_string(),
            used_percent: 35.5,
            remaining_percent: 64.5,
            resets_at: Some(resets_at),
            reset_in_seconds: Some(13156),
        };

        let json_str = serde_json::to_string(&window).expect("serialize QuotaWindow");
        assert!(json_str.contains("\"label\":\"5-Hour Window\""));
        assert!(json_str.contains("\"usedPercent\":35.5"));
        assert!(json_str.contains("\"remainingPercent\":64.5"));
        assert!(json_str.contains("\"resetsAt\":\"2026-09-26T20:00:00Z\""));
        assert!(json_str.contains("\"resetInSeconds\":13156"));

        let deserialized: QuotaWindow =
            serde_json::from_str(&json_str).expect("deserialize QuotaWindow");
        assert_eq!(deserialized, window);
    }

    #[test]
    fn test_spend_limit_serialization_camel_case() {
        let spend = SpendLimit {
            used_usd: 12.5,
            limit_usd: 50.0,
        };

        let json_str = serde_json::to_string(&spend).expect("serialize SpendLimit");
        assert!(json_str.contains("\"usedUsd\":12.5"));
        assert!(json_str.contains("\"limitUsd\":50.0"));

        let deserialized: SpendLimit =
            serde_json::from_str(&json_str).expect("deserialize SpendLimit");
        assert_eq!(deserialized, spend);
    }

    #[test]
    fn test_agent_quota_info_full_serialization() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 16, 20, 0).unwrap();
        let short_reset = Utc.with_ymd_and_hms(2026, 9, 26, 21, 0, 0).unwrap();
        let weekly_reset = Utc.with_ymd_and_hms(2026, 10, 1, 0, 0, 0).unwrap();

        let info = AgentQuotaInfo {
            agent_type: "codex".to_string(),
            plan_name: Some("ChatGPT Plus".to_string()),
            short_window: Some(QuotaWindow::new(
                "5-Hour Window",
                20.0,
                80.0,
                Some(short_reset),
                Some(16800),
            )),
            weekly_window: Some(QuotaWindow::new(
                "Weekly Window",
                55.0,
                45.0,
                Some(weekly_reset),
                Some(373200),
            )),
            spend_limit: Some(SpendLimit::new(5.0, 20.0)),
            last_updated: now,
        };

        let json_val = serde_json::to_value(&info).expect("to_value");
        assert_eq!(json_val["agentType"], "codex");
        assert_eq!(json_val["planName"], "ChatGPT Plus");
        assert_eq!(json_val["shortWindow"]["label"], "5-Hour Window");
        assert_eq!(json_val["shortWindow"]["usedPercent"], 20.0);
        assert_eq!(json_val["shortWindow"]["remainingPercent"], 80.0);
        assert_eq!(
            json_val["shortWindow"]["resetsAt"],
            "2026-09-26T21:00:00Z"
        );
        assert_eq!(json_val["shortWindow"]["resetInSeconds"], 16800);
        assert_eq!(json_val["weeklyWindow"]["label"], "Weekly Window");
        assert_eq!(json_val["spendLimit"]["usedUsd"], 5.0);
        assert_eq!(json_val["spendLimit"]["limitUsd"], 20.0);
        assert_eq!(json_val["lastUpdated"], "2026-09-26T16:20:00Z");

        let deserialized: AgentQuotaInfo =
            serde_json::from_value(json_val).expect("from_value AgentQuotaInfo");
        assert_eq!(deserialized, info);
    }

    #[test]
    fn test_agent_quota_info_partial_deserialization() {
        let raw_json = r#"{
            "agentType": "antigravity",
            "lastUpdated": "2026-09-26T16:20:00Z"
        }"#;

        let parsed: AgentQuotaInfo =
            serde_json::from_str(raw_json).expect("deserialize partial AgentQuotaInfo");
        assert_eq!(parsed.agent_type, "antigravity");
        assert_eq!(parsed.plan_name, None);
        assert_eq!(parsed.short_window, None);
        assert_eq!(parsed.weekly_window, None);
        assert_eq!(parsed.spend_limit, None);
    }

    #[test]
    fn test_quota_window_from_usage() {
        let now = Utc.with_ymd_and_hms(2026, 9, 26, 12, 0, 0).unwrap();
        let reset = Utc.with_ymd_and_hms(2026, 9, 26, 13, 0, 0).unwrap();

        let window = QuotaWindow::from_usage("Short Window", 25.0, 100.0, Some(reset), Some(now));
        assert_eq!(window.label, "Short Window");
        assert!((window.used_percent - 25.0).abs() < f64::EPSILON);
        assert!((window.remaining_percent - 75.0).abs() < f64::EPSILON);
        assert_eq!(window.reset_in_seconds, Some(3600));
    }
}
