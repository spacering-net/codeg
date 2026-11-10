//! The "Allow command-line access" setting (`codeg-cli`).

use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::cli_run::CliAccessStatus;

pub async fn cli_access_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<CliAccessStatus>, AppCommandError> {
    Ok(Json(state.cli_access.status(&state.db.conn).await))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAccessSetEnabledParams {
    pub enabled: bool,
}

pub async fn cli_access_set_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CliAccessSetEnabledParams>,
) -> Result<Json<CliAccessStatus>, AppCommandError> {
    state
        .cli_access
        .set_enabled(&state.db.conn, params.enabled)
        .await
        .map(Json)
        .map_err(AppCommandError::task_execution_failed)
}
