//! HTTP handlers for render-page settings — the web-mode mirror of the Tauri
//! commands in `commands::render_page`.
//!
//! Both endpoints share the same core helpers (`load_render_page_settings`,
//! `set_render_page_settings_core`) so the persist + runtime-config re-apply
//! behavior stays identical across transports. (Answering a pending page is an
//! ACP operation and lives in
//! `web::handlers::acp::acp_answer_render_page`.)

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::render_page::{
    load_render_page_settings, set_render_page_settings_core, RenderPageSettings,
};

pub async fn get_render_page_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<RenderPageSettings>, AppCommandError> {
    Ok(Json(load_render_page_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetRenderPageSettingsParams {
    pub settings: RenderPageSettings,
}

pub async fn set_render_page_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetRenderPageSettingsParams>,
) -> Result<Json<RenderPageSettings>, AppCommandError> {
    let saved = set_render_page_settings_core(
        &state.db.conn,
        &state.render_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}
