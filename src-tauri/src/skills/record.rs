//! `~/.codeg/skills/.links.json`: every link or copy Codeg made in an
//! agent's skill directory — the skill, the directory, how (symlink,
//! junction or copy), when, and for a copy the hash of what was copied.
//!
//! The record helps; the disk decides. A link that leads to a skill in the
//! store is Codeg's whether or not it is recorded. A real folder is the
//! user's unless the record says Codeg copied it there — the one thing only
//! the record can tell. Entries the disk contradicts are dropped, and links
//! found without one are added, by [`reconcile`] (at every start, and so
//! after Codeg's backup has been restored over the store — when which folders
//! are Codeg's copies follows the record from before the restore:
//! [`LinkRecord::take_copies_from`]).
//!
//! Written whole, atomically, under the skills lock.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::fsio::{entry_key, write_private_atomic};
use super::link::LinkMode;
use super::model::{codes, SkillsIssue};

pub(crate) const RECORD_FILE: &str = ".links.json";
const RECORD_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecordEntry {
    pub skill: String,
    /// The agent skill directory the entry is in.
    pub dir: String,
    /// The entry itself: `<dir>/<skill>`.
    pub path: String,
    pub mode: LinkMode,
    /// RFC 3339.
    pub created_at: String,
    /// Copies: the hash of what was copied (`fsio::hash_skill_dir`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_hash: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RecordFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    links: Vec<RecordEntry>,
}

/// The record, keyed by where each entry is.
#[derive(Debug, Clone, Default)]
pub struct LinkRecord {
    entries: BTreeMap<PathBuf, RecordEntry>,
    /// Why the file could not be read, when it could not.
    pub problem: Option<SkillsIssue>,
    changed: bool,
}

pub(crate) fn record_path(store: &Path) -> PathBuf {
    store.join(RECORD_FILE)
}

impl LinkRecord {
    pub fn load(store: &Path) -> Self {
        let path = record_path(store);
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Self::default(),
            Err(err) => {
                return Self {
                    problem: Some(
                        SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                            .path(&path)
                            .detail(err.to_string()),
                    ),
                    ..Self::default()
                }
            }
        };
        match serde_json::from_slice::<RecordFile>(&bytes) {
            Ok(file) => {
                let mut record = Self::default();
                for entry in file.links {
                    record
                        .entries
                        .insert(entry_key(Path::new(&entry.path)), entry);
                }
                record
            }
            Err(err) => Self {
                problem: Some(
                    SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                        .path(&path)
                        .detail(err.to_string()),
                ),
                ..Self::default()
            },
        }
    }

    pub fn get(&self, path: &Path) -> Option<&RecordEntry> {
        self.entries.get(&entry_key(path))
    }

    pub fn entries(&self) -> impl Iterator<Item = &RecordEntry> {
        self.entries.values()
    }

    pub fn insert(&mut self, entry: RecordEntry) {
        let key = entry_key(Path::new(&entry.path));
        if self.entries.get(&key) != Some(&entry) {
            self.entries.insert(key, entry);
            self.changed = true;
        }
    }

    pub fn remove(&mut self, path: &Path) -> Option<RecordEntry> {
        let removed = self.entries.remove(&entry_key(path));
        if removed.is_some() {
            self.changed = true;
        }
        removed
    }

    /// Write the record when it changed. An unreadable record is kept as
    /// `.links.json.unreadable` too rather than lost, and stays in place
    /// until the new one is renamed over it (never no record at all).
    pub fn save(&mut self, store: &Path) -> io::Result<()> {
        if !self.changed {
            return Ok(());
        }
        let path = record_path(store);
        if self.problem.is_some() {
            super::fsio::keep_aside(&path, &store.join(format!("{RECORD_FILE}.unreadable")))?;
        }
        let file = RecordFile {
            version: RECORD_VERSION,
            links: self.entries.values().cloned().collect(),
        };
        let bytes = serde_json::to_vec_pretty(&file).map_err(io::Error::other)?;
        fs::create_dir_all(store)?;
        write_private_atomic(&path, &bytes)?;
        self.changed = false;
        self.problem = None;
        Ok(())
    }

    /// After Codeg's backup was restored over the store, with `before` the
    /// record from just before. The restore brought back the store, not the
    /// agents' directories, so what the restored record says about those is
    /// as old as the backup. Which real folders are Codeg's copies — the one
    /// thing only the record can tell — follows `before` (removals
    /// included: a copy disabled since the backup is not Codeg's again, and
    /// a copy refreshed since keeps its new hash); with `before` unreadable
    /// or absent, no folder is Codeg's copy (a real folder without a record
    /// is the user's). Links stay as either record knows them until the
    /// reconcile at startup rebuilds them from the disk.
    pub fn take_copies_from(&mut self, before: &LinkRecord) {
        let copies: Vec<PathBuf> = self
            .entries
            .iter()
            .filter(|(_, entry)| entry.mode == LinkMode::Copy)
            .map(|(key, _)| key.clone())
            .collect();
        for key in copies {
            self.entries.remove(&key);
            self.changed = true;
        }
        if before.problem.is_some() {
            return;
        }
        for (key, entry) in &before.entries {
            if self.entries.get(key) != Some(entry) {
                self.entries.insert(key.clone(), entry.clone());
                self.changed = true;
            }
        }
    }
}

pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Bring the record in line with the disk: drop what the disk contradicts,
/// add the links into the store it does not know. Returns whether anything
/// changed. Caller holds the skills lock.
pub(crate) fn reconcile(ctx: &super::SkillsCtx, record: &mut LinkRecord) -> bool {
    reconcile_with(ctx, record, false)
}

/// [`reconcile`] for the links only: every copy's entry stays as it is —
/// after a rollback that failed, a copy waiting in staging is put back at
/// the next start by its entry.
pub(crate) fn reconcile_links(ctx: &super::SkillsCtx, record: &mut LinkRecord) -> bool {
    reconcile_with(ctx, record, true)
}

fn reconcile_with(ctx: &super::SkillsCtx, record: &mut LinkRecord, keep_copies: bool) -> bool {
    use super::link::{inspect, RawEntry};
    let store = super::StorePaths::of(&ctx.store);
    let before = record.entries.clone();
    let stale: Vec<PathBuf> = record
        .entries
        .iter()
        .filter(|(_, entry)| {
            let path = Path::new(&entry.path);
            match (entry.mode, inspect(path)) {
                (LinkMode::Copy, _) if keep_copies => false,
                (LinkMode::Copy, RawEntry::Dir) => false,
                (LinkMode::Copy, _) => true,
                (_, RawEntry::Link { resolved, target }) => {
                    // A link recorded as Codeg's stays Codeg's while it still
                    // leads (or, dangling, points) into the store.
                    let into_store = match resolved {
                        Some(real) => store.child_of(&real).is_some(),
                        None => target.as_deref().and_then(|t| store.child_of(t)).is_some(),
                    };
                    !into_store
                }
                _ => true,
            }
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in stale {
        record.entries.remove(&key);
        record.changed = true;
    }
    for dir in ctx.all_dirs() {
        let Ok(children) = fs::read_dir(&dir) else {
            continue;
        };
        for child in children.flatten() {
            let path = child.path();
            if record.get(&path).is_some() {
                continue;
            }
            if let RawEntry::Link {
                resolved: Some(real),
                ..
            } = inspect(&path)
            {
                if let Some(skill) = store.child_of(&real) {
                    let created_at = fs::symlink_metadata(&path)
                        .and_then(|meta| meta.modified())
                        .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339())
                        .unwrap_or_else(|_| now());
                    record.insert(RecordEntry {
                        skill,
                        dir: dir.to_string_lossy().into_owned(),
                        path: path.to_string_lossy().into_owned(),
                        mode: if cfg!(windows) {
                            LinkMode::Junction
                        } else {
                            LinkMode::Symlink
                        },
                        created_at,
                        copy_hash: None,
                    });
                }
            }
        }
    }
    record.entries != before
}
