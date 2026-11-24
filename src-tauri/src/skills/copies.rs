//! Copies of a skill in an agent's directory, where no link could be made
//! (on Windows, a junction that failed).
//!
//! A copy is made, replaced and removed through a staging folder beside the
//! agent's skills directory — `<its parent>/.codeg-skills-staging/<op>/` —
//! on the same volume, so every move is a rename, and outside the skills
//! directory, so no agent ever lists it. Each operation writes an `op.json`
//! (its journal) before it moves anything; a start after a crash finishes or
//! undoes what an operation left ([`recover`]).
//!
//! - **Make**: copy into staging, check the copy against the store, then
//!   rename it into place — never over anything that is there.
//! - **Replace** (a skill update): stage the new copy, journal the hashes of
//!   the old copy and the new one, move the old one into staging, rename the
//!   new one in; the record's hash is updated after. The swap is done once
//!   the record holds the new hash (the commit point); until then a crash
//!   puts the old copy back — but only over the new copy Codeg made: a
//!   target that matches neither side (edited since) is kept, and so is the
//!   staged old copy, and the start reports both.
//! - **Remove**: move it into staging; it is deleted only once the record no
//!   longer lists it.
//!
//! When putting something back fails, nothing is deleted: the staging
//! folder, its journal and what it holds stay where they are, and the caller
//! reports their paths (`SkillsIssue::kept`). The next start puts them back.
//!
//! Only a copy that still matches its recorded hash is replaced or removed:
//! one changed on the agent's side is reported, and replaced only on
//! request, after a backup (`super::backups`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsio::{copy_tree, hash_skill_dir, op_id, remove_if_empty, rename};
use super::link::LinkMode;
use super::record::LinkRecord;
use super::SkillsCtx;

pub(crate) const AGENT_STAGING_DIR: &str = ".codeg-skills-staging";
const OP_FILE: &str = "op.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OpKind {
    Copy,
    Swap,
    Remove,
    /// `skills_adopt`: the agent's original waits here until the link is in.
    Adopt,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct OpFile {
    kind: OpKind,
    target: String,
    skill: String,
    /// `adopt`: where the link goes (`target` is the original's place).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    link: Option<String>,
    /// `swap`, `remove`: the hash of the copy that moves out (to `old`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    old_hash: Option<String>,
    /// `swap`: the hash of the copy that moves in. The swap is done once the
    /// record holds it for `target`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    new_hash: Option<String>,
}

/// A step that failed. `kept`: what stayed where it is because putting it
/// back failed too (the staged original, its operation's folder) — empty
/// when everything is back as it was.
#[derive(Debug)]
pub(crate) struct CopyFailure {
    pub error: io::Error,
    pub kept: Vec<PathBuf>,
}

impl CopyFailure {
    fn clean(error: io::Error) -> Self {
        Self {
            error,
            kept: Vec::new(),
        }
    }
}

impl std::fmt::Display for CopyFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.error)?;
        if !self.kept.is_empty() {
            let kept: Vec<String> = self.kept.iter().map(|p| p.display().to_string()).collect();
            write!(f, "; kept: {}", kept.join(", "))?;
        }
        Ok(())
    }
}

/// The staging root for an agent skills directory: beside it.
pub(crate) fn staging_root(agent_dir: &Path) -> PathBuf {
    match agent_dir.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.join(AGENT_STAGING_DIR),
        _ => agent_dir.join(AGENT_STAGING_DIR),
    }
}

fn write_journal(op: &Path, file: &OpFile) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(file).map_err(io::Error::other)?;
    super::fsio::write_private_atomic(&op.join(OP_FILE), &bytes)
}

fn start_op_with(file: OpFile) -> io::Result<PathBuf> {
    let target = PathBuf::from(&file.target);
    let dir = target
        .parent()
        .ok_or_else(|| io::Error::other("the entry has no directory"))?;
    let op = staging_root(dir).join(op_id());
    fs::create_dir_all(&op)?;
    if let Err(err) = write_journal(&op, &file) {
        finish_op(&op);
        return Err(err);
    }
    Ok(op)
}

fn start_op(target: &Path, skill: &str, kind: OpKind) -> io::Result<PathBuf> {
    start_op_with(OpFile {
        kind,
        target: target.to_string_lossy().into_owned(),
        skill: skill.to_string(),
        link: None,
        old_hash: None,
        new_hash: None,
    })
}

/// Staging for `skills_adopt`: the original at `original` moves to
/// `<op>/old` until the link at `link` is in place.
pub(crate) fn start_adopt(original: &Path, link: &Path, skill: &str) -> io::Result<PathBuf> {
    start_op_with(OpFile {
        kind: OpKind::Adopt,
        target: original.to_string_lossy().into_owned(),
        skill: skill.to_string(),
        link: Some(link.to_string_lossy().into_owned()),
        old_hash: None,
        new_hash: None,
    })
}

fn finish_op(op: &Path) {
    let _ = fs::remove_dir_all(op);
    if let Some(root) = op.parent() {
        remove_if_empty(root);
    }
}

/// A link attempt that failed may leave the empty folder it started from (a
/// Windows junction is made on a new directory): remove it when it is empty
/// and not a link — never anything with content.
pub(crate) fn clear_failed_link_leftover(path: &Path) {
    let empty_dir = fs::symlink_metadata(path)
        .map(|meta| meta.is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
        && fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
    if empty_dir {
        let _ = fs::remove_dir(path);
    }
}

/// Copy the store's `skill` (`source`) to `target`, which must not exist.
/// Returns the copy's hash.
pub(crate) fn create_copy(
    ctx: &SkillsCtx,
    source: &Path,
    target: &Path,
    skill: &str,
) -> io::Result<String> {
    let op = start_op(target, skill, OpKind::Copy)?;
    let result = (|| {
        let new = op.join("new");
        ctx.fault("copy")?;
        copy_tree(source, &new)?;
        let hash = hash_skill_dir(&new, skill)?;
        if hash != hash_skill_dir(source, skill)? {
            return Err(io::Error::other("the copy does not match the skill"));
        }
        if fs::symlink_metadata(target).is_ok() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!("{} already exists", target.display()),
            ));
        }
        ctx.fault("copy_rename")?;
        rename(&new, target)?;
        Ok(hash)
    })();
    finish_op(&op);
    result
}

/// A copy moved into staging, to be deleted on commit or put back on undo.
#[derive(Debug, Clone)]
pub(crate) struct StagedRemoval {
    pub op_dir: PathBuf,
    old: PathBuf,
    target: PathBuf,
}

pub(crate) fn stage_removal(
    ctx: &SkillsCtx,
    target: &Path,
    skill: &str,
) -> io::Result<StagedRemoval> {
    let op = start_op_with(OpFile {
        kind: OpKind::Remove,
        target: target.to_string_lossy().into_owned(),
        skill: skill.to_string(),
        link: None,
        old_hash: hash_skill_dir(target, skill).ok(),
        new_hash: None,
    })?;
    let old = op.join("old");
    let moved = ctx.fault("remove_copy").and_then(|()| rename(target, &old));
    if let Err(err) = moved {
        finish_op(&op);
        return Err(err);
    }
    Ok(StagedRemoval {
        op_dir: op,
        old,
        target: target.to_path_buf(),
    })
}

/// Put a staged removal back. When that fails the copy stays in staging,
/// journal and all, for the next start to put back.
pub(crate) fn unstage(ctx: &SkillsCtx, staged: StagedRemoval) -> Result<(), CopyFailure> {
    if let Err(error) = ctx
        .fault("unstage")
        .and_then(|()| rename(&staged.old, &staged.target))
    {
        return Err(CopyFailure {
            error,
            kept: vec![staged.old, staged.op_dir],
        });
    }
    finish_op(&staged.op_dir);
    Ok(())
}

/// A copy replaced by a new one; the old one waits in staging.
#[derive(Debug, Clone)]
pub(crate) struct StagedSwap {
    pub op_dir: PathBuf,
    pub new_hash: String,
    old: PathBuf,
    target: PathBuf,
}

/// Replace the copy at `target` with the store's `skill`. The old copy stays
/// in staging until [`commit`]; any failure on the way puts it back — and
/// when putting it back fails too, it stays in staging with its journal
/// (`CopyFailure::kept`), never deleted.
pub(crate) fn swap_in(
    ctx: &SkillsCtx,
    target: &Path,
    skill: &str,
) -> Result<StagedSwap, CopyFailure> {
    let source = ctx.skill_path(skill);
    let old_hash = hash_skill_dir(target, skill).map_err(CopyFailure::clean)?;
    let op = start_op(target, skill, OpKind::Swap).map_err(CopyFailure::clean)?;
    let new = op.join("new");
    let old = op.join("old");
    let prepared = (|| {
        copy_tree(&source, &new)?;
        let hash = hash_skill_dir(&new, skill)?;
        if hash != hash_skill_dir(&source, skill)? {
            return Err(io::Error::other("the new copy does not match the skill"));
        }
        // The journal knows both sides before anything moves.
        write_journal(
            &op,
            &OpFile {
                kind: OpKind::Swap,
                target: target.to_string_lossy().into_owned(),
                skill: skill.to_string(),
                link: None,
                old_hash: Some(old_hash.clone()),
                new_hash: Some(hash.clone()),
            },
        )?;
        Ok(hash)
    })();
    let new_hash = match prepared {
        Ok(hash) => hash,
        Err(err) => {
            finish_op(&op);
            return Err(CopyFailure::clean(err));
        }
    };
    if let Err(err) = ctx.fault("swap_out").and_then(|()| rename(target, &old)) {
        finish_op(&op);
        return Err(CopyFailure::clean(err));
    }
    if let Err(err) = ctx.fault("swap_in").and_then(|()| rename(&new, target)) {
        // The old copy goes back where it was.
        let restored = ctx
            .fault("swap_restore")
            .and_then(|()| rename(&old, target));
        return match restored {
            Ok(()) => {
                finish_op(&op);
                Err(CopyFailure::clean(err))
            }
            Err(restore_err) => Err(CopyFailure {
                error: io::Error::other(format!(
                    "{err}; putting the old copy back failed too ({restore_err})"
                )),
                kept: vec![old, op],
            }),
        };
    }
    Ok(StagedSwap {
        op_dir: op,
        new_hash,
        old,
        target: target.to_path_buf(),
    })
}

/// Undo a swap: the old copy back in place. When that fails, the old copy
/// stays in staging with its journal.
pub(crate) fn unswap(ctx: &SkillsCtx, staged: StagedSwap) -> Result<(), CopyFailure> {
    let aside = staged.op_dir.join("undone");
    let kept = || vec![staged.old.clone(), staged.op_dir.clone()];
    if let Err(error) = ctx
        .fault("unswap")
        .and_then(|()| rename(&staged.target, &aside))
    {
        return Err(CopyFailure {
            error,
            kept: kept(),
        });
    }
    if let Err(error) = rename(&staged.old, &staged.target) {
        let _ = rename(&aside, &staged.target);
        return Err(CopyFailure {
            error,
            kept: kept(),
        });
    }
    finish_op(&staged.op_dir);
    Ok(())
}

/// Drop what an operation left in staging, once it is done for good.
pub(crate) fn commit(op_dir: &Path) {
    finish_op(op_dir);
}

/// After a crash: finish or undo what unfinished operations left, then clear
/// every agent-side staging folder — except an operation whose leftovers
/// cannot be settled safely, which stays (journal and all) and is reported.
/// Caller holds the skills lock, so no other Codeg is in the middle of one.
pub(crate) fn recover(ctx: &SkillsCtx, record: &LinkRecord) -> Vec<String> {
    let mut problems = Vec::new();
    let mut roots: Vec<PathBuf> = ctx.all_dirs().iter().map(|d| staging_root(d)).collect();
    roots.sort();
    roots.dedup();
    for root in roots {
        let Ok(ops) = fs::read_dir(&root) else {
            continue;
        };
        for op in ops.flatten() {
            let op = op.path();
            if let Err(err) = recover_op(ctx, &op, record) {
                problems.push(format!("{}: {err}", op.display()));
                continue;
            }
            finish_op(&op);
        }
        remove_if_empty(&root);
    }
    problems
}

fn recover_op(ctx: &SkillsCtx, op: &Path, record: &LinkRecord) -> io::Result<()> {
    let old = op.join("old");
    if fs::symlink_metadata(&old).is_err() {
        // Nothing was moved aside: what is left is Codeg's own scratch.
        return Ok(());
    }
    let file = fs::read(op.join(OP_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<OpFile>(&bytes).ok());
    let Some(file) = file else {
        // Something was moved aside, and where it came from cannot be read.
        return Err(io::Error::other(format!(
            "its journal cannot be read; {} stays",
            old.display()
        )));
    };
    let target = PathBuf::from(&file.target);
    let target_absent = fs::symlink_metadata(&target).is_err();
    let recorded = record
        .get(&target)
        .filter(|entry| entry.mode == LinkMode::Copy);
    let keep = |why: &str| {
        Err(io::Error::other(format!(
            "{why}; {} stays as it is and the earlier copy stays in {}",
            target.display(),
            old.display()
        )))
    };
    if record.problem.is_some() && matches!(file.kind, OpKind::Remove | OpKind::Swap) {
        // Whether it was done is in the record, which cannot be read.
        return keep("the link record cannot be read");
    }
    match file.kind {
        OpKind::Copy => Ok(()),
        OpKind::Adopt => {
            // Done once the link leads into the store; otherwise the original
            // goes back.
            let linked = file.link.as_deref().is_some_and(|link| {
                match super::link::inspect(Path::new(link)) {
                    super::link::RawEntry::Link {
                        resolved: Some(real),
                        ..
                    } => super::StorePaths::of(&ctx.store).child_of(&real).is_some(),
                    super::link::RawEntry::Dir => record.get(Path::new(link)).is_some(),
                    _ => false,
                }
            });
            if linked {
                Ok(())
            } else if target_absent {
                rename(&old, &target)
            } else {
                // Never over something: the original waits in staging.
                Err(io::Error::other(format!(
                    "{} is taken; the original stays in {}",
                    target.display(),
                    old.display()
                )))
            }
        }
        // The record still lists the copy: the removal never finished.
        OpKind::Remove if recorded.is_some() => {
            if target_absent {
                rename(&old, &target)
            } else {
                keep("something new is where the removed copy was")
            }
        }
        // The record let go of it: the removal is done.
        OpKind::Remove => Ok(()),
        OpKind::Swap => {
            // The commit point: the record holds the new copy's hash.
            let committed = file.new_hash.is_some()
                && recorded.and_then(|entry| entry.copy_hash.as_deref())
                    == file.new_hash.as_deref();
            if committed {
                return Ok(());
            }
            if target_absent {
                return rename(&old, &target);
            }
            let current = hash_skill_dir(&target, &file.skill).ok();
            if current.is_some() && current == file.new_hash {
                // Codeg's new copy, not recorded yet: the old one goes back.
                let aside = op.join("undone");
                rename(&target, &aside)?;
                if let Err(err) = rename(&old, &target) {
                    let _ = rename(&aside, &target);
                    return Err(err);
                }
                Ok(())
            } else if current.is_some() && current == file.old_hash {
                // The old copy is in place already; the staged one is the same.
                Ok(())
            } else {
                // Changed since (or unknown): neither side is Codeg's to drop.
                keep("the copy matches neither the copy that was replaced nor its replacement")
            }
        }
    }
}
