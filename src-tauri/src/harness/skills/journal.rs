//! Putting a skill into Codeg's store — or taking it out — together with its
//! manifest entry, so that a failure or a crash at any point leaves the
//! folder and the manifest agreeing (plan §7.3 step 6).
//!
//! An operation lives in `~/.codeg/skills/.codeg-staging/<op>/`:
//!
//! 1. **Stage**: the new content, complete and flushed to disk, in `new/`.
//! 2. **Journal**: `op.json` (written atomically) — the action, the install
//!    name, the manifest entry before and after, whether a folder was there
//!    before, the new content's hash, and whether the old folder is to be
//!    kept as a backup.
//! 3. **Swap**: the folder in the store (if any) to `old/`, then `new/` to
//!    the store. An uninstall only moves the folder out.
//! 4. **Commit**: the manifest written with the new entry (or without the
//!    old). This is the point of no return.
//! 5. **Finish**: `old/` deleted only when what it holds is exactly what was
//!    installed (checked then, from its contents: an edit made while the
//!    operation ran counts); anything else — a file changed or added, one
//!    that cannot be read — is moved to `.user-backups/<name>/<time>/`. Then
//!    the operation's folder is removed.
//!
//! A failure before the commit **rolls back**: the new folder taken out
//! (only if it is the one this operation put there, by its hash), the old
//! one moved back, the manifest left as it was. A failure after it only
//! leaves cleaning to do. Either way, if Codeg dies midway, the next start
//! finds the journal ([`recover_journals`], run by the skills engine's
//! startup under the skills lock before it clears staging without a
//! journal) and does the same from what is on disk: the manifest holding
//! the new entry means **finish**, holding the old one means **roll back**.
//! A journal whose world is gone — the store restored from a backup — is
//! dropped; nothing it would have moved back is deleted (an old folder that
//! cannot go back is kept among the backups).
//!
//! Everything here runs under the skills lock, so a desktop app and a
//! codeg-server sharing the store never clear each other's staging.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::skills::fsio::{create_dir_all_durable, flush_dir, hash_skill_dir, op_id, rename};
use crate::skills::provenance::STAGING_DIR;
use crate::skills::SkillsCtx;

use super::manifest::{self, ManifestEntry};
use super::package::PackageFile;

pub(crate) const JOURNAL: &str = "op.json";
/// Marks a journal as this step's (the store's staging holds no other with
/// an `op.json`, but a newer Codeg might).
const KIND: &str = "harness_skill";
const FORMAT: u64 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Action {
    Install,
    Update,
    Uninstall,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Journal {
    pub kind: String,
    pub format: u64,
    pub op: String,
    pub action: Action,
    pub name: String,
    pub item_id: String,
    pub before: Option<ManifestEntry>,
    pub after: Option<ManifestEntry>,
    /// The store had a folder under the name when the operation began.
    pub had_old: bool,
    /// The hash of the new content (`hash_skill_dir`, under the name).
    pub new_hash: Option<String>,
    /// The old folder goes to the backups instead of being deleted, whatever
    /// it holds at the end (it held changes when the operation began).
    /// Without it, the finish decides from what the folder holds then.
    pub keep_old: bool,
    pub created_at: String,
}

/// An operation on one install name. Caller holds the skills lock for its
/// whole life.
pub(crate) struct Tx<'c> {
    ctx: &'c SkillsCtx,
    pub dir: PathBuf,
    pub journal: Journal,
}

/// What putting back left where it is.
#[derive(Debug)]
pub(crate) struct RollbackFailure {
    pub error: io::Error,
    pub kept: Vec<PathBuf>,
}

/// How an operation's manifest stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stand {
    /// The new entry is in: finish.
    Committed,
    /// The old entry is still in: roll back.
    Before,
    /// Neither (the store was restored, or edited): drop the journal.
    Foreign,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Write one file of the package, flushed to disk, with its mode.
fn write_file(root: &Path, file: &PackageFile) -> io::Result<()> {
    let path = root.join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut handle = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    handle.write_all(&file.bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = if file.executable { 0o755 } else { 0o644 };
        handle.set_permissions(fs::Permissions::from_mode(mode))?;
    }
    handle.sync_all()
}

fn flush_tree(root: &Path) -> io::Result<()> {
    let mut dirs = vec![root.to_path_buf()];
    let mut i = 0;
    while i < dirs.len() {
        for entry in fs::read_dir(&dirs[i])? {
            let entry = entry?;
            if entry.file_type()?.is_dir() {
                dirs.push(entry.path());
            }
        }
        i += 1;
    }
    // Deepest first, so each folder's entries are down before it.
    for dir in dirs.iter().rev() {
        flush_dir(dir)?;
    }
    Ok(())
}

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

fn remove_tree(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
        Ok(meta) if meta.is_dir() && !meta.file_type().is_symlink() => fs::remove_dir_all(path),
        Ok(_) => fs::remove_file(path),
    }
}

impl<'c> Tx<'c> {
    /// A fresh operation folder for `journal` (its `op` is set here).
    pub fn begin(ctx: &'c SkillsCtx, mut journal: Journal) -> io::Result<Self> {
        let op = op_id();
        let dir = ctx.store.join(STAGING_DIR).join(&op);
        create_dir_all_durable(&dir)?;
        journal.op = op;
        Ok(Self { ctx, dir, journal })
    }

    /// The operation `begin` started, picked up again (by the next step
    /// under the same lock).
    pub fn resume(ctx: &'c SkillsCtx, dir: PathBuf, journal: Journal) -> Self {
        Self { ctx, dir, journal }
    }

    pub fn into_parts(self) -> (PathBuf, Journal) {
        (self.dir, self.journal)
    }

    pub fn live(&self) -> PathBuf {
        self.ctx.skill_path(&self.journal.name)
    }

    fn new_dir(&self) -> PathBuf {
        self.dir.join("new")
    }

    pub fn old_dir(&self) -> PathBuf {
        self.dir.join("old")
    }

    /// Step 1: the new content in `new/`, on disk. Returns its hash.
    pub fn stage(&self, files: &[PackageFile]) -> io::Result<String> {
        let new = self.new_dir();
        fs::create_dir_all(&new)?;
        for file in files {
            write_file(&new, file)?;
        }
        flush_tree(&new)?;
        self.ctx.fault("harness_stage")?;
        hash_skill_dir(&new, &self.journal.name)
    }

    /// Step 2: the journal, atomically.
    pub fn write_journal(&self) -> io::Result<()> {
        self.ctx.fault("harness_journal")?;
        let bytes = serde_json::to_vec_pretty(&self.journal).map_err(io::Error::other)?;
        crate::skills::fsio::write_private_atomic(&self.dir.join(JOURNAL), &bytes)
    }

    /// Step 3: the old folder out, the new one in (an uninstall: only out).
    pub fn swap(&self) -> io::Result<()> {
        let live = self.live();
        if exists(&live) {
            self.ctx.fault("harness_swap_out")?;
            rename(&live, &self.old_dir())?;
        }
        if self.journal.action != Action::Uninstall {
            self.ctx.fault("harness_swap_in")?;
            rename(&self.new_dir(), &live)?;
        }
        if let Some(parent) = live.parent() {
            let _ = flush_dir(parent);
        }
        Ok(())
    }

    /// Step 4: the manifest with the new entry (or without the old one).
    pub fn commit(&self) -> io::Result<()> {
        self.ctx.fault("harness_commit")?;
        let mut current = manifest::load_for_write(&self.ctx.store)
            .map_err(|error| io::Error::other(error.detail()))?;
        match &self.journal.after {
            Some(entry) => {
                current
                    .skills
                    .insert(self.journal.name.clone(), entry.clone());
            }
            None => {
                current.skills.remove(&self.journal.name);
            }
        }
        manifest::save(&self.ctx.store, &current)
    }

    /// Step 5: the old folder deleted or kept among the backups, then the
    /// operation's folder removed. Returns where a kept folder went. On
    /// failure the journal stays and the next start finishes the job.
    pub fn finish(&self) -> io::Result<Option<PathBuf>> {
        finish(self.ctx, &self.dir, &self.journal)
    }

    /// Put things back as they were before the swap. Nothing is deleted
    /// that is not this operation's own; on failure everything stays where
    /// it is (`kept`), journal included, for the next start.
    pub fn rollback(&self) -> Result<(), RollbackFailure> {
        rollback(self.ctx, &self.dir, &self.journal)
    }

    /// Remove the operation's folder when nothing was moved yet (a failure
    /// while staging or journaling).
    pub fn discard(&self) {
        let _ = fs::remove_dir_all(&self.dir);
        crate::skills::fsio::remove_if_empty(&self.ctx.store.join(STAGING_DIR));
    }
}

pub(crate) fn new_journal(
    action: Action,
    name: &str,
    item_id: &str,
    before: Option<ManifestEntry>,
    after: Option<ManifestEntry>,
    had_old: bool,
    keep_old: bool,
) -> Journal {
    Journal {
        kind: KIND.to_string(),
        format: FORMAT,
        op: String::new(),
        action,
        name: name.to_string(),
        item_id: item_id.to_string(),
        before,
        after,
        had_old,
        new_hash: None,
        keep_old,
        created_at: now(),
    }
}

fn finish(ctx: &SkillsCtx, dir: &Path, journal: &Journal) -> io::Result<Option<PathBuf>> {
    let old = dir.join("old");
    let mut kept = None;
    if exists(&old) {
        ctx.fault("harness_cleanup")?;
        // Decided now, from what `old/` holds, not from what the folder held
        // when the operation began: an editor or an agent may have changed it
        // since (they take no lock), up to the moment it was swapped out.
        if journal.keep_old || holds_changes(&old, journal) {
            kept = Some(crate::skills::backups::move_into_backups(
                ctx,
                &old,
                &journal.name,
            )?);
        } else {
            remove_tree(&old)?;
        }
    }
    fs::remove_dir_all(dir)?;
    crate::skills::fsio::remove_if_empty(&ctx.store.join(STAGING_DIR));
    Ok(kept)
}

/// Whether the folder an operation took out of the store (`old`) holds
/// anything that is not exactly what was installed: a file changed or added
/// (by SHA-256, through the skills engine's ignore table), anything that
/// cannot be read or compared, or no record of what was installed. Only a
/// folder found unchanged may be deleted; anything else is kept.
fn holds_changes(old: &Path, journal: &Journal) -> bool {
    let Some(before) = &journal.before else {
        return true;
    };
    if !fs::symlink_metadata(old).is_ok_and(|meta| meta.is_dir()) {
        return true;
    }
    match super::file_changes(old, before) {
        Ok(changes) => !changes.changed.is_empty() || !changes.added.is_empty(),
        Err(_) => true,
    }
}

fn rollback(ctx: &SkillsCtx, dir: &Path, journal: &Journal) -> Result<(), RollbackFailure> {
    let live = ctx.skill_path(&journal.name);
    let old = dir.join("old");
    let new = dir.join("new");
    let discard = dir.join("discard");
    let failed = |error: io::Error| RollbackFailure {
        error,
        kept: [&old, dir]
            .into_iter()
            .filter(|path| exists(path))
            .map(|path| path.to_path_buf())
            .collect(),
    };
    ctx.fault("harness_rollback").map_err(failed)?;
    // The new folder is in the store when `new/` is gone and what is there
    // is exactly what was staged.
    let new_is_in = !exists(&new)
        && journal.action != Action::Uninstall
        && journal.new_hash.as_deref().is_some_and(|hash| {
            fs::symlink_metadata(&live).is_ok_and(|meta| meta.is_dir())
                && hash_skill_dir(&live, &journal.name).ok().as_deref() == Some(hash)
        });
    if exists(&old) {
        if exists(&live) {
            if !new_is_in {
                // Someone else's folder is there now: it stays, and the old
                // one is kept among the backups rather than lost.
                crate::skills::backups::move_into_backups(ctx, &old, &journal.name)
                    .map_err(failed)?;
                fs::remove_dir_all(dir).map_err(failed)?;
                return Ok(());
            }
            remove_tree(&discard).map_err(failed)?;
            rename(&live, &discard).map_err(failed)?;
        }
        rename(&old, &live).map_err(failed)?;
    } else if new_is_in && !journal.had_old {
        // A first install (or one over a folder that was gone): only the new
        // folder to take out.
        remove_tree(&discard).map_err(failed)?;
        rename(&live, &discard).map_err(failed)?;
    }
    fs::remove_dir_all(dir).map_err(failed)?;
    crate::skills::fsio::remove_if_empty(&ctx.store.join(STAGING_DIR));
    Ok(())
}

fn stand(journal: &Journal, current: Option<&ManifestEntry>) -> Stand {
    let op_of = |entry: Option<&ManifestEntry>| entry.map(|entry| entry.op.clone());
    match journal.action {
        Action::Install | Action::Update => {
            if current.is_some_and(|entry| entry.op == journal.op) {
                Stand::Committed
            } else if op_of(current) == op_of(journal.before.as_ref()) {
                Stand::Before
            } else {
                Stand::Foreign
            }
        }
        Action::Uninstall => match current {
            None => Stand::Committed,
            Some(entry) if Some(&entry.op) == journal.before.as_ref().map(|b| &b.op) => {
                Stand::Before
            }
            Some(_) => Stand::Foreign,
        },
    }
}

/// What the startup recovery did.
#[derive(Debug, Default)]
pub struct RecoveryReport {
    pub finished: usize,
    pub rolled_back: usize,
    pub dropped: usize,
    /// Something in the store changed (a folder moved back, taken out, or
    /// kept as a backup).
    pub changed: bool,
    pub problems: Vec<String>,
}

/// Finish or roll back every journal in the store's staging (see the
/// module docs). Caller holds the skills lock; the engine's startup runs
/// this before it clears staging that has no journal.
pub fn recover_journals(ctx: &SkillsCtx) -> RecoveryReport {
    let mut report = RecoveryReport::default();
    let root = ctx.store.join(STAGING_DIR);
    let Ok(entries) = fs::read_dir(&root) else {
        return report;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let journal_path = dir.join(JOURNAL);
        if !journal_path.is_file() {
            continue;
        }
        let journal = match fs::read(&journal_path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| serde_json::from_slice::<Journal>(&bytes).map_err(|e| e.to_string()))
        {
            Ok(journal) if journal.kind == KIND && journal.format <= FORMAT => journal,
            Ok(_) => {
                report.problems.push(format!(
                    "{}: a journal this Codeg does not know; left as it is",
                    dir.display()
                ));
                continue;
            }
            Err(error) => {
                report.problems.push(format!(
                    "{}: the journal cannot be read ({error}); left as it is",
                    dir.display()
                ));
                continue;
            }
        };
        if journal.op != entry.file_name().to_string_lossy() || !valid_name(&journal.name) {
            report.problems.push(format!(
                "{}: the journal does not belong to this folder; left as it is",
                dir.display()
            ));
            continue;
        }
        let current = match manifest::load(&ctx.store) {
            Ok(manifest) => manifest.skills.get(&journal.name).cloned(),
            Err(error) => {
                report.problems.push(format!(
                    "{}: the Harness manifest cannot be read ({}); the journal waits",
                    dir.display(),
                    error.detail()
                ));
                continue;
            }
        };
        match stand(&journal, current.as_ref()) {
            Stand::Committed => match finish(ctx, &dir, &journal) {
                Ok(kept) => {
                    report.finished += 1;
                    report.changed |= kept.is_some();
                }
                Err(error) => report
                    .problems
                    .push(format!("{}: finishing failed ({error})", dir.display())),
            },
            Stand::Before => match rollback(ctx, &dir, &journal) {
                Ok(()) => {
                    report.rolled_back += 1;
                    report.changed = true;
                }
                Err(failure) => report.problems.push(format!(
                    "{}: rolling back failed ({}); kept: {:?}",
                    dir.display(),
                    failure.error,
                    failure.kept
                )),
            },
            Stand::Foreign => {
                let old = dir.join("old");
                let kept = if exists(&old) {
                    match crate::skills::backups::move_into_backups(ctx, &old, &journal.name) {
                        Ok(path) => Some(path),
                        Err(error) => {
                            report.problems.push(format!(
                                "{}: the manifest is not the one this operation knew, and its old folder could not be kept ({error}); left as it is",
                                dir.display()
                            ));
                            continue;
                        }
                    }
                } else {
                    None
                };
                match fs::remove_dir_all(&dir) {
                    Ok(()) => {
                        report.dropped += 1;
                        report.changed |= kept.is_some();
                        if let Some(path) = kept {
                            report.problems.push(format!(
                                "{}: the manifest is not the one this operation knew (a restored backup?); its old folder was kept in {}",
                                dir.display(),
                                path.display()
                            ));
                        }
                    }
                    Err(error) => report.problems.push(format!("{}: {error}", dir.display())),
                }
            }
        }
    }
    crate::skills::fsio::remove_if_empty(&root);
    report
}

/// An install name as the journal must give it to be acted on.
fn valid_name(name: &str) -> bool {
    super::names::is_valid(name)
}
