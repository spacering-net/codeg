use std::collections::BTreeMap;
use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;
use serde_json::Value;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::mcp as mcp_commands;
use crate::commands::mcp::{
    LocalMcpScan, LocalMcpServer, McpAppType, McpMarketplaceItem, McpMarketplaceProvider,
    McpMarketplaceServerDetail,
};
use crate::commands::mcp_engine;
use crate::commands::mcp_engine::oauth::{
    McpOAuthBridgeDefinitionRequest, McpOAuthBridgeSnapshot, McpOAuthCancelRequest,
    McpOAuthCancelResult, McpOAuthCompleteCallbackRequest, McpOAuthRevokeRequest,
    McpOAuthRouteInfo, McpOAuthStartRequest, McpOAuthStartResult,
};
use crate::commands::mcp_engine::{
    McpAgentId, McpApplyRequest, McpApplyResult, McpInventory, McpOp, McpProbeRequest,
    McpProbeResult, McpSnippet,
};

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMarketplaceParams {
    pub provider_id: String,
    pub query: Option<String>,
    pub limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetMarketplaceServerDetailParams {
    pub provider_id: String,
    pub server_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallFromMarketplaceParams {
    pub provider_id: String,
    pub server_id: String,
    pub apps: Vec<McpAppType>,
    pub spec_override: Option<Value>,
    pub option_id: Option<String>,
    pub protocol: Option<String>,
    pub parameter_values: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertLocalServerParams {
    pub server_id: String,
    pub spec: Value,
    pub apps: Vec<McpAppType>,
    /// The spec the editor loaded before the edit; absent for a new server.
    #[serde(default)]
    pub shown_spec: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetServerAppsParams {
    pub server_id: String,
    pub apps: Vec<McpAppType>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveServerParams {
    pub server_id: String,
    pub apps: Option<Vec<McpAppType>>,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn mcp_scan_local() -> Json<LocalMcpScan> {
    Json(mcp_commands::mcp_scan_local().await)
}

pub async fn mcp_list_marketplaces() -> Result<Json<Vec<McpMarketplaceProvider>>, AppCommandError> {
    let result = mcp_commands::mcp_list_marketplaces().await?;
    Ok(Json(result))
}

pub async fn mcp_search_marketplace(
    Json(params): Json<SearchMarketplaceParams>,
) -> Result<Json<Vec<McpMarketplaceItem>>, AppCommandError> {
    let result =
        mcp_commands::mcp_search_marketplace(params.provider_id, params.query, params.limit)
            .await?;
    Ok(Json(result))
}

pub async fn mcp_get_marketplace_server_detail(
    Json(params): Json<GetMarketplaceServerDetailParams>,
) -> Result<Json<McpMarketplaceServerDetail>, AppCommandError> {
    let result =
        mcp_commands::mcp_get_marketplace_server_detail(params.provider_id, params.server_id)
            .await?;
    Ok(Json(result))
}

pub async fn mcp_install_from_marketplace(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<InstallFromMarketplaceParams>,
) -> Result<Json<LocalMcpServer>, AppCommandError> {
    let result = mcp_commands::mcp_install_from_marketplace_core(
        &state.emitter,
        params.provider_id,
        params.server_id,
        params.apps,
        params.spec_override,
        params.option_id,
        params.protocol,
        params.parameter_values,
    )
    .await?;
    Ok(Json(result))
}

pub async fn mcp_upsert_local_server(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpsertLocalServerParams>,
) -> Result<Json<LocalMcpServer>, AppCommandError> {
    let result = mcp_commands::mcp_upsert_local_server_core(
        &state.emitter,
        params.server_id,
        params.spec,
        params.apps,
        params.shown_spec,
    )
    .await?;
    Ok(Json(result))
}

pub async fn mcp_set_server_apps(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetServerAppsParams>,
) -> Result<Json<Option<LocalMcpServer>>, AppCommandError> {
    let result =
        mcp_commands::mcp_set_server_apps_core(&state.emitter, params.server_id, params.apps)
            .await?;
    Ok(Json(result))
}

pub async fn mcp_remove_server(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RemoveServerParams>,
) -> Result<Json<bool>, AppCommandError> {
    let result =
        mcp_commands::mcp_remove_server_core(&state.emitter, params.server_id, params.apps).await?;
    Ok(Json(result))
}

// ---------------------------------------------------------------------------
// The MCP engine (`commands::mcp_engine`)
// ---------------------------------------------------------------------------

pub async fn mcp_inventory(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<McpInventory>, AppCommandError> {
    Ok(Json(
        mcp_engine::mcp_inventory_at(&state.db, &state.data_dir).await?,
    ))
}

/// `mcp_apply`'s arguments, named as the desktop command names them.
#[derive(Deserialize)]
pub struct ApplyParams {
    #[serde(default)]
    pub basis: Option<BTreeMap<McpAgentId, String>>,
    pub ops: Vec<McpOp>,
    #[serde(default)]
    pub preflight: Option<bool>,
}

pub async fn mcp_apply(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ApplyParams>,
) -> Result<Json<McpApplyResult>, AppCommandError> {
    let request = McpApplyRequest {
        basis: params.basis.unwrap_or_default(),
        ops: params.ops,
        preflight: params.preflight.unwrap_or(false),
    };
    Ok(Json(
        mcp_engine::mcp_apply_core(
            &state.db,
            &state.emitter,
            &state.connection_manager,
            &state.data_dir,
            request,
        )
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct ParseSnippetParams {
    pub text: String,
}

pub async fn mcp_parse_snippet(
    Json(params): Json<ParseSnippetParams>,
) -> Result<Json<McpSnippet>, AppCommandError> {
    Ok(Json(mcp_engine::mcp_parse_snippet_core(&params.text)))
}

pub async fn mcp_probe(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpProbeRequest>,
) -> Json<McpProbeResult> {
    Json(mcp_engine::mcp_probe_at(&state.db, request, &state.data_dir).await)
}

pub async fn mcp_oauth_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<McpOAuthBridgeSnapshot>, AppCommandError> {
    state.mcp_oauth_bridge.mcp_oauth_list_core().await.map(Json)
}

pub async fn mcp_oauth_start(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpOAuthStartRequest>,
) -> Result<Json<McpOAuthStartResult>, AppCommandError> {
    state
        .mcp_oauth_bridge
        .mcp_oauth_start_core(request)
        .await
        .map(Json)
}

pub async fn mcp_oauth_complete_callback(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpOAuthCompleteCallbackRequest>,
) -> Result<Json<McpOAuthRouteInfo>, AppCommandError> {
    state
        .mcp_oauth_bridge
        .mcp_oauth_complete_callback_core(request)
        .await
        .map(Json)
}

pub async fn mcp_oauth_cancel(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpOAuthCancelRequest>,
) -> Result<Json<McpOAuthCancelResult>, AppCommandError> {
    state
        .mcp_oauth_bridge
        .mcp_oauth_cancel_core(request)
        .await
        .map(Json)
}

pub async fn mcp_oauth_revoke(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpOAuthRevokeRequest>,
) -> Result<Json<McpOAuthBridgeSnapshot>, AppCommandError> {
    state
        .mcp_oauth_bridge
        .mcp_oauth_revoke_core(request)
        .await
        .map(Json)
}

pub async fn mcp_oauth_bridge_definition(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<McpOAuthBridgeDefinitionRequest>,
) -> Result<Json<mcp_engine::model::McpDefinition>, AppCommandError> {
    state
        .mcp_oauth_bridge
        .mcp_oauth_bridge_definition_core(request)
        .await
        .map(Json)
}
