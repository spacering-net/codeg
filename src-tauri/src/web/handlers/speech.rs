use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::speech::{
    speech_get_settings_core, speech_synthesize_core, speech_transcribe_core,
    speech_update_settings_core, SpeechAudio, SpeechCloudSettings, SpeechCloudSettingsView,
};
use axum::{extract::Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsParams {
    pub settings: SpeechCloudSettings,
    pub api_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeParams {
    pub audio_base64: String,
    pub mime_type: String,
    pub language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SynthesizeParams {
    pub text: String,
    pub speed: f32,
}

pub async fn speech_get_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<SpeechCloudSettingsView>, AppCommandError> {
    let view = speech_get_settings_core(&state.db.conn).await?;
    Ok(Json(view))
}

pub async fn speech_update_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<UpdateSettingsParams>,
) -> Result<Json<SpeechCloudSettingsView>, AppCommandError> {
    let view = speech_update_settings_core(&state.db.conn, params.settings, params.api_key).await?;
    Ok(Json(view))
}

pub async fn speech_transcribe(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TranscribeParams>,
) -> Result<Json<String>, AppCommandError> {
    let text = speech_transcribe_core(
        &state.db.conn,
        params.audio_base64,
        params.mime_type,
        params.language,
    )
    .await?;
    Ok(Json(text))
}

pub async fn speech_synthesize(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SynthesizeParams>,
) -> Result<Json<SpeechAudio>, AppCommandError> {
    let audio = speech_synthesize_core(&state.db.conn, params.text, params.speed).await?;
    Ok(Json(audio))
}
