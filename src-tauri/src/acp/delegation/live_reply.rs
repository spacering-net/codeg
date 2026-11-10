//! `ChildLiveReplyLookup` — broker capability that peeks at a still-running
//! delegation child's **in-memory** session to pull a one-line "what it's doing
//! right now" hint. The broker uses it to enrich `get_delegation_status`'s
//! running report from a bare `"Running."` into a two-line
//! `"Running.\nLatest sub-agent reply: …"`, so the parent LLM (and the user) can
//! see the child is genuinely making progress. The hint sits on its own line so
//! content-only hosts can anchor "still running" to the standalone first line
//! (see `attach_live_reply` in `super::broker`).
//!
//! Kept behind a trait for the same reason as [`super::meta_writer`] /
//! [`super::broker::ChildStatusLookup`]: the broker stays decoupled from
//! `ConnectionManager`, and unit tests can inject a deterministic reply without
//! a live ACP session. Production wires [`ConnectionManagerLiveReplyLookup`] via
//! [`super::broker::DelegationBroker::with_live_reply_lookup`].
//!
//! Lock-ordering note: the broker calls this **after** releasing its pending
//! mutex, so reading the child's `SessionState` (a separate `RwLock`) can never
//! invert lock order against the broker's own state.

use async_trait::async_trait;
use std::sync::Arc;

use crate::acp::delegation::types::{BlockedOn, DelegationProgress};
use crate::acp::manager::ConnectionManager;

/// Char budget for the inline live-reply hint — one tidy line, not a transcript.
/// Read by [`ConnectionManagerLiveReplyLookup`] and passed to
/// [`crate::acp::SessionState::latest_live_reply`].
pub const LIVE_REPLY_CAP: usize = 120;

/// Cap for the blocking prompt's label. Same reasoning as [`LIVE_REPLY_CAP`] —
/// this is one line of a tool report, not a transcript.
pub const BLOCKED_TITLE_CAP: usize = 120;

/// Capability the broker uses to fetch a running child's latest one-line reply.
#[async_trait]
pub trait ChildLiveReplyLookup: Send + Sync {
    /// The child's latest single-line activity, or `None` when it hasn't
    /// produced anything renderable yet / the connection is gone.
    async fn latest_reply(&self, child_connection_id: &str) -> Option<String>;

    /// What the child is parked on, if anything — a permission, a question, or
    /// a plan approval. `None` means it is genuinely working (or is gone).
    ///
    /// Defaulted to `None` so the Noop / mock impls and every test call site
    /// stay untouched; only the production lookup answers for real.
    async fn blocked_on(&self, _child_connection_id: &str) -> Option<BlockedOn> {
        None
    }

    /// The child's tool-call progress — the turn in flight, or the one that
    /// just ended (see [`crate::acp::SessionState::delegation_progress`]).
    /// Defaulted to `None` like [`Self::blocked_on`].
    async fn progress(&self, _child_connection_id: &str) -> Option<DelegationProgress> {
        None
    }
}

/// Default lookup — always `None`. Used by `DelegationBroker::new` / `with_writers`
/// (test callsites that don't exercise the live-reply enrichment); production
/// replaces it via `with_live_reply_lookup`.
#[derive(Default, Clone)]
pub struct NoopChildLiveReplyLookup;

#[async_trait]
impl ChildLiveReplyLookup for NoopChildLiveReplyLookup {
    async fn latest_reply(&self, _child_connection_id: &str) -> Option<String> {
        None
    }
}

/// Production impl backed by `ConnectionManager`. Reads the child connection's
/// live `SessionState` and asks it for a one-line progress hint. A missing
/// connection (child torn down between the status read and this call) collapses
/// to `None` — the report just stays `"Running."`.
#[derive(Clone)]
pub struct ConnectionManagerLiveReplyLookup {
    pub manager: Arc<ConnectionManager>,
}

#[async_trait]
impl ChildLiveReplyLookup for ConnectionManagerLiveReplyLookup {
    async fn latest_reply(&self, child_connection_id: &str) -> Option<String> {
        let state = self.manager.get_state(child_connection_id).await?;
        // Bind the guard to a local: `latest_live_reply` returns an owned String,
        // so nothing borrows the guard past this scope.
        let guard = state.read().await;
        guard.latest_live_reply(LIVE_REPLY_CAP)
    }

    async fn blocked_on(&self, child_connection_id: &str) -> Option<BlockedOn> {
        let state = self.manager.get_state(child_connection_id).await?;
        let guard = state.read().await;
        guard.blocking_prompt(BLOCKED_TITLE_CAP)
    }

    async fn progress(&self, child_connection_id: &str) -> Option<DelegationProgress> {
        let state = self.manager.get_state(child_connection_id).await?;
        let guard = state.read().await;
        guard.delegation_progress()
    }
}

#[cfg(any(test, feature = "test-utils"))]
pub mod mock {
    use super::*;

    use std::sync::Mutex;

    /// Returns a fixed reply for every lookup so broker tests can assert the
    /// running-status message composition without a live child session.
    ///
    /// `blocked` is interior-mutable so a test can flip a child into (and out
    /// of) a blocked state *while a status long-poll is parked* — which is
    /// exactly the transition `get_tasks_status` must wake on.
    #[derive(Default)]
    pub struct MockChildLiveReplyLookup {
        pub reply: Option<String>,
        blocked: Mutex<Option<BlockedOn>>,
        progress: Mutex<Option<DelegationProgress>>,
    }

    impl MockChildLiveReplyLookup {
        pub fn new(reply: Option<String>) -> Self {
            Self {
                reply,
                blocked: Mutex::new(None),
                progress: Mutex::new(None),
            }
        }

        /// Set (or clear) what every child looks blocked on from now on.
        pub fn set_blocked(&self, blocked: Option<BlockedOn>) {
            *self.blocked.lock().unwrap() = blocked;
        }

        /// Set (or clear) every child's progress from now on.
        pub fn set_progress(&self, progress: Option<DelegationProgress>) {
            *self.progress.lock().unwrap() = progress;
        }
    }

    #[async_trait]
    impl ChildLiveReplyLookup for MockChildLiveReplyLookup {
        async fn latest_reply(&self, _child_connection_id: &str) -> Option<String> {
            self.reply.clone()
        }

        async fn blocked_on(&self, _child_connection_id: &str) -> Option<BlockedOn> {
            self.blocked.lock().unwrap().clone()
        }

        async fn progress(&self, _child_connection_id: &str) -> Option<DelegationProgress> {
            self.progress.lock().unwrap().clone()
        }
    }
}
