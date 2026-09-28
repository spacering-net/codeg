//! Built-in expert skills management.
//!
//! Experts are curated skills (from obra/superpowers) that codeg bundles
//! into its binary via `include_dir!`. On startup they are extracted to a
//! central directory `~/.codeg/skills/<id>/`. Users can then enable an
//! expert for any ACP agent by creating a symbolic link (or Windows
//! junction) from the agent's skill directory into the central copy.
//!
//! The central store is the single source of truth. Enabling/disabling is
//! purely "does a link exist in the agent's skill dir" — there is no
//! database state, and updates propagate automatically when codeg upgrades
//! and re-extracts the bundled files.
//!
//! `experts/skills/` is vendored from upstream `skills/` verbatim, so a
//! version bump is an `rsync --delete` plus a `diff -rq` check. The one
//! deliberate exception is `writing-skills/package.json`: upstream declares
//! `"type": "module"` once at its repo root, which covers `render-graphs.js`
//! (ESM since v6.3.0). We extract skill directories standalone, so that
//! declaration never comes along and Node falls back to CommonJS — the
//! script then dies on `import` for anyone below Node 22.7, where ESM
//! auto-detection is off. The marker has to live in the bundle rather than
//! be written at extraction time: `install_or_refresh_expert` compares the
//! on-disk hash against the bundled one, so any file extraction invents
//! reads as user modification and gets backed up on every launch. Re-add it
//! after each sync.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use chrono::Utc;
use include_dir::{include_dir, Dir, DirEntry};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::acp::types::AgentSkillScope;
use crate::commands::acp::{
    preferred_scope_skill_dir, remove_skill_entry, scoped_skill_dirs, skill_storage_spec,
    validate_skill_id,
};
use crate::models::agent::AgentType;

// ─── Embedded bundle ────────────────────────────────────────────────────

static EXPERTS_BUNDLE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/experts");

const CENTRAL_DIR_NAME: &str = ".codeg";
const CENTRAL_SKILLS_SUBDIR: &str = "skills";
const MANIFEST_FILE: &str = ".manifest.json";
const EXPERTS_TOML: &str = "experts.toml";

// ─── Error type ─────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum ExpertsError {
    #[error("expert not found: {0}")]
    NotFound(String),
    #[error("agent does not support skills: {0:?}")]
    UnsupportedAgent(AgentType),
    #[error("a real directory already exists at '{path}' — delete or rename it first")]
    NameCollision { path: String },
    #[error("a different link already exists at '{path}' (points to '{found}') — remove it first")]
    ForeignLink { path: String, found: String },
    #[error("io error: {0}")]
    Io(String),
    #[error("metadata error: {0}")]
    Metadata(String),
    #[error("central expert store is unavailable: {0}")]
    CentralUnavailable(String),
}

impl Serialize for ExpertsError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<io::Error> for ExpertsError {
    fn from(err: io::Error) -> Self {
        ExpertsError::Io(err.to_string())
    }
}

// ─── Public types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ExpertMetadata {
    pub id: String,
    pub category: String,
    pub icon: Option<String>,
    pub sort_order: i32,
    pub display_name: BTreeMap<String, String>,
    pub description: BTreeMap<String, String>,
    pub bundled_hash: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExpertListItem {
    pub metadata: ExpertMetadata,
    pub installed_centrally: bool,
    pub user_modified: bool,
    pub central_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExpertLinkState {
    NotLinked,
    LinkedToCodeg,
    LinkedElsewhere,
    BlockedByRealDirectory,
    Broken,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpertInstallStatus {
    pub expert_id: String,
    pub agent_type: AgentType,
    pub state: ExpertLinkState,
    pub link_path: String,
    pub target_path: Option<String>,
    pub expected_target_path: String,
    pub copy_mode: bool,
}

/// A single enable/disable request for one (skill, agent) pair, used by the
/// batch `*_apply_links` commands. `expert_id` is the central-store id — for
/// office tools it carries the office skill id (mirroring how
/// `ExpertInstallStatus.expert_id` already doubles as the office skill id).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOp {
    pub expert_id: String,
    pub agent_type: AgentType,
    pub enable: bool,
}

/// Per-op outcome of a batch apply. A failed op never aborts the rest of the
/// batch; the caller inspects `ok`/`error` per entry and re-fetches the
/// authoritative snapshot afterwards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkOpResult {
    pub expert_id: String,
    pub agent_type: AgentType,
    pub ok: bool,
    /// Present on a successful enable; `None` for disables and failures.
    pub status: Option<ExpertInstallStatus>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct InstallReport {
    pub installed_count: usize,
    pub updated_count: usize,
    pub pending_user_review: Vec<String>,
    pub errors: Vec<String>,
}

// ─── Manifest ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Manifest {
    #[serde(default)]
    codeg_version: String,
    #[serde(default)]
    installed_at: String,
    #[serde(default)]
    experts: BTreeMap<String, ManifestEntry>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ManifestEntry {
    #[serde(default)]
    hash: String,
    #[serde(default)]
    installed_at: String,
    #[serde(default)]
    pending_user_review: bool,
}

// ─── Concurrency ────────────────────────────────────────────────────────

fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

// ─── Paths ──────────────────────────────────────────────────────────────

fn home_dir_or_default() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn central_experts_dir() -> PathBuf {
    home_dir_or_default()
        .join(CENTRAL_DIR_NAME)
        .join(CENTRAL_SKILLS_SUBDIR)
}

fn manifest_path() -> PathBuf {
    central_experts_dir().join(MANIFEST_FILE)
}

fn expert_central_path(expert_id: &str) -> PathBuf {
    central_experts_dir().join(expert_id)
}

fn agent_link_path(agent: AgentType, expert_id: &str) -> Result<PathBuf, ExpertsError> {
    let dir = preferred_scope_skill_dir(agent, AgentSkillScope::Global, None)
        .map_err(|_| ExpertsError::UnsupportedAgent(agent))?;
    Ok(dir.join(expert_id))
}

// ─── Metadata loading ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct ExpertsTomlRoot {
    #[serde(default)]
    expert: Vec<ExpertTomlEntry>,
}

#[derive(Debug, Deserialize)]
struct ExpertTomlEntry {
    id: String,
    category: String,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    sort_order: i32,
    #[serde(default)]
    display_name: BTreeMap<String, String>,
    #[serde(default)]
    description: BTreeMap<String, String>,
}

fn bundled_metadata() -> &'static [ExpertMetadata] {
    static METADATA: OnceLock<Vec<ExpertMetadata>> = OnceLock::new();
    METADATA.get_or_init(|| match load_bundled_metadata_inner() {
        Ok(list) => list,
        Err(err) => {
            tracing::error!("[Experts] failed to load bundled metadata: {err}");
            Vec::new()
        }
    })
}

fn load_bundled_metadata_inner() -> Result<Vec<ExpertMetadata>, ExpertsError> {
    let toml_file = EXPERTS_BUNDLE
        .get_file(EXPERTS_TOML)
        .ok_or_else(|| ExpertsError::Metadata(format!("{EXPERTS_TOML} missing from bundle")))?;
    let toml_str = toml_file
        .contents_utf8()
        .ok_or_else(|| ExpertsError::Metadata(format!("{EXPERTS_TOML} is not valid UTF-8")))?;
    let root: ExpertsTomlRoot = toml::from_str(toml_str)
        .map_err(|e| ExpertsError::Metadata(format!("failed to parse {EXPERTS_TOML}: {e}")))?;

    let mut out = Vec::with_capacity(root.expert.len());
    for entry in root.expert {
        let bundled_hash = hash_bundled_expert(&entry.id)?;
        out.push(ExpertMetadata {
            id: entry.id,
            category: entry.category,
            icon: entry.icon,
            sort_order: entry.sort_order,
            display_name: entry.display_name,
            description: entry.description,
            bundled_hash,
        });
    }
    out.sort_by(|a, b| {
        a.sort_order
            .cmp(&b.sort_order)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

/// Ids of all bundled experts. Used by the custom-skills pack to exclude
/// built-in ids from the "custom" set (all packs share the central store).
pub(crate) fn bundled_ids() -> Vec<String> {
    bundled_metadata().iter().map(|m| m.id.clone()).collect()
}

fn find_metadata(expert_id: &str) -> Result<&'static ExpertMetadata, ExpertsError> {
    bundled_metadata()
        .iter()
        .find(|m| m.id == expert_id)
        .ok_or_else(|| ExpertsError::NotFound(expert_id.to_string()))
}

// ─── Hashing ────────────────────────────────────────────────────────────

fn hash_bundled_expert(expert_id: &str) -> Result<String, ExpertsError> {
    let skill_dir = format!("skills/{expert_id}");
    let dir = EXPERTS_BUNDLE
        .get_dir(&skill_dir)
        .ok_or_else(|| ExpertsError::NotFound(expert_id.to_string()))?;
    let mut files: Vec<(&str, &[u8])> = Vec::new();
    collect_bundle_files(dir, &mut files);
    files.sort_by_key(|(path, _)| *path);
    let mut hasher = Sha256::new();
    for (path, contents) in files {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(contents);
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_bundle_files<'a>(dir: &'a Dir<'a>, out: &mut Vec<(&'a str, &'a [u8])>) {
    for entry in dir.entries() {
        match entry {
            DirEntry::File(f) => {
                let rel = f.path().to_str().unwrap_or("");
                out.push((rel, f.contents()));
            }
            DirEntry::Dir(d) => collect_bundle_files(d, out),
        }
    }
}

fn hash_disk_directory(path: &Path) -> Result<String, ExpertsError> {
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    collect_disk_files(path, path, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel_path, contents) in files {
        // Mirror the bundled hash format: relative path includes the
        // leading `skills/<id>/` prefix from bundled view.
        let logical = format!(
            "skills/{}/{}",
            path.file_name()
                .and_then(|s| s.to_str())
                .unwrap_or_default(),
            rel_path
        );
        hasher.update(logical.as_bytes());
        hasher.update(b"\0");
        hasher.update(&contents);
        hasher.update(b"\0");
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn collect_disk_files(
    base: &Path,
    current: &Path,
    out: &mut Vec<(String, Vec<u8>)>,
) -> Result<(), ExpertsError> {
    if !current.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(current)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let child = entry.path();
        if file_type.is_dir() {
            collect_disk_files(base, &child, out)?;
        } else if file_type.is_file() {
            let rel = child
                .strip_prefix(base)
                .map_err(|e| ExpertsError::Io(e.to_string()))?
                .to_string_lossy()
                .replace('\\', "/");
            let contents = fs::read(&child)?;
            out.push((rel, contents));
        }
    }
    Ok(())
}

// ─── Manifest I/O ───────────────────────────────────────────────────────

fn load_manifest() -> Manifest {
    let path = manifest_path();
    match fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str::<Manifest>(&content).unwrap_or_default(),
        Err(_) => Manifest::default(),
    }
}

fn save_manifest(manifest: &Manifest) -> Result<(), ExpertsError> {
    let path = manifest_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(manifest)
        .map_err(|e| ExpertsError::Metadata(format!("failed to serialize manifest: {e}")))?;
    fs::write(&path, serialized)?;
    Ok(())
}

// ─── Link operations ────────────────────────────────────────────────────

#[cfg(unix)]
pub(crate) fn create_link_raw(src: &Path, dst: &Path) -> io::Result<bool> {
    std::os::unix::fs::symlink(src, dst).map(|_| false)
}

#[cfg(windows)]
pub(crate) fn create_link_raw(src: &Path, dst: &Path) -> io::Result<bool> {
    match junction::create(src, dst) {
        Ok(_) => Ok(false),
        Err(junction_err) => {
            // Fall back to recursive copy when junction creation is not
            // possible (e.g. cross-volume, permission denied). Mark the
            // returned status with copy_mode = true so the UI can warn
            // the user that upgrades won't propagate automatically.
            copy_dir_recursive(src, dst).map_err(|copy_err| {
                io::Error::other(format!(
                    "junction failed ({junction_err}); copy fallback failed ({copy_err})"
                ))
            })?;
            Ok(true)
        }
    }
}

#[cfg(windows)]
fn copy_dir_recursive(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ft = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ft.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// Best-effort human-readable link target. On Windows, `fs::read_link`
/// does not resolve junctions in all stdlib versions — prefer the
/// `junction` crate when the path is a reparse point.
pub(crate) fn read_link_target(path: &Path) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if path_is_reparse_point(path) {
            if let Ok(target) = junction::get_target(path) {
                return Some(target);
            }
        }
    }
    fs::read_link(path).ok()
}

pub(crate) fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
}

/// On Windows a junction is *not* a symlink — it is a directory reparse
/// point. `symlink_metadata` reports it as a directory. So we also need to
/// ask the OS whether the directory is a reparse point.
#[cfg(windows)]
fn path_is_reparse_point(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    fs::symlink_metadata(path)
        .map(|m| m.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn path_is_reparse_point(_path: &Path) -> bool {
    false
}

/// Equality check for two already-canonicalized paths. On Windows the
/// filesystem is case-insensitive but `Path` comparison is not — canonical
/// forms can still differ in drive-letter case or user-supplied casing.
fn paths_equivalent(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    #[cfg(windows)]
    {
        let a_s = a.as_os_str().to_string_lossy();
        let b_s = b.as_os_str().to_string_lossy();
        a_s.eq_ignore_ascii_case(b_s.as_ref())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// Resolve a path while following symlinks and Windows junctions.
/// Returns `None` if the path does not exist or cannot be resolved (e.g.
/// dangling link).
fn resolve_real_path(path: &Path) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

pub(crate) fn classify_link(link_path: &Path, expected_target: &Path) -> ExpertLinkState {
    // No entry at all (not even a dangling link) → not linked.
    let meta = match fs::symlink_metadata(link_path) {
        Ok(m) => m,
        Err(_) => return ExpertLinkState::NotLinked,
    };

    let is_link_like = meta.file_type().is_symlink() || path_is_reparse_point(link_path);
    if !is_link_like {
        // A real directory (or file) sits where we'd put our link.
        // This also covers Windows copy-mode fallback, where we could not
        // create a junction and fell back to `copy_dir_recursive`. We still
        // surface it as BlockedByRealDirectory so experts_link_to_agent
        // treats it as "needs user attention" (the copy will not track
        // central-store updates and must be re-linked explicitly).
        return ExpertLinkState::BlockedByRealDirectory;
    }

    // `fs::canonicalize` transparently follows both symlinks and Windows
    // junctions, so comparing the two canonical forms is the single
    // source of truth for "does this link point at our central store?".
    // We intentionally do *not* rely on `fs::read_link`'s string output
    // for equality — on Windows junctions its output format is
    // stdlib-version-dependent and often fails to round-trip through
    // `canonicalize` cleanly.
    let resolved_link = resolve_real_path(link_path);
    let resolved_expected = resolve_real_path(expected_target);

    match (resolved_link, resolved_expected) {
        (None, _) => ExpertLinkState::Broken,
        (Some(l), Some(e)) if paths_equivalent(&l, &e) => ExpertLinkState::LinkedToCodeg,
        _ => ExpertLinkState::LinkedElsewhere,
    }
}

// ─── Central store installation ────────────────────────────────────────

pub async fn ensure_central_experts_installed() -> InstallReport {
    let _guard = mutation_lock().lock().await;
    tokio::task::spawn_blocking(ensure_central_experts_installed_blocking)
        .await
        .unwrap_or_else(|e| {
            let mut r = InstallReport::default();
            r.errors.push(format!("join error: {e}"));
            r
        })
}

fn ensure_central_experts_installed_blocking() -> InstallReport {
    let mut report = InstallReport::default();

    let central = central_experts_dir();
    if let Err(e) = fs::create_dir_all(&central) {
        report
            .errors
            .push(format!("failed to create central dir: {e}"));
        return report;
    }

    let mut manifest = load_manifest();
    let meta_list = bundled_metadata();

    for meta in meta_list {
        match install_or_refresh_expert(meta, &mut manifest) {
            Ok(InstallAction::Skipped) => {}
            Ok(InstallAction::Installed) => {
                report.installed_count += 1;
            }
            Ok(InstallAction::Updated) => {
                report.updated_count += 1;
            }
            Ok(InstallAction::BackedUp) => {
                report.updated_count += 1;
                report.pending_user_review.push(meta.id.clone());
            }
            Err(e) => {
                report.errors.push(format!("{}: {}", meta.id, e));
            }
        }
    }

    manifest.codeg_version = env!("CARGO_PKG_VERSION").to_string();
    manifest.installed_at = Utc::now().to_rfc3339();
    if let Err(e) = save_manifest(&manifest) {
        report.errors.push(format!("save manifest: {e}"));
    }

    report
}

enum InstallAction {
    Skipped,
    Installed,
    Updated,
    BackedUp,
}

fn install_or_refresh_expert(
    meta: &ExpertMetadata,
    manifest: &mut Manifest,
) -> Result<InstallAction, ExpertsError> {
    let central_path = expert_central_path(&meta.id);
    let bundled_hash = &meta.bundled_hash;
    let manifest_entry = manifest.experts.get(&meta.id).cloned().unwrap_or_default();

    if central_path.exists() {
        let on_disk_hash = hash_disk_directory(&central_path).unwrap_or_default();
        if &on_disk_hash == bundled_hash {
            // Up-to-date and pristine. Ensure manifest matches.
            if manifest_entry.hash != *bundled_hash {
                manifest.experts.insert(
                    meta.id.clone(),
                    ManifestEntry {
                        hash: bundled_hash.clone(),
                        installed_at: Utc::now().to_rfc3339(),
                        pending_user_review: false,
                    },
                );
            }
            return Ok(InstallAction::Skipped);
        }

        // Content differs. Was the user the one who changed it, or is
        // the bundle itself newer?
        let user_modified = manifest_entry.hash.is_empty() || on_disk_hash != manifest_entry.hash;
        if user_modified {
            // Preserve user work: move aside, install fresh.
            let backup_name = format!(
                "{}.user-backup-{}",
                meta.id,
                Utc::now().format("%Y%m%d-%H%M%S")
            );
            let backup_path = central_experts_dir().join(backup_name);
            fs::rename(&central_path, &backup_path)?;
            extract_expert_to_disk(meta, &central_path)?;
            manifest.experts.insert(
                meta.id.clone(),
                ManifestEntry {
                    hash: bundled_hash.clone(),
                    installed_at: Utc::now().to_rfc3339(),
                    pending_user_review: true,
                },
            );
            return Ok(InstallAction::BackedUp);
        }

        // Pristine but outdated → overwrite.
        remove_skill_entry(&central_path)
            .map_err(|e| ExpertsError::Io(format!("remove stale expert: {e}")))?;
        extract_expert_to_disk(meta, &central_path)?;
        manifest.experts.insert(
            meta.id.clone(),
            ManifestEntry {
                hash: bundled_hash.clone(),
                installed_at: Utc::now().to_rfc3339(),
                pending_user_review: false,
            },
        );
        Ok(InstallAction::Updated)
    } else {
        extract_expert_to_disk(meta, &central_path)?;
        manifest.experts.insert(
            meta.id.clone(),
            ManifestEntry {
                hash: bundled_hash.clone(),
                installed_at: Utc::now().to_rfc3339(),
                pending_user_review: false,
            },
        );
        Ok(InstallAction::Installed)
    }
}

fn extract_expert_to_disk(meta: &ExpertMetadata, target: &Path) -> Result<(), ExpertsError> {
    let skill_rel = format!("skills/{}", meta.id);
    let dir = EXPERTS_BUNDLE
        .get_dir(&skill_rel)
        .ok_or_else(|| ExpertsError::NotFound(meta.id.clone()))?;
    fs::create_dir_all(target)?;
    extract_bundle_dir(dir, &skill_rel, target)?;
    Ok(())
}

fn extract_bundle_dir(
    dir: &Dir<'_>,
    bundle_prefix: &str,
    target: &Path,
) -> Result<(), ExpertsError> {
    for entry in dir.entries() {
        match entry {
            DirEntry::File(f) => {
                let rel = f
                    .path()
                    .to_str()
                    .ok_or_else(|| ExpertsError::Io("non-utf8 path in bundle".into()))?;
                let rel_within = rel
                    .strip_prefix(bundle_prefix)
                    .and_then(|s| s.strip_prefix('/'))
                    .unwrap_or(rel);
                let out_path = target.join(rel_within);
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                fs::write(&out_path, f.contents())?;
                // `include_dir!` does not carry Unix permission bits, so bundled
                // scripts (e.g. subagent-driven-development/scripts/* and the
                // brainstorming companion's *.sh) would extract as non-executable
                // and fail when a skill invokes them by path. Restore the execute
                // bit for any file that declares a shebang.
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if f.contents().starts_with(b"#!") {
                        let mut perms = fs::metadata(&out_path)?.permissions();
                        perms.set_mode(perms.mode() | 0o111);
                        fs::set_permissions(&out_path, perms)?;
                    }
                }
            }
            DirEntry::Dir(d) => {
                extract_bundle_dir(d, bundle_prefix, target)?;
            }
        }
    }
    Ok(())
}

// ─── Commands: list / status ────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_list() -> Result<Vec<ExpertListItem>, ExpertsError> {
    let meta_list = bundled_metadata().to_vec();
    let manifest = load_manifest();
    let mut out = Vec::with_capacity(meta_list.len());
    for meta in meta_list {
        let central_path = expert_central_path(&meta.id);
        let installed_centrally = central_path.exists();
        let user_modified = manifest
            .experts
            .get(&meta.id)
            .map(|e| e.pending_user_review)
            .unwrap_or(false);
        out.push(ExpertListItem {
            metadata: meta,
            installed_centrally,
            user_modified,
            central_path: central_path.to_string_lossy().to_string(),
        });
    }
    Ok(out)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_get_install_status(
    expert_id: String,
) -> Result<Vec<ExpertInstallStatus>, ExpertsError> {
    let expert_id =
        validate_skill_id(&expert_id).map_err(|e| ExpertsError::Metadata(e.to_string()))?;
    let _ = find_metadata(&expert_id)?; // ensure it exists in the bundle
    let expected = expert_central_path(&expert_id);
    let agents = supported_agents();

    let mut out = Vec::with_capacity(agents.len());
    for agent in agents {
        let link_path = match agent_link_path(agent, &expert_id) {
            Ok(p) => p,
            Err(_) => continue,
        };
        let state = classify_link(&link_path, &expected);
        let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
        out.push(ExpertInstallStatus {
            expert_id: expert_id.clone(),
            agent_type: agent,
            state,
            link_path: link_path.to_string_lossy().to_string(),
            target_path,
            expected_target_path: expected.to_string_lossy().to_string(),
            copy_mode: false,
        });
    }
    Ok(out)
}

fn supported_agents() -> Vec<AgentType> {
    const ALL: &[AgentType] = &[
        AgentType::ClaudeCode,
        AgentType::Codex,
        AgentType::OpenCode,
        AgentType::Gemini,
        AgentType::OpenClaw,
        AgentType::Cline,
        AgentType::Hermes,
        AgentType::CodeBuddy,
        AgentType::KimiCode,
        AgentType::Pi,
        AgentType::Grok,
        AgentType::Cursor,
        AgentType::DeepSeek,
        AgentType::Qoder,
        AgentType::Antigravity,
    ];
    // Custom agents that declared the shared skills store join the built-in
    // set — the same `skill_storage_spec` gate every skills surface uses, so
    // this stays in lockstep with the columns the frontend renders.
    ALL.iter()
        .copied()
        .chain(crate::acp::custom_registry::all())
        .filter(|a| skill_storage_spec(*a).is_some())
        .collect()
}

// ─── Commands: link / unlink ────────────────────────────────────────────

/// Link one expert into one agent's skill dir. **Assumes the mutation lock is
/// already held** by the caller — `tokio::sync::Mutex` is not reentrant, so the
/// batch path (`experts_apply_links`) locks once and calls this directly rather
/// than the public command (which would self-deadlock).
fn link_one_locked(
    expert_id: &str,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, ExpertsError> {
    let expert_id =
        validate_skill_id(expert_id).map_err(|e| ExpertsError::Metadata(e.to_string()))?;
    let _ = find_metadata(&expert_id)?;
    let central = expert_central_path(&expert_id);
    if !central.exists() {
        return Err(ExpertsError::CentralUnavailable(format!(
            "expert '{expert_id}' is not installed in central store"
        )));
    }

    let link_path = agent_link_path(agent_type, &expert_id)?;
    if let Some(parent) = link_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut copy_mode = false;
    match create_link_raw(&central, &link_path) {
        Ok(is_copy) => {
            copy_mode = is_copy;
        }
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
            // Already exists — figure out what kind.
            match classify_link(&link_path, &central) {
                ExpertLinkState::LinkedToCodeg => {
                    // Idempotent success.
                }
                ExpertLinkState::BlockedByRealDirectory => {
                    return Err(ExpertsError::NameCollision {
                        path: link_path.to_string_lossy().to_string(),
                    });
                }
                ExpertLinkState::LinkedElsewhere | ExpertLinkState::Broken => {
                    let found = read_link_target(&link_path)
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_else(|| "<unknown>".into());
                    return Err(ExpertsError::ForeignLink {
                        path: link_path.to_string_lossy().to_string(),
                        found,
                    });
                }
                ExpertLinkState::NotLinked => {
                    // Shouldn't happen after AlreadyExists, but retry once.
                    create_link_raw(&central, &link_path)
                        .map_err(|e| ExpertsError::Io(format!("retry link failed: {e}")))?;
                }
            }
        }
        Err(err) => return Err(ExpertsError::Io(err.to_string())),
    }

    let state = classify_link(&link_path, &central);
    let target_path = read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
    Ok(ExpertInstallStatus {
        expert_id: expert_id.clone(),
        agent_type,
        state,
        link_path: link_path.to_string_lossy().to_string(),
        target_path,
        expected_target_path: central.to_string_lossy().to_string(),
        copy_mode,
    })
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_link_to_agent(
    expert_id: String,
    agent_type: AgentType,
) -> Result<ExpertInstallStatus, ExpertsError> {
    let _guard = mutation_lock().lock().await;
    link_one_locked(&expert_id, agent_type)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_unlink_from_agent(
    expert_id: String,
    agent_type: AgentType,
) -> Result<(), ExpertsError> {
    let _guard = mutation_lock().lock().await;
    unlink_one_locked(&expert_id, agent_type)
}

/// Remove one expert's link from one agent's skill dirs. **Assumes the mutation
/// lock is already held** (see `link_one_locked`).
fn unlink_one_locked(expert_id: &str, agent_type: AgentType) -> Result<(), ExpertsError> {
    let expert_id =
        validate_skill_id(expert_id).map_err(|e| ExpertsError::Metadata(e.to_string()))?;

    // Scan ALL global dirs for this agent to handle shared-dir agents — most
    // built-ins also point at the cross-agent `~/.agents/skills/` store, so the
    // link may sit in either. `skill_storage_spec` is the live list; do not
    // enumerate them here, it drifts. Remove the link wherever it is found.
    let dirs = scoped_skill_dirs(agent_type, AgentSkillScope::Global, None)
        .map_err(|_| ExpertsError::UnsupportedAgent(agent_type))?;

    let central = expert_central_path(&expert_id);
    let mut removed = false;
    for dir in dirs {
        let candidate = dir.join(&expert_id);
        if !candidate.exists() && !path_is_symlink(&candidate) {
            continue;
        }
        let state = classify_link(&candidate, &central);
        if matches!(
            state,
            ExpertLinkState::LinkedToCodeg | ExpertLinkState::Broken
        ) {
            // Safe to remove a link to our central store or a broken link.
            remove_skill_entry(&candidate).map_err(|e| {
                ExpertsError::Io(format!("remove link {}: {e}", candidate.display()))
            })?;
            removed = true;
        } else if state == ExpertLinkState::LinkedElsewhere {
            return Err(ExpertsError::ForeignLink {
                path: candidate.to_string_lossy().to_string(),
                found: read_link_target(&candidate)
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| "<unknown>".into()),
            });
        } else if state == ExpertLinkState::BlockedByRealDirectory {
            // Not ours; leave alone.
            continue;
        }
    }

    if !removed {
        // It was already unlinked — treat as idempotent success.
    }
    Ok(())
}

/// Apply a batch of enable/disable operations under a single lock acquisition.
///
/// Each op is applied independently: a failing op records `ok: false` with its
/// error and the batch continues, so a partial failure never aborts the rest.
/// The frontend computes the minimal delta of changed cells, calls this, then
/// re-fetches the authoritative snapshot via `experts_list_all_install_statuses`
/// to reconcile (necessary because shared agent dirs make per-op state
/// non-local — see the office/experts shared-dir note).
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_apply_links(ops: Vec<LinkOp>) -> Result<Vec<LinkOpResult>, ExpertsError> {
    let _guard = mutation_lock().lock().await;
    let mut out = Vec::with_capacity(ops.len());
    for op in ops {
        let LinkOp {
            expert_id,
            agent_type,
            enable,
        } = op;
        let res = if enable {
            link_one_locked(&expert_id, agent_type).map(Some)
        } else {
            unlink_one_locked(&expert_id, agent_type).map(|()| None)
        };
        out.push(match res {
            Ok(status) => LinkOpResult {
                expert_id,
                agent_type,
                ok: true,
                status,
                error: None,
            },
            Err(err) => LinkOpResult {
                expert_id,
                agent_type,
                ok: false,
                status: None,
                error: Some(err.to_string()),
            },
        });
    }
    Ok(out)
}

/// One-shot snapshot of every (expert, agent) link state — lets the matrix UI
/// render the whole grid from a single round-trip instead of one
/// `experts_get_install_status` call per expert.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_list_all_install_statuses() -> Result<Vec<ExpertInstallStatus>, ExpertsError> {
    let agents = supported_agents();
    let mut out = Vec::with_capacity(bundled_metadata().len() * agents.len());
    for meta in bundled_metadata() {
        let expected = expert_central_path(&meta.id);
        for &agent in &agents {
            let link_path = match agent_link_path(agent, &meta.id) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let state = classify_link(&link_path, &expected);
            let target_path =
                read_link_target(&link_path).map(|p| p.to_string_lossy().to_string());
            out.push(ExpertInstallStatus {
                expert_id: meta.id.clone(),
                agent_type: agent,
                state,
                link_path: link_path.to_string_lossy().to_string(),
                target_path,
                expected_target_path: expected.to_string_lossy().to_string(),
                copy_mode: false,
            });
        }
    }
    Ok(out)
}

// ─── Commands: read / open ──────────────────────────────────────────────

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_read_content(expert_id: String) -> Result<String, ExpertsError> {
    let expert_id =
        validate_skill_id(&expert_id).map_err(|e| ExpertsError::Metadata(e.to_string()))?;
    let _ = find_metadata(&expert_id)?;
    let path = expert_central_path(&expert_id).join("SKILL.md");
    if !path.exists() {
        // Fall back to bundled copy when central store isn't populated.
        let bundled_rel = format!("skills/{expert_id}/SKILL.md");
        if let Some(f) = EXPERTS_BUNDLE.get_file(&bundled_rel) {
            if let Some(text) = f.contents_utf8() {
                return Ok(text.to_string());
            }
        }
        return Err(ExpertsError::CentralUnavailable(format!(
            "expert '{expert_id}' has no SKILL.md on disk"
        )));
    }
    let content = fs::read_to_string(&path)?;
    Ok(content)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn experts_open_central_dir() -> Result<String, ExpertsError> {
    let dir = central_experts_dir();
    fs::create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_declared_custom_agent_gains_a_column_here_too() {
        use crate::acp::custom_registry::{
            hydrate, hydrate_test_guard, CustomAgentDef, CustomAgentSpec, CustomDistributionKind,
            NpxSpec,
        };
        let _guard = hydrate_test_guard();
        let mut def = CustomAgentDef {
            registry_id: "experts-pack-agent".into(),
            name: "Pack Agent".into(),
            description: String::new(),
            version: "1.0.0".into(),
            distribution_kind: CustomDistributionKind::Npx,
            spec: CustomAgentSpec {
                npx: Some(NpxSpec {
                    package: "pack-agent@1.0.0".into(),
                    ..Default::default()
                }),
                ..Default::default()
            },
            icon_url: None,
            skills_shared_store: false,
            skills_dir: None,
            source: Default::default(),
            version_probe: None,
            supports_mcp: true,
        };
        let agent = crate::models::agent::AgentType::custom("experts-pack-agent").unwrap();

        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(
            !supported_agents().contains(&agent),
            "undeclared custom agents stay out"
        );

        def.skills_shared_store = true;
        assert!(hydrate(std::slice::from_ref(&def)).is_empty());
        assert!(
            supported_agents().contains(&agent),
            "declared custom agents get a column"
        );

        assert!(hydrate(&[]).is_empty());
        assert!(!supported_agents().contains(&agent));
    }

    use tokio::time::{timeout, Duration};

    // These tests deliberately use ids that are well-formed but absent from the
    // bundle and unlikely to exist as real links, so they never touch or mutate
    // the developer's real skill directories: a disable of an absent id only
    // performs path-existence reads, and an enable of an unknown id fails at
    // `find_metadata` before any filesystem write.

    #[tokio::test]
    async fn apply_links_does_not_deadlock() {
        // The keystone regression: `experts_apply_links` locks the (non-reentrant)
        // mutation lock once and must call the lock-free inner helpers, NOT the
        // public single commands. If a future refactor reintroduced a re-lock,
        // the second acquisition would hang — caught here as a timeout rather
        // than a wedged CI run.
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-batch-test-absent-aaa".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                expert_id: "zzz-codeg-batch-test-absent-bbb".into(),
                agent_type: AgentType::Codex,
                enable: false,
            },
        ];
        let results = timeout(Duration::from_secs(5), experts_apply_links(ops))
            .await
            .expect("experts_apply_links must not deadlock")
            .expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        // Disabling an already-absent link is an idempotent success.
        assert!(results.iter().all(|r| r.ok), "{results:?}");
    }

    #[tokio::test]
    async fn apply_links_collects_per_op_results_without_aborting() {
        let ops = vec![
            LinkOp {
                expert_id: "zzz-codeg-batch-test-absent".into(),
                agent_type: AgentType::ClaudeCode,
                enable: false,
            },
            LinkOp {
                // Unknown expert → enable fails at find_metadata, before any fs write.
                expert_id: "zzz-unknown-expert".into(),
                agent_type: AgentType::ClaudeCode,
                enable: true,
            },
        ];
        let results = experts_apply_links(ops).await.expect("batch returns Ok");
        assert_eq!(results.len(), 2);
        assert!(results[0].ok, "idempotent disable should succeed");
        assert!(!results[1].ok, "unknown expert enable should fail its op");
        assert!(results[1].error.is_some());
        assert!(results[1].status.is_none());
    }

    #[tokio::test]
    // The hydrate guard is held across the await on purpose — see the
    // identical note in `custom_agent_service`.
    #[allow(clippy::await_holding_lock)]
    async fn list_all_install_statuses_covers_every_expert_agent_pair() {
        // A test hydrating a custom agent that declares a store would add a
        // column between the snapshot and the count below.
        let _guard = crate::acp::custom_registry::hydrate_test_guard();
        let rows = experts_list_all_install_statuses()
            .await
            .expect("snapshot returns Ok");
        let expected = bundled_metadata().len() * supported_agents().len();
        assert_eq!(rows.len(), expected);
    }
}
