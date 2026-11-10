use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::assistants as assistant_commands;
use crate::models::{AssistantDraft, AssistantInfo, AssistantPatch};

pub async fn assistant_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<AssistantInfo>>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_list_core(&state.db).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantCreateParams {
    pub draft: AssistantDraft,
}

pub async fn assistant_create(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AssistantCreateParams>,
) -> Result<Json<AssistantInfo>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_create_core(&state.emitter, &state.db, params.draft).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantUpdateParams {
    pub id: i32,
    pub patch: AssistantPatch,
}

pub async fn assistant_update(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AssistantUpdateParams>,
) -> Result<Json<AssistantInfo>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_update_core(
            &state.emitter,
            &state.db,
            params.id,
            params.patch,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantIdParams {
    pub id: i32,
}

pub async fn assistant_delete(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AssistantIdParams>,
) -> Result<Json<AssistantInfo>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_delete_core(&state.emitter, &state.db, params.id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantReorderParams {
    pub ids: Vec<i32>,
}

pub async fn assistant_reorder(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AssistantReorderParams>,
) -> Result<Json<Vec<AssistantInfo>>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_reorder_core(&state.emitter, &state.db, params.ids).await?,
    ))
}
