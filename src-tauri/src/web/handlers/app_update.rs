//! In-place self-update endpoints for the standalone server / Docker
//! runtime: download+verify+swap (`perform_app_update`), relaunch
//! (`restart_app`), and revert (`rollback_app`).
//!
//! All three are gated behind the process-wide `system_op_lock` so a second
//! click can't race a download already in flight. On desktop (Tauri) builds
//! they hard-error — desktop updates through `tauri-plugin-updater`.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::update::runtime::UpdateCapability;
use crate::update::AppUpdateState;

/// Current update snapshot (in-flight download progress, ready-to-restart, or
/// error). Mode-agnostic: reads the shared in-memory handle both runtimes
/// write to, so the upgrade UI can re-sync after a navigation or reload.
/// Available in both desktop (embedded server) and standalone-server builds.
pub async fn app_update_state(Extension(state): Extension<Arc<AppState>>) -> Json<AppUpdateState> {
    Json(crate::update::state::snapshot(&state.update_state))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateActionResult {
    /// Version installed (perform) — absent for restart/rollback.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Whether the caller should follow up with `restart_app`.
    pub need_restart: bool,
    /// Relaunch delay (ms) the frontend countdown should use.
    pub restart_delay_ms: u64,
    /// Supervisor probation window (seconds) during which a freshly-upgraded
    /// worker that crashes is auto-rolled-back. 0 when there is no supervisor
    /// (re-exec mode): no auto-rollback, so the frontend need not wait it out.
    pub trial_seconds: u64,
    pub capability: UpdateCapability,
}

/// Kick off the download/verify/swap and return **immediately** with the
/// current snapshot (`Downloading`). The actual work runs in a detached task so
/// it survives the client navigating away, reloading, or dropping the
/// connection — progress is observed via the `app_update_state` event/snapshot,
/// not by holding this request open. Idempotent: a second call while one is in
/// flight just returns the live snapshot.
pub async fn perform_app_update(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AppUpdateState>, AppCommandError> {
    perform_impl(state).await.map(Json)
}

pub async fn restart_app(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UpdateActionResult>, AppCommandError> {
    restart_impl(state).map(Json)
}

pub async fn rollback_app(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UpdateActionResult>, AppCommandError> {
    rollback_impl(state).await.map(Json)
}

// ─── desktop build: not supported ────────────────────────────────────────

#[cfg(feature = "tauri-runtime")]
async fn perform_impl(_state: Arc<AppState>) -> Result<AppUpdateState, AppCommandError> {
    // The embedded server in a desktop build must never swap the desktop
    // binary with a server tarball; the desktop app updates through its own
    // `app_update` Tauri commands (tauri-plugin-updater).
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
fn restart_impl(_state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
async fn rollback_impl(_state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    Err(not_supported())
}

#[cfg(feature = "tauri-runtime")]
fn not_supported() -> AppCommandError {
    AppCommandError::invalid_input("In-place update is only available in server mode")
}

// ─── server build: the real thing ────────────────────────────────────────

#[cfg(not(feature = "tauri-runtime"))]
fn busy() -> AppCommandError {
    AppCommandError::already_exists("An update operation is already in progress")
}

/// Refuse on platforms where in-place self-update is not validated. Windows
/// server self-update is disabled (running-.exe swap + re-exec rebind are
/// untested there); the desktop Windows app updates via tauri-plugin-updater.
/// The probation window the frontend should wait out before declaring success,
/// in seconds — only meaningful under the supervisor (which performs the
/// auto-rollback). Re-exec mode has no supervisor, hence no trial.
#[cfg(not(feature = "tauri-runtime"))]
fn trial_seconds_value() -> u64 {
    match crate::update::runtime::capability() {
        UpdateCapability::Supervised => crate::update::runtime::upgrade_trial_secs(),
        _ => 0,
    }
}

#[cfg(not(feature = "tauri-runtime"))]
fn ensure_supported() -> Result<(), AppCommandError> {
    if cfg!(target_os = "windows") {
        return Err(AppCommandError::invalid_input(
            "In-place server self-update is not supported on Windows yet",
        ));
    }
    Ok(())
}

#[cfg(not(feature = "tauri-runtime"))]
async fn perform_impl(state: Arc<AppState>) -> Result<AppUpdateState, AppCommandError> {
    use crate::update::install::UpdatePhase;
    use crate::update::state as update_state;

    ensure_supported()?;

    // Perform-vs-perform mutual exclusion is the atomic `update_state` claim:
    // a second click or another client that finds a download already in flight
    // (or a staged / restarting op) gets that snapshot back and *attaches*,
    // never an error. This is gated by `try_begin`'s RwLock section, not the
    // op-lock, so there is no window where a concurrent caller sees `busy`.
    let (started, snap) = update_state::try_begin(&state.update_state, &state.emitter);
    if !started {
        return Ok(snap);
    }

    // We now own the `Downloading` claim. Acquire the op-lock to exclude a
    // concurrent restart/rollback for the whole download/verify/swap; the guard
    // moves into the detached task and is released only when it ends. If a
    // restart/rollback already holds it, yield our claim — but only if the state
    // is still the one we just set (a restart/rollback may have moved it on,
    // which we must not clobber) — and report busy.
    let guard = match state.system_op_lock.clone().try_lock_owned() {
        Ok(g) => g,
        Err(_) => {
            update_state::abort_claim(&state.update_state, &state.emitter, snap.seq);
            return Err(busy());
        }
    };

    // Detach the download so it outlives this request: the client may navigate
    // away, reload, or drop the socket, and axum would otherwise cancel the
    // handler future mid-swap. Progress flows through `app_update_state`.
    tokio::spawn(async move {
        let emitter = state.emitter.clone();
        let pe = std::sync::Arc::new(update_state::ProgressEmitter::new(
            state.update_state.clone(),
            emitter.clone(),
        ));
        let progress = move |phase: UpdatePhase, downloaded: u64, total: Option<u64>| match phase {
            UpdatePhase::Downloading => pe.downloading(downloaded, total),
            // verify / extract / swap all read as the indeterminate finalize.
            _ => pe.installing(),
        };

        // The op-lock `guard` is held for the whole download/verify/swap, then
        // released BEFORE the terminal state is published (see
        // `publish_after_releasing`): publishing the claimable `ReadyToRestart`
        // while still holding the lock would let a concurrent restart claim it,
        // fail to acquire the lock, and bounce a genuinely-staged update to
        // `Error`.
        let outcome = crate::update::install::perform_update(&state.data_dir, &progress).await;
        publish_after_releasing(guard, || match outcome {
            Ok(o) => {
                update_state::set_ready(
                    &state.update_state,
                    &emitter,
                    Some(o.version),
                    Some(crate::update::runtime::restart_delay_ms()),
                    Some(trial_seconds_value()),
                    Some(crate::update::runtime::capability()),
                );
            }
            Err(e) => {
                update_state::set_command_error(&state.update_state, &emitter, &e);
            }
        });
    });

    Ok(snap)
}

/// Run `publish` AFTER releasing the op-lock `guard`. A terminal *claimable*
/// state (`ReadyToRestart` / `Error`) must never be published while the lock is
/// still held: a concurrent `restart_impl` could claim the new state, fail to
/// acquire the still-held lock, and bounce a genuinely-staged update to `Error`
/// (losing it). Dropping first makes the lock free the instant the state
/// becomes claimable.
#[cfg(not(feature = "tauri-runtime"))]
fn publish_after_releasing<F: FnOnce()>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    publish: F,
) {
    drop(guard);
    publish();
}

#[cfg(not(feature = "tauri-runtime"))]
fn restart_impl(state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    ensure_supported()?;
    // Atomically claim the relaunch (flips the shared snapshot to `Restarting`)
    // — rejects a stale status-bar / second-window click unless an update is
    // genuinely staged, and serializes against a racing rollback/perform in the
    // single `update_state` critical section. Only a successful claim means no
    // other system op is running, so the op-lock below is free.
    if !crate::update::state::try_claim_restart(&state.update_state, &state.emitter) {
        return Err(AppCommandError::invalid_input(
            "No staged update to restart into",
        ));
    }
    // Hold the lock until the process exits so nothing slips into the flush
    // window and gets killed by the restart. Free after a successful claim; on
    // the unreachable failure path restore a terminal error rather than leaving
    // the snapshot stuck "restarting".
    let guard = state
        .system_op_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| {
            crate::update::state::set_error(
                &state.update_state,
                &state.emitter,
                "Another system operation is in progress",
            );
            busy()
        })?;
    let restart_delay_ms = crate::update::runtime::restart_delay_ms();
    crate::update::schedule_restart(guard);
    Ok(UpdateActionResult {
        version: None,
        need_restart: false,
        restart_delay_ms,
        trial_seconds: trial_seconds_value(),
        capability: crate::update::runtime::capability(),
    })
}

#[cfg(not(feature = "tauri-runtime"))]
async fn rollback_impl(state: Arc<AppState>) -> Result<UpdateActionResult, AppCommandError> {
    ensure_supported()?;
    // Atomically claim the rollback (flips to `Restarting`) only from a settled
    // state — rejects a stale rollback during a staged/in-flight upgrade, and
    // serializes against a racing `perform` in the single `update_state`
    // critical section: whoever claims the state first wins, so a download and a
    // rollback can never both proceed (which would clobber the `.bak`). A
    // successful claim means no other op is running, so the op-lock is free.
    if !crate::update::state::try_claim_rollback(&state.update_state, &state.emitter) {
        return Err(AppCommandError::invalid_input(
            "Cannot roll back while an update is in progress",
        ));
    }
    // Hold the lock until the process exits so nothing races the revert+relaunch.
    let guard = state
        .system_op_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| {
            crate::update::state::set_error(
                &state.update_state,
                &state.emitter,
                "Another system operation is in progress",
            );
            busy()
        })?;
    let restart_delay_ms = crate::update::runtime::restart_delay_ms();
    if let Err(e) = crate::update::install::rollback() {
        // Release the op-lock BEFORE publishing the claimable `Error` so a
        // concurrent perform/rollback that claims it can immediately take the
        // now-free lock (see `publish_after_releasing`).
        publish_after_releasing(guard, || {
            crate::update::state::set_command_error(&state.update_state, &state.emitter, &e);
        });
        return Err(e);
    }
    // Responds first, then exits/re-execs after a short flush delay — the lock
    // is held until the process dies, so nothing can race the relaunch.
    crate::update::schedule_restart(guard);
    Ok(UpdateActionResult {
        version: None,
        // Restart is already scheduled server-side; the client must not issue a
        // separate `restart_app` (which would just contend for the held lock).
        need_restart: false,
        restart_delay_ms,
        trial_seconds: 0,
        capability: crate::update::runtime::capability(),
    })
}

// `ensure_supported` rejects Windows, and the desktop build's `perform_impl` is
// the not-supported stub — so this concurrency test only applies to a server
// build on a supported platform.
#[cfg(all(test, not(feature = "tauri-runtime"), not(target_os = "windows")))]
mod tests {
    use super::*;
    use crate::update::state as update_state;

    #[tokio::test]
    async fn perform_attaches_to_an_in_flight_download_without_busy() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new_for_test(db, dir.path().to_path_buf()));

        // Simulate a download already in flight (what the first request's
        // `try_begin` would have set).
        let (started, _) = update_state::try_begin(&state.update_state, &state.emitter);
        assert!(started);

        // A second concurrent perform must return the live snapshot and attach —
        // never a `busy` error, and without driving a second download. `try_begin`
        // short-circuits before the op-lock or any network is touched.
        let result = perform_impl(state.clone())
            .await
            .expect("second perform attaches instead of erroring");
        assert_eq!(result.status, update_state::AppUpdateLifecycle::Downloading);

        // The op-lock was never taken on the attach path, so a follow-up restart
        // could still acquire it.
        assert!(state.system_op_lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn publish_runs_only_after_the_op_lock_is_released() {
        // The terminal state (ReadyToRestart/Error) must become claimable only
        // once the op-lock is free, or a concurrent restart could claim it, fail
        // the held lock, and bounce a staged update to Error. This proves the
        // guard is dropped BEFORE the publish callback runs.
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let guard = lock.clone().try_lock_owned().expect("acquire op-lock");
        let probe = lock.clone();
        let mut published = false;
        publish_after_releasing(guard, || {
            assert!(
                probe.try_lock().is_ok(),
                "op-lock still held while publishing a claimable state"
            );
            published = true;
        });
        assert!(published);
    }

    #[tokio::test]
    async fn restart_rejected_when_no_staged_update() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new_for_test(db, dir.path().to_path_buf()));

        // Fresh state is Idle — nothing is staged, so a (stale) restart click
        // must be rejected rather than rebooting into whatever is on disk.
        let err = restart_impl(state.clone()).unwrap_err();
        assert!(err.message.contains("No staged update"));
        // State untouched and the lock is free for a later legitimate op.
        assert_eq!(
            update_state::snapshot(&state.update_state).status,
            update_state::AppUpdateLifecycle::Idle
        );
        assert!(state.system_op_lock.try_lock().is_ok());
    }

    #[tokio::test]
    async fn rollback_rejected_when_update_staged() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new_for_test(db, dir.path().to_path_buf()));

        // An upgrade is staged awaiting restart. A stale rollback (e.g. a
        // confirm dialog opened while idle in another window) must be rejected
        // and must NOT flip the staged state to `restarting`.
        update_state::set_ready(
            &state.update_state,
            &state.emitter,
            Some("1.2.3".into()),
            Some(2000),
            Some(30),
            None,
        );
        let err = rollback_impl(state.clone()).await.unwrap_err();
        assert!(err.message.contains("Cannot roll back"));
        assert_eq!(
            update_state::snapshot(&state.update_state).status,
            update_state::AppUpdateLifecycle::ReadyToRestart
        );
        assert!(state.system_op_lock.try_lock().is_ok());
    }
}
