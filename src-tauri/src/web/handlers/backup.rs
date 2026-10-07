//! Backup & restore HTTP endpoints (server / web mode).
//!
//! Export builds the archive to a temp file under the data dir and hands the
//! browser a single-use download ticket (reusing [`WorkspaceTransferManager`]).
//! Restore is a two-step upload→stage flow that avoids re-uploading a large
//! archive: the file is uploaded once, then inspected and staged by reference.
//! The actual data swap happens on the next process start (the frontend calls
//! the existing `restart_app` endpoint), see [`crate::commands::backup::restore`].

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Extension, Multipart, Path as AxumPath};
use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::backup::core::{self, BackupInputs, BackupOptions};
use crate::commands::backup::manifest::DegradedSqlite;
use crate::commands::backup::restore::{
    self, ExternalRestoreMode, StagedRestore, EXPORT_TMP_DIR as BACKUP_TMP_DIR,
    UPLOAD_TMP_DIR as RESTORE_UPLOAD_DIR,
};
use crate::commands::backup::source::{
    prepare_source_core, release_source_core, resolve_prepared_zip, PreparedSource,
};
use crate::workspace_transfer::{DownloadKind, DownloadTicketIssued, DownloadTicketSpec};

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Grace period before an undownloaded export archive is reaped.
const EXPORT_REAP_SECS: u64 = 120;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBackupParams {
    #[serde(default)]
    pub include_external_transcripts: bool,
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// A download ticket plus whatever the backup had to degrade on the way.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTicketResult {
    #[serde(flatten)]
    pub ticket: DownloadTicketIssued,
    /// Third-party SQLite stores that could not be snapshotted cleanly. The
    /// desktop command reads these off the returned manifest; discarding them
    /// here would let the web UI report a degraded backup as a clean one.
    pub degraded_sqlite: Vec<DegradedSqlite>,
}

/// Build a backup archive and return a single-use download ticket pointing at
/// the new `GET /api/backup_download/{ticket}` route.
pub async fn backup_create_ticket(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CreateBackupParams>,
) -> Result<Json<BackupTicketResult>, AppCommandError> {
    let encrypted = params.passphrase.as_deref().is_some_and(|p| !p.is_empty());
    let ext = if encrypted { "codegbak" } else { "codeg.zip" };

    let tmp_dir = state.data_dir.join(BACKUP_TMP_DIR);
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(AppCommandError::io)?;
    let archive_name = format!("{}.{ext}", uuid::Uuid::new_v4().simple());
    let dest = tmp_dir.join(&archive_name);

    let (op_id, cancel) = state.workspace_transfer.register_transfer().await;
    let inputs = BackupInputs {
        conn: &state.db.conn,
        data_dir: &state.data_dir,
        live_roots: crate::commands::backup::sections::LiveRoots::resolve(&state.data_dir),
        app_version: APP_VERSION,
        runtime_label: "server",
    };
    let opts = BackupOptions {
        include_external_transcripts: params.include_external_transcripts,
        passphrase: params.passphrase.clone(),
    };
    let result = core::create_backup_core(inputs, opts, &dest, &state.emitter, &op_id, &cancel).await;
    state.workspace_transfer.finish_transfer(&op_id).await;
    let manifest = result?;

    let download_name = format!(
        "codeg-backup-{}.{ext}",
        chrono::Utc::now().format("%Y%m%d-%H%M%S")
    );
    let ticket = state
        .workspace_transfer
        .issue_download_ticket(DownloadTicketSpec {
            root_path: tmp_dir,
            target_path: dest.clone(),
            relative_path: archive_name,
            kind: DownloadKind::File,
            filename: download_name,
        })
        .await;

    // Reap the temp archive after the ticket TTL whether or not it was
    // downloaded (the download stream does not delete it).
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(EXPORT_REAP_SECS)).await;
        let _ = tokio::fs::remove_file(&dest).await;
    });

    Ok(Json(BackupTicketResult {
        ticket: DownloadTicketIssued {
            url: format!("/api/backup_download/{}", ticket.ticket),
            ..ticket
        },
        degraded_sqlite: manifest.degraded_sqlite,
    }))
}

/// Stream a built backup archive (public, capability via single-use ticket).
pub async fn backup_download(
    Extension(state): Extension<Arc<AppState>>,
    AxumPath(ticket): AxumPath<String>,
) -> Result<Response, AppCommandError> {
    let Some(t) = state.workspace_transfer.consume_download_ticket(&ticket).await else {
        return Err(AppCommandError::not_found(
            "Download ticket is invalid or expired",
        ));
    };
    // This public route shares the ticket pool with workspace downloads. Only
    // serve tickets that point inside the backup temp dir, so a workspace ticket
    // redeemed here can't stream an arbitrary workspace file.
    if !t.target_path.starts_with(state.data_dir.join(BACKUP_TMP_DIR)) {
        return Err(AppCommandError::not_found(
            "Download ticket is invalid or expired",
        ));
    }
    crate::web::handlers::workspace_files::stream_file_response(&t.target_path, &t.filename).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub upload_id: String,
    pub file_name: String,
}

/// Upload a backup archive to a temp file; returns a handle used by
/// inspect/stage so the (potentially large) file is uploaded only once.
pub async fn backup_upload(
    Extension(state): Extension<Arc<AppState>>,
    mut multipart: Multipart,
) -> Result<Json<UploadResult>, AppCommandError> {
    let upload_dir = state.data_dir.join(RESTORE_UPLOAD_DIR);
    tokio::fs::create_dir_all(&upload_dir)
        .await
        .map_err(AppCommandError::io)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dest = upload_dir.join(format!("{id}.bin"));

    // Optional hard size cap (default unlimited, matching the attachment-upload
    // convention). Operators on shared deployments can bound it via env.
    let max_bytes = std::env::var("CODEG_BACKUP_UPLOAD_MAX_BYTES")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .filter(|v| *v > 0);

    // Stream into the temp file; on ANY failure (read error, write error, over
    // cap) delete the partial file so a failed/aborted upload doesn't linger.
    match receive_upload(&mut multipart, &dest, max_bytes).await {
        Ok(file_name) => Ok(Json(UploadResult {
            upload_id: id,
            file_name,
        })),
        Err(e) => {
            let _ = tokio::fs::remove_file(&dest).await;
            Err(e)
        }
    }
}

async fn receive_upload(
    multipart: &mut Multipart,
    dest: &PathBuf,
    max_bytes: Option<u64>,
) -> Result<String, AppCommandError> {
    let mut file_name = String::new();
    let mut received = false;
    let mut written: u64 = 0;
    while let Some(mut field) = multipart.next_field().await.map_err(|e| {
        AppCommandError::io_error("Invalid multipart upload").with_detail(e.to_string())
    })? {
        if field.name() != Some("file") {
            continue;
        }
        file_name = field.file_name().unwrap_or("backup").to_string();
        let mut out = tokio::fs::File::create(dest)
            .await
            .map_err(AppCommandError::io)?;
        while let Some(chunk) = field.chunk().await.map_err(|e| {
            AppCommandError::io_error("Failed to read upload chunk").with_detail(e.to_string())
        })? {
            written = written.saturating_add(chunk.len() as u64);
            if let Some(limit) = max_bytes {
                if written > limit {
                    return Err(AppCommandError::invalid_input(
                        "Uploaded backup exceeds the configured size limit",
                    ));
                }
            }
            out.write_all(&chunk)
                .await
                .map_err(crate::commands::backup::map_disk_full)?;
        }
        out.flush().await.map_err(AppCommandError::io)?;
        received = true;
    }
    if !received {
        return Err(AppCommandError::invalid_input(
            "Multipart upload is missing the `file` field",
        ));
    }
    Ok(file_name)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareParams {
    pub upload_id: String,
    #[serde(default)]
    pub passphrase: Option<String>,
}

/// Decrypt once and hand back a handle the rest of the restore flow reuses,
/// together with the compatibility preview.
pub async fn backup_prepare_source(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<PrepareParams>,
) -> Result<Json<PreparedSource>, AppCommandError> {
    let src = resolve_upload(&state, &params.upload_id)?;
    // `true`: the upload is a transient temp file, and staging no longer
    // deletes it — the prepared source takes it over.
    let prepared =
        prepare_source_core(&src, &state.data_dir, params.passphrase.as_deref(), true).await?;
    Ok(Json(prepared))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceParams {
    pub source_id: String,
}

pub async fn backup_release_source(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SourceParams>,
) -> Result<Json<bool>, AppCommandError> {
    release_source_core(&state.data_dir, &params.source_id).map(Json)
}

pub async fn backup_scan_external_conflicts(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SourceParams>,
) -> Result<Json<Vec<crate::commands::backup::external::ExternalConflict>>, AppCommandError> {
    let zip = resolve_prepared_zip(&state.data_dir, &params.source_id)?;
    let conflicts = core::scan_external_conflicts_core(&zip).await?;
    Ok(Json(conflicts))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StageParams {
    pub source_id: String,
    /// Defaults to `Skip` when omitted.
    #[serde(default)]
    pub external_mode: Option<ExternalRestoreMode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StageResult {
    pub needs_restart: bool,
    pub restart_delay_ms: u64,
    pub staged: StagedRestore,
}

pub async fn backup_restore_stage(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<StageParams>,
) -> Result<Json<StageResult>, AppCommandError> {
    let zip = resolve_prepared_zip(&state.data_dir, &params.source_id)?;
    let (op_id, cancel) = state.workspace_transfer.register_transfer().await;
    let staged =
        restore::stage_restore_core(&zip, &state.data_dir, &state.emitter, &op_id, &cancel).await;
    state.workspace_transfer.finish_transfer(&op_id).await;
    let mut staged = staged?;
    // Dispatched here, not inside the engine: this is the layer that can lock
    // out new ACP connections while writing to the agents' own directories.
    restore::dispatch_external_after_stage(
        &mut staged,
        &state.data_dir,
        &state.connection_manager,
        params.external_mode.unwrap_or_default(),
        &cancel,
    )
    .await;

    // The verified copy now lives in staging, so neither the decrypted archive
    // nor the upload is needed. (A failed stage keeps both for a retry; startup
    // sweeps them.)
    let _ = release_source_core(&state.data_dir, &params.source_id);

    Ok(Json(StageResult {
        needs_restart: true,
        restart_delay_ms: crate::update::runtime::restart_delay_ms(),
        staged,
    }))
}

/// Agents connected right now, so the mode picker can advise closing them
/// before choosing "original locations". Advisory only.
pub async fn backup_active_agents(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    Ok(Json(
        restore::active_agent_names(&state.connection_manager).await,
    ))
}

pub async fn backup_list_safety_snapshots(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<restore::SafetySnapshot>>, AppCommandError> {
    let data_dir = state.data_dir.clone();
    let snapshots =
        tokio::task::spawn_blocking(move || restore::list_safety_snapshots_core(&data_dir))
            .await
            .map_err(|e| {
                AppCommandError::task_execution_failed("List snapshots failed")
                    .with_detail(e.to_string())
            })?;
    Ok(Json(snapshots))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackParams {
    pub snapshot_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackResult {
    pub needs_restart: bool,
    pub restart_delay_ms: u64,
    pub snapshot_path: String,
}

pub async fn backup_rollback(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RollbackParams>,
) -> Result<Json<RollbackResult>, AppCommandError> {
    let data_dir = state.data_dir.clone();
    let snapshot_path = tokio::task::spawn_blocking(move || {
        restore::rollback_to_snapshot_core(&data_dir, &params.snapshot_id)
    })
    .await
    .map_err(|e| {
        AppCommandError::task_execution_failed("Rollback failed").with_detail(e.to_string())
    })??;
    Ok(Json(RollbackResult {
        needs_restart: true,
        restart_delay_ms: crate::update::runtime::restart_delay_ms(),
        snapshot_path,
    }))
}

pub async fn backup_discard_pending(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<bool>, AppCommandError> {
    let data_dir = state.data_dir.clone();
    tokio::task::spawn_blocking(move || restore::discard_pending_restore_core(&data_dir))
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Discard pending failed")
                .with_detail(e.to_string())
        })?
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelParams {
    pub op_id: String,
}

pub async fn backup_cancel(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<CancelParams>,
) -> Result<Json<bool>, AppCommandError> {
    Ok(Json(state.workspace_transfer.cancel(&params.op_id).await))
}

/// Resolve an `upload_id` to its temp path, rejecting anything that isn't a
/// bare 32-char simple UUID (defends the join against path traversal).
fn resolve_upload(state: &AppState, upload_id: &str) -> Result<PathBuf, AppCommandError> {
    if upload_id.len() != 32 || !upload_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input("Invalid upload id"));
    }
    let path = state
        .data_dir
        .join(RESTORE_UPLOAD_DIR)
        .join(format!("{upload_id}.bin"));
    if !path.is_file() {
        return Err(AppCommandError::not_found("Uploaded backup not found"));
    }
    Ok(path)
}
