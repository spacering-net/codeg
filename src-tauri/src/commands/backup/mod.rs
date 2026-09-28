//! Data backup & restore engine.
//!
//! Layered so the `*_core` functions in [`core`] (and, from M2, `restore`) are
//! runtime-agnostic — they take a `&DatabaseConnection` + `&EventEmitter` +
//! `&CancellationToken` and contain no Tauri coupling, so they are shared by
//! the desktop Tauri commands, the Axum web handlers, and (later) a headless
//! scheduler. See `.claude/plans/shimmying-tumbling-forest.md`.

pub mod archive;
pub mod core;
pub mod crypto;
pub mod external;
pub mod manifest;
pub mod restore;
pub mod sections;
pub mod source;

use std::collections::BTreeMap;

use crate::app_error::{
    AppCommandError, BACKUP_I18N_KEY_CANCELLED, BACKUP_I18N_KEY_CORRUPTED,
    BACKUP_I18N_KEY_DISK_SPACE, BACKUP_I18N_KEY_NEWER_VERSION, BACKUP_I18N_KEY_UNKNOWN_FORMAT,
};

/// Map an I/O error to a friendlier "out of disk space" error when it is an
/// `ENOSPC` (Unix 28) / `ERROR_DISK_FULL` (Windows 112) / `ERROR_HANDLE_DISK_FULL`
/// (39); otherwise fall through to the generic I/O mapping. Used at the bulk
/// write boundaries (archive assembly, archive delivery) where running out of
/// space is the most likely failure on large backups.
pub(crate) fn map_disk_full(e: std::io::Error) -> AppCommandError {
    if matches!(e.raw_os_error(), Some(28) | Some(39) | Some(112)) {
        return AppCommandError::io_error("Not enough disk space")
            .with_i18n(BACKUP_I18N_KEY_DISK_SPACE, BTreeMap::new());
    }
    AppCommandError::io(e)
}

/// User cancelled the operation mid-flight.
pub(crate) fn cancelled_error() -> AppCommandError {
    AppCommandError::task_execution_failed("Backup operation cancelled")
        .with_i18n(BACKUP_I18N_KEY_CANCELLED, BTreeMap::new())
}

/// The file is not a codeg backup, or its layout version is too new.
pub(crate) fn unknown_format_error() -> AppCommandError {
    AppCommandError::invalid_input("Not a recognized codeg backup archive")
        .with_i18n(BACKUP_I18N_KEY_UNKNOWN_FORMAT, BTreeMap::new())
}

/// An entry's bytes did not match the manifest checksum.
pub(crate) fn corrupted_error() -> AppCommandError {
    AppCommandError::invalid_input("Backup archive is corrupted (checksum mismatch)")
        .with_i18n(BACKUP_I18N_KEY_CORRUPTED, BTreeMap::new())
}

/// The backup was taken by a newer app version whose schema we can't represent.
pub(crate) fn newer_version_error(backup_version: &str, app_version: &str) -> AppCommandError {
    let mut params = BTreeMap::new();
    params.insert("backupVersion".to_string(), backup_version.to_string());
    params.insert("appVersion".to_string(), app_version.to_string());
    AppCommandError::invalid_input("Backup was created by a newer version of codeg")
        .with_i18n(BACKUP_I18N_KEY_NEWER_VERSION, params)
}

// ─── Desktop Tauri commands ──────────────────────────────────────────────
//
// Thin wrappers over the runtime-agnostic engine: resolve the data dir /
// uploads root from the Tauri path resolver, build a `Tauri` event emitter,
// and register the op with the shared transfer manager for cancellation. The
// frontend picks `dest_path` / `src_path` via the native file dialog.

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

    use serde::Deserialize;
    use tauri::{AppHandle, Manager, State};

    use crate::app_error::AppCommandError;
    use crate::db::AppDatabase;
    use crate::web::event_bridge::EventEmitter;
    use crate::workspace_transfer::WorkspaceTransferManager;

    use super::core::{create_backup_core, scan_external_conflicts_core, BackupInputs, BackupOptions};
    use super::external::ExternalConflict;
    use super::manifest::BackupManifest;
    use super::restore::{stage_restore_core, ExternalRestoreMode, StagedRestore};
    use super::source::{
        prepare_source_core, release_source_core, resolve_prepared_zip, PreparedSource,
    };

    const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct BackupOptionsDto {
        #[serde(default)]
        pub include_external_transcripts: bool,
        #[serde(default)]
        pub passphrase: Option<String>,
    }

    impl From<BackupOptionsDto> for BackupOptions {
        fn from(dto: BackupOptionsDto) -> Self {
            BackupOptions {
                include_external_transcripts: dto.include_external_transcripts,
                passphrase: dto.passphrase,
            }
        }
    }

    fn resolve_data_dir(app: &AppHandle) -> Result<PathBuf, AppCommandError> {
        let fallback = app
            .path()
            .app_data_dir()
            .map_err(|e| AppCommandError::io_error("Resolve app data dir").with_detail(e.to_string()))?;
        Ok(crate::paths::resolve_effective_data_dir(&fallback))
    }

    #[tauri::command]
    pub async fn backup_create(
        options: BackupOptionsDto,
        dest_path: String,
        db: State<'_, AppDatabase>,
        transfer: State<'_, Arc<WorkspaceTransferManager>>,
        app: AppHandle,
    ) -> Result<BackupManifest, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        let (op_id, cancel) = transfer.register_transfer().await;
        let emitter = EventEmitter::Tauri(app.clone());
        let inputs = BackupInputs {
            conn: &db.conn,
            data_dir: &data_dir,
            live_roots: super::sections::LiveRoots::resolve(&data_dir),
            app_version: APP_VERSION,
            runtime_label: "desktop",
        };
        let result =
            create_backup_core(inputs, options.into(), Path::new(&dest_path), &emitter, &op_id, &cancel)
                .await;
        transfer.finish_transfer(&op_id).await;
        result
    }

    /// Decrypt once and hand back a handle the rest of the restore flow
    /// reuses, together with the compatibility preview.
    #[tauri::command]
    pub async fn backup_prepare_source(
        src_path: String,
        passphrase: Option<String>,
        app: AppHandle,
    ) -> Result<PreparedSource, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        // `false`: `src_path` is the user's own file, not ours to consume.
        prepare_source_core(Path::new(&src_path), &data_dir, passphrase.as_deref(), false).await
    }

    #[tauri::command]
    pub async fn backup_release_source(
        source_id: String,
        app: AppHandle,
    ) -> Result<bool, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        release_source_core(&data_dir, &source_id)
    }

    #[tauri::command]
    pub async fn backup_scan_external_conflicts(
        source_id: String,
        app: AppHandle,
    ) -> Result<Vec<ExternalConflict>, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        let zip = resolve_prepared_zip(&data_dir, &source_id)?;
        scan_external_conflicts_core(&zip).await
    }

    #[tauri::command]
    pub async fn backup_restore_stage(
        source_id: String,
        external_mode: Option<ExternalRestoreMode>,
        db: State<'_, AppDatabase>,
        transfer: State<'_, Arc<WorkspaceTransferManager>>,
        connections: State<'_, crate::acp::manager::ConnectionManager>,
        app: AppHandle,
    ) -> Result<StagedRestore, AppCommandError> {
        // `db` is taken so a restore can't race in-flight DB work; the swap
        // itself happens on next startup before any connection opens.
        let _ = &db;
        let data_dir = resolve_data_dir(&app)?;
        let zip = resolve_prepared_zip(&data_dir, &source_id)?;
        let (op_id, cancel) = transfer.register_transfer().await;
        let emitter = EventEmitter::Tauri(app.clone());
        let result =
            stage_restore_core(&zip, &data_dir, &emitter, &op_id, &cancel).await;
        transfer.finish_transfer(&op_id).await;
        let mut staged = result?;
        // Dispatched here, not inside the engine: this is the layer that can
        // lock out new ACP connections while writing to the agents' own dirs.
        super::restore::dispatch_external_after_stage(
            &mut staged,
            &data_dir,
            &connections,
            external_mode.unwrap_or_default(),
            &cancel,
        )
        .await;
        // The verified copy now lives in staging; the plaintext archive is no
        // longer needed. A failed stage keeps it so the user can retry.
        let _ = release_source_core(&data_dir, &source_id);
        Ok(staged)
    }

    /// Agents connected right now, so the mode picker can advise closing them
    /// before choosing "original locations". Advisory only.
    #[tauri::command]
    pub async fn backup_active_agents(
        connections: State<'_, crate::acp::manager::ConnectionManager>,
    ) -> Result<Vec<String>, AppCommandError> {
        Ok(super::restore::active_agent_names(&connections).await)
    }

    /// Pre-restore snapshots still on disk, newest first.
    #[tauri::command]
    pub async fn backup_list_safety_snapshots(
        app: AppHandle,
    ) -> Result<Vec<super::restore::SafetySnapshot>, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        tokio::task::spawn_blocking(move || {
            super::restore::list_safety_snapshots_core(&data_dir)
        })
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("List snapshots failed").with_detail(e.to_string())
        })
    }

    /// Stage a rollback to a safety snapshot; applied on the next startup, so
    /// the caller restarts exactly as it does after a restore.
    #[tauri::command]
    pub async fn backup_rollback(
        snapshot_id: String,
        app: AppHandle,
    ) -> Result<String, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        tokio::task::spawn_blocking(move || {
            super::restore::rollback_to_snapshot_core(&data_dir, &snapshot_id)
        })
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Rollback failed").with_detail(e.to_string())
        })?
    }

    /// Escape hatch when the restart after a stage never happened.
    #[tauri::command]
    pub async fn backup_discard_pending(app: AppHandle) -> Result<bool, AppCommandError> {
        let data_dir = resolve_data_dir(&app)?;
        tokio::task::spawn_blocking(move || {
            super::restore::discard_pending_restore_core(&data_dir)
        })
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Discard pending failed")
                .with_detail(e.to_string())
        })?
    }

    #[tauri::command]
    pub async fn backup_cancel(
        op_id: String,
        transfer: State<'_, Arc<WorkspaceTransferManager>>,
    ) -> Result<bool, AppCommandError> {
        Ok(transfer.cancel(&op_id).await)
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
