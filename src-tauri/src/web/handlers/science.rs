use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::experts::{ExpertInstallStatus, LinkOp, LinkOpResult};
use crate::commands::science as science_commands;
use crate::commands::science::ScienceListItem;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScienceIdParams {
    pub skill_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyLinksParams {
    pub ops: Vec<LinkOp>,
}

pub async fn science_list() -> Result<Json<Vec<ScienceListItem>>, AppCommandError> {
    let result = science_commands::science_list()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn science_list_all_install_statuses(
) -> Result<Json<Vec<ExpertInstallStatus>>, AppCommandError> {
    let result = science_commands::science_list_all_install_statuses()
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn science_apply_links(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyLinksParams>,
) -> Result<Json<Vec<LinkOpResult>>, AppCommandError> {
    let result = science_commands::science_apply_links_core(&state.emitter, params.ops)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}

pub async fn science_read_content(
    Json(params): Json<ScienceIdParams>,
) -> Result<Json<String>, AppCommandError> {
    let result = science_commands::science_read_content(params.skill_id)
        .await
        .map_err(|e| AppCommandError::from(&e))?;
    Ok(Json(result))
}
