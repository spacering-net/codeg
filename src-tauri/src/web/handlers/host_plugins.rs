use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::host_plugins::source::Registry;
use crate::host_plugins::{InstalledPlugin, Mutation, TurnActivity};

#[derive(Deserialize)]
pub struct ApplyParams {
    mutation: Mutation,
}

#[derive(Deserialize)]
pub struct InstallSourceParams {
    input: String,
    #[serde(default)]
    registry: Registry,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityParams {
    plugin_id: String,
    folder_id: i32,
}

pub async fn list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<InstalledPlugin>>, AppCommandError> {
    state.host_plugins.list().map(Json)
}

pub async fn apply(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyParams>,
) -> Result<Json<Vec<InstalledPlugin>>, AppCommandError> {
    crate::commands::host_plugins::apply_core(&state.host_plugins, &state.emitter, params.mutation)
        .map(Json)
}

pub async fn activity(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ActivityParams>,
) -> Result<Json<Vec<TurnActivity>>, AppCommandError> {
    state
        .host_plugins
        .activity(&params.plugin_id, params.folder_id)
        .map(Json)
}

pub async fn install_source(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<InstallSourceParams>,
) -> Result<Json<Vec<InstalledPlugin>>, AppCommandError> {
    crate::commands::host_plugins::install_source_core(
        &state.host_plugins,
        &state.emitter,
        &params.input,
        params.registry,
    )
    .await
    .map(Json)
}
