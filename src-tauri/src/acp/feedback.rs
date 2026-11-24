//! Live user-feedback ("steering") domain types.
//!
//! While an agent is mid-turn the user can submit short notes / corrections
//! from the conversation UI. Those notes live on the connection's
//! [`crate::acp::session_state::SessionState`] (in-memory, turn-scoped — they
//! are real-time steering, not durable history, so they are intentionally NOT
//! persisted) and are pulled by the agent through the `check_user_feedback`
//! MCP tool exposed by `codeg-mcp`.
//!
//! This module holds the pieces shared across layers so the manager, the
//! delegation listener, the MCP companion plumbing, and the settings command
//! don't each grow their own copy:
//!   * [`FeedbackItem`] / [`FeedbackStatus`] — the stored note + its lifecycle.
//!   * [`PendingFeedback`] — a pending note read for delivery (id retained so
//!     the listener can mark it delivered only after the response is written).
//!   * `check_user_feedback` always returns an immediate snapshot (no wait).
//!   * [`SessionFeedbackAccess`] — the listener-facing trait the production
//!     `ConnectionManager` implements (kept here so the listener can be unit
//!     tested with an in-memory stub, mirroring `ParentSessionLookup`).
//!   * [`FeedbackRuntimeConfig`] — the hot-swappable "is the feature on?" flag,
//!     populated at startup and re-applied on settings save, read at MCP
//!     injection time (mirrors the delegation broker's config snapshot).

use std::sync::Arc;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

/// Lifecycle of a single feedback note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FeedbackStatus {
    /// Submitted by the user, not yet read by the agent.
    Pending,
    /// Returned to the agent by a `check_user_feedback` call.
    Delivered,
}

/// A user-submitted live-feedback note, stored on `SessionState.feedback`.
///
/// `id` is a per-note UUID so the submit/consume events stay idempotent on
/// replay (a snapshot-attaching client re-applying `FeedbackConsumed` for an
/// already-`Delivered` id is a safe no-op). Notes are turn-scoped: the
/// `UserMessage` event for the next turn clears the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FeedbackItem {
    pub id: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
    pub status: FeedbackStatus,
    /// When the agent read this note. `None` while `Pending`. On the native
    /// push path it is the submit instant (see [`Self::new_delivered`]) — a
    /// lower bound on the read rather than the read itself.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_at: Option<DateTime<Utc>>,
    /// What the user actually sent, when the note carried more than plain text
    /// (image attachments). `None` for a text-only note, which is every note on
    /// the pull channel and the historical native one — the frontend then
    /// renders `text` alone, exactly as before.
    ///
    /// Needed because `text` is the note's DISPLAY form: the composer collapses
    /// a draft's attachments into it, so a steered image would otherwise reach
    /// the live transcript as words about an image rather than the image. The
    /// projection is [`crate::acp::user_blocks_from_prompt`] applied AFTER
    /// hydration — the same contract `AcpEvent::UserMessage` follows for an
    /// ordinary prompt, so a steered message and a prompted one carry their
    /// images identically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<crate::acp::types::UserMessageBlock>>,
}

impl FeedbackItem {
    /// Build a fresh `Pending` note with a new id and the current timestamp.
    ///
    /// Always text-only: the pull tool (`check_user_feedback`) hands the agent a
    /// string, so `submit_feedback` refuses a draft carrying blocks on that
    /// channel rather than dropping them silently, and this constructor is only
    /// reached once that gate has passed.
    pub fn new_pending(id: String, text: String, created_at: DateTime<Utc>) -> Self {
        Self {
            id,
            text,
            created_at,
            status: FeedbackStatus::Pending,
            delivered_at: None,
            blocks: None,
        }
    }

    /// Build a note that is `Delivered` from birth — the native
    /// `_session/steering` path, where the adapter has ALREADY consumed the
    /// content by the time the note is recorded. Never `Pending`: that would
    /// let `read_pending_feedback` hand the same text to a `check_user_feedback`
    /// call and double-deliver it (the Pending-only read is the mutual
    /// exclusion between the push and pull channels).
    ///
    /// `at` is the SUBMIT instant, taken before the injection is handed to the
    /// adapter (`submit_feedback_native`), so `created_at` is provably earlier
    /// than the agent's own transcript copy of the message — the ordering the
    /// frontend needs to recognize that copy. `delivered_at` shares it, and is
    /// therefore a lower bound on the read rather than the read itself.
    ///
    /// `blocks` is `Some` only when the draft carried more than plain text; see
    /// the field's own doc for why `text` alone cannot stand in for it. Passing
    /// `None` reproduces the historical text-only note byte for byte.
    pub fn new_delivered(
        id: String,
        text: String,
        at: DateTime<Utc>,
        blocks: Option<Vec<crate::acp::types::UserMessageBlock>>,
    ) -> Self {
        Self {
            id,
            text,
            created_at: at,
            status: FeedbackStatus::Delivered,
            delivered_at: Some(at),
            blocks,
        }
    }
}

/// Per-note sanity bound for a live-feedback note, in characters. A steering
/// note is one line of guidance; the full text rides in the broadcast event,
/// the snapshot, and the MCP tool response, so this caps the blast radius of a
/// single pathological note. NOT a throughput limit — the per-turn note set is
/// cleared every turn, so its count scales with human typing, not unboundedly.
pub const MAX_FEEDBACK_CHARS: usize = 4096;

/// Per-TURN bound on the attachment bytes retained across a turn's notes.
///
/// [`MAX_FEEDBACK_CHARS`] bounds one note's text and leans on "the count scales
/// with human typing" for the rest — an argument that holds at 4 KiB a note and
/// does not survive base64 image data, which is three orders of magnitude
/// larger. Notes are turn-scoped but a turn is not short, so without an
/// aggregate bound a run of image steers grows `SessionState.feedback` (and
/// every snapshot built from it) without limit.
///
/// Exceeding it is NOT an error: the note is still delivered, it simply records
/// no blocks, so it renders from `text` alone — the same fallback a text-only
/// steer has always taken. Degrading a picture to its caption is the right
/// trade against refusing a message the agent has already been handed.
pub const MAX_FEEDBACK_ATTACHMENT_BYTES_PER_TURN: usize = 32 * 1024 * 1024;

/// Bytes a projected block list contributes to the per-turn attachment budget.
/// Only image payloads are counted: text rides the already-bounded `text`
/// field, and `user_blocks_from_prompt` has by this point folded every other
/// carriage into either an image or a markdown link.
pub fn attachment_bytes(blocks: &[crate::acp::types::UserMessageBlock]) -> usize {
    blocks
        .iter()
        .map(|b| match b {
            crate::acp::types::UserMessageBlock::Image { data, .. } => data.len(),
            crate::acp::types::UserMessageBlock::Text { .. } => 0,
        })
        .sum()
}

/// Hard ceiling on a single `check_user_feedback` RESPONSE's *serialized* size,
/// in bytes. Chosen well under the transport frame cap (`MAX_FRAME_BYTES` =
/// 16 MiB) AND low enough that the agent-facing MCP result — which repeats the
/// note text in both `content` and `structuredContent` (~2×) — also stays
/// comfortably bounded. Excess notes stay pending and drain on the agent's next
/// check: chunked delivery, never lost, never an oversized frame.
pub const MAX_FEEDBACK_RESPONSE_BYTES: usize = 4 * 1024 * 1024;

/// Upper bound on the bytes one note adds to the serialized response. Worst-case
/// JSON string escaping is 6 bytes per source byte (a control char → `\u00XX`);
/// the fixed term covers the `{"text":"","created_at":"<rfc3339>"},` wrapper.
/// Deliberately an OVER-estimate so the real frame is always smaller.
fn estimated_note_response_bytes(text: &str) -> usize {
    text.len().saturating_mul(6).saturating_add(128)
}

/// Bound a pending-feedback batch so its serialized `check_user_feedback`
/// response can't exceed `max_response_bytes` (and thus never the transport
/// frame cap), accounting for per-note JSON overhead — not just raw text length,
/// which a flood of tiny notes would slip past. Always returns at least the
/// first note (each is ≤ [`MAX_FEEDBACK_CHARS`], so one always fits) to
/// guarantee forward progress; the rest stay pending and drain on the next check.
pub fn bounded_feedback_batch(
    pending: Vec<PendingFeedback>,
    max_response_bytes: usize,
) -> Vec<PendingFeedback> {
    let mut out: Vec<PendingFeedback> = Vec::new();
    // Seed with the `{"count":NNN,"feedback":[]}` envelope overhead.
    let mut total: usize = 64;
    for p in pending {
        let cost = estimated_note_response_bytes(&p.text);
        if !out.is_empty() && total.saturating_add(cost) > max_response_bytes {
            break;
        }
        total = total.saturating_add(cost);
        out.push(p);
    }
    out
}

/// A pending note read for delivery. The `id` is retained (unlike the lean
/// shape sent to the agent) so the listener can mark it `Delivered` ONLY after
/// the tool response is successfully written to the companion — a dropped or
/// failed write must leave the note pending for the agent's next check
/// (at-least-once / retry-safe). Reading does NOT mutate state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingFeedback {
    pub id: String,
    pub text: String,
    pub created_at: DateTime<Utc>,
}

/// Listener-facing access to a parent connection's pending feedback. The
/// production impl (`ConnectionManagerFeedbackLookup`) wraps the
/// `ConnectionManager`; tests use an in-memory stub. Mirrors
/// `crate::acp::delegation::listener::ParentSessionLookup`.
///
/// Split into read + commit so the listener can guarantee at-least-once
/// delivery: it READS pending notes (no mutation, safe to abandon on
/// peer-close), writes the tool response, and only then COMMITS them as
/// delivered. A dropped/failed write skips the commit, leaving the notes
/// pending for the agent's next `check_user_feedback`.
#[async_trait]
pub trait SessionFeedbackAccess: Send + Sync {
    /// Read the pending feedback for the parent connection (resolved from the
    /// per-launch token) WITHOUT marking it delivered. Returns an immediate
    /// snapshot. Read-only: abandoning it (peer-close) leaves state untouched.
    /// Empty when the connection is gone or nothing is pending.
    async fn read_pending_feedback(
        &self,
        parent_connection_id: &str,
    ) -> Vec<PendingFeedback>;

    /// Mark the named notes `Delivered` and broadcast the consumption. Called by
    /// the listener ONLY after the tool response was written to the companion.
    /// Idempotent: ids already delivered (or gone) are skipped.
    async fn commit_feedback_delivered(&self, parent_connection_id: &str, ids: Vec<String>);
}

/// The hot-swappable feature config read at MCP injection time. Kept tiny and
/// separate from `DelegationConfig` so the two features toggle independently —
/// `codeg-mcp` is injected when EITHER is enabled, and each tool is listed only
/// when its own feature is on.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedbackConfig {
    pub enabled: bool,
}

/// Shared, hot-swappable handle to [`FeedbackConfig`]. Cloned into
/// `DelegationInjection` (read at injection) and `AppState` (updated on save).
/// Populated at startup by `apply_persisted_feedback_config` and re-applied by
/// `set_feedback_settings_core`, exactly like the delegation broker's config.
#[derive(Clone, Default)]
pub struct FeedbackRuntimeConfig {
    inner: Arc<RwLock<FeedbackConfig>>,
}

impl FeedbackRuntimeConfig {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn snapshot(&self) -> FeedbackConfig {
        self.inner.read().await.clone()
    }

    pub async fn set(&self, cfg: FeedbackConfig) {
        *self.inner.write().await = cfg;
    }

    /// Convenience read used at MCP injection time.
    pub async fn is_enabled(&self) -> bool {
        self.inner.read().await.enabled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feedback_item_new_pending_defaults() {
        let item = FeedbackItem::new_pending("id-1".into(), "use UserService".into(), Utc::now());
        assert_eq!(item.status, FeedbackStatus::Pending);
        assert!(item.delivered_at.is_none());
        assert_eq!(item.text, "use UserService");
    }

    #[test]
    fn pending_item_omits_delivered_at_on_wire() {
        let item = FeedbackItem::new_pending("id-1".into(), "hi".into(), Utc::now());
        let json = serde_json::to_string(&item).unwrap();
        assert!(
            !json.contains("delivered_at"),
            "a pending note must keep delivered_at off the wire"
        );
        assert!(json.contains("\"status\":\"pending\""));
    }

    #[tokio::test]
    async fn runtime_config_hot_swaps() {
        let cfg = FeedbackRuntimeConfig::new();
        assert!(!cfg.is_enabled().await);
        cfg.set(FeedbackConfig { enabled: true }).await;
        assert!(cfg.is_enabled().await);
        assert_eq!(cfg.snapshot().await, FeedbackConfig { enabled: true });
    }

    fn note(id: &str, text: &str) -> PendingFeedback {
        PendingFeedback {
            id: id.into(),
            text: text.into(),
            created_at: Utc::now(),
        }
    }

    #[test]
    fn bounded_batch_always_returns_at_least_one() {
        // A single note larger than the cap is still returned (forward progress).
        let big = note("big", &"x".repeat(1000));
        let out = bounded_feedback_batch(vec![big], 10);
        assert_eq!(out.len(), 1);
        // Empty in → empty out.
        assert!(bounded_feedback_batch(Vec::new(), 10).is_empty());
    }

    #[test]
    fn bounded_batch_caps_a_flood_of_tiny_notes_by_serialized_size() {
        // The regression: many TINY notes are little text but real per-note JSON
        // overhead. 350k 1-char notes are only ~350 KB of text yet serialize to
        // ~17 MB — they must be chunked, not all returned.
        let pending: Vec<PendingFeedback> =
            (0..350_000).map(|i| note(&format!("f{i}"), "x")).collect();
        let total = pending.len();
        let batch = bounded_feedback_batch(pending, MAX_FEEDBACK_RESPONSE_BYTES);
        assert!(
            batch.len() < total,
            "a flood of tiny notes must be chunked, not returned whole"
        );
        // The estimated serialized size of the returned batch stays within the
        // response cap (and thus far under the 16 MiB transport frame).
        let est: usize = 64
            + batch
                .iter()
                .map(|p| estimated_note_response_bytes(&p.text))
                .sum::<usize>();
        assert!(est <= MAX_FEEDBACK_RESPONSE_BYTES);
    }
}
