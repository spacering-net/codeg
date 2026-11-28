use std::sync::Arc;

use super::{
    McpDefinition, McpOAuthBridge, McpOAuthBridgeDefinitionRequest, McpOAuthBridgeSnapshot,
    McpOAuthCancelRequest, McpOAuthCancelResult, McpOAuthCompleteCallbackRequest,
    McpOAuthRevokeRequest, McpOAuthRouteInfo, McpOAuthStartRequest, McpOAuthStartResult,
    McpOAuthTransport, Result,
};

type BridgeState<'a> = tauri::State<'a, Arc<McpOAuthBridge>>;

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_list(bridge: BridgeState<'_>) -> Result<McpOAuthBridgeSnapshot> {
    bridge.mcp_oauth_list_core().await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_start(
    bridge: BridgeState<'_>,
    upstream_url: String,
    transport: Option<McpOAuthTransport>,
    resource_metadata_url: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    scopes: Option<Vec<String>>,
) -> Result<McpOAuthStartResult> {
    bridge
        .inner()
        .mcp_oauth_start_core(McpOAuthStartRequest {
            upstream_url,
            transport,
            resource_metadata_url,
            client_id,
            client_secret,
            scopes,
        })
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_complete_callback(
    bridge: BridgeState<'_>,
    flow_id: String,
    callback_url: String,
) -> Result<McpOAuthRouteInfo> {
    bridge
        .inner()
        .mcp_oauth_complete_callback_core(McpOAuthCompleteCallbackRequest {
            flow_id,
            callback_url,
        })
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_cancel(
    bridge: BridgeState<'_>,
    flow_id: String,
) -> Result<McpOAuthCancelResult> {
    bridge
        .mcp_oauth_cancel_core(McpOAuthCancelRequest { flow_id })
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_revoke(
    bridge: BridgeState<'_>,
    route_id: String,
) -> Result<McpOAuthBridgeSnapshot> {
    bridge
        .mcp_oauth_revoke_core(McpOAuthRevokeRequest { route_id })
        .await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn mcp_oauth_bridge_definition(
    bridge: BridgeState<'_>,
    route_id: String,
) -> Result<McpDefinition> {
    bridge
        .mcp_oauth_bridge_definition_core(McpOAuthBridgeDefinitionRequest { route_id })
        .await
}
