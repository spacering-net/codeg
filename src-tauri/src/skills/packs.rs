//! The packs' side of the store: extracting the bundled Experts and Science
//! skills at startup, the Office skills' sync, their manifests, and what has
//! to follow an update (refreshing Codeg's copies) or an uninstall (taking
//! every link away).
//!
//! An extraction writes the whole skill into `~/.codeg/skills/.codeg-staging/`
//! first and renames it into place, so a skill is never half there; an
//! update swaps the old folder out the same way. A pack's skill whose folder
//! the user changed is set aside into the backups first. A folder of the
//! pack's id that the pack's manifest does not list is someone else's — a
//! Custom skill — and is never taken over: the pack's skill is "name taken".

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use include_dir::{Dir, DirEntry};
use serde::{Deserialize, Serialize};

use crate::models::agent::AgentType;

use super::fsio::{hash_skill_dir, op_id, rename, write_content_atomic, write_private_atomic};
use super::link::{inspect, LinkMode, RawEntry};
use super::model::{codes, SkillOrigin, SkillsIssue};
use super::provenance::{manifest_of, STAGING_DIR};
use super::world::{Entry, World};
use super::SkillsCtx;

// ─── Manifests ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ManifestEntry {
    #[serde(default)]
    pub hash: String,
    #[serde(default)]
    pub installed_at: String,
    #[serde(default)]
    pub pending_user_review: bool,
}

/// A pack's manifest: `{ codeg_version, installed_at, <key>: { <id>: entry } }`,
/// the shape Experts and Science have always written.
#[derive(Debug, Clone)]
pub(crate) struct PackManifest {
    file: &'static str,
    key: &'static str,
    pub codeg_version: String,
    pub installed_at: String,
    pub entries: BTreeMap<String, ManifestEntry>,
    /// Folders under the pack's ids whose owner nobody can tell any more (an
    /// earlier manifest could not be read, and they did not equal the pack's
    /// skill): not claimed, never touched, reported (`ownership_unresolved`)
    /// until they go or come to equal the pack's skill. Top-level
    /// `"unresolved": [<id>…]`, written only when there are any.
    pub unresolved: BTreeSet<String>,
    /// The file is there (readable or not).
    pub exists: bool,
    pub problem: Option<SkillsIssue>,
}

impl PackManifest {
    pub fn load(store: &Path, origin: SkillOrigin) -> Self {
        let (file, key) = manifest_of(origin).expect("a pack with a manifest");
        let path = store.join(file);
        let mut out = Self {
            file,
            key,
            codeg_version: String::new(),
            installed_at: String::new(),
            entries: BTreeMap::new(),
            unresolved: BTreeSet::new(),
            exists: false,
            problem: None,
        };
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return out,
            Err(err) => {
                out.exists = true;
                out.problem = Some(
                    SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                        .path(&path)
                        .detail(err.to_string()),
                );
                return out;
            }
        };
        out.exists = true;
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(value) => {
                let text = |field: &str| {
                    value
                        .get(field)
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string()
                };
                out.codeg_version = text("codeg_version");
                out.installed_at = text("installed_at");
                if let Some(entries) = value.get(key).and_then(|v| v.as_object()) {
                    for (id, entry) in entries {
                        let entry = serde_json::from_value::<ManifestEntry>(entry.clone())
                            .unwrap_or_default();
                        out.entries.insert(id.clone(), entry);
                    }
                }
                out.unresolved = super::provenance::unresolved_in(&value);
            }
            Err(err) => {
                out.problem = Some(
                    SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                        .path(&path)
                        .detail(err.to_string()),
                )
            }
        }
        out
    }

    /// Write the manifest. One that could not be read is kept as
    /// `<file>.unreadable` too, never silently lost — and stays the active
    /// manifest until this one is renamed over it: a write that fails or is
    /// cut short leaves it in place (still unreadable, so nothing whose owner
    /// is unknown is touched), never no manifest at all (which would read as
    /// a store from before the pack kept one). Once written, this one is the
    /// readable one.
    pub fn save(&mut self, store: &Path) -> io::Result<()> {
        if self.problem.is_some() {
            let path = store.join(self.file);
            super::fsio::keep_aside(&path, &store.join(format!("{}.unreadable", self.file)))?;
        }
        let mut root = serde_json::Map::new();
        root.insert(
            "codeg_version".into(),
            serde_json::Value::String(self.codeg_version.clone()),
        );
        root.insert(
            "installed_at".into(),
            serde_json::Value::String(self.installed_at.clone()),
        );
        root.insert(
            self.key.into(),
            serde_json::to_value(&self.entries).map_err(io::Error::other)?,
        );
        if !self.unresolved.is_empty() {
            root.insert(
                super::provenance::UNRESOLVED_KEY.into(),
                serde_json::to_value(&self.unresolved).map_err(io::Error::other)?,
            );
        }
        let bytes = serde_json::to_vec_pretty(&serde_json::Value::Object(root))
            .map_err(io::Error::other)?;
        fs::create_dir_all(store)?;
        super::fsio::fault_point("manifest_write")?;
        write_private_atomic(&store.join(self.file), &bytes)?;
        self.problem = None;
        self.exists = true;
        Ok(())
    }

    /// After the manifest could not be read, nobody can tell whose the
    /// folders under the pack's ids (`ids`) are: each one there that this
    /// manifest does not list becomes unresolved. Nothing is claimed or
    /// touched here; [`Self::settle_unresolved`] decides.
    pub(crate) fn mark_unresolved_after_unreadable<'a>(
        &mut self,
        ctx: &SkillsCtx,
        ids: impl IntoIterator<Item = &'a str>,
    ) {
        if self.problem.is_none() {
            return;
        }
        for id in ids {
            if !self.entries.contains_key(id)
                && matches!(inspect(&ctx.skill_path(id)), RawEntry::Dir)
            {
                self.unresolved.insert(id.to_string());
            }
        }
    }

    /// Settle the unresolved id `id`, given the hash the pack's own skill
    /// of that id has now (`expected`; `None` when not known). A folder that
    /// is gone leaves the list (the pack may put its own there); one equal
    /// to the pack's skill is recorded as the pack's; any other is left
    /// exactly as it is and stays unresolved. Returns whether it stays.
    pub(crate) fn settle_unresolved(
        &mut self,
        ctx: &SkillsCtx,
        id: &str,
        expected: Option<&str>,
    ) -> bool {
        if !self.unresolved.contains(id) {
            return false;
        }
        let central = ctx.skill_path(id);
        match inspect(&central) {
            RawEntry::Absent => {
                self.unresolved.remove(id);
                false
            }
            RawEntry::Dir => {
                let on_disk = hash_skill_dir(&central, id).ok();
                match (on_disk, expected) {
                    (Some(on_disk), Some(expected)) if on_disk == expected => {
                        self.unresolved.remove(id);
                        self.entries.insert(
                            id.to_string(),
                            ManifestEntry {
                                hash: on_disk,
                                installed_at: now(),
                                pending_user_review: false,
                            },
                        );
                        false
                    }
                    _ => true,
                }
            }
            _ => true,
        }
    }

    pub(crate) fn stamp(&mut self) {
        self.codeg_version = env!("CARGO_PKG_VERSION").to_string();
        self.installed_at = chrono::Utc::now().to_rfc3339();
    }
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ─── Bundled packs ──────────────────────────────────────────────────────

/// One pack compiled into the binary: its skills are `skills/<id>/` in `dir`.
pub(crate) struct Bundle<'a> {
    pub origin: SkillOrigin,
    pub dir: &'a Dir<'a>,
    /// (id, bundled hash) of every skill.
    pub skills: Vec<(String, String)>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct InstallReport {
    pub installed_count: usize,
    pub updated_count: usize,
    pub pending_user_review: Vec<String>,
    /// The pack's skills a skill of another origin holds the id of.
    pub name_taken: Vec<String>,
    /// Folders under the pack's ids whose owner is unknown (its manifest
    /// could not be read): left as they are, reported.
    pub unresolved: Vec<String>,
    pub errors: Vec<String>,
}

/// Write the bundled skill `id` of `dir` into `target` (which must not
/// exist). `include_dir!` carries no permission bits, so a file that starts
/// with a shebang is made executable.
pub(crate) fn extract_bundle_skill(dir: &Dir<'_>, id: &str, target: &Path) -> io::Result<()> {
    let prefix = format!("skills/{id}");
    let skill = dir
        .get_dir(&prefix)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{id} is not bundled")))?;
    fs::create_dir_all(target)?;
    fn walk(dir: &Dir<'_>, prefix: &str, target: &Path) -> io::Result<()> {
        for entry in dir.entries() {
            match entry {
                DirEntry::File(file) => {
                    let rel = file
                        .path()
                        .to_str()
                        .ok_or_else(|| io::Error::other("non-utf8 path in bundle"))?;
                    let within = rel
                        .strip_prefix(prefix)
                        .and_then(|s| s.strip_prefix('/'))
                        .unwrap_or(rel);
                    let out = target.join(within);
                    if let Some(parent) = out.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    fs::write(&out, file.contents())?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        if file.contents().starts_with(b"#!") {
                            let mut perms = fs::metadata(&out)?.permissions();
                            perms.set_mode(perms.mode() | 0o111);
                            fs::set_permissions(&out, perms)?;
                        }
                    }
                }
                DirEntry::Dir(sub) => walk(sub, prefix, target)?,
            }
        }
        Ok(())
    }
    walk(skill, &prefix, target)
}

/// Every file of the bundled skill `id`, as (`skills/<id>/<rel>`, bytes).
pub(crate) fn bundle_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a str, &'a [u8])>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::File(file) => out.push((file.path().to_str().unwrap_or(""), file.contents())),
            DirEntry::Dir(sub) => bundle_files(sub, out),
        }
    }
}

/// The hash of the bundled skill `id` (the manifests' hash).
pub(crate) fn bundled_hash(dir: &Dir<'_>, id: &str) -> Option<String> {
    let skill = dir.get_dir(format!("skills/{id}"))?;
    let mut files = Vec::new();
    bundle_files(skill, &mut files);
    Some(super::fsio::hash_bundle_files(&mut files))
}

fn staging_op(ctx: &SkillsCtx) -> io::Result<PathBuf> {
    let op = ctx.store.join(STAGING_DIR).join(op_id());
    fs::create_dir_all(&op)?;
    Ok(op)
}

fn finish(op: &Path) {
    let _ = fs::remove_dir_all(op);
    if let Some(root) = op.parent() {
        super::fsio::remove_if_empty(root);
    }
}

/// The journal of a [`place_skill`] that swapped a skill out: which id its
/// `old` folder is, so a start after a crash puts it back
/// ([`recover_store_staging`]).
const PLACE_JOURNAL: &str = "place.json";

/// Put a skill written by `write` (into the path it is given) at the store's
/// `id`: staged in full, then renamed into place. When `id` is already there,
/// the old folder is swapped out (`set_aside`: into the backups; otherwise
/// deleted once the new one is in). Any failure leaves the old one in place;
/// when putting it back fails too, it is never deleted: it stays in staging
/// (named in the error), and the next start puts it back.
pub(crate) fn place_skill(
    ctx: &SkillsCtx,
    id: &str,
    set_aside: bool,
    write: impl FnOnce(&Path) -> io::Result<()>,
) -> io::Result<Option<PathBuf>> {
    let central = ctx.skill_path(id);
    let op = staging_op(ctx)?;
    let new = op.join("new");
    let old = op.join("old");
    let mut keep_op = false;
    let result = (|| {
        write(&new)?;
        ctx.fault("place_new")?;
        let present = fs::symlink_metadata(&central).is_ok();
        if !present {
            rename(&new, &central)?;
            return Ok(None);
        }
        let backup = if set_aside {
            Some(super::backups::set_aside(ctx, id)?)
        } else {
            let journal =
                serde_json::to_vec(&serde_json::json!({ "id": id })).map_err(io::Error::other)?;
            write_private_atomic(&op.join(PLACE_JOURNAL), &journal)?;
            rename(&central, &old)?;
            None
        };
        if let Err(err) = ctx
            .fault("place_swap")
            .and_then(|()| rename(&new, &central))
        {
            let restored = ctx.fault("place_restore").and_then(|()| match &backup {
                Some(path) => super::fsio::move_dir(path, &central, id),
                None => rename(&old, &central),
            });
            if backup.is_some() && restored.is_ok() {
                super::backups::tidy(ctx, id);
            }
            return Err(match restored {
                Ok(()) => err,
                Err(restore_err) => {
                    let kept = match &backup {
                        Some(path) => path.clone(),
                        None => {
                            keep_op = true;
                            old.clone()
                        }
                    };
                    io::Error::other(format!(
                        "{err}; putting the old skill back failed too ({restore_err}); it is kept in {}",
                        kept.display()
                    ))
                }
            });
        }
        Ok(backup)
    })();
    if keep_op {
        // Only the old skill and its journal stay.
        let _ = fs::remove_dir_all(&new);
    } else {
        finish(&op);
    }
    result
}

/// At startup, for a folder in the store's staging that a [`place_skill`]
/// left (its `place.json`): the skill it had swapped out goes back where it
/// was when nothing took its place. `None` for a folder without that
/// journal; an error when the skill could not go back (the folder then
/// stays).
pub(crate) fn recover_placed(ctx: &SkillsCtx, op: &Path) -> Option<io::Result<()>> {
    let bytes = fs::read(op.join(PLACE_JOURNAL)).ok()?;
    let id = serde_json::from_slice::<serde_json::Value>(&bytes)
        .ok()
        .and_then(|value| value.get("id").and_then(|v| v.as_str()).map(str::to_string))
        .filter(|id| crate::commands::acp::validate_skill_id(id).is_ok());
    let old = op.join("old");
    let Some(id) = id else {
        return Some(Ok(()));
    };
    if fs::symlink_metadata(&old).is_err() {
        return Some(Ok(()));
    }
    let central = ctx.skill_path(&id);
    if fs::symlink_metadata(&central).is_ok() {
        // The new one made it in: the swap was done.
        return Some(Ok(()));
    }
    Some(rename(&old, &central))
}

enum Action {
    Skipped,
    Installed,
    Updated,
    BackedUp,
    NameTaken,
}

/// Bring the pack's skills in the store up to date. Caller holds the skills
/// lock.
pub(crate) fn install_bundle(ctx: &SkillsCtx, bundle: &Bundle<'_>) -> InstallReport {
    let mut report = InstallReport::default();
    if let Err(err) = fs::create_dir_all(&ctx.store) {
        report
            .errors
            .push(format!("failed to create central dir: {err}"));
        return report;
    }
    let mut manifest = PackManifest::load(&ctx.store, bundle.origin);
    if let Some(problem) = &manifest.problem {
        report.errors.push(format!(
            "{}: {}: {}",
            codes::MANIFEST_UNREADABLE,
            problem.path.clone().unwrap_or_default(),
            problem.detail.clone().unwrap_or_default()
        ));
        manifest
            .mark_unresolved_after_unreadable(ctx, bundle.skills.iter().map(|(id, _)| id.as_str()));
    }
    // While nobody can tell whose a folder is, nothing of it changes: one
    // equal to the pack's skill is recorded as the pack's, any other is left
    // as it is (not claimed: the pack's is "name taken") and reported.
    for (id, hash) in &bundle.skills {
        if manifest.settle_unresolved(ctx, id, Some(hash)) {
            report.unresolved.push(id.clone());
        }
    }
    if !report.unresolved.is_empty() {
        report.errors.push(format!(
            "{}: {} folder(s) under the pack's ids left as they are, owner unknown: {}",
            codes::OWNERSHIP_UNRESOLVED,
            report.unresolved.len(),
            report.unresolved.join(", ")
        ));
    }
    // Claim first: an id the pack is about to extract is in its manifest
    // before its folder is in the store. Were the manifest written only after
    // and that write failed, the pack's new folder would read as a skill of
    // the user's from then on.
    let mut absent = false;
    for (id, hash) in &bundle.skills {
        if !manifest.entries.contains_key(id)
            && matches!(inspect(&ctx.skill_path(id)), RawEntry::Absent)
        {
            manifest.entries.insert(
                id.clone(),
                ManifestEntry {
                    hash: hash.clone(),
                    installed_at: now(),
                    pending_user_review: false,
                },
            );
            absent = true;
        }
    }
    if absent || manifest.problem.is_some() {
        manifest.stamp();
        if let Err(err) = ctx
            .fault("manifest_save")
            .and_then(|()| manifest.save(&ctx.store))
        {
            // Nothing is extracted without its claim on disk.
            report.errors.push(format!("save manifest: {err}"));
            return report;
        }
    }
    let mut updated: Vec<String> = Vec::new();
    for (id, hash) in &bundle.skills {
        match install_one(ctx, bundle, &mut manifest, id, hash) {
            Ok(Action::Skipped) => {}
            Ok(Action::Installed) => report.installed_count += 1,
            Ok(Action::Updated) => {
                report.updated_count += 1;
                updated.push(id.clone());
            }
            Ok(Action::BackedUp) => {
                report.updated_count += 1;
                report.pending_user_review.push(id.clone());
                updated.push(id.clone());
            }
            Ok(Action::NameTaken) => report.name_taken.push(id.clone()),
            Err(err) => report.errors.push(format!("{id}: {err}")),
        }
    }
    manifest.stamp();
    if let Err(err) = ctx
        .fault("manifest_save")
        .and_then(|()| manifest.save(&ctx.store))
    {
        report.errors.push(format!("save manifest: {err}"));
    }
    for id in updated {
        report.errors.extend(refresh_copies(ctx, &id));
    }
    report
}

fn install_one(
    ctx: &SkillsCtx,
    bundle: &Bundle<'_>,
    manifest: &mut PackManifest,
    id: &str,
    bundled: &str,
) -> io::Result<Action> {
    let central = ctx.skill_path(id);
    let fresh = |hash: &str, pending: bool| ManifestEntry {
        hash: hash.to_string(),
        installed_at: now(),
        pending_user_review: pending,
    };
    let extract = |target: &Path| extract_bundle_skill(bundle.dir, id, target);
    match inspect(&central) {
        RawEntry::Absent => {
            place_skill(ctx, id, false, extract)?;
            manifest
                .entries
                .insert(id.to_string(), fresh(bundled, false));
            Ok(Action::Installed)
        }
        RawEntry::Dir => {
            let Some(entry) = manifest.entries.get(id).cloned() else {
                // Not the pack's: a skill of the user's holds the name — even
                // one whose content equals the pack's. It stays a Custom
                // skill, and the pack's is "name taken".
                return Ok(Action::NameTaken);
            };
            let on_disk = hash_skill_dir(&central, id)?;
            if on_disk == bundled {
                if entry.hash != bundled {
                    manifest.entries.insert(
                        id.to_string(),
                        ManifestEntry {
                            pending_user_review: entry.pending_user_review,
                            ..fresh(bundled, false)
                        },
                    );
                }
                return Ok(Action::Skipped);
            }
            if !entry.hash.is_empty() && on_disk == entry.hash {
                // Pristine but outdated.
                place_skill(ctx, id, false, extract)?;
                manifest
                    .entries
                    .insert(id.to_string(), fresh(bundled, false));
                return Ok(Action::Updated);
            }
            // The user changed the pack's copy: keep theirs among the
            // backups, install the bundled one.
            place_skill(ctx, id, true, extract)?;
            manifest
                .entries
                .insert(id.to_string(), fresh(bundled, true));
            Ok(Action::BackedUp)
        }
        // A link or a file under the pack's id: not the pack's to replace.
        RawEntry::Link { .. } | RawEntry::File => {
            if manifest.entries.contains_key(id) {
                manifest.entries.remove(id);
            }
            Ok(Action::NameTaken)
        }
        RawEntry::Unreadable(err) => Err(io::Error::other(err)),
    }
}

/// Clear a pack skill's "user modified" mark once none of its backups is
/// left.
pub(crate) fn clear_pending_if_no_backups(ctx: &SkillsCtx, id: &str) {
    if super::backups::counts(ctx).get(id).copied().unwrap_or(0) > 0 {
        return;
    }
    for origin in [SkillOrigin::Experts, SkillOrigin::Science] {
        let mut manifest = PackManifest::load(&ctx.store, origin);
        if manifest.problem.is_some() {
            continue;
        }
        if let Some(entry) = manifest.entries.get_mut(id) {
            if entry.pending_user_review {
                entry.pending_user_review = false;
                if let Err(err) = manifest.save(&ctx.store) {
                    tracing::warn!("[Skills] could not clear the review mark of {id}: {err}");
                }
            }
        }
    }
}

// ─── Copies after an update ─────────────────────────────────────────────

/// After the store's `id` changed: replace every copy of Codeg's that still
/// matches its record with the new content. A copy changed on the agent's
/// side is left as it is (and stays "modified" in the inventory). Caller
/// holds the skills lock. Returns what went wrong.
pub(crate) fn refresh_copies(ctx: &SkillsCtx, id: &str) -> Vec<String> {
    let mut world = World::load(ctx);
    let copies: Vec<PathBuf> = world
        .record
        .entries()
        .filter(|entry| entry.mode == LinkMode::Copy && entry.skill == id)
        .map(|entry| PathBuf::from(&entry.path))
        .collect();
    let mut problems = Vec::new();
    for path in copies {
        match world.entry(&path) {
            Entry::CodegCopy {
                matches: true,
                current: false,
                ..
            } => match super::copies::swap_in(ctx, &path, id) {
                Ok(staged) => {
                    if let Some(mut entry) = world.record.get(&path).cloned() {
                        entry.copy_hash = Some(staged.new_hash.clone());
                        world.record.insert(entry);
                    }
                    match ctx
                        .fault("refresh_record")
                        .and_then(|()| world.record.save(&ctx.store))
                    {
                        Ok(()) => super::copies::commit(&staged.op_dir),
                        Err(err) => {
                            // Without the new hash on record the new copy
                            // would read as changed by the user: put the old
                            // one back (or, failing that, keep it in staging
                            // for the next start to put back).
                            let undone = super::copies::unswap(ctx, staged);
                            world.record = super::record::LinkRecord::load(&ctx.store);
                            match undone {
                                Ok(()) => problems.push(format!("{}: {err}", path.display())),
                                Err(failure) => problems.push(format!(
                                    "{}: {err}; putting the old copy back failed too: {failure}",
                                    path.display()
                                )),
                            }
                        }
                    }
                }
                Err(failure) => problems.push(format!("{}: {failure}", path.display())),
            },
            Entry::CodegCopy { matches: false, .. } => {
                tracing::info!(
                    "[Skills] {} was changed on the agent's side; it keeps the older {id}",
                    path.display()
                );
            }
            _ => {}
        }
    }
    problems
}

// ─── Taking a skill away from every agent ───────────────────────────────

/// Remove every link Codeg made to the store's `id` (broken ones too) and
/// every copy of it that matches its record, in every agent's directory.
/// Caller holds the skills lock. Returns the agents whose directories
/// changed, and what could not be done.
pub(crate) fn unlink_everywhere(ctx: &SkillsCtx, id: &str) -> (Vec<AgentType>, Vec<SkillsIssue>) {
    let mut world = World::load(ctx);
    let mut agents: Vec<AgentType> = Vec::new();
    let mut problems = Vec::new();
    for info in ctx.dirs.clone() {
        let path = info.path.join(id);
        let removed = match world.entry(&path) {
            Entry::CodegLink { skill, .. } if skill == id => {
                super::link::remove_entry(&path).map(|()| true)
            }
            Entry::CodegCopy {
                skill,
                matches: true,
                ..
            } if skill == id => fs::remove_dir_all(&path).map(|()| true),
            Entry::CodegCopy {
                skill,
                matches: false,
                ..
            } if skill == id => {
                problems.push(
                    SkillsIssue::new(codes::COPY_MODIFIED_KEPT)
                        .path(&path)
                        .agents(info.readers.clone()),
                );
                Ok(false)
            }
            _ => Ok(false),
        };
        match removed {
            Ok(true) => {
                world.record.remove(&path);
                agents.extend(info.readers.iter().copied());
            }
            Ok(false) => {}
            Err(err) => problems.push(
                SkillsIssue::new(codes::REMOVE_FAILED)
                    .path(&path)
                    .detail(err.to_string()),
            ),
        }
    }
    if let Err(err) = world.record.save(&ctx.store) {
        problems.push(
            SkillsIssue::new(codes::RECORD_WRITE_FAILED)
                .path(super::record::record_path(&ctx.store))
                .detail(err.to_string()),
        );
    }
    agents.sort();
    agents.dedup();
    (agents, problems)
}

/// Remove the store's `id` (through staging, so a removal cut short leaves
/// no half skill). Caller holds the skills lock.
pub(crate) fn remove_from_store(ctx: &SkillsCtx, id: &str) -> io::Result<()> {
    let central = ctx.skill_path(id);
    match inspect(&central) {
        RawEntry::Absent => Ok(()),
        RawEntry::Link { .. } => super::link::remove_entry(&central),
        _ => {
            let op = staging_op(ctx)?;
            let moved = rename(&central, &op.join("old"));
            finish(&op);
            moved
        }
    }
}

// ─── Office ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum OfficeWrite {
    Written,
    Unchanged,
    NameTaken,
    /// The folder's owner is unknown (Office's manifest could not be read)
    /// and it is not what Office would write: left as it is, reported.
    LeftAlone,
}

/// Before 0.46 Office kept no manifest: claim the Office ids already in the
/// store, once. Caller holds the skills lock.
pub(crate) fn migrate_office_manifest(ctx: &SkillsCtx) -> io::Result<bool> {
    let mut manifest = PackManifest::load(&ctx.store, SkillOrigin::Office);
    if manifest.exists {
        return Ok(false);
    }
    let mut claimed = false;
    for id in crate::commands::office_tools::bundled_skill_ids() {
        let central = ctx.skill_path(&id);
        if matches!(inspect(&central), RawEntry::Dir) {
            manifest.entries.insert(
                id.clone(),
                ManifestEntry {
                    hash: hash_skill_dir(&central, &id).unwrap_or_default(),
                    installed_at: now(),
                    pending_user_review: false,
                },
            );
            claimed = true;
        }
    }
    if !claimed {
        return Ok(false);
    }
    manifest.stamp();
    manifest.save(&ctx.store)?;
    Ok(true)
}

/// Office's manifest for its sync and uninstall. After one that cannot be
/// read, the Office ids in the store are unresolved: not claimed, not
/// touched (see [`PackManifest::settle_unresolved`]).
pub(crate) fn load_office_manifest(ctx: &SkillsCtx) -> PackManifest {
    let mut manifest = PackManifest::load(&ctx.store, SkillOrigin::Office);
    let ids = crate::commands::office_tools::bundled_skill_ids();
    manifest.mark_unresolved_after_unreadable(ctx, ids.iter().map(String::as_str));
    manifest
}

/// The hash a folder holding only Office's `SKILL.md` (`content`) has.
fn office_hash(id: &str, content: &str) -> String {
    let path = format!("skills/{id}/SKILL.md");
    super::fsio::hash_bundle_files(&mut [(path.as_str(), content.as_bytes())])
}

/// Write an Office skill's `SKILL.md` (OfficeCLI's output) into the store.
/// Caller holds the skills lock and saves `manifest` afterwards.
pub(crate) fn write_office_skill(
    ctx: &SkillsCtx,
    manifest: &mut PackManifest,
    id: &str,
    content: &str,
) -> io::Result<OfficeWrite> {
    let central = ctx.skill_path(id);
    // Owner unknown (an earlier manifest could not be read): a folder that
    // is exactly what Office writes is recorded as Office's; any other is
    // left as it is.
    if manifest.settle_unresolved(ctx, id, Some(&office_hash(id, content))) {
        return Ok(OfficeWrite::LeftAlone);
    }
    // No manifest yet (before 0.46): the Office ids in the store are
    // Office's, as `Provenance` reads them.
    let claimed = manifest.entries.contains_key(id)
        || (!manifest.exists && matches!(inspect(&central), RawEntry::Dir));
    let outcome = match inspect(&central) {
        RawEntry::Absent => {
            // Claim first, so the new folder is never one no manifest lists.
            manifest.entries.insert(
                id.to_string(),
                ManifestEntry {
                    hash: String::new(),
                    installed_at: now(),
                    pending_user_review: false,
                },
            );
            manifest.stamp();
            manifest.save(&ctx.store)?;
            place_skill(ctx, id, false, |target| {
                fs::create_dir_all(target)?;
                fs::write(target.join("SKILL.md"), content.as_bytes())
            })?;
            OfficeWrite::Written
        }
        RawEntry::Dir if claimed => {
            let skill_md = central.join("SKILL.md");
            if fs::read(&skill_md).ok().as_deref() == Some(content.as_bytes()) {
                OfficeWrite::Unchanged
            } else {
                write_content_atomic(&skill_md, content.as_bytes())?;
                OfficeWrite::Written
            }
        }
        RawEntry::Unreadable(err) => return Err(io::Error::other(err)),
        _ => return Ok(OfficeWrite::NameTaken),
    };
    manifest.entries.insert(
        id.to_string(),
        ManifestEntry {
            hash: hash_skill_dir(&central, id).unwrap_or_default(),
            installed_at: now(),
            pending_user_review: false,
        },
    );
    Ok(outcome)
}

/// Remove the Office skills Office owns: every link and matching copy of
/// them, then their folders, then their manifest entries. Caller holds the
/// skills lock. Returns the agents whose directories changed and what went
/// wrong.
pub(crate) fn uninstall_office_skills(ctx: &SkillsCtx) -> (Vec<AgentType>, Vec<String>) {
    let mut manifest = load_office_manifest(ctx);
    let mut agents = Vec::new();
    let mut errors = Vec::new();
    for id in crate::commands::office_tools::bundled_skill_ids() {
        // Office's by its manifest (or, before 0.46, by its name) — never a
        // folder whose owner is unknown.
        let owned = manifest.entries.contains_key(&id)
            || (!manifest.exists && matches!(inspect(&ctx.skill_path(&id)), RawEntry::Dir));
        if manifest.unresolved.contains(&id) {
            errors.push(format!(
                "{}: {} left as it is, owner unknown",
                codes::OWNERSHIP_UNRESOLVED,
                ctx.skill_path(&id).display()
            ));
            continue;
        }
        if !owned {
            continue;
        }
        let (touched, problems) = unlink_everywhere(ctx, &id);
        agents.extend(touched);
        for problem in problems {
            errors.push(format!(
                "{}: {} {}",
                problem.code,
                problem.path.unwrap_or_default(),
                problem.detail.unwrap_or_default()
            ));
        }
        match remove_from_store(ctx, &id) {
            Ok(()) => {
                manifest.entries.remove(&id);
            }
            Err(err) => errors.push(format!(
                "failed to remove {}: {err}",
                ctx.skill_path(&id).display()
            )),
        }
    }
    if manifest.exists || !manifest.entries.is_empty() {
        manifest.stamp();
        if let Err(err) = manifest.save(&ctx.store) {
            errors.push(format!("save manifest: {err}"));
        }
    }
    agents.sort();
    agents.dedup();
    (agents, errors)
}
