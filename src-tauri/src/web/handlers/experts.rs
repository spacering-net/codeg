use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::experts as experts_commands;
use crate::commands::experts::{ExpertInstallStatus, ExpertListItem, LinkOp, LinkOpResult};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertIdParams {
    pub expert_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLinksParams {
    pub ops: Vec<LinkOp>,
}

pub async fn experts_list() -> Result<Json<Vec<ExpertListItem>>, AppCommandError> {
    let result = experts_commands::experts_list()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn experts_list_all_install_statuses(
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    let result = experts_commands::experts_list_all_install_statuses()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn experts_apply_links(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyLinksParams>,
) -> Result<Json<Vec<LinkOpResult>>, AppCommandError> {
    let result = experts_commands::experts_apply_links_core(&state.emitter, params.ops)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn experts_read_content(
    Json(params): Json<ExpertIdParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = experts_commands::experts_read_content(params.expert_id)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn experts_open_central_dir() -> Result<Json<String>, AppCommandError> {
    let result = experts_commands::experts_open_central_dir()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}
