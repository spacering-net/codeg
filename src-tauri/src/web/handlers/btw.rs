use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::btw as btw_commands;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwCreateParams {
    pub parent_connection_id: String,
    pub parent_conversation_id: i32,
    pub question: String,
}

pub async fn btw_create(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BtwCreateParams>,
) -> Result<Json<btw_commands::BtwCreateResult>, AppCommandError> {
    let result = btw_commands::btw_create_core(
        &state.db,
        &state.connection_manager,
        &state.emitter,
        &state.data_dir,
        &params.parent_connection_id,
        params.parent_conversation_id,
        params.question,
    )
    .await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtwPromoteParams {
    pub conversation_id: i32,
}

pub async fn btw_promote(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<BtwPromoteParams>,
) -> Result<Json<()>, AppCommandError> {
    btw_commands::btw_promote_core(&state.db, &state.emitter, params.conversation_id).await?;
    Ok(Json(()))
}
