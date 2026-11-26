//! What runs once at startup, in the background, each step under the skills
//! lock: putting back what a crash left half-moved, moving an older
//! release's backups out of the way, claiming the Office skills for Office's
//! new manifest, extracting the bundled Experts and Science skills, and
//! bringing the link record in line with the disk.
//!
//! First of all, under the plugins lock and then the skills lock (the order
//! every plugin operation takes them in), the Harness plugins' journals are
//! finished or rolled back (`harness::plugins::journal::recover`, which
//! never runs a host command) — before the skills journals, among them those
//! of the plugins' own skill stores.
//!
//! Restoring Codeg's backup over the store happens earlier, before anything
//! else runs (`commands::backup::restore`); it takes the same lock and hands
//! the record from before the restore to [`absorb_record_after_restore`]:
//! which folders in the agents' directories are Codeg's copies follows that
//! record (the restore did not bring those directories back), and the links
//! are rebuilt from the disk when the record is reconciled here.

use std::path::Path;

use crate::web::event_bridge::EventEmitter;

use crate::harness::plugins::PluginsCtx;

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
    /// The plugins' journals: `None` when the plugins lock could not be had
    /// (the next start tries again; a problem says so).
    pub plugins: Option<crate::harness::plugins::journal::RecoveryReport>,
    /// The order the recoveries ran in.
    #[cfg(test)]
    pub order: Vec<&'static str>,
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
    #[cfg(test)]
    report.order.push("skills");
    // The agent-side copy operations of Codeg's store and of every plugin's
    // own store share one staging: their records are read together.
    let record = super::owned::record_with_owned_copies(ctx);
    report.problems.extend(super::copies::recover(ctx, &record));
    // Harness's journals (`op.json`) first: finished or rolled back before
    // the staging without one is cleared — in Codeg's store and in each
    // plugin's own.
    let harness = crate::harness::skills::recover_journals(ctx);
    if harness.changed {
        report.changed = true;
    }
    report.problems.extend(harness.problems);
    report.problems.extend(clear_store_staging(ctx));
    for plugin in super::owned::plugin_stores(ctx) {
        let owned = ctx.over_plugin_store(&plugin);
        let harness = crate::harness::skills::recover_journals(&owned);
        if harness.changed {
            report.changed = true;
        }
        report.problems.extend(harness.problems);
        report.problems.extend(clear_store_staging(&owned));
    }
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

/// A backup restore's mark (`journal::RESTORED_MARK`; the rollbacks just
/// run marked their agents as restored with it): it goes once none of its
/// operations is left.
fn restored_again(plugins: &PluginsCtx, problems: &mut Vec<String>) {
    if let Err(err) = crate::harness::plugins::journal::clear_restored_mark(plugins) {
        problems.push(format!("plugins restore mark: {err}"));
    }
}

/// Everything above, blocking, over Codeg's skill store `ctx` and the
/// plugin store `plugins`.
pub(crate) fn run_blocking(ctx: &SkillsCtx, plugins: &PluginsCtx) -> StartupReport {
    let mut report = StartupReport::default();
    let mut ctx = ctx.clone();
    ctx.lock_wait = STARTUP_LOCK_WAIT;
    let mut plugins = plugins.clone();
    plugins.lock_wait = STARTUP_LOCK_WAIT;
    // Plugins → skills, as every plugin operation takes them. Without the
    // plugins lock the skills are still seen to (no plugin journal is
    // touched).
    let plugins_guard = match plugins.lock_blocking() {
        Ok(guard) => Some(guard),
        Err(err) => {
            report
                .problems
                .push(format!("plugin journals skipped: {err}"));
            None
        }
    };
    match ctx.lock_blocking() {
        Ok(_guard) => {
            if let Some(guard) = &plugins_guard {
                #[cfg(test)]
                report.order.push("plugins");
                let recovered = crate::harness::plugins::journal::recover(&plugins, guard);
                report.problems.extend(recovered.problems.iter().cloned());
                restored_again(&plugins, &mut report.problems);
                report.plugins = Some(recovered);
            }
            maintenance(&ctx, &mut report);
        }
        Err(err) => report.problems.push(format!("maintenance skipped: {err}")),
    }
    drop(plugins_guard);
    report.experts = crate::commands::experts::install_in(&ctx);
    report.science = crate::commands::science::install_in(&ctx);
    if report.experts.installed_count + report.experts.updated_count > 0
        || report.science.installed_count + report.science.updated_count > 0
    {
        report.changed = true;
    }
    match ctx.lock_blocking() {
        Ok(_guard) => {
            let mut stores = vec![ctx.clone()];
            stores.extend(
                super::owned::plugin_stores(&ctx)
                    .into_iter()
                    .map(|plugin| ctx.over_plugin_store(&plugin)),
            );
            for store in stores {
                let mut record = LinkRecord::load(&store.store);
                if reconcile(&store, &mut record) {
                    if let Err(err) = record.save(&store.store) {
                        report.problems.push(format!("link record: {err}"));
                    }
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
    let plugins = PluginsCtx::user();
    let report = match tokio::task::spawn_blocking(move || run_blocking(&ctx, &plugins)).await {
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
    if let Some(plugins) = &report.plugins {
        if plugins.finished + plugins.rolled_back > 0 {
            tracing::info!(
                "[Harness plugins] startup: {} operation(s) finished, {} rolled back, needing repair: {:?}",
                plugins.finished,
                plugins.rolled_back,
                plugins.needs_repair
            );
            crate::web::event_bridge::emit_event(
                &emitter,
                crate::harness::mcp::model::INSTALLED_CHANGED_EVENT,
                crate::harness::skills::SkillsInstalledChanged {
                    item_ids: Vec::new(),
                    agents: Vec::new(),
                },
            );
            crate::harness::updates::records_changed();
        }
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
