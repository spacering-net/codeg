//! Shared, process-lived source of truth for an in-flight / completed app
//! self-update.
//!
//! The upgrade UI used to keep the only copy of the download progress in React
//! component state, so navigating away from the settings page (or closing it)
//! unmounted the component and lost the progress while the download kept
//! running underneath. This module moves that state into the backend — the
//! renderer becomes a pure subscriber that re-syncs from a snapshot on mount —
//! mirroring how `pet_state` lets a freshly-opened window pick up the current
//! ambient state.
//!
//! Both runtimes write here through the same small API:
//!   * desktop drives `tauri-plugin-updater` from `commands::app_update`;
//!   * the standalone server drives the in-place swap from
//!     `web::handlers::app_update`.
//!
//! Both emit the same [`APP_UPDATE_STATE_CHANNEL`] event (the full snapshot on
//! every transition) and answer the same snapshot query, so the frontend has a
//! single mode-agnostic code path.

use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::update::runtime::UpdateCapability;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Channel name shared by the live event and the snapshot query.
pub const APP_UPDATE_STATE_CHANNEL: &str = "app_update_state";

/// Minimum gap between emitted `Downloading` frames. The snapshot is updated on
/// every chunk (so a mount-time query is always exact), but the live event is
/// throttled so a multi-MB download doesn't emit thousands of frames.
const PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(100);

/// Coarse lifecycle the frontend renders. The server's finer phases
/// (verify / extract / swap) and the desktop's post-download install both
/// collapse to [`AppUpdateLifecycle::Installing`] — the UI shows a determinate
/// bar only while `Downloading` and an indeterminate "installing…" otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppUpdateLifecycle {
    Idle,
    Downloading,
    Installing,
    ReadyToRestart,
    Restarting,
    Error,
}

/// Full update snapshot, emitted on every transition and returned by the
/// snapshot query. A flat struct (rather than a tagged enum) keeps the
/// TypeScript mirror a plain discriminated-by-`status` object and dodges
/// serde-flatten edge cases.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateState {
    /// Monotonic across every transition (bumped even for throttled-away
    /// frames). The renderer keeps only the highest-`seq` value it has seen, so
    /// a late-arriving snapshot can't clobber a fresher live event — and a
    /// post-throttle snapshot is always strictly newer than the last event,
    /// never mistaken for stale.
    pub seq: u64,
    pub status: AppUpdateLifecycle,
    /// Bytes downloaded so far (`Downloading` only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downloaded: Option<u64>,
    /// Total bytes from `Content-Length`, if the source reported it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Target version once known (desktop: the manifest check; server: filled
    /// in when the swap completes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Relaunch delay (ms) for the renderer countdown — set on `ReadyToRestart`
    /// in server mode so it matches the supervisor's actual relaunch delay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restart_delay_ms: Option<u64>,
    /// Supervisor probation window (s) — set on `ReadyToRestart` in server
    /// mode; the renderer watches the running version across it before
    /// declaring success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trial_seconds: Option<u64>,
    /// How a server restart is carried out (`supervised` / `reexec`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<UpdateCapability>,
    /// Raw error message (`Error` only). The frontend classifies it for
    /// display via `normalizeAppUpdateError` when there is no `error_info` to
    /// go by.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The failure behind `error` as the backend knew it (`Error` only): code,
    /// OS detail and, for a failure the backend can explain, an i18n key with
    /// its params (e.g. which directory could not be written). The frontend
    /// renders that in preference to classifying `error`. Absent when all the
    /// backend had was a string (the desktop updater's plugin errors).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_info: Option<AppCommandError>,
}

impl AppUpdateState {
    fn idle() -> Self {
        Self {
            seq: 0,
            status: AppUpdateLifecycle::Idle,
            downloaded: None,
            total: None,
            version: None,
            restart_delay_ms: None,
            trial_seconds: None,
            capability: None,
            error: None,
            error_info: None,
        }
    }

    /// Clear every per-operation field, preserving only `seq` (the caller bumps
    /// it). Used when entering a terminal/clean state so stale progress or a
    /// previous error never leaks into the new status.
    fn clear_operation_fields(&mut self) {
        self.downloaded = None;
        self.total = None;
        self.version = None;
        self.restart_delay_ms = None;
        self.trial_seconds = None;
        self.capability = None;
        self.error = None;
        self.error_info = None;
    }
}

pub type AppUpdateStateHandle = Arc<RwLock<AppUpdateState>>;

pub fn new_handle() -> AppUpdateStateHandle {
    Arc::new(RwLock::new(AppUpdateState::idle()))
}

/// Read the current snapshot. Recovers a poisoned lock (a writer panicked
/// mid-update): the worst case is a momentarily stale snapshot, never a wedged
/// reader.
pub fn snapshot(handle: &AppUpdateStateHandle) -> AppUpdateState {
    handle
        .read()
        .map(|g| g.clone())
        .unwrap_or_else(|p| p.into_inner().clone())
}

/// Atomically claim the single system-op slot for a relaunch: transition to
/// `Restarting` IFF an update is staged (`ReadyToRestart`). Returns true if
/// claimed. Used as the authority check by BOTH the desktop `restart_app`
/// command and the server `restart_impl` handler. Because the check-and-set is
/// one `update_state` critical section, it also serializes concurrent restart
/// clicks and excludes a racing rollback/perform (whoever claims first wins).
pub fn try_claim_restart(handle: &AppUpdateStateHandle, emitter: &EventEmitter) -> bool {
    claim_restarting(handle, emitter, &[AppUpdateLifecycle::ReadyToRestart])
}

/// Atomically claim the single system-op slot for a rollback: transition to
/// `Restarting` IFF the lifecycle is settled (`Idle`/`Error`). Returns true if
/// claimed. Serializing against [`try_begin`] in one critical section is what
/// guarantees a rollback and a download can never both proceed — whoever claims
/// the state first wins, so the loser backs off before touching the op-lock or
/// the `.bak`.
pub fn try_claim_rollback(handle: &AppUpdateStateHandle, emitter: &EventEmitter) -> bool {
    claim_restarting(
        handle,
        emitter,
        &[AppUpdateLifecycle::Idle, AppUpdateLifecycle::Error],
    )
}

fn claim_restarting(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    allowed_from: &[AppUpdateLifecycle],
) -> bool {
    let snap = {
        let mut g = handle.write().unwrap_or_else(|p| p.into_inner());
        if !allowed_from.contains(&g.status) {
            return false;
        }
        g.seq += 1;
        g.clear_operation_fields();
        g.status = AppUpdateLifecycle::Restarting;
        g.clone()
    };
    emit_event(emitter, APP_UPDATE_STATE_CHANNEL, &snap);
    true
}

/// Apply `f` under the write lock, bump `seq`, then emit the resulting
/// snapshot. Used for every discrete transition (the per-chunk progress path
/// is throttled separately by [`ProgressEmitter`]).
fn mutate(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    f: impl FnOnce(&mut AppUpdateState),
) -> AppUpdateState {
    let snap = {
        let mut g = handle.write().unwrap_or_else(|p| p.into_inner());
        g.seq += 1;
        f(&mut g);
        g.clone()
    };
    emit_event(emitter, APP_UPDATE_STATE_CHANNEL, &snap);
    snap
}

/// Atomically start a fresh download **iff** the current state is terminal
/// (`Idle` / `Error`). Returns `(started, snapshot)`:
///   * `started == true` — the caller now owns the download and must drive it;
///   * `started == false` — a download is already in flight (or staged), so a
///     second click / second tab simply attaches to the in-flight snapshot.
///
/// The check-and-set happens in one write-lock critical section, so two
/// concurrent callers can never both start.
pub fn try_begin(handle: &AppUpdateStateHandle, emitter: &EventEmitter) -> (bool, AppUpdateState) {
    let snap = {
        let mut g = handle.write().unwrap_or_else(|p| p.into_inner());
        if !matches!(
            g.status,
            AppUpdateLifecycle::Idle | AppUpdateLifecycle::Error
        ) {
            return (false, g.clone());
        }
        g.seq += 1;
        g.clear_operation_fields();
        g.status = AppUpdateLifecycle::Downloading;
        g.downloaded = Some(0);
        g.clone()
    };
    emit_event(emitter, APP_UPDATE_STATE_CHANNEL, &snap);
    (true, snap)
}

/// Revert a just-claimed download back to `Idle` — but only if the state is
/// still exactly the one `try_begin` claimed (`claimed_seq` matches). Used when
/// a caller wins the [`try_begin`] race but then cannot acquire the op-lock (a
/// restart/rollback is in flight): it must yield the claim without clobbering
/// whatever that other operation has since written.
pub fn abort_claim(handle: &AppUpdateStateHandle, emitter: &EventEmitter, claimed_seq: u64) {
    let snap = {
        let mut g = handle.write().unwrap_or_else(|p| p.into_inner());
        if g.seq != claimed_seq {
            // A concurrent operation already moved the state on — leave it.
            return;
        }
        g.seq += 1;
        g.clear_operation_fields();
        g.status = AppUpdateLifecycle::Idle;
        g.clone()
    };
    emit_event(emitter, APP_UPDATE_STATE_CHANNEL, &snap);
}

/// Transition to the indeterminate finalize phase (server verify/extract/swap,
/// or desktop install after the bytes have landed).
pub fn set_installing(handle: &AppUpdateStateHandle, emitter: &EventEmitter) -> AppUpdateState {
    mutate(handle, emitter, |s| {
        s.status = AppUpdateLifecycle::Installing;
        s.downloaded = None;
        s.total = None;
    })
}

/// The new bytes are staged and the app is ready to relaunch into them.
/// `restart_delay_ms` / `trial_seconds` / `capability` are server-only
/// (the desktop app relaunches itself with no supervisor trial).
pub fn set_ready(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    version: Option<String>,
    restart_delay_ms: Option<u64>,
    trial_seconds: Option<u64>,
    capability: Option<UpdateCapability>,
) -> AppUpdateState {
    mutate(handle, emitter, |s| {
        s.clear_operation_fields();
        s.status = AppUpdateLifecycle::ReadyToRestart;
        s.version = version;
        s.restart_delay_ms = restart_delay_ms;
        s.trial_seconds = trial_seconds;
        s.capability = capability;
    })
}

/// The operation failed. The message is surfaced verbatim; the frontend
/// classifies it for the toast.
pub fn set_error(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    message: impl Into<String>,
) -> AppUpdateState {
    mutate(handle, emitter, |s| {
        s.clear_operation_fields();
        s.status = AppUpdateLifecycle::Error;
        s.error = Some(message.into());
    })
}

/// The operation failed with an [`AppCommandError`]: publish its message as
/// `error`, exactly like [`set_error`], plus the structured error itself as
/// `error_info` — which carries the explanation (i18n key and params) the
/// message alone would lose.
pub fn set_command_error(
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    err: &AppCommandError,
) -> AppUpdateState {
    mutate(handle, emitter, |s| {
        s.clear_operation_fields();
        s.status = AppUpdateLifecycle::Error;
        s.error = Some(err.to_string());
        s.error_info = Some(err.clone());
    })
}

/// Throttled writer for the per-chunk download progress. Owns the last-emit
/// timestamp so a hot download loop updates the snapshot on every chunk but
/// only emits a live frame every [`PROGRESS_EMIT_INTERVAL`].
pub struct ProgressEmitter {
    handle: AppUpdateStateHandle,
    emitter: EventEmitter,
    last_emit: std::sync::Mutex<Option<Instant>>,
}

impl ProgressEmitter {
    pub fn new(handle: AppUpdateStateHandle, emitter: EventEmitter) -> Self {
        Self {
            handle,
            emitter,
            last_emit: std::sync::Mutex::new(None),
        }
    }

    /// Record download progress. Always updates the snapshot; emits a live
    /// frame on the first byte, on completion, and at most once per interval in
    /// between. A late frame after the operation already left `Downloading` /
    /// `Installing` is ignored so it can't resurrect the bar.
    pub fn downloading(&self, downloaded: u64, total: Option<u64>) {
        let snap = {
            let mut g = self.handle.write().unwrap_or_else(|p| p.into_inner());
            if !matches!(
                g.status,
                AppUpdateLifecycle::Downloading | AppUpdateLifecycle::Installing
            ) {
                return;
            }
            g.seq += 1;
            g.status = AppUpdateLifecycle::Downloading;
            g.downloaded = Some(downloaded);
            if total.is_some() {
                g.total = total;
            }
            g.clone()
        };

        let complete = matches!(total, Some(t) if downloaded >= t && t > 0);
        let due = {
            let mut last = self.last_emit.lock().unwrap_or_else(|p| p.into_inner());
            let now = Instant::now();
            let due = downloaded == 0
                || complete
                || last.is_none_or(|t| now.duration_since(t) >= PROGRESS_EMIT_INTERVAL);
            if due {
                *last = Some(now);
            }
            due
        };
        if due {
            emit_event(&self.emitter, APP_UPDATE_STATE_CHANNEL, &snap);
        }
    }

    /// Convenience: transition to the install phase (the download-finished
    /// callback).
    pub fn installing(&self) {
        set_installing(&self.handle, &self.emitter);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::event_bridge::EventEmitter;

    #[test]
    fn try_begin_starts_once_then_attaches() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        let (started, snap) = try_begin(&h, &e);
        assert!(started, "first perform should start the download");
        assert_eq!(snap.status, AppUpdateLifecycle::Downloading);
        assert_eq!(snap.downloaded, Some(0));

        // A second perform while one is in flight attaches to it (returns the
        // live snapshot) instead of starting a duplicate.
        let (started2, snap2) = try_begin(&h, &e);
        assert!(!started2, "second perform must not start a second download");
        assert_eq!(snap2.status, AppUpdateLifecycle::Downloading);
        assert!(snap2.seq >= snap.seq, "seq is monotonic");
    }

    #[test]
    fn ready_to_restart_blocks_a_new_download() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        assert!(try_begin(&h, &e).0);
        set_ready(&h, &e, Some("1.2.3".into()), Some(2000), Some(30), None);

        // A staged, ready-to-restart update must not be clobbered by another
        // perform (which would overwrite the rollback `.bak`).
        let (started, snap) = try_begin(&h, &e);
        assert!(!started);
        assert_eq!(snap.status, AppUpdateLifecycle::ReadyToRestart);
        assert_eq!(snap.version.as_deref(), Some("1.2.3"));
        assert_eq!(snap.restart_delay_ms, Some(2000));
        assert_eq!(snap.trial_seconds, Some(30));
    }

    #[test]
    fn error_allows_a_retry_and_clears() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        assert!(try_begin(&h, &e).0);
        set_error(&h, &e, "network down");
        let snap = snapshot(&h);
        assert_eq!(snap.status, AppUpdateLifecycle::Error);
        assert_eq!(snap.error.as_deref(), Some("network down"));
        assert_eq!(snap.downloaded, None, "progress cleared on error");

        // Retrying from a terminal Error starts fresh and clears the message.
        let (started, snap2) = try_begin(&h, &e);
        assert!(started);
        assert_eq!(snap2.status, AppUpdateLifecycle::Downloading);
        assert!(snap2.error.is_none());
    }

    #[test]
    fn a_command_error_publishes_its_explanation_alongside_the_message() {
        let h = new_handle();
        let e = EventEmitter::Noop;
        let err = AppCommandError::permission_denied("Update target is not writable: /opt/codeg")
            .with_detail("Permission denied (os error 13)")
            .with_i18n(
                "SystemSettings.updateErrors.permissionDenied",
                std::collections::BTreeMap::from([("path".to_string(), "/opt/codeg".to_string())]),
            );

        assert!(try_begin(&h, &e).0);
        let snap = set_command_error(&h, &e, &err);

        // The wire shape the frontend reads: `error` stays the bare message for
        // clients that only classify strings, `errorInfo` carries the rest.
        let wire = serde_json::to_value(&snap).unwrap();
        assert_eq!(wire["status"], "error");
        assert_eq!(wire["error"], "Update target is not writable: /opt/codeg");
        assert_eq!(wire["errorInfo"]["code"], "permission_denied");
        assert_eq!(
            wire["errorInfo"]["i18n_key"],
            "SystemSettings.updateErrors.permissionDenied"
        );
        assert_eq!(wire["errorInfo"]["i18n_params"]["path"], "/opt/codeg");

        // A retry must not carry the old explanation into the new attempt.
        let (started, retry) = try_begin(&h, &e);
        assert!(started);
        assert!(retry.error_info.is_none());
        assert!(serde_json::to_value(&retry).unwrap().get("errorInfo").is_none());
    }

    #[test]
    fn seq_strictly_increases_across_transitions() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        let s0 = snapshot(&h).seq;
        try_begin(&h, &e);
        let s1 = snapshot(&h).seq;
        set_installing(&h, &e);
        let s2 = snapshot(&h).seq;
        set_ready(&h, &e, None, None, None, None);
        let s3 = snapshot(&h).seq;
        try_claim_restart(&h, &e);
        let s4 = snapshot(&h).seq;
        assert!(s0 < s1 && s1 < s2 && s2 < s3 && s3 < s4);
    }

    #[test]
    fn try_claim_restart_only_when_staged() {
        let h = new_handle();
        let e = EventEmitter::Noop;
        assert!(!try_claim_restart(&h, &e)); // idle
        try_begin(&h, &e);
        assert!(!try_claim_restart(&h, &e)); // downloading
        set_installing(&h, &e);
        assert!(!try_claim_restart(&h, &e)); // installing
        set_ready(&h, &e, None, None, None, None);
        // Staged: the claim succeeds and flips to Restarting…
        assert!(try_claim_restart(&h, &e));
        assert_eq!(
            snapshot(&h).status,
            AppUpdateLifecycle::Restarting
        );
        // …and a second (concurrent) restart click can no longer claim it.
        assert!(!try_claim_restart(&h, &e));
    }

    #[test]
    fn try_claim_rollback_only_when_settled() {
        let h = new_handle();
        let e = EventEmitter::Noop;
        // Settled (idle) → claims.
        assert!(try_claim_rollback(&h, &e));
        assert_eq!(snapshot(&h).status, AppUpdateLifecycle::Restarting);

        // While an upgrade is downloading / staged, rollback can't claim.
        let h2 = new_handle();
        try_begin(&h2, &e);
        assert!(!try_claim_rollback(&h2, &e));
        set_ready(&h2, &e, None, None, None, None);
        assert!(!try_claim_rollback(&h2, &e));
    }

    #[test]
    fn rollback_and_perform_claims_are_mutually_exclusive() {
        let e = EventEmitter::Noop;

        // Whoever claims the shared state first wins; the other backs off — so a
        // rollback and a download can never both proceed.
        let a = new_handle();
        assert!(try_begin(&a, &e).0); // perform claims Downloading
        assert!(!try_claim_rollback(&a, &e)); // rollback then can't claim

        let b = new_handle();
        assert!(try_claim_rollback(&b, &e)); // rollback claims Restarting
        assert!(!try_begin(&b, &e).0); // perform then attaches, doesn't start
    }

    #[test]
    fn abort_claim_reverts_only_its_own_claim() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        // Win the claim, then fail to get the op-lock: aborting reverts to Idle
        // so the user can retry once the conflicting op finishes.
        let (started, snap) = try_begin(&h, &e);
        assert!(started);
        abort_claim(&h, &e, snap.seq);
        assert_eq!(snapshot(&h).status, AppUpdateLifecycle::Idle);
    }

    #[test]
    fn abort_claim_leaves_a_state_a_concurrent_op_moved_on() {
        let h = new_handle();
        let e = EventEmitter::Noop;

        let (started, snap) = try_begin(&h, &e);
        assert!(started);
        // The state already moved on after our claim (e.g. the download task
        // set an error) — aborting with the now-stale seq must NOT clobber it
        // back to Idle.
        set_error(&h, &e, "download failed");
        abort_claim(&h, &e, snap.seq);
        assert_eq!(snapshot(&h).status, AppUpdateLifecycle::Error);
    }

    #[test]
    fn progress_emitter_keeps_snapshot_exact_every_chunk() {
        let h = new_handle();
        let e = EventEmitter::Noop;
        assert!(try_begin(&h, &e).0);

        let pe = ProgressEmitter::new(h.clone(), e);
        pe.downloading(40, Some(100));
        let snap = snapshot(&h);
        assert_eq!(snap.downloaded, Some(40));
        assert_eq!(snap.total, Some(100));
        // Even a throttled (non-emitted) frame updates the snapshot exactly, so
        // a mount-time query is never stale.
        pe.downloading(95, Some(100));
        assert_eq!(snapshot(&h).downloaded, Some(95));
    }
}
