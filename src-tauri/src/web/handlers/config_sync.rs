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

use axum::body::Bytes;
use axum::extract::Extension;
use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::config_sync::appearance::{mirror_appearance_core, AppearanceValues};
use crate::commands::config_sync::local_io::{
    apply_rollback_core, export_content_core, import_bytes_core, list_rollbacks_core,
    peek_import_bytes_core, ConfigExportContent, ConfigImportPreview, ConfigImportResult,
};
use crate::commands::config_sync::snapshot::{
    rollback_dir, ConfigManifest, RollbackSnapshotInfo,
};
use crate::commands::config_sync::webdav_sync::{
    download_and_apply_core, load_settings, load_state_view, merge_settings, peek_remote_core,
    save_settings_core, test_connection_core, upload_snapshot_core, ConfigSyncSettingsInput,
    ConfigSyncSettingsView, ConfigSyncState, DownloadOutcome, UploadOutcome, UploadRequest,
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

/// `{}` from the plain "sync now" button; the token only after the user
/// confirmed replacing a remote snapshot this device had not seen.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UploadParams {
    pub overwrite_remote_sha256: Option<String>,
}

/// This endpoint took no body before the overwrite token existed, so an empty
/// one — with or without a JSON content type — still means a plain upload.
fn parse_upload_params(body: &[u8]) -> Result<UploadParams, AppCommandError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(UploadParams::default());
    }
    serde_json::from_slice(body).map_err(|e| {
        AppCommandError::invalid_input("Invalid upload request").with_detail(e.to_string())
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppearanceParams {
    pub values: AppearanceValues,
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
    Ok(Json(load_state_view(&state.db.conn).await))
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
    body: Bytes,
) -> Result<Json<UploadOutcome>, AppCommandError> {
    let params = parse_upload_params(&body)?;
    upload_snapshot_core(
        &state.db.conn,
        APP_VERSION,
        UploadRequest {
            force: true,
            automatic: false,
            overwrite_remote_sha256: params.overwrite_remote_sha256.as_deref(),
        },
    )
    .await
    .map(Json)
}

pub async fn config_sync_mirror_appearance(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<AppearanceParams>,
) -> Result<Json<()>, AppCommandError> {
    mirror_appearance_core(&state.db.conn, params.values)
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
    download_and_apply_core(&state.db.conn, &state.emitter)
        .await
        .map(Json)
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
    import_bytes_core(
        &state.db.conn,
        &state.emitter,
        params.content.as_bytes(),
        &rollback_dir(),
    )
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
    apply_rollback_core(&state.db.conn, &state.emitter, &rollback_dir(), &params.id)
        .await
        .map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The plain "sync now" button posts `{}`; the overwrite confirmation adds
    /// the camelCase token; a caller from before the token existed may post
    /// nothing at all. All must reach `upload_snapshot_core` as meant.
    #[test]
    fn upload_params_accept_no_body_an_empty_object_and_the_overwrite_token() {
        let empties: [&[u8]; 4] = [b"", b"  \n", b"{}", br#"{"overwriteRemoteSha256":null}"#];
        for empty in empties {
            let params = parse_upload_params(empty).expect("plain upload");
            assert_eq!(params.overwrite_remote_sha256, None);
        }
        let confirmed = parse_upload_params(br#"{"overwriteRemoteSha256":"abc"}"#).expect("token");
        assert_eq!(confirmed.overwrite_remote_sha256.as_deref(), Some("abc"));
        parse_upload_params(b"{not json").expect_err("garbage is refused, not ignored");
    }

    /// Over real HTTP: no body and no content type is what an older client
    /// sent, and must not turn into a 415.
    #[tokio::test]
    async fn upload_body_without_content_type_is_accepted() {
        use axum::routing::post;
        let app = axum::Router::new().route(
            "/u",
            post(|body: Bytes| async move {
                parse_upload_params(&body)
                    .map(|p| Json(p.overwrite_remote_sha256))
                    .map_err(|_| axum::http::StatusCode::BAD_REQUEST)
            }),
        );
        let server = axum_test::TestServer::new(app).expect("server");
        let bare = server.post("/u").await;
        bare.assert_status_ok();
        assert_eq!(bare.json::<Option<String>>(), None);
        let token = server
            .post("/u")
            .json(&serde_json::json!({ "overwriteRemoteSha256": "abc" }))
            .await;
        assert_eq!(token.json::<Option<String>>().as_deref(), Some("abc"));
    }

    #[test]
    fn appearance_params_carry_a_string_map() {
        let params: AppearanceParams =
            serde_json::from_str(r#"{"values":{"codeg-theme-color":"red"}}"#).expect("parse");
        assert_eq!(
            params.values.get("codeg-theme-color").map(String::as_str),
            Some("red")
        );
    }
}
