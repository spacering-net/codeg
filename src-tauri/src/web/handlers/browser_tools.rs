//! HTTP handlers for the browser-tools switch — the web-mode mirror of the
//! Tauri commands in `commands::browser_tools`.
//!
//! Present in server mode even though server mode has no built-in browser to
//! read: this is one setting stored in one database, and a user administering
//! their desktop instance from a phone should see the same switch, in the same
//! position, as the one on the machine with the tabs.

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::browser_tools::{
    load_browser_tools_settings, set_browser_tools_settings_core, BrowserToolsSettings,
};

pub async fn get_browser_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<BrowserToolsSettings>, AppCommandError> {
    Ok(Json(load_browser_tools_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetBrowserToolsSettingsParams {
    pub settings: BrowserToolsSettings,
}

pub async fn set_browser_tools_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetBrowserToolsSettingsParams>,
) -> Result<Json<BrowserToolsSettings>, AppCommandError> {
    let saved = set_browser_tools_settings_core(
        &state.db.conn,
        &state.browser_tools_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}
