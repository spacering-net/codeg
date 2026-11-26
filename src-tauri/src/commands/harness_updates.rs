//! The update check of what was installed from Harness: what it last said
//! (`harness_updates`, no request) and "check now" (`harness_check_updates`).
//! The work is in `harness::updates`; these are the `_core` functions both
//! runtimes call, and the Tauri commands. The Web handlers are in
//! `web/handlers/harness_updates.rs`.
//!
//! Neither installs, updates or removes anything. `harness_updates` only
//! reads; a check `harness_check_updates` runs may switch off a plugin's
//! autorun parts SRN no longer vouches for (the plugins guard, see
//! `harness::updates`), as the scheduled check does. With
//! `CODEG_HARNESS=off` both answer `enabled: false` and nothing else, without
//! reading or asking anything. `codeg-mcp` exposes neither.

use crate::app_error::AppCommandError;
use crate::harness::updates::{HarnessUpdates, UpdateChecker};

fn joined(answer: Option<HarnessUpdates>) -> Result<HarnessUpdates, AppCommandError> {
    answer.ok_or_else(|| {
        AppCommandError::task_execution_failed("Harness updates: a blocking task failed")
    })
}

/// What the last check says of what is installed now. No request.
pub async fn harness_updates_core(
    checker: &UpdateChecker,
) -> Result<HarnessUpdates, AppCommandError> {
    joined(checker.updates().await)
}

/// Checks now if it is due — always when `explicit` (the user asked), else
/// only an hour after the last try — then answers as `harness_updates`.
pub async fn harness_check_updates_core(
    checker: &UpdateChecker,
    explicit: bool,
) -> Result<HarnessUpdates, AppCommandError> {
    joined(checker.check_now(explicit).await)
}

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::sync::Arc;

    use super::*;
    use crate::web::event_bridge::EventEmitter;

    /// The process's checker, for the data directory every other part of
    /// the app uses (see `commands::harness`).
    fn checker(app: &tauri::AppHandle) -> Arc<UpdateChecker> {
        use tauri::Manager;
        let data_dir = crate::paths::resolve_effective_data_dir(
            &app.path().app_data_dir().unwrap_or_default(),
        );
        crate::harness::updates::checker_for(&data_dir, &EventEmitter::from_app(app))
    }

    #[tauri::command]
    pub async fn harness_updates(app: tauri::AppHandle) -> Result<HarnessUpdates, AppCommandError> {
        harness_updates_core(&checker(&app)).await
    }

    #[tauri::command]
    pub async fn harness_check_updates(
        app: tauri::AppHandle,
        explicit: Option<bool>,
    ) -> Result<HarnessUpdates, AppCommandError> {
        harness_check_updates_core(&checker(&app), explicit.unwrap_or(false)).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
