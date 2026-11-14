//! Opt-in, numeric-only frontend lifecycle diagnostics. No heap inspection,
//! arbitrary evaluation, user payloads, filesystem writes or persistent history.
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;

const MAX_WINDOWS: usize = 16;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const TTL: Duration = Duration::from_secs(300);

/// A closed vocabulary prevents accidentally forwarding text as metric names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryMetric {
    ProvidersActive,
    ProvidersMounted,
    ProvidersUnmounted,
    RetiredStoresTracked,
    RetiredStoresAlive,
    RetiredTrackersDropped,
    WeakRefsAvailable,
    ActiveTrackersDropped,
    SurfacesActive,
    SurfacesMounted,
    SurfacesUnmounted,
    Connections,
    PromptingConnections,
    LiveTextUnits,
    ToolTextUnits,
    LiveBlocks,
    OpenTabKeys,
    HydrationCaptures,
    HydrationEvents,
    UnmappedConnections,
    UnmappedEvents,
    StreamingEvents,
    PendingToolUpdates,
    EventSubscribers,
    RuntimeSessions,
    RuntimeDetailTurns,
    RuntimeLocalTurns,
    RuntimeBackgroundTurns,
    RuntimeOptimisticTurns,
    RuntimePendingBackgroundSettlements,
    RuntimeLiveBlocks,
    RuntimeSessionsRetired,
    RetiredRuntimeSessionsAlive,
    RuntimeTurnsRetired,
    RetiredRuntimeTurnsAlive,
    MessageViewsRetired,
    RetiredMessageViewsAlive,
    LifetimeTrackersDropped,
    HighlightCacheEntries,
    HighlightCacheEstimatedBytes,
    HighlightInFlight,
    HighlightWaiting,
    DocumentHidden,
    DocumentFocused,
    OverlayFoldRefetchEntries,
    SelectorsCacheEntries,
    IframeCount,
    HtmlFrames,
    HtmlFrameBytes,
    HtmlViews,
    HtmlViewBytes,
    HtmlPins,
    SampleDurationMicros,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrontendMemorySample {
    /// Ephemeral random renderer ID, never a session/path/window title.
    pub reporter_id: String,
    pub metrics: BTreeMap<MemoryMetric, u64>,
}

impl FrontendMemorySample {
    fn validate(&self) -> Result<(), AppCommandError> {
        if self.reporter_id.len() != 36 || uuid::Uuid::parse_str(&self.reporter_id).is_err() {
            return Err(AppCommandError::invalid_input(
                "Invalid diagnostic reporter ID",
            ));
        }
        if self.metrics.is_empty() || self.metrics.values().any(|value| *value > MAX_SAFE_INTEGER) {
            return Err(AppCommandError::invalid_input(
                "Invalid diagnostic counters",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendMemoryWindow {
    pub reporter_id: String,
    pub received_at_ms: u64,
    pub metrics: BTreeMap<MemoryMetric, u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendMemorySnapshot {
    pub enabled: bool,
    pub windows: Vec<FrontendMemoryWindow>,
}

#[derive(Default)]
struct Store {
    entries: BTreeMap<String, (Instant, FrontendMemoryWindow)>,
}

impl Store {
    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, (seen, _)| now.saturating_duration_since(*seen) < TTL);
    }

    fn report(&mut self, sample: FrontendMemorySample, now: Instant, wall_ms: u64) {
        self.prune(now);
        if !self.entries.contains_key(&sample.reporter_id) && self.entries.len() >= MAX_WINDOWS {
            if let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, (seen, _))| *seen)
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest);
            }
        }
        self.entries.insert(
            sample.reporter_id.clone(),
            (
                now,
                FrontendMemoryWindow {
                    reporter_id: sample.reporter_id,
                    received_at_ms: wall_ms,
                    metrics: sample.metrics,
                },
            ),
        );
    }

    fn snapshot(&mut self, now: Instant) -> Vec<FrontendMemoryWindow> {
        self.prune(now);
        self.entries
            .values()
            .map(|(_, value)| value.clone())
            .collect()
    }
}

static STORE: OnceLock<Mutex<Store>> = OnceLock::new();

/// Disabled builds allocate no store and accept no renderer reports.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub fn report_frontend_memory(sample: FrontendMemorySample) -> Result<(), AppCommandError> {
    if !cfg!(feature = "memory-diagnostics") {
        return Err(AppCommandError::invalid_input(
            "Frontend memory diagnostics are disabled in this build",
        ));
    }
    sample.validate()?;
    let wall_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    STORE
        .get_or_init(|| Mutex::new(Store::default()))
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .report(sample, Instant::now(), wall_ms);
    Ok(())
}

pub fn frontend_memory_snapshot() -> FrontendMemorySnapshot {
    let enabled = cfg!(feature = "memory-diagnostics");
    let windows = if enabled {
        STORE.get().map_or_else(Vec::new, |store| {
            store
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .snapshot(Instant::now())
        })
    } else {
        Vec::new()
    };
    FrontendMemorySnapshot { enabled, windows }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, count: u64) -> FrontendMemorySample {
        FrontendMemorySample {
            reporter_id: id.to_owned(),
            metrics: BTreeMap::from([(MemoryMetric::Connections, count)]),
        }
    }

    #[test]
    fn rejects_user_text_unknown_fields_and_invalid_numbers() {
        for json in [
            r#"{"reporterId":"opaque","metrics":{"prompt":"private"}}"#,
            r#"{"reporterId":"opaque","metrics":{"connections":"private"}}"#,
            r#"{"reporterId":"opaque","metrics":{"connections":-1}}"#,
            r#"{"reporterId":"opaque","metrics":{"connections":1},"title":"private"}"#,
        ] {
            assert!(serde_json::from_str::<FrontendMemorySample>(json).is_err());
        }
        assert!(sample("/private/path", 1).validate().is_err());
        assert!(sample(&"a".repeat(65), 1).validate().is_err());
        assert!(sample("opaque", MAX_SAFE_INTEGER + 1).validate().is_err());
        assert!(sample("12345678-1234-4234-8234-123456789abc", 1)
            .validate()
            .is_ok());
    }

    #[test]
    fn accepts_runtime_retention_metric_vocabulary() {
        let json = r#"{
            "reporterId": "12345678-1234-4234-8234-123456789abc",
            "metrics": {
                "runtimeSessions": 1,
                "runtimeDetailTurns": 2,
                "runtimeLocalTurns": 3,
                "runtimeBackgroundTurns": 4,
                "runtimeOptimisticTurns": 5,
                "runtimePendingBackgroundSettlements": 6,
                "runtimeLiveBlocks": 7,
                "overlayFoldRefetchEntries": 8,
                "selectorsCacheEntries": 9,
                "runtimeSessionsRetired": 10,
                "retiredRuntimeSessionsAlive": 0,
                "runtimeTurnsRetired": 11,
                "retiredRuntimeTurnsAlive": 0,
                "messageViewsRetired": 12,
                "retiredMessageViewsAlive": 0,
                "lifetimeTrackersDropped": 0,
                "highlightCacheEntries": 13,
                "highlightCacheEstimatedBytes": 14,
                "highlightInFlight": 0,
                "highlightWaiting": 0,
                "documentHidden": 0,
                "documentFocused": 1
            }
        }"#;
        let parsed: FrontendMemorySample = serde_json::from_str(json).unwrap();
        parsed.validate().unwrap();
        assert_eq!(
            parsed.metrics[&MemoryMetric::RuntimePendingBackgroundSettlements],
            6
        );
        assert_eq!(parsed.metrics[&MemoryMetric::MessageViewsRetired], 12);
        assert_eq!(parsed.metrics[&MemoryMetric::DocumentFocused], 1);
        assert_eq!(
            parsed.metrics[&MemoryMetric::HighlightCacheEstimatedBytes],
            14
        );
    }

    #[test]
    fn replaces_reports_without_retaining_history() {
        let mut store = Store::default();
        let now = Instant::now();
        for count in 0..100 {
            store.report(sample("same", count), now, count);
        }
        let windows = store.snapshot(now);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].metrics[&MemoryMetric::Connections], 99);
    }

    #[test]
    fn bounds_reporters_and_evicts_the_oldest() {
        let mut store = Store::default();
        let now = Instant::now();
        for count in 0..20 {
            store.report(
                sample(&format!("window-{count}"), count),
                now + Duration::from_secs(count),
                count,
            );
        }
        let windows = store.snapshot(now + Duration::from_secs(20));
        assert_eq!(windows.len(), MAX_WINDOWS);
        assert!(!windows
            .iter()
            .any(|window| window.reporter_id == "window-0"));
        assert!(windows
            .iter()
            .any(|window| window.reporter_id == "window-19"));
    }

    #[test]
    fn expires_samples_without_relying_on_wall_clock() {
        let mut store = Store::default();
        let now = Instant::now();
        store.report(sample("old", 1), now, u64::MAX);
        assert_eq!(store.snapshot(now + Duration::from_secs(299)).len(), 1);
        assert!(store.snapshot(now + TTL).is_empty());
    }
}
