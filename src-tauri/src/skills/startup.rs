//! What runs once at startup, in the background, each step under the skills
//! lock: putting back what a crash left half-moved, moving an older
//! release's backups out of the way, claiming the Office skills for Office's
//! new manifest, extracting the bundled Experts and Science skills, and
//! bringing the link record in line with the disk.
//!
//! Restoring Codeg's backup over the store happens earlier, before anything
//! else runs (`commands::backup::restore`); it takes the same lock and hands
//! the record from before the restore to [`absorb_record_after_restore`]:
//! which folders in the agents' directories are Codeg's copies follows that
//! record (the restore did not bring those directories back), and the links
//! are rebuilt from the disk when the record is reconciled here.

use std::path::Path;

use crate::web::event_bridge::EventEmitter;

use super::model::ChangedKind;
use super::packs::InstallReport;
use super::provenance::STAGING_DIR;
use super::record::{reconcile, LinkRecord};
use super::SkillsCtx;

/// How long the startup steps wait for the lock.
const STARTUP_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(30);

#[derive(Debug, Default)]
pub struct StartupReport {
    pub experts: InstallReport,
    pub science: InstallReport,
    pub problems: Vec<String>,
    pub backups_moved: usize,
    pub backups_kept: usize,
    pub changed: bool,
}

/// Remove what the store's staging holds without an `op.json` (those are a
/// Harness install's journal, which its own recovery finishes first) — after
/// putting back a skill a crash left swapped out (`packs::recover_placed`).
pub(crate) fn clear_store_staging(ctx: &SkillsCtx) -> Vec<String> {
    let root = ctx.store.join(STAGING_DIR);
    let mut problems = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return problems;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.join("op.json").exists() {
            continue;
        }
        if let Some(Err(err)) = super::packs::recover_placed(ctx, &path) {
            problems.push(format!(
                "{}: the skill it holds could not go back ({err}); it stays",
                path.display()
            ));
            continue;
        }
        if let Err(err) = std::fs::remove_dir_all(&path) {
            problems.push(format!("{}: {err}", path.display()));
        }
    }
    super::fsio::remove_if_empty(&root);
    problems
}

fn maintenance(ctx: &SkillsCtx, report: &mut StartupReport) {
    let record = LinkRecord::load(&ctx.store);
    report.problems.extend(super::copies::recover(ctx, &record));
    // Harness's journals (`op.json`) first: finished or rolled back before
    // the staging without one is cleared.
    let harness = crate::harness::skills::recover_journals(ctx);
    if harness.changed {
        report.changed = true;
    }
    report.problems.extend(harness.problems);
    report.problems.extend(clear_store_staging(ctx));
    let (moved, kept, problems) = super::backups::migrate_legacy(ctx);
    report.backups_moved = moved;
    report.backups_kept = kept;
    report.problems.extend(problems);
    if moved > 0 {
        report.changed = true;
    }
    match super::packs::migrate_office_manifest(ctx) {
        Ok(true) => report.changed = true,
        Ok(false) => {}
        Err(err) => report.problems.push(format!("office manifest: {err}")),
    }
}

/// Everything above, blocking. `install` extracts the two bundled packs.
pub(crate) fn run_blocking(ctx: &SkillsCtx) -> StartupReport {
    let mut report = StartupReport::default();
    let mut ctx = ctx.clone();
    ctx.lock_wait = STARTUP_LOCK_WAIT;
    match ctx.lock_blocking() {
        Ok(_guard) => maintenance(&ctx, &mut report),
        Err(err) => report.problems.push(format!("maintenance skipped: {err}")),
    }
    report.experts = crate::commands::experts::install_in(&ctx);
    report.science = crate::commands::science::install_in(&ctx);
    if report.experts.installed_count + report.experts.updated_count > 0
        || report.science.installed_count + report.science.updated_count > 0
    {
        report.changed = true;
    }
    match ctx.lock_blocking() {
        Ok(_guard) => {
            let mut record = LinkRecord::load(&ctx.store);
            if reconcile(&ctx, &mut record) {
                if let Err(err) = record.save(&ctx.store) {
                    report.problems.push(format!("link record: {err}"));
                }
            }
        }
        Err(err) => report.problems.push(format!("link record skipped: {err}")),
    }
    report
}

fn log_pack(name: &str, report: &InstallReport) {
    if !report.errors.is_empty() {
        tracing::error!(
            "[{name}] install finished with {} error(s): {:?}",
            report.errors.len(),
            report.errors
        );
    } else {
        tracing::info!(
            "[{name}] install ok: installed={} updated={} pending_review={} name_taken={}",
            report.installed_count,
            report.updated_count,
            report.pending_user_review.len(),
            report.name_taken.len()
        );
    }
}

/// The startup task of both runtimes. Never fails; problems are logged.
pub async fn run(emitter: EventEmitter) {
    let ctx = SkillsCtx::user();
    let report = match tokio::task::spawn_blocking(move || run_blocking(&ctx)).await {
        Ok(report) => report,
        Err(err) => {
            tracing::error!("[Skills] startup task failed: {err}");
            return;
        }
    };
    log_pack("Experts", &report.experts);
    log_pack("Science", &report.science);
    if report.backups_moved + report.backups_kept > 0 {
        tracing::info!(
            "[Skills] older backups: {} moved to .user-backups, {} linked and left in place",
            report.backups_moved,
            report.backups_kept
        );
    }
    if !report.problems.is_empty() {
        tracing::warn!("[Skills] startup problems: {:?}", report.problems);
    }
    if report.changed {
        let agents: Vec<_> = SkillsCtx::user().agents.iter().map(|a| a.agent).collect();
        super::announce(&emitter, [ChangedKind::Store, ChangedKind::Backups], agents);
    }
}

/// The skills lock for restoring Codeg's backup at startup, waited for
/// longer than an operation would. Blocking.
pub fn lock_for_restore() -> Result<super::lock::SkillsGuard, super::lock::SkillsLockError> {
    super::lock::acquire_blocking_at(
        &super::lock::default_lock_path(),
        super::lock::RESTORE_LOCK_WAIT,
    )
}

/// After Codeg's backup replaced the store: the ownership of copies in the
/// agents' directories follows the record from before (now in the restore's
/// safety snapshot), removals and refreshed hashes included — never the
/// restored record's, which is as old as the backup. The links are rebuilt
/// from the disk by the reconcile at startup. Caller holds the skills lock.
pub fn absorb_record_after_restore(
    live_store: &Path,
    snapshot_store: &Path,
) -> std::io::Result<()> {
    let before = LinkRecord::load(snapshot_store);
    let mut live = LinkRecord::load(live_store);
    live.take_copies_from(&before);
    live.save(live_store)
}
