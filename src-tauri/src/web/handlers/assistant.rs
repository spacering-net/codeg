use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::assistant::{
    assistant_ensure_core, assistant_get_settings_core, assistant_reset_core,
    assistant_set_settings_core, AssistantSession, AssistantSettings,
};
use crate::web::event_bridge::EventEmitter;
use axum::{Extension, Json};
use serde::Deserialize;
use std::sync::Arc;

pub async fn get_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AssistantSettings>, AppCommandError> {
    let settings = assistant_get_settings_core(&state.db.conn).await?;
    Ok(Json(settings))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSettingsParams {
    pub settings: AssistantSettings,
}

pub async fn set_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SetSettingsParams>,
) -> Result<Json<()>, AppCommandError> {
    assistant_set_settings_core(&state.db.conn, params.settings).await?;
    Ok(Json(()))
}

pub async fn reset(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<()>, AppCommandError> {
    assistant_reset_core(&state.db.conn, &state.connection_manager).await?;
    Ok(Json(()))
}

pub async fn ensure(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<AssistantSession>, AppCommandError> {
    let emitter = EventEmitter::WebOnly {
        broadcaster: state.event_broadcaster.clone(),
        bus: state.acp_event_bus.clone(),
    };
    let data_dir = crate::paths::codeg_home_dir();
    let session =
        assistant_ensure_core(&state.db, &state.connection_manager, emitter, data_dir).await?;
    Ok(Json(session))
}
