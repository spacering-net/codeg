use axum::Json;

use crate::frontend_memory::{frontend_memory_snapshot, FrontendMemorySnapshot};

/// Same authentication as the rest of /api. Reporting is a local Tauri
/// command; this endpoint only reads the bounded, expiring numeric snapshots.
pub async fn get_frontend_memory() -> Json<FrontendMemorySnapshot> {
    Json(frontend_memory_snapshot())
}
