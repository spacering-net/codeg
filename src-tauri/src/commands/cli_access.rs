//! The "Allow command-line access" setting (`codeg-cli`) for the desktop;
//! the server's are `web::handlers::cli_access`.

use std::sync::Arc;

use crate::app_error::AppCommandError;
use crate::cli_run::command_tool::{self, CommandToolStatus};
use crate::cli_run::{CliAccess, CliAccessStatus};
use crate::db::AppDatabase;

#[tauri::command]
pub async fn cli_access_status(
    db: tauri::State<'_, AppDatabase>,
    access: tauri::State<'_, Arc<CliAccess>>,
) -> Result<CliAccessStatus, AppCommandError> {
    Ok(access.status(&db.conn).await)
}

#[tauri::command]
pub async fn cli_access_set_enabled(
    db: tauri::State<'_, AppDatabase>,
    access: tauri::State<'_, Arc<CliAccess>>,
    enabled: bool,
) -> Result<CliAccessStatus, AppCommandError> {
    access
        .set_enabled(&db.conn, enabled)
        .await
        .map_err(AppCommandError::task_execution_failed)
}

/// Settings → "Install command-line tool": whether `codeg-cli` is on the
/// user's PATH, and how it would get there.
#[tauri::command]
pub async fn cli_tool_status() -> Result<CommandToolStatus, AppCommandError> {
    tokio::task::spawn_blocking(command_tool::status)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

/// Put `codeg-cli` on the user's PATH; on macOS this may ask for an
/// administrator's password.
#[tauri::command]
pub async fn cli_tool_install() -> Result<CommandToolStatus, AppCommandError> {
    tokio::task::spawn_blocking(command_tool::install)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?
        .map_err(AppCommandError::task_execution_failed)
}
