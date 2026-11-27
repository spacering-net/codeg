use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MCP_OAUTH_CHANGED_EVENT: &str = "mcp://oauth-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpOAuthGrantStatus {
    Authorized,
    Authorizing,
    Expired,
    Revoked,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpOAuthChanged {
    pub route_id: String,
    pub upstream_url: String,
    pub status: McpOAuthGrantStatus,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpOAuthTransport {
    #[default]
    Http,
    Sse,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthRouteInfo {
    pub route_id: String,
    pub upstream_url: String,
    pub transport: McpOAuthTransport,
    pub bridge_url: Option<String>,
    pub status: McpOAuthGrantStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
    pub has_refresh_token: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpOAuthBridgeSnapshot {
    pub bridge_running: bool,
    pub bridge_base_url: Option<String>,
    pub routes: Vec<McpOAuthRouteInfo>,
}

#[derive(Deserialize)]
pub struct McpOAuthStartRequest {
    pub upstream_url: String,
    pub transport: Option<McpOAuthTransport>,
    pub resource_metadata_url: Option<String>,
    pub client_id: Option<String>,
    pub client_secret: Option<String>,
    pub scopes: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpOAuthRegistrationMode {
    Dynamic,
    Manual,
}

// Contains the OAuth state in authorization_url. Avoid logging this payload.
#[derive(Serialize, Deserialize)]
pub struct McpOAuthStartResult {
    pub flow_id: String,
    pub route_id: String,
    pub upstream_url: String,
    pub authorization_url: String,
    pub callback_url: String,
    pub expires_at: DateTime<Utc>,
    pub registration_mode: McpOAuthRegistrationMode,
}

#[derive(Deserialize)]
pub struct McpOAuthCompleteCallbackRequest {
    pub flow_id: String,
    pub callback_url: String,
}

#[derive(Deserialize)]
pub struct McpOAuthCancelRequest {
    pub flow_id: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpOAuthCancelResult {
    pub cancelled: bool,
}

#[derive(Deserialize)]
pub struct McpOAuthRevokeRequest {
    pub route_id: String,
}

#[derive(Deserialize)]
pub struct McpOAuthBridgeDefinitionRequest {
    pub route_id: String,
}
