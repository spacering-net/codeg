//! Backups of skills the user had changed: `~/.codeg/skills/.user-backups/<id>/<time>/`
//! for a pack's (or Harness's) skill set aside before an update, and
//! `<time>-<agent>/` for an agent's changed copy replaced on request.
//!
//! A plugin's own skills (`super::owned`) keep theirs here too, under the
//! skill's name: Codeg's store is the one place backups are listed from.
//!
//! Dot-prefixed, so never listed as a skill (an older release kept them
//! beside the skills as `<id>.user-backup-<time>`, where they showed up as
//! Custom skills); not `.codeg-`, so Codeg's backup still takes them. The
//! old ones move here at startup — except those linked into an agent's
//! directory, which stay where they are and are listed as backups.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use crate::models::agent::AgentType;

use super::fsio::{
    copy_tree, copy_tree_durable, hash_skill_dir, move_dir, op_id, remove_if_empty, rename,
};
use super::model::{
    codes, BackupKind, BackupOutcome, SkillBackup, SkillsBackupResult, SkillsBackups, SkillsIssue,
};
use super::provenance::{legacy_backup_name, STAGING_DIR, USER_BACKUPS_DIR};
use super::world::World;
use super::SkillsCtx;

pub(crate) fn backups_root(store: &Path) -> PathBuf {
    store.join(USER_BACKUPS_DIR)
}

fn stamp() -> String {
    chrono::Utc::now().format("%Y%m%d-%H%M%S%.3f").to_string()
}

/// A fresh backup folder for `id`, named after now (and `suffix`).
fn fresh_dir(store: &Path, id: &str, suffix: Option<&str>) -> PathBuf {
    let root = backups_root(store).join(id);
    loop {
        let name = match suffix {
            Some(suffix) => format!("{}-{suffix}", stamp()),
            None => stamp(),
        };
        let path = root.join(&name);
        if fs::symlink_metadata(&path).is_err() {
            return path;
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

/// Move the store's copy of `id` (a changed pack skill) into its backups.
/// Same volume: a rename. Returns where it went.
pub(crate) fn set_aside(ctx: &SkillsCtx, id: &str) -> io::Result<PathBuf> {
    let from = ctx.skill_path(id);
    let to = fresh_dir(&ctx.main_store(), id, None);
    move_dir(&from, &to, id)?;
    Ok(to)
}

/// Move `from` (a skill the user had changed, taken out of the store by an
/// update or an uninstall — Harness's) into the backups of `id`, under a
/// fresh `<time>` name. Same volume: a rename. Returns where it went.
pub(crate) fn move_into_backups(ctx: &SkillsCtx, from: &Path, id: &str) -> io::Result<PathBuf> {
    let to = fresh_dir(&ctx.main_store(), id, None);
    move_dir(from, &to, id)?;
    Ok(to)
}

/// Copy `from` (an agent's changed copy) into the backups of `id`, flushed
/// to disk and checked against the original — the original is replaced
/// right after. The original stays.
pub(crate) fn copy_into_backups(
    ctx: &SkillsCtx,
    from: &Path,
    id: &str,
    agent_label: Option<&str>,
) -> io::Result<PathBuf> {
    let to = fresh_dir(&ctx.main_store(), id, agent_label);
    // Every folder it creates on the way (`.user-backups`, `<id>`) is
    // flushed into its parent too.
    copy_tree_durable(from, &to)?;
    if hash_skill_dir(from, id)? != hash_skill_dir(&to, id)? {
        let _ = fs::remove_dir_all(&to);
        return Err(io::Error::other("the backup does not match the copy"));
    }
    Ok(to)
}

/// Drop an empty backups folder of `id`.
pub(crate) fn tidy(ctx: &SkillsCtx, id: &str) {
    let store = ctx.main_store();
    let dir = backups_root(&store).join(id);
    remove_if_empty(&dir);
    remove_if_empty(&backups_root(&store));
}

/// `<YYYYMMDD-HHMMSS>[.mmm][-<agent>]` → (RFC 3339 time, agent).
fn parse_name(name: &str) -> (Option<String>, Option<String>) {
    let bytes = name.as_bytes();
    if bytes.len() < 15
        || bytes[8] != b'-'
        || !bytes[..15]
            .iter()
            .enumerate()
            .all(|(i, b)| i == 8 || b.is_ascii_digit())
    {
        return (None, None);
    }
    let mut rest = &name[15..];
    let mut millis = "000";
    if rest.len() >= 4
        && rest.starts_with('.')
        && rest.as_bytes()[1..4].iter().all(u8::is_ascii_digit)
    {
        millis = &rest[1..4];
        rest = &rest[4..];
    }
    let created = chrono::NaiveDateTime::parse_from_str(&name[..15], "%Y%m%d-%H%M%S")
        .ok()
        .map(|time| format!("{}.{millis}Z", time.and_utc().format("%Y-%m-%dT%H:%M:%S")));
    let agent = rest
        .strip_prefix('-')
        .filter(|agent| !agent.is_empty())
        .map(str::to_string);
    (created, agent)
}

/// The agents that see the store entry `name` through a link of Codeg's.
fn linked_by(world: &World, name: &str) -> Vec<AgentType> {
    world.seen_by(name)
}

pub(crate) fn list(ctx: &SkillsCtx, only: Option<&str>) -> SkillsBackups {
    let world = World::load(ctx);
    let mut backups = Vec::new();
    let mut problems = Vec::new();
    let root = backups_root(&ctx.store);
    match fs::read_dir(&root) {
        Ok(skills) => {
            for skill in skills.flatten() {
                let id = skill.file_name().to_string_lossy().into_owned();
                if only.is_some_and(|only| only != id) || !real_dir(&skill.path()) {
                    continue;
                }
                let Ok(entries) = fs::read_dir(skill.path()) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if name.starts_with('.') || !real_dir(&entry.path()) {
                        continue;
                    }
                    let (created_at, agent) = parse_name(&name);
                    backups.push(SkillBackup {
                        skill: id.clone(),
                        kind: if agent.is_some() {
                            BackupKind::Copy
                        } else {
                            BackupKind::Update
                        },
                        path: entry.path().to_string_lossy().into_owned(),
                        name,
                        created_at,
                        agent,
                        linked_by: Vec::new(),
                    });
                }
            }
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => {}
        Err(err) => problems.push(
            SkillsIssue::new(codes::IO_ERROR)
                .path(&root)
                .detail(err.to_string()),
        ),
    }
    for name in super::fsio::child_names(&ctx.store) {
        let Some((id, time)) = legacy_backup_name(&name) else {
            continue;
        };
        if only.is_some_and(|only| only != id) {
            continue;
        }
        let path = ctx.store.join(&name);
        if !real_dir(&path) {
            continue;
        }
        let (created_at, _) = parse_name(&time);
        backups.push(SkillBackup {
            skill: id,
            name: time,
            path: path.to_string_lossy().into_owned(),
            kind: BackupKind::Legacy,
            created_at,
            agent: None,
            linked_by: linked_by(&world, &name),
        });
    }
    // By skill; the newest first.
    backups.sort_by(|a, b| a.skill.cmp(&b.skill).then_with(|| b.name.cmp(&a.name)));
    SkillsBackups { backups, problems }
}

/// How many backups each skill has.
pub(crate) fn counts(ctx: &SkillsCtx) -> BTreeMap<String, usize> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    let root = backups_root(&ctx.store);
    for id in super::fsio::child_names(&root) {
        let dir = root.join(&id);
        if !real_dir(&dir) {
            continue;
        }
        let n = super::fsio::child_names(&dir)
            .into_iter()
            .filter(|name| !name.starts_with('.') && real_dir(&dir.join(name)))
            .count();
        if n > 0 {
            *out.entry(id).or_default() += n;
        }
    }
    for name in super::fsio::child_names(&ctx.store) {
        if let Some((id, _)) = legacy_backup_name(&name) {
            if real_dir(&ctx.store.join(&name)) {
                *out.entry(id).or_default() += 1;
            }
        }
    }
    out
}

/// Move an older release's `<id>.user-backup-<time>` folders into the
/// backups — all but those an agent sees through a link, which stay. Caller
/// holds the skills lock. Returns (moved, kept, problems).
pub(crate) fn migrate_legacy(ctx: &SkillsCtx) -> (usize, usize, Vec<String>) {
    let world = World::load(ctx);
    let (mut moved, mut kept, mut problems) = (0, 0, Vec::new());
    for name in super::fsio::child_names(&ctx.store) {
        let Some((id, time)) = legacy_backup_name(&name) else {
            continue;
        };
        let from = ctx.store.join(&name);
        if !from.is_dir() || fs::symlink_metadata(&from).is_ok_and(|m| m.file_type().is_symlink()) {
            continue;
        }
        if !linked_by(&world, &name).is_empty() {
            kept += 1;
            continue;
        }
        let root = backups_root(&ctx.store).join(&id);
        let mut to = root.join(&time);
        let mut n = 1;
        while fs::symlink_metadata(&to).is_ok() {
            to = root.join(format!("{time}.{n:03}"));
            n += 1;
        }
        match move_dir(&from, &to, &id) {
            Ok(()) => moved += 1,
            Err(err) => problems.push(format!("{}: {err}", from.display())),
        }
    }
    (moved, kept, problems)
}

enum Found {
    New(PathBuf),
    Legacy(PathBuf, String),
}

/// A name a caller gives for a backup (`skill`, `name`): one plain entry of
/// the characters Codeg's own names use — `[A-Za-z0-9._-]`, never leading
/// `.`, never `..` — so it can only ever name an entry of the directory it
/// is joined to, on every platform (no separator of either kind, no drive
/// or root, no `C:x`).
fn backup_component(text: &str) -> bool {
    !text.starts_with('.')
        && !text.contains("..")
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        && super::fsio::plain_name(text)
}

/// A real directory, not a link (or a Windows junction) to one.
fn real_dir(path: &Path) -> bool {
    matches!(super::link::inspect(path), super::link::RawEntry::Dir)
}

/// `path`, resolved through every link, is directly inside `dir` (resolved).
fn resolves_directly_into(path: &Path, dir: &Path) -> bool {
    match (fs::canonicalize(path), fs::canonicalize(dir)) {
        (Ok(real), Ok(dir)) => real.parent() == Some(dir.as_path()),
        _ => false,
    }
}

/// The backup `skill`/`name` names: inside the store's backups (or, an older
/// release's, inside the store itself), every folder on the way a real one
/// — a link anywhere on the way could lead a delete out of the store — and
/// checked once more by where it resolves before anything moves.
fn find(ctx: &SkillsCtx, skill: &str, name: &str) -> Option<Found> {
    if !backup_component(skill) || !backup_component(name) {
        return None;
    }
    let root = backups_root(&ctx.store);
    let dir = root.join(skill);
    let path = dir.join(name);
    if real_dir(&root) && real_dir(&dir) && real_dir(&path) && resolves_directly_into(&path, &dir) {
        let inside = fs::canonicalize(&dir)
            .ok()
            .zip(fs::canonicalize(&ctx.store).ok())
            .is_some_and(|(dir, store)| dir.starts_with(store));
        if inside {
            return Some(Found::New(path));
        }
        return None;
    }
    let legacy = format!("{skill}.user-backup-{name}");
    let path = ctx.store.join(&legacy);
    (legacy_backup_name(&legacy).is_some()
        && real_dir(&path)
        && resolves_directly_into(&path, &ctx.store))
    .then_some(Found::Legacy(path, legacy))
}

fn result(skill: &str, name: &str, outcome: BackupOutcome) -> SkillsBackupResult {
    SkillsBackupResult {
        outcome,
        ok: matches!(outcome, BackupOutcome::Restored | BackupOutcome::Deleted),
        skill: skill.to_string(),
        name: name.to_string(),
        id: None,
        path: None,
        backup_kept: true,
        issues: Vec::new(),
    }
}

fn failed(
    mut out: SkillsBackupResult,
    outcome: BackupOutcome,
    issue: SkillsIssue,
) -> SkillsBackupResult {
    out.outcome = outcome;
    out.ok = false;
    out.issues.push(issue);
    out
}

/// Restore a backup as the Custom skill `id`. Caller holds the skills lock.
pub(crate) fn restore_as_custom(
    ctx: &SkillsCtx,
    skill: &str,
    name: &str,
    id: &str,
) -> SkillsBackupResult {
    let out = result(skill, name, BackupOutcome::Restored);
    let id = match crate::commands::custom_skills::ensure_custom_id_in(&ctx.store, id) {
        Ok(id) => id,
        Err(err) => {
            let code = err.code();
            return failed(
                out,
                BackupOutcome::Invalid,
                SkillsIssue::new(code).detail(err.to_string()),
            );
        }
    };
    let Some(found) = find(ctx, skill, name) else {
        return failed(
            out,
            BackupOutcome::Invalid,
            SkillsIssue::new(codes::BACKUP_NOT_FOUND),
        );
    };
    let dst = ctx.skill_path(&id);
    if fs::symlink_metadata(&dst).is_ok() {
        return failed(
            out,
            BackupOutcome::Invalid,
            SkillsIssue::new(codes::ID_TAKEN).path(&dst),
        );
    }
    let world = World::load(ctx);
    let (source, keep) = match &found {
        Found::New(path) => (path.clone(), false),
        // An older release's backup an agent links to keeps its place.
        Found::Legacy(path, dir_name) => (path.clone(), !linked_by(&world, dir_name).is_empty()),
    };
    let done = if keep {
        let staging = ctx.store.join(STAGING_DIR).join(op_id()).join("new");
        let copied = staging
            .parent()
            .map(fs::create_dir_all)
            .unwrap_or(Ok(()))
            .and_then(|()| copy_tree(&source, &staging))
            .and_then(|()| rename(&staging, &dst));
        if let Some(op) = staging.parent() {
            let _ = fs::remove_dir_all(op);
        }
        remove_if_empty(&ctx.store.join(STAGING_DIR));
        copied
    } else {
        move_dir(&source, &dst, &id)
    };
    if let Err(err) = done {
        return failed(
            out,
            BackupOutcome::Failed,
            SkillsIssue::new(codes::IO_ERROR)
                .path(&source)
                .detail(err.to_string()),
        );
    }
    tidy(ctx, skill);
    super::packs::clear_pending_if_no_backups(ctx, skill);
    SkillsBackupResult {
        id: Some(id),
        path: Some(dst.to_string_lossy().into_owned()),
        backup_kept: keep,
        ..out
    }
}

/// Delete a backup. Caller holds the skills lock.
pub(crate) fn delete(ctx: &SkillsCtx, skill: &str, name: &str) -> SkillsBackupResult {
    let mut out = result(skill, name, BackupOutcome::Deleted);
    let Some(found) = find(ctx, skill, name) else {
        return failed(
            out,
            BackupOutcome::Invalid,
            SkillsIssue::new(codes::BACKUP_NOT_FOUND),
        );
    };
    let path = match found {
        Found::New(path) => path,
        Found::Legacy(path, dir_name) => {
            let world = World::load(ctx);
            let agents = linked_by(&world, &dir_name);
            if !agents.is_empty() {
                return failed(
                    out,
                    BackupOutcome::Invalid,
                    SkillsIssue::new(codes::BACKUP_LINKED)
                        .path(&path)
                        .agents(agents),
                );
            }
            path
        }
    };
    // Into staging first, so a delete cut short leaves nothing half there.
    let aside = ctx.store.join(STAGING_DIR).join(op_id()).join("old");
    let moved = aside
        .parent()
        .map(fs::create_dir_all)
        .unwrap_or(Ok(()))
        .and_then(|()| rename(&path, &aside));
    if let Err(err) = moved {
        if let Some(op) = aside.parent() {
            let _ = fs::remove_dir_all(op);
        }
        remove_if_empty(&ctx.store.join(STAGING_DIR));
        return failed(
            out,
            BackupOutcome::Failed,
            SkillsIssue::new(codes::IO_ERROR)
                .path(&path)
                .detail(err.to_string()),
        );
    }
    if let Some(op) = aside.parent() {
        let _ = fs::remove_dir_all(op);
    }
    remove_if_empty(&ctx.store.join(STAGING_DIR));
    tidy(ctx, skill);
    super::packs::clear_pending_if_no_backups(ctx, skill);
    out.backup_kept = false;
    out
}
