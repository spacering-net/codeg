use std::sync::Arc;

use axum::extract::{Extension, Path};
use axum::Json;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::quota as quota_commands;
use crate::models::AgentQuotaInfo;

pub async fn get_agent_quota(
    Extension(state): Extension<Arc<AppState>>,
    Path(agent_type): Path<String>,
) -> Result<Json<AgentQuotaInfo>, AppCommandError> {
    let result = quota_commands::get_agent_quota_core(&state.quota_manager, &agent_type).await?;
    Ok(Json(result))
}

pub async fn refresh_agent_quota(
    Extension(state): Extension<Arc<AppState>>,
    Path(agent_type): Path<String>,
) -> Result<Json<AgentQuotaInfo>, AppCommandError> {
    let result =
        quota_commands::refresh_agent_quota_core(&state.quota_manager, &agent_type).await?;
    Ok(Json(result))
}
