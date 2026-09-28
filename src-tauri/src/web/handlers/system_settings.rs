use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::system_settings as settings_commands;
use crate::commands::system_settings::{
    LANGUAGE_SETTINGS_UPDATED_EVENT, SYSTEM_LANGUAGE_SETTINGS_KEY, SYSTEM_PROXY_SETTINGS_KEY,
};
use crate::db::service::app_metadata_service;
use crate::models::*;
use crate::network::proxy;

// Wrapper structs to match Tauri's named parameter convention.
// Frontend sends `{ settings: <T> }` which Tauri `invoke()` unwraps automatically,
// but in web mode the entire JSON body arrives as-is.

#[derive(Deserialize)]
pub struct UpdateProxySettingsParams {
    pub settings: SystemProxySettings,
}

#[derive(Deserialize)]
pub struct UpdateLanguageSettingsParams {
    pub settings: SystemLanguageSettings,
}

#[derive(Deserialize)]
pub struct UpdateTerminalSettingsParams {
    pub settings: SystemTerminalSettings,
}

// ---------------------------------------------------------------------------
// Read handlers
// ---------------------------------------------------------------------------

pub async fn get_system_proxy_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SystemProxySettings>, AppCommandError> {
    let db = &state.db;
    let settings = settings_commands::load_system_proxy_settings(&db.conn).await?;
    Ok(Json(settings))
}

pub async fn get_system_language_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SystemLanguageSettings>, AppCommandError> {
    let db = &state.db;
    let settings = settings_commands::load_system_language_settings(&db.conn).await?;
    Ok(Json(settings))
}

pub async fn get_system_terminal_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SystemTerminalSettings>, AppCommandError> {
    let db = &state.db;
    let settings = settings_commands::load_system_terminal_settings(&db.conn).await?;
    Ok(Json(settings))
}

pub async fn get_available_terminal_shells(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AvailableTerminalShells>, AppCommandError> {
    let settings = settings_commands::load_system_terminal_settings(&state.db.conn).await?;
    Ok(Json(settings_commands::build_available_terminal_shells(
        settings.default_shell.as_deref(),
    )))
}

#[derive(Deserialize)]
pub struct ProbeTerminalShellPathParams {
    pub path: String,
}

pub async fn probe_terminal_shell_path(
    Json(params): Json<ProbeTerminalShellPathParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(settings_commands::probe_terminal_shell_path_core(
        &params.path,
    )))
}

// ---------------------------------------------------------------------------
// Update handlers
// ---------------------------------------------------------------------------

pub async fn update_system_proxy_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateProxySettingsParams>,
) -> Result<Json<SystemProxySettings>, AppCommandError> {
    let db = &state.db;

    // Normalize before storing, exactly like the desktop command does. The
    // frontend only checks for emptiness, so this is the only thing that
    // validates the URL and gives it an explicit scheme in server mode.
    let settings = settings_commands::normalize_proxy_settings(params.settings)?;
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize proxy settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, SYSTEM_PROXY_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    proxy::apply_system_proxy_settings(&settings)?;
    #[cfg(feature = "tauri-runtime")]
    if let crate::web::event_bridge::EventEmitter::Tauri(app) = &state.emitter {
        crate::browser::profile::proxy_settings_changed(app);
    }
    Ok(Json(settings))
}

pub async fn update_system_language_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateLanguageSettingsParams>,
) -> Result<Json<SystemLanguageSettings>, AppCommandError> {
    let settings = params.settings;
    let db = &state.db;

    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize language settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, SYSTEM_LANGUAGE_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    crate::web::event_bridge::emit_event(
        &state.emitter,
        LANGUAGE_SETTINGS_UPDATED_EVENT,
        settings.clone(),
    );

    Ok(Json(settings))
}

pub async fn update_system_terminal_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateTerminalSettingsParams>,
) -> Result<Json<SystemTerminalSettings>, AppCommandError> {
    let config = state.connection_manager.terminal_shell_config();
    let settings = settings_commands::set_system_terminal_settings_core(
        &state.db.conn,
        &config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(settings))
}
