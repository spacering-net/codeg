//! The personal agent's compaction rules: the pre-delivery decision, and the
//! streaks that pause auto-compaction on a session it cannot shrink.
//!
//! The reading, the threshold test and the command come from the kanban's
//! `work_task::compact` — the same feature, applied before every delivery
//! instead of before a resumed task round.

use serde::{Deserialize, Serialize};

use crate::work_task::compact;

/// What to do before a delivery.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum PreDelivery {
    /// Send the compact command first. `forced` after a context overflow:
    /// then the reading and the pause do not count.
    Compact { forced: bool },
    /// Deliver right away, for this reason (shown on the status panel).
    Deliver(&'static str),
}

/// Decide whether the next delivery compacts first.
///
/// `skip_once` is set right after any compaction attempt — successful,
/// failed, refused or canceled — so the batch that was waiting for it goes
/// out next: a failed compaction must not hold the owner's message back
/// behind another attempt.
pub fn decide(
    forced: bool,
    threshold: i32,
    paused: bool,
    skip_once: bool,
    percent: Option<f64>,
) -> PreDelivery {
    if skip_once {
        return PreDelivery::Deliver("skipped_after_attempt");
    }
    if forced {
        return PreDelivery::Compact { forced: true };
    }
    if threshold <= 0 {
        return PreDelivery::Deliver("disabled");
    }
    if paused {
        return PreDelivery::Deliver("paused");
    }
    match percent {
        None => PreDelivery::Deliver("usage_unknown"),
        Some(p) if compact::trips_threshold(p, threshold) => PreDelivery::Compact { forced: false },
        Some(_) => PreDelivery::Deliver("below"),
    }
}

/// Compactions in a row that did not help, per segment. Persisted with the
/// segment, so a restart does not reset the count.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Streaks {
    /// Auto-compactions in a row whose next normal turn still read at or
    /// above the threshold.
    #[serde(default)]
    pub ineffective: u32,
    /// Auto-compactions in a row that failed, were refused or were canceled.
    #[serde(default)]
    pub failures: u32,
    /// The last auto-compaction succeeded; judge it at the end of the next
    /// normal turn.
    #[serde(default)]
    pub judge_next_turn: bool,
}

/// How many unhelpful compactions in a row pause auto-compaction.
pub const PAUSE_AFTER: u32 = 2;

impl Streaks {
    /// Record how an auto-compaction ended. Returns whether to pause.
    pub fn after_compaction(&mut self, succeeded: bool) -> bool {
        if succeeded {
            self.failures = 0;
            self.judge_next_turn = true;
            false
        } else {
            self.failures += 1;
            self.judge_next_turn = false;
            self.failures >= PAUSE_AFTER
        }
    }

    /// Judge the last auto-compaction by the reading at the end of the first
    /// normal turn after it. Returns whether to pause. An unknown reading
    /// judges nothing.
    pub fn after_turn(&mut self, threshold: i32, percent: Option<f64>) -> bool {
        if !self.judge_next_turn {
            return false;
        }
        let Some(p) = percent else {
            return false;
        };
        self.judge_next_turn = false;
        if compact::trips_threshold(p, threshold) {
            self.ineffective += 1;
            self.ineffective >= PAUSE_AFTER
        } else {
            self.ineffective = 0;
            false
        }
    }

    /// A pause was lifted (by the owner, or a new segment): start over.
    pub fn reset(&mut self) {
        *self = Self::default();
    }
}

/// Whether an agent error reads as "the context is full". The adapters word
/// it differently, so this is a list of the phrasings seen in the wild; a miss
/// leaves the turn treated as an ordinary failure.
pub fn looks_like_context_overflow(message: &str, code: Option<&str>) -> bool {
    if matches!(code, Some("context_length_exceeded" | "context_overflow")) {
        return true;
    }
    let m = message.to_ascii_lowercase();
    [
        "prompt is too long",
        "context length",
        "context_length_exceeded",
        "maximum context",
        "context window",
        "too many tokens",
        "exceeds the context",
        "input is too long",
        "token limit",
    ]
    .iter()
    .any(|needle| m.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_decision_follows_the_kanban_threshold() {
        assert_eq!(
            decide(false, 70, false, false, Some(70.0)),
            PreDelivery::Compact { forced: false }
        );
        assert_eq!(decide(false, 70, false, false, Some(69.9)), PreDelivery::Deliver("below"));
        assert_eq!(decide(false, 0, false, false, Some(99.0)), PreDelivery::Deliver("disabled"));
        assert_eq!(decide(false, 70, true, false, Some(99.0)), PreDelivery::Deliver("paused"));
        assert_eq!(decide(false, 70, false, false, None), PreDelivery::Deliver("usage_unknown"));
    }

    #[test]
    fn an_overflow_forces_one_compaction_past_the_pause() {
        assert_eq!(
            decide(true, 0, true, false, None),
            PreDelivery::Compact { forced: true }
        );
        // …but never twice in a row: the batch waiting for it goes out next.
        assert_eq!(
            decide(true, 70, false, true, Some(99.0)),
            PreDelivery::Deliver("skipped_after_attempt")
        );
    }

    #[test]
    fn two_failures_in_a_row_pause() {
        let mut s = Streaks::default();
        assert!(!s.after_compaction(false));
        assert!(s.after_compaction(false));
        // A success in between resets the count.
        let mut s = Streaks::default();
        assert!(!s.after_compaction(false));
        assert!(!s.after_compaction(true));
        assert!(!s.after_compaction(false));
    }

    #[test]
    fn two_ineffective_compactions_in_a_row_pause() {
        let mut s = Streaks::default();
        s.after_compaction(true);
        assert!(!s.after_turn(70, Some(80.0)));
        // Only the first normal turn after a compaction is judged.
        assert!(!s.after_turn(70, Some(95.0)));
        s.after_compaction(true);
        assert!(s.after_turn(70, Some(75.0)));
        // One that worked resets it.
        let mut s = Streaks::default();
        s.after_compaction(true);
        assert!(!s.after_turn(70, Some(80.0)));
        s.after_compaction(true);
        assert!(!s.after_turn(70, Some(30.0)));
        s.after_compaction(true);
        assert!(!s.after_turn(70, Some(80.0)));
        // An unknown reading judges nothing and waits for a known one.
        let mut s = Streaks::default();
        s.after_compaction(true);
        assert!(!s.after_turn(70, None));
        assert!(s.judge_next_turn);
    }

    #[test]
    fn overflow_errors_are_recognized() {
        assert!(looks_like_context_overflow("Prompt is too long: 210000 tokens", None));
        assert!(looks_like_context_overflow("x", Some("context_length_exceeded")));
        assert!(looks_like_context_overflow(
            "This model's maximum context length is 128000 tokens",
            None
        ));
        assert!(!looks_like_context_overflow("rate limited", None));
    }
}
