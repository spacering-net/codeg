//! Asking a workspace window to open a tab, and hearing back which tab it is.
//!
//! A browser tab is not the backend's to create. `open_tab_core` needs an
//! owning window and a rectangle, and the native surface is built by the
//! frontend's `NativeSurfaceHost` when the tab becomes the one on screen — a
//! tab record the frontend does not know about would be an orphaned webview
//! painted over the UI, which is exactly what the events bridge sweeps away
//! when it mounts. So the backend asks (`browser://open-request`) and the
//! workspace answers.
//!
//! The asking has been fire-and-forget since deep links needed it. An agent
//! tool cannot be: `browser_open_tab` has to come back with the id of the tab
//! it opened, or the agent has no way to name the page it just asked for. This
//! is the little bit of plumbing that turns the event into a round trip.
//!
//! Two differences from [`crate::browser::confirm`], which this is otherwise
//! shaped after:
//!
//! * **Many at once.** Consent is deliberately one question for the whole app;
//!   opening a tab asks nobody anything, so two agents opening two tabs is two
//!   requests in flight, keyed by id.
//! * **The first answer wins.** Only the addressed window acts, but a document
//!   being replaced (a dev reload) can briefly leave two listening. A second
//!   answer to the same request is dropped rather than overwriting the first,
//!   which would hand the agent the id of a tab it did not get.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

/// How long the backend waits for a workspace window to take the request.
///
/// This is not a page load — it is one event out and one command back, in a
/// document that is already running. Anything beyond a few seconds means
/// nobody is listening: no window, a window still booting, a frontend wedged.
pub const ANSWER_TIMEOUT: Duration = Duration::from_secs(5);

/// How long the backend then waits for the tab to exist and commit a document.
///
/// Generous, because it covers a real navigation over a real network, and the
/// alternative to waiting is handing the agent a tab id that answers "still
/// loading" to everything. It is a cap, not a promise: a page still going when
/// it expires comes back as the tab it is, and the agent can read it later.
pub const SETTLE_TIMEOUT: Duration = Duration::from_secs(20);

/// After the page commits, how long to keep waiting for a sharing level to
/// appear on it.
///
/// The standing default (`browser-agent-grant.ts`) is applied by the FRONTEND
/// when it sees the page commit, so for one round trip after the commit the
/// tab genuinely has no grant yet. Reporting that would tell the agent
/// "nobody shared this" about a page that is about to be shared with it, and
/// the agent would relay a false instruction to the user.
pub const GRANT_GRACE: Duration = Duration::from_millis(1_500);

/// How often the settle wait re-reads the tab.
///
/// The registry has no change notification and one is not worth building for
/// this: the read is a mutex and a clone, and the thing being waited for
/// happens on a human/network timescale.
pub const POLL_INTERVAL: Duration = Duration::from_millis(50);

/// The open requests waiting for a window to answer.
///
/// Managed state, like the tab registry: the tool path arms one and the
/// command that carries the answer back reaches the same handle through the
/// `AppHandle`.
#[derive(Default)]
pub struct OpenRequests {
    pending: Mutex<HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>>,
}

impl OpenRequests {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, tokio::sync::oneshot::Sender<Option<String>>>> {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Register `request_id` and hand back the channel its answer arrives on.
    ///
    /// The receiver resolves with the backend tab id the workspace opened, or
    /// `None` when the workspace could not open one. It resolves as an error —
    /// which the caller reads as "nobody answered" — if the entry is dropped.
    pub fn arm(&self, request_id: &str) -> tokio::sync::oneshot::Receiver<Option<String>> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.lock().insert(request_id.to_string(), tx);
        rx
    }

    /// A window opened the tab (or failed to). `false` when the id names no
    /// waiting request — it timed out, or another document answered first.
    pub fn answer(&self, request_id: &str, tab_id: Option<String>) -> bool {
        let Some(tx) = self.lock().remove(request_id) else {
            return false;
        };
        // The receiver is gone when the asking side timed out between the
        // remove above and now; the answer has nowhere to go, and the tab it
        // names is a real tab the user can see either way.
        let _ = tx.send(tab_id);
        true
    }

    /// Nobody answered in time. Frees the entry so the map does not grow by
    /// one every time a request goes unheard.
    pub fn abandon(&self, request_id: &str) {
        self.lock().remove(request_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_answer_reaches_the_asker() {
        let requests = OpenRequests::new();
        let rx = requests.arm("r1");
        assert!(requests.answer("r1", Some("t7".into())));
        assert_eq!(rx.await, Ok(Some("t7".into())));
    }

    /// Two tabs can be asked for at once — unlike a consent dialog, opening a
    /// tab puts no question in front of anyone, so there is nothing to
    /// serialise.
    #[tokio::test]
    async fn two_requests_are_in_flight_at_once_and_do_not_cross() {
        let requests = OpenRequests::new();
        let first = requests.arm("r1");
        let second = requests.arm("r2");
        assert!(requests.answer("r2", Some("t2".into())));
        assert!(requests.answer("r1", Some("t1".into())));
        assert_eq!(first.await, Ok(Some("t1".into())));
        assert_eq!(second.await, Ok(Some("t2".into())));
    }

    /// A second document answering the same request changes nothing: the
    /// first answer is the tab the agent was told about, and replacing it
    /// would name a tab the agent never heard of.
    #[tokio::test]
    async fn the_first_answer_wins() {
        let requests = OpenRequests::new();
        let rx = requests.arm("r1");
        assert!(requests.answer("r1", Some("t1".into())));
        assert!(!requests.answer("r1", Some("t2".into())));
        assert_eq!(rx.await, Ok(Some("t1".into())));
    }

    /// An abandoned request is forgotten rather than left in the map, and a
    /// late answer to it is refused like any other stale one.
    #[tokio::test]
    async fn abandoning_frees_the_entry() {
        let requests = OpenRequests::new();
        let rx = requests.arm("r1");
        requests.abandon("r1");
        assert!(!requests.answer("r1", Some("t1".into())));
        assert!(rx.await.is_err());
        assert!(requests.lock().is_empty());
    }

    /// A workspace that could not open the tab says so, rather than going
    /// quiet and leaving the agent to wait out the timeout.
    #[tokio::test]
    async fn a_workspace_can_answer_that_it_opened_nothing() {
        let requests = OpenRequests::new();
        let rx = requests.arm("r1");
        assert!(requests.answer("r1", None));
        assert_eq!(rx.await, Ok(None));
    }
}
