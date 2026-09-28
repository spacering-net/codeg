//! Configuration sync HTTP endpoints (server / web mode).
//!
//! One handler per Tauri command in `commands::config_sync`, over the same
//! `*_core` functions — the split exists precisely so neither runtime gets a
//! second implementation to keep in step.
//!
//! The only shape that differs is local file transfer. A browser cannot hand
//! the backend a path, so export answers with the document's text (the client
//! saves it with a `Blob`) and import posts the text back. That is the whole
//! mechanism: a config snapshot is tens of KB, so it needs none of the
//! upload-staging, download-ticket, and temp-file reaping machinery
//! `handlers::backup` carries for archives measured in gigabytes.

use std::sync::Arc;

use axum::extract::Extension;
use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::config_sync::local_io::{
    apply_rollback_core, export_content_core, import_bytes_core, list_rollbacks_core,
    peek_import_bytes_core, ConfigExportContent, ConfigImportPreview, ConfigImportResult,
};
use crate::commands::config_sync::snapshot::{
    rollback_dir, ConfigManifest, RollbackSnapshotInfo,
};
use crate::commands::config_sync::webdav_sync::{
    download_and_apply_core, load_settings, load_state, merge_settings, peek_remote_core,
    save_settings_core, test_connection_core, upload_snapshot_core, ConfigSyncSettingsInput,
    ConfigSyncSettingsView, ConfigSyncState, DownloadOutcome, UploadOutcome,
};
use crate::commands::config_sync::APP_VERSION;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsParams {
    pub settings: ConfigSyncSettingsInput,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentParams {
    pub content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackParams {
    pub id: String,
}

pub async fn config_sync_get_settings(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ConfigSyncSettingsView>, AppCommandError> {
    Ok(Json(ConfigSyncSettingsView::from(
        &load_settings(&state.db.conn).await,
    )))
}

pub async fn config_sync_update_settings(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsParams>,
) -> Result<Json<ConfigSyncSettingsView>, AppCommandError> {
    save_settings_core(&state.db.conn, params.settings)
        .await
        .map(Json)
}

pub async fn config_sync_get_state(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ConfigSyncState>, AppCommandError> {
    Ok(Json(load_state(&state.db.conn).await))
}

pub async fn config_sync_test_connection(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SettingsParams>,
) -> Result<Json<()>, AppCommandError> {
    let existing = load_settings(&state.db.conn).await;
    let candidate = merge_settings(&existing, params.settings)?;
    test_connection_core(&candidate).await.map(Json)
}

pub async fn config_sync_upload_now(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<UploadOutcome>, AppCommandError> {
    upload_snapshot_core(&state.db.conn, APP_VERSION, true)
        .await
        .map(Json)
}

pub async fn config_sync_peek_remote(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Option<ConfigManifest>>, AppCommandError> {
    peek_remote_core(&state.db.conn).await.map(Json)
}

pub async fn config_sync_download_apply(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<DownloadOutcome>, AppCommandError> {
    download_and_apply_core(&state.db.conn).await.map(Json)
}

pub async fn config_sync_export_content(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<ConfigExportContent>, AppCommandError> {
    export_content_core(&state.db.conn, APP_VERSION)
        .await
        .map(Json)
}

pub async fn config_sync_peek_content(
    Json(params): Json<ContentParams>,
) -> Result<Json<ConfigImportPreview>, AppCommandError> {
    peek_import_bytes_core(params.content.as_bytes()).map(Json)
}

pub async fn config_sync_import_content(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ContentParams>,
) -> Result<Json<ConfigImportResult>, AppCommandError> {
    import_bytes_core(&state.db.conn, params.content.as_bytes(), &rollback_dir())
        .await
        .map(Json)
}

pub async fn config_sync_list_rollbacks(
) -> Result<Json<Vec<RollbackSnapshotInfo>>, AppCommandError> {
    let infos = tokio::task::spawn_blocking(|| list_rollbacks_core(&rollback_dir()))
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("List rollback snapshots")
                .with_detail(e.to_string())
        })?;
    Ok(Json(infos))
}

pub async fn config_sync_apply_rollback(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RollbackParams>,
) -> Result<Json<ConfigImportResult>, AppCommandError> {
    apply_rollback_core(&state.db.conn, &rollback_dir(), &params.id)
        .await
        .map(Json)
}
