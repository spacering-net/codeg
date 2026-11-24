//! Whose skill is it: the manifests decide, never the name alone.
//!
//! A skill in the store belongs to the pack whose manifest lists it
//! (`.manifest.json` for Experts, `.manifest.science.json`,
//! `.manifest.office.json`), to the UI pack when its folder carries the
//! `.codeg-managed` marker, or to Harness when `.manifest.harness.json`
//! lists it (written by the Harness install). A skill none of them claims is
//! Custom. So a pack update that brings an id a Custom skill already has
//! does not take it over: the pack's skill is "name taken" instead.
//!
//! Before 0.46 Office kept no manifest; until the startup migration writes
//! one, an Office id in the store is Office's, as it always was.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io;
use std::path::Path;

use super::model::{codes, HarnessSkillInfo, SkillOrigin, SkillsIssue};

pub(crate) const EXPERTS_MANIFEST: &str = ".manifest.json";
pub(crate) const SCIENCE_MANIFEST: &str = ".manifest.science.json";
pub(crate) const OFFICE_MANIFEST: &str = ".manifest.office.json";
/// Written by the Harness install (H3); read here when it is there. Shape:
/// `{ "skills": { "<id>": { "ref": "…", "version": "…", … } } }`.
pub(crate) const HARNESS_MANIFEST: &str = ".manifest.harness.json";
/// The UI pack's mark on its copies (`commands::generative_ui`).
pub(crate) const UI_MARKER: &str = ".codeg-managed";
pub(crate) const UI_IDS: [&str; 2] = ["ui-render", "json-render"];
/// Where backups of skills go: dot-prefixed, so never listed as a skill;
/// not `.codeg-`, so still in Codeg's backup.
pub(crate) const USER_BACKUPS_DIR: &str = ".user-backups";
/// Staging inside the store: skipped by Codeg's backup and by every listing.
pub(crate) const STAGING_DIR: &str = ".codeg-staging";

/// The top-level key of a pack manifest listing the folders under the pack's
/// ids whose owner is unknown (`packs::PackManifest::unresolved`).
pub(crate) const UNRESOLVED_KEY: &str = "unresolved";

/// The ids a manifest lists as unresolved (valid ids only).
pub(crate) fn unresolved_in(value: &serde_json::Value) -> BTreeSet<String> {
    value
        .get(UNRESOLVED_KEY)
        .and_then(|list| list.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|id| id.as_str())
                .filter(|id| crate::commands::acp::validate_skill_id(id).is_ok())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Which manifest key each pack keeps its entries under.
pub(crate) fn manifest_of(origin: SkillOrigin) -> Option<(&'static str, &'static str)> {
    match origin {
        SkillOrigin::Experts => Some((EXPERTS_MANIFEST, "experts")),
        SkillOrigin::Science => Some((SCIENCE_MANIFEST, "science")),
        SkillOrigin::Office => Some((OFFICE_MANIFEST, "office")),
        SkillOrigin::Harness => Some((HARNESS_MANIFEST, "skills")),
        SkillOrigin::Ui | SkillOrigin::Custom => None,
    }
}

/// The entries under `key` in the manifest `file`: `Ok(None)` when the file
/// is not there.
pub(crate) fn read_manifest_entries(
    store: &Path,
    file: &str,
    key: &str,
) -> Result<Option<serde_json::Map<String, serde_json::Value>>, SkillsIssue> {
    let path = store.join(file);
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                .path(&path)
                .detail(err.to_string()))
        }
    };
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|err| {
        SkillsIssue::new(codes::MANIFEST_UNREADABLE)
            .path(&path)
            .detail(err.to_string())
    })?;
    Ok(Some(
        value
            .get(key)
            .and_then(|entries| entries.as_object())
            .cloned()
            .unwrap_or_default(),
    ))
}

/// `<id>.user-backup-<YYYYMMDD-HHMMSS>`: an older release's backup of a
/// pack skill the user had changed. Returns the skill id and the time.
pub(crate) fn legacy_backup_name(name: &str) -> Option<(String, String)> {
    let (id, stamp) = name.rsplit_once(".user-backup-")?;
    let bytes = stamp.as_bytes();
    let well_formed = bytes.len() == 15
        && bytes[8] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(i, b)| i == 8 || b.is_ascii_digit());
    if !well_formed || crate::commands::acp::validate_skill_id(id).is_err() {
        return None;
    }
    Some((id.to_string(), stamp.to_string()))
}

/// Harness's manifest read by the Harness install's own loader
/// (`harness::skills::manifest::load`): anything it refuses — not JSON, a
/// field of the wrong type, `skills` missing or not a map of well-formed
/// entries — cannot say which skills are Harness's, here either.
fn harness_manifest_refused(store: &Path) -> Option<SkillsIssue> {
    crate::harness::skills::manifest::load(store)
        .err()
        .map(|error| {
            SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                .path(store.join(HARNESS_MANIFEST))
                .detail(error.detail())
        })
}

/// A folder with a `SKILL.md` (through a link, as an agent would read it).
pub(crate) fn is_skill_dir(path: &Path) -> bool {
    path.is_dir() && path.join("SKILL.md").is_file()
}

/// What the store's manifests and markers say, read once.
#[derive(Debug, Clone, Default)]
pub struct Provenance {
    claims: BTreeMap<String, SkillOrigin>,
    pending: BTreeSet<String>,
    harness: BTreeMap<String, HarnessSkillInfo>,
    /// While Harness's manifest cannot be read: every store folder no other
    /// manifest or marker claims, any of which may be Harness's
    /// (`ownership_unresolved`, detail `harness`).
    harness_unresolved: BTreeSet<String>,
    pub problems: Vec<SkillsIssue>,
}

impl Provenance {
    pub fn load(store: &Path) -> Self {
        let mut out = Self::default();
        // The UI pack's mark is the most specific claim; it goes first.
        for id in UI_IDS {
            if store.join(id).join(UI_MARKER).is_file() {
                out.claims.insert(id.to_string(), SkillOrigin::Ui);
            }
        }
        for origin in [
            SkillOrigin::Experts,
            SkillOrigin::Science,
            SkillOrigin::Office,
            SkillOrigin::Harness,
        ] {
            let (file, key) = manifest_of(origin).expect("packs keep manifests");
            if origin.is_pack() {
                // Folders the pack left alone, owner unknown: not claimed
                // (they read as the user's), and said so.
                if let Ok(bytes) = fs::read(store.join(file)) {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        for id in unresolved_in(&value) {
                            if store.join(&id).exists() {
                                out.problems.push(
                                    SkillsIssue::new(codes::OWNERSHIP_UNRESOLVED)
                                        .path(store.join(&id))
                                        .detail(origin.as_str()),
                                );
                            }
                        }
                    }
                }
            }
            let mut read = read_manifest_entries(store, file, key);
            if origin == SkillOrigin::Harness && matches!(read, Ok(Some(_))) {
                if let Some(problem) = harness_manifest_refused(store) {
                    read = Err(problem);
                }
            }
            match read {
                Ok(Some(entries)) => {
                    for (id, entry) in entries {
                        if entry
                            .get("pending_user_review")
                            .and_then(|flag| flag.as_bool())
                            .unwrap_or(false)
                        {
                            out.pending.insert(id.clone());
                        }
                        if origin == SkillOrigin::Harness {
                            let text = |field: &str| {
                                entry
                                    .get(field)
                                    .and_then(|value| value.as_str())
                                    .map(str::to_string)
                            };
                            out.harness.insert(
                                id.clone(),
                                HarnessSkillInfo {
                                    item_ref: text("ref"),
                                    version: text("version"),
                                    plugin: text("plugin"),
                                },
                            );
                        }
                        out.claims.entry(id).or_insert(origin);
                    }
                }
                Ok(None) => {
                    if origin == SkillOrigin::Office {
                        // No Office manifest yet (before 0.46): its ids are
                        // its own, as they always were.
                        out.claim_bundled(store, origin);
                    }
                }
                Err(problem) => {
                    // A manifest that cannot be read must not turn the pack's
                    // skills into the user's: its own ids stay its own.
                    out.problems.push(problem);
                    out.claim_bundled(store, origin);
                    if origin == SkillOrigin::Harness {
                        // Harness has no bundled ids: which skills are its
                        // own cannot be told at all. Every folder no one
                        // else claims may be one (it is checked last, so the
                        // packs' claims are known).
                        out.mark_harness_unresolved(store);
                    }
                }
            }
        }
        out
    }

    /// A plugin's own store (`super::owned`): its Harness manifest is all
    /// there is, and every skill it lists is the plugin's. No pack claims
    /// anything there — a member may well have a pack skill's name.
    pub fn load_owned(store: &Path) -> Self {
        let mut out = Self::default();
        match crate::harness::skills::manifest::load(store) {
            Ok(manifest) => {
                for (id, entry) in manifest.skills {
                    out.harness.insert(
                        id.clone(),
                        HarnessSkillInfo {
                            item_ref: Some(entry.item_ref.clone()),
                            version: entry.version.clone(),
                            plugin: entry.plugin.clone(),
                        },
                    );
                    out.claims.insert(id, SkillOrigin::Harness);
                }
            }
            Err(error) => out.problems.push(
                SkillsIssue::new(codes::MANIFEST_UNREADABLE)
                    .path(store.join(HARNESS_MANIFEST))
                    .detail(error.detail()),
            ),
        }
        out
    }

    /// See [`Self::harness_unresolved`].
    fn mark_harness_unresolved(&mut self, store: &Path) {
        let Ok(entries) = fs::read_dir(store) else {
            return;
        };
        let mut ids: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.path().is_dir())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| {
                !name.starts_with('.')
                    && legacy_backup_name(name).is_none()
                    && crate::commands::acp::validate_skill_id(name).is_ok()
                    && !self.claims.contains_key(name)
            })
            .collect();
        ids.sort();
        for id in ids {
            self.problems.push(
                SkillsIssue::new(codes::OWNERSHIP_UNRESOLVED)
                    .path(store.join(&id))
                    .detail(SkillOrigin::Harness.as_str()),
            );
            self.harness_unresolved.insert(id);
        }
    }

    /// Whether `id` may be a Harness skill nobody can tell from a Custom one:
    /// Harness's manifest cannot be read. Such a folder still reads as Custom
    /// (nothing is hidden), but nothing that would change or remove it as a
    /// Custom skill may do so (`custom_save_skill`, `custom_delete_skills`).
    pub fn harness_unresolved(&self, id: &str) -> bool {
        self.harness_unresolved.contains(id)
    }

    fn claim_bundled(&mut self, store: &Path, origin: SkillOrigin) {
        let ids = match origin {
            SkillOrigin::Experts => crate::commands::experts::bundled_ids(),
            SkillOrigin::Science => crate::commands::science::bundled_ids(),
            SkillOrigin::Office => crate::commands::office_tools::bundled_skill_ids(),
            _ => Vec::new(),
        };
        for id in ids {
            if store.join(&id).exists() {
                self.claims.entry(id).or_insert(origin);
            }
        }
    }

    /// The origin a manifest or marker claims for `id`.
    pub fn claimed(&self, id: &str) -> Option<SkillOrigin> {
        self.claims.get(id).copied()
    }

    /// The origin of the skill `id` in the store: its claim, else Custom when
    /// it is a skill at all. `None` for anything else under that name.
    pub fn origin_of(&self, store: &Path, id: &str) -> Option<SkillOrigin> {
        if let Some(origin) = self.claimed(id) {
            return Some(origin);
        }
        if legacy_backup_name(id).is_some() || id.starts_with('.') {
            return None;
        }
        is_skill_dir(&store.join(id)).then_some(SkillOrigin::Custom)
    }

    pub fn pending_user_review(&self, id: &str) -> bool {
        self.pending.contains(id)
    }

    pub fn harness_info(&self, id: &str) -> Option<HarnessSkillInfo> {
        self.harness.get(id).cloned()
    }
}

/// Every skill in the store with its origin, in id order: folders holding a
/// `SKILL.md` (or claimed by a manifest), not dot-prefixed, not an older
/// release's backup.
pub(crate) fn store_skills(store: &Path, provenance: &Provenance) -> Vec<(String, SkillOrigin)> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(store) else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || legacy_backup_name(&name).is_some() {
            continue;
        }
        if crate::commands::acp::validate_skill_id(&name).is_err() {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        if let Some(origin) = provenance.origin_of(store, &name) {
            out.push((name, origin));
        }
    }
    out.sort();
    out
}
