//! HTTP endpoints for the file tree tab's content search. Thin wrappers over
//! the `_core` functions the Tauri commands use.

use axum::Json;

use crate::app_error::AppCommandError;
use crate::commands::workspace_search::{
    self as workspace_search_commands, CancelWorkspaceSearchParams, ContentSearchRequest,
    ContentSearchResult,
};

pub async fn search_workspace_content(
    Json(params): Json<ContentSearchRequest>,
) -> Result<Json<ContentSearchResult>, AppCommandError> {
    let result = workspace_search_commands::search_workspace_content_core(params).await?;
    Ok(Json(result))
}

pub async fn cancel_workspace_search(
    Json(params): Json<CancelWorkspaceSearchParams>,
) -> Result<Json<()>, AppCommandError> {
    workspace_search_commands::cancel_workspace_search_core(params.search_key).await?;
    Ok(Json(()))
}
