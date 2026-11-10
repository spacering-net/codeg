//! Per-prompt billing and wall time supplied by the ZCode ACP bridge.
//!
//! `usage_update` describes context occupancy, not a billable turn. These
//! counters are already cache-exclusive ACP usage; never subtract the cache
//! again or add the deprecated alias/standard context updates to them.
//!
//! The bridge reports each busy window as a running/ended pair, and the end
//! carries that window's own usage. One prompt can hold several windows: an
//! `/auto` or `/goal` loop runs every round inside the prompt that started it,
//! a sandbox approval re-runs the prompt as a continuation round, and a
//! compaction the prompt waited behind reports a window of its own. The bridge
//! scopes each report to one backend turn, so the prompt's usage is their sum.

pub(crate) const TURN_STATE_METHOD: &str = "_zcode/turnState";

pub(crate) fn is_turn_state_method(method: &str) -> bool {
    matches!(method, TURN_STATE_METHOD | "$/zcode/turnState")
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct TurnMetrics {
    pub usage: Option<serde_json::Value>,
    pub duration_ms: Option<u64>,
}

impl TurnMetrics {
    /// Replace the measurements on the ONE normal turn-end record rather than
    /// append a second end. Missing extras keep the ordinary Codeg-measured
    /// duration and do not fabricate billing usage.
    pub fn apply_to(&self, payload: &mut serde_json::Value) {
        if let Some(usage) = &self.usage {
            payload["usage"] = usage.clone();
        }
        if let Some(duration_ms) = self.duration_ms {
            payload["durationMs"] = duration_ms.into();
        }
    }
}

/// Constructed for each prompt, observed only inside its update drain, and
/// discarded when Codeg ends that prompt. Load replay and idle notifications
/// never enter this tracker. The protocol has no turn ID: its ordered
/// running/ended pairs and the sequential prompt boundary are the available
/// correlation markers. An end with no running report before it in this
/// prompt (a repeated end, or a late end of an earlier prompt) closes nothing.
#[derive(Debug, Default)]
pub(crate) struct TurnTracker {
    running: bool,
    /// Busy windows that closed during this prompt.
    windows: u32,
    /// Set once the windows' total no longer fits; no later window revives it.
    usage_unrepresentable: bool,
    metrics: Option<TurnMetrics>,
}

impl TurnTracker {
    pub fn observe(&mut self, method: &str, params: &serde_json::Value, session_id: &str) {
        if method != TURN_STATE_METHOD
            || params.get("sessionId").and_then(|v| v.as_str()) != Some(session_id)
        {
            return;
        }
        match params.get("running").and_then(|v| v.as_bool()) {
            Some(true) => self.running = true,
            Some(false) if self.running => {
                self.running = false;
                self.windows += 1;
                let metrics = self.metrics.get_or_insert_with(TurnMetrics::default);
                if let Some(report) = params.get("usage").and_then(valid_usage) {
                    if !self.usage_unrepresentable {
                        metrics.usage = match metrics.usage.take() {
                            Some(total) => add_usage(&total, &report),
                            None => Some(report),
                        };
                        self.usage_unrepresentable = metrics.usage.is_none();
                    }
                }
                // One window's clock is the prompt's own. Several leave gaps
                // between them (a compaction hold, judging the next round, a
                // restart) that only Codeg's measurement of the prompt spans.
                metrics.duration_ms = if self.windows == 1 {
                    params.get("turnMs").and_then(|v| v.as_u64())
                } else {
                    None
                };
            }
            _ => {}
        }
    }

    pub fn metrics(&self) -> Option<&TurnMetrics> {
        self.metrics.as_ref()
    }
}

/// Retain only unsigned ACP counters, without inventing missing values. A bad
/// counter drops the usage report as a whole; the independent clock can still
/// be used. Guard the four-bucket sum the history parser will compute as well.
fn valid_usage(value: &serde_json::Value) -> Option<serde_json::Value> {
    value.as_object()?;
    let mut counters = serde_json::Map::new();
    let mut total = 0_u64;
    let mut billing_counter = false;
    for key in [
        "inputTokens",
        "outputTokens",
        "cachedReadTokens",
        "cachedWriteTokens",
        "totalTokens",
        "thoughtTokens",
    ] {
        let Some(value) = value.get(key).filter(|v| !v.is_null()) else {
            continue;
        };
        let count = value.as_u64()?;
        if matches!(
            key,
            "inputTokens" | "outputTokens" | "cachedReadTokens" | "cachedWriteTokens"
        ) {
            total = total.checked_add(count)?;
            billing_counter = true;
        }
        counters.insert(key.to_string(), count.into());
    }
    billing_counter.then_some(serde_json::Value::Object(counters))
}

/// One more window's counters on top of the prompt's total, revalidated as a
/// whole. `None` when the sum no longer fits: the usage is dropped rather than
/// saturated into a number nobody reported.
fn add_usage(total: &serde_json::Value, report: &serde_json::Value) -> Option<serde_json::Value> {
    let mut sum = total.as_object()?.clone();
    for (key, count) in report.as_object()? {
        let prior = sum
            .get(key)
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        sum.insert(key.clone(), prior.checked_add(count.as_u64()?)?.into());
    }
    valid_usage(&serde_json::Value::Object(sum))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn start(tracker: &mut TurnTracker) {
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"s", "running":true}),
            "s",
        );
    }

    fn end() -> serde_json::Value {
        json!({"sessionId":"s", "running":false, "turnMs":4200,
            "usage":{"inputTokens":180,"outputTokens":350,"cachedReadTokens":900,
                "cachedWriteTokens":120,"thoughtTokens":200,"totalTokens":1550}})
    }

    #[test]
    fn an_ordered_terminal_report_keeps_cache_exclusive_usage_and_wall_time() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap(),
            &end()["usage"]
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, Some(4200));
    }

    #[test]
    fn aliases_other_sessions_and_unopened_ends_do_not_count() {
        let mut tracker = TurnTracker::default();
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"other", "running":true}),
            "s",
        );
        tracker.observe(
            "$/zcode/turnState",
            &json!({"sessionId":"s", "running":true}),
            "s",
        );
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        assert!(tracker.metrics().is_none());
        start(&mut tracker);
        tracker.observe("$/zcode/turnState", &end(), "s");
        assert!(tracker.metrics().is_none());
        tracker.observe(TURN_STATE_METHOD, &end(), "other");
        assert!(tracker.metrics().is_none());
    }

    #[test]
    fn a_repeated_end_counts_once_and_each_further_window_adds_its_report() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        let mut second = end();
        second["usage"]["inputTokens"] = json!(9999);
        second["turnMs"] = json!(1700);
        // The deprecated alias repeats the same transition, and an end with no
        // running report before it closes no window: neither counts again.
        tracker.observe("$/zcode/turnState", &second, "s");
        tracker.observe(TURN_STATE_METHOD, &second, "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap(),
            &end()["usage"]
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, Some(4200));
        // A second window (the next `/auto` round, a sandbox continuation) is
        // another backend turn with its own report. It adds up, and the clock
        // goes back to Codeg's measurement of the whole prompt.
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &second, "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap(),
            &json!({"inputTokens":10179,"outputTokens":700,"cachedReadTokens":1800,
                "cachedWriteTokens":240,"totalTokens":3100,"thoughtTokens":400})
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, None);
        let next = TurnTracker::default();
        assert!(
            next.metrics().is_none(),
            "a cancelled or rejected next prompt inherits nothing"
        );
    }

    #[test]
    fn a_window_without_a_report_still_hands_the_clock_back_to_codeg() {
        // A compaction the prompt waited behind settles its busy window bare;
        // the prompt's own round follows with the real report.
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"s","running":false}),
            "s",
        );
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &end(), "s");
        assert_eq!(
            tracker.metrics().unwrap().usage.as_ref().unwrap(),
            &end()["usage"]
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, None);
    }

    #[test]
    fn a_total_that_no_longer_fits_drops_the_usage_for_good() {
        let window = |tracker: &mut TurnTracker, input: u64| {
            start(tracker);
            tracker.observe(
                TURN_STATE_METHOD,
                &json!({"sessionId":"s","running":false,"usage":{"inputTokens":input}}),
                "s",
            );
        };
        let mut tracker = TurnTracker::default();
        window(&mut tracker, u64::MAX - 1);
        window(&mut tracker, 2);
        assert_eq!(tracker.metrics().unwrap().usage, None);
        window(&mut tracker, 5);
        assert_eq!(
            tracker.metrics().unwrap().usage,
            None,
            "a later window does not stand in for the whole prompt"
        );
    }

    #[test]
    fn absent_usage_does_not_fabricate_zero_counters() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(
            TURN_STATE_METHOD,
            &json!({"sessionId":"s","running":false}),
            "s",
        );
        assert_eq!(tracker.metrics(), Some(&TurnMetrics::default()));
    }

    #[test]
    fn malformed_counters_do_not_discard_a_valid_independent_clock() {
        for usage in [
            json!({"inputTokens":-1}),
            json!({"outputTokens":"3"}),
            json!({"inputTokens":1.5}),
            json!({"inputTokens":u64::MAX,"outputTokens":1}),
            json!({"totalTokens":10}),
            json!(null),
        ] {
            let mut tracker = TurnTracker::default();
            start(&mut tracker);
            tracker.observe(
                TURN_STATE_METHOD,
                &json!({"sessionId":"s","running":false,"usage":usage,"turnMs":0}),
                "s",
            );
            assert_eq!(tracker.metrics().unwrap().usage, None);
            assert_eq!(tracker.metrics().unwrap().duration_ms, Some(0));
        }
    }

    #[test]
    fn partial_usage_and_invalid_duration_remain_independent() {
        let mut tracker = TurnTracker::default();
        start(&mut tracker);
        tracker.observe(TURN_STATE_METHOD, &json!({"sessionId":"s","running":false,"usage":{"cachedReadTokens":42,"cachedWriteTokens":null,"other":"ignored"},"turnMs":-5}), "s");
        assert_eq!(
            tracker.metrics().unwrap().usage,
            Some(json!({"cachedReadTokens":42}))
        );
        assert_eq!(tracker.metrics().unwrap().duration_ms, None);
    }

    #[test]
    fn one_turn_end_retains_fallbacks_and_replaces_counters_instead_of_adding() {
        let mut payload = json!({"stopReason":"cancelled","model":"glm-test","durationMs":9999});
        TurnMetrics::default().apply_to(&mut payload);
        assert_eq!(payload["durationMs"], 9999);
        assert!(payload.get("usage").is_none());
        let metrics = TurnMetrics {
            usage: Some(end()["usage"].clone()),
            duration_ms: Some(4200),
        };
        metrics.apply_to(&mut payload);
        metrics.apply_to(&mut payload);
        assert_eq!(payload["usage"], end()["usage"]);
        assert_eq!(payload["durationMs"], 4200);
        assert_eq!(payload["stopReason"], "cancelled");
        assert_eq!(payload["model"], "glm-test");
    }
}
