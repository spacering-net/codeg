//! Runtime-agnostic backup engine.
//!
//! `create_backup_core` / `scan_external_conflicts_core` take plain references
//! (`&DatabaseConnection`, `&EventEmitter`, `&CancellationToken`) so the same
//! code path serves the desktop Tauri commands, the Axum web handlers, and a
//! future headless scheduler (which would pass `EventEmitter::Noop`).

use std::path::{Path, PathBuf};

use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use sea_orm_migration::MigratorTrait;
use tokio_util::sync::CancellationToken;

use crate::app_error::{AppCommandError, BACKUP_I18N_KEY_NEWER_VERSION, BACKUP_I18N_KEY_UNKNOWN_FORMAT};
use crate::db::migration::Migrator;
use crate::web::event_bridge::{emit_event, EventEmitter};

use super::archive::ArchiveBuilder;
use super::crypto;
use super::external;
use super::manifest::{
    BackupManifest, BackupPhase, BackupProgress, BACKUP_FORMAT_VERSION, BACKUP_KIND,
    BACKUP_PROGRESS_EVENT,
};
use super::sections::{self, LiveRoots, SectionKind};
use super::cancelled_error;

/// Options that shape a backup.
#[derive(Debug, Clone, Default)]
pub struct BackupOptions {
    pub include_external_transcripts: bool,
    /// `None` or empty → unencrypted archive. Otherwise the archive is wrapped
    /// in an AES-256-GCM envelope keyed off this passphrase.
    pub passphrase: Option<String>,
}

/// Everything the engine needs to assemble a backup, resolved by the caller
/// (desktop command / web handler) so the engine stays free of env lookups.
pub struct BackupInputs<'a> {
    pub conn: &'a DatabaseConnection,
    pub data_dir: &'a Path,
    /// Live location of every managed section — resolved by the caller so the
    /// engine stays free of env lookups and tests can redirect the whole set.
    pub live_roots: LiveRoots,
    pub app_version: &'a str,
    pub runtime_label: &'static str,
}

/// Build a backup archive at `dest_path`. Emits [`BACKUP_PROGRESS_EVENT`]
/// throughout and honors `cancel`. Writes to a sibling `.part` file and renames
/// on success so a crash never leaves a half-written backup at `dest_path`.
pub(crate) async fn create_backup_core(
    inputs: BackupInputs<'_>,
    options: BackupOptions,
    dest_path: &Path,
    emitter: &EventEmitter,
    op_id: &str,
    cancel: &CancellationToken,
) -> Result<BackupManifest, AppCommandError> {
    // Scratch lives under the data dir, never in the system temp: on Linux
    // that is often tmpfs, so a multi-GB archive would be assembled in RAM,
    // and a cross-filesystem temp turns every later rename into a full copy.
    // `cleanup_transient_dirs` already sweeps this root at startup.
    let work = tempfile::tempdir_in(scratch_root(inputs.data_dir)?).map_err(AppCommandError::io)?;
    let db_snapshot = work.path().join("codeg.db");
    let zip_tmp = work.path().join("payload.zip");
    let external_scratch = work.path().to_path_buf();

    // ── Phase 1: consistent DB snapshot via VACUUM INTO ──────────────────
    emit(emitter, op_id, BackupPhase::Snapshotting, 0, None, None);
    if cancel.is_cancelled() {
        return Err(cancelled_error());
    }
    snapshot_db_to(inputs.conn, &db_snapshot).await?;

    // ── Phase 2: build the ZIP payload (blocking) ────────────────────────
    let manifest_template = BackupManifest {
        format_version: BACKUP_FORMAT_VERSION,
        kind: BACKUP_KIND.to_string(),
        created_at: Utc::now().to_rfc3339(),
        app_version: inputs.app_version.to_string(),
        latest_migration: latest_migration_name(),
        runtime: inputs.runtime_label.to_string(),
        includes_external_transcripts: false, // set after packing
        includes_secrets: true,
        // Declare the full table: a restore replaces exactly these sections and
        // ignores anything a crafted archive staged outside them.
        managed_sections: Some(sections::all_section_ids()),
        degraded_sqlite: Vec::new(),
        entries: Vec::new(),
    };

    let live_roots = inputs.live_roots.clone();
    let include_external = options.include_external_transcripts;

    let zip_tmp_c = zip_tmp.clone();
    let db_snapshot_c = db_snapshot.clone();
    let cancel_c = cancel.clone();
    let emitter_c = emitter.clone();
    let op_id_c = op_id.to_string();

    // Walked up front so the progress bar has a denominator. Stat-only, next to
    // nothing against reading and deflating the same bytes. It is an estimate:
    // a SQLite store is archived as a page-copied snapshot whose size differs
    // from the live file's, and files can change mid-run.
    let total_estimate = total_plaintext_bytes(&live_roots, &db_snapshot, include_external);

    emit(
        emitter,
        op_id,
        BackupPhase::Archiving,
        0,
        Some(total_estimate),
        None,
    );
    let manifest = tokio::task::spawn_blocking(move || -> Result<BackupManifest, AppCommandError> {
        let mut builder = ArchiveBuilder::create(&zip_tmp_c)?;
        let mut prog = |path: &str, processed: u64| {
            emit(
                &emitter_c,
                &op_id_c,
                BackupPhase::Archiving,
                processed,
                Some(total_estimate.max(processed)),
                Some(path.to_string()),
            );
        };
        builder.add_file("db/codeg.db", &db_snapshot_c, &cancel_c, &mut prog)?;
        // Every codeg-owned section, straight off the shared table — see
        // `sections.rs` for why this must not be re-hardcoded here.
        let exclude = |rel: &Path| sections::is_excluded_section_entry(rel);
        for section in sections::MANAGED_SECTIONS {
            let Some(live) = live_roots.path(section.id) else {
                continue;
            };
            match section.kind {
                SectionKind::Dir => {
                    builder.add_dir(section.id, live, &exclude, &cancel_c, &mut prog)?
                }
                SectionKind::File => {
                    if live.is_file() {
                        builder.add_file(section.id, live, &cancel_c, &mut prog)?;
                    }
                }
            }
        }
        let mut manifest = manifest_template;
        if include_external {
            let pack = external::add_external_sources(
                &mut builder,
                &external_scratch,
                &cancel_c,
                &mut prog,
            )?;
            manifest.includes_external_transcripts = pack.packed;
            // A store that could not be snapshotted cleanly must reach the UI;
            // a `tracing::warn!` would let a degraded backup be reported as a
            // clean one.
            manifest.degraded_sqlite = pack.degraded;
        }
        builder.finish(manifest)
    })
    .await
    .map_err(|e| AppCommandError::task_execution_failed("Archive task failed").with_detail(e.to_string()))??;

    // ── Phase 3: deliver (encrypt or copy) into dest_path atomically ─────
    let part = with_part_suffix(dest_path);
    if let Some(parent) = dest_path.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }
    match options.passphrase.as_deref().filter(|p| !p.is_empty()) {
        Some(pass) => {
            emit(emitter, op_id, BackupPhase::Encrypting, 0, None, None);
            let zip_tmp_c = zip_tmp.clone();
            let part_c = part.clone();
            let pass = pass.to_string();
            let cancel_c = cancel.clone();
            tokio::task::spawn_blocking(move || crypto::encrypt_file(&zip_tmp_c, &part_c, &pass, &cancel_c))
                .await
                .map_err(|e| AppCommandError::task_execution_failed("Encrypt task failed").with_detail(e.to_string()))??;
        }
        None => {
            tokio::fs::copy(&zip_tmp, &part)
                .await
                .map_err(super::map_disk_full)?;
        }
    }
    tokio::fs::rename(&part, dest_path).await.map_err(AppCommandError::io)?;

    let total = manifest.total_bytes();
    emit(emitter, op_id, BackupPhase::Done, total, Some(total), None);
    Ok(manifest)
}

/// Scan a backup for external transcript entries whose live target already
/// exists. Called only when the user opts to restore to original locations,
/// so the UI can surface conflicts before any write.
pub(crate) async fn scan_external_conflicts_core(
    zip_path: &Path,
) -> Result<Vec<super::external::ExternalConflict>, AppCommandError> {
    let zip = zip_path.to_path_buf();
    tokio::task::spawn_blocking(move || super::external::scan_external_conflicts(&zip))
        .await
        .map_err(|e| AppCommandError::task_execution_failed("Scan task failed").with_detail(e.to_string()))?
}

/// Run `VACUUM INTO` to produce a transactionally-consistent, defragmented
/// single-file copy of the live DB — sidesteps the WAL `-wal`/`-shm` sidecars.
pub(crate) async fn snapshot_db_to(
    conn: &DatabaseConnection,
    dest: &Path,
) -> Result<(), AppCommandError> {
    // VACUUM INTO requires the destination not to exist.
    if dest.exists() {
        tokio::fs::remove_file(dest).await.map_err(AppCommandError::io)?;
    }
    let dest_lit = dest.to_string_lossy().replace('\'', "''");
    let sql = format!("VACUUM INTO '{dest_lit}';");
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await
        .map_err(|e| AppCommandError::database_error("VACUUM INTO failed").with_detail(e.to_string()))?;
    Ok(())
}

/// Plaintext bytes the archive is about to hold, so the progress bar is not
/// stuck in the indeterminate state for the whole run. Stat-only.
fn total_plaintext_bytes(live_roots: &LiveRoots, db_snapshot: &Path, include_external: bool) -> u64 {
    fn dir_bytes(root: &Path, exclude: &dyn Fn(&Path) -> bool) -> u64 {
        walkdir::WalkDir::new(root)
            .follow_links(false)
            .into_iter()
            .flatten()
            .filter(|e| e.file_type().is_file())
            .filter(|e| {
                e.path()
                    .strip_prefix(root)
                    .map(|rel| !exclude(rel))
                    .unwrap_or(false)
            })
            .filter_map(|e| e.metadata().ok())
            .map(|m| m.len())
            .sum()
    }

    let mut total = std::fs::metadata(db_snapshot).map(|m| m.len()).unwrap_or(0);
    for section in sections::MANAGED_SECTIONS {
        let Some(live) = live_roots.path(section.id) else {
            continue;
        };
        total += match section.kind {
            SectionKind::Dir => dir_bytes(live, &sections::is_excluded_section_entry),
            SectionKind::File => std::fs::metadata(live).map(|m| m.len()).unwrap_or(0),
        };
    }
    if include_external {
        total += external::estimated_source_bytes();
    }
    total
}

/// Private scratch root under the data dir, created `0700` on Unix. Shared
/// with the server-mode export staging area, which `cleanup_transient_dirs`
/// already wipes at startup.
pub(crate) fn scratch_root(data_dir: &Path) -> Result<PathBuf, AppCommandError> {
    let root = data_dir.join(super::restore::EXPORT_TMP_DIR);
    std::fs::create_dir_all(&root).map_err(AppCommandError::io)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700));
    }
    Ok(root)
}

/// `(compatible, reject_reason_i18n_key)`. Schema compatibility is keyed off
/// the migration identity (more robust than semver): an unknown
/// `latest_migration` means the backup is newer than this binary understands.
pub(crate) fn evaluate_compat(manifest: &BackupManifest) -> (bool, Option<String>) {
    if manifest.format_version > BACKUP_FORMAT_VERSION || manifest.kind != BACKUP_KIND {
        return (false, Some(BACKUP_I18N_KEY_UNKNOWN_FORMAT.to_string()));
    }
    if !known_migration(&manifest.latest_migration) {
        return (false, Some(BACKUP_I18N_KEY_NEWER_VERSION.to_string()));
    }
    (true, None)
}

fn latest_migration_name() -> String {
    Migrator::migrations()
        .last()
        .map(|m| m.name().to_string())
        .unwrap_or_default()
}

fn known_migration(name: &str) -> bool {
    Migrator::migrations().iter().any(|m| m.name() == name)
}

fn with_part_suffix(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

fn emit(
    emitter: &EventEmitter,
    op_id: &str,
    phase: BackupPhase,
    processed: u64,
    total: Option<u64>,
    path: Option<String>,
) {
    emit_event(
        emitter,
        BACKUP_PROGRESS_EVENT,
        BackupProgress {
            op_id: op_id.to_string(),
            phase,
            processed_bytes: processed,
            total_bytes: total,
            current_path: path,
            error: None,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::backup::archive;
    use crate::db::test_helpers::fresh_disk_db;
    use sea_orm::Database;

    async fn count_folders(db_path: &Path) -> i64 {
        let url = format!("sqlite:{}?mode=ro", db_path.to_string_lossy());
        let conn = Database::connect(url).await.expect("open restored db");
        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS c FROM folder;".to_owned(),
            ))
            .await
            .expect("query")
            .expect("row");
        row.try_get::<i64>("", "c").expect("count")
    }

    /// Every managed section rooted under `live_base/<id>` so the test drives
    /// the real `MANAGED_SECTIONS` table without touching the user's `~/.codeg`.
    fn inputs<'a>(
        conn: &'a DatabaseConnection,
        data_dir: &'a Path,
        live_base: &Path,
    ) -> BackupInputs<'a> {
        BackupInputs {
            conn,
            data_dir,
            live_roots: LiveRoots::rooted_at(live_base),
            app_version: "0.15.0",
            runtime_label: "server",
        }
    }

    #[tokio::test]
    async fn backup_roundtrip_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(dir.path()).await;
        crate::db::service::folder_service::add_folder(&db.conn, "/tmp/proj")
            .await
            .expect("seed folder");

        let live = dir.path().join("live");
        let uploads = live.join("uploads");
        std::fs::create_dir_all(uploads.join(".tmp")).unwrap();
        std::fs::write(uploads.join("att.txt"), b"attachment").unwrap();
        std::fs::write(uploads.join(".tmp/partial"), b"should be skipped").unwrap();
        let dest = dir.path().join("backup.codeg.zip");

        let cancel = CancellationToken::new();
        let manifest = create_backup_core(
            inputs(&db.conn, dir.path(), &live),
            BackupOptions::default(),
            &dest,
            &EventEmitter::Noop,
            "t1",
            &cancel,
        )
        .await
        .unwrap();

        assert!(dest.exists());
        // Scratch is under the data dir, not `std::env::temp_dir()`: on Linux
        // that is often tmpfs, so a multi-GB archive would be built in RAM,
        // and a cross-filesystem temp turns the delivery rename into a copy.
        assert!(
            dir.path()
                .join(crate::commands::backup::restore::EXPORT_TMP_DIR)
                .is_dir(),
            "the archive must be assembled under the data dir"
        );
        assert!(manifest.entries.iter().any(|e| e.path == "db/codeg.db"));
        assert!(manifest.entries.iter().any(|e| e.path == "uploads/att.txt"));
        assert!(!manifest.entries.iter().any(|e| e.path.contains(".tmp")));

        // Preparing the source must report compatible (uses our own latest
        // migration) without copying a plaintext archive anywhere.
        let prepared = super::super::source::prepare_source_core(&dest, dir.path(), None, false)
            .await
            .unwrap();
        assert!(!prepared.preview.encrypted);
        assert!(
            prepared.preview.compatible,
            "reject: {:?}",
            prepared.preview.reject_reason
        );

        // Extract and confirm the snapshot is a real DB carrying our row.
        let out = dir.path().join("out");
        archive::extract_all(&dest, &out, &manifest, &cancel, &mut archive::null_progress())
            .unwrap();
        assert_eq!(count_folders(&out.join("db/codeg.db")).await, 1);
    }

    #[tokio::test]
    async fn backup_roundtrip_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(dir.path()).await;
        let live = dir.path().join("live");
        std::fs::create_dir_all(live.join("uploads")).unwrap();
        let dest = dir.path().join("backup.codegbak");

        let cancel = CancellationToken::new();
        create_backup_core(
            inputs(&db.conn, dir.path(), &live),
            BackupOptions {
                include_external_transcripts: false,
                passphrase: Some("s3cret".to_string()),
            },
            &dest,
            &EventEmitter::Noop,
            "t2",
            &cancel,
        )
        .await
        .unwrap();

        assert!(crypto::is_encrypted(&dest).unwrap());

        // No passphrase → locked preview, no handle issued.
        let locked = super::super::source::prepare_source_core(&dest, dir.path(), None, false)
            .await
            .unwrap();
        assert!(locked.source_id.is_none());
        assert!(
            locked.preview.encrypted
                && locked.preview.needs_passphrase
                && locked.preview.manifest.is_none()
        );

        // Wrong passphrase → authentication error.
        assert!(
            super::super::source::prepare_source_core(&dest, dir.path(), Some("wrong"), false)
                .await
                .is_err()
        );

        // Correct passphrase → manifest readable + compatible.
        let unlocked = super::super::source::prepare_source_core(&dest, dir.path(), Some("s3cret"), false)
            .await
            .unwrap();
        assert!(unlocked.source_id.is_some());
        assert!(unlocked.preview.manifest.is_some());
        assert!(unlocked.preview.compatible);
    }

    #[tokio::test]
    async fn backup_then_stage_then_apply_roundtrip() {
        use super::super::restore::{
            apply_pending_restore_with_paths, stage_restore_core, RestoreApplied,
            PENDING_MARKER,
        };

        let src_dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(src_dir.path()).await;
        crate::db::service::folder_service::add_folder(&db.conn, "/tmp/proj-a")
            .await
            .unwrap();
        crate::db::service::folder_service::add_folder(&db.conn, "/tmp/proj-b")
            .await
            .unwrap();
        let live = src_dir.path().join("live");
        std::fs::create_dir_all(live.join("uploads")).unwrap();
        let dest = src_dir.path().join("backup.codeg.zip");

        let cancel = CancellationToken::new();
        create_backup_core(
            inputs(&db.conn, src_dir.path(), &live),
            BackupOptions::default(),
            &dest,
            &EventEmitter::Noop,
            "b1",
            &cancel,
        )
        .await
        .unwrap();

        // Stage into a fresh, separate data dir.
        let restore_dir = tempfile::tempdir().unwrap();
        let staged = stage_restore_core(
            &dest,
            restore_dir.path(),
                        &EventEmitter::Noop,
            "r1",
            &cancel,
        )
        .await
        .unwrap();
        assert!(PathBuf::from(&staged.staging_dir).join("db/codeg.db").exists());
        assert!(restore_dir.path().join(PENDING_MARKER).is_file());

        // Apply on "startup" → live DB carries the two seeded folders. Inject
        // temp section roots so the test never touches ~/.codeg.
        let restore_live = LiveRoots::rooted_at(&restore_dir.path().join("live"));
        let applied =
            apply_pending_restore_with_paths(restore_dir.path(), &restore_live).unwrap();
        assert!(matches!(applied, RestoreApplied::Applied { .. }));
        let db_name = crate::db::database_file_name();
        assert_eq!(count_folders(&restore_dir.path().join(db_name)).await, 2);
        assert!(!restore_dir.path().join(PENDING_MARKER).exists());
    }

    #[tokio::test]
    async fn restore_with_empty_uploads_clears_live_uploads() {
        // A backup whose uploads section is empty must REPLACE (clear) live
        // uploads, not merge — the prior file survives only in the safety
        // snapshot.
        use super::super::restore::{
            apply_pending_restore_with_paths, stage_restore_core,
        };
        let src_dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(src_dir.path()).await;
        let live = src_dir.path().join("live");
        std::fs::create_dir_all(live.join("uploads")).unwrap(); // exists, no files
        let dest = src_dir.path().join("backup.codeg.zip");
        let cancel = CancellationToken::new();
        create_backup_core(
            inputs(&db.conn, src_dir.path(), &live),
            BackupOptions::default(),
            &dest,
            &EventEmitter::Noop,
            "e1",
            &cancel,
        )
        .await
        .unwrap();

        let restore_dir = tempfile::tempdir().unwrap();
        stage_restore_core(
            &dest,
            restore_dir.path(),
                        &EventEmitter::Noop,
            "e2",
            &cancel,
        )
        .await
        .unwrap();

        // Live uploads has a stale file that the backup does not contain.
        let restore_live_base = restore_dir.path().join("live");
        let live_uploads = restore_live_base.join("uploads");
        std::fs::create_dir_all(&live_uploads).unwrap();
        std::fs::write(live_uploads.join("stale.png"), b"old").unwrap();

        apply_pending_restore_with_paths(
            restore_dir.path(),
            &LiveRoots::rooted_at(&restore_live_base),
        )
        .unwrap();

        // Stale file is gone from live uploads (preserved only in the snapshot).
        assert!(!live_uploads.join("stale.png").exists());
    }

    /// The structural guarantee against D1 recurring: drive the whole
    /// `MANAGED_SECTIONS` table end to end. A section added to the table but
    /// not wired into packing OR swapping fails here instead of silently
    /// vanishing from users' backups.
    #[tokio::test]
    async fn every_section_is_packed_and_swapped() {
        use super::super::restore::{
            apply_pending_restore_with_paths, stage_restore_core,
        };
        use super::super::sections::{SectionKind, MANAGED_SECTIONS};

        let src_dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(src_dir.path()).await;
        let live = src_dir.path().join("live");

        // A sentinel in every section, at a path shaped like the real thing.
        for section in MANAGED_SECTIONS {
            let path = live.join(section.id);
            match section.kind {
                SectionKind::Dir => {
                    std::fs::create_dir_all(&path).unwrap();
                    std::fs::write(path.join("sentinel.txt"), section.id.as_bytes()).unwrap();
                }
                SectionKind::File => {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                    std::fs::write(&path, section.id.as_bytes()).unwrap();
                }
            }
        }

        let dest = src_dir.path().join("backup.codeg.zip");
        let cancel = CancellationToken::new();
        let manifest = create_backup_core(
            inputs(&db.conn, src_dir.path(), &live),
            BackupOptions::default(),
            &dest,
            &EventEmitter::Noop,
            "sec1",
            &cancel,
        )
        .await
        .unwrap();

        // Packed: every section contributed its sentinel entry.
        for section in MANAGED_SECTIONS {
            let expected = match section.kind {
                SectionKind::Dir => format!("{}/sentinel.txt", section.id),
                SectionKind::File => section.id.to_string(),
            };
            assert!(
                manifest.entries.iter().any(|e| e.path == expected),
                "section '{}' was never packed (missing archive entry {expected})",
                section.id
            );
        }
        assert_eq!(
            manifest.managed_sections.as_deref(),
            Some(super::super::sections::all_section_ids().as_slice()),
            "the archive must declare the full table"
        );
        // An archive that manages more than the legacy three must not claim
        // format 1. A v1 reader parses it happily (the new manifest fields are
        // additive), restores the database, silently drops every section it
        // has no live path for, and reports success — handing back
        // conversations with no messages. The version gate is what turns that
        // into an up-front refusal.
        assert!(
            manifest.format_version > 1,
            "declaring new sections requires a format bump"
        );

        // Swapped: stage + apply into a fresh data dir brings them all back.
        let restore_dir = tempfile::tempdir().unwrap();
        stage_restore_core(
            &dest,
            restore_dir.path(),
                        &EventEmitter::Noop,
            "sec2",
            &cancel,
        )
        .await
        .unwrap();
        let restore_live = restore_dir.path().join("live");
        apply_pending_restore_with_paths(restore_dir.path(), &LiveRoots::rooted_at(&restore_live))
            .unwrap();

        for section in MANAGED_SECTIONS {
            let path = match section.kind {
                SectionKind::Dir => restore_live.join(section.id).join("sentinel.txt"),
                SectionKind::File => restore_live.join(section.id),
            };
            assert_eq!(
                std::fs::read(&path).ok().as_deref(),
                Some(section.id.as_bytes()),
                "section '{}' was never swapped back in ({} missing)",
                section.id,
                path.display()
            );
        }
    }

    /// D1 itself: the conversation text of a custom ACP agent lives ONLY in
    /// `~/.codeg/acp-transcripts`, so this is the round-trip that used to lose
    /// every message while keeping the conversation row.
    #[tokio::test]
    async fn custom_agent_transcript_survives_roundtrip() {
        use super::super::restore::{
            apply_pending_restore_with_paths, stage_restore_core,
        };
        let src_dir = tempfile::tempdir().unwrap();
        let db = fresh_disk_db(src_dir.path()).await;
        let live = src_dir.path().join("live");
        let transcript = live.join("acp-transcripts").join("sess-abc.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, b"{\"type\":\"user\",\"text\":\"hello\"}\n").unwrap();

        let dest = src_dir.path().join("backup.codeg.zip");
        let cancel = CancellationToken::new();
        create_backup_core(
            inputs(&db.conn, src_dir.path(), &live),
            BackupOptions::default(),
            &dest,
            &EventEmitter::Noop,
            "d1a",
            &cancel,
        )
        .await
        .unwrap();

        let restore_dir = tempfile::tempdir().unwrap();
        stage_restore_core(
            &dest,
            restore_dir.path(),
                        &EventEmitter::Noop,
            "d1b",
            &cancel,
        )
        .await
        .unwrap();
        let restore_live = restore_dir.path().join("live");
        apply_pending_restore_with_paths(restore_dir.path(), &LiveRoots::rooted_at(&restore_live))
            .unwrap();

        assert_eq!(
            std::fs::read(restore_live.join("acp-transcripts").join("sess-abc.jsonl")).unwrap(),
            b"{\"type\":\"user\",\"text\":\"hello\"}\n"
        );
    }

    fn manifest_with_migration(latest_migration: &str, format_version: u32) -> BackupManifest {
        BackupManifest {
            format_version,
            kind: BACKUP_KIND.to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "9.9.9".to_string(),
            latest_migration: latest_migration.to_string(),
            runtime: "server".to_string(),
            includes_external_transcripts: false,
            includes_secrets: true,
            managed_sections: None,
            degraded_sqlite: Vec::new(),
            entries: Vec::new(),
        }
    }

    #[test]
    fn evaluate_compat_gates_on_migration_and_format() {
        // A migration this binary knows → compatible.
        let known = latest_migration_name();
        let (ok, reason) = evaluate_compat(&manifest_with_migration(&known, BACKUP_FORMAT_VERSION));
        assert!(ok && reason.is_none());

        // A migration we don't know → newer version, rejected.
        let (ok, reason) =
            evaluate_compat(&manifest_with_migration("m99999999_000001_from_the_future", 1));
        assert!(!ok);
        assert_eq!(reason.as_deref(), Some(BACKUP_I18N_KEY_NEWER_VERSION));

        // A newer archive layout → unknown format.
        let (ok, reason) =
            evaluate_compat(&manifest_with_migration(&known, BACKUP_FORMAT_VERSION + 1));
        assert!(!ok);
        assert_eq!(reason.as_deref(), Some(BACKUP_I18N_KEY_UNKNOWN_FORMAT));
    }
}
