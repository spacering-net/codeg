//! Settings commands for OpenCode 2's provider credentials: list the
//! integrations, connect one with an API key, disconnect one.
//!
//! The work is done by OpenCode itself, through the server
//! `acp::opencode_credentials` starts with the launch environment a session
//! would get, so a key lands in the database sessions read. Secrets only flow
//! in: what these commands return names integrations, methods and connections,
//! never a key.
//!
//! A running `opencode acp` keeps the credentials it started with, so every
//! change bumps [`credential_epoch`], which OpenCode's config fingerprint
//! includes (`commands::acp::fingerprint_config`): sessions started before the
//! change read as restart-required, and the count of them comes back for the
//! settings page's "N sessions need a restart" notice.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[cfg(feature = "tauri-runtime")]
use tauri::{Manager, State};

use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::opencode_credentials::{self, OpenCodeIntegration};
use crate::acp::types::ConfigStaleKind;
use crate::db::AppDatabase;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

/// Bumped by every credential change codeg makes (see the module docs).
static CREDENTIAL_EPOCH: AtomicU64 = AtomicU64::new(0);

/// How many credential changes codeg has made in this process.
pub(crate) fn credential_epoch() -> u64 {
    CREDENTIAL_EPOCH.load(Ordering::Relaxed)
}

/// What a change returns: the integrations as it left them, and how many
/// running OpenCode sessions now need a restart to see it.
#[derive(Debug, Clone, Serialize)]
pub struct OpenCodeCredentialChange {
    pub integrations: Vec<OpenCodeIntegration>,
    pub stale_sessions: usize,
}

/// A request to store an API key for an integration.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeConnectKeyRequest {
    pub integration_id: String,
    pub key: String,
    /// Answers to the extra fields the integration's key method asks for
    /// (Azure's resource name, a Cloudflare account id, …).
    #[serde(default)]
    pub answer: Option<BTreeMap<String, Value>>,
    /// Replace the integration's stored credentials instead of adding one.
    #[serde(default)]
    pub replace: bool,
}

/// The environment a session would launch OpenCode with, whether or not the
/// agent is enabled: connecting a provider is how a user gets ready to use it.
async fn runtime_env(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<BTreeMap<String, String>, AcpError> {
    crate::commands::acp::build_runtime_env_for_agent(db, AgentType::OpenCode, None, data_dir, true)
        .await
}

/// Mark the change and tell running sessions and other windows about it.
async fn after_change(
    integrations: Vec<OpenCodeIntegration>,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> OpenCodeCredentialChange {
    CREDENTIAL_EPOCH.fetch_add(1, Ordering::Relaxed);
    let stale_sessions = crate::commands::acp::refresh_config_staleness(
        manager,
        db,
        data_dir,
        &[AgentType::OpenCode],
        ConfigStaleKind::AgentConfig,
    )
    .await;
    crate::commands::acp::emit_acp_agents_updated(
        emitter,
        "opencode_credentials",
        Some(AgentType::OpenCode),
    );
    OpenCodeCredentialChange {
        integrations,
        stale_sessions,
    }
}

pub(crate) async fn opencode_list_integrations_core(
    db: &AppDatabase,
    data_dir: &Path,
) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    let env = runtime_env(db, data_dir).await?;
    opencode_credentials::list(&env, data_dir).await
}

pub(crate) async fn opencode_connect_key_core(
    request: OpenCodeConnectKeyRequest,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<OpenCodeCredentialChange, AcpError> {
    let env = runtime_env(db, data_dir).await?;
    let integrations = opencode_credentials::connect_key(
        &env,
        data_dir,
        &request.integration_id,
        &request.key,
        request.answer,
        request.replace,
    )
    .await?;
    Ok(after_change(integrations, db, manager, data_dir, emitter).await)
}

pub(crate) async fn opencode_disconnect_provider_core(
    integration_id: &str,
    db: &AppDatabase,
    manager: &ConnectionManager,
    data_dir: &Path,
    emitter: &EventEmitter,
) -> Result<OpenCodeCredentialChange, AcpError> {
    let env = runtime_env(db, data_dir).await?;
    let integrations = opencode_credentials::disconnect(&env, data_dir, integration_id).await?;
    Ok(after_change(integrations, db, manager, data_dir, emitter).await)
}

#[cfg(feature = "tauri-runtime")]
fn app_data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .map(|p| crate::paths::resolve_effective_data_dir(&p))
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_list_integrations(
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<Vec<OpenCodeIntegration>, AcpError> {
    opencode_list_integrations_core(&db, &app_data_dir(&app)).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_connect_key(
    request: OpenCodeConnectKeyRequest,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<OpenCodeCredentialChange, AcpError> {
    let data_dir = app_data_dir(&app);
    let emitter = EventEmitter::Tauri(app);
    opencode_connect_key_core(request, &db, &manager, &data_dir, &emitter).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn opencode_disconnect_provider(
    integration_id: String,
    manager: State<'_, ConnectionManager>,
    db: State<'_, AppDatabase>,
    app: tauri::AppHandle,
) -> Result<OpenCodeCredentialChange, AcpError> {
    let data_dir = app_data_dir(&app);
    let emitter = EventEmitter::Tauri(app);
    opencode_disconnect_provider_core(&integration_id, &db, &manager, &data_dir, &emitter).await
}
