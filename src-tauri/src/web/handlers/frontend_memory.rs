use std::sync::Arc;

use axum::{extract::Extension, Json};

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::frontend_memory::{frontend_memory_snapshot, FrontendMemorySnapshot};
use crate::frontend_memory_control::{
    frontend_memory_control_snapshot, set_frontend_memory_control_core, FrontendMemoryControl,
    FrontendMemoryControlSnapshot, SetFrontendMemoryControl,
};

/// Same authentication as the rest of /api. Reporting is a local Tauri
/// command; this endpoint only reads the bounded, expiring numeric snapshots.
pub async fn get_frontend_memory() -> Json<FrontendMemorySnapshot> {
    Json(frontend_memory_snapshot())
}

pub async fn get_frontend_memory_control() -> Json<FrontendMemoryControlSnapshot> {
    Json(frontend_memory_control_snapshot())
}

pub async fn set_frontend_memory_control(
    Extension(state): Extension<Arc<AppState>>,
    Json(request): Json<SetFrontendMemoryControl>,
) -> Result<Json<FrontendMemoryControl>, AppCommandError> {
    Ok(Json(set_frontend_memory_control_core(
        &state.emitter,
        request,
    )?))
}
