//! HTTP handlers for live user-feedback — the web-mode mirror of the Tauri
//! commands in `commands::feedback`.
//!
//! The settings endpoints share the same core helpers
//! (`load_feedback_settings`, `set_feedback_settings_core`) so the persist +
//! runtime-config re-apply behavior stays identical across transports. The
//! submit endpoint delegates straight to `ConnectionManager::submit_feedback`,
//! mapping the "no active turn" rejection to a 4xx the frontend recovers from
//! (it falls back to sending the text as an ordinary prompt).

use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::acp::error::AcpError;
use crate::acp::feedback::FeedbackItem;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::app_state::AppState;
use crate::commands::feedback::{
    load_feedback_settings, set_feedback_settings_core, FeedbackSettings,
};

pub async fn get_feedback_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<FeedbackSettings>, AppCommandError> {
    Ok(Json(load_feedback_settings(&state.db.conn).await))
}

#[derive(Deserialize)]
pub struct SetFeedbackSettingsParams {
    pub settings: FeedbackSettings,
}

pub async fn set_feedback_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetFeedbackSettingsParams>,
) -> Result<Json<FeedbackSettings>, AppCommandError> {
    let saved = set_feedback_settings_core(
        &state.db.conn,
        &state.feedback_config,
        &state.emitter,
        params.settings,
    )
    .await?;
    Ok(Json(saved))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitSessionFeedbackParams {
    pub connection_id: String,
    pub text: String,
    /// Full prompt-block draft when the note carries image attachments
    /// (native steering only); `text` stays the recorded/display form. Web /
    /// remote-mode uploads arrive as empty-payload `file://` markers, exactly
    /// like `/acp_prompt`, and are re-hydrated server-side.
    #[serde(default)]
    pub blocks: Option<Vec<crate::acp::types::PromptInputBlock>>,
}

pub async fn submit_session_feedback(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SubmitSessionFeedbackParams>,
) -> Result<Json<FeedbackItem>, AppCommandError> {
    // The gate (per-connection feedback-tool availability + turn-in-flight) lives
    // in `submit_feedback`; recoverable rejections map to 4xx below.
    let item = state
        .connection_manager
        .submit_feedback(&params.connection_id, params.text, params.blocks)
        .await
        .map_err(|e| {
            let message = e.to_string();
            match e {
                // Expected, recoverable client conditions → 4xx, not a 500. The
                // frontend recognizes NoActiveTurn (falls back to an ordinary
                // prompt) and surfaces the others.
                AcpError::NoActiveTurn
                | AcpError::FeedbackDisabled
                | AcpError::InvalidFeedback(_) => {
                    AppCommandError::new(AppErrorCode::InvalidInput, message)
                }
                _ => AppCommandError::task_execution_failed(message),
            }
        })?;
    Ok(Json(item))
}
