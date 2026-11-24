use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::{app_error::AppCommandError, app_state::AppState, commands::project_knowledge};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Params {
    folder_id: i32,
    request: project_knowledge::Request,
}

pub async fn call(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<Params>,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    project_knowledge::run(
        &state.db.conn,
        &state.data_dir,
        params.folder_id,
        params.request,
    )
    .await
    .map(Json)
    .map_err(AppCommandError::invalid_input)
}
