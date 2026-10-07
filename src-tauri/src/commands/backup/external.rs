//! Optional external agent-CLI transcript handling (the "include conversation
//! content" toggle).
//!
//! Backup packs each source under `external/<agent>/`. Restore never silently
//! clobbers a live CLI directory: callers either drop these (Skip), extract
//! them to a safe side folder (SideLocation), or — only with an explicit
//! conflict decision — write them back to their original locations
//! (OriginalLocations), where any file that already exists is skipped unless
//! the user authorized overwriting.

use std::fs::{File, OpenOptions};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tokio_util::sync::CancellationToken;
use zip::ZipArchive;

use crate::app_error::AppCommandError;
use crate::parsers::{external_transcript_sources, ExternalSource};

use super::archive::{ArchiveBuilder, ProgressFn};
use super::manifest::{DegradedSqlite, SqliteDegradation};
use super::restore::ConflictPolicy;
use super::{cancelled_error, unknown_format_error};

/// A staged external file whose target already exists on disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalConflict {
    pub agent: String,
    /// Path inside the archive (e.g. `external/claude/projects/foo.jsonl`).
    pub archive_path: String,
    /// Absolute live path the entry would overwrite.
    pub target_path: String,
    pub target_size: Option<u64>,
}

/// What packing the external trees produced.
#[derive(Debug, Default)]
pub struct ExternalPack {
    /// Any source contributed (drives `includes_external_transcripts`).
    pub packed: bool,
    /// SQLite stores that could not be snapshotted the normal way.
    pub degraded: Vec<DegradedSqlite>,
}

/// A SQLite main database file inside a `sqlite: true` source.
fn is_sqlite_main(name: &str) -> bool {
    name.ends_with(".db")
}

/// Its WAL/SHM sidecars. Never archived and never published — see
/// [`ExternalSource::sqlite`].
fn is_sqlite_sidecar(name: &str) -> bool {
    name.ends_with(".db-wal") || name.ends_with(".db-shm")
}

fn sidecar_of(db: &Path, suffix: &str) -> PathBuf {
    let mut s = db.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// Honor a source's `include_top` allowlist, so a mixed base dir (e.g.
/// Gemini's, which holds credentials next to transcripts) only contributes its
/// transcript/session subtrees.
fn top_excluded(include_top: Option<&'static [&'static str]>, rel: &Path) -> bool {
    match include_top {
        None => false,
        Some(allow) => match rel.components().next() {
            Some(std::path::Component::Normal(first)) => {
                let first = first.to_string_lossy();
                !allow.iter().any(|a| *a == first)
            }
            _ => true,
        },
    }
}

/// Pack external transcript trees into the archive. `scratch` is a private
/// working directory (under the data dir) used to stage SQLite snapshots.
pub fn add_external_sources(
    builder: &mut ArchiveBuilder,
    scratch: &Path,
    cancel: &CancellationToken,
    progress: &mut ProgressFn<'_>,
) -> Result<ExternalPack, AppCommandError> {
    add_external_sources_with(
        builder,
        scratch,
        &external_transcript_sources(),
        cancel,
        progress,
    )
}

fn add_external_sources_with(
    builder: &mut ArchiveBuilder,
    scratch: &Path,
    sources: &[ExternalSource],
    cancel: &CancellationToken,
    progress: &mut ProgressFn<'_>,
) -> Result<ExternalPack, AppCommandError> {
    let mut out = ExternalPack::default();
    for src in sources {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        if !src.root.exists() {
            continue;
        }
        let prefix = format!("external/{}", src.agent);
        if src.is_file {
            let name = src
                .root
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("data");
            let entry = format!("{prefix}/{name}");
            if src.sqlite && is_sqlite_main(name) {
                pack_sqlite_store(
                    builder,
                    src.agent,
                    &entry,
                    &src.root,
                    scratch,
                    cancel,
                    progress,
                    &mut out.degraded,
                )?;
            } else {
                builder.add_file(&entry, &src.root, cancel, progress)?;
            }
        } else if src.sqlite {
            add_sqlite_dir(
                builder,
                &prefix,
                src,
                scratch,
                cancel,
                progress,
                &mut out.degraded,
            )?;
        } else {
            let include_top = src.include_top;
            let exclude = move |rel: &Path| top_excluded(include_top, rel);
            builder.add_dir(&prefix, &src.root, &exclude, cancel, progress)?;
        }
        out.packed = true;
    }
    Ok(out)
}

/// Plaintext bytes the external sources will contribute, for the progress
/// bar's denominator. Stat-only, and an estimate: a SQLite store is archived
/// as a page-copied snapshot whose size differs from the live file's.
pub fn estimated_source_bytes() -> u64 {
    let mut total = 0u64;
    for src in external_transcript_sources() {
        if !src.root.exists() {
            continue;
        }
        if src.is_file {
            total += std::fs::metadata(&src.root).map(|m| m.len()).unwrap_or(0);
            continue;
        }
        for entry in walkdir::WalkDir::new(&src.root)
            .follow_links(false)
            .into_iter()
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let Ok(rel) = entry.path().strip_prefix(&src.root) else {
                continue;
            };
            if top_excluded(src.include_top, rel) {
                continue;
            }
            if src.sqlite && is_sqlite_sidecar(&entry.file_name().to_string_lossy()) {
                continue;
            }
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    total
}

/// Walk a directory source that holds SQLite stores (Cursor's per-chat
/// `store.db`, Antigravity's per-session `<id>.db`), snapshotting each `.db`
/// and dropping every sidecar. Non-database siblings (`.meta`, `meta.json`)
/// are archived verbatim.
fn add_sqlite_dir(
    builder: &mut ArchiveBuilder,
    prefix: &str,
    src: &ExternalSource,
    scratch: &Path,
    cancel: &CancellationToken,
    progress: &mut ProgressFn<'_>,
    degraded: &mut Vec<DegradedSqlite>,
) -> Result<(), AppCommandError> {
    for entry in walkdir::WalkDir::new(&src.root).follow_links(false) {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let entry = entry.map_err(|e| {
            AppCommandError::io_error("Failed to walk directory").with_detail(e.to_string())
        })?;
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(&src.root) else {
            continue;
        };
        if top_excluded(src.include_top, rel) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // The invariant the whole restore path leans on: one archive entry per
        // database, so "new db next to a stale wal" is not a state the archive
        // can even describe.
        if is_sqlite_sidecar(&name) {
            continue;
        }
        let entry_name = format!("{prefix}/{}", to_slash(rel));
        if is_sqlite_main(&name) {
            pack_sqlite_store(
                builder,
                src.agent,
                &entry_name,
                entry.path(),
                scratch,
                cancel,
                progress,
                degraded,
            )?;
        } else {
            builder.add_file(&entry_name, entry.path(), cancel, progress)?;
        }
    }
    Ok(())
}

/// Add one SQLite store to the archive as a single self-contained file.
#[allow(clippy::too_many_arguments)]
fn pack_sqlite_store(
    builder: &mut ArchiveBuilder,
    agent: &str,
    entry_name: &str,
    live_db: &Path,
    scratch: &Path,
    cancel: &CancellationToken,
    progress: &mut ProgressFn<'_>,
    degraded: &mut Vec<DegradedSqlite>,
) -> Result<(), AppCommandError> {
    // A zero-byte `.db` is a placeholder the agent has not written yet; there
    // is nothing for SQLite to copy, so take the bytes as they are.
    if std::fs::metadata(live_db).map(|m| m.len()).unwrap_or(0) == 0 {
        return builder.add_file(entry_name, live_db, cancel, progress);
    }

    let snap = scratch.join(format!("{}.db", uuid::Uuid::new_v4().simple()));

    // (a) The normal path: a read-only page copy. Page copy, not `VACUUM` —
    //     VACUUM may renumber the ROWID of any table without an explicit
    //     INTEGER PRIMARY KEY, and we cannot audit a third-party schema for
    //     tables that use rowid as a key. Read-only, not read-write — opening
    //     someone else's store for writing runs hot-journal/WAL recovery
    //     inside it.
    match page_copy_readonly(live_db, &snap) {
        Ok(()) => {
            let r = builder.add_file(entry_name, &snap, cancel, progress);
            let _ = std::fs::remove_file(&snap);
            return r;
        }
        Err(e) => {
            // Expected when the store has a live `-wal` but no `-shm` (the CLI
            // crashed): a read-only connection may not create the shm.
            tracing::warn!(
                "[BACKUP] read-only snapshot of {} failed ({e}); recovering on a private copy",
                live_db.display()
            );
            let _ = std::fs::remove_file(&snap);
        }
    }

    // (b) Degraded: copy the whole group into our own scratch, prove it is
    //     coherent, and let SQLite recover it THERE.
    match recover_on_private_copy(live_db, &snap, scratch) {
        Ok(level) => {
            let r = builder.add_file(entry_name, &snap, cancel, progress);
            let _ = std::fs::remove_file(&snap);
            degraded.push(DegradedSqlite {
                agent: agent.to_string(),
                archive_path: entry_name.to_string(),
                level,
            });
            r
        }
        Err(reason) => {
            let _ = std::fs::remove_file(&snap);
            tracing::error!(
                "[BACKUP] {} not archived: {reason}",
                live_db.display()
            );
            degraded.push(DegradedSqlite {
                agent: agent.to_string(),
                archive_path: entry_name.to_string(),
                level: SqliteDegradation::NotArchived,
            });
            Ok(())
        }
    }
}

/// Page-copy `src` into `dest` through a read-only connection.
fn page_copy_readonly(src: &Path, dest: &Path) -> Result<(), rusqlite::Error> {
    let _ = std::fs::remove_file(dest);
    let conn = Connection::open_with_flags(
        src,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.backup(rusqlite::DatabaseName::Main, dest, None)
}

/// Byte-level identity of a store *group*, used to prove the main file and its
/// WAL were copied from the same instant. The first 100 bytes are the SQLite
/// header, which carries the change counter and page count — a running
/// checkpoint moves them.
#[derive(Debug, PartialEq, Eq)]
struct StoreFingerprint {
    db: (u64, Option<SystemTime>),
    header: Vec<u8>,
    wal: Option<(u64, Option<SystemTime>)>,
}

fn fingerprint(db: &Path) -> Option<StoreFingerprint> {
    let meta = std::fs::metadata(db).ok()?;
    let mut header = Vec::new();
    File::open(db)
        .ok()?
        .take(100)
        .read_to_end(&mut header)
        .ok()?;
    let wal = std::fs::metadata(sidecar_of(db, "-wal"))
        .ok()
        .map(|m| (m.len(), m.modified().ok()));
    Some(StoreFingerprint {
        db: (meta.len(), meta.modified().ok()),
        header,
        wal,
    })
}

/// Copy the store and its sidecars into our own scratch, prove the group is
/// coherent, then let SQLite recover it **there** and page-copy one
/// self-contained file out. The source is never opened for writing.
///
/// The coherence proof is the point. A main file copied while a checkpoint is
/// running is a mixture of pre- and post-checkpoint pages, and if the
/// checkpoint completes (resetting the WAL) before we copy the WAL, the WAL we
/// get belongs to a later generation. SQLite applies it *successfully* and
/// produces a structurally valid database holding half of some atomic
/// transaction — `integrity_check` and the backup API both stay silent. A
/// per-file checksum proves byte integrity, not cross-file coherence, so the
/// only available proof is "the source did not move between the two reads".
fn recover_on_private_copy(
    live_db: &Path,
    snap: &Path,
    scratch: &Path,
) -> Result<SqliteDegradation, String> {
    const ATTEMPTS: usize = 3;
    let work = scratch.join(format!("recover-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let copy_db = work.join("store.db");

    let mut coherent = false;
    // A WAL that exists but could not be read (permissions, a Windows sharing
    // lock). Recovering without it would produce a snapshot that is missing
    // committed frames while `RecoveredOnCopy` claims it is complete, so the
    // outcome has to be downgraded instead.
    let mut wal_unreadable = false;
    for _ in 0..ATTEMPTS {
        let Some(before) = fingerprint(live_db) else {
            break;
        };
        for sc in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(sidecar_of(&copy_db, sc));
        }
        // Main file first: a WAL read afterwards is a superset of it, which is
        // the only ordering a cold copy of a live store can justify.
        if std::fs::copy(live_db, &copy_db).is_err() {
            continue;
        }
        let mut wal_failed = false;
        for sc in ["-wal", "-shm"] {
            let s = sidecar_of(live_db, sc);
            if s.exists() && std::fs::copy(&s, sidecar_of(&copy_db, sc)).is_err() {
                // `-shm` is a rebuildable index, but a missing `-wal` means
                // lost commits; only that one downgrades the result.
                wal_failed |= sc == "-wal";
            }
        }
        if fingerprint(live_db).as_ref() == Some(&before) {
            coherent = true;
            wal_unreadable = wal_failed;
            break;
        }
    }
    if !coherent {
        let _ = std::fs::remove_dir_all(&work);
        return Err("store kept changing while it was being copied".to_string());
    }

    // Read-write here is on OUR copy, so the recovery has no effect outside
    // this scratch dir. It is skipped entirely when the WAL never made it:
    // SQLite would happily "recover" the main file alone and report success.
    let recovered = if wal_unreadable {
        tracing::warn!(
            "[BACKUP] the WAL beside {} could not be read; archiving the main file alone",
            live_db.display()
        );
        Err("write-ahead log could not be copied".to_string())
    } else {
        recover_and_page_copy(&copy_db, snap).map_err(|e| e.to_string())
    };
    let level = match recovered {
        Ok(()) => SqliteDegradation::RecoveredOnCopy,
        Err(e) => {
            tracing::warn!(
                "[BACKUP] no complete snapshot of {} ({e}); archiving the bare file",
                live_db.display()
            );
            // The copy is a *stable* at-rest database: a source that did not
            // move is not mid-checkpoint. It is simply missing whatever the
            // WAL held.
            std::fs::copy(&copy_db, snap).map_err(|e| e.to_string())?;
            SqliteDegradation::BareFileOnly
        }
    };
    let _ = std::fs::remove_dir_all(&work);
    Ok(level)
}

fn recover_and_page_copy(copy_db: &Path, dest: &Path) -> Result<(), rusqlite::Error> {
    let _ = std::fs::remove_file(dest);
    let conn = Connection::open(copy_db)?;
    conn.backup(rusqlite::DatabaseName::Main, dest, None)
}

/// Scan a (plaintext) backup ZIP for external entries whose live target already
/// exists, so the UI can surface conflicts before any write.
pub fn scan_external_conflicts(
    zip_path: &Path,
) -> Result<Vec<ExternalConflict>, AppCommandError> {
    scan_external_conflicts_with_sources(zip_path, &external_transcript_sources())
}

fn scan_external_conflicts_with_sources(
    zip_path: &Path,
    sources: &[ExternalSource],
) -> Result<Vec<ExternalConflict>, AppCommandError> {
    let f = File::open(zip_path).map_err(AppCommandError::io)?;
    let mut ar = ZipArchive::new(BufReader::new(f)).map_err(|_| unknown_format_error())?;

    let mut conflicts = Vec::new();
    for i in 0..ar.len() {
        let entry = ar.by_index(i).map_err(|_| unknown_format_error())?;
        if entry.is_dir() {
            continue;
        }
        let Some(rel) = entry.enclosed_name() else {
            continue;
        };
        let rel_str = to_slash(&rel);
        let Some((agent, _base, target)) = map_external_to_target(&rel_str, sources) else {
            continue;
        };
        // `symlink_metadata` matches the restore-side conflict test exactly, so
        // the preview reports dangling symlinks too (they are conflicts on
        // restore).
        if let Ok(meta) = std::fs::symlink_metadata(&target) {
            conflicts.push(ExternalConflict {
                agent,
                archive_path: rel_str,
                target_size: Some(meta.len()),
                target_path: target.to_string_lossy().into_owned(),
            });
        }
    }
    Ok(conflicts)
}

/// Why an archive entry was refused outright (never a user-visible conflict —
/// the live file is left exactly as it was).
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RefusalReason {
    /// A pre-fix archive that packed a `.db` and its `-wal` as two entries.
    /// Their coherence cannot be proven, so nothing is written.
    LegacyUnprovableSqlitePair,
}

/// One refused entry, reported so the UI can point at the side location.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefusedExternal {
    pub archive_path: String,
    pub target_path: String,
    pub reason: RefusalReason,
}

/// Outcome of writing external transcripts back to their original locations.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRestoreReport {
    /// Live paths left alone because they already existed and overwriting was
    /// not authorized.
    pub skipped_conflicts: Vec<String>,
    /// Entries we declined to publish for a structural reason.
    pub refused: Vec<RefusedExternal>,
}

/// Write already-extracted `external/<agent>/…` files from `staged_external`
/// back to their original CLI locations, honoring `policy`. Never overwrites a
/// conflicting file under `SkipExisting`.
pub fn restore_external_from_staging(
    staged_external: &Path,
    policy: ConflictPolicy,
    cancel: &CancellationToken,
) -> Result<ExternalRestoreReport, AppCommandError> {
    restore_external_with_sources(staged_external, &external_transcript_sources(), policy, cancel)
}

fn restore_external_with_sources(
    staged_external: &Path,
    sources: &[ExternalSource],
    policy: ConflictPolicy,
    cancel: &CancellationToken,
) -> Result<ExternalRestoreReport, AppCommandError> {
    let mut report = ExternalRestoreReport::default();

    for entry in walkdir::WalkDir::new(staged_external).follow_links(false) {
        if cancel.is_cancelled() {
            return Err(cancelled_error());
        }
        let entry = entry
            .map_err(|e| AppCommandError::io_error("Walk staged transcripts").with_detail(e.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        // Reconstruct the in-archive path (`external/<agent>/<rest>`) from the
        // staging-relative path so the same mapping as the scan applies.
        let rel = match entry.path().strip_prefix(staged_external) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let archive_path = format!("external/{}", to_slash(rel));
        // `map_external_to_target` enforces the per-agent allowlist + file-only
        // constraints, so a crafted archive entry (e.g. `external/gemini/
        // oauth_creds.json`) is dropped here rather than written to a live
        // config path.
        let Some((agent, base, target)) = map_external_to_target(&archive_path, sources) else {
            continue;
        };
        let sqlite_store = sources.iter().any(|s| s.agent == agent && s.sqlite)
            && target
                .file_name()
                .and_then(|n| n.to_str())
                .is_some_and(is_sqlite_main);

        // An archive made before this fix packed directory-source stores as
        // `<x>.db` PLUS `<x>.db-wal`. Whether those two belong to the same WAL
        // generation is not provable: `add_dir` may have read the main file
        // mid-checkpoint (a mixture of pre- and post-checkpoint pages), the
        // checkpoint may then have completed and reset the WAL, and the
        // `-wal` we archived may belong to the generation after it. SQLite
        // would apply it without complaint and produce a structurally valid
        // database containing half of some atomic transaction; neither
        // `integrity_check` nor the backup API would report anything. The
        // archive carries no anchor that could settle it (the main file's
        // header does not record the current WAL's salt), so refuse: the live
        // store keeps its own good copy, and SideLocation hands the raw files
        // over for the user to decide about.
        if sqlite_store && sidecar_of(entry.path(), "-wal").exists() {
            report.refused.push(RefusedExternal {
                archive_path,
                target_path: target.to_string_lossy().into_owned(),
                reason: RefusalReason::LegacyUnprovableSqlitePair,
            });
            continue;
        }

        match restore_one(entry.path(), &base, &target, policy, sqlite_store) {
            FileOutcome::Written => {}
            FileOutcome::Skipped => report
                .skipped_conflicts
                .push(target.to_string_lossy().into_owned()),
            FileOutcome::Failed => { /* logged in restore_one; non-fatal */ }
        }
    }
    Ok(report)
}

enum FileOutcome {
    Written,
    Skipped,
    Failed,
}

/// Place one staged file at `target` (which must live under `base`), never
/// leaving a partial file at the final path, never clobbering an existing file
/// under `SkipExisting`, and never following a symlinked parent component out
/// of `base`.
fn restore_one(
    src: &Path,
    base: &Path,
    target: &Path,
    policy: ConflictPolicy,
    sqlite_store: bool,
) -> FileOutcome {
    let exists = std::fs::symlink_metadata(target).is_ok();
    if exists && policy == ConflictPolicy::SkipExisting {
        // We are not replacing this store, so its sidecars are none of our
        // business either.
        return FileOutcome::Skipped;
    }
    let Some(parent) = target.parent() else {
        return FileOutcome::Failed;
    };
    // Refuse to write if any existing component between `base` and the target's
    // parent is a symlink — otherwise `create_dir_all`/rename would follow it
    // and write outside the agent's tree.
    if !parent_chain_is_safe(base, parent) {
        tracing::warn!("[RESTORE] external: symlinked parent under {}, skipping {}", base.display(), target.display());
        return FileOutcome::Failed;
    }
    if let Err(e) = std::fs::create_dir_all(parent) {
        tracing::error!("[RESTORE] external: mkdir {} failed: {e}", parent.display());
        return FileOutcome::Failed;
    }

    // A SQLite store always goes through the sidecar-clearing publication,
    // under either policy: even when the target is absent, a leftover `-wal`
    // beside it would be recovered into the database we are about to create.
    // (The `create_new` race guard the plain `SkipExisting` path gets is given
    // up here; the window is between the existence check above and the rename,
    // and the only writer that could hit it is the very CLI whose store is
    // being replaced.)
    if sqlite_store {
        return publish_sqlite(src, target, parent);
    }

    match policy {
        ConflictPolicy::SkipExisting => {
            // Atomic no-clobber: `create_new` fails if the path appeared in a
            // race. On a copy failure, remove the partial file we just created
            // so no half-written transcript is left at the live path.
            match OpenOptions::new().write(true).create_new(true).open(target) {
                Ok(mut out) => match File::open(src).and_then(|mut i| std::io::copy(&mut i, &mut out)) {
                    Ok(_) => FileOutcome::Written,
                    Err(e) => {
                        tracing::error!("[RESTORE] external: write {} failed: {e}", target.display());
                        let _ = std::fs::remove_file(target);
                        FileOutcome::Failed
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => FileOutcome::Skipped,
                Err(e) => {
                    tracing::error!("[RESTORE] external: create {} failed: {e}", target.display());
                    FileOutcome::Failed
                }
            }
        }
        ConflictPolicy::Overwrite => {
            // Write to a same-dir temp file, then publish by rename so the final
            // path never holds a partially-written file. The temp is cleaned up
            // on any failure.
            let tmp = parent.join(format!(".codeg-ext-{}.part", uuid::Uuid::new_v4().simple()));
            let write = (|| -> std::io::Result<()> {
                let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
                let mut input = File::open(src)?;
                std::io::copy(&mut input, &mut out)?;
                Ok(())
            })();
            if let Err(e) = write {
                tracing::error!("[RESTORE] external: stage temp for {} failed: {e}", target.display());
                let _ = std::fs::remove_file(&tmp);
                return FileOutcome::Failed;
            }
            // rename() can't replace an existing file on Windows; remove the
            // existing entry (file or symlink) first.
            if exists {
                let _ = std::fs::remove_file(target);
            }
            if let Err(e) = std::fs::rename(&tmp, target) {
                tracing::error!("[RESTORE] external: publish {} failed: {e}", target.display());
                let _ = std::fs::remove_file(&tmp);
                return FileOutcome::Failed;
            }
            FileOutcome::Written
        }
    }
}

/// Publish a SQLite store, deleting the live `-wal`/`-shm` **before** the new
/// main file lands.
///
/// Order matters, and so does the barrier. If the rename came first, a crash
/// before the sidecars were removed would leave "new db + old wal", which
/// SQLite replays into corruption on the next open — and external restore is a
/// one-shot action with no journal to resume from. Removing them first means
/// every crash point leaves either "old db, no wal" or "new db, no wal", both
/// of which are legal and unreplayable.
///
/// But syscall order is not power-loss order: unlink and rename each only
/// mutate the parent directory's metadata, so without a barrier a crash can
/// persist the rename while losing the earlier unlinks and hand back exactly
/// the state we set out to make impossible. Ordered-journal filesystems
/// (ext4 / APFS / XFS) do preserve it in practice, but POSIX does not, and
/// `data=writeback`, `nobarrier`, non-journalling filesystems and some network
/// mounts do not either. One `fsync` on the directory settles it.
///
/// Windows offers no directory handle to fsync; there `remove_file` and
/// `MoveFileEx` are ordered, journalled NTFS metadata transactions, so the
/// barrier is compiled out.
fn publish_sqlite(src: &Path, target: &Path, parent: &Path) -> FileOutcome {
    let tmp = parent.join(format!(".codeg-ext-{}.part", uuid::Uuid::new_v4().simple()));
    // 1. The replacement is fully on disk before anything live is touched.
    let staged = (|| -> std::io::Result<()> {
        let mut out = OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        let mut input = File::open(src)?;
        std::io::copy(&mut input, &mut out)?;
        out.sync_all()
    })();
    if let Err(e) = staged {
        tracing::error!(
            "[RESTORE] external: stage temp for {} failed: {e}",
            target.display()
        );
        let _ = std::fs::remove_file(&tmp);
        return FileOutcome::Failed;
    }

    // 2-4. Sidecars, then the database itself (Windows cannot rename over an
    //      existing file). Once ANY of these succeeds the live store is
    //      partly dismantled, and the staged replacement becomes the only
    //      copy of what should be there — see `fail_publication`.
    let mut dismantled = false;
    for victim in [
        sidecar_of(target, "-wal"),
        sidecar_of(target, "-shm"),
        target.to_path_buf(),
    ] {
        match std::fs::remove_file(&victim) {
            Ok(()) => dismantled = true,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                tracing::error!("[RESTORE] external: remove {} failed: {e}", victim.display());
                return fail_publication(&tmp, target, dismantled);
            }
        }
    }
    // The barrier is the whole reason the removals come first, so a failure
    // here means the ordering is unproven — stop before the rename rather than
    // publish a database that a crash could pair with a resurrected WAL. The
    // live store is left as "old db, no wal": legal, unreplayable, and only
    // missing frames the archive was going to replace anyway.
    if let Err(e) = sync_dir(parent) {
        tracing::error!(
            "[RESTORE] external: durability barrier for {} failed: {e}",
            parent.display()
        );
        return fail_publication(&tmp, target, dismantled);
    }

    // 5. Single rename — the archive holds exactly one file per store, so
    //    there is no multi-file publication to be interrupted halfway.
    if let Err(e) = std::fs::rename(&tmp, target) {
        tracing::error!("[RESTORE] external: publish {} failed: {e}", target.display());
        return fail_publication(&tmp, target, dismantled);
    }
    // Past the point of no return: the new database is in place, so a failure
    // to flush the directory entry costs durability, not correctness. Reporting
    // failure here would be a lie about what is on disk.
    if let Err(e) = sync_dir(parent) {
        tracing::warn!(
            "[RESTORE] external: post-publish sync of {} failed: {e}",
            parent.display()
        );
    }
    FileOutcome::Written
}

/// Report a failed publication, keeping the staged replacement only when
/// something was already destroyed.
///
/// If nothing has been removed yet the live store is whole, and the temp is
/// just litter. But once a sidecar or the database itself is gone, the temp
/// holds the only complete copy of what the store should contain — deleting it
/// too would leave the user with no store at all, which is far worse than the
/// bounded truncation this ordering trades for. Its path is logged so the
/// bytes can be recovered by hand.
fn fail_publication(tmp: &Path, target: &Path, dismantled: bool) -> FileOutcome {
    if dismantled {
        tracing::error!(
            "[RESTORE] external: {} was left incomplete; its replacement is preserved at {}",
            target.display(),
            tmp.display()
        );
    } else {
        let _ = std::fs::remove_file(tmp);
    }
    FileOutcome::Failed
}

/// Flush a directory's entries so a rename/unlink ordering actually survives a
/// power loss.
///
/// Windows offers no directory handle to fsync; there `remove_file` and
/// `MoveFileEx` are ordered, journalled NTFS metadata transactions, so this is
/// a no-op.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Map an `external/<agent>/<rest>` archive path to `(agent, base, live_target)`,
/// re-applying the SAME constraints used at backup time so a crafted archive
/// can't smuggle a non-transcript path into a live config location:
/// - the agent must be a known source;
/// - a file source accepts only its exact filename;
/// - a dir source with an `include_top` allowlist accepts only those top dirs;
/// - traversal components are rejected.
fn map_external_to_target(
    archive_path: &str,
    sources: &[ExternalSource],
) -> Option<(String, PathBuf, PathBuf)> {
    let rest = archive_path.strip_prefix("external/")?;
    let (agent, sub) = rest.split_once('/')?;
    let src = sources.iter().find(|s| s.agent == agent)?;

    // Reject traversal / non-normal components up front.
    let segs: Vec<&str> = sub.split('/').collect();
    if segs.iter().any(|s| s.is_empty() || *s == "." || *s == "..") {
        return None;
    }

    // Backstop for the one-file-per-store invariant: whatever an archive
    // claims, a `-wal`/`-shm` never resolves to a live path. Together with the
    // legacy-pair refusal in `restore_external_with_sources`, no restore path
    // can put a sidecar next to a store.
    if src.sqlite && segs.last().is_some_and(|last| is_sqlite_sidecar(last)) {
        return None;
    }

    if src.is_file {
        // Only the source file's own name is allowed (e.g. `opencode.db`).
        let fname = src.root.file_name()?.to_str()?;
        if segs.as_slice() != [fname] {
            return None;
        }
        return Some((agent.to_string(), src.restore_base(), src.root.clone()));
    }

    if let Some(allow) = src.include_top {
        let first = segs.first()?;
        if !allow.iter().any(|a| a == first) {
            return None;
        }
    }

    let base = src.restore_base();
    let mut target = base.clone();
    for seg in &segs {
        target.push(seg);
    }
    Some((agent.to_string(), base, target))
}

/// True if no existing component between `base` (exclusive) and `dir`
/// (inclusive) is a symlink, and `dir` is actually under `base`. Used to refuse
/// writing through a symlinked parent that escapes the agent's tree.
fn parent_chain_is_safe(base: &Path, dir: &Path) -> bool {
    let Ok(rel) = dir.strip_prefix(base) else {
        return false;
    };
    let mut cur = base.to_path_buf();
    for comp in rel.components() {
        match comp {
            std::path::Component::Normal(s) => cur.push(s),
            // Any non-normal component (shouldn't occur post-mapping) is unsafe.
            _ => return false,
        }
        if let Ok(meta) = std::fs::symlink_metadata(&cur) {
            if meta.file_type().is_symlink() {
                return false;
            }
        }
    }
    true
}

fn to_slash(rel: &Path) -> String {
    rel.components()
        .filter_map(|c| match c {
            std::path::Component::Normal(s) => Some(s.to_string_lossy().into_owned()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir_source(agent: &'static str, root: PathBuf) -> ExternalSource {
        ExternalSource {
            agent,
            root,
            is_file: false,
            sqlite: false,
            include_top: None,
        }
    }

    /// `map_external_to_target` resolves an archive entry by
    /// `find(|s| s.agent == agent)`, so a duplicated name silently routes the
    /// SECOND source's entries into the FIRST source's root on restore. That is
    /// invisible in a backup and only shows up as misplaced files on someone
    /// else's machine, so pin the invariant here rather than trusting review.
    /// An agent that owns two independently-relocatable trees (DeepSeek: its
    /// session logs and its attachment store) needs two distinct names.
    #[test]
    fn external_source_agent_names_are_unique() {
        let sources = external_transcript_sources();
        let mut seen = std::collections::HashSet::new();
        for src in &sources {
            assert!(
                seen.insert(src.agent),
                "duplicate external source agent name: {}",
                src.agent
            );
        }
    }

    /// deepseek-acp 0.6.0 puts prompt images in a content-addressed store that
    /// is NOT under the session-log root, and the log keeps only a `sha256:`
    /// reference. If the store is not archived, restoring on a clean machine
    /// degrades every image to the parser's `[image …]` placeholder with the
    /// bytes gone for good — so both trees must be registered, must restore to
    /// their own roots, and the store's non-conversation siblings must stay out.
    #[test]
    fn deepseek_attachment_objects_restore_into_the_attachment_store() {
        let sources = external_transcript_sources();
        let logs = sources
            .iter()
            .find(|s| s.agent == "deepseek")
            .expect("deepseek session logs are not registered for backup");
        let store = sources
            .iter()
            .find(|s| s.agent == "deepseek-attachments")
            .expect("deepseek attachment store is not registered for backup");
        // Two roots, resolved independently — `DEEPSEEK_ACP_SESSIONS_ROOT` moves
        // the logs without moving the store.
        assert_ne!(logs.root, store.root);
        assert!(store.root.ends_with("attachments/v1"), "{:?}", store.root);

        // Scoped to `objects/`: `tmp/` is upload staging and `request-images/`
        // holds per-provider re-encodings the agent rebuilds on demand.
        let store_only = std::slice::from_ref(store);
        let hex = "a".repeat(64);
        let object = format!("external/deepseek-attachments/objects/aa/{hex}");
        let (_, base, target) =
            map_external_to_target(&object, store_only).expect("object entry must map");
        assert_eq!(base, store.root);
        assert_eq!(target, store.root.join("objects").join("aa").join(&hex));
        assert!(
            map_external_to_target("external/deepseek-attachments/tmp/staged", store_only).is_none()
        );
        assert!(map_external_to_target(
            "external/deepseek-attachments/request-images/aa/bb",
            store_only
        )
        .is_none());

        // And the bytes actually land there on restore — at exactly the path
        // `parsers::deepseek::attachment_image_block` reads back.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("attachments").join("v1");
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("deepseek-attachments/objects/aa")).unwrap();
        std::fs::create_dir_all(staged.join("deepseek-attachments/tmp")).unwrap();
        std::fs::write(
            staged.join("deepseek-attachments/objects/aa").join(&hex),
            b"\x89PNG\r\n\x1a\n",
        )
        .unwrap();
        std::fs::write(staged.join("deepseek-attachments/tmp/staged"), b"junk").unwrap();

        let restored = vec![ExternalSource {
            agent: "deepseek-attachments",
            root: root.clone(),
            is_file: false,
            sqlite: false,
            include_top: Some(&["objects"]),
        }];
        let report = restore_external_with_sources(
            &staged,
            &restored,
            ConflictPolicy::SkipExisting,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(report.skipped_conflicts.is_empty(), "{report:?}");
        assert_eq!(
            std::fs::read(root.join("objects").join("aa").join(&hex)).unwrap(),
            b"\x89PNG\r\n\x1a\n"
        );
        assert!(!root.join("tmp").join("staged").exists());
    }

    /// Restore-to-original-locations must never silently overwrite an existing
    /// file: `SkipExisting` reports it as skipped and leaves it untouched,
    /// while `Overwrite` replaces it. Non-conflicting files always restore.
    #[test]
    fn original_locations_respects_conflict_policy() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("claude/projects")).unwrap();
        std::fs::write(staged.join("claude/projects/exists.jsonl"), b"NEW").unwrap();
        std::fs::write(staged.join("claude/projects/fresh.jsonl"), b"FRESH").unwrap();

        // Live target base with a pre-existing conflicting file.
        let target_base = dir.path().join("live-claude");
        std::fs::create_dir_all(target_base.join("projects")).unwrap();
        std::fs::write(target_base.join("projects/exists.jsonl"), b"OLD").unwrap();
        let sources = vec![dir_source("claude", target_base.clone())];
        let cancel = CancellationToken::new();

        // SkipExisting: conflict reported + untouched; fresh file restored.
        let report = restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::SkipExisting,
            &cancel,
        )
        .unwrap();
        assert_eq!(report.skipped_conflicts.len(), 1);
        assert!(report.skipped_conflicts[0].ends_with("exists.jsonl"));
        assert_eq!(
            std::fs::read(target_base.join("projects/exists.jsonl")).unwrap(),
            b"OLD"
        );
        assert_eq!(
            std::fs::read(target_base.join("projects/fresh.jsonl")).unwrap(),
            b"FRESH"
        );

        // Overwrite: the conflict is replaced, nothing reported skipped.
        let report =
            restore_external_with_sources(&staged, &sources, ConflictPolicy::Overwrite, &cancel)
                .unwrap();
        assert!(report.skipped_conflicts.is_empty());
        assert_eq!(
            std::fs::read(target_base.join("projects/exists.jsonl")).unwrap(),
            b"NEW"
        );
        // Atomic publish must leave no `.part` temp file behind.
        let leftover_temp = std::fs::read_dir(target_base.join("projects"))
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".part"));
        assert!(!leftover_temp, "no temp file should remain after publish");
    }

    #[cfg(unix)]
    #[test]
    fn scan_reports_dangling_symlink_conflict() {
        use std::io::Write as _;
        let dir = tempfile::tempdir().unwrap();
        // Minimal archive with one external entry.
        let zip_path = dir.path().join("b.zip");
        {
            let f = File::create(&zip_path).unwrap();
            let mut w = zip::ZipWriter::new(f);
            w.start_file(
                "external/claude/projects/x.jsonl",
                zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
            w.write_all(b"hi").unwrap();
            w.finish().unwrap();
        }
        // Live target is a DANGLING symlink — restore would treat it as a
        // conflict, so the scan must surface it too.
        let base = dir.path().join("live");
        std::fs::create_dir_all(base.join("projects")).unwrap();
        std::os::unix::fs::symlink(
            dir.path().join("nonexistent-target"),
            base.join("projects/x.jsonl"),
        )
        .unwrap();

        let sources = vec![dir_source("claude", base)];
        let conflicts = scan_external_conflicts_with_sources(&zip_path, &sources).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert!(conflicts[0].archive_path.ends_with("x.jsonl"));
    }

    #[test]
    fn map_external_rejects_traversal_and_returns_base() {
        let sources = vec![dir_source("claude", PathBuf::from("/tmp/base"))];
        assert!(map_external_to_target("external/claude/../escape", &sources).is_none());
        assert!(map_external_to_target("external/unknown/x", &sources).is_none());
        assert_eq!(
            map_external_to_target("external/claude/projects/a.jsonl", &sources),
            Some((
                "claude".to_string(),
                PathBuf::from("/tmp/base"),
                PathBuf::from("/tmp/base/projects/a.jsonl"),
            ))
        );
    }

    #[test]
    fn map_external_enforces_allowlist_and_file_only() {
        // Dir source with an include_top allowlist: only listed top dirs map.
        let gemini = ExternalSource {
            agent: "gemini",
            root: PathBuf::from("/tmp/gemini"),
            is_file: false,
            sqlite: false,
            include_top: Some(&["tmp", "history"]),
        };
        // A crafted credential path is rejected.
        let gemini = std::slice::from_ref(&gemini);
        assert!(map_external_to_target("external/gemini/oauth_creds.json", gemini).is_none());
        assert!(map_external_to_target("external/gemini/tmp/chat.json", gemini).is_some());

        // File source: only its exact filename maps; anything else is rejected.
        let opencode = ExternalSource {
            agent: "opencode",
            root: PathBuf::from("/tmp/oc/opencode.db"),
            is_file: true,
            sqlite: true,
            include_top: None,
        };
        let opencode = std::slice::from_ref(&opencode);
        assert!(map_external_to_target("external/opencode/evil.sh", opencode).is_none());
        assert_eq!(
            map_external_to_target("external/opencode/opencode.db", opencode),
            Some((
                "opencode".to_string(),
                PathBuf::from("/tmp/oc"),
                PathBuf::from("/tmp/oc/opencode.db"),
            ))
        );
    }

    // ── third-party SQLite stores ────────────────────────────────────────

    fn sqlite_file_source(agent: &'static str, db: PathBuf) -> ExternalSource {
        ExternalSource {
            agent,
            root: db,
            is_file: true,
            sqlite: true,
            include_top: None,
        }
    }

    fn sqlite_dir_source(agent: &'static str, root: PathBuf) -> ExternalSource {
        ExternalSource {
            agent,
            root,
            is_file: false,
            sqlite: true,
            include_top: None,
        }
    }

    /// A WAL-mode store with two committed rows. The returned connection is
    /// deliberately kept alive so nothing checkpoints — the rows exist only in
    /// the `-wal`, which is the case a naive file copy loses.
    fn seed_store(path: &Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch("CREATE TABLE t(v TEXT); INSERT INTO t VALUES('a'),('b');")
            .unwrap();
        conn
    }

    /// Read-write open: a WAL-mode database always needs its `-shm`, and a
    /// self-contained snapshot has none until someone writable opens it.
    fn count_rows(db: &Path) -> rusqlite::Result<i64> {
        Connection::open(db)?.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
    }

    fn pack_one(source: &ExternalSource, dir: &Path) -> (Vec<String>, Vec<DegradedSqlite>) {
        let scratch = dir.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        let zip = dir.join(format!("a-{}.zip", uuid::Uuid::new_v4().simple()));
        let mut b = ArchiveBuilder::create(&zip).unwrap();
        let mut prog = crate::commands::backup::archive::null_progress();
        let pack = add_external_sources_with(
            &mut b,
            &scratch,
            std::slice::from_ref(source),
            &CancellationToken::new(),
            &mut prog,
        )
        .unwrap();
        let manifest = b
            .finish(crate::commands::backup::manifest::BackupManifest {
                format_version: 1,
                kind: "codeg-backup".to_string(),
                created_at: String::new(),
                app_version: String::new(),
                latest_migration: String::new(),
                runtime: "server".to_string(),
                includes_external_transcripts: pack.packed,
                includes_secrets: false,
                managed_sections: None,
                degraded_sqlite: pack.degraded.clone(),
                entries: Vec::new(),
            })
            .unwrap();
        (
            manifest.entries.into_iter().map(|e| e.path).collect(),
            pack.degraded,
        )
    }

    /// The invariant everything else leans on: one archive entry per database.
    /// Sidecars in the archive are what would let a restore reconstruct
    /// "new db + stale wal", so they must not be representable.
    #[test]
    fn sqlite_source_is_always_exactly_one_archive_entry() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("chats").join("abc");
        std::fs::create_dir_all(&root).unwrap();
        let conn = seed_store(&root.join("store.db"));
        std::fs::write(root.join("meta.json"), b"{}").unwrap();
        assert!(
            sidecar_of(&root.join("store.db"), "-wal").exists(),
            "the fixture needs a live WAL to be meaningful"
        );

        let (mut entries, _) = pack_one(
            &sqlite_dir_source("cursor", dir.path().join("chats")),
            dir.path(),
        );
        entries.sort();
        assert_eq!(
            entries,
            vec![
                "external/cursor/abc/meta.json".to_string(),
                "external/cursor/abc/store.db".to_string(),
            ]
        );
        drop(conn);
    }

    /// The frames that live only in the WAL have to survive, and the archived
    /// file has to stand on its own afterwards.
    #[test]
    fn sqlite_source_is_snapshotted_without_wal_dependency() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("opencode.db");
        let conn = seed_store(&db);

        // A plain file copy of the main database sees nothing: the schema and
        // the rows are still in the WAL.
        let raw = dir.path().join("raw.db");
        std::fs::copy(&db, &raw).unwrap();
        assert!(count_rows(&raw).is_err());

        let snap = dir.path().join("snap.db");
        page_copy_readonly(&db, &snap).expect("read-only page copy");
        assert_eq!(count_rows(&snap).unwrap(), 2);
        drop(conn);
    }

    /// `VACUUM` may renumber the ROWID of any table without an explicit
    /// INTEGER PRIMARY KEY. A page copy must not — we cannot audit a
    /// third-party schema for tables that use rowid as a key, and the damage
    /// would be silent and permanent (the archive would hold the broken copy).
    #[test]
    fn page_copy_preserves_implicit_rowids() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("store.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE t(v TEXT);
             INSERT INTO t VALUES('a'),('b'),('c'),('d'),('e');
             DELETE FROM t WHERE v IN ('b','d');",
        )
        .unwrap();
        let source_rowids: Vec<i64> = conn
            .prepare("SELECT rowid FROM t ORDER BY rowid")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(source_rowids, vec![1, 3, 5], "fixture must have holes");
        drop(conn);

        let snap = dir.path().join("snap.db");
        page_copy_readonly(&db, &snap).unwrap();
        let snap_conn = Connection::open(&snap).unwrap();
        let snap_rowids: Vec<i64> = snap_conn
            .prepare("SELECT rowid FROM t ORDER BY rowid")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(snap_rowids, source_rowids);
    }

    /// Backing up must not write into a store codeg does not own — not the
    /// database, and not a `-wal`/`-shm` created as a side effect of opening
    /// it for writing.
    #[cfg(unix)]
    #[test]
    fn backup_never_opens_a_third_party_store_read_write() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE t(v TEXT); INSERT INTO t VALUES('a'),('b');")
                .unwrap();
        } // cleanly closed: no sidecars
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o444)).unwrap();
        let before = std::fs::metadata(&db).unwrap();

        let (entries, degraded) = pack_one(&sqlite_file_source("hermes", db.clone()), dir.path());
        assert_eq!(entries, vec!["external/hermes/state.db".to_string()]);
        assert!(degraded.is_empty(), "{degraded:?}");

        let after = std::fs::metadata(&db).unwrap();
        assert_eq!(before.len(), after.len());
        assert_eq!(before.modified().unwrap(), after.modified().unwrap());
        assert!(!sidecar_of(&db, "-wal").exists());
        assert!(!sidecar_of(&db, "-shm").exists());
    }

    /// A store the CLI crashed on: a live `-wal` with no `-shm`, in a
    /// directory SQLite may not write to, so the read-only open cannot
    /// succeed. The frames must still be recovered — on OUR copy — and the
    /// degradation must be reported rather than logged and forgotten.
    #[cfg(unix)]
    #[test]
    fn readonly_open_failure_recovers_on_a_private_copy_and_is_reported() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        std::fs::create_dir_all(&live).unwrap();

        // Build the store elsewhere, then move db + wal over WITHOUT the shm.
        let build = dir.path().join("build");
        std::fs::create_dir_all(&build).unwrap();
        let src_db = build.join("opencode.db");
        let conn = seed_store(&src_db);
        let db = live.join("opencode.db");
        std::fs::copy(&src_db, &db).unwrap();
        std::fs::copy(sidecar_of(&src_db, "-wal"), sidecar_of(&db, "-wal")).unwrap();
        drop(conn);

        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o555)).unwrap();
        let (entries, degraded) = pack_one(&sqlite_file_source("opencode", db.clone()), dir.path());
        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            entries,
            vec!["external/opencode/opencode.db".to_string()],
            "still exactly one entry, even degraded"
        );
        assert_eq!(degraded.len(), 1, "{degraded:?}");
        assert_eq!(degraded[0].agent, "opencode");
        assert_eq!(degraded[0].level, SqliteDegradation::RecoveredOnCopy);
    }

    /// The coherence proof behind the degraded path: a main file and a WAL read
    /// at two instants are only usable together if the source did not move
    /// between them.
    #[test]
    fn fingerprint_notices_the_store_moving() {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("store.db");
        let conn = seed_store(&db);
        let before = fingerprint(&db).unwrap();
        assert_eq!(fingerprint(&db).as_ref(), Some(&before));

        conn.execute_batch("INSERT INTO t VALUES('c');").unwrap();
        assert_ne!(
            fingerprint(&db).as_ref(),
            Some(&before),
            "a commit grows the WAL, which must break the fingerprint"
        );
        drop(conn);
        assert_ne!(
            fingerprint(&db).as_ref(),
            Some(&before),
            "a checkpoint rewrites the main file, which must break it too"
        );
    }

    /// When the store cannot be copied at all, archive nothing for it and say
    /// so — rather than a torn copy `integrity_check` would call healthy.
    #[cfg(unix)]
    #[test]
    fn unreadable_store_is_reported_as_not_archived() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("state.db");
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE TABLE t(v TEXT);").unwrap();
        }
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o000)).unwrap();

        let (entries, degraded) = pack_one(&sqlite_file_source("hermes", db.clone()), dir.path());
        std::fs::set_permissions(&db, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert!(entries.is_empty(), "{entries:?}");
        assert_eq!(degraded.len(), 1);
        assert_eq!(degraded[0].level, SqliteDegradation::NotArchived);
    }

    /// Publishing a store must clear the sidecars that belong to the database
    /// it replaces; otherwise the next open replays a foreign WAL into it.
    #[test]
    fn restore_drops_stale_sidecars_next_to_replaced_db() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("opencode")).unwrap();
        std::fs::write(staged.join("opencode/opencode.db"), b"NEW-DB").unwrap();

        let live_dir = dir.path().join("live");
        std::fs::create_dir_all(&live_dir).unwrap();
        let live_db = live_dir.join("opencode.db");
        std::fs::write(&live_db, b"OLD-DB").unwrap();
        std::fs::write(sidecar_of(&live_db, "-wal"), b"OLD-WAL").unwrap();
        std::fs::write(sidecar_of(&live_db, "-shm"), b"OLD-SHM").unwrap();

        let sources = vec![sqlite_file_source("opencode", live_db.clone())];
        let report = restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::Overwrite,
            &CancellationToken::new(),
        )
        .unwrap();
        assert!(report.skipped_conflicts.is_empty() && report.refused.is_empty());
        assert_eq!(std::fs::read(&live_db).unwrap(), b"NEW-DB");
        assert!(!sidecar_of(&live_db, "-wal").exists());
        assert!(!sidecar_of(&live_db, "-shm").exists());
    }

    /// We did not replace that store, so its sidecars are not ours to remove.
    #[test]
    fn skip_existing_touches_neither_db_nor_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("opencode")).unwrap();
        std::fs::write(staged.join("opencode/opencode.db"), b"NEW-DB").unwrap();

        let live_dir = dir.path().join("live");
        std::fs::create_dir_all(&live_dir).unwrap();
        let live_db = live_dir.join("opencode.db");
        std::fs::write(&live_db, b"OLD-DB").unwrap();
        std::fs::write(sidecar_of(&live_db, "-wal"), b"OLD-WAL").unwrap();

        let sources = vec![sqlite_file_source("opencode", live_db.clone())];
        let report = restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::SkipExisting,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(report.skipped_conflicts.len(), 1);
        assert_eq!(std::fs::read(&live_db).unwrap(), b"OLD-DB");
        assert_eq!(
            std::fs::read(sidecar_of(&live_db, "-wal")).unwrap(),
            b"OLD-WAL"
        );
    }

    /// An IO failure part-way through the sidecar sweep must leave the live
    /// database byte-identical — never half-published. (A directory named
    /// `…-wal` makes `remove_file` fail deterministically.)
    #[test]
    fn sidecar_removal_failure_leaves_the_db_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("opencode")).unwrap();
        std::fs::write(staged.join("opencode/opencode.db"), b"NEW-DB").unwrap();

        let live_dir = dir.path().join("live");
        std::fs::create_dir_all(&live_dir).unwrap();
        let live_db = live_dir.join("opencode.db");
        std::fs::write(&live_db, b"OLD-DB").unwrap();
        std::fs::create_dir_all(sidecar_of(&live_db, "-wal")).unwrap();

        let sources = vec![sqlite_file_source("opencode", live_db.clone())];
        restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::Overwrite,
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(std::fs::read(&live_db).unwrap(), b"OLD-DB");
        // Nothing had been removed yet, so the live store is whole and the
        // temp is pure litter.
        let leftover = std::fs::read_dir(&live_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().ends_with(".part"));
        assert!(!leftover, "the staged temp must be cleaned up on failure");
    }

    /// Once a sidecar is gone the live store is incomplete, and the staged
    /// replacement is the only whole copy. Deleting it too would leave the
    /// user with no store at all.
    #[test]
    fn replacement_is_preserved_when_publication_fails_after_destroying_something() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("opencode")).unwrap();
        std::fs::write(staged.join("opencode/opencode.db"), b"NEW-DB").unwrap();

        let live_dir = dir.path().join("live");
        std::fs::create_dir_all(&live_dir).unwrap();
        let live_db = live_dir.join("opencode.db");
        // A directory in the database's place: the `-wal` beside it removes
        // cleanly, then removing the "database" fails deterministically.
        std::fs::create_dir_all(&live_db).unwrap();
        std::fs::write(sidecar_of(&live_db, "-wal"), b"OLD-WAL").unwrap();

        let sources = vec![sqlite_file_source("opencode", live_db.clone())];
        restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::Overwrite,
            &CancellationToken::new(),
        )
        .unwrap();

        assert!(!sidecar_of(&live_db, "-wal").exists(), "the wal was removed");
        let preserved: Vec<PathBuf> = std::fs::read_dir(&live_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.to_string_lossy().ends_with(".part"))
            .collect();
        assert_eq!(preserved.len(), 1, "{preserved:?}");
        assert_eq!(std::fs::read(&preserved[0]).unwrap(), b"NEW-DB");
    }

    /// A WAL that exists but cannot be read means committed frames are
    /// missing. Recovering the main file alone would still succeed, so the
    /// result must be labelled `BareFileOnly` rather than complete.
    #[cfg(unix)]
    #[test]
    fn unreadable_wal_downgrades_below_recovered_on_copy() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let live = dir.path().join("live");
        std::fs::create_dir_all(&live).unwrap();

        let build = dir.path().join("build");
        std::fs::create_dir_all(&build).unwrap();
        let src_db = build.join("opencode.db");
        let conn = seed_store(&src_db);
        let db = live.join("opencode.db");
        std::fs::copy(&src_db, &db).unwrap();
        let wal = sidecar_of(&db, "-wal");
        std::fs::copy(sidecar_of(&src_db, "-wal"), &wal).unwrap();
        drop(conn);

        // Present but unreadable, and the directory is read-only so the
        // read-only open cannot create a `-shm` either.
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o000)).unwrap();
        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o555)).unwrap();
        let (entries, degraded) = pack_one(&sqlite_file_source("opencode", db.clone()), dir.path());
        std::fs::set_permissions(&live, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(entries, vec!["external/opencode/opencode.db".to_string()]);
        assert_eq!(degraded.len(), 1, "{degraded:?}");
        assert_eq!(
            degraded[0].level,
            SqliteDegradation::BareFileOnly,
            "an unreadable WAL must not be reported as a complete snapshot"
        );
    }

    /// A pre-fix archive packed `<x>.db` and `<x>.db-wal` as separate entries.
    /// Nothing in the archive can prove they belong to the same WAL
    /// generation, and SQLite would apply a mismatched pair without
    /// complaining, so refuse the entry outright and leave the live store as
    /// it is.
    #[test]
    fn legacy_pair_is_refused_and_live_store_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        let chats = staged.join("cursor").join("abc");
        std::fs::create_dir_all(&chats).unwrap();
        std::fs::write(chats.join("store.db"), b"ARCHIVE-DB").unwrap();
        std::fs::write(chats.join("store.db-wal"), b"ARCHIVE-WAL").unwrap();

        let live_root = dir.path().join("live");
        let live_db = live_root.join("abc").join("store.db");
        std::fs::create_dir_all(live_db.parent().unwrap()).unwrap();
        std::fs::write(&live_db, b"MINE").unwrap();

        let sources = vec![sqlite_dir_source("cursor", live_root.clone())];
        let report = restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::Overwrite,
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(std::fs::read(&live_db).unwrap(), b"MINE");
        assert!(!sidecar_of(&live_db, "-wal").exists());
        assert_eq!(report.refused.len(), 1, "{report:?}");
        assert_eq!(
            report.refused[0].reason,
            RefusalReason::LegacyUnprovableSqlitePair
        );
        assert!(report.refused[0].archive_path.ends_with("store.db"));
    }

    /// The refusal is per entry, not per source: a store in the same legacy
    /// archive that has no `-wal` beside it is provably self-contained and
    /// restores normally.
    #[test]
    fn legacy_single_file_store_still_restores() {
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("cursor").join("torn")).unwrap();
        std::fs::create_dir_all(staged.join("cursor").join("clean")).unwrap();
        std::fs::write(staged.join("cursor/torn/store.db"), b"A").unwrap();
        std::fs::write(staged.join("cursor/torn/store.db-wal"), b"W").unwrap();
        std::fs::write(staged.join("cursor/clean/store.db"), b"CLEAN").unwrap();

        let live_root = dir.path().join("live");
        std::fs::create_dir_all(&live_root).unwrap();
        let sources = vec![sqlite_dir_source("cursor", live_root.clone())];
        let report = restore_external_with_sources(
            &staged,
            &sources,
            ConflictPolicy::Overwrite,
            &CancellationToken::new(),
        )
        .unwrap();

        assert_eq!(report.refused.len(), 1);
        assert_eq!(
            std::fs::read(live_root.join("clean").join("store.db")).unwrap(),
            b"CLEAN"
        );
        assert!(!live_root.join("torn").join("store.db").exists());
        // And no path ever writes a sidecar next to a store.
        assert!(!live_root.join("clean").join("store.db-wal").exists());
    }

    /// Backstop for the same invariant one layer down: whatever an archive
    /// claims, a sidecar entry never resolves to a live path.
    #[test]
    fn sidecar_entries_are_refused_by_the_mapper() {
        let sources = vec![
            sqlite_dir_source("cursor", PathBuf::from("/tmp/cursor")),
            sqlite_file_source("opencode", PathBuf::from("/tmp/oc/opencode.db")),
        ];
        for path in [
            "external/cursor/abc/store.db-wal",
            "external/cursor/abc/store.db-shm",
            "external/opencode/opencode.db-wal",
            "external/opencode/opencode.db-shm",
        ] {
            assert!(
                map_external_to_target(path, &sources).is_none(),
                "sidecar must not map: {path}"
            );
        }
        assert!(map_external_to_target("external/cursor/abc/store.db", &sources).is_some());
    }

    #[cfg(unix)]
    #[test]
    fn restore_refuses_symlinked_parent_escape() {
        // A symlinked parent (projects -> /escape) must NOT be followed.
        let dir = tempfile::tempdir().unwrap();
        let staged = dir.path().join("external");
        std::fs::create_dir_all(staged.join("claude/projects")).unwrap();
        std::fs::write(staged.join("claude/projects/x.jsonl"), b"DATA").unwrap();

        let base = dir.path().join("live-claude");
        std::fs::create_dir_all(&base).unwrap();
        let escape = dir.path().join("escape");
        std::fs::create_dir_all(&escape).unwrap();
        // base/projects is a symlink to an out-of-tree dir.
        std::os::unix::fs::symlink(&escape, base.join("projects")).unwrap();

        let sources = vec![dir_source("claude", base)];
        let cancel = CancellationToken::new();
        let report =
            restore_external_with_sources(&staged, &sources, ConflictPolicy::Overwrite, &cancel)
                .unwrap();
        // Nothing was written through the symlink into the escape dir.
        assert!(!escape.join("x.jsonl").exists());
        assert!(report.skipped_conflicts.is_empty());
    }
}
