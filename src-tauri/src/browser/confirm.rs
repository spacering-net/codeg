//! Asking the person, for one snippet, right now.
//!
//! `browser_eval` is the only tool on this surface that can stop and wait for
//! a human, and it does so for the people who asked it to: the built-in
//! browser settings decide whether each snippet is shown, and out of the box
//! they are not (see `browser::eval` for where that weight went instead).
//!
//! Nothing here knows about that setting. The question is asked the same way
//! either way — the frontend answers it, and an answer that comes back in a
//! millisecond is as much an answer as one that took a person forty seconds.
//! That is deliberate: it keeps one path to audit, and it means the rules
//! below hold for everyone, including someone who is never asked.
//!
//! For those who are, each snippet is its own question and this module never
//! keeps the answer — there is no "always allow" beside the code, because
//! somebody who turned this dialog on wants each snippet, and a button that
//! undid that is the one thing they did not ask for.
//!
//! Three rules hold this together, and all three are about consent fatigue
//! rather than about cryptography:
//!
//! * **One question at a time, for the whole app.** A person answering two
//!   dialogs cannot be sure which snippet the button they just pressed belongs
//!   to. A second request while one is open is refused outright
//!   ([`AskRefused::Busy`]) rather than queued behind it.
//! * **A refusal buys quiet.** An agent that can ask again the instant it is
//!   told no can ask two hundred times, and the two hundredth dialog is the
//!   one that gets a mis-click. After a "no" — or after nobody answered — that
//!   tab is refused without asking for [`EVAL_DECLINE_COOLDOWN`].
//! * **Silence is a refusal.** Nobody at the keyboard, no window mounted to
//!   show the dialog, an answer that never comes: all of them time out into
//!   "no". Never into "yes", and never into waiting forever, which would hang
//!   the agent's turn on an absent human.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// How long a dialog stands before the host answers "no" on the person's
/// behalf.
///
/// Long enough to read a screen of code and think about it; short enough that
/// an agent whose user has walked away gets a definite answer rather than a
/// turn that never ends. The frontend runs the same clock and refuses early,
/// so this is the backstop for a window that is not there at all.
pub const EVAL_CONFIRM_TIMEOUT: Duration = Duration::from_secs(120);

/// How long a tab stays un-askable after a refusal.
pub const EVAL_DECLINE_COOLDOWN: Duration = Duration::from_secs(15);

pub const EVAL_REQUEST_EVENT: &str = "browser://eval-request";

/// `browser://eval-request`: put this in front of the person and tell the host
/// what they said.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRequestPayload {
    /// Names this one question. Echoed back by the answer.
    pub request_id: String,
    pub tab_id: String,
    /// Only the window that owns the tab shows the dialog — the others are
    /// looking at something else, and two copies of one question is two
    /// chances to answer it differently.
    pub owner_window: String,
    /// The origin the grant is bound to, which is where the code will run.
    pub origin: String,
    /// The page's own title, for a person who has several tabs of one site.
    pub title: String,
    /// The snippet, verbatim and in full. Not summarised, not highlighted, not
    /// "the interesting part": approving code means approving all of it, and
    /// the host has already refused anything too long to read
    /// (`eval::MAX_EVAL_CODE_CHARS`).
    pub code: String,
    /// Unix milliseconds at which this lapses into a refusal.
    pub expires_at: i64,
}

/// Why a snippet was not put in front of anyone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AskRefused {
    /// Another snippet is already waiting for an answer.
    Busy,
    /// This tab refused one recently.
    CoolingDown,
}

struct Pending {
    request_id: String,
    tab_id: String,
    answer: tokio::sync::oneshot::Sender<bool>,
}

#[derive(Default)]
struct Inner {
    pending: Option<Pending>,
    /// Tab id → when it may be asked about again.
    cooling: HashMap<String, Instant>,
}

/// The one pending question, and which tabs are in their quiet period.
///
/// Managed state, like the tab registry: a process holds one, and the tool
/// path and the command that carries the answer back both reach it from the
/// `AppHandle`.
#[derive(Default)]
pub struct EvalConsent {
    inner: Mutex<Inner>,
}

impl EvalConsent {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Claim the one question slot for `tab_id`, or say why not.
    ///
    /// The receiver resolves with the person's answer; it is dropped — and so
    /// resolves as an error, which the caller reads as "no" — if the slot is
    /// taken over or the process is going away.
    pub fn arm(
        &self,
        tab_id: &str,
        request_id: String,
    ) -> Result<tokio::sync::oneshot::Receiver<bool>, AskRefused> {
        self.arm_at(tab_id, request_id, Instant::now())
    }

    /// [`Self::arm`] against a clock the caller names, for tests.
    pub fn arm_at(
        &self,
        tab_id: &str,
        request_id: String,
        now: Instant,
    ) -> Result<tokio::sync::oneshot::Receiver<bool>, AskRefused> {
        let mut inner = self.lock();
        // Expired entries go as they are passed, rather than needing a sweep:
        // the map only ever holds tabs someone asked about.
        inner.cooling.retain(|_, until| *until > now);
        if inner.cooling.contains_key(tab_id) {
            return Err(AskRefused::CoolingDown);
        }
        if inner.pending.is_some() {
            return Err(AskRefused::Busy);
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        inner.pending = Some(Pending {
            request_id,
            tab_id: tab_id.to_string(),
            answer: tx,
        });
        Ok(rx)
    }

    /// The person answered. `false` when the id names no waiting question —
    /// they answered one that had already lapsed, or a second window raced the
    /// first.
    pub fn decide(&self, request_id: &str, allow: bool) -> bool {
        self.decide_at(request_id, allow, Instant::now())
    }

    pub fn decide_at(&self, request_id: &str, allow: bool, now: Instant) -> bool {
        let mut inner = self.lock();
        let matches = inner
            .pending
            .as_ref()
            .is_some_and(|p| p.request_id == request_id);
        if !matches {
            return false;
        }
        let pending = inner.pending.take().expect("checked just above");
        if !allow {
            inner
                .cooling
                .insert(pending.tab_id.clone(), now + EVAL_DECLINE_COOLDOWN);
        }
        // The receiver is gone when the asking side timed out first; the
        // answer has nowhere to go, and the cooldown above is still right.
        let _ = pending.answer.send(allow);
        true
    }

    /// Nobody answered in time. Frees the slot and starts the quiet period, as
    /// a refusal does — an unanswered question is a room with nobody in it,
    /// and asking it again immediately would not find anyone either.
    pub fn abandon(&self, request_id: &str) {
        self.abandon_at(request_id, Instant::now());
    }

    pub fn abandon_at(&self, request_id: &str, now: Instant) {
        let mut inner = self.lock();
        let matches = inner
            .pending
            .as_ref()
            .is_some_and(|p| p.request_id == request_id);
        if !matches {
            return;
        }
        if let Some(pending) = inner.pending.take() {
            inner
                .cooling
                .insert(pending.tab_id, now + EVAL_DECLINE_COOLDOWN);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn one_question_at_a_time_across_the_whole_app() {
        let consent = EvalConsent::new();
        let _first = consent.arm("t1", "r1".into()).expect("slot is free");
        // A different tab is no excuse: the person can only answer one dialog
        // at a time, whichever page it is about.
        assert_eq!(consent.arm("t2", "r2".into()).err(), Some(AskRefused::Busy));
        assert!(consent.decide("r1", true));
        assert!(consent.arm("t2", "r3".into()).is_ok());
    }

    #[tokio::test]
    async fn the_answer_reaches_the_asker() {
        let consent = EvalConsent::new();
        let rx = consent.arm("t1", "r1".into()).unwrap();
        assert!(consent.decide("r1", true));
        assert_eq!(rx.await, Ok(true));
    }

    /// An answer to a question that is no longer waiting changes nothing — and
    /// in particular does not release the question that IS waiting.
    #[tokio::test]
    async fn an_answer_to_the_wrong_question_is_ignored() {
        let consent = EvalConsent::new();
        let rx = consent.arm("t1", "r1".into()).unwrap();
        assert!(!consent.decide("r-other", true));
        assert_eq!(consent.arm("t1", "r2".into()).err(), Some(AskRefused::Busy));
        assert!(consent.decide("r1", false));
        assert_eq!(rx.await, Ok(false));
    }

    /// Saying no quiets that tab, and only that tab.
    #[tokio::test]
    async fn a_refusal_buys_quiet_on_that_tab() {
        let consent = EvalConsent::new();
        let start = Instant::now();
        let _rx = consent.arm_at("t1", "r1".into(), start).unwrap();
        assert!(consent.decide_at("r1", false, start));
        assert_eq!(
            consent.arm_at("t1", "r2".into(), start).err(),
            Some(AskRefused::CoolingDown)
        );
        // Another tab is a different page and a different decision.
        assert!(consent.arm_at("t2", "r3".into(), start).is_ok());
        assert!(consent.decide_at("r3", true, start));
        // And the quiet ends.
        let later = start + EVAL_DECLINE_COOLDOWN + Duration::from_millis(1);
        assert!(consent.arm_at("t1", "r4".into(), later).is_ok());
    }

    /// Allowing does not start a cooldown: a person who says yes is working
    /// with the agent, and the next snippet is part of the same work.
    #[tokio::test]
    async fn saying_yes_does_not_quiet_the_tab() {
        let consent = EvalConsent::new();
        let start = Instant::now();
        let _rx = consent.arm_at("t1", "r1".into(), start).unwrap();
        assert!(consent.decide_at("r1", true, start));
        assert!(consent.arm_at("t1", "r2".into(), start).is_ok());
    }

    /// Nobody answered: the slot frees and the tab goes quiet, exactly as for
    /// a refusal. An empty room does not become a fuller one by being asked
    /// again straight away.
    #[tokio::test]
    async fn silence_frees_the_slot_and_quiets_the_tab() {
        let consent = EvalConsent::new();
        let start = Instant::now();
        let rx = consent.arm_at("t1", "r1".into(), start).unwrap();
        consent.abandon_at("r1", start);
        assert!(rx.await.is_err(), "the asker hears a dropped sender");
        assert_eq!(
            consent.arm_at("t1", "r2".into(), start).err(),
            Some(AskRefused::CoolingDown)
        );
        assert!(consent.arm_at("t2", "r3".into(), start).is_ok());
    }

    /// A late abandon must not take down the question that replaced it.
    #[tokio::test]
    async fn abandoning_a_stale_id_leaves_the_live_question_alone() {
        let consent = EvalConsent::new();
        let start = Instant::now();
        let _first = consent.arm_at("t1", "r1".into(), start).unwrap();
        assert!(consent.decide_at("r1", true, start));
        let rx = consent.arm_at("t1", "r2".into(), start).unwrap();
        consent.abandon_at("r1", start);
        assert!(consent.decide_at("r2", true, start));
        assert_eq!(rx.await, Ok(true));
    }
}
