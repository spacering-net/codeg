//! Restore: stage-then-swap-on-startup.
//!
//! The DB connection pool holds `codeg.db` open (WAL sidecars), so swapping it
//! under a live connection risks corruption (and fails outright on Windows).
//! Restore therefore runs in two phases:
//!
//! 1. **Stage** (while running) — decrypt + extract + checksum-verify the
//!    archive into `<data_dir>/.codeg-restore-staging/<op_id>/`, then write a
//!    pending-restore marker. Live data is untouched until this fully succeeds.
//! 2. **Swap** (next startup) — [`apply_pending_restore_on_startup`] runs as the
//!    first step of `db::init_database`, before any connection is opened: it
//!    takes a safety snapshot of the current data, moves the staged files into
//!    place, then lets the normal `Migrator::up` bring a possibly-older
//!    restored DB up to the current schema.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::app_error::{AppCommandError, BACKUP_I18N_KEY_ALREADY_PENDING};

use super::archive;
use super::core;
use super::manifest::{BackupManifest, BackupPhase, BackupProgress, BACKUP_PROGRESS_EVENT};
use super::sections::{self, LiveRoots, SectionKind, SectionPolicy};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Marker committing a staged restore; consumed on next startup.
pub const PENDING_MARKER: &str = ".codeg-restore-pending.json";
/// Root for staged (extracted, verified, not-yet-applied) restore payloads.
pub const STAGING_DIR: &str = ".codeg-restore-staging";
/// Root for pre-restore safety snapshots of the previous live data.
pub const SAFETY_DIR: &str = ".codeg-restore-backup";
/// Side location external transcripts are restored to (never clobbers the
/// live CLI dirs without explicit conflict resolution — see M7).
pub const RESTORED_TRANSCRIPTS_DIR: &str = "restored-transcripts";
/// Transient dir (server mode) holding export archives awaiting download.
pub const EXPORT_TMP_DIR: &str = ".codeg-backup-tmp";
/// Transient dir (server mode) holding uploaded archives awaiting inspect/stage.
pub const UPLOAD_TMP_DIR: &str = ".codeg-restore-upload";
/// Staging/archive subdirectory holding the database snapshot.
pub const DB_STAGING_DIR: &str = "db";
/// Fixed in-archive name of the database snapshot. The LIVE name varies
/// (`codeg-dev.db` on debug desktop builds), so the two are mapped explicitly
/// at swap time rather than assumed equal.
pub const DB_STAGING_NAME: &str = "codeg.db";
/// Per-unit swap progress, written inside the staging dir so a crashed swap
/// can be resumed exactly once per unit.
const SWAP_STATE_DIR: &str = ".codeg-swap-state";
/// Records what the live data looked like when a safety snapshot was taken —
/// including what was *absent*, which is the only way a rollback can undo a
/// restore that introduced a file.
const SNAPSHOT_MANIFEST: &str = ".codeg-snapshot.json";
/// How many safety snapshots to keep. Each one holds a full copy of the
/// previous database and upload tree, and nothing used to reclaim them.
const SAFETY_SNAPSHOT_KEEP: usize = 2;

/// How conflicting files are handled when restoring external transcripts back
/// to their original CLI locations. Never silent: the UI forces an explicit
/// choice before `Overwrite` can be selected.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictPolicy {
    Overwrite,
    SkipExisting,
}

/// Where (if anywhere) external agent transcripts are restored.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ExternalRestoreMode {
    /// Don't restore external transcripts at all.
    #[default]
    Skip,
    /// Extract to a safe side folder under the data dir — zero risk, and what
    /// the UI preselects once an archive turns out to carry transcripts. NOT
    /// the serde default: an omitted `externalMode` still means `Skip`, and
    /// changing that would silently alter what existing API callers asked for.
    SideLocation,
    /// Write back to the original `~/.claude` etc., honoring `on_conflict`.
    OriginalLocations { on_conflict: ConflictPolicy },
}

/// Result of staging a restore (returned to the UI before the restart).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedRestore {
    pub staging_dir: String,
    pub manifest: BackupManifest,
    /// Set when external transcripts were extracted to a side location.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_external_path: Option<String>,
    /// External files skipped because they already existed and the user did
    /// not authorize overwriting them.
    pub skipped_conflicts: Vec<String>,
    /// External entries we declined to publish for a structural reason (today:
    /// a pre-fix archive's unprovable `.db` + `-wal` pair). The live files were
    /// not touched.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub refused_external: Vec<super::external::RefusedExternal>,
    /// Set when the requested external mode could not be honored and a safer
    /// one was used instead. Never an error: the core restore is already
    /// committed by this point, so failing the call would tell the UI "don't
    /// restart" while the marker applies on the next launch anyway.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_downgraded: Option<ExternalDowngrade>,
}

/// Why the requested external-restore mode was not used, and where the
/// transcripts went instead.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDowngrade {
    pub reason: DowngradeReason,
    /// Agents that were running and therefore could not be written back to.
    pub agents: Vec<String>,
    /// Where the transcripts were put instead.
    pub path: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DowngradeReason {
    /// Agents were live. Overwriting a file an agent holds open unlinks the
    /// inode it keeps writing to, so those turns vanish when it closes the
    /// handle — and they are not in the restored file either.
    AgentsRunning,
}

/// Outcome of the startup swap.
#[derive(Debug)]
pub enum RestoreApplied {
    None,
    Applied { safety_snapshot: Option<PathBuf> },
}

#[derive(Debug, Serialize, Deserialize)]
struct PendingRestore {
    staging_dir: String,
    created_at: String,
    app_version: String,
    latest_migration: String,
    /// Which codeg-owned sections this restore is allowed to replace.
    ///
    /// It has to live HERE rather than be re-derived at apply time: the swap
    /// runs in the *next* process and the manifest never reaches staging
    /// (`archive::extract_all` deliberately skips `manifest.json`). Inferring
    /// section ownership from "does `staging/<id>` exist" instead would make
    /// restoring a pre-`managedSections` backup wipe the live
    /// `acp-transcripts/` — the exact data loss this whole change exists to
    /// fix. Absent on markers written before this field existed → the legacy
    /// three.
    #[serde(default)]
    managed_sections: Option<Vec<String>>,
    /// Units the swap must REMOVE rather than replace, because the source
    /// directory represents a state in which they did not exist. Only a
    /// rollback sets this: without it, undoing a restore that brought in
    /// someone else's `tokens.json` would leave those credentials live.
    #[serde(default)]
    absent_sections: Vec<String>,
}

impl PendingRestore {
    /// Sections this marker authorizes, normalized against the table this
    /// binary knows.
    fn sections(&self) -> Vec<String> {
        match self.managed_sections.as_deref() {
            Some(list) => sections::normalize_section_ids(list),
            None => legacy_section_ids(),
        }
    }
}

fn legacy_section_ids() -> Vec<String> {
    sections::LEGACY_SECTION_IDS
        .iter()
        .map(|s| (*s).to_string())
        .collect()
}

/// Decrypt + extract + verify a backup into a staging dir and write the pending
/// marker. Does NOT touch live data — the swap happens at next startup.
///
/// External transcripts are deliberately NOT handled here. They are dispatched
/// by the command layer via [`dispatch_external_after_stage`], which is the
/// only place with a handle on the live ACP connections it has to lock out.
pub(crate) async fn stage_restore_core(
    zip_path: &Path,
    data_dir: &Path,
    emitter: &EventEmitter,
    op_id: &str,
    cancel: &CancellationToken,
) -> Result<StagedRestore, AppCommandError> {
    // 0. Only one restore may be staged at a time. Fail fast if one is already
    //    pending (the real guard is the atomic no-clobber marker write in step
    //    4; this just avoids wasting extraction work in the common case).
    if data_dir.join(PENDING_MARKER).exists() {
        return Err(already_pending_error());
    }

    // 1. The archive arrives already decrypted — `source::prepare_source_core`
    //    did that once for the whole restore flow.
    let zip_path = zip_path.to_path_buf();

    // 2. Read + validate the manifest (version gate).
    let zip_for_manifest = zip_path.clone();
    let manifest = tokio::task::spawn_blocking(move || archive::read_manifest(&zip_for_manifest))
        .await
        .map_err(spawn_err)??;
    let (compatible, reject) = core::evaluate_compat(&manifest);
    if !compatible {
        return Err(reject_to_error(&manifest, reject.as_deref()));
    }
    // Reject crafted manifests (traversal/dup paths, missing DB) before we
    // trust the manifest to bound extraction.
    archive::validate_manifest(&manifest)?;

    // 3. Extract into a fresh staging dir + verify every checksum. Extraction
    //    is manifest-bounded, so the staged set equals the checksum-covered set.
    let staging_root = data_dir.join(STAGING_DIR).join(op_id);
    let _ = tokio::fs::remove_dir_all(&staging_root).await;
    tokio::fs::create_dir_all(&staging_root)
        .await
        .map_err(AppCommandError::io)?;

    emit(emitter, op_id, BackupPhase::Extracting);
    let zip_c = zip_path.clone();
    let staging_c = staging_root.clone();
    let manifest_c = manifest.clone();
    let cancel_c = cancel.clone();
    let emitter_c = emitter.clone();
    let op_id_c = op_id.to_string();
    // The manifest already knows the plaintext total, so extraction reports a
    // real fraction rather than sitting indeterminate.
    let total = manifest.total_bytes();
    tokio::task::spawn_blocking(move || -> Result<(), AppCommandError> {
        let mut prog = |path: &str, processed: u64| {
            emit_progress(
                &emitter_c,
                &op_id_c,
                BackupPhase::Extracting,
                processed,
                total,
                Some(path.to_string()),
            );
        };
        archive::extract_all(&zip_c, &staging_c, &manifest_c, &cancel_c, &mut prog)?;
        archive::verify_checksums(&staging_c, &manifest_c, &cancel_c)
    })
    .await
    .map_err(spawn_err)??;
    emit(emitter, op_id, BackupPhase::Verifying);

    // Force-create the staged directory of every `AlwaysReplace` section this
    // archive DECLARES, so "the backup had nothing here" is representable and
    // the swap replaces the live tree wholesale instead of merging into it.
    // Only declared sections: a legacy archive declares just `uploads`, so its
    // restore leaves this machine's `acp-transcripts/` alone.
    let declared_sections = manifest_section_ids(&manifest);
    for id in &declared_sections {
        let Some(section) = sections::find_section(id) else {
            continue;
        };
        if section.policy == SectionPolicy::AlwaysReplace && section.kind == SectionKind::Dir {
            tokio::fs::create_dir_all(staging_root.join(id))
                .await
                .map_err(AppCommandError::io)?;
        }
    }

    // 4. Commit core restore by writing the pending marker FIRST. The marker is
    //    the point of no return for the DB/uploads swap (applied next startup).
    write_pending_marker(data_dir, &staging_root, &manifest)?;

    emit(emitter, op_id, BackupPhase::Done);

    Ok(StagedRestore {
        staging_dir: staging_root.to_string_lossy().into_owned(),
        manifest,
        restored_external_path: None,
        skipped_conflicts: Vec::new(),
        refused_external: Vec::new(),
        external_downgraded: None,
    })
}

/// Dispatch the staged external transcripts per `mode`, filling the result
/// fields of `staged` in place.
///
/// Two rules hold this together. It runs AFTER the marker is committed, so it
/// must never turn the call into an error — that would tell the UI "failed,
/// don't restart" while the swap applies on the next launch regardless. And
/// `OriginalLocations` takes the connection lock BEFORE looking at what is
/// running, because a check followed by minutes of writing is not a gate.
///
/// When agents are live it downgrades to `SideLocation` rather than refusing:
/// nothing is lost, the user is told where the files went, and the call still
/// reports success + `needs_restart`.
pub(crate) async fn dispatch_external_after_stage(
    staged: &mut StagedRestore,
    data_dir: &Path,
    connections: &crate::acp::manager::ConnectionManager,
    mode: ExternalRestoreMode,
    cancel: &CancellationToken,
) {
    let staging_root = PathBuf::from(&staged.staging_dir);
    let staged_external = staging_root.join("external");
    if !staged.manifest.includes_external_transcripts || !staged_external.is_dir() {
        return;
    }

    let mut effective = mode;
    // The guard must outlive the writes, so it is bound here rather than in
    // the match arm.
    //
    let mut _lockout = None;
    if matches!(mode, ExternalRestoreMode::OriginalLocations { .. }) {
        let guard = connections.lock_out_new_connections().await;
        let live = live_agent_names(connections).await;
        if live.is_empty() {
            _lockout = Some(guard);
        } else {
            // Releasing the guard is fine: SideLocation writes only under our
            // own data dir and never touches an agent's files.
            drop(guard);
            let mut agents = live;
            agents.sort();
            agents.dedup();
            staged.external_downgraded = Some(ExternalDowngrade {
                reason: DowngradeReason::AgentsRunning,
                agents,
                path: String::new(), // filled in once the side dir is known
            });
            effective = ExternalRestoreMode::SideLocation;
        }
    }

    match handle_external(&staging_root, data_dir, &staged.manifest, effective, cancel).await {
        Ok((path, report)) => {
            if let (Some(d), Some(p)) = (staged.external_downgraded.as_mut(), path.as_ref()) {
                d.path = p.clone();
            }
            staged.restored_external_path = path;
            staged.skipped_conflicts = report.skipped_conflicts;
            staged.refused_external = report.refused;
        }
        Err(e) => {
            tracing::error!(
                "[RESTORE] external transcript handling failed (core restore still staged): {e}"
            );
            // Nothing landed anywhere, so reporting a downgrade "to <path>"
            // would point at a location that does not exist. The core restore
            // is still committed; only the transcripts were lost, and the log
            // says why.
            staged.external_downgraded = None;
        }
    }
}

/// Agents whose process could still be holding a transcript open. A torn-down
/// or errored connection has no writer behind it, so counting it would
/// downgrade a restore that was perfectly safe.
async fn live_agent_names(
    connections: &crate::acp::manager::ConnectionManager,
) -> Vec<String> {
    // One call, not "list the map then ask about draining": `disconnect`
    // removes the map entry and registers the draining child under a single
    // lock, and only this query observes both under that same lock. Reading
    // them separately could catch the handoff mid-flight and conclude nothing
    // is running.
    connections.live_or_draining_agent_names().await
}

/// Agents that are currently connected, for the advisory prompt shown while
/// the user is still choosing a mode. Read-only and purely a courtesy — the
/// correctness guarantee is [`dispatch_external_after_stage`]'s lock, not this.
pub(crate) async fn active_agent_names(
    connections: &crate::acp::manager::ConnectionManager,
) -> Vec<String> {
    live_agent_names(connections).await
}

/// Remove transient backup/restore scratch dirs left behind by an interrupted
/// process (export archives whose reaper never fired, uploads whose stage never
/// completed, and orphaned staging with no pending marker). Best-effort; called
/// at startup after [`apply_pending_restore_on_startup`]. No-op on desktop,
/// which uses neither transient dir.
pub fn cleanup_transient_dirs(data_dir: &Path) {
    let _ = std::fs::remove_dir_all(data_dir.join(EXPORT_TMP_DIR));
    let _ = std::fs::remove_dir_all(data_dir.join(UPLOAD_TMP_DIR));
    // Nothing is prepared across a process boundary, so any decrypted archive
    // still sitting here is residue from a killed process.
    super::source::cleanup_prepared_sources(data_dir);
    // A staging dir is only valid while its pending marker exists; once the
    // marker is gone (applied or never committed), staging is orphaned.
    if !data_dir.join(PENDING_MARKER).exists() {
        let _ = std::fs::remove_dir_all(data_dir.join(STAGING_DIR));
    }
    prune_safety_snapshots(data_dir, SAFETY_SNAPSHOT_KEEP);
}

/// Keep the `keep` newest safety snapshots and delete the rest. Each snapshot
/// holds a full copy of the previous database and upload tree, and until now
/// nothing ever reclaimed them.
pub fn prune_safety_snapshots(data_dir: &Path, keep: usize) {
    // A staged-but-unapplied restore still needs the previous snapshot around,
    // and a failed apply must not have its evidence swept. (A failed apply
    // returns Err from `init_database` before this is reached anyway; this
    // covers the staged-then-not-yet-restarted case.)
    if data_dir.join(PENDING_MARKER).exists() {
        return;
    }
    let root = data_dir.join(SAFETY_DIR);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return;
    };
    let mut dated: Vec<(i64, PathBuf)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        // Sort by the parsed timestamp, never by the raw name: the two naming
        // schemes do not sort against each other lexicographically. An entry
        // we cannot date at all is left alone rather than guessed at.
        if let Some(key) = snapshot_sort_key(&path) {
            dated.push((key, path));
        }
    }
    dated.sort_by_key(|a| std::cmp::Reverse(a.0));
    for (_, path) in dated.into_iter().skip(keep) {
        tracing::info!("[RESTORE] pruning safety snapshot {}", path.display());
        let _ = std::fs::remove_dir_all(&path);
    }
}

fn snapshot_sort_key(path: &Path) -> Option<i64> {
    let name = path.file_name()?.to_str()?;
    // Both the legacy `%Y%m%d-%H%M%S-<uuid>` and the current
    // `%Y%m%d-%H%M%S-<op-id>` names open with the same 15-character stamp.
    if let Some(stamp) = name.get(..15) {
        if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(stamp, "%Y%m%d-%H%M%S") {
            return Some(dt.and_utc().timestamp());
        }
    }
    std::fs::metadata(path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

/// A pre-restore safety snapshot, as offered to the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafetySnapshot {
    /// Directory name under `.codeg-restore-backup/`.
    pub id: String,
    pub path: String,
    /// RFC3339 timestamp of the restore this snapshot was taken for. `None`
    /// for snapshots written before the manifest existed.
    pub created_at: Option<String>,
    pub size_bytes: u64,
    /// Only a snapshot carrying the manifest can be rolled back: without its
    /// `absent` list, a rollback cannot tell "leave this alone" from "this did
    /// not exist, remove it".
    pub rollback_supported: bool,
}

pub fn list_safety_snapshots_core(data_dir: &Path) -> Vec<SafetySnapshot> {
    let root = data_dir.join(SAFETY_DIR);
    let Ok(rd) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut out: Vec<(i64, SafetySnapshot)> = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = read_snapshot_manifest(&path);
        out.push((
            snapshot_sort_key(&path).unwrap_or(0),
            SafetySnapshot {
                id: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                created_at: manifest.as_ref().map(|m| m.created_at.clone()),
                size_bytes: dir_size(&path),
                rollback_supported: manifest.is_some(),
            },
        ));
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.0));
    out.into_iter().map(|(_, s)| s).collect()
}

fn read_snapshot_manifest(dir: &Path) -> Option<SnapshotManifest> {
    let raw = std::fs::read_to_string(dir.join(SNAPSHOT_MANIFEST)).ok()?;
    let m: SnapshotManifest = serde_json::from_str(&raw).ok()?;
    (m.v == 1 && m.layout == "staging").then_some(m)
}

fn dir_size(dir: &Path) -> u64 {
    walkdir::WalkDir::new(dir)
        .follow_links(false)
        .into_iter()
        .flatten()
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| e.metadata().ok())
        .map(|m| m.len())
        .sum()
}

/// Stage a rollback to a safety snapshot. Reuses the whole restore machinery:
/// the snapshot is already laid out like a staging dir, so all this does is
/// commit a pending marker pointing at it (applied on the next startup, with a
/// fresh snapshot of the current data taken on the way).
pub fn rollback_to_snapshot_core(
    data_dir: &Path,
    snapshot_id: &str,
) -> Result<String, AppCommandError> {
    if snapshot_id.is_empty()
        || snapshot_id.contains('/')
        || snapshot_id.contains('\\')
        || snapshot_id.contains("..")
    {
        return Err(AppCommandError::invalid_input("Invalid snapshot id"));
    }
    let dir = data_dir.join(SAFETY_DIR).join(snapshot_id);
    if !dir.is_dir() {
        return Err(AppCommandError::not_found("Safety snapshot not found"));
    }
    let Some(manifest) = read_snapshot_manifest(&dir) else {
        return Err(AppCommandError::invalid_input(
            "This snapshot predates rollback support and can only be inspected",
        ));
    };

    // `present` is what to put back; `absent` is what to take away. Both are
    // narrowed to sections this binary knows — the swap has no live path for
    // anything else.
    let mut declared: Vec<String> = manifest.present.clone();
    declared.extend(manifest.absent.iter().cloned());
    let pending = PendingRestore {
        staging_dir: dir.to_string_lossy().into_owned(),
        created_at: Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        latest_migration: String::new(),
        managed_sections: Some(sections::normalize_section_ids(&declared)),
        absent_sections: sections::normalize_section_ids(&manifest.absent),
    };
    commit_pending_marker(data_dir, &pending)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Drop a staged restore that was never applied: remove the marker, then its
/// staging dir. Without this, a failed `relaunchApp()` leaves the user pinned
/// on `alreadyPending` with no way out.
pub fn discard_pending_restore_core(data_dir: &Path) -> Result<bool, AppCommandError> {
    let marker = data_dir.join(PENDING_MARKER);
    if !marker.is_file() {
        return Ok(false);
    }
    let staging = std::fs::read_to_string(&marker)
        .ok()
        .and_then(|raw| serde_json::from_str::<PendingRestore>(&raw).ok())
        .map(|p| PathBuf::from(p.staging_dir));
    // Marker first: while it exists the swap is still armed, and a crash
    // between the two leaves an orphaned staging dir that startup sweeps.
    std::fs::remove_file(&marker).map_err(AppCommandError::io)?;
    if let Some(staging) = staging {
        // ONLY a directory we created under the staging root. A rollback's
        // marker points at a safety snapshot instead, and deleting that would
        // destroy the very data the user was trying to recover — the escape
        // hatch would eat the parachute.
        if staging.starts_with(data_dir.join(STAGING_DIR)) {
            let _ = std::fs::remove_dir_all(staging);
        } else {
            tracing::info!(
                "[RESTORE] discarded a pending restore sourced from {}; leaving it in place",
                staging.display()
            );
        }
    }
    Ok(true)
}

/// Apply a staged restore if a pending marker exists. MUST run before the DB
/// connection is opened. Pure filesystem; crash-safe and idempotent.
///
/// Resolves the live uploads root + preferences path via the env-aware
/// `paths::*` resolvers (production), then delegates to
/// [`apply_pending_restore_with_paths`]. Tests call the inner fn with temp
/// paths so they never touch the real `~/.codeg`.
pub fn apply_pending_restore_on_startup(
    data_dir: &Path,
) -> Result<RestoreApplied, std::io::Error> {
    apply_pending_restore_with_paths(data_dir, &LiveRoots::resolve(data_dir))
}

pub(crate) fn apply_pending_restore_with_paths(
    data_dir: &Path,
    live_roots: &LiveRoots,
) -> Result<RestoreApplied, std::io::Error> {
    let marker = data_dir.join(PENDING_MARKER);
    if !marker.is_file() {
        return Ok(RestoreApplied::None);
    }
    let raw = std::fs::read_to_string(&marker)?;
    let pending: PendingRestore = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(_) => {
            // Corrupt / half-written marker — discard so we don't loop.
            tracing::warn!("[RESTORE] ignoring malformed pending-restore marker");
            let _ = std::fs::remove_file(&marker);
            return Ok(RestoreApplied::None);
        }
    };
    let staging = PathBuf::from(&pending.staging_dir);
    if !staging.is_dir() {
        tracing::info!("[RESTORE] staging dir missing, discarding marker");
        let _ = std::fs::remove_file(&marker);
        return Ok(RestoreApplied::None);
    }

    tracing::info!(
        "[RESTORE] applying staged restore (backup app_version={}, migration={})",
        pending.app_version, pending.latest_migration
    );

    // The snapshot directory is DERIVED from the marker, so every retry of the
    // same restore reuses it. A fresh directory per attempt used to scatter one
    // pre-restore state across several snapshots (boot 1 swapped the DB and
    // died, boot 2 swapped uploads), and pruning would then delete part of it.
    let backup_dir = data_dir.join(SAFETY_DIR).join(snapshot_dir_name(&pending));
    std::fs::create_dir_all(&backup_dir)?;

    let units = swap_units(&staging, data_dir, live_roots, &backup_dir, &pending);
    // Written once, before anything moves — on a retry the live tree is already
    // half-swapped and would misreport what was originally there.
    write_snapshot_manifest(&backup_dir, &pending.created_at, &units)?;

    let state_dir = staging.join(SWAP_STATE_DIR);
    for unit in &units {
        swap_unit(&state_dir, unit)?;
    }

    // Commit only after a fully successful swap. On a mid-swap crash we return
    // Err with marker + staging + safety snapshot all intact, so the next boot
    // resumes from the recorded per-unit state.
    std::fs::remove_file(&marker)?;
    let _ = std::fs::remove_dir_all(&staging);
    tracing::info!(
        "[RESTORE] restore applied; previous data preserved at {}",
        backup_dir.display()
    );
    Ok(RestoreApplied::Applied {
        safety_snapshot: Some(backup_dir),
    })
}

/// One thing the swap moves: the database, one of its WAL sidecars, or a
/// managed section.
struct SwapUnit {
    /// Stable id — names both the swap-state file and the snapshot manifest
    /// entry. Always a single safe path component.
    id: String,
    staged: PathBuf,
    live: PathBuf,
    snapshot: PathBuf,
    /// Move `live` aside even when the source has no counterpart, i.e. leave
    /// nothing behind. True for the DB's `-wal`/`-shm` (a `VACUUM INTO`
    /// snapshot is self-contained, and a leftover WAL would be replayed onto
    /// it) and for the units a rollback has to remove.
    evict_when_absent: bool,
}

fn swap_units(
    staging: &Path,
    data_dir: &Path,
    live_roots: &LiveRoots,
    backup_dir: &Path,
    pending: &PendingRestore,
) -> Vec<SwapUnit> {
    let db_name = crate::db::database_file_name();
    let mut units = Vec::new();
    for (id, suffix, evict) in [
        (DB_STAGING_DIR.to_string(), "", false),
        (format!("{DB_STAGING_DIR}-wal"), "-wal", true),
        (format!("{DB_STAGING_DIR}-shm"), "-shm", true),
    ] {
        let file = format!("{DB_STAGING_NAME}{suffix}");
        units.push(SwapUnit {
            id,
            staged: staging.join(DB_STAGING_DIR).join(&file),
            live: data_dir.join(format!("{db_name}{suffix}")),
            snapshot: backup_dir.join(DB_STAGING_DIR).join(&file),
            evict_when_absent: evict,
        });
    }
    // Only the sections the marker authorizes. Iterating the staged directory
    // instead would let a crafted archive that stages `pets/` without declaring
    // it replace the live tree.
    for id in pending.sections() {
        let Some(live) = live_roots.path(&id) else {
            continue;
        };
        let evict = pending.absent_sections.contains(&id);
        units.push(SwapUnit {
            staged: staging.join(&id),
            live: live.to_path_buf(),
            snapshot: backup_dir.join(&id),
            id,
            evict_when_absent: evict,
        });
    }
    units
}

/// Move `live` aside, then move `staged` into place — at most once per unit,
/// however many times the swap is retried.
///
/// The durable per-unit state is what makes a retry safe. `move_path` falls
/// back to copy-then-remove across filesystem boundaries, so a crash after the
/// copy but before the source is unlinked leaves `staged` AND `live` both
/// present. Without a record that the backup step already ran, the retry would
/// see `live.exists()` and move the *already-restored* data into the snapshot,
/// destroying the pre-restore copy it is supposed to preserve.
fn swap_unit(state_dir: &Path, unit: &SwapUnit) -> std::io::Result<()> {
    match read_swap_state(state_dir, &unit.id) {
        Some(SwapState::Published) => return Ok(()),
        // The backup step is done; touching it again is exactly the hazard.
        Some(SwapState::BackedUp) => {}
        None => {
            if (unit.evict_when_absent || unit.staged.exists()) && unit.live.exists() {
                move_path(&unit.live, &unit.snapshot)?;
            }
            // Durable BEFORE the next move: if this record were lost while the
            // move survived, the retry would fall back into the case above.
            write_swap_state(state_dir, &unit.id, SwapState::BackedUp)?;
        }
    }
    if unit.staged.exists() {
        move_path(&unit.staged, &unit.live)?;
    }
    write_swap_state(state_dir, &unit.id, SwapState::Published)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SwapState {
    BackedUp,
    Published,
}

impl SwapState {
    fn as_str(self) -> &'static str {
        match self {
            SwapState::BackedUp => "backed-up",
            SwapState::Published => "published",
        }
    }
}

fn read_swap_state(state_dir: &Path, id: &str) -> Option<SwapState> {
    match std::fs::read_to_string(state_dir.join(id)).ok()?.trim() {
        "published" => Some(SwapState::Published),
        "backed-up" => Some(SwapState::BackedUp),
        _ => None,
    }
}

/// Record a unit's progress durably and ATOMICALLY.
///
/// Atomic matters as much as durable: overwriting the file in place would
/// truncate `backed-up` before `published` lands, and a crash in that instant
/// leaves an unparseable record that reads back as "never started". The retry
/// would then redo the backup step against already-restored live data and move
/// it over the pre-restore snapshot — exactly the destruction this state
/// machine exists to prevent. A rename is all-or-nothing, so the file is
/// always one of the two valid values.
fn write_swap_state(state_dir: &Path, id: &str, state: SwapState) -> std::io::Result<()> {
    std::fs::create_dir_all(state_dir)?;
    let tmp = state_dir.join(format!(".{id}.tmp"));
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(state.as_str().as_bytes())?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, state_dir.join(id))?;
    // The file's own fsync does not publish its *name*; without this the entry
    // can be lost in a crash while the move it guards survives. No directory
    // handle to sync on Windows, where NTFS journals the metadata itself.
    #[cfg(unix)]
    std::fs::File::open(state_dir)?.sync_all()?;
    Ok(())
}

/// What the live data looked like when a snapshot was taken.
#[derive(Debug, Serialize, Deserialize)]
struct SnapshotManifest {
    v: u32,
    /// Snapshots are laid out exactly like a staging dir, so a rollback is
    /// "apply this directory as if it had been staged".
    layout: String,
    /// RFC3339 timestamp of the restore this snapshot was taken for.
    created_at: String,
    /// Units that existed live at snapshot time.
    present: Vec<String>,
    /// Units that did NOT exist. Rolling back has to REMOVE these; a snapshot
    /// that only records what was there can never undo a restore that
    /// introduced a file (say, another machine's `tokens.json`).
    absent: Vec<String>,
}

fn write_snapshot_manifest(
    backup_dir: &Path,
    created_at: &str,
    units: &[SwapUnit],
) -> std::io::Result<()> {
    let path = backup_dir.join(SNAPSHOT_MANIFEST);
    // The existence check is what stops a retry from recomputing present/absent
    // against a half-swapped live tree — which would record restored data as
    // "was already here" and make a later rollback wrong. That only holds if
    // existence implies completeness, hence the atomic write below: a partial
    // file must never be left behind for the retry to trust.
    if path.exists() {
        return Ok(());
    }
    let (present, absent): (Vec<_>, Vec<_>) = units.iter().partition(|u| u.live.exists());
    let manifest = SnapshotManifest {
        v: 1,
        layout: "staging".to_string(),
        created_at: created_at.to_string(),
        present: present.iter().map(|u| u.id.clone()).collect(),
        absent: absent.iter().map(|u| u.id.clone()).collect(),
    };
    let json = serde_json::to_vec_pretty(&manifest).map_err(std::io::Error::other)?;
    let tmp = backup_dir.join(format!("{SNAPSHOT_MANIFEST}.tmp"));
    let mut f = std::fs::File::create(&tmp)?;
    f.write_all(&json)?;
    f.sync_all()?;
    drop(f);
    std::fs::rename(&tmp, &path)?;
    #[cfg(unix)]
    std::fs::File::open(backup_dir)?.sync_all()?;
    Ok(())
}

/// Deterministic per-restore snapshot name: the restore's own timestamp in the
/// SAME `%Y%m%d-%H%M%S` shape the older names used, plus the staging op id.
///
/// Not the raw RFC3339 string: `2026-09-05T07-…` sorts *before* every legacy
/// `20260905-…` name (`-` is 0x2D, `0` is 0x30), so a lexicographic prune would
/// treat the newest snapshot as the oldest and delete it.
fn snapshot_dir_name(pending: &PendingRestore) -> String {
    let stamp = chrono::DateTime::parse_from_rfc3339(&pending.created_at)
        .map(|dt| dt.format("%Y%m%d-%H%M%S").to_string())
        .unwrap_or_else(|_| Utc::now().format("%Y%m%d-%H%M%S").to_string());
    let op = Path::new(&pending.staging_dir)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    format!("{stamp}-{op}")
}

/// Rename `src` → `dst`, falling back to recursive copy + remove across
/// filesystem boundaries (CODEG_HOME / CODEG_DATA_DIR may differ).
fn move_path(src: &Path, dst: &Path) -> std::io::Result<()> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }
    copy_recursive(src, dst)?;
    if src.is_dir() {
        std::fs::remove_dir_all(src)?;
    } else {
        std::fs::remove_file(src)?;
    }
    Ok(())
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        std::fs::create_dir_all(dst)?;
        // Every directory that gains an entry has to be flushed, not just the
        // root: a file's name lives in its own parent, and that parent's name
        // lives in ITS parent. Syncing only the root would leave nested files
        // with durable bytes and no durable name — indistinguishable from
        // never having been copied, while the caller has already deleted the
        // source and recorded the snapshot as taken.
        let mut dirs = std::collections::BTreeSet::new();
        dirs.insert(dst.to_path_buf());
        // The root's own name lives one level up, and `create_dir_all(dst)`
        // above may have just created it. Without this the whole copied tree
        // can vanish while the source is already deleted.
        if let Some(parent) = dst.parent() {
            dirs.insert(parent.to_path_buf());
        }
        for entry in walkdir::WalkDir::new(src).follow_links(false) {
            let entry = entry.map_err(std::io::Error::other)?;
            let rel = entry.path().strip_prefix(src).unwrap_or(entry.path());
            let target = dst.join(rel);
            if entry.file_type().is_dir() {
                std::fs::create_dir_all(&target)?;
                dirs.insert(target);
            } else if entry.file_type().is_file() {
                if let Some(parent) = target.parent() {
                    std::fs::create_dir_all(parent)?;
                    dirs.insert(parent.to_path_buf());
                }
                copy_durable(entry.path(), &target)?;
            }
        }
        // Deepest first — a child must exist before the parent entry naming it
        // is flushed. `BTreeSet` orders paths so a parent precedes its
        // children; reversing gives children first.
        for dir in dirs.iter().rev() {
            sync_dir(dir)?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        copy_durable(src, dst)?;
        if let Some(parent) = dst.parent() {
            sync_dir(parent)?;
        }
    }
    Ok(())
}

/// Copy one file and flush it before the caller unlinks the source.
///
/// This is the cross-filesystem half of [`move_path`], and the swap's crash
/// safety rests on it: `write_swap_state` fsyncs the `backed-up` record right
/// after the move, so unsynced copy data plus a synced record means a power
/// loss can leave "the snapshot is recorded as taken" while the snapshot's
/// bytes were never written — and the retry, trusting the record, skips the
/// backup step and the pre-restore data is gone for good.
fn copy_durable(src: &Path, dst: &Path) -> std::io::Result<()> {
    // Copied by hand rather than with `fs::copy` so we end up holding a
    // WRITE handle: `sync_all` is `FlushFileBuffers` on Windows, which
    // requires `GENERIC_WRITE` and fails with ACCESS_DENIED on the read-only
    // handle `File::open` would give — that would break every
    // cross-filesystem move on Windows, not just the durability of one.
    let mut input = std::fs::File::open(src)?;
    let mut out = std::fs::File::create(dst)?;
    std::io::copy(&mut input, &mut out)?;
    // Carry the source's mode across, as `fs::copy` would have. BEFORE the
    // flush, so the fsync covers it and the change cannot be lost to a crash —
    // and propagated, not best-effort: silently widening a `0600` secret to
    // whatever the umask allows is not an acceptable way to copy it. Setting
    // it on the path while our write handle is still open keeps a read-only
    // mode from blocking the flush.
    std::fs::set_permissions(dst, input.metadata()?.permissions())?;
    out.sync_all()?;
    Ok(())
}

/// Flush a directory's entries. Failures propagate: the caller is about to
/// delete the source it just copied, so an unflushed destination that it
/// records as durable is how the pre-restore data gets lost for good.
///
/// Windows offers no directory handle to fsync; NTFS journals the metadata
/// itself, so this is a no-op there.
#[cfg(unix)]
fn sync_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.sync_all()
}

#[cfg(not(unix))]
fn sync_dir(_dir: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Apply external transcripts from the staging dir per `mode`. External files
/// are owned by the agent CLIs, so OriginalLocations never overwrites an
/// existing file unless the caller authorized it (`Overwrite`); skipped paths
/// are returned for the UI to report.
async fn handle_external(
    staging_root: &Path,
    data_dir: &Path,
    manifest: &BackupManifest,
    mode: ExternalRestoreMode,
    cancel: &CancellationToken,
) -> Result<(Option<String>, super::external::ExternalRestoreReport), AppCommandError> {
    let staged_external = staging_root.join("external");
    if !manifest.includes_external_transcripts || !staged_external.is_dir() {
        return Ok((None, Default::default()));
    }
    match mode {
        ExternalRestoreMode::Skip => {
            let _ = tokio::fs::remove_dir_all(&staged_external).await;
            Ok((None, Default::default()))
        }
        ExternalRestoreMode::SideLocation => {
            // Zero-risk: move the whole tree to a timestamped side folder under
            // the data dir; the user copies it back manually if desired.
            let stamp = sanitize_stamp(&manifest.created_at);
            let dest = data_dir.join(RESTORED_TRANSCRIPTS_DIR).join(stamp);
            let staged_c = staged_external.clone();
            let dest_c = dest.clone();
            tokio::task::spawn_blocking(move || move_path(&staged_c, &dest_c))
                .await
                .map_err(spawn_err)?
                .map_err(AppCommandError::io)?;
            Ok((Some(dest.to_string_lossy().into_owned()), Default::default()))
        }
        ExternalRestoreMode::OriginalLocations { on_conflict } => {
            let staged_c = staged_external.clone();
            let cancel_c = cancel.clone();
            let report = tokio::task::spawn_blocking(move || {
                super::external::restore_external_from_staging(&staged_c, on_conflict, &cancel_c)
            })
            .await
            .map_err(spawn_err)??;
            let _ = tokio::fs::remove_dir_all(&staged_external).await;
            Ok((None, report))
        }
    }
}

fn write_pending_marker(
    data_dir: &Path,
    staging_root: &Path,
    manifest: &BackupManifest,
) -> Result<(), AppCommandError> {
    commit_pending_marker(
        data_dir,
        &PendingRestore {
            staging_dir: staging_root.to_string_lossy().into_owned(),
            created_at: Utc::now().to_rfc3339(),
            app_version: manifest.app_version.clone(),
            latest_migration: manifest.latest_migration.clone(),
            managed_sections: Some(manifest_section_ids(manifest)),
            absent_sections: Vec::new(),
        },
    )
}

fn commit_pending_marker(
    data_dir: &Path,
    pending: &PendingRestore,
) -> Result<(), AppCommandError> {
    let json = serde_json::to_vec_pretty(pending)
        .map_err(|e| AppCommandError::task_execution_failed("Serialize restore marker").with_detail(e.to_string()))?;
    let marker = data_dir.join(PENDING_MARKER);
    // Atomic, no-clobber claim: `create_new` lets exactly one concurrent stage
    // commit. A second one fails with AlreadyExists rather than racing a rename
    // and silently committing a different staging dir. A crash mid-write leaves
    // a partial marker, which `apply_pending_restore_*` treats as malformed and
    // discards (its staging is then reaped by `cleanup_transient_dirs`).
    let mut f = match OpenOptions::new().write(true).create_new(true).open(&marker) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(already_pending_error())
        }
        Err(e) => return Err(AppCommandError::io(e)),
    };
    f.write_all(&json).map_err(AppCommandError::io)?;
    Ok(())
}

/// Sections an archive declares, normalized to this binary's table. An archive
/// written before the field existed is normalized to the legacy three — the
/// only sections that format ever managed — rather than to the full table.
fn manifest_section_ids(manifest: &BackupManifest) -> Vec<String> {
    match manifest.managed_sections.as_deref() {
        Some(list) => sections::normalize_section_ids(list),
        None => legacy_section_ids(),
    }
}

fn already_pending_error() -> AppCommandError {
    AppCommandError::already_exists(
        "A restore is already staged; restart to apply it before staging another",
    )
    .with_i18n(BACKUP_I18N_KEY_ALREADY_PENDING, Default::default())
}

fn reject_to_error(manifest: &BackupManifest, reason: Option<&str>) -> AppCommandError {
    use crate::app_error::BACKUP_I18N_KEY_NEWER_VERSION;
    match reason {
        Some(k) if k == BACKUP_I18N_KEY_NEWER_VERSION => {
            super::newer_version_error(&manifest.app_version, env!("CARGO_PKG_VERSION"))
        }
        _ => super::unknown_format_error(),
    }
}

fn sanitize_stamp(rfc3339: &str) -> String {
    rfc3339
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn emit(emitter: &EventEmitter, op_id: &str, phase: BackupPhase) {
    emit_event(emitter, BACKUP_PROGRESS_EVENT, BackupProgress::phase(op_id, phase));
}

fn emit_progress(
    emitter: &EventEmitter,
    op_id: &str,
    phase: BackupPhase,
    processed: u64,
    total: u64,
    path: Option<String>,
) {
    emit_event(
        emitter,
        BACKUP_PROGRESS_EVENT,
        BackupProgress {
            op_id: op_id.to_string(),
            phase,
            processed_bytes: processed,
            total_bytes: Some(total.max(processed)),
            current_path: path,
            error: None,
        },
    );
}

fn spawn_err(e: tokio::task::JoinError) -> AppCommandError {
    AppCommandError::task_execution_failed("Restore task failed").with_detail(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::MigratorTrait;

    fn known_migration() -> String {
        crate::db::migration::Migrator::migrations()
            .last()
            .map(|m| m.name().to_string())
            .unwrap_or_default()
    }

    /// Build a plaintext archive with exactly `files` and the given section
    /// declaration — `None` reproduces a pre-`managedSections` archive.
    fn write_archive(dest: &Path, managed: Option<Vec<String>>, files: &[(&str, &[u8])]) {
        use super::super::manifest::{BACKUP_FORMAT_VERSION, BACKUP_KIND};
        let cancel = CancellationToken::new();
        let scratch = dest.parent().unwrap().join(format!(
            "src-{}",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&scratch).unwrap();
        let mut b = archive::ArchiveBuilder::create(dest).unwrap();
        let mut prog = archive::null_progress();
        for (i, (name, bytes)) in files.iter().enumerate() {
            let p = scratch.join(format!("f{i}"));
            std::fs::write(&p, bytes).unwrap();
            b.add_file(name, &p, &cancel, &mut prog).unwrap();
        }
        b.finish(BackupManifest {
            format_version: BACKUP_FORMAT_VERSION,
            kind: BACKUP_KIND.to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: known_migration(),
            runtime: "server".to_string(),
            includes_external_transcripts: false,
            includes_secrets: true,
            managed_sections: managed,
            degraded_sqlite: Vec::new(),
            entries: Vec::new(),
        })
        .unwrap();
    }

    /// Restoring a pre-`managedSections` archive must not touch a section that
    /// format never knew about — otherwise fixing D1 would itself wipe every
    /// custom-agent transcript on the machine being restored onto.
    #[tokio::test]
    async fn legacy_manifest_without_sections_leaves_new_roots_untouched() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        std::fs::create_dir_all(&data_dir).unwrap();
        let src = dir.path().join("legacy.zip");
        write_archive(
            &src,
            None,
            &[("db/codeg.db", b"NEW-DB"), ("uploads/a.txt", b"A")],
        );

        let live_base = dir.path().join("live");
        let transcript = live_base.join("acp-transcripts").join("s.jsonl");
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        std::fs::write(&transcript, b"KEEP-ME").unwrap();

        let cancel = CancellationToken::new();
        stage_restore_core(
            &src,
            &data_dir,
                        &EventEmitter::Noop,
            "lg",
            &cancel,
        )
        .await
        .unwrap();

        let staging = data_dir.join(STAGING_DIR).join("lg");
        assert!(
            staging.join("uploads").is_dir(),
            "uploads is legacy-managed and must still be force-created"
        );
        assert!(
            !staging.join("acp-transcripts").exists(),
            "a legacy archive must not claim sections its format never had"
        );

        apply_pending_restore_with_paths(&data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();
        assert_eq!(std::fs::read(&transcript).unwrap(), b"KEEP-ME");
    }

    /// Same guarantee one layer down: a marker written by the previous build
    /// has no `managedSections` key at all, and apply runs in the process that
    /// already has the new table.
    #[test]
    fn legacy_marker_without_sections_field_falls_back_to_three_sections() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(staging.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(staging.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"NEW-DB").unwrap();
        std::fs::create_dir_all(staging.join("uploads")).unwrap();
        std::fs::write(staging.join("uploads").join("a.txt"), b"A").unwrap();
        std::fs::create_dir_all(staging.join("acp-transcripts")).unwrap();
        std::fs::write(
            staging.join("acp-transcripts").join("s.jsonl"),
            b"FROM-ARCHIVE",
        )
        .unwrap();

        std::fs::write(
            data_dir.join(PENDING_MARKER),
            serde_json::json!({
                "staging_dir": staging.to_string_lossy(),
                "created_at": "2026-06-06T00:00:00Z",
                "app_version": "0.15.0",
                "latest_migration": "m20260522_000001_delegation_columns",
            })
            .to_string(),
        )
        .unwrap();

        let live_base = dir.path().join("live");
        let live_transcript = live_base.join("acp-transcripts").join("s.jsonl");
        std::fs::create_dir_all(live_transcript.parent().unwrap()).unwrap();
        std::fs::write(&live_transcript, b"KEEP-ME").unwrap();

        apply_pending_restore_with_paths(data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();
        assert_eq!(
            std::fs::read(live_base.join("uploads").join("a.txt")).unwrap(),
            b"A"
        );
        assert_eq!(std::fs::read(&live_transcript).unwrap(), b"KEEP-ME");
    }

    /// The marker's declaration — not the staged directory listing — decides
    /// what may be replaced, so an archive that stages a section it never
    /// declared cannot reach live data.
    #[test]
    fn apply_ignores_staged_dirs_outside_the_marker_declaration() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(staging.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(staging.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"NEW-DB").unwrap();
        std::fs::create_dir_all(staging.join("pets")).unwrap();
        std::fs::write(staging.join("pets").join("evil.png"), b"SMUGGLED").unwrap();

        let marker = PendingRestore {
            staging_dir: staging.to_string_lossy().into_owned(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: "m20260522_000001_delegation_columns".to_string(),
            managed_sections: Some(vec!["uploads".to_string()]),
            absent_sections: Vec::new(),
        };
        std::fs::write(
            data_dir.join(PENDING_MARKER),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();

        let live_base = dir.path().join("live");
        let live_pet = live_base.join("pets").join("mine.png");
        std::fs::create_dir_all(live_pet.parent().unwrap()).unwrap();
        std::fs::write(&live_pet, b"MINE").unwrap();

        apply_pending_restore_with_paths(data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();
        assert_eq!(std::fs::read(&live_pet).unwrap(), b"MINE");
        assert!(!live_base.join("pets").join("evil.png").exists());
    }

    #[test]
    fn swap_unit_moves_live_aside_then_publishes_exactly_once() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        let unit = SwapUnit {
            id: "uploads".to_string(),
            staged: dir.path().join("staged.txt"),
            live: dir.path().join("live.txt"),
            snapshot: dir.path().join("snap/live.txt"),
            evict_when_absent: false,
        };
        std::fs::write(&unit.staged, b"new").unwrap();
        std::fs::write(&unit.live, b"old").unwrap();

        swap_unit(&state, &unit).unwrap();
        assert_eq!(std::fs::read(&unit.live).unwrap(), b"new");
        assert_eq!(std::fs::read(&unit.snapshot).unwrap(), b"old");
        assert!(!unit.staged.exists());

        // Replayed after the unit is Published: nothing moves, so the snapshot
        // can never be overwritten with already-restored data.
        std::fs::write(&unit.staged, b"newer").unwrap();
        swap_unit(&state, &unit).unwrap();
        assert_eq!(std::fs::read(&unit.live).unwrap(), b"new");
        assert_eq!(std::fs::read(&unit.snapshot).unwrap(), b"old");
    }

    /// Write a marker for a staging dir under `data_dir`, declaring `sections`.
    fn write_marker(data_dir: &Path, staging: &Path, sections: &[&str]) {
        let marker = PendingRestore {
            staging_dir: staging.to_string_lossy().into_owned(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: "m20260522_000001_delegation_columns".to_string(),
            managed_sections: Some(sections.iter().map(|s| (*s).to_string()).collect()),
            absent_sections: Vec::new(),
        };
        std::fs::write(
            data_dir.join(PENDING_MARKER),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();
    }

    /// A restore interrupted part-way and retried must keep ONE snapshot.
    /// Splitting the pre-restore state across a directory per attempt used to
    /// leave the database in one snapshot and the uploads in another — and
    /// pruning would then delete half of it.
    #[cfg(unix)]
    #[test]
    fn retries_reuse_one_snapshot_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let db_name = crate::db::database_file_name();
        std::fs::write(data_dir.join(db_name), b"OLD-DB").unwrap();

        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(staging.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(staging.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"NEW-DB").unwrap();
        std::fs::create_dir_all(staging.join("uploads")).unwrap();
        std::fs::write(staging.join("uploads").join("new.png"), b"NEW").unwrap();
        write_marker(data_dir, &staging, &["uploads"]);

        let live_base = dir.path().join("live");
        std::fs::create_dir_all(live_base.join("uploads")).unwrap();
        std::fs::write(live_base.join("uploads").join("old.png"), b"ORIGINAL").unwrap();
        let roots = LiveRoots::rooted_at(&live_base);

        // Boot 1: the DB swaps, then the uploads move fails (its parent is not
        // writable, so neither the rename nor the copy's cleanup can finish).
        std::fs::set_permissions(&live_base, std::fs::Permissions::from_mode(0o555)).unwrap();
        assert!(apply_pending_restore_with_paths(data_dir, &roots).is_err());
        std::fs::set_permissions(&live_base, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(data_dir.join(PENDING_MARKER).is_file(), "marker survives");

        // Boot 2: resumes and completes.
        apply_pending_restore_with_paths(data_dir, &roots).unwrap();

        let snapshots: Vec<_> = std::fs::read_dir(data_dir.join(SAFETY_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .collect();
        assert_eq!(snapshots.len(), 1, "{snapshots:?}");
        let snap = &snapshots[0];
        assert_eq!(
            std::fs::read(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME)).unwrap(),
            b"OLD-DB"
        );
        assert_eq!(
            std::fs::read(snap.join("uploads").join("old.png")).unwrap(),
            b"ORIGINAL"
        );
        assert_eq!(std::fs::read(data_dir.join(db_name)).unwrap(), b"NEW-DB");
    }

    /// The regression that made a "deterministic snapshot directory" alone
    /// WORSE than the bug it fixed. `move_path` degrades to copy-then-remove
    /// across filesystems, so a crash after the copy leaves staged and live
    /// both present. Without the durable `backed-up` record the retry would
    /// move the already-restored live data into the snapshot, destroying the
    /// pre-restore copy.
    #[test]
    fn retry_after_copy_without_source_removal_keeps_the_original_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(staging.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(staging.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"NEW-DB").unwrap();
        // Staged uploads still present: the copy into live succeeded, the
        // source removal did not.
        std::fs::create_dir_all(staging.join("uploads")).unwrap();
        std::fs::write(staging.join("uploads").join("new.png"), b"FROM-BACKUP").unwrap();
        write_marker(data_dir, &staging, &["uploads"]);

        // The snapshot already holds the pre-restore uploads, and the unit is
        // recorded as backed up.
        let marker: PendingRestore =
            serde_json::from_slice(&std::fs::read(data_dir.join(PENDING_MARKER)).unwrap()).unwrap();
        let snap = data_dir.join(SAFETY_DIR).join(snapshot_dir_name(&marker));
        std::fs::create_dir_all(snap.join("uploads")).unwrap();
        std::fs::write(snap.join("uploads").join("old.png"), b"ORIGINAL").unwrap();
        write_swap_state(&staging.join(SWAP_STATE_DIR), "uploads", SwapState::BackedUp).unwrap();

        // Live uploads is the half-restored copy.
        let live_base = dir.path().join("live");
        std::fs::create_dir_all(live_base.join("uploads")).unwrap();
        std::fs::write(
            live_base.join("uploads").join("new.png"),
            b"FROM-BACKUP",
        )
        .unwrap();

        apply_pending_restore_with_paths(data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();

        assert_eq!(
            std::fs::read(snap.join("uploads").join("old.png")).unwrap(),
            b"ORIGINAL",
            "the pre-restore snapshot must survive the retry"
        );
        assert!(
            !snap.join("uploads").join("new.png").exists(),
            "restored data must never be folded into the snapshot"
        );
    }

    #[test]
    fn prune_keeps_only_the_newest_n_snapshots() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(SAFETY_DIR);
        for name in [
            "20260101-000000-a",
            "20260201-000000-b",
            "20260301-000000-c",
            "20260401-000000-d",
        ] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        prune_safety_snapshots(dir.path(), 2);
        let mut left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, vec!["20260301-000000-c", "20260401-000000-d"]);
    }

    /// The two naming schemes do not sort against each other as strings — an
    /// RFC3339-derived name (`2026-…`) sorts before every `2026…` legacy name
    /// because `-` (0x2D) precedes `0` (0x30). Pruning by parsed time, not by
    /// name, is what keeps that from deleting the newest snapshot.
    #[test]
    fn prune_orders_legacy_and_new_snapshot_names_chronologically() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(SAFETY_DIR);
        for name in [
            "20260101-000000-deadbeef",     // legacy naming, oldest
            "20260901-120000-op-newest",    // current naming, newest
            "20260501-000000-op-middle",
        ] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        prune_safety_snapshots(dir.path(), 1);
        let left: Vec<String> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(left, vec!["20260901-120000-op-newest".to_string()]);
    }

    #[test]
    fn prune_skips_when_a_restore_is_pending() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(SAFETY_DIR);
        for name in ["20260101-000000-a", "20260201-000000-b"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        std::fs::write(dir.path().join(PENDING_MARKER), b"{}").unwrap();
        prune_safety_snapshots(dir.path(), 1);
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 2);
    }

    /// Build a rollback-capable snapshot directory by hand.
    fn write_snapshot(
        data_dir: &Path,
        id: &str,
        present: &[&str],
        absent: &[&str],
    ) -> PathBuf {
        let dir = data_dir.join(SAFETY_DIR).join(id);
        std::fs::create_dir_all(&dir).unwrap();
        let manifest = SnapshotManifest {
            v: 1,
            layout: "staging".to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            present: present.iter().map(|s| (*s).to_string()).collect(),
            absent: absent.iter().map(|s| (*s).to_string()).collect(),
        };
        std::fs::write(
            dir.join(SNAPSHOT_MANIFEST),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        dir
    }

    /// A snapshot that only recorded what WAS there could never undo a restore
    /// that brought a file in — another machine's `tokens.json` would stay
    /// live forever.
    #[test]
    fn rollback_removes_a_file_the_restore_introduced() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let db_name = crate::db::database_file_name();
        let snap = write_snapshot(data_dir, "20260101-000000-op1", &["db"], &["tokens.json"]);
        std::fs::create_dir_all(snap.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"OLD-DB").unwrap();

        // Live state after the restore we are undoing.
        std::fs::write(data_dir.join(db_name), b"RESTORED-DB").unwrap();
        let live_base = dir.path().join("live");
        std::fs::create_dir_all(&live_base).unwrap();
        let live_tokens = live_base.join("tokens.json");
        std::fs::write(&live_tokens, b"THEIR-CREDENTIALS").unwrap();

        rollback_to_snapshot_core(data_dir, "20260101-000000-op1").unwrap();
        apply_pending_restore_with_paths(data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();

        assert_eq!(std::fs::read(data_dir.join(db_name)).unwrap(), b"OLD-DB");
        assert!(
            !live_tokens.exists(),
            "a file the restore introduced must be removed, not left live"
        );
        // Still recoverable from the snapshot the rollback itself took.
        let recovered = std::fs::read_dir(data_dir.join(SAFETY_DIR))
            .unwrap()
            .flatten()
            .map(|e| e.path().join("tokens.json"))
            .find(|p| p.is_file());
        assert_eq!(
            std::fs::read(recovered.expect("rollback snapshot")).unwrap(),
            b"THEIR-CREDENTIALS"
        );
    }

    /// A rollback snapshot carries the DB's WAL sidecars; putting the database
    /// back without them would drop every transaction that had not been
    /// checkpointed.
    #[test]
    fn rollback_restores_db_wal_sidecars() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let db_name = crate::db::database_file_name();
        let snap = write_snapshot(data_dir, "20260101-000000-op1", &["db", "db-wal"], &[]);
        std::fs::create_dir_all(snap.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"OLD-DB").unwrap();
        std::fs::write(
            snap.join(DB_STAGING_DIR).join(format!("{DB_STAGING_NAME}-wal")),
            b"OLD-WAL",
        )
        .unwrap();
        std::fs::write(data_dir.join(db_name), b"RESTORED-DB").unwrap();

        rollback_to_snapshot_core(data_dir, "20260101-000000-op1").unwrap();
        let live_base = dir.path().join("live");
        apply_pending_restore_with_paths(data_dir, &LiveRoots::rooted_at(&live_base)).unwrap();

        assert_eq!(std::fs::read(data_dir.join(db_name)).unwrap(), b"OLD-DB");
        assert_eq!(
            std::fs::read(data_dir.join(format!("{db_name}-wal"))).unwrap(),
            b"OLD-WAL"
        );
    }

    #[test]
    fn rollback_refuses_a_legacy_layout_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(SAFETY_DIR).join("20260101-000000-old")).unwrap();
        assert!(rollback_to_snapshot_core(dir.path(), "20260101-000000-old").is_err());
        assert!(rollback_to_snapshot_core(dir.path(), "../escape").is_err());

        let listed = list_safety_snapshots_core(dir.path());
        assert_eq!(listed.len(), 1);
        assert!(!listed[0].rollback_supported);
    }

    /// The gate must NEVER turn a staged restore into an error. The marker is
    /// committed before external handling runs, so a 4xx here would tell the
    /// UI "failed, don't restart" while the swap applies on the next launch
    /// regardless — the exact trap the commit-ordering comment warns about.
    /// With agents running it downgrades to the side location instead, keeps
    /// every byte, and says so.
    #[tokio::test]
    async fn original_locations_downgrades_instead_of_failing_when_agents_run() {
        use crate::acp::manager::ConnectionManager;
        use crate::models::AgentType;

        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        let staged_external = staging.join("external").join("claude").join("projects");
        std::fs::create_dir_all(&staged_external).unwrap();
        std::fs::write(staged_external.join("x.jsonl"), b"TRANSCRIPT").unwrap();

        let mut manifest = BackupManifest {
            format_version: 1,
            kind: "codeg-backup".to_string(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: String::new(),
            runtime: "server".to_string(),
            includes_external_transcripts: true,
            includes_secrets: false,
            managed_sections: None,
            degraded_sqlite: Vec::new(),
            entries: Vec::new(),
        };
        manifest.includes_external_transcripts = true;
        let mut staged = StagedRestore {
            staging_dir: staging.to_string_lossy().into_owned(),
            manifest,
            restored_external_path: None,
            skipped_conflicts: Vec::new(),
            refused_external: Vec::new(),
            external_downgraded: None,
        };

        let connections = ConnectionManager::new();
        connections
            .insert_test_connection("c1", AgentType::ClaudeCode, None, EventEmitter::Noop)
            .await;

        dispatch_external_after_stage(
            &mut staged,
            data_dir,
            &connections,
            ExternalRestoreMode::OriginalLocations {
                on_conflict: ConflictPolicy::Overwrite,
            },
            &CancellationToken::new(),
        )
        .await;

        let downgrade = staged
            .external_downgraded
            .as_ref()
            .expect("a running agent must force a downgrade, not a failure");
        assert_eq!(downgrade.agents, vec!["Claude Code".to_string()]);
        assert!(!downgrade.path.is_empty());
        // Every byte is still there, in the side location.
        let side = PathBuf::from(&downgrade.path);
        assert_eq!(
            std::fs::read(side.join("claude").join("projects").join("x.jsonl")).unwrap(),
            b"TRANSCRIPT"
        );
        assert_eq!(staged.restored_external_path.as_deref(), Some(downgrade.path.as_str()));
    }

    /// The escape hatch must not eat the parachute. A rollback's marker points
    /// at a safety snapshot rather than a staging dir, so discarding it after
    /// a failed restart used to delete the very data being recovered.
    #[test]
    fn discard_keeps_a_snapshot_a_rollback_was_staged_from() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let snap = write_snapshot(data_dir, "20260101-000000-op1", &["db"], &[]);
        std::fs::create_dir_all(snap.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"OLD-DB").unwrap();

        rollback_to_snapshot_core(data_dir, "20260101-000000-op1").unwrap();
        assert!(discard_pending_restore_core(data_dir).unwrap());

        assert!(!data_dir.join(PENDING_MARKER).exists());
        assert_eq!(
            std::fs::read(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME)).unwrap(),
            b"OLD-DB",
            "the snapshot must survive discarding the rollback that used it"
        );
        // And it is still offered for a retry.
        assert_eq!(list_safety_snapshots_core(data_dir).len(), 1);
    }

    /// A torn `published` write must not read back as "never started": the
    /// retry would then redo the backup step against already-restored live
    /// data and move it over the pre-restore snapshot.
    #[test]
    fn swap_state_survives_a_crash_between_two_values() {
        let dir = tempfile::tempdir().unwrap();
        let state = dir.path().join("state");
        write_swap_state(&state, "uploads", SwapState::BackedUp).unwrap();
        write_swap_state(&state, "uploads", SwapState::Published).unwrap();
        assert!(matches!(
            read_swap_state(&state, "uploads"),
            Some(SwapState::Published)
        ));
        // Nothing half-written is left for a reader to trip over.
        let leftovers: Vec<String> = std::fs::read_dir(&state)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(leftovers, vec!["uploads".to_string()], "{leftovers:?}");
    }

    /// The retry MUST reuse the manifest rather than recompute present/absent
    /// from a half-swapped live tree — recomputing would record restored data
    /// as "was already here" and make a later rollback put back the wrong set.
    #[test]
    fn snapshot_manifest_is_written_once_and_never_partial() {
        let dir = tempfile::tempdir().unwrap();
        let backup_dir = dir.path().join("snap");
        std::fs::create_dir_all(&backup_dir).unwrap();
        let live = dir.path().join("live");
        std::fs::create_dir_all(live.join("uploads")).unwrap();

        let unit = |id: &str, path: PathBuf| SwapUnit {
            id: id.to_string(),
            staged: dir.path().join("staged").join(id),
            live: path,
            snapshot: backup_dir.join(id),
            evict_when_absent: false,
        };
        let units = vec![
            unit("uploads", live.join("uploads")),
            unit("pets", live.join("pets")),
        ];
        write_snapshot_manifest(&backup_dir, "2026-06-06T00:00:00Z", &units).unwrap();
        let first = read_snapshot_manifest(&backup_dir).expect("manifest");
        assert_eq!(first.present, vec!["uploads".to_string()]);
        assert_eq!(first.absent, vec!["pets".to_string()]);
        assert!(
            !backup_dir.join(format!("{SNAPSHOT_MANIFEST}.tmp")).exists(),
            "the atomic write must leave no temp behind"
        );

        // Simulate the retry: `pets` now exists because the swap created it.
        std::fs::create_dir_all(live.join("pets")).unwrap();
        write_snapshot_manifest(&backup_dir, "2026-06-06T00:00:00Z", &units).unwrap();
        let second = read_snapshot_manifest(&backup_dir).expect("manifest");
        assert_eq!(
            second.absent,
            vec!["pets".to_string()],
            "the retry must not recompute against already-restored data"
        );
    }

    #[test]
    fn discard_pending_removes_marker_and_staging() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(&staging).unwrap();
        std::fs::write(staging.join("x"), b"staged").unwrap();
        write_marker(data_dir, &staging, &["uploads"]);

        assert!(discard_pending_restore_core(data_dir).unwrap());
        assert!(!data_dir.join(PENDING_MARKER).exists());
        assert!(!staging.exists());
        // Idempotent: nothing pending is not an error.
        assert!(!discard_pending_restore_core(data_dir).unwrap());
    }

    #[test]
    fn apply_is_noop_without_marker() {
        let dir = tempfile::tempdir().unwrap();
        assert!(matches!(
            apply_pending_restore_on_startup(dir.path()).unwrap(),
            RestoreApplied::None
        ));
    }

    #[test]
    fn apply_ignores_malformed_marker() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(PENDING_MARKER), b"{not json").unwrap();
        assert!(matches!(
            apply_pending_restore_on_startup(dir.path()).unwrap(),
            RestoreApplied::None
        ));
        assert!(!dir.path().join(PENDING_MARKER).exists());
    }

    #[test]
    fn apply_swaps_staged_db_and_snapshots_old() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        let db_name = crate::db::database_file_name();

        // Current live DB (plus a stale WAL sidecar) + a staged replacement.
        std::fs::write(data_dir.join(db_name), b"OLD-DB").unwrap();
        std::fs::write(data_dir.join(format!("{db_name}-wal")), b"OLD-WAL").unwrap();
        let staging = data_dir.join(STAGING_DIR).join("op1");
        std::fs::create_dir_all(staging.join(DB_STAGING_DIR)).unwrap();
        std::fs::write(staging.join(DB_STAGING_DIR).join(DB_STAGING_NAME), b"NEW-DB").unwrap();

        let marker = PendingRestore {
            staging_dir: staging.to_string_lossy().into_owned(),
            created_at: "2026-06-06T00:00:00Z".to_string(),
            app_version: "0.15.0".to_string(),
            latest_migration: "m20260522_000001_delegation_columns".to_string(),
            managed_sections: Some(vec![]),
            absent_sections: Vec::new(),
        };
        std::fs::write(
            data_dir.join(PENDING_MARKER),
            serde_json::to_vec(&marker).unwrap(),
        )
        .unwrap();

        let live = LiveRoots::rooted_at(&dir.path().join("live"));
        let applied = apply_pending_restore_with_paths(data_dir, &live).unwrap();
        match applied {
            RestoreApplied::Applied { safety_snapshot } => {
                // Snapshot is in STAGING layout so a rollback can replay it.
                let snap = safety_snapshot.expect("snapshot");
                assert_eq!(
                    std::fs::read(snap.join(DB_STAGING_DIR).join(DB_STAGING_NAME)).unwrap(),
                    b"OLD-DB"
                );
                assert_eq!(
                    std::fs::read(
                        snap.join(DB_STAGING_DIR)
                            .join(format!("{DB_STAGING_NAME}-wal"))
                    )
                    .unwrap(),
                    b"OLD-WAL"
                );
            }
            RestoreApplied::None => panic!("expected a restore to be applied"),
        }
        assert_eq!(std::fs::read(data_dir.join(db_name)).unwrap(), b"NEW-DB");
        // The stale WAL must be gone: replaying it onto the new DB corrupts it.
        assert!(!data_dir.join(format!("{db_name}-wal")).exists());
        assert!(!data_dir.join(PENDING_MARKER).exists());
        assert!(!staging.exists());

        // Idempotent second call: nothing pending.
        assert!(matches!(
            apply_pending_restore_with_paths(data_dir, &live).unwrap(),
            RestoreApplied::None
        ));
    }
}
