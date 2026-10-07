//! Which of codex's usage reports read the context window.
//!
//! codex reports usage once per model request, and the context ring reads the
//! latest report as the occupancy: `last_token_usage.total_tokens` over
//! `model_context_window` — what codex's own status line counts as the tokens
//! in the context window, and what codex-acp forwards as `usage_update.used`.
//! That holds while a request is one pass over the conversation. A request that
//! runs a hosted web search is not: the provider runs the search loop
//! server-side, inside that one request, and reports usage for the whole loop —
//! the pages it read and, on some providers, a fresh pass over the conversation
//! per search — none of which the conversation keeps (codex records the
//! `web_search_call` items, not what they fetched). Issue #846 has 530 278 of a
//! 996 147-token window reported for such a request (53 %), then 74 215 for the
//! very next one, which re-sent the whole conversation. OpenAI's own models do
//! it too: a gpt-5.5 request that searched 13 times reported 248 708 input
//! tokens between neighbours of 143 695 and 150 661.
//!
//! So that report is set aside and the ring keeps the reading before it —
//! behind by the latest exchange until the next request reports, where the
//! searched report overstates the context by the whole loop. The live path
//! ([`crate::acp::connection`]) and the history parser
//! ([`crate::parsers::codex`]) sort their reports through [`ContextReadings`]
//! alike, so the ring, the session details and the work-task compaction
//! threshold all read the same figure.

use serde_json::Value;

/// Sorts codex's usage reports, in stream order, into context readings and the
/// reports of requests that ran a hosted web search.
#[derive(Debug, Default)]
pub(crate) struct ContextReadings {
    /// A hosted web search ran in the request now in flight.
    searched: bool,
    /// The latest report's `used`, and whether it was read as the context.
    latest: Option<(u64, bool)>,
}

impl ContextReadings {
    /// A hosted web search ran in the request now in flight.
    pub(crate) fn web_search_ran(&mut self) {
        self.searched = true;
    }

    /// A turn opened. A search whose request never reported (the turn was
    /// interrupted mid-request) has no report left to set aside.
    pub(crate) fn turn_started(&mut self) {
        self.searched = false;
    }

    /// Whether a usage report of `used` tokens reads the context window.
    ///
    /// A report repeating the latest one's figure is a restatement — older
    /// codex re-sends its latest report as each request opens — so it says
    /// nothing about the request now in flight: it keeps the latest report's
    /// verdict and leaves a pending search to the report it belongs to.
    pub(crate) fn admit(&mut self, used: u64) -> bool {
        if let Some((latest, read)) = self.latest {
            if latest == used {
                return read;
            }
        }
        let read = !std::mem::take(&mut self.searched);
        self.latest = Some((used, read));
        read
    }
}

/// Whether a codex-acp tool call's `rawInput` is a hosted web search. Through
/// 1.13.x codex-acp passed the app-server item's own `type` through
/// (`createWebSearchRawInput`); 2.0.0 sends codeg (an AIR client) only
/// `{query, action}` — see `air_contract::is_codex_web_search_input`, which
/// reads both.
pub(crate) fn is_web_search_input(raw_input: Option<&Value>) -> bool {
    crate::acp::air_contract::is_codex_web_search_input(raw_input)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_report_of_a_request_that_searched_is_set_aside() {
        let mut readings = ContextReadings::default();
        assert!(readings.admit(57_302));
        readings.web_search_ran();
        readings.web_search_ran();
        assert!(!readings.admit(530_278));
        assert!(readings.admit(79_334), "the search belonged to one request");
    }

    #[test]
    fn a_restatement_keeps_the_verdict_of_the_report_it_repeats() {
        let mut readings = ContextReadings::default();
        assert!(readings.admit(57_302));
        assert!(readings.admit(57_302));
        readings.web_search_ran();
        assert!(!readings.admit(530_278));
        assert!(!readings.admit(530_278));

        // A restatement arriving after the next request's search is not that
        // request's report, so the search stays pending for the real one.
        readings.web_search_ran();
        assert!(!readings.admit(530_278));
        assert!(!readings.admit(612_004));
        assert!(readings.admit(88_120));
    }

    #[test]
    fn a_search_whose_request_never_reported_ends_with_its_turn() {
        let mut readings = ContextReadings::default();
        readings.web_search_ran();
        readings.turn_started();
        assert!(readings.admit(12_000));
    }

    #[test]
    fn a_web_search_is_recognized_by_its_item_type() {
        let search = serde_json::json!({
            "type": "webSearch",
            "id": "ws_1",
            "query": "q",
            "action": {"type": "search", "query": "q"},
        });
        assert!(is_web_search_input(Some(&search)));
        // codex-acp's other `kind: "search"` calls carry no such type: a fuzzy
        // file search sends `{query}`, an `rg` it ran sends no `rawInput`.
        assert!(!is_web_search_input(Some(&serde_json::json!({"query": "q"}))));
        assert!(!is_web_search_input(None));
    }
}
