//! One decryption per restore.
//!
//! Inspecting an archive, scanning it for external conflicts and staging it
//! each used to decrypt the whole thing again, so restoring a 5 GB encrypted
//! backup cost four full-size temporaries: three decryptions plus the
//! extracted staging tree. A [`PreparedSource`] decrypts once into the data
//! dir and hands back a handle the later steps reuse.
//!
//! The trade is that the plaintext archive sits on disk for as long as the
//! user takes to work through the restore dialog. That is accepted in codeg's
//! local-data threat model — the same directory already holds `tokens.json`
//! and the database, mode `0700` — and it is bounded three ways, all of which
//! are real code rather than intentions: released the moment staging succeeds,
//! reaped by a per-source idle timer, and wiped wholesale at startup. The one
//! residual case is "prepare, then the process is killed and never runs
//! again", which leaves the plaintext until the next launch.
//!
//! The idle timer is refreshed on every use, so a user who is slowly working
//! through the dialog never has the handle pulled out from under them; only an
//! abandoned one expires.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::app_error::AppCommandError;

use super::archive;
use super::core;
use super::crypto;
use super::manifest::BackupPreview;

/// Holds decrypted archives awaiting inspect/scan/stage. Wiped at startup by
/// [`super::restore::cleanup_transient_dirs`].
pub const PREPARED_DIR: &str = ".codeg-restore-prepared";
const META_FILE: &str = "meta.json";
const PLAIN_ZIP: &str = "plain.zip";
/// How long a prepared source may sit unused before it is reaped. Refreshed on
/// every use, so this bounds abandonment, not how long a restore may take.
const IDLE_TTL: Duration = Duration::from_secs(30 * 60);

/// A prepared archive handle plus the preview the caller was going to ask for
/// anyway (reading the manifest already required the decryption).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedSource {
    /// `None` when the archive is encrypted and no usable passphrase was
    /// supplied: nothing was decrypted, so there is nothing to hand back. The
    /// UI prompts and calls prepare again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    pub preview: BackupPreview,
}

#[derive(Debug, Serialize, Deserialize)]
struct SourceMeta {
    v: u32,
    zip_path: String,
    /// Whether the zip lives inside this source's own directory (a decrypted
    /// copy) or is the caller's own plaintext file, which must not be deleted.
    owns_zip: bool,
    last_used_epoch: u64,
}

/// Decrypt (if needed) and register `src` as a reusable restore source.
///
/// `take_ownership` says whether `src` is a transient upload this module may
/// consume. The web flow sets it: without it, a 5 GB plaintext upload would sit
/// in the upload directory for the rest of the session, since staging no
/// longer deletes it. The desktop flow does NOT — `src` is the user's own file.
pub async fn prepare_source_core(
    src: &Path,
    data_dir: &Path,
    passphrase: Option<&str>,
    take_ownership: bool,
) -> Result<PreparedSource, AppCommandError> {
    let src_buf = src.to_path_buf();
    let encrypted = tokio::task::spawn_blocking(move || crypto::is_encrypted(&src_buf))
        .await
        .map_err(spawn_err)??;

    if encrypted && passphrase.is_none_or(|p| p.is_empty()) {
        return Ok(PreparedSource {
            source_id: None,
            preview: BackupPreview {
                encrypted: true,
                needs_passphrase: true,
                manifest: None,
                compatible: false,
                reject_reason: None,
            },
        });
    }

    let prepared_root = prepared_root(data_dir)?; // 0700 on Unix
    let id = uuid::Uuid::new_v4().simple().to_string();
    let dir = prepared_root.join(&id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(AppCommandError::io)?;

    // A plaintext archive the caller owns is referenced in place: copying a
    // multi-GB file would defeat the point of this whole module.
    let (zip_path, owns_zip) = if encrypted {
        let out = dir.join(PLAIN_ZIP);
        let src_c = src.to_path_buf();
        let out_c = out.clone();
        let pass = passphrase.unwrap_or_default().to_string();
        let cancel = CancellationToken::new();
        let decrypted =
            tokio::task::spawn_blocking(move || crypto::decrypt_file(&src_c, &out_c, &pass, &cancel))
                .await
                .map_err(spawn_err)?;
        if let Err(e) = decrypted {
            // A wrong passphrase must not leave a partial plaintext behind.
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
        if take_ownership {
            // The ciphertext has served its purpose.
            let _ = tokio::fs::remove_file(src).await;
        }
        (out, true)
    } else if take_ownership {
        // Same filesystem, so this is a rename, not a copy. If it is not (an
        // exotic layout), fall back to referencing it where it lies rather
        // than duplicating gigabytes; the startup sweep still reclaims it.
        let out = dir.join(PLAIN_ZIP);
        match tokio::fs::rename(src, &out).await {
            Ok(()) => (out, true),
            Err(_) => (src.to_path_buf(), false),
        }
    } else {
        (src.to_path_buf(), false)
    };

    let preview = match preview_zip(&zip_path, encrypted).await {
        Ok(p) => p,
        Err(e) => {
            let _ = tokio::fs::remove_dir_all(&dir).await;
            return Err(e);
        }
    };
    // The meta file is what the reaper and the release path find this source
    // by, so failing to write it would strand a decrypted archive until the
    // next startup sweep. Clean up instead of handing back a handle nothing
    // can resolve.
    if let Err(e) = write_meta(
        &dir,
        &SourceMeta {
            v: 1,
            zip_path: zip_path.to_string_lossy().into_owned(),
            owns_zip,
            last_used_epoch: now_epoch(),
        },
    ) {
        let _ = tokio::fs::remove_dir_all(&dir).await;
        return Err(e);
    }
    spawn_idle_reaper(data_dir.to_path_buf(), id.clone());

    Ok(PreparedSource {
        source_id: Some(id),
        preview,
    })
}

/// Resolve a source handle to its plaintext archive, refreshing the idle
/// timer. Rejects anything that is not a bare 32-char simple UUID, so the
/// join cannot be steered out of the prepared root.
pub fn resolve_prepared_zip(data_dir: &Path, source_id: &str) -> Result<PathBuf, AppCommandError> {
    if source_id.len() != 32 || !source_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input("Invalid backup source id"));
    }
    let dir = data_dir.join(PREPARED_DIR).join(source_id);
    let mut meta = read_meta(&dir)
        .ok_or_else(|| AppCommandError::not_found("Prepared backup source not found"))?;
    let zip = PathBuf::from(&meta.zip_path);
    if !zip.is_file() {
        return Err(AppCommandError::not_found("Prepared backup source not found"));
    }
    meta.last_used_epoch = now_epoch();
    let _ = write_meta(&dir, &meta);
    Ok(zip)
}

/// Drop a prepared source. Idempotent; `false` means there was nothing there.
pub fn release_source_core(data_dir: &Path, source_id: &str) -> Result<bool, AppCommandError> {
    if source_id.len() != 32 || !source_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppCommandError::invalid_input("Invalid backup source id"));
    }
    let dir = data_dir.join(PREPARED_DIR).join(source_id);
    if !dir.is_dir() {
        return Ok(false);
    }
    // Only the decrypted copy lives inside `dir`, so removing the directory
    // never touches a plaintext archive the caller owns.
    std::fs::remove_dir_all(&dir).map_err(AppCommandError::io)?;
    Ok(true)
}

/// Startup sweep: nothing is prepared across a process boundary, so anything
/// still here is the residue of a killed process.
pub fn cleanup_prepared_sources(data_dir: &Path) {
    let _ = std::fs::remove_dir_all(data_dir.join(PREPARED_DIR));
}

/// Reap this source once it has gone `IDLE_TTL` without being used. Re-arms
/// rather than reaping while it is still in use, so a slow restore is never
/// cut off.
fn spawn_idle_reaper(data_dir: PathBuf, source_id: String) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(IDLE_TTL).await;
            let dir = data_dir.join(PREPARED_DIR).join(&source_id);
            let Some(meta) = read_meta(&dir) else {
                return; // already released
            };
            let idle = now_epoch().saturating_sub(meta.last_used_epoch);
            if idle >= IDLE_TTL.as_secs() {
                tracing::info!("[RESTORE] reaping idle prepared source {source_id}");
                let _ = std::fs::remove_dir_all(&dir);
                return;
            }
        }
    });
}

async fn preview_zip(zip_path: &Path, encrypted: bool) -> Result<BackupPreview, AppCommandError> {
    let zip_c = zip_path.to_path_buf();
    let manifest = tokio::task::spawn_blocking(move || archive::read_manifest(&zip_c))
        .await
        .map_err(spawn_err)??;
    let (mut compatible, mut reject_reason) = core::evaluate_compat(&manifest);
    // Mirror the structural checks stage applies, so the preview never reports
    // "compatible" for a backup that stage will reject.
    if compatible && archive::validate_manifest(&manifest).is_err() {
        compatible = false;
        reject_reason =
            Some(crate::app_error::BACKUP_I18N_KEY_UNKNOWN_FORMAT.to_string());
    }
    Ok(BackupPreview {
        encrypted,
        needs_passphrase: false,
        manifest: Some(manifest),
        compatible,
        reject_reason,
    })
}

fn prepared_root(data_dir: &Path) -> Result<PathBuf, AppCommandError> {
    let root = data_dir.join(PREPARED_DIR);
    std::fs::create_dir_all(&root).map_err(AppCommandError::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
    }
    Ok(root)
}

fn read_meta(dir: &Path) -> Option<SourceMeta> {
    let raw = std::fs::read_to_string(dir.join(META_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(dir: &Path, meta: &SourceMeta) -> Result<(), AppCommandError> {
    let json = serde_json::to_vec_pretty(meta).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize backup source meta")
            .with_detail(e.to_string())
    })?;
    std::fs::write(dir.join(META_FILE), json).map_err(AppCommandError::io)
}

fn now_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn spawn_err(e: tokio::task::JoinError) -> AppCommandError {
    AppCommandError::task_execution_failed("Backup source task failed").with_detail(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plaintext_archive(dir: &Path) -> PathBuf {
        use crate::commands::backup::manifest::{BackupManifest, BACKUP_FORMAT_VERSION, BACKUP_KIND};
        use sea_orm_migration::MigratorTrait;
        let zip = dir.join("backup.codeg.zip");
        let db = dir.join("db.bin");
        std::fs::write(&db, b"DB").unwrap();
        let mut b = archive::ArchiveBuilder::create(&zip).unwrap();
        b.add_file(
            "db/codeg.db",
            &db,
            &CancellationToken::new(),
            &mut archive::null_progress(),
        )
        .unwrap();
        b.finish(BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            kind: BACKUP_KIND.to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: crate::db::migration::Migrator::migrations()
                .last()
                .map(|m| m.name().to_string())
                .unwrap_or_default(),
            runtime: "server".to_string(),
            includes_external_transcripts: false,
            includes_secrets: true,
            managed_sections: None,
            degraded_sqlite: Vec::new(),
            entries: Vec::new(),
        })
        .unwrap();
        zip
    }

    #[tokio::test]
    async fn plaintext_source_is_referenced_not_copied() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let zip = plaintext_archive(dir.path());

        let prepared = prepare_source_core(&zip, &data_dir, None, false)
            .await
            .unwrap();
        let id = prepared.source_id.expect("plaintext needs no passphrase");
        assert!(prepared.preview.compatible, "{:?}", prepared.preview);
        assert_eq!(resolve_prepared_zip(&data_dir, &id).unwrap(), zip);

        // Releasing must never delete an archive the caller owns.
        assert!(release_source_core(&data_dir, &id).unwrap());
        assert!(zip.is_file());
        assert!(resolve_prepared_zip(&data_dir, &id).is_err());
        assert!(!release_source_core(&data_dir, &id).unwrap());
    }

    #[tokio::test]
    async fn encrypted_source_decrypts_once_under_the_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let plain = plaintext_archive(dir.path());
        let enc = dir.path().join("backup.codegbak");
        crypto::encrypt_file(&plain, &enc, "s3cret", &CancellationToken::new()).unwrap();

        // No passphrase: nothing is decrypted and no handle is issued.
        let locked = prepare_source_core(&enc, &data_dir, None, false).await.unwrap();
        assert!(locked.source_id.is_none());
        assert!(locked.preview.needs_passphrase);

        // Wrong passphrase leaves nothing behind.
        assert!(prepare_source_core(&enc, &data_dir, Some("nope"), false)
            .await
            .is_err());
        assert_eq!(
            std::fs::read_dir(data_dir.join(PREPARED_DIR)).unwrap().count(),
            0,
            "a failed decryption must not leave a partial plaintext"
        );

        let prepared = prepare_source_core(&enc, &data_dir, Some("s3cret"), false)
            .await
            .unwrap();
        let id = prepared.source_id.expect("handle");
        let zip = resolve_prepared_zip(&data_dir, &id).unwrap();
        // Under the data dir, never `std::env::temp_dir()` — on Linux that is
        // often tmpfs, so a multi-GB decryption would land in RAM.
        assert!(zip.starts_with(data_dir.join(PREPARED_DIR)));
        assert!(prepared.preview.compatible);

        release_source_core(&data_dir, &id).unwrap();
        assert!(!zip.exists(), "the decrypted copy is deleted on release");
    }

    #[tokio::test]
    async fn source_ids_are_validated_before_the_join() {
        let dir = tempfile::tempdir().unwrap();
        for bad in ["../escape", "", "not-hex-not-hex-not-hex-not-hexx"] {
            assert!(resolve_prepared_zip(dir.path(), bad).is_err());
            assert!(release_source_core(dir.path(), bad).is_err());
        }
    }

    #[tokio::test]
    async fn startup_sweep_removes_leftover_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let plain = plaintext_archive(dir.path());
        let enc = dir.path().join("backup.codegbak");
        crypto::encrypt_file(&plain, &enc, "s3cret", &CancellationToken::new()).unwrap();
        let prepared = prepare_source_core(&enc, &data_dir, Some("s3cret"), false)
            .await
            .unwrap();
        let zip = resolve_prepared_zip(&data_dir, prepared.source_id.as_ref().unwrap()).unwrap();
        assert!(zip.is_file());

        cleanup_prepared_sources(&data_dir);
        assert!(!zip.exists());
        assert!(!data_dir.join(PREPARED_DIR).exists());
    }
}
