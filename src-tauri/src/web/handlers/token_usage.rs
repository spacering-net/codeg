use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::token_usage::{
    token_usage_facets_core, token_usage_report_core, token_usage_status_core,
    token_usage_sync_core, TokenUsageSyncMode,
};
use crate::models::token_usage::{
    TokenUsageFacets, TokenUsageFilter, TokenUsageReport, TokenUsageSyncResult,
    TokenUsageSyncStatus,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageReportParams {
    pub filter: TokenUsageFilter,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSyncParams {
    #[serde(default)]
    pub mode: Option<TokenUsageSyncMode>,
}

pub async fn token_usage_report(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TokenUsageReportParams>,
) -> Result<Json<TokenUsageReport>, AppCommandError> {
    let report = token_usage_report_core(&state.db.conn, params.filter).await?;
    Ok(Json(report))
}

pub async fn token_usage_facets(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TokenUsageFacets>, AppCommandError> {
    let facets = token_usage_facets_core(&state.db.conn).await?;
    Ok(Json(facets))
}

pub async fn token_usage_status(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<TokenUsageSyncStatus>, AppCommandError> {
    let status = token_usage_status_core(&state.db.conn).await?;
    Ok(Json(status))
}

pub async fn token_usage_sync(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TokenUsageSyncParams>,
) -> Result<Json<TokenUsageSyncResult>, AppCommandError> {
    let result = token_usage_sync_core(
        &state.db.conn,
        &state.emitter,
        params.mode.unwrap_or_default(),
        &state.data_dir,
    )
    .await?;
    Ok(Json(result))
}
