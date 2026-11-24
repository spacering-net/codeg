//! Web routes for OpenCode 2's provider credentials (see
//! `commands::opencode_credentials`).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::opencode_credentials::OpenCodeIntegration;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::opencode_credentials::{
    self as commands, OpenCodeConnectKeyRequest, OpenCodeCredentialChange,
};

pub async fn opencode_list_integrations(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<OpenCodeIntegration>>, AppCommandError> {
    commands::opencode_list_integrations_core(&state.db, &state.data_dir)
        .await
        .map(Json)
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeConnectKeyParams {
    pub request: OpenCodeConnectKeyRequest,
}

pub async fn opencode_connect_key(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OpenCodeConnectKeyParams>,
) -> Result<Json<OpenCodeCredentialChange>, AppCommandError> {
    let emitter = state.emitter.clone();
    commands::opencode_connect_key_core(
        params.request,
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        &emitter,
    )
    .await
    .map(Json)
    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeDisconnectProviderParams {
    pub integration_id: String,
}

pub async fn opencode_disconnect_provider(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<OpenCodeDisconnectProviderParams>,
) -> Result<Json<OpenCodeCredentialChange>, AppCommandError> {
    let emitter = state.emitter.clone();
    commands::opencode_disconnect_provider_core(
        &params.integration_id,
        &state.db,
        &state.connection_manager,
        &state.data_dir,
        &emitter,
    )
    .await
    .map(Json)
    .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}
