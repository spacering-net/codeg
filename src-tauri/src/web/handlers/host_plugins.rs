use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;
use uuid::Uuid;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::host_plugins::source::Registry;
use crate::host_plugins::{
    ExpectedPlugin, InstallPreview, InstalledPlugin, Mutation, PluginSettings, PluginUpdate,
    SettingsRequest, TurnActivity,
};

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
pub struct PreviewInstallParams {
    input: String,
    registry: Registry,
    expected: Option<ExpectedPlugin>,
}

#[derive(Deserialize)]
pub struct ConfirmInstallParams {
    ticket: Uuid,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityParams {
    plugin_id: String,
    folder_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallParams {
    plugin_id: String,
    method: String,
    input: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientHtmlParams {
    plugin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParams {
    plugin_id: String,
    request: SettingsRequest,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateParams {
    plugin_id: String,
}

#[derive(Deserialize)]
pub struct FetchIndexParams {
    url: String,
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
        .await
        .map(Json)
}

pub async fn settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsParams>,
) -> Result<Json<PluginSettings>, AppCommandError> {
    crate::commands::host_plugins::settings_core(
        &state.host_plugins,
        params.plugin_id,
        params.request,
    )
    .await
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

pub async fn call(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CallParams>,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    state
        .host_plugins
        .call(&params.plugin_id, params.method, params.input)
        .await
        .map(Json)
}

pub async fn client_html(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ClientHtmlParams>,
) -> Result<Json<Arc<str>>, AppCommandError> {
    state.host_plugins.client_html(&params.plugin_id).map(Json)
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

pub async fn update(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateParams>,
) -> Result<Json<PluginUpdate>, AppCommandError> {
    crate::commands::host_plugins::update_core(
        &state.host_plugins,
        &state.emitter,
        &params.plugin_id,
    )
    .await
    .map(Json)
}

pub async fn fetch_index(
    Json(params): Json<FetchIndexParams>,
) -> Result<Json<crate::host_plugins::source::PluginIndex>, AppCommandError> {
    crate::commands::host_plugins::fetch_index_core(&params.url)
        .await
        .map(Json)
}

pub async fn preview_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PreviewInstallParams>,
) -> Result<Json<InstallPreview>, AppCommandError> {
    crate::commands::host_plugins::preview_install_core(
        &state.host_plugins,
        &params.input,
        params.registry,
        params.expected,
    )
    .await
    .map(Json)
}

pub async fn confirm_install(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConfirmInstallParams>,
) -> Result<Json<Vec<InstalledPlugin>>, AppCommandError> {
    crate::commands::host_plugins::confirm_install_core(
        &state.host_plugins,
        &state.emitter,
        params.ticket,
    )
    .map(Json)
}
