use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::assistants as assistant_commands;
use crate::models::AssistantInfo;

pub async fn assistant_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<AssistantInfo>>, AppCommandError> {
    Ok(Json(
        assistant_commands::assistant_list_core(&state.db).await?,
    ))
}
