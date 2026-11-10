//! HTTP handlers for the computer-use settings — the web-mode mirror of the
//! Tauri commands in `commands::computer_tools`.
//!
//! Only the settings: sharing a window, and everything else that is about the
//! screen, is a desktop-only action with no HTTP face. The switches are here
//! for the same reason the browser's are — one setting in one database, which
//! a user administering their desktop instance from elsewhere should see in
//! the same position.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::computer_tools::{
    load_computer_tools_settings, set_computer_tools_enabled_core,
    set_computer_tools_preferences_core, set_computer_tools_settings_core,
    ComputerToolsPreferences, ComputerToolsSettings,
};

pub async fn get_computer_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    Ok(Json(load_computer_tools_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetComputerToolsSettingsParams {
    pub settings: ComputerToolsSettings,
}

pub async fn set_computer_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetComputerToolsSettingsParams>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_settings_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}

#[derive(Deserialize)]
pub struct SetComputerToolsEnabledParams {
    pub enabled: bool,
}

pub async fn set_computer_tools_enabled(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetComputerToolsEnabledParams>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_enabled_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        params.enabled,
    )
    .await?;
    Ok(Json(saved))
}

/// Any of them; an absent one is left as it is.
pub async fn set_computer_tools_preferences(
    Extension(state): Extension<Arc<AppState>>,
    Json(preferences): Json<ComputerToolsPreferences>,
) -> Result<Json<ComputerToolsSettings>, AppCommandError> {
    let saved = set_computer_tools_preferences_core(
        &state.db.conn,
        &state.computer_tools_config,
        &state.emitter,
        preferences,
    )
    .await?;
    Ok(Json(saved))
}
