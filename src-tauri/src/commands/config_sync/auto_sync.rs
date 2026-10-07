//! The background half of config sync: a timer that uploads when — and only
//! when — the local configuration actually changed.
//!
//! ## Why a periodic hash compare instead of marking dirty on write
//!
//! The obvious design is to flag "config changed" at each write site and
//! debounce. That works when writes funnel through a handful of save
//! functions; codeg's configuration writes are spread across `model_provider`,
//! `custom_agents`, `quick_messages`, `work_task`, and a dozen settings
//! commands, so instrumenting them is both a wide change and one that every
//! new feature can silently forget to make — and a forgotten write site means
//! a setting that never syncs, which is invisible until a user loses it.
//!
//! Collecting a snapshot is a handful of small queries over tens of KB, so
//! comparing its hash every few minutes costs less than the bookkeeping would,
//! cannot be forgotten by a future feature, and sends zero network traffic
//! when nothing changed.
//!
//! ## Upload only
//!
//! This loop never downloads. Pulling remote configuration is always an
//! explicit user action, because an automatic pull is indistinguishable from
//! "another machine silently overwrote my settings".

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde::Serialize;

use super::webdav_sync::{load_settings, load_state, upload_snapshot_core};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Emitted ONLY by this loop. A frontend receiving it knows the sync was
/// automatic; manual sync results come back as command return values, so the
/// UI never has to guess which action a status update belongs to.
pub const CONFIG_SYNC_STATUS_EVENT: &str = "config-sync://status";

/// Startup grace period. The first minutes after launch are the busiest —
/// migrations, agent probes, session scans — and a config upload is never
/// urgent.
const STARTUP_DELAY: Duration = Duration::from_secs(60);

/// Consecutive-failure cap for the backoff exponent: 16× the interval. At the
/// default 5 minutes that is ~80 minutes between attempts for a share that is
/// simply offline.
const MAX_BACKOFF_EXPONENT: u32 = 4;

/// How many suppression scopes are currently held. A counter, not a flag:
/// an import and a manual download can overlap, and a flag would let the first
/// one to finish re-enable syncing while the second is still writing.
static SUPPRESSION_DEPTH: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncStatusPayload {
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

/// Held while local configuration is being rewritten from a remote snapshot.
/// Released on drop, including on an early return or a panic — which matters,
/// because a leaked suppression would silently stop syncing for the rest of
/// the session.
pub struct AutoSyncSuppression {
    _private: (),
}

impl Drop for AutoSyncSuppression {
    fn drop(&mut self) {
        SUPPRESSION_DEPTH.fetch_sub(1, Ordering::AcqRel);
    }
}

pub fn suppress_auto_sync() -> AutoSyncSuppression {
    SUPPRESSION_DEPTH.fetch_add(1, Ordering::AcqRel);
    AutoSyncSuppression { _private: () }
}

pub fn is_auto_sync_suppressed() -> bool {
    SUPPRESSION_DEPTH.load(Ordering::Acquire) > 0
}

/// `interval * 2^min(failures, 4)`, saturating. Pure so the schedule is
/// testable without waiting for wall-clock time.
pub fn next_delay(interval_minutes: u32, consecutive_failures: u32) -> Duration {
    let interval = interval_minutes.max(1) as u64;
    let exponent = consecutive_failures.min(MAX_BACKOFF_EXPONENT);
    let minutes = interval.saturating_mul(1u64 << exponent);
    Duration::from_secs(minutes.saturating_mul(60))
}

/// Whether this tick should attempt an upload at all. Split out from the loop
/// so the skip rules are testable.
///
/// `configured` is separate from `enabled` because the two are set at
/// different moments: the switch is flipped on to reveal the credential form,
/// so "enabled with no server URL" is a state every user passes through.
/// Attempting it would fail on the empty URL, and the failure would be written
/// to `last_error` and shown in the panel as if the user's server had rejected
/// something.
pub fn should_attempt(enabled: bool, auto_sync: bool, configured: bool, suppressed: bool) -> bool {
    enabled && auto_sync && configured && !suppressed
}

/// Runs until the process exits. Reads settings every tick on purpose: turning
/// sync off in the UI takes effect at the next tick without restarting the
/// loop or plumbing a cancellation channel.
pub async fn run_auto_sync_loop(
    conn: DatabaseConnection,
    emitter: Arc<EventEmitter>,
    app_version: String,
) {
    tokio::time::sleep(STARTUP_DELAY).await;
    let mut consecutive_failures: u32 = 0;

    loop {
        let settings = load_settings(&conn).await;

        if !should_attempt(
            settings.enabled,
            settings.auto_sync,
            settings.is_configured(),
            is_auto_sync_suppressed(),
        ) {
            // Still honour the configured interval so a user who re-enables
            // sync does not wait out a stale backoff.
            tokio::time::sleep(next_delay(settings.interval_minutes, 0)).await;
            continue;
        }

        match upload_snapshot_core(&conn, &app_version, false).await {
            Ok(outcome) => {
                consecutive_failures = 0;
                // Only announce an upload that happened. A no-op tick would
                // otherwise repaint "last synced" every few minutes with a
                // timestamp nothing was written at.
                if outcome.uploaded {
                    let state = load_state(&conn).await;
                    emit_status(&emitter, &state.last_sync_at, &None);
                }
            }
            Err(err) => {
                consecutive_failures = consecutive_failures.saturating_add(1);
                tracing::warn!(
                    "[CONFIG-SYNC] auto sync failed ({consecutive_failures} in a row): {}",
                    err.message
                );
                let state = load_state(&conn).await;
                emit_status(&emitter, &state.last_sync_at, &Some(err.message));
            }
        }

        let settings = load_settings(&conn).await;
        tokio::time::sleep(next_delay(settings.interval_minutes, consecutive_failures)).await;
    }
}

fn emit_status(
    emitter: &EventEmitter,
    last_sync_at: &Option<String>,
    last_error: &Option<String>,
) {
    emit_event(
        emitter,
        CONFIG_SYNC_STATUS_EVENT,
        ConfigSyncStatusPayload {
            last_sync_at: last_sync_at.clone(),
            last_error: last_error.clone(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_grows_then_stops_growing() {
        assert_eq!(next_delay(5, 0), Duration::from_secs(5 * 60));
        assert_eq!(next_delay(5, 1), Duration::from_secs(10 * 60));
        assert_eq!(next_delay(5, 4), Duration::from_secs(80 * 60));
        // Capped: a share that has been offline for days must not schedule the
        // next attempt a year out.
        assert_eq!(next_delay(5, 99), next_delay(5, MAX_BACKOFF_EXPONENT));
    }

    #[test]
    fn a_zero_interval_never_becomes_a_busy_loop() {
        assert_eq!(next_delay(0, 0), Duration::from_secs(60));
    }

    #[test]
    fn suppression_is_reference_counted_and_released_on_drop() {
        assert!(!is_auto_sync_suppressed());
        {
            let _outer = suppress_auto_sync();
            assert!(is_auto_sync_suppressed());
            {
                let _inner = suppress_auto_sync();
                assert!(is_auto_sync_suppressed());
            }
            // The inner scope ending must NOT re-enable syncing while the
            // outer one is still applying a snapshot.
            assert!(is_auto_sync_suppressed());
        }
        assert!(!is_auto_sync_suppressed());
    }

    #[test]
    fn every_reason_to_skip_a_tick_is_honoured() {
        assert!(should_attempt(true, true, true, false));
        assert!(!should_attempt(false, true, true, false));
        assert!(!should_attempt(true, false, true, false));
        assert!(!should_attempt(true, true, true, true));
        // Switched on but never filled in: the state between flipping the
        // toggle and saving credentials must stay silent, not fail every
        // interval against an empty URL.
        assert!(!should_attempt(true, true, false, false));
    }

    #[test]
    fn a_settings_row_without_a_server_is_not_configured() {
        use super::super::webdav_sync::ConfigSyncSettings;

        let blank = ConfigSyncSettings {
            enabled: true,
            ..Default::default()
        };
        assert!(!blank.is_configured());
        assert!(!ConfigSyncSettings {
            server_url: "   ".to_string(),
            ..blank.clone()
        }
        .is_configured());
        assert!(ConfigSyncSettings {
            server_url: "https://dav.example.com/dav/".to_string(),
            ..blank
        }
        .is_configured());
    }
}
