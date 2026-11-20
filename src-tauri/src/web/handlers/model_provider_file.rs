use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::model_provider_file as mp_file;
use crate::models::model_provider_file::{
    BuiltinProviderInfo, ModelProviderDraft, ModelProviderRecord, ProbeOutcome, SaveResult,
    TestOutcome,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderIdParams {
    pub provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetEnabledParams {
    pub provider_id: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderParams {
    pub provider_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneBuiltinParams {
    pub builtin_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestModelParams {
    pub provider_id: String,
    pub model_id: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

/// Web transport mirrors Tauri's named-argument convention, so the draft
/// arrives wrapped (`{ draft: … }`) instead of as the bare draft object.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDraftParams {
    pub draft: ModelProviderDraft,
}

/// Same wrapper for probe, whose Tauri command also takes a named `params`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeParamsBody {
    pub params: mp_file::ProbeParams,
}

pub async fn list_model_provider_records(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<ModelProviderRecord>>, AppCommandError> {
    Ok(Json(
        mp_file::list_model_provider_records_core(&state.data_dir).await?,
    ))
}

pub async fn list_builtin_model_providers(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<BuiltinProviderInfo>>, AppCommandError> {
    Ok(Json(
        mp_file::list_builtin_model_providers_core(&state.data_dir).await?,
    ))
}

pub async fn create_model_provider(
    Extension(state): Extension<Arc<AppState>>,
    Json(body): Json<ProviderDraftParams>,
) -> Result<Json<SaveResult>, AppCommandError> {
    let result = mp_file::create_model_provider_core(&state.data_dir, body.draft).await?;
    mp_file::emit_event_for_web(&state.emitter);
    Ok(Json(result))
}

pub async fn update_model_provider(
    Extension(state): Extension<Arc<AppState>>,
    Json(body): Json<ProviderDraftParams>,
) -> Result<Json<SaveResult>, AppCommandError> {
    let result = mp_file::update_model_provider_core(&state.data_dir, body.draft).await?;
    mp_file::emit_event_for_web(&state.emitter);
    Ok(Json(result))
}

pub async fn delete_model_provider(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ProviderIdParams>,
) -> Result<Json<()>, AppCommandError> {
    mp_file::delete_model_provider_core(&state.data_dir, params.provider_id).await?;
    mp_file::emit_event_for_web(&state.emitter);
    Ok(Json(()))
}

pub async fn set_model_provider_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetEnabledParams>,
) -> Result<Json<()>, AppCommandError> {
    mp_file::set_model_provider_enabled_core(&state.data_dir, params.provider_id, params.enabled)
        .await?;
    mp_file::emit_event_for_web(&state.emitter);
    Ok(Json(()))
}

pub async fn reorder_model_providers(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ReorderParams>,
) -> Result<Json<()>, AppCommandError> {
    mp_file::reorder_model_providers_core(&state.data_dir, params.provider_ids).await?;
    mp_file::emit_event_for_web(&state.emitter);
    Ok(Json(()))
}

pub async fn clone_builtin_model_provider(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CloneBuiltinParams>,
) -> Result<Json<ModelProviderDraft>, AppCommandError> {
    Ok(Json(
        mp_file::clone_builtin_model_provider_core(&state.data_dir, params.builtin_id).await?,
    ))
}

pub async fn probe_model_provider_models(
    Json(body): Json<ProbeParamsBody>,
) -> Result<Json<ProbeOutcome>, AppCommandError> {
    Ok(Json(
        mp_file::probe_model_provider_models_core(body.params).await?,
    ))
}

pub async fn test_model_provider_model(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TestModelParams>,
) -> Result<Json<TestOutcome>, AppCommandError> {
    Ok(Json(
        mp_file::test_model_provider_model_core(
            &state.data_dir,
            params.provider_id,
            params.model_id,
            params.api_key,
        )
        .await?,
    ))
}
