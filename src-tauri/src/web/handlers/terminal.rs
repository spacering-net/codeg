use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::terminal::prepare_credential_env;
use crate::terminal::manager::SpawnOptions;
use crate::terminal::types::{TerminalInfo, TerminalSnapshot};

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnParams {
    pub working_dir: String,
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdParams {
    pub terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKillParams {
    pub terminal_id: String,
    /// Stop the process but keep the terminal's final output (see
    /// `TerminalManager::stop`) instead of closing the terminal.
    #[serde(default)]
    pub keep_output: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn terminal_spawn(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalSpawnParams>,
) -> Result<Json<String>, AppCommandError> {
    let manager = &state.terminal_manager;
    let terminal_id = params
        .terminal_id
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let extra_env = prepare_credential_env(&state.data_dir);

    let id = manager
        .spawn_with_id(
            SpawnOptions {
                terminal_id,
                working_dir: params.working_dir,
                owner_window_label: "web".to_string(),
                shell: params.shell,
                initial_command: params.initial_command,
                extra_env,
                temp_files: vec![],
            },
            state.emitter.clone(),
        )
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;

    Ok(Json(id))
}

pub async fn terminal_write(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalWriteParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    manager
        .write(&params.terminal_id, params.data.as_bytes())
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn terminal_resize(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalResizeParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    manager
        .resize(&params.terminal_id, params.cols, params.rows)
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

/// Recent output of an already-running terminal — the re-attach half of
/// `terminal_spawn` (see the Tauri command of the same name).
pub async fn terminal_snapshot(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalIdParams>,
) -> Result<Json<TerminalSnapshot>, AppCommandError> {
    let manager = &state.terminal_manager;
    Ok(Json(manager.snapshot(&params.terminal_id)))
}

pub async fn terminal_kill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalKillParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    let result = if params.keep_output {
        manager.stop(&params.terminal_id)
    } else {
        manager.kill(&params.terminal_id)
    };
    result.map_err(|e| AppCommandError::task_execution_failed(e.to_string()))?;
    Ok(Json(()))
}

pub async fn terminal_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<TerminalInfo>>, AppCommandError> {
    let manager = &state.terminal_manager;
    let result = manager.list_with_exit_check(Some(&state.emitter));
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::TerminalKillParams;

    #[test]
    fn a_kill_without_keep_output_still_closes_the_terminal() {
        // Older clients send only the id, and that must stay a close.
        let close: TerminalKillParams =
            serde_json::from_str(r#"{"terminalId":"t"}"#).expect("close params");
        assert!(!close.keep_output);
        let stop: TerminalKillParams =
            serde_json::from_str(r#"{"terminalId":"t","keepOutput":true}"#).expect("stop params");
        assert!(stop.keep_output);
    }
}
