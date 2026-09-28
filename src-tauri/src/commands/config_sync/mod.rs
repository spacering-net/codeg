//! Configuration sync: a small, config-only snapshot of this machine's
//! settings that can be exported to a file or pushed to the user's own WebDAV
//! share, and pulled back on another machine.
//!
//! Deliberately NOT the backup engine (`commands::backup`): that one packs
//! conversations, uploads, and transcripts into an encrypted archive measured
//! in gigabytes, which is the wrong unit for something that runs on a timer.
//! This snapshot is tens of KB of configuration and nothing else.
//!
//! ## Shape of the feature
//!
//! * [`domains`] — the single table of what a snapshot contains.
//! * [`portable_keys`] — which `app_metadata` preferences may travel.
//! * [`snapshot`] — collect / validate / apply, plus local rollback copies.
//! * [`local_io`] — single-file export and import.
//! * [`webdav_sync`] — settings, remote layout, upload/download.
//! * [`auto_sync`] — the periodic hash-compare uploader and its suppression.
//!
//! ## Two rules that shape everything else
//!
//! **Uploads are automatic; downloads never are.** A timer that pulled would
//! be indistinguishable from another machine silently overwriting local
//! settings, so every download is an explicit user action with a confirmation
//! that shows what is about to change.
//!
//! **The snapshot is plaintext.** The security boundary is the user's own
//! authenticated WebDAV endpoint. API keys therefore travel in the clear and
//! the sync's own credentials are excluded from the snapshot entirely — a
//! machine can never overwrite another machine's credentials, which is what
//! would turn two clients into a sync loop.
//!
//! **Secrets stay out of the snapshot AND out of the settings row.** The
//! WebDAV password and the optional snapshot passphrase live in the OS keyring
//! (the `0600` token store on a server) — see [`credentials`]. A settings row
//! is plaintext in the SQLite file, and that file is inside every backup
//! archive; neither credential is portable, so neither belongs there.
//!
//! Layering mirrors the backup engine: `*_core` functions take plain
//! references (`&DatabaseConnection`, `&EventEmitter`) so desktop commands,
//! the Axum handlers in `web::handlers::config_sync`, and the background
//! scheduler share one implementation.

pub mod auto_sync;
pub mod credentials;
pub mod crypto;
pub mod domains;
pub mod local_io;
pub mod portable_keys;
pub mod snapshot;
pub mod webdav_sync;

/// Shared by the Tauri commands and the HTTP handlers, so "which version
/// wrote this snapshot" is the same answer in both runtimes.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

// ─── Desktop Tauri commands ──────────────────────────────────────────────
//
// Thin wrappers only. The frontend picks paths with the native file dialog
// and passes them in, exactly as the backup commands do — except in a browser,
// which has no path to pass and posts the bytes instead (`*_content`).

#[cfg(feature = "tauri-runtime")]
mod tauri_commands {
    use std::path::Path;

    use tauri::State;

    use crate::app_error::AppCommandError;
    use crate::db::AppDatabase;

    use super::local_io::{
        apply_rollback_core, export_content_core, export_to_file_core, import_bytes_core,
        import_from_file_core, list_rollbacks_core, peek_import_bytes_core, peek_import_core,
        ConfigExportContent, ConfigExportSummary, ConfigImportPreview, ConfigImportResult,
    };
    use super::snapshot::{rollback_dir, ConfigManifest, RollbackSnapshotInfo};
    use super::webdav_sync::{
        download_and_apply_core, load_settings, load_state, merge_settings, peek_remote_core,
        save_settings_core, test_connection_core, upload_snapshot_core, ConfigSyncSettingsInput,
        ConfigSyncSettingsView, ConfigSyncState, DownloadOutcome, UploadOutcome,
    };

    use super::APP_VERSION;

    #[tauri::command]
    pub async fn config_sync_export_file(
        dest_path: String,
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigExportSummary, AppCommandError> {
        export_to_file_core(&db.conn, APP_VERSION, Path::new(&dest_path)).await
    }

    /// Read-only: powers the "this file contains…" confirmation before any
    /// local data is touched.
    #[tauri::command]
    pub async fn config_sync_peek_file(
        src_path: String,
    ) -> Result<ConfigImportPreview, AppCommandError> {
        peek_import_core(Path::new(&src_path))
    }

    /// Intentionally NOT suppressed: a configuration the user imported by hand
    /// should propagate to their other machines like any other local change.
    #[tauri::command]
    pub async fn config_sync_import_file(
        src_path: String,
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigImportResult, AppCommandError> {
        import_from_file_core(&db.conn, Path::new(&src_path), &rollback_dir()).await
    }

    #[tauri::command]
    pub async fn config_sync_get_settings(
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigSyncSettingsView, AppCommandError> {
        Ok(ConfigSyncSettingsView::from(&load_settings(&db.conn).await))
    }

    #[tauri::command]
    pub async fn config_sync_update_settings(
        settings: ConfigSyncSettingsInput,
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigSyncSettingsView, AppCommandError> {
        save_settings_core(&db.conn, settings).await
    }

    #[tauri::command]
    pub async fn config_sync_get_state(
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigSyncState, AppCommandError> {
        Ok(load_state(&db.conn).await)
    }

    /// Tests what the form currently shows WITHOUT saving it, so a user can
    /// verify credentials before committing them. An empty password field
    /// falls back to the stored one, same as saving would.
    #[tauri::command]
    pub async fn config_sync_test_connection(
        settings: ConfigSyncSettingsInput,
        db: State<'_, AppDatabase>,
    ) -> Result<(), AppCommandError> {
        let existing = load_settings(&db.conn).await;
        let candidate = merge_settings(&existing, settings)?;
        test_connection_core(&candidate).await
    }

    /// The manual "sync now" button: uploads even when the hash says nothing
    /// changed, because the user pressing it usually means they suspect the
    /// remote is out of date.
    #[tauri::command]
    pub async fn config_sync_upload_now(
        db: State<'_, AppDatabase>,
    ) -> Result<UploadOutcome, AppCommandError> {
        upload_snapshot_core(&db.conn, APP_VERSION, true).await
    }

    #[tauri::command]
    pub async fn config_sync_peek_remote(
        db: State<'_, AppDatabase>,
    ) -> Result<Option<ConfigManifest>, AppCommandError> {
        peek_remote_core(&db.conn).await
    }

    #[tauri::command]
    pub async fn config_sync_download_apply(
        db: State<'_, AppDatabase>,
    ) -> Result<DownloadOutcome, AppCommandError> {
        download_and_apply_core(&db.conn).await
    }

    // ── By-content variants ──
    //
    // A Tauri window connected to a REMOTE codeg server routes these over
    // HTTP, where there is no shared filesystem to name a path on. Registering
    // them on the desktop too keeps one frontend code path for both.

    #[tauri::command]
    pub async fn config_sync_export_content(
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigExportContent, AppCommandError> {
        export_content_core(&db.conn, APP_VERSION).await
    }

    #[tauri::command]
    pub async fn config_sync_peek_content(
        content: String,
    ) -> Result<ConfigImportPreview, AppCommandError> {
        peek_import_bytes_core(content.as_bytes())
    }

    #[tauri::command]
    pub async fn config_sync_import_content(
        content: String,
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigImportResult, AppCommandError> {
        import_bytes_core(&db.conn, content.as_bytes(), &rollback_dir()).await
    }

    // ── Rollback snapshots ──
    //
    // Every import and every restore writes one first. Without these two they
    // were a safety net that existed on disk and nowhere in the product.

    #[tauri::command]
    pub async fn config_sync_list_rollbacks(
    ) -> Result<Vec<RollbackSnapshotInfo>, AppCommandError> {
        Ok(list_rollbacks_core(&rollback_dir()))
    }

    #[tauri::command]
    pub async fn config_sync_apply_rollback(
        id: String,
        db: State<'_, AppDatabase>,
    ) -> Result<ConfigImportResult, AppCommandError> {
        apply_rollback_core(&db.conn, &rollback_dir(), &id).await
    }
}

#[cfg(feature = "tauri-runtime")]
pub use tauri_commands::*;
